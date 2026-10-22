const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'library.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

// Инициализация схемы БД
db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT DEFAULT 'Аноним',
    genre TEXT DEFAULT 'other',
    themeId TEXT DEFAULT 'anime',
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_books_created ON books(created_at DESC);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
`);

// Начальные книги
const booksCount = db.prepare('SELECT COUNT(*) as c FROM books').get().c;
if (booksCount === 0) {
  const seed = db.prepare(`
    INSERT INTO books (id, title, author, genre, themeId, content)
    VALUES (@id, @title, @author, @genre, @themeId, @content)
  `);
  const initialBooks = [
    {
      id: "stalker-call",
      title: "Сталкер: Зов Припяти",
      author: "Андрей Левицкий",
      genre: "fantastic",
      themeId: "stalker",
      content: "### Глава 1. Путь в Припять\nРанним утром, когда туман еще не рассеялся над Зоной, Стрелок вышел на дорогу. Впереди маячил силуэт заброшенного города, который когда-то был гордостью Советского Союза.\n\nТеперь же это было место, где время остановилось, а природа постепенно забирала свое.\n\nОн знал, что впереди его ждут не просто руины, а нечто большее. Припять хранила в себе тайны, которые лучше не тревожить.\n\nВетер принес с собой запах радиации и гари. Где-то вдалеке раздался глухой взрыв — возможно, это был очередной выброс. Стрелок ускорил шаг, плотнее запахивая куртку. Он знал, что обратного пути может не быть.\n\n— Главное — не терять голову, — пробормотал он себе под нос. — В Зоне нет случайностей."
    },
    {
      id: "skyrim-dragon",
      title: "Скайрим. Путь Дракона",
      author: "Ник Перумов",
      genre: "fantasy",
      themeId: "skyrim",
      content: "### Глава 1. Голоса предков\nСнег хрустел под ногами Довакина. В воздухе кружились холодные хлопья, оседая на древней чешуе доспеха. Высокий Хротгар возвышался над облаками."
    },
    {
      id: "wind-hair",
      title: "Ветер в твоих волосах",
      author: "Ранобэ",
      genre: "fantasy",
      themeId: "anime",
      content: "### Глава 1. Лепестки над академией\nКогда Акари переступила порог гильдии магии, колокольчик тихо звякнул. Её спутник, черный котенок с лунным полумесяцем на лбу, тихо мурлыкнул."
    },
    {
      id: "sin-city",
      title: "Город грехов",
      author: "Фрэнк Миллер",
      genre: "adventure",
      themeId: "comic",
      content: "### POW! BAM!\nДождь барабанил по капоту старого Плимута. Нео-Сити никогда не спал, а если и засыпал, то только с револьвером под подушкой."
    }
  ];
  for (const b of initialBooks) seed.run(b);
}

// Запросы к БД
const getAllBooksStmt = db.prepare('SELECT id, title, author, genre, themeId, content FROM books ORDER BY created_at DESC');
const upsertBookStmt = db.prepare(`
  INSERT INTO books (id, title, author, genre, themeId, content)
  VALUES (@id, @title, @author, @genre, @themeId, @content)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    author = excluded.author,
    genre = excluded.genre,
    themeId = excluded.themeId,
    content = excluded.content
`);
const deleteBookStmt = db.prepare('DELETE FROM books WHERE id = ?');
const findUserStmt = db.prepare('SELECT * FROM users WHERE username = ?');

// Сессии и Rate-Limiting (Brute-Force Protection)
const activeAdminTokens = new Map();
const loginAttempts = new Map(); // IP -> { count, lockedUntil }

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '127.0.0.1';
}

function cleanExpired() {
  const now = Date.now();
  for (const [token, exp] of activeAdminTokens.entries()) {
    if (exp < now) activeAdminTokens.delete(token);
  }
  for (const [ip, data] of loginAttempts.entries()) {
    if (data.lockedUntil && data.lockedUntil < now) {
      loginAttempts.delete(ip);
    }
  }
}
setInterval(cleanExpired, 60000);

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block'
  });
  res.end(payload);
}

function verifyAdmin(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.substring(7).trim();
  const exp = activeAdminTokens.get(token);
  if (!exp || exp < Date.now()) {
    if (token) activeAdminTokens.delete(token);
    return false;
  }
  return true;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg'
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 1. Авторизация (с ограничением попыток подбора)
  if (req.url === '/api/auth/login' && req.method === 'POST') {
    const ip = getClientIp(req);
    const now = Date.now();
    const attempts = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };

    if (attempts.lockedUntil && attempts.lockedUntil > now) {
      const waitMinutes = Math.ceil((attempts.lockedUntil - now) / 60000);
      return sendJson(res, 429, { error: `Слишком много попыток. Блокировка на ${waitMinutes} мин.` });
    }

    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e4) req.destroy();
    });
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        if (!username || !password) {
          return sendJson(res, 400, { error: 'Логин и пароль обязательны' });
        }

        const user = findUserStmt.get(username);
        const isMatch = user && bcrypt.compareSync(password, user.password_hash);

        if (!isMatch) {
          attempts.count += 1;
          if (attempts.count >= 5) {
            attempts.lockedUntil = now + (15 * 60 * 1000); // 15 минут блокировки
            loginAttempts.set(ip, attempts);
            return sendJson(res, 429, { error: 'Превышен лимит попыток. Вход заблокирован на 15 минут.' });
          }
          loginAttempts.set(ip, attempts);
          return sendJson(res, 401, { error: `Неверный пароль. Осталось попыток: ${5 - attempts.count}` });
        }

        // Успешный вход — сброс счетчика
        loginAttempts.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        activeAdminTokens.set(token, Date.now() + (24 * 60 * 60 * 1000));

        return sendJson(res, 200, {
          success: true,
          token,
          username: user.username,
          role: user.role
        });
      } catch (e) {
        return sendJson(res, 400, { error: 'Некорректный запрос' });
      }
    });
    return;
  }

  // 2. Получение списка книг
  if (req.url === '/api/books' && req.method === 'GET') {
    try {
      return sendJson(res, 200, getAllBooksStmt.all());
    } catch (err) {
      return sendJson(res, 500, { error: 'Ошибка базы данных' });
    }
  }

  // 3. Сохранение книги (требуется Bearer-токен)
  if (req.url === '/api/books' && req.method === 'POST') {
    if (!verifyAdmin(req)) {
      return sendJson(res, 403, { error: 'Требуются права администратора' });
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const item = JSON.parse(body);
        if (!item.title || !item.content) {
          return sendJson(res, 400, { error: 'Поля title и content обязательны' });
        }
        const bookRecord = {
          id: (item.id && typeof item.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(item.id))
            ? item.id
            : `book-${Date.now()}`,
          title: String(item.title).slice(0, 200),
          author: String(item.author || 'Аноним').slice(0, 100),
          genre: String(item.genre || 'other').slice(0, 50),
          themeId: String(item.themeId || 'anime').slice(0, 50),
          content: String(item.content)
        };
        upsertBookStmt.run(bookRecord);
        return sendJson(res, 200, { success: true, books: getAllBooksStmt.all() });
      } catch (err) {
        return sendJson(res, 400, { error: 'Ошибка сохранения в базу' });
      }
    });
    return;
  }

  // 4. Удаление книги (требуется Bearer-токен)
  if (req.url.startsWith('/api/books/') && req.method === 'DELETE') {
    if (!verifyAdmin(req)) {
      return sendJson(res, 403, { error: 'Требуются права администратора' });
    }
    const bookId = decodeURIComponent(req.url.replace('/api/books/', '').trim());
    try {
      const result = deleteBookStmt.run(bookId);
      if (result.changes === 0) {
        return sendJson(res, 404, { error: 'Книга не найдена' });
      }
      return sendJson(res, 200, { success: true, books: getAllBooksStmt.all() });
    } catch (err) {
      return sendJson(res, 500, { error: 'Ошибка удаления' });
    }
  }

  // 5. Раздача статики
  let safePath = path.normalize(decodeURI(req.url.split('?')[0]));
  if (safePath === '/') safePath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Access Denied');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const indexFallback = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexFallback, (errIdx, content) => {
        if (errIdx) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Ponya-Budka Server] Running securely on port ${PORT}`);
});

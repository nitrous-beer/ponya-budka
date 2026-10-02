'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const HOST = '127.0.0.1';
const PORT = 3000;
const DATA_DIR = '/var/lib/budka';
const BOOKS_FILE = path.join(DATA_DIR, 'books.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MAX_BODY = 1_500_000;
const sessions = new Map();
const loginAttempts = new Map();

const DEFAULT_BOOK = {
  id: crypto.randomUUID(),
  title: 'Поняшина будка: Пролог',
  author: 'Анонимный сталкер',
  description: 'Демонстрационная книга. Её можно отредактировать или удалить из админ-панели.',
  content: `Глава I\n\nВечер опускался на Будку тихо, будто кто-то приглушил громкость мира. За окном мерцали огни, а на столе лежала книга, которую никто не решался открыть первым.\n\nПоняша посмотрела на старую закладку и сказала: «Ладно. Только одну страницу». Разумеется, это была ложь. Через минуту первая страница перевернулась, а вместе с ней началось маленькое приключение.\n\nГлава II\n\nВнутри книги оказался коридор из букв. Каждый шаг отзывался шорохом бумаги, а где-то далеко щёлкал невидимый счётчик. На последней строке стояло предупреждение: «Если дочитал сюда — переверни страницу».\n\nИ читатель перевернул. Потому что иначе зачем вообще была эта закладка?`,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });
  if (!fs.existsSync(BOOKS_FILE)) writeJsonAtomic(BOOKS_FILE, [DEFAULT_BOOK]);
  if (!fs.existsSync(USERS_FILE)) {
    const admin = makeUser('admin', 'admin', 'admin');
    writeJsonAtomic(USERS_FILE, [admin]);
  } else {
    const users = readJson(USERS_FILE, []);
    if (!users.some(u => u.role === 'admin')) {
      users.push(makeUser('admin', 'admin', 'admin'));
      writeJsonAtomic(USERS_FILE, users);
    }
  }
  try { fs.chownSync(DATA_DIR, getUid('www-data'), getGid('www-data')); } catch (_) {}
}

function getUid(name) {
  return require('child_process').execFileSync('id', ['-u', name], { encoding: 'utf8' }).trim();
}
function getGid(name) {
  return require('child_process').execFileSync('id', ['-g', name], { encoding: 'utf8' }).trim();
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o640 });
  fs.renameSync(tmp, file);
}
function now() { return new Date().toISOString(); }
function makeId() { return crypto.randomUUID(); }
function makeUser(username, password, role = 'reader') {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { id: makeId(), username, password: `${salt}:${hash}`, role, createdAt: now() };
}
function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
function publicUser(u) { return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt }; }
function token() { return crypto.randomBytes(32).toString('base64url'); }
function cleanupSessions() {
  const cutoff = Date.now() - 1000 * 60 * 60 * 12;
  for (const [t, s] of sessions) if (s.createdAt < cutoff) sessions.delete(t);
}
setInterval(cleanupSessions, 15 * 60 * 1000).unref();

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function fail(res, status, message) { send(res, status, { error: message }); }
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function getUser(req) {
  const t = parseCookies(req).budka_session;
  if (!t) return null;
  const s = sessions.get(t);
  if (!s || s.expiresAt < Date.now()) { sessions.delete(t); return null; }
  const users = readJson(USERS_FILE, []);
  const user = users.find(u => u.id === s.userId);
  return user || null;
}
function auth(req, res, adminOnly = false) {
  const user = getUser(req);
  if (!user) { fail(res, 401, 'Требуется вход'); return null; }
  if (adminOnly && user.role !== 'admin') { fail(res, 403, 'Требуются права администратора'); return null; }
  return user;
}
function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY) { reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(Object.assign(new Error('Некорректный JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function cleanText(value, max) { return String(value ?? '').trim().slice(0, max); }
function validateBook(body) {
  const title = cleanText(body.title, 200);
  const author = cleanText(body.author, 120);
  const description = cleanText(body.description, 1000);
  const content = String(body.content ?? '').slice(0, 1_000_000);
  if (!title || !content) throw Object.assign(new Error('Название и текст книги обязательны'), { status: 400 });
  return { title, author, description, content };
}
function rateLimit(ip) {
  const x = loginAttempts.get(ip) || { count: 0, reset: Date.now() + 15 * 60 * 1000 };
  if (x.reset < Date.now()) { x.count = 0; x.reset = Date.now() + 15 * 60 * 1000; }
  x.count += 1; loginAttempts.set(ip, x);
  return x.count <= 10;
}

async function api(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, service: 'budka-api' });
  if (method === 'GET' && p === '/api/books') return send(res, 200, readJson(BOOKS_FILE, []));
  if (method === 'GET' && p === '/api/me') {
    const user = getUser(req); return send(res, 200, { user: user ? publicUser(user) : null });
  }

  if (method === 'POST' && p === '/api/auth/login') {
    if (!rateLimit(req.socket.remoteAddress || 'unknown')) return fail(res, 429, 'Слишком много попыток входа. Попробуйте позже.');
    const body = await jsonBody(req).catch(e => { fail(res, e.status || 400, e.message); return null; });
    if (!body) return;
    const username = cleanText(body.username, 80);
    const password = String(body.password || '');
    const users = readJson(USERS_FILE, []);
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !verifyPassword(password, user.password)) return fail(res, 401, 'Неверный логин или пароль');
    const t = token(); sessions.set(t, { userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `budka_session=${encodeURIComponent(t)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200` });
  }
  if (method === 'POST' && p === '/api/auth/logout') {
    const t = parseCookies(req).budka_session; if (t) sessions.delete(t);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'budka_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  }
  if (method === 'POST' && p === '/api/auth/register') {
    const body = await jsonBody(req).catch(e => { fail(res, e.status || 400, e.message); return null; });
    if (!body) return;
    const username = cleanText(body.username, 40);
    const password = String(body.password || '');
    if (!/^[\p{L}\p{N}_.-]{3,40}$/u.test(username) || password.length < 8) return fail(res, 400, 'Логин: 3–40 символов. Пароль: минимум 8 символов.');
    const users = readJson(USERS_FILE, []);
    if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) return fail(res, 409, 'Такой пользователь уже существует');
    const user = makeUser(username, password, 'reader'); users.push(user); writeJsonAtomic(USERS_FILE, users);
    return send(res, 201, { user: publicUser(user) });
  }

  if (method === 'POST' && p === '/api/auth/password') {
    const user = auth(req, res, false); if (!user) return;
    const body = await jsonBody(req).catch(e => { fail(res, e.status || 400, e.message); return null; });
    if (!body) return;
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (!verifyPassword(currentPassword, user.password)) return fail(res, 401, 'Текущий пароль указан неверно');
    if (newPassword.length < 8 || newPassword.length > 200) return fail(res, 400, 'Новый пароль: от 8 до 200 символов');
    const users = readJson(USERS_FILE, []);
    const i = users.findIndex(u => u.id === user.id);
    if (i < 0) return fail(res, 404, 'Пользователь не найден');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(newPassword, salt, 64).toString('hex');
    users[i].password = `${salt}:${hash}`;
    writeJsonAtomic(USERS_FILE, users);
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && p === '/api/books') {
    const user = auth(req, res, true); if (!user) return;
    const body = await jsonBody(req).catch(e => { fail(res, e.status || 400, e.message); return null; }); if (!body) return;
    const data = validateBook(body); const books = readJson(BOOKS_FILE, []);
    const book = { id: makeId(), ...data, createdAt: now(), updatedAt: now() }; books.unshift(book); writeJsonAtomic(BOOKS_FILE, books);
    return send(res, 201, book);
  }
  const bookMatch = p.match(/^\/api\/books\/([0-9a-f-]{36})$/i);
  if (bookMatch && method === 'PUT') {
    const user = auth(req, res, true); if (!user) return;
    const body = await jsonBody(req).catch(e => { fail(res, e.status || 400, e.message); return null; }); if (!body) return;
    const books = readJson(BOOKS_FILE, []); const i = books.findIndex(b => b.id === bookMatch[1]);
    if (i < 0) return fail(res, 404, 'Книга не найдена');
    books[i] = { ...books[i], ...validateBook(body), updatedAt: now() }; writeJsonAtomic(BOOKS_FILE, books); return send(res, 200, books[i]);
  }
  if (bookMatch && method === 'DELETE') {
    const user = auth(req, res, true); if (!user) return;
    const books = readJson(BOOKS_FILE, []); const next = books.filter(b => b.id !== bookMatch[1]);
    if (next.length === books.length) return fail(res, 404, 'Книга не найдена');
    writeJsonAtomic(BOOKS_FILE, next); return send(res, 200, { ok: true });
  }

  if (method === 'GET' && p === '/api/users') {
    const user = auth(req, res, true); if (!user) return; return send(res, 200, readJson(USERS_FILE, []).map(publicUser));
  }
  const userMatch = p.match(/^\/api\/users\/([0-9a-f-]{36})$/i);
  if (userMatch && method === 'DELETE') {
    const actor = auth(req, res, true); if (!actor) return;
    if (actor.id === userMatch[1]) return fail(res, 400, 'Нельзя удалить текущего администратора');
    const users = readJson(USERS_FILE, []); const target = users.find(u => u.id === userMatch[1]);
    if (!target) return fail(res, 404, 'Пользователь не найден');
    if (target.role === 'admin' && users.filter(u => u.role === 'admin').length <= 1) return fail(res, 400, 'Нельзя удалить последнего администратора');
    writeJsonAtomic(USERS_FILE, users.filter(u => u.id !== target.id)); return send(res, 200, { ok: true });
  }
  if (userMatch && method === 'PUT') {
    const actor = auth(req, res, true); if (!actor) return;
    const body = await jsonBody(req).catch(e => { fail(res, e.status || 400, e.message); return null; }); if (!body) return;
    const role = body.role === 'admin' ? 'admin' : body.role === 'reader' ? 'reader' : null;
    if (!role) return fail(res, 400, 'Недопустимая роль');
    const users = readJson(USERS_FILE, []); const target = users.find(u => u.id === userMatch[1]);
    if (!target) return fail(res, 404, 'Пользователь не найден');
    if (target.role === 'admin' && role === 'reader' && users.filter(u => u.role === 'admin').length <= 1) return fail(res, 400, 'Нельзя снять роль у последнего администратора');
    target.role = role; writeJsonAtomic(USERS_FILE, users); return send(res, 200, publicUser(target));
  }
  return fail(res, 404, 'API route not found');
}

ensureData();
const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/api/')) return fail(res, 404, 'Not found');
  Promise.resolve(api(req, res)).catch(err => { console.error(err); if (!res.headersSent) fail(res, 500, 'Внутренняя ошибка сервера'); });
});
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, HOST, () => console.log(`budka-api listening on ${HOST}:${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

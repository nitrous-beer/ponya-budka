'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const HOST = process.env.BUDKA_HOST || '127.0.0.1';
const PORT = Number(process.env.BUDKA_PORT || 3000);
const DATA_DIR = process.env.BUDKA_DATA_DIR || '/var/lib/budka';
const BOOKS_FILE = path.join(DATA_DIR, 'books.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MAX_BODY = 2_000_000;
const SESSION_TTL = 12 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();

const DEMO_BOOKS = [
  ['Сталкер: Зов Припяти','Андрей Левицкий','Фантастика'],
  ['Скайрим. Путь Дракона','Ник Перумов','Фэнтези'],
  ['Ветер в твоих волосах','Ранобэ','Приключения'],
  ['Город грехов','Фрэнк Миллер','Комикс'],
  ['Анна Каренина','Лев Толстой','Классика'],
  ['Ночной дозор','Сергей Лукьяненко','Фантастика']
];
function demoContent(title){return `Глава 1\nПуть в ${title}\n\nРанним утром мир еще не успел проснуться. Впереди была дорога, полная тайн, а рядом лежала старая книга. Казалось, стоило открыть первую страницу — и обычный день превратится в приключение.\n\nВетер принес запах дождя и далекого города. Герой сделал шаг вперед и понял: обратного пути может не быть.\n\n— Главное — не терять голову, — сказал он себе. — В этой истории случайностей нет.`;}
function makeDemoBooks(){return DEMO_BOOKS.map(([title,author])=>({id:crypto.randomUUID(),title,author,description:'Демонстрационная книга для проверки каталога и читалки.',content:demoContent(title),createdAt:now(),updatedAt:now()}));}


function now() { return new Date().toISOString(); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o640 });
  fs.renameSync(tmp, file);
}
function normalizeRole(role) { return role === 'admin' ? 'admin' : 'reader'; }
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function makeUser(username, password, role = 'reader') {
  return { id: crypto.randomUUID(), username, password: hashPassword(password), role: normalizeRole(role), createdAt: now() };
}
function verifyPassword(password, stored) {
  try {
    const [salt, expected] = String(stored || '').split(':');
    if (!salt || !expected || !/^[0-9a-f]+$/i.test(expected)) return false;
    const actual = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(actual, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}
function publicUser(u) { return { id: u.id, username: u.username, role: normalizeRole(u.role), createdAt: u.createdAt }; }
function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });
  let books = readJson(BOOKS_FILE, null);
  if (!Array.isArray(books)) books = makeDemoBooks();
  if (!books.length) books = makeDemoBooks();
  writeJsonAtomic(BOOKS_FILE, books);

  let users = readJson(USERS_FILE, []);
  if (!Array.isArray(users)) users = [];
  let changed = false;
  users = users.map(u => {
    const role = normalizeRole(u.role);
    if (u.role !== role) { changed = true; return { ...u, role }; }
    return u;
  });
  if (!users.some(u => u.role === 'admin')) { users.unshift(makeUser('admin', 'admin', 'admin')); changed = true; }
  if (changed || !fs.existsSync(USERS_FILE)) writeJsonAtomic(USERS_FILE, users);
  try { fs.chownSync(DATA_DIR, process.getuid?.() || 0, process.getgid?.() || 0); } catch (_) {}
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function fail(res, status, message) { return send(res, status, { error: message }); }
function cleanText(value, max) { return String(value ?? '').trim().slice(0, max); }
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
  const s = sessions.get(t);
  if (!t || !s || s.expiresAt < Date.now()) { if (t) sessions.delete(t); return null; }
  return readJson(USERS_FILE, []).find(u => u.id === s.userId) || null;
}
function auth(req, res, adminOnly = false) {
  const user = getUser(req);
  if (!user) { fail(res, 401, 'Требуется вход'); return null; }
  if (adminOnly && normalizeRole(user.role) !== 'admin') { fail(res, 403, 'Требуются права администратора'); return null; }
  return user;
}
function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY) { reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(Object.assign(new Error('Некорректный JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function validateBook(body) {
  const title = cleanText(body.title, 200);
  const author = cleanText(body.author, 120);
  const description = cleanText(body.description, 1000);
  const content = String(body.content ?? '').slice(0, 1_500_000);
  if (!title || !content.trim()) throw Object.assign(new Error('Название и текст книги обязательны'), { status: 400 });
  return { title, author, description, content };
}
function rateLimit(ip) {
  const item = loginAttempts.get(ip) || { count: 0, reset: Date.now() + 15 * 60 * 1000 };
  if (item.reset < Date.now()) { item.count = 0; item.reset = Date.now() + 15 * 60 * 1000; }
  item.count += 1; loginAttempts.set(ip, item);
  return item.count <= 10;
}
async function api(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname; const method = req.method;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, service: 'budka-api', time: now() });
  if (method === 'GET' && p === '/api/books') return send(res, 200, readJson(BOOKS_FILE, []));
  if (method === 'GET' && p === '/api/me') { const user = getUser(req); return send(res, 200, { user: user ? publicUser(user) : null }); }

  if (method === 'POST' && p === '/api/auth/login') {
    if (!rateLimit(req.socket.remoteAddress || 'unknown')) return fail(res, 429, 'Слишком много попыток входа. Попробуйте позже.');
    const body = await jsonBody(req).catch(e => { fail(res, e.status || 400, e.message); return null; }); if (!body) return;
    const username = cleanText(body.username, 80); const password = String(body.password || '');
    const user = readJson(USERS_FILE, []).find(u => String(u.username).toLowerCase() === username.toLowerCase());
    if (!user || !verifyPassword(password, user.password)) return fail(res, 401, 'Неверный логин или пароль');
    const t = crypto.randomBytes(32).toString('base64url'); sessions.set(t, { userId: user.id, expiresAt: Date.now() + SESSION_TTL });
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `budka_session=${encodeURIComponent(t)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}` });
  }
  if (method === 'POST' && p === '/api/auth/logout') {
    const t = parseCookies(req).budka_session; if (t) sessions.delete(t);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'budka_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  }
  if (method === 'POST' && p === '/api/auth/register') {
    const body = await jsonBody(req).catch(e => { fail(res, e.status || 400, e.message); return null; }); if (!body) return;
    const username = cleanText(body.username, 40); const password = String(body.password || '');
    if (!/^[\p{L}\p{N}_.-]{3,40}$/u.test(username) || password.length < 8 || password.length > 200) return fail(res, 400, 'Логин: 3–40 символов. Пароль: 8–200 символов.');
    const users = readJson(USERS_FILE, []);
    if (users.some(u => String(u.username).toLowerCase() === username.toLowerCase())) return fail(res, 409, 'Такой пользователь уже существует');
    const user = makeUser(username, password, 'reader'); users.push(user); writeJsonAtomic(USERS_FILE, users); return send(res, 201, { user: publicUser(user) });
  }
  if (method === 'POST' && p === '/api/auth/password') {
    const user = auth(req, res); if (!user) return;
    const body = await jsonBody(req).catch(e => { fail(res, e.status || 400, e.message); return null; }); if (!body) return;
    const currentPassword = String(body.currentPassword || ''); const newPassword = String(body.newPassword || '');
    if (!verifyPassword(currentPassword, user.password)) return fail(res, 401, 'Текущий пароль указан неверно');
    if (newPassword.length < 8 || newPassword.length > 200) return fail(res, 400, 'Новый пароль: 8–200 символов');
    if (verifyPassword(newPassword, user.password)) return fail(res, 400, 'Новый пароль должен отличаться от текущего');
    const users = readJson(USERS_FILE, []); const i = users.findIndex(u => u.id === user.id); if (i < 0) return fail(res, 404, 'Пользователь не найден');
    users[i].password = hashPassword(newPassword); writeJsonAtomic(USERS_FILE, users); return send(res, 200, { ok: true });
  }
  if (method === 'POST' && p === '/api/books') {
    if (!auth(req, res, true)) return;
    const body = await jsonBody(req).catch(e => { fail(res, e.status || 400, e.message); return null; }); if (!body) return;
    const data = validateBook(body); const books = readJson(BOOKS_FILE, []); const book = { id: crypto.randomUUID(), ...data, createdAt: now(), updatedAt: now() }; books.unshift(book); writeJsonAtomic(BOOKS_FILE, books); return send(res, 201, book);
  }
  const bookMatch = p.match(/^\/api\/books\/([0-9a-f-]{36})$/i);
  if (bookMatch && method === 'PUT') {
    if (!auth(req, res, true)) return;
    const body = await jsonBody(req).catch(e => { fail(res, e.status || 400, e.message); return null; }); if (!body) return;
    const books = readJson(BOOKS_FILE, []); const i = books.findIndex(b => b.id === bookMatch[1]); if (i < 0) return fail(res, 404, 'Книга не найдена');
    books[i] = { ...books[i], ...validateBook(body), updatedAt: now() }; writeJsonAtomic(BOOKS_FILE, books); return send(res, 200, books[i]);
  }
  if (bookMatch && method === 'DELETE') {
    if (!auth(req, res, true)) return;
    const books = readJson(BOOKS_FILE, []); const next = books.filter(b => b.id !== bookMatch[1]); if (next.length === books.length) return fail(res, 404, 'Книга не найдена');
    writeJsonAtomic(BOOKS_FILE, next); return send(res, 200, { ok: true });
  }
  if (method === 'GET' && p === '/api/users') { if (!auth(req, res, true)) return; return send(res, 200, readJson(USERS_FILE, []).map(publicUser)); }
  const userMatch = p.match(/^\/api\/users\/([0-9a-f-]{36})$/i);
  if (userMatch && method === 'PUT') {
    const actor = auth(req, res, true); if (!actor) return;
    const body = await jsonBody(req).catch(e => { fail(res, e.status || 400, e.message); return null; }); if (!body) return;
    if (body.role !== 'admin' && body.role !== 'reader') return fail(res, 400, 'Недопустимая роль');
    const users = readJson(USERS_FILE, []); const target = users.find(u => u.id === userMatch[1]); if (!target) return fail(res, 404, 'Пользователь не найден');
    const admins = users.filter(u => normalizeRole(u.role) === 'admin').length;
    if (normalizeRole(target.role) === 'admin' && body.role === 'reader' && admins <= 1) return fail(res, 400, 'Нельзя снять роль у последнего администратора');
    target.role = body.role; writeJsonAtomic(USERS_FILE, users); return send(res, 200, publicUser(target));
  }
  if (userMatch && method === 'DELETE') {
    const actor = auth(req, res, true); if (!actor) return;
    if (actor.id === userMatch[1]) return fail(res, 400, 'Нельзя удалить самого себя');
    const users = readJson(USERS_FILE, []); const target = users.find(u => u.id === userMatch[1]); if (!target) return fail(res, 404, 'Пользователь не найден');
    if (normalizeRole(target.role) === 'admin' && users.filter(u => normalizeRole(u.role) === 'admin').length <= 1) return fail(res, 400, 'Нельзя удалить последнего администратора');
    writeJsonAtomic(USERS_FILE, users.filter(u => u.id !== target.id)); return send(res, 200, { ok: true });
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

import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scrypt, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hashPassword = promisify(scrypt);
const sessionMs = 7 * 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');

function respond(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(value));
}
function validation(res, fields) { return respond(res, 400, { error: 'validation', fields }); }
async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16384) throw new Error('must be at most 16384 bytes');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('must be a JSON object');
  return value;
}
function credentials(input) {
  const fields = {};
  if (typeof input.email !== 'string' || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    fields.email = 'must be a valid email address of at most 254 characters';
  }
  if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) {
    fields.password = 'must be a string between 8 and 128 characters';
  }
  return fields;
}
function integer(raw, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}
function publicExpense(row) {
  return { id: row.id, title: row.title, amountCents: row.amount_cents, currency: 'USD', createdAt: row.created_at };
}

export function createService(path = ':memory:', options = {}) {
  const now = options.now || Date.now;
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const sql = {
    user: db.prepare('SELECT * FROM users WHERE email = ?'),
    addUser: db.prepare('INSERT INTO users(email, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING RETURNING id, email'),
    addSession: db.prepare('INSERT INTO sessions VALUES (?, ?, ?)'),
    authenticate: db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    logout: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    list: db.prepare('SELECT * FROM expenses WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?'),
    detail: db.prepare('SELECT * FROM expenses WHERE user_id = ? AND id = ?'),
    remove: db.prepare('DELETE FROM expenses WHERE user_id = ? AND id = ? RETURNING id'),
    addExpense: db.prepare('INSERT INTO expenses(user_id, title, amount_cents, created_at) VALUES (?, ?, ?, ?) RETURNING *'),
    receipt: db.prepare('SELECT * FROM idempotency WHERE user_id = ? AND key = ?'),
    addReceipt: db.prepare('INSERT INTO idempotency VALUES (?, ?, ?, ?)')
  };
  function newSession(user) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now() + sessionMs;
    sql.pruneSessions.run(now());
    sql.addSession.run(digest(token), user.id, expiresAt);
    return { user: { id: user.id, email: user.email }, token, expiresAt };
  }
  // A bounded, per-process login/signup limiter. Proxy IP headers are deliberately not trusted.
  const authHits = new Map();
  function authAllowed(req, res) {
    const time = now();
    for (const [ip, entry] of authHits) if (entry.until <= time) authHits.delete(ip);
    const ip = req.socket.remoteAddress;
    const entry = authHits.get(ip) || { count: 0, until: time + 60000 };
    entry.count++;
    authHits.set(ip, entry);
    if (entry.count <= 30) return true;
    res.setHeader('Retry-After', String(Math.ceil((entry.until - time) / 1000)));
    respond(res, 429, { error: 'rate_limited', message: 'Too many sign-in attempts; retry after the indicated delay' });
    return false;
  }
  const dummySalt = randomBytes(16).toString('hex');
  const dummyHash = Buffer.alloc(64);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      if (req.method === 'GET' && route === '/') return respond(res, 200, {
        service: 'Private expense tracker', repository: 'https://github.com/saikatdas47/expense-tracker',
        health: '/health', signup: '/auth/signup', login: '/auth/login', expenses: '/expenses'
      });
      if (req.method === 'GET' && route === '/health') return respond(res, 200, { ok: true });
      if (req.method === 'POST' && (route === '/auth/signup' || route === '/auth/login')) {
        if (!authAllowed(req, res)) return;
        let input;
        try { input = await readBody(req); }
        catch (error) { return validation(res, { body: error.message }); }
        const fields = credentials(input);
        if (Object.keys(fields).length) return validation(res, fields);
        const email = input.email.toLowerCase();
        if (route === '/auth/signup') {
          const salt = randomBytes(16).toString('hex');
          const hash = await hashPassword(input.password, salt, 64);
          const user = sql.addUser.get(email, salt, hash.toString('hex'), new Date(now()).toISOString());
          if (!user) return respond(res, 409, { error: 'conflict', fields: { email: 'already registered' } });
          return respond(res, 201, newSession(user));
        }
        const user = sql.user.get(email);
        const computed = await hashPassword(input.password, user?.password_salt || dummySalt, 64);
        const expected = user ? Buffer.from(user.password_hash, 'hex') : dummyHash;
        const matches = timingSafeEqual(computed, expected);
        if (!user || !matches) return respond(res, 401, { error: 'unauthenticated', message: 'Email or password is incorrect' });
        return respond(res, 200, newSession(user));
      }
      const protectedRoute = route === '/expenses' || /^\/expenses\/[^/]+$/.test(route) || route === '/auth/logout';
      if (!protectedRoute) return respond(res, 404, { error: 'not_found', message: 'Route was not found' });
      const match = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
      const token = match?.[1];
      const session = token && sql.authenticate.get(digest(token), now());
      if (!session) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return respond(res, 401, { error: 'unauthenticated', message: 'Provide a valid Bearer token from sign-in' });
      }
      const userId = session.user_id;
      if (req.method === 'POST' && route === '/auth/logout') {
        sql.logout.run(digest(token));
        return respond(res, 200, { ok: true });
      }
      if (req.method === 'GET' && route === '/expenses') {
        const limit = integer(url.searchParams.get('limit') ?? '20', 1, 100);
        const before = integer(url.searchParams.get('before') ?? String(Number.MAX_SAFE_INTEGER));
        const fields = {};
        if (limit === null) fields.limit = 'must be an integer between 1 and 100';
        if (before === null) fields.before = 'must be a positive integer cursor';
        if (Object.keys(fields).length) return validation(res, fields);
        const rows = sql.list.all(userId, before, limit + 1);
        const items = rows.slice(0, limit).map(publicExpense);
        return respond(res, 200, { items, nextCursor: rows.length > limit ? items.at(-1).id : null });
      }
      if (req.method === 'POST' && route === '/expenses') {
        let input;
        try { input = await readBody(req); }
        catch (error) { return validation(res, { body: error.message }); }
        const fields = {};
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) fields['Idempotency-Key'] = 'must contain 1 to 128 letters, digits, underscores or hyphens';
        if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) fields.title = 'must be a nonempty string of at most 200 characters';
        if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1 || input.amountCents > 100000000) fields.amountCents = 'must be an integer between 1 and 100000000';
        if (Object.keys(fields).length) return validation(res, fields);
        const title = input.title.trim();
        const requestHash = digest(JSON.stringify({ title, amountCents: input.amountCents }));
        db.exec('BEGIN IMMEDIATE');
        let result;
        try {
          const receipt = sql.receipt.get(userId, key);
          if (receipt) {
            if (receipt.request_hash !== requestHash) result = { status: 409, body: { error: 'conflict', fields: { 'Idempotency-Key': 'was already used with different expense data; use a new key' } } };
            else result = { status: 201, body: JSON.parse(receipt.response_json) };
          } else {
            const row = sql.addExpense.get(userId, title, input.amountCents, new Date(now()).toISOString());
            const response = { expense: publicExpense(row) };
            sql.addReceipt.run(userId, key, requestHash, JSON.stringify(response));
            result = { status: 201, body: response };
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return respond(res, result.status, result.body);
      }
      const expenseMatch = route.match(/^\/expenses\/([^/]+)$/);
      if (expenseMatch && (req.method === 'GET' || req.method === 'DELETE')) {
        const id = integer(expenseMatch[1]);
        if (id === null) return validation(res, { id: 'must be a positive integer' });
        // Ownership is part of every database predicate, including writes.
        const row = req.method === 'GET' ? sql.detail.get(userId, id) : sql.remove.get(userId, id);
        if (!row) return respond(res, 404, { error: 'not_found', message: 'Expense was not found' });
        return respond(res, 200, req.method === 'GET' ? { expense: publicExpense(row) } : { ok: true });
      }
      return respond(res, 405, { error: 'method_not_allowed', message: 'Use a documented method for this route' });
    } catch (error) {
      const id = randomUUID();
      console.error(JSON.stringify({ id, error: error.name }));
      if (!res.headersSent) respond(res, 500, { error: 'internal', id });
      else res.end();
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = integer(process.env.PORT ?? '3003', 0, 65535);
  if (port === null) throw new Error('PORT must be an integer between 0 and 65535');
  const server = createService(process.env.DB_PATH || './data/expenses.db');
  server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ listening: server.address().port })));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createService } from '../server.js';
import { startProcess, stopProcess } from '../processes.js';

async function request(base, path, method = 'GET', token, value, key) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: value === undefined ? undefined : JSON.stringify(value)
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('private rows, durable concurrent idempotency, validation, login and logout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'expense-test-'));
  const path = join(directory, 'expenses.db');
  const services = [];
  try {
    services.push(await startProcess(path));
    services.push(await startProcess(path));
    const base = services[0].base;
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-type').includes('text/html'));
    assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.ok((await page.text()).includes('Penny'));
    assert.equal((await fetch(base + '/app.js')).status, 200);
    assert.equal((await fetch(base + '/styles.css')).status, 200);
    assert.equal((await request(base, '/expenses')).status, 401);
    assert.equal((await request(base, '/expenses', 'POST', undefined, {})).status, 401);
    assert.equal((await request(base, '/expenses/1', 'GET')).status, 401);
    assert.equal((await request(base, '/expenses/1', 'DELETE')).status, 401);
    const invalidSignup = await request(base, '/auth/signup', 'POST', undefined, { email: 'wrong', password: 'short' });
    assert.equal(invalidSignup.status, 400);
    assert.ok(invalidSignup.body.fields.email && invalidSignup.body.fields.password);
    const alice = await request(base, '/auth/signup', 'POST', undefined, { email: 'alice@example.test', password: 'test-password-alice' });
    const bob = await request(base, '/auth/signup', 'POST', undefined, { email: 'bob@example.test', password: 'test-password-bob' });
    assert.equal(alice.status, 201);
    assert.equal(bob.status, 201);
    const a = alice.body.token, b = bob.body.token;
    assert.equal((await request(base, '/auth/signup', 'POST', undefined, { email: 'ALICE@example.test', password: 'test-password-alice' })).status, 409);
    assert.equal((await request(base, '/auth/login', 'POST', undefined, { email: 'alice@example.test', password: 'incorrect-password' })).status, 401);
    assert.equal((await request(base, '/auth/login', 'POST', undefined, { email: 'missing@example.test', password: 'incorrect-password' })).status, 401);
    assert.equal((await request(base, '/auth/login', 'POST', undefined, { email: 'alice@example.test', password: 'test-password-alice' })).status, 200);
    const invalid = await request(base, '/expenses', 'POST', a, { title: '', amountCents: 0 });
    assert.equal(invalid.status, 400);
    assert.ok(invalid.body.fields.title && invalid.body.fields.amountCents && invalid.body.fields['Idempotency-Key']);
    const malformed = await fetch(base + '/expenses', { method: 'POST', headers: { Authorization: `Bearer ${a}` }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.ok((await malformed.json()).fields.body);
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => request(services[i % 2].base, '/expenses', 'POST', a, { title: 'Lunch', amountCents: 1250, userId: bob.body.user.id }, 'lunch-1')));
    for (const response of responses) {
      assert.equal(response.status, 201);
      assert.deepEqual(response.body, responses[0].body);
    }
    const expense = responses[0].body.expense;
    assert.equal((await request(base, `/expenses/${expense.id}`, 'GET', b)).status, 404);
    assert.equal((await request(base, `/expenses/${expense.id}`, 'DELETE', b)).status, 404);
    assert.deepEqual((await request(base, '/expenses', 'GET', b)).body.items, []);
    assert.equal((await request(base, `/expenses/${expense.id}`, 'GET', a)).status, 200);
    const conflict = await request(base, '/expenses', 'POST', a, { title: 'Lunch', amountCents: 999 }, 'lunch-1');
    assert.equal(conflict.status, 409);
    assert.ok(conflict.body.fields['Idempotency-Key']);
    // Keys are scoped to an authenticated user, not globally.
    assert.equal((await request(base, '/expenses', 'POST', b, { title: 'Bob lunch', amountCents: 500 }, 'lunch-1')).status, 201);
    await request(base, '/expenses', 'POST', a, { title: 'Dinner', amountCents: 1500 }, 'dinner-1');
    const first = await request(base, '/expenses?limit=1', 'GET', a);
    assert.equal(first.body.items.length, 1);
    assert.ok(first.body.nextCursor);
    const second = await request(base, `/expenses?limit=1&before=${first.body.nextCursor}`, 'GET', a);
    assert.equal(second.body.items[0].id, expense.id);
    assert.equal(second.body.nextCursor, null);
    assert.equal((await request(base, '/expenses?limit=0', 'GET', a)).status, 400);
    assert.equal((await request(base, '/expenses/no', 'GET', a)).status, 400);
    await stopProcess(services[0]);
    services[0] = await startProcess(path);
    assert.deepEqual((await request(services[0].base, '/expenses', 'POST', a, { title: 'Lunch', amountCents: 1250 }, 'lunch-1')).body, responses[0].body);
    assert.equal((await request(services[0].base, `/expenses/${expense.id}`, 'DELETE', a)).status, 200);
    assert.deepEqual((await request(services[0].base, '/expenses', 'POST', a, { title: 'Lunch', amountCents: 1250 }, 'lunch-1')).body, responses[0].body);
    assert.equal((await request(services[0].base, `/expenses/${expense.id}`, 'GET', a)).status, 404);
    const db = new DatabaseSync(path);
    assert.equal(db.prepare('SELECT count(*) AS n FROM idempotency WHERE user_id = ? AND key = ?').get(alice.body.user.id, 'lunch-1').n, 1);
    assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(alice.body.user.id).password_hash.includes('test-password-alice'), false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE token_hash = ?').get(a).n, 0);
    db.close();
    assert.equal((await request(services[0].base, '/auth/logout', 'POST', a)).status, 200);
    assert.equal((await request(services[1].base, '/expenses', 'GET', a)).status, 401);
  } finally {
    await Promise.all(services.map(stopProcess));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('session expires exactly at its expiry time', async () => {
  let now = 1800000000000;
  const server = await createService(':memory:', { now: () => now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const signup = await request(base, '/auth/signup', 'POST', undefined, { email: 'expiry@example.test', password: 'expiry-test-password' });
    assert.equal(signup.status, 201);
    now = signup.body.expiresAt - 1;
    assert.equal((await request(base, '/expenses', 'GET', signup.body.token)).status, 200);
    now++;
    assert.equal((await request(base, '/expenses', 'GET', signup.body.token)).status, 401);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
});

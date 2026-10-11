import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startProcess, stopProcess } from '../processes.js';

test('PostgreSQL: account isolation, cross-process retries and persistent receipts', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const services = [];
  async function request(base, path, method = 'GET', token, body, key) {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    services.push(await startProcess(':memory:', { databaseUrl: url.href }));
    services.push(await startProcess(':memory:', { databaseUrl: url.href }));
    const base = services[0].base;
    assert.equal((await request(base, '/expenses')).status, 401);
    const alice = await request(base, '/auth/signup', 'POST', undefined, { email: 'alice@example.test', password: 'postgres-test-alice' });
    const bob = await request(base, '/auth/signup', 'POST', undefined, { email: 'bob@example.test', password: 'postgres-test-bob' });
    assert.equal(alice.status, 201); assert.equal(bob.status, 201);
    const token = alice.body.token;
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => request(services[i % 2].base, '/expenses', 'POST', token, { title: 'Coffee', amountCents: 450 }, 'coffee-1')));
    for (const response of responses) { assert.equal(response.status, 201); assert.deepEqual(response.body, responses[0].body); }
    assert.equal(Number((await pool.query(`SELECT COUNT(*) AS n FROM ${schema}.expenses`)).rows[0].n), 1);
    const id = responses[0].body.expense.id;
    assert.equal((await request(base, `/expenses/${id}`, 'GET', bob.body.token)).status, 404);
    assert.equal((await request(base, `/expenses/${id}`, 'DELETE', bob.body.token)).status, 404);
    const list = await request(base, '/expenses', 'GET', token);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.summary, { count: 1, totalCents: 450 });
    assert.deepEqual((await request(base, '/expenses', 'GET', bob.body.token)).body.items, []);
    assert.equal((await request(base, '/expenses', 'POST', token, { title: 'Coffee', amountCents: 999 }, 'coffee-1')).status, 409);
    await stopProcess(services[0]);
    services[0] = await startProcess(':memory:', { databaseUrl: url.href });
    assert.deepEqual((await request(services[0].base, '/expenses', 'POST', token, { title: 'Coffee', amountCents: 450 }, 'coffee-1')).body, responses[0].body);
    assert.equal((await request(services[0].base, `/expenses/${id}`, 'DELETE', token)).status, 200);
    assert.deepEqual((await request(services[0].base, '/expenses', 'POST', token, { title: 'Coffee', amountCents: 450 }, 'coffee-1')).body, responses[0].body);
    assert.equal(Number((await pool.query(`SELECT COUNT(*) AS n FROM ${schema}.expenses`)).rows[0].n), 0);
  } finally {
    await Promise.all(services.map(stopProcess));
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});

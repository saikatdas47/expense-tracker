import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createService } from '../server.js';

test('retry identity trims title whitespace but rejects a changed amount', async () => {
  const server = await createService(':memory:');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const signup = await fetch(base + '/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'retry@example.test', password: 'retry-test-password' }) });
    const { token } = await signup.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'normalised-retry' };
    const create = (title, amountCents) => fetch(base + '/expenses', { method: 'POST', headers, body: JSON.stringify({ title, amountCents }) });
    const original = await create('  Lunch  ', 1250);
    assert.equal(original.status, 201);
    const result = await original.json();
    assert.equal(result.expense.title, 'Lunch');
    const retry = await create('Lunch', 1250);
    assert.equal(retry.status, 201);
    assert.deepEqual(await retry.json(), result);
    const changed = await create('Lunch', 1251);
    assert.equal(changed.status, 409);
    assert.ok((await changed.json()).fields['Idempotency-Key']);
    const list = await (await fetch(base + '/expenses', { headers })).json();
    assert.deepEqual(list.items, [result.expense]);
    assert.equal(list.summary.totalCents, 1250);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

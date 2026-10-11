import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createService } from '../server.js';

test('cursor pages survive new rows and totals cover the whole account', async () => {
  const server = await createService(':memory:');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const signup = await fetch(base + '/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'pages@example.test', password: 'pagination-password' }) });
    const { token } = await signup.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    async function create(title, amountCents) {
      const response = await fetch(base + '/expenses', { method: 'POST', headers: { ...headers, 'Idempotency-Key': title }, body: JSON.stringify({ title, amountCents }) });
      assert.equal(response.status, 201); return (await response.json()).expense;
    }
    const first = await create('First', 100);
    const second = await create('Second', 200);
    const third = await create('Third', 300);
    const page = await (await fetch(base + '/expenses?limit=1', { headers })).json();
    assert.equal(page.items[0].id, third.id);
    assert.deepEqual(page.summary, { count: 3, totalCents: 600 });
    await create('New-arrival', 400);
    const rest = await (await fetch(base + '/expenses?limit=2&before=' + page.nextCursor, { headers })).json();
    assert.deepEqual(rest.items.map(row => row.id), [second.id, first.id]);
    assert.equal(rest.nextCursor, null);
    assert.deepEqual(rest.summary, { count: 4, totalCents: 1000 });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createService } from '../server.js';

test('oversized and non-object bodies return field errors without consuming a create key', async () => {
  const server = await createService(':memory:');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const signup = await fetch(base + '/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'boundary@example.test', password: 'boundary-test-password' })
    });
    const { token } = await signup.json();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': 'boundary-key' };
    for (const body of ['null', '[]', '"text"', '{', JSON.stringify({ title: 'x'.repeat(17000), amountCents: 100 })]) {
      const response = await fetch(base + '/expenses', { method: 'POST', headers, body });
      assert.equal(response.status, 400);
      assert.ok((await response.json()).fields.body);
    }
    const before = await (await fetch(base + '/expenses', { headers })).json();
    assert.deepEqual(before.items, []);
    assert.equal(before.summary.count, 0);
    const validBody = JSON.stringify({ title: 'Valid expense', amountCents: 100 });
    const created = await fetch(base + '/expenses', { method: 'POST', headers, body: validBody });
    assert.equal(created.status, 201);
    const result = await created.json();
    const replay = await fetch(base + '/expenses', { method: 'POST', headers, body: validBody });
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), result);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

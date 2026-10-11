import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createService } from '../server.js';

test('signup and login share a limit that resets exactly after 60 seconds', async () => {
  let now = 1800000000000;
  const server = await createService(':memory:', { now: () => now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const attempt = route => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  try {
    for (let i = 0; i < 30; i++) {
      assert.equal((await attempt(i % 2 ? '/auth/login' : '/auth/signup')).status, 400);
    }
    now += 59999;
    const blocked = await attempt('/auth/login');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('Retry-After'), '1');
    assert.equal((await blocked.json()).error, 'rate_limited');
    // Public readiness remains available while auth is throttled.
    assert.equal((await fetch(base + '/health')).status, 200);
    now++;
    assert.equal((await attempt('/auth/signup')).status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

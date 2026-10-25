import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { CallRateLimiter } from '../src/rate-limit.js';
import { KnowledgeStore } from '../src/store.js';
import { ApiKeys } from '../src/api-keys.js';
import { createApp, validateConfig } from '../src/server.js';

const config = { maintainerToken: 'rate-limit-test-'.repeat(4), publicUrl: 'http://localhost:8080' };

test('sliding windows expire individual requests; rejections do not prolong the wait', () => {
  let now = 0;
  const limiter = new CallRateLimiter(2, { now: () => now });
  assert.equal(limiter.consume('alice'), 0);
  now = 30_000;
  assert.equal(limiter.consume('alice'), 0);
  assert.equal(limiter.consume('alice'), 30);
  assert.equal(limiter.consume('bob'), 0);
  now = 59_999;
  assert.equal(limiter.consume('alice'), 1);
  now = 60_000;
  assert.equal(limiter.consume('alice'), 0);
  assert.equal(limiter.consume('alice'), 30);
  now = 90_000;
  assert.equal(limiter.consume('alice'), 0);
  assert.equal(limiter.consume('alice'), 30);
  now = 180_000;
  assert.equal(limiter.consume('alice'), 0);
  assert.equal(limiter.consume('alice'), 0);
});

test('rate configuration defaults to 100, supports 1000, and rejects invalid limits', () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity, null, '100', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateConfig({ ...config, callRateLimitPerMinute: limit }), /MCP_CALL_RATE_LIMIT_PER_MINUTE/);
  }
  for (const limit of [undefined, 1000]) {
    validateConfig({ ...config, callRateLimitPerMinute: limit });
    const limiter = new CallRateLimiter(limit, { now: () => 0 });
    for (let i = 0; i < (limit ?? 100); i++) assert.equal(limiter.consume('key'), 0);
    assert.equal(limiter.consume('key'), 60);
  }
});

test('HTTP budgets are per key across protocol versions and reject before writes or body parsing', async t => {
  let now = 0;
  const store = new KnowledgeStore(':memory:');
  const keys = new ApiKeys(store.db);
  const alice = keys.create('Alice');
  const bob = keys.create('Bob');
  const listener = createApp(store, { ...config, callRateLimitPerMinute: 2 }, { rateLimitNow: () => now }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(async () => { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); store.close(); });
  const url = `http://127.0.0.1:${listener.address().port}`;
  const rpc = (token, method = 'tools/list', params = {}, modern = false) => fetch(`${url}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(modern ? { 'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': method, ...(params.name ? { 'MCP-Name': params.name } : {}) } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, ...(modern ? { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}
    } } : {}) } })
  });
  assert.equal((await rpc('invalid')).status, 401);
  assert.equal((await rpc(alice.token, 'server/discover', {}, true)).status, 200);
  assert.equal((await rpc(alice.token)).status, 200);
  const rejected = await rpc(alice.token, 'tools/list', {}, true);
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get('retry-after'), '60');
  assert.equal(rejected.headers.get('cache-control'), 'no-store');
  assert.equal((await rejected.json()).retry_after_seconds, 60);
  assert.equal((await rpc(bob.token)).status, 200);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  // Changing IP headers or protocol does not grant a fresh budget.
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: {
    Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.42'
  }, body: '{broken' })).status, 429);
  assert.equal((await rpc(config.maintainerToken)).status, 200);
  assert.equal((await rpc(config.maintainerToken)).status, 200);
  const save = { name: 'save_draft', arguments: { id: 'blocked', expected_revision: 0,
    content: { title: 'Blocked write', problem: 'Must not be saved', robin_code: 'SET X TO 1', power_fx: 'disabled' } } };
  assert.equal((await rpc(config.maintainerToken, 'tools/call', save, true)).status, 429);
  assert.equal(store.list({}).entries.length, 0);
  now = 60_000;
  assert.equal((await rpc(config.maintainerToken, 'tools/call', save, true)).status, 200);
  assert.equal(store.get('blocked', 'maintainer').revision, 1);
  const burst = await Promise.all(Array.from({ length: 8 }, () => rpc(alice.token)));
  assert.equal(burst.filter(response => response.status === 200).length, 2);
  assert.equal(burst.filter(response => response.status === 429).length, 6);
  keys.delete(alice.id);
  assert.equal((await rpc(alice.token)).status, 401);
});

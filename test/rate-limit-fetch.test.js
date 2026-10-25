import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimitFetch } from '../scripts/rate-limit-fetch.js';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import { KnowledgeStore } from '../src/store.js';
import { createApp } from '../src/server.js';
import { contentSchema } from '../src/schema.js';

test('transfer retries explicit 429 rejections using Retry-After and the unchanged request', async () => {
  const calls = [], waits = [];
  const request = { method: 'POST', body: '{"jsonrpc":"2.0","id":1}' };
  const retry = createRateLimitFetch({
    fetchImpl: async (...args) => { calls.push(args); return calls.length === 1
      ? new Response('limited', { status: 429, headers: { 'Retry-After': '60' } }) : new Response('ok'); },
    sleep: async ms => { waits.push(ms); }, warn: () => {}
  });
  assert.equal((await retry('http://localhost/mcp', request)).status, 200);
  assert.deepEqual(waits, [60_000]);
  assert.deepEqual(calls, [['http://localhost/mcp', request], ['http://localhost/mcp', request]]);
});

test('transfer caps retries, respects cancellation, and never retries uncertain failures', async () => {
  let calls = 0;
  const limited = createRateLimitFetch({ fetchImpl: async () => { calls++; return new Response(null, { status: 429, headers: { 'Retry-After': '1' } }); },
    sleep: async () => {}, warn: () => {} });
  assert.equal((await limited('http://localhost/mcp')).status, 429);
  assert.equal(calls, 4);
  for (const [status, header] of [[500, '1'], [401, '1'], [429, 'invalid'], [429, '0'], [429, '61'], [429, null]]) {
    calls = 0;
    const retry = createRateLimitFetch({ fetchImpl: async () => { calls++; return new Response(null, { status, headers: header === null ? {} : { 'Retry-After': header } }); },
      sleep: async () => assert.fail('Must not wait'), warn: () => {} });
    assert.equal((await retry('http://localhost/mcp')).status, status);
    assert.equal(calls, 1);
  }
  calls = 0;
  const failure = new Error('Connection lost after a possible write');
  const broken = createRateLimitFetch({ fetchImpl: async () => { calls++; throw failure; } });
  await assert.rejects(broken('http://localhost/mcp'), error => error === failure);
  assert.equal(calls, 1);
  const controller = new AbortController();
  calls = 0;
  const cancelled = createRateLimitFetch({ fetchImpl: async () => { calls++; return new Response(null, { status: 429, headers: { 'Retry-After': '1' } }); },
    sleep: async (_ms, _value, { signal }) => { controller.abort(); signal.throwIfAborted(); }, warn: () => {} });
  await assert.rejects(cancelled('http://localhost/mcp', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('real transfer CLI waits through handshake and tool rate limits without duplicate imports', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pad-mcp-rate-transfer-'));
  const store = new KnowledgeStore(':memory:');
  const token = 'transfer-rate-test-'.repeat(3);
  store.saveDraft({ id: 'original', expected_revision: 0, content: contentSchema.parse({
    title: 'Original', problem: 'Transfer without duplication', robin_code: 'SET Value TO 1', power_fx: 'disabled'
  }) });
  store.publish({ id: 'original', revision: 1 });
  const rejected = new Set();
  const app = express();
  app.use(express.json());
  // Test-only admission rejections, before the actual MCP application runs.
  app.use((req, res, next) => {
    if (!req.body) return next();
    const operation = req.body.method === 'tools/call' ? req.body.params.name : req.body.method;
    if (['initialize', 'notifications/initialized', 'export_knowledge', 'import_knowledge'].includes(operation) && !rejected.has(operation)) {
      rejected.add(operation);
      return res.status(429).set('Retry-After', '1').json({ error: 'Test admission limit; not executed' });
    }
    next();
  });
  app.use(createApp(store, { maintainerToken: token, publicUrl: 'http://localhost:8080' }));
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(async () => {
    listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const env = { ...process.env, MCP_URL: `http://127.0.0.1:${listener.address().port}/mcp`, MCP_MAINTAINER_TOKEN: token };
  const output = join(directory, 'export.json');
  const run = (...args) => promisify(execFile)(process.execPath, ['scripts/transfer.js', ...args], { env, timeout: 20_000 });
  const exported = await run('export', output);
  assert.match(exported.stderr, /Rate limited; retrying in 1s/);
  const pack = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(pack.entries.length, 1);
  pack.entries[0].id = 'imported';
  const input = join(directory, 'import.json');
  writeFileSync(input, JSON.stringify(pack));
  const imported = await run('import', input);
  assert.match(imported.stderr, /Rate limited; retrying in 1s/);
  assert.deepEqual([...rejected].sort(), ['export_knowledge', 'import_knowledge', 'initialize', 'notifications/initialized']);
  assert.equal(store.get('imported', 'maintainer').revision, 1);
  assert.equal(store.get('imported', 'maintainer').published, false);
  assert.equal(store.list({}).entries.length, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { KnowledgeStore } from '../src/store.js';
import { ApiKeys } from '../src/api-keys.js';
import { UsageStats } from '../src/usage.js';
import { createApp, validateConfig } from '../src/server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('daily aggregates, exact retention boundary, pagination, opt-out and key deletion', () => {
  const store = new KnowledgeStore(':memory:');
  try {
    const keys = new ApiKeys(store.db);
    const key = keys.create('Roby');
    let date = new Date('2026-01-01T12:00:00Z');
    const usage = new UsageStats(store.db, { now: () => date });
    const call = { keyId: key.id, tool: 'search_patterns', mode: 'classic', success: true, empty: true };
    for (let i = 0; i < 100; i++) usage.record(call);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get().n, 1);
    usage.record({ ...call, success: false });
    let report = usage.report();
    assert.deepEqual({ ...report.summary }, { calls: 101, successes: 100, errors: 1, empty_results: 100, active_keys: 1 });
    date = new Date('2026-03-31T23:59:59Z'); // Jan 1 is the oldest of 90 UTC dates.
    usage.cleanup();
    assert.equal(usage.report({ days: 90 }).summary.calls, 101);
    date = new Date('2026-04-01T00:00:00Z');
    usage.cleanup();
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get().n, 0);
    usage.record(call);
    usage.record({ ...call, tool: 'search_actions', mode: 'power_fx' });
    report = usage.report({ group_by: 'tool', limit: 1 });
    assert.equal(report.summary.calls, 2);
    assert.equal(report.next_offset, 1);
    assert.equal(usage.report({ group_by: 'tool', limit: 1, offset: 1 }).next_offset, null);
    assert.equal(usage.report({ group_by: 'key' }).results[0].name, 'Roby');
    assert.equal(keys.list()[0].last_used_at, date.toISOString());
    new UsageStats(store.db, { enabled: false }).record(call);
    assert.equal(usage.report().summary.calls, 2);
    keys.delete(key.id);
    usage.record(call); // In-flight request cannot restore a deleted key.
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get().n, 0);
    assert.equal(usage.recordingFailures, 0);
  } finally { store.close(); }
});

test('v4 migration preserves keys, contexts and knowledge, and counters persist on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pad-usage-'));
  const path = join(dir, 'db.sqlite');
  let store = new KnowledgeStore(path);
  try {
    const key = new ApiKeys(store.db).create('Roby');
    const context = store.developmentContext({ power_fx: 'enabled' });
    store.saveDraft({ id: 'preserved', expected_revision: 0, content: { title: 'Keep', problem: 'Keep', robin_code: 'original' } });
    const original = store.get('preserved', 'maintainer');
    store.db.exec('DROP TABLE usage_daily; ALTER TABLE api_keys DROP COLUMN last_used_at; PRAGMA user_version = 4;');
    store.close();
    store = new KnowledgeStore(path);
    assert.equal(new ApiKeys(store.db).authenticate(key.token).id, key.id);
    assert.deepEqual(store.developmentContext({ context_id: context.context_id }), context);
    assert.deepEqual(store.get('preserved', 'maintainer'), original);
    new UsageStats(store.db).record({ keyId: key.id, tool: 'export_knowledge', mode: 'not_applicable', success: true });
    store.close();
    store = new KnowledgeStore(path);
    assert.equal(new UsageStats(store.db).report().summary.calls, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('MCP usage is maintainer-only, content-free, excludes protocol traffic and survives metric failures', async t => {
  const store = new KnowledgeStore(':memory:');
  const key = new ApiKeys(store.db).create('Roby');
  const config = { maintainerToken: 'm'.repeat(48), publicUrl: 'http://localhost:8080' };
  const app = createApp(store, config, { catalogCache: { checkForUpdates: async () => ({ status: 'current' }),
    get: async () => ({ searchActions: () => ({ record: null }), searchTypes: () => ({ results: [] }) }) } });
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(async () => { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); store.close(); });
  const rpc = async (token, method, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/mcp`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: response.status, body: await response.json() };
  };
  const call = async (token, name, args = {}) => (await rpc(token, 'tools/call', { name, arguments: args })).body;
  const report = async () => (await call(config.maintainerToken, 'get_usage_stats')).result.structuredContent;
  assert.ok(!(await rpc(key.token, 'tools/list')).body.result.tools.some(tool => tool.name === 'get_usage_stats'));
  const denied = await call(key.token, 'get_usage_stats');
  assert.ok(denied.error || denied.result?.isError);
  assert.equal((await rpc('wrong', 'tools/list')).status, 401);
  await call(key.token, 'search_patterns', {}); // SDK validation rejects before handler.
  assert.equal((await report()).summary.calls, 0);
  const context = (await call(key.token, 'get_development_context', { power_fx: 'enabled' })).result.structuredContent;
  await call(key.token, 'search_patterns', { context_id: context.context_id, query: 'PRIVATE_QUERY_SENTINEL' });
  await call(key.token, 'search_actions', { context_id: context.context_id, action_id: 'missing' });
  await call(key.token, 'search_type_reference', { context_id: context.context_id, query: 'missing' });
  await call(key.token, 'get_pattern', { id: 'missing', context_id: context.context_id });
  await call(config.maintainerToken, 'get_development_context', { power_fx: 'disabled' });
  assert.deepEqual((await report()).summary, { calls: 5, successes: 4, errors: 1, empty_results: 3, active_keys: 1 });
  const rows = store.db.prepare('SELECT * FROM usage_daily').all();
  assert.ok(rows.every(row => row.mode === 'power_fx'));
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_QUERY_SENTINEL'));
  assert.ok(!JSON.stringify(rows).includes(key.token));
  assert.deepEqual(Object.keys(rows[0]).sort(), ['day','key_id','tool','mode','calls','successes','errors','empty_results'].sort());
  store.db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON usage_daily BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.equal((await call(key.token, 'get_development_context', {})).result.structuredContent.status, 'selection_required');
  assert.equal((await report()).recording_failures_since_start, 1);
  assert.equal((await report()).summary.calls, 5);
  assert.throws(() => validateConfig({ ...config, usageRetentionDays: 0 }), /USAGE_RETENTION_DAYS/);
  assert.throws(() => validateConfig({ ...config, usageEnabled: 'false' }), /USAGE_STATS_ENABLED/);
});

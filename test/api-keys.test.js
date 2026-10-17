import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KnowledgeStore } from '../src/store.js';
import { ApiKeys } from '../src/api-keys.js';
import { createApp } from '../src/server.js';

const exec = promisify(execFile);
const maintainerToken = 'm'.repeat(48);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pad-keys-'));
  const path = join(dir, 'knowledge.sqlite');
  return path;
}

test('keys persist as hashes, have no expiry, and deletion removes the record permanently', t => {
  const path = fixture();
  let store = new KnowledgeStore(path);
  t.after(() => { store.close(); rmSync(dirname(path), { recursive: true, force: true }); });
  let keys = new ApiKeys(store.db);
  const key = keys.create('  Alice  ');
  const other = keys.create('Bob');
  assert.equal(key.name, 'Alice');
  assert.match(key.token, /^pad_dev_[a-f0-9]{64}$/);
  assert.equal(keys.authenticate(key.token).id, key.id);
  assert.equal(keys.authenticate('invalid'), null);
  const saved = store.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(key.id);
  assert.match(saved.token_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(saved).includes(key.token));
  assert.ok(!JSON.stringify(keys.list()).includes(saved.token_hash));
  assert.ok(!('expires_at' in saved));
  for (const invalid of ['', ' ', 'x'.repeat(101), 'a\nb']) assert.throws(() => keys.create(invalid), /Name must/);
  assert.deepEqual(keys.delete(key.id), { id: key.id, deleted: true });
  assert.equal(store.db.prepare('SELECT * FROM api_keys WHERE id = ? OR token_hash = ?').get(key.id, saved.token_hash), undefined);
  assert.throws(() => keys.delete(key.id), /not found/);
  assert.throws(() => keys.delete('missing'), /not found/);
  store.close();
  store = new KnowledgeStore(path);
  keys = new ApiKeys(store.db);
  assert.equal(keys.authenticate(key.token), null);
  assert.equal(keys.authenticate(other.token).id, other.id);
  assert.equal(keys.list().length, 1);
});

test('v3 migration preserves knowledge and immutable contexts', t => {
  const path = fixture();
  let store = new KnowledgeStore(path);
  t.after(() => { store.close(); rmSync(dirname(path), { recursive: true, force: true }); });
  const context = store.developmentContext({ power_fx: 'enabled' });
  const before = store.export({});
  store.db.exec('DROP TABLE usage_daily; DROP TABLE api_keys; PRAGMA user_version = 3;');
  store.close();
  store = new KnowledgeStore(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.deepEqual(store.export({}), before);
  assert.deepEqual(store.developmentContext({ context_id: context.context_id }), context);
});

test('CLI changes are visible to a running server and developer keys cannot invoke maintainer tools', async t => {
  const path = fixture();
  const store = new KnowledgeStore(path);
  const app = createApp(store, { maintainerToken, publicUrl: 'http://localhost:8080' }, {
    catalogCache: { checkForUpdates: async () => ({ status: 'current' }) }
  });
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  });
  const cli = async (...args) => {
    const { stdout } = await exec(process.execPath, ['scripts/keys.js', ...args], {
      env: { ...process.env, DATABASE_PATH: path }
    });
    return JSON.parse(stdout);
  };
  const request = (token, method, params = {}) => fetch(`http://127.0.0.1:${listener.address().port}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const key = await cli('create', '--name', 'Reddit Alice');
  const second = await cli('create', '--name', 'Bob');
  const list = await cli('list');
  assert.equal(list.length, 2);
  assert.ok(!JSON.stringify(list).includes(key.token));
  assert.ok(!JSON.stringify(list).includes('token_hash'));
  const toolsResponse = await request(key.token, 'tools/list');
  assert.equal(toolsResponse.status, 200);
  const names = (await toolsResponse.json()).result.tools.map(tool => tool.name);
  assert.ok(names.includes('search_patterns'));
  assert.ok(!names.includes('save_draft'));
  const forbidden = await request(key.token, 'tools/call', { name: 'save_draft', arguments: {} });
  const body = await forbidden.json();
  assert.ok(body.error || body.result?.isError);
  const context = await request(key.token, 'tools/call', { name: 'get_development_context', arguments: { power_fx: 'enabled' } });
  assert.equal((await context.json()).result.structuredContent.status, 'ready');
  await assert.rejects(cli('disable', '--id', key.id));
  assert.equal((await request(key.token, 'tools/list')).status, 200);
  assert.deepEqual(await cli('delete', '--id', key.id), { id: key.id, deleted: true });
  assert.deepEqual((await cli('list')).map(item => item.id), [second.id]);
  assert.equal(store.db.prepare('SELECT 1 FROM api_keys WHERE id = ?').get(key.id), undefined);
  assert.equal((await request(key.token, 'tools/list')).status, 401);
  assert.equal((await request(second.token, 'tools/list')).status, 200);
  const admin = await request(maintainerToken, 'tools/list');
  assert.ok((await admin.json()).result.tools.some(tool => tool.name === 'save_draft'));
  await assert.rejects(cli('create', '--name', 'No', '--role', 'maintainer'));
  await assert.rejects(cli('delete', '--id', key.id));
  await assert.rejects(cli('delete', '--id', 'missing'));
});

test('keys disabled by older releases stay rejected and can be permanently deleted', () => {
  const store = new KnowledgeStore(':memory:');
  try {
    const keys = new ApiKeys(store.db);
    const old = keys.create('Old disabled key');
    const active = keys.create('Roby');
    store.db.prepare('UPDATE api_keys SET disabled_at = ? WHERE id = ?').run(new Date().toISOString(), old.id);
    assert.equal(keys.authenticate(old.token), null);
    assert.ok(keys.list().find(key => key.id === old.id).disabled_at);
    keys.delete(old.id);
    assert.equal(store.db.prepare('SELECT 1 FROM api_keys WHERE id = ?').get(old.id), undefined);
    assert.equal(keys.authenticate(active.token).id, active.id);
  } finally { store.close(); }
});

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

test('keys persist as hashes, have no expiry, and disable is permanent and idempotent', t => {
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
  const disabled = keys.disable(key.id);
  assert.deepEqual(keys.disable(key.id), disabled);
  assert.throws(() => keys.disable('missing'), /not found/);
  store.close();
  store = new KnowledgeStore(path);
  keys = new ApiKeys(store.db);
  assert.equal(keys.authenticate(key.token), null);
  assert.equal(keys.authenticate(other.token).id, other.id);
  assert.equal(keys.list().length, 2);
});

test('legacy developer token imports once and cannot be resurrected by restart or env changes', t => {
  const path = fixture();
  let store = new KnowledgeStore(path);
  t.after(() => { store.close(); rmSync(dirname(path), { recursive: true, force: true }); });
  let keys = new ApiKeys(store.db);
  keys.importLegacy(undefined);
  const legacy = 'd'.repeat(48);
  keys.importLegacy(legacy);
  const key = keys.authenticate(legacy);
  keys.disable(key.id);
  store.close();
  store = new KnowledgeStore(path);
  keys = new ApiKeys(store.db);
  keys.importLegacy(legacy);
  keys.importLegacy('e'.repeat(48));
  assert.equal(keys.authenticate(legacy), null);
  assert.equal(keys.authenticate('e'.repeat(48)), null);
  assert.equal(keys.list().length, 1);
});

test('v3 migration preserves knowledge and immutable contexts', t => {
  const path = fixture();
  let store = new KnowledgeStore(path);
  t.after(() => { store.close(); rmSync(dirname(path), { recursive: true, force: true }); });
  const context = store.developmentContext({ power_fx: 'enabled' });
  const before = store.export({});
  store.db.exec('DROP TABLE api_keys; DROP TABLE api_keys_bootstrap; PRAGMA user_version = 3;');
  store.close();
  store = new KnowledgeStore(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
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
  await cli('disable', '--id', key.id);
  assert.equal((await request(key.token, 'tools/list')).status, 401);
  assert.equal((await request(second.token, 'tools/list')).status, 200);
  const admin = await request(maintainerToken, 'tools/list');
  assert.ok((await admin.json()).result.tools.some(tool => tool.name === 'save_draft'));
  await assert.rejects(cli('create', '--name', 'No', '--role', 'maintainer'));
  await assert.rejects(cli('disable', '--id', 'missing'));
});

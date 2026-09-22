import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { KnowledgeStore } from '../src/store.js';
import { createApp, validateConfig } from '../src/server.js';
import { contentSchema } from '../src/schema.js';

const config = { maintainerToken: 'a'.repeat(48), developerToken: 'b'.repeat(48), publicUrl: 'http://localhost:8080' };
const code = "\r\nSET Example TO $fx'=1'\r\n  # Unicode preservation fixture: café ☕\r\n";
const content = (extra = {}) => contentSchema.parse({ title: 'Pagination example', problem: 'Divide a list into batches', robin_code: code, tags: ['pagination'], ...extra });

async function setup(t) {
  const store = new KnowledgeStore(':memory:');
  const listener = createApp(store, config).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const url = `http://127.0.0.1:${listener.address().port}`;
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await new Promise(resolve => listener.close(resolve));
    store.close();
  });
  async function connect(token) {
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    }));
    return client;
  }
  return { store, url, maintainer: await connect(config.maintainerToken), developer: await connect(config.developerToken) };
}

async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response));
  return response.structuredContent;
}
async function save(client, id, extra = {}, revision = 0) {
  return call(client, 'save_draft', { id, expected_revision: revision, content: content(extra) });
}
async function publish(client, id, revision = 1) {
  return call(client, 'publish_revision', { id, revision });
}

test('real MCP handshake, instructions and server-side tool permissions', async t => {
  const { maintainer, developer } = await setup(t);
  assert.match(maintainer.getInstructions(), /get_development_context/);
  assert.ok((await maintainer.listTools()).tools.some(tool => tool.name === 'save_draft'));
  assert.ok(!(await developer.listTools()).tools.some(tool => tool.name === 'save_draft'));
  const forbidden = await developer.callTool({ name: 'save_draft', arguments: { id: 'forbidden', expected_revision: 0, content: content() } });
  assert.equal(forbidden.isError, true);
  assert.equal((await call(maintainer, 'list_patterns')).entries.length, 0);
});
test('draft -> exact publication -> new draft preserves published code and revision history', async t => {
  const { maintainer, developer } = await setup(t);
  const draft = await save(maintainer, 'pagination');
  assert.equal(draft.content.robin_code, code);
  assert.equal((await call(maintainer, 'search_patterns', { query: 'pagination' })).results.length, 0);
  await publish(maintainer, 'pagination');
  assert.equal((await call(developer, 'search_patterns', { query: 'dividere in gruppi' })).results[0].content.robin_code, code);
  await save(maintainer, 'pagination', { robin_code: 'changed code' }, 1);
  assert.equal((await call(developer, 'get_pattern', { id: 'pagination' })).revision, 1);
  assert.equal((await call(developer, 'get_pattern', { id: 'pagination' })).latest_revision, undefined);
  assert.equal((await call(maintainer, 'get_pattern', { id: 'pagination' })).revision, 2);
  const stale = await maintainer.callTool({ name: 'publish_revision', arguments: { id: 'pagination', revision: 1 } });
  assert.equal(stale.isError, true);
  const conflict = await maintainer.callTool({ name: 'save_draft', arguments: { id: 'pagination', expected_revision: 1, content: content() } });
  assert.equal(conflict.isError, true);
  await publish(maintainer, 'pagination', 2);
  assert.equal((await call(developer, 'search_patterns', { query: 'pagination' })).results[0].revision, 2);
  const hidden = await developer.callTool({ name: 'get_pattern', arguments: { id: 'pagination', revision: 1 } });
  assert.equal(hidden.isError, true);
  assert.equal((await call(maintainer, 'get_pattern', { id: 'pagination', revision: 1 })).content.robin_code, code);
});

test('all published content is shared; drafts remain outside Developer retrieval', async t => {
  const { maintainer, developer } = await setup(t);
  await save(maintainer, 'team-convention', { kind: 'convention', area: 'global' });
  assert.equal((await call(developer, 'get_development_context')).conventions.length, 0);
  assert.equal((await call(developer, 'export_knowledge')).entries.length, 0);
  const hidden = await developer.callTool({ name: 'get_pattern', arguments: { id: 'team-convention' } });
  assert.equal(hidden.isError, true);
  await publish(maintainer, 'team-convention');
  assert.equal((await call(developer, 'get_development_context')).conventions.length, 1);
  assert.equal((await call(maintainer, 'get_development_context')).conventions.length, 1);
  assert.deepEqual(await call(developer, 'export_knowledge'), await call(maintainer, 'export_knowledge'));
  assert.equal((await call(developer, 'get_pattern', { id: 'team-convention' })).revision, 1);
});

test('withdrawal removes published data while preserving history', async t => {
  const { maintainer, developer } = await setup(t);
  await save(maintainer, 'withdraw');
  await publish(maintainer, 'withdraw');
  await call(maintainer, 'unpublish_pattern', { id: 'withdraw' });
  assert.equal((await call(developer, 'export_knowledge')).entries.length, 0);
  assert.equal((await call(maintainer, 'search_patterns', { query: 'pagination' })).results.length, 0);
  assert.equal((await call(maintainer, 'get_pattern', { id: 'withdraw' })).content.robin_code, code);
});

test('portable export roundtrip imports drafts and rolls back an entire conflicting batch', async t => {
  const { maintainer, store } = await setup(t);
  await save(maintainer, 'original');
  await publish(maintainer, 'original');
  const exported = await call(maintainer, 'export_knowledge');
  const importedEntry = { ...exported.entries[0], id: 'imported' };
  await call(maintainer, 'import_knowledge', { package: { schema_version: 1, entries: [importedEntry] } });
  const imported = await call(maintainer, 'get_pattern', { id: 'imported' });
  assert.equal('visibility' in imported, false);
  assert.equal(imported.published, false);
  assert.deepEqual(imported.content, exported.entries[0].content);
  const failed = await maintainer.callTool({ name: 'import_knowledge', arguments: {
    package: { schema_version: 1, entries: [{ ...importedEntry, id: 'rollback' }, importedEntry] }
  } });
  assert.equal(failed.isError, true);
  assert.throws(() => store.get('rollback', 'maintainer'), /not found/);
});

test('search handles hostile FTS syntax, no matches, and Power Fx compatibility filters', async t => {
  const { maintainer } = await setup(t);
  await save(maintainer, 'fx', { power_fx: 'enabled', area: 'lists' });
  await publish(maintainer, 'fx');
  assert.equal((await call(maintainer, 'search_patterns', { query: 'pagination', power_fx: 'disabled' })).results.length, 0);
  assert.equal((await call(maintainer, 'search_patterns', { query: 'pagination', power_fx: 'enabled', area: 'lists' })).results.length, 1);
  assert.equal((await call(maintainer, 'search_patterns', { query: 'xyznonexistent' })).results.length, 0);
  assert.equal((await call(maintainer, 'search_patterns', { query: '" OR * : ( )' })).results.length, 0);
});

test('HTTP boundary rejects unauthenticated, invalid-origin, malformed and oversized requests', async t => {
  const { url } = await setup(t);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST' })).status, 401);
  const headers = { Authorization: `Bearer ${config.maintainerToken}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  // fetch may replace Host with the URL host; raw HTTP proves the server boundary.
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${url}/mcp`, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify({ huge: 'x'.repeat(2100000) }) })).status, 413);
  assert.equal((await fetch(`${url}/mcp`, { headers })).status, 405);
});

test('schema validation does not let malformed snippets or fabricated test completeness enter storage', async t => {
  const { maintainer } = await setup(t);
  for (const invalid of [
    { ...content(), robin_code: '' },
    { ...content(), verification: { status: 'tested', pad_version: '', evidence: '' } },
    { ...content(), unexpected_field: true }
  ]) {
    const response = await maintainer.callTool({ name: 'save_draft', arguments: { id: 'invalid', expected_revision: 0, content: invalid } });
    assert.equal(response.isError, true);
  }
  assert.equal((await call(maintainer, 'list_patterns')).entries.length, 0);
});

test('SQLite re-open preserves drafts, original bytes, approved revision and full-text index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pad-mcp-test-'));
  let store;
  try {
    const file = join(dir, 'knowledge.sqlite');
    store = new KnowledgeStore(file);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.deepEqual(store.db.prepare('PRAGMA table_info(patterns)').all().map(column => column.name), ['id', 'latest_revision', 'published_revision']);
    assert.deepEqual(store.export({}), { schema_version: 1, entries: [], next_offset: null });
    store.saveDraft({ id: 'persisted', expected_revision: 0, content: content() });
    store.publish({ id: 'persisted', revision: 1 });
    store.saveDraft({ id: 'persisted', expected_revision: 1, content: content({ robin_code: 'draft' }) });
    store.close();
    store = new KnowledgeStore(file);
    assert.equal(store.get('persisted', 'maintainer').revision, 2);
    assert.equal(store.get('persisted', 'developer').content.robin_code, code);
    assert.equal(store.search({ query: 'pagination' }, 'developer').results.length, 1);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true });
  }
});

test('configuration fails closed with missing/weak/equal tokens or a non-HTTPS external origin', () => {
  assert.throws(() => validateConfig({ ...config, maintainerToken: '' }), /MCP_MAINTAINER_TOKEN/);
  assert.throws(() => validateConfig({ ...config, developerToken: config.maintainerToken }), /differ/);
  assert.throws(() => validateConfig({ ...config, publicUrl: 'http://example.com' }), /HTTPS/);
  assert.throws(() => validateConfig({ ...config, publicUrl: 'https://example.com/mcp' }), /origin/);
});

test('file transfer CLI exports all pages and imports a collection through authenticated MCP', async t => {
  const { maintainer, store, url } = await setup(t);
  const dir = mkdtempSync(join(tmpdir(), 'pad-mcp-transfer-test-'));
  t.after(() => rmSync(dir, { recursive: true }));
  for (let index = 0; index < 21; index++) {
    const id = `entry-${String(index).padStart(2, '0')}`;
    store.saveDraft({ id, expected_revision: 0, content: content() });
    store.publish({ id, revision: 1 });
  }
  await save(maintainer, 'draft-entry');
  const env = { ...process.env, MCP_URL: `${url}/mcp`, MCP_MAINTAINER_TOKEN: config.maintainerToken };
  const file = join(dir, 'export.json');
  await promisify(execFile)(process.execPath, ['scripts/transfer.js', 'export', file], { env });
  const pack = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(pack.entries.length, 21);
  assert.ok(pack.entries.every(entry => !('visibility' in entry)));
  const input = join(dir, 'import.json');
  writeFileSync(input, JSON.stringify({ ...pack, entries: pack.entries.map(entry => ({ ...entry, id: `copy-${entry.id}` })) }));
  await promisify(execFile)(process.execPath, ['scripts/transfer.js', 'import', input], { env });
  assert.equal(store.get('copy-entry-20', 'maintainer').published, false);
  assert.equal(store.get('copy-entry-20', 'maintainer').content.robin_code, code);
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/transfer.js', 'export', file], { env }), /EEXIST/);
});

test('Developers cannot invoke any Maintainer mutation, including replacement and deletion', async t => {
  const { maintainer, developer, store } = await setup(t);
  await save(maintainer, 'protected');
  await publish(maintainer, 'protected');
  const published = store.export({}, 'maintainer').entries[0];
  const mutations = {
    save_draft: { id: 'protected', expected_revision: 1, content: content() },
    publish_revision: { id: 'protected', revision: 1 },
    unpublish_pattern: { id: 'protected' },
    replace_pattern: { id: 'protected', expected_revision: 1, content: content() },
    delete_pattern: { id: 'protected', expected_revision: 1 },
    import_knowledge: { package: { schema_version: 1, entries: [{ ...published, id: 'unauthorized' }] } }
  };
  const developerTools = (await developer.listTools()).tools.map(tool => tool.name);
  for (const [name, args] of Object.entries(mutations)) {
    assert.ok(!developerTools.includes(name), name);
    const response = await developer.callTool({ name, arguments: args });
    assert.equal(response.isError, true, name);
  }
  assert.equal(store.get('protected', 'developer').revision, 1);
  assert.equal(store.list({}).entries.length, 1);
});

test('approved replacement updates retrieval atomically while retaining Maintainer history', async t => {
  const { maintainer, developer } = await setup(t);
  await save(maintainer, 'maintained', { title: 'legacyuniqueterm', problem: 'legacyuniqueterm', tags: [] });
  await publish(maintainer, 'maintained');
  const replacement = content({ title: 'replacementuniqueterm', problem: 'replacementuniqueterm', tags: [], robin_code: `${code}# Replacement\r\n` });
  const response = await call(maintainer, 'replace_pattern', { id: 'maintained', expected_revision: 1, content: replacement });
  assert.equal(response.revision, 2);
  assert.equal(response.history_preserved, true);
  assert.equal((await call(developer, 'get_pattern', { id: 'maintained' })).content.robin_code, replacement.robin_code);
  assert.equal((await call(maintainer, 'get_pattern', { id: 'maintained', revision: 1 })).content.robin_code, code);
  assert.equal((await call(developer, 'search_patterns', { query: 'legacyuniqueterm' })).results.length, 0);
  assert.equal((await call(developer, 'search_patterns', { query: 'replacementuniqueterm' })).results[0].revision, 2);
  assert.equal((await call(developer, 'export_knowledge')).entries[0].revision, 2);
  const oldRevision = await developer.callTool({ name: 'get_pattern', arguments: { id: 'maintained', revision: 1 } });
  assert.equal(oldRevision.isError, true);
  const stale = await maintainer.callTool({ name: 'replace_pattern', arguments: { id: 'maintained', expected_revision: 1, content: replacement } });
  assert.equal(stale.isError, true);
  const invalid = await maintainer.callTool({ name: 'replace_pattern', arguments: { id: 'maintained', expected_revision: 2, content: { ...replacement, robin_code: '' } } });
  assert.equal(invalid.isError, true);
  assert.equal((await call(maintainer, 'get_pattern', { id: 'maintained' })).revision, 2);
  await call(maintainer, 'replace_pattern', { id: 'maintained', expected_revision: 2, content: replacement });
  assert.equal((await call(developer, 'export_knowledge')).entries[0].revision, 3);
});

test('permanent deletion removes all revisions, context, exports and index without affecting another entry', async t => {
  const { maintainer, developer, store } = await setup(t);
  await save(maintainer, 'obsolete', { kind: 'convention', area: 'global' });
  await publish(maintainer, 'obsolete');
  await save(maintainer, 'obsolete', {}, 1);
  await save(maintainer, 'keep');
  await publish(maintainer, 'keep');
  const stale = await maintainer.callTool({ name: 'delete_pattern', arguments: { id: 'obsolete', expected_revision: 1 } });
  assert.equal(stale.isError, true);
  assert.equal(store.get('obsolete', 'maintainer').revision, 2);
  const deleted = await call(maintainer, 'delete_pattern', { id: 'obsolete', expected_revision: 2 });
  assert.equal(deleted.deleted_revisions, 2);
  assert.equal(deleted.history_preserved, false);
  assert.throws(() => store.get('obsolete', 'maintainer', 1), /not found/);
  assert.equal((await call(maintainer, 'get_development_context')).conventions.length, 0);
  assert.deepEqual((await call(developer, 'export_knowledge')).entries.map(entry => entry.id), ['keep']);
  assert.deepEqual((await call(maintainer, 'list_patterns')).entries.map(entry => entry.id), ['keep']);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM revisions WHERE id = ?').get('obsolete').count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM knowledge_fts WHERE id = ?').get('obsolete').count, 0);
  const missing = await maintainer.callTool({ name: 'delete_pattern', arguments: { id: 'obsolete', expected_revision: 2 } });
  assert.equal(missing.isError, true);
});

test('database failures roll back replacement and deletion, including revisions and FTS data', () => {
  const store = new KnowledgeStore(':memory:');
  try {
    store.saveDraft({ id: 'rollback', expected_revision: 0, content: content() });
    store.publish({ id: 'rollback', revision: 1 });
    store.db.exec(`CREATE TRIGGER fail_publish BEFORE UPDATE OF published_revision ON patterns
      BEGIN SELECT RAISE(ABORT, 'forced publication failure'); END;`);
    assert.throws(() => store.replace({ id: 'rollback', expected_revision: 1, content: content({ robin_code: 'replacement' }) }), /forced publication failure/);
    assert.equal(store.get('rollback', 'maintainer').revision, 1);
    assert.equal(store.search({ query: 'pagination' }, 'developer').results.length, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM revisions').get().count, 1);
    store.db.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON patterns
      BEGIN SELECT RAISE(ABORT, 'forced deletion failure'); END;`);
    assert.throws(() => store.delete({ id: 'rollback', expected_revision: 1 }), /forced deletion failure/);
    assert.equal(store.get('rollback', 'developer').content.robin_code, code);
    assert.equal(store.search({ query: 'pagination' }, 'developer').results.length, 1);
  } finally { store.close(); }
});

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
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { KnowledgeStore, PATTERN_PREVIEW_LENGTH } from '../src/store.js';
import { ApiKeys } from '../src/api-keys.js';
import { createApp, validateConfig } from '../src/server.js';
import { contentSchema } from '../src/schema.js';
import { DatabaseSync } from 'node:sqlite';
import { CatalogIndex } from '../src/catalog.js';
import { CatalogCache } from '../src/catalog-cache.js';
import { documents, writeBundle } from './fixtures/catalog.js';

const config = { maintainerToken: 'a'.repeat(48), publicUrl: 'http://localhost:8080' };
const code = "\r\nSET Example TO $fx'=1'\r\n  # Unicode preservation fixture: café ☕\r\n";
const content = (extra = {}) => contentSchema.parse({ title: 'Pagination example', problem: 'Divide a list into batches', robin_code: code, tags: ['pagination'], power_fx: 'enabled', ...extra });
function toolData(response) {
  assert.equal(response.structuredContent, undefined);
  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, 'text');
  return JSON.parse(response.content[0].text);
}

const testContexts = new WeakMap();
const testRoles = new WeakMap();

async function setup(t, dependencies = { catalogCache: { get: async mode => new CatalogIndex({ ...documents(mode, 'a'), power_fx: mode }) } }, protocolMode = 'legacy') {
  const store = new KnowledgeStore(':memory:');
  const developerToken = new ApiKeys(store.db).create('Test Developer').token;
  const listener = createApp(store, config, dependencies).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const url = `http://127.0.0.1:${listener.address().port}`;
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await new Promise(resolve => listener.close(resolve));
    store.close();
  });
  async function connect(token) {
    const client = new Client({ name: 'integration-test', version: '1.0.0' }, { versionNegotiation: { mode: protocolMode } });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    }));
    const context = await client.callTool({ name: 'get_development_context', arguments: { power_fx: 'enabled' } });
    assert.ok(!context.isError);
    testContexts.set(client, toolData(context).context_id);
    testRoles.set(client, token === config.maintainerToken ? 'maintainer' : 'developer');
    return client;
  }
  return { store, url, developerToken, maintainer: await connect(config.maintainerToken), developer: await connect(developerToken) };
}

async function call(client, name, args = {}) {
  // Existing workflow tests use an explicit, previously selected Power Fx context.
  if (name === 'search_patterns' || (name === 'get_development_context' && Object.keys(args).length === 0)) {
    args = { context_id: testContexts.get(client), ...args };
  }
  if (name === 'get_pattern') {
    args = { ...(testRoles.get(client) === 'maintainer' ? { purpose: 'maintenance' } : { context_id: testContexts.get(client) }), ...args };
  }
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response));
  return toolData(response);
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
  await assert.rejects(developer.callTool({ name: 'save_draft', arguments: { id: 'forbidden', expected_revision: 0, content: content() } }), { code: -32602 });
  assert.equal((await call(maintainer, 'list_patterns')).entries.length, 0);
});

test('2026 clients keep the same tools, contexts, publication workflow and role boundaries', async t => {
  const { maintainer, developer, store, url, developerToken } = await setup(t, undefined, { pin: '2026-07-28' });
  assert.equal(maintainer.getProtocolEra(), 'modern');
  assert.equal(developer.getProtocolEra(), 'modern');
  assert.match(developer.getInstructions(), /get_development_context/);
  assert.equal(toolData(await developer.callTool({ name: 'get_development_context', arguments: {} })).status, 'selection_required');
  const classic = await call(developer, 'get_development_context', { power_fx: 'disabled' });
  assert.equal(classic.power_fx, 'disabled');
  assert.equal((await developer.callTool({ name: 'get_development_context', arguments: { context_id: classic.context_id, power_fx: 'enabled' } })).isError, true);
  assert.ok((await call(developer, 'search_actions', { context_id: classic.context_id, query: 'text' })).results.length > 0);

  // Both eras can use the same persisted context, without a protocol session.
  const legacy = await fetch(`${url}/mcp`, { method: 'POST',
    headers: { Authorization: `Bearer ${developerToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_development_context', arguments: { context_id: classic.context_id } } }) });
  assert.equal(legacy.status, 200);
  assert.match(legacy.headers.get('content-type'), /application\/json/);
  assert.equal(legacy.headers.get('mcp-session-id'), null);
  assert.equal(toolData((await legacy.json()).result).context_id, classic.context_id);

  await save(maintainer, 'modern-pattern');
  assert.equal((await call(developer, 'search_patterns', { query: 'pagination' })).results.length, 0);
  await publish(maintainer, 'modern-pattern');
  const match = (await call(developer, 'search_patterns', { query: 'pagination' })).results[0];
  assert.equal((await call(developer, 'get_pattern', { id: match.id, revision: match.revision })).content.robin_code, code);
  const replacement = content({ title: 'Updated pagination', robin_code: code + '# preserved' });
  await call(maintainer, 'replace_pattern', { id: match.id, expected_revision: 1, content: replacement });
  assert.equal((await call(developer, 'get_pattern', { id: match.id })).content.robin_code, replacement.robin_code);
  const exported = await call(maintainer, 'export_knowledge');
  await call(maintainer, 'import_knowledge', { package: { schema_version: 2, entries: [{ ...exported.entries[0], id: 'modern-import' }] } });
  assert.equal(store.get('modern-import', 'maintainer').published, false);
  await call(maintainer, 'unpublish_pattern', { id: match.id });
  assert.equal((await call(developer, 'search_patterns', { query: 'pagination' })).results.length, 0);
  await call(maintainer, 'delete_pattern', { id: match.id, expected_revision: 2 });
  assert.deepEqual((await call(maintainer, 'list_patterns')).entries.map(entry => entry.id), ['modern-import']);
  await assert.rejects(developer.callTool({ name: 'save_draft', arguments: { id: 'forbidden', expected_revision: 0, content: content() } }), { code: -32602 });
  await assert.rejects(maintainer.callTool({ name: 'missing_tool', arguments: {} }), { code: -32602 });
  assert.equal((await maintainer.callTool({ name: 'publish_revision', arguments: { id: 'missing', revision: 1 } })).isError, true);
  assert.ok((await call(maintainer, 'get_usage_stats')).results.length > 0);
  const lists = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? developer : maintainer).listTools()));
  lists.forEach((list, index) => assert.equal(list.tools.some(tool => tool.name === 'save_draft'), index % 2 === 0));
});

test('2026 discovery and HTTP metadata are validated without weakening authentication', async t => {
  const { url, developerToken, maintainer, developer, store } = await setup(t);
  const rpc = async (method, params = {}, headers = {}, version = '2026-07-28') => {
    const response = await fetch(`${url}/mcp`, { method: 'POST',
      headers: { Authorization: `Bearer ${developerToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': version, 'MCP-Method': method, ...(params.name ? { 'MCP-Name': params.name } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {}
      } } }) });
    return { response, body: await response.json() };
  };
  const discovery = await rpc('server/discover');
  assert.equal(discovery.response.status, 200);
  assert.equal(discovery.response.headers.get('cache-control'), 'no-store');
  assert.equal(discovery.response.headers.get('mcp-session-id'), null);
  assert.ok(discovery.body.result.supportedVersions.includes('2026-07-28'));
  assert.equal(discovery.body.result.resultType, 'complete');
  assert.equal(discovery.body.result.cacheScope, 'private');
  assert.equal(discovery.body.result.ttlMs, 0);
  assert.equal(discovery.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'pad-mcp');
  assert.equal(discovery.body.result.instructions, developer.getInstructions());
  const list = await rpc('tools/list');
  assert.deepEqual(list.body.result.tools, (await developer.listTools()).tools);
  const adminList = await rpc('tools/list', {}, { Authorization: `Bearer ${config.maintainerToken}` });
  assert.deepEqual(adminList.body.result.tools, (await maintainer.listTools()).tools);
  assert.equal((await rpc('tools/list', {}, { Authorization: 'Bearer invalid' })).response.status, 401);
  assert.equal((await rpc('server/discover', {}, { Origin: 'https://untrusted.example' })).response.status, 403);
  const mismatch = await rpc('tools/list', {}, { 'MCP-Protocol-Version': '2025-11-25' });
  assert.equal(mismatch.response.status, 400);
  assert.ok(mismatch.body.error);
  const methodMismatch = await rpc('tools/list', {}, { 'MCP-Method': 'tools/call' });
  assert.equal(methodMismatch.response.status, 400);
  const unsupported = await rpc('tools/list', {}, {}, '2099-01-01');
  assert.equal(unsupported.body.error.code, -32022);
  const missing = await rpc('tools/call', { name: 'missing_tool', arguments: {} });
  assert.equal(missing.body.error.code, -32602);
  const keys = new ApiKeys(store.db);
  keys.delete(keys.list()[0].id);
  assert.equal((await rpc('tools/list')).response.status, 401);
});
test('draft -> exact publication -> new draft preserves published code and revision history', async t => {
  const { maintainer, developer } = await setup(t);
  const draft = await save(maintainer, 'pagination');
  assert.equal(draft.content.robin_code, code);
  assert.equal((await call(maintainer, 'search_patterns', { query: 'pagination' })).results.length, 0);
  await publish(maintainer, 'pagination');
  const preview = (await call(developer, 'search_patterns', { query: 'dividere in gruppi' })).results[0];
  assert.equal((await call(developer, 'get_pattern', { id: preview.id, revision: preview.revision })).content.robin_code, code);
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
  const hidden = await developer.callTool({ name: 'get_pattern', arguments: { id: 'pagination', revision: 1, context_id: testContexts.get(developer) } });
  assert.equal(hidden.isError, true);
  assert.equal((await call(maintainer, 'get_pattern', { id: 'pagination', revision: 1 })).content.robin_code, code);
});

test('all published content is shared; drafts remain outside Developer retrieval', async t => {
  const { maintainer, developer } = await setup(t);
  await save(maintainer, 'team-convention', { kind: 'convention', area: 'global' });
  assert.equal((await call(developer, 'get_development_context')).conventions.length, 0);
  assert.equal((await call(developer, 'export_knowledge')).entries.length, 0);
  const hidden = await developer.callTool({ name: 'get_pattern', arguments: { id: 'team-convention', context_id: testContexts.get(developer) } });
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
  await call(maintainer, 'import_knowledge', { package: { schema_version: 2, entries: [importedEntry] } });
  const imported = await call(maintainer, 'get_pattern', { id: 'imported' });
  assert.equal('visibility' in imported, false);
  assert.equal(imported.published, false);
  assert.deepEqual(imported.content, exported.entries[0].content);
  const failed = await maintainer.callTool({ name: 'import_knowledge', arguments: {
    package: { schema_version: 2, entries: [{ ...importedEntry, id: 'rollback' }, importedEntry] }
  } });
  assert.equal(failed.isError, true);
  assert.throws(() => store.get('rollback', 'maintainer'), /not found/);
});

test('search handles hostile FTS syntax, no matches, and Power Fx compatibility filters', async t => {
  const { maintainer } = await setup(t);
  await save(maintainer, 'fx', { power_fx: 'enabled', area: 'lists' });
  await publish(maintainer, 'fx');
  const classic = await call(maintainer, 'get_development_context', { power_fx: 'disabled' });
  assert.equal((await call(maintainer, 'search_patterns', { query: 'pagination', context_id: classic.context_id })).results.length, 0);
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

test('schema validation rejects malformed snippets and unknown fields', async t => {
  const { maintainer } = await setup(t);
  for (const invalid of [
    { ...content(), robin_code: '' },
    { ...content(), unexpected_field: true }
  ]) {
    const response = await maintainer.callTool({ name: 'save_draft', arguments: { id: 'invalid', expected_revision: 0, content: invalid } });
    assert.equal(response.isError, true);
  }
  assert.equal((await call(maintainer, 'list_patterns')).entries.length, 0);
});

test('development content stays lean through MCP schemas, storage, retrieval and export', async t => {
  const { maintainer, developer, store } = await setup(t);
  const original = content({ kind: 'convention', area: 'global', pitfalls: ['limitationuniqueterm'] });
  const tools = (await maintainer.listTools()).tools;
  for (const name of ['save_draft', 'replace_pattern']) {
    const properties = tools.find(tool => tool.name === name).inputSchema.properties.content.properties;
    assert.deepEqual(Object.keys(properties).sort(), Object.keys(original).sort(), name);
  }
  await call(maintainer, 'save_draft', { id: 'lean', expected_revision: 0, content: original });
  await publish(maintainer, 'lean');
  const stored = JSON.parse(store.db.prepare('SELECT content FROM revisions WHERE id = ?').get('lean').content);
  assert.deepEqual(stored, original);
  for (const client of [maintainer, developer]) {
    assert.deepEqual((await call(client, 'get_pattern', { id: 'lean' })).content, original);
    // Full content remains searchable server-side, including limitations.
    const response = await client.callTool({ name: 'search_patterns', arguments: { query: 'limitationuniqueterm', context_id: testContexts.get(client) } });
    assert.deepEqual(toolData(response).results[0], { id: 'lean', revision: 1, kind: original.kind, title: original.title, problem: original.problem });
    assert.deepEqual((await call(client, 'get_development_context')).conventions[0].content, original);
    const exported = await call(client, 'export_knowledge');
    assert.equal(exported.schema_version, 2);
    assert.deepEqual(exported.entries[0].content, original);
  }
  const entry = { id: 'invalid-import', revision: 1, content: original };
  const invalidPackages = [
    { schema_version: 1, entries: [entry] },
    { schema_version: 2, entries: [{ ...entry, content: { ...original, unexpected_field: true } }] }
  ];
  for (const pack of invalidPackages) {
    const response = await maintainer.callTool({ name: 'import_knowledge', arguments: { package: pack } });
    assert.equal(response.isError, true);
  }
  assert.equal(store.list({}).entries.length, 1);
});

test('unsupported database formats are rejected without changing the file', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pad-mcp-format-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const version of [1, 7]) {
    const file = join(dir, `version-${version}.sqlite`);
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE sample_content (content TEXT); PRAGMA user_version = ${version};`);
    db.prepare('INSERT INTO sample_content VALUES (?)').run('Preserve existing data');
    db.close();
    const before = readFileSync(file);
    assert.throws(() => new KnowledgeStore(file), /Unsupported database schema/);
    assert.deepEqual(readFileSync(file), before);
  }
});

test('SQLite re-open preserves drafts, original bytes, approved revision and full-text index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pad-mcp-test-'));
  let store;
  try {
    const file = join(dir, 'knowledge.sqlite');
    store = new KnowledgeStore(file);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 6);
    assert.deepEqual(store.db.prepare('PRAGMA table_info(patterns)').all().map(column => column.name), ['id', 'latest_revision', 'published_revision']);
    assert.deepEqual(store.export({}), { schema_version: 2, entries: [], next_offset: null });
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

test('configuration fails closed with missing/weak Maintainer tokens or a non-HTTPS external origin', () => {
  assert.throws(() => validateConfig({ ...config, maintainerToken: '' }), /MCP_MAINTAINER_TOKEN/);
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
    import_knowledge: { package: { schema_version: 2, entries: [{ ...published, id: 'unauthorized' }] } }
  };
  const developerTools = (await developer.listTools()).tools.map(tool => tool.name);
  for (const [name, args] of Object.entries(mutations)) {
    assert.ok(!developerTools.includes(name), name);
    await assert.rejects(developer.callTool({ name, arguments: args }), { code: -32602 }, name);
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
  const oldRevision = await developer.callTool({ name: 'get_pattern', arguments: { id: 'maintained', revision: 1, context_id: testContexts.get(developer) } });
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

test('MCP selection is explicit, context mode is immutable and development cannot bypass filtering', async t => {
  const { maintainer, developer, store } = await setup(t);
  const initialCount = store.db.prepare('SELECT COUNT(*) AS n FROM development_contexts').get().n;
  const initial = await developer.callTool({ name: 'get_development_context', arguments: {} });
  assert.equal(toolData(initial).status, 'selection_required');
  assert.equal('conventions' in toolData(initial), false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM development_contexts').get().n, initialCount);
  const classic = await call(developer, 'get_development_context', { power_fx: 'disabled' });
  const fx = await call(developer, 'get_development_context', { power_fx: 'enabled' });
  assert.notEqual(classic.context_id, fx.context_id);
  assert.equal((await call(developer, 'get_development_context', { context_id: classic.context_id })).power_fx, 'disabled');
  const changed = await developer.callTool({ name: 'get_development_context', arguments: { context_id: classic.context_id, power_fx: 'enabled' } });
  assert.equal(changed.isError, true);
  assert.equal(store.requireContext(classic.context_id).power_fx, 'disabled');
  for (const mode of ['enabled', 'disabled', 'either']) {
    await save(maintainer, mode, { power_fx: mode, kind: 'convention', area: 'global' });
    await publish(maintainer, mode);
  }
  // Simulate an already published legacy entry. Migration must not relabel or remove it.
  await save(maintainer, 'legacy', { power_fx: 'either', kind: 'convention', area: 'global' });
  await publish(maintainer, 'legacy');
  store.db.prepare("UPDATE revisions SET content = json_set(content, '$.power_fx', 'unspecified') WHERE id = ?").run('legacy');
  for (const context of [classic, fx]) {
    const found = await call(developer, 'search_patterns', { context_id: context.context_id, query: 'pagination' });
    assert.deepEqual(found.results.map(entry => entry.id).sort(), [context.power_fx, 'either'].sort());
    const loaded = await call(developer, 'get_development_context', { context_id: context.context_id });
    assert.deepEqual(loaded.conventions.map(entry => entry.id).sort(), [context.power_fx, 'either'].sort());
  }
  for (const [name, args] of [
    ['search_patterns', { query: 'pagination' }],
    ['search_patterns', { query: 'pagination', context_id: classic.context_id, power_fx: 'enabled' }],
    ['get_pattern', { id: 'enabled' }],
    ['get_pattern', { id: 'enabled', context_id: classic.context_id }],
    ['get_pattern', { id: 'legacy', context_id: fx.context_id }],
    ['get_pattern', { id: 'disabled', purpose: 'maintenance' }],
    ['get_development_context', { context_id: '00000000-0000-4000-8000-000000000000' }]
  ]) {
    assert.equal((await developer.callTool({ name, arguments: args })).isError, true, name);
  }
  // Maintainer development is also filtered and must not return newer drafts.
  await save(maintainer, 'enabled', { power_fx: 'disabled', robin_code: 'draft only' }, 1);
  const published = await maintainer.callTool({ name: 'get_pattern', arguments: { id: 'enabled', context_id: fx.context_id } });
  assert.equal(toolData(published).revision, 1);
  const wrongMode = await maintainer.callTool({ name: 'get_pattern', arguments: { id: 'enabled', context_id: classic.context_id } });
  assert.equal(wrongMode.isError, true);
  const review = await call(maintainer, 'get_pattern', { id: 'enabled', purpose: 'maintenance' });
  assert.equal(review.revision, 2);
  assert.equal(review.purpose, 'maintenance');
  assert.equal((await call(maintainer, 'get_pattern', { id: 'legacy' })).content.power_fx, 'unspecified');
  const tool = (await developer.listTools()).tools.find(entry => entry.name === 'get_development_context');
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal((await call(developer, 'export_knowledge')).entries.length, 4);
});

test('publication and replacement require classification and roll back without rewriting code', async t => {
  const { maintainer, store } = await setup(t);
  await save(maintainer, 'unclassified', { power_fx: 'unspecified' });
  assert.equal((await maintainer.callTool({ name: 'publish_revision', arguments: { id: 'unclassified', revision: 1 } })).isError, true);
  assert.equal(store.get('unclassified', 'maintainer').content.robin_code, code);
  assert.equal(store.get('unclassified', 'maintainer').approved_at, null);
  await save(maintainer, 'unclassified', { power_fx: 'enabled' }, 1);
  await publish(maintainer, 'unclassified', 2);
  const before = store.export({});
  const rejected = await maintainer.callTool({ name: 'replace_pattern', arguments: {
    id: 'unclassified', expected_revision: 2, content: content({ power_fx: 'unspecified' })
  } });
  assert.equal(rejected.isError, true);
  assert.deepEqual(store.export({}), before);
  assert.equal(store.get('unclassified', 'maintainer').revision, 2);
  assert.equal(store.get('unclassified', 'maintainer', 1).content.robin_code, code);
  // Import remains portable v2 and can retain unclassified entries as drafts.
  const imported = { id: 'unclassified-import', revision: 1, content: content({ power_fx: 'unspecified' }) };
  await call(maintainer, 'import_knowledge', { package: { schema_version: 2, entries: [imported] } });
  assert.equal(store.get(imported.id, 'maintainer').published, false);
});

test('catalog MCP tools use bundled catalogs, selected edition and bounded responses', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pad-catalog-mcp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle_directory = join(directory, 'bundle');
  await writeBundle(bundle_directory);
  const catalogCache = new CatalogCache({ bundle_directory });
  const { developer, maintainer, store } = await setup(t, { catalogCache });
  const fx = testContexts.get(developer);
  const classic = (await call(developer, 'get_development_context', { power_fx: 'disabled' })).context_id;
  const fxPrompt = await call(developer, 'get_development_context', { context_id: fx });
  assert.match(fxPrompt.development_prompt, /Selected mode: PAD with Power Fx enabled/);
  assert.doesNotMatch(fxPrompt.development_prompt, /Selected mode: PAD Classic/);
  assert.match((await call(developer, 'get_development_context', { context_id: classic })).development_prompt, /Selected mode: PAD Classic/);
  for (const client of [developer, maintainer]) {
    const tools = (await client.listTools()).tools;
    for (const name of ['search_actions', 'search_type_reference']) {
      const tool = tools.find(item => item.name === name);
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.openWorldHint, true);
    }
  }
  for (const [name, args] of [
    ['search_actions', { query: 'text' }],
    ['search_actions', { context_id: fx }],
    ['search_actions', { context_id: fx, action_id: 'Text.Action0', query: 'text' }],
    ['search_type_reference', { context_id: fx, type_name: 'String', query: 'text' }],
    ['search_actions', { context_id: '00000000-0000-4000-8000-000000000000', query: 'text' }]
  ]) assert.equal((await developer.callTool({ name, arguments: args })).isError, true);
  const summaries = await Promise.all([developer, maintainer].map(client =>
    call(client, 'search_actions', { context_id: fx, module: 'Text' })));
  assert.equal(summaries[0].results.length, 5);
  assert.equal(summaries[0].truncated, true);
  assert.equal('golden_example' in summaries[0].results[0], false);
  for (const [id, mode] of [[fx, 'enabled'], [classic, 'disabled']]) {
    const exact = await call(developer, 'search_actions', { context_id: id, action_id: 'Text.Action0' });
    assert.equal(exact.record.golden_example, mode + '-a');
    assert.equal('source' in exact, false);
    assert.equal('development_prompt' in exact, false);
    assert.deepEqual(Object.keys(exact), ['record']);
    const context = await call(developer, 'get_development_context', { context_id: id });
    const rules = JSON.parse(context.development_prompt.split('Catalog rules for the selected mode:\n')[1]);
    assert.deepEqual(rules, (await catalogCache.get(mode)).developmentRules());
    const type = await call(developer, 'search_type_reference', { context_id: id, type_name: 'String' });
    assert.equal(type.record.example, mode + '-a');
  }
  assert.equal('catalog_update' in (await call(maintainer, 'get_development_context')), false);
  const selection = await maintainer.callTool({ name: 'get_development_context', arguments: {} });
  assert.equal(toolData(selection).status, 'selection_required');
  assert.deepEqual(Object.keys(toolData(selection)).sort(), ['question', 'status']);
  assert.equal('catalog_update' in fxPrompt, false);
  assert.equal('authoring_guidance' in fxPrompt, false);
  assert.equal('catalog_error' in fxPrompt, false);
  assert.equal('instructions' in fxPrompt, false);
  assert.equal('guidance' in fxPrompt, false);
  assert.equal(maintainer.getInstructions(), developer.getInstructions());
  for (const client of [developer, maintainer]) {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['get_catalog_update_status', 'update_catalogs']) {
      assert.equal(names.includes(name), false);
      await assert.rejects(client.callTool({ name, arguments: { expected_commit: 'b'.repeat(40), confirmed: true } }), { code: -32602 });
    }
  }
  assert.equal(store.export({}).entries.length, 0);
  const restarted = new CatalogCache({ bundle_directory });
  assert.equal((await restarted.get('enabled')).searchTypes({ type_name: 'String' }).record.example, 'enabled-a');
});

test('pattern previews are bounded, preserve Unicode and retrieve only the selected published revision', async t => {
  const { developer, maintainer } = await setup(t);
  const original = content({ problem: '😀'.repeat(PATTERN_PREVIEW_LENGTH) + ' tail', pitfalls: ['searchableuniqueconstraint'] });
  await call(maintainer, 'save_draft', { id: 'long-preview', expected_revision: 0, content: original });
  await publish(maintainer, 'long-preview');
  await save(maintainer, 'other-preview', { problem: 'searchableuniqueconstraint', robin_code: 'OTHER CODE' });
  await publish(maintainer, 'other-preview');
  const search = await call(developer, 'search_patterns', { query: 'searchableuniqueconstraint' });
  assert.equal(search.results.length, 2);
  const selected = search.results.find(item => item.id === 'long-preview');
  assert.deepEqual(selected, { id: 'long-preview', revision: 1, kind: original.kind,
    title: original.title, problem: '😀'.repeat(PATTERN_PREVIEW_LENGTH), problem_truncated: true });
  assert.equal('problem_truncated' in search.results.find(item => item.id === 'other-preview'), false);
  const args = { context_id: testContexts.get(developer), id: selected.id, revision: selected.revision };
  assert.deepEqual((await call(developer, 'get_pattern', args)).content, original);
  await save(maintainer, 'long-preview', { problem: 'Replacement', robin_code: 'NEW CODE' }, 1);
  // A newer draft does not invalidate the selected published revision.
  assert.deepEqual((await call(developer, 'get_pattern', args)).content, original);
  await publish(maintainer, 'long-preview', 2);
  assert.equal((await developer.callTool({ name: 'get_pattern', arguments: args })).isError, true);
  const refreshed = await call(developer, 'search_patterns', { query: 'Replacement' });
  assert.equal(refreshed.results[0].revision, 2);
});

test('catalog failure is a tool error and leaves context and approved patterns usable', async t => {
  const { developer, maintainer } = await setup(t, { catalogCache: { get: async () => { throw new Error('Unavailable'); } } });
  const result = await developer.callTool({ name: 'search_actions', arguments: { context_id: testContexts.get(developer), query: 'text' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Catalog unavailable/);
  await save(maintainer, 'available'); await publish(maintainer, 'available');
  assert.equal((await call(developer, 'search_patterns', { query: 'pagination' })).results.length, 1);
  const context = await call(developer, 'get_development_context');
  assert.equal(context.status, 'ready');
  assert.match(context.catalog_error, /Catalog unavailable/);
});

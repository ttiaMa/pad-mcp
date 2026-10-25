import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore } from '../src/store.js';
import { contentSchema } from '../src/schema.js';
import { bootstrapKnowledge } from '../src/bootstrap.js';
import { ApiKeys } from '../src/api-keys.js';
import { UsageStats } from '../src/usage.js';
import { DatabaseSync } from 'node:sqlite';

test('additive v2 migration preserves every knowledge row, bootstrap marker and portable export', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pad-context-migration-'));
  const path = join(directory, 'knowledge.sqlite');
  let store = new KnowledgeStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const id of ['dos-create-folder-if-missing', 'power-fx-string-manipulation']) {
    const content = contentSchema.parse({ title: id, problem: 'Migration preservation fixture',
      robin_code: "\r\nSET Example TO $fx'=1'\r\n# café ☕\r\n", power_fx: 'enabled' });
    store.saveDraft({ id, expected_revision: 0, content });
    store.publish({ id, revision: 1 });
  }
  store.saveDraft({ id: 'draft', expected_revision: 0,
    content: contentSchema.parse({ title: 'Draft', problem: 'Unclassified', robin_code: 'unchanged' }) });
  bootstrapKnowledge(store);
  // Recreate the exact pre-context v2 schema, including existing knowledge and bootstrap state.
  store.db.exec('DROP TABLE usage_daily; DROP TABLE api_keys; PRAGMA user_version = 2;');
  const queries = ['SELECT * FROM patterns ORDER BY id', 'SELECT * FROM revisions ORDER BY id, revision',
    'SELECT * FROM knowledge_fts ORDER BY id', 'SELECT * FROM knowledge_bootstrap'];
  const before = queries.map(query => store.db.prepare(query).all());
  const exported = store.export({});
  store.close();
  store = new KnowledgeStore(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.deepEqual(queries.map(query => store.db.prepare(query).all()), before);
  assert.deepEqual(store.export({}), exported);
  assert.equal(bootstrapKnowledge(store).status, 'already_initialized');
  const fx = store.developmentContext({ power_fx: 'enabled' });
  const classic = store.developmentContext({ power_fx: 'disabled' });
  assert.equal(store.searchDevelopment({ power_fx: fx.power_fx, query: 'migration' }, 'developer').results.length, 2);
  assert.equal(store.searchDevelopment({ power_fx: classic.power_fx, query: 'migration' }, 'developer').results.length, 0);
  store.close();
  store = new KnowledgeStore(path);
  assert.deepEqual(store.developmentContext({ power_fx: fx.power_fx }), fx);
  assert.deepEqual(store.developmentContext({ power_fx: classic.power_fx }), classic);
  assert.deepEqual(store.export({}), exported);
});

test('invalid and missing modes fail before search, even for an empty query', () => {
  const store = new KnowledgeStore(':memory:');
  try {
    assert.equal(store.developmentContext().status, 'selection_required');
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'development_contexts'").get(), undefined);
    assert.throws(() => store.searchDevelopment({ query: '' }, 'developer'), /enabled or disabled/);
    assert.throws(() => store.developmentContext({ power_fx: 'missing' }), /enabled or disabled/);
    assert.throws(() => store.developmentContext({ power_fx: 'either' }), /enabled or disabled/);
  } finally { store.close(); }
});

test('failed migration rolls back and releases the connection without altering existing data', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pad-context-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'knowledge.sqlite');
  const db = new DatabaseSync(path);
  // A pre-existing conflicting name forces the migration to fail after BEGIN.
  db.exec("CREATE TABLE api_keys (original TEXT); INSERT INTO api_keys VALUES ('preserve'); PRAGMA user_version = 2;");
  db.close();
  assert.throws(() => new KnowledgeStore(path), /already exists/);
  const reopened = new DatabaseSync(path);
  try {
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(reopened.prepare('SELECT original FROM api_keys').get().original, 'preserve');
    reopened.exec('BEGIN EXCLUSIVE; ROLLBACK;');
  } finally { reopened.close(); }
});


test('v6 cleanup removes all context storage and preserves every other row across reopen', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pad-mode-cleanup-'));
  const path = join(directory, 'knowledge.sqlite');
  let store = new KnowledgeStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  bootstrapKnowledge(store);
  const key = new ApiKeys(store.db).create('Preserve key');
  new UsageStats(store.db).record({ keyId: key.id, tool: 'search_patterns', mode: 'classic', success: true });
  store.saveDraft({ id: 'draft-history', expected_revision: 0,
    content: contentSchema.parse({ title: 'Original', problem: 'Preserve', robin_code: '  original code  ', power_fx: 'either' }) });
  store.publish({ id: 'draft-history', revision: 1 });
  store.saveDraft({ id: 'draft-history', expected_revision: 1,
    content: contentSchema.parse({ title: 'New draft', problem: 'Preserve draft', robin_code: '  draft  ' }) });
  const tables = ['patterns', 'revisions', 'knowledge_fts', 'knowledge_bootstrap', 'api_keys', 'usage_daily'];
  const snapshot = () => tables.map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = snapshot();
  const exported = store.export({});
  store.db.exec(`CREATE TABLE development_contexts (
    context_id TEXT PRIMARY KEY, power_fx TEXT NOT NULL CHECK (power_fx IN ('enabled', 'disabled')), created_at TEXT NOT NULL);
    CREATE TRIGGER immutable_development_context BEFORE UPDATE ON development_contexts
      BEGIN SELECT RAISE(ABORT, 'Development contexts are immutable'); END;
    INSERT INTO development_contexts VALUES ('old-fx', 'enabled', '2026-01-01'), ('old-classic', 'disabled', '2026-01-01');
    PRAGMA user_version = 6;`);
  for (let i = 0; i < 2; i++) {
    store.close();
    store = new KnowledgeStore(path);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.deepEqual(store.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('development_contexts', 'immutable_development_context')").all(), []);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(store.export({}), exported);
    assert.equal(new ApiKeys(store.db).authenticate(key.token).id, key.id);
    for (const power_fx of ['enabled', 'disabled']) {
      assert.deepEqual(store.developmentContext({ power_fx }), { status: 'ready', power_fx });
    }
    assert.deepEqual(snapshot(), before);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  }
});

test('v7 cleanup rolls back the trigger and schema version if table removal fails', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pad-mode-rollback-'));
  const path = join(directory, 'knowledge.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE development_contexts (context_id TEXT PRIMARY KEY);
    INSERT INTO development_contexts VALUES ('preserve');
    CREATE TRIGGER immutable_development_context BEFORE UPDATE ON development_contexts
      BEGIN SELECT RAISE(ABORT, 'immutable'); END;
    CREATE TABLE unexpected_reference (context_id TEXT REFERENCES development_contexts(context_id));
    INSERT INTO unexpected_reference VALUES ('preserve'); PRAGMA user_version = 6;`);
  db.close();
  assert.throws(() => new KnowledgeStore(path), /FOREIGN KEY/);
  const reopened = new DatabaseSync(path);
  try {
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 6);
    assert.equal(reopened.prepare('SELECT context_id FROM development_contexts').get().context_id, 'preserve');
    assert.throws(() => reopened.exec("UPDATE development_contexts SET context_id = 'changed'"), /immutable/);
    reopened.exec('BEGIN EXCLUSIVE; ROLLBACK;');
  } finally { reopened.close(); }
});

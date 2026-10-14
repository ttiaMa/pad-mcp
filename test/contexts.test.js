import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore } from '../src/store.js';
import { contentSchema } from '../src/schema.js';
import { bootstrapKnowledge } from '../src/bootstrap.js';
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
  store.db.exec('DROP TRIGGER immutable_development_context; DROP TABLE development_contexts; PRAGMA user_version = 2;');
  const queries = ['SELECT * FROM patterns ORDER BY id', 'SELECT * FROM revisions ORDER BY id, revision',
    'SELECT * FROM knowledge_fts ORDER BY id', 'SELECT * FROM knowledge_bootstrap'];
  const before = queries.map(query => store.db.prepare(query).all());
  const exported = store.export({});
  store.close();
  store = new KnowledgeStore(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.deepEqual(queries.map(query => store.db.prepare(query).all()), before);
  assert.deepEqual(store.export({}), exported);
  assert.equal(bootstrapKnowledge(store).status, 'already_initialized');
  const fx = store.developmentContext({ power_fx: 'enabled' });
  const classic = store.developmentContext({ power_fx: 'disabled' });
  assert.equal(store.searchDevelopment({ context_id: fx.context_id, query: 'migration' }, 'developer').results.length, 2);
  assert.equal(store.searchDevelopment({ context_id: classic.context_id, query: 'migration' }, 'developer').results.length, 0);
  store.close();
  store = new KnowledgeStore(path);
  assert.deepEqual(store.developmentContext({ context_id: fx.context_id }), fx);
  assert.deepEqual(store.developmentContext({ context_id: classic.context_id }), classic);
  assert.throws(() => store.developmentContext({ context_id: fx.context_id, power_fx: 'disabled' }), /cannot change/);
  assert.throws(() => store.db.prepare('UPDATE development_contexts SET power_fx = ? WHERE context_id = ?')
    .run('disabled', fx.context_id), /immutable/);
  assert.deepEqual(store.export({}), exported);
});

test('unknown and missing contexts fail before search, even for an empty query', () => {
  const store = new KnowledgeStore(':memory:');
  try {
    assert.equal(store.developmentContext().status, 'selection_required');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM development_contexts').get().n, 0);
    assert.throws(() => store.searchDevelopment({ query: '' }, 'developer'), /context_id is required/);
    assert.throws(() => store.developmentContext({ context_id: 'missing' }), /not found/);
    assert.throws(() => store.developmentContext({ power_fx: 'either' }), /enabled or disabled/);
  } finally { store.close(); }
});

test('failed migration rolls back and releases the connection without altering existing data', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pad-context-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'knowledge.sqlite');
  const db = new DatabaseSync(path);
  // A pre-existing conflicting name forces the migration to fail after BEGIN.
  db.exec("CREATE TABLE development_contexts (original TEXT); INSERT INTO development_contexts VALUES ('preserve'); PRAGMA user_version = 2;");
  db.close();
  assert.throws(() => new KnowledgeStore(path), /already exists/);
  const reopened = new DatabaseSync(path);
  try {
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(reopened.prepare('SELECT original FROM development_contexts').get().original, 'preserve');
    reopened.exec('BEGIN EXCLUSIVE; ROLLBACK;');
  } finally { reopened.close(); }
});

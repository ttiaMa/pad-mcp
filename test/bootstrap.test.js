import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../src/store.js';
import { bootstrapKnowledge } from '../src/bootstrap.js';
import { contentSchema } from '../src/schema.js';

const sample = {
  schema_version: 2,
  entries: [{
    id: 'text-example', revision: 1,
    content: contentSchema.parse({
      title: 'Text example', problem: 'Store sample text',
      robin_code: 'SET Example TO \'sample\'', tags: ['strings', 'stringhe']
    })
  }]
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pad-bootstrap-'));
  const db = join(dir, 'knowledge.sqlite');
  const seed = join(dir, 'seed.json');
  writeFileSync(seed, JSON.stringify(sample));
  let store = new KnowledgeStore(db);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { seed, get store() { return store; }, reopen() { store.close(); store = new KnowledgeStore(db); } };
}

test('custom seed is published and searchable; edits and deletions survive restarts', t => {
  const f = fixture(t);
  assert.deepEqual(bootstrapKnowledge(f.store, f.seed), { status: 'seeded', entries: 1 });
  const id = sample.entries[0].id;
  const entry = f.store.get(id, 'developer');
  assert.equal(entry.content.robin_code, sample.entries[0].content.robin_code);
  assert.deepEqual(entry.content, sample.entries[0].content);
  assert.equal(f.store.search({ query: 'stringhe' }, 'developer').results[0].id, id);
  f.store.replace({ id, expected_revision: 1, content: { ...entry.content, title: 'Team update' } });
  f.reopen();
  assert.equal(bootstrapKnowledge(f.store, f.seed).status, 'already_initialized');
  assert.equal(f.store.get(id, 'developer').content.title, 'Team update');
  f.store.delete({ id, expected_revision: 2 });
  f.reopen();
  bootstrapKnowledge(f.store, f.seed);
  assert.equal(f.store.list({}).entries.length, 0);
});

test('pre-existing drafts are preserved and never automatically published or reseeded', t => {
  const f = fixture(t);
  const { id, content } = sample.entries[0];
  f.store.saveDraft({ id, expected_revision: 0, content });
  assert.equal(bootstrapKnowledge(f.store, f.seed).status, 'existing_collection_preserved');
  assert.equal(f.store.get(id, 'maintainer').published, false);
  f.store.delete({ id, expected_revision: 1 });
  f.reopen();
  assert.equal(bootstrapKnowledge(f.store, f.seed).status, 'already_initialized');
  assert.equal(f.store.list({}).entries.length, 0);
});

test('invalid and duplicate packages leave no partial seed and can be corrected', t => {
  const f = fixture(t);
  for (const entries of [
    [...sample.entries, { id: 'invalid', revision: 1, content: {} }],
    [...sample.entries, ...sample.entries]
  ]) {
    writeFileSync(f.seed, JSON.stringify({ schema_version: 2, entries }));
    assert.throws(() => bootstrapKnowledge(f.store, f.seed));
    assert.equal(f.store.list({}).entries.length, 0);
  }
  writeFileSync(f.seed, JSON.stringify(sample));
  assert.equal(bootstrapKnowledge(f.store, f.seed).entries, 1);
});

test('publication failure rolls back entries, search and completion marker', t => {
  const f = fixture(t);
  f.store.db.exec(`CREATE TRIGGER reject_seed BEFORE UPDATE OF published_revision ON patterns
    BEGIN SELECT RAISE(ABORT, 'publication failed'); END;`);
  assert.throws(() => bootstrapKnowledge(f.store, f.seed), /publication failed/);
  assert.equal(f.store.list({}).entries.length, 0);
  assert.equal(f.store.search({ query: 'strings' }, 'developer').results.length, 0);
  f.store.db.exec('DROP TRIGGER reject_seed');
  assert.equal(bootstrapKnowledge(f.store, f.seed).entries, 1);
});

test('empty seed stays initialized even when the file later changes', t => {
  const f = fixture(t);
  writeFileSync(f.seed, JSON.stringify({ schema_version: 2, entries: [] }));
  assert.equal(bootstrapKnowledge(f.store, f.seed).entries, 0);
  writeFileSync(f.seed, JSON.stringify(sample));
  f.reopen();
  assert.equal(bootstrapKnowledge(f.store, f.seed).status, 'already_initialized');
  assert.equal(f.store.list({}).entries.length, 0);
});

test('exported packages with more than 20 entries seed a fresh database', t => {
  const f = fixture(t);
  for (let i = 0; i < 21; i++) {
    const id = `entry-${i}`;
    f.store.saveDraft({ id, expected_revision: 0, content: sample.entries[0].content });
    f.store.publish({ id, revision: 1 });
  }
  const { next_offset, ...pack } = f.store.export({ limit: 100 });
  pack.entries[0].content.title = 'Manually edited export';
  writeFileSync(f.seed, JSON.stringify(pack));
  const target = new KnowledgeStore(':memory:');
  try {
    assert.equal(bootstrapKnowledge(target, f.seed).entries, 21);
    assert.equal(target.get(pack.entries[0].id, 'developer').content.title, 'Manually edited export');
  } finally { target.close(); }
});

test('default seed starts with an empty collection and remains empty after restart', t => {
  const f = fixture(t);
  assert.deepEqual(bootstrapKnowledge(f.store), { status: 'seeded', entries: 0 });
  assert.deepEqual(f.store.export({}), { schema_version: 2, entries: [], next_offset: null });
  f.reopen();
  assert.deepEqual(bootstrapKnowledge(f.store), { status: 'already_initialized', entries: 0 });
  assert.equal(f.store.list({}).entries.length, 0);
});

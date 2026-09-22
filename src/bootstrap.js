import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { packageEntrySchema } from './schema.js';

const seedSchema = z.object({
  schema_version: z.literal(2),
  entries: z.array(packageEntrySchema).max(10000)
}).strict();

// Repository seeds are approved for publication by the operator deploying them.
// Record completion even for an empty collection so deleted entries stay deleted.
export function bootstrapKnowledge(store, file = new URL('../knowledge/seed.json', import.meta.url)) {
  return store.transaction(() => {
    store.db.exec('CREATE TABLE IF NOT EXISTS knowledge_bootstrap (id INTEGER PRIMARY KEY CHECK (id = 1))');
    if (store.db.prepare('SELECT id FROM knowledge_bootstrap WHERE id = 1').get()) {
      return { status: 'already_initialized', entries: 0 };
    }
    let result;
    if (store.db.prepare('SELECT id FROM patterns LIMIT 1').get()) {
      result = { status: 'existing_collection_preserved', entries: 0 };
    } else {
      const pack = seedSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      if (new Set(pack.entries.map(entry => entry.id)).size !== pack.entries.length) {
        throw new Error('Duplicate IDs in seed package.');
      }
      for (const entry of pack.entries) {
        const draft = store.insertDraft(entry.id, 0, entry.content);
        store.publishRevision({ id: entry.id, revision: draft.revision });
      }
      result = { status: 'seeded', entries: pack.entries.length };
    }
    store.db.prepare('INSERT INTO knowledge_bootstrap (id) VALUES (1)').run();
    return result;
  });
}

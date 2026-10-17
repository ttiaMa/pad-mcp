import { createHash, randomBytes, randomUUID } from 'node:crypto';

const hash = token => createHash('sha256').update(token).digest('hex');
const columns = 'id, name, created_at, disabled_at';

export class ApiKeys {
  constructor(db) { this.db = db; }

  create(name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\x00-\x1f\x7f]/.test(name)) {
      throw new Error('Name must contain 1-100 characters without control characters.');
    }
    const token = `pad_dev_${randomBytes(32).toString('hex')}`;
    const key = { id: randomUUID(), name: name.trim(), created_at: new Date().toISOString(), disabled_at: null };
    this.db.prepare('INSERT INTO api_keys (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(key.id, key.name, hash(token), key.created_at);
    return { ...key, token };
  }

  // Import once: a stale environment value must never resurrect a disabled key.
  importLegacy(token) {
    if (!token) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('SELECT 1 FROM api_keys_bootstrap WHERE id = 1').get()) {
        this.db.prepare('INSERT INTO api_keys (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
          .run(randomUUID(), 'legacy-developer', hash(token), new Date().toISOString());
        this.db.prepare('INSERT INTO api_keys_bootstrap (id) VALUES (1)').run();
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  list() { return this.db.prepare(`SELECT ${columns} FROM api_keys ORDER BY created_at, id`).all(); }

  disable(id) {
    const key = this.db.prepare(`SELECT ${columns} FROM api_keys WHERE id = ?`).get(id);
    if (!key) throw new Error('API key not found.');
    if (!key.disabled_at) {
      this.db.prepare('UPDATE api_keys SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL')
        .run(new Date().toISOString(), id);
    }
    return this.db.prepare(`SELECT ${columns} FROM api_keys WHERE id = ?`).get(id);
  }

  authenticate(token) {
    return this.db.prepare(`SELECT ${columns} FROM api_keys WHERE token_hash = ? AND disabled_at IS NULL`)
      .get(hash(token)) ?? null;
  }
}

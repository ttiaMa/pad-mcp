import { createHash, randomBytes, randomUUID } from 'node:crypto';

const hash = token => createHash('sha256').update(token).digest('hex');
const columns = 'id, name, created_at, last_used_at';

export class ApiKeys {
  constructor(db) { this.db = db; }

  create(name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\x00-\x1f\x7f]/.test(name)) {
      throw new Error('Name must contain 1-100 characters without control characters.');
    }
    const token = `pad_dev_${randomBytes(32).toString('hex')}`;
    const key = { id: randomUUID(), name: name.trim(), created_at: new Date().toISOString(), last_used_at: null };
    this.db.prepare('INSERT INTO api_keys (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(key.id, key.name, hash(token), key.created_at);
    return { ...key, token };
  }

  list() { return this.db.prepare(`SELECT ${columns} FROM api_keys ORDER BY created_at, id`).all(); }

  delete(id) {
    const key = this.db.prepare('DELETE FROM api_keys WHERE id = ? RETURNING id').get(id);
    if (!key) throw new Error('API key not found.');
    return { id: key.id, deleted: true };
  }

  authenticate(token) {
    return this.db.prepare(`SELECT ${columns} FROM api_keys WHERE token_hash = ?`)
      .get(hash(token)) ?? null;
  }
}

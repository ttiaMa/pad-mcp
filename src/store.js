import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class KnowledgeError extends Error {}

// Small bilingual expansion; no model or external embedding service is required.
const groups = [
  ['date', 'dates', 'data', 'giorno', 'giorni', 'mese', 'month', 'datetime'],
  ['lista', 'liste', 'list', 'lists', 'elementi', 'items'],
  ['paginazione', 'pagination', 'batch', 'gruppi', 'blocchi'],
  ['errore', 'errori', 'error', 'errors', 'retry', 'tentativi'],
  ['stringa', 'stringhe', 'string', 'strings', 'testo', 'text'],
  ['file', 'files', 'cartella', 'folder'],
  ['coda', 'code', 'queue', 'queues']
];
const stopWords = new Set('a al alla alle con da dal dalla dei del della delle di e gli i il in la le lo mi per prendere che come devo voglio un una uno the a an to of for and how do i need'.split(' '));

function matchExpression(query) {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])]
    .filter(word => !stopWords.has(word)).slice(0, 32);
  const expanded = new Set(words);
  for (const group of groups) if (group.some(word => expanded.has(word))) {
    for (const word of group) expanded.add(word);
  }
  return [...expanded].map(word => `"${word}"`).join(' OR ');
}

export class KnowledgeStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 2, 3, 4, 5, 6].includes(version)) {
      this.db.close();
      throw new Error(`Unsupported database schema ${version}; expected 2, 3, 4, 5 or 6.`);
    }
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    if (version === 0) this.db.exec(`
      BEGIN;
      CREATE TABLE patterns (
        id TEXT PRIMARY KEY,
        latest_revision INTEGER NOT NULL,
        published_revision INTEGER
      );
      CREATE TABLE revisions (
        id TEXT NOT NULL REFERENCES patterns(id),
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        PRIMARY KEY (id, revision)
      );
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(
        id UNINDEXED, title, problem, tags, body, tokenize = 'unicode61 remove_diacritics 2'
      );
      PRAGMA user_version = 2;
      COMMIT;
    `);
    // Additive migration: knowledge, revision history and the portable v2 format stay unchanged.
    if (version < 3) try { this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE development_contexts (
        context_id TEXT PRIMARY KEY,
        power_fx TEXT NOT NULL CHECK (power_fx IN ('enabled', 'disabled')),
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER immutable_development_context BEFORE UPDATE ON development_contexts
        BEGIN SELECT RAISE(ABORT, 'Development contexts are immutable'); END;
      PRAGMA user_version = 3;
      COMMIT;
    `); } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Transaction may not have started. */ }
      this.db.close();
      throw error;
    }
    if (version < 4) try { this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      PRAGMA user_version = 4;
      COMMIT;
    `); } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Transaction may not have started. */ }
      this.db.close();
      throw error;
    }
    if (version < 5) try { this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE api_keys ADD COLUMN last_used_at TEXT;
      CREATE TABLE usage_daily (
        day TEXT NOT NULL,
        key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        tool TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('classic', 'power_fx', 'not_applicable')),
        calls INTEGER NOT NULL,
        successes INTEGER NOT NULL,
        errors INTEGER NOT NULL,
        empty_results INTEGER NOT NULL,
        PRIMARY KEY (day, key_id, tool, mode)
      );
      CREATE INDEX usage_daily_key ON usage_daily(key_id);
      PRAGMA user_version = 5;
      COMMIT;
    `); } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Transaction may not have started. */ }
      this.db.close();
      throw error;
    }
    if (version < 6) try {
      this.db.exec('BEGIN IMMEDIATE');
      // Remove the obsolete status without reactivating previously revoked access.
      if (this.db.prepare('PRAGMA table_info(api_keys)').all().some(column => column.name === 'disabled_at')) {
        this.db.exec('DELETE FROM api_keys WHERE disabled_at IS NOT NULL; ALTER TABLE api_keys DROP COLUMN disabled_at;');
      }
      this.db.exec('DROP TABLE IF EXISTS api_keys_bootstrap; PRAGMA user_version = 6; COMMIT;');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Transaction may not have started. */ }
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }
  health() { this.db.prepare('SELECT 1').get(); }

  developmentContext({ context_id, power_fx } = {}) {
    if (power_fx !== undefined && !['enabled', 'disabled'].includes(power_fx)) {
      throw new KnowledgeError('Choose power_fx enabled or disabled.');
    }
    if (context_id !== undefined) {
      const existing = this.requireContext(context_id);
      if (power_fx !== undefined && power_fx !== existing.power_fx) {
        throw new KnowledgeError('The mode of this development context cannot change. Reuse it throughout this chat.');
      }
      return { status: 'ready', ...existing };
    }
    if (power_fx === undefined) return { status: 'selection_required',
      question: 'Will this chat use PAD Classic (Power Fx disabled) or PAD with Power Fx enabled?' };
    const context = { context_id: randomUUID(), power_fx, created_at: new Date().toISOString() };
    this.db.prepare('INSERT INTO development_contexts (context_id, power_fx, created_at) VALUES (?, ?, ?)')
      .run(context.context_id, context.power_fx, context.created_at);
    return { status: 'ready', ...context };
  }

  requireContext(contextId) {
    if (typeof contextId !== 'string' || !contextId) throw new KnowledgeError('A development context_id is required. Call get_development_context first.');
    const context = this.db.prepare('SELECT * FROM development_contexts WHERE context_id = ?').get(contextId);
    if (!context) throw new KnowledgeError('Development context not found.');
    return { ...context };
  }

  searchDevelopment(args, role) {
    const context = this.requireContext(args.context_id);
    if (args.power_fx !== undefined && args.power_fx !== context.power_fx) {
      throw new KnowledgeError('Power Fx filter conflicts with the development context.');
    }
    return this.search({ ...args, power_fx: context.power_fx }, role);
  }

  getDevelopmentPattern({ id, revision, context_id }) {
    const context = this.requireContext(context_id);
    // Development always reads a published revision, even for a Maintainer.
    const pattern = this.get(id, 'developer', revision);
    if (![context.power_fx, 'either'].includes(pattern.content.power_fx)) {
      throw new KnowledgeError('Pattern is not compatible with this development context.');
    }
    return pattern;
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveDraft({ id, expected_revision, content }) {
    return this.transaction(() => this.insertDraft(id, expected_revision, content));
  }

  insertDraft(id, expectedRevision, content) {
    const current = this.db.prepare('SELECT * FROM patterns WHERE id = ?').get(id);
    const latest = current?.latest_revision ?? 0;
    if (latest !== expectedRevision) throw new KnowledgeError(`Revision conflict for ${id}: latest is ${latest}. Read it before retrying.`);
    const revision = latest + 1;
    if (!current) this.db.prepare('INSERT INTO patterns (id, latest_revision) VALUES (?, ?)').run(id, revision);
    else this.db.prepare('UPDATE patterns SET latest_revision = ? WHERE id = ?').run(revision, id);
    this.db.prepare('INSERT INTO revisions (id, revision, content, created_at) VALUES (?, ?, ?, ?)')
      .run(id, revision, JSON.stringify(content), new Date().toISOString());
    return { id, revision, status: 'draft', content };
  }

  publish({ id, revision }) {
    return this.transaction(() => this.publishRevision({ id, revision }));
  }

  // Shared by standalone publication and atomic replacement; caller owns the transaction.
  publishRevision({ id, revision }) {
    const pattern = this.db.prepare('SELECT * FROM patterns WHERE id = ?').get(id);
    if (!pattern || pattern.latest_revision !== revision) throw new KnowledgeError('Only the latest exact revision can be published. Read the pattern first.');
    const row = this.db.prepare('SELECT * FROM revisions WHERE id = ? AND revision = ?').get(id, revision);
    const content = JSON.parse(row.content);
    if (!['enabled', 'disabled', 'either'].includes(content.power_fx)) {
      throw new KnowledgeError('Publication requires an explicit power_fx classification: enabled, disabled, or either. Save a classified draft first.');
    }
    this.db.prepare('UPDATE revisions SET approved_at = COALESCE(approved_at, ?) WHERE id = ? AND revision = ?')
      .run(new Date().toISOString(), id, revision);
    this.db.prepare('UPDATE patterns SET published_revision = ? WHERE id = ?').run(revision, id);
    this.db.prepare('DELETE FROM knowledge_fts WHERE id = ?').run(id);
    this.db.prepare('INSERT INTO knowledge_fts (id, title, problem, tags, body) VALUES (?, ?, ?, ?, ?)')
      .run(id, content.title, content.problem, content.tags.join(' '), JSON.stringify(content));
    return { id, revision, status: 'published' };
  }

  replace({ id, expected_revision, content }) {
    return this.transaction(() => {
      this.requireRevision(id, expected_revision);
      const draft = this.insertDraft(id, expected_revision, content);
      const published = this.publishRevision({ id, revision: draft.revision });
      return { ...published, replaced_revision: expected_revision, history_preserved: true };
    });
  }

  requireRevision(id, expectedRevision) {
    const pattern = this.db.prepare('SELECT latest_revision FROM patterns WHERE id = ?').get(id);
    if (!pattern) throw new KnowledgeError('Pattern not found.');
    if (pattern.latest_revision !== expectedRevision) {
      throw new KnowledgeError(`Revision conflict for ${id}: latest is ${pattern.latest_revision}. Read it before retrying.`);
    }
  }

  delete({ id, expected_revision }) {
    return this.transaction(() => {
      this.requireRevision(id, expected_revision);
      this.db.prepare('DELETE FROM knowledge_fts WHERE id = ?').run(id);
      const deleted = this.db.prepare('DELETE FROM revisions WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM patterns WHERE id = ?').run(id);
      return { id, status: 'deleted', deleted_revisions: Number(deleted.changes), history_preserved: false };
    });
  }

  unpublish(id) {
    return this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM patterns WHERE id = ?').get(id)) throw new KnowledgeError('Pattern not found.');
      this.db.prepare('UPDATE patterns SET published_revision = NULL WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM knowledge_fts WHERE id = ?').run(id);
      return { id, status: 'unpublished', history_preserved: true };
    });
  }

  decode(row, role = 'maintainer') {
    return { id: row.id, revision: row.revision,
      ...(role === 'maintainer' ? { latest_revision: row.latest_revision } : {}),
      published: row.revision === row.published_revision,
      created_at: row.created_at, approved_at: row.approved_at, content: JSON.parse(row.content) };
  }

  get(id, role, revision) {
    const row = this.db.prepare(`SELECT p.*, r.* FROM patterns p JOIN revisions r ON r.id = p.id
      AND r.revision = ${revision === undefined ? (role === 'maintainer' ? 'p.latest_revision' : 'p.published_revision') : '?'}
      WHERE p.id = ? ${role === 'maintainer' ? '' : "AND r.revision = p.published_revision"}`)
      .get(...(revision === undefined ? [id] : [revision, id]));
    if (!row) throw new KnowledgeError('Pattern not found or inaccessible.');
    return this.decode(row, role);
  }

  list({ status = 'all', offset = 0, limit = 20 }) {
    const rows = this.db.prepare(`SELECT p.*, r.* FROM patterns p JOIN revisions r
      ON r.id = p.id AND r.revision = p.latest_revision
      WHERE (? = 'all' OR (? = 'draft' AND (p.published_revision IS NULL OR p.latest_revision != p.published_revision))
      OR (? = 'published' AND p.published_revision IS NOT NULL)) ORDER BY p.id LIMIT ? OFFSET ?`)
      .all(status, status, status, limit + 1, offset);
    return { entries: rows.slice(0, limit).map(row => ({ id: row.id, revision: row.revision,
      published_revision: row.published_revision, title: JSON.parse(row.content).title })),
      next_offset: rows.length > limit ? offset + limit : null };
  }

  search({ query, area, kind, power_fx, max_results = 3 }, role) {
    const expression = matchExpression(query);
    if (!expression) return { results: [], message: 'No searchable terms. Use specific task keywords.' };
    const rows = this.db.prepare(`SELECT p.*, r.* FROM knowledge_fts
      JOIN patterns p ON p.id = knowledge_fts.id
      JOIN revisions r ON r.id = p.id AND r.revision = p.published_revision
      WHERE knowledge_fts MATCH ?
      AND (? IS NULL OR json_extract(r.content, '$.area') = ?)
      AND (? IS NULL OR json_extract(r.content, '$.kind') = ?)
      AND (? IS NULL OR json_extract(r.content, '$.power_fx') IN (?, 'either'))
      ORDER BY bm25(knowledge_fts, 0, 8, 5, 6, 1), p.id LIMIT ?`)
      .all(expression, area ?? null, area ?? null, kind ?? null, kind ?? null, power_fx ?? null, power_fx ?? null, max_results);
    return { results: rows.map(row => this.decode(row, role)),
      message: rows.length ? 'Keyword matches; check task fit. Approval applies to the original revision only.' : 'No approved pattern found. Do not claim generated code is approved.' };
  }

  context(role, powerFx) {
    if (!['enabled', 'disabled'].includes(powerFx)) throw new KnowledgeError('A development mode is required for conventions.');
    const rows = this.db.prepare(`SELECT p.*, r.* FROM patterns p JOIN revisions r
      ON r.id = p.id AND r.revision = p.published_revision
      WHERE json_extract(r.content, '$.kind') = 'convention' AND json_extract(r.content, '$.area') = 'global'
      AND json_extract(r.content, '$.power_fx') IN (?, 'either')
      ORDER BY p.id LIMIT 21`).all(powerFx);
    return { conventions: rows.slice(0, 20).map(row => this.decode(row, role)), truncated: rows.length > 20 };
  }

  export({ offset = 0, limit = 20 }) {
    const rows = this.db.prepare(`SELECT p.id, r.revision, r.content FROM patterns p JOIN revisions r
      ON r.id = p.id AND r.revision = p.published_revision
      ORDER BY p.id LIMIT ? OFFSET ?`).all(limit + 1, offset);
    return { schema_version: 2, entries: rows.slice(0, limit).map(row => ({ ...row, content: JSON.parse(row.content) })),
      next_offset: rows.length > limit ? offset + limit : null };
  }

  import(pack) {
    return this.transaction(() => ({
      entries: pack.entries.map(entry => {
        const saved = this.insertDraft(entry.id, 0, entry.content);
        return { id: saved.id, revision: saved.revision, status: 'draft', source_revision: entry.revision };
      }),
      message: 'Imported as drafts. Review before publishing. Existing IDs cause the whole batch to roll back.'
    }));
  }
}

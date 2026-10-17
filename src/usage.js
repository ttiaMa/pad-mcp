const DAY = 86400000;
const sums = `COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(successes), 0) AS successes,
  COALESCE(SUM(errors), 0) AS errors, COALESCE(SUM(empty_results), 0) AS empty_results`;

export class UsageStats {
  constructor(db, { enabled = true, retentionDays = 90, now = () => new Date() } = {}) {
    this.db = db;
    this.enabled = enabled;
    this.retentionDays = retentionDays;
    this.now = now;
    this.recordingFailures = 0;
    this.cleanupFailures = 0;
  }

  day(daysAgo = 0) { return new Date(this.now().getTime() - daysAgo * DAY).toISOString().slice(0, 10); }

  cleanup() {
    try {
      this.db.prepare('DELETE FROM usage_daily WHERE day < ?').run(this.day(this.retentionDays - 1));
    } catch {
      this.cleanupFailures++;
      console.error('Usage statistics cleanup failed.');
    }
  }

  record({ keyId, tool, mode, success, empty = false }) {
    if (!this.enabled || !keyId) return;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      // A key deleted while the handler ran must not be recreated or counted.
      this.db.prepare(`INSERT INTO usage_daily (day, key_id, tool, mode, calls, successes, errors, empty_results)
        SELECT ?, id, ?, ?, 1, ?, ?, ? FROM api_keys WHERE id = ? AND disabled_at IS NULL
        ON CONFLICT(day, key_id, tool, mode) DO UPDATE SET calls = calls + 1,
          successes = successes + excluded.successes, errors = errors + excluded.errors,
          empty_results = empty_results + excluded.empty_results`)
        .run(this.day(), tool, mode, Number(success), Number(!success), Number(success && empty), keyId);
      this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ? AND disabled_at IS NULL')
        .run(this.now().toISOString(), keyId);
      this.db.exec('COMMIT');
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* No active transaction. */ }
      this.recordingFailures++;
      console.error('Usage statistics recording failed.');
    }
  }

  report({ days = 30, group_by = 'day', key_id, offset = 0, limit = 30 } = {}) {
    this.cleanup();
    const groups = { day: 'u.day', tool: 'u.tool', mode: 'u.mode', key: 'u.key_id' };
    if (!groups[group_by] || !Number.isInteger(days) || days < 1 || days > 365
      || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid usage report options.');
    }
    const from = this.day(Math.min(days, this.retentionDays) - 1);
    const to = this.day();
    const where = 'u.day >= ? AND u.day <= ?' + (key_id ? ' AND u.key_id = ?' : '');
    const params = key_id ? [from, to, key_id] : [from, to];
    const summary = this.db.prepare(`SELECT ${sums}, COUNT(DISTINCT key_id) AS active_keys
      FROM usage_daily u WHERE ${where}`).get(...params);
    const rows = this.db.prepare(`SELECT ${groups[group_by]} AS value, ${sums}
      FROM usage_daily u WHERE ${where} GROUP BY ${groups[group_by]}
      ORDER BY ${groups[group_by]} LIMIT ? OFFSET ?`).all(...params, limit + 1, offset);
    const more = rows.length > limit;
    const results = rows.slice(0, limit).map(row => group_by === 'key'
      ? { ...row, ...this.db.prepare('SELECT name, last_used_at FROM api_keys WHERE id = ?').get(row.value) }
      : row);
    return { enabled: this.enabled, retention_days: this.retentionDays, from, to, timezone: 'UTC',
      scope: 'developer', recording_failures_since_start: this.recordingFailures,
      cleanup_failures_since_start: this.cleanupFailures, summary, group_by, results,
      next_offset: more ? offset + limit : null };
  }
}

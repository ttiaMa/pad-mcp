import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CatalogIndex, CATALOG_REPOSITORY, catalogFiles, parseCatalogPair } from './catalog.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const manifestSchema = z.object({ active: z.string().uuid(), previous: z.string().uuid().nullable() });
const metadataSchema = z.object({ commit: sha, downloaded_at: z.string().datetime(),
  checksums: z.record(z.string().regex(/^[a-f0-9]{64}$/)) });
const checkSchema = z.object({ checked_at: z.string().datetime(), latest_commit: sha.nullable(), error: z.string().nullable() });
const hash = value => createHash('sha256').update(value).digest('hex');
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const modes = ['disabled', 'enabled'];
const files = modes.flatMap(mode => Object.values(catalogFiles(mode)));
const bundledDirectory = fileURLToPath(new URL('../catalogs/', import.meta.url));

/** One instance/process per data directory, shared by every role and HTTP request. */
export class CatalogCache {
  #directory; #bundle; #fetch; #now; #io; #timeout; #maxBytes;
  #loading; #snapshot; #manifest = null; #check = null; #recoveryError = null;
  #queue = Promise.resolve(); #timer; #running = false;

  constructor({ directory, bundle_directory = bundledDirectory, fetch = globalThis.fetch,
    now = Date.now, timeout_ms = 15000, max_bytes = 10 * 1024 * 1024, io = fs }) {
    if (typeof directory !== 'string' || !directory) throw new Error('A cache directory is required.');
    if (!Number.isSafeInteger(timeout_ms) || timeout_ms < 1 || !Number.isSafeInteger(max_bytes) || max_bytes < 1) {
      throw new Error('Cache timeout and size limits must be positive integers.');
    }
    this.#directory = directory; this.#bundle = bundle_directory; this.#fetch = fetch;
    this.#now = now; this.#io = io; this.#timeout = timeout_ms; this.#maxBytes = max_bytes;
  }

  #exclusive(work) {
    const pending = this.#queue.then(work);
    this.#queue = pending.catch(() => {});
    return pending;
  }

  async #download(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      const response = await this.#fetch(url, { signal: controller.signal, redirect: 'error',
        headers: { Accept: 'application/json', 'User-Agent': 'pad-mcp-catalog' } });
      if (!response.ok) throw new Error(`Catalog HTTP ${response.status}.`);
      if (Number(response.headers.get('content-length')) > this.#maxBytes) throw new Error('Catalog exceeds size limit.');
      if (!response.body) throw new Error('Catalog response has no body.');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > this.#maxBytes) throw new Error('Catalog exceeds size limit.');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } finally { controller.abort(); clearTimeout(timer); }
  }

  async #write(path, value) {
    const handle = await this.#io.open(path, 'wx');
    try { await handle.writeFile(value); await handle.sync(); }
    finally { await handle.close(); }
  }

  async #writePointer(file, value) {
    await this.#io.mkdir(this.#directory, { recursive: true });
    const temporary = join(this.#directory, `${randomUUID()}.tmp`);
    try {
      await this.#write(temporary, JSON.stringify(value));
      await this.#io.rename(temporary, join(this.#directory, file));
    } finally { await this.#io.unlink(temporary).catch(() => {}); }
  }

  async #readSnapshot(directory, id = null) {
    const metadata = metadataSchema.parse(JSON.parse(await this.#io.readFile(join(directory, 'metadata.json'), 'utf8')));
    const pairs = {};
    for (const mode of modes) {
      const input = { power_fx: mode };
      for (const [kind, file] of Object.entries(catalogFiles(mode))) {
        const bytes = await this.#io.readFile(join(directory, file));
        if (hash(bytes) !== metadata.checksums[file]) throw new Error('Catalog checksum mismatch.');
        input[kind] = bytes.toString('utf8');
      }
      pairs[mode] = parseCatalogPair(input);
    }
    return { id, metadata, pairs };
  }

  async #load() {
    try {
      this.#check = checkSchema.parse(JSON.parse(await this.#io.readFile(join(this.#directory, 'check.json'), 'utf8')));
    } catch { /* A missing/corrupt check record permits a fresh check, never an update. */ }
    try {
      this.#manifest = manifestSchema.parse(JSON.parse(await this.#io.readFile(join(this.#directory, 'manifest.json'), 'utf8')));
      for (const id of [this.#manifest.active, this.#manifest.previous].filter(Boolean)) {
        try {
          this.#snapshot = await this.#readSnapshot(join(this.#directory, id), id);
          if (id !== this.#manifest.active) this.#recoveryError = 'Active catalog failed validation; using the previous approved snapshot.';
          return;
        } catch { /* Preserve files and try the previous complete snapshot. */ }
      }
      this.#recoveryError = 'No valid approved snapshot; using bundled catalogs.';
    } catch (error) {
      if (error.code !== 'ENOENT') this.#recoveryError = 'Catalog manifest is unreadable; using bundled catalogs. Existing files were retained.';
    }
    this.#snapshot = await this.#readSnapshot(this.#bundle);
  }

  async #ready() {
    this.#loading ??= this.#load().catch(error => { this.#loading = null; throw error; });
    await this.#loading;
  }

  /** Lookups are entirely local, including on first use. */
  async get(mode) {
    catalogFiles(mode);
    await this.#ready();
    const error = this.#recoveryError ?? this.#check?.error;
    return new CatalogIndex(this.#snapshot.pairs[mode], {
      commit: this.#snapshot.metadata.commit, checked_at: this.#check?.checked_at ?? null,
      cache_status: error ? 'stale' : this.#snapshot.id ? 'approved' : 'bundled', refresh_error: error
    });
  }

  #status() {
    const baseline = this.#snapshot.metadata.commit;
    const pending = this.#check?.latest_commit && this.#check.latest_commit !== baseline;
    return {
      status: pending ? 'update_available' : 'current', repository: CATALOG_REPOSITORY,
      baseline_commit: baseline, available_commit: pending ? this.#check.latest_commit : null,
      checked_at: this.#check?.checked_at ?? null,
      check_error: this.#check?.error ?? null, recovery_error: this.#recoveryError,
      ...(pending ? { approval_required: true,
        message: `Updated PAD references are available at ${CATALOG_REPOSITORY}. Would you like to replace the locally saved Classic and Power Fx JSON catalogs?`,
        instructions: 'Show the repository link and ask the maintainer for approval. Only after explicit approval call update_catalogs with available_commit as expected_commit and confirmed=true. If declined, keep the current catalogs.' } : {})
    };
  }

  /** Persist successful and failed checks so restarts respect the daily interval. */
  checkForUpdates() {
    return this.#exclusive(async () => {
      await this.#ready();
      if (!this.#check || this.#now() >= Date.parse(this.#check.checked_at) + CHECK_INTERVAL_MS) {
        const checked_at = new Date(this.#now()).toISOString();
        try {
          const head = JSON.parse((await this.#download('https://api.github.com/repos/JoeG592/pad-robin-action-kb/commits/main')).toString('utf8'));
          this.#check = { checked_at, latest_commit: sha.parse(head.sha), error: null };
        } catch (error) {
          this.#check = { checked_at, latest_commit: this.#check?.latest_commit ?? null,
            error: `Catalog check failed: ${error.name === 'AbortError' ? 'request timed out' : error.message}` };
        }
        try { await this.#writePointer('check.json', this.#check); }
        catch { this.#check.error = 'Catalog check could not be persisted; daily backoff applies only until restart.'; }
      }
      return this.#status();
    });
  }

  /** Called only by the maintainer-only MCP tool after explicit approval of this SHA. */
  update({ expected_commit, confirmed }) {
    return this.#exclusive(async () => {
      sha.parse(expected_commit);
      if (confirmed !== true) throw new Error('Explicit maintainer approval is required.');
      await this.#ready();
      if (expected_commit === this.#snapshot.metadata.commit) return this.#status();
      if (expected_commit !== this.#check?.latest_commit) throw new Error('The proposed update changed. Read catalog update status and obtain approval again.');
      const id = randomUUID();
      const staging = join(this.#directory, `${id}.tmp`);
      await this.#io.mkdir(staging, { recursive: true });
      const metadata = { commit: expected_commit, downloaded_at: new Date(this.#now()).toISOString(), checksums: {} };
      try {
        for (const file of files) {
          const bytes = await this.#download(`https://raw.githubusercontent.com/JoeG592/pad-robin-action-kb/${expected_commit}/${file}`);
          metadata.checksums[file] = hash(bytes);
          await this.#write(join(staging, file), bytes);
        }
        await this.#write(join(staging, 'metadata.json'), JSON.stringify(metadata));
        await this.#readSnapshot(staging); // All four documents must validate before activation.
        await this.#io.rename(staging, join(this.#directory, id));
      } finally { await this.#removeKnownFiles(staging).catch(() => {}); }
      const snapshot = await this.#readSnapshot(join(this.#directory, id), id);
      const manifest = { active: id, previous: this.#snapshot.id };
      await this.#writePointer('manifest.json', manifest);
      const oldManifest = this.#manifest;
      this.#snapshot = snapshot; this.#manifest = manifest; this.#recoveryError = null;
      // Retain active + previous approved snapshots; never delete orphan generations.
      try {
        await this.#readSnapshot(join(this.#directory, id), id);
        if (manifest.previous) await this.#readSnapshot(join(this.#directory, manifest.previous), manifest.previous);
        for (const old of new Set([oldManifest?.active, oldManifest?.previous].filter(Boolean))) {
          if (old !== id && old !== manifest.previous) await this.#removeKnownFiles(join(this.#directory, old));
        }
      } catch { /* Cleanup failure must not invalidate successful activation. */ }
      return this.#status();
    });
  }

  async #removeKnownFiles(directory) {
    for (const file of [...files, 'metadata.json']) {
      await this.#io.unlink(join(directory, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await this.#io.rmdir(directory);
  }

  /** Background checks continue even when no chat is active. */
  start() {
    if (this.#running) return;
    this.#running = true;
    const tick = async () => {
      try { await this.checkForUpdates(); }
      catch (error) { console.error('Catalog check unavailable:', error.message); }
      if (!this.#running) return;
      const remaining = this.#check ? Date.parse(this.#check.checked_at) + CHECK_INTERVAL_MS - this.#now() : CHECK_INTERVAL_MS;
      this.#timer = setTimeout(tick, Math.max(1000, remaining));
      this.#timer.unref();
    };
    void tick();
  }

  stop() { this.#running = false; clearTimeout(this.#timer); }
}

import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CatalogIndex, catalogFiles, parseCatalogPair } from './catalog.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const generationId = z.string().uuid();
const date = z.string().datetime();
const manifestSchema = z.object({
  active: generationId, previous: generationId.nullable(), checked_at: date
});
const metadataSchema = z.object({
  power_fx: z.enum(['enabled', 'disabled']), commit: sha, downloaded_at: date,
  checksums: z.object({ actions: z.string().regex(/^[a-f0-9]{64}$/), types: z.string().regex(/^[a-f0-9]{64}$/) })
});
const hash = value => createHash('sha256').update(value).digest('hex');
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** One instance per data directory/process. HTTP sessions share this instance. */
export class CatalogCache {
  #directory;
  #fetch;
  #now;
  #io;
  #timeout;
  #maxBytes;
  #states = new Map();
  #pending = new Map();

  constructor({ directory, fetch = globalThis.fetch, now = Date.now, timeout_ms = 15000,
    max_bytes = 10 * 1024 * 1024, io = fs }) {
    if (typeof directory !== 'string' || !directory) throw new Error('A cache directory is required.');
    if (!Number.isSafeInteger(timeout_ms) || timeout_ms < 1 || !Number.isSafeInteger(max_bytes) || max_bytes < 1) {
      throw new Error('Cache timeout and size limits must be positive integers.');
    }
    this.#directory = directory;
    this.#fetch = fetch;
    this.#now = now;
    this.#io = io;
    this.#timeout = timeout_ms;
    this.#maxBytes = max_bytes;
  }

  async get(powerFx) {
    catalogFiles(powerFx); // Validate before constructing filesystem paths.
    if (!this.#pending.has(powerFx)) {
      const work = this.#get(powerFx).finally(() => this.#pending.delete(powerFx));
      this.#pending.set(powerFx, work);
    }
    return this.#pending.get(powerFx);
  }

  async #download(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      const response = await this.#fetch(url, {
        signal: controller.signal, redirect: 'error',
        headers: { Accept: 'application/json', 'User-Agent': 'pad-mcp-catalog' }
      });
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
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }

  async #write(path, value) {
    const handle = await this.#io.open(path, 'wx');
    try { await handle.writeFile(value); await handle.sync(); }
    finally { await handle.close(); }
  }

  async #readGeneration(root, id, mode) {
    generationId.parse(id);
    const directory = join(root, id);
    const metadata = metadataSchema.parse(JSON.parse(await this.#io.readFile(join(directory, 'metadata.json'), 'utf8')));
    if (metadata.power_fx !== mode) throw new Error('Cached edition mismatch.');
    const input = { power_fx: mode };
    for (const kind of ['actions', 'types']) {
      const bytes = await this.#io.readFile(join(directory, `${kind}.json`));
      if (hash(bytes) !== metadata.checksums[kind]) throw new Error('Cached catalog checksum mismatch.');
      input[kind] = bytes.toString('utf8');
    }
    return { id, metadata, pair: parseCatalogPair(input) };
  }

  async #load(root, mode) {
    let manifest;
    try { manifest = manifestSchema.parse(JSON.parse(await this.#io.readFile(join(root, 'manifest.json'), 'utf8'))); }
    catch (error) {
      return { generation: null, manifest: null, next_check: 0,
        error: error.code === 'ENOENT' ? null : 'Cache manifest is unreadable; existing files were retained.' };
    }
    for (const id of [manifest.active, manifest.previous].filter(Boolean)) {
      try {
        const generation = await this.#readGeneration(root, id, mode);
        const recovered = id !== manifest.active;
        return { generation, manifest, next_check: recovered ? 0 : Date.parse(manifest.checked_at) + REFRESH_INTERVAL_MS,
          error: recovered ? 'Active cache failed validation; using the previous valid pair.' : null };
      } catch { /* Try the previous pair without deleting either generation. */ }
    }
    return { generation: null, manifest, next_check: 0, error: 'No valid cached catalog pair.' };
  }

  async #activate(root, manifest) {
    const temporary = join(root, `${randomUUID()}.manifest.tmp`);
    try {
      await this.#write(temporary, JSON.stringify(manifest));
      // Same-directory rename replaces only the pointer, after both documents are durable.
      await this.#io.rename(temporary, join(root, 'manifest.json'));
    } finally { await this.#io.unlink(temporary).catch(() => {}); }
  }

  async #removeGeneration(root, id) {
    // Delete only the known files of a previously referenced generation; never recurse.
    generationId.parse(id);
    const directory = join(root, id);
    for (const file of ['actions.json', 'types.json', 'metadata.json']) {
      await this.#io.unlink(join(directory, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await this.#io.rmdir(directory);
  }

  async #refresh(root, mode, state) {
    const head = JSON.parse(await this.#download('https://api.github.com/repos/JoeG592/pad-robin-action-kb/commits/main'));
    const commit = sha.parse(head.sha);
    const checked_at = new Date(this.#now()).toISOString();
    if (state.generation?.metadata.commit === commit) {
      const manifest = { active: state.generation.id,
        previous: state.manifest?.active === state.generation.id ? state.manifest.previous : null, checked_at };
      await this.#activate(root, manifest);
      return { generation: state.generation, manifest, next_check: this.#now() + REFRESH_INTERVAL_MS, error: null };
    }
    const input = { power_fx: mode };
    for (const [kind, file] of Object.entries(catalogFiles(mode))) {
      input[kind] = await this.#download(`https://raw.githubusercontent.com/JoeG592/pad-robin-action-kb/${commit}/${file}`);
    }
    parseCatalogPair(input);
    const id = randomUUID();
    const staging = join(root, `${id}.tmp`);
    await this.#io.mkdir(staging);
    const metadata = { power_fx: mode, commit, downloaded_at: checked_at,
      checksums: { actions: hash(input.actions), types: hash(input.types) } };
    try {
      await this.#write(join(staging, 'actions.json'), input.actions);
      await this.#write(join(staging, 'types.json'), input.types);
      await this.#write(join(staging, 'metadata.json'), JSON.stringify(metadata));
      await this.#io.rename(staging, join(root, id));
    } finally {
      for (const file of ['actions.json', 'types.json', 'metadata.json']) {
        await this.#io.unlink(join(staging, file)).catch(() => {});
      }
      await this.#io.rmdir(staging).catch(() => {});
    }
    const generation = await this.#readGeneration(root, id, mode);
    const manifest = { active: id, previous: state.generation?.id ?? null, checked_at };
    await this.#activate(root, manifest);
    // Cleanup is best-effort and only follows a successful activation. Orphans are retained.
    if (manifest.previous) {
      try {
        await this.#readGeneration(root, manifest.active, mode);
        await this.#readGeneration(root, manifest.previous, mode);
        for (const obsolete of new Set([state.manifest?.active, state.manifest?.previous].filter(Boolean))) {
          if (obsolete !== manifest.active && obsolete !== manifest.previous) await this.#removeGeneration(root, obsolete);
        }
      } catch { /* Retain extra files rather than risk the valid pair. */ }
    }
    return { generation, manifest, next_check: this.#now() + REFRESH_INTERVAL_MS, error: null };
  }

  async #get(mode) {
    const root = join(this.#directory, mode);
    await this.#io.mkdir(root, { recursive: true });
    let state = this.#states.get(mode) ?? await this.#load(root, mode);
    if (this.#now() >= state.next_check) {
      try { state = await this.#refresh(root, mode, state); }
      catch (error) {
        state = { ...state, next_check: this.#now() + REFRESH_INTERVAL_MS,
          error: `Catalog refresh failed: ${error.name === 'AbortError' ? 'request timed out' : error.message}` };
      }
    }
    this.#states.set(mode, state);
    if (!state.generation) throw new Error(state.error ?? 'No valid catalog available.');
    return new CatalogIndex(state.generation.pair, {
      commit: state.generation.metadata.commit, checked_at: state.manifest?.checked_at ?? null,
      cache_status: state.error ? 'stale' : 'fresh', refresh_error: state.error
    });
  }
}

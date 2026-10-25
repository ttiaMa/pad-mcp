import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CatalogIndex, catalogFiles, parseCatalogPair } from './catalog.js';

const metadataSchema = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), downloaded_at: z.string().datetime(),
  checksums: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) });
const hash = value => createHash('sha256').update(value).digest('hex');
const modes = ['disabled', 'enabled'];
const bundledDirectory = fileURLToPath(new URL('../catalogs/', import.meta.url));

/** Read-only, in-memory cache of the catalogs shipped with the application. */
export class CatalogCache {
  #bundle; #io; #loading;

  constructor({ bundle_directory = bundledDirectory, io = fs } = {}) {
    this.#bundle = bundle_directory;
    this.#io = io;
  }

  async #readSnapshot(directory) {
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
    return { metadata, pairs };
  }

  async get(mode) {
    catalogFiles(mode);
    this.#loading ??= this.#readSnapshot(this.#bundle).catch(error => {
      this.#loading = null;
      throw error;
    });
    const snapshot = await this.#loading;
    return new CatalogIndex(snapshot.pairs[mode]);
  }
}

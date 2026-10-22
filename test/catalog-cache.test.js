import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogCache } from '../src/catalog-cache.js';
import { writeBundle } from './fixtures/catalog.js';

test('both real bundled editions are available on first use without network or a writable cache', async t => {
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected catalog request'); });
  const cache = new CatalogCache({ io: { readFile: fs.readFile } });
  for (const mode of ['enabled', 'disabled']) {
    const index = await cache.get(mode);
    const actions = index.searchActions({ module: 'Text' });
    assert.ok(actions.total_matches > 5);
    assert.equal('source' in actions, false);
    assert.ok(index.searchTypes({ type_name: 'String' }).record);
    const typeDoc = JSON.parse(await fs.readFile(new URL(`../catalogs/PAD_Robin_TypeReference${mode === 'enabled' ? '_PowerFx' : ''}.json`, import.meta.url), 'utf8'));
    const actionDoc = JSON.parse(await fs.readFile(new URL(`../catalogs/PAD_Robin_ActionKB${mode === 'enabled' ? '_PowerFx' : ''}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(index.searchActions({ action_id: 'Access.CloseAccess' }).record.error_handling,
      { on_error: true, errors: ['CloseAccessError'] });
    assert.deepEqual(index.searchActions({ action_id: 'Clipboard.Clear' }).record.error_handling,
      { on_error: false, errors: [] });
    assert.deepEqual(index.searchActions({ action_id: 'File.WaitForFile.Created' }).record.error_handling,
      { on_error: true, errors: [] });
    assert.deepEqual(index.developmentRules(), { types: typeDoc.rules, ...(actionDoc.power_fx ? { power_fx: actionDoc.power_fx } : {}) });
    const rules = index.developmentRules();
    rules.types.length = 0;
    assert.deepEqual(index.developmentRules().types, typeDoc.rules);
  }
  await assert.rejects(cache.get('../elsewhere'));
  assert.equal(network.mock.callCount(), 0);
});


test('rejects corrupted bundled data and retries after a manual repair', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'pad-bundle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeBundle(directory);
  await fs.appendFile(join(directory, 'PAD_Robin_ActionKB.json'), ' ');
  const cache = new CatalogCache({ bundle_directory: directory });
  await assert.rejects(cache.get('enabled'), /checksum mismatch/);
  await writeBundle(directory);
  assert.equal((await cache.get('enabled')).searchTypes({ type_name: 'String' }).record.example, 'enabled-a');
});

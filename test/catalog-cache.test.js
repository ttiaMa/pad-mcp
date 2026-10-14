import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogCache } from '../src/catalog-cache.js';

const HOUR = 3600000;
function documents(mode, version) {
  const header = { name: 'Synthetic', license: 'CC BY 4.0', version,
    ...(mode === 'enabled' ? { edition: 'power-fx' } : {}) };
  return {
    actions: { ...header, pad_build: '2.73', actions: [{
      actionId: 'Text.Join', module: 'Text', kind: 'Action', selector: null,
      template: 'Synthetic', golden_example: `${mode}-${version}`, input_params: [], output_params: [],
      constraints: {}, sibling_selectors: [], needs_ui_selector: false, validation: 'Synthetic only'
    }] },
    types: { ...header, rules: ['Synthetic rule'], types: [
      { type: 'String', category: 'value', example: 'Synthetic', description: 'Text' }
    ] }
  };
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'pad-catalog-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let time = Date.parse('2026-10-14T00:00:00Z');
  let version = 'a';
  let failure = null;
  const urls = [];
  const fetch = async (url, init) => {
    urls.push(url);
    if (failure) {
      const response = await failure(url, init);
      if (response) return response;
    }
    if (url.includes('api.github.com')) return Response.json({ sha: version.repeat(40) });
    const mode = url.includes('_PowerFx') ? 'enabled' : 'disabled';
    const docs = documents(mode, version);
    return Response.json(url.includes('ActionKB') ? docs.actions : docs.types);
  };
  const config = { directory, fetch, now: () => time, ...options };
  return {
    directory, urls, cache: new CatalogCache(config),
    restart: (extra = {}) => new CatalogCache({ ...config, ...extra }),
    advance: () => { time += HOUR; },
    version: value => { version = value; },
    fail: handler => { failure = handler; },
    manifest: async (mode = 'disabled') => JSON.parse(await fs.readFile(join(directory, mode, 'manifest.json'), 'utf8'))
  };
}
const detail = index => index.searchActions({ action_id: 'Text.Join' });

test('pins both files to one commit, coalesces requests and persists the hourly check', async t => {
  const f = await fixture(t);
  const indexes = await Promise.all(Array.from({ length: 10 }, () => f.cache.get('disabled')));
  assert.equal(f.urls.length, 3);
  assert.ok(f.urls.slice(1).every(url => url.includes(`/${'a'.repeat(40)}/`)));
  assert.equal(detail(indexes[0]).source.cache_status, 'fresh');
  assert.equal(detail(await f.restart().get('disabled')).record.golden_example, 'disabled-a');
  assert.equal(f.urls.length, 3);
  f.advance();
  await f.cache.get('disabled');
  assert.equal(f.urls.length, 4); // Same commit: no JSON downloads.
  await f.restart().get('disabled');
  assert.equal(f.urls.length, 4);
});

test('retains exactly active and previous generations after successful rotations', async t => {
  const f = await fixture(t);
  await f.cache.get('disabled');
  const first = await f.manifest();
  f.version('b'); f.advance(); await f.cache.get('disabled');
  const second = await f.manifest();
  assert.equal(second.previous, first.active);
  assert.equal(detail(await f.restart().get('disabled')).record.golden_example, 'disabled-b');
  f.version('c'); f.advance(); await f.cache.get('disabled');
  const third = await f.manifest();
  assert.equal(third.previous, second.active);
  assert.deepEqual((await fs.readdir(join(f.directory, 'disabled'))).sort(),
    [third.active, third.previous, 'manifest.json'].sort());
});

test('404, malformed or wrong-edition updates never replace or delete the valid pair', async t => {
  for (const failure of [
    () => new Response('gone', { status: 404 }),
    () => new Response('{invalid'),
    () => Response.json(documents('enabled', 'b').types),
    () => Response.json({ ...documents('disabled', 'b').types, types: [] })
  ]) {
    const f = await fixture(t);
    await f.cache.get('disabled');
    const before = await f.manifest();
    f.version('b'); f.advance();
    f.fail(url => url.includes('TypeReference') ? failure() : null);
    const result = detail(await f.cache.get('disabled'));
    assert.equal(result.source.cache_status, 'stale');
    assert.ok(result.source.refresh_error);
    assert.equal(result.record.golden_example, 'disabled-a');
    assert.deepEqual(await f.manifest(), before);
    const calls = f.urls.length;
    await f.cache.get('disabled');
    assert.equal(f.urls.length, calls); // Failure backoff is also one hour.
    assert.equal(detail(await f.restart().get('disabled')).record.golden_example, 'disabled-a');
  }
});

test('restart recovers the previous pair on checksum failure even when remote is unavailable', async t => {
  const f = await fixture(t);
  await f.cache.get('disabled');
  f.version('b'); f.advance(); await f.cache.get('disabled');
  const manifest = await f.manifest();
  await fs.writeFile(join(f.directory, 'disabled', manifest.active, 'actions.json'), '{}');
  f.fail(() => new Response('', { status: 503 }));
  const result = detail(await f.restart().get('disabled'));
  assert.equal(result.record.golden_example, 'disabled-a');
  assert.equal(result.source.cache_status, 'stale');
  assert.deepEqual(await f.manifest(), manifest);
  assert.ok(await fs.stat(join(f.directory, 'disabled', manifest.previous, 'types.json')));
  // A subsequent successful update retains the recovered pair, not the corrupt active pair.
  f.fail(null); f.version('c');
  await f.restart().get('disabled');
  assert.equal((await f.manifest()).previous, manifest.previous);
});

test('failed pointer activation leaves the old manifest authoritative', async t => {
  const f = await fixture(t);
  await f.cache.get('disabled');
  const manifest = await f.manifest();
  f.version('b'); f.advance();
  const failing = f.restart({ io: { ...fs, rename: async (from, to) => {
    if (to.endsWith('manifest.json')) throw new Error('Simulated rename failure');
    return fs.rename(from, to);
  } } });
  assert.equal(detail(await failing.get('disabled')).record.golden_example, 'disabled-a');
  assert.deepEqual(await f.manifest(), manifest);
  f.fail(() => new Response('', { status: 503 }));
  assert.equal(detail(await f.restart().get('disabled')).record.golden_example, 'disabled-a');
});

test('timeouts and streamed size limits fail explicitly without a valid cache', async t => {
  const timeout = await fixture(t, { timeout_ms: 10 });
  timeout.fail((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await assert.rejects(timeout.cache.get('disabled'), /timed out/);
  const size = await fixture(t, { max_bytes: 100 });
  size.fail(() => new Response('x'.repeat(101)));
  await assert.rejects(size.cache.get('disabled'), /size limit/);
  await assert.rejects(fs.stat(join(size.directory, 'disabled', 'manifest.json')), { code: 'ENOENT' });
});

test('an interrupted file write preserves the active pair and removes staging files', async t => {
  const f = await fixture(t);
  await f.cache.get('disabled');
  const manifest = await f.manifest();
  f.version('b'); f.advance();
  const failing = f.restart({ io: { ...fs, open: async (path, flags) => {
    if (path.endsWith('types.json')) throw new Error('Simulated disk full');
    return fs.open(path, flags);
  } } });
  const result = detail(await failing.get('disabled'));
  assert.equal(result.record.golden_example, 'disabled-a');
  assert.equal(result.source.cache_status, 'stale');
  assert.deepEqual(await f.manifest(), manifest);
  assert.deepEqual((await fs.readdir(join(f.directory, 'disabled'))).sort(), [manifest.active, 'manifest.json'].sort());
});

test('unreadable manifests retain existing files rather than guessing an active generation', async t => {
  const f = await fixture(t);
  await f.cache.get('disabled');
  const manifest = await f.manifest();
  await fs.writeFile(join(f.directory, 'disabled', 'manifest.json'), '{');
  f.fail(() => new Response('', { status: 503 }));
  await assert.rejects(f.restart().get('disabled'), /503/);
  assert.ok(await fs.stat(join(f.directory, 'disabled', manifest.active, 'actions.json')));
});

test('separates editions on disk and does not accept path-like modes', async t => {
  const f = await fixture(t);
  await Promise.all(['enabled', 'disabled'].map(mode => f.cache.get(mode)));
  for (const mode of ['enabled', 'disabled']) {
    const result = detail(await f.restart().get(mode));
    assert.equal(result.record.golden_example, `${mode}-a`);
    assert.equal(result.source.power_fx, mode);
  }
  await assert.rejects(f.cache.get('../elsewhere'));
});

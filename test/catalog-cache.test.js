import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogCache, CHECK_INTERVAL_MS } from '../src/catalog-cache.js';
import { documents, writeBundle } from './fixtures/catalog.js';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'pad-catalog-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = join(root, 'cache');
  const bundle_directory = join(root, 'bundle');
  await writeBundle(bundle_directory);
  let time = Date.parse('2026-10-17T00:00:00Z');
  let version = 'a';
  let failure = null;
  const urls = [];
  const fetch = async (url, init) => {
    urls.push(url);
    assert.equal(init.redirect, 'error');
    assert.equal('Authorization' in init.headers, false);
    if (failure) {
      const response = await failure(url, init);
      if (response) return response;
    }
    if (url.includes('api.github.com')) return Response.json({ sha: version.repeat(40) });
    const mode = url.includes('_PowerFx') ? 'enabled' : 'disabled';
    // Respect the immutable SHA, even if main has advanced since the proposal.
    const docs = documents(mode, url.split('/').at(-2)[0]);
    return Response.json(url.includes('ActionKB') ? docs.actions : docs.types);
  };
  const config = { directory, bundle_directory, fetch, now: () => time, ...options };
  const cache = new CatalogCache(config);
  t.after(() => cache.stop());
  return {
    directory, bundle_directory, urls, cache,
    restart: (extra = {}) => new CatalogCache({ ...config, ...extra }),
    advance: (milliseconds = CHECK_INTERVAL_MS) => { time += milliseconds; },
    version: value => { version = value; },
    fail: handler => { failure = handler; },
    manifest: async () => JSON.parse(await fs.readFile(join(directory, 'manifest.json'), 'utf8')),
    approve: async (instance = cache) => {
      const status = await instance.checkForUpdates();
      return instance.update({ expected_commit: status.available_commit, confirmed: true });
    }
  };
}
const detail = index => index.searchActions({ action_id: 'Text.Action0' });
const baseline = async cache => detail(await cache.get('disabled')).record.golden_example.split('-').at(-1).repeat(40);

test('both real bundled editions are available on first use without network or a writable cache', async () => {
  const cache = new CatalogCache({ directory: 'unused',
    io: { ...fs, mkdir: async () => { throw new Error('Read only'); } },
    fetch: () => { throw new Error('No network allowed'); } });
  for (const mode of ['enabled', 'disabled']) {
    const index = await cache.get(mode);
    const actions = index.searchActions({ module: 'Text' });
    assert.ok(actions.total_matches > 5);
    assert.equal('source' in actions, false);
    assert.ok(index.searchTypes({ type_name: 'String' }).record);
  }
  await assert.rejects(cache.get('../elsewhere'));
});

test('coalesces daily checks for both editions, persists cadence across restart and never auto-downloads', async t => {
  const f = await fixture(t);
  await Promise.all(['enabled', 'disabled'].map(mode => f.cache.get(mode)));
  assert.equal(f.urls.length, 0);
  f.version('b');
  const statuses = await Promise.all(Array.from({ length: 10 }, () => f.cache.checkForUpdates()));
  assert.equal(f.urls.length, 1);
  assert.equal('repository' in statuses[0], false);
  assert.equal(statuses[0].status, 'update_available');
  assert.equal(statuses[0].available_commit, 'b'.repeat(40));
  assert.equal(await baseline(f.cache), 'a'.repeat(40));
  f.advance(CHECK_INTERVAL_MS - 1);
  assert.equal((await f.restart().checkForUpdates()).status, 'update_available');
  assert.equal(f.urls.length, 1);
  f.advance(1);
  await f.cache.checkForUpdates();
  assert.equal(f.urls.length, 2);
  assert.ok(f.urls.every(url => url.includes('api.github.com')));
});

test('explicit approval pins all four files, atomically overrides bundles and advances the baseline', async t => {
  const f = await fixture(t);
  f.version('b');
  await f.cache.checkForUpdates();
  await assert.rejects(f.cache.update({ expected_commit: 'b'.repeat(40), confirmed: false }), /approval/);
  await assert.rejects(f.cache.update({ expected_commit: 'c'.repeat(40), confirmed: true }), /changed/);
  assert.equal(f.urls.length, 1);
  f.version('c'); // main advances after the offer, but approval is for b only.
  const args = { expected_commit: 'b'.repeat(40), confirmed: true };
  await Promise.all([f.cache.update(args), f.cache.update(args)]);
  assert.equal(f.urls.length, 5);
  assert.ok(f.urls.slice(1).every(url => url.includes(`/${'b'.repeat(40)}/`)));
  for (const mode of ['disabled', 'enabled']) {
    assert.equal(detail(await f.restart().get(mode)).record.golden_example, `${mode}-b`);
  }
  assert.equal((await f.cache.checkForUpdates()).status, 'current');
  f.advance();
  const next = await f.cache.checkForUpdates();
  assert.equal(next.baseline_commit, 'b'.repeat(40));
  assert.equal(next.available_commit, 'c'.repeat(40));
  assert.equal(await baseline(f.cache), 'b'.repeat(40));
  // Bundles are immutable: local approval only writes into the persistent cache.
  const bundle = JSON.parse(await fs.readFile(join(f.bundle_directory, 'metadata.json'), 'utf8'));
  assert.equal(bundle.commit, 'a'.repeat(40));
});

test('retains exactly active and previous approved snapshots after rotations', async t => {
  const f = await fixture(t);
  f.version('b'); await f.approve(); const first = await f.manifest();
  f.version('c'); f.advance(); await f.approve(); const second = await f.manifest();
  assert.equal(second.previous, first.active);
  f.version('d'); f.advance(); await f.approve(); const third = await f.manifest();
  assert.equal(third.previous, second.active);
  assert.deepEqual((await fs.readdir(f.directory)).sort(),
    [third.active, third.previous, 'manifest.json', 'check.json'].sort());
});

test('404, malformed, empty and wrong-edition updates preserve the entire approved snapshot', async t => {
  for (const failure of [
    () => new Response('gone', { status: 404 }),
    () => new Response('{invalid'),
    () => Response.json(documents('disabled', 'c').types),
    () => Response.json({ ...documents('enabled', 'c').types, types: [] })
  ]) {
    const f = await fixture(t);
    f.version('b'); await f.approve();
    const before = await f.manifest();
    f.version('c'); f.advance();
    f.fail(url => url.endsWith('TypeReference_PowerFx.json') ? failure() : null);
    await assert.rejects(f.approve());
    assert.deepEqual(await f.manifest(), before);
    for (const mode of ['enabled', 'disabled']) {
      assert.equal(detail(await f.restart().get(mode)).record.golden_example, `${mode}-b`);
    }
    assert.equal((await f.cache.checkForUpdates()).available_commit, 'c'.repeat(40));
    assert.equal((await fs.readdir(f.directory)).some(name => name.endsWith('.tmp')), false);
  }
});

test('restart recovers previous snapshot offline, retaining it as the next predecessor', async t => {
  const f = await fixture(t);
  f.version('b'); await f.approve();
  f.version('c'); f.advance(); await f.approve();
  const before = await f.manifest();
  await fs.writeFile(join(f.directory, before.active, 'PAD_Robin_ActionKB.json'), '{}');
  f.fail(() => new Response('', { status: 503 }));
  const recovered = f.restart();
  assert.equal(await baseline(recovered), 'b'.repeat(40));
  assert.ok((await recovered.checkForUpdates()).recovery_error);
  f.fail(null); f.version('d'); f.advance();
  await f.approve(recovered);
  assert.equal((await f.manifest()).previous, before.previous);
});

test('failed writes and pointer activation leave the old snapshot authoritative', async t => {
  for (const stage of ['write', 'activate']) {
    const f = await fixture(t);
    f.version('b'); await f.approve(); const before = await f.manifest();
    f.version('c'); f.advance();
    const failing = f.restart({ io: { ...fs,
      open: async (path, flags) => {
        if (stage === 'write' && path.endsWith('TypeReference_PowerFx.json')) throw new Error('Disk full');
        return fs.open(path, flags);
      },
      rename: async (from, to) => {
        if (stage === 'activate' && to.endsWith('manifest.json')) throw new Error('Rename failure');
        return fs.rename(from, to);
      }
    } });
    await assert.rejects(f.approve(failing), /Disk full|Rename failure/);
    assert.deepEqual(await f.manifest(), before);
    assert.equal(await baseline(failing), 'b'.repeat(40));
    assert.equal(await baseline(f.restart()), 'b'.repeat(40));
  }
});

test('daily check failures preserve pending approval and back off across restarts', async t => {
  const f = await fixture(t);
  f.version('b'); await f.cache.checkForUpdates();
  f.advance(); f.fail(() => new Response('', { status: 503 }));
  const failed = await f.cache.checkForUpdates();
  assert.match(failed.check_error, /503/);
  assert.equal(failed.available_commit, 'b'.repeat(40));
  await f.restart().checkForUpdates();
  assert.equal(f.urls.length, 2);
  assert.equal(await baseline(f.cache), 'a'.repeat(40));
  f.advance(); await f.restart().checkForUpdates();
  assert.equal(f.urls.length, 3);
});

test('timeouts and streamed/declared size limits never make bundled catalogs unavailable', async t => {
  const timeout = await fixture(t, { timeout_ms: 10 });
  timeout.fail((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  assert.match((await timeout.cache.checkForUpdates()).check_error, /timed out/);
  assert.equal(await baseline(timeout.cache), 'a'.repeat(40));
  for (const response of [new Response('x'.repeat(101)), new Response('x', { headers: { 'content-length': '101' } })]) {
    const size = await fixture(t, { max_bytes: 100 });
    size.fail(() => response);
    assert.match((await size.cache.checkForUpdates()).check_error, /size limit/);
    assert.equal(await baseline(size.cache), 'a'.repeat(40));
  }
});

test('unreadable manifest falls back to bundles without guessing or deleting existing generations', async t => {
  const f = await fixture(t);
  f.version('b'); await f.approve(); const before = await f.manifest();
  await fs.writeFile(join(f.directory, 'manifest.json'), '{');
  const restarted = f.restart();
  assert.equal(await baseline(restarted), 'a'.repeat(40));
  assert.equal((await restarted.checkForUpdates()).status, 'update_available');
  assert.ok(await fs.stat(join(f.directory, before.active, 'PAD_Robin_ActionKB.json')));
});

test('background timer checks daily without chat traffic and stops cleanly', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.cache.start();
  await f.cache.checkForUpdates();
  assert.equal(f.urls.length, 1);
  f.version('b'); f.advance();
  t.mock.timers.tick(CHECK_INTERVAL_MS);
  // Drain the queue after the timer; no duplicate remote check.
  assert.equal((await f.cache.checkForUpdates()).status, 'update_available');
  assert.equal(f.urls.length, 2);
  f.cache.stop(); f.advance();
  t.mock.timers.tick(CHECK_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(f.urls.length, 2);
});

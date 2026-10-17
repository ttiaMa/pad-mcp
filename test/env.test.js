import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const keysScript = fileURLToPath(new URL('../scripts/keys.js', import.meta.url));
const envModule = new URL('../src/env.js', import.meta.url).href;

test('CLI works without .env and create/list only expose current key metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pad-env-cli-'));
  try {
    const env = { ...process.env, DATABASE_PATH: join(dir, 'keys.sqlite') };
    const run = (...args) => exec(process.execPath, [keysScript, ...args], { cwd: dir, env });
    const empty = await run('list');
    assert.deepEqual(JSON.parse(empty.stdout), []);
    assert.equal(empty.stderr, '');
    const created = await run('create', '--name', 'Roby');
    const key = JSON.parse(created.stdout);
    assert.deepEqual(Object.keys(key).sort(), ['id', 'name', 'created_at', 'last_used_at', 'token'].sort());
    assert.equal(key.last_used_at, null);
    assert.doesNotMatch(created.stderr, /env not found/i);
    const listed = await run('list');
    assert.deepEqual(JSON.parse(listed.stdout), [{ id: key.id, name: 'Roby', created_at: key.created_at, last_used_at: null }]);
    assert.equal(listed.stderr, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('optional .env loads local values, preserves runtime values and reports real file errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pad-env-load-'));
  const childEnv = { ...process.env };
  delete childEnv.PAD_ENV_TEST_LOCAL;
  childEnv.PAD_ENV_TEST_OVERRIDE = 'runtime';
  const code = `import { loadLocalEnv } from ${JSON.stringify(envModule)};
    loadLocalEnv(); console.log(JSON.stringify({local: process.env.PAD_ENV_TEST_LOCAL, override: process.env.PAD_ENV_TEST_OVERRIDE}));`;
  const run = () => exec(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, env: childEnv });
  try {
    writeFileSync(join(dir, '.env'), 'PAD_ENV_TEST_LOCAL=local-file\nPAD_ENV_TEST_OVERRIDE=file-value\n');
    const output = await run();
    assert.deepEqual(JSON.parse(output.stdout), { local: 'local-file', override: 'runtime' });
    assert.equal(output.stderr, '');
    rmSync(join(dir, '.env'));
    mkdirSync(join(dir, '.env'));
    await assert.rejects(run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

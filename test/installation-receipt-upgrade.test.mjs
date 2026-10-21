import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectInstallationReceipt, retainLegacyInstallationReceipt } from '../scripts/install-staged-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slash = value => value.replaceAll('\\', '/');
const bash = process.env.SINGULARITY_FLOW_TEST_BASH || (process.platform === 'win32'
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const legacy = '{"schemaVersion":1,"version":"0.9.0","status":"complete"}\r\n';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-receipt-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const installations = path.join(directory, '.singularity-flow', 'installations');
  await mkdir(installations, { recursive: true });
  const current = path.join(installations, 'current.json');
  return { directory, installations, current };
}

test('built-in receipt observer classifies supported formats without migrating or trusting old fields', async t => {
  const f = await fixture(t);
  assert.equal((await inspectInstallationReceipt(f.current)).state, 'absent');
  await writeFile(f.current, legacy);
  const observation = await inspectInstallationReceipt(f.current);
  assert.equal(observation.state, 'legacy');
  assert.equal(await readFile(f.current, 'utf8'), legacy);
  const helper = spawnSync(process.execPath, [path.join(root, 'scripts/install-staged-artifacts.mjs'),
    'receipt-state', '--current-manifest', f.current], { encoding: 'utf8' });
  assert.equal(helper.status, 0, helper.stderr);
  assert.equal(helper.stdout.trim(), 'legacy');
  await writeFile(f.current, '{"schemaVersion":2}');
  assert.equal((await inspectInstallationReceipt(f.current)).state, 'current');
  for (const bytes of ['{broken', '[]', '{"schemaVersion":99}', '{"schemaVersion":1}',
    '{"schemaVersion":1,"version":"0.9.0","status":"activating"}']) {
    await writeFile(f.current, bytes);
    await assert.rejects(inspectInstallationReceipt(f.current), /receipt|JSON/);
    assert.equal(await readFile(f.current, 'utf8'), bytes);
  }
});

test('receipt archives are exact, idempotent and cannot be redirected through a linked directory', async t => {
  const f = await fixture(t);
  await writeFile(f.current, legacy);
  const observed = await inspectInstallationReceipt(f.current);
  const first = await retainLegacyInstallationReceipt(observed);
  assert.deepEqual(await retainLegacyInstallationReceipt(observed), first);
  assert.equal(await readFile(first.previousReceipt.path, 'utf8'), legacy);
  await rm(path.join(f.installations, 'receipt-history'), { recursive: true });
  const outside = path.join(f.directory, 'workspace');
  await mkdir(outside);
  const marker = path.join(outside, 'keep.txt');
  await writeFile(marker, 'workspace is not installation storage');
  await symlink(outside, path.join(f.installations, 'receipt-history'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(retainLegacyInstallationReceipt(observed), /non-symlink directory/);
  assert.equal(await readFile(marker, 'utf8'), 'workspace is not installation storage');
});

async function scriptFixture(t) {
  const f = await fixture(t);
  const bin = path.join(f.directory, 'bin');
  const log = path.join(f.directory, 'commands.log');
  await mkdir(bin);
  await mkdir(path.join(f.directory, 'scripts'));
  for (const file of ['install.sh', 'scripts/install-staged-artifacts.mjs']) {
    await copyFile(path.join(root, file), path.join(f.directory, file));
  }
  await writeFile(f.current, legacy);
  const workspace = path.join(f.directory, '.singularity-flow/workspaces.json');
  await writeFile(workspace, 'preserve workspace and Story registrations');
  for (const name of ['git', 'npm', 'copilot', 'singularity-flow', 'code', 'node']) {
    const body = name === 'node' ? `
if [[ "\${1:-}" == */repair-unreceipted-installation.mjs ]]; then
  [[ ! -e "$HOME/.singularity-flow/installations/activation-current.json.lock" ]] || exit 92
  exit 0
fi
exec ${JSON.stringify(slash(process.execPath))} "$@"`
      : name === 'npm' ? 'if [[ "$*" == "config get registry" ]]; then echo https://registry.npmjs.org/; fi'
        : name === 'git' ? 'if [[ "$*" == "show -s --format=%ct HEAD" ]]; then echo 946684800; fi' : '';
    const file = path.join(bin, name);
    await writeFile(file, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "${name} $*" >> "$INSTALL_TEST_LOG"\n${body}\n`);
    await chmod(file, 0o755);
  }
  // Git Bash initializes its own executable search path on Windows. Prepend the fixture *inside*
  // that shell so a real git/npm manager can never shadow these non-mutating test commands.
  const enter = process.platform === 'win32'
    ? 'export PATH="$(cygpath -u "$INSTALL_TEST_BIN"):$PATH"; exec bash "$@"'
    : 'export PATH="$INSTALL_TEST_BIN:$PATH"; exec bash "$@"';
  const run = args => spawnSync(bash, ['-c', enter, 'sflow-receipt-test',
    slash(path.join(f.directory, 'install.sh')), '--no-update', ...args], {
    cwd: f.directory, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: slash(f.directory), INSTALL_TEST_LOG: slash(log), INSTALL_TEST_BIN: slash(bin),
      PATH: process.platform === 'win32' ? `${bin};${process.env.PATH}` : `${bin}:/bin:/usr/bin` }
  });
  return { ...f, log, workspace, run };
}

for (const skipTests of [false, true]) {
  test(`normal installer automatically hands v1 to verified full-product upgrade (skipTests=${skipTests})`, async t => {
    const f = await scriptFixture(t);
    const result = f.run(skipTests ? ['--skip-tests'] : []);
    assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error || ''));
    assert.match(result.stdout, /automatically upgrading/);
    const commands = await readFile(f.log, 'utf8');
    assert.match(commands, /repair-unreceipted-installation\.mjs .*--legacy-receipt/);
    assert.match(commands, /npm run check/);
    assert.equal(/npm test/.test(commands), !skipTests, 'the existing full test policy is not silently weakened');
    const handoff = commands.split('\n').find(line => /repair-unreceipted-installation/.test(line));
    assert.equal(handoff.includes('--skip-tests'), skipTests);
    assert.doesNotMatch(commands, /install --global|--install-extension|workspace refresh-configuration/);
    assert.equal(await readFile(f.current, 'utf8'), legacy, 'only the verified product service may replace the receipt');
    assert.equal(await readFile(f.workspace, 'utf8'), 'preserve workspace and Story registrations');
  });
}

for (const flag of ['--cli-only', '--vscode-only', '--skip-vscode', '--skip-copilot']) {
  test(`legacy upgrade never silently expands ${flag}`, async t => {
    const f = await scriptFixture(t);
    const result = f.run([flag, '--skip-tests']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires a full install without partial-surface flags/);
    assert.equal(await readFile(f.current, 'utf8'), legacy);
    assert.doesNotMatch(await readFile(f.log, 'utf8'), /repair-unreceipted-installation|install --global|--install-extension/);
  });
}

test('normal install refuses invalid receipt metadata before dependency work or storage cleanup', async t => {
  const f = await scriptFixture(t);
  const retained = path.join(f.installations, 'versions', 'sha256', 'a'.repeat(64), 'singularity-flow.tgz');
  await mkdir(path.dirname(retained), { recursive: true });
  await writeFile(retained, 'unknown prior product bytes must survive');
  for (const bytes of ['{broken', '{"schemaVersion":999}', '{"schemaVersion":1,"status":"activating","version":"0.9.0"}']) {
    await writeFile(f.current, bytes);
    const result = f.run(['--skip-tests']);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(f.current, 'utf8'), bytes);
    assert.equal(await readFile(retained, 'utf8'), 'unknown prior product bytes must survive');
  }
  assert.doesNotMatch(await readFile(f.log, 'utf8'), /npm ci|repair-unreceipted-installation|cleanup --journal/);
});

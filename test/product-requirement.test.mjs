/**
 * Teammates update themselves from the signed release their repository's approved configuration
 * requires. Every install here runs against a fake machine; nothing real is downloaded or
 * installed.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  enforceProductRequirement, installRequiredRelease, materializeRelease, parseProductRequirement,
  productRequirementVerdict, readApprovedProductRequirement
} from '../src/product-requirement.mjs';
import { productRequirementDue, requirementChecksFile } from '../src/product-requirement-gate.mjs';
import { versionLine } from '../src/build-info.mjs';
import { parseBuildLine } from '../src/product-alignment.mjs';
import { distributionFixture } from './helpers/distribution-artifacts.mjs';
import { harness } from './helpers/distribution-harness.mjs';

const OLDER = Object.freeze({ commit: 'a'.repeat(40), sourceSha256: null, branch: null, dirty: false, builtAt: '2026-09-01T00:00:00.000Z' });
const REQUIRED_AT = '2026-09-20T00:00:00.000Z';
const NEWER = Object.freeze({ ...OLDER, commit: 'c'.repeat(40), builtAt: '2026-09-27T00:00:00.000Z' });
const DEVELOPMENT = Object.freeze({ commit: null, sourceSha256: null, branch: null, dirty: null, builtAt: null });

const pem = (publicKey) => publicKey.export({ type: 'spki', format: 'pem' });
const requirementText = ({ source, key, builtAt = REQUIRED_AT, extra = '' }) => [
  'schemaVersion: 1',
  'minimumBuild:',
  `  builtAt: ${builtAt}`,
  'release:',
  `  source: ${source}`,
  '  artifactPublicKey: |',
  ...String(key).trim().split('\n').map((line) => `    ${line}`),
  extra
].join('\n');

async function temporary(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a requirement names one build, one signed release source and the key that must sign it', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const parsed = parseProductRequirement(requirementText({ source: 'https://releases.example.test/sflow/current/', key: pem(publicKey) }));
  assert.equal(parsed.minimumBuild.builtAt, REQUIRED_AT);
  assert.equal(parsed.release.source, 'https://releases.example.test/sflow/current/');
  assert.match(parsed.release.artifactPublicKey, /^-----BEGIN PUBLIC KEY-----/u);
  assert.equal(parseProductRequirement(requirementText({ source: '/shared/sflow/current', key: pem(publicKey) })).release.source,
    '/shared/sflow/current');
  for (const [label, text] of [
    ['http', requirementText({ source: 'http://releases.example.test/', key: pem(publicKey) })],
    ['credentials', requirementText({ source: 'https://user:secret@releases.example.test/', key: pem(publicKey) })],
    ['relative folder', requirementText({ source: 'shared/sflow', key: pem(publicKey) })],
    ['no key', requirementText({ source: 'https://releases.example.test/', key: 'not a key' })],
    ['unknown field', `${requirementText({ source: 'https://releases.example.test/', key: pem(publicKey) })}\nautoApprove: true`],
    ['bad instant', requirementText({ source: 'https://releases.example.test/', key: pem(publicKey), builtAt: 'yesterday' })]
  ]) {
    assert.throws(() => parseProductRequirement(text), { code: 'PRODUCT_REQUIREMENT_INVALID' }, label);
  }
  assert.throws(() => parseProductRequirement(requirementText({ source: '/shared/sflow', key: pem(publicKey) })
    .replace('schemaVersion: 1', 'schemaVersion: 2')), { code: 'SCHEMA_VERSION_FUTURE' },
  'a requirement a newer build wrote is refused as such, and that refusal is guided');
});

test('an older stamped build needs the update, and a development checkout never updates itself', () => {
  const requirement = { minimumBuild: { builtAt: REQUIRED_AT, commit: null } };
  assert.equal(productRequirementVerdict(requirement, OLDER), 'update-required');
  assert.equal(productRequirementVerdict(requirement, NEWER), 'satisfied');
  assert.equal(productRequirementVerdict({ minimumBuild: { builtAt: REQUIRED_AT, commit: OLDER.commit } }, OLDER), 'satisfied',
    'the exact required commit satisfies it whatever its stamp time');
  assert.equal(productRequirementVerdict(requirement, DEVELOPMENT), 'development');
});

test('only an approved configuration authority can carry a requirement; a working tree cannot', async (t) => {
  const root = await temporary(t, 'sflow-requirement-root-');
  const { publicKey } = generateKeyPairSync('ed25519');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'product.yml'), requirementText({ source: '/shared/sflow', key: pem(publicKey) }));
  const read = (authority) => (_root, fn) => fn(authority);
  assert.equal(await readApprovedProductRequirement(root, { read: read(null) }), null);
  assert.equal(await readApprovedProductRequirement(root, { read: read({ kind: 'working-tree', ref: null, commit: null }) }), null,
    'a working-tree copy names both what to install and who may sign it, so it authorises nothing');
  const found = await readApprovedProductRequirement(root, { read: read({ kind: 'configuration-branch', ref: 'sflow/config', commit: 'e'.repeat(40) }) });
  assert.equal(found.authority.commit, 'e'.repeat(40));
  assert.equal(found.requirement.release.source, '/shared/sflow');
});

test('an https release is copied file by file as its RELEASE.json names them, and never over http', async (t) => {
  const release = await distributionFixture();
  t.after(() => Promise.all([rm(release.directory, { recursive: true, force: true }), rm(release.keyDirectory, { recursive: true, force: true })]));
  const tempRoot = await temporary(t, 'sflow-requirement-temp-');
  const requested = [];
  const serve = (redirectTo = null) => async (url) => {
    requested.push(url.href);
    const name = decodeURIComponent(url.pathname.split('/').at(-1));
    const bytes = await readFile(path.join(release.directory, name)).catch(() => null);
    return {
      ok: Boolean(bytes), status: bytes ? 200 : 404, url: redirectTo ?? url.href,
      arrayBuffer: async () => (bytes ?? Buffer.alloc(0)).buffer.slice(bytes?.byteOffset ?? 0, (bytes?.byteOffset ?? 0) + (bytes?.length ?? 0))
    };
  };
  const copied = await materializeRelease('https://releases.example.test/sflow/current', { fetchImpl: serve(), tempRoot });
  t.after(() => rm(copied.directory, { recursive: true, force: true }));
  assert.deepEqual((await readdir(copied.directory)).sort(), (await readdir(release.directory)).sort());
  assert.ok(requested.every((href) => href.startsWith('https://releases.example.test/sflow/current/')));
  await assert.rejects(materializeRelease('https://releases.example.test/sflow/current/', {
    fetchImpl: serve('http://releases.example.test/downgraded'), tempRoot
  }), { code: 'PRODUCT_RELEASE_UNAVAILABLE' });
  assert.deepEqual(await readdir(tempRoot).then((names) => names.filter((name) => name.startsWith('sflow-release-'))
    .filter((name) => path.join(tempRoot, name) !== copied.directory)), [], 'a refused download leaves nothing behind');
  const folder = await materializeRelease(release.directory, { fetchImpl: () => { throw new Error('no download'); } });
  assert.equal(folder.directory, release.directory);
  assert.equal(folder.temporary, null);
});

test('the required release installs on every surface only when the pinned key signed it', async (t) => {
  const release = await distributionFixture({ buildInfo: NEWER });
  t.after(() => Promise.all([rm(release.directory, { recursive: true, force: true }), rm(release.keyDirectory, { recursive: true, force: true })]));
  const home = await temporary(t, 'sflow-requirement-home-');
  const tempRoot = await temporary(t, 'sflow-requirement-plans-');
  const pinned = await readFile(release.publicKeyPath, 'utf8');
  const requirement = parseProductRequirement(requirementText({ source: release.directory, key: pinned }));

  const other = generateKeyPairSync('ed25519');
  const forged = parseProductRequirement(requirementText({ source: release.directory, key: pem(other.publicKey) }));
  const refused = harness(release.version);
  await assert.rejects(installRequiredRelease(forged, {
    execute: refused.execute, exists: refused.exists, homeDirectory: home,
    environment: { ...process.env, HOME: home }, tempRoot, running: OLDER
  }), /signature|trusted|key/iu);
  assert.equal(refused.calls.some(([command, verb, scope]) => command === 'npm' && verb === 'install' && scope === '--global'), false,
    'a release another key signed never reaches an installed surface');

  const machine = harness(release.version);
  const installed = await installRequiredRelease(requirement, {
    execute: machine.execute, exists: machine.exists, homeDirectory: home,
    environment: { ...process.env, HOME: home }, tempRoot, running: OLDER
  });
  assert.equal(installed.status, 'installed');
  assert.equal(installed.version, release.version);
  assert.ok(machine.calls.some(([command, verb, scope]) => command === 'npm' && verb === 'install' && scope === '--global'),
    'the admitted tarball was installed globally');
  const receipt = JSON.parse(await readFile(path.join(home, '.singularity-flow', 'installations', 'current.json'), 'utf8'));
  assert.equal(receipt.version, release.version, 'the install committed its receipt');
  assert.deepEqual((await readdir(tempRoot)).filter((name) => name.startsWith('sflow-release-key-')), [],
    'the pinned key copy is removed after the install');
});

test('a mutation on an older build installs the required build and hands the command to it', async (t) => {
  const root = await temporary(t, 'sflow-requirement-repo-');
  const home = await temporary(t, 'sflow-requirement-machine-');
  const { publicKey } = generateKeyPairSync('ed25519');
  const requirement = parseProductRequirement(requirementText({ source: '/shared/sflow', key: pem(publicKey) }));
  const found = { requirement, authority: { kind: 'configuration-branch', ref: 'sflow/config', commit: 'e'.repeat(40) } };
  const lines = [];
  const handed = [];
  const execute = (command, args, options) => { handed.push({ command, args, env: options.env, stdio: options.stdio }); return { status: 4 }; };
  const installs = [];
  const outcome = await enforceProductRequirement({
    root, runningBuild: 'older', argv: ['submit', '--json'], homeDirectory: home, execute, info: OLDER,
    write: (line) => lines.push(line), read: async () => found, pathBuild: () => null,
    install: async (value) => { installs.push(value); }
  });
  assert.deepEqual(outcome, { status: 'handed-off', exitCode: 4 });
  assert.equal(installs.length, 1);
  assert.deepEqual(handed.map((entry) => [entry.command, entry.args, entry.stdio]), [['singularity-flow', ['submit', '--json'], 'inherit']]);
  assert.equal(handed[0].env.SINGULARITY_FLOW_PRODUCT_UPDATE, 'off', 'the handed-off command cannot update again');
  assert.equal(handed[0].env.SINGULARITY_FLOW_PRODUCT_ALIGNMENT, 'off');
  assert.ok(lines.some((line) => /requires a build from 2026-09-20T00:00:00.000Z or later/u.test(line)));
});

test('a release that cannot meet the requirement, or would downgrade, is never installed', async (t) => {
  const home = await temporary(t, 'sflow-requirement-home-');
  const tempRoot = await temporary(t, 'sflow-requirement-plans-');
  const fixture = async (buildInfo) => {
    const release = await distributionFixture({ buildInfo });
    t.after(() => Promise.all([rm(release.directory, { recursive: true, force: true }), rm(release.keyDirectory, { recursive: true, force: true })]));
    return release;
  };
  const attempt = async (release, { requirement: overrides = {}, running = OLDER, ...options } = {}) => {
    const requirement = parseProductRequirement(requirementText({
      source: release.directory, key: await readFile(release.publicKeyPath, 'utf8'), ...overrides
    }));
    const machine = harness(release.version);
    const outcome = installRequiredRelease(requirement, {
      execute: machine.execute, exists: machine.exists, homeDirectory: home,
      environment: { ...process.env, HOME: home }, tempRoot, running, ...options
    });
    return { outcome, machine };
  };
  const staged = (machine) => machine.calls.filter(([command, verb]) => command === 'npm' && verb === 'install');

  // Published before the requirement was raised: installing it would repeat on every command.
  const stale = await fixture({ ...OLDER, commit: 'd'.repeat(40), builtAt: '2026-09-10T00:00:00.000Z' });
  const below = await attempt(stale);
  await assert.rejects(below.outcome, { code: 'PRODUCT_RELEASE_BELOW_REQUIREMENT' });
  assert.deepEqual(staged(below.machine), [], 'nothing is staged or installed for a release that cannot satisfy the requirement');

  // The exact required commit, but older than the build already running: an update never downgrades.
  const pinned = await readFile(stale.publicKeyPath, 'utf8');
  const exact = parseProductRequirement(requirementText({ source: stale.directory, key: pinned })
    .replace(`  builtAt: ${REQUIRED_AT}`, `  builtAt: ${REQUIRED_AT}\n  commit: ${'d'.repeat(40)}`));
  const machine = harness(stale.version);
  await assert.rejects(installRequiredRelease(exact, {
    execute: machine.execute, exists: machine.exists, homeDirectory: home,
    environment: { ...process.env, HOME: home }, tempRoot,
    running: { ...OLDER, commit: 'f'.repeat(40), builtAt: '2026-09-15T00:00:00.000Z' }
  }), { code: 'PRODUCT_RELEASE_DOWNGRADE' });
  assert.deepEqual(staged(machine), []);

  const unstamped = await attempt(await fixture(null));
  await assert.rejects(unstamped.outcome, { code: 'PRODUCT_RELEASE_UNSTAMPED' });

  // The verified snapshot is judged again: a shared folder can change after the first look.
  const current = await fixture(NEWER);
  const applied = [];
  const swapped = await attempt(current, {
    prepare: async () => ({ confirmation: 'INSTALL', bundle: { tarball: path.join(stale.directory, stale.tarballName) } }),
    apply: async (plan) => { applied.push(plan); }
  });
  await assert.rejects(swapped.outcome, { code: 'PRODUCT_RELEASE_BELOW_REQUIREMENT' });
  assert.deepEqual(applied, [], 'a snapshot that no longer satisfies the requirement is never applied');
});

test('a window whose CLI predates an installed update hands the command over instead of installing again', async (t) => {
  const root = await temporary(t, 'sflow-requirement-repo-');
  const home = await temporary(t, 'sflow-requirement-machine-');
  const { publicKey } = generateKeyPairSync('ed25519');
  const requirement = parseProductRequirement(requirementText({ source: '/shared/sflow', key: pem(publicKey) }));
  const found = { requirement, authority: { kind: 'configuration-branch', ref: 'sflow/config', commit: 'e'.repeat(40) } };
  const run = async (onPath) => {
    const lines = [];
    const handed = [];
    const installs = [];
    const outcome = await enforceProductRequirement({
      root, runningBuild: versionLine(OLDER), argv: ['next'], homeDirectory: home, info: OLDER,
      write: (line) => lines.push(line), read: async () => found,
      pathBuild: () => (onPath ? parseBuildLine(versionLine(onPath)) : null),
      execute: (command, args, options) => { handed.push({ command, args, env: options.env }); return { status: 0 }; },
      install: async (value) => { installs.push(value); }
    });
    return { outcome, lines, handed, installs };
  };
  const delegated = await run(NEWER);
  assert.deepEqual(delegated.outcome, { status: 'handed-off', exitCode: 0 });
  assert.deepEqual(delegated.installs, [], 'the installed build already meets the requirement: nothing is installed again');
  assert.deepEqual(delegated.handed.map((entry) => [entry.command, entry.args]), [['singularity-flow', ['next']]]);
  assert.equal(delegated.handed[0].env.SINGULARITY_FLOW_PRODUCT_UPDATE, 'off');
  assert.ok(delegated.lines.some((line) => line.includes(`continuing this command on the installed ${versionLine(NEWER)}`)));

  const stillOld = await run(OLDER);
  assert.equal(stillOld.installs.length, 1, 'a PATH build that is itself too old does not stop the install');
  const unreadable = await run(null);
  assert.equal(unreadable.installs.length, 1);
});

test('a requirement check never fails the command it precedes', async (t) => {
  const root = await temporary(t, 'sflow-requirement-repo-');
  const home = await temporary(t, 'sflow-requirement-machine-');
  const { publicKey } = generateKeyPairSync('ed25519');
  const requirement = parseProductRequirement(requirementText({ source: '/shared/sflow', key: pem(publicKey) }));
  const lines = [];
  const base = {
    root, runningBuild: 'older', argv: ['next'], homeDirectory: home, write: (line) => lines.push(line), info: OLDER,
    execute: () => { throw new Error('nothing is handed off after a failed install'); }
  };
  assert.equal((await enforceProductRequirement({
    ...base, read: async () => ({ requirement, authority: { kind: 'configuration-branch', commit: 'e'.repeat(40) } }),
    install: async () => { throw Object.assign(new Error('offline'), { code: 'PRODUCT_RELEASE_UNAVAILABLE' }); }
  })).status, 'failed');
  assert.ok(lines.some((line) => /could not install the required release \(offline\)/u.test(line) && /Continuing on this build/u.test(line)));
  assert.equal((await enforceProductRequirement({
    ...base, read: async () => { throw Object.assign(new Error('no network'), { code: 'NETWORK' }); }
  })).status, 'unavailable');
  assert.equal((await enforceProductRequirement({ ...base, read: async () => null })).status, 'none');
  const checks = JSON.parse(await readFile(requirementChecksFile(home), 'utf8'));
  assert.equal(Object.values(checks.repositories)[0].verdict, 'none', 'the last verdict is recorded per repository');
});

test('only a repository whose configuration carries a requirement pays for the check, and a verdict stands for a day', async (t) => {
  const root = await temporary(t, 'sflow-requirement-repo-');
  const home = await temporary(t, 'sflow-requirement-machine-');
  const due = (overrides = {}) => productRequirementDue({
    root, command: 'next', classification: 'mutation', homeDirectory: home, environment: {}, info: OLDER, ...overrides
  });
  assert.equal(await due(), null, 'no requirement file, no check');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'product.yml'), 'schemaVersion: 1\n');
  assert.match(await due(), /^0\.9\.0 \(a{40}/u);
  assert.equal(await due({ classification: 'read' }), null, 'reads never update');
  assert.equal(await due({ environment: { SINGULARITY_FLOW_PRODUCT_UPDATE: 'off' } }), null);
  assert.equal(await due({ info: DEVELOPMENT }), null);
  await enforceProductRequirement({
    root, runningBuild: await due(), argv: ['next'], homeDirectory: home, write: () => {}, info: OLDER,
    read: async () => ({ requirement: { minimumBuild: { builtAt: '2026-01-01T00:00:00.000Z', commit: null } }, authority: { commit: 'e'.repeat(40) } })
  });
  assert.equal(await due(), null, 'a satisfied verdict stands');
  assert.match(await due({ now: Date.now() + 25 * 60 * 60 * 1000 }), /^0\.9\.0/u, 'after a day it is checked again');
});

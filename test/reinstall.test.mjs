import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyLocalReinstall,
  assertReinstallNodeVersion,
  buildReinstallBundle,
  normalizeReinstallRegistry,
  prepareLocalReinstall,
  reinstallSourceDigest,
  reinstallPlanText,
  resolveReinstallPlan,
  repairMissingInstallationReceipt,
  upgradeLegacyInstallationReceipt
} from '../src/reinstall.mjs';
import {
  VSIX_SOURCE_MANIFEST_ENV,
  VSIX_SOURCE_MANIFEST_SHA256_ENV
} from '../src/vsix-source-manifest.mjs';
import { renderPlatformCommand } from '../src/safe-command-guidance.mjs';
import {
  acquireActivationLease, releaseActivationLease
} from '../scripts/install-staged-artifacts.mjs';
import { readRecord } from '../src/schema-migrations.mjs';

const VERSION = '9.8.7';
const BUILD = `${VERSION} (fixture-build-01234567)`;
const MANAGED = '<!-- managed-by: singularity-flow direct-skill-alias -->';

function storedZip(name, body) {
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const directory = Buffer.concat([central, filename]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(local.length + filename.length + body.length, 16);
  return Buffer.concat([local, filename, body, directory, eocd]);
}

test('reinstall requires a supported Node: 22 or newer, and on Windows 22.17 or newer, not 23', () => {
  assert.deepEqual(assertReinstallNodeVersion('v26.0.0', 'linux'), { version: '26.0.0', major: 26 });
  assert.deepEqual(assertReinstallNodeVersion('22.14.0', 'darwin'), { version: '22.14.0', major: 22 });
  assert.deepEqual(assertReinstallNodeVersion('22.17.0', 'win32'), { version: '22.17.0', major: 22 });
  assert.throws(() => assertReinstallNodeVersion('v20.20.2', 'linux'), /Node\.js 22 or newer is required; found v20\.20\.2/);
  assert.throws(() => assertReinstallNodeVersion('22.14.0', 'win32'), /Node\.js 22\.17 or newer \(not 23\) is required/);
  assert.throws(() => assertReinstallNodeVersion('23.11.1', 'win32'), /Node\.js 22\.17 or newer \(not 23\) is required/);
  assert.throws(() => assertReinstallNodeVersion('unknown'), /Could not determine/);
});

async function fixture(t = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-reinstall-test-'));
  t?.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  const home = path.join(root, 'home');
  const temp = path.join(root, 'tmp');
  await mkdir(path.join(checkout, 'plugin', 'skills', 'sflow-test'), { recursive: true });
  await mkdir(path.join(checkout, 'apps', 'vscode'), { recursive: true });
  await mkdir(path.join(checkout, 'bin'), { recursive: true });
  await mkdir(path.join(checkout, 'singularity'), { recursive: true });
  await mkdir(path.join(checkout, '.singularity'), { recursive: true });
  await mkdir(path.join(checkout, '.git', 'singularity-flow'), { recursive: true });
  await mkdir(path.join(home, '.singularity-flow'), { recursive: true });
  await mkdir(temp, { recursive: true });
  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({ name: 'singularity-flow', version: VERSION }));
  await writeFile(path.join(checkout, 'bin', 'singularity-flow.mjs'),
    `if (process.argv[2] === '--build') console.log(${JSON.stringify(BUILD)});\n`);
  await writeFile(path.join(checkout, 'install.sh'), '#!/bin/sh\n');
  await writeFile(path.join(checkout, 'plugin', 'plugin.json'), JSON.stringify({ name: 'singularity-flow', version: VERSION }));
  await writeFile(path.join(checkout, 'apps', 'vscode', 'package.json'), JSON.stringify({
    name: 'singularity-flow-vscode', publisher: 'singularityflow', version: VERSION
  }));
  await writeFile(path.join(checkout, 'plugin', 'skills', 'sflow-test', 'SKILL.md'), '---\nname: sflow-test\n---\n# Test\n');
  await writeFile(path.join(checkout, 'singularity', 'workflow.yml'), 'repository-owned\n');
  await writeFile(path.join(checkout, '.singularity', 'legacy.yml'), 'legacy-owned\n');
  await writeFile(path.join(checkout, '.git', 'singularity-flow', 'session.json'), 'session-owned\n');
  await writeFile(path.join(home, '.singularity-flow', 'workspaces.json'), '{"preserve":true}\n');
  await writeFile(path.join(home, '.singularity-flow', 'active-workspace.json'), '{"workspace":"keep"}\n');
  return { root, checkout, home, temp };
}

function commandHarness({
  installed = false, code = true, copilot = true, npmRoot = '', homeDirectory = null
} = {}) {
  const calls = [];
  const copilotPlugins = new Set(installed
    ? ['singularity-flow', 'singularity-flow@singularity-flow'] : []);
  let installedPluginRoot = null;
  const exists = (command) => command === 'node' || command === 'npm'
    || (command === 'code' && code) || (command === 'copilot' && copilot);
  const execute = (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    const words = args.join(' ');
    if (command === process.execPath && args.at(-1) === '--build') return ok(`${BUILD}\n`);
    if (command === 'npm' && words === 'config get registry') return ok('https://registry.npmjs.org/\n');
    if (command === 'npm' && words === 'root --global') return ok(`${npmRoot}\n`);
    if (command === 'npm' && args[0] === 'install' && args[1] === '--prefix') {
      const packageRoot = path.join(args[2], 'node_modules', 'singularity-flow');
      fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(packageRoot, 'plugin', 'skills', 'sflow-test'), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
        name: 'singularity-flow', version: VERSION
      }));
      fs.writeFileSync(path.join(packageRoot, 'plugin', 'plugin.json'), JSON.stringify({
        name: 'singularity-flow', version: VERSION
      }));
      fs.writeFileSync(path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
        `if (process.argv[2] === '--build') console.log(${JSON.stringify(BUILD)});\n`);
      fs.writeFileSync(path.join(packageRoot, 'plugin', 'skills', 'sflow-test', 'SKILL.md'),
        '---\nname: sflow-test\n---\n# Test\n');
      return ok('');
    }
    if (command === 'npm' && args[0] === 'list') return ok(installed
      ? JSON.stringify({ dependencies: { 'singularity-flow': { version: VERSION } } })
      : '{}');
    if (command === 'copilot' && args[0] === 'plugin' && args[1] === 'uninstall') {
      copilotPlugins.delete(args[2]);
      return ok('');
    }
    if (command === 'copilot' && args[0] === 'plugin' && args[1] === 'install') {
      copilotPlugins.add('singularity-flow');
      installedPluginRoot = args[2];
      return ok('');
    }
    if (command === 'copilot' && words === 'plugin list') {
      return ok([...copilotPlugins].join('\n'));
    }
    if (command === 'copilot' && words === 'plugin list --json') {
      return ok(JSON.stringify([...copilotPlugins].map((identity) => {
        const [name, marketplace = ''] = identity.split('@');
        return { name, marketplace, version: VERSION, enabled: true, source: 'installed' };
      })));
    }
    if (command === 'copilot' && words === 'skill list --json') {
      const skillsRoot = options.env?.SINGULARITY_FLOW_COPILOT_SKILLS_DIR
        ?? path.join(homeDirectory ?? options.env?.HOME ?? os.homedir(), '.copilot', 'skills');
      return ok(JSON.stringify([
        {
          name: 'sf-test', description: 'Test', source: 'personal-copilot',
          path: path.join(skillsRoot, 'sf-test'), enabled: true
        },
        {
          name: 'sflow-test', description: 'Test', source: 'plugin',
          path: path.join(installedPluginRoot, 'skills', 'sflow-test'), enabled: true
        }
      ]));
    }
    if (command === 'copilot' && words === 'plugins list --kind plugin --scope user --json') {
      return ok(JSON.stringify({
        plugins: [...copilotPlugins].map((name) => ({
          kind: 'plugin', name: name.split('@')[0], scope: 'user', enabled: true, version: VERSION
        })),
        errors: []
      }));
    }
    if (command === 'copilot' && words === 'plugins list --kind skill --scope user --json') {
      return ok(JSON.stringify({
        plugins: [{ kind: 'skill', name: 'sf-test', scope: 'user', enabled: true }], errors: []
      }));
    }
    if (command === 'copilot' && words === 'plugins list --kind skill --scope plugin --json') {
      return ok(JSON.stringify({
        plugins: [{ kind: 'skill', name: 'sflow-test', scope: 'plugin', enabled: true }], errors: []
      }));
    }
    if (command === 'code' && args[0] === '--list-extensions') return ok(installed
      ? `singularityflow.singularity-flow-vscode@${VERSION}\n`
      : '');
    if (command === 'singularity-flow' && words === '--version') return ok(`${VERSION}\n`);
    if (command === 'singularity-flow' && words === '--build') return ok(`${BUILD}\n`);
    if (command === 'singularity-flow' && words === 'plugin verify --json') {
      return ok('{"status":"verified"}\n');
    }
    return ok('');
  };
  return { calls, exists, execute };
}

function ok(stdout = '') { return { status: 0, stdout, stderr: '' }; }

async function fakeBuild({ checkout, registry, cliOnly, tempRoot }) {
  const stagingParent = await mkdtemp(path.join(tempRoot, 'built-'));
  const source = path.join(stagingParent, 'source');
  const artifacts = path.join(stagingParent, 'artifacts');
  await cp(checkout, source, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const tarball = path.join(artifacts, 'singularity-flow.tgz');
  const vsix = cliOnly ? null : path.join(artifacts, 'singularity-flow.vsix');
  await writeFile(tarball, `tarball:${registry}`);
  if (vsix) await writeFile(vsix, 'vsix');
  return { stagingParent, source, artifacts, tarball, vsix };
}

async function preview(context, harness, overrides = {}) {
  return prepareLocalReinstall({
    checkout: context.checkout,
    registry: 'https://artifacts.example.test/api/npm/npm-virtual',
    homeDirectory: context.home,
    tempRoot: context.temp,
    environment: {},
    build: fakeBuild,
    log: () => {},
    ...harness,
    ...overrides
  });
}

test('reinstall preview builds first and preserves every repository and workspace byte', async () => {
  const context = await fixture();
  const harness = commandHarness();
  const before = await Promise.all([
    readFile(path.join(context.checkout, 'singularity', 'workflow.yml'), 'utf8'),
    readFile(path.join(context.checkout, '.singularity', 'legacy.yml'), 'utf8'),
    readFile(path.join(context.checkout, '.git', 'singularity-flow', 'session.json'), 'utf8'),
    readFile(path.join(context.home, '.singularity-flow', 'workspaces.json'), 'utf8')
  ]);
  const plan = await preview(context, harness);
  assert.match(plan.confirmation, /^REINSTALL SINGULARITY FLOW [0-9a-f]{16}$/);
  assert.equal(plan.registry, 'https://artifacts.example.test/api/npm/npm-virtual/');
  assert.match(reinstallPlanText(plan), /No Git command was run/);
  assert.match(reinstallPlanText(plan), /staged only; product activation has not started/u);
  assert.equal(harness.calls.some((call) => call.command === 'git'), false);
  assert.equal(harness.calls.some((call) => ['install', 'uninstall'].includes(call.args[0])), false);
  assert.deepEqual(await Promise.all([
    readFile(path.join(context.checkout, 'singularity', 'workflow.yml'), 'utf8'),
    readFile(path.join(context.checkout, '.singularity', 'legacy.yml'), 'utf8'),
    readFile(path.join(context.checkout, '.git', 'singularity-flow', 'session.json'), 'utf8'),
    readFile(path.join(context.home, '.singularity-flow', 'workspaces.json'), 'utf8')
  ]), before);
});

test('reinstall preview renders reviewed values as argv rather than shell source', async () => {
  const context = await fixture();
  const plan = await preview(context, commandHarness());
  const checkout = "/tmp/SFlow $(printf INJECTED) `printf BACKTICK` O'Brien";
  const hostile = { ...plan, checkout };
  const expected = renderPlatformCommand([
    'singularity-flow', 'reinstall', '--checkout', checkout,
    '--registry', plan.registry, '--confirm', plan.confirmation
  ]);
  const rendered = reinstallPlanText(hostile);
  assert.ok(rendered.includes(`Shell: ${expected}`));
  assert.doesNotMatch(rendered, /Shell: .*"\$\(/u);
});

test('skip-tests bypasses only the reinstall test suite, never builds or artifact preparation', async t => {
  for (const cliOnly of [false, true]) {
    const context = await fixture(t);
    const calls = [], warnings = [];
    const execute = (command, args, options) => {
      calls.push({ command, args });
      if (args.join(' ') === 'run test:reinstall') return { status: 1, stderr: 'deliberately failing tests' };
      if (command === 'npm' && args[0] === 'pack') fs.writeFileSync(
        path.join(args[args.indexOf('--pack-destination') + 1], 'fixture.tgz'), 'candidate');
      if (args.join(' ') === 'run vscode:package') fs.writeFileSync(
        path.join(options.cwd, 'apps/vscode/fixture.vsix'), 'candidate vsix');
      return ok();
    };
    const options = { checkout: context.checkout, registry: 'https://registry.npmjs.org/',
      cliOnly, execute, tempRoot: context.temp, log: value => warnings.push(value) };
    await assert.rejects(buildReinstallBundle(options), /deliberately failing tests/);
    calls.length = 0;
    await buildReinstallBundle({ ...options, skipTests: true });
    assert.equal(calls.some(call => call.args.join(' ') === 'run test:reinstall'), false);
    assert.equal(calls.some(call => call.command === 'npm' && call.args[0] === 'ci'), true);
    assert.equal(calls.some(call => call.args.join(' ') === 'run vscode:typecheck'), !cliOnly);
    assert.equal(calls.some(call => call.args[0] === 'pack'), true);
    assert.equal(calls.some(call => call.args.join(' ') === 'run vscode:package'), !cliOnly);
    assert.match(warnings.join('\n'), /tests skipped by request/);
    if (!cliOnly) await assert.rejects(buildReinstallBundle({ ...options, skipTests: true,
      execute: (command, args, input) => args.join(' ') === 'run vscode:typecheck'
        ? { status: 1, stderr: 'broken typecheck' } : execute(command, args, input)
    }), /broken typecheck/);
  }
});

test('test opt-out is bound into confirmation, cache, recovery guidance, and installation receipts', async t => {
  const context = await fixture(t);
  const harness = commandHarness({ installed: true });
  const tested = await preview(context, harness);
  const skipped = await preview(context, harness, { skipTests: true });
  assert.notEqual(skipped.fingerprint, tested.fingerprint, 'identical artifact bytes cannot hide different test modes');
  assert.equal(skipped.skipTests, true);
  assert.match(reinstallPlanText(skipped), /--skip-tests/);
  assert.doesNotMatch(reinstallPlanText(skipped), /reinstall safety tests,.*completed/);
  await assert.rejects(resolveReinstallPlan({ checkout: context.checkout, confirmation: skipped.confirmation,
    cliOnly: false, telemetry: true, skipTests: false, tempRoot: context.temp, ...harness
  }), /different reinstall options/);
  const loaded = await resolveReinstallPlan({ checkout: context.checkout, confirmation: skipped.confirmation,
    cliOnly: false, telemetry: true, skipTests: true, tempRoot: context.temp, ...harness });
  assert.equal(loaded.skipTests, true);
  await assert.rejects(applyLocalReinstall({ ...loaded, skipTests: false }, {
    confirmation: loaded.confirmation, homeDirectory: context.home, environment: {}, ...harness
  }), /does not match its fingerprint/);
  const npmRoot = path.join(context.root, 'global');
  await mkdir(npmRoot, { recursive: true });
  await cp(skipped.bundle.source, path.join(npmRoot, 'singularity-flow'), { recursive: true });
  const applied = await applyLocalReinstall(loaded, { confirmation: loaded.confirmation,
    homeDirectory: context.home, environment: {},
    ...commandHarness({ installed: true, npmRoot, homeDirectory: context.home }) });
  assert.match(reinstallPlanText(applied), /TESTS SKIPPED/);
  assert.equal(JSON.parse(await readFile(applied.receipt, 'utf8')).validation.reinstallTests, 'skipped-by-request');
  assert.equal(JSON.parse(await readFile(applied.installationManifest, 'utf8')).validation.reinstallTests, 'skipped-by-request');
});

test('missing-receipt repair replaces the full product and preserves workspace and repository bytes', async t => {
  const context = await fixture(t);
  const npmRoot = path.join(context.root, 'global');
  await mkdir(npmRoot, { recursive: true });
  await cp(context.checkout, path.join(npmRoot, 'singularity-flow'), { recursive: true });
  const files = [path.join(context.home, '.singularity-flow/workspaces.json'),
    path.join(context.home, '.singularity-flow/active-workspace.json'),
    path.join(context.checkout, 'singularity/workflow.yml'), path.join(context.checkout, '.git/singularity-flow/session.json')];
  const before = await Promise.all(files.map(file => readFile(file, 'utf8')));
  const result = await repairMissingInstallationReceipt({ checkout: context.checkout, skipTests: true,
    registry: 'https://registry.npmjs.org/', homeDirectory: context.home, tempRoot: context.temp,
    environment: {}, build: fakeBuild, log: () => {},
    ...commandHarness({ installed: true, npmRoot, homeDirectory: context.home }) });
  assert.equal(result.completed, true);
  const receipt = JSON.parse(await readFile(result.receipt, 'utf8'));
  assert.equal(receipt.repairReason, 'missing-installation-receipt');
  const current = JSON.parse(await readFile(result.installationManifest, 'utf8'));
  assert.equal(current.build.cli, BUILD);
  assert.equal(current.validation.reinstallTests, 'skipped-by-request');
  assert.equal(current.workspaceRefresh, 'skipped');
  assert.deepEqual(await Promise.all(files.map(file => readFile(file, 'utf8'))), before);
});

async function legacyUpgradeFixture(t, skipTests = false) {
  const context = await fixture(t);
  const npmRoot = path.join(context.root, 'global');
  await mkdir(npmRoot, { recursive: true });
  await cp(context.checkout, path.join(npmRoot, 'singularity-flow'), { recursive: true });
  const installations = path.join(context.home, '.singularity-flow', 'installations');
  await mkdir(installations, { recursive: true });
  const current = path.join(installations, 'current.json');
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, status: 'complete', version: VERSION,
    checkout: context.checkout, tarball: 'old unavailable archive', vsix: 'old unavailable VSIX',
    artifacts: { tarball: { path: path.join(context.checkout, 'singularity/workflow.yml'), sha256: 'untrusted v1 claim' } },
    note: 'preserve exact legacy bytes, including whitespace' }, null, 4)}\r\n`);
  await writeFile(current, bytes, { mode: 0o600 });
  const harness = commandHarness({ installed: true, npmRoot, homeDirectory: context.home });
  const options = { checkout: context.checkout, skipTests, registry: 'https://registry.npmjs.org/',
    homeDirectory: context.home, tempRoot: context.temp, environment: {}, build: fakeBuild,
    log: () => {}, ...harness };
  return { ...context, installations, current, bytes, harness, options };
}

for (const skipTests of [false, true]) {
  test(`full source install upgrades v1 with exact lineage and no workspace changes (skipTests=${skipTests})`, async t => {
    const f = await legacyUpgradeFixture(t, skipTests);
    const protectedFiles = [path.join(f.home, '.singularity-flow/workspaces.json'),
      path.join(f.home, '.singularity-flow/active-workspace.json'),
      path.join(f.checkout, 'singularity/workflow.yml'), path.join(f.checkout, '.git/singularity-flow/session.json')];
    const before = await Promise.all(protectedFiles.map(file => readFile(file)));
    const buildChoices = [];
    const result = await upgradeLegacyInstallationReceipt({ ...f.options, build: options => {
      buildChoices.push(options.skipTests);
      return fakeBuild(options);
    } });
    assert.equal(result.completed, true);
    const current = readRecord('installation-current', await readFile(f.current)).record;
    assert.equal(current.schemaVersion, 2);
    assert.equal(current.build.cli, BUILD);
    assert.equal(current.rollbackArtifacts, null, 'old metadata never becomes proof of rollback bytes');
    assert.equal(current.validation.reinstallTests, skipTests ? 'skipped-by-request' : 'passed');
    assert.equal(current.workspaceRefresh, 'skipped');
    assert.deepEqual(buildChoices, [skipTests]);
    assert.deepEqual(await Promise.all(protectedFiles.map(file => readFile(file))), before);
    const upgrade = current.receiptUpgrade;
    assert.equal(upgrade.fromSchemaVersion, 1);
    assert.equal(upgrade.toSchemaVersion, 2);
    assert.equal(upgrade.method, 'verified-full-source-install');
    assert.equal(upgrade.previousReceipt.sha256, `sha256:${createHash('sha256').update(f.bytes).digest('hex')}`);
    assert.deepEqual(await readFile(upgrade.previousReceipt.path), f.bytes);
    const audit = JSON.parse(await readFile(result.receipt));
    assert.equal(audit.repairReason, 'legacy-installation-receipt');
    assert.deepEqual(audit.receiptUpgrade, upgrade);
    assert.equal(f.harness.calls.some(call => call.command === 'git'), false);
  });
}

test('legacy receipt upgrade refuses changes during the build before product mutation', async t => {
  const f = await legacyUpgradeFixture(t);
  const changed = Buffer.concat([f.bytes, Buffer.from('\n')]);
  await assert.rejects(upgradeLegacyInstallationReceipt({ ...f.options, build: async options => {
    const bundle = await fakeBuild(options);
    await writeFile(f.current, changed);
    return bundle;
  } }), /receipt changed/);
  assert.deepEqual(await readFile(f.current), changed);
  assert.equal(f.harness.calls.some(call => call.args.includes('--install-extension')
    || (call.command === 'npm' && call.args.includes('--global') && call.args[0] !== 'list')), false);
});

test('a legacy receipt can be upgraded when the old CLI is missing without treating its bytes as authority', async t => {
  const f = await legacyUpgradeFixture(t, true);
  let cliInstalled = false;
  const result = await upgradeLegacyInstallationReceipt({ ...f.options,
    execute: (command, args, options) => {
      if (command === 'npm' && args[0] === 'list' && !cliInstalled) return ok('{}');
      if (command === 'npm' && args[0] === 'install' && args.includes('--global')) cliInstalled = true;
      return f.harness.execute(command, args, options);
    }
  });
  assert.equal(result.completed, true);
  const current = JSON.parse(await readFile(f.current));
  assert.equal(current.build.cli, BUILD);
  assert.deepEqual(await readFile(current.receiptUpgrade.previousReceipt.path), f.bytes);
});

test('failed legacy activation retains old receipt and exact candidate for a lineage-preserving retry', async t => {
  const f = await legacyUpgradeFixture(t, true);
  let failed = false;
  await assert.rejects(upgradeLegacyInstallationReceipt({ ...f.options,
    execute: (command, args, options) => {
      if (command === 'code' && args[0] === '--install-extension') {
        failed = true;
        return { status: 1, stdout: '', stderr: 'fixture VS Code locked' };
      }
      return f.harness.execute(command, args, options);
    }
  }), error => /fixture VS Code locked/.test(error.message)
    && /REINSTALL SINGULARITY FLOW/.test(error.message) && /--skip-tests/.test(error.message));
  assert.equal(failed, true);
  assert.deepEqual(await readFile(f.current), f.bytes);
  const caches = await readdir(path.join(f.temp, 'singularity-flow-reinstall-plans'));
  assert.equal(caches.length, 1);
  const retainedPlan = JSON.parse(await readFile(path.join(f.temp, 'singularity-flow-reinstall-plans', caches[0], 'reinstall-plan.json')));
  const result = await applyLocalReinstall(retainedPlan, { confirmation: retainedPlan.confirmation,
    homeDirectory: f.home, environment: {}, log: () => {}, ...f.harness });
  assert.equal(result.completed, true);
  const current = JSON.parse(await readFile(f.current));
  assert.deepEqual(await readFile(current.receiptUpgrade.previousReceipt.path), f.bytes);
  assert.equal((await readdir(path.join(f.installations, 'receipt-history', 'sha256'))).length, 1);
});

test('legacy upgrade never replaces pending recovery, bad metadata, or partial selections', async t => {
  const f = await legacyUpgradeFixture(t);
  let builds = 0;
  const options = { ...f.options, build: async request => { builds++; return fakeBuild(request); } };
  await assert.rejects(upgradeLegacyInstallationReceipt({ ...options, cliOnly: true }), /full source install/);
  for (const name of ['distribution-install-pending.json', 'uninstall-pending.json']) {
    const file = path.join(f.installations, name);
    await writeFile(file, 'preserve exact pending recovery');
    await assert.rejects(upgradeLegacyInstallationReceipt(options), /recovery.*preserved/i);
    assert.equal(await readFile(file, 'utf8'), 'preserve exact pending recovery');
    await fs.promises.unlink(file);
  }
  for (const status of ['staged', 'activating', 'rolling-back', 'rollback-failed']) {
    const journal = path.join(f.installations, 'activation-current.json');
    const bytes = JSON.stringify({ schemaVersion: 1, status });
    await writeFile(journal, bytes);
    await assert.rejects(upgradeLegacyInstallationReceipt(options), /recovery refused/);
    assert.equal(await readFile(journal, 'utf8'), bytes);
    await fs.promises.unlink(journal);
  }
  for (const bytes of ['{bad JSON', '{"schemaVersion":999}', '{"schemaVersion":1}', '[]']) {
    await writeFile(f.current, bytes);
    await assert.rejects(upgradeLegacyInstallationReceipt(options), /receipt|JSON/);
    assert.equal(await readFile(f.current, 'utf8'), bytes);
  }
  await fs.promises.unlink(f.current);
  await mkdir(f.current);
  await assert.rejects(upgradeLegacyInstallationReceipt(options), /regular.*file/);
  assert.equal(builds, 0);
});

test('legacy upgrade preserves old receipt when build validation fails', async t => {
  const f = await legacyUpgradeFixture(t);
  await assert.rejects(upgradeLegacyInstallationReceipt({ ...f.options,
    build: async () => { throw new Error('fixture validation failure'); }
  }), /fixture validation failure/);
  assert.deepEqual(await readFile(f.current), f.bytes);
  assert.equal(fs.existsSync(path.join(f.installations, 'receipt-history')), false);
});

test('legacy upgrade rechecks pending recovery after the build and preserves a completed journal', async t => {
  const f = await legacyUpgradeFixture(t);
  const pending = path.join(f.installations, 'uninstall-pending.json');
  await assert.rejects(upgradeLegacyInstallationReceipt({ ...f.options, build: async options => {
    const bundle = await fakeBuild(options);
    await writeFile(pending, 'new recovery must survive');
    return bundle;
  } }), /recovery.*preserved/i);
  assert.equal(await readFile(pending, 'utf8'), 'new recovery must survive');
  assert.deepEqual(await readFile(f.current), f.bytes);
  await fs.promises.unlink(pending);
  const journal = path.join(f.installations, 'activation-current.json');
  const bytes = JSON.stringify({ schemaVersion: 1, status: 'complete',
    operationId: 'install-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  await writeFile(journal, bytes);
  const result = await upgradeLegacyInstallationReceipt(f.options);
  assert.equal(result.completed, true);
  assert.equal(await readFile(journal, 'utf8'), bytes);
});

test('receipt drift at commit cannot replace current.json or leave a false successful upgrade audit', async t => {
  const f = await legacyUpgradeFixture(t);
  const changed = Buffer.concat([f.bytes, Buffer.from('\n')]);
  await assert.rejects(upgradeLegacyInstallationReceipt({ ...f.options,
    execute: (command, args, options) => {
      if (command === 'singularity-flow' && args.join(' ') === 'plugin verify --json') {
        fs.writeFileSync(f.current, changed);
      }
      return f.harness.execute(command, args, options);
    }
  }), /receipt changed/);
  assert.deepEqual(await readFile(f.current), changed);
  assert.deepEqual((await readdir(f.installations)).filter(name => /^reinstall-.*\.json$/u.test(name)), []);
});

test('archive conflicts and non-ordinary receipt storage refuse upgrade without product mutation', async t => {
  const f = await legacyUpgradeFixture(t);
  const history = path.join(f.installations, 'receipt-history', 'sha256');
  const hash = createHash('sha256').update(f.bytes).digest('hex');
  await mkdir(history, { recursive: true });
  const archive = path.join(history, `${hash}.json`);
  await writeFile(archive, 'conflicting archive is preserved');
  await assert.rejects(upgradeLegacyInstallationReceipt(f.options), /conflicts with its digest/);
  assert.equal(await readFile(archive, 'utf8'), 'conflicting archive is preserved');
  assert.deepEqual(await readFile(f.current), f.bytes);
  assert.equal(f.harness.calls.some(call => call.args.includes('--install-extension')), false);
});

test('archive tampering during activation cannot commit a v2 receipt with broken lineage', async t => {
  const f = await legacyUpgradeFixture(t, true);
  const hash = createHash('sha256').update(f.bytes).digest('hex');
  const archive = path.join(f.installations, 'receipt-history', 'sha256', `${hash}.json`);
  await assert.rejects(upgradeLegacyInstallationReceipt({ ...f.options,
    execute: (command, args, options) => {
      if (command === 'singularity-flow' && args.join(' ') === 'plugin verify --json') {
        fs.writeFileSync(archive, 'tampered archived receipt');
      }
      return f.harness.execute(command, args, options);
    }
  }), /archived installation receipt|conflicts with its digest/);
  assert.deepEqual(await readFile(f.current), f.bytes);
  assert.equal(await readFile(archive, 'utf8'), 'tampered archived receipt');
  assert.deepEqual((await readdir(f.installations)).filter(name => /^reinstall-.*\.json$/u.test(name)), []);
});

test('test opt-out still refuses changed package bytes before product mutation', async t => {
  const context = await fixture(t);
  const harness = commandHarness({ installed: true });
  const plan = await preview(context, harness, { skipTests: true });
  await writeFile(plan.bundle.tarball, 'changed after preview');
  harness.calls.length = 0;
  await assert.rejects(applyLocalReinstall(plan, { confirmation: plan.confirmation,
    homeDirectory: context.home, environment: {}, ...harness }), /bundle changed after validation/);
  assert.equal(harness.calls.length, 0);
});

test('automatic receipt repair rechecks absence under the activation lease', async t => {
  const context = await fixture(t);
  const harness = commandHarness({ installed: true });
  const current = path.join(context.home, '.singularity-flow/installations/current.json');
  await assert.rejects(repairMissingInstallationReceipt({ checkout: context.checkout,
    skipTests: true, homeDirectory: context.home, tempRoot: context.temp,
    registry: 'https://registry.npmjs.org/', environment: {}, log: () => {}, ...harness,
    build: async options => {
      const bundle = await fakeBuild(options);
      await mkdir(path.dirname(current), { recursive: true });
      await writeFile(current, 'concurrent receipt must survive');
      return bundle;
    }
  }), /Existing receipts are preserved/);
  assert.equal(await readFile(current, 'utf8'), 'concurrent receipt must survive');
  assert.equal(harness.calls.some(call => call.command === 'npm'
    && ['install', 'uninstall'].includes(call.args[0]) && call.args.includes('--global')), false);
});

test('automatic repair never expands partial installs or overwrites receipts and active recovery', async t => {
  const context = await fixture(t);
  const harness = commandHarness({ installed: true });
  const options = { checkout: context.checkout, skipTests: true, homeDirectory: context.home,
    tempRoot: context.temp, registry: 'https://registry.npmjs.org/', environment: {}, build: fakeBuild,
    log: () => {}, ...harness };
  await assert.rejects(repairMissingInstallationReceipt({ ...options, skipTests: false }), /explicit --skip-tests/);
  await assert.rejects(repairMissingInstallationReceipt({ ...options, cliOnly: true }), /full source install/);
  const installations = path.join(context.home, '.singularity-flow/installations');
  await mkdir(installations, { recursive: true });
  for (const name of ['current.json', 'distribution-install-pending.json', 'uninstall-pending.json']) {
    const file = path.join(installations, name);
    await writeFile(file, 'preserved recovery bytes');
    await assert.rejects(repairMissingInstallationReceipt(options), /preserved|Existing receipts/);
    assert.equal(await readFile(file, 'utf8'), 'preserved recovery bytes');
    await fs.promises.unlink(file);
  }
  const journal = path.join(installations, 'activation-current.json');
  const lease = await acquireActivationLease({ journal, checkout: context.checkout, mode: 'create' });
  try {
    await assert.rejects(repairMissingInstallationReceipt(options), /another installer.*active/);
    assert.equal(harness.calls.some(call => call.command === 'npm'
      && ['install', 'uninstall'].includes(call.args[0]) && call.args.includes('--global')), false);
  } finally { await releaseActivationLease({ journal, ...lease }); }
});

test('full reinstall carries sealed source authority into Git-less VSIX packaging', async () => {
  const context = await fixture();
  const calls = [];
  let capturedManifest = null;
  let capturedManifestPath = null;
  const execute = (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    if (command === 'npm' && args[0] === 'pack') {
      const destination = args[args.indexOf('--pack-destination') + 1];
      fs.writeFileSync(path.join(destination, 'singularity-flow-fixture.tgz'), 'tarball');
    }
    if (command === 'npm' && args.join(' ') === 'run vscode:package') {
      capturedManifestPath = options.env[VSIX_SOURCE_MANIFEST_ENV];
      capturedManifest = JSON.parse(fs.readFileSync(capturedManifestPath, 'utf8'));
      fs.writeFileSync(
        path.join(options.cwd, 'apps', 'vscode', 'singularity-flow-vscode-fixture.vsix'),
        'vsix'
      );
    }
    return ok('');
  };
  const bundle = await buildReinstallBundle({
    checkout: context.checkout,
    registry: 'https://registry.npmjs.org/',
    sourceSha256: await reinstallSourceDigest(context.checkout),
    execute,
    tempRoot: context.temp,
    log: () => {}
  });
  const packaging = calls.find((call) => call.command === 'npm'
    && call.args.join(' ') === 'run vscode:package');
  assert.ok(packaging, 'full reinstall never attempted VSIX packaging');
  assert.equal(calls.some((call) => call.command === 'npm'
    && call.args.join(' ') === 'run vscode:build'), false,
  'reinstall performed a redundant pre-manifest extension build');
  assert.match(packaging.options.env[VSIX_SOURCE_MANIFEST_SHA256_ENV], /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    capturedManifestPath,
    path.join(bundle.stagingParent, 'vsix-source-manifest.json')
  );
  assert.equal(capturedManifest.sourceSha256, await reinstallSourceDigest(context.checkout));
  assert.equal(capturedManifest.records.some(
    (record) => record.path === 'apps/vscode/package.json'
  ), true);
  assert.equal(fs.existsSync(capturedManifestPath), false,
    'private source authority survived packaging');
  assert.equal(fs.existsSync(path.join(bundle.source, '.git')), false,
    'reinstall copied Git authority into the isolated source');
});

test('reinstall refuses stale confirmation, applies exact bytes, and upgrades a legacy installation receipt', async () => {
  const context = await fixture();
  const legacyTarball = path.join(context.checkout, 'singularity-flow-legacy.tgz');
  const legacyVsix = path.join(context.checkout, 'apps', 'vscode', 'singularity-flow-legacy.vsix');
  await mkdir(path.join(context.home, '.singularity-flow', 'installations'), { recursive: true });
  await writeFile(legacyTarball, 'mutable legacy tarball');
  await writeFile(legacyVsix, 'mutable legacy vsix');
  await writeFile(
    path.join(context.home, '.singularity-flow', 'installations', 'current.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      status: 'complete',
      version: VERSION,
      checkout: context.checkout,
      tarball: legacyTarball,
      vsix: legacyVsix
    }, null, 2)}\n`
  );
  const previewHarness = commandHarness({ installed: true });
  const skills = path.join(context.home, '.copilot', 'skills');
  await mkdir(path.join(skills, 'sf-old'), { recursive: true });
  await mkdir(path.join(skills, 'sf-personal'), { recursive: true });
  await writeFile(path.join(skills, 'sf-old', 'SKILL.md'), `${MANAGED}\nold\n`);
  await writeFile(path.join(skills, 'sf-personal', 'SKILL.md'), '# personal\n');
  const plan = await preview(context, previewHarness, {
    environment: { SINGULARITY_FLOW_COPILOT_SKILLS_DIR: skills }
  });
  const npmRoot = path.join(context.root, 'global-node-modules');
  await mkdir(npmRoot, { recursive: true });
  await cp(plan.bundle.source, path.join(npmRoot, 'singularity-flow'), { recursive: true });
  const applyHarness = commandHarness({ installed: true, npmRoot, homeDirectory: context.home });
  await assert.rejects(
    applyLocalReinstall(plan, {
      confirmation: 'REINSTALL SINGULARITY FLOW wrong', homeDirectory: context.home,
      environment: { SINGULARITY_FLOW_COPILOT_SKILLS_DIR: skills }, ...applyHarness
    }),
    /exact confirmation/
  );
  assert.equal(applyHarness.calls.length, 0, 'a bad confirmation cannot uninstall anything');
  await assert.rejects(
    applyLocalReinstall({ ...plan, version: '9.8.8' }, {
      confirmation: plan.confirmation, homeDirectory: context.home,
      environment: { SINGULARITY_FLOW_COPILOT_SKILLS_DIR: skills }, ...applyHarness
    }),
    /does not match its fingerprint/
  );
  assert.equal(applyHarness.calls.length, 0, 'a forged cached plan cannot uninstall anything');
  const result = await applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    homeDirectory: context.home,
    environment: { SINGULARITY_FLOW_COPILOT_SKILLS_DIR: skills },
    ...applyHarness
  });
  assert.equal(result.completed, true);
  assert.match(reinstallPlanText(result),
    /Singularity Flow product activation — COMPLETE AND VERIFIED/u);
  assert.ok(reinstallPlanText(result).endsWith(
    'Singularity Flow product activation — COMPLETE AND VERIFIED'
  ));
  assert.match(reinstallPlanText(result), /Installed CLI build:/u);
  assert.match(reinstallPlanText(result), /Installation receipt:/u);
  assert.ok(result.receipt.startsWith(path.join(context.home, '.singularity-flow', 'installations')));
  assert.equal(
    result.installationManifest,
    path.join(context.home, '.singularity-flow', 'installations', 'current.json')
  );
  const current = JSON.parse(await readFile(result.installationManifest, 'utf8'));
  assert.equal(current.schemaVersion, 2);
  assert.equal(current.status, 'complete');
  assert.equal(current.version, VERSION);
  assert.deepEqual(current.build, { cli: BUILD });
  assert.equal(current.checkout, plan.checkout);
  assert.equal(current.artifacts.tarball.sha256, `sha256:${plan.artifacts.tarballSha256}`);
  assert.equal(current.artifacts.vsix.sha256, `sha256:${plan.artifacts.vsixSha256}`);
  assert.match(current.artifacts.tarball.path,
    /[/\\]installations[/\\]versions[/\\]sha256[/\\][a-f0-9]{64}[/\\]singularity-flow\.tgz$/u);
  assert.match(current.artifacts.vsix.path,
    /[/\\]installations[/\\]versions[/\\]sha256[/\\][a-f0-9]{64}[/\\]singularity-flow\.vsix$/u);
  assert.notEqual(current.artifacts.tarball.path, legacyTarball);
  assert.notEqual(current.artifacts.vsix.path, legacyVsix);
  assert.deepEqual(await readFile(current.artifacts.tarball.path), await readFile(plan.bundle.tarball));
  assert.deepEqual(await readFile(current.artifacts.vsix.path), await readFile(plan.bundle.vsix));
  assert.deepEqual(current.surfaces, {
    cli: true, vscode: true, copilot: true, telemetry: true, manifest: true
  });
  assert.deepEqual(current.reinstall, { fingerprint: plan.fingerprint, receipt: result.receipt });
  assert.equal(result.verified.cliBuild, BUILD);
  assert.ok(applyHarness.calls.some((call) => call.command === 'singularity-flow'
    && call.args.join(' ') === '--build'));
  assert.ok(applyHarness.calls.some((call) => call.command === 'singularity-flow'
    && call.args.join(' ') === 'plugin verify --json'));
  assert.equal(await readFile(path.join(skills, 'sf-personal', 'SKILL.md'), 'utf8'), '# personal\n');
  assert.match(await readFile(path.join(skills, 'sf-test', 'SKILL.md'), 'utf8'), new RegExp(MANAGED));
  await assert.rejects(readFile(path.join(skills, 'sf-old', 'SKILL.md')), /ENOENT/);
  assert.equal(await readFile(path.join(context.home, '.singularity-flow', 'workspaces.json'), 'utf8'), '{"preserve":true}\n');
  assert.equal(await readFile(path.join(context.home, '.singularity-flow', 'active-workspace.json'), 'utf8'), '{"workspace":"keep"}\n');
  assert.equal(applyHarness.calls.some((call) => call.command === 'git'), false);
  // Over the top: the direct copy a running chat's hooks use is never taken away first.
  assert.ok(applyHarness.calls.some((call) => call.command === 'copilot'
    && call.args.join(' ') === 'plugin uninstall singularity-flow@singularity-flow'));
  assert.equal(applyHarness.calls.some((call) => call.command === 'copilot'
    && call.args.join(' ') === 'plugin uninstall singularity-flow'), false);
  const skillVerification = applyHarness.calls.find((call) => call.command === 'copilot'
    && call.args.join(' ') === 'skill list --json');
  assert.equal(skillVerification.options.env.SINGULARITY_FLOW_COPILOT_SKILLS_DIR, skills);
  const npmInstall = applyHarness.calls.find((call) => call.command === 'npm' && call.args[0] === 'install');
  assert.equal(npmInstall.options.env.NPM_CONFIG_REGISTRY, plan.registry);
  assert.ok(npmInstall.args.includes(`--registry=${plan.registry}`));
});

test('reinstall refuses the same semantic version when the installed build provenance differs', async () => {
  const context = await fixture();
  const previewHarness = commandHarness();
  const plan = await preview(context, previewHarness, { cliOnly: true });
  const npmRoot = path.join(context.root, 'global-node-modules');
  await mkdir(npmRoot, { recursive: true });
  await cp(plan.bundle.source, path.join(npmRoot, 'singularity-flow'), { recursive: true });
  const base = commandHarness({ npmRoot });
  const execute = (command, args, options) => {
    if (command === 'singularity-flow' && args.join(' ') === '--build') {
      base.calls.push({ command, args: [...args], options });
      return ok(`${VERSION} (stale-fixture-build-89abcdef)\n`);
    }
    return base.execute(command, args, options);
  };
  await assert.rejects(applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    homeDirectory: context.home,
    ...base,
    execute
  }), (error) => {
    assert.match(error.message,
      /Installed CLI build .* does not match the admitted candidate build/u);
    assert.match(error.message, /same exact command|recovery/iu);
    return true;
  });
  assert.ok(base.calls.some((call) => call.command === 'singularity-flow'
    && call.args.join(' ') === '--version'));
  assert.ok(base.calls.some((call) => call.command === 'singularity-flow'
    && call.args.join(' ') === '--build'));
  assert.equal(fs.existsSync(path.join(
    context.home, '.singularity-flow', 'installations', 'current.json'
  )), false, 'a same-version stale build cannot commit a successful installation receipt');
});

test('reinstall refuses an unstamped development candidate before product mutation', async () => {
  const context = await fixture();
  const plan = await preview(context, commandHarness(), { cliOnly: true, telemetry: false });
  const harness = commandHarness();
  const execute = (command, args, options) => {
    if (command === process.execPath && args.at(-1) === '--build') {
      harness.calls.push({ command, args: [...args], options });
      return ok(`${VERSION} (development checkout, not a stamped package)\n`);
    }
    return harness.execute(command, args, options);
  };
  await assert.rejects(applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    homeDirectory: context.home,
    ...harness,
    execute
  }), /invalid build identity.*development checkout/iu);
  assert.equal(harness.calls.some((call) => call.command === 'npm'
    && call.args[0] === 'install' && call.args[1] === '--global'), false);
  assert.equal(harness.calls.some((call) => call.command === 'copilot'
    && ['install', 'uninstall'].includes(call.args[1])), false,
  'an unstamped candidate is rejected before any Copilot mutation');
  assert.equal(harness.calls.some((call) => call.command === 'code'
    && ['--install-extension', '--uninstall-extension'].includes(call.args[0])), false,
  'an unstamped candidate is rejected before any VS Code mutation');
});

test('telemetry opt-out is reported as partial activation by request', async () => {
  const context = await fixture();
  const harness = commandHarness({ code: false, homeDirectory: context.home });
  const plan = await preview(context, harness, { telemetry: false });
  const result = await applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    homeDirectory: context.home,
    ...harness
  });
  assert.equal(result.completed, true);
  assert.equal(result.verified.telemetryManaged, false);
  const current = JSON.parse(await readFile(result.installationManifest, 'utf8'));
  assert.equal(current.surfaces.telemetry, false);
  assert.ok(reinstallPlanText(result).endsWith(
    'Singularity Flow product activation — PARTIAL BY REQUEST'
  ));
});

test('cached reinstall confirmation is bound to checkout, registry, artifacts, and options', async () => {
  const context = await fixture();
  const harness = commandHarness();
  const plan = await preview(context, harness);
  const loaded = await resolveReinstallPlan({
    checkout: context.checkout,
    confirmation: plan.confirmation,
    registry: plan.registry,
    cliOnly: false,
    telemetry: true,
    tempRoot: context.temp,
    ...harness
  });
  assert.equal(loaded.fingerprint, plan.fingerprint);
  await assert.rejects(resolveReinstallPlan({
    checkout: context.checkout,
    confirmation: plan.confirmation,
    registry: 'https://other.example.test/npm/',
    cliOnly: false,
    telemetry: true,
    tempRoot: context.temp,
    ...harness
  }), /different npm registry/);
  await assert.rejects(resolveReinstallPlan({
    checkout: context.checkout,
    confirmation: 'wrong confirmation',
    registry: plan.registry,
    cliOnly: false,
    telemetry: true,
    tempRoot: context.temp,
    ...harness
  }), /not valid/);
  await assert.rejects(resolveReinstallPlan({
    checkout: context.checkout,
    confirmation: 'REINSTALL SINGULARITY FLOW 0000000000000000',
    registry: plan.registry,
    cliOnly: false,
    telemetry: true,
    tempRoot: context.temp,
    ...harness
  }), /No validated reinstall preview/);
});

test('missing Copilot requires cli-only while missing code is an explicitly skipped optional surface', async () => {
  const context = await fixture();
  await assert.rejects(preview(context, commandHarness({ copilot: false })), /use --cli-only/);
  const cliPlan = await preview(context, commandHarness({ copilot: false, code: false }), { cliOnly: true, telemetry: false });
  assert.equal(cliPlan.cliOnly, true);
  assert.equal(cliPlan.remove.length, 1);
  const cliText = reinstallPlanText(cliPlan);
  assert.match(cliText, /isolated CLI build/);
  assert.doesNotMatch(cliText, /VSIX completed/);
  assert.match(cliText, /--cli-only/);
  assert.ok(cliText.includes(renderPlatformCommand([
    'singularity-flow', 'reinstall', '--checkout', cliPlan.checkout,
    '--registry', cliPlan.registry, '--confirm', cliPlan.confirmation, '--cli-only'
  ])));
  const noCode = await preview(context, commandHarness({ code: false }));
  assert.ok(noCode.remove.some((item) => item.includes('code CLI unavailable; skipped')));
});

test('CLI-only reinstall refuses an installed VSIX without trusted rollback authority before any removal', async () => {
  const context = await fixture();
  const installations = path.join(context.home, '.singularity-flow', 'installations');
  const currentFile = path.join(installations, 'current.json');
  await mkdir(installations, { recursive: true });
  const legacyReceipt = `${JSON.stringify({
    schemaVersion: 1,
    status: 'complete',
    version: VERSION,
    checkout: context.checkout,
    tarball: path.join(context.checkout, 'legacy.tgz'),
    vsix: path.join(context.checkout, 'legacy.vsix')
  }, null, 2)}\n`;
  await writeFile(currentFile, legacyReceipt);
  const previewHarness = commandHarness({ installed: true });
  let built = false;
  await assert.rejects(preview(context, previewHarness, {
    cliOnly: true,
    telemetry: false,
    build: async (options) => {
      built = true;
      return fakeBuild(options);
    }
  }), /CLI-only clean reinstall cannot preserve rollback authority.*full clean reinstall/su);
  assert.equal(built, false, 'an uncovered installed VSIX is refused before packaging');
  await assert.rejects(preview(context, previewHarness, { cliOnly: true, skipTests: true }),
    error => /CLI-only clean reinstall cannot preserve rollback authority/.test(error.message)
      && /--skip-tests/.test(error.message), 'full-repair guidance preserves the explicit test opt-out');

  const bytes = storedZip('extension/package.json', Buffer.from(JSON.stringify({
    publisher: 'singularityflow', name: 'singularity-flow-vscode', version: VERSION
  })));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const retainedVsix = path.join(
    installations, 'versions', 'sha256', digest, 'singularity-flow.vsix'
  );
  await mkdir(path.dirname(retainedVsix), { recursive: true });
  await writeFile(retainedVsix, bytes);
  await writeFile(currentFile, `${JSON.stringify({
    schemaVersion: 2,
    artifacts: {
      tarball: null,
      vsix: {
        path: retainedVsix,
        sha256: `sha256:${digest}`,
        extensionId: 'singularityflow.singularity-flow-vscode',
        version: VERSION
      }
    }
  })}\n`);
  const plan = await preview(context, commandHarness({ installed: true }), {
    cliOnly: true, telemetry: false
  });

  // The apply path must re-admit the live receipt rather than trusting the preview snapshot.
  await writeFile(currentFile, legacyReceipt);
  const applyHarness = commandHarness({ installed: true });
  await assert.rejects(applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    homeDirectory: context.home,
    ...applyHarness
  }), /CLI-only clean reinstall cannot preserve rollback authority.*full clean reinstall/su);
  assert.equal(
    applyHarness.calls.some((call) => call.command === 'npm'
      && call.args[0] === 'install' && call.args[1] === '--global'),
    false,
    'apply refuses before replacing the global package'
  );
  assert.equal(await readFile(currentFile, 'utf8'), legacyReceipt);
});

test('CLI-only reinstall preserves an untouched VSIX only from an already trusted schema-v2 binding', async () => {
  const context = await fixture();
  const harness = commandHarness({ installed: true, homeDirectory: context.home });
  const bytes = storedZip('extension/package.json', Buffer.from(JSON.stringify({
    publisher: 'singularityflow', name: 'singularity-flow-vscode', version: VERSION
  })));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const installations = path.join(context.home, '.singularity-flow', 'installations');
  const retainedVsix = path.join(
    installations, 'versions', 'sha256', digest, 'singularity-flow.vsix'
  );
  await mkdir(path.dirname(retainedVsix), { recursive: true });
  await writeFile(retainedVsix, bytes);
  await writeFile(path.join(installations, 'current.json'), `${JSON.stringify({
    schemaVersion: 2,
    artifacts: {
      tarball: null,
      vsix: {
        path: retainedVsix,
        sha256: `sha256:${digest}`,
        extensionId: 'singularityflow.singularity-flow-vscode',
        version: VERSION
      }
    }
  })}\n`);
  const plan = await preview(context, harness, { cliOnly: true, telemetry: false });
  const result = await applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    homeDirectory: context.home,
    ...harness
  });
  const current = JSON.parse(await readFile(result.installationManifest, 'utf8'));
  assert.equal(current.artifacts.vsix.path, retainedVsix);
  assert.equal(current.artifacts.vsix.sha256, `sha256:${digest}`);
  assert.equal(current.surfaces.vscode, true);
  assert.equal(current.surfaces.copilot, false);
  assert.equal(current.status, 'complete-with-skips');
  assert.match(reinstallPlanText(result),
    /Singularity Flow product activation — PARTIAL BY REQUEST/u);
  assert.ok(reinstallPlanText(result).endsWith(
    'Singularity Flow product activation — PARTIAL BY REQUEST'
  ));
  assert.match(reinstallPlanText(result), /Installed CLI build:/u);
  assert.match(reinstallPlanText(result), /Installation receipt:/u);
});

test('clean reinstall shares the normal installer activation lease before any product mutation', async () => {
  const context = await fixture();
  const plan = await preview(context, commandHarness());
  const installations = path.join(context.home, '.singularity-flow', 'installations');
  const journal = path.join(installations, 'activation-current.json');
  const currentFile = path.join(installations, 'current.json');
  const sentinel = '{"sentinel":true}\n';
  await mkdir(installations, { recursive: true });
  await writeFile(currentFile, sentinel);
  const competing = await acquireActivationLease({
    journal,
    checkout: context.checkout,
    mode: 'create'
  });
  const applyHarness = commandHarness();
  try {
    await assert.rejects(applyLocalReinstall(plan, {
      confirmation: plan.confirmation,
      homeDirectory: context.home,
      ...applyHarness
    }), /another installer operation/u);
  } finally {
    await releaseActivationLease({ journal, ...competing });
  }
  assert.equal(applyHarness.calls.length, 0, 'lease contention is refused before external commands');
  assert.equal(await readFile(currentFile, 'utf8'), sentinel);
});

test('all validation and packaging finishes before removal and failures print a retryable recovery command', async () => {
  const context = await fixture();
  const events = [];
  const harness = commandHarness({ installed: true, homeDirectory: context.home });
  const plan = await preview(context, harness, {
    build: async (options) => {
      events.push('bundle-validated');
      return fakeBuild(options);
    }
  });
  const execute = (command, args, options = {}) => {
    events.push(`${command}:${args.join(' ')}`);
    if (command === 'npm' && args[0] === 'install' && args[1] === '--global') {
      return { status: 1, stdout: '', stderr: 'simulated registry outage' };
    }
    return harness.execute(command, args, options);
  };
  await assert.rejects(applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    homeDirectory: context.home,
    execute,
    exists: harness.exists
  }), (error) => {
    assert.match(error.message, /simulated registry outage/);
    assert.ok(error.message.includes(renderPlatformCommand([
      'sf-reinstall', '--checkout', plan.checkout, '--confirm', plan.confirmation
    ])));
    assert.match(error.message, new RegExp(plan.fingerprint));
    return true;
  });
  assert.equal(events[0], 'bundle-validated');
  assert.equal(events.some((event) => event.startsWith('npm:uninstall --global')), false,
    'npm install must replace the package without first removing the working CLI');
  assert.ok(events.findIndex((event) => event.startsWith('npm:install --global')) > 0);
  assert.equal(events.some((event) => event.startsWith('git:')), false);
});

test('registry validation rejects credentials and reinstall source contains no Git execution or broad home deletion', async () => {
  assert.throws(() => normalizeReinstallRegistry('https://user:token@example.test/npm/'), /credentials/);
  assert.throws(() => normalizeReinstallRegistry('file:///tmp/registry'), /http/);
  const source = await readFile(new URL('../src/reinstall.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /execute(?:OrThrow)?\([^\n]*['"]git['"]/);
  assert.doesNotMatch(source, /run\([^\n]*['"]git['"]/);
  assert.doesNotMatch(source, /rm(?:Sync)?\([^\n]*(?:homedir|homeDirectory)/);
  assert.doesNotMatch(source, /readdir(?:Sync)?\([^\n]*(?:homedir|homeDirectory)/);
  assert.match(source, /NPM_CONFIG_CACHE: npmCache/);
  assert.match(source, /'npm', \['run', 'test:reinstall'\]/);
  assert.doesNotMatch(source, /'npm', \['test'\]/);
  assert.doesNotMatch(source, /'npm', \['run', 'check'\]/);
});

import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyLocalReinstall, distributionInstallPlanText, prepareDistributionInstall,
  recoverPendingDistributionInstall, resolveDistributionInstallPlan
} from '../src/reinstall.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { renderPlatformCommand } from '../src/safe-command-guidance.mjs';
import { distributionFixture, fileSha256 } from './helpers/distribution-artifacts.mjs';

function harness(version, {
  badInstalledVersion = false,
  badInstalledBuild = false,
  beforeVersion = null,
  initialInstalled = false,
  pluginIdentity = null,
  fullSurfaces = false,
  badRestoredBuild = false,
  badRestoredPlugin = false,
  tamperRestoredPackagedSkill = false,
  tamperRestoredSkill = false
} = {}) {
  const calls = [];
  const build = `${version} (distribution-fixture-build-01234567)`;
  let installed = initialInstalled;
  let plugin = pluginIdentity;
  let installedPluginRoot = null;
  let vscodeVersion = null;
  let globalInstallCount = 0;
  let pluginInstallCount = 0;
  const exists = (command) => ['node', 'npm', ...(fullSurfaces ? ['copilot', 'code'] : [])]
    .includes(command);
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const execute = (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === 'npm' && args.join(' ') === 'config get registry') return ok('https://registry.npmjs.org/\n');
    if (command === 'npm' && args[0] === 'list') {
      return ok(installed ? JSON.stringify({ dependencies: { 'singularity-flow': { version } } }) : '{}');
    }
    if (command === 'npm' && args[0] === 'install' && args[1] === '--prefix') {
      const packageRoot = path.join(args[2], 'node_modules', 'singularity-flow');
      mkdirSync(path.join(packageRoot, 'plugin'), { recursive: true });
      mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
      writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({
        name: 'singularity-flow', version
      })}\n`);
      writeFileSync(path.join(packageRoot, 'plugin', 'plugin.json'), `${JSON.stringify({
        name: 'singularity-flow', version
      })}\n`);
      writeFileSync(path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
        `if (process.argv[2] === '--build') console.log(${JSON.stringify(build)});\n`);
      const skill = path.join(packageRoot, 'plugin', 'skills', 'sflow-help');
      mkdirSync(skill, { recursive: true });
      writeFileSync(path.join(skill, 'SKILL.md'), [
        '---', 'name: sflow-help', 'description: Help', '---', '# Help', ''
      ].join('\n'));
      return ok();
    }
    if (command === 'npm' && args[0] === 'install') {
      if (args[1] === '--global') globalInstallCount += 1;
      installed = true;
      return ok();
    }
    if (command === 'npm' && args[0] === 'uninstall') { installed = false; return ok(); }
    if (command === 'copilot' && args.join(' ') === 'plugin list') {
      return ok(plugin ? `${plugin}\n` : '');
    }
    if (command === 'copilot' && args.join(' ') === 'plugin list --json') {
      if (!plugin) return ok('[]');
      const [name, marketplace = ''] = plugin.split('@');
      return ok(JSON.stringify([{
        name, marketplace, version,
        enabled: !(badRestoredPlugin && pluginInstallCount >= 2), source: 'installed'
      }]));
    }
    if (command === 'copilot' && args.join(' ') === 'skill list --json') {
      const skillsRoot = options.env?.SINGULARITY_FLOW_COPILOT_SKILLS_DIR
        ?? path.join(options.env?.HOME ?? os.homedir(), '.copilot', 'skills');
      return ok(JSON.stringify([
        {
          name: 'sf-help', description: 'Help', source: 'personal-copilot',
          path: path.join(skillsRoot, 'sf-help'), enabled: true
        },
        {
          name: 'sflow-help', description: 'Help', source: 'plugin',
          path: path.join(installedPluginRoot, 'skills', 'sflow-help'), enabled: true
        }
      ]));
    }
    if (command === 'copilot' && args[0] === 'plugins' && args[1] === 'list'
        && args[2] === '--kind' && args[4] === '--scope' && args[6] === '--json') {
      const kind = args[3];
      const scope = args[5];
      let plugins = [];
      if (kind === 'plugin' && scope === 'user' && plugin) {
        plugins = [{ kind, scope, name: 'singularity-flow', enabled: true }];
      } else if (kind === 'skill' && scope === 'user' && plugin) {
        plugins = [{ kind, scope, name: 'sf-help', enabled: true }];
      } else if (kind === 'skill' && scope === 'plugin' && plugin) {
        plugins = [{ kind, scope, name: 'sflow-help', enabled: true }];
      }
      return ok(`${JSON.stringify({ plugins, errors: [] })}\n`);
    }
    if (command === 'copilot' && args[0] === 'plugin' && args[1] === 'uninstall') {
      if (plugin === args[2]) plugin = null;
      return ok();
    }
    if (command === 'copilot' && args[0] === 'plugin' && args[1] === 'install') {
      pluginInstallCount += 1;
      plugin = 'singularity-flow';
      installedPluginRoot = path.join(
        options.env?.HOME ?? os.homedir(), '.copilot', 'plugin-cache', 'singularity-flow'
      );
      rmSync(installedPluginRoot, { recursive: true, force: true });
      cpSync(args[2], installedPluginRoot, { recursive: true });
      if (tamperRestoredPackagedSkill && pluginInstallCount >= 2) {
        appendFileSync(
          path.join(installedPluginRoot, 'skills', 'sflow-help', 'SKILL.md'),
          '\ntampered after plugin restore\n'
        );
      }
      return ok();
    }
    if (command === 'code' && args.join(' ') === '--list-extensions --show-versions') {
      return ok(vscodeVersion ? `singularityflow.singularity-flow-vscode@${vscodeVersion}\n` : '');
    }
    if (command === 'code' && args[0] === '--install-extension') {
      vscodeVersion = version;
      return ok();
    }
    if (command === 'code' && args[0] === '--uninstall-extension') {
      vscodeVersion = null;
      if (tamperRestoredSkill) {
        const skillsRoot = options.env?.SINGULARITY_FLOW_COPILOT_SKILLS_DIR
          ?? path.join(options.env?.HOME ?? os.homedir(), '.copilot', 'skills');
        appendFileSync(path.join(skillsRoot, 'sf-help', 'SKILL.md'), '\ntampered after restore\n');
      }
      return ok();
    }
    if (command === 'singularity-flow' && args.join(' ') === '--version') {
      beforeVersion?.();
      return ok(`${badInstalledVersion ? '0.0.0-bad' : version}\n`);
    }
    if (command === process.execPath && args.at(-1) === '--build') return ok(`${build}\n`);
    if (command === 'singularity-flow' && args.join(' ') === '--build') {
      const restoredMismatch = badRestoredBuild && globalInstallCount >= 2;
      return ok(`${badInstalledBuild || restoredMismatch
        ? `${version} (stale-distribution-build-89abcdef)` : build}\n`);
    }
    if (command === 'singularity-flow' && args.join(' ') === 'plugin verify --json') {
      return ok('{"status":"verified"}\n');
    }
    return ok();
  };
  return { calls, execute, exists };
}

async function seedRetainedTarball(item) {
  const source = path.join(item.release.directory, item.release.tarballName);
  const bytes = await readFile(source);
  const digest = fileSha256(bytes);
  const installations = path.join(item.home, '.singularity-flow', 'installations');
  const target = path.join(
    installations, 'versions', 'sha256', digest, 'singularity-flow.tgz'
  );
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target);
  await writeFile(path.join(installations, 'current.json'), `${JSON.stringify({
    schemaVersion: 2,
    artifacts: { tarball: { path: target, sha256: `sha256:${digest}` } }
  }, null, 2)}\n`, { mode: 0o600 });
  return target;
}

async function seedManagedDirectSkill(home) {
  const directory = path.join(home, '.copilot', 'skills', 'sf-help');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'SKILL.md'), [
    '---', 'name: sf-help', 'description: Help', '---',
    '<!-- managed-by: singularity-flow direct-skill-alias -->', '# Help', ''
  ].join('\n'));
  return directory;
}

async function fixture(t) {
  const release = await distributionFixture();
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-distribution-install-home-'));
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sflow-distribution-install-plan-'));
  t.after(() => Promise.all([
    rm(release.directory, { recursive: true, force: true }),
    rm(release.keyDirectory, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
    rm(temp, { recursive: true, force: true })
  ]));
  return { release, home, temp };
}

test('distribution preview validates exact artifacts without Git or product mutation', async (t) => {
  const item = await fixture(t);
  const commands = harness(item.release.version);
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home },
    tempRoot: item.temp
  });
  assert.equal(plan.operation, 'distribution-product-install');
  assert.match(plan.confirmation, /^INSTALL SINGULARITY FLOW [a-f0-9]{16}$/u);
  assert.match(distributionInstallPlanText(plan), /No Git command was run/u);
  assert.match(distributionInstallPlanText(plan), /staged only; product activation has not started/u);
  assert.equal(commands.calls.some(([command, verb, scope]) => (
    command === 'npm' && verb === 'install' && scope === '--global'
  )), false, 'preview may stage a private candidate but cannot replace the global CLI');
  assert.ok(commands.calls.some(([command, verb, scope]) => (
    command === 'npm' && verb === 'install' && scope === '--prefix'
  )), 'preview stages the exact signed candidate so build identity is known before mutation');
  assert.equal(commands.calls.some(([command]) => command === 'git'), false);
});

test('distribution preview shell command preserves hostile paths as literal argv', async (t) => {
  const item = await fixture(t);
  const commands = harness(item.release.version);
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home },
    tempRoot: item.temp
  });
  const entrypoint = "/tmp/SFlow Installer $(printf INJECTED) `printf BACKTICK` O'Brien";
  const artifactKeyPath = "/tmp/key $(printf KEY) O'Brien.pem";
  const hostile = {
    ...plan,
    distribution: { ...plan.distribution, entrypoint, artifactKeyPath }
  };
  const expected = renderPlatformCommand([
    entrypoint, '--artifact-key', artifactKeyPath, '--confirm', plan.confirmation, '--cli-only'
  ]);
  const rendered = distributionInstallPlanText(hostile);
  assert.ok(rendered.includes(`Shell: ${expected}`));
  assert.doesNotMatch(rendered, /Shell: .*"\$\(/u);
});

test('distribution preview binds every installed CLI to its retained exact build', async (t) => {
  const item = await fixture(t);
  await seedRetainedTarball(item);
  const commands = harness(item.release.version, { initialInstalled: true });
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home },
    tempRoot: item.temp
  });
  assert.equal(plan.distribution.rollback.cliBuild,
    `${item.release.version} (distribution-fixture-build-01234567)`);
  assert.match(plan.distribution.rollback.packageSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(plan.distribution.rollback.package.endsWith(
    path.join('rollback-package', 'node_modules', 'singularity-flow')
  ));
  const liveBuild = commands.calls.findIndex(([command, ...args]) => (
    command === 'singularity-flow' && args.join(' ') === '--build'
  ));
  const firstGlobalMutation = commands.calls.findIndex(([command, verb, scope]) => (
    command === 'npm' && verb === 'install' && scope === '--global'
  ));
  assert.ok(liveBuild >= 0);
  assert.equal(firstGlobalMutation, -1, 'preview cannot mutate the global CLI');
});

test('distribution preview refuses retained CLI bytes that do not reproduce the live build', async (t) => {
  const item = await fixture(t);
  await seedRetainedTarball(item);
  const commands = harness(item.release.version, {
    initialInstalled: true, badInstalledBuild: true
  });
  await assert.rejects(() => prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home },
    tempRoot: item.temp
  }), /retained CLI rollback package reports build .* currently installed CLI reports/u);
  assert.equal(commands.calls.some(([command, verb, scope]) => (
    command === 'npm' && verb === 'install' && scope === '--global'
  )), false);
});

test('distribution applies the admitted tarball and records retained exact bytes', async (t) => {
  const item = await fixture(t);
  const commands = harness(item.release.version);
  const options = {
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home },
    tempRoot: item.temp
  };
  const plan = await prepareDistributionInstall(options);
  const completed = await applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: options.environment
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.verified.cliBuild,
    `${item.release.version} (distribution-fixture-build-01234567)`);
  assert.match(distributionInstallPlanText(completed),
    /Singularity Flow product activation — PARTIAL BY REQUEST/u);
  assert.ok(distributionInstallPlanText(completed).endsWith(
    'Singularity Flow product activation — PARTIAL BY REQUEST'
  ));
  assert.match(distributionInstallPlanText(completed), /Installed CLI build:/u);
  assert.match(distributionInstallPlanText(completed), /Installation receipt:/u);
  const install = commands.calls.find(([command, verb, scope]) => (
    command === 'npm' && verb === 'install' && scope === '--global'
  ));
  assert.equal(path.resolve(install[3]), path.resolve(plan.bundle.tarball));
  assert.equal(commands.calls.some(([command]) => command === 'git'), false);
  const current = JSON.parse(await readFile(
    path.join(item.home, '.singularity-flow', 'installations', 'current.json'), 'utf8'
  ));
  assert.equal(current.version, item.release.version);
  assert.deepEqual(current.build, {
    cli: `${item.release.version} (distribution-fixture-build-01234567)`
  });
  assert.match(current.artifacts.tarball.path, /versions[/\\]sha256[/\\][a-f0-9]{64}[/\\]singularity-flow\.tgz$/u);
});

test('distribution install refuses same-version stale CLI build provenance', async (t) => {
  const item = await fixture(t);
  const commands = harness(item.release.version, { badInstalledBuild: true });
  const environment = { ...process.env, HOME: item.home };
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    tempRoot: item.temp
  });
  await assert.rejects(() => applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment
  }), (error) => {
    assert.match(error.message,
      /Installed CLI build .* does not match the admitted candidate build/u);
    assert.match(error.message, /Every touched product surface was restored and verified/u);
    return true;
  });
  assert.ok(commands.calls.some(([command, ...args]) => command === 'singularity-flow'
    && args.join(' ') === '--version'));
  assert.ok(commands.calls.some(([command, ...args]) => command === 'singularity-flow'
    && args.join(' ') === '--build'));
  await assert.rejects(() => readFile(path.join(
    item.home, '.singularity-flow', 'installations', 'current.json'
  )), /ENOENT/u);
});

test('late distribution failure restores every touched surface and clears its transaction', async (t) => {
  const item = await fixture(t);
  const commands = harness(item.release.version, { badInstalledVersion: true });
  const options = {
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home, SHELL: '/bin/zsh' },
    tempRoot: item.temp
  };
  const plan = await prepareDistributionInstall(options);
  await assert.rejects(() => applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: options.environment
  }), /Every touched product surface was restored and verified/u);
  assert.ok(commands.calls.some(([command, verb]) => command === 'npm' && verb === 'install'));
  assert.ok(commands.calls.some(([command, verb]) => command === 'npm' && verb === 'uninstall'));
  await assert.rejects(() => readFile(path.join(
    item.home, '.singularity-flow', 'installations', 'distribution-install-pending.json'
  )), /ENOENT/u);
  await assert.rejects(() => readFile(path.join(
    item.home, '.singularity-flow', 'installations', 'current.json'
  )), /ENOENT/u);
});

test('distribution rollback refuses to claim restoration when the exact CLI build differs', async (t) => {
  const item = await fixture(t);
  await seedRetainedTarball(item);
  const commands = harness(item.release.version, {
    initialInstalled: true,
    badInstalledVersion: true,
    badRestoredBuild: true
  });
  const environment = { ...process.env, HOME: item.home };
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    tempRoot: item.temp
  });
  await assert.rejects(() => applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment
  }), (error) => {
    assert.match(error.message, /restored build .* does not match/u);
    assert.doesNotMatch(error.message, /Every touched product surface was restored and verified/u);
    return true;
  });
  const pending = JSON.parse(await readFile(path.join(
    item.home, '.singularity-flow', 'installations', 'distribution-install-pending.json'
  ), 'utf8'));
  assert.equal(pending.status, 'rollback-failed');
});

test('distribution rollback verifies restored Copilot enabled inventory', async (t) => {
  const item = await fixture(t);
  await seedRetainedTarball(item);
  const commands = harness(item.release.version, {
    initialInstalled: true,
    pluginIdentity: 'singularity-flow',
    fullSurfaces: true,
    badInstalledVersion: true,
    badRestoredPlugin: true
  });
  const environment = { ...process.env, HOME: item.home };
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: false,
    telemetry: false,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    tempRoot: item.temp
  });
  await assert.rejects(() => applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment
  }), (error) => {
    assert.match(error.message, /Copilot structured plugin verification failed/u);
    assert.doesNotMatch(error.message, /Every touched product surface was restored and verified/u);
    return true;
  });
  assert.ok(commands.calls.some(([command, ...args]) => (
    command === 'copilot' && args.join(' ') === 'plugin list --json'
  )));
  const pending = JSON.parse(await readFile(path.join(
    item.home, '.singularity-flow', 'installations', 'distribution-install-pending.json'
  ), 'utf8'));
  assert.equal(pending.status, 'rollback-failed');
});

test('distribution rollback verifies restored Copilot packaged skill content', async (t) => {
  const item = await fixture(t);
  await Promise.all([seedRetainedTarball(item), seedManagedDirectSkill(item.home)]);
  const commands = harness(item.release.version, {
    initialInstalled: true,
    pluginIdentity: 'singularity-flow',
    fullSurfaces: true,
    badInstalledVersion: true,
    tamperRestoredPackagedSkill: true
  });
  const environment = { ...process.env, HOME: item.home };
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: false,
    telemetry: false,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    tempRoot: item.temp
  });
  await assert.rejects(() => applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment
  }), (error) => {
    assert.match(error.message, /packaged Copilot skill content .*stale: sflow-help/u);
    assert.doesNotMatch(error.message, /Every touched product surface was restored and verified/u);
    return true;
  });
  assert.ok(commands.calls.some(([command, ...args]) => (
    command === 'copilot' && args.join(' ') === 'skill list --json'
  )));
  const pending = JSON.parse(await readFile(path.join(
    item.home, '.singularity-flow', 'installations', 'distribution-install-pending.json'
  ), 'utf8'));
  assert.equal(pending.status, 'rollback-failed');
});

test('distribution rollback verifies final restored direct-skill bytes', async (t) => {
  const item = await fixture(t);
  await Promise.all([seedRetainedTarball(item), seedManagedDirectSkill(item.home)]);
  const commands = harness(item.release.version, {
    initialInstalled: true,
    fullSurfaces: true,
    badInstalledVersion: true,
    tamperRestoredSkill: true
  });
  const environment = { ...process.env, HOME: item.home };
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: false,
    telemetry: false,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    tempRoot: item.temp
  });
  assert.deepEqual(plan.installed.managedDirectSkills, ['sf-help']);
  await assert.rejects(() => applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment
  }), (error) => {
    assert.match(error.message, /restored bytes do not match for sf-help/u);
    assert.doesNotMatch(error.message, /Every touched product surface was restored and verified/u);
    return true;
  });
  const pending = JSON.parse(await readFile(path.join(
    item.home, '.singularity-flow', 'installations', 'distribution-install-pending.json'
  ), 'utf8'));
  assert.equal(pending.status, 'rollback-failed');
});

test('late receipt failure removes the false completed reinstall audit', async (t) => {
  const item = await fixture(t);
  const versions = path.join(item.home, '.singularity-flow', 'installations', 'versions');
  const commands = harness(item.release.version, {
    beforeVersion: () => writeFileSync(versions, 'unsafe collision\n')
  });
  const environment = { ...process.env, HOME: item.home };
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    tempRoot: item.temp
  });
  await assert.rejects(() => applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment
  }), /Every touched product surface was restored and verified/u);
  const installations = path.join(item.home, '.singularity-flow', 'installations');
  const receipts = (await readdir(installations))
    .filter((name) => name.startsWith('reinstall-') && name.endsWith(`-${plan.fingerprint}.json`));
  assert.deepEqual(receipts, []);
});

test('distribution apply refuses a cached plan whose operative installed path was altered', async (t) => {
  const item = await fixture(t);
  const commands = harness(item.release.version);
  const options = {
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home },
    tempRoot: item.temp
  };
  const plan = await prepareDistributionInstall(options);
  const forged = structuredClone(plan);
  forged.installed.skillsRoot = path.join(item.home, 'attacker-selected-skills');
  await assert.rejects(() => applyLocalReinstall(forged, {
    confirmation: forged.confirmation,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: options.environment
  }), /does not match its fingerprint|Installed product state changed after preview/u);
  assert.equal(commands.calls.some(([command, verb, scope]) => (
    command === 'npm' && verb === 'install' && scope === '--global'
  )), false);
});

test('distribution binds retained Copilot rollback package bytes before product mutation', async (t) => {
  const item = await fixture(t);
  await seedRetainedTarball(item);
  const commands = harness(item.release.version, {
    initialInstalled: true, pluginIdentity: 'singularity-flow', fullSurfaces: true
  });
  const options = {
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: false,
    telemetry: false,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home },
    tempRoot: item.temp
  };
  const plan = await prepareDistributionInstall(options);
  assert.match(plan.distribution.rollback.packageSha256, /^sha256:[a-f0-9]{64}$/u);
  await writeFile(
    path.join(plan.distribution.rollback.package, 'plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'singularity-flow', version: 'tampered' })}\n`
  );
  const mutationsBeforeApply = commands.calls.filter(([command, verb, option]) => (
    (command === 'npm' && verb === 'install' && option === '--global')
    || command === 'copilot' || command === 'code'
  )).length;
  await assert.rejects(() => applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: options.environment
  }), /rollback package changed after distribution preview/u);
  const mutationsAfterApply = commands.calls.filter(([command, verb, option]) => (
    (command === 'npm' && verb === 'install' && option === '--global')
    || command === 'copilot' || command === 'code'
  )).length;
  assert.equal(mutationsAfterApply, mutationsBeforeApply);
});

test('distribution refuses a prior Copilot identity that cannot be reproduced exactly', async (t) => {
  const item = await fixture(t);
  await seedRetainedTarball(item);
  const commands = harness(item.release.version, {
    initialInstalled: true,
    pluginIdentity: 'singularity-flow@singularity-flow',
    fullSurfaces: true
  });
  await assert.rejects(() => prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: false,
    telemetry: false,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home },
    tempRoot: item.temp
  }), /cannot reproduce the exact currently installed Copilot plugin identities/u);
  assert.equal(commands.calls.some(([command, verb, option]) => (
    command === 'npm' && verb === 'install' && option === '--global'
  )), false);
});

test('distribution telemetry opt-out removes every managed profile activation', async (t) => {
  const item = await fixture(t);
  const activation = [
    '# user setting',
    '# Singularity Flow: Copilot model/token/cost telemetry',
    '[ -r "$HOME/.singularity-flow/copilot-otel.sh" ] && . "$HOME/.singularity-flow/copilot-otel.sh"',
    ''
  ].join('\n');
  const zsh = path.join(item.home, '.zshrc');
  const bash = path.join(item.home, '.bashrc');
  await Promise.all([writeFile(zsh, activation), writeFile(bash, activation)]);
  const commands = harness(item.release.version, { fullSurfaces: true });
  const environment = { ...process.env, HOME: item.home, SHELL: '/bin/zsh' };
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: false,
    telemetry: false,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    tempRoot: item.temp
  });
  const completed = await applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment
  });
  assert.equal(completed.completed, true);
  assert.ok(distributionInstallPlanText(completed).endsWith(
    'Singularity Flow product activation — PARTIAL BY REQUEST'
  ), 'an explicit telemetry omission must not claim complete all-surface activation');
  for (const profile of [zsh, bash]) {
    const contents = await readFile(profile, 'utf8');
    assert.doesNotMatch(contents, /Singularity Flow: Copilot model\/token\/cost telemetry/u);
    assert.doesNotMatch(contents, /sflow_copilot/u);
    assert.match(contents, /# user setting/u);
  }
});

test('distribution telemetry update preserves an edit arriving after profile discovery', async (t) => {
  const item = await fixture(t);
  const profile = path.join(item.home, '.zshrc');
  await writeFile(profile, '# user setting\n');
  const commands = harness(item.release.version, { fullSurfaces: true });
  const environment = { ...process.env, HOME: item.home, SHELL: '/bin/zsh' };
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: false,
    telemetry: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    tempRoot: item.temp
  });
  let edited = false;
  const completed = await applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    beforeTelemetryProfileMutation: async ({ candidate }) => {
      if (!edited && path.resolve(candidate) === path.resolve(profile)) {
        edited = true;
        appendFileSync(profile, '# concurrent editor setting\n');
      }
    }
  });
  assert.equal(completed.completed, true);
  const installed = await readFile(profile, 'utf8');
  assert.match(installed, /# user setting/u);
  assert.match(installed, /# concurrent editor setting/u);
  assert.match(installed, /Singularity Flow: Copilot model\/token\/cost telemetry/u);
});

test('distribution rollback preserves concurrent shell-profile edits', async (t) => {
  const item = await fixture(t);
  const profile = path.join(item.home, '.zshrc');
  await writeFile(profile, '# user setting\n');
  const commands = harness(item.release.version, {
    badInstalledVersion: true,
    fullSurfaces: true,
    beforeVersion: () => appendFileSync(profile, '# concurrent editor setting\n')
  });
  const environment = { ...process.env, HOME: item.home, SHELL: '/bin/zsh' };
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: false,
    telemetry: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    tempRoot: item.temp
  });
  await assert.rejects(() => applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment
  }), /Every touched product surface was restored and verified/u);
  const restored = await readFile(profile, 'utf8');
  assert.match(restored, /# user setting/u);
  assert.match(restored, /# concurrent editor setting/u);
  assert.doesNotMatch(restored, /Singularity Flow: Copilot model\/token\/cost telemetry/u);
  assert.doesNotMatch(restored, /sflow_copilot/u);
});

test('repeated distribution previews reuse one immutable fingerprinted plan', async (t) => {
  const item = await fixture(t);
  const commands = harness(item.release.version);
  const options = {
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home },
    tempRoot: item.temp
  };
  const first = await prepareDistributionInstall(options);
  const second = await prepareDistributionInstall(options);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.bundle.tarball, first.bundle.tarball);
  assert.equal(second.confirmation, first.confirmation);
});

test('bootstrapped install reads private inputs while retaining stable origin provenance', async (t) => {
  const item = await fixture(t);
  const commands = harness(item.release.version);
  const originRelease = path.join(item.temp, 'removed-origin-release');
  const originKey = path.join(item.temp, 'removed-origin-key.pem');
  const environment = {
    ...process.env,
    HOME: item.home,
    SINGULARITY_FLOW_DISTRIBUTION_BOOTSTRAPPED: '1',
    SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_RELEASE_DIR: originRelease,
    SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_ARTIFACT_KEY: originKey
  };
  const options = {
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    telemetry: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    tempRoot: item.temp
  };
  const plan = await prepareDistributionInstall(options);
  assert.equal(plan.checkout, originRelease);
  assert.equal(plan.distribution.artifactKeyPath, originKey);
  const resolved = await resolveDistributionInstallPlan({
    ...options, confirmation: plan.confirmation
  });
  assert.equal(resolved.fingerprint, plan.fingerprint);
  assert.equal(resolved.bundle.tarball, plan.bundle.tarball);
});

test('durable distribution recovery does not depend on the temporary preview cache', async (t) => {
  const item = await fixture(t);
  const commands = harness(item.release.version);
  const environment = { ...process.env, HOME: item.home };
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    tempRoot: item.temp
  });
  await rm(plan.bundle.stagingParent, { recursive: true, force: true });
  const installations = path.join(item.home, '.singularity-flow', 'installations');
  const transactions = path.join(installations, 'distribution-install-transactions');
  const root = path.join(transactions, `${plan.fingerprint}-interrupted`);
  await mkdir(path.join(root, 'rollback-authority'), { recursive: true, mode: 0o700 });
  const profileTarget = path.join(item.temp, 'original-zdotdir', '.zshrc');
  const profileSnapshot = path.join(root, 'profile-1');
  const profileOriginal = '# original profile\n';
  await mkdir(path.dirname(profileTarget), { recursive: true });
  await writeFile(profileTarget, [
    '# original profile',
    '',
    '# Singularity Flow: Copilot model/token/cost telemetry',
    '[ -r "$HOME/.singularity-flow/copilot-otel.sh" ] && . "$HOME/.singularity-flow/copilot-otel.sh"',
    ''
  ].join('\n'));
  await writeFile(profileSnapshot, profileOriginal, { mode: 0o600 });
  const pending = path.join(installations, 'distribution-install-pending.json');
  await writeFile(pending, `${JSON.stringify({
    schemaVersion: currentSchemaVersion('distribution-install-transaction'),
    operation: 'distribution-product-install',
    fingerprint: plan.fingerprint,
    status: 'applying',
    createdAt: new Date().toISOString(),
    root,
    installed: plan.installed,
    rollback: {
      tarball: null, tarballSha256: null, vsix: null, vsixSha256: null, package: null
    },
    registry: plan.registry,
    skillsRoot: plan.installed.skillsRoot,
    skillSnapshots: [],
    files: [{
      target: profileTarget,
      present: true,
      snapshot: profileSnapshot,
      mode: 0o600,
      sha256: `sha256:${fileSha256(Buffer.from(profileOriginal))}`
    }],
    telemetryProfileTargets: [profileTarget],
    receiptBaseline: [],
    surfaces: {
      vscode: 'untouched', copilot: 'untouched', skills: 'untouched',
      telemetry: 'applied', cli: 'applied', receipt: 'untouched'
    }
  }, null, 2)}\n`, { mode: 0o600 });

  const recovered = await recoverPendingDistributionInstall({
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...environment, SHELL: '/bin/bash' }
  });
  assert.deepEqual(recovered, {
    recovered: true, status: 'rolled-back', fingerprint: plan.fingerprint
  });
  assert.ok(commands.calls.some(([command, verb]) => command === 'npm' && verb === 'uninstall'));
  await assert.rejects(() => readFile(pending), /ENOENT/u);
  await assert.rejects(() => readFile(root), /ENOENT/u);
  assert.equal(await readFile(profileTarget, 'utf8'), profileOriginal);
  const rebuilt = await resolveDistributionInstallPlan({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    confirmation: plan.confirmation,
    cliOnly: true,
    telemetry: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    tempRoot: item.temp
  });
  assert.equal(rebuilt.confirmation, plan.confirmation);
  assert.equal(rebuilt.fingerprint, plan.fingerprint);
});

test('durable distribution recovery refuses changed direct-skill rollback bytes', async (t) => {
  const item = await fixture(t);
  const commands = harness(item.release.version);
  const environment = { ...process.env, HOME: item.home };
  const plan = await prepareDistributionInstall({
    releaseDirectory: item.release.directory,
    artifactKey: item.release.publicKeyPath,
    cliOnly: true,
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment,
    tempRoot: item.temp
  });
  const installations = path.join(item.home, '.singularity-flow', 'installations');
  const root = path.join(
    installations, 'distribution-install-transactions', `${plan.fingerprint}-skill-tamper`
  );
  const skillSnapshot = path.join(root, 'skills', 'sf-help');
  await mkdir(skillSnapshot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(skillSnapshot, 'SKILL.md'), [
    '---', 'name: sf-help', '---',
    '<!-- managed-by: singularity-flow direct-skill-alias -->', 'tampered', ''
  ].join('\n'));
  const pending = path.join(installations, 'distribution-install-pending.json');
  await writeFile(pending, `${JSON.stringify({
    schemaVersion: currentSchemaVersion('distribution-install-transaction'),
    operation: 'distribution-product-install',
    fingerprint: plan.fingerprint,
    status: 'applying',
    createdAt: new Date().toISOString(),
    root,
    installed: { ...plan.installed, managedDirectSkills: ['sf-help'] },
    rollback: {
      tarball: null, tarballSha256: null, vsix: null, vsixSha256: null,
      package: null, packageSha256: null
    },
    registry: plan.registry,
    skillsRoot: plan.installed.skillsRoot,
    skillSnapshots: [{
      name: 'sf-help', snapshot: skillSnapshot, sha256: `sha256:${'0'.repeat(64)}`
    }],
    files: [],
    telemetryProfileTargets: [],
    receiptBaseline: [],
    surfaces: {
      vscode: 'untouched', copilot: 'untouched', skills: 'applied',
      telemetry: 'untouched', cli: 'untouched', receipt: 'untouched'
    }
  }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(() => recoverPendingDistributionInstall({
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment
  }), /retained direct-skill rollback bytes changed for sf-help/u);
  const retained = JSON.parse(await readFile(pending, 'utf8'));
  assert.equal(retained.status, 'rollback-failed');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyLocalReinstall,
  assertReinstallNodeVersion,
  normalizeReinstallRegistry,
  prepareLocalReinstall,
  reinstallPlanText,
  resolveReinstallPlan
} from '../src/reinstall.mjs';

const VERSION = '9.8.7';
const MANAGED = '<!-- managed-by: singularity-flow direct-skill-alias -->';

test('reinstall requires a valid Node 20 or newer runtime', () => {
  assert.deepEqual(assertReinstallNodeVersion('v20.0.0'), { version: '20.0.0', major: 20 });
  assert.deepEqual(assertReinstallNodeVersion('22.14.0'), { version: '22.14.0', major: 22 });
  assert.throws(() => assertReinstallNodeVersion('v18.20.8'), /Node\.js 20 or newer is required/);
  assert.throws(() => assertReinstallNodeVersion('unknown'), /Could not determine/);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-reinstall-test-'));
  const checkout = path.join(root, 'checkout');
  const home = path.join(root, 'home');
  const temp = path.join(root, 'tmp');
  await mkdir(path.join(checkout, 'plugin', 'skills', 'sflow-test'), { recursive: true });
  await mkdir(path.join(checkout, 'apps', 'vscode'), { recursive: true });
  await mkdir(path.join(checkout, 'singularity'), { recursive: true });
  await mkdir(path.join(checkout, '.singularity'), { recursive: true });
  await mkdir(path.join(checkout, '.git', 'singularity-flow'), { recursive: true });
  await mkdir(path.join(home, '.singularity-flow'), { recursive: true });
  await mkdir(temp, { recursive: true });
  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({ name: 'singularity-flow', version: VERSION }));
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

function commandHarness({ installed = false, code = true, copilot = true, npmRoot = '' } = {}) {
  const calls = [];
  const exists = (command) => command === 'node' || command === 'npm'
    || (command === 'code' && code) || (command === 'copilot' && copilot);
  const execute = (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    const words = args.join(' ');
    if (command === 'npm' && words === 'config get registry') return ok('https://registry.npmjs.org/\n');
    if (command === 'npm' && words === 'root --global') return ok(`${npmRoot}\n`);
    if (command === 'npm' && args[0] === 'list') return ok(installed
      ? JSON.stringify({ dependencies: { 'singularity-flow': { version: VERSION } } })
      : '{}');
    if (command === 'copilot' && words === 'plugin list') return ok(installed
      ? 'singularity-flow\nsingularity-flow@singularity-flow\n'
      : '');
    if (command === 'code' && args[0] === '--list-extensions') return ok(installed
      ? `singularityflow.singularity-flow-vscode@${VERSION}\n`
      : '');
    if (command === 'singularity-flow' && words === '--version') return ok(`${VERSION}\n`);
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
  assert.equal(harness.calls.some((call) => call.command === 'git'), false);
  assert.equal(harness.calls.some((call) => ['install', 'uninstall'].includes(call.args[0])), false);
  assert.deepEqual(await Promise.all([
    readFile(path.join(context.checkout, 'singularity', 'workflow.yml'), 'utf8'),
    readFile(path.join(context.checkout, '.singularity', 'legacy.yml'), 'utf8'),
    readFile(path.join(context.checkout, '.git', 'singularity-flow', 'session.json'), 'utf8'),
    readFile(path.join(context.home, '.singularity-flow', 'workspaces.json'), 'utf8')
  ]), before);
});

test('reinstall refuses stale confirmation before removal and applies the exact validated transaction', async () => {
  const context = await fixture();
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
  const applyHarness = commandHarness({ installed: true, npmRoot });
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
  assert.ok(result.receipt.startsWith(path.join(context.home, '.singularity-flow', 'installations')));
  assert.equal(await readFile(path.join(skills, 'sf-personal', 'SKILL.md'), 'utf8'), '# personal\n');
  assert.match(await readFile(path.join(skills, 'sf-test', 'SKILL.md'), 'utf8'), new RegExp(MANAGED));
  await assert.rejects(readFile(path.join(skills, 'sf-old', 'SKILL.md')), /ENOENT/);
  assert.equal(await readFile(path.join(context.home, '.singularity-flow', 'workspaces.json'), 'utf8'), '{"preserve":true}\n');
  assert.equal(await readFile(path.join(context.home, '.singularity-flow', 'active-workspace.json'), 'utf8'), '{"workspace":"keep"}\n');
  assert.equal(applyHarness.calls.some((call) => call.command === 'git'), false);
  for (const identity of ['singularity-flow', 'singularity-flow@singularity-flow']) {
    assert.ok(applyHarness.calls.some((call) => call.command === 'copilot'
      && call.args.join(' ') === `plugin uninstall ${identity}`));
  }
  const npmInstall = applyHarness.calls.find((call) => call.command === 'npm' && call.args[0] === 'install');
  assert.equal(npmInstall.options.env.NPM_CONFIG_REGISTRY, plan.registry);
  assert.ok(npmInstall.args.includes(`--registry=${plan.registry}`));
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
  assert.match(cliText, new RegExp(`--registry ${JSON.stringify(cliPlan.registry)}`));
  const noCode = await preview(context, commandHarness({ code: false }));
  assert.ok(noCode.remove.some((item) => item.includes('code CLI unavailable; skipped')));
});

test('all validation and packaging finishes before removal and failures print a retryable recovery command', async () => {
  const context = await fixture();
  const events = [];
  const harness = commandHarness({ installed: true });
  const plan = await preview(context, harness, {
    build: async (options) => {
      events.push('bundle-validated');
      return fakeBuild(options);
    }
  });
  const execute = (command, args, options = {}) => {
    events.push(`${command}:${args.join(' ')}`);
    if (command === 'npm' && args[0] === 'install') return { status: 1, stdout: '', stderr: 'simulated registry outage' };
    return harness.execute(command, args, options);
  };
  await assert.rejects(applyLocalReinstall(plan, {
    confirmation: plan.confirmation,
    homeDirectory: context.home,
    execute,
    exists: harness.exists
  }), (error) => {
    assert.match(error.message, /simulated registry outage/);
    assert.match(error.message, /sf-reinstall --checkout/);
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

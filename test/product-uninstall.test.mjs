import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyProductUninstall, prepareProductUninstall, productUninstallText
} from '../src/product-uninstall.mjs';
import { renderPlatformCommand } from '../src/safe-command-guidance.mjs';

const MANAGED = '<!-- managed-by: singularity-flow direct-skill-alias -->';

function harness(faults = {}) {
  const calls = [];
  let npmVersion = '0.9.0';
  let extension = '0.9.0';
  const plugins = new Set(['singularity-flow', 'singularity-flow@singularity-flow']);
  const exists = (command) => ['npm', 'code', 'copilot', 'node'].includes(command);
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const execute = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'npm' && args[0] === 'list') {
      return ok(npmVersion ? JSON.stringify({ dependencies: { 'singularity-flow': { version: npmVersion } } }) : '{}');
    }
    if (command === 'npm' && args[0] === 'uninstall') { npmVersion = null; return ok(); }
    if (command === 'code' && args[0] === '--list-extensions') {
      if (faults.failExtensionVerification && extension === null) {
        return { status: 1, stdout: '', stderr: 'extension verification interrupted' };
      }
      return ok(extension ? `singularityflow.singularity-flow-vscode@${extension}\n` : 'unrelated.extension@1.0.0\n');
    }
    if (command === 'code' && args[0] === '--uninstall-extension') {
      if (faults.failCodeUninstall) return { status: 1, stdout: '', stderr: 'restart required' };
      extension = null;
      return ok();
    }
    if (command === 'copilot' && args.join(' ') === 'plugin list') return ok([...plugins].join('\n'));
    if (command === 'copilot' && args[0] === 'plugin' && args[1] === 'uninstall') {
      if (faults.failCopilotUninstall) {
        return { status: 1, stdout: '', stderr: 'copilot plugin manager unavailable' };
      }
      plugins.delete(args[2]);
      return ok();
    }
    return ok();
  };
  return { calls, execute, exists };
}

async function fixture(t) {
  const home = await import('node:fs/promises').then(({ mkdtemp }) => (
    mkdtemp(path.join(os.tmpdir(), 'sflow-product-uninstall-'))
  ));
  t.after(() => rm(home, { recursive: true, force: true }));
  const skills = path.join(home, '.copilot', 'skills');
  await mkdir(path.join(skills, 'sf-managed'), { recursive: true });
  await mkdir(path.join(skills, 'sf-personal'), { recursive: true });
  await writeFile(path.join(skills, 'sf-managed', 'SKILL.md'), `${MANAGED}\nmanaged\n`);
  await writeFile(path.join(skills, 'sf-personal', 'SKILL.md'), 'personal\n');
  await mkdir(path.join(home, '.singularity-flow', 'installations'), { recursive: true });
  await writeFile(path.join(home, '.singularity-flow', 'installations', 'current.json'), '{"schemaVersion":2}\n');
  await writeFile(path.join(home, '.singularity-flow', 'workspaces.json'), '{"preserve":true}\n');
  await writeFile(path.join(home, '.singularity-flow', 'copilot-otel.sh'), [
    '# Managed by the Singularity Flow installer.',
    'sflow_copilot() { command singularity-flow copilot "$@"; }',
    ''
  ].join('\n'));
  await writeFile(path.join(home, '.zshrc'), [
    'export KEEP_ME=yes',
    '# Singularity Flow: Copilot model/token/cost telemetry',
    '[ -r "$HOME/.singularity-flow/copilot-otel.sh" ] && . "$HOME/.singularity-flow/copilot-otel.sh"',
    'alias personal="echo keep"',
    ''
  ].join('\n'));
  return { home, skills };
}

test('product uninstall removes owned surfaces last while preserving user and workspace data', async (t) => {
  const item = await fixture(t);
  const commands = harness();
  const options = {
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home, SHELL: '/bin/zsh' }
  };
  const plan = await prepareProductUninstall(options);
  assert.equal(plan.present, true);
  assert.match(productUninstallText(plan), /UNINSTALL SINGULARITY FLOW [a-f0-9]{16}/u);
  await assert.rejects(() => applyProductUninstall(plan, { ...options, confirmation: 'wrong' }), /exact confirmation/u);
  const completed = await applyProductUninstall(plan, { ...options, confirmation: plan.confirmation });
  assert.equal(completed.completed, true);
  assert.equal(completed.removed.at(-1), 'global-cli');
  const npmRemoval = commands.calls.findIndex(([command, verb]) => command === 'npm' && verb === 'uninstall');
  const vscodeRemoval = commands.calls.findIndex(([command, verb]) => command === 'code' && verb === '--uninstall-extension');
  const copilotRemoval = commands.calls.findIndex(([command, first, second]) => command === 'copilot' && first === 'plugin' && second === 'uninstall');
  assert.ok(npmRemoval > vscodeRemoval && npmRemoval > copilotRemoval, 'global CLI must be removed last');
  await assert.rejects(() => readFile(path.join(item.skills, 'sf-managed', 'SKILL.md')), /ENOENT/u);
  assert.equal(await readFile(path.join(item.skills, 'sf-personal', 'SKILL.md'), 'utf8'), 'personal\n');
  assert.equal(await readFile(path.join(item.home, '.singularity-flow', 'workspaces.json'), 'utf8'), '{"preserve":true}\n');
  const profile = await readFile(path.join(item.home, '.zshrc'), 'utf8');
  assert.match(profile, /KEEP_ME=yes/u);
  assert.match(profile, /alias personal/u);
  assert.doesNotMatch(profile, /copilot-otel|Singularity Flow: Copilot/u);
  assert.ok(completed.receipt.endsWith('uninstall-current.json'));

  const second = await prepareProductUninstall(options);
  assert.equal(second.present, false);
});

test('distribution uninstall retry renders paths and confirmation as literal argv', async (t) => {
  const item = await fixture(t);
  const commands = harness();
  const plan = await prepareProductUninstall({
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home, SHELL: '/bin/zsh' }
  });
  const distributionEntrypoint = "/tmp/SFlow Uninstaller $(printf INJECTED) `printf BACKTICK` O'Brien";
  const artifactKeyPath = "/tmp/key $(printf KEY) O'Brien.pem";
  const hostile = { ...plan, distributionEntrypoint, artifactKeyPath };
  const expected = renderPlatformCommand([
    distributionEntrypoint, '--artifact-key', artifactKeyPath, '--confirm', plan.confirmation
  ]);
  const rendered = productUninstallText(hostile);
  assert.ok(rendered.includes(`Shell: ${expected}`));
  assert.doesNotMatch(rendered, /Shell: .*"\$\(/u);
});

test('VS Code refusal keeps the global CLI installed and leaves an exact retry path', async (t) => {
  const item = await fixture(t);
  const commands = harness({ failCodeUninstall: true });
  const options = {
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home, SHELL: '/bin/zsh' }
  };
  const plan = await prepareProductUninstall(options);
  await assert.rejects(
    () => applyProductUninstall(plan, { ...options, confirmation: plan.confirmation }),
    /restart required/u
  );
  assert.equal(commands.calls.some(([command, verb]) => command === 'npm' && verb === 'uninstall'), false);
  assert.equal(await readFile(path.join(item.home, '.singularity-flow', 'installations', 'current.json'), 'utf8'), '{"schemaVersion":2}\n');
});

test('partial uninstall retries with the original confirmation and preserves cumulative removals', async (t) => {
  const item = await fixture(t);
  const faults = { failCopilotUninstall: true };
  const commands = harness(faults);
  const options = {
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home, SHELL: '/bin/zsh' }
  };
  const firstPlan = await prepareProductUninstall(options);
  await assert.rejects(
    () => applyProductUninstall(firstPlan, { ...options, confirmation: firstPlan.confirmation }),
    /copilot plugin manager unavailable/u
  );

  const pendingFile = path.join(
    item.home, '.singularity-flow', 'installations', 'uninstall-pending.json'
  );
  const pending = JSON.parse(await readFile(pendingFile, 'utf8'));
  assert.equal(pending.initialFingerprint, firstPlan.fingerprint);
  assert.deepEqual(pending.removed, ['vscode-extension']);

  faults.failCopilotUninstall = false;
  const retryPlan = await prepareProductUninstall(options);
  assert.equal(retryPlan.fingerprint, firstPlan.fingerprint);
  assert.equal(retryPlan.confirmation, firstPlan.confirmation);
  const completed = await applyProductUninstall(retryPlan, {
    ...options, confirmation: firstPlan.confirmation
  });
  assert.equal(completed.completed, true);
  assert.deepEqual(completed.removed, [
    'vscode-extension', 'copilot-plugin', 'direct-skills:1', 'telemetry-helper', 'global-cli'
  ]);
  const receipt = JSON.parse(await readFile(completed.receipt, 'utf8'));
  assert.deepEqual(receipt.removed, completed.removed);
  await assert.rejects(() => readFile(pendingFile), /ENOENT/u);
});

test('retry reconciles a surface removed after its durable pending marker but before verification', async (t) => {
  const item = await fixture(t);
  const faults = { failExtensionVerification: true };
  const commands = harness(faults);
  const options = {
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home, SHELL: '/bin/zsh' }
  };
  const firstPlan = await prepareProductUninstall(options);
  await assert.rejects(
    () => applyProductUninstall(firstPlan, { ...options, confirmation: firstPlan.confirmation }),
    /extension verification interrupted/u
  );
  const pendingFile = path.join(
    item.home, '.singularity-flow', 'installations', 'uninstall-pending.json'
  );
  const interrupted = JSON.parse(await readFile(pendingFile, 'utf8'));
  assert.equal(interrupted.surfaces.vscode, 'pending');
  assert.equal(interrupted.surfaceEntries.vscode, 'vscode-extension');
  assert.deepEqual(interrupted.removed, []);

  faults.failExtensionVerification = false;
  const retryPlan = await prepareProductUninstall(options);
  assert.equal(retryPlan.confirmation, firstPlan.confirmation);
  const completed = await applyProductUninstall(retryPlan, {
    ...options, confirmation: firstPlan.confirmation
  });
  assert.equal(completed.completed, true);
  assert.deepEqual(completed.removed, [
    'vscode-extension', 'copilot-plugin', 'direct-skills:1', 'telemetry-helper', 'global-cli'
  ]);
  const receipt = JSON.parse(await readFile(completed.receipt, 'utf8'));
  assert.deepEqual(receipt.removed, completed.removed);
});

test('receipt-recorded managers must be available before uninstall mutates anything', async (t) => {
  const item = await fixture(t);
  const commands = harness();
  await writeFile(path.join(item.home, '.singularity-flow', 'installations', 'current.json'),
    `${JSON.stringify({ schemaVersion: 2, surfaces: { vscode: true, copilot: true } })}\n`);
  await assert.rejects(() => prepareProductUninstall({
    execute: commands.execute,
    exists: (command) => command === 'npm',
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home }
  }), /code command is unavailable/u);
  assert.equal(commands.calls.some(([command, verb]) => command === 'npm' && verb === 'uninstall'), false);
});

test('an installation receipt alone remains recoverable after every product surface is absent', async (t) => {
  const home = await import('node:fs/promises').then(({ mkdtemp }) => (
    mkdtemp(path.join(os.tmpdir(), 'sflow-product-uninstall-reconcile-'))
  ));
  t.after(() => rm(home, { recursive: true, force: true }));
  const installations = path.join(home, '.singularity-flow', 'installations');
  await mkdir(installations, { recursive: true });
  await writeFile(path.join(installations, 'current.json'), '{"schemaVersion":2}\n');
  const calls = [];
  const execute = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'npm' && args[0] === 'list') {
      return { status: 0, stdout: '{}', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const options = {
    execute,
    exists: (command) => command === 'npm',
    homeDirectory: home,
    environment: { ...process.env, HOME: home }
  };
  const plan = await prepareProductUninstall(options);
  assert.equal(plan.present, true, 'stale receipt is unfinished uninstall work');
  const result = await applyProductUninstall(plan, { ...options, confirmation: plan.confirmation });
  assert.equal(result.completed, true);
  assert.deepEqual(result.removed, []);
  await assert.rejects(() => readFile(path.join(installations, 'current.json')), /ENOENT/u);
  assert.ok((await readFile(path.join(installations, 'uninstall-current.json'), 'utf8')).includes('product-uninstall'));
});

test('unsafe uninstall receipt targets are refused before the first removal', async (t) => {
  const item = await fixture(t);
  const commands = harness();
  const options = {
    execute: commands.execute,
    exists: commands.exists,
    homeDirectory: item.home,
    environment: { ...process.env, HOME: item.home }
  };
  const plan = await prepareProductUninstall(options);
  await mkdir(path.join(item.home, '.singularity-flow', 'installations', 'uninstall-current.json'));
  await assert.rejects(
    () => applyProductUninstall(plan, { ...options, confirmation: plan.confirmation }),
    /Prior uninstall receipt is not an ordinary file/u
  );
  assert.equal(commands.calls.some(([command, verb]) => command === 'code' && verb === '--uninstall-extension'), false);
  assert.equal(commands.calls.some(([command, verb]) => command === 'npm' && verb === 'uninstall'), false);
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { doctorSnapshot } from '../src/doctor.mjs';
import { modelFreedomSnapshot } from '../src/model-freedom.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
}

function activeWorkflow(qualityCommands = [], allowedProducers = ['human']) {
  return {
    currentPhase: 'intake', phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', qualityCommands, generationPolicy: { requirement: 'required', allowedProducers } } }
  };
}

test('doctor model-freedom reports unknown external commands as partial', () => {
  const report = modelFreedomSnapshot({ workflow: activeWorkflow(['legacy-validator']), definition: { noModel: { unknownExternalCommands: 'warn' } }, modelMode: { enabled: false } });
  assert.equal(report.currentWorkflow.status, 'partial');
  assert.equal(report.qualityCommands.unknown, 1);
  assert.equal(report.modelFreeLifecycleReady, true);
});

test('doctor model-freedom reports a model-only phase as blocked', () => {
  const report = modelFreedomSnapshot({ workflow: activeWorkflow([], ['governed-agent']), modelMode: { enabled: false } });
  assert.equal(report.currentWorkflow.status, 'blocked');
  assert.equal(report.modelFreeLifecycleReady, false);
});

test('doctor model-freedom checks the configured logical provider and executable', () => {
  const report = modelFreedomSnapshot({
    definition: {
      models: {
        defaultProvider: 'corporate-copilot',
        providers: { 'corporate-copilot': { type: 'copilot-cli', executable: process.execPath } }
      }
    }
  });
  assert.deepEqual(report.provider, {
    id: 'corporate-copilot', type: 'copilot-cli', executable: process.execPath, available: true
  });
});

test('doctor reports zero-token world-model readiness when semantic routing is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-doctor-zero-token-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Doctor Tester'], root);
  run('git', ['config', 'user.email', 'doctor@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Doctor routing test\n');
  run(process.execPath, [bin, 'init'], root);
  await rm(path.join(root, 'singularity/modelTiers.yml'));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize without semantic routing'], root);

  const report = await doctorSnapshot(root, { offline: true });
  const routing = report.checks.find((entry) => entry.id === 'world-model-routing');
  assert.equal(routing.status, 'warn');
  assert.match(routing.message, /Deterministic light generation remains available with zero model tokens/);
  assert.match(routing.fix, /wm build --depth light/);
});

test('doctor keeps model-free work healthy when the optional provider is not installed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-doctor-no-provider-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Doctor Tester'], root);
  run('git', ['config', 'user.email', 'doctor@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Doctor provider test\n');
  run(process.execPath, [bin, 'init'], root);
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = await readFile(workflowPath, 'utf8');
  await writeFile(workflowPath, workflow
    .replace('publish: required', 'publish: off')
    .replace('executable: copilot', `executable: ${path.join(root, 'missing-copilot')}`));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize without optional provider'], root);

  const report = await doctorSnapshot(root, { offline: true });
  const provider = report.checks.find((entry) => entry.id === 'model-provider-prompt-transport');
  assert.equal(provider.status, 'warn');
  assert.equal(provider.code, 'MODEL_PROVIDER_UNAVAILABLE');
  assert.match(provider.message, /model-free work remains available/);
  assert.equal(report.healthy, true);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CLI = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'bin/singularity-flow.mjs');
const W = 'WXR-1';
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Renewal Tester', SINGULARITY_FLOW_NO_MODEL: '1' };

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: ENV });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

// The command a lapsed-exception refusal names is a real decision command: it finds the Story, checks
// the exact exception and refuses one the step never recorded, changing nothing (2026-10-28).
test('decision witness-exception renews only an exception the step recorded', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-witness-renewal-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Renewal Tester'], root);
  run('git', ['config', 'user.email', 'renew@example.test'], root);
  await writeFile(path.join(root, 'README.md'), '# Renewal fixture\n');
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off'; config.worldModel.grounding = 'off';
  config.repositoryReadiness.requiredBeforeStory = false;
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the renewal fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-q', '-u', 'origin', 'main'], root);
  cli('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Renew an exception', '--description', 'Renew a lapsed witness exception.');
  const before = await readFile(path.join(root, 'singularity/work-items', W, 'workflow.json'), 'utf8');
  const refused = run(process.execPath, [CLI, '--no-model', 'decision', 'witness-exception', W, '--phase', 'intake',
    '--mapping', `sha256:${'a'.repeat(64)}`, '--expires', '2099-01-01', '--reason', 'The device lab is still down.'], root, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /intake's current approval recorded no witness exception/u);
  assert.equal(await readFile(path.join(root, 'singularity/work-items', W, 'workflow.json'), 'utf8'), before, 'nothing was recorded');
  const usage = run(process.execPath, [CLI, '--no-model', 'decision', 'witness-exception', W], root, { allowFailure: true });
  assert.match(usage.stdout + usage.stderr, /--phase STEP --mapping sha256/u);
});

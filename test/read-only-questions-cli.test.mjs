import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Question Tester', SINGULARITY_FLOW_NO_MODEL: '1' };
const W = 'ASK-1';

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: ENV });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

/**
 * A skill asks these on whatever step is current. Each is a question, so each is answered on a
 * step it does not concern instead of refusing: an agent that stops on a refusal here stops a Story
 * that has nothing wrong with it. Asked at intake, the step a functional test stopped on.
 */
test('every read-only question a skill asks is answered at a step it does not concern', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-read-only-questions-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Question Tester'], root);
  run('git', ['config', 'user.email', 'ask@example.test'], root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'test/smoke.test.mjs'), "import test from 'node:test';\ntest('smoke', () => {});\n");
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  // Reviewed like spec-driven-standard, so intake sits in a Story whose later steps owe a source review.
  config.workTypes.feature.sourceReview = { mode: 'enforce', phases: ['requirements', 'implementation-spec'], reviewerAgent: 'sflow-source-reviewer' };
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the read-only questions fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');
  cli('start', W, '--from-branch', 'main', '--work-type', 'feature', '--title', 'Cache the value', '--description', 'Decide how long callers cache the value.');
  cli('prepare', 'intake');

  const ask = (...args) => {
    const result = run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
    assert.equal(result.status, 0, `${args.join(' ')} refused at intake:\n${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /applies only|does neither|cannot define specification clauses/u);
    return result.stdout;
  };
  const json = (...args) => JSON.parse(ask(...args, '--json'));

  for (const action of ['status', 'context', 'decision-context', 'check']) {
    assert.equal(json('review-source', action, 'intake').status, 'not-required', `review-source ${action} intake`);
  }
  assert.equal(json('review-source', 'status', 'requirements').status, 'not-yet-published');
  const index = json('spec', 'index', '--phase', 'intake', '--dry-run');
  assert.deepEqual([index.applies, index.indexPhase], [false, 'requirements']);
  assert.equal(json('story', 'test-policy', 'plan').outcome.slots.status, 'not-applicable');
  assert.match(ask('revision', 'status', '--json'), /not-applicable/u);
  assert.equal(json('stack', 'status').status, 'not-applicable');
  assert.deepEqual(Object.values(json('receipt', 'show', '--work-id', W)).slice(0, 2), ['unavailable', 'no-submission']);
  assert.equal(json('adhoc', 'status').session, null);
  // Submission readiness is the one place a skill learns whether a review is owed.
  assert.doesNotMatch(ask('status', W, '--submission-readiness', '--json'), /review-source (?:status|context|check) intake/u);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

/** A feature Story whose scope steps owe an enforced source review, started and at intake. */
async function featureStory(t) {
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
  return { root, cli };
}

/** Author a prepared step's placeholders, then compose, clarify and publish it. */
async function publish(root, cli, phase, text) {
  cli('prepare', phase);
  const directory = path.join(root, 'singularity/work-items', W, 'artifacts', phase);
  const file = path.join(directory, (await readdir(directory)).find((name) => name.endsWith('.md')));
  await writeFile(file, (await readFile(file, 'utf8')).replace(/TODO:[^\n]*/gu, text).replace(/\bTODO\b/gu, text));
  cli('wm', 'compose', '--phase', phase);
  cli('clarification', 'record', phase, '--question', `Is the ${phase} scope agreed?`, '--answer', 'Yes, as written.');
  cli('phase', 'publish', phase, '--authored', 'human', '--channel', 'manual-in-place');
}

/**
 * A skill asks these on whatever step is current. Each is a question, so each is answered on a
 * step it does not concern instead of refusing: an agent that stops on a refusal here stops a Story
 * that has nothing wrong with it. Asked at intake, the step a functional test stopped on.
 */
test('every read-only question a skill asks is answered at a step it does not concern', async (t) => {
  const { root } = await featureStory(t);
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

/**
 * `next` and `run` never submit a step whose source review is not ready: they show the review's own
 * next step with a route every surface can render, and leave the step as it was. A step that owes
 * no review is submitted as before.
 */
test('next submits an unreviewed intake but shows the review route for a published scope step', async (t) => {
  const { root, cli } = await featureStory(t);
  const state = async () => JSON.parse(await readFile(path.join(root, 'singularity/work-items', W, 'workflow.json'), 'utf8'));
  await publish(root, cli, 'intake', 'Callers read the value from one shared module and keep a copy for at most one hour.');
  cli('next');
  assert.equal((await state()).phases.intake.status, 'awaiting_approval', 'intake owes no review, so next submits it');
  cli('approve', 'intake', '--yes');
  // The composed context is also named as a verified file, and control fields lead the packet.
  const entry = JSON.parse(cli('phase', 'enter', 'requirements', '--compose', '--for-agent', '--json').stdout);
  assert.equal(entry.context.file.sha256, createHash('sha256').update(await readFile(path.join(root, entry.context.file.path))).digest('hex'));
  assert.ok(Object.keys(entry).indexOf('authoring') < Object.keys(entry).indexOf('recovery'));
  assert.equal(Object.keys(entry).at(-1), 'context');
  await publish(root, cli, 'requirements', 'Callers keep a local copy for at most one hour and refresh it when the module changes.');
  for (const command of ['next', 'run']) {
    const held = cli(command, '--yes').stdout;
    assert.match(held, /Copilot: \/sf-review-source requirements/u, command);
    assert.match(held, /Shell: singularity-flow review-source context requirements --json/u, command);
    assert.doesNotMatch(held, /unavailable/u, `${command} printed a route no surface can render`);
    assert.equal((await state()).phases.requirements.status, 'in_progress', `${command} must not submit before the review`);
  }
});

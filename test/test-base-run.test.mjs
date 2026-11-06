/**
 * `tests base`: does this also fail without the Story's change? The same command once on the base commit,
 * which is a fact for a person: not evidence, no attempt, no refusal, and never run twice.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { baseComparison, runOnBase, storyBaseCommit } from '../src/verification/base-run.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('a base run reads against the failures here: all of them, some of them, or none', () => {
  const ran = { baseCommit: 'a'.repeat(40), nodeVersion: '26.12.0', status: 'failed', exitCode: 1, tests: { discovered: 31, passed: 14, failed: 17 }, failed: ['one', 'two'] };
  const all = baseComparison(ran, { here: ['one', 'two'] });
  assert.equal(all.verdict, 'fails-on-base');
  assert.match(all.words, /Every failure here also fails without this change, on the base commit a{12}, on Node 26\.12\.0 \(31 tests, 14 passed, 17 failed\)/u);
  assert.match(all.words, /A person decides what to do/u);
  const some = baseComparison(ran, { here: ['one', 'mine'] });
  assert.deepEqual([some.verdict, some.alsoOnBase, some.onlyHere], ['partly-on-base', ['one'], ['mine']]);
  assert.match(some.words, /1 of 2 failures here also fail[\s\S]*These fail only with it: mine\./u);
  const passes = baseComparison({ ...ran, status: 'passed', failed: [], tests: { discovered: 31, passed: 31, failed: 0 } }, { here: ['mine'] });
  assert.equal(passes.verdict, 'passes-on-base');
  assert.match(passes.words, /It passes without this change[\s\S]*so mine fails only with it\./u);
  assert.equal(baseComparison({ ...ran, status: 'not-run', why: 'no base' }).verdict, 'not-run');
  assert.match(baseComparison({ ...ran, tests: null, failed: [] }).words, /exit 1, with no report SFlow could read/u);
});

test('the base is the commit the Story started from', () => {
  assert.equal(storyBaseCommit({ workItem: { baseCommit: 'story' }, workIntervals: { current: { sourceBaseCommit: 'interval' } } }, { generationIntent: { baseline: { commit: 'generation' } } }), 'story');
  assert.equal(storyBaseCommit({ workItem: {} }, { generationIntent: { baseline: { commit: 'generation' } } }), 'generation');
  assert.equal(storyBaseCommit({}, {}), null);
});

test('a base run that cannot check out the commit says why and is not kept', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-base-run-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  const result = await runOnBase(root, { id: 'unit', argv: ['npm', 'test'], workingDirectory: '.', result: { adapter: 'vitest-json' } },
    { baseCommit: 'f'.repeat(40), gateRun: async () => assert.fail('nothing runs') });
  assert.equal(result.status, 'not-run');
  assert.match(result.why, /could not check out the base commit/u);
});

test('tests base: a real Story\'s failures, compared with its base commit, change nothing and run once', slowLane({ timeout: 600_000 }), async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-base-run-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Base Tester', SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Base Tester', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'base.tester@example.invalid' };
  delete env.NODE_TEST_CONTEXT;
  const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(240_000) });
  const must = (command, args, cwd = root) => { const result = run(command, args, cwd); assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`); return result.stdout; };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  const tests = (...cases) => "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n// @ac:QF-1:AC-001\n" + cases.join('\n') + '\n';
  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.sflow/results/\n');
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  // Broken before any Story: the failure the question is about.
  await writeFile(path.join(root, 'test/value.test.mjs'), tests("test('already broken', () => assert.equal(process.env.NOT_SET_HERE, 'x'));", "test('value', () => assert.equal(value, 1));"));
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'A repository whose tests already fail']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), ['# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '', '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|', '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('resume', 'QF-1');
  sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), tests("test('already broken', () => assert.equal(process.env.NOT_SET_HERE, 'x'));", "test('value', () => assert.equal(value, 3));"));
  sflow('prepare', 'implement');
  const failed = run(process.execPath, [cli, '--no-model', 'tests', 'run', '--work-id', 'QF-1', '--json']);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const workflowPath = path.join(root, 'singularity/work-items/QF-1/workflow.json');
  const before = await readFile(workflowPath, 'utf8');
  const attemptsFolder = path.join(root, '.git/singularity-flow/test-attempts/QF-1/implement');
  const attemptsBefore = (await readdir(attemptsFolder, { recursive: true }).catch(() => [])).length;
  const head = must('git', ['rev-parse', 'HEAD']).trim();

  const answer = JSON.parse(sflow('tests', 'base', '--work-id', 'QF-1', '--json'));
  assert.equal(answer.resultType, 'sflow-test-base');
  const [result] = answer.results;
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.deepEqual([result.verdict, result.alsoOnBase, result.onlyHere], ['partly-on-base', ['already broken'], ['value']], JSON.stringify(result));
  assert.match(result.words, /1 of 2 failures here also fail without this change/u);
  assert.equal(result.nodeVersion, process.versions.node);
  // A fact, not a run of this Story: nothing about it changed, and the base worktree is gone.
  assert.equal(await readFile(workflowPath, 'utf8'), before);
  assert.equal((await readdir(attemptsFolder, { recursive: true }).catch(() => [])).length, attemptsBefore);
  assert.equal(must('git', ['rev-parse', 'HEAD']).trim(), head);
  assert.equal(must('git', ['worktree', 'list', '--porcelain']).match(/^worktree /gmu).length, 1, 'the throwaway worktree is removed');
  // The same question again is not a second run.
  const again = JSON.parse(sflow('tests', 'base', '--work-id', 'QF-1', '--json'));
  assert.equal(again.results[0].reused, true);
  assert.deepEqual(again.results[0].alsoOnBase, ['already broken']);
  assert.match(sflow('tests', 'base', '--work-id', 'QF-1'), /not evidence and refuses nothing[\s\S]*already run on this base/u);
  // A Story step is what it compares: a capability has no base commit.
  const noStory = run(process.execPath, [cli, '--no-model', 'tests', 'base', '--json']);
  assert.notEqual(noStory.status, 0);
  assert.match(noStory.stdout, /name it with --work-id/u);
});

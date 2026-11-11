/**
 * Narrowed test runs, through quick-fix Stories [TCE:REQ-020].
 *
 * A focused test, a skipped test, a dropped test and a filter in the script behind `npm test` all
 * passed the gate before. Each now refuses publication with CODE_TEST_NARROWED, naming why. A
 * person who approves the step may accept a narrowing with a reason; it covers the same or a
 * smaller narrowing of the same pin, is shown in the review and the test summary, and a wider one
 * is refused again.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

/**
 * A quick-fix Story opened at its code step, with `scripts` as the package's scripts on the base
 * branch and `storyScripts`, when given, as the Story's own change to them.
 */
async function quickFix(t, { scripts, storyScripts = null, prefix, baseFiles = {} }) {
  const base = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Narrow Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Narrow Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'narrow.tester@example.invalid' };
  delete env.NODE_TEST_CONTEXT;
  const run = (args, extra = {}) => spawnSync(process.execPath, [cli, '--no-model', ...args], { cwd: root, env: { ...env, ...extra },
    encoding: 'utf8', timeout: childTimeout(180_000) });
  const must = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000) });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  const json = (...args) => JSON.parse(sflow(...args, '--json'));
  const reviewer = { SINGULARITY_FLOW_TEST_IDENTITY: 'Narrow Reviewer', GIT_CONFIG_VALUE_0: 'Narrow Reviewer', GIT_CONFIG_VALUE_1: 'narrow.reviewer@example.invalid' };
  const asReviewer = (...args) => {
    const result = run([...args, '--json'], reviewer);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const refused = (...args) => {
    const result = run([...args, '--json']);
    assert.notEqual(result.status, 0, `${args.join(' ')} should be refused\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  const writeTests = (...cases) => writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\n"
    + "import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n// @ac:QF-1:AC-001\n" + cases.join('\n') + '\n');

  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test')); await mkdir(path.join(root, 'node_modules/.bin'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts }));
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.sflow/results/\n');
  // A stand-in Mocha on the npm script PATH that passes whatever it is asked.
  await writeFile(path.join(root, 'node_modules/.bin/mocha'), '#!/usr/bin/env node\nprocess.exit(0);\n');
  await chmod(path.join(root, 'node_modules/.bin/mocha'), 0o755);
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n");
  for (const [file, text] of Object.entries(baseFiles)) await writeFile(path.join(root, file), text);
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Narrowed runs fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), [
    '# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
    ...(storyScripts ? ['## Supporting files', '', '- `package.json` — the test script gains a step.', ''] : []),
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('resume', 'QF-1');
  sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  if (storyScripts) await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: storyScripts }));
  sflow('prepare', 'implement');
  return { root, run, sflow, json, asReviewer, refused, writeTests, reviewer,
    stored: async () => JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8')) };
}

const planCommands = (envelope) => (envelope.remediationPlan?.steps ?? []).map((entry) => entry.command).filter(Boolean);
const ACCEPT = 'singularity-flow decision test-narrowing QF-1 --phase implement --command .-node-tests --reason "<why the narrowed run is enough for this step>"';

test('focused, skipped and dropped tests refuse the gate until a person who approves the step accepts the narrowing', slowLane({ timeout: 900_000 }), async (t) => {
  const story = await quickFix(t, { scripts: { test: 'node --test' }, prefix: 'sflow-narrowed-run-' });
  const cases = ["test('value', () => assert.equal(value, 2));", "test('value is a number', () => assert.equal(typeof value, 'number'));",
    "test('value is positive', () => assert.ok(value > 0));"];

  // A focused test [TCE:REQ-021, REQ-022].
  await story.writeTests(cases[0].replace("test('value'", "test.only('value'"), cases[1], cases[2]);
  const focused = story.refused('phase', 'publish', 'implement');
  assert.equal(focused.error.code, 'CODE_TEST_NARROWED', JSON.stringify(focused.error));
  assert.deepEqual(focused.error.details.testNarrowing.reasons, ['focused']);
  assert.match(focused.error.message, /ran narrowed before publication: focused test test\/value\.test\.mjs:5 'value'/u);
  assert.equal(focused.error.details.testNarrowing.command, ACCEPT);
  assert.ok(planCommands(focused).includes(ACCEPT), JSON.stringify(planCommands(focused)));

  // A skipped test, and a test that is no longer there: the first passing run of the pin had three.
  await story.writeTests(cases[0], cases[1], cases[2].replace("test('value is positive',", "test('value is positive', { skip: true },"));
  const skipped = story.refused('phase', 'publish', 'implement');
  assert.equal(skipped.error.code, 'CODE_TEST_NARROWED');
  assert.deepEqual(skipped.error.details.testNarrowing.reasons, ['skipped']);
  assert.match(skipped.error.message, /1 test\(s\) skipped/u);
  await story.writeTests(cases[0], cases[1]);
  const dropped = story.refused('phase', 'publish', 'implement');
  assert.deepEqual(dropped.error.details.testNarrowing.reasons, ['below-baseline']);
  assert.match(dropped.error.message, /2 test\(s\) discovered, 1 fewer than the first passing run of this pin \(3\)/u);

  // Nothing to accept without a reason; a person who approves the step accepts the dropped test.
  assert.equal(story.refused('decision', 'test-narrowing', '--phase', 'implement', '--reason', 'short').error.code, 'TEST_NARROWING_INVALID');
  const accepted = story.asReviewer('decision', 'test-narrowing', 'QF-1', '--phase', 'implement', '--command', '.-node-tests',
    '--reason', 'The positive-value case is covered by the type check now.');
  assert.equal(accepted.data.record.id, 'TNR-001');
  assert.deepEqual(accepted.data.record.narrowing.reasons, ['below-baseline']);

  // A wider narrowing of the same pin is refused again, naming the smaller one accepted.
  await story.writeTests(cases[0]);
  const wider = story.refused('phase', 'publish', 'implement');
  assert.equal(wider.error.code, 'CODE_TEST_NARROWED');
  assert.match(wider.error.message, /TNR-001 accepted a smaller narrowing of this pin; this run goes beyond it/u);

  // The accepted narrowing lets the step through, and the review and the test summary show it [TCE:REQ-024].
  await story.writeTests(cases[0], cases[1]);
  story.sflow('phase', 'publish', 'implement');
  const review = story.json('phase', 'show', 'implement');
  assert.equal(review.testEvidence.acceptedNarrowings.length, 1);
  assert.match(review.testEvidence.acceptedNarrowings[0].words,
    /^\.-node-tests ran narrowed \(2 test\(s\) discovered, 1 fewer than the first passing run of this pin \(3\)\)\. Accepted as TNR-001 by .*: The positive-value case is covered by the type check now\.$/u);
  const shown = story.run(['phase', 'show', 'implement']);
  assert.match(shown.stderr, /Accepted narrowing: \.-node-tests ran narrowed/u);
  const summary = story.run(['tests', 'summary', '--work-id', 'QF-1', '--phase', 'implement']);
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /Narrowed: 2 test\(s\) discovered, 1 fewer .*; accepted as TNR-001: The positive-value case is covered by the type check now\./u);

  story.sflow('submit', 'implement');
  const submitted = await story.stored();
  assert.equal(submitted.phases.implement.status, 'approved');
  assert.equal(submitted.phases.implement.deliveryEvidence.testExecutions[0].testNarrowing.id, 'TNR-001', 'the submission ran narrowed too, under the same decision');
});

test('a filter the Story adds to the script behind npm test refuses the gate, naming where it was written; the team\'s own does not', slowLane({ timeout: 600_000 }), async (t) => {
  // The team's script already filters by name on the base branch; the Story adds a mocha step that greps.
  const story = await quickFix(t, { scripts: { test: 'node --test --test-name-pattern=value' },
    storyScripts: { test: 'node --test --test-name-pattern=value', posttest: 'mocha --grep value' }, prefix: 'sflow-filtered-run-' });
  await story.writeTests("test('value', () => assert.equal(value, 2));");
  const filtered = story.refused('phase', 'publish', 'implement');
  assert.equal(filtered.error.code, 'CODE_TEST_NARROWED', JSON.stringify(filtered.error));
  assert.deepEqual(filtered.error.details.testNarrowing.reasons, ['filter']);
  assert.match(filtered.error.message, /ran narrowed before publication: filter --grep value \(package\.json#scripts\.posttest\)/u);
  assert.doesNotMatch(filtered.error.message, /--test-name-pattern/u, 'the filter already on the base branch is the team\'s setup');
  // The pinned filter is accepted once; the same filter then passes, with the decision bound.
  story.asReviewer('decision', 'test-narrowing', 'QF-1', '--phase', 'implement', '--command', '.-node-tests',
    '--reason', 'The module names its suite by pattern; CI runs the same script.');
  story.sflow('phase', 'publish', 'implement');
  assert.equal((await story.stored()).phases.implement.deliveryEvidence.preflightAttempts.at(-1).testNarrowing.id, 'TNR-001');
});

test('a path the Story adds to the script: one that drops nothing publishes and is shown, one that drops a test is a person\'s decision', slowLane({ timeout: 600_000 }), async (t) => {
  const more = "import test from 'node:test';\ntest('more', () => {});\n";
  // Every test the base commit has is still selected: nobody is asked, and the summary says what the script now names.
  const quiet = await quickFix(t, { scripts: { test: 'node --test' }, storyScripts: { test: 'node --test test/*.test.mjs' }, prefix: 'sflow-path-kept-', baseFiles: { 'test/more.test.mjs': more } });
  await quiet.writeTests("test('value', () => assert.equal(value, 2));");
  quiet.sflow('phase', 'publish', 'implement');
  const summary = quiet.json('tests', 'summary', '--work-id', 'QF-1', '--phase', 'implement');
  assert.match(JSON.stringify(summary), /now names test\/\*\.test\.mjs\. Every test file it ran at the base commit \(2\) is still selected, so none are dropped/u);

  // One is left out: refused, naming it, before anyone relies on the smaller run.
  const narrow = await quickFix(t, { scripts: { test: 'node --test' }, storyScripts: { test: 'node --test test/value.test.mjs' }, prefix: 'sflow-path-dropped-', baseFiles: { 'test/more.test.mjs': more } });
  await narrow.writeTests("test('value', () => assert.equal(value, 2));");
  const refused = narrow.refused('phase', 'publish', 'implement');
  assert.equal(refused.error.code, 'CODE_TEST_NARROWED', JSON.stringify(refused.error));
  assert.match(refused.error.message, /path test\/value\.test\.mjs \(package\.json#scripts\.test\) leaves out 1 of the 2 test files of the base commit: test\/more\.test\.mjs/u);
  // A person who approves the step decides it like any other filter.
  narrow.asReviewer('decision', 'test-narrowing', 'QF-1', '--phase', 'implement', '--command', '.-node-tests',
    '--reason', 'The other test moves to its own suite in the next Story of this Epic.');
  narrow.sflow('phase', 'publish', 'implement');
  assert.equal((await narrow.stored()).phases.implement.deliveryEvidence.preflightAttempts.at(-1).testNarrowing.id, 'TNR-001');
});

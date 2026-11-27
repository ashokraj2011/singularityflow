/**
 * Watch the code base [WCB, docs/SPEC-WCB-WATCH-CODE-BASE-v1.md], through the real CLI.
 *
 * Owner, 2026-11-27: "We should care about the code base, not any of these settings files or any config files or test
 * folders", and "If any code changes that was not agreed upon in planning phase, surface it, let copilot explain if it has
 * touched, add the reason in documents and carry forward. If human has done, let them do it and move forward."
 *
 * A person starts coding while Intake (the plan) is open and commits some of it, and an editor, a test runner and a local
 * settings file write their own files. Intake is submitted and approved with no question. The code step carries what was
 * already there, committed or not, and is published, submitted and approved with no question either. A clause with no
 * test is still refused: the hard stops stay.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function execute(command, args, cwd, { allowFailure = false } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Base Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'chore', agent: 'developer' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: childTimeout(180_000) });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}
const flow = (cwd, args, options) => execute(process.execPath, [bin, ...args], cwd, options);
// No detached auto-maintenance between the fixture's own back-to-back Git commands (document-step-files.test.mjs).
const git = (cwd, ...args) => execute('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], cwd).stdout.trim();
const json = (result) => JSON.parse(result.stdout);

async function repository(t, configure = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wcb-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(`${root}.git`, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Base Tester');
  git(root, 'config', 'user.email', 'base.tester@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Ledger\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.approvalSecurity = { profile: 'poc' };
  config.worldModel.grounding = 'off';
  config.repositoryReadiness = { ...config.repositoryReadiness, requiredBeforeStory: false };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  config.workTypes['classic-delivery'].spec = { ...(config.workTypes['classic-delivery'].spec ?? {}), mode: 'enforce', coverage: 'enforce' };
  configure?.(config);
  await writeFile(configPath, YAML.stringify(config));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'initial');
  git(root, 'init', '-q', '--bare', '-b', 'main', `${root}.git`);
  for (const [key, value] of [['maintenance.auto', 'false'], ['gc.auto', '0']]) git(`${root}.git`, 'config', key, value);
  git(root, 'remote', 'add', 'origin', `${root}.git`);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return root;
}

/** A classic-delivery Story whose plan names src/value.mjs and its test for AC-001; Intake published, not submitted. */
async function story(t, W) {
  const root = await repository(t);
  const AC = `${W}:AC-001`;
  const write = async (relative, contents) => writeFile(path.join(root, relative), contents);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  execute('mkdir', ['-p', 'src', 'test'], root);
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${AC}`, "test('value', () => assert.equal(value, 1));", ''].join('\n'));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'value module');
  git(root, 'push', '-q', 'origin', 'main');
  const readiness = json(flow(root, ['precheck', '--run', '--scope', 'dependency-test', '--json'])).data.plan;
  flow(root, ['precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json']);
  flow(root, ['start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return 2.']);
  const item = path.join(root, 'singularity/work-items', W);
  flow(root, ['prepare', 'intake']);
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${W} — intake`, '', '## Request and outcome', '', 'Return the approved value 2 to every caller.', '',
    '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${AC}] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${AC}\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified |`, '',
    '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''
  ].join('\n'));
  flow(root, ['wm', 'compose', '--phase', 'intake']);
  flow(root, ['clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.']);
  flow(root, ['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place']);
  const read = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  return { root, item, AC, write, read };
}

const summary = (item, W, outside = []) => [
  `# ${W} — Implementation Summary`, '', '## Agent brief', '', 'The value module returns the approved value 2.', '',
  '## Changed components and decisions', '', '- `src/value.mjs`: returns the approved value.', '',
  ...(outside.length ? ['### Changes outside the plan', '', ...outside.map(([file, why]) => `- \`${file}\`: ${why}`), ''] : []),
  '## Tests and operational notes', '', '- `test/value.test.mjs` checks the value.', ''
].join('\n');

const valueTest = (W, value, tagged = true) => ["import test from 'node:test';", "import assert from 'node:assert/strict';",
  "import { value } from '../src/value.mjs';", ...(tagged ? [`// @ac:${W}:AC-001`] : []), `test('value', () => assert.equal(value, ${value}));`, ''].join('\n');

test('code written while the plan is open, committed or not, reaches an approved code step with no question; the workspace\'s own files are never counted',
  slowLane({ timeout: 900_000 }), async (t) => {
    const W = 'WCB-1';
    const { root, item, write, read } = await story(t, W);
    const base = (await read()).workItem.baseCommit;
    execute('mkdir', ['-p', '.vscode', 'test-results'], root);

    // While Intake is open: a person starts the planned change, and an editor, a test runner and a local settings file write
    // their own files.
    await write('src/value.mjs', 'export const value = 2;\n');
    await write('.vscode/settings.json', '{ "java.configuration.updateBuildConfiguration": "automatic" }\n');
    await write('test-results/.last-run.json', '{ "status": "passed" }\n');
    await write('.env.local', 'LEDGER_REGION=local\n');

    // Intake writes documents only: it is submitted and approved with nothing to set aside and nobody asked, while the
    // person goes on coding and commits the test as it waits [WCB:REQ-005, REQ-006].
    const submitted = flow(root, ['submit', 'intake', '--json'], { allowFailure: true });
    assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
    await write('src/value.mjs', `// @clause:${W}:AC-001 returns the approved value\nexport const value = 2;\n`);
    await write('test/value.test.mjs', valueTest(W, 2));
    git(root, 'add', 'test/value.test.mjs');
    git(root, 'commit', '-q', '-m', 'early work');
    const intakeList = json(flow(root, ['decisions', W, '--json'])).data;
    assert.ok(!intakeList.items.some((entry) => ['generation-rollover', 'plan-accounting', 'departure'].includes(entry.kind)),
      JSON.stringify(intakeList.items.map((entry) => entry.kind)));
    const approved = flow(root, ['approve', 'intake', '--yes'], { allowFailure: true });
    assert.equal(approved.status, 0, approved.stdout + approved.stderr);
    let workflow = await read();
    assert.equal(workflow.phases.intake.status, 'approved');
    // Nothing of the code base went into Intake's commits.
    assert.equal(git(root, 'status', '--porcelain', '--', 'src/value.mjs'), 'M src/value.mjs');
    // The code step's interval starts where code was last governed, the Story's base, so the commit made during Intake is
    // in its change set [WCB:REQ-008].
    assert.equal(workflow.workIntervals.current.phaseId, 'implementation');
    assert.equal(workflow.workIntervals.current.sourceBaseCommit, base);

    // The code step begins without a question: what was already there is carried [WCB:REQ-009].
    const prepared = flow(root, ['prepare', 'implementation'], { allowFailure: true });
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    workflow = await read();
    const start = JSON.parse(await readFile(path.join(root, workflow.phases.implementation.generationIntent.path), 'utf8'));
    assert.equal(start.baseline.mode, 'inherited');
    assert.equal(start.baseline.commit, base);
    for (const file of ['src/value.mjs', 'test/value.test.mjs']) assert.ok(start.inherited.paths.includes(file), file);
    assert.ok(!start.inherited.paths.some((file) => file.startsWith('.vscode/') || file.startsWith('test-results/') || file === '.env.local'));

    await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), summary(item, W));
    const published = flow(root, ['phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place', '--json'], { allowFailure: true });
    assert.equal(published.status, 0, published.stdout + published.stderr);
    assert.equal(git(root, 'status', '--porcelain', '--', 'src/value.mjs'), '');
    assert.equal(git(root, 'ls-files', '--', '.vscode', 'test-results', '.env.local'), '');
    const submittedCode = flow(root, ['submit', 'implementation', '--json'], { allowFailure: true });
    assert.equal(submittedCode.status, 0, submittedCode.stdout + submittedCode.stderr);
    const approvedCode = flow(root, ['approve', 'implementation', '--yes'], { allowFailure: true });
    assert.equal(approvedCode.status, 0, approvedCode.stdout + approvedCode.stderr);
    assert.equal((await read()).phases.implementation.status, 'approved');
    // The workspace's own files are untouched.
    assert.equal(await readFile(path.join(root, '.vscode/settings.json'), 'utf8'), '{ "java.configuration.updateBuildConfiguration": "automatic" }\n');
    assert.equal(await readFile(path.join(root, '.env.local'), 'utf8'), 'LEDGER_REGION=local\n');
  });

test('the hard stops stay: a clause with no test is refused [WCB:REQ-001]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const W = 'WCB-2';
    const { root, write, item, read } = await story(t, W);
    flow(root, ['submit', 'intake']);
    flow(root, ['approve', 'intake', '--yes']);
    // No code was committed while Intake was open: the code step starts where it always did, not at the Story's base.
    const opened = await read();
    assert.notEqual(opened.workIntervals.current.sourceBaseCommit, opened.workItem.baseCommit);
    flow(root, ['prepare', 'implementation']);
    assert.equal(JSON.parse(await readFile(path.join(root, (await read()).phases.implementation.generationIntent.path), 'utf8')).baseline.mode, 'clean');
    await write('src/value.mjs', `// @clause:${W}:AC-001 returns the approved value\nexport const value = 2;\n`);
    // The planned test no longer names its clause: AC-001 has code and no test case.
    await write('test/value.test.mjs', valueTest(W, 2, false));
    await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), summary(item, W));
    const refused = flow(root, ['phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place', '--json'], { allowFailure: true });
    assert.notEqual(refused.status, 0, refused.stdout);
    const error = json(refused).error;
    assert.match(JSON.stringify(error), /AC-001/u, refused.stdout);
    assert.equal(error.code, 'CODE_DELIVERY_EVIDENCE_REQUIRED', refused.stdout);
    assert.equal((await read()).phases.implementation.status, 'in_progress');
  });

test('a Story with no code step: code left in its checkout is listed at its approval as not part of it, and code committed on it waits until the Decide page takes the commit out [WCB:REQ-017]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const W = 'WCB-3';
    // A workflow with no code step, as a docs, investigate or review task is.
    const root = await repository(t, (config) => {
      config.workTypes['notes-only'] = { label: 'Notes only', description: 'An intake note; it changes no code.', phases: ['intake'],
        sourceReview: { mode: 'off' } };
    });
    const write = async (relative, contents) => writeFile(path.join(root, relative), contents);
    await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
    execute('mkdir', ['-p', 'src', 'test'], root);
    await write('src/value.mjs', 'export const value = 1;\n');
    await write('test/value.test.mjs', valueTest(W, 1, false));
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'value module');
    git(root, 'push', '-q', 'origin', 'main');
    const readiness = json(flow(root, ['precheck', '--run', '--scope', 'dependency-test', '--json'])).data.plan;
    flow(root, ['precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json']);
    flow(root, ['start', W, '--from-branch', 'main', '--work-type', 'notes-only', '--title', 'Note the value', '--description', 'Say why it is 1.']);
    const item = path.join(root, 'singularity/work-items', W);
    const read = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
    const started = await read();
    assert.deepEqual(started.phaseOrder, ['intake']);
    flow(root, ['prepare', 'intake']);
    await writeFile(path.join(item, 'artifacts/intake/intake.md'), [`# ${W} — Intake`, '', '## Request', '',
      'Write down why the value module returns 1, for the team that reads it next.', '', '## Scope and urgency', '',
      'Only the note; no code changes. Not urgent.', '', '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
      `| [${W}:AC-001] | The note says why the value module returns 1. |`, '', '## Initial evidence', '', 'src/value.mjs exports the value 1.', ''].join('\n'));
    flow(root, ['wm', 'compose', '--phase', 'intake']);
    flow(root, ['clarification', 'record', 'intake', '--question', 'Is a note enough?', '--answer', 'Yes.']);
    flow(root, ['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place']);

    // A scratch file stays in the checkout; a commit of code would reach the pull request with nothing checking it.
    await write('src/scratch.mjs', 'export const scratch = true;\n');
    await write('src/value.mjs', 'export const value = 3;\n');
    git(root, 'commit', '-q', '-am', 'try another value');
    const refused = flow(root, ['submit', 'intake', '--json'], { allowFailure: true });
    assert.notEqual(refused.status, 0, refused.stdout);
    const error = json(refused).error;
    assert.equal(error.code, 'PHASE_SOURCE_CHANGED_AFTER_PUBLICATION', refused.stdout);
    // It names the take-out, and its one route is the Decide page, a person's step.
    assert.deepEqual(error.details.changedPaths, ['src/value.mjs'], refused.stdout.slice(0, 3000));
    assert.match(error.message, /which has no step that checks code against a clause and a test\. Take the commit out \(git revert --no-edit [0-9a-f]{12}\)/u);
    assert.equal(error.details.nextAction, `singularity-flow decisions ${W}`);
    assert.deepEqual(json(refused).remediationPlan.steps.filter((entry) => entry.kind === 'remediation').map((entry) => [entry.command, entry.skill]),
      [[`singularity-flow decisions ${W}`, '/sf-decide']]);
    // The Decide page has the row the refusal names, with the one step that clears it.
    const list = json(flow(root, ['decisions', W, '--json'])).data;
    const row = list.items.find((entry) => entry.kind === 'generation-rollover' && entry.details.committedCode);
    assert.ok(row, JSON.stringify(list.items.map((entry) => entry.kind)));
    assert.deepEqual(row.options.map((option) => option.id), ['take-out']);
    const takeOut = row.options[0].action.command;
    assert.match(takeOut, /^git revert --no-edit [0-9a-f]{12}$/u);
    git(root, ...takeOut.split(' ').slice(1));
    // Taken out, the step is submitted; its approval lists the scratch file as not part of the task and leaves it.
    const submitted = flow(root, ['submit', 'intake', '--json'], { allowFailure: true });
    assert.equal(submitted.status, 0, submitted.stdout);
    const approval = json(flow(root, ['decisions', W, '--json'])).data.items.find((entry) => entry.kind === 'approval');
    assert.deepEqual(approval.details.notPartOfTask, ['src/scratch.mjs']);
    assert.ok(approval.details.lines.some((line) => /^Not part of this task: src\/scratch\.mjs, left in your checkout/u.test(line)), JSON.stringify(approval.details.lines));
    const approved = flow(root, ['approve', 'intake', '--yes'], { allowFailure: true });
    assert.equal(approved.status, 0, approved.stdout + approved.stderr);
    assert.equal(await readFile(path.join(root, 'src/scratch.mjs'), 'utf8'), 'export const scratch = true;\n');
  });

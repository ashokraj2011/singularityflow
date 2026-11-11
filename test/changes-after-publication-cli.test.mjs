/**
 * N7 (seen live 2026-11-11): a code step's own uncommitted edit to a file no plan names (index.html), made
 * after the step was published, passed submission and first showed at approval, as a checkout hold whose
 * route was /sf-recover. Submission, the readiness and next-step answers that offer it, and approval now see
 * the change in the step, with its in-step repair first: start the next draft that includes the change (the
 * person confirms it), or the person sets the change aside.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { approvedSpecificationStory, implementationPlan, CLI } from './helpers/submitted-planning-story.mjs';
import { agentAct } from '../src/agent-output.mjs';

const WORK = 'N7-1';

async function publishedCodeStory(t) {
  const story = await approvedSpecificationStory(t, WORK);
  const { root, cli, item } = story;
  const write = async (relative, text) => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), text); };
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks'); cli('approve', 'planning', '--yes');
  cli('prepare', 'implementation');
  const clauses = [`${WORK}:AC-001`, `${WORK}:REQ-002`];
  await write('src/value.mjs', `${clauses.map((clause) => `// @clause:${clause} returns the approved value to its callers\n`).join('')}export const value = 1;\n`);
  await write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n${clauses.map((clause) => `// @ac:${clause}\n`).join('')}test('value', () => assert.ok(value >= 1));\n`);
  await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), ['# Implementation summary', '', '## Agent brief', '',
    'Added the value module; both clauses have one focused test that reads the approved value.', '', '## Changed components and decisions', '',
    '- `src/value.mjs` exports the approved value.', '', '## Tests and operational notes', '', '`test/value.test.mjs` verifies the value.', ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/implementation/operator-notes.md'), ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place', '--json');
  return { ...story, write };
}

const json = (result) => JSON.parse(result.stdout);
const workflowOf = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));

test('an unplanned edit after Code is published is refused at submit with the next draft first, and that draft takes it', async (t) => {
  const story = await publishedCodeStory(t);
  const { cli, run, item, git } = story;
  const publishedHead = git('rev-parse', 'HEAD');
  await story.write('index.html', '<p>hello</p>\n');
  const before = await workflowOf(item);

  // Submission refuses, before anything opens, with the step's own repair first: never recover, never ready.
  const refused = run(process.execPath, [CLI, '--no-model', 'submit', 'implementation', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  const result = JSON.parse(refused.stdout);
  assert.equal(result.error.code, 'CODE_CHANGED_AFTER_PUBLICATION', refused.stdout.slice(0, 2000));
  assert.deepEqual(result.error.details.paths, ['index.html']);
  assert.match(result.error.message, /implementation draft 1 is published, and index\.html is changed in this checkout/u);
  const [include, aside] = result.remediationPlan.steps;
  assert.equal(include.command, 'singularity-flow phase rollover implementation --json', JSON.stringify(result.remediationPlan.steps));
  assert.equal(include.copilotCommand, '/sf-code implementation');
  assert.match(include.label, /start draft 2 of implementation that includes index\.html/u);
  assert.match(aside.command, /^singularity-flow recover N7-1 --phase implementation --set-aside --confirm sha256:[a-f0-9]{64} --json/u);
  assert.match(aside.label, /the person sets index\.html aside in their own terminal/u);
  const act = agentAct(result);
  assert.equal(act.do.shell, 'singularity-flow phase rollover implementation --json');
  assert.equal(git('rev-parse', 'HEAD'), publishedHead, 'nothing was committed');
  assert.deepEqual(await workflowOf(item), before, 'nothing was submitted');

  // The readiness and next-step answers that offered submit lead with the same repair.
  const readiness = json(cli('status', '--submission-readiness', '--json'));
  const answer = readiness.submissionReadiness ?? readiness;
  assert.equal(answer.classification, 'changed-after-publication', JSON.stringify(answer).slice(0, 1500));
  assert.equal(answer.lifecycleReady, false);
  assert.equal(answer.nextCommand, 'singularity-flow phase rollover implementation --json');
  const next = json(cli('nextsteps', '--json'));
  const now = next.actions.find((entry) => entry.timing === 'now');
  assert.equal(now.command, 'singularity-flow phase rollover implementation --json', JSON.stringify(next.actions));
  assert.ok(!next.actions.some((entry) => entry.timing === 'now' && /^singularity-flow submit /u.test(entry.command)));
  // /sf-code leads with that preview too.
  const entry = json(cli('phase', 'enter', '--compose', '--for-agent', '--json'));
  assert.equal(entry.act.do.shell, 'singularity-flow phase rollover implementation --json', JSON.stringify(entry.act));

  // The next draft starts with the change once the person confirms; draft 1 stays as published.
  const preview = json(cli('phase', 'rollover', 'implementation', '--json'));
  assert.deepEqual([preview.fromGeneration, preview.toGeneration], [1, 2]);
  assert.match(preview.confirmation, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(await workflowOf(item), before);
  const opened = json(cli('phase', 'rollover', 'implementation', '--confirm', preview.confirmation, '--json'));
  assert.equal(opened.generationIntent.generation, 2);
  assert.equal(opened.generationIntent.baseline.mode, 'adopted');
  assert.equal(await readFile(path.join(story.root, 'index.html'), 'utf8'), '<p>hello</p>\n');
  assert.equal(JSON.parse(git('show', `${publishedHead}:singularity/work-items/${WORK}/workflow.json`)).phases.implementation.generation, 1);
});

test('an unplanned edit made after submission holds approval with the same in-step repair, never recovery first', async (t) => {
  const story = await publishedCodeStory(t);
  const { cli, run } = story;
  cli('submit', 'implementation');
  await story.write('index.html', '<p>hello</p>\n');

  const refused = run(process.execPath, [CLI, '--no-model', 'approve', 'implementation', '--yes', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  const result = JSON.parse(refused.stdout);
  assert.equal(result.error.code, 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED');
  assert.deepEqual(result.error.details.paths, ['index.html']);
  const [first, ...rest] = result.remediationPlan.steps;
  assert.equal(first.command, 'singularity-flow reject implementation --work-id N7-1 --to implementation --reason <REASON>', JSON.stringify(result.remediationPlan.steps));
  assert.equal(first.copilotCommand, '/sf-reject');
  assert.match(first.label, /returns it to itself, and its author makes draft 2 with index\.html/u);
  assert.ok(rest.some((entry) => /--set-aside --confirm sha256:/u.test(entry.command ?? '')), JSON.stringify(rest));
  assert.ok(!/sf-recover/u.test(first.copilotCommand ?? ''));

  // The approval preview and the decision list name that route for the hold, not recovery.
  const next = json(cli('nextsteps', '--json'));
  assert.equal(next.pending.next.command, 'singularity-flow reject implementation --work-id N7-1 --to implementation --reason <REASON>', JSON.stringify(next.pending));
  assert.notEqual(next.pending.next.copilotCommand, '/sf-recover N7-1');
});

test('a file committed after Code is published is refused at submit with the next draft first, and that draft takes it', async (t) => {
  const story = await publishedCodeStory(t);
  const { cli, run, git } = story;
  await story.write('src/extra.mjs', 'export const extra = true;\n');
  git('add', 'src/extra.mjs');
  git('commit', '-qm', 'An edit after publication');

  const refused = run(process.execPath, [CLI, '--no-model', 'submit', 'implementation', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  const result = JSON.parse(refused.stdout);
  assert.equal(result.error.code, 'CODE_CHANGED_AFTER_PUBLICATION', refused.stdout.slice(0, 2000));
  assert.deepEqual(result.error.details.paths, ['src/extra.mjs']);
  assert.match(result.error.message, /src\/extra\.mjs was committed since/u);
  assert.equal(result.remediationPlan.steps[0].command, 'singularity-flow phase rollover implementation --json');
  // Nothing uncommitted to set aside: the next draft is the way to keep it.
  assert.ok(!result.remediationPlan.steps.some((entry) => /--set-aside/u.test(entry.command ?? '')), JSON.stringify(result.remediationPlan.steps));
  const preview = json(cli('phase', 'rollover', 'implementation', '--json'));
  assert.deepEqual([preview.fromGeneration, preview.toGeneration], [1, 2]);
  const opened = json(cli('phase', 'rollover', 'implementation', '--confirm', preview.confirmation, '--json'));
  assert.equal(opened.generationIntent.generation, 2);
});

// ITW REQ-114 (docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md): `work --start` takes what VS Code's Start Story gives a task (its
// title and words, its Story branch, its bases, its documents with their names and where each is kept, its own checkout,
// or a GitHub Issue as its source) and hands each to `start` as start's own option; the likely plan reads the same words.
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { EMPTY_INTAKE_FORM, taskIntakeCommand, taskPlanCommand } from '../apps/vscode/src/views/intake-form.ts';
import { TASK_START_OPTIONS } from '../src/commands/work.mjs';
import { journeyRepository } from './helpers/route-follower.mjs';

const json = (text) => { const value = JSON.parse(text); return value.data ?? value; };
const GITHUB_HOST = ['github', 'com'].join('.');
const form = (overrides = {}) => ({
  ...EMPTY_INTAKE_FORM, shape: 'story', tracker: 'none', startMode: 'task', id: 'TASK-7', title: 'Make the value module return 2',
  description: 'The value module returns 1; its callers want 2.', baseBranch: 'main', basePreflightPassed: true,
  baseRepositories: [{ id: 'repository', defaultBranch: 'main', branches: ['main'] }],
  baseBranchChoices: [{ branch: 'main', present: 1, total: 1, everywhere: true, missingFrom: [] }], ...overrides
});

/** A repository whose policy lets a Story's documents be committed to Git as well as kept on this machine. */
const bothStorages = (configuration) => { configuration.documents = { ...(configuration.documents ?? {}), storage: { allowed: ['git', 'local'], default: 'local' } }; };
/** The form once it read the likely plan: where documents may be kept is the task's policy. */
const plannedForm = (overrides = {}) => ({ ...form(overrides), taskPlan: { key: '', text: null, why: null, kindNeeded: false, documentStorage: { allowed: ['git', 'local'], default: 'local' } } });

test('ITW REQ-114: the likely plan reads Start Story\'s title and words, and says where a task\'s documents may be kept', async (t) => {
  const story = await journeyRepository(t, { configure: bothStorages });
  const likely = JSON.parse(story.cli(...taskPlanCommand(form())));
  assert.equal(likely.resultType, 'sflow-task-likely-plan');
  assert.equal(likely.kind, 'change', 'the title says "make"');
  assert.match(likely.plan, /^Plan: requirement → implement and test → SFlow runs the tests\./u);
  assert.deepEqual(likely.documentStorage, { allowed: ['git', 'local'], default: 'local' });
  // The title alone can say the kind: "fix" is in the title, not in the words.
  const fix = JSON.parse(story.cli(...taskPlanCommand(form({ title: 'Fix the value module', description: 'It returns 1 where 2 is wanted.' }))));
  assert.equal(fix.kind, 'fix');
  // Words that do not say the kind ask it, and still say where documents may be kept; no words ask nothing.
  const unknown = JSON.parse(story.cli(...taskPlanCommand(form({ title: 'Value module', description: 'The value module and its callers.' }))));
  assert.deepEqual([unknown.plan, unknown.kindNeeded, unknown.documentStorage?.default], [null, true, 'local']);
  const none = JSON.parse(story.cli('work', '--plan-only', '--json'));
  assert.deepEqual([none.plan, none.kindNeeded, none.documentStorage?.allowed], [null, undefined, ['git', 'local']]);
  assert.equal(story.git('status', '--porcelain'), '', 'a likely plan writes nothing');
});

test('ITW REQ-114: work --start takes the form\'s branch, base and documents, and starts the task in a checkout of its own', async (t) => {
  const story = await journeyRepository(t, { configure: bothStorages });
  const brief = path.join(story.base, 'value-brief.md');
  await writeFile(brief, '# Value brief\n\nCallers read the value module and want 2.\n');
  assert.deepEqual(TASK_START_OPTIONS, ['ref', 'from-branch', 'document-name', 'document-store', 'acceptance-criteria', 'address', 'github', 'jira', 'isolated-worktree']);
  const args = taskIntakeCommand(plannedForm({ storyBranch: 'feature/TASK-7-value', acceptanceCriteria: 'The value module returns 2',
    storyAttachments: [{ sourcePath: brief, displayName: 'value-brief.md', name: 'Value brief', store: 'git' }, null, null, null] }));
  const started = json(story.cli(...args));
  assert.equal(started.id, 'TASK-7');
  assert.ok(path.isAbsolute(started.repositoryPath) && started.repositoryPath !== story.root, `its own checkout: ${started.repositoryPath}`);
  assert.match(started.task.plan, /^Plan: requirement → implement and test → SFlow runs the tests\./u);
  // The launch checkout is left as it was.
  assert.equal(story.git('branch', '--show-current'), 'main');
  assert.equal(story.git('status', '--porcelain'), '');
  // The Story is on the branch the form named, cut from the base it chose, composed by SFlow: no workflow was chosen.
  const shown = (relative) => story.git('show', `feature/TASK-7-value:singularity/work-items/TASK-7/${relative}`);
  const record = JSON.parse(shown('workflow.json'));
  assert.equal(record.workItem.workType, 'task-change');
  assert.equal(record.workItem.baseBranch, 'main');
  assert.equal(record.workItem.title, 'Make the value module return 2');
  assert.equal(record.resolution.composition.sizing, 'requirement');
  assert.deepEqual(record.phaseOrder, ['intake', 'implementation', 'verification']);
  // The words, what SFlow asks of the requirement, and the acceptance criteria are the Story's; the title is not repeated.
  const intake = shown('USER-STORY.md');
  assert.match(intake, /^# TASK-7 — Make the value module return 2$/mu);
  assert.match(intake, /## Description\n\nThe value module returns 1; its callers want 2\.\n\n## How SFlow sizes this task/u);
  assert.match(intake, /## Acceptance criteria\n\n[^#]*The value module returns 2/u);
  assert.equal(intake.split('Make the value module return 2').length - 1, 1);
  // The document, by the name the form gave it, kept in Git as it chose, read by every step.
  const documents = JSON.parse(shown('documents.json')).documents;
  assert.deepEqual(documents.map((entry) => [entry.name, entry.storage.kind]), [['Value brief', 'git']]);
  assert.deepEqual(documents[0].phases, record.phaseOrder, 'no step was named: every step of the task reads it');
  // A task open on the launch checkout does not stop a task that starts in a checkout of its own.
  const second = json(story.cli(...taskIntakeCommand(form({ id: 'TASK-8', title: 'Fix the value module', description: 'It returns 1 where 2 is wanted.' }))));
  assert.equal(second.id, 'TASK-8');
});

test('ITW REQ-114: a GitHub Issue is the task\'s source and its words; what SFlow asks of the requirement is in its notes', async (t) => {
  const story = await journeyRepository(t);
  // An issue's Story is found by its identity in the Story list, which its state branch holds.
  story.cli('ledger', 'init');
  // The GitHub CLI, as Start reads an issue through it: one issue, nothing else.
  const bin = path.join(story.base, 'bin');
  await mkdir(bin, { recursive: true });
  const issue = { id: 9001, number: 12, title: 'The checkout is broken on an empty cart', body: 'Opening checkout with an empty cart crashes the page.\n\n- [ ] An empty cart shows a message', html_url: 'https://github.example/acme/shop/issues/12', labels: [{ name: 'bug' }] };
  await writeFile(path.join(bin, 'gh'), `#!/usr/bin/env node\nif (process.argv.slice(2).join(' ') !== 'api --hostname ${GITHUB_HOST} repos/acme/shop/issues/12') { process.stderr.write('unexpected gh call'); process.exit(2); }\nprocess.stdout.write(${JSON.stringify(JSON.stringify(issue))});\n`);
  await chmod(path.join(bin, 'gh'), 0o755);
  story.env.PATH = `${bin}${path.delimiter}${story.env.PATH}`;
  const args = taskIntakeCommand(form({ tracker: 'github', id: 'GH-12', key: 'acme/shop#12', title: '', description: '' }));
  assert.ok(!args.includes('--title') && !args.includes('--description'));
  const started = json(story.cli(...args));
  assert.equal(started.id, 'GH-12');
  const shown = (relative) => story.git('show', `GH-12:singularity/work-items/GH-12/${relative}`);
  const record = JSON.parse(shown('workflow.json'));
  assert.equal(record.workItem.workType, 'task-fix', 'the issue\'s words say "broken"');
  assert.equal(record.workItem.title, 'The checkout is broken on an empty cart');
  const source = JSON.parse(shown('source.json'));
  assert.equal(source.type, 'github-issue');
  assert.equal(source.stableId, `github-issue:${GITHUB_HOST}/acme/shop#12`);
  assert.match(source.notes, /^## How SFlow sizes this task/u);
  const intake = shown('USER-STORY.md');
  assert.match(intake, /## Description\n\nOpening checkout with an empty cart crashes the page\./u);
  assert.match(intake, /## Notes\n\n## How SFlow sizes this task/u);
});

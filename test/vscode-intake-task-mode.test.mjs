// ITW REQ-115 (docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md): VS Code's Start Story starts a task. Beside "Choose a workflow" the
// form offers "Start a task": it asks only for the Story's details, its documents and its branch, shows the likely plan
// under the words, and starts the task with `work --start`; SFlow picks the steps, as /sf-task does.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_INTAKE_FORM, TASK_KIND_CHOICES, intakeCommand, intakeHtml, intakeProblems, storyPreflightCommand, taskBlocker, taskDefaultBase, taskIntakeCommand,
  taskKindOf, taskMode, taskModeOffered, taskPlanCommand, taskPlanFrom, taskPlanKey, taskStartAnswer
} from '../apps/vscode/src/views/intake-form.ts';
import { intakeWizardNavigation } from '../apps/vscode/src/views/intake-wizard.ts';
import { STORY_START_TASK_TURN_KEY, storyStartTaskTurn, storyStartTaskTurnDue } from '../apps/vscode/src/story-start-handoff.ts';
import { TASK_KINDS } from '../src/task-composition.mjs';

const PLAN = 'Plan: requirement → implement and test → SFlow runs the tests. You approve the requirement and the code. Small or big is decided with the requirement. Say "add a design step" to change it.';
const form = (overrides = {}) => ({
  ...EMPTY_INTAKE_FORM, shape: 'story', tracker: 'none', startMode: 'task', id: 'TASK-7', title: 'Make the value module return 2',
  description: 'The value module returns 1; its callers want 2.', targetRepository: '/work/shop', targetWorkspace: 'shop',
  storyWorkflows: [{ id: 'feature', label: 'Feature', description: '', phases: ['intake', 'implementation'], documentStorage: { allowed: ['git', 'local'], default: 'local' } }],
  workType: 'feature', baseRemote: 'origin', baseBranch: 'main', baseRepositories: [{ id: 'shop', defaultBranch: 'main', branches: ['main'] }],
  baseBranchChoices: [{ branch: 'main', present: 1, total: 1, everywhere: true, missingFrom: [] }], basePreflightPassed: true, ...overrides
});
const withPlan = (value, overrides = {}) => { const draft = form(overrides); return { ...draft, taskPlan: taskPlanFrom(value, taskPlanKey(draft)) }; };
const planned = (overrides = {}) => withPlan({ resultType: 'sflow-task-likely-plan', kind: 'change', plan: PLAN,
  documentStorage: { allowed: ['git', 'local'], default: 'local' } }, overrides);
const after = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const document = { sourcePath: '/work/brief.md', displayName: 'brief.md', name: 'Value brief', store: 'git', phases: ['implementation'] };

test('ITW REQ-115: Start Story offers a task beside the workflow, each saying what it does; the workflow stays the default', () => {
  assert.equal(EMPTY_INTAKE_FORM.startMode, 'workflow', 'today\'s default');
  const html = intakeHtml(form({ startMode: 'workflow' }));
  assert.match(html, /<h2>How should this Story run\?<\/h2>/u);
  assert.match(html, /data-start-mode="workflow" checked[^]*Choose a workflow<\/span>[^]*You pick the exact steps your team defined\./u);
  assert.match(html, /data-start-mode="task"[^>]*>[^]*Start a task<\/span>[^]*SFlow picks the steps from what you describe: the requirement first, then the code and its tests\./u);
  // Workflow mode is unchanged: the workflow picker, the phases, the checks.
  assert.match(html, /data-work-type="feature"/u);
  assert.match(html, /Testing &amp; quality gates|Testing & quality gates/u);
  // Only a new Story: a clone and a Story from a reviewed specification keep their workflow, an Epic has none.
  assert.equal(taskModeOffered(form()), true);
  assert.equal(taskModeOffered(form({ cloneFrom: 'STORY-1' })), false);
  assert.equal(taskModeOffered(form({ cloneSpecifications: ['SPEC-1@3'] })), false);
  assert.equal(taskModeOffered(form({ shape: 'epic' })), false);
  assert.doesNotMatch(intakeHtml(form({ shape: 'epic' })), /How should this Story run/u);
  assert.equal(taskMode(form({ cloneFrom: 'STORY-1' })), false, 'a clone with a remembered task choice is a workflow Story');
});

test('ITW REQ-115: a task asks for its details, branch and documents only; documents are read by every step', () => {
  const html = intakeHtml(planned({ storyAttachments: [document, null, null, null] }));
  // Nothing that exists only because of a chosen workflow.
  assert.doesNotMatch(html, /data-work-type=|Story workflow<\/h2>|data-attachment-phase|Used in phases|Reference repositories|Browser readiness|data-field="targetUrl"/u);
  assert.doesNotMatch(html, /Testing &amp; quality gates|Testing & quality gates|data-quality-gate-mode|data-readiness-baseline|Test execution scope/u);
  // Each field that stays says why it is there.
  assert.match(html, /The ID names the Story and its branch; the title is how lists show it\./u);
  assert.match(html, /<span>What do you want done\? <span class="sf-required">\(required\)<\/span><\/span>/u);
  assert.match(html, /Optional\. SFlow's requirement turns each line into a numbered clause with its test\./u);
  assert.match(html, /Every step of the task reads it\./u);
  assert.match(html, /data-attachment-store="0"[^]*<option value="git" selected>Committed to Git/u, 'where it is kept, as the task\'s workflow allows');
  // The workflow's place says who picks the steps, and the workflow is one click away.
  assert.match(html, /<h2>[^<]*(?:<[^>]+>[^<]*)*Steps<\/h2>[^]*SFlow picks the steps from what you described, so there is no workflow to choose\./u);
  assert.match(html, /data-start-mode-switch="workflow">Choose a workflow instead<\/button>/u);
  // The base and the Story branch stay, with what they are for; the base is the default branch until the person says.
  assert.match(html, /data-base-branch="main" checked/u);
  assert.match(html, /SFlow starts a task from the repository's default branch, as \/sf-task does; choose another if the work starts elsewhere\./u);
  assert.equal(taskDefaultBase(form({ baseBranch: null, baseLaunchRepository: 'shop' })), 'main');
  assert.equal(taskDefaultBase(form({ baseBranch: null, startMode: 'workflow' })), null, 'a workflow\'s base stays the person\'s explicit choice');
  assert.equal(taskDefaultBase(form({ baseBranch: null, baseRepositories: [{ id: 'shop', defaultBranch: 'trunk', branches: ['trunk'] }] })), null,
    'never a branch the form does not offer');
  assert.match(intakeHtml(form({ startMode: 'workflow' })), /Choose explicitly\. The new Story branch is cut from the latest remote commit/u);
  assert.match(html, /data-field="storyBranch"/u);
  assert.match(html, /The branch is ready: create <code>TASK-7<\/code>/u);
  // The review says the same, and the Start button starts the task.
  assert.match(html, /<h3>Steps &amp; branch<\/h3>|<h3>Steps & branch<\/h3>/u);
  assert.match(html, /<dd>SFlow picks them from what you described\./u);
  assert.match(html, /Value brief — kept in Git · every step/u);
  assert.match(html, /<dt>Checks<\/dt><dd>SFlow's own: hard quality gates, and it runs the tests itself\.<\/dd>/u);
  assert.match(html, />\s*Start the task\s*<\/button>/u);
  // A task can start from any step once nothing is missing: the review is there to read, not a step to click through.
  assert.match(html, /<span data-intake-wizard-final="always"><button type="button" data-submit="start"/u);
  assert.match(intakeHtml(form({ startMode: 'workflow' })), /<span data-intake-wizard-final hidden>/u);
  assert.match(html, /Starts task <code>TASK-7<\/code> in a checkout of its own; Copilot chat then carries it on\./u);
  // The wizard's steps are named for what a task asks.
  assert.match(intakeWizardNavigation(true, true), /data-intake-wizard-label="Branch"[^]*data-intake-wizard-label="Documents"/u);
  assert.match(intakeWizardNavigation(true, false), /data-intake-wizard-label="Workflow &amp; branch"|data-intake-wizard-label="Workflow & branch"/u);
});

test('ITW REQ-115: the likely plan is one line under the words, in the Work place\'s words, read again when they change', () => {
  const draft = form();
  assert.deepEqual(taskPlanCommand(draft), ['work', '--plan-only', '--json', '--title', 'Make the value module return 2', '--description', 'The value module returns 1; its callers want 2.']);
  assert.equal(taskPlanCommand(form({ startMode: 'workflow' })), null, 'a workflow Story reads no plan');
  assert.deepEqual(taskPlanCommand(form({ description: '  ' })), ['work', '--plan-only', '--json'], 'no words: only where documents may be kept');
  assert.deepEqual(taskPlanCommand(form({ tracker: 'github', key: 'acme/shop#12' })), ['work', '--plan-only', '--json'],
    'an issue\'s words are read on Start; only where its documents may be kept is asked');
  assert.notEqual(taskPlanKey(form({ description: 'other words' })), taskPlanKey(draft), 'other words, another plan');
  const plan = planned();
  assert.equal(plan.taskPlan.text, 'Likely plan: requirement → implement and test → SFlow runs the tests. You approve the requirement and the code. Small or big is decided with the requirement.');
  assert.deepEqual(plan.taskPlan.documentStorage, { allowed: ['git', 'local'], default: 'local' });
  const html = intakeHtml(plan);
  const description = html.indexOf('data-field="description"');
  const line = html.indexOf('Likely plan: requirement → implement and test');
  const criteria = html.indexOf('data-field="acceptanceCriteria"');
  assert.ok(description > 0 && line > description && line < criteria, 'the line is under the words');
  // An answer for older words is not shown as theirs.
  const stale = { ...form({ description: 'other words' }), taskPlan: plan.taskPlan };
  assert.match(intakeHtml(stale), /Reading the steps SFlow will take…/u);
  assert.match(intakeHtml(form({ description: '' })), /Say what you want done; SFlow shows the steps it will take here\./u);
  assert.match(intakeHtml(form({ tracker: 'jira', key: 'ENG-7' })), /SFlow reads the issue when you press Start and picks the steps from it\./u);
});

test('ITW REQ-115: words that do not say the kind show the kinds, a change chosen until the person says otherwise', () => {
  assert.deepEqual(TASK_KIND_CHOICES.map((entry) => entry.id).sort(), [...TASK_KINDS].sort(), 'the engine\'s nine kinds');
  const unknown = withPlan({ resultType: 'sflow-task-likely-plan', kind: null, plan: null, kindNeeded: true, why: 'SFlow cannot tell the kind of task from these words; the chat names it.' },
    { title: 'Value module', description: 'The value module and its callers.' });
  assert.equal(taskKindOf(unknown), 'change');
  const html = intakeHtml(unknown);
  assert.match(html, /SFlow cannot tell the kind of task from these words, so it starts it as a change\. Choose another kind below if it is not one\./u);
  assert.match(html, /<select data-task-kind><option value="change" selected>A change: SFlow sizes it from its requirement<\/option>/u);
  assert.equal(after(taskIntakeCommand(unknown), '--kind'), 'change', 'Start says the kind it showed');
  // The person's choice is the kind, and the plan is read for it.
  const chosen = { ...unknown, taskKind: 'investigate' };
  assert.equal(after(taskIntakeCommand(chosen), '--kind'), 'investigate');
  assert.equal(after(taskPlanCommand(chosen), '--kind'), 'investigate');
  assert.match(intakeHtml(chosen), /<option value="investigate" selected>An investigation: a report, no code<\/option>/u);
  // Words that say it: no kind is asked, and SFlow reads it from them.
  assert.equal(taskKindOf(planned()), null);
  assert.doesNotMatch(intakeHtml(planned()), /data-task-kind/u);
  assert.equal(after(taskIntakeCommand(planned()), '--kind'), null);
});

test('ITW REQ-115: Start is work --start with the details, the branch, the bases and each document\'s name and storage', () => {
  const draft = planned({ storyBranch: 'feature/TASK-7-value', acceptanceCriteria: 'The value module returns 2',
    storyAttachments: [document, { sourcePath: '/work/notes.txt', displayName: 'notes.txt', name: 'Notes', store: 'local' }, null, null] });
  const args = intakeCommand(draft);
  assert.deepEqual(args, taskIntakeCommand(draft), 'Start Story\'s command is the task\'s in task mode');
  assert.deepEqual(args, ['work', '--start', '--json', '--isolated-worktree', '--work-id', 'TASK-7',
    '--title', 'Make the value module return 2', '--description', 'The value module returns 1; its callers want 2.', '--acceptance-criteria', 'The value module returns 2',
    '--from-branch', 'main', '--ref', 'feature/TASK-7-value',
    '--document', '/work/brief.md', '--document-name', 'Value brief', '--document-store', 'git',
    '--document', '/work/notes.txt', '--document-name', 'Notes', '--document-store', 'local']);
  assert.ok(!args.includes('--work-type') && !args.includes('--document-phases'), 'no workflow, and every step reads each document');
  // A document kept where the task's policy does not allow is kept where it allows.
  const localOnly = withPlan({ resultType: 'sflow-task-likely-plan', plan: PLAN, documentStorage: { allowed: ['local'], default: 'local' } }, { storyAttachments: [document, null, null, null] });
  assert.equal(after(taskIntakeCommand(localOnly), '--document-store'), 'local');
  // An issue is the task's source: its key, or its reference, and no typed words.
  const jira = taskIntakeCommand(form({ tracker: 'jira', key: 'ENG-142' }));
  assert.deepEqual(jira.slice(0, 7), ['work', '--start', '--json', '--isolated-worktree', '--work-id', 'ENG-142', '--jira']);
  assert.ok(!jira.includes('--title') && !jira.includes('--description'));
  const github = taskIntakeCommand(form({ tracker: 'github', id: 'GH-12', key: 'acme/shop#12' }));
  assert.deepEqual(github.slice(4, 8), ['--work-id', 'GH-12', '--github', 'acme/shop#12']);
  // Workflow mode is today's start, unchanged.
  const workflow = intakeCommand(form({ startMode: 'workflow' }));
  assert.equal(workflow[0], 'start');
  assert.equal(after(workflow, '--work-type'), 'feature');
  // The readiness check names no workflow for a task, and uses start's own defaults.
  const preflight = storyPreflightCommand(form({ readinessBaseline: 'run', qualityGateMode: 'soft' }));
  assert.ok(!preflight.includes('--work-type') && !preflight.includes('--mint-intake-receipt'), preflight.join(' '));
  assert.equal(after(preflight, '--readiness-baseline'), 'reuse');
  assert.equal(after(preflight, '--gate-mode'), 'hard');
  assert.equal(after(preflight, '--title'), 'Make the value module return 2', 'the branch pattern may use the title');
});

test('ITW REQ-115: a task needs no workflow; where it cannot start it says why in one line, beside the way on', () => {
  // No workflow chosen, none listed, a workflow-only baseline choice: none of it stops a task.
  const ready = planned({ workType: null, readinessBaseline: 'run', storyAttachments: [{ ...document, phases: [] }, null, null, null] });
  assert.deepEqual(intakeProblems(ready), []);
  assert.deepEqual(intakeProblems(planned({ storyWorkflows: [], workType: null })), []);
  assert.ok(intakeProblems(planned({ description: '' })).includes('Say what you want done: SFlow picks the steps from it.'));
  assert.ok(intakeProblems(planned({ baseBranch: null })).includes('Choose the remote base branch from which the Story branch will be created.'));
  // Several repositories: a task works in one; the workflow is one click away.
  const several = planned({ baseRepositories: [{ id: 'api', defaultBranch: 'main', branches: ['main'] }, { id: 'web', defaultBranch: 'main', branches: ['main'] }] });
  assert.equal(taskBlocker(several), 'A task works in one repository, and this workspace has 2. Use a workflow to change them together.');
  assert.ok(intakeProblems(several).includes(taskBlocker(several)));
  assert.match(intakeHtml(several), /data-task-blocker>A task works in one repository[^]*<button type="button" data-start-mode-switch="workflow">Choose a workflow<\/button>/u);
  assert.match(intakeHtml(several), /data-focus-field="region:mode"/u, 'the line in Before this can start takes the reader there');
  // A repository that asks a decision about tests failing before work starts: a workflow's form asks it.
  const recovery = planned({ testRecovery: { schemaVersion: 1, enabled: true } });
  assert.match(taskBlocker(recovery), /A workflow's form asks it\.$/u);
  assert.equal(taskBlocker(form({ startMode: 'workflow', testRecovery: { schemaVersion: 1, enabled: true } })), null);
});

test('ITW REQ-115: SFlow\'s questions before a task starts are answered on the form, one click each, and the answer starts it', () => {
  assert.deepEqual(taskStartAnswer({ error: { code: 'TASK_KIND_NEEDED', details: { kinds: [...TASK_KINDS] } } }), { taskKindNeeded: true });
  const needed = { ...form({ tracker: 'jira', key: 'ENG-142' }), taskKindNeeded: true };
  assert.equal(taskKindOf(needed), 'change');
  assert.match(intakeHtml(needed), /The issue does not say what kind of task it is\. Check the kind, then press Start again\./u);
  // A marketplace skill offered for a step: Yes and No, each adding what the chat's answer adds.
  const skill = taskStartAnswer({ error: { code: 'TASK_SKILL_YES_NEEDED', details: { offers: [
    { id: 'pay-lint', ask: 'Use pay-lint for the implement and test step? It is marked stable.', why: 'its marketplace says it checks payment code', yes: '--use-skill pay-lint', no: '--without-skill pay-lint' }] } } });
  assert.deepEqual(skill.taskQuestion, { ask: 'Use pay-lint for the implement and test step? It is marked stable.', why: 'Its marketplace says it checks payment code.',
    yes: ['--use-skill', 'pay-lint'], no: ['--without-skill', 'pay-lint'] });
  const asked = { ...planned(), ...skill };
  assert.ok(intakeProblems(asked).includes('Answer SFlow\'s question below: your answer starts the task.'));
  const html = intakeHtml(asked);
  assert.match(html, /One question before the task starts[^]*Use pay-lint for the implement and test step\?[^]*data-task-answer="yes">Yes, use it<\/button>[^]*data-task-answer="no"[^>]*>No, SFlow picks the steps<\/button>/u);
  assert.deepEqual(taskIntakeCommand({ ...planned(), taskAnswers: ['--without-skill', 'pay-lint'] }).slice(-2), ['--without-skill', 'pay-lint']);
  // One that needs its review first has no Yes here: the task starts with SFlow's steps.
  const agent = taskStartAnswer({ error: { code: 'TASK_AGENT_YES_NEEDED', details: { agentOffer: { ask: 'Use acme\'s qa agent for this task?', why: 'its stages cover it',
    show: 'singularity-flow import preview "market:acme/qa" --as agent --json', yes: '--use-agent acme/qa', no: '--without-agent acme/qa' } } } });
  assert.equal(agent.taskQuestion.yes, null);
  assert.match(intakeHtml({ ...planned(), ...agent }), /It needs a review before any task can use it, so this task starts with SFlow's own steps\.[^]*data-task-answer="no"[^>]*>Start with SFlow's steps<\/button>/u);
  assert.doesNotMatch(intakeHtml({ ...planned(), ...agent }), /data-task-answer="yes"/u);
  // Only an agent, workflow or skill answer is taken from a refusal; any other is shown as the refusal it is.
  assert.equal(taskStartAnswer({ error: { code: 'TASK_SKILL_YES_NEEDED', details: { offers: [{ ask: 'x?', yes: '--use-skill a b', no: '--force' }] } } }), null);
  assert.equal(taskStartAnswer({ error: { code: 'STORY_BRANCH_EXISTS' } }), null);
  assert.equal(taskStartAnswer(null), null);
  // A refusal Start could not get past says where it is fixed, beside its own words.
  assert.match(intakeHtml({ ...planned(), error: 'Document 1 (brief.md) could not be read.' }),
    /could not be read\. <button type="button" class="link" data-focus-field="region:attachments">Show where to fix it<\/button>/u);
});

test('ITW REQ-115: the task goes on in the chat of the window that opens its checkout, once', () => {
  const now = Date.parse('2026-11-28T10:00:00Z');
  const turn = storyStartTaskTurn('/work/shop/.sflow/TASK-7', 'TASK-7', now);
  assert.deepEqual(turn, { schemaVersion: 1, repositoryPath: '/work/shop/.sflow/TASK-7', storyId: 'TASK-7', createdAt: '2026-11-28T10:00:00.000Z' });
  assert.equal(STORY_START_TASK_TURN_KEY, 'singularityFlow.storyStartTaskTurn.v1');
  const story = { workItem: { id: 'TASK-7' } };
  assert.equal(storyStartTaskTurnDue(turn, '/work/shop/.sflow/TASK-7', story, true, now + 5_000), 'send');
  assert.equal(storyStartTaskTurnDue(turn, '/work/shop/.sflow/TASK-7', { workItem: { id: 'OTHER-1' } }, true, now), 'wait', 'its first read is still to come');
  assert.equal(storyStartTaskTurnDue(turn, '/work/shop', story, true, now), 'wait', 'another window\'s');
  assert.equal(storyStartTaskTurnDue(turn, '/work/shop/.sflow/TASK-7', story, false, now), 'wait', 'only a task');
  assert.equal(storyStartTaskTurnDue(turn, '/work/shop/.sflow/TASK-7', story, true, now + 11 * 60_000), 'drop', 'an old one is never sent');
  assert.equal(storyStartTaskTurnDue({ schemaVersion: 2 }, '/work/shop', story, true, now), 'drop');
  assert.equal(storyStartTaskTurn('relative/path', 'TASK-7', now), null);
});

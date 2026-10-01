import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(packageRoot, 'apps', 'vscode', 'src', name);
const {
  decisionChoiceItems, decisionChooseArgv, decisionInputPrompt, decisionTargetText,
  pendingDecisionSummary, submitArgvWithDecisionValues
} = await import(source('decisions.ts'));
const { buildJourney } = await import(source('views/journey-model.ts'));
const { buildTree } = await import(source('views/tree-model.ts'));
const { buildApprovals } = await import(source('views/approvals-model.ts'));
const { buildInbox } = await import(source('views/inbox-model.ts'));

const PENDING = {
  schemaVersion: 1, key: '0123456789abcdef', decision: 'direction', label: 'Where next?', reason: 'ask',
  after: 'requirements', afterLabel: 'Requirements', by: ['product-approvers'], anyStep: true, round: null, maxRounds: null,
  options: [
    { id: 'continue', label: 'Continue', to: 'next', toLabel: 'Design', reach: 'next', skips: [] },
    { id: 'again', label: 'Another round', to: 'requirements', toLabel: 'Requirements', reach: 'backward', skips: [] },
    { id: 'stop', label: 'Finish here', to: 'end', toLabel: 'Finish the Story', reach: 'end', skips: ['design', 'spec'] }
  ]
};

/** A Story waiting at a decision after Requirements, with Spec skipped by an earlier one. */
function waitingSnapshot() {
  const phase = (id, label, status, extra = {}) => ({ id, label, status, generation: status === 'not_started' ? 0 : 1, artifacts: [], approvals: [], ...extra });
  return {
    initiative: null, initiatives: [], selectedInitiativeId: null,
    selectedWorkId: 'STORY-7', workItems: [{ id: 'STORY-7', title: 'Decide well' }],
    identities: { git: { email: 'reviewer@example.com' } },
    workflow: {
      workItem: { id: 'STORY-7', title: 'Decide well', branch: 'STORY-7', workType: 'decide-demo' },
      currentPhase: 'requirements', phaseOrder: ['intake', 'requirements', 'design', 'spec'], status: 'in_progress',
      pendingDecision: { ...PENDING, options: PENDING.options.map(({ id, label, to }) => ({ id, label, to })) },
      phases: {
        intake: phase('intake', 'Intake', 'approved'),
        requirements: phase('requirements', 'Requirements', 'approved'),
        design: phase('design', 'Design', 'not_started'),
        spec: phase('spec', 'Spec', 'skipped', { skippedBy: { decision: 'needs-spec', route: 'small' } })
      }
    },
    decisions: { schemaVersion: 1, workId: 'STORY-7', decisions: [], ahead: null, pending: PENDING, skipped: [], log: [] },
    submissionReadiness: {
      phaseId: 'requirements', phaseStatus: 'approved', classification: 'decision-required', lifecycleReady: false,
      currentGeneration: 1, publishedGeneration: 1, draftExists: true, draftModified: false, publicationRecorded: true,
      nextSkill: '/sf-approve', nextCommand: 'singularity-flow decision show STORY-7', reasonCode: 'DECISION_REQUIRED', decision: PENDING
    }
  };
}

test('a waiting decision offers each option, and each choice is one exact, bound command', () => {
  const items = decisionChoiceItems(PENDING);
  assert.deepEqual(items.map((item) => [item.label, item.description]), [
    ['Continue', 'Design'],
    ['Another round', 'back to Requirements'],
    ['Finish here', 'finish the Story, skipping design, spec'],
    ['Another step…', 'Choose any step of this Story, or finish it']
  ]);
  assert.match(pendingDecisionSummary(PENDING), /^Where next\? Decided by product-approvers\.$/);
  assert.match(pendingDecisionSummary({ ...PENDING, reason: 'limit', maxRounds: 3 }), /All 3 rounds are used/);
  assert.deepEqual(decisionChooseArgv('STORY-7', PENDING, { option: 'stop' }, '  Out of scope  '), [
    'decision', 'choose', 'STORY-7', '--fetch', '--option', 'stop', '--reason', 'Out of scope', '--expected', '0123456789abcdef'
  ]);
  assert.deepEqual(decisionChooseArgv('STORY-7', PENDING, { to: 'design' }, 'Jump'), [
    'decision', 'choose', 'STORY-7', '--fetch', '--to', 'design', '--reason', 'Jump', '--expected', '0123456789abcdef'
  ]);
  assert.equal(decisionTargetText({ to: 'x', toLabel: 'X', reach: 'forward', skips: ['y'] }), 'X, skipping y');
});

test('submitting a phase that feeds a decision fills its value placeholders with the person\'s choices', () => {
  assert.deepEqual(submitArgvWithDecisionValues(
    ['submit', 'intake', '--work-id', 'STORY-7', '--decision', 'risk=<risk>', '--decision', 'size=<size>'],
    { risk: 'high', size: '3' }
  ), ['submit', 'intake', '--work-id', 'STORY-7', '--decision', 'risk=high', '--decision', 'size=3']);
  assert.deepEqual(submitArgvWithDecisionValues(['submit', 'intake'], {}), ['submit', 'intake'], 'no inputs leaves the command as it was');
  const choice = decisionInputPrompt({ name: 'risk', label: 'Risk', type: 'choice', values: ['low', 'high'], decisionLabel: 'Security check' });
  assert.deepEqual([choice.title, choice.choices], ['Security check: Risk', ['low', 'high']]);
  const number = decisionInputPrompt({ name: 'coverage', type: 'number', minimum: 0, maximum: 100 });
  assert.equal(number.choices, null);
  assert.equal(number.validate('85'), null);
  assert.match(number.validate('120'), /at most 100/);
  assert.match(number.validate('many'), /Enter a number/);
});

test('the journey makes the waiting decision its next action and shows skipped phases as skipped', () => {
  const journey = buildJourney(waitingSnapshot());
  assert.equal(journey.nextAction.execution, 'decide');
  assert.equal(journey.nextAction.label, 'Choose what happens next');
  assert.deepEqual(journey.nextAction.argv, ['decision', 'show', 'STORY-7']);
  assert.match(journey.nextAction.reason, /'Where next\?' waits for a person/);
  assert.equal(journey.decision.key, PENDING.key);
  assert.equal(journey.stages.find((stage) => stage.id === 'spec').publicationLabel, 'skipped by a decision (small)');

  const submit = waitingSnapshot();
  delete submit.workflow.pendingDecision;
  submit.decisions.pending = null;
  submit.workflow.currentPhase = 'design';
  submit.workflow.phases.design.status = 'in_progress';
  submit.workflow.phases.design.generation = 1;
  submit.workflow.phases.design.generationPublications = [{ generation: 1, record: { path: 'p.json', sha256: `sha256:${'a'.repeat(64)}` } }];
  submit.decisions.ahead = { decision: 'ready', label: 'Ready?', mode: 'auto', after: 'design', inputs: [], projection: null };
  submit.submissionReadiness = {
    phaseId: 'design', phaseStatus: 'in_progress', classification: 'ready-to-attempt', lifecycleReady: true,
    currentGeneration: 1, publishedGeneration: 1, draftExists: true, draftModified: true, publicationRecorded: true,
    nextSkill: '/sf-submit', nextCommand: 'singularity-flow submit design --work-id STORY-7 --decision ready=<ready>',
    reasonCode: 'SUBMISSION_READY', decisionInputs: [{ name: 'ready', type: 'choice', values: ['yes', 'no'], decision: 'ready', decisionLabel: 'Ready?' }]
  };
  const ready = buildJourney(submit);
  assert.equal(ready.nextAction.label, 'Record the decision values and submit');
  assert.deepEqual(ready.nextAction.decisionInputs.map((input) => input.name), ['ready']);
  assert.match(ready.decisionAhead.text, /'Ready\?' chooses the next step from the values it records/);
});

test('the lifecycle tree, approvals and inbox all route a waiting decision to the choice flow', () => {
  const snapshot = waitingSnapshot();
  const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
  const decide = flatten(buildTree(snapshot)).find((node) => node.id === 'story:requirements:decide');
  assert.ok(decide, 'the tree offers the choice');
  assert.equal(decide.runCommand, 'singularityFlow.decideStory');
  assert.equal(decide.label, 'Choose what happens next: Where next?');
  assert.equal(flatten(buildTree(snapshot)).some((node) => node.id === 'story:requirements:submit'), false, 'nothing to submit while waiting');
  const inbox = buildInbox(snapshot);
  assert.equal(inbox.decision.workId, 'STORY-7');
  assert.equal(inbox.decision.options.length, 3);

  const awaiting = waitingSnapshot();
  delete awaiting.workflow.pendingDecision;
  awaiting.workflow.phases.requirements.status = 'awaiting_approval';
  awaiting.workflow.phases.requirements.approvalPolicy = { authorities: ['product-approvers'], minimum: 1, rejectTo: ['requirements'] };
  awaiting.decisions.pending = null;
  awaiting.decisions.ahead = { decision: 'direction', label: 'Where next?', mode: 'ask', after: 'requirements', inputs: [], projection: null };
  const card = buildApprovals(awaiting).pending[0];
  assert.equal(card.afterApproval, "A person then chooses what happens next ('Where next?').");
  awaiting.decisions.ahead = { ...awaiting.decisions.ahead, mode: 'auto', projection: { kind: 'loop', target: 'intake', text: "'Rework' goes back to Intake until ready is yes (round 1 of 3)." } };
  assert.match(buildApprovals(awaiting).pending[0].afterApproval, /goes back to Intake until ready is yes \(round 1 of 3\)/);
});

test('the host binds each decision control to the exact engine command and asks for a reason', async () => {
  const extension = await readFile(source('extension.ts'), 'utf8');
  assert.match(extension, /client\.run<StoryDecisionView>\(\['decision', 'show', workId, '--json'\]\)/, 'the question is read fresh before choosing');
  assert.match(extension, /validateInput: \(value\) => \(value\.trim\(\) \? null : 'A reason is required\.'\)[\s\S]{0,400}command: decisionChooseArgv\(workId, pending, choice, reason\)/);
  assert.match(extension, /'singularityFlow\.decideStory': async \(target\?: unknown\) =>/);
  const manifest = JSON.parse(await readFile(source('../package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.decideStory'));
});

/**
 * Who does what, where, in each step (src/workflow-step-people.mjs): on every packaged workflow, and
 * for a team whose custom requirements approval had to run in the approver's own terminal, which
 * nobody knew until the agent said so mid-approval (2026-11-11).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { OWN_TERMINAL_STEPS } from '../src/person-step-catalog.mjs';
import { STEP_PEOPLE_ITEMS, workflowStepPeople } from '../src/workflow-step-people.mjs';

const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const WORKFLOW = 'singularity/workflow.yml';
const LINE_WORDS = ['Author:', 'Questions:', 'Review:', 'Approval:', 'Approvers:', 'Tests:', 'Sign-offs:'];

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function flow(root, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: path.join(root, '..', `${path.basename(root)}-builds`) }
  });
}
const json = (root, args) => {
  const result = flow(root, [...args, '--json']);
  return { status: result.status, stderr: result.stderr, report: JSON.parse(result.stdout) };
};

/** A starter repository; `change` edits the parsed workflow.yml or its text, and adds files. */
async function repository(change = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-people-'));
  await initializeDefinition(root);
  const file = path.join(root, WORKFLOW);
  const original = await readFile(file, 'utf8');
  const files = {};
  const edited = await change({ definition: YAML.parse(original), text: original, files, root });
  await writeFile(file, edited ?? original, 'utf8');
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text, 'utf8');
  }
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'People Checker'); git(root, 'config', 'user.email', 'people-checker@example.invalid');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'people');
  return root;
}


test('every packaged workflow: each step says who does what and where', async () => {
  const root = await repository();
  const { status, report, stderr } = json(root, ['workflow', 'check']);
  assert.equal(status, 0, stderr);
  assert.deepEqual([report.counts.problem, report.counts.warning], [0, 0],
    JSON.stringify(report.workflows.flatMap((entry) => entry.findings).filter((entry) => entry.severity !== 'note')));
  for (const workflow of report.workflows) {
    for (const step of workflow.explanation.steps) {
      const people = step.people;
      assert.ok(people, `${workflow.id} ${step.id} has its map`);
      assert.deepEqual(people.lines.map((line) => line.split(' ')[0]), LINE_WORDS, `${workflow.id} ${step.id}`);
      assert.equal(people.approval.where === 'none', people.approval.mode === 'none', `${workflow.id} ${step.id}`);
      assert.equal(people.questions.asked, people.questions.mode !== 'off' && people.author.by !== 'sflow', `${workflow.id} ${step.id}`);
    }
  }
  assert.equal(STEP_PEOPLE_ITEMS.length, LINE_WORDS.length);

  // Feature: documents are approved in the chat; the code step only in the approver's own terminal when it
  // confirms evidence or decides a test result, as the guard's own person-step catalog says.
  const feature = report.workflows.find((entry) => entry.id === 'feature');
  const step = (id) => feature.explanation.steps.find((entry) => entry.id === id).people;
  assert.deepEqual([step('requirements').approval.where, step('requirements').approval.ownTerminalWhen], ['chat', []]);
  assert.deepEqual(step('requirements').approval.groups.map((group) => [group.id, group.status, group.canApprove]), [['product-approvers', 'auto', true]]);
  assert.deepEqual(step('requirements').questions.answeredBy, { groups: ['product-approvers'], where: 'chat-or-own-terminal' });
  const implementation = step('implementation');
  assert.deepEqual([implementation.author.by, implementation.author.agent.id, implementation.author.writesCode], ['agent', 'developer', true]);
  assert.deepEqual([implementation.review.reviewed, implementation.review.kind, implementation.review.reviewer.id], [true, 'code', 'sflow-source-reviewer']);
  assert.equal(implementation.approval.where, 'own-terminal-when-needed');
  assert.deepEqual(implementation.approval.ownTerminalWhen.map((entry) => [entry.reason, entry.ownTerminalStep]),
    [['evidence-sign-off', 'approval-evidence-confirmation'], ['test-decision', 'test-run-risk']]);
  const own = new Map(OWN_TERMINAL_STEPS.map((entry) => [entry.id, entry]));
  assert.ok(own.get('approval-evidence-confirmation').matches(['approve', 'implementation'], { 'confirm-evidence': true }));
  assert.ok(own.get('test-run-risk').matches(['decision', 'test-risk'], {}));
  assert.deepEqual(implementation.signOffs.map((entry) => [entry.kind, entry.methods, entry.where]), [['evidence', ['inspection', 'visual'], 'own-terminal']]);
  assert.deepEqual([implementation.tests.runs, implementation.tests.from], [true, 'found']);
  assert.match(implementation.approval.text, /^Approval: one person from Engineering reviewers \(its author may approve it\), in the chat with \/sf-approve, but only in the approver's own terminal when it also confirms/u);
  assert.equal(step('verification').approval.ownTerminalWhen.map((entry) => entry.reason).join(), 'test-decision', 'it runs the repository\'s tests');
  // A visual verification step answers for the visual sign-offs; its code step for inspections only.
  const figma = report.workflows.find((entry) => entry.id === 'figma-mobile').explanation.steps;
  assert.deepEqual(figma.filter((entry) => entry.people.signOffs.length).map((entry) => [entry.id, entry.people.signOffs[0].methods]),
    [['implementation', ['inspection']], ['visual-verification', ['visual']]]);
  // A step Singularity Flow builds asks nobody; a workflow that omits the scope owes that decision at its end.
  const lite = report.workflows.find((entry) => entry.id === 'poc-lite').explanation.steps;
  assert.deepEqual(lite.map((entry) => entry.people.author.by), ['sflow', 'sflow', 'sflow', 'sflow']);
  assert.deepEqual(lite.at(-1).people.signOffs, [{ kind: 'applicability', responsibility: 'scope', group: 'quality-reviewers', where: 'chat',
    text: 'before the Story finishes, someone from Quality reviewers records why scope does not apply (singularity-flow decision applicability, or /sf-decide)' }]);
  // A test step that reads the code step's receipt runs no tests itself.
  const classic = report.workflows.find((entry) => entry.id === 'classic-delivery').explanation.steps.find((entry) => entry.id === 'testing').people;
  assert.deepEqual([classic.tests.runs, classic.tests.from, classic.tests.evidenceFrom], [false, 'code-step', 'implementation']);
  // The specification's markers block, and it asks: nothing to report.
  const spec = report.workflows.find((entry) => entry.id === 'spec-driven-standard').explanation.steps.find((entry) => entry.id === 'specification').people;
  assert.deepEqual([spec.questions.mode, spec.questions.markersBlock, spec.questions.asked], ['required', true, true]);

  // validate carries the same map on each step it lists.
  const validated = json(root, ['workflow', 'validate', 'feature']);
  assert.equal(validated.status, 0, validated.stderr);
  assert.deepEqual(validated.report.workflows[0].roles.map((entry) => entry.people), feature.explanation.steps.map((entry) => entry.people));
});

test('the map reads people from the groups and producers a step really has', () => {
  const resolved = {
    phases: [{ id: 'sign', generation: { allowedProducers: ['human'], defaultProducer: 'human' },
      clarification: { mode: 'required', maxQuestions: 2, topics: [], markers: { mode: 'warn' } },
      approval: { mode: 'required', authorities: ['g1', 'g2', 'g3', 'g4'], minimum: 2, requiredAuthorities: ['g1'], allowSelfApproval: false } }],
    approvalAuthorities: {
      g1: { label: 'Leads', members: [{ email: 'lead@example.invalid' }, { email: 'deputy@example.invalid' }], githubTeams: [], allowAnyGitIdentity: false },
      g2: { label: 'Anyone', members: [], githubTeams: [], allowAnyGitIdentity: true },
      g3: { label: 'Team', members: [], githubTeams: ['@example/reviewers'], allowAnyGitIdentity: false },
      g4: { label: 'Empty', members: [], githubTeams: [], allowAnyGitIdentity: false }
    },
    approvalSecurity: { allowAnyGitIdentity: false, autoEnrollNewIdentities: false },
    sourceReview: { mode: 'off', phases: [], reviewerAgent: null },
    obligationGraph: { nodes: [], endpoints: [] }
  };
  const workflow = { steps: [{ id: 'sign', label: 'Sign', output: 'document', agent: 'writer' }] };
  const people = workflowStepPeople({ agents: [{ id: 'writer', label: 'Writer' }] }, workflow, resolved).get('sign');
  assert.deepEqual([people.author.by, people.author.personMayWrite], ['person', false]);
  assert.equal(people.questions.asked, false, 'only an agent\'s draft is asked about');
  assert.match(people.questions.text, /Nobody asks, though: no agent drafts it\. An unanswered \[NEEDS CLARIFICATION\] marker in its document is a warning at publication\.$/u);
  assert.deepEqual(people.approval.groups.map((group) => [group.status, group.canApprove]), [['people', true], ['anyone', true], ['teams', true], ['blocked', false]]);
  assert.equal(people.approval.text, 'Approval: 2 people from Leads, Anyone, Team or Empty, including someone from Leads (someone other than its author approves it), '
    + 'in the chat with /sf-approve (or VS Code\'s Approve, or the approver\'s own terminal).');
  assert.equal(people.approval.groupsText, 'Approvers: Leads: 2 people; Anyone: any Git identity; Team: the members of @example/reviewers; '
    + 'Empty: nobody (no people, no teams, and nobody is added automatically), so nobody can approve.');
  assert.deepEqual([people.review.reviewed, people.review.reason], [false, 'review-off']);
  assert.equal(workflowStepPeople({ agents: [] }, workflow, null).size, 0, 'a workflow that does not resolve has no map');
});

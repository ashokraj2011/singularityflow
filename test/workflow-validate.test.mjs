/**
 * `workflow validate`: is each workflow correct as the platform judges it, why not, and how to fix
 * it. Scratch starter repositories with team workflows: renamed steps that pass, a clause step whose
 * template defines no anchors, a plan template with the old wrong table header, a copied step that
 * sends rejected work to a step this workflow does not have, a new step no agent drafts, and a code
 * step with no requirements step before it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';

const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const OLD_FIELDS = ['id', 'label', 'status', 'clausePhases', 'owners', 'reason', 'obligations'];

const SPEC = `# {{work.id}} — Team specification

## Requirements

- The export includes every visible row. [{{work.id}}:REQ-001]

## Acceptance criteria

- Exporting a table with 3 rows downloads a CSV with 3 rows. [{{work.id}}:AC-001]
`;
const PLAN = (header = '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |') => `# {{work.id}} — Team plan

## Approach

TODO: How the change is made.

## Planned implementation evidence

${header}
|---|---|---|---|---|
| \`{{work.id}}:REQ-001\` | TODO: \`src/example.js\` | TODO: \`test/example.test.js\` | new | TODO |
`;

const agentFile = (id, label, steps) => ['---', `name: ${id}`, `description: ${label} for the team flow.`, 'model: [auto]',
  'tools: [read, search, edit, bash, ask_user]', 'metadata:', `  sflow-label: "${label}"`, `  sflow-phases: "${steps}"`,
  `  sflow-default-for: "${steps}"`, '---', '', `# ${label}`, '', `Draft the ${label.toLowerCase()} step from its approved inputs.`, ''].join('\n');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function flow(root, args, { env = {} } = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: path.join(root, '..', `${path.basename(root)}-builds`), ...env }
  });
}
const validate = (root, ...args) => {
  const result = flow(root, ['workflow', 'validate', ...args, '--json']);
  return { status: result.status, stderr: result.stderr, report: JSON.parse(result.stdout) };
};

/** A starter repository with the team flow: specification, plan and build, each with its own step ID, template and agent. */
async function teamRepository(change = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-validate-'));
  await initializeDefinition(root);
  const file = path.join(root, 'singularity', 'workflow.yml');
  const definition = YAML.parse(await readFile(file, 'utf8'));
  // It asks the person about the scope it defines: a scope nobody is asked about is a problem of its own.
  definition.phases['team-spec'] = { label: 'Team specification', defaultTemplate: 'team/spec.md',
    artifact: { path: 'artifacts/team-spec/spec.md', kind: 'requirements', minimumBytes: 200 },
    clarification: { mode: 'required', maxQuestions: 5, topics: ['scope', 'acceptance criteria'] },
    approval: { authorities: ['product-approvers'], minimum: 1, rejectTo: ['team-spec'] } };
  definition.phases['team-plan'] = { label: 'Team plan', defaultTemplate: 'team/plan.md',
    artifact: { path: 'artifacts/team-plan/plan.md', kind: 'implementation-plan', minimumBytes: 200 },
    approval: { authorities: ['architecture-reviewers'], minimum: 1, rejectTo: ['team-spec', 'team-plan'] } };
  definition.phases['team-build'] = { label: 'Team build', defaultTemplate: 'common/implementation.md',
    artifact: { path: 'artifacts/team-build/summary.md', kind: 'implementation-summary', minimumBytes: 250 },
    generation: { task: 'code' }, writeScope: 'source-and-artifact',
    approval: { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['team-plan', 'team-build'] } };
  definition.workTypes['team-flow'] = { label: 'Team flow', description: 'Specify, plan and build a team change.',
    phases: ['team-spec', 'team-plan', 'team-build'],
    plannedClaims: { mode: 'required', clausePhases: ['team-spec'], owners: { 'team-build': 'team-plan' } } };
  const files = {
    'singularity/templates/team/spec.md': SPEC,
    'singularity/templates/team/plan.md': PLAN(),
    '.github/agents/team-analyst.agent.md': agentFile('team-analyst', 'Team analyst', 'team-spec'),
    '.github/agents/team-architect.agent.md': agentFile('team-architect', 'Team architect', 'team-plan'),
    '.github/agents/team-developer.agent.md': agentFile('team-developer', 'Team developer', 'team-build')
  };
  await change({ definition, files });
  await writeFile(file, YAML.stringify(definition), 'utf8');
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text, 'utf8');
  }
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Workflow Validator'); git(root, 'config', 'user.email', 'workflow-validator@example.invalid');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'team flow');
  return root;
}

const problems = (workflow) => workflow.findings.filter((entry) => entry.severity === 'problem');

test('every packaged workflow is valid with no problem or warning, and the report keeps every earlier field', async () => {
  const root = await teamRepository();
  const { status, report, stderr } = validate(root);
  assert.equal(status, 0, stderr);
  assert.equal(report.valid, true);
  assert.equal(report.resultType, 'workflow-validation');
  assert.deepEqual([report.counts.problem, report.counts.warning], [0, 0],
    JSON.stringify(report.workflows.flatMap((entry) => entry.findings).filter((entry) => entry.severity !== 'note')));
  assert.equal(report.nextAction, undefined, 'nothing to fix, nothing offered');
  for (const workflow of report.workflows) {
    for (const field of OLD_FIELDS) assert.ok(Object.hasOwn(workflow, field), `${workflow.id} keeps ${field}`);
    assert.deepEqual([workflow.valid, problems(workflow)], [true, []], workflow.id);
    assert.ok(!workflow.findings.some((entry) => entry.code.startsWith('CHECK_TEMPLATE_')), `${workflow.id}: packaged templates conform`);
    assert.ok(workflow.findings.every((entry) => typeof entry.blocksStart === 'boolean'), `${workflow.id}: every finding says whether Story start refuses it`);
  }
  const feature = report.workflows.find((entry) => entry.id === 'feature');
  assert.deepEqual(feature.roles.filter((step) => step.definesClauses).map((step) => step.id), ['requirements', 'implementation-spec']);
  assert.deepEqual(feature.roles.find((step) => step.id === 'implementation-spec').plansClaimsFor, ['implementation']);
  assert.deepEqual(feature.roles.filter((step) => step.carriesTags).map((step) => step.id), ['implementation']);
  const text = flow(root, ['workflow', 'validate']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Validated \d+ Story workflow\(s\): valid\.$/mu);
  assert.doesNotMatch(text.stdout, /sf-fix-workflow/u);
});

test('renamed steps hold their responsibilities from structure, and the workflow is valid', async () => {
  const root = await teamRepository();
  const { status, report, stderr } = validate(root, 'team-flow');
  assert.equal(status, 0, stderr);
  const [team] = report.workflows;
  assert.deepEqual([report.valid, team.valid, team.status, team.counts.problem, team.counts.warning], [true, true, 'protected', 0, 0], JSON.stringify(team.findings));
  assert.deepEqual(team.roles.map((step) => [step.id, step.responsibilities, step.definesClauses, step.plansClaimsFor, step.carriesTags]), [
    ['team-spec', ['scope', 'review'], true, [], false],
    ['team-plan', ['plan', 'review'], false, ['team-build'], false],
    ['team-build', ['implement', 'verify', 'review'], false, [], true]
  ]);
});

test('a clause step whose template defines no anchors is a problem located at the template', async () => {
  const root = await teamRepository(({ files }) => {
    files['singularity/templates/team/spec.md'] = SPEC.replace(' [{{work.id}}:REQ-001]', '').replace(' [{{work.id}}:AC-001]', '');
  });
  const { status, report } = validate(root, 'team-flow');
  assert.equal(status, 1);
  assert.equal(report.valid, false);
  const [finding] = problems(report.workflows[0]).filter((entry) => entry.code === 'CHECK_TEMPLATE_CLAUSE_ANCHORS');
  assert.equal(finding.location.file, 'singularity/templates/team/spec.md');
  assert.ok(finding.location.line >= 1);
  assert.deepEqual([finding.subject.step, finding.subject.template, finding.blocksStart], ['team-spec', 'team/spec.md', false]);
  assert.deepEqual(finding.stopsAt, { step: 'team-spec', when: 'publication' });
  assert.match(finding.detail, /requires stable clause anchors such as \[CHECK-1:REQ-001\]/u);
  assert.match(finding.fix.text, /\[\{\{work\.id\}\}:REQ-001\]/u);
  assert.equal(report.nextAction.copilotCommand, '/sf-fix-workflow team-flow');
  // The same finding in `workflow check`, which Workflow Studio and the builder use; it still exits 0.
  const check = flow(root, ['workflow', 'check', 'team-flow', '--json']);
  assert.equal(check.status, 0, check.stderr);
  assert.ok(JSON.parse(check.stdout).workflows[0].findings.some((entry) => entry.code === 'CHECK_TEMPLATE_CLAUSE_ANCHORS'));
});

test('a plan template with the old wrong table header is a problem with the kernel\'s own message', async () => {
  const root = await teamRepository(({ files }) => {
    files['singularity/templates/team/plan.md'] = PLAN('| Clause | Expected paths | Planned tests | Owner | Observable result |');
  });
  const { status, report } = validate(root, 'team-flow');
  assert.equal(status, 1);
  const [finding] = problems(report.workflows[0]).filter((entry) => entry.code === 'CHECK_TEMPLATE_PLANNED_TABLE');
  assert.match(finding.detail, /^Planned claim table at line \d+ may add only these columns, each once: Fulfillment, Steps, Observable result\./u);
  const line = (await readFile(path.join(root, 'singularity/templates/team/plan.md'), 'utf8')).split('\n').findIndex((entry) => entry.includes('| Owner |')) + 1;
  assert.deepEqual(finding.location, { file: 'singularity/templates/team/plan.md', line });
  assert.match(finding.fix.text, /\| Clause \| Expected paths \| Planned tests \| Fulfillment \| Observable result \|/u);

  // A plan template with no table at all says so, and where a near-miss table is.
  const missing = await teamRepository(({ files }) => { files['singularity/templates/team/plan.md'] = PLAN('| Clause | Paths | Tests | Fulfillment | Observable result |'); });
  const [none] = problems(validate(missing, 'team-flow').report.workflows[0]).filter((entry) => entry.code === 'CHECK_TEMPLATE_PLANNED_TABLE');
  assert.match(none.detail, /The table at line \d+ starts "\| Clause \| Paths \| Tests \|/u);
  assert.match(none.detail, /Team build refuses to start without that plan/u);
});

test('a copied step that sends rejected work to a step this workflow lacks makes validate fail, with the fix as a move and a change set', async () => {
  const root = await teamRepository(({ definition }) => {
    // Copied from a longer workflow: Design is not in this one.
    definition.phases['team-build'].approval.rejectTo = ['design', 'team-build'];
  });
  const { status, report } = validate(root, 'team-flow');
  assert.equal(status, 1);
  assert.equal(report.valid, false);
  const [team] = report.workflows;
  assert.equal(team.status, 'protected', 'the planned-claims contract itself is fine');
  assert.equal(team.obligations.startable, true, 'Story start alone would have accepted it');
  const [finding] = problems(team).filter((entry) => entry.code === 'WORKFLOW_REJECTION_TARGET');
  assert.deepEqual([finding.blocksStart, finding.stopsAt], [false, { step: 'team-build', when: 'rejection' }]);
  assert.deepEqual(finding.fix.move, { move: 'step.change', id: 'team-build', signOff: { groups: ['engineering-reviewers'], minimum: 1, sendBackTo: ['team-build'] } });
  assert.deepEqual(finding.fix.changes, [{ op: 'phase.update', id: 'team-build', workflow: 'team-flow', approval: { groups: ['engineering-reviewers'], minimum: 1, rejectTo: ['team-build'] } }]);
  assert.match(report.fixDraft.changeSetPath, /workflow-fixes[\\/][a-f0-9]{16}[\\/]team-flow\.change-set\.json$/u);
  assert.ok(!report.fixDraft.changeSetPath.startsWith(`${root}${path.sep}`), 'the draft is private, outside the repository');
  // Its folder is made when it is issued, since a host's create tool makes no parent folder; the file never is.
  assert.ok((await stat(path.dirname(report.fixDraft.changeSetPath))).isDirectory());
  await assert.rejects(access(report.fixDraft.changeSetPath), { code: 'ENOENT' });

  // The change set the finding gives clears it, checked without writing anything.
  const draft = path.join(root, '..', `${path.basename(root)}-fix.json`);
  await writeFile(draft, JSON.stringify({ schema: report.fixDraft.schema, changes: finding.fix.changes }));
  const checked = JSON.parse(flow(root, ['workflow', 'check', 'team-flow', '--change-set', draft, '--json']).stdout);
  assert.equal(checked.changeSet.valid, true, JSON.stringify(checked.changeSet));
  assert.equal(checked.workflows[0].counts.problem, 0, JSON.stringify(checked.workflows[0].findings));

  const text = flow(root, ['workflow', 'validate', 'team-flow']);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /^ {2}problem {2}Rejecting Team build sends work to a step that does not come before it {2}\(singularity\/workflow\.yml:\d+\)$/mu);
  assert.match(text.stdout, /^ {11}Why: Rejecting 'team-build' returns to 'design'.* A Story stops when Team build is rejected\.$/mu);
  assert.match(text.stdout, /^ {11}Fix: Send rejected work back to Team build instead/mu);
  assert.match(text.stdout, /^Copilot can draft the fixes with \/sf-fix-workflow team-flow as one reviewed configuration proposal .*nothing changes until it is reviewed and activated\.$/mu);
});

test('a new step no agent drafts is a located finding on the agent file, not a refusal; validate exits 1', async () => {
  const root = await teamRepository(({ definition }) => {
    definition.phases['team-audit'] = { label: 'Team audit', defaultTemplate: 'common/verification.md',
      artifact: { path: 'artifacts/team-audit/audit.md', kind: 'test-evidence', minimumBytes: 300 },
      approval: { authorities: ['quality-reviewers'], minimum: 1, rejectTo: ['team-audit'] } };
    definition.workTypes['team-flow'].phases.push('team-audit');
  });
  const { status, report, stderr } = validate(root, 'team-flow');
  assert.equal(status, 1, stderr);
  assert.equal(report.resultType, 'workflow-validation', 'a validate result, not a refusal plan');
  assert.deepEqual([report.valid, report.configuration.valid, report.blocksStart], [false, false, true]);
  const [team] = report.workflows;
  for (const field of OLD_FIELDS) assert.ok(Object.hasOwn(team, field), `keeps ${field}`);
  const [finding] = problems(team).filter((entry) => entry.code.startsWith('AGENT_PHASE_'));
  assert.ok(['AGENT_PHASE_UNMAPPED', 'AGENT_PHASE_DEFAULT_MISSING'].includes(finding.code), finding.code);
  assert.deepEqual([finding.subject.step, finding.subject.workflows, finding.blocksStart], ['team-audit', ['team-flow'], true]);
  assert.match(finding.location.file, /^\.github\/agents\/[a-z-]+\.agent\.md$/u);
  assert.match(finding.fix.text, /^Add 'team-audit' to sflow-phases and sflow-default-for in .*\.github\/agents\/[a-z-]+\.agent\.md/u);
  // The engine's own message is kept, and it is coded now.
  assert.match(finding.detail, /^Phase 'team-audit' (?:has no compatible agent\.|requires exactly one default agent; found 0\.)/u);
  assert.ok(report.repository.findings.some((entry) => entry.id === finding.id), 'it is about the agent files');
  // The rest of the workflow was still checked: the template findings, roles and the old report.
  assert.deepEqual(team.roles.map((step) => step.id), ['team-spec', 'team-plan', 'team-build', 'team-audit']);

  const text = flow(root, ['workflow', 'validate', 'team-flow']);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /^ {2}problem {2}No agent (?:can draft|drafts) Team audit {2}\(\.github\/agents\/[a-z-]+\.agent\.md:\d+\)$/mu);
  assert.match(text.stdout, /^ {11}Fix: Add 'team-audit' to sflow-phases and sflow-default-for in /mu);
  assert.match(text.stdout, /\/sf-fix-workflow team-flow/u);
  // Every other command still refuses, coded, and its recovery plan points at validate.
  const refused = flow(root, ['workflow', 'simulate', 'team-flow', '--json']);
  assert.notEqual(refused.status, 0);
  const plan = JSON.parse(refused.stdout);
  assert.ok(['AGENT_PHASE_UNMAPPED', 'AGENT_PHASE_DEFAULT_MISSING'].includes(plan.error.code), plan.error.code);
  assert.equal(plan.remediationPlan.steps[0].command, 'singularity-flow workflow validate');
  assert.equal(plan.remediationPlan.steps[0].copilotCommand, '/sf-fix-workflow');
  // Workflow check answers with the same located finding and keeps its exit code.
  const check = flow(root, ['workflow', 'check', 'team-flow', '--json']);
  assert.equal(check.status, 0, check.stderr);
  const checked = JSON.parse(check.stdout);
  assert.equal(checked.configuration.valid, false);
  assert.ok(checked.repository.findings.some((entry) => entry.code === finding.code && entry.location.file === finding.location.file));
});

test('a code step without a requirements step is still refused for new Stories, with how a step comes to hold each role', async () => {
  const root = await teamRepository(({ definition }) => {
    definition.workTypes['team-short'] = { label: 'Team short', phases: ['team-build'] };
  });
  const { status, report } = validate(root, 'team-short');
  assert.equal(status, 1);
  const [short] = report.workflows;
  assert.equal(short.status, 'migration-required');
  assert.equal(short.valid, false);
  const finding = short.findings.find((entry) => entry.code === 'CHECK_PLANNED_CLAIMS');
  assert.deepEqual([finding.severity, finding.blocksStart], ['problem', true]);
  assert.match(finding.fix.text, /document type \(artifact kind\) is requirements or implementation-spec/u);
  assert.match(finding.fix.text, /declare omits for scope with a reason of at least 20 characters and the approval group/u);

  const unknown = flow(root, ['workflow', 'validate', 'no-such-flow', '--json']);
  assert.equal(unknown.status, 1);
  const refusal = JSON.parse(unknown.stdout);
  assert.equal(refusal.error.code, 'WORKFLOW_UNKNOWN');
  assert.match(refusal.error.message, /There is no workflow 'no-such-flow'\. Workflows here: .*team-flow/u);
});

test('a configuration that does not load is a validate result with its located problems, not a bare refusal', async () => {
  const root = await teamRepository();
  const file = path.join(root, 'singularity', 'workflow.yml');
  await writeFile(file, `${await readFile(file, 'utf8')}\nworkTypes:\n  broken: {}\n`, 'utf8');
  const { status, report } = validate(root);
  assert.equal(status, 1);
  assert.deepEqual([report.resultType, report.valid, report.configuration.valid, report.workflows], ['workflow-validation', false, false, []]);
  const [finding] = report.repository.findings;
  assert.deepEqual([finding.severity, finding.blocksStart, finding.location.file], ['problem', true, 'singularity/workflow.yml']);
  assert.ok(finding.location.line > 1);
  assert.equal(report.nextAction.copilotCommand, '/sf-fix-workflow');
  const text = flow(root, ['workflow', 'validate']);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /^The workflow configuration cannot be read until these are fixed:$/mu);
  assert.match(text.stdout, /^ {11}Why: .*No command can read the configuration, so no Story can start\.$/mu);
});

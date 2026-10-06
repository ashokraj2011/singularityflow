import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { authoringRoute, phaseRequiresCodeDelivery } from '../src/code-delivery-policy.mjs';
import { installWorkflow, simulateWorkflow, workflowCatalog } from '../src/workflow-catalog.mjs';
import { applicabilityStatus } from '../src/evidence/applicability.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { decisionOutcome, normalizeDecisionInputValues, obligationsDroppedBySkips, pendingDecisionRecord, resolveDecisionChoice } from '../src/workflow-decisions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'document-test-repair';
const PHASES = ['document-intake', 'scenario-check', 'scenario-repair', 'scenario-retest'];
const packaged = async () => YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));

function aggregate(resolution, phaseId, verdict, rounds = 0) {
  const decision = resolution.decisions.find((entry) => entry.after === phaseId);
  return {
    resolution, phaseOrder: PHASES,
    phases: Object.fromEntries(resolution.phases.map((phase) => [phase.id, {
      ...phase, generation: 1, status: phase.id === phaseId ? 'awaiting_approval' : 'approved',
      ...(phase.id === phaseId ? { decisionInputs: { decision: decision.id, values: { verdict } } } : {})
    }])),
    decisionRounds: { [decision.id]: { count: rounds } }
  };
}

test('document acceptance tests existing behavior first and binds repair, retest, skills and human agreement', async () => {
  const raw = await packaged();
  const resolution = resolveWorkType(validateDefinition(raw), ID);
  const phases = resolution.phases;
  assert.deepEqual(phases.map((phase) => phase.id), PHASES);
  assert.deepEqual(phases.map((phase) => authoringRoute(phase).effectiveAuthoringSkill),
    ['/sf-document-intake', '/sf-scenario-check', '/sf-code', '/sf-scenario-check']);
  assert.deepEqual(phases.map(phaseRequiresCodeDelivery), [false, false, true, false]);
  assert.ok(phases.every((phase) => phase.approval.mode === 'required'));
  assert.deepEqual(phases.map((phase) => phase.writeScope),
    ['artifact-only', 'artifact-only', 'source-and-artifact', 'artifact-only']);
  assert.equal(phases[3].testEvidenceFrom, 'scenario-repair', 'retest must verify the current Code receipt');
  assert.deepEqual(resolution.plannedClaims, { mode: 'required', clausePhases: ['document-intake'], owners: { 'scenario-repair': 'document-intake' }, reason: null });
  assert.deepEqual(resolution.documents.allowedPhases, ['document-intake']);
  assert.ok(resolution.decisions.every((entry) => entry.enforceConditions && entry.maxRounds === 2));
  assert.ok(phases.slice(1).every((phase) => !phase.approval.rejectTo.includes('scenario-repair') || phase.id === 'scenario-repair'),
    'human rejection must not bypass the decision-directed repair path');
  assert.ok(phases.every((phase) => phase.mcp.requiredServers.length === 0));
  assert.ok(raw.mcpServers.playwright.agents.includes('scenario-tester'));
  assert.ok(['scenario-check', 'scenario-retest'].every((id) => raw.mcpServers.playwright.phases.includes(id)));
  assert.ok(!raw.mcpServers.playwright.phases.includes('scenario-repair'));
  assert.deepEqual(resolveWorkType(validateDefinition(raw), 'classic-delivery').phases.map((phase) => phase.id),
    ['intake', 'implementation', 'testing', 'conformance']);
});

test('passing existing behavior skips repair only with human implementation applicability', async () => {
  const resolution = resolveWorkType(validateDefinition(await packaged()), ID);
  const workflow = aggregate(resolution, 'scenario-check', 'pass');
  const outcome = decisionOutcome(workflow, workflow.phases['scenario-check']);
  assert.equal(outcome.kind, 'end');
  assert.deepEqual(outcome.skipped, ['scenario-repair', 'scenario-retest']);
  workflow.decisionLog = [{ ...outcome, route: outcome.route }];
  const status = applicabilityStatus(workflow);
  assert.equal(status.length, 1);
  assert.equal(status[0].responsibility, 'implement');
  assert.equal(status[0].satisfied, false, 'no-change completion cannot infer human applicability');
  workflow.applicability = [{ responsibility: 'implement', authorityGroup: 'quality-reviewers',
    reason: 'The fresh approved scenarios demonstrate the behavior already exists.', actor: { email: 'reviewer@example.test' } }];
  assert.equal(applicabilityStatus(workflow)[0].satisfied, true);
});

test('initial pass can finish by approved inspection, but skipping repair does not waive criterion evidence', async () => {
  const resolution = resolveWorkType(validateDefinition(await packaged()), ID);
  const workflow = aggregate(resolution, 'scenario-check', 'pass');
  workflow.workItem = { id: 'DOC-1' };
  workflow.status = 'closed';
  workflow.currentPhase = null;
  for (const phase of Object.values(workflow.phases)) {
    phase.requiredArtifact = phase.artifact;
    phase.approvalPolicy = phase.approval;
    phase.approvals = [{ decision: 'approved', actor: { login: 'reviewer' }, authorityGroup: phase.approval.authorities[0] }];
    phase.status = ['scenario-repair', 'scenario-retest'].includes(phase.id) ? 'skipped' : 'approved';
  }
  const outcome = decisionOutcome(workflow, workflow.phases['scenario-check']);
  workflow.decisionLog = [{ ...outcome, decision: resolution.decisions[0].id }];
  assert.equal(obligationsDroppedBySkips(workflow).length, 1, 'an undeclared human omission cannot waive planned repair');
  workflow.applicability = [{ responsibility: 'implement', authorityGroup: 'quality-reviewers',
    reason: 'Fresh scenario evidence demonstrates that implementation already satisfies the approved criterion.' }];
  assert.deepEqual(obligationsDroppedBySkips(workflow), []);
  workflow.applicability[0].authorityGroup = 'product-approvers';
  assert.equal(obligationsDroppedBySkips(workflow).length, 1, 'a different authority cannot waive the repair obligation');
  workflow.applicability[0].authorityGroup = 'quality-reviewers';
  const clauseId = 'DOC-1:AC-001';
  const records = { indexes: [{ phase: 'document-intake', generation: 1,
    clauses: [{ id: clauseId, type: 'AC', bodySha256: 'a'.repeat(64) }] }],
    planned: [{ phase: 'document-intake', generation: 1, claims: { [clauseId]: {
      expectedPaths: ['src/screen.js'], tests: ['test/screen.test.js']
    } } }], observed: [] };
  const evaluate = (text) => evaluateEvidence(evidenceGraph({ workflow, records,
    inspections: [{ phaseId: 'scenario-check', text }] }), { boundary: 'terminal', mode: 'decision' });
  const passing = evaluate(`Executed and reviewed [${clauseId}]: the approved observable assertion passed.`);
  assert.equal(passing.decision.gate, 'allow', JSON.stringify(passing.findings));
  assert.equal(passing.rows.find((row) => row.id === clauseId).verification.association, 'inspection');
  assert.equal(passing.rows.find((row) => row.id === clauseId).assurance, 'declared', 'prose must not claim exact-test assurance');
  assert.equal(evaluate('Passed only OTHER-DOC-1:AC-001.').decision.gate, 'block', 'another criterion cannot satisfy this Story');
  delete workflow.applicability;
  assert.equal(evaluate(`Reviewed [${clauseId}].`).decision.gate, 'block', 'human no-change applicability is still required');
});

test('defects enter repair, blocked access stays in checking, and retest loops have a finite limit', async () => {
  const resolution = resolveWorkType(validateDefinition(await packaged()), ID);
  for (const [phase, verdict, kind, target] of [
    ['scenario-check', 'repair', 'next', 'scenario-repair'],
    ['scenario-check', 'blocked', 'loop', 'scenario-check'],
    ['scenario-retest', 'repair', 'loop', 'scenario-repair'],
    ['scenario-retest', 'blocked', 'loop', 'scenario-retest'],
    ['scenario-retest', 'pass', 'end', null]
  ]) {
    const workflow = aggregate(resolution, phase, verdict);
    const outcome = decisionOutcome(workflow, workflow.phases[phase]);
    assert.deepEqual([outcome.kind, outcome.target], [kind, target]);
  }
  for (const verdict of ['repair', 'blocked']) {
    const workflow = aggregate(resolution, 'scenario-retest', verdict, 2);
    const outcome = decisionOutcome(workflow, workflow.phases['scenario-retest']);
    assert.equal(outcome.kind, 'pause');
    assert.equal(outcome.reason, 'limit');
    const pending = pendingDecisionRecord(workflow, workflow.phases['scenario-retest'], outcome, { at: '2026-10-06T00:00:00Z' });
    assert.ok(!pending.options.some((entry) => entry.to === 'end'), 'a failed agent verdict must not offer Finish in CLI or UI');
    assert.throws(() => resolveDecisionChoice(workflow, { ...pending,
      options: [...pending.options, { id: 'accepted', label: 'Forged pass', to: 'end' }], values: { verdict: 'pass' }
    }, { option: 'accepted' }), (error) => error.code === 'DECISION_CONDITION_REQUIRED');
    assert.equal(resolveDecisionChoice(workflow, pending, { option: pending.options[0].id }).reach.kind, 'backward');
  }
  const decision = resolution.decisions[0];
  assert.throws(() => normalizeDecisionInputValues(decision, {}), (error) => error.code === 'DECISION_INPUTS_MISSING');
  assert.throws(() => normalizeDecisionInputValues(decision, { verdict: 'unknown' }), (error) => error.code === 'DECISION_INPUT_INVALID');
});

test('starter installs agents, usable artifact contracts and a catalog entry without overwriting repository agents', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-document-test-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  // Exercise adoption into a repository that does not already contain this optional starter.
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  delete config.workTypes[ID];
  for (const id of PHASES) delete config.phases[id];
  config.mcpServers.playwright.phases = config.mcpServers.playwright.phases.filter((id) => !PHASES.includes(id));
  config.mcpServers.playwright.agents = config.mcpServers.playwright.agents.filter((id) => id !== 'scenario-tester');
  await writeFile(configPath, YAML.stringify(config));
  for (const id of ['document-analyst', 'scenario-tester', 'scenario-developer']) {
    await rm(path.join(root, `.github/agents/${id}.agent.md`));
  }
  await rm(path.join(root, 'singularity/templates/document-test-repair'), { recursive: true });
  await installWorkflow(root, ID);
  const definition = await loadDefinition(root);
  const resolution = resolveWorkType(definition, ID);
  assert.deepEqual(resolution.phases.map((phase) => phase.defaultAgent),
    ['document-analyst', 'scenario-tester', 'scenario-developer', 'scenario-tester']);
  for (const phase of resolution.phases) {
    const text = await readFile(path.join(root, definition.templatesRoot, phase.template), 'utf8');
    for (const heading of phase.artifact.validation.requiredHeadings) assert.ok(text.includes(`## ${heading}\n`), `${phase.id}: ${heading}`);
  }
  const catalog = (await workflowCatalog(root)).find((entry) => entry.id === ID);
  assert.equal(catalog.status, 'current');
  assert.deepEqual(catalog.codePhases, ['scenario-repair']);
  const simulation = (await simulateWorkflow(root, ID))[0];
  assert.deepEqual(simulation.phases.map((phase) => phase.id), PHASES);
  const agentPath = path.join(root, '.github/agents/scenario-tester.agent.md');
  const custom = `${await readFile(agentPath, 'utf8')}\nRepository-specific safety instruction.\n`;
  await writeFile(agentPath, custom);
  await installWorkflow(root, ID, { replace: true });
  assert.equal(await readFile(agentPath, 'utf8'), custom);
  for (const name of ['document-intake', 'scenario-check', 'scenario-repair']) {
    const skill = await readFile(path.join(ROOT, `plugin/skills/sflow-${name}/SKILL.md`), 'utf8');
    assert.match(skill, /disable-model-invocation: true/);
    assert.match(skill, /never submit|Never submit|submit or approve/);
  }
});

test('a fresh Story tests existing behavior and finishes only after human acceptance, without browser prerequisites or repair', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-document-story-'));
  const remote = `${root}.git`;
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(remote, { recursive: true, force: true }); });
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Document Scenario Reviewer',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: ID, agent: 'document-analyst' }) };
  delete env.NODE_TEST_CONTEXT; // The nested repository test must use its own reporter, not outer IPC.
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const flow = (...args) => run(process.execPath, [path.join(ROOT, 'bin/singularity-flow.mjs'), '--no-model', ...args]);
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.name', 'Document Scenario Reviewer']);
  run('git', ['config', 'user.email', 'scenario-reviewer@example.test']);
  await writeFile(path.join(root, 'README.md'), '# Document scenario fixture\n');
  flow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'src/screen.mjs'), 'export const title = "Approved screen";\n');
  await writeFile(path.join(root, 'test/screen.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { title } from '../src/screen.mjs';
test('SC-001 shows the approved title', () => assert.equal(title, 'Approved screen'));
`);
  run('git', ['add', '.']); run('git', ['commit', '-m', 'Initialize document acceptance fixture']);
  run('git', ['init', '--bare', '-b', 'main', remote]);
  run('git', ['remote', 'add', 'origin', remote]); run('git', ['push', '-u', 'origin', 'main']);
  flow('start', 'DOC-1', '--from-branch', 'main', '--work-type', ID, '--title', 'Check the approved screen',
    '--description', 'Confirm documented behavior before making a repair.');
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/DOC-1/workflow.json'), 'utf8'));
  assert.deepEqual(workflow.phaseOrder, PHASES);
  assert.equal(workflow.currentPhase, 'document-intake');
  assert.ok(workflow.resolution.decisions.every((entry) => entry.enforceConditions));
  const show = JSON.parse(flow('phase', 'show', 'document-intake', '--json'));
  assert.equal(show.policyVerified, true);
  assert.equal(show.effectiveAuthoringSkill, '/sf-document-intake');
  assert.match(flow('nextsteps', '--json'), /sf-document-intake/);

  flow('wm', 'compose', '--phase', 'document-intake');
  const staged = run('git', ['rev-parse', '--git-path', 'singularity-flow/clarification-responses/document-intake.json']).trim();
  await mkdir(path.dirname(path.resolve(root, staged)), { recursive: true });
  await writeFile(path.resolve(root, staged), JSON.stringify({ responses: [{
    question: 'What behavior, tool and repair scope are approved?',
    answer: 'SC-001 must show Approved screen. Use node --test test/screen.test.mjs locally. Repair only src/screen.mjs if this assertion fails; no browser or production access.'
  }] }));
  flow('clarification', 'record', 'document-intake', '--response-file', path.resolve(root, staged));
  flow('prepare', 'document-intake');
  const intakePath = path.join(root, 'singularity/work-items/DOC-1/artifacts/document-intake/intake.md');
  await writeFile(intakePath, `# DOC-1 — Approved title acceptance
## Approved sources
The human's intake description requires the approved screen title. No screenshot is required for this text assertion.
## Scope and acceptance criteria
- Show the approved title exactly. [DOC-1:AC-001]
Only src/screen.mjs may be repaired if this title is incorrect; dependencies and workflow policy are outside scope.
## Scenario matrix
SC-001 checks DOC-1:AC-001 with the executable assertion SC-001 shows the approved title in test/screen.test.mjs.
## Test tool and authorized environment
Use node --test test/screen.test.mjs from this local repository. No browser, remote service or production data is involved.
## Planned implementation evidence
| Clause | Expected paths | Planned tests |
| --- | --- | --- |
| DOC-1:AC-001 | \`src/screen.mjs\` | \`test/screen.test.mjs\` |
## Repair and acceptance agreement
Test existing behavior first. A fresh pass needs human approval and a no-change applicability decision; a demonstrated failure requests repair. Missing tools remain blocked. At the loop limit a human chooses another matching attempt or cancels, never overrides a failure as passing.
`);
  flow('phase', 'publish', 'document-intake');
  flow('submit', 'document-intake');
  flow('approve', 'document-intake', '--yes');
  const scope = JSON.parse(flow('evidence', 'scope', '--json')).data.scope;
  for (const item of scope.items.filter((entry) => entry.disposition === 'unresolved')) {
    flow('decision', 'scope', '--item', item.id, '--as', 'included', '--clause', 'DOC-1:AC-001',
      '--reason', 'The requested document behavior is carried by the exact approved title acceptance criterion.');
  }
  env.SINGULARITY_FLOW_TEST_SELECTION = JSON.stringify({ workType: ID, agent: 'scenario-tester' });
  flow('prepare', 'scenario-check');
  const testOutput = run(process.execPath, ['--test', 'test/screen.test.mjs']);
  assert.match(testOutput, /# pass 1|pass 1/);
  // Summarize the reporter's zero pending-test metadata instead of inserting the word TODO into
  // an authored report. The original output hash still identifies the complete observed bytes.
  const displayedOutput = testOutput.replace(/^.*\btodo\s+0\s*$/gm, '');
  const outputSha256 = createHash('sha256').update(testOutput).digest('hex');
  const testedCommit = run('git', ['rev-parse', 'HEAD']).trim();
  await writeFile(path.join(root, 'singularity/work-items/DOC-1/artifacts/scenario-check/scenario-results.md'), `# Existing behavior result
## Pinned inputs and tested revision
Approved DOC-1 intake, repository revision ${testedCommit}. The source and test have not changed.
## Tool execution and evidence
Executed node --test test/screen.test.mjs in the fixture repository, exit 0, one assertion ran, zero pending tests. Complete output SHA-256 ${outputSha256}. Bounded fresh output:
\`\`\`text
${displayedOutput}
\`\`\`
## Scenario results
[DOC-1:AC-001] — SC-001 shows the approved title: passed. Actual title Approved screen equals the approved exact value. No scenario was skipped.
## Agent verdict and repair request
verdict=pass. All required observable assertions ran successfully; there is no product defect and no repair is proposed.
## Human acceptance
Pending authorized review of this exact published report, together with implementation-not-applicable acknowledgement. The agent cannot approve or finish the Story itself.
`);
  flow('phase', 'publish', 'scenario-check');
  flow('submit', 'scenario-check', '--decision', 'verdict=pass');
  const readState = async () => JSON.parse(await readFile(path.join(root, 'singularity/work-items/DOC-1/workflow.json'), 'utf8'));
  assert.equal((await readState()).currentPhase, 'scenario-check', 'agent pass/submission alone cannot finish');
  flow('decision', 'applicability', '--responsibility', 'implement', '--reason', 'Fresh SC-001 evidence proves the existing title already satisfies the approved criterion; no implementation change is needed.');
  flow('approve', 'scenario-check', '--yes');
  const completed = await readState();
  assert.equal(completed.status, 'closed');
  assert.equal(completed.completion.kind, 'complete');
  assert.deepEqual(['scenario-repair', 'scenario-retest'].map((id) => completed.phases[id].status), ['skipped', 'skipped']);
  assert.equal(await readFile(path.join(root, 'src/screen.mjs'), 'utf8'), 'export const title = "Approved screen";\n');
});

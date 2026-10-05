import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import {
  observationDigest, recordRiskDecision, recordRiskRevocation, riskDecisionState, riskEligibility
} from '../src/evidence/risk-decisions.mjs';

const CLI = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'bin/singularity-flow.mjs');
const W = 'RISK-1';
const AC = `${W}:AC-001`;
const NOW = '2026-10-03T10:00:00.000Z';
const policy = { mode: 'required', minimum: 1, authorities: ['quality-reviewers'], requiredAuthorities: [] };
const approval = { decision: 'approved', actor: { login: 'bob' }, authorityGroup: 'quality-reviewers', at: '2026-10-02T00:00:00Z' };

function story() {
  return {
    workItem: { id: W, title: 'Risk fixture' }, status: 'in_progress', currentPhase: 'testing',
    phaseOrder: ['intake', 'implementation', 'testing'],
    resolution: { plannedClaims: { mode: 'required', clausePhases: ['intake'], owners: { implementation: 'intake' } } },
    phases: {
      intake: { id: 'intake', status: 'approved', generation: 1, approvalPolicy: policy, approvals: [approval], requiredArtifact: { kind: 'requirements' } },
      implementation: { id: 'implementation', status: 'approved', generation: 1, approvalPolicy: policy, approvals: [approval], generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' } },
      testing: { id: 'testing', status: 'in_progress', generation: 1, approvalPolicy: policy, approvals: [], requiredArtifact: { kind: 'test-evidence' } }
    }
  };
}

// AC-001 is implemented, but the test command covering its test failed.
const records = {
  indexes: [{ workId: W, phase: 'intake', generation: 1, clauses: [{ id: AC, type: 'AC', source: { path: 'intake.md', line: 5 }, bodySha256: 'a'.repeat(64), dependsOn: [] }] }],
  planned: [{ workId: W, phase: 'intake', generation: 1, kind: 'planned', claims: { [AC]: { expectedPaths: ['src/value.mjs'], tests: ['test/value.test.mjs'], testDisposition: 'applicable', testReason: null } } }],
  observed: [{ workId: W, phase: 'implementation', generation: 1, kind: 'observed', claims: { [AC]: { observedPaths: ['src/value.mjs'], testResults: ['test/value.test.mjs'], commits: [], verdict: 'matched' } } }],
  acceptance: []
};
const delivery = (status = 'failed') => ({
  phaseId: 'implementation', generation: 1, status: 'ready', testRecovery: null,
  acceptanceCriteria: { bindings: [{ clauseId: AC, testSource: 'test/value.test.mjs' }] },
  receipt: { status: 'ready', traceability: { bindings: [{ clauseId: AC, testSource: 'test/value.test.mjs', commandId: 'unit' }] } },
  executions: [{ commandId: 'unit', kind: 'test-execution', status, record: status === 'no-result' ? null : { status, tests: { discovered: 1, passed: status === 'passed' ? 1 : 0, failed: status === 'failed' ? 1 : 0, skipped: 0 } } }]
});
const evaluate = (workflow, options = {}) => evaluateEvidence(evidenceGraph({ workflow, records, deliveries: [delivery(options.status)] }), { at: options.at ?? NOW });
const verifyOf = (evaluation) => evaluation.rows.find((row) => row.id === AC).obligations.find((entry) => entry.responsibility === 'verify');
const accept = (workflow, obligation, overrides = {}) => recordRiskDecision(workflow, {
  obligation, category: 'external-dependency', expires: '2026-10-20', reason: 'The payment sandbox is down; production is verified separately.',
  actor: 'qa@example.test', authorityGroup: 'quality-reviewers', at: NOW, ...overrides
});

test('only an open, trusted, fresh obligation that is not a review may have its risk accepted', () => {
  const failed = { id: 'OBL:x', responsibility: 'verify', status: 'failed', facets: { freshness: 'current' } };
  assert.equal(riskEligibility(failed).eligible, true);
  assert.equal(riskEligibility(failed, { untrusted: true }).reason, 'integrity', 'untrusted records are repaired, never accepted');
  assert.equal(riskEligibility({ ...failed, facets: { freshness: 'stale' } }).reason, 'stale', 'stale evidence is rerun, never accepted');
  assert.equal(riskEligibility({ ...failed, responsibility: 'review' }).reason, 'unreviewed');
  assert.equal(riskEligibility({ ...failed, status: 'pending' }).reason, 'not-open');
  assert.equal(riskEligibility({ ...failed, status: 'met' }).reason, 'not-open');
});

test('an accepted risk carries the obligation as excepted while the failure stays visible', () => {
  const workflow = story();
  const before = verifyOf(evaluate(workflow));
  assert.equal(before.status, 'failed');
  assert.ok(evaluate(workflow).rows[0].actions.some((action) => action.kind === 'accept-risk' && action.command.includes(before.id)));
  assert.throws(() => accept(workflow, before, { category: 'whatever' }), (error) => error.code === 'RISK_DECISION_INVALID');
  assert.throws(() => accept(workflow, before, { expires: '2026-10-01' }), /after today and at most 90 days ahead/);
  assert.throws(() => accept(workflow, before, { expires: '2027-06-01' }), /at most 90 days ahead/);
  assert.throws(() => accept(workflow, before, { transitions: ['approval'] }), /--transition must be one of terminal/);
  assert.throws(() => accept(workflow, before, { reason: 'later' }), (error) => error.code === 'RISK_DECISION_REASON_REQUIRED');
  const decision = accept(workflow, before);
  assert.equal(decision.id, 'RISK-001');
  assert.deepEqual(decision.observation, { status: 'failed', sha256: observationDigest(before) });

  const evaluation = evaluate(workflow);
  const after = verifyOf(evaluation);
  assert.deepEqual([after.status, after.facets.execution, after.facets.exception, after.riskDecision.id], ['excepted', 'failed', 'accepted-risk', 'RISK-001'],
    'the observation is unchanged; only the disposition is excepted');
  assert.equal(evaluation.rows[0].result, 'satisfied-with-exception');
});

test('an expired, revoked or overtaken decision counts for nothing and asks to be renewed', () => {
  const workflow = story();
  const obligation = verifyOf(evaluate(workflow));
  accept(workflow, obligation);
  // Re-evaluated at the current time, so an expiry after approval still blocks closing (D4).
  const late = evaluate(workflow, { at: '2026-10-21T00:00:00.000Z' });
  assert.equal(verifyOf(late).status, 'failed');
  assert.ok(late.rows[0].findings.some((entry) => entry.code === 'RISK_DECISION_EXPIRED' && /renew it/.test(entry.message)));
  assert.equal(late.decision.gate, 'block');

  // Different evidence than the decision accepted is not covered by it.
  const overtaken = evaluate(workflow, { status: 'no-result' });
  assert.notEqual(verifyOf(overtaken).status, 'excepted');
  assert.ok(overtaken.rows[0].findings.some((entry) => entry.code === 'RISK_DECISION_OVERTAKEN'));

  assert.throws(() => recordRiskRevocation(workflow, { riskId: 'RISK-009', reason: 'The sandbox is back online for everyone.', actor: 'qa@example.test', authorityGroup: 'quality-reviewers', at: NOW }),
    (error) => error.code === 'RISK_DECISION_UNKNOWN');
  recordRiskRevocation(workflow, { riskId: 'RISK-001', reason: 'The sandbox is back online for everyone.', actor: 'qa@example.test', authorityGroup: 'quality-reviewers', at: NOW });
  assert.equal(riskDecisionState(workflow, obligation, { at: NOW }).state, 'revoked');
  assert.equal(verifyOf(evaluate(workflow)).status, 'failed');
  assert.throws(() => recordRiskRevocation(workflow, { riskId: 'RISK-001', reason: 'Revoking the same decision twice.', actor: 'qa@example.test', authorityGroup: 'quality-reviewers', at: NOW }),
    (error) => error.code === 'RISK_DECISION_REVOKED');
  assert.equal(riskDecisionState(workflow, obligation, { at: NOW, transition: 'approval' }).state, 'revoked');
});

test('a decision binds the exact attempts it accepted, so a rerun or a looser tie asks for it to be renewed [E2G-020]', () => {
  const workflow = { riskDecisions: [] };
  const accepted = {
    id: `OBL:${W}:verify:AC-001`, responsibility: 'verify', status: 'failed', owningSteps: ['implementation'],
    assuranceFacets: { identity: 'source-bound', execution: 'exact-local-observed' },
    attempts: [{ test: 'value > exact value', attemptId: 'TA-00000000000000000001', outcome: 'failed' }],
    facets: { coverage: 'linked', execution: 'failed', assurance: 'exact-local-observed', review: 'approved', freshness: 'current', exception: 'none' }
  };
  recordRiskDecision(workflow, { obligation: accepted, category: 'known-failure', expires: '2026-10-20',
    reason: 'The upstream sandbox fails this test until its certificate is renewed.', actor: 'qa@example.test', authorityGroup: 'quality-reviewers', at: NOW });
  assert.equal(riskDecisionState(workflow, accepted, { at: NOW }).state, 'active');
  const rerun = { ...accepted, attempts: [{ ...accepted.attempts[0], attemptId: 'TA-00000000000000000002' }] };
  assert.equal(riskDecisionState(workflow, rerun, { at: NOW }).state, 'overtaken', 'the same failure in a new attempt is accepted again, not inherited');
  const looser = { ...accepted, assuranceFacets: { ...accepted.assuranceFacets, identity: 'declared' } };
  assert.equal(riskDecisionState(workflow, looser, { at: NOW }).state, 'overtaken');
  // An obligation with no tests keeps the digest it always had.
  const plain = { id: 'OBL:x', status: 'failed', facets: { coverage: 'linked', execution: 'failed', assurance: 'none' } };
  assert.equal(observationDigest(plain), observationDigest({ ...plain, attempts: undefined, assuranceFacets: undefined }));
});

function cliRun(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Risk Tester', SINGULARITY_FLOW_NO_MODEL: '1' }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('the CLI accepts and revokes the risk of an inconclusive criterion through the step that owns it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-risk-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const id = 'RISKCLI-1';
  const cli = (...args) => cliRun(process.execPath, [CLI, '--no-model', ...args], root);
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  cliRun('git', ['init', '-b', 'main'], root);
  cliRun('git', ['config', 'user.name', 'Risk Tester'], root);
  cliRun('git', ['config', 'user.email', 'risk@example.test'], root);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${id}:AC-001`, "test('value', () => assert.equal(value, 1));", ''].join('\n'));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Node's JUnit report only counts tests, so which test was skipped is not joined to the criterion.
  // (The inferred `node --test` command is read exactly, where a skipped test leaves it missing.)
  config.phases.implementation.qualityCommands = [{
    id: 'unit-tests', kind: 'test', argv: [process.execPath, '--test', '--test-reporter=junit', 'test/value.test.mjs'],
    workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
    result: { adapter: 'junit-xml', path: '.sflow/results/unit.xml', minimumDiscovered: 1 }
  }];
  await writeFile(configPath, YAML.stringify(config));
  cliRun('git', ['add', '.'], root);
  cliRun('git', ['commit', '-m', 'Initialize the risk fixture'], root);
  cliRun('git', ['init', '--bare', '-b', 'main', remote], root);
  cliRun('git', ['remote', 'add', 'origin', remote], root);
  cliRun('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');
  cli('start', id, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return 2.');
  const item = path.join(root, 'singularity/work-items', id);
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${id} — intake`, '', '## Request and outcome', '', 'Return the approved value 2 to every caller.', '',
    '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${id}:AC-001] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${id}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');
  cli('prepare', 'implementation');
  await write('src/value.mjs', `// @clause:${id}:AC-001 returns the approved value 2\nexport const value = 2;\n`);
  // One assertion runs and passes; one is skipped, so the criterion is inconclusive, not verified.
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${id}:AC-001`, "test('value', () => assert.equal(value, 2));",
    `// @ac:${id}:AC-001`, "test.skip('value in the payment sandbox', () => assert.equal(value, 2));", ''].join('\n'));
  const codeArtifact = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(codeArtifact, (await readFile(codeArtifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module returns the approved value 2.'));
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  cli('approve', 'implementation', '--yes');

  const verify = () => JSON.parse(cli('evidence', 'matrix', '--json').stdout).data.matrix.page.rows
    .find((row) => row.id === `${id}:AC-001`).obligations.find((entry) => entry.responsibility === 'verify');
  const open = verify();
  assert.equal(open.status, 'inconclusive');
  const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  cli('decision', 'risk', '--obligation', open.id, '--category', 'assurance-shortfall', '--expires', expires,
    '--reason', 'The sandbox test is skipped until the provider restores it next sprint.');
  assert.deepEqual([verify().status, verify().facets.execution, verify().riskDecision.id], ['excepted', 'passed-with-skips', 'RISK-001']);

  cli('decision', 'risk', '--revoke', 'RISK-001', '--reason', 'The provider restored the sandbox earlier than planned.');
  assert.equal(verify().status, 'inconclusive');
  const state = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.deepEqual(state.riskDecisions.map((entry) => entry.revokes ?? entry.id), ['RISK-001', 'RISK-001']);
  assert.deepEqual(state.history.filter((entry) => entry.event === 'risk_decided').length, 2);
});

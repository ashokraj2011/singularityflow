import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSpecIndex, derivePlannedClaimMap, extractClauses, inspectPlannedClaimMap,
  evaluateSpecAcceptance, normalizeClaimMap, mergePlannedClaimRecords } from '../src/specifications.mjs';
import { sourceReviewBinding } from '../src/source-grounded-review.mjs';
import { sourceReviewReportTemplate } from '../src/source-review-contract.mjs';
import { checkSourceReviewReport } from '../src/source-review-lifecycle.mjs';
import { buildActiveClauseCapsule } from '../src/active-clause-capsule.mjs';
import { phaseAuthoringContract, phaseAuthoringContractLines } from '../src/phase-authoring-contract.mjs';

const req = 'PROOF:REQ-001';
const ac = 'PROOF:AC-001';
const scope = '# Scope\n- Retain the screenshot. [PROOF:REQ-001]\n- Show success. [PROOF:AC-001]\n';
const intent = (methods = 'visual') => [
  '## Verification intent', '', '| Clause | Methods | Criterion |', '|---|---|---|',
  '| `PROOF:REQ-001` | ' + methods + ' | `PROOF:AC-001` |',
  '| `PROOF:AC-001` | ' + methods + ' | `PROOF:AC-001` |', ''
].join('\n');
const specification = () => scope + '\n' + intent();
const plan = () => [
  '# Plan', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
  '| `PROOF:REQ-001` | `docs/proof.md` | verification: PROOF:AC-001 | document |',
  '| `PROOF:AC-001` | `docs/proof.md` | verification: PROOF:AC-001 | document |',
  '', '## Verification contracts', '', '| Criterion | Slot | Method | Witness | Role |', '|---|---|---|---|---|',
  '| `PROOF:AC-001` | screen | visual | `success screen` | primary |', ''
].join('\n');
const derive = (markdown = plan(), spec = specification()) => {
  const clauses = extractClauses(spec);
  return derivePlannedClaimMap(markdown, { clauses, clauseIds: clauses.map(clause => clause.id), requireComplete: true });
};

test('Specification binds exact proof methods, canonical identities and a shared AC into its index', async () => {
  const clauses = extractClauses(specification().replaceAll('`PROOF:', '`proof:'));
  assert.deepEqual(clauses.map(clause => clause.verification), [
    { methods: ['visual'], criterionId: ac }, { methods: ['visual'], criterionId: ac }
  ]);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-proof-intent-'));
  try {
    await writeFile(path.join(directory, 'scope.md'), specification());
    const first = await buildSpecIndex(directory, 'scope.md', { write: false });
    await writeFile(path.join(directory, 'scope.md'), specification().replaceAll('| visual |', '| inspection |'));
    const second = await buildSpecIndex(directory, 'scope.md', { write: false });
    assert.notEqual(first.indexSha256, second.indexSha256, 'changing proof is a governed scope change');
    assert.deepEqual(first.clauses[0].verification.methods, ['visual']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid, incomplete or unlinked intent is caught during Specification, not the next phase', () => {
  const bad = [
    specification().replace('| visual |', '| manual |'),
    specification().replace('| visual |', '| visual, visual |'),
    specification().replace('Criterion |', 'Evidence |'),
    specification().replace('| `PROOF:REQ-001` | visual | `PROOF:AC-001` |', ''),
    specification().replace('| `PROOF:REQ-001` | visual | `PROOF:AC-001` |', '| `PROOF:REQ-001` | visual | - |'),
    specification().replaceAll(' | `PROOF:AC-001` |', ' | `PROOF:AC-009` |'),
    specification().replace('| `PROOF:AC-001` | visual |', '| `PROOF:AC-001` | test |'),
    specification() + '\n' + intent()
  ];
  for (const markdown of bad) assert.throws(() => extractClauses(markdown), { code: 'SPEC_VERIFICATION_INTENT_INVALID' });
  assert.equal(Object.hasOwn(extractClauses(scope)[0], 'verification'), false, 'legacy source bytes keep their meaning');
  for (const example of ['<!--\n' + intent() + '\n-->', '```\n' + intent() + '\n```',
    '<!-- singularity-flow:inputs:start -->\n' + intent() + '\n<!-- singularity-flow:inputs:end -->']) {
    assert.equal(Object.hasOwn(extractClauses(scope + example)[0], 'verification'), false, 'managed/examples do not declare scope');
  }
  const previous = extractClauses(specification());
  const successor = '# Additional scope\n- Inspect the existing screen. [PROOF:REQ-002]\n\n'
    + '## Verification intent\n\n| Clause | Methods | Criterion |\n|---|---|---|\n'
    + '| `PROOF:REQ-002` | visual | `PROOF:AC-001` |\n';
  assert.equal(extractClauses(successor, { externalClauses: previous })[0].verification.criterionId, ac,
    'a later defining phase can reference approved proof without redefining earlier clauses');
});

test('non-test proof is an exact shared contract, not an exemption or an observed visual pass', () => {
  const derived = derive();
  assert.deepEqual(derived.missingTestClauseIds, []);
  assert.deepEqual(derived.claimMap.claims[req], { expectedPaths: ['docs/proof.md'], tests: [],
    testDisposition: 'non-test', testReason: null, verificationCriterion: ac, deviation: null, fulfillment: 'document' });
  const normalized = normalizeClaimMap(derived.claimMap, { kind: 'planned', clauseIds: [req, ac] });
  assert.deepEqual(normalized.claims, derived.claimMap.claims);
  assert.deepEqual(mergePlannedClaimRecords([normalized])[req].verificationCriterion, ac);
  assert.equal(derived.claimMap.verificationContracts[0].slots[0].status, undefined, 'no screenshot accepted');
  const records = { indexes: [{ clauses: extractClauses(specification()) }], planned: [derived.claimMap] };
  assert.deepEqual(evaluateSpecAcceptance(records, { acceptance: 'presence' }).missingPlannedTests, []);
  const verified = evaluateSpecAcceptance(records, { acceptance: 'verify' });
  assert.deepEqual(verified.missingObservedTests, [], 'manual proof does not demand a fake executable test');
  assert.equal(verified.missingRun, true, 'required configured command execution remains required');
  const unbound = { ...records, planned: [{ ...derived.claimMap, verificationContracts: [] }] };
  assert.deepEqual(evaluateSpecAcceptance(unbound, { acceptance: 'presence' }).missingPlannedTests, [ac, req].sort());
  const forged = structuredClone(records);
  for (const claim of Object.values(forged.planned[0].claims)) {
    claim.testDisposition = 'not-applicable'; claim.testReason = 'not needed'; delete claim.verificationCriterion;
  }
  forged.indexes[0].clauses = extractClauses(scope + intent('test'));
  assert.deepEqual(evaluateSpecAcceptance(forged, { acceptance: 'presence' }).missingPlannedTests, [ac, req].sort(),
    'an exemption cannot erase explicitly approved automated proof downstream');
});

test('Planning cannot waive automation, use another AC, omit primary proof or weaken combined methods', () => {
  const cases = [
    [plan(), scope + intent('test')],
    [plan().replaceAll('verification: PROOF:AC-001', 'not-applicable: not needed'), scope + intent('test')],
    [plan().replace(' | primary |', ' | supporting |'), specification()],
    [plan().replace('## Verification contracts', '## Ignored contracts'), specification()],
    [plan().replaceAll('verification: PROOF:AC-001', 'verification: PROOF:REQ-001'), specification()],
    [plan(), scope], // A legacy requirement cannot invent a shared proof relationship.
    [plan(), scope + intent('test, visual')]
  ];
  for (const [markdown, spec] of cases) assert.throws(() => derive(markdown, spec));
  const mixed = plan().replaceAll('verification: PROOF:AC-001', '`test/proof.test.js`')
    .replace('| Witness | Role |', '| Witness | Role | Combination |')
    .replace('|---|---|---|---|---|', '|---|---|---|---|---|---|')
    .replace('| `success screen` | primary |', '| `success screen` | primary | all |')
    + '| `PROOF:AC-001` | unit | test | `test/proof.test.js` | primary | all |\n';
  assert.equal(derive(mixed, scope + intent('test, visual')).claimMap.claims[ac].testDisposition, 'applicable');
  assert.throws(() => derive(mixed.replaceAll(' | all |', ' | any |'), scope + intent('test, visual')));
  const diagnostics = inspectPlannedClaimMap(plan(), { clauses: extractClauses(scope + intent('test')), clauseIds: [req, ac] });
  assert.equal(diagnostics.valid, false);
  assert.equal(diagnostics.diagnostics[0].code, 'SPEC_VERIFICATION_INTENT_INVALID');
  assert.equal(diagnostics.diagnostics[0].details.repairScope, 'current-draft');
});

test('source review of custom phases distinguishes manual proof from real exemptions and preserves independence', () => {
  const context = { kind: 'planning', workId: 'PROOF', phase: 'bespoke-design', generation: 1,
    authorAgentId: 'architect', reviewerAgentId: 'source-reviewer', reviewerAgentSha256: 'a'.repeat(64),
    sources: [{ id: 'story', path: 'USER-STORY.md', text: 'Retain the screenshot.' }],
    upstreamSpec: { path: 'scope.md', text: specification() }, artifact: { path: 'design.md', text: plan() } };
  context.binding = sourceReviewBinding(context);
  const report = sourceReviewReportTemplate(context);
  for (const row of report.rows) row.assessment = 'supported';
  const checked = checkSourceReviewReport(report, context);
  assert.equal(checked.retentionReady, true);
  assert.deepEqual(checked.evaluation.pendingDispositions, []);
  assert.equal(checked.evaluation.status, 'ready');
  report.rows[0].verificationCriterion = 'PROOF:AC-009';
  assert.equal(checkSourceReviewReport(report, context).retentionReady, false, 'reviewer cannot invent proof');
  const legacy = { ...context, upstreamSpec: { ...context.upstreamSpec, text: scope },
    artifact: { ...context.artifact, text: plan().replaceAll('verification: PROOF:AC-001', 'not-applicable: visual inspection') } };
  legacy.binding = sourceReviewBinding(legacy);
  const legacyReport = sourceReviewReportTemplate(legacy);
  for (const row of legacyReport.rows) row.assessment = 'supported';
  assert.deepEqual(checkSourceReviewReport(legacyReport, legacy).evaluation.pendingDispositions.map(item => item.clauseId), [req],
    'legacy AC primary visual contract is not an exemption; unlinked REQ remains a genuine exception');
  legacy.artifact.text = legacy.artifact.text.split('## Verification contracts')[0];
  legacy.binding = sourceReviewBinding(legacy);
  const exemption = sourceReviewReportTemplate(legacy);
  for (const row of exemption.rows) row.assessment = 'supported';
  assert.equal(checkSourceReviewReport(exemption, legacy).evaluation.pendingDispositions.length, 2);
});

test('approved proof survives prompt compaction and all workflow authoring defaults', () => {
  const workflow = { workItem: { id: 'PROOF' }, phaseOrder: ['custom-intake', 'custom-design', 'code'],
    resolution: { plannedClaims: { mode: 'required', owners: { code: 'custom-design' } },
      obligationGraph: { nodes: [{ id: 'custom-intake', responsibilities: ['scope'] }] } }, phases: {
      'custom-intake': { id: 'custom-intake', requiredArtifact: { kind: 'requirements' } },
      'custom-design': { id: 'custom-design', requiredArtifact: { kind: 'implementation-spec' } },
      code: { id: 'code', generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' } }
    } };
  const records = { indexes: [{ phase: 'custom-intake', clauses: extractClauses(specification()) }] };
  const capsule = buildActiveClauseCapsule(records, workflow, workflow.phases['custom-design']);
  assert.deepEqual(capsule.capsule.clauses[0].verification.methods, ['visual']);
  assert.match(capsule.text, /"verification"/);
  const intake = phaseAuthoringContract({}, workflow, workflow.phases['custom-intake']);
  assert.equal(intake.verificationIntent.oneRowPerDeclaredClause, true);
  assert.match(phaseAuthoringContractLines(intake).join('\n'), /Verification intent/);
  const design = phaseAuthoringContract({}, workflow, workflow.phases['custom-design']);
  assert.equal(design.planning.verification.inheritApprovedMethods, true);
  assert.match(phaseAuthoringContractLines(design).join('\n'), /not-applicable.*genuine exemption/);
});

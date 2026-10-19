import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectEvidenceConsistency, renderEvidenceConsistency, withEvidenceConsistencyRefresh,
  MAX_EVIDENCE_CONSISTENCY_BYTES } from '../src/evidence-consistency.mjs';
import { readEvidenceConsistency } from '../src/evidence-consistency-read.mjs';
import { recordSha256 } from '../src/records.mjs';
import { discrepancyItemSha256 } from '../src/upstream-issues.mjs';
import { phaseEntryAgentPresentation } from '../src/agent-packet-presentation.mjs';

const HASH = `sha256:${'a'.repeat(64)}`;
const AT = '2026-10-19T09:00:00.000Z';
const PATH = 'team/stories/BIN-501/artifacts/release/conformance.md';
const discrepancy = '**Verification generation 1; “Acceptance and specification results”:** '
  + 'The report states that 15 tests passed, but the packet has no execution record. '
  + '**Assumption:** do not claim a Verification run. **Impact:** REQ-001, REQ-002 and AC-001 remain partial. '
  + '**Proposed owner action:** amend the Verification report or retain a fresh run.';

function fixture() {
  const workflow = {
    workItem: { id: 'BIN-501' }, currentPhase: 'release', status: 'in_progress',
    phaseOrder: ['specification', 'implementation', 'verification', 'release'],
    phases: {
      specification: { id: 'specification', label: 'Specification', generation: 1, status: 'approved', requiredArtifact: { kind: 'requirements' } },
      implementation: { id: 'implementation', generation: 1, status: 'approved', writeScope: 'source-and-artifact' },
      verification: { id: 'verification', label: 'Verification', generation: 1, status: 'approved', requiredArtifact: { kind: 'test-evidence' } },
      release: { id: 'release', generation: 1, status: 'awaiting_approval',
        requiredArtifact: { kind: 'conformance-report', path: 'artifacts/release/conformance.md' } }
    },
    lineage: { submissions: ['implementation', 'verification'].map((phase) => ({ phase, generation: 1 })) },
    upstreamIssues: [{ id: 'UPI-001', phase: 'specification', about: 'recorded discrepancy',
      problem: discrepancy.slice(0, 299) + '…', source: { path: PATH,
        itemSha256: discrepancyItemSha256('specification', discrepancy.slice(0, 299) + '…') } }]
  };
  const executionEvidence = {
    projectionSha256: HASH, current: { status: 'available', sourceTreeSha256: HASH, testInputSha256: null },
    diagnostics: [], omittedPackets: 0,
    entries: [
      { phase: 'implementation', generation: 1, status: 'retained', packetSha256: 'b'.repeat(64),
        path: 'team/stories/BIN-501/submissions/implementation/packet.json', sourceTreeSha256: HASH,
        checks: [{ commandId: 'vitest', outcome: 'passed', binding: 'matched', structuredTestsReusable: true }],
        executions: [{ attemptId: 'TA-01234567890123456789', commandId: 'vitest', path: 'attempt.json', sha256: HASH,
          status: 'passed', counts: { discovered: 33, passed: 33, failed: 0, skipped: 0 }, assurance: 'module-executed' }] },
      { phase: 'verification', generation: 1, status: 'no-governed-tests-in-this-packet', packetSha256: 'c'.repeat(64),
        checks: [], executions: [], sourceTreeSha256: HASH, path: 'team/stories/BIN-501/submissions/verification/packet.json' }
    ]
  };
  const visualReviews = { projectionSha256: HASH, reviews: [{
    id: 'WIT-001', clauseId: 'BIN-501:AC-001', slot: 'screenshot', method: 'visual',
    file: 'evidence/binary.png', sha256: HASH, actor: 'reviewer@example.test', authorityGroup: 'quality-reviewers',
    decision: 'satisfies', binding: 'bound-file-unchanged', candidate: 'unchanged', valid: true
  }] };
  const report = ['# Release', '', '| Clause | Evidence | Verdict |', '|---|---|---|',
    '| BIN-501:REQ-001 | implementation execution | matched |',
    '| BIN-501:REQ-002 | test source | matched |',
    '| BIN-501:AC-001 | human visual acceptance outstanding | matched |', '',
    '## Upstream discrepancies', '', `- ${discrepancy}`, ''].join('\n');
  return { workflow, phase: workflow.phases.release, executionEvidence, visualReviews,
    documents: [{ path: PATH, content: report }], report };
}

test('the BIN-style report exposes contradictions, missing execution, stale review prose and wrong issue ownership together', async () => {
  const item = fixture(); const original = JSON.stringify(item);
  const snapshot = await readEvidenceConsistency('/not-read', { workItemRoot: 'team/stories' }, item.workflow, item.phase,
    { ...item, at: AT });
  assert.equal(snapshot.phases.find((p) => p.phase === 'implementation').runs[0].counts.passed, 33);
  assert.equal(snapshot.phases.find((p) => p.phase === 'verification').runs.length, 0);
  assert.equal(snapshot.visualReviews[0].valid, true);
  for (const code of ['conformance.verdict-contradicted', 'evidence.execution-unretained',
    'conformance.witness-unreported', 'evidence.discrepancy-owner-mismatch']) {
    assert.ok(snapshot.findings.some((finding) => finding.code === code), code);
  }
  assert.equal(snapshot.issues[0].phase, 'specification', 'retain the erroneous historical owner, never silently retarget');
  assert.equal(snapshot.issues[0].status, 'open');
  assert.ok(snapshot.reportedVerdicts.every((row) => row.assurance === 'authored-claim'));
  assert.ok(snapshot.findings.every((finding) => finding.blocking === false), 'this projection introduces no new gate');
  assert.equal(JSON.stringify(item), original, 'reading never edits artifacts, decisions or the input observations');
  assert.match(snapshot.summary.join('\n'), /33 passed.*source binding matched/u);
  assert.match(snapshot.summary.join('\n'), /verification generation 1: no test execution is retained/u);
  assert.doesNotMatch(snapshot.summary.join('\n'), /verification.*15 passed/u);
});

test('reuse remains explicitly attributed, covers only its named clauses and never manufactures a consumer execution', async () => {
  const item = fixture();
  const decision = { id: 'ERU-001', phase: 'verification', state: 'active', recordedBy: 'implementation',
    attemptId: 'TA-01234567890123456789', clauses: ['BIN-501:REQ-001'],
    label: 'reused: TA-01234567890123456789 recorded by implementation; approved for verification by a reviewer (ERU-001), not a run by verification' };
  item.executionEvidence.reusedTestEvidence = [decision];
  const snapshot = await readEvidenceConsistency('/not-read', { workItemRoot: 'team/stories' }, item.workflow, item.phase,
    { ...item, at: AT });
  assert.equal(snapshot.reuses[0].runRecordedByConsumer, false);
  assert.equal(snapshot.phases.find((p) => p.phase === 'verification').runs.length, 0);
  assert.deepEqual(snapshot.reuses[0].clauses, ['BIN-501:REQ-001']);
  assert.match(snapshot.findings.find((f) => f.code === 'evidence.execution-unretained').message, /Approved reuse: ERU-001/u);
  decision.state = 'expired';
  const expired = await readEvidenceConsistency('/not-read', { workItemRoot: 'team/stories' }, item.workflow, item.phase,
    { ...item, at: AT });
  assert.match(expired.findings.find((f) => f.code === 'evidence.execution-unretained').message, /No approved reuse/u);
  assert.notEqual(expired.projectionSha256, snapshot.projectionSha256);
});

test('same observations have the same reconstructable digest; source, decision, receipt and review changes invalidate it', () => {
  const item = fixture();
  const before = projectEvidenceConsistency(item);
  assert.deepEqual(projectEvidenceConsistency(item), before);
  const { projectionSha256, ...core } = before;
  assert.equal(projectionSha256, `sha256:${recordSha256(core)}`);
  for (const change of ['source', 'receipt', 'visual', 'generation', 'issue']) {
    const altered = fixture();
    if (change === 'source') altered.executionEvidence.current.sourceTreeSha256 = `sha256:${'d'.repeat(64)}`;
    if (change === 'receipt') altered.executionEvidence.entries[0].executions[0].sha256 = `sha256:${'d'.repeat(64)}`;
    if (change === 'visual') altered.visualReviews.reviews[0].valid = false;
    if (change === 'generation') altered.workflow.phases.implementation.generation = 2;
    if (change === 'issue') altered.issues = [{ id: 'UPI-001', phase: 'verification', status: 'decided', decision: { outcome: 'accept-risk' } }];
    assert.notEqual(projectEvidenceConsistency(altered).projectionSha256, before.projectionSha256, change);
  }
});

test('missing/omitted packets, stale source and unstructured command success are never promoted', () => {
  const item = fixture();
  const check = item.executionEvidence.entries[0].checks[0];
  check.binding = 'stale'; check.structuredTestsReusable = false;
  item.executionEvidence.entries[0].executions = [];
  item.executionEvidence.entries.pop();
  item.executionEvidence.diagnostics = [{ phase: 'verification', code: 'STORY_REVIEW_EVIDENCE_INVALID', status: 'unavailable' }];
  item.executionEvidence.omittedPackets = 2;
  const snapshot = projectEvidenceConsistency(item);
  const run = snapshot.phases.find((p) => p.phase === 'implementation').runs[0];
  assert.equal(run.counts, null); assert.equal(run.structuredTestsReusable, false);
  assert.equal(run.outcome, 'passed', 'historical process success is not rewritten');
  assert.equal(snapshot.phases.find((p) => p.phase === 'verification').status, 'unavailable');
  assert.match(snapshot.summary.join('\n'), /no structured counts; source binding stale/u);
  assert.match(snapshot.summary.join('\n'), /Omission is not passing evidence/u);
  assert.equal(snapshot.phases.find((p) => p.phase === 'release').status, 'no-retained-submission');
});

test('custom renamed phases and future workflows use the same role-independent facts', () => {
  const item = fixture();
  const custom = { ...item.phase, id: 'team-close', label: 'Ship it' };
  item.workflow.phases[custom.id] = custom; item.workflow.phaseOrder.push(custom.id);
  item.phase = custom;
  const snapshot = projectEvidenceConsistency(item);
  assert.equal(snapshot.phase, custom.id);
  assert.ok(snapshot.phases.some((entry) => entry.phase === 'verification'));
  assert.equal(snapshot.phases.at(-1).phase, custom.id);
  const shown = phaseEntryAgentPresentation({ ready: true, evidenceConsistency: snapshot });
  assert.deepEqual(shown.evidenceConsistency, snapshot);
  assert.ok(shown.agentGuide.readOrder.includes('evidenceConsistency'));
});

test('a superseded issue owes nothing: no outcome and no outstanding decision, only its replacement and kept history', () => {
  const item = fixture();
  item.issues = [
    { id: 'UPI-001', phase: 'specification', about: 'recorded discrepancy', status: 'superseded', supersededBy: 'UPI-002', decision: null },
    { id: 'UPI-002', phase: 'implementation', about: 'BIN-501:REQ-001', status: 'open', supersededBy: null, decision: null },
    { id: 'UPI-003', phase: 'verification', about: 'x', status: 'decided', supersededBy: 'UPI-004', decision: { outcome: 'dismiss' } }
  ];
  const lines = projectEvidenceConsistency(item).summary;
  assert.ok(lines.includes('UPI-001: owned by specification; superseded by UPI-002, original history retained.'), lines.join('\n'));
  assert.ok(lines.includes('UPI-002: owned by implementation; open; human decision outstanding.'));
  assert.ok(lines.includes('UPI-003: owned by verification; decided (dismiss); superseded by UPI-004, original history retained.'));
  assert.equal(lines.filter((line) => line.startsWith('UPI-001')).some((line) => /outstanding|\(/u.test(line)), false);
});

test('recorded visual reviews carry what the person looked at and the rule for reporting them, once', () => {
  const item = fixture();
  Object.assign(item.visualReviews.reviews[0], { at: AT, reason: 'Checked the converted totals.' });
  item.visualReviews.reviews.push({ id: 'WIT-002', clauseId: 'BIN-501:AC-002', slot: 'screen', method: 'inspection',
    file: 'evidence/two.png', sha256: HASH, decision: 'does-not-satisfy', answeredNo: ['matches-criterion'],
    binding: 'bound-file-changed', candidate: 'unchanged', valid: false });
  const lines = projectEvidenceConsistency(item).summary;
  assert.equal(lines.filter((line) => line.startsWith('Report the recorded visual')).length, 1);
  assert.ok(lines.some((line) => line.startsWith('WIT-001: BIN-501:AC-001, slot screenshot: recorded human review satisfies this slot')
    && line.includes('visual of `evidence/binary.png` satisfies it, recorded by reviewer@example.test for quality-reviewers at 2026-10-19T09:00:00.000Z')
    && line.includes('reviewer note: "Checked the converted totals."')), lines.join('\n'));
  assert.ok(lines.some((line) => line.startsWith('WIT-002: BIN-501:AC-002, slot screen: review does not currently satisfy this slot')
    && line.includes('does not satisfy it (answered no: matches-criterion)')));
  delete item.visualReviews;
  assert.equal(projectEvidenceConsistency(item).summary.some((line) => line.startsWith('Report the recorded visual')), false,
    'the rule is said only when reviews are listed');
});

test('a refresh delivers current facts beside an immutable old prompt; unchanged digest adds nothing', () => {
  const snapshot = projectEvidenceConsistency(fixture());
  const old = '# Original prompt\nApproved evidence must not change.\n';
  assert.equal(withEvidenceConsistencyRefresh(old, { promptBudget: { evidenceConsistency: snapshot } }, snapshot), old);
  const delivered = withEvidenceConsistencyRefresh(old, { promptBudget: {} }, snapshot);
  assert.ok(delivered.startsWith(old.trimEnd()));
  assert.match(delivered, /Current evidence-consistency refresh/u);
  assert.ok(delivered.includes(renderEvidenceConsistency(snapshot)));
  assert.equal(old, '# Original prompt\nApproved evidence must not change.\n');
});

test('the reader uses supplied observations without Git/file reads; different report bytes change its digest', async () => {
  const item = fixture();
  const options = { ...item, at: AT };
  const first = await readEvidenceConsistency('/not-read', { workItemRoot: 'team/stories' }, item.workflow, item.phase, options);
  const second = await readEvidenceConsistency('/not-read', { workItemRoot: 'team/stories' }, item.workflow, item.phase, options);
  assert.equal(first.projectionSha256, second.projectionSha256);
  options.documents = [{ path: PATH, content: item.report.replace('matched', 'partial') }];
  const changed = await readEvidenceConsistency('/not-read', { workItemRoot: 'team/stories' }, item.workflow, item.phase, options);
  assert.notEqual(changed.inputs.documents[0].authoredSha256, first.inputs.documents[0].authoredSha256);
  assert.notEqual(changed.projectionSha256, first.projectionSha256);
});

test('report reads stay inside the repository, do not mutate it, and do not expose an unsafe file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-evidence-consistency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const item = fixture();
  await mkdir(path.dirname(path.join(root, PATH)), { recursive: true });
  await writeFile(path.join(root, PATH), item.report);
  const options = { executionEvidence: item.executionEvidence, visualReviews: item.visualReviews, at: AT };
  const snapshot = await readEvidenceConsistency(root, { workItemRoot: 'team/stories' }, item.workflow, item.phase, options);
  assert.equal(snapshot.inputs.documents[0].path, PATH);
  assert.equal(await readFile(path.join(root, PATH), 'utf8'), item.report);
  item.phase.requiredArtifact.path = '../../../../../outside.md';
  const refused = await readEvidenceConsistency(root, { workItemRoot: 'team/stories' }, item.workflow, item.phase, options);
  assert.equal(refused.inputs.documents.length, 0);
  assert.ok(refused.findings.some((entry) => /could not be inspected/u.test(entry.message)));
});

test('partial document previews never masquerade as a full report inspection', async () => {
  const item = fixture(); item.documents[0].truncated = true;
  const snapshot = await readEvidenceConsistency('/not-read', { workItemRoot: 'team/stories' }, item.workflow, item.phase,
    { ...item, at: AT });
  assert.deepEqual(snapshot.inputs.documents, []);
  assert.deepEqual(snapshot.reportedVerdicts, []);
  assert.ok(snapshot.findings.some((entry) => entry.code === 'EVIDENCE_REPORT_PARTIAL'));
});

test('managed metadata is excluded from claims without shifting source line numbers', async () => {
  const item = fixture();
  const first = await readEvidenceConsistency('/not-read', { workItemRoot: 'team/stories' }, item.workflow, item.phase,
    { ...item, at: AT });
  item.documents[0].content = '<!-- singularity-flow:metadata\n{}\n-->\n\n' + item.report;
  const shifted = await readEvidenceConsistency('/not-read', { workItemRoot: 'team/stories' }, item.workflow, item.phase,
    { ...item, at: AT });
  assert.equal(shifted.reportedVerdicts[0].line, first.reportedVerdicts[0].line + 4);
  const witness = shifted.findings.find((entry) => entry.code === 'conformance.witness-unreported');
  assert.equal(witness.record, 'WIT-001');
  assert.equal(witness.path, PATH);
});

test('a changed human decision explanation changes the snapshot even when its outcome stays the same', async () => {
  const item = fixture();
  item.workflow.upstreamIssueDecisions = [{ issue: 'UPI-001', outcome: 'dismiss', actor: 'reviewer@example.test',
    authorityGroup: 'quality-reviewers', reason: 'The verified retained run is sufficient.', at: AT }];
  const options = { ...item, at: AT };
  const first = await readEvidenceConsistency('/not-read', { workItemRoot: 'team/stories' }, item.workflow, item.phase, options);
  item.workflow.upstreamIssueDecisions[0].reason = 'A different explanation of the human disposition.';
  const changed = await readEvidenceConsistency('/not-read', { workItemRoot: 'team/stories' }, item.workflow, item.phase, options);
  assert.equal(first.issues[0].status, changed.issues[0].status);
  assert.notEqual(first.issues[0].decisionSha256, changed.issues[0].decisionSha256);
  assert.notEqual(first.projectionSha256, changed.projectionSha256);
});

test('large handoffs omit whole observations explicitly; they never duplicate full issue prose', () => {
  const item = fixture();
  item.issues = Array.from({ length: 100 }, (_, index) => ({ id: `UPI-${index}`, phase: 'verification',
    about: 'Test evidence', problem: 'PRIVATE-RAW-PROBLEM'.repeat(400), status: 'open', decision: null }));
  item.findings = Array.from({ length: 100 }, (_, index) => ({ code: `diagnostic-${index}`,
    message: 'A bounded inspection is needed. '.repeat(100), blocking: false }));
  const snapshot = projectEvidenceConsistency(item);
  const serialized = JSON.stringify(snapshot);
  assert.ok(Buffer.byteLength(serialized) <= MAX_EVIDENCE_CONSISTENCY_BYTES);
  assert.doesNotMatch(serialized, /PRIVATE-RAW-PROBLEM/u);
  assert.ok(snapshot.omitted.findings > 0);
  assert.match(snapshot.summary.join('\n'), /Not shown:.*findings.*Omission is not passing evidence/u);
});

/**
 * One rule for honest partial and missing verdicts at approval and at the final gate.
 * [owner decision 2026-10-19: it should not block; a person decides the gap]
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectConformanceVerdictAdvisories, verdictSummaryStatus, withVerdictSummary } from '../src/conformance-readiness.mjs';
import { conformanceVerdictGaps, contradictedConformanceVerdicts } from '../src/conformance-verdicts.mjs';
import { phaseResolutionProjection } from '../src/phase-resolution.mjs';
import { refusalDetails, refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import {
  conformanceGapDecisions, conformanceGapRefusal, issueNamesClause
} from '../src/upstream-routes.mjs';
import { upstreamIssueStates } from '../src/upstream-issues.mjs';

const W = 'GAP-1';
const NOW = '2026-10-19T10:00:00.000Z';
const LATER = '2026-12-01T10:00:00.000Z';

function story({ issues = [], decisions = [], status = 'awaiting_approval' } = {}) {
  return {
    workItem: { id: W }, currentPhase: 'release', status: 'in_progress',
    phaseOrder: ['specification', 'implementation', 'verification', 'release'],
    phases: {
      specification: { id: 'specification', status: 'approved', generation: 1, requiredArtifact: { kind: 'requirements' } },
      implementation: { id: 'implementation', status: 'approved', generation: 1, generationPolicy: { task: 'code' },
        writeScope: 'source-and-artifact', requiredArtifact: { kind: 'implementation-summary' } },
      verification: { id: 'verification', status: 'approved', generation: 1, requiredArtifact: { kind: 'test-evidence' } },
      release: { id: 'release', status, generation: 1, requiredArtifact: { kind: 'conformance-report', path: 'artifacts/release/conformance.md' },
        approvalPolicy: { rejectTo: ['implementation', 'verification', 'release'] } }
    },
    upstreamIssues: issues, upstreamIssueDecisions: decisions
  };
}
const issue = (id, about, phase = 'implementation') => ({ id, phase, about, problem: 'The claimed test run was never recorded.' });
const decision = (id, outcome, expiresAt = null) => ({ issue: id, outcome, expiresAt, reason: 'Decided by the step approvers.', at: NOW });

const REPORT = [
  '| Clause | Evidence | Verdict |', '|---|---|---|',
  `| \`${W}:REQ-001\` | src/a.mjs | partial |`,
  `| \`${W}:AC-001\` | test/a.test.mjs | missing (no recorded run) |`,
  `| \`${W}:AC-002\` | test/b.test.mjs | matched |`
].join('\n');

test('an issue covers a clause only when its about names that exact clause', () => {
  assert.equal(issueNamesClause(`${W}:REQ-001`, `${W}:REQ-001`), true);
  assert.equal(issueNamesClause('REQ-001 has no recorded run', `${W}:REQ-001`), true, 'a bare label names its own clause');
  assert.equal(issueNamesClause('OTHER-9:REQ-001', `${W}:REQ-001`), false, 'another Story\'s clause is not this one');
  assert.equal(issueNamesClause('REQ-0010', `${W}:REQ-001`), false);
  assert.equal(issueNamesClause('Scope and constraints', `${W}:REQ-001`), false);
  assert.equal(issueNamesClause(`${W}:AC-001`, 'AC-001'), true, 'a qualified about names a bare legacy row');
});

test('a gap is decided by an unexpired accepted risk or a dismissal, and by nothing else', () => {
  const gaps = conformanceVerdictGaps(REPORT);
  assert.deepEqual(gaps.map((gap) => [gap.clauseId, gap.verdict]), [[`${W}:REQ-001`, 'partial'], [`${W}:AC-001`, 'missing']]);
  const none = conformanceGapDecisions(story(), 'release', gaps, { now: NOW });
  assert.deepEqual(none.map((gap) => [gap.status, gap.owner, gap.choices[0].kind]),
    [['unraised', 'implementation', 'raise-upstream-issue'], ['unraised', 'implementation', 'raise-upstream-issue']]);

  const raised = story({ issues: [issue('UPI-001', `${W}:REQ-001`), issue('UPI-002', 'AC-001')] });
  assert.deepEqual(conformanceGapDecisions(raised, 'release', gaps, { now: NOW }).map((gap) => [gap.status, gap.issue, gap.choices[0].kind]),
    [['undecided', 'UPI-001', 'decide-upstream-issue'], ['undecided', 'UPI-002', 'decide-upstream-issue']]);

  const decided = story({ issues: raised.upstreamIssues,
    decisions: [decision('UPI-001', 'accept-risk', '2026-11-01T00:00:00.000Z'), decision('UPI-002', 'dismiss')] });
  assert.equal(conformanceGapRefusal(decided, 'release', gaps, { now: NOW }), null, 'both decided: approval proceeds');
  const expired = conformanceGapRefusal(decided, 'release', gaps, { now: LATER });
  assert.deepEqual(expired.gaps.map((gap) => [gap.clauseId, gap.status]), [[`${W}:REQ-001`, 'expired']], 'an expired acceptance no longer covers it');
  assert.match(expired.lines[0], /UPI-001's accepted risk expired at 2026-11-01T00:00:00.000Z; implementation's approvers decide it again/u);
  assert.equal(upstreamIssueStates(decided, LATER)[0].status, 'expired', 'one state read for issues and gaps');

  // A return sends the work back; if the clause is still short afterwards, a new issue is raised.
  const returned = story({ issues: [issue('UPI-001', `${W}:REQ-001`)], decisions: [{ ...decision('UPI-001', 'return'), link: 'CR-001' }] });
  assert.deepEqual(conformanceGapDecisions(returned, 'release', gaps.slice(0, 1), { now: NOW }).map((gap) => gap.status), ['unraised']);
  // An issue about another clause covers nothing here.
  const elsewhere = story({ issues: [issue('UPI-001', `${W}:AC-002`)], decisions: [decision('UPI-001', 'dismiss')] });
  assert.deepEqual(conformanceGapDecisions(elsewhere, 'release', gaps, { now: NOW }).map((gap) => gap.status), ['unraised', 'unraised']);
});

test('the refusal names a decision and three repair routes, never a verdict edit', () => {
  const refusal = conformanceGapRefusal(story(), 'release', conformanceVerdictGaps(REPORT), { now: NOW });
  const [first] = refusal.details.conformanceGaps;
  assert.deepEqual(first.choices.map((choice) => choice.kind), ['raise-upstream-issue', 'repair-return', 'evidence-reuse', 'fresh-recorded-run']);
  assert.equal(first.choices[0].command,
    `singularity-flow upstream-issue raise --phase implementation --about ${W}:REQ-001 --problem "<what the delivered change is missing>" --work-id ${W}`);
  assert.equal(first.choices[1].command, `singularity-flow reject release --work-id ${W} --to implementation --reason <why>`);
  assert.equal(first.choices[2].command, `singularity-flow decision evidence-reuse ${W} --phase implementation --from-attempt <ATTEMPT-ID> --reason <TEXT>`);
  assert.match(first.choices[2].detail, /Accepting existing evidence never certifies a run that was not recorded/u);
  assert.match(first.choices[3].detail, /document step such as release cannot record test runs/u);
  assert.equal(refusal.details.nextAction.command, first.choices[0].command);
  assert.equal(refusal.details.route, '/sf-decide');
  assert.match(refusal.details.rule, /Keep the honest verdict; never edit it to clear a check/u);
  for (const entry of refusal.details.recoveryCommands) assert.ok(safeCommandGuidance(entry), entry.command);
  assert.doesNotMatch(JSON.stringify(refusal), /re-author|edit the verdict to/u);

  // Before submission the return is named for later, never offered as if it worked now.
  const drafting = conformanceGapDecisions(story({ status: 'in_progress' }), 'release', conformanceVerdictGaps(REPORT), { now: NOW });
  assert.match(drafting[0].choices[1].detail, /once release is submitted/u);
});

test('the approval refusal plan is the decision and its routes, not a repair of the report', () => {
  const refusal = conformanceGapRefusal(story({ issues: [issue('UPI-001', `${W}:REQ-001`)] }), 'release',
    conformanceVerdictGaps(REPORT), { now: NOW });
  const error = Object.assign(new Error('refused'), { code: 'CONFORMANCE_BLOCKING_VERDICTS', details: refusal.details });
  const plan = refusalRemediationPlan(error, ['approve', 'release', '--work-id', W]);
  assert.deepEqual(plan.steps.map((entry) => entry.id),
    ['decide-conformance-gap', 'return-conformance-gap', 'reuse-recorded-evidence', 'record-fresh-run', 'raise-upstream-issue']);
  assert.match(plan.steps[0].command, /^singularity-flow upstream-issue decide UPI-001 --work-id GAP-1 --outcome accept-risk --expires <YYYY-MM-DD> --reason <why>$/u);
  assert.match(plan.steps[1].command, /--outcome return/u);
  assert.equal(plan.context?.strategy, 'person-decides-conformance-gap');
  assert.match(plan.retry.label, /Never edit the verdict/u);
  assert.equal(plan.documentation?.section, 'conformance.verdict-incomplete');
  const projected = refusalDetails(refusal.details);
  assert.deepEqual(projected.conformanceGaps.map((gap) => [gap.clauseId, gap.status, gap.issue]),
    [[`${W}:REQ-001`, 'undecided', 'UPI-001'], [`${W}:AC-001`, 'unraised', undefined]]);
  assert.equal(projected.nextAction, plan.steps[0].command);
});

test('a decided gap stays visible but is no longer required before approval', () => {
  const decided = story({ issues: [issue('UPI-001', `${W}:REQ-001`)], decisions: [decision('UPI-001', 'dismiss')] });
  const advisories = inspectConformanceVerdictAdvisories(REPORT, { workflow: decided, phaseId: 'release', now: NOW });
  assert.deepEqual(advisories.map((entry) => [entry.clauseId, entry.details.status, entry.requiredBefore]),
    [[`${W}:REQ-001`, 'decided', null], [`${W}:AC-001`, 'unraised', 'approve']]);
  const projection = phaseResolutionProjection(decided, decided.phases.release, [], { advisories });
  assert.equal(projection.status, 'ready');
  assert.deepEqual(projection.advisories.map((entry) => [entry.requiredBefore, entry.choices.length]), [[null, 0], ['approve', 4]]);
  assert.ok(projection.advisories.every((entry) => entry.blocking === false));
});

test('before the step is submitted, a gap still offers its return routes, marked not yet', () => {
  const drafting = story({ status: 'in_progress' });
  const advisories = inspectConformanceVerdictAdvisories(REPORT, { workflow: drafting, phaseId: 'release', now: NOW });
  const { choices } = phaseResolutionProjection(drafting, drafting.phases.release, [], { advisories }).advisories.find((entry) => entry.requiredBefore === 'approve');
  assert.deepEqual(choices.map((choice) => choice.kind), ['upstream-issue', 'repair-return', 'evidence-reuse', 'fresh-recorded-run']);
  assert.deepEqual(choices.filter((choice) => !choice.admission.allowed).map((choice) => choice.kind), ['repair-return', 'fresh-recorded-run']);
});

test('a table that contradicts its own discrepancy text is called out, conservatively', () => {
  const report = [
    '| Clause | Evidence | Verdict |', '|---|---|---|',
    `| \`${W}:REQ-001\` | src/a.mjs | matched (hedged) |`,
    `| \`${W}:REQ-002\` | src/b.mjs | matched |`,
    `| \`${W}:AC-001\` | test | matched |`,
    `| \`${W}:AC-002\` | test | matched |`,
    `| \`${W}:AC-003\` | test | partial |`, '',
    '## Upstream discrepancies', '',
    'The Verification step claimed a 15-test run that SFlow never recorded, so REQ-001, REQ-002,',
    'and AC-001 remain partial. AC-002 is no longer partial.', '',
    '<!-- AC-002 partial inside a comment does not count -->',
    '```text', 'AC-002 partial inside a fence does not count', '```', '',
    '## Final conclusion', '', 'AC-002 partial outside the section does not count.'
  ].join('\n');
  assert.deepEqual(contradictedConformanceVerdicts(report).map((entry) => [entry.clauseId, entry.stated, entry.section]), [
    [`${W}:REQ-001`, 'partial', 'Upstream discrepancies'],
    [`${W}:REQ-002`, 'partial', 'Upstream discrepancies'],
    [`${W}:AC-001`, 'partial', 'Upstream discrepancies']
  ]);
  const impact = `| Clause | Verdict |\n|---|---|\n| AC-001 | matched |\n\n## Impact\n\n- AC-001 is missing its recorded run.\n`;
  assert.deepEqual(contradictedConformanceVerdicts(impact).map((entry) => [entry.clauseId, entry.stated, entry.section]), [['AC-001', 'missing', 'Impact']]);
  assert.deepEqual(contradictedConformanceVerdicts(REPORT), [], 'no discrepancy text, nothing to contradict');
  const [advisory] = inspectConformanceVerdictAdvisories(report).filter((entry) => entry.code === 'conformance.verdict-contradicted');
  assert.equal(advisory.blocking, false);
  assert.equal(advisory.requiredBefore, null);
  assert.match(advisory.message, /the table says matched, the Upstream discrepancies text says partial: use the honest verdict/u);
});

test('the Verdict summary is written from the table alone and refreshed in place', () => {
  const raised = story({ issues: [issue('UPI-001', `${W}:AC-001`)], decisions: [decision('UPI-001', 'accept-risk', '2026-11-01T00:00:00.000Z')] });
  const discrepancy = `${REPORT}\n\n## Upstream discrepancies\n\n- implementation: the delivered change is short of ${W}:REQ-001.\n`;
  const once = withVerdictSummary(discrepancy, raised, 'release', { now: NOW });
  assert.equal(withVerdictSummary(once, raised, 'release', { now: NOW }), once, 'refreshing an unchanged report changes nothing');
  assert.match(once, /\n## Verdict summary\n\n<!-- singularity-flow:verdict-summary:start -->\nEngine-written from the clause table; keep it\. The table is the only place a verdict is stated\.\n\n/u);
  assert.match(once, new RegExp(`^- \`${W}:REQ-001\`: partial; no issue raised yet; implementation owns it\\.$`, 'mu'));
  assert.match(once, new RegExp(`^- \`${W}:AC-001\`: missing; covered by UPI-001 \\(accepted risk until 2026-11-01\\)\\.$`, 'mu'));
  assert.equal(verdictSummaryStatus(once, raised, 'release', { now: NOW }).current, true);
  // The block is neither a verdict table nor discrepancy text, so it changes no check.
  assert.deepEqual(conformanceVerdictGaps(once), conformanceVerdictGaps(REPORT));
  assert.deepEqual(contradictedConformanceVerdicts(once), []);
  // When the table or a decision moves on, the summary is stale until the next prepare refreshes it.
  const fixed = once.replace(`| \`${W}:REQ-001\` | src/a.mjs | partial |`, `| \`${W}:REQ-001\` | src/a.mjs | matched |`);
  assert.equal(verdictSummaryStatus(fixed, raised, 'release', { now: NOW }).current, false);
  assert.equal(verdictSummaryStatus(once, raised, 'release', { now: LATER }).current, false, 'an expiry changes the summary');
  const refreshed = withVerdictSummary(fixed, raised, 'release', { now: NOW });
  assert.equal(refreshed.split('## Verdict summary').length, 2, 'refreshed in place, never appended twice');
  assert.doesNotMatch(refreshed, /REQ-001`: partial/u);
  assert.match(withVerdictSummary('# Report\n', raised, 'release', { now: NOW }), /^- No clause in the table is partial or missing\.$/mu);
});

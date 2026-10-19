import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { conformanceVerdictGaps } from '../src/conformance-verdicts.mjs';
import { conformanceGapDecisions, conformanceGapRefusal, upstreamIssueStates } from '../src/upstream-routes.mjs';
import { discrepancyItemSha256 } from '../src/upstream-issues.mjs';
import { decisionPacket, decisionRecordPlan, parseDecisionAnswers } from '../src/decision-list.mjs';
import { blockingDecisionFacts, pendingDecisionSummary } from '../src/decision-list-facts.mjs';
import { inspectConformanceVerdictAdvisories, verdictSummaryBlock } from '../src/conformance-readiness.mjs';
import { phaseResolutionProjection } from '../src/phase-resolution.mjs';
import { storyDecisionView, storyDecisionReadGuidance } from '../src/workflow-decisions.mjs';

const AT = '2026-10-19T09:00:00.000Z';
const W = 'LINK-1';
const C = [`${W}:REQ-001`, `${W}:AC-001`];
const actor = { name: 'Review Person', email: 'quality@example.test', login: null };

function fixture(ids = ['specification', 'implementation', 'verification', 'release'], { impact = 'The test portion of both clauses lacks a retained execution.', extraRow = '' } = {}) {
  const [scope, code, verify, report] = ids;
  const workflow = { workItem: { id: W }, status: 'in_progress', currentPhase: report, phaseOrder: ids,
    phases: Object.fromEntries(ids.map((id, index) => [id, { id, label: id.replaceAll('-', ' '), generation: 1,
      status: index === 3 ? 'awaiting_approval' : 'approved',
      ...(index === 1 ? { writeScope: 'source-and-artifact' } : {}),
      approvalPolicy: { authorities: [index === 2 ? 'quality-reviewers' : 'engineering-reviewers'], rejectTo: ids },
      requiredArtifact: { kind: ['requirements', 'implementation-summary', 'test-evidence', 'conformance-report'][index], path: `artifacts/${id}/report.md` }
    }])), upstreamIssueDecisions: [],
    resolution: { approvalAuthorities: {
      'quality-reviewers': { label: 'Quality reviewers', members: [{ email: actor.email }] },
      'engineering-reviewers': { label: 'Engineering reviewers', members: [{ email: 'engineer@example.test' }] }
    } } };
  const item = `**${verify}, “Acceptance results”:** the report claims 22 tests passed, but no execution was retained. Impact: ${impact} Proposed owner action: retain a genuine run.`;
  const reportPath = `team/work-items/${W}/${workflow.phases[report].requiredArtifact.path}`;
  workflow.upstreamIssues = [{ id: 'UPI-001', phase: verify, about: 'Acceptance results', problem: item, impact,
    source: { path: reportPath, itemSha256: discrepancyItemSha256(verify, item) } }];
  const markdown = ['# Comparison', '', '| Clause | Evidence | Verdict |', '|---|---|---|',
    `| ${C[0]} | ${verify}: missing retained execution | partial |`,
    `| ${C[1]} | valid visual review, ${verify}: missing retained execution | partial |`, extraRow,
    '', '## Upstream discrepancies', '', `- ${item}`, ''].join('\n');
  return { workflow, phaseId: report, code, verify, scope, markdown, reportPath };
}
const gapsOf = (f) => conformanceVerdictGaps(f.markdown, f);
const resolved = (f, at = AT) => conformanceGapDecisions(f.workflow, f.phaseId, gapsOf(f), { now: at });
function packetOf(f) {
  return decisionPacket(f.workflow, { phaseId: f.phaseId, gaps: resolved(f).map((gap) => ({ ...gap, report: f.phaseId })),
    issues: upstreamIssueStates(f.workflow, AT), endsStory: true, candidates: [] },
  { authorities: f.workflow.resolution.approvalAuthorities, actor, at: AT });
}

for (const ids of [undefined, ['intent', 'build', 'qa-check', 'close'], ['intake', 'repair', 'retest', 'acceptance']]) {
  test(`section-owned evidence gaps become one decision for the correct owner (${ids?.join('/') ?? 'standard'})`, () => {
    const f = fixture(ids); const original = JSON.stringify(f);
    assert.deepEqual(resolved(f).map((gap) => [gap.clauseId, gap.owner, gap.issue, gap.status]),
      C.map((id) => [id, f.verify, 'UPI-001', 'undecided']));
    const packet = packetOf(f);
    assert.equal(packet.items.length, 1);
    const [item] = packet.items;
    assert.deepEqual([item.details.issue, item.details.owner], ['UPI-001', f.verify]);
    assert.deepEqual(item.details.clauses, C);
    assert.deepEqual(item.options.find((option) => option.id === 'return').effects,
      [{ kind: 'upstream-issue-decision', issue: 'UPI-001', issuePhase: f.verify, outcome: 'return' }]);
    for (const option of item.options) {
      assert.deepEqual(option.decidedBy.groups, ['quality-reviewers']);
      assert.equal(option.decidedBy.allowed, true);
      assert.equal(option.effects.some((effect) => effect.kind === 'upstream-issue'), false, 'never raise the same issue again');
    }
    assert.match(item.why, /owns the linked upstream problem/u);
    assert.doesNotMatch(item.why, /delivered them/u);
    assert.equal(new Set(item.details.commands).size, item.details.commands.length);
    assert.equal(JSON.stringify(f), original, 'only a projection; no approved record is changed');
  });
}

test('advisories, repair routes, verdict summaries, approval and the terminal gate share the binding', () => {
  const f = fixture();
  const advisories = inspectConformanceVerdictAdvisories(f.markdown, { ...f, now: AT });
  assert.deepEqual(advisories.map((item) => [item.details.owner, item.details.issue]), C.map(() => [f.verify, 'UPI-001']));
  const projection = phaseResolutionProjection(f.workflow, f.workflow.phases[f.phaseId], [], { advisories });
  for (const item of projection.advisories) {
    assert.equal(item.choices[0].owner, f.verify);
    assert.match(JSON.stringify(item), /upstream-issue.*decide.*UPI-001/u);
    assert.ok(item.choices.every((choice) => !(choice.argv?.[0] === 'upstream-issue' && choice.argv?.[1] === 'raise')));
  }
  assert.match(verdictSummaryBlock(f.markdown, f.workflow, f.phaseId, { now: AT }), /UPI-001 raised against verification/u);
  const refusal = conformanceGapRefusal(f.workflow, f.phaseId, gapsOf(f), { now: AT });
  assert.deepEqual(refusal.gaps.map((gap) => gap.issue), ['UPI-001', 'UPI-001']);
  f.workflow.upstreamIssueDecisions.push({ issue: 'UPI-001', outcome: 'accept-risk', expiresAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(conformanceGapRefusal(f.workflow, f.phaseId, gapsOf(f), { now: AT }), null);
  assert.equal(conformanceGapRefusal(f.workflow, f.phaseId, gapsOf(f), { now: '2026-11-02T00:00:00.000Z' }).gaps.length, 2);
  assert.equal(resolved(f)[0].owner, f.verify, 'accepting or expiring a risk never changes the issue owner');
});

test('exact impact clauses and explicit row UPI references link issues without a short about clause', () => {
  const f = fixture(undefined, { impact: `${C[0]} is missing its retained test execution.` });
  assert.deepEqual(resolved(f).map((gap) => gap.issue), ['UPI-001', null]);
  f.markdown = f.markdown.replace('valid visual review,', 'UPI-001: valid visual review,');
  assert.deepEqual(resolved(f).map((gap) => gap.issue), ['UPI-001', 'UPI-001']);
  f.workflow.upstreamIssues[0].source.itemSha256 = '0'.repeat(64);
  assert.equal(resolved(f)[1].issue, 'UPI-001', 'a direct reference does not depend on prose provenance');
  f.workflow.upstreamIssues[0].impact = `OTHER:REQ-001 is missing its retained test execution.`;
  assert.equal(resolved(f)[0].issue, null, 'never match a foreign Story clause');
});

test('ambiguous, unrelated, changed, fenced and managed text cannot bind a section issue to all clauses', () => {
  for (const change of [
    (f) => { f.workflow.upstreamIssues[0].source.path = `other/work-items/${W}/unrelated.md`; },
    (f) => { f.workflow.upstreamIssues[0].source.itemSha256 = '0'.repeat(64); },
    (f) => { f.markdown = f.markdown.replace('both clauses', 'some clauses'); },
    (f) => { f.markdown = f.markdown.replace('## Upstream discrepancies', '```md\n## Upstream discrepancies') + '\n```'; },
    (f) => { f.markdown = f.markdown.replace('## Upstream discrepancies', '<!-- singularity-flow:inputs:start -->\n## Upstream discrepancies') + '\n<!-- singularity-flow:inputs:end -->'; }
  ]) {
    const f = fixture(); change(f);
    assert.ok(resolved(f).every((gap) => gap.issue === null));
  }
  const three = fixture(undefined, { extraRow: `| ${W}:AC-002 | another behavior | matched |` });
  assert.ok(resolved(three).every((gap) => gap.issue === null), 'both cannot mean any two of three');
});

test('multiple real issues stay separate, and an unrelated decided clause issue cannot clear a linked one', () => {
  const f = fixture();
  f.workflow.upstreamIssues.push({ id: 'UPI-002', phase: f.code, about: C[0], problem: 'Another independent defect in this requirement.' });
  f.workflow.upstreamIssueDecisions.push({ issue: 'UPI-002', outcome: 'dismiss' });
  assert.equal(resolved(f)[0].issue, 'UPI-001');
  assert.equal(resolved(f)[0].status, 'undecided');
  f.markdown = f.markdown.replace('verification: missing', 'UPI-001 and UPI-002: missing');
  f.workflow.upstreamIssueDecisions = [];
  const packet = packetOf(f);
  assert.equal(packet.items.length, 2);
  assert.deepEqual(packet.items.map((item) => item.details.issue).sort(), ['UPI-001', 'UPI-002']);
  const advisories = inspectConformanceVerdictAdvisories(f.markdown, { ...f, now: AT });
  const projection = phaseResolutionProjection(f.workflow, f.workflow.phases[f.phaseId], [], { advisories });
  for (const [index, item] of projection.advisories.entries()) {
    assert.equal(item.choices[0].argv[2], advisories[index].details.issue, 'each issue keeps its own resolution command');
    assert.equal(item.choices[0].owner, advisories[index].details.owner);
  }
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: ['d1=dismiss'] }), { at: AT });
  assert.equal(plan.steps[0].effects.some((effect) => effect.kind === 'upstream-issue'), false);
});

test('a superseding record carries explicit references to its predecessor without reviving the old decision', () => {
  const f = fixture();
  f.markdown = f.markdown.replace('verification: missing', 'UPI-001: missing');
  f.workflow.upstreamIssues.push({ ...f.workflow.upstreamIssues[0], id: 'UPI-002', supersedes: 'UPI-001' });
  assert.ok(resolved(f).every((gap) => gap.issue === 'UPI-002'));
  assert.equal(packetOf(f).items.length, 1);
});

test('file-backed next-step counts use the same single problem and do not change the report', async (t) => {
  const f = fixture();
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-issue-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, f.reportPath);
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, f.markdown);
  const config = { workItemRoot: 'team/work-items' };
  const facts = await blockingDecisionFacts(root, config, f.workflow, { phaseId: f.phaseId, at: AT });
  assert.equal(decisionPacket(f.workflow, facts, { authorities: f.workflow.resolution.approvalAuthorities, actor, at: AT }).items.length, 1);
  const summary = await pendingDecisionSummary(root, config, f.workflow, f.workflow.phases[f.phaseId], { at: AT });
  assert.equal(summary.count, 1);
  assert.equal(summary.command, `singularity-flow decisions ${W}`);
  assert.equal(summary.copilotCommand, `/sf-decide ${W}`);
  assert.equal(await readFile(file, 'utf8'), f.markdown);
});

test('an empty legacy routing array explicitly directs people to the consolidated decisions command', () => {
  const f = fixture();
  const view = { ...storyDecisionView(f.workflow), ...storyDecisionReadGuidance(f.workflow) };
  assert.deepEqual(view.decisions, []);
  assert.equal(view.coverage, 'workflow-routing-and-applicability');
  assert.match(view.instruction, /empty routing decisions array is not approval readiness/u);
  assert.equal(view.commandGuidance.pendingDecisions.command, `singularity-flow decisions ${W} --json`);
  assert.equal(view.commandGuidance.pendingDecisions.copilotCommand, `/sf-decide ${W}`);
});

test('the actual defect owner may be any earlier phase, never just a fixed Verification or code phase', () => {
  for (const owner of ['specification', 'implementation', 'verification']) {
    const f = fixture();
    const item = f.workflow.upstreamIssues[0].problem.replace('**verification,', `**${owner},`);
    f.markdown = f.markdown.replace(f.workflow.upstreamIssues[0].problem, item);
    Object.assign(f.workflow.upstreamIssues[0], { phase: owner, problem: item,
      source: { path: f.reportPath, itemSha256: discrepancyItemSha256(owner, item) } });
    assert.ok(resolved(f).every((gap) => gap.owner === owner && gap.issue === 'UPI-001'));
    assert.equal(packetOf(f).items.length, 1);
  }
});

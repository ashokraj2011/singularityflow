/**
 * The recorded facts the decision list is built from, read with the same readers approval and the
 * gates use, so the list and a refusal never disagree about what is open. [decision list]
 *
 * - Conformance gaps: every partial or missing verdict of the step itself (when it writes a
 *   conformance report) and of every approved conformance step, read from the report and decided by
 *   conformanceGapDecisions with the evidence reuses that still hold, exactly as approval reads them.
 * - Upstream issues: upstreamIssueStates; a superseded issue is not open.
 *
 * Reads only. The list adds reusable runs, test-run risks and screen sizes (decision-list-reads.mjs),
 * which nothing on a hot path loads. The pending-decision summary used by next steps and refusals
 * reads nothing when no conformance report or open issue exists.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { conformancePhasesOf, isConformancePhase } from './phase-roles.mjs';
import { OPEN_UPSTREAM_ISSUE_STATUSES, conformanceGapDecisions, decisionHeadline, decisionListRoute, decisionListRouteLine,
  upstreamIssueStates } from './upstream-routes.mjs';
import { workDir } from './story-paths.mjs';
import { SingularityFlowError } from './util.mjs';

const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** Whether completing `phase` would end the Story: every later step is skipped. */
export function phaseEndsStory(workflow, phase) {
  const order = workflow?.phaseOrder ?? [];
  const index = order.indexOf(phase?.id);
  return index >= 0 && order.slice(index + 1).every((id) => workflow.phases?.[id]?.status === 'skipped');
}

function writesConformanceReport(phase) {
  return phase?.requiredArtifact?.kind === 'conformance-report' || isConformancePhase(phase);
}

/** The conformance steps whose gaps hold `phase` back: its own report, and every approved one. */
function blockingReportSteps(workflow, phase) {
  const steps = new Map();
  for (const candidate of conformancePhasesOf(workflow)) {
    if (candidate.status === 'approved' && Number(candidate.generation) > 0) steps.set(candidate.id, candidate);
  }
  if (writesConformanceReport(phase) && Number(phase.generation) > 0 && phase.status !== 'skipped') steps.set(phase.id, phase);
  const order = workflow?.phaseOrder ?? [];
  return [...steps.values()].filter((step) => step.requiredArtifact?.path).sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
}

/** The Story's final step, submitted: where approval checks the evidence obligations a person decides. */
function evidenceDecisionsApply(workflow, phase) {
  return phase?.status === 'awaiting_approval' && phaseEndsStory(workflow, phase);
}

/**
 * The evidence decisions approval waits for at the Story's end (a slot to witness, an obligation to
 * accept as a dated risk), from the same evaluation the approval gate runs, so the list, next steps
 * and the refusal name the same things [decision list parity]. Empty anywhere else.
 */
export async function evidenceDecisionFacts(root, config, workflow, phase) {
  if (!evidenceDecisionsApply(workflow, phase)) return [];
  const { terminalReadinessOnce, terminalEvidenceDecisions } = await import('./evidence/terminal.mjs');
  const readiness = await terminalReadinessOnce(root, config, workflow, { stage: 'approval' });
  return terminalEvidenceDecisions(workflow.workItem.id, readiness.evaluation, workflow);
}

/** Whether anything could be open for `phase` without reading a file. */
export function decisionsMayBePending(workflow, phase) {
  if (!phase) return false;
  if (blockingReportSteps(workflow, phase).length) return true;
  if (evidenceDecisionsApply(workflow, phase)) return true;
  return phaseEndsStory(workflow, phase)
    && upstreamIssueStates(workflow).some((state) => OPEN_UPSTREAM_ISSUE_STATUSES.includes(state.status));
}

async function reportGaps(root, config, workflow, step, at) {
  const [{ conformanceVerdictGaps }, { conformanceEvidenceReuse }] = await Promise.all([
    import('./conformance-verdicts.mjs'), import('./conformance-readiness.mjs')]);
  const file = path.join(workDir(root, config, workflow.workItem.id), step.requiredArtifact.path);
  const report = await readFile(file, 'utf8');
  const reused = await conformanceEvidenceReuse(root, config, workflow, step.id, at);
  const gaps = conformanceGapDecisions(workflow, step.id, conformanceVerdictGaps(report, { workflow, phaseId: step.id }), { now: at, reused })
    .filter((gap) => gap.status !== 'decided')
    .map((gap) => ({ report: step.id, clauseId: gap.clauseId, verdict: gap.verdict, line: gap.line ?? null, owner: gap.owner,
      status: gap.status, issue: gap.issue, expiresAt: gap.expiresAt ?? null, choices: gap.choices }));
  return { gaps, digest: sha256(report), reused };
}

/**
 * What holds `phaseId` back that approval and the gates read: its undecided conformance gaps (and
 * those of approved conformance steps), the upstream issue states, the reuses that still hold, and
 * the reports' digests. The list adds reusable runs, test-run risks and screen sizes to these.
 */
export async function blockingDecisionFacts(root, config, workflow, { phaseId = workflow?.currentPhase ?? null, at = new Date().toISOString() } = {}) {
  const phase = phaseId ? workflow?.phases?.[phaseId] ?? null : null;
  if (!phase) {
    throw new SingularityFlowError(phaseId ? `Story ${workflow?.workItem?.id} has no step ${phaseId}.` : `Story ${workflow?.workItem?.id} has no current step.`,
      { code: 'DECISIONS_PHASE_UNKNOWN' });
  }
  const reports = [];
  const unavailable = [];
  for (const step of blockingReportSteps(workflow, phase)) {
    try { reports.push({ step, ...await reportGaps(root, config, workflow, step, at) }); }
    catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SingularityFlowError)) throw error;
      unavailable.push({ phase: step.id, reason: error.code ?? 'unreadable' });
    }
  }
  return {
    phase, phaseId: phase.id, at, endsStory: phaseEndsStory(workflow, phase), reports,
    gaps: reports.flatMap((entry) => entry.gaps), issues: upstreamIssueStates(workflow, at),
    activeReuse: [...new Map(reports.flatMap((entry) => entry.reused ?? []).map((entry) => [entry.id, entry])).values()],
    unavailable
  };
}

/**
 * The underlying problems, grouped the same way wherever they are counted: a gap with the open issue
 * that names it is one problem (all of that issue's clauses together); gaps no open issue names are one
 * problem per report and owning step. Superseded issues never appear; their replacement carries them.
 */
export function decisionGroups(workflow, { gaps = [], issues = [], includeAllIssues = false } = {}) {
  const open = new Map(issues.filter((state) => OPEN_UPSTREAM_ISSUE_STATUSES.includes(state.status)).map((state) => [state.issue.id, state]));
  const groups = new Map();
  for (const gap of gaps) {
    const issue = gap.issue && open.has(gap.issue) ? open.get(gap.issue) : null;
    const key = issue ? `issue:${issue.issue.id}` : `unraised:${gap.report}:${gap.owner}`;
    if (!groups.has(key)) groups.set(key, { kind: 'conformance-gap', issue: issue ? { ...issue.issue, status: issue.status, decision: issue.decision } : null,
      owner: issue?.issue.phase ?? gap.owner, gaps: [] });
    const existing = groups.get(key).gaps;
    if (!existing.some((entry) => entry.report === gap.report && entry.clauseId === gap.clauseId)) existing.push(gap);
  }
  const named = new Set([...groups.values()].map((group) => group.issue?.id).filter(Boolean));
  const issueGroupsList = includeAllIssues ? [...open.values()].filter((state) => !named.has(state.issue.id))
    .map((state) => ({ kind: 'upstream-issue', state })) : [];
  return [...groups.values(), ...issueGroupsList];
}

/**
 * What a refusal for pending decisions leads with: the plain sentence, its count from the same
 * grouping the list uses, and the decision-list route. `gaps` are undecided conformance gaps
 * (each with its report step); `issues` the upstream issue states.
 */
export function decisionRefusalLead(workflow, phaseId, { gaps = [], issues = [], includeAllIssues = false } = {}) {
  const count = decisionGroups(workflow, { gaps, issues, includeAllIssues }).length;
  if (!count) return null;
  const workId = workflow.workItem.id;
  return { count, headline: decisionHeadline(workflow, phaseId, count, { refused: true }), route: decisionListRouteLine(workId),
    nextAction: decisionListRoute(workId) };
}

/**
 * How many decisions hold `phase` back from approval or the Story's end, and the one route to them:
 * Copilot `/sf-decide WORK-ID`, Shell `singularity-flow decisions WORK-ID`. Null when none.
 */
export async function pendingDecisionSummary(root, config, workflow, phase, { at = new Date().toISOString() } = {}) {
  if (!decisionsMayBePending(workflow, phase)) return null;
  const facts = await blockingDecisionFacts(root, config, workflow, { phaseId: phase.id, at });
  // An unavailable evaluation is not "nothing to decide": approval reports it as its own refusal.
  const evidence = await evidenceDecisionFacts(root, config, workflow, phase).catch(() => []);
  const groups = decisionGroups(workflow, { gaps: facts.gaps, issues: facts.issues, includeAllIssues: facts.endsStory }).length;
  const count = groups + evidence.length;
  if (!count) return null;
  const workId = workflow.workItem.id;
  // Only evidence left: a person witnesses it or accepts a dated risk in their own terminal, which no
  // turn records, so the route is that command, not /sf-decide again.
  if (!groups) {
    const [first] = evidence;
    return { count, headline: decisionHeadline(workflow, phase.id, count), personal: true,
      command: first.witnesses[0]?.command ?? first.risks[0]?.command ?? `singularity-flow decisions ${workId}`,
      listCommand: `singularity-flow decisions ${workId}`, skill: null, copilotCommand: null };
  }
  return { count, headline: decisionHeadline(workflow, phase.id, count), command: `singularity-flow decisions ${workId}`,
    skill: '/sf-decide', copilotCommand: `/sf-decide ${workId}` };
}

/**
 * Upstream issues: a later phase records a defect in an earlier, approved phase and keeps working
 * while that phase's owners decide. `[UIF-M2]`
 *
 * Raising never blocks and needs no authority: any participant, including a governed agent that
 * found the problem, may raise one. Deciding belongs to the earlier phase's approvers: a plan
 * correction, a return, an accepted risk with an expiry, or a dismissal. Only completion needs every
 * issue decided, so a defect found late is resolved by its owner instead of stalling the phase that
 * found it.
 *
 * Both lists are append-only: an issue is never edited, and its decision is a separate record, so
 * each raise or decision is one appended entry. Pure: no I/O.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SingularityFlowError } from './util.mjs';

export const UPSTREAM_ISSUE_OUTCOMES = Object.freeze(['plan-correction', 'amend', 'return', 'accept-risk', 'dismiss']);
export const UPSTREAM_ISSUE_PROPOSALS = Object.freeze(['plan-correction', 'amend', 'return', 'accept-risk', 'unknown']);
const MAX_RISK_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
const text = (minimum, maximum) => z.string().trim().min(minimum).max(maximum);
const optionalText = z.string().trim().min(1).max(1000).nullable();

export const UpstreamIssueSchema = z.strictObject({
  id: z.string().regex(/^UPI-\d{3,}$/u),
  phase: z.string().min(1),
  raisedIn: z.strictObject({ phase: z.string().min(1).nullable(), status: z.string().min(1).nullable(), generation: z.number().int().nonnegative().nullable() }),
  about: text(1, 200), problem: text(20, 1000), assumption: optionalText, impact: optionalText,
  proposed: z.enum(UPSTREAM_ISSUE_PROPOSALS),
  producerGeneration: z.number().int().nonnegative(),
  producerArtifacts: z.array(z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable() })).max(50),
  source: z.strictObject({ path: z.string().min(1).max(512), itemSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).nullable(),
  raisedBy: z.string().min(1), authored: z.enum(['human', 'governed-agent']), agent: z.string().min(1).nullable(),
  at: z.string().datetime()
});

export const UpstreamIssueDecisionSchema = z.strictObject({
  issue: z.string().regex(/^UPI-\d{3,}$/u),
  outcome: z.enum(UPSTREAM_ISSUE_OUTCOMES),
  reason: text(20, 1000),
  link: z.string().regex(/^(?:PRC-\d{3,}|CR-\d{3,}|FAM-\d{3,})$/u).nullable(),
  expiresAt: z.string().datetime().nullable(),
  actor: z.string().min(1), authorityGroup: z.string().min(1), identityAssurance: z.string().nullable(),
  at: z.string().datetime()
});

function refused(message, code = 'UPSTREAM_ISSUE_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function order(workflow) {
  return workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
}

/** The earlier phase's approval groups decide; a later phase's reviewers cannot rule on it. */
export function upstreamIssueAuthorities(workflow, phaseId) {
  const policy = workflow?.phases?.[phaseId]?.approvalPolicy ?? {};
  return [...new Set([...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])])].sort();
}

/** The digest that makes `--from-artifact` idempotent per recorded item. */
export function discrepancyItemSha256(phaseId, itemText) {
  return createHash('sha256').update(`${phaseId}\n${String(itemText).replace(/\s+/gu, ' ').trim()}`).digest('hex');
}

/** Record one issue against an earlier phase that has run. */
export function raiseUpstreamIssue(workflow, {
  phase, about, problem, assumption = null, impact = null, proposed = 'unknown', raisedBy, authored = 'human',
  agent = null, source = null, at
}) {
  const current = workflow.currentPhase ?? null;
  const ids = order(workflow);
  const target = workflow.phases?.[phase];
  if (!target) refused(`${phase || 'That phase'} is not a step of this Story.`);
  // A Story that finished has no current phase; an issue then is about any step before its end.
  const limit = current ? ids.indexOf(current) : ids.length;
  if (ids.indexOf(phase) < 0 || ids.indexOf(phase) >= limit) {
    refused(`An upstream issue is about an earlier step; ${phase} is not before ${current ?? 'the end of the Story'}.`, 'UPSTREAM_ISSUE_NOT_EARLIER');
  }
  if (!(Number(target.generation) > 0) || target.status === 'not_started') {
    refused(`${phase} has not produced anything yet, so there is nothing upstream to raise.`, 'UPSTREAM_ISSUE_NOT_EARLIER');
  }
  workflow.upstreamIssues ??= [];
  const issue = {
    id: `UPI-${String(workflow.upstreamIssues.length + 1).padStart(3, '0')}`,
    phase,
    raisedIn: { phase: current, status: current ? workflow.phases?.[current]?.status ?? null : null,
      generation: current ? Number(workflow.phases?.[current]?.generation ?? 0) : null },
    about: String(about ?? '').trim(), problem: String(problem ?? '').trim(),
    assumption: assumption == null || !String(assumption).trim() ? null : String(assumption).trim(),
    impact: impact == null || !String(impact).trim() ? null : String(impact).trim(),
    proposed, producerGeneration: Number(target.generation),
    producerArtifacts: (target.artifacts ?? []).slice(0, 50).map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 ?? null })),
    source, raisedBy, authored, agent, at
  };
  const checked = UpstreamIssueSchema.safeParse(issue);
  if (!checked.success) {
    const field = checked.error.issues[0]?.path?.join('.') ?? 'issue';
    refused(`The upstream issue is not well formed (${field}): ${checked.error.issues[0]?.message ?? 'invalid'}. `
      + 'Name --about (1-200 characters) and --problem (20-1000 characters).');
  }
  workflow.upstreamIssues.push(checked.data);
  return checked.data;
}

/** Each issue with its latest decision and whether it is still open at `now`. */
export function upstreamIssueStates(workflow, now = new Date().toISOString()) {
  const decisions = workflow?.upstreamIssueDecisions ?? [];
  return (workflow?.upstreamIssues ?? []).map((issue) => {
    const decision = decisions.findLast((entry) => entry?.issue === issue.id) ?? null;
    const expired = decision?.outcome === 'accept-risk' && decision.expiresAt && Date.parse(decision.expiresAt) <= Date.parse(now);
    return { issue, decision, status: !decision ? 'open' : expired ? 'expired' : 'decided' };
  });
}

/** Issues completion still waits for: undecided, or an accepted risk that expired. */
export function openUpstreamIssues(workflow, now = new Date().toISOString()) {
  return upstreamIssueStates(workflow, now).filter((entry) => entry.status !== 'decided');
}

export function upstreamIssueDecideCommand(workId, issue) {
  return `singularity-flow upstream-issue decide ${issue.id} --work-id ${workId} --outcome plan-correction|return|accept-risk|dismiss --reason "<why>"`;
}

/** One terminal blocker per open issue, with its exact decide command. */
export function upstreamIssueTerminalBlockers(workflow, now = new Date().toISOString()) {
  return openUpstreamIssues(workflow, now).map(({ issue, status }) => ({
    code: 'UPSTREAM_ISSUES_OPEN',
    message: `${issue.id} about ${issue.phase} (${issue.about}) ${status === 'expired' ? 'had its accepted risk expire' : 'is not decided'}; ${issue.phase}'s approvers decide it.`,
    command: upstreamIssueDecideCommand(workflow.workItem?.id ?? '<WORK-ID>', issue)
  }));
}

/**
 * Validate and record a decision. `return` is recorded by the caller together with the rework it
 * performs (its link is the change request); `amend` arrives with forward amendment.
 */
export function decideUpstreamIssue(workflow, {
  issue: issueId, outcome, reason, link = null, expiresAt = null, actor, authorityGroup, identityAssurance = null, at
}) {
  const state = upstreamIssueStates(workflow, at).find((entry) => entry.issue.id === issueId);
  if (!state) refused(`${issueId || 'That issue'} is not an upstream issue of this Story.`, 'UPSTREAM_ISSUE_NOT_FOUND');
  if (state.status === 'decided') {
    refused(`${issueId} is already decided (${state.decision.outcome}).`, 'UPSTREAM_ISSUE_DECIDED');
  }
  if (!UPSTREAM_ISSUE_OUTCOMES.includes(outcome)) refused(`--outcome must be one of ${UPSTREAM_ISSUE_OUTCOMES.join(', ')}.`);
  if (outcome === 'amend') {
    refused('Forward amendment is not available yet; correct the plan, return to the step, or accept the risk.', 'UPSTREAM_ISSUE_OUTCOME_UNAVAILABLE');
  }
  if (outcome === 'plan-correction') {
    const correction = (workflow.planAmendments ?? []).find((entry) => entry?.kind === 'plan-row-correction' && entry.id === link);
    if (!correction) refused(`Name the plan correction that resolves ${issueId} with --link PRC-NNN.`);
    if (correction.ownerPhase !== state.issue.phase) {
      refused(`${link} corrects ${correction.ownerPhase}, but ${issueId} is about ${state.issue.phase}.`);
    }
    if (correction.upstreamIssue && correction.upstreamIssue !== issueId) {
      refused(`${link} was recorded for ${correction.upstreamIssue}, not ${issueId}.`);
    }
  } else if (outcome === 'return') {
    if (!/^CR-\d{3,}$/u.test(link ?? '')) refused('A return records the change request it opened.');
  } else if (link) {
    refused(`--link is used only with --outcome plan-correction.`);
  }
  let expiry = null;
  if (outcome === 'accept-risk') {
    const parsed = Date.parse(expiresAt ?? '');
    if (!Number.isFinite(parsed) || parsed <= Date.parse(at) || parsed - Date.parse(at) > MAX_RISK_DAYS * DAY) {
      refused(`An accepted risk expires: give --expires within ${MAX_RISK_DAYS} days.`, 'UPSTREAM_ISSUE_RISK_EXPIRY_REQUIRED');
    }
    expiry = new Date(parsed).toISOString();
  } else if (expiresAt) {
    refused('--expires is used only with --outcome accept-risk.');
  }
  const decision = { issue: issueId, outcome, reason: String(reason ?? '').trim(), link: link ?? null, expiresAt: expiry,
    actor, authorityGroup, identityAssurance, at };
  const checked = UpstreamIssueDecisionSchema.safeParse(decision);
  if (!checked.success) refused('Say why in 20 to 1000 characters with --reason.', 'UPSTREAM_ISSUE_REASON_REQUIRED');
  workflow.upstreamIssueDecisions ??= [];
  workflow.upstreamIssueDecisions.push(checked.data);
  return checked.data;
}

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
import { upstreamIssueStates } from './upstream-routes.mjs';
import { SingularityFlowError } from './util.mjs';

// The pure state read lives with the routes, which every lifecycle command already loads, so the
// conformance gate can ask it without loading this module's schemas [owner decision 2026-10-19].
export { upstreamIssueStates };

export const UPSTREAM_ISSUE_OUTCOMES = Object.freeze(['plan-correction', 'amend', 'return', 'accept-risk', 'dismiss']);
export const UPSTREAM_ISSUE_PROPOSALS = Object.freeze(['plan-correction', 'amend', 'return', 'accept-risk', 'unknown']);
/** The longest problem an issue records; a longer recorded item is refused, never cut. */
export const UPSTREAM_ISSUE_PROBLEM_MAXIMUM = 1000;
const MAX_RISK_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
const text = (minimum, maximum) => z.string().trim().min(minimum).max(maximum);
const optionalText = z.string().trim().min(1).max(1000).nullable();

export const UpstreamIssueSchema = z.strictObject({
  id: z.string().regex(/^UPI-\d{3,}$/u),
  phase: z.string().min(1),
  raisedIn: z.strictObject({ phase: z.string().min(1).nullable(), status: z.string().min(1).nullable(), generation: z.number().int().nonnegative().nullable() }),
  about: text(1, 200), problem: text(20, UPSTREAM_ISSUE_PROBLEM_MAXIMUM), assumption: optionalText, impact: optionalText,
  proposed: z.enum(UPSTREAM_ISSUE_PROPOSALS),
  producerGeneration: z.number().int().nonnegative(),
  producerArtifacts: z.array(z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable() })).max(50),
  source: z.strictObject({ path: z.string().min(1).max(512), itemSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).nullable(),
  // Optional and written only when set: the open issue this one replaces (a wrong owning step).
  supersedes: z.string().regex(/^UPI-\d{3,}$/u).optional(),
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

// Story-qualified clause IDs (`W:REQ-001`) and bare ones; record IDs (UPI, CR, PRC, FAM) are not clauses.
const CLAUSE_IDS = /\b(?:[A-Z0-9][A-Z0-9._-]{0,63}:)?[A-Z]{2,4}-\d{3}\b/gu;
const RECORD_ID = /(?:^|:)(?:UPI|CR|PRC|FAM)-\d{3}$/u;

/** `parts` joined within `maximum` characters, naming how many did not fit; null when none fits. */
function fittedList(parts, separator, maximum = 200) {
  for (let count = parts.length; count > 0; count -= 1) {
    const value = `${parts.slice(0, count).join(separator)}${count < parts.length ? ` and ${parts.length - count} more` : ''}`;
    if (value.length <= maximum) return value;
  }
  return null;
}

/**
 * What `--from-artifact` records for one item: its whole text as the problem, the clause IDs it
 * names anywhere (else its section titles) as what it is about, and its own Assumption, Impact and
 * Proposed owner action fields. A proposal is read only when it opens with one of the proposal
 * kinds; anything else stays 'unknown' and its words stay in the problem.
 */
export function discrepancyIssueFields(item) {
  const text = String(item?.text ?? '').trim();
  const ids = [...new Set(text.match(CLAUSE_IDS) ?? [])].filter((id) => !RECORD_ID.test(id));
  const action = String(item?.proposed ?? '').replace(/[*_`]/gu, '').trim();
  const proposed = UPSTREAM_ISSUE_PROPOSALS.find((kind) => kind !== 'unknown'
    && new RegExp(`^${kind.replace('-', '[- ]')}(?![\\p{L}\\p{N}-])`, 'iu').test(action)) ?? 'unknown';
  return {
    about: fittedList(ids, ', ') ?? fittedList(item?.sections ?? [], ' / ') ?? 'recorded discrepancy',
    problem: text.length >= 20 ? text : `Recorded discrepancy: ${text}`,
    assumption: item?.assumption ?? null, impact: item?.impact ?? null, proposed
  };
}

/**
 * Sort the items a step's own documents record (`{ path, item }`) for `--from-artifact`: requests
 * to raise; items without exactly one earlier owning step, never raised on a guess; and items too
 * long to record whole. An item already filed is skipped, including one filed under the 300
 * characters the reader once kept. One filed against another step (the reader once took the first
 * step named anywhere in the text) is replaced: the new issue supersedes it while it is open.
 */
export function discrepancyIssueRequests(workflow, entries) {
  const states = upstreamIssueStates(workflow);
  const raised = new Set(states.map(({ issue }) => issue.source?.itemSha256).filter(Boolean));
  const requests = [];
  const unowned = [];
  const tooLong = [];
  for (const { path, item } of entries) {
    const fields = discrepancyIssueFields(item);
    const target = workflow.phases?.[item.phase];
    // An owner that has not run (a skipped step) has nothing to decide; the author names another.
    const owner = item.phase && (!(Number(target?.generation) > 0) || target.status === 'not_started')
      ? { ...item.owner, status: 'not-run' } : item.owner;
    if (!item.phase || owner !== item.owner) {
      unowned.push({ path, text: item.text, owner, about: fields.about });
      continue;
    }
    const texts = [...new Set([item.text, item.legacyText ?? item.text])];
    const itemSha256 = discrepancyItemSha256(item.phase, item.text);
    if (texts.some((text) => raised.has(discrepancyItemSha256(item.phase, text)))
      || requests.some((entry) => entry.source.itemSha256 === itemSha256)) continue;
    const prior = states.find(({ issue }) => issue.phase !== item.phase && issue.source?.path === path
      && texts.some((text) => discrepancyItemSha256(issue.phase, text) === issue.source.itemSha256));
    if (prior?.supersededBy) continue;
    if (fields.problem.length > UPSTREAM_ISSUE_PROBLEM_MAXIMUM) {
      tooLong.push({ path, length: fields.problem.length, text: item.text });
      continue;
    }
    const supersedes = prior && prior.status !== 'decided' && !requests.some((entry) => entry.supersedes === prior.issue.id) ? prior.issue.id : null;
    requests.push({ phase: item.phase, ...fields, source: { path, itemSha256 }, supersedes });
  }
  return { requests, unowned, tooLong };
}

/** Record one issue against an earlier phase that has run. */
export function raiseUpstreamIssue(workflow, {
  phase, about, problem, assumption = null, impact = null, proposed = 'unknown', raisedBy, authored = 'human',
  agent = null, source = null, supersedes = null, at
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
  if (supersedes != null) {
    // The replaced issue keeps its history; only its own step's approvers close it (as dismiss).
    const prior = upstreamIssueStates(workflow, at).find((entry) => entry.issue.id === supersedes);
    if (!prior) refused(`${supersedes || 'That issue'} is not an upstream issue of this Story, so there is nothing to supersede.`, 'UPSTREAM_ISSUE_SUPERSEDE_INVALID');
    if (prior.status === 'decided') {
      refused(`${supersedes} is already decided (${prior.decision.outcome}); raise the new issue without --supersedes.`, 'UPSTREAM_ISSUE_SUPERSEDE_INVALID');
    }
    if (prior.supersededBy) refused(`${supersedes} is already superseded by ${prior.supersededBy}.`, 'UPSTREAM_ISSUE_SUPERSEDE_INVALID');
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
    source, ...(supersedes != null ? { supersedes } : {}), raisedBy, authored, agent, at
  };
  const checked = UpstreamIssueSchema.safeParse(issue);
  if (!checked.success) {
    const field = checked.error.issues[0]?.path?.join('.') ?? 'issue';
    refused(`The upstream issue is not well formed (${field}): ${checked.error.issues[0]?.message ?? 'invalid'}. `
      + `Name --about (1-200 characters) and --problem (20-${UPSTREAM_ISSUE_PROBLEM_MAXIMUM} characters).`);
  }
  workflow.upstreamIssues.push(checked.data);
  return checked.data;
}

/** Issues completion still waits for: undecided, or an accepted risk that expired. */
export function openUpstreamIssues(workflow, now = new Date().toISOString()) {
  return upstreamIssueStates(workflow, now).filter((entry) => entry.status !== 'decided');
}

/** The decide command; a superseded issue is decided as a dismissal naming its replacement. */
export function upstreamIssueDecideCommand(workId, issue, supersededBy = null) {
  if (supersededBy) return `singularity-flow upstream-issue decide ${issue.id} --work-id ${workId} --outcome dismiss --reason "Superseded by ${supersededBy}."`;
  return `singularity-flow upstream-issue decide ${issue.id} --work-id ${workId} --outcome plan-correction|amend|return|accept-risk|dismiss --reason "<why>"`;
}

/** One terminal blocker per open issue, with its exact decide command. */
export function upstreamIssueTerminalBlockers(workflow, now = new Date().toISOString()) {
  return openUpstreamIssues(workflow, now).map(({ issue, status, supersededBy }) => ({
    code: 'UPSTREAM_ISSUES_OPEN',
    message: `${issue.id} about ${issue.phase} (${issue.about}) ${status === 'expired' ? 'had its accepted risk expire' : 'is not decided'}`
      + `${supersededBy ? `; it is superseded by ${supersededBy}, so ${issue.phase}'s approvers decide it as dismiss.` : `; ${issue.phase}'s approvers decide it.`}`,
    command: upstreamIssueDecideCommand(workflow.workItem?.id ?? '<WORK-ID>', issue, supersededBy)
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
    // The issue is resolved by the approved forward amendment of the same step [UIF-M3].
    const amendment = (workflow.forwardAmendments ?? []).find((entry) => entry.id === link);
    const approved = (workflow.forwardAmendmentDecisions ?? []).findLast((entry) => entry.amendment === link);
    if (!amendment || approved?.decision !== 'approved') refused(`Name the approved forward amendment that resolves ${issueId} with --link FAM-NNN.`);
    if (amendment.phase !== state.issue.phase) refused(`${link} amends ${amendment.phase}, but ${issueId} is about ${state.issue.phase}.`);
  } else if (outcome === 'plan-correction') {
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
    refused(`--link is used only with --outcome plan-correction or amend.`);
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

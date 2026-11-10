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
import {z} from 'zod';
import {upstreamRecordShapes} from './kernel/upstream-issues.mjs';
import { discrepancyItemSha256 } from './records.mjs';
import { countedRecords } from './presence/counted.mjs';
import { decidableUpstreamStep, OPEN_UPSTREAM_ISSUE_STATUSES, upstreamIssueAuthorities, upstreamIssueOutcomes, upstreamIssueStates } from './upstream-routes.mjs';

// The pure state read lives with the routes, which every lifecycle command already loads, so the
// conformance gate can ask it without loading this module's schemas [owner decision 2026-10-19].
export { decidableUpstreamStep, upstreamIssueAuthorities, upstreamIssueStates };
export { discrepancyItemSha256 };

export {UPSTREAM_ISSUE_OUTCOMES,UPSTREAM_ISSUE_PROPOSALS,UPSTREAM_ISSUE_PROBLEM_MAXIMUM} from './kernel/upstream-issues.mjs';
import {UPSTREAM_ISSUE_PROPOSALS,UPSTREAM_ISSUE_PROBLEM_MAXIMUM,raiseUpstreamIssue as raiseObservedIssue,decideUpstreamIssue as decideObservedIssue} from './kernel/upstream-issues.mjs';

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
export function raiseUpstreamIssue(workflow,input) {
  return raiseObservedIssue(workflow,input,{issueDecisions:countedRecords(workflow,workflow.upstreamIssueDecisions)});
}

/** Issues completion still waits for: undecided, or an accepted risk that expired. A superseded issue is not one. */
export function openUpstreamIssues(workflow, now = new Date().toISOString()) {
  return upstreamIssueStates(workflow, now).filter((entry) => OPEN_UPSTREAM_ISSUE_STATUSES.includes(entry.status));
}

/** The decide command; a superseded issue, should its approvers close it, is dismissed naming its replacement. */
export function upstreamIssueDecideCommand(workId, issue, supersededBy = null, workflow = null) {
  if (supersededBy) return `singularity-flow upstream-issue decide ${issue.id} --work-id ${workId} --outcome dismiss --reason "Superseded by ${supersededBy}."`;
  return `singularity-flow upstream-issue decide ${issue.id} --work-id ${workId} --outcome ${upstreamIssueOutcomes(workflow, issue.phase)} --reason "<why>"`;
}

/** One terminal blocker per open issue, with its exact decide command. A superseded issue blocks nothing. */
export function upstreamIssueTerminalBlockers(workflow, now = new Date().toISOString()) {
  return openUpstreamIssues(workflow, now).map(({ issue, status }) => ({
    code: 'UPSTREAM_ISSUES_OPEN',
    message: `${issue.id} about ${issue.phase} (${issue.about}) ${status === 'expired' ? 'had its accepted risk expire' : 'is not decided'}; ${issue.phase}'s approvers decide it.`,
    command: upstreamIssueDecideCommand(workflow.workItem?.id ?? '<WORK-ID>', issue, null, workflow)
  }));
}

/**
 * Validate and record a decision. `return` is recorded by the caller together with the rework it
 * performs (its link is the change request); `amend` arrives with forward amendment.
 */
export function decideUpstreamIssue(workflow,input) {
  return decideObservedIssue(workflow,input,{issueDecisions:countedRecords(workflow,workflow.upstreamIssueDecisions),
    amendmentDecisions:countedRecords(workflow,workflow.forwardAmendmentDecisions),planAmendments:countedRecords(workflow,workflow.planAmendments)});
}

const UPSTREAM_RECORD_SHAPES=upstreamRecordShapes();
// Compatibility schema APIs are compiled from the same pure structural declarations.
function schema(rule){
  let value;
  if(rule.kind==='string'){value=z.string();if(rule.trim)value=value.trim();if(rule.minimum!=null)value=value.min(rule.minimum);if(rule.maximum!=null)value=value.max(rule.maximum);if(rule.pattern)value=value.regex(new RegExp(rule.pattern,'u'));}
  else if(rule.kind==='datetime')value=z.string().datetime();
  else if(rule.kind==='enum')value=z.enum(rule.values);
  else if(rule.kind==='integer')value=z.number().int().nonnegative();
  else if(rule.kind==='array')value=z.array(schema(rule.item)).max(rule.maximum);
  else if(rule.kind==='record')value=z.record(z.string(),z.unknown());
  else value=z.strictObject(Object.fromEntries(Object.entries(rule.fields).map(([key,field])=>[key,schema(field)])));
  if(rule.nullable)value=value.nullable();if(rule.optional)value=value.optional();return value;
}
export const UpstreamIssueSchema=schema(UPSTREAM_RECORD_SHAPES.issue);
export const UpstreamIssueDecisionSchema=schema(UPSTREAM_RECORD_SHAPES.decision);

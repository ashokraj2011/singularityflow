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
import {upstreamRecordShapes,upstreamDiscrepancyPolicies} from './kernel/upstream-issues.mjs';
import { discrepancyItemSha256,NODE_TEXT_DIGESTS } from './records.mjs';
import { countedRecords } from './presence/counted.mjs';
import { decidableUpstreamStep, OPEN_UPSTREAM_ISSUE_STATUSES, upstreamIssueAuthorities, upstreamIssueOutcomes, upstreamIssueStates } from './upstream-routes.mjs';

// The pure state read lives with the routes, which every lifecycle command already loads, so the
// conformance gate can ask it without loading this module's schemas [owner decision 2026-10-19].
export { decidableUpstreamStep, upstreamIssueAuthorities, upstreamIssueStates };
export { discrepancyItemSha256 };

export {UPSTREAM_ISSUE_OUTCOMES,UPSTREAM_ISSUE_PROPOSALS,UPSTREAM_ISSUE_PROBLEM_MAXIMUM} from './kernel/upstream-issues.mjs';
import {UPSTREAM_ISSUE_PROPOSALS,UPSTREAM_ISSUE_PROBLEM_MAXIMUM,raiseUpstreamIssue as raiseObservedIssue,decideUpstreamIssue as decideObservedIssue} from './kernel/upstream-issues.mjs';

const discrepancies=/* @__PURE__ */ upstreamDiscrepancyPolicies(NODE_TEXT_DIGESTS);
export const discrepancyIssueFields=/* @__PURE__ */ (()=>discrepancies.discrepancyIssueFields)();
export function discrepancyIssueRequests(workflow,entries){return discrepancies.discrepancyIssueRequests(workflow,entries,{states:upstreamIssueStates(workflow)});}

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

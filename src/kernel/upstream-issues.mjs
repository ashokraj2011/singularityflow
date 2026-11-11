import {parseRecordShape as parseRecord} from '../foundation/record-shapes.mjs';
import {textDigestCapability} from '../foundation/record-schema.mjs';
/** Append-only upstream rules over admitted observations. No discovery, presence registry or wall clock. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {upstreamDispositionFacts} from './decision-plan.mjs';
import {reopenPhaseRange} from './lifecycle-transitions.mjs';
import {applyNamespaceRepairBudget} from './test-recovery.mjs';
export const NAMESPACE_UPSTREAM_RETURN_PROFILE='sflow-namespace-upstream-return/v1';
export const NAMESPACE_UPSTREAM_BOUNDED_RETURN_PROFILE='sflow-namespace-upstream-return/v2';
export const isNamespaceUpstreamReturnProfile=value=>[NAMESPACE_UPSTREAM_RETURN_PROFILE,NAMESPACE_UPSTREAM_BOUNDED_RETURN_PROFILE].includes(value);
export const UPSTREAM_ISSUE_OUTCOMES = Object.freeze(['plan-correction', 'amend', 'return', 'accept-risk', 'dismiss']);
export const UPSTREAM_ISSUE_PROPOSALS = Object.freeze(['plan-correction', 'amend', 'return', 'accept-risk', 'unknown']);
/** The longest problem an issue records; a longer recorded item is refused, never cut. */
export const UPSTREAM_ISSUE_PROBLEM_MAXIMUM = 1000;
// The structural contract is data so native Zod APIs and the standalone parser share one shape.
const string=(minimum=1,maximum=null,trim=false)=>({kind:'string',minimum,maximum,trim});
const nullable=value=>({...value,nullable:true}),optional=value=>({...value,optional:true});
const regex=pattern=>({...string(),pattern}),enumeration=values=>({kind:'enum',values});
const integer={kind:'integer',minimum:0},datetime={kind:'datetime'},object=fields=>({kind:'object',fields});
export function upstreamRecordShapes(){
const issueFields={
  id:regex('^UPI-\\d{3,}$'),phase:string(),
  raisedIn:object({phase:nullable(string()),status:nullable(string()),generation:nullable(integer)}),
  about:string(1,200,true),problem:string(20,UPSTREAM_ISSUE_PROBLEM_MAXIMUM,true),
  assumption:nullable(string(1,1000,true)),impact:nullable(string(1,1000,true)),proposed:enumeration(UPSTREAM_ISSUE_PROPOSALS),
  producerGeneration:integer,producerArtifacts:{kind:'array',maximum:50,item:object({path:string(),sha256:nullable(regex('^[a-f0-9]{64}$'))})},
  source:nullable(object({path:string(1,512),itemSha256:regex('^[a-f0-9]{64}$')})),supersedes:optional(regex('^UPI-\\d{3,}$')),
  raisedBy:string(),authored:enumeration(['human','governed-agent']),agent:nullable(string()),at:datetime
};
const decisionFields={issue:regex('^UPI-\\d{3,}$'),outcome:enumeration(UPSTREAM_ISSUE_OUTCOMES),reason:string(20,1000,true),
  link:nullable(regex('^(?:PRC-\\d{3,}|CR-\\d{3,}|FAM-\\d{3,})$')),expiresAt:nullable(datetime),actor:string(),authorityGroup:string(),
  identityAssurance:nullable(string(0)),at:datetime,presence:optional({kind:'record'})};
function freeze(value){if(value&&typeof value==='object'){for(const entry of Object.values(value))freeze(entry);Object.freeze(value);}return value;}
return freeze({issue:object(issueFields),decision:object(decisionFields)});
}
const issueCodec=Object.freeze({safeParse:value=>parseRecord(upstreamRecordShapes().issue,value)}),
  decisionCodec=Object.freeze({safeParse:value=>parseRecord(upstreamRecordShapes().decision,value)});


function refused(message, code = 'UPSTREAM_ISSUE_INVALID', details = undefined) {
  throw new SingularityFlowError(message, {code, ...(details ? {details} : {})});
}
function order(workflow) {return workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});}

export function upstreamIssueAuthorities(workflow, phaseId) {
  const policy = workflow?.phases?.[phaseId]?.approvalPolicy ?? {};
  return [...new Set([...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])])].sort();
}

/**
 * The step an issue about `phaseId` can be decided at: `phaseId` when it has approvers, else the
 * nearest step before it that has run and has approvers, else null. An issue raised against a step
 * with no approval group could never be decided, and the Story could never finish while it was open
 * (quick-fix implement, poc-lite steps; 2026-10-27 blocker audit).
 */
export function decidableUpstreamStep(workflow, phaseId) {
  const ids = workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
  for (let index = ids.indexOf(phaseId); index >= 0; index -= 1) {
    const candidate = workflow.phases?.[ids[index]];
    if (upstreamIssueAuthorities(workflow, ids[index]).length && Number(candidate?.generation) > 0 && candidate.status !== 'not_started') return ids[index];
  }
  return null;
}

export function upstreamIssueStates(workflow, now, observedDecisions = workflow?.upstreamIssueDecisions ?? []) {
  const decisions = observedDecisions;
  const replacements = new Map();
  for (const issue of workflow?.upstreamIssues ?? []) {
    if (issue?.supersedes && !replacements.has(issue.supersedes)) replacements.set(issue.supersedes, issue.id);
  }
  return (workflow?.upstreamIssues ?? []).map((issue) => {
    const decision = decisions.findLast((entry) => entry?.issue === issue.id) ?? null;
    const expired = decision?.outcome === 'accept-risk' && decision.expiresAt && Date.parse(decision.expiresAt) <= Date.parse(now);
    const supersededBy = replacements.get(issue.id) ?? null;
    const status = decision && !expired ? 'decided' : supersededBy ? 'superseded' : !decision ? 'open' : 'expired';
    return { issue, decision, status, supersededBy };
  });
}

export function raiseUpstreamIssue(workflow, {
  phase, about, problem, assumption = null, impact = null, proposed = 'unknown', raisedBy, authored = 'human',
  agent = null, source = null, supersedes = null, at
}, records = {}) {
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
  if (!upstreamIssueAuthorities(workflow, phase).length) {
    const instead = decidableUpstreamStep(workflow, phase);
    refused(`${phase} has no approval group, so nobody could decide an issue about it and the Story could not finish while it was open. `
      + (instead ? `Raise it against ${instead}, the nearest earlier step whose approvers can decide it.`
        : 'No earlier step has approvers either: describe the problem in this step\'s own document for its reviewers.'),
    'UPSTREAM_ISSUE_AUTHORITY_UNAVAILABLE', { phase, ...(instead ? { decidableStep: instead } : {}) });
  }
  if (supersedes != null) {
    // The replaced issue keeps its history; only its own step's approvers close it (as dismiss).
    const prior = upstreamIssueStates(workflow, at, records.issueDecisions).find((entry) => entry.issue.id === supersedes);
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
  const checked = issueCodec.safeParse(issue);
  if (!checked.success) {
    const field = checked.error.issues[0]?.path?.join('.') ?? 'issue';
    refused(`The upstream issue is not well formed (${field}): ${checked.error.issues[0]?.message ?? 'invalid'}. `
      + `Name --about (1-200 characters) and --problem (20-${UPSTREAM_ISSUE_PROBLEM_MAXIMUM} characters).`);
  }
  workflow.upstreamIssues.push(checked.data);
  return checked.data;
}

export function decideUpstreamIssue(workflow, {
  issue: issueId, outcome, reason, link = null, expiresAt = null, actor, authorityGroup, identityAssurance = null, at
}, records = {}) {
  const state = upstreamIssueStates(workflow, at, records.issueDecisions).find((entry) => entry.issue.id === issueId);
  if (!state) refused(`${issueId || 'That issue'} is not an upstream issue of this Story.`, 'UPSTREAM_ISSUE_NOT_FOUND');
  if (state.status === 'decided') {
    refused(`${issueId} is already decided (${state.decision.outcome}).`, 'UPSTREAM_ISSUE_DECIDED');
  }
  if (!UPSTREAM_ISSUE_OUTCOMES.includes(outcome)) refused(`--outcome must be one of ${UPSTREAM_ISSUE_OUTCOMES.join(', ')}.`);
  if (outcome === 'amend') {
    // The issue is resolved by the approved forward amendment of the same step [UIF-M3].
    const amendment = (workflow.forwardAmendments ?? []).find((entry) => entry.id === link);
    const approved = (records.amendmentDecisions ?? workflow.forwardAmendmentDecisions ?? []).findLast((entry) => entry.amendment === link);
    if (!amendment || approved?.decision !== 'approved') refused(`Name the approved forward amendment that resolves ${issueId} with --link FAM-NNN.`);
    if (amendment.phase !== state.issue.phase) refused(`${link} amends ${amendment.phase}, but ${issueId} is about ${state.issue.phase}.`);
  } else if (outcome === 'plan-correction') {
    const correction = (records.planAmendments ?? workflow.planAmendments ?? []).find((entry) => entry?.kind === 'plan-row-correction' && entry.id === link);
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
  const {expiresAt: expiry} = upstreamDispositionFacts({outcome,reason,expiresAt,at});
  const decision = { issue: issueId, outcome, reason: String(reason ?? '').trim(), link: link ?? null, expiresAt: expiry,
    actor, authorityGroup, identityAssurance, at };
  const checked = decisionCodec.safeParse(decision);
  if (!checked.success) refused('Say why in 20 to 1000 characters with --reason.', 'UPSTREAM_ISSUE_REASON_REQUIRED');
  workflow.upstreamIssueDecisions ??= [];
  workflow.upstreamIssueDecisions.push(checked.data);
  return checked.data;
}

/** Explicit namespace return over already authenticated issue/producer facts. No synthetic review packet. */
export function planNamespaceUpstreamReturn(workflow,request,facts,source){
  const issue=source.issue,current=workflow.phases?.[workflow.currentPhase],order=workflow.phaseOrder??[];
  if(workflow.status!=='in_progress'||!issue||issue.id!==request.issueId||request.phaseId!==issue.phase
    ||!current||!['in_progress','awaiting_approval'].includes(current.status)||order.indexOf(issue.phase)<0
    ||order.indexOf(issue.phase)>order.indexOf(current.id))refused('An upstream return needs its current open phase and actual earlier producer.','UPSTREAM_ISSUE_RETURN_UNAVAILABLE');
  const proposed=structuredClone(workflow),id='CR-'+String((workflow.changeRequests??[]).length+1).padStart(3,'0');
  if(request.link!==null&&request.link!==undefined)refused('A new upstream return records the change request it opens; do not supply another return.','UPSTREAM_ISSUE_INVALID');
  const repairBudget=applyNamespaceRepairBudget(proposed,source,{...request,target:issue.phase},facts,id,'upstream'),
    budgeted=Boolean(source.repairBudget?.selection||source.repairBudget?.prior),
    decision=decideUpstreamIssue(proposed,{issue:request.issueId,outcome:'return',reason:request.reason,link:id,
    expiresAt:request.expires,actor:facts.actorId,authorityGroup:facts.authorityGroup,identityAssurance:null,at:facts.at}),
    changeRequest={schemaVersion:1,profile:budgeted?NAMESPACE_UPSTREAM_BOUNDED_RETURN_PROFILE:NAMESPACE_UPSTREAM_RETURN_PROFILE,id,status:'open',sourcePhase:current.id,sourceGeneration:current.generation,
      targetPhase:issue.phase,clauseIds:[],comment:request.reason,requestedAt:facts.at,requestedBy:facts.actorId,agent:facts.agentId,
      channel:'engine-sdk',authorityGroup:facts.authorityGroup,identityAssurance:null,
      sourceArtifactSha256:(current.artifacts??[]).map(row=>({path:row.path,sha256:row.sha256??null})),reviewPacketSha256:null,
      upstreamIssue:{id:issue.id,producer:source.issueProducer},resolution:null};
  reopenPhaseRange(proposed,{targetId:issue.phase,at:facts.at,actor:facts.actorId,reason:request.reason});
  proposed.changeRequests??=[];proposed.changeRequests.push(changeRequest);
  proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'phase_rejected',phase:current.id,
    detail:changeRequest.id+' returns '+issue.id+' to '+issue.phase+': '+request.reason});
  proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'upstream_issue_decided',phase:issue.phase,
    detail:decision.issue+': return ('+id+'). '+decision.reason});
  return {workflow:proposed,outcome:{currentPhase:issue.phase,record:{...decision,changeRequest,...(budgeted?{repairBudget}:{})}}};
}

/** Recorded artifact ownership and deduplication share the native byte identity. */
export function upstreamDiscrepancyPolicies(textDigests){
  const digests=textDigestCapability(textDigests),discrepancyItemSha256=(phase,item)=>digests.sha256Utf8(`${phase}\n${String(item).replace(/\s+/gu, ' ').trim()}`);
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
function discrepancyIssueFields(item) {
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
function discrepancyIssueRequests(workflow, entries, {states = upstreamIssueStates(workflow,undefined)} = {}) {
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

  return Object.freeze({discrepancyIssueFields,discrepancyIssueRequests,discrepancyItemSha256});
}

/** Forward-amendment queries over already admitted person records; hosts own presence and command text. */
/** Where the next proposal's bytes are saved: the Story's own record, never the step's artifact. */
export function nextForwardAmendmentProposal(itemRelative, workflow, artifactRelative) {
  const id = `FAM-${String((workflow?.forwardAmendments ?? []).length + 1).padStart(3, '0')}`;
  return { id, proposedPath: `${itemRelative}/context/amendments/${id}-${String(artifactRelative).split('/').at(-1)}` };
}

/** The latest decision on a proposal, or null while it waits. */
export function forwardAmendmentDecision(workflow, amendmentId, decisions = workflow?.forwardAmendmentDecisions ?? []) {
  return decisions.findLast((entry) => entry?.amendment === amendmentId) ?? null;
}

/** Proposals nobody has decided yet. */
export function pendingForwardAmendments(workflow, decisions = workflow?.forwardAmendmentDecisions ?? []) {
  return (workflow?.forwardAmendments ?? []).filter((proposal) => !forwardAmendmentDecision(workflow, proposal.id, decisions));
}

/**
 * Each step an approved amendment listed for revalidation that has no revalidation yet and still
 * stands at the generation it was approved with. A step sent back for rework reads its inputs again
 * in its next generation, so nothing is owed for it any more.
 */
export function pendingAmendmentRevalidations(workflow, {decisions = workflow?.forwardAmendmentDecisions ?? [], revalidations = workflow?.amendmentRevalidations ?? []} = {}) {
  const decided = new Set(revalidations.map((entry) => `${entry.amendment}\u0000${entry.phase}`));
  return decisions
    .filter((entry) => entry?.decision === 'approved')
    .flatMap((entry) => (entry.revalidate ?? [])
      .filter((item) => workflow.phases?.[item.phase]?.status === 'approved'
        && Number(workflow.phases[item.phase].generation) === Number(item.generation)
        && !decided.has(`${entry.amendment}\u0000${item.phase}`))
      .map((item) => ({ amendment: entry.amendment, phase: item.phase, generation: item.generation, producer: entry.phase })));
}

/**
 * Producers whose amended generation this step was revalidated against, keyed by producer, for the
 * step's current generation and exact input record. A later amendment of the same producer needs
 * its own revalidation, because the binding names the producer's generation and bytes.
 */
export function acceptedRevalidationBindings(workflow, phase, inputRecordSha256, revalidations = workflow?.amendmentRevalidations ?? []) {
  const bindings = new Map();
  for (const entry of revalidations) {
    if (entry?.phase !== phase?.id || entry.outcome !== 'unchanged'
        || Number(entry.generation) !== Number(phase.generation)
        || entry.binding?.inputRecordSha256 !== inputRecordSha256) continue;
    bindings.set(entry.binding.producer, { ...entry.binding, amendment: entry.amendment });
  }
  return bindings;
}

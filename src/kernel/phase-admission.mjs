/** Phase selection, role/compiler policy and composition admission. No command rendering or I/O. */
import {SingularityFlowError} from '../foundation/failures.mjs';

export function currentEntryPhase(workflow,phaseId=null,{allowTerminal=false}={}) {
  const id=phaseId??workflow.currentPhase;
  const phase=id!=null&&Object.hasOwn(workflow.phases??{},id)?workflow.phases[id]:null;
  if((!phase&&!(allowTerminal&&!workflow.currentPhase&&!phaseId))
    ||phase&&phase.id!==workflow.currentPhase)throw new SingularityFlowError(
    'Phase entry must name the current Story phase; historical inspection uses phase show.',{
      code:'PHASE_DRAFT_NOT_ACTIVE',details:{requestedPhase:phaseId,currentPhase:workflow.currentPhase}});
  return phase;
}

export function phaseCompositionAdmission({ready=true,authoring={},recovery={},references={},deterministic=false,documents=null}={}) {
  const blockers=[];
  const add=(code,details={})=>blockers.push({code,...details});
  if(!ready) {
    add('PHASE_CONTEXT_BINDING_REQUIRED');
    return {allowed:false,blockers};
  }
  if(authoring.entry?.status!=='authoring-entry')add('PHASE_CONTEXT_AUTHORING_ENTRY_REQUIRED',{
    entryStatus:authoring.entry?.status??null,reason:authoring.entry?.reason??null});
  if(deterministic)add('PHASE_CONTEXT_DETERMINISTIC');
  if(!authoring.policyVerified)add('PHASE_CONTEXT_POLICY_UNVERIFIED',authoring.policyReason?{reason:authoring.policyReason}:{});
  if(!authoring.hasAuthoringRoute)add('PHASE_CONTEXT_AUTHORING_ROUTE_REQUIRED');
  if(recovery.requiresRecovery)add('PHASE_CONTEXT_RECOVERY_REQUIRED',{
    actionIds:(recovery.actions??[]).filter(action=>action.automatic||action.mode==='manual').map(action=>action.id)});
  const worktree=(recovery.actions??[]).find(action=>action.id==='working-tree'&&action.confirmation!=='none');
  const pendingEvidence=worktree?.authoringContinuation?.allowed===true&&worktree.authoringContinuation.status==='draft-only';
  if(worktree&&!pendingEvidence)add('PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED',{
    actionIds:(recovery.actions??[]).filter(action=>action.id==='working-tree'||action.id==='set-aside-worktree'
      ||action.id?.startsWith('review-evidence-contract:')).map(action=>action.id),
    paths:worktree.unexpectedPaths?.length?worktree.unexpectedPaths:worktree.paths??[],confirmation:worktree.confirmation});
  if(references.status==='blocked')add('PHASE_CONTEXT_REFERENCES_BLOCKED');
  const inputs=(recovery.blockers??[]).filter(blocker=>blocker.category==='inputs');
  if(inputs.length)add('PHASE_CONTEXT_INPUTS_NOT_READY',{
    upstreamPhases:[...new Set(inputs.map(blocker=>blocker.details?.upstreamPhase).filter(Boolean))],
    findings:inputs.map(blocker=>({phase:blocker.details?.upstreamPhase??null,path:blocker.path??null,
      status:blocker.details?.status??null,restorable:blocker.details?.restorable===true})),
    actionIds:(recovery.actions??[]).filter(action=>/^(?:resolve|restore)-inputs:/u.test(action.id??'')).map(action=>action.id)});
  if(documents&&documents.status!=='ready')add('DOCUMENT_REUPLOAD_REQUIRED',{
    documents:documents.missing.map(({id,name,sha256})=>({id,name,sha256}))});
  return {allowed:blockers.length===0,blockers,...(pendingEvidence?{pendingEvidence:true}:{})};
}

/** Sort only by semantic action identity; hosts retain their own rendering and original objects. */
export function phaseAdmissionActions(actions,admission,{authoring,recovery}={}) {
  if(!recovery?.requiresRecovery&&admission.blockers.some(item=>item.code==='PHASE_CONTEXT_INPUTS_NOT_READY')) {
    const rank=action=>action.id?.startsWith('resolve-inputs:')?0:action.id?.startsWith('restore-inputs:')?1:2;
    return [...actions].sort((left,right)=>rank(left)-rank(right));
  }
  if(authoring?.entry?.status!=='authoring-entry'||recovery?.requiresRecovery
    ||!admission.blockers.some(item=>item.code==='PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED'))return actions;
  const rank=action=>action.id?.startsWith('review-evidence-contract:')?0:action.id==='working-tree'?1
    :action.id==='set-aside-worktree'?2:action.id==='commit-reviewed-worktree'?4:3;
  return [...actions].sort((left,right)=>rank(left)-rank(right));
}

export function readOnlyAgent(config, workflow, session) {
  const id = session?.agent;
  if (!id) return null;
  const mode = config?.agents?.[id]?.metadata?.['sflow-mode'];
  if (['read-only', 'read-only-review'].includes(mode)) return { id, mode };
  if (id === workflow?.resolution?.sourceReview?.reviewerAgent) return { id, mode: 'read-only-review' };
  return null;
}

/** Role eligibility is independent of host commands, session persistence and review wording. */
export function phaseAgentMutationFacts(config, workflow, phase, session, operation) {
  const agent = readOnlyAgent(config, workflow, session);
  if (!agent) return { allowed: true };
  return { allowed: false, code: agent.mode === 'read-only-review'
    ? `SOURCE_REVIEW_REVIEWER_CANNOT_${operation.toUpperCase().replaceAll('-', '_')}` : 'READ_ONLY_AGENT_CANNOT_MUTATE',
  category: 'agent-role', phase: phase?.id ?? null, workId: workflow?.workItem?.id ?? null,
  agent, author: phase?.defaultAgent ?? null };
}

/** The optional reviewability predicate is the trusted compiler's structural rule, never SDK request data. */
export function normalizeSourceReviewPolicy(value = null, { workTypeId = 'workflow', phases = [], reviewable = null } = {}) {
  if (value == null) return { mode: 'off', phases: [], reviewerAgent: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!['mode', 'phases', 'reviewerAgent'].includes(key)) {
      throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview has unknown field '${key}'.`);
    }
  }
  const mode = value.mode ?? 'off';
  if (!['off', 'enforce'].includes(mode)) {
    throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview.mode must be off or enforce.`);
  }
  const selected = value.phases ?? [];
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length
      || selected.some((phase) => !phases.includes(phase) || (reviewable && !reviewable(phase)))) {
    throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview.phases must list distinct active steps that define the scope or plan the claims.`);
  }
  const reviewerAgent = value.reviewerAgent ?? null;
  if (reviewerAgent != null && (typeof reviewerAgent !== 'string'
      || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(reviewerAgent))) {
    throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview.reviewerAgent must be an agent ID.`);
  }
  if (mode === 'enforce' && (!selected.length || !reviewerAgent)) {
    throw new SingularityFlowError(`Work type '${workTypeId}' enforced sourceReview needs phases and reviewerAgent.`);
  }
  return { mode, phases: selected, reviewerAgent };
}

export function assertSourceReviewerAvailable(policy, agents, { workTypeId = 'workflow' } = {}) {
  if (policy?.mode !== 'enforce') return;
  const reviewer = agents?.find((agent) => agent.id === policy.reviewerAgent);
  if (!reviewer || reviewer.metadata?.['sflow-mode'] !== 'read-only-review') {
    throw new SingularityFlowError(
      `Work type '${workTypeId}' requires reviewer '${policy.reviewerAgent}' with sflow-mode: read-only-review.`,
      { code: 'SOURCE_REVIEW_AGENT_UNAVAILABLE' }
    );
  }
  const collisions = (policy.phases ?? []).filter((id) => reviewer.defaultFor?.includes(id));
  if (collisions.length) throw new SingularityFlowError(
    `Work type '${workTypeId}' cannot use '${reviewer.id}' as both author and independent reviewer of ${collisions.join(', ')}. Choose a writable default author.`,
    { code: 'SOURCE_REVIEW_AUTHOR_COLLISION', details: { workTypeId, reviewerAgent: reviewer.id, phases: collisions } }
  );
}

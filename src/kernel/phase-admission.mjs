/** Current-phase selection and composition admission. No command names, prompt prose or I/O. */
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

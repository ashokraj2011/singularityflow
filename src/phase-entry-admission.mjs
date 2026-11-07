/** Native wording of kernel admission findings. No second admission or action-ranking policy. */
import {phaseCompositionAdmission} from './kernel/phase-admission.mjs';
export {phaseAdmissionActions} from './kernel/phase-admission.mjs';

const wording={
  PHASE_CONTEXT_BINDING_REQUIRED:'Attach the exact Story and its configured phase agent before composition.',
  PHASE_CONTEXT_AUTHORING_ENTRY_REQUIRED:'Follow the returned preparation, retained-generation or authority route; composition cannot create that boundary.',
  PHASE_CONTEXT_DETERMINISTIC:'This phase uses its deterministic producer, not model composition.',
  PHASE_CONTEXT_POLICY_UNVERIFIED:'Verify the pinned phase policy before composing context.',
  PHASE_CONTEXT_AUTHORING_ROUTE_REQUIRED:'No verified phase-authoring route is available.',
  PHASE_CONTEXT_RECOVERY_REQUIRED:'Complete the returned recovery boundary before composing. Draft quality findings are separate.',
  PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED:'The listed worktree changes require human review. A tag/artifact repair or source-only commit does not clear an unexpected evidence file.',
  PHASE_CONTEXT_REFERENCES_BLOCKED:'Repair the returned reference-repository findings before composition.'
};

export function phaseContextAdmissionPresentation(admission,{recovery={},documents=null}={}) {
  const blockers=admission.blockers.map(({code,...details})=>({code,message:code==='PHASE_CONTEXT_INPUTS_NOT_READY'
    ?`Approved inputs${details.upstreamPhases.length?` from ${details.upstreamPhases.join(', ')}`:''} are not ready. They belong to that earlier phase and must not be edited here: inspect them, restore their exact approved bytes, or use the producer's return or amendment route.`
    :code==='DOCUMENT_REUPLOAD_REQUIRED'?documents.instruction:wording[code],...details}));
  const continuation=(recovery.actions??[]).find(action=>action.id==='working-tree'&&action.confirmation!=='none')?.authoringContinuation;
  return {allowed:admission.allowed,blockers,...(admission.pendingEvidence?{pendingEvidence:continuation}:{})};
}

export function phaseContextAdmission({authoring={},...options}={}) {
  return phaseContextAdmissionPresentation(phaseCompositionAdmission({...options,
    authoring:{...authoring,hasAuthoringRoute:Boolean(authoring.effectiveAuthoringSkill)}}),options);
}

/** Phase selection, role/compiler policy and composition admission. No command rendering or I/O. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import { isVisualVerificationPhase } from './phase-policy.mjs';

const PUBLICATION_DEPENDENCY_CODES = Object.freeze({
  'evidence-contract': 'PLAN_EVIDENCE_CORRECTION_REVIEW_REQUIRED',
  'repair-loop': 'PHASE_REPAIR_RECHECK_REQUIRED', appeal: 'PHASE_APPEAL_REVIEW_REQUIRED',
  integration: 'STEP_ACTION_REQUIRED_UNRECORDED', inputs: 'PHASE_INPUTS_NOT_READY',
  'mcp-host': 'MCP_PHASE_NOT_READY', grounding: 'PHASE_GROUNDING_NOT_READY',
  clarification: 'PHASE_CLARIFICATION_NOT_READY', 'mcp-evidence': 'MCP_EVIDENCE_REQUIRED',
  'design-source': 'DESIGN_SOURCE_REQUIRED', 'visual-coverage': 'VISUAL_COVERAGE_FAILED'
});

/** Required read observations are not evidence receipts, identity or permission to publish. */
export function phasePublicationDependencyInspection(workflow, phase, { producer, generation, agent = null } = {}) {
  const binding = Object.freeze({ workId: workflow.workItem.id, phase: phase.id, generation, producer, agent });
  const text = value => typeof value === 'string' && value.length > 0;
  const invalid = (message, details = null) => { throw new SingularityFlowError(message, { code: 'PHASE_DEPENDENCY_OBSERVATION_INVALID', details }); };
  if (!text(binding.workId) || !text(binding.phase) || !text(producer) || !Number.isSafeInteger(generation) || generation < 0
    || agent !== null && !text(agent)) invalid('Publication dependencies require an explicit Story, phase, generation and producer binding.');
  const optional = {
    appeal: workflow.phaseAppeals !== undefined || workflow.phaseAppealDecisions !== undefined,
    'design-source': workflow.resolution?.designSources?.capturePhase === phase.id,
    'visual-coverage': isVisualVerificationPhase(phase)
  };
  const checks = Object.freeze(Object.entries(PUBLICATION_DEPENDENCY_CODES).map(([id, code]) => {
    const observe = Object.hasOwn(optional, id) ? optional[id] : true;
    return Object.freeze({ id, observe, enforce: observe && (id !== 'clarification' || producer === 'governed-agent'), code });
  }));
  const plan = Object.freeze({ schemaVersion: 1, binding, checks });
  const observed = new Map(); let finished = false;
  function requirement(id) {
    const value = checks.find(check => check.id === id);
    if (!value) invalid('The publication dependency is not in this compiled plan.', { id });
    return value;
  }
  function observe(id, input) {
    const required = requirement(id);
    if (finished || observed.has(id)) invalid('A dependency observation cannot be duplicated or changed after inspection.', { id });
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype,null].includes(Object.getPrototypeOf(input))) invalid('A dependency observation must contain bound data.', { id });
    const allowed = ['binding','errors','sourceCode','blockerCount','recordPresent'];
    for (const key of Reflect.ownKeys(input)) {
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (typeof key !== 'string' || !allowed.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value')) invalid('Unsupported dependency observation field.', { id });
    }
    const { errors, sourceCode = null, blockerCount = errors?.length, recordPresent = false } = input;
    const supplied = input.binding;
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || ![Object.prototype,null].includes(Object.getPrototypeOf(supplied))
      || Reflect.ownKeys(supplied).length !== Object.keys(binding).length
      || Object.keys(binding).some(key => { const descriptor = Object.getOwnPropertyDescriptor(supplied, key);
        return !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value !== binding[key]; })) {
      invalid('The dependency observation belongs to another invocation.', { id, expected: binding });
    }
    let validErrors = Array.isArray(errors) && Reflect.ownKeys(errors).length === errors.length + 1;
    if (validErrors) for (let index = 0; index < errors.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(errors, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') { validErrors = false; break; }
    }
    if (!validErrors
      || !Number.isSafeInteger(blockerCount) || blockerCount < 0 || typeof recordPresent !== 'boolean'
      || sourceCode !== null && !['string','number','boolean'].includes(typeof sourceCode)
      || typeof sourceCode === 'number' && !Number.isFinite(sourceCode)) invalid('The dependency observation has invalid diagnostics.', { id });
    const blocked = required.enforce && (id === 'grounding' ? blockerCount > 0 : errors.length > 0);
    const result = Object.freeze({ id, enforced: required.enforce, observed: true, blocked, code: sourceCode ?? required.code,
      errorCount: errors.length, retainObservedRecord: id === 'clarification' && (required.enforce || errors.length === 0),
      warnInvalidRecord: id === 'clarification' && !required.enforce && recordPresent && errors.length > 0 });
    observed.set(id, result); return result;
  }
  function finish() {
    const missing = checks.filter(check => check.observe && !observed.has(check.id)).map(check => check.id);
    if (missing.length) invalid('Required publication dependency observations are missing.', { binding, missing });
    finished = true;
    const result = checks.map(check => observed.get(check.id) ?? Object.freeze({ id: check.id, observed: false, enforced: false,
      blocked: false, code: check.code, errorCount: 0, retainObservedRecord: false, warnInvalidRecord: false }));
    return Object.freeze({ binding, ready: !result.some(check => check.blocked), checks: Object.freeze(result) });
  }
  return Object.freeze({ plan, requires: id => requirement(id).observe, observe, finish });
}

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

/** Skill instructions do not themselves establish an installed containment/delivery capability. */
export function skillPhaseHostRequirement(workflow,phase) {
  const pinned=workflow.resolution?.phases?.find(entry=>entry.id===phase?.id);
  if(pinned?.kind!=='skill'&&phase?.kind!=='skill')return null;
  const skillId=pinned?.skillBinding?.bindingRefs?.skill?.id??pinned?.skill?.id
    ??phase?.skillBinding?.bindingRefs?.skill?.id??phase?.skill?.id;
  return {phase:phase.id,workId:workflow.workItem?.id,...(typeof skillId==='string'?{skillId}:{})};
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

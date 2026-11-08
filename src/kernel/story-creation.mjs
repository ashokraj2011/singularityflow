/** Story genesis rules over an approved contract. No checkout, source control or execution. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { NAMESPACE_STORY_SCHEMAS } from '../foundation/record-schema.mjs';
import { initialWorkflowProgress } from './lifecycle-transitions.mjs';
import { assertApprovalPolicyAttainable,normalizeApprovalSecurity,enrollPinnedApprovalIdentity } from './approval-policy.mjs';
import { projectConfigurationBinding, projectEnrollmentTimestamp } from './project-enrollment.mjs';
import { workflowStartIssues } from './phase-policy.mjs';

export const STORY_SOURCE_MAXIMUM_BYTES = 1_048_576;
const logical = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
const text = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000\u007f]/u.test(value);
const opaque = value => text(value, 512) && !/[\u0000-\u0020]/u.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const fail = (message, code = 'ENGINE_INPUT_INVALID', details = null) => { throw new SingularityFlowError(message, { code, details }); };

export function storySourceReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || !['namespace','sha256','bytes'].every(key => Object.hasOwn(value,key))
    || !['state','evidence'].includes(value.namespace) || !digest(value.sha256)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > STORY_SOURCE_MAXIMUM_BYTES) {
    fail('Story creation requires bounded shared immutable source content.');
  }
  return { namespace: value.namespace, sha256: value.sha256, bytes: value.bytes };
}

export function storyCreationInput(input) {
  const fields = ['operationId','workId','title','workTypeId','configurationId','source'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length
    || !fields.every(key => Object.hasOwn(input,key)) || !logical(input.operationId) || !logical(input.workId)
    || !logical(input.workTypeId) || !logical(input.configurationId) || !text(input.title,512)) {
    fail('Story creation needs an operation ID, Story ID, title, workflow ID, approved configuration ID and source.');
  }
  return { operationId: input.operationId, workId: input.workId, title: input.title, workTypeId: input.workTypeId,
    configurationId: input.configurationId, source: storySourceReference(input.source) };
}

export function storyCreationBinding(value, input) {
  const binding = projectConfigurationBinding(value);
  if (value.workId !== input.workId) fail('The Story creation host is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');
  return { ...binding, workId: input.workId };
}

export function storyActorValue(facts) {
  if (!facts || !opaque(facts.principalId) || !['human','service'].includes(facts.actorKind)
    || !facts.identity || Object.keys(facts.identity).some(key => !['name','email','login'].includes(key))
    || !text(facts.identity.name,512) || ![facts.identity.email,facts.identity.login].some(value => opaque(value))
    || ['email','login'].some(key => facts.identity[key] != null && !opaque(facts.identity[key]))) {
    fail('The access port must supply bounded authenticated Story creator facts.','ENGINE_PORT_RESULT_INVALID');
  }
  return { principalId: facts.principalId, actorKind: facts.actorKind,
    identity: { name: facts.identity.name, email: facts.identity.email ?? null, login: facts.identity.login ?? null } };
}

export function storyCreationAccess(facts, projectId, expected = null) {
  if (!facts || facts.projectId !== projectId || !Array.isArray(facts.permissions) || facts.permissions.length > 128
    || facts.permissions.some(value => !text(value,128))) fail('The access port returned another project or invalid permissions.','ENGINE_PORT_RESULT_INVALID');
  const actor=storyActorValue(facts);
  if (!facts.permissions.includes('story.create')) fail('The current principal cannot create a Story.','ENGINE_AUTHORITY_REQUIRED');
  if (expected !== null && JSON.stringify(actor) !== JSON.stringify(expected)) {
    fail('Resume Story creation under its original authenticated creator.','ENGINE_ACTOR_CHANGED');
  }
  return actor;
}

export function initialNamespaceStory(input, approved, actor, at) {
  storyCreationInput(input); projectEnrollmentTimestamp(at);
  if (!Object.hasOwn(approved.workflows,input.workTypeId)) fail('The selected approved configuration has no such workflow.','ENGINE_WORKFLOW_UNAVAILABLE',{workTypeId:input.workTypeId});
  const effective = approved.workflows[input.workTypeId];
  let pattern;
  try { pattern = new RegExp(approved.definition.idPattern ?? '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'); }
  catch { fail('The approved Story ID pattern is invalid.','ENGINE_CONFIGURATION_INVALID'); }
  if (!pattern.test(input.workId)) fail('The Story ID does not match the approved project pattern.');
  if (!Array.isArray(effective.phases) || !effective.phases.length) fail('The workflow has no initial phase.','ENGINE_CONFIGURATION_INVALID');
  const issues = workflowStartIssues(effective);
  if (issues.length) fail('The selected workflow cannot start until its contract findings are repaired.',issues[0].code,{findings:issues});
  const resolution = structuredClone(effective);
  const authorities = resolution.approvalAuthorities;
  if (!authorities || typeof authorities !== 'object' || Array.isArray(authorities)) fail('The approved workflow has no approval authority contract.','ENGINE_CONFIGURATION_INVALID');
  if (actor.actorKind === 'human' && normalizeApprovalSecurity(approved.definition.approvalSecurity??{}).autoEnrollNewIdentities) {
    enrollPinnedApprovalIdentity(authorities,actor.identity);
  }
  for (const phase of resolution.phases) assertApprovalPolicyAttainable(authorities,phase.approval,phase.id,{creator:actor.identity});
  const progress = initialWorkflowProgress(resolution.phases,{startedAt:at,tokenMode:approved.definition.tokens?.mode ?? 'exact-or-unavailable'});
  return { schemaVersion:NAMESPACE_STORY_SCHEMAS.workflow.currentVersion,format:'sflow-namespace-story-workflow/v1',
    workItem:{id:input.workId,title:input.title,workType:input.workTypeId,workTypeLabel:resolution.label,
      branch:null,baseBranch:null,createdAt:at,createdBy:structuredClone(actor),
      source:{type:'namespace-text',content:structuredClone(input.source),contentSha256:input.source.sha256}},
    lineage:{canonicalBranch:null,parentStoryId:input.workId,childBranches:[],submissions:[]},
    resolution:{...resolution,workItemRoot:approved.definition.workItemRoot,configurationApprovalId:input.configurationId,configurationSource:structuredClone(approved.source),
      sourceSha256:input.source.sha256},
    ...progress,
    execution:{status:'unbound',repositories:[],observations:[]},mcpAuthorizations:{},
    namespaceDocuments:[{id:'story-source',phase:null,generation:null,sourceKey:'USER-STORY.md',role:'file',name:'Story source',
      kind:'story-source',mimeType:'text/markdown',encoding:'utf8',locality:'project',status:'active',aliases:['source'],content:structuredClone(input.source)}],
    history:[{at,actor:actor.principalId,agent:null,event:'work_started',phase:progress.currentPhase,detail:`Created ${input.workTypeId} Story`}] };
}

export function storyCreationResult(binding, inputs, facts) {
  if (!facts || facts.projectId !== binding.projectId || facts.workId !== inputs.workId || facts.operationId !== inputs.operationId
    || facts.authorityId !== binding.authority.id || facts.epoch !== binding.authority.epoch || !opaque(facts.revision)
    || !opaque(facts.transactionRevision) || !digest(facts.requestDigest) || !opaque(facts.principalId) || typeof facts.replayed !== 'boolean'
    || !text(facts.currentPhase,128) || facts.configurationId !== inputs.configurationId) fail('The creation port returned another Story receipt.','ENGINE_PORT_RESULT_INVALID');
  projectEnrollmentTimestamp(facts.recordedAt);
  return {status:'created',subject:{kind:'story',id:inputs.workId},operationId:inputs.operationId,authority:binding.authority,
    principalId:facts.principalId,configurationId:facts.configurationId,currentPhase:facts.currentPhase,generation:0,
    recordedAt:facts.recordedAt,revision:facts.revision,transactionRevision:facts.transactionRevision,requestDigest:facts.requestDigest,replayed:facts.replayed,
    source:{kind:'story-document',id:'story-source',workId:inputs.workId},
    effects:{committed:true,pushed:false,storyCreated:true,configurationApproved:false,humanReviewRecorded:false,approvalRecorded:false} };
}

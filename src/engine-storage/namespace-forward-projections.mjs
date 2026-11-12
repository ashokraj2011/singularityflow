/** Deterministic evidence for a reviewed historical document. Persistence is supplied by its owner. */
import {createHash} from 'node:crypto';
import {canonicalJson,namespacePublicationRecordProfile,namespaceSubmissionRecordProfile,namespaceApprovalRecordProfile} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {principalApprovalPlan} from '../kernel/approval-policy.mjs';
import {buildGenerationAuthorship,normalizeAuthorshipOptions,assertProducerAllowed} from '../kernel/phase-policy.mjs';
import {artifactContentObservation} from '../kernel/artifact-content.mjs';
import {namespaceApprovalDecision,namespaceApprovalArtifactSetRecord} from './namespace-approval-contract.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function forwardEvidence(value){const bytes=Buffer.from(canonicalJson(value));return {reference:{namespace:'evidence',sha256:hash(bytes),bytes:bytes.byteLength},bytes};}
export function forwardAmendmentProjections(snapshot,request,{principal,at},source){
  const workflow=snapshot.workflow,workId=workflow.workItem.id,phase=workflow.phases[request.phaseId],proposal=source.proposal,author=source.proposalValue.actor,
    generation=proposal.fromGeneration+1,origin={schemaVersion:1,format:'sflow-namespace-forward-amendment-origin/v1',amendmentId:proposal.id,proposal:source.proposalReference,previous:source.previous.value.publication},
    common={projectId:source.projectId,workId,phase:phase.id,generation,operationId:principal.operationId,requestSha256:principal.requestSha256,
      baseRevision:snapshot.revision,configuration:snapshot.configuration},
    pubProfile=namespacePublicationRecordProfile({schemaVersion:5}),subProfile=namespaceSubmissionRecordProfile({schemaVersion:6}),voteProfile=namespaceApprovalRecordProfile({schemaVersion:3}),
    human=author.actorKind==='human',agentId=human?null:source.proposalValue.agentId,
    authorship=buildGenerationAuthorship({options:normalizeAuthorshipOptions({producer:human?'human':'governed-agent',channel:human?'manual-import':'copilot-host',imported:human}),actor:author.identity,
      governedAgentContext:agentId,source:null,generation});
  assertProducerAllowed(phase,authorship.producer);
  const artifact={...source.previous.published.artifact,content:proposal.content,encoding:'utf8',fingerprint:'sha256:'+hash(artifactContentObservation(source.text).fingerprintText)},
    publication={schemaVersion:pubProfile.version,format:pubProfile.format,profile:pubProfile.profile,...common,
      draft:{revision:source.proposalValue.baseRevision,sha256:proposal.proposedSha256},actor:author,agentId,publishedAt:at,authorship,artifact,
      inputs:source.previous.published.inputs,checks:null,specifications:null,policyEvidence:source.policyEvidence??[],origin},
    published=forwardEvidence(publication),publicationBinding={schemaVersion:1,format:'sflow-phase-publication-binding/v1',generation,record:published.reference},
    submission={schemaVersion:subProfile.version,format:subProfile.format,profile:subProfile.profile,...common,publication:publicationBinding,actor:author,agentId:null,submittedAt:at,origin},
    submitted=forwardEvidence(submission),submissionBinding={schemaVersion:1,format:'sflow-namespace-phase-submission-binding/v1',generation,record:submitted.reference},
    artifactSet=namespaceApprovalArtifactSetRecord({projectId:source.projectId,workId,phase:phase.id,generation,
      reviewPacket:submitted.reference,artifact:{sourceKey:artifact.sourceKey,kind:artifact.kind,content:artifact.content}},{policyChecklist:source.policyChecklist??null}),set=forwardEvidence(artifactSet),
    target={...phase,generation,approvals:[]},policy=principalApprovalPlan(workflow,target,principal,{author,active:[]});
  if(!policy.reached)throw new SingularityFlowError('This amendment needs more than one human approval; return the Story to the document owner for its normal review.',{
    code:'FORWARD_AMENDMENT_AUTHORITY',details:{actions:[{operation:'phase.review',inputs:{workId,phaseId:workflow.currentPhase}}]}});
  const vote={schemaVersion:voteProfile.version,format:voteProfile.format,profile:voteProfile.profile,...common,reviewPacket:submitted.reference,artifactSet:set.reference,
    actor:principal.actor,agentId:principal.agentId,recordedAt:at,authorityGroup:policy.authorityGroup,selfApproval:policy.selfApproval,thresholdReached:true,currentPhase:workflow.currentPhase,origin},
    voted=forwardEvidence(vote),voteBinding={schemaVersion:1,format:'sflow-namespace-phase-approval-binding/v1',generation,record:voted.reference};
  return {publication,submission,vote,artifactSet,publicationBinding,submissionBinding,voteBinding,approval:namespaceApprovalDecision(vote,voteBinding),
    evidence:[published,submitted,set,voted]};
}

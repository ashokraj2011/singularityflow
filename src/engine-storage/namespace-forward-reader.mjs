/** Reconstruct forward amendments from original documents, human votes and conditional receipts. */
import {createHash} from 'node:crypto';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceForwardAmendmentTarget,pendingForwardAmendments,pendingAmendmentRevalidations,planNamespaceForwardProposal,
  planNamespaceForwardDecision,planNamespaceForwardRevalidation,namespaceForwardAmendmentHolds} from '../kernel/upstream-issues.mjs';
import {extractInputsBlock} from '../kernel/phase-inputs.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {namespaceLocalInputBytes,memoNamespaceObservedDecision} from './namespace-story-reader.mjs';
import {forwardAmendmentProjections} from './namespace-forward-projections.mjs';
import {createNamespaceUpstreamOwners} from './namespace-upstream-reader.mjs';
import {artifactContentObservation,inspectRequiredArtifactObservation} from '../kernel/artifact-content.mjs';
import {createNamespaceRepairBudgetReader} from './namespace-repair-budget-reader.mjs';
import {NAMESPACE_FORWARD_RETURN_PROFILE} from '../kernel/upstream-issues.mjs';
import {namespaceForwardEvidence} from './namespace-forward-evidence.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceTestRecoveryOwner,namespaceTestRecoveryBinding} from './namespace-test-recovery-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(value).digest('hex'),
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});},
  collections={'forward-amendment.propose':'forwardAmendments','forward-amendment.decide':'forwardAmendmentDecisions','forward-amendment.revalidate':'amendmentRevalidations'};
export function createNamespaceForwardAmendmentOwners({observer,scope,workId,sources=[]}){
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),packets=createNamespaceSubmissionReader({observer,scope,workId,checks}),owners=new Map(),readers=new Map();
  let upstream;const upstreamOwner=()=>upstream??=createNamespaceUpstreamOwners({observer,scope,workId});
  async function accepted(link,options){return memoNamespaceObservedDecision(observer,{profile:'sflow-namespace-forward-proof/v1',operation:link.operation,record:link.record},async()=>{
    const proof=await readers.get(link.operation).accepted(link,options),source={...proof.source};
    // Byte buffers are temporary construction material, not part of the accepted read proof.
    // Keeping them in a JSON proof memo expands every byte into properties on each clone.
    delete source.pendingEvidence;delete source.text;
    if(source.projected){source.projected={...source.projected};delete source.projected.evidence;}
    return {value:proof.value,reference:proof.reference,source,original:proof.original,
      accepted:{plan:proof.accepted.plan,state:proof.accepted.state}};
  },options);}
  async function admitted(snapshot,{signal,policyTraversal}={}){
    const references=[];
    for(const [operation,field]of Object.entries(collections)){
      const rows=snapshot.workflow[field]??[],links=namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operation===operation);
      if(!Array.isArray(rows))fail('The forward-amendment inventory is invalid.');
      if(!links.length){if(rows.length)fail('Forward-amendment rows require their accepted original transactions.');continue;}
      const proof=await accepted(links.at(-1),{signal,policyTraversal});if(!same(rows,proof.accepted.state.workflow[field]??[]))fail('The amendment inventory differs from its last accepted transition.');
      references.push(...links.map(row=>row.record));
    }return references;
  }
  async function proposal(snapshot,id,options){
    for(const link of namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operation==='forward-amendment.propose')){
      const proof=await accepted(link,options);if(proof.value.outcome.record.id===id)return {...proof,proposal:proof.value.outcome.record};
    }fail('That amendment is not an accepted proposal of this Story.','FORWARD_AMENDMENT_NOT_FOUND');
  }
  async function approved(snapshot,id,options={}){
    await admitted(snapshot,options);const original=await proposal(snapshot,id,options);
    for(const link of namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operation==='forward-amendment.decide')){
      const proof=await accepted(link,options);
      if(proof.value.request.amendmentId===id&&proof.value.outcome.record.applied)return {proposal:original.proposal,decision:proof.value.outcome.record.decision,
        references:[original.reference,proof.reference,...proof.source.references]};
    }fail('Name the actual approved forward amendment.','FORWARD_AMENDMENT_NOT_APPROVED');
  }
  async function body(reference,signal){return new TextDecoder('utf-8',{fatal:true}).decode(await observer.bytes(reference,reference.bytes,signal));}
  for(const operation of Object.keys(collections)){
    const owner={agentPhase:snapshot=>snapshot.workflow.currentPhase,needsHead:operation==='forward-amendment.decide',
      async read(snapshot,request,{signal,policyTraversal,bound,principal,at,head}={}){
        const workflow=snapshot.workflow,references=await admitted(snapshot,{signal,policyTraversal}),phase=workflow.phases[request.phaseId];
        if(!phase)fail('The document owner is not in this Story.','FORWARD_AMENDMENT_NOT_FOUND');
        if(operation==='forward-amendment.propose'){
          namespaceForwardAmendmentTarget(workflow,request.phaseId);
          if(pendingForwardAmendments(workflow).some(row=>row.phase===phase.id))fail('This document already has a pending proposal.','FORWARD_AMENDMENT_PENDING');
          if(pendingAmendmentRevalidations(workflow).some(row=>row.producer===phase.id))fail('Revalidate the prior amendment before proposing another.','AMENDMENT_REVALIDATION_REQUIRED');
          if(request.file!==null||!request.content)fail('Use the explicit device-bound content reference for a namespace amendment draft.','ENGINE_INPUT_INVALID');
          const previous=(await packets.inspectApprovedMany(snapshot,[phase.id],{signal,policyTraversal}))[0];if(!previous)fail('The document has no actual independent approval.');
          let bytes,content;if(bound){content=contentReference(bound.content);bytes=await observer.bytes(content,content.bytes,signal);}
          else{contentReference(request.content,4_194_304);bytes=await namespaceLocalInputBytes(observer,request.content,{signal});content={namespace:'evidence',sha256:hash(bytes),bytes:bytes.byteLength};}
          if(content.namespace!=='evidence'||content.sha256===previous.published.artifact.content.sha256)fail('The proposed bytes are unchanged.','FORWARD_AMENDMENT_UNCHANGED');
          const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),original=await body(previous.published.artifact.content,signal);
          if(extractInputsBlock(text)!==extractInputsBlock(original))fail('Keep the managed input block unchanged.','FORWARD_AMENDMENT_INVALID');
          if(request.upstreamIssue){references.push(...await upstreamOwner().admitted(snapshot,{signal,policyTraversal}));
            if(!(workflow.upstreamIssues??[]).some(row=>row.id===request.upstreamIssue&&row.phase===phase.id))fail('That upstream issue names another producer.','UPSTREAM_ISSUE_INVALID');}
          const findings=inspectRequiredArtifactObservation(artifactContentObservation(text),{...phase,authoringBaseline:{generation:phase.generation+1,
            fingerprint:previous.published.artifact.fingerprint}},{path:previous.published.artifact.sourceKey,generation:phase.generation+1,
            fingerprint:'sha256:'+hash(artifactContentObservation(text).fingerprintText)});
          if(findings.length)fail('Complete the replacement document before proposing its review.','ARTIFACT_AUTHORING_INCOMPLETE',{findings});
          const artifactPath=previous.published.artifact.sourceKey,identity={profile:'sflow-namespace-forward-proposal/v1',publication:previous.value.publication,
            submission:previous.binding,content};
          if(bound&&!same(bound,identity))fail('The proposal has another original document binding.');
          return {generation:phase.generation,identity,previous,content,text,artifactPath,itemRelative:artifactPath.slice(0,-phase.requiredArtifact.path.length-1),
            references:[...references,previous.binding.record,previous.value.publication.record,previous.published.artifact.content,content],pendingEvidence:bound?[]:[{reference:content,bytes}]};
        }
        const original=await proposal(snapshot,request.amendmentId,{signal,policyTraversal}),proposed=original.proposal;
        if(operation==='forward-amendment.decide'&&proposed.phase!==phase.id)fail('The proposal names another document owner.');
        if(operation==='forward-amendment.decide'){
          if((workflow.forwardAmendmentDecisions??[]).some(row=>row.amendment===request.amendmentId))fail('The amendment is already decided.','FORWARD_AMENDMENT_DECIDED');
          const source={projectId:scope.projectId,generation:phase.generation,proposal:proposed,proposalValue:original.value,proposalReference:original.reference,
            references:[...references,original.reference,proposed.content],identity:{profile:'sflow-namespace-forward-decision/v1',proposal:original.reference,content:proposed.content}};
          if(request.decision==='approve'){
            namespaceForwardAmendmentTarget(workflow,phase.id);if(phase.generation!==proposed.fromGeneration)fail('Reject the stale proposal and propose against the current document.','FORWARD_AMENDMENT_STALE');
            const previous=(await packets.inspectApprovedMany(snapshot,[phase.id],{signal,policyTraversal}))[0];
            if(!previous||previous.published.artifact.content.sha256!==proposed.fromSha256)fail('The proposal lost its original approved bytes.','FORWARD_AMENDMENT_STALE');
            for(const input of previous.published.inputs.filter(row=>row.kind==='approved-input')){
              if(workflow.phases[input.phase]?.generation!==input.generation)fail('The document inputs changed; use its normal reviewed successor.','FORWARD_AMENDMENT_STALE');
              const actual=(await packets.inspectApprovedMany(snapshot,[input.phase],{signal,policyTraversal}))[0];
              if(!actual||!same(actual.published.artifact.content,input.reference))fail('The original input no longer has its approved binding.','FORWARD_AMENDMENT_STALE');
              source.references.push(actual.binding.record,actual.value.publication.record);
            }
            source.previous=previous;source.text=await body(proposed.content,signal);
            const preliminary=forwardAmendmentProjections(snapshot,request,{principal,at},source),policy=await namespaceForwardEvidence({observer,scope,workId,checks,snapshot,head,
              publication:preliminary.publication,reviewer:principal.actor,signal});
            source.policyEvidence=policy.bindings;source.policyChecklist=policy.checklist??null;source.policyReports=policy.reports;
            source.projected=forwardAmendmentProjections(snapshot,request,{principal,at},source);
            source.pendingEvidence=[...policy.pendingEvidence,...source.projected.evidence];source.references.push(...policy.references,previous.binding.record,previous.value.publication.record,previous.published.artifact.content,
              ...source.pendingEvidence.map(row=>row.reference));source.identity={...source.identity,previous:previous.value.publication,
                projection:{publication:source.projected.publicationBinding,submission:source.projected.submissionBinding,vote:source.projected.voteBinding}};
          }
          if(bound&&!same(source.identity,bound))fail('The amendment decision changed its original proof.');return source;
        }
        const owed=pendingAmendmentRevalidations(workflow).find(row=>row.amendment===request.amendmentId&&row.phase===phase.id);
        if(!owed)fail('This phase owes no such revalidation.','AMENDMENT_REVALIDATION_NOT_OWED');
        const previous=(await packets.inspectApprovedMany(snapshot,[phase.id],{signal,policyTraversal}))[0],producer=(await packets.inspectApprovedMany(snapshot,[owed.producer],{signal,policyTraversal}))[0];
        if(!previous||!producer)fail('A revalidation needs both original approved documents.');
        const input=previous.published.inputs.find(row=>row.kind==='approved-input'&&row.phase===owed.producer);
        if(!input)fail('The original document did not read this producer.','AMENDMENT_REVALIDATION_INVALID');
        for(const other of previous.published.inputs.filter(row=>row.kind==='approved-input'&&row.phase!==owed.producer))if(workflow.phases[other.phase]?.generation!==other.generation)
          fail('Another input changed; return this phase for normal revalidation.','AMENDMENT_REVALIDATION_INVALID');
        const binding={producer:owed.producer,producerGeneration:producer.value.generation,producerSha256:producer.published.artifact.content.sha256,inputRecordSha256:previous.binding.record.sha256},
          identity={profile:'sflow-namespace-forward-revalidation/v1',amendment:original.reference,submission:previous.binding,producer:producer.value.publication,binding};
        const source={generation:phase.generation,identity,binding,references:[...references,original.reference,previous.binding.record,previous.value.publication.record,producer.binding.record,producer.value.publication.record]};
        if(request.outcome==='return'){
          if(workflow.resolution.presence)fail('This return requires its configured additional authority owners.','ENGINE_PORT_UNAVAILABLE',{required:['person-presence']});
          const recovery=workflow.resolution.testRecovery?.enabled?await createNamespaceTestRecoveryOwner({observer,scope,workId}).current(snapshot,{signal,policyTraversal}):null;
          source.readerPublication=previous.value.publication;source.repairBudget=await createNamespaceRepairBudgetReader({observer,scope,workId}).inspect(snapshot,workflow.currentPhase,phase.id,{signal,policyTraversal});
          source.identity={...identity,profile:NAMESPACE_FORWARD_RETURN_PROFILE,readerPublication:source.readerPublication,repairBudget:source.repairBudget.selection,priorBudget:source.repairBudget.prior,
            ...(recovery?{recovery:namespaceTestRecoveryBinding(recovery)}:{})};
          source.references.push(...source.repairBudget.references,...(recovery?.references??[]));
        }
        if(bound&&!same(bound,source.identity))fail('The revalidation has another retained input basis.');
        return source;
      },
      authority(workflow,request,actor){if(operation==='forward-amendment.propose')return null;
        if(operation==='forward-amendment.revalidate'&&request.outcome==='return')requireApprovalAuthority(workflow.resolution.approvalAuthorities,workflow.phases[workflow.currentPhase].approvalPolicy,actor.identity);
        return requireApprovalAuthority(workflow.resolution.approvalAuthorities,workflow.phases[request.phaseId].approvalPolicy,actor.identity).authorityGroup;},
      async fresh(snapshot,request,source,{signal}={}){
        if(operation!=='forward-amendment.decide'||request.decision!=='approve'||!source.policyEvidence?.length)return;
        const publications=createNamespacePublicationReader({observer,scope,workId,checks}),value=await publications.read(source.projected.publicationBinding,request.phaseId,{signal});
        const owners=publications.policies.owners(value);
        if(owners.includes('code-delivery-inputs'))await publications.policies.freshInputSources(value,sources,{signal});
        await publications.policies.assertApproval(value,{snapshot,at:source.projected.vote.recordedAt,signal,reached:true,reworkTarget:null});
      },
      plan:operation==='forward-amendment.propose'?planNamespaceForwardProposal:operation==='forward-amendment.decide'?planNamespaceForwardDecision:planNamespaceForwardRevalidation};
    owners.set(operation,owner);readers.set(operation,createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract}));
  }
  async function projection(value,binding,kind,options={}){
    const proof=await observer.accepted(value.operationId,options),link=namespaceDecisionContract.receipts(proof.state.workflow).find(row=>row.operationId===value.operationId&&row.operation==='forward-amendment.decide');
    if(!link)fail('An amended document needs its accepted human amendment decision.');
    const verified=await accepted(link,options),projected=verified.source.projected,
      reference=kind==='publication'?projected?.publicationBinding.record:kind==='submission'?projected?.submissionBinding.record:projected?.voteBinding.record;
    if(!projected||!same(value,projected[kind])||!same(binding.record,reference))fail('The amended projection differs from its original accepted decision.');
    return proof;
  }
  async function readiness(snapshot,phaseId,options={}){
    const references=await admitted(snapshot,options),holds=namespaceForwardAmendmentHolds(snapshot.workflow,phaseId,options);
    return {references,holds};
  }
  async function returned(snapshot,request,options={}){
    if(request.profile!==NAMESPACE_FORWARD_RETURN_PROFILE)return null;
    for(const link of namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operation==='forward-amendment.revalidate').reverse()){
      const value=await readers.get(link.operation).decode(link.record,options);
      if(value.request.outcome!=='return'||value.outcome.record.changeRequest?.id!==request.id)continue;
      const proof=await accepted(link,options),genesis=({status,resolution,resolvedAt,resolvedBy,...row})=>row,
        original=proof.accepted.state.workflow.changeRequests?.find(row=>row.id===request.id);
      if(!original||!same(genesis(original),genesis(request))||value.recordedAt!==request.requestedAt||value.source.profile!==NAMESPACE_FORWARD_RETURN_PROFILE)
        fail('The amendment return differs from its original human receipt.');
      return {kind:'amendment',binding:{operationId:link.operationId,record:link.record},value,accepted:proof.accepted,references:[link.record,...proof.source.references]};
    }fail('The amendment return lost its original human receipt.');
  }
  async function assertReady(snapshot,phaseId,options={}){const result=await readiness(snapshot,phaseId,options);
    if(result.holds.length)fail('Review the exact amendment obligations before consuming this delivery.',result.holds[0].code,{phase:phaseId,holds:result.holds,actions:result.holds.map(row=>row.action)});
    return result.references;
  }
  return Object.freeze({owners,readers,admitted,proposal,approved,projection,readiness,assertReady,returned});
}

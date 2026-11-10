/** Authenticated report bytes for artifact-derived issue filing. Uploaded inputs stay local. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {phaseNeedsGeneration,nextPhaseGeneration} from '../kernel/phase-policy.mjs';
import {discrepancySteps,upstreamDiscrepanciesFromMarkdown} from '../kernel/phase-upstream-discrepancies.mjs';
import {upstreamDiscrepancyPolicies,upstreamIssueStates} from '../kernel/upstream-issues.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
const policies=upstreamDiscrepancyPolicies(NODE_TEXT_DIGESTS);
export function createNamespaceUpstreamArtifactReader({observer,scope,workId,publications,runtime=null}){
  const selections=new WeakMap();
  function seal(identity,bytes){const token=Object.freeze({});selections.set(token,{identity,bytes:Buffer.from(bytes)});return token;}
  function selected(token){const value=selections.get(token);if(!value)throw error('Use the captured discrepancy report.','ENGINE_INPUT_INVALID');return value;}
  async function capture(snapshot,{signal}={}){
    const phase=snapshot.workflow.phases[snapshot.workflow.currentPhase];
    if(!phase)throw error('The Story has no current report.','UPSTREAM_ISSUE_INVALID');
    if(phaseNeedsGeneration(snapshot.workflow,phase)){
      if(!runtime)throw error('Bind this device\'s authored report before filing discrepancies.','ENGINE_PORT_UNAVAILABLE',{
        operation:'phase.draft.read',required:['machine-local-working-store']});
      const read=await runtime.captureInspectionDraft(phase.id,'upstream.raise',{signal}),facts=runtime.inspectionDraftFacts(read),draft=facts.draft;
      if(facts.revision!==snapshot.revision)throw error('The discrepancy report has another Story basis.','ENGINE_CONTEXT_CHANGED');
      if(!draft)throw error('Prepare and author the current report first.','ENGINE_DRAFT_MISSING');
      const p=draft.payload,bytes=runtime.inspectionArtifactBytes(read);
      if(p.generation!==nextPhaseGeneration(phase)||!same(p.configuration,snapshot.configuration))throw error(
        'The report is not this phase\'s current candidate.','ENGINE_CONTEXT_CHANGED');
      const definition=facts.definition,sourceKey=(definition.workItemRoot??'singularity/work-items')+'/'+workId+'/'+p.artifact.key;
      await runtime.revalidateInspectionDraft(read,{signal});
      return seal({kind:'private-draft',phase:phase.id,generation:p.generation,artifact:{key:sourceKey,
        content:{namespace:'evidence',sha256:hash(bytes),bytes:bytes.byteLength}},draft:{revision:draft.revision,bodySha256:draft.bodySha256}},bytes);
    }
    const binding=phase.publicationBindings?.find(row=>row.generation===phase.generation);
    if(!binding)throw error('The current report has no original publication.');
    const publication=await publications.accepted(binding,phase.id,{signal}),bytes=await observer.bytes(publication.artifact.content,publication.artifact.content.bytes,signal);
    return seal({kind:'publication',phase:phase.id,generation:phase.generation,artifact:{key:publication.artifact.sourceKey,content:publication.artifact.content},publication:binding},bytes);
  }
  async function restore(snapshot,identity,{signal,policyTraversal}={}){
    if(!identity||!['private-draft','publication'].includes(identity.kind)||identity.phase!==snapshot.workflow.currentPhase
      ||identity.artifact?.content?.namespace!=='evidence')throw error('The original discrepancy report identity is invalid.');
    const phase=snapshot.workflow.phases[identity.phase],definition=(await observer.approved(snapshot,{signal})).compiled.definition,
      key=(definition.workItemRoot??'singularity/work-items')+'/'+workId+'/'+phase.requiredArtifact.path;
    if(identity.artifact.key!==key)throw error('The discrepancy report is outside its recorded phase.');
    if(identity.kind==='private-draft'){
      if(!phaseNeedsGeneration(snapshot.workflow,phase)||identity.generation!==nextPhaseGeneration(phase)
        ||typeof identity.draft?.revision!=='string'||!/^[a-f0-9]{64}$/u.test(identity.draft?.bodySha256??''))throw error('The original draft report has another generation.');
    }else{
      const binding=phase.publicationBindings?.find(row=>row.generation===phase.generation);
      if(identity.generation!==phase.generation||!same(identity.publication,binding))throw error('The original published report has another producer.');
      const value=await publications.accepted(binding,phase.id,{signal,policyTraversal});
      if(!same(identity.artifact,{key:value.artifact.sourceKey,content:value.artifact.content}))throw error('The discrepancy report differs from its publication.');
    }
    const bytes=await observer.bytes(identity.artifact.content,identity.artifact.content.bytes,signal);
    // Private report bytes are retained by the exact authorized decision transaction, not by a read.
    return seal(structuredClone(identity),bytes);
  }
  function requests(snapshot,token,at){const {identity,bytes}=selected(token),steps=discrepancySteps(snapshot.workflow),ids=steps.map(row=>row.id),
    earlier=ids.slice(0,Math.max(0,ids.indexOf(identity.phase))),body=new TextDecoder('utf-8',{fatal:true}).decode(bytes),
    entries=upstreamDiscrepanciesFromMarkdown(body,steps,{earlier}).map(item=>({path:identity.artifact.key,item}));
    return policies.discrepancyIssueRequests(snapshot.workflow,entries,{states:upstreamIssueStates(snapshot.workflow,at)});
  }
  async function fresh(snapshot,token,{signal}={}){
    const expected=selected(token),actual=selected(await capture(snapshot,{signal}));
    if(!same(expected.identity,actual.identity)||!expected.bytes.equals(actual.bytes))throw error(
      'The authored discrepancy report changed. Read its current issues and use a new operation ID.','ENGINE_CONTEXT_CHANGED',{
        actions:[{operation:'phase.draft.read',inputs:{workId,phaseId:expected.identity.phase}}],requiredInputs:['operationId']});
  }
  return Object.freeze({capture,restore,requests,fresh,identity:token=>structuredClone(selected(token).identity),
    evidence:token=>{const {identity,bytes}=selected(token);return {references:[identity.artifact.content,...(identity.kind==='publication'?[identity.publication.record]:[])],
      pendingEvidence:identity.kind==='private-draft'?[{reference:identity.artifact.content,bytes:Buffer.from(bytes)}]:[]};}});
}

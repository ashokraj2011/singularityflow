/** Replay specification values against actual bytes and original approved inputs; no writes. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,admitRecordSchemaVersion,SPECIFICATION_INDEX_SCHEMA,SPECIFICATION_CLAIM_MAP_SCHEMA} from '../foundation/record-schema.mjs';
import {SPECIFICATION_CLAIM_TIMESTAMP_REQUEST,plannedClaimContractFindings} from '../kernel/specification-values.mjs';
import {assertSpecificationIndexClauses} from '../kernel/specification-policy.mjs';
import {specificationPublicationPolicy,specificationPublicationSources,SPECIFICATION_PUBLICATION_OWNERS} from '../kernel/specification-publication.mjs';
import {extractClauses,specificationIndexRecord,derivePlannedClaimMapReplay,plannedTestSlots,plannedTestAssuranceProblem} from '../engine-compatibility/node-specification-policy.mjs';
import {commandCovering} from '../engine-compatibility/node-source-policy.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {namespaceSpecificationManifest,namespaceSpecificationIdentity as identity} from './namespace-specification-contract.mjs';

const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
// An opaque, invocation-scoped proof traversal; callers cannot seed successful cache entries.
const traversals=new WeakMap();
function traversal(given) {
  const token=given&&traversals.has(given)?given:Object.freeze({});
  if(!traversals.has(token))traversals.set(token,new Map());
  return {token,proofs:traversals.get(token)};
}


/** No clock or repository inference: replay only the retained artifact and pinned declarations. */
function derive(publication,workflow,indices,data) {
  const phase=workflow.phases[publication.phase],selected=specificationPublicationPolicy(workflow,phase);
  if(!selected)throw error('This phase needs another specification policy owner.','ENGINE_PORT_UNAVAILABLE',{required:['specification-publication']});
  if(publication.artifact.encoding!=='utf8')throw error('Specification definitions require UTF-8 Markdown.','ARTIFACT_AUTHORING_INCOMPLETE');
  let markdown;try{markdown=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);}catch(cause){throw error('The specification artifact is not UTF-8 Markdown.','ARTIFACT_AUTHORING_INCOMPLETE',null,cause);}
  const source={path:publication.artifact.sourceKey,sha256:publication.artifact.content.sha256,bytes:publication.artifact.content.bytes};
  const earlier=indices.flatMap(index=>index.clauses),externalClauseIds=earlier.map(clause=>clause.id);
  const index=selected.index?specificationIndexRecord({workId:publication.workId,phase:publication.phase,generation:publication.generation,source,
    clauses:extractClauses(markdown,{sourcePath:source.path,namespace:selected.policy.namespace,limits:selected.policy.limits,externalClauseIds,externalClauses:earlier})}):null;
  if(index)assertSpecificationIndexClauses(index,workflow,phase,selected.policy);
  let planned=null,capabilities=null;
  if(selected.codeSteps.length) {
    const clauses=[...earlier,...(index?.clauses??[])],clauseIds=[...new Set(clauses.map(clause=>clause.id))].sort();
    const root=source.path.split('/artifacts/')[0],replay=derivePlannedClaimMapReplay(markdown,{clauseIds,clauses,policy:selected.policy,evidenceRoot:root+'/evidence'});
    let step=replay.next();
    while(!step.done) {
      if(step.value!==SPECIFICATION_CLAIM_TIMESTAMP_REQUEST)throw error('Unexpected specification value effect.','ENGINE_PORT_RESULT_INVALID');
      step=replay.next(publication.publishedAt);
    }
    const derived=step.value,{placeholderReasons,misallocated,idle}=plannedClaimContractFindings(derived.claimMap.claims,selected.codeSteps);
    if(placeholderReasons.length)throw error('Replace placeholder test exemptions with a concrete reviewed reason.','SPEC_PLANNED_TEST_BINDING_REQUIRED',{phase:phase.id,clauses:placeholderReasons});
    if(misallocated.length||idle.length)throw error('Allocate each obligation to the code steps this phase plans.','SPEC_PLANNED_ALLOCATION_INVALID',{
      phase:phase.id,...(misallocated.length?{misallocated}:{}),...(idle.length?{idle}:{}),codeSteps:selected.codeSteps});
    const gaps=[...new Set([...derived.missingClauseIds,...derived.missingTestClauseIds])].sort();
    if(gaps.length&&selected.enforce)throw error('Complete the exact planned tests or reviewed non-test verification for every clause.','SPEC_PLANNED_TEST_BINDING_REQUIRED',{phase:phase.id,clauses:gaps});
    planned={...derived.claimMap,workId:publication.workId,phase:publication.phase,generation:publication.generation,source};
    const contracts=new Map((planned.verificationContracts??[]).map(contract=>[contract.clauseId,contract])),pending=[],problems=[];
    for(const codeId of selected.codeSteps) {
      const commands=(workflow.phases[codeId].qualityCommands??[]).filter(command=>command.kind==='test');
      for(const slot of plannedTestSlots(planned.claims,contracts,codeId)) {
        const command=commandCovering(commands,slot.testPath);
        if(!command){pending.push(`${slot.id}: no pinned test command of ${codeId} can run ${slot.testPath}`);continue;}
        const problem=plannedTestAssuranceProblem(slot,command);if(problem)problems.push(problem);
      }
    }
    if(problems.length)throw error('The declared test runners cannot provide the required assurance.','TEST_CAPABILITY_UNSUPPORTED',{problems});
    capabilities={status:pending.length?'configuration-pending':'declared',launcherObservation:'not-observed',pending};
  }
  return {index,planned,capabilities};
}

export function createNamespaceSpecificationReader({observer,scope,workId,checks=null}) {
  const verified=new WeakMap();
  async function json(reference,signal) {
    const data=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}
    catch(cause){throw error('The retained specification record is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',null,cause);}
  }
  async function retainedValue(reference,kind,signal) {
    const value=await json(reference,signal);
    try{admitRecordSchemaVersion(kind==='index'?SPECIFICATION_INDEX_SCHEMA:SPECIFICATION_CLAIM_MAP_SCHEMA,value);}
    catch(cause){throw error('The retained '+kind+' has an unsupported or invalid record version.',
      ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',null,cause);}
    return value;
  }
  async function prior(snapshot,phaseId,signal,specificationTraversal) {
    const ids=specificationPublicationSources(snapshot.workflow,phaseId);
    // Construct lazily: recursive publication proof always moves to an earlier pinned phase.
    const packets=createNamespaceSubmissionReader({observer,scope,workId,checks}),proofs=await packets.inspectApprovedMany(snapshot,ids,{signal,specificationTraversal});
    const inputs=[],indices=[];
    for(let i=0;i<ids.length;i++) {
      const proof=proofs[i];
      if(!proof?.published.specifications)throw error('An earlier definition needs its retained specification evidence and human approval.','ENGINE_PORT_UNAVAILABLE',{
        phase:ids[i],required:['approved-specification-evidence']});
      const manifest=namespaceSpecificationManifest(await json(proof.published.specifications.record,signal),{scope,workId,phaseId:ids[i]});
      if(!manifest.index)throw error('The approved definition has no retained clause index.','ENGINE_STORAGE_CORRUPT');
      inputs.push({phase:ids[i],generation:proof.value.generation,publication:proof.value.publication});indices.push(await json(manifest.index,signal));
    }
    return {inputs,indices};
  }
  async function derivePublication(publication,snapshot,{signal}={}) {
    const previous=await prior(snapshot,publication.phase,signal,traversal().token),data=await observer.bytes(publication.artifact.content,publication.artifact.content.bytes,signal);
    return {values:derive(publication,snapshot.workflow,previous.indices,data),inputs:previous.inputs};
  }
  async function verifyOne(publication,signal,specificationTraversal) {
    const manifest=namespaceSpecificationManifest(await json(publication.specifications.record,signal),{scope,workId,phaseId:publication.phase});
    if(!same(identity(publication),Object.fromEntries(Object.keys(identity(publication)).map(key=>[key,manifest[key]])))
      ||manifest.recordedAt!==publication.publishedAt||!same(manifest.configuration,manifest.basis.head.configuration)
      ||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content}))throw error(
      'Specification evidence differs from its original publication identity.','ENGINE_STORAGE_CORRUPT');
    const state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      snapshot={revision:manifest.basis.revision,configuration:manifest.configuration,workflow:state.workflow};
    const previous=await prior(snapshot,publication.phase,signal,specificationTraversal);
    if(!same(previous.inputs,manifest.inputs))throw error('Specification evidence has another approved input set.','ENGINE_STORAGE_CORRUPT');
    const data=await observer.bytes(publication.artifact.content,publication.artifact.content.bytes,signal);let expected;
    try{expected=derive(publication,state.workflow,previous.indices,data);}
    catch(cause){if(cause.code==='ENGINE_PORT_UNAVAILABLE')throw cause;
      throw error('Specification evidence no longer replays against its original bytes.','ENGINE_STORAGE_CORRUPT',null,cause);}
    for(const key of ['index','planned'])if((expected[key]===null)!==(manifest[key]===null)
      ||expected[key]!==null&&!same(expected[key],await retainedValue(manifest[key],key,signal)))throw error('The retained '+key+' differs from deterministic specification replay.','ENGINE_STORAGE_CORRUPT');
    if(!same(expected.capabilities,manifest.capabilities))throw error('The planned capability observation differs from the pinned commands.','ENGINE_STORAGE_CORRUPT');
    return manifest;
  }
  async function verify(publication,{signal,specificationTraversal}={}) {
    if(!publication.specifications)return;
    const {token,proofs}=traversal(specificationTraversal),key=canonicalJson(publication);
    if(!proofs.has(key))proofs.set(key,verifyOne(publication,signal,token));
    verified.set(publication,{identity:key,manifest:await proofs.get(key)});
  }
  function proof(publication) {const found=verified.get(publication);return found&&found.identity===canonicalJson(publication)?found.manifest:null;}
  function owners(publication) {return proof(publication)?SPECIFICATION_PUBLICATION_OWNERS:[];}
  function evidence(publication) {
    const manifest=proof(publication);
    return manifest?[publication.specifications.record,...[manifest.index,manifest.planned].filter(Boolean),...manifest.inputs.map(item=>item.publication.record)]:[];
  }
  function verifyPlan(publication,plan) {
    if(!publication.specifications)return;
    const manifest=proof(publication);
    if(!manifest||!same(manifest.basis.head,plan.basis.head)||manifest.basis.revision!==plan.basis.headVersion
      ||!evidence(publication).every(ref=>plan.evidence.some(item=>same(item,ref))))throw error(
      'Specification evidence was not accepted against its original lifecycle basis.','ENGINE_STORAGE_CORRUPT');
  }
  return Object.freeze({derive:derivePublication,verify,owners,evidence,verifyPlan});
}

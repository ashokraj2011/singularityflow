/** Recompute Code publication from original source, approved claims and actual check receipts. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,admitRecordSchemaVersion,NAMESPACE_PHASE_POLICY_SCHEMAS,namespaceCodePolicyProfile,namespaceCodePolicyVersionsMatch,namespaceCodePreflightVersion} from '../foundation/record-schema.mjs';
import {sourceSnapshot,validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {exactObject,namespaceIdentifier,namespaceRevision} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {codePublicationPolicy} from '../kernel/publication-intent.mjs';
import {plannedClaimAllocatedTo} from '../kernel/specification-policy.mjs';
import {SPECIFICATION_CLAIM_TIMESTAMP_REQUEST} from '../kernel/specification-values.mjs';
import {witnessResult,aggregateWitnesses} from '../kernel/verification-witnesses.mjs';
import {ASSURANCE} from '../kernel/verification-policy.mjs';
import {sourceBaselineInventory,uncoveredTestDeliveryPaths} from '../engine-compatibility/node-source-policy.mjs';
import {deriveObservedClaimMapReplay,effectiveContract,mergedVerificationContracts} from '../engine-compatibility/node-specification-policy.mjs';
import {repositoryPlanProjection,repositoryPlanTestLocation} from '../engine-compatibility/node-repository-plan.mjs';
import {createNamespaceCodePreflightReader,createNamespaceRetainedCodePreflightReader} from './namespace-code-preflight.mjs';
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
import {createNamespaceSourceBaselineReader} from './namespace-source-baseline-reader.mjs';
import {sourceRetentionBinding} from './namespace-source-retention-contract.mjs';
import {createNamespaceSourceControlReader} from './namespace-source-control-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {namespaceStoryReadDomain} from './namespace-story-reader.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {namespaceWitnessAttempt} from './namespace-check-witnesses.mjs';
import {namespaceCodeManifest} from './namespace-policy-contract.mjs';
import {namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=data=>createHash('sha256').update(data).digest('hex');
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null,cause)=>new SingularityFlowError(message,{code,details,cause});
const missing=owner=>{throw error('Code publication needs its declared evidence owner.','ENGINE_PORT_UNAVAILABLE',{required:[owner]});};
const evidenceProofs=new WeakMap(),proofTraversals=new WeakMap();
/** One awaited immutable proof walk; external objects cannot supply cached successful outcomes. */
export async function withCodePolicyTraversal(given,read){
  if(given&&proofTraversals.get(given))return read(given);
  const token=Object.freeze({}),state={entries:[],bytes:0};proofTraversals.set(token,state);
  try{return await read(token);}finally{state.entries.length=0;state.bytes=0;proofTraversals.set(token,null);}
}
export async function verifyCodePolicyInTraversal(reader,observer,publication,binding,{signal,policyTraversal}={}){
  const cancelled=()=>{if(signal?.aborted)throw error('Code policy replay was cancelled.','ENGINE_OPERATION_CANCELLED');};cancelled();
  const scope=proofTraversals.get(policyTraversal);if(!scope)return reader.verify(publication,binding,{signal,policyTraversal});
  const domain=namespaceStoryReadDomain(observer),key=canonicalJson([publication,binding]),cached=scope.entries.find(row=>row.key===key&&row.domain===domain);
  if(cached){const value=await cached.pending;cancelled();if(proofTraversals.get(policyTraversal)!==scope)throw error('The Code proof traversal expired.','ENGINE_CONTEXT_CHANGED');return reader.reuse(publication,value);}
  if(scope.entries.length>=32)return reader.verify(publication,binding,{signal,policyTraversal});
  const entry={domain,key,pending:reader.verify(publication,binding,{signal,policyTraversal})};scope.entries.push(entry);
  try{const value=await entry.pending,proof=evidenceProofs.get(value);cancelled();
    if(proofTraversals.get(policyTraversal)!==scope)throw error('The Code proof traversal expired.','ENGINE_CONTEXT_CHANGED');
    if(!proof)throw error('Code reuse needs its actual verified policy proof.','ENGINE_PORT_RESULT_INVALID');
    if(scope.bytes+proof.bytes>8*1024*1024){entry.key=null;entry.pending=null;}else scope.bytes+=proof.bytes;
    return value;
  }catch(cause){entry.key=null;entry.pending=null;throw cause;}
}
function reportValue(value){
  try{const profile=namespaceCodePolicyProfile('codeReport',value);
    exactObject(value,['schemaVersion','format','preflight','control','checks','repositories','acceptance']);
    if(value.format!==profile.format||!Array.isArray(value.repositories)||!Array.isArray(value.acceptance))throw Error('Another Code report.');
    const p=value.preflight;exactObject(p,['profile','source','baseline','plan','repositories',...(profile.rework?['history']:[])]);
    if(p.profile!=='sflow-namespace-code-preflight/v'+profile.version||!Array.isArray(p.repositories))throw Error('Another Code preflight.');
    sourceRetentionBinding(p.source);exactObject(p.baseline,['operationId','record','index']);namespaceIdentifier(p.baseline.operationId,'Baseline operation');
    for(const [row,fields]of [[p.baseline.record,['key','version','content']],[p.baseline.index,['key','version']]]){
      exactObject(row,fields);if(typeof row.key!=='string'||namespaceRevision(row.version)===null)throw Error('Invalid baseline binding.');
    }
    if(contentReference(p.baseline.record.content).namespace!=='evidence')throw Error('A baseline needs shared content.');
    exactObject(value.control,['namespace','key','version']);
    if(value.control.namespace!=='evidence'||!/^source-control\/drafts\/[a-f0-9]{64}$/u.test(value.control.key??'')||value.control.version!==null)throw Error('Another Code control profile.');
  }catch(cause){throw error('The retained Code report has an invalid or unsupported contract.',
    ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED','ENGINE_STORAGE_UNSUPPORTED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',null,cause);}
  return value;
}
async function observedClaimMap(planned,delivery,publication,policy,repositoryId){
  const claims=Object.fromEntries(Object.entries(planned.claims).filter(([,claim])=>plannedClaimAllocatedTo(claim,publication.phase))),
    replay=deriveObservedClaimMapReplay(claims,{...delivery,fulfillment:{obligations:delivery.fulfillment??[]},
      traceability:{bindings:delivery.acceptanceCriteria.bindings,sourceBindings:delivery.sourceBindings.bindings}},
      {policy,requireSourceBindings:delivery.sourceBindings.mode==='enforce'});let step=replay.next();
  while(!step.done){if(step.value!==SPECIFICATION_CLAIM_TIMESTAMP_REQUEST)missing(step.value.kind);step=replay.next(publication.publishedAt);}
  return {...step.value,workId:publication.workId,phase:publication.phase,generation:publication.generation,repositoryId,
    source:{path:publication.artifact.sourceKey,sha256:publication.artifact.content.sha256,bytes:publication.artifact.content.bytes}};
}
export function createNamespaceCodePolicyReader({observer,scope,workId,checks}){
  const bindings=observer.evidenceReads;if(!bindings)missing('source-evidence-read-bindings');
  const sources=createNamespaceSourceRetentionReader({...bindings,observer}),verified=new WeakMap();
  function withReaders(read){return observer.withReadScope(scoped=>{const options={...bindings,observer:scoped},scopedChecks=createNamespacePhaseCheckReader(options);return read({observer:scoped,checks:scopedChecks,
    sources:createNamespaceSourceRetentionReader(options),baseline:createNamespaceSourceBaselineReader(options),controls:createNamespaceSourceControlReader(options),
    plans:createNamespaceSpecificationReader({observer:scoped,scope,workId,checks:scopedChecks}),current:createNamespaceCodePreflightReader(options),retained:createNamespaceRetainedCodePreflightReader(options)});});}
  const identity=publication=>({phaseId:publication.phase,generation:publication.generation,baseRevision:publication.baseRevision,
    draft:{workId,phase:publication.phase,revision:publication.draft.revision,bodySha256:publication.draft.sha256},configuration:publication.configuration,
    artifact:{...publication.artifact.content,namespace:'local'}});
  const controlBinding=(controls,selected)=>({namespace:'evidence',key:controls.codec.indexKey({input:{phaseId:selected.phaseId},generation:selected.generation,
    basis:{headVersion:selected.baseRevision},draft:selected.draft}),version:null});
  async function sourceBinding(snapshot,selected,{signal}={}){
    return withReaders(async({sources,baseline})=>{
      const found=await sources.inspectDraft(selected,{signal});if(!found)throw error('Retain this exact authored Code generation.','ENGINE_SOURCE_EVIDENCE_REQUIRED',{
        operation:'phase.source.retain',workId,phaseId:selected.phaseId});
      if(found.plan.basis.headVersion!==snapshot.revision||!same(found.plan.basis.configuration,snapshot.configuration))throw error('Code source belongs to another lifecycle basis.','ENGINE_CONTEXT_CHANGED');
      const original=await baseline.inspectBinding(found.plan.sourceBinding.operationId,{signal});if(!original)throw error('Retain the exact original Code source.','ENGINE_SOURCE_BASELINE_REQUIRED',{
        operation:'source.baseline.retain',sourceBindingId:found.plan.sourceBinding.operationId,workId});
      return {source:found.binding,baseline:{operationId:original.plan.input.operationId,record:original.record,index:{key:original.indexKey,version:original.indexVersion}}};
    });
  }
  async function json(reference,signal){const data=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch(cause){throw error('Code policy evidence is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',null,cause);}}
  async function candidateFor(publication,snapshot,{signal,bound=null,policyTraversal}={}, {observer,sources,controls,plans,current,retained,checks}){
    const workflow=snapshot.workflow,phase=workflow.phases[publication.phase],policy=codePublicationPolicy(workflow,phase);
    if(!policy)missing('code-publication-policy');
    const selected=identity(publication);
    // v1 explicitly excludes an origin/control interpretation it cannot replay, rather than ignoring one.
    if(!bound&&await controls.inspectDraft(selected,{signal}))missing('namespace-code-control-history');
    const preflight=await (bound?retained:current).inspect(snapshot,publication.phase,selected,{signal,policyTraversal,...(bound?{binding:bound.preflight}:{})}),
      source=await sources.accepted({operationId:preflight.source.operationId,workId,phaseId:publication.phase},{signal}),
      plan=await plans.sourcePlan(snapshot,publication.phase,{signal}),definition=(await observer.approved(snapshot,{signal})).compiled.definition;
    if(!source||!same(source.binding,preflight.source))throw error('The Code report lost its actual retained source receipt.');
    const tested=publication.checks?await checks.publication(publication,{signal}):null;
    if(!tested&&preflight.repositories.some(row=>row.delivery.testPaths.length))throw error('Run and retain the pinned tests for this exact Code generation.','ENGINE_CHECK_EVIDENCE_REQUIRED',{
      operation:'phase.checks.run',workId,phase:publication.phase});
    if(tested&&tested.plan.sources.length!==source.plan.sources.length)throw error('Code and check evidence name different repository sets.');
    const repositories=[];
    for(const row of preflight.repositories){
      const selectedSource=source.plan.sources.find(item=>item.repository.id===row.id),checked=tested?.plan.sources.find(item=>item.id===row.id),
        sourceSnapshot=await sources.snapshot(selectedSource.observed.content,selectedSource.repository.descriptor,selectedSource.observed.revision,signal),
        inventory=value=>sourceBaselineInventory(value,{definition,workflow});
      if(tested&&(!checked||!same(checked.descriptor,selectedSource.repository.descriptor)
        ||!same(inventory(await checks.snapshot(checked.content,checked.descriptor,signal)),inventory(sourceSnapshot))))throw error(
          'The accepted tests did not run on the retained Code source.','ENGINE_CODE_CHECK_SOURCE_MISMATCH',{repositoryId:row.id,operation:'phase.checks.run'});
      const commands=(tested?.plan.steps??[]).filter((step,index)=>step.repositoryId===row.id&&tested.body.checks[index].status==='passed'&&step.command.kind==='test').map(step=>step.command),
        uncovered=uncoveredTestDeliveryPaths(row.delivery,phase.sourceBoundary,commands);
      if(workflow.resolution.codeDelivery?.tests?.requireAffectedModuleCoverage!==false&&uncovered.length)throw error(
        'Pinned passing tests do not cover every affected delivery path.','CODE_DELIVERY_TEST_COVERAGE_INCOMPLETE',{repositoryId:row.id,paths:uncovered});
      const witnesses=row.delivery.acceptanceCriteria.witnesses.map(witness=>({witness,result:witnessResult(witness,namespaceWitnessAttempt(witness,tested,row.id),{
        submitted:true,enforceAssertionAdequacy:workflow.resolution.codeDelivery?.assertionAdequacy==='enforce'})})),
        projection=plan.repositoryPlan?repositoryPlanProjection(plan.repositoryPlan,row.id):null,
        planned=projection?{...plan.planned,claims:projection.claims,supportingFiles:projection.supportingFiles,supportingFileDetails:projection.supportingFileDetails}:plan.planned;
      repositories.push({id:row.id,sourceRevision:selectedSource.observed.revision,checkRevision:checked?.revision??null,witnesses,
        observed:await observedClaimMap(planned,row.delivery,publication,workflow.resolution.spec,row.id)});
    }
    const contracts=mergedVerificationContracts([plan.planned]),criteria=plan.active.indexes.flatMap(index=>index.clauses)
      .filter(clause=>(clause.type==='AC'||/:AC-\d+$/u.test(clause.id))&&plannedClaimAllocatedTo(plan.planned.claims[clause.id],publication.phase)),acceptance=[];
    for(const clause of criteria){const contract=effectiveContract(clause.id,contracts,plan.planned.claims[clause.id]);if(!contract)continue;
      if(contract.combination!=='all'||contract.slots.some(slot=>slot.method!=='test'||slot.role!=='primary'))missing('verification-contract-acceptance');
      for(const slot of contract.slots){const paths=slot.witness.path?[slot.witness.path]:slot.witness.paths??[];
        if(!paths.length)throw error('The primary test slot needs its exact planned test path.','CODE_TEST_WITNESS_INCOMPLETE',{clauseId:clause.id,slot:slot.slot,operation:'phase.draft.write'});
        for(const global of paths){
        const local=plan.repositoryPlan?repositoryPlanTestLocation(plan.repositoryPlan,global,{workflow,definition}):{repositoryId:repositories[0]?.id,path:global},
          repository=repositories.find(row=>row.id===local?.repositoryId),matches=repository?.witnesses.filter(row=>row.witness.clauseId===clause.id&&row.witness.testSource===local.path)??[],
          result=aggregateWitnesses(matches.map(row=>row.result)),assurance=slot.requiredAssurance??matches[0]?.result.requiredAssurance??'module-observed';
        if(result.status!=='met'||ASSURANCE.indexOf(result.assurance)<ASSURANCE.indexOf(assurance))throw error(
          'Retain successful execution of every planned acceptance test before Code publication.','CODE_TEST_WITNESS_INCOMPLETE',{
            clauseId:clause.id,slot:slot.slot,repositoryId:local?.repositoryId??null,path:local?.path??global,status:result.status,assurance:result.assurance,requiredAssurance:assurance,
            reasons:[...new Set(matches.flatMap(row=>row.result.reasons))],operation:'phase.checks.run'});
        acceptance.push({clauseId:clause.id,slot:slot.slot,repositoryId:local.repositoryId,path:local.path,result,requiredAssurance:assurance});
        }
      }
    }
    const version=namespaceCodePreflightVersion(preflight),report=reportValue({schemaVersion:version,format:'sflow-namespace-code-policy-report/v'+version,preflight,control:controlBinding(controls,selected),checks:publication.checks??null,repositories,acceptance});
    return {report,source,policy};
  }
  function candidate(publication,snapshot,options){return withReaders(readers=>candidateFor(publication,snapshot,options,readers));}
  async function verify(publication,binding,{signal,policyTraversal}={}){
    return withReaders(async readers=>{
    const manifest=namespaceCodeManifest(await json(binding.record,signal),{scope,workId,phaseId:publication.phase});
    if(!same(namespaceSpecificationIdentity(publication),Object.fromEntries(Object.keys(namespaceSpecificationIdentity(publication)).map(key=>[key,manifest[key]])))
      ||manifest.recordedAt!==publication.publishedAt||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content})
      ||!same(manifest.configuration,manifest.basis.head.configuration))throw error('The Code policy differs from its original publication identity.');
    const report=reportValue(await json(manifest.report,signal)),profile=namespaceCodePolicyProfile('code',manifest);
    if(!namespaceCodePolicyVersionsMatch(manifest,report)||binding.kind!==(profile.kind))throw error('The Code policy binding names another immutable version.');
    const state=await readers.observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      actual=await candidateFor(publication,{revision:manifest.basis.revision,configuration:manifest.configuration,workflow:state.workflow},{signal,bound:report,policyTraversal},readers);
    if(!same(actual.report,report))throw error('The Code report does not replay from its exact accepted source, plan and checks.');
    const value={binding,manifest,...actual},serialized=canonicalJson(value),identity=canonicalJson(publication);
    evidenceProofs.set(value,{domain:namespaceStoryReadDomain(observer),identity,sha256:hash(serialized),bytes:new TextEncoder().encode(serialized).byteLength});
    verified.set(publication,{identity,value});return value;
    });
  }
  function reuse(publication,value){const source=evidenceProofs.get(value),identity=canonicalJson(publication);
    if(!source||source.domain!==namespaceStoryReadDomain(observer)||source.identity!==identity||source.sha256!==hash(canonicalJson(value)))throw error('The Code proof changed or belongs to another read owner.','ENGINE_CONTEXT_CHANGED');
    verified.set(publication,{identity,value});return value;}
  function proof(publication){const found=verified.get(publication),source=found&&evidenceProofs.get(found.value);
    return source&&found.identity===canonicalJson(publication)&&source.sha256===hash(canonicalJson(found.value))?found.value:null;}
  function readBindings(value){const p=value.report.preflight;return [...[p.source.result,p.source.index,p.baseline.record,p.baseline.index].map(row=>({namespace:'evidence',key:row.key,version:row.version})),value.report.control];}
  function evidence(value){const p=value.report.preflight;return [value.binding.record,value.manifest.report,p.source.result.content,p.baseline.record.content,
    p.plan.publication,p.plan.reviewPacket,p.plan.planned,...p.plan.indices.map(row=>row.record),...(p.plan.repositoryPlan?[p.plan.repositoryPlan]:[]),...(p.history?[p.history.predecessor.publication.record,p.history.predecessor.policy.record,p.history.predecessor.report,(p.history.return.rejection??p.history.return.approval).record]:[])];}
  async function freshSources(publication,units,{signal}={}){
    const value=proof(publication);if(!value)throw error('Verify the exact Code proof before checking source freshness.','ENGINE_INPUT_INVALID');
    const selected=new Map(units.map(unit=>[validateSourceUnit(unit).repositoryId,unit]));
    for(const source of value.source.plan.sources){const unit=selected.get(source.repository.id);if(!unit||!same(unit.descriptor,source.repository.descriptor))throw error('Bind the actual Code source before publication.','ENGINE_SOURCE_UNIT_UNAVAILABLE');
      const observed=await unit.capture({signal}),snapshot=sourceSnapshot(observed.snapshot,unit.descriptor);
      const original=await sources.snapshot(source.observed.content,unit.descriptor,source.observed.revision,signal),definition=(await observer.approved({workflow:value.source.workflow,configuration:publication.configuration},{signal})).compiled.definition;
      if(observed.revision!=='sha256:'+hash(canonicalJson(snapshot))||!same(sourceBaselineInventory(original,{definition,workflow:value.source.workflow}),sourceBaselineInventory(snapshot,{definition,workflow:value.source.workflow})))throw error(
        'Code source changed after its retained evidence.','ENGINE_SOURCE_CHANGED',{operation:'phase.source.retain',workId,phase:publication.phase});
    }
  }
  return Object.freeze({sourceBinding,candidate,verify,reuse,proof,readBindings,evidence,freshSources});
}

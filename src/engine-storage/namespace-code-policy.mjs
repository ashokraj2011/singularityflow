/** Recompute Code publication from original source, approved claims and actual check receipts. */
import {isNamespaceTestRiskPolicy,canonicalJson,admitRecordSchemaVersion,NAMESPACE_PHASE_POLICY_SCHEMAS,namespaceCodePolicyProfile,namespaceCodePolicyVersionsMatch,namespaceCodePreflightVersion} from '../foundation/record-schema.mjs';
import {createNamespaceTestRiskOwner} from './namespace-test-risk-reader.mjs';
import {namespaceCodeEnvironmentRiskCoverage} from '../kernel/test-recovery.mjs';
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
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
import {createNamespaceOutputRetentionReader} from './namespace-output-retention-reader.mjs';
import {createNamespaceSourceBaselineReader} from './namespace-source-baseline-reader.mjs';
import {sourceRetentionBinding} from './namespace-source-retention-contract.mjs';
import {createNamespaceSourceControlReader} from './namespace-source-control-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {namespaceStoryReadDomain,memoNamespaceObservedCodePolicy} from './namespace-story-reader.mjs';
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
  try{const wire=namespaceCodePolicyProfile('codeReport',value),profile=wire.executionRisk?namespaceCodePolicyProfile('codeReport',{schemaVersion:value.evidenceVersion}):wire;
    if(wire.executionRisk&&(!Number.isInteger(value.evidenceVersion)||value.evidenceVersion<1||value.evidenceVersion>31||value.checks!==null
      ||value.executionException?.profile!=='sflow-namespace-code-execution-risk/v1'||value.executionException.testsPassed!==false))throw Error('Another execution exception.');
    exactObject(value,['schemaVersion','format','preflight','control','checks','repositories','acceptance',...(wire.executionRisk?['evidenceVersion','executionException']:[])]);
    if(value.format!==wire.format||!Array.isArray(value.repositories)||!Array.isArray(value.acceptance))throw Error('Another Code report.');
    const p=value.preflight;exactObject(p,['profile','source','baseline','plan','repositories',...((profile.optionalHistory?Boolean(p.history):profile.rework)?['history']:[]),
      ...((profile.optionalPredecessors?Boolean(p.priorCode):profile.predecessors)?['priorCode']:[]),...((profile.optionalOutputs?Boolean(p.outputs):profile.outputs)?['outputs']:[]),...(profile.repositoryCoverage?['repositoryScope']:[])]);
    const preflightVersion=profile.humanAcceptance?namespaceCodePreflightVersion(p):profile.version;
    if(p.profile!=='sflow-namespace-code-preflight/v'+preflightVersion||namespaceCodePreflightVersion(p)!==preflightVersion||!Array.isArray(p.repositories))throw Error('Another Code preflight.');
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
  const sources=createNamespaceSourceRetentionReader({...bindings,observer}),verified=new WeakMap(),candidates=new WeakMap();
  function withReaders(read){return observer.withReadScope(scoped=>{const options={...bindings,observer:scoped},scopedChecks=createNamespacePhaseCheckReader(options);return read({observer:scoped,checks:scopedChecks,
    sources:createNamespaceSourceRetentionReader(options),baseline:createNamespaceSourceBaselineReader(options),controls:createNamespaceSourceControlReader(options),
    plans:createNamespaceSpecificationReader({observer:scoped,scope,workId,checks:scopedChecks}),current:createNamespaceCodePreflightReader(options),retained:createNamespaceRetainedCodePreflightReader(options)});});}
  const identity=publication=>({phaseId:publication.phase,generation:publication.generation,baseRevision:publication.baseRevision,
    draft:{workId,phase:publication.phase,revision:publication.draft.revision,bodySha256:publication.draft.sha256},configuration:publication.configuration,
    artifact:{...publication.artifact.content,namespace:'local'}});
  const controlBinding=(controls,selected)=>({namespace:'evidence',key:controls.codec.indexKey({input:{phaseId:selected.phaseId},generation:selected.generation,
    basis:{headVersion:selected.baseRevision},draft:selected.draft}),version:null});
  async function sourceBinding(snapshot,selected,{signal}={}){
    return withReaders(async({observer:selectedObserver,sources,baseline})=>{
      const found=await sources.inspectDraft(selected,{signal});if(!found)throw error('Retain this exact authored Code generation.','ENGINE_SOURCE_EVIDENCE_REQUIRED',{
        operation:'phase.source.retain',workId,phaseId:selected.phaseId});
      if(found.plan.basis.headVersion!==snapshot.revision||!same(found.plan.basis.configuration,snapshot.configuration))throw error('Code source belongs to another lifecycle basis.','ENGINE_CONTEXT_CHANGED');
      const original=await baseline.inspectBinding(found.plan.sourceBinding.operationId,{signal});if(!original)throw error('Retain the exact original Code source.','ENGINE_SOURCE_BASELINE_REQUIRED',{
        operation:'source.baseline.retain',sourceBindingId:found.plan.sourceBinding.operationId,workId});
      const outputs=await createNamespaceOutputRetentionReader({...bindings,observer:selectedObserver,sourceReader:sources}).selection({
        phaseId:selected.phaseId,generation:selected.generation,configuration:snapshot.configuration,source:found},{signal});
      return {source:found.binding,baseline:{operationId:original.plan.input.operationId,record:original.record,index:{key:original.indexKey,version:original.indexVersion}},...(outputs?{outputs}:{})};
    });
  }
  async function json(reference,signal){const data=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch(cause){throw error('Code policy evidence is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',null,cause);}}
  async function candidateFor(publication,snapshot,{signal,bound=null,policyTraversal,riskChecks=null}={}, {observer,sources,controls,plans,current,retained,checks}){
    const workflow=snapshot.workflow,phase=workflow.phases[publication.phase],policy=codePublicationPolicy(workflow,phase);
    if(!policy)missing('code-publication-policy');
    const selected=identity(publication);
    // v1 explicitly excludes an origin/control interpretation it cannot replay, rather than ignoring one.
    if(!bound&&await controls.inspectDraft(selected,{signal}))missing('namespace-code-control-history');
    const preflight=await (bound?retained:current).inspect(snapshot,publication.phase,selected,{signal,policyTraversal,...(bound?{binding:bound.preflight}:{})}),
      source=await sources.accepted({operationId:preflight.source.operationId,workId,phaseId:publication.phase},{signal}),
      plan=await plans.sourcePlan(snapshot,publication.phase,{signal}),definition=(await observer.approved(snapshot,{signal})).compiled.definition;
    if(!source||!same(source.binding,preflight.source))throw error('The Code report lost its actual retained source receipt.');
    const riskOwner=publication.policyEvidence?.some(row=>isNamespaceTestRiskPolicy(row.kind)&&row.kind!=='test-risk/v1')||riskChecks?createNamespaceTestRiskOwner({observer,scope,workId}):null,
      risk=riskChecks?{...await riskOwner.candidate(publication,snapshot,{signal,at:publication.publishedAt,checked:{binding:riskChecks,found:await checks.proof(riskChecks,publication.phase,{signal})}}),
        binding:riskChecks,found:await checks.proof(riskChecks,publication.phase,{signal})}:riskOwner?await riskOwner.forPublication(publication,snapshot,{signal}):null,
      tested=publication.checks?await checks.publication(publication,{signal}):risk?.found??null;
    if(!tested&&(preflight.history?.mode==='revalidated'||preflight.repositories.some(row=>row.delivery.testPaths.length)))throw error('Run and retain the pinned tests for this exact Code generation.','ENGINE_CHECK_EVIDENCE_REQUIRED',{
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
      const commands=(tested?.plan.steps??[]).filter((step,index)=>step.repositoryId===row.id&&(tested.body.checks[index].status==='passed'||risk?.report.observations.some(item=>item.repositoryId===row.id&&item.commandId===step.command.id&&item.decision))&&step.command.kind==='test').map(step=>step.command),
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
      const extended=contract.combination!=='all'||contract.slots.some(slot=>slot.method!=='test'||slot.role!=='primary');
      if(extended){const testSlots=[];
        for(const slot of contract.slots.filter(row=>row.method==='test')){const results=[];
          for(const global of slot.witness.path?[slot.witness.path]:slot.witness.paths??[]){
            const local=plan.repositoryPlan?repositoryPlanTestLocation(plan.repositoryPlan,global,{workflow,definition}):{repositoryId:repositories[0]?.id,path:global},
              repository=repositories.find(row=>row.id===local?.repositoryId),matches=repository?.witnesses.filter(row=>row.witness.clauseId===clause.id&&row.witness.testSource===local.path)??[],
              result=aggregateWitnesses(matches.map(row=>row.result)),assurance=slot.requiredAssurance??matches[0]?.result.requiredAssurance??'module-observed',
              exception=namespaceCodeEnvironmentRiskCoverage(matches,local?.repositoryId,risk?.report,{enforceAssertionAdequacy:workflow.resolution.codeDelivery?.assertionAdequacy==='enforce'});
            if(slot.role==='primary'&&contract.combination==='all'&&!exception&&(result.status!=='met'||ASSURANCE.indexOf(result.assurance)<ASSURANCE.indexOf(assurance)))throw error(
              'Retain successful execution of each required primary test slot before Code publication.','CODE_TEST_WITNESS_INCOMPLETE',{
                clauseId:clause.id,slot:slot.slot,repositoryId:local?.repositoryId??null,path:global,operation:'phase.checks.run'});
            results.push({repositoryId:local?.repositoryId??null,path:global,result,requiredAssurance:assurance,
              ...(risk?{witnessResults:matches.map(row=>row.result)}:{}),...(exception?{executionException:exception}:{})});}
          if(!results.length&&slot.role==='primary'&&contract.combination==='all')throw error('The primary test slot needs an exact planned test path.',
            'CODE_TEST_WITNESS_INCOMPLETE',{clauseId:clause.id,slot:slot.slot,operation:'phase.draft.write'});
          testSlots.push({slot:slot.slot,results});}
        acceptance.push({clauseId:clause.id,contract,testSlots});continue;}
      for(const slot of contract.slots){const paths=slot.witness.path?[slot.witness.path]:slot.witness.paths??[];
        if(!paths.length)throw error('The primary test slot needs its exact planned test path.','CODE_TEST_WITNESS_INCOMPLETE',{clauseId:clause.id,slot:slot.slot,operation:'phase.draft.write'});
        for(const global of paths){
        const local=plan.repositoryPlan?repositoryPlanTestLocation(plan.repositoryPlan,global,{workflow,definition}):{repositoryId:repositories[0]?.id,path:global},
          repository=repositories.find(row=>row.id===local?.repositoryId),matches=repository?.witnesses.filter(row=>row.witness.clauseId===clause.id&&row.witness.testSource===local.path)??[],
          result=aggregateWitnesses(matches.map(row=>row.result)),assurance=slot.requiredAssurance??matches[0]?.result.requiredAssurance??'module-observed',
              exception=namespaceCodeEnvironmentRiskCoverage(matches,local?.repositoryId,risk?.report,{enforceAssertionAdequacy:workflow.resolution.codeDelivery?.assertionAdequacy==='enforce'});
        if(!exception&&(result.status!=='met'||ASSURANCE.indexOf(result.assurance)<ASSURANCE.indexOf(assurance)))throw error(
          'Retain successful execution of every planned acceptance test before Code publication.','CODE_TEST_WITNESS_INCOMPLETE',{
            clauseId:clause.id,slot:slot.slot,repositoryId:local?.repositoryId??null,path:local?.path??global,status:result.status,assurance:result.assurance,requiredAssurance:assurance,
            reasons:[...new Set(matches.flatMap(row=>row.result.reasons))],operation:'phase.checks.run'});
        acceptance.push({clauseId:clause.id,slot:slot.slot,repositoryId:local.repositoryId,path:local.path,result,requiredAssurance:assurance,...(exception?{executionException:exception}:{})});
        }
      }
    }
    const extended=acceptance.some(row=>row.contract),preflightVersion=namespaceCodePreflightVersion(preflight),version=extended?({8:9,10:11,12:13,14:15,16:17,18:19,20:21,22:23,28:29,30:31}[preflightVersion]??7):preflightVersion;
    const report=reportValue({schemaVersion:risk?32:version,format:'sflow-namespace-code-policy-report/v'+(risk?32:version),preflight,control:controlBinding(controls,selected),checks:publication.checks??null,repositories,acceptance,
      ...(risk?{evidenceVersion:version,executionException:{profile:'sflow-namespace-code-execution-risk/v1',checks:risk.binding,testsPassed:false,policy:publication.policyEvidence?.find(row=>isNamespaceTestRiskPolicy(row.kind)&&row.kind!=='test-risk/v1')??null}}:{})});
    return {report,source,policy};
  }
  async function candidate(publication,snapshot,options){const value=await withReaders(readers=>candidateFor(publication,snapshot,options,readers));
    candidates.set(value,{identity:canonicalJson(publication),sha256:hash(canonicalJson(value))});return value;}
  async function verify(publication,binding,{signal,policyTraversal}={}){
    const original=canonicalJson({publication,binding}),value=await memoNamespaceObservedCodePolicy(observer,{publication,binding},()=>withReaders(async readers=>{
    const manifest=namespaceCodeManifest(await json(binding.record,signal),{scope,workId,phaseId:publication.phase});
    if(!same(namespaceSpecificationIdentity(publication),Object.fromEntries(Object.keys(namespaceSpecificationIdentity(publication)).map(key=>[key,manifest[key]])))
      ||manifest.recordedAt!==publication.publishedAt||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content})
      ||!same(manifest.configuration,manifest.basis.head.configuration))throw error('The Code policy differs from its original publication identity.');
    const report=reportValue(await json(manifest.report,signal)),profile=namespaceCodePolicyProfile('code',manifest);
    if(!namespaceCodePolicyVersionsMatch(manifest,report)||binding.kind!==(profile.kind))throw error('The Code policy binding names another immutable version.');
    const state=await readers.observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      actual=await candidateFor(publication,{revision:manifest.basis.revision,configuration:manifest.configuration,workflow:state.workflow},{signal,bound:report,policyTraversal},readers);
    if(!same(actual.report,report))throw error('The Code report does not replay from its exact accepted source, plan and checks.');
    return {binding,manifest,...actual};
    }),{signal});
    if(original!==canonicalJson({publication,binding}))throw error('The Code publication changed during verification.','ENGINE_CONTEXT_CHANGED');
    const serialized=canonicalJson(value),identity=canonicalJson(publication);
    evidenceProofs.set(value,{domain:namespaceStoryReadDomain(observer),identity,sha256:hash(serialized),bytes:new TextEncoder().encode(serialized).byteLength});
    verified.set(publication,{identity,value});return value;
  }
  function reuse(publication,value){const source=evidenceProofs.get(value),identity=canonicalJson(publication);
    if(!source||source.domain!==namespaceStoryReadDomain(observer)||source.identity!==identity||source.sha256!==hash(canonicalJson(value)))throw error('The Code proof changed or belongs to another read owner.','ENGINE_CONTEXT_CHANGED');
    verified.set(publication,{identity,value});return value;}
  function proof(publication){const found=verified.get(publication),source=found&&evidenceProofs.get(found.value);
    return source&&found.identity===canonicalJson(publication)&&source.sha256===hash(canonicalJson(found.value))?found.value:null;}
  function readBindings(value){const p=value.report.preflight;return [...[p.source.result,p.source.index,p.baseline.record,p.baseline.index,...(p.outputs?[p.outputs.index,...p.outputs.files.map(row=>row.retention.result)]:[])].map(row=>({namespace:'evidence',key:row.key,version:row.version})),value.report.control];}
  function evidence(value){const p=value.report.preflight;return [value.binding.record,value.manifest.report,p.source.result.content,p.baseline.record.content,
    p.plan.publication,p.plan.reviewPacket,p.plan.planned,...p.plan.indices.map(row=>row.record),...(p.plan.repositoryPlan?[p.plan.repositoryPlan]:[]),
    ...(p.plan.amendments??[]).map(row=>row.record),...(p.outputs?.files??[]).flatMap(row=>[row.content,row.retention.result.content]),...(value.source.workflow.planAmendments??[]).flatMap(row=>(row.operations??[]).filter(operation=>operation.op==='reclassify-evidence').map(operation=>operation.content)),
    ...(p.priorCode?.phases??[]).flatMap(row=>row.references),...(['sflow-namespace-code-history/v4','sflow-namespace-code-history/v6','sflow-namespace-code-history/v12'].includes(p.history?.profile)?p.history.returns.flatMap(row=>row.references):p.history?[p.history.predecessor.publication.record,p.history.predecessor.policy.record,p.history.predecessor.report,(p.history.return.amendment??p.history.return.upstream??p.history.return.choice??p.history.return.rejection??p.history.return.approval).record,...(p.history.return.references??[]),...(p.history.returns??[]).flatMap(row=>row.references),...(p.history.earlierReturns??[]).flatMap(row=>row.references)]:[])];}
  async function freshSources(publication,units,{signal}={}){
    const value=proof(publication);if(!value)throw error('Verify the exact Code proof before checking source freshness.','ENGINE_INPUT_INVALID');
    return readFreshSources(value,publication,units,{signal});
  }
  async function freshCandidate(value,publication,units,{signal}={}){
    const found=candidates.get(value);
    if(!found||found.identity!==canonicalJson(publication)||found.sha256!==hash(canonicalJson(value)))throw error(
      'Use the unchanged Code candidate before inspecting its source freshness.','ENGINE_INPUT_INVALID');
    return readFreshSources(value,publication,units,{signal});
  }
  async function readFreshSources(value,publication,units,{signal}={}){
    const selected=new Map(units.map(unit=>[validateSourceUnit(unit).repositoryId,unit]));
    for(const source of value.source.plan.sources){const unit=selected.get(source.repository.id);if(!unit||!same(unit.descriptor,source.repository.descriptor))throw error('Bind the actual Code source before publication.','ENGINE_SOURCE_UNIT_UNAVAILABLE');
      const observed=await unit.capture({signal}),snapshot=sourceSnapshot(observed.snapshot,unit.descriptor);
      const original=await sources.snapshot(source.observed.content,unit.descriptor,source.observed.revision,signal),definition=(await observer.approved({workflow:value.source.workflow,configuration:publication.configuration},{signal})).compiled.definition;
      if(observed.revision!=='sha256:'+hash(canonicalJson(snapshot))||!same(sourceBaselineInventory(original,{definition,workflow:value.source.workflow}),sourceBaselineInventory(snapshot,{definition,workflow:value.source.workflow})))throw error(
        'Code source changed after its retained evidence.','ENGINE_SOURCE_CHANGED',{operation:'phase.source.retain',workId,phase:publication.phase});
    }
  }
  return Object.freeze({sourceBinding,candidate,verify,reuse,proof,readBindings,evidence,freshSources,freshCandidate});
}

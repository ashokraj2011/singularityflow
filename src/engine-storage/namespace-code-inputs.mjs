/** Carry actual approved Code proofs into downstream publications. No execution or writes. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,namespaceCodeInputPolicyProfile,namespaceCodePolicyProfile} from '../foundation/record-schema.mjs';
import {sourceSnapshot,validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {exactObject} from '../sda/namespace/values.mjs';
import {codeInputPublicationPolicy,conformancePublicationPolicy,codePublicationInputPhases} from '../kernel/publication-intent.mjs';
import {resolvedPhaseInputs} from '../kernel/phase-inputs.mjs';
import {testReceiptPassing} from '../kernel/test-report-codec.mjs';
import {sourceBaselineInventory} from '../engine-compatibility/node-source-policy.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceTestRiskOwner} from './namespace-test-risk-reader.mjs';
import {namespaceCodeInputManifest} from './namespace-policy-contract.mjs';
import {namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=data=>createHash('sha256').update(data).digest('hex');
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null,cause)=>new SingularityFlowError(message,{code,details,cause});
function inputReport(value){
  try{const profile=namespaceCodeInputPolicyProfile('codeInputReport',value);
    exactObject(value,['schemaVersion','format','testEvidenceFrom','inputs','currentSources']);
    if(value.format!==profile.format||!Array.isArray(value.inputs)||!Array.isArray(value.currentSources)
      ||!profile.selectiveInputs&&Boolean(profile.knownFailureInputs)!==value.inputs.some(row=>row.executionRisk)
      ||Boolean(profile.selectiveInputs)!==value.inputs.some(row=>row.testSelection))throw Error('Invalid Code input report.');
  }catch(cause){throw error('The retained Code input report has an invalid or unsupported contract.',
    ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',null,cause);}
  return value;
}
export function createNamespaceCodeInputReader({observer,scope,workId}){
  const verified=new WeakMap(),candidates=new WeakMap();
  function issue(value){candidates.set(value,hash(canonicalJson(value)));return value;}
  async function json(reference,signal){const data=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch(cause){throw error('Code input evidence is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',null,cause);}}
  async function candidate(publication,snapshot,{signal,policyTraversal,conformance=false}={}){
    const workflow=snapshot.workflow,phase=workflow.phases[publication.phase],policy=(conformance?conformancePublicationPolicy:codeInputPublicationPolicy)(workflow,phase);
    if(!policy)throw error('This consumer needs its declared Code input policy owner.','ENGINE_PORT_UNAVAILABLE',{required:['code-input-publication-policy']});
    return observer.withReadScope(async scoped=>{
      const options={...scoped.evidenceReads,observer:scoped},checks=createNamespacePhaseCheckReader(options),
        packets=createNamespaceSubmissionReader({observer:scoped,scope,workId,checks}),
        declarations=resolvedPhaseInputs(workflow,phase),ids=codePublicationInputPhases(workflow,phase),selected=[];
      for(const id of ids){const optional=id!==policy.testSource&&!declarations.some(row=>(typeof row==='string'?row:row.phase)===id&&(typeof row==='string'||row.required!==false));
        if(workflow.phases[id]?.status!=='approved'){if(optional)continue;throw error('Finish and approve the exact Code producer before consuming its evidence.','PRIOR_CODE_TEST_EVIDENCE_REQUIRED',{
          phase:publication.phase,sourcePhase:id,operation:'phase.review',inputs:{phaseId:id}});}selected.push(id);}
      if(!selected.length)throw error('This phase has no accepted Code input to carry.','ENGINE_PORT_UNAVAILABLE',{required:['accepted-code-input']});
      const proofs=await packets.inspectApprovedMany(snapshot,selected,{signal,policyTraversal}),inputs=[],current=new Map();
      for(const [index,id]of selected.entries()){
        const proof=proofs[index],code=proof&&packets.publicationCodeEvidence(proof.published);
        if(!code)throw error('The approved Code producer needs its actual source and execution proof.','ENGINE_PORT_UNAVAILABLE',{phase:id,required:['retained-code-policy']});
        const tests=[];let executionRisk=null,riskObservations=null,testSelection=null;
        if(id===policy.testSource){
          let found;
          if(proof.published.checks)found=await checks.publication(proof.published,{signal});
          else if(namespaceCodePolicyProfile('codeReport',code.report).knownFailureRisk){
            const risks=createNamespaceTestRiskOwner({observer:scoped,scope,workId}),actual=await risks.forPublication(proof.published,snapshot,{signal});
            if(!actual||actual.policyBinding.kind!=='known-test-risk/v1')throw error('Known-failure Code inputs need their original execution and human permission.');
            const active=await risks.publication({...proof.published,riskChecks:actual.binding},snapshot,{signal,at:publication.publishedAt,bound:actual.report});
            found=actual.found;riskObservations=active.report.observations;executionRisk={profile:'sflow-known-failure-code-input/v1',policy:actual.policyBinding,report:actual.manifest.report,
              checks:actual.binding,decision:actual.report.decision,testsPassed:false,failedAcceptanceWaived:false,references:active.references};
          }else throw error('The selected Code producer has no retained test execution.','PRIOR_CODE_TEST_EVIDENCE_REQUIRED',{phase:publication.phase,sourcePhase:id});
          const minimum=workflow.resolution.codeDelivery?.tests??{};
          for(const [position,step]of found.plan.steps.entries())if(step.command.kind==='test'){
            const check=found.body.checks[position],process=found.body.results[position]?.candidate?.output?.process;
            if(!testReceiptPassing({status:check.status,exitCode:process?.status,timedOut:process?.timedOut,skipped:false,suppressed:false,tests:check.tests},
              minimum.minimumDiscovered??1,minimum.minimumPassed??1)&&!executionRisk)throw error('The approved producer does not retain passing structured tests.','PRIOR_CODE_TEST_EVIDENCE_REQUIRED',{sourcePhase:id,commandId:step.command.id});
            const observation=riskObservations?.find(row=>row.taskId===step.contract.taskId&&row.repositoryId===step.repositoryId&&row.commandId===step.command.id);
            if(executionRisk&&(!observation||!same(observation.tests,check.tests)||check.status!=='passed'&&observation.disposition!=='accepted-known-failures'))throw error('The actual failed Code input has no exact known-failure disposition.');
            tests.push({repositoryId:step.repositoryId,commandId:step.command.id,tests:check.tests,...(executionRisk?{
              status:check.status,disposition:observation?.disposition??'passed',failedCases:observation?.failedCases??[]}: {})});
          }
          if(code.sources.some(source=>!tests.some(row=>row.repositoryId===source.repository.id)))throw error('The approved producer has no actual test execution for every selected repository.','PRIOR_CODE_TEST_EVIDENCE_REQUIRED',{sourcePhase:id});
          if(found.plan.selection){const selection=found.plan.selection;
            const permission=(await packets.publicationReader.policies.executionDispositions(proof.published,snapshot,{signal,at:publication.publishedAt}))
              .find(row=>row.policy.kind==='test-recovery/v2');
            if(!permission||permission.disposition==='uncovered')throw error('Renew the original file-selection permission or restore full execution evidence.','SELECTIVE_TEST_RECOVERY_NOT_CURRENT',{
              phase:publication.phase,sourcePhase:id,actions:permission?.actions??[]});
            testSelection={profile:'sflow-selective-code-input/v1',checks:proof.published.checks,decision:selection.decision,
              executionMode:'reviewed-file-selection',excluded:selection.rows.map(row=>({repositoryId:row.repositoryId,commandId:row.commandId,testIds:row.excludedIds,outcome:'not-run'})),
              permission:{decisions:permission.decisions,references:permission.references},receiverExecuted:false,impactComplete:false,failuresWaived:false};}
        }
        const row={phase:id,generation:proof.value.generation,publication:proof.value.publication,submission:proof.binding,
          approvals:(workflow.phases[id].approvals??[]).filter(vote=>!vote.invalidatedAt&&vote.decision==='approved'&&vote.generation===proof.value.generation).map(vote=>vote.namespaceVote),
          code:code.binding,report:code.manifest.report,plan:code.report.preflight.plan,checks:proof.published.checks??null,tests,
          repositories:code.report.repositories,sources:code.sources.map(source=>({id:source.repository.id,descriptor:source.repository.descriptor,
            content:source.observed.content,revision:source.observed.revision}))};
        if(executionRisk)row.executionRisk=executionRisk;
        if(testSelection)row.testSelection=testSelection;
        if(row.approvals.some(value=>!value))throw error('The Code input lost an original human approval receipt.');
        inputs.push(row);
        for(const source of row.sources){const previous=current.get(source.id),position=workflow.phaseOrder.indexOf(id);
          if(id===policy.testSource||!previous||previous.phase!==policy.testSource&&position>workflow.phaseOrder.indexOf(previous.phase))current.set(source.id,{phase:id,generation:row.generation,...source});}
      }
      const profile=namespaceCodeInputPolicyProfile('codeInputReport',{schemaVersion:inputs.some(row=>row.testSelection)?3:inputs.some(row=>row.executionRisk)?2:1}),
        report=inputReport({schemaVersion:profile.version,format:profile.format,testEvidenceFrom:policy.testSource,
        inputs,currentSources:[...current.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)});
      const value={report,policy,workflow,definition:(await scoped.approved(snapshot,{signal})).compiled.definition};
      return conformance?issue(value):value;
    });
  }
  async function verify(publication,binding,{signal,policyTraversal}={}){
    const manifest=namespaceCodeInputManifest(await json(binding.record,signal),{scope,workId,phaseId:publication.phase}),identity=namespaceSpecificationIdentity(publication);
    if(!same(identity,Object.fromEntries(Object.keys(identity).map(key=>[key,manifest[key]])))||manifest.recordedAt!==publication.publishedAt
      ||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content})||!same(manifest.configuration,manifest.basis.head.configuration))throw error('The Code inputs differ from their original publication identity.');
    const report=inputReport(await json(manifest.report,signal)),state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      actual=await candidate(publication,{revision:manifest.basis.revision,configuration:manifest.configuration,workflow:state.workflow},{signal,policyTraversal});
    if(!same(actual.report,report)||namespaceCodeInputPolicyProfile('codeInputs',manifest).version!==namespaceCodeInputPolicyProfile('codeInputReport',report).version
      ||binding.kind!==namespaceCodeInputPolicyProfile('codeInputs',manifest).kind)throw error('Code inputs do not replay from their exact accepted generation, plan, tests and human approvals.');
    const value={binding,manifest,...actual};verified.set(publication,{identity:canonicalJson(publication),value,sha256:hash(canonicalJson(value))});return value;
  }
  function proof(publication){const found=verified.get(publication);return found?.identity===canonicalJson(publication)&&found.sha256===hash(canonicalJson(found.value))?found.value:null;}
  const originalEvidence=report=>report.inputs.flatMap(row=>[row.publication.record,row.submission.record,...row.approvals.map(vote=>vote.record),row.code.record,row.report,
    ...(row.executionRisk?[row.executionRisk.policy.record,row.executionRisk.report,...row.executionRisk.references]:[]),...(row.testSelection?[row.testSelection.decision,...row.testSelection.permission.references]:[])]);
  function sourceEvidence(value){if(candidates.get(value)!==hash(canonicalJson(value)))throw error('Use the original Code input computation.','ENGINE_INPUT_INVALID');return originalEvidence(value.report);}
  function evidence(value){return [value.binding.record,value.manifest.report,...originalEvidence(value.report)];}
  async function freshSources(publication,units,{signal}={}){
    const value=proof(publication);if(!value)throw error('Verify the exact Code input proof before source admission.','ENGINE_INPUT_INVALID');
    return readFreshSources(value,units,{signal});
  }
  async function freshEvidence(value,units,{signal}={}){
    if(candidates.get(value)!==hash(canonicalJson(value)))throw error('Use the original Code input computation before source admission.','ENGINE_INPUT_INVALID');
    return readFreshSources(value,units,{signal});
  }
  async function readFreshSources(value,units,{signal}={}){
    const selected=new Map(units.map(unit=>[validateSourceUnit(unit).repositoryId,unit])),
      retention=createNamespaceSourceRetentionReader({...observer.evidenceReads,observer}),inventory=snapshot=>sourceBaselineInventory(snapshot,{workflow:value.workflow,definition:value.definition});
    for(const source of value.report.currentSources){const unit=selected.get(source.id);
      if(!unit||!same(unit.descriptor,source.descriptor))throw error('Bind the approved repository source before publishing its consuming phase.','ENGINE_SOURCE_UNIT_UNAVAILABLE',{repositoryId:source.id,sourcePhase:source.phase});
      const observed=await unit.capture({signal}),snapshot=sourceSnapshot(observed.snapshot,unit.descriptor),original=await retention.snapshot(source.content,source.descriptor,source.revision,signal);
      if(observed.revision!=='sha256:'+hash(canonicalJson(snapshot)))throw error('The source port returned another snapshot digest.','ENGINE_PORT_RESULT_INVALID');
      if(!same(inventory(snapshot),inventory(original)))throw error('Application source or test inputs changed after the approved Code execution.','PRIOR_CODE_TEST_EVIDENCE_REQUIRED',{
        phase:value.manifest?.phase??value.workflow.currentPhase,sourcePhase:source.phase,repositoryId:source.id,operation:'phase.review',inputs:{workId,phaseId:source.phase}});
    }
  }
  return Object.freeze({candidate,verify,proof,evidence,sourceEvidence,freshSources,freshEvidence});
}

/** Read accepted local check proof without loading a process executor or discovering a checkout. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,namespacePhaseCheckPlanProfile,admitRecordSchemaVersion,NODE_CHECK_ENVIRONMENT_OBSERVATION_SCHEMA} from '../foundation/record-schema.mjs';
import {localCheckExecutionProfile} from '../foundation/execution-unit-port.mjs';
import {sourceSnapshot,validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {qualityValidationVerdict,observedPhaseCheck,observedCommandCheck} from '../kernel/phase-checks.mjs';
import {namespaceReuseEnvironment} from '../kernel/evidence-reuse.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {normalizeExternalCommand} from '../engine-compatibility/node-configuration-path.mjs';
import {createNodeTestReportCodec,parseNativeNodeJunitReport} from '../verification/test-report-reader.mjs';
import {validateAgentTaskContract,validateExecutionUnitManifest,qualifiedCheckReportRoot,qualifiedCheckReportLocation,sha256 as digest} from '../sgos/node-execution-values.mjs';
import {namespaceScope,exactObject} from '../sda/namespace/values.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespaceTestRecoveryOwner} from './namespace-test-recovery-reader.mjs';
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
import {createNamespaceSelectiveTestRecoveryOwner} from './namespace-selective-test-recovery-reader.mjs';
import {createNamespaceStoryObserver,memoNamespaceObservedEvidence} from './namespace-story-reader.mjs';
import {createNamespaceLifecycleCodec} from './namespace-lifecycle-codec.mjs';
import {createNamespacePhaseCheckCodec,phaseCheckRecord,phaseCheckRecordValue,phaseCheckEvidenceBinding,NAMESPACE_PHASE_CHECK_PROFILE,NAMESPACE_MIXED_CHECK_PROFILE} from './namespace-phase-check-contract.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code='ENGINE_INPUT_INVALID',details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
const sourceValue=snapshot=>({projectId:snapshot.projectId,repositoryId:snapshot.repositoryId,provider:snapshot.provider,
  selection:snapshot.selection,entries:snapshot.entries});

export function createNamespacePhaseCheckReader({records,content,scope,workId,authority,observer:givenObserver,checks:executors,clock}={}) {
  scope=namespaceScope(scope);const observer=givenObserver??createNamespaceStoryObserver({records,content,scope,workId,authority});
  const limits=namespaceLimits(records.descriptor.limits),codec=createNamespacePhaseCheckCodec({scope,workId,authority,limits,textDigests:NODE_TEXT_DIGESTS});
  const lifecycle=createNamespaceLifecycleCodec({scope,workId,authority,limits,textDigests:NODE_TEXT_DIGESTS});
  const inspection=Object.freeze({port:records,method:records.inspectOperation}),inspectOperation=inspection.method.bind(records),parser=createNodeTestReportCodec();
  async function json(reference,kind,signal){if(contentReference(reference).bytes>33_554_432)throw error('The check body exceeds its byte bound.','ENGINE_STORAGE_LIMIT');
    const data=await observer.bytes(reference,reference.bytes,signal);
    try{return phaseCheckRecordValue(kind,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)));}
    catch(cause){if(cause.code==='ENGINE_STORAGE_UNSUPPORTED')throw cause;throw error('The retained phase-check body is invalid.','ENGINE_STORAGE_CORRUPT',null,cause);}}
  async function intent(input,{signal}={}) {
    const keys=codec.keys(input),accepted=await inspectOperation(scope,keys.prepareOperation,{signal});
    const saved=await observer.record('runtime',keys.intent,true,signal,true);
    if(accepted?.status==='missing'&&accepted.receipt===null){if(saved)throw error('An unaccepted check intent cannot authorize execution.','ENGINE_STORAGE_CORRUPT');return null;}
    if(!saved)throw error('The accepted check intent is missing.','ENGINE_STORAGE_CORRUPT');
    const value=codec.verifyMetadata('intent',saved.value,input),plan=await json(value.content,'plan',signal);
    if(!same(plan.input,input)||plan.parametersSha256!==value.parametersSha256||plan.profile!==NAMESPACE_PHASE_CHECK_PROFILE
      ||!same(plan.binding,codec.binding)||!Array.isArray(plan.steps)||plan.steps.length<1||plan.steps.length>1024
      ||!Array.isArray(plan.sources)||plan.sources.length<1||plan.sources.length>32)throw error('The accepted check plan has another binding.','ENGINE_STORAGE_CORRUPT');
    const receipt=codec.receipt(accepted,codec.transaction(plan,value.content,{intent:true}));
    if(receipt.records[0]?.version!==saved.version)throw error('The intent differs from its acceptance receipt.','ENGINE_STORAGE_CORRUPT');
    const basis=await observer.accepted(plan.basis.head.operationId,{signal}),head=lifecycle.head(basis.plan);
    if(!same(head,plan.basis.head)||basis.receipt.records.find(item=>item.key===lifecycle.headKey)?.version!==plan.basis.headVersion
      ||basis.plan.basis.configurationVersion!==plan.basis.configurationVersion||!same(head.configuration,plan.basis.configuration))
      throw error('The check intent has no matching accepted lifecycle basis.','ENGINE_STORAGE_CORRUPT');
    const phase=basis.state.workflow.phases[plan.input.phaseId],snapshot={workflow:basis.state.workflow,configuration:plan.basis.configuration,revision:plan.basis.headVersion},
      selected=namespacePhaseCheckPlanProfile(plan).commands?await createNamespaceTestCommandOwners({observer,scope,workId}).commands(snapshot,plan.input.phaseId,{signal}):null,
      commands=selected?.commands??(phase?.qualityCommands??[]).map(normalizeExternalCommand);
    if(selected&&!same(selected.identity,plan.testCommands)||!selected&&(basis.state.workflow.testCommandDecisions??[]).length)throw error('The check plan has another acknowledged command inventory.','ENGINE_STORAGE_CORRUPT');
    if(namespacePhaseCheckPlanProfile(plan).recovery){
      const current=await createNamespaceTestRecoveryOwner({observer,scope,workId}).current(snapshot,{signal});
      if(!same(plan.recovery,{profile:'sflow-namespace-test-recovery-check/v1',agreementSha256:current.agreement.contextSha256,agreements:current.references}))throw error('The check intent changed its confirmed recovery agreement.','ENGINE_STORAGE_CORRUPT');
    }else if(snapshot.workflow.resolution.testRecovery?.enabled)throw error('The check intent needs its original recovery agreement.','ENGINE_STORAGE_CORRUPT');
    if(namespacePhaseCheckPlanProfile(plan).selective){
      if(!plan.recovery||plan.selection?.record?.context?.generation!==plan.generation)throw error('The selected check lost its agreement or generation.','ENGINE_STORAGE_CORRUPT');
      const selected=await createNamespaceSelectiveTestRecoveryOwner({observer,scope,workId}).current(snapshot,plan.input.phaseId,{signal,bound:plan.selection});
      if(!same(selected,plan.selection))throw error('The check intent changed its original human file-selection receipt.','ENGINE_STORAGE_CORRUPT');
    }
    if(Boolean(namespacePhaseCheckPlanProfile(plan).mixed)!==commands.some(command=>command.kind!=='test'))throw error('The check plan changed its command observation profile.','ENGINE_STORAGE_CORRUPT');
    const repositories=basis.state.workflow.sourceBindings?.current?.repositories??[];
    if(commands.length*repositories.length!==plan.steps.length||plan.sources.length!==repositories.length
      ||plan.sources.some((item,index)=>item.id!==repositories[index].id||!same(item.descriptor,repositories[index].descriptor)))
      throw error('The check intent differs from its approved command or repository set.','ENGINE_STORAGE_CORRUPT');
    for(const [index,step] of plan.steps.entries()){
      exactObject(step,['phaseId','command','repositoryId','manifest','contract']);validateExecutionUnitManifest(step.manifest);validateAgentTaskContract(step.contract,step.manifest);
      if(step.contract.programSha256!=='sha256:'+plan.parametersSha256||step.contract.policySnapshotSha256!=='sha256:'+plan.basis.configuration.content.sha256
        ||!same(step.contract.inputs,['sha256:'+plan.draft.bodySha256])||!same(step.command,commands[Math.floor(index/repositories.length)])
      ||step.repositoryId!==repositories[index%repositories.length].id||step.phaseId!==plan.input.phaseId)
        throw error('The check intent changed the pinned command sequence or task binding.','ENGINE_STORAGE_CORRUPT');}
    for(const step of plan.steps){const selected=plan.selection?.rows.find(row=>row.commandId===step.command.id&&row.repositoryId===step.repositoryId),
        execution=localCheckExecutionProfile(step.manifest.toolPolicy),policy=step.manifest.toolPolicy;
      if(Boolean(execution.selective)!==Boolean(selected)||policy.command.argumentsSha256!==digest((selected?.argv??step.command.argv).slice(1))
        ||selected&&!same(policy.selection,{profile:'sflow-node-check-file-selection/v1',sha256:plan.selection.record.contextSha256,
          originalArgumentsSha256:digest(step.command.argv.slice(1)),files:selected.files}))throw error('The retained executor changed the exact reviewed file selection.','ENGINE_STORAGE_CORRUPT');}
    return {plan,reference:value.content};
  }
  async function snapshot(reference,descriptor,signal){const data=await observer.bytes(reference,reference.bytes,signal);let value;
    try{value=sourceSnapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)),descriptor);}
    catch(cause){throw error('A check source observation is invalid.','ENGINE_STORAGE_CORRUPT',null,cause);}return value;}
  async function observations(plan,results,signal) {
    if(!Array.isArray(results)||results.length!==plan.steps.length)throw error('The check set is incomplete.','ENGINE_STORAGE_CORRUPT');
    const checks=[];
    for(const [index,step] of plan.steps.entries()) {
      const result=results[index];
      if(result.commandId!==step.command.id||result.repositoryId!==step.repositoryId||!result.handle
        ||result.handle.contractSha256!==step.contract.contractSha256||result.handle.executionUnitManifestSha256!==step.manifest.manifestSha256
        ||result.quiescence?.handleSha256!==result.handle.handleSha256||result.quiescence.quiescent!==true)throw error('A retained check has another task or quiescence binding.','ENGINE_STORAGE_CORRUPT');
      if(result.failure){if(result.candidate!==null)throw error('A failed check cannot also contain a candidate.','ENGINE_STORAGE_CORRUPT');
        checks.push({id:step.command.id,repositoryId:step.repositoryId,requirement:step.command.requirement,status:'unavailable',tests:null,diagnostics:[result.failure]});continue;}
      const candidate=result.candidate,out=candidate?.output,execution=localCheckExecutionProfile(step.manifest.toolPolicy);
      if(execution.testReport!==(step.command.kind==='test')||!execution.testReport&&execution.commandKind!==step.command.kind)throw error('The check result changed its pinned command kind.','ENGINE_STORAGE_CORRUPT');
      if(candidate.kind!=='candidate-result'||candidate.contractSha256!==step.contract.contractSha256
        ||candidate.executionUnitManifestSha256!==step.manifest.manifestSha256||candidate.outputSha256!==digest(out)
        ||candidate.eventHeadSha256!==result.quiescence.eventHeadSha256||out?.format!==execution.format
        ||out.contractSha256!==step.contract.contractSha256||out.manifestSha256!==step.manifest.manifestSha256
        ||!same(out.command,step.manifest.toolPolicy.command)||out.reports?.adapter!==(step.command.result?.adapter??null)
        ||!Array.isArray(out.diagnostics))throw error('A retained candidate differs from its pinned check task.','ENGINE_STORAGE_CORRUPT');
      await observer.bytes(out.stdout,out.stdout.bytes,signal);await observer.bytes(out.stderr,out.stderr.bytes,signal);
      if(!execution.testReport&&(out.reports.parsed!==null||out.reports.raw?.length!==1||out.reports.raw[0].path!==null||!same(out.reports.raw[0].content,out.stdout)))throw error('A command observation cannot claim parsed test evidence.','ENGINE_STORAGE_CORRUPT');
      let parsed=null;const raw=[];
      for(const report of out.reports.raw)raw.push({contents:await observer.bytes(report.content,report.content.bytes,signal)});
      if(out.reports.parsed!==null){await parser.prepareTestReportReader(out.reports.adapter);parsed=parser.replayTestReports(out.reports.adapter,raw);
        const expected=step.manifest.toolPolicy.report.files.length?step.manifest.toolPolicy.report.files:[null];
        if(!same(out.reports.raw.map(item=>item.path),expected)||expected[0]===null&&!same(out.reports.raw[0].content,out.stdout))
          throw error('The result used another report destination or stdout.','ENGINE_STORAGE_CORRUPT');
        if(!same(parsed,out.reports.parsed))throw error('The retained test counts differ from their raw report bytes.','ENGINE_STORAGE_CORRUPT');}
      const descriptor=step.manifest.toolPolicy.repository,before=await snapshot(out.source.before.content,descriptor,signal);
      const after=out.source.after?await snapshot(out.source.after.content,descriptor,signal):null;
      if(out.source.before.revision!=='sha256:'+hash(canonicalJson(before))||after&&out.source.after.revision!=='sha256:'+hash(canonicalJson(after)))
        throw error('The check source digest differs from its retained bytes.','ENGINE_STORAGE_CORRUPT');
      const expected=plan.sources.find(item=>item.id===step.repositoryId),original=await snapshot(expected.content,expected.descriptor,signal);
      const sourceMatched=Boolean(after)&&same(sourceValue(before),sourceValue(after))&&same(sourceValue(before),sourceValue(original));
      const selected=plan.selection?.rows.find(row=>row.commandId===step.command.id&&row.repositoryId===step.repositoryId);
      if(selected&&parsed){
        const native=parseNativeNodeJunitReport(raw[0].contents),qualification=step.manifest.toolPolicy.environmentQualification,
          seen=new Set();
        if(!qualifiedCheckReportRoot(qualification.reportRoot)||native.cases.length!==selected.selectedIds.length||native.tests.skipped!==0)
          throw error('The selected execution omitted, skipped or added independently expected cases.','SELECTIVE_TEST_REPORT_INVALID');
        for(const row of native.cases){const file=row.file===null&&selected.files.length===1?selected.files[0]
            :qualifiedCheckReportLocation(row.file,qualification.reportRoot),
            test=selected.declaration.tests.find(test=>test.path===file&&test.name===row.name);
          if(!test||!selected.selectedIds.includes(test.id)||seen.has(test.id)||!['passed','failed'].includes(row.outcome))
            throw error('The selected report has another file, case identity or outcome.','SELECTIVE_TEST_REPORT_INVALID');seen.add(test.id);}
      }
      const effective=selected?{...step.command,result:{...step.command.result,...selected.effectiveMinimums}}:step.command;
      checks.push({...((execution.testReport?observedPhaseCheck:observedCommandCheck)(effective,{process:out.process,tests:parsed?.tests??null,diagnostics:out.diagnostics,sourceMatched})),repositoryId:step.repositoryId});
    }
    return checks;
  }
  async function acceptedObservation(input,{signal}={}) {
    const k=codec.keys(input),operation=await inspectOperation(scope,k.operation,{signal});
    const saved=await observer.record('evidence',k.manifest,true,signal,true);
    if(operation?.status==='missing'&&operation.receipt===null){if(saved)throw error('An unaccepted check result is not execution evidence.','ENGINE_STORAGE_CORRUPT');return null;}
    if(!saved)throw error('The accepted check result is missing.','ENGINE_STORAGE_CORRUPT');
    const metadata=codec.verifyMetadata('manifest',saved.value,input),original=await intent(input,{signal});
    if(!original||metadata.parametersSha256!==original.plan.parametersSha256)throw error('The check result lost its original accepted plan.','ENGINE_STORAGE_CORRUPT');
    const body=await json(metadata.content,'result',signal);
    if(!same(body.plan,original.reference)||body.profile!==NAMESPACE_PHASE_CHECK_PROFILE)throw error('The result names another accepted plan.','ENGINE_STORAGE_CORRUPT');
    projectEnrollmentTimestamp(body.recordedAt);
    const checks=await observations(original.plan,body.results,signal),verdict=qualityValidationVerdict(checks,{required:true}).verdict;
    if(!same(checks,body.checks)||body.verdict!==verdict)throw error('The retained check summary differs from its executed observations.','ENGINE_STORAGE_CORRUPT');
    const tx=codec.transaction(original.plan,metadata.content,{previousIndexVersion:metadata.previousIndexVersion}),receipt=codec.receipt(operation,tx);
    if(receipt.records.find(item=>item.key===k.manifest)?.version!==saved.version)throw error('The check result has another accepted record revision.','ENGINE_STORAGE_CORRUPT');
    return {plan:original.plan,body,receipt,record:{key:k.manifest,version:saved.version,content:metadata.content}};
  }
  async function accepted(input,options={}){codec.keys(input);const selected=structuredClone(input);
    return memoNamespaceObservedEvidence(observer,inspection,{profile:'sflow-namespace-phase-check-proof/v1',binding:codec.binding,limits,input:selected},
      ()=>acceptedObservation(selected,options),options);}
  async function proof(binding,phaseId,{signal}={}) {
    phaseCheckEvidenceBinding(binding);
    const found=await accepted({operationId:binding.operationId,workId,phaseId},{signal});
    if(!found||!same(found.record,binding.result)||codec.indexKey(found.plan)!==binding.index.key
      ||found.receipt.records.find(item=>item.namespace==='evidence'&&item.key===binding.index.key)?.version!==binding.index.version)
      throw error('The check binding has no matching accepted result and index revision.','ENGINE_STORAGE_CORRUPT');
    return found;
  }
  function assertPassing(found,phaseId) {
    if(found.body.verdict!=='passed')throw error('The current draft has no complete passing check set. Repair and run its configured checks.',
      'PHASE_CHECKS_NOT_PASSED',{operation:'phase.checks.run',workId,phase:phaseId,verdict:found.body.verdict,checks:found.body.checks,
        ...(namespacePhaseCheckPlanProfile(found.plan).recovery?{profile:'sflow-namespace-test-recovery-handoff/v1',
          actions:[{operation:'phase.repair.run',inputs:{workId,phaseId,failedOperationId:found.plan.input.operationId},requiredInputs:['operationId'],
            prerequisites:['bound-test-repair-executor','approved-automatic-attempt-remains']},
          {operation:'test-command.context',inputs:{workId,phaseId}}]}:{})});
  }
  async function inspectDraft({phaseId,generation,baseRevision,draft,artifact,configuration},{signal}={}) {
    const key=codec.indexKey({input:{phaseId},generation,basis:{headVersion:baseRevision},draft});
    const index=await observer.record('evidence',key,false,signal,true);
    if(!index)return null;
    codec.index(index.value);
    const metadata=await observer.record('evidence',index.value.manifestKey,true,signal);
    phaseCheckRecordValue('manifest',metadata.value);
    const binding=phaseCheckRecord('binding',{operationId:metadata.value.operationId,
      result:{key:index.value.manifestKey,version:metadata.version,content:metadata.value.content},index:{key,version:index.version}});
    const found=await proof(binding,phaseId,{signal});
    if(found.plan.generation!==generation||found.plan.basis.headVersion!==baseRevision||!same(found.plan.draft,draft)
      ||!same(found.plan.basis.configuration,configuration)||found.plan.artifact.sha256!==artifact.sha256||found.plan.artifact.bytes!==artifact.bytes)
      throw error('The accepted check set belongs to another authored draft.','ENGINE_STORAGE_CORRUPT');
    return {binding,found};
  }
  async function forDraft(input,{signal}={}) {
    const selected=await inspectDraft(input,{signal});
    if(!selected)throw error('Run the configured phase checks for this exact authored draft before publication.','ENGINE_CHECK_EVIDENCE_REQUIRED',{
      operation:'phase.checks.run',workId,phase:input.phaseId,generation:input.generation});
    assertPassing(selected.found,input.phaseId);return selected.binding;
  }
  async function publicationObservation(value,{signal}={}) {
    const found=await proof(value.checks,value.phase,{signal}),plan=found.plan;
    if(plan.generation!==value.generation||plan.basis.headVersion!==value.baseRevision||!same(plan.basis.configuration,value.configuration)
      ||!same(plan.draft,{workId,phase:value.phase,revision:value.draft.revision,bodySha256:value.draft.sha256})
      ||plan.artifact.sha256!==value.artifact.content.sha256||plan.artifact.bytes!==value.artifact.content.bytes)
      throw error('The publication differs from its accepted check evidence.','ENGINE_STORAGE_CORRUPT');
    return found;
  }
  async function publication(value,options={}){
    const found=await publicationObservation(value,options);assertPassing(found,value.phase);return found;
  }
  const readBindings=binding=>{phaseCheckEvidenceBinding(binding);return [
    {namespace:'evidence',key:binding.result.key,version:binding.result.version},
    {namespace:'evidence',key:binding.index.key,version:binding.index.version}];};
  async function currentObservation(binding,phaseId,{signal}={}) {
    const found=await proof(binding,phaseId,{signal}),current=await observer.record('evidence',binding.index.key,false,signal);
    codec.index(current.value);
    if(current.version!==binding.index.version||current.value.manifestKey!==binding.result.key)
      throw error('The draft check result changed. Reinspect the current result before publication.','ENGINE_CONTEXT_CHANGED',{
        operation:'phase.checks.run',workId,phase:phaseId});
    return found;
  }
  async function assertCurrent(binding,phaseId,options={}){
    const found=await currentObservation(binding,phaseId,options);assertPassing(found,phaseId);return found;
  }
  async function compareSources(found,phaseId,sources,{signal}={}) {
    const units=new Map(sources.map(unit=>[validateSourceUnit(unit).repositoryId,unit]));
    for(const selected of found.plan.sources){const unit=units.get(selected.id),descriptor=unit&&validateSourceUnit(unit);
      if(!descriptor||descriptor.projectId!==scope.projectId||!same(descriptor.selection,selected.descriptor.selection))
        throw error('Bind the actual source observation port before publishing checked evidence.','ENGINE_SOURCE_UNIT_UNAVAILABLE',{repositoryId:selected.id});
      const observed=await unit.capture({signal}),value=sourceSnapshot(observed.snapshot,descriptor);
      if(observed.revision!=='sha256:'+hash(canonicalJson(value)))throw error('The source port returned another byte revision.','ENGINE_PORT_RESULT_INVALID');
      const original=await snapshot(selected.content,selected.descriptor,signal);
      if(!same(sourceValue(original),sourceValue(value)))throw error('Source bytes changed after the accepted test run. Run the checks for the current source.',
        'ENGINE_SOURCE_CHANGED',{operation:'phase.checks.run',workId,phase:phaseId,repositoryId:selected.id});
    }
    if(found.plan.selection){
      if(typeof clock?.now!=='function')throw error('Fresh selected execution needs its explicit lifecycle clock.','ENGINE_PORT_UNAVAILABLE',{required:['clock']});
      const selected=await createNamespaceSelectiveTestRecoveryOwner({observer,scope,workId,sources,checks:executors}).current(
        (await observer.capture({signal})).snapshot,phaseId,{signal,at:projectEnrollmentTimestamp(await clock.now())});
      if(!selected||selected.record.contextSha256!==found.plan.selection.record.contextSha256)throw error('The reviewed selection expired, was revoked or changed before the lifecycle action.','SELECTIVE_TEST_RECOVERY_NOT_CURRENT');
    }
    return found;
  }
  async function freshObservedSources(binding,phaseId,sources,options={}){
    return compareSources(await currentObservation(binding,phaseId,options),phaseId,sources,options);
  }
  async function freshSources(binding,phaseId,sources,options={}){
    return compareSources(await assertCurrent(binding,phaseId,options),phaseId,sources,options);
  }
  const environmentBindings=new Map();
  for(const binding of executors?.bindings??[]){const method=Object.getOwnPropertyDescriptor(binding.unit,'observeEnvironment');
    if(method&&Object.hasOwn(method,'value')&&typeof method.value==='function')environmentBindings.set(
      JSON.stringify([binding.phaseId,binding.commandId,binding.repositoryId]),method.value.bind(binding.unit));}
  async function environment(phaseId,command,repository,{signal}={}){
    const read=environmentBindings.get(JSON.stringify([phaseId,command.id,repository.id]));
    if(!read)throw error('Bind a qualified check environment reader, or execute the current checks.','ENGINE_EVIDENCE_REUSE_ENVIRONMENT_REQUIRED',{
      actions:[{operation:'phase.checks.run',inputs:{workId,phaseId},requiredInputs:['operationId']}],repositoryId:repository.id,commandId:command.id});
    const value=await read({signal}),descriptor=value?.repository,observed=sourceSnapshot(value?.source?.snapshot,descriptor);
    try{admitRecordSchemaVersion(NODE_CHECK_ENVIRONMENT_OBSERVATION_SCHEMA,value);}catch(cause){throw error(
      'The environment reader returned an invalid or unsupported observation.','ENGINE_PORT_RESULT_INVALID',null,cause);}
    if(value.profile!=='sflow-node-check-environment-observation/v1'||descriptor.projectId!==scope.projectId
      ||descriptor.repositoryId!==repository.id||!same(descriptor.selection,repository.descriptor.selection)
      ||value.source.revision!=='sha256:'+hash(canonicalJson(observed))||value.command.argumentsSha256!==digest(command.argv.slice(1)))
      throw error('The environment reader returned another command, repository or source observation.','ENGINE_PORT_RESULT_INVALID');
    return {identity:namespaceReuseEnvironment(value.qualification,value.command),source:observed};
  }
  return Object.freeze({codec,observer,intent,accepted,observations,snapshot,proof,forDraft,inspectDraft,publication,publicationObservation,readBindings,assertCurrent,currentObservation,freshSources,freshObservedSources,
    environment,codeRecoveryReuse:executors?.codeRecoveryReuse===true,environmentSensitiveReuse:executors?.environmentSensitiveReuse===true});
}

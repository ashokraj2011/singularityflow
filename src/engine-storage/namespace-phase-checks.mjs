/** Registry-bound checks over explicit execution, source and storage ports. No command discovery. */
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {captureExecutionUnit} from '../foundation/execution-unit-port.mjs';
import {sourceSnapshot,validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {qualityValidationVerdict,qualityReportUsesStdout,observedPhaseCheck} from '../kernel/phase-checks.mjs';
import {phaseAccessIdentity} from '../kernel/phase-preparation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {normalizeExternalCommand} from '../engine-compatibility/node-configuration-path.mjs';
import {createNodeTestReportCodec} from '../verification/test-report-reader.mjs';
import {createAgentTaskContract,validateAgentTaskContract,validateExecutionUnitManifest,executionUnitSha256 as digest} from '../sgos/node-execution-unit.mjs';
import {NODE_CHECK_EXECUTION_PROFILE} from '../sgos/node-check-execution-unit.mjs';
import {createDurableExecutionUnit} from '../sgos/durable-execution-unit.mjs';
import {createNamespaceSgosOperationalStore} from '../sgos/namespace-operational-store.mjs';
import {namespaceScope,namespaceIdentifier,namespaceJson,exactObject} from '../sda/namespace/values.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespacePreparationRuntime} from './namespace-preparation.mjs';
import {createNamespaceReadPorts} from './namespace-reader.mjs';
import {createNamespaceLifecycleCodec} from './namespace-lifecycle-codec.mjs';
import {createNamespacePhaseCheckCodec,phaseCheckRecord,phaseCheckRecordValue,NAMESPACE_PHASE_CHECK_PROFILE} from './namespace-phase-check-contract.mjs';
export {NAMESPACE_PHASE_CHECK_PROFILE};
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code='ENGINE_INPUT_INVALID',details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
const facts=cause=>({name:cause.name??'Error',code:cause.code??null,message:cause.message??String(cause),details:cause.details??null});
function cancelled(signal){if(signal?.aborted)throw error('Phase checks were cancelled; retained attempts are preserved.','ENGINE_OPERATION_CANCELLED');}
const sourceValue=snapshot=>({projectId:snapshot.projectId,repositoryId:snapshot.repositoryId,provider:snapshot.provider,
  selection:snapshot.selection,entries:snapshot.entries});

export function createNamespacePhaseCheckReader({records,content,scope,workId,authority}={}) {
  scope=namespaceScope(scope);const observer=createNamespaceStoryObserver({records,content,scope,workId,authority});
  const codec=createNamespacePhaseCheckCodec({scope,workId,authority,limits:namespaceLimits(records.descriptor.limits),textDigests:NODE_TEXT_DIGESTS});
  const lifecycle=createNamespaceLifecycleCodec({scope,workId,authority,limits:namespaceLimits(records.descriptor.limits),textDigests:NODE_TEXT_DIGESTS});
  const inspectOperation=records.inspectOperation.bind(records),parser=createNodeTestReportCodec();
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
    const phase=basis.state.workflow.phases[plan.input.phaseId],commands=(phase?.qualityCommands??[]).map(normalizeExternalCommand);
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
      const candidate=result.candidate,out=candidate?.output;
      if(candidate.kind!=='candidate-result'||candidate.contractSha256!==step.contract.contractSha256
        ||candidate.executionUnitManifestSha256!==step.manifest.manifestSha256||candidate.outputSha256!==digest(out)
        ||candidate.eventHeadSha256!==result.quiescence.eventHeadSha256||out?.format!==NODE_CHECK_EXECUTION_PROFILE
        ||out.contractSha256!==step.contract.contractSha256||out.manifestSha256!==step.manifest.manifestSha256
        ||!same(out.command,step.manifest.toolPolicy.command)||out.reports?.adapter!==step.command.result.adapter
        ||!Array.isArray(out.diagnostics))throw error('A retained candidate differs from its pinned check task.','ENGINE_STORAGE_CORRUPT');
      await observer.bytes(out.stdout,out.stdout.bytes,signal);await observer.bytes(out.stderr,out.stderr.bytes,signal);
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
      checks.push({...observedPhaseCheck(step.command,{process:out.process,tests:parsed?.tests??null,diagnostics:out.diagnostics,sourceMatched}),repositoryId:step.repositoryId});
    }
    return checks;
  }
  async function accepted(input,{signal}={}) {
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
  return Object.freeze({codec,observer,intent,accepted,observations,snapshot});
}

export function createNamespacePhaseChecksPort(options={},runtime=null) {
  const {records,content,access,clock,checks={},sources=[]}=options,scope=namespaceScope(options.scope),workId=namespaceIdentifier(options.workId,'Story ID');
  const reader=createNamespacePhaseCheckReader({...options,scope,workId}),{observer,codec}=reader;
  if(typeof access?.current!=='function'||typeof clock?.now!=='function'||!Array.isArray(checks.bindings??[])||(checks.bindings??[]).length>1024)
    throw error('Phase checks need explicit access, clock and execution bindings.');
  const current=access.current.bind(access),now=clock.now.bind(clock),put=content.put.bind(content),transact=records.transact.bind(records);
  const units=new Map(),sourceUnits=new Map(),contexts=new WeakMap(),prepared=new WeakMap(),completed=new WeakMap(),executionSignals=new Map();
  for(const source of sources){const descriptor=validateSourceUnit(source);sourceUnits.set(descriptor.repositoryId,{descriptor,capture:source.capture.bind(source)});}
  const history=createNamespaceSgosOperationalStore({records,content,scope,storeId:'phase-checks-'+hash(canonicalJson(codec.binding)).slice(0,48)});
  for(const binding of checks.bindings??[]){const identity=JSON.stringify([binding.phaseId,binding.commandId,binding.repositoryId]);
    if(units.has(identity))throw error('Phase/check/repository bindings must be distinct.');
    const unit=captureExecutionUnit(binding.unit);
    units.set(identity,{...binding,environment:namespaceJson(binding.environment??{}),unit,
      runtime:createDurableExecutionUnit({unit:{...unit,start:contract=>unit.start(contract,{signal:executionSignals.get(contract.contractSha256)??null})},
        store:history,content,scope,owner:checks.owner,clock})});}
  const select=context=>{const found=contexts.get(context);if(!found)throw error('Use the issued phase-check context.');return found;};
  const parameters=input=>hash(canonicalJson({input,binding:codec.binding,recordsId:records.descriptor.id,contentId:content.descriptor.id}));
  async function authorize(expected,signal,identityOnly=false){cancelled(signal);const identity=phaseAccessIdentity(namespaceJson(await current({projectId:scope.projectId,workId,operation:'phase.checks.run',signal})),scope.projectId);
    if(expected&&!(identityOnly?same(identity.actor,expected.actor):same(identity,expected)))throw error('Resume the check operation under its original authenticated actor.','ENGINE_ACTOR_CHANGED');return identity;}
  async function shared(data,namespace,signal){cancelled(signal);const expected={namespace,sha256:hash(data),bytes:data.byteLength};
    const saved=await put(scope,namespace,data,{signal});if(!same(contentReference(saved?.reference),expected)||typeof saved.reused!=='boolean')throw error('The content port acknowledged other check bytes.','ENGINE_PORT_RESULT_INVALID');
    await observer.bytes(expected,expected.bytes,signal);return expected;}
  function checked(plan,s){if(plan&&(plan.parametersSha256!==s.parameters||!same(plan.input,s.input)))throw error('This operation ID belongs to another check request.','ENGINE_OPERATION_ID_REUSED');return plan;}
  function binding(step){const found=units.get(JSON.stringify([step.phaseId,step.command.id,step.repositoryId]));
    if(!found)throw error('Bind an explicit executor for every selected command and repository.','ENGINE_PORT_UNAVAILABLE',{operation:'phase.checks.run',commandId:step.command.id,repositoryId:step.repositoryId});return found;}
  async function captureSources(repositories,signal){const captured=[];
    for(const repo of repositories){const source=sourceUnits.get(repo.id);if(!source||!same(source.descriptor,repo.descriptor))throw error('Bind the selected repository source observation port.','ENGINE_SOURCE_UNIT_UNAVAILABLE',{repositoryId:repo.id});
      const found=await source.capture({signal});sourceSnapshot(found.snapshot,source.descriptor);const data=Buffer.from(canonicalJson(found.snapshot));
      if(found.revision!=='sha256:'+hash(data))throw error('The source port returned another revision.','ENGINE_PORT_RESULT_INVALID');
      captured.push({id:repo.id,descriptor:source.descriptor,revision:found.revision,content:await shared(data,'runtime',signal)});}
    return captured;}
  async function fresh(s,signal){await runtime.revalidateDraft(s.admission,{signal});await authorize(s.plan.actor,signal);
    const captured=await captureSources(s.plan.sources.map(item=>({id:item.id,descriptor:item.descriptor})),signal);
    if(captured.some((item,index)=>item.revision!==s.plan.sources[index].revision))throw error('Source bytes changed after the check plan. Retained attempts are preserved.','ENGINE_SOURCE_CHANGED',{
      operation:'phase.checks.run',newOperationRequired:true});}
  async function acknowledged(s,signal){const accepted=await reader.accepted(s.input,{signal});if(!accepted)return null;
    checked(accepted.plan,s);await authorize(accepted.plan.actor,signal,true);return {...accepted,replayed:true};}
  return {
    async load(input,{signal}={}){if(input.workId!==workId)throw error('Phase checks are bound to another Story.','ACTIVE_SUBJECT_MISMATCH');cancelled(signal);
      const context=Object.freeze({subject:{kind:'story',id:workId},phase:input.phaseId});contexts.set(context,{input,parameters:parameters(input)});return context;},
    async retained(context,_input,{signal}={}){return acknowledged(select(context),signal);},
    async prepare(context,_input,{signal}={}) {
      const s=select(context);if(!runtime)throw error('A new check run requires its machine-local authored draft.','ENGINE_PORT_UNAVAILABLE',{required:['machine-local-working-store']});
      const draft=await runtime.captureDraft(s.input.phaseId,{signal});s.admission=await runtime.admitDraft(draft,'phase.checks.run',{signal});
      const facts=runtime.draftFacts(s.admission),captured=await observer.capture({signal}),phase=captured.snapshot.workflow.phases[s.input.phaseId];
      if(captured.snapshot.revision!==facts.revision)throw error('The Story changed before check preparation.','ENGINE_CONTEXT_CHANGED');
      const existing=await reader.intent(s.input,{signal});
      if(existing){s.plan=checked(existing.plan,s);s.planReference=existing.reference;
        if(!same(s.plan.draft,runtime.draftIdentity(draft))||s.plan.basis.headVersion!==facts.revision)throw error('The authored draft changed; preserve this intent and select a new check operation.','ENGINE_CONTEXT_CHANGED');
        await fresh(s,signal);
      }else{
        const commands=(phase.qualityCommands??[]).map(normalizeExternalCommand),repositories=captured.snapshot.workflow.sourceBindings?.current?.repositories;
        if(!commands.length)throw error('The pinned phase has no configured checks.','ENGINE_CHECKS_NOT_CONFIGURED');
        const required=[];for(const command of commands){
          if(!command.argv||command.command)required.push('structured-argv');if(command.kind!=='test'||!command.result)required.push('structured-test-result');
          if(command.modelPolicy!=='never')required.push('external-model-policy');if(command.environment)required.push('environment-binding');
          if(command.workingDirectory&&command.workingDirectory!=='.')required.push('working-directory');}
        if(required.length)throw error('These checks require additional execution policy owners.','ENGINE_PORT_UNAVAILABLE',{operation:'phase.checks.run',required:[...new Set(required)]});
        if(!Array.isArray(repositories)||!repositories.length)throw error('Bind actual source repositories before executing phase checks.','ENGINE_SOURCE_UNIT_UNAVAILABLE');
        const sourceProof=await observer.accepted(captured.snapshot.workflow.sourceBindings.current.operationId,{signal});
        if(!same(sourceProof.state.workflow.sourceBindings?.current,captured.snapshot.workflow.sourceBindings.current))throw error('The source selection differs from its accepted binding.','ENGINE_STORAGE_CORRUPT');
        const steps=[],seen=new Set();for(const command of commands){if(seen.has(command.id))throw error('Configured check IDs must be unique.','ENGINE_INPUT_INVALID');seen.add(command.id);
          for(const repo of repositories){const selection={phaseId:s.input.phaseId,command,repositoryId:repo.id},bound=binding(selection);
            const manifest=validateExecutionUnitManifest(bound.unit.descriptor()),policy=manifest.toolPolicy;
            if(policy.profile!==NODE_CHECK_EXECUTION_PROFILE||manifest.provider!=='authorized-local-check'||policy.repository.projectId!==scope.projectId
              ||policy.repository.repositoryId!==repo.id||!same(policy.repository.selection,repo.descriptor.selection)
              ||bound.executable!==command.argv[0]||bound.executableSha256!==policy.command.executableSha256
              ||policy.command.argumentsSha256!==digest(command.argv.slice(1))||policy.command.environmentSha256!==digest(bound.environment)
              ||Object.entries(command.env??{}).some(([key,value])=>bound.environment[key]!==value)
              ||policy.report.adapter!==command.result.adapter||!same(policy.report.files,qualityReportUsesStdout(command,path.basename)?[]:[command.result.path]))
              throw error('The selected executor differs from the pinned command, report or source selection.','ENGINE_CHECK_BINDING_CHANGED',{commandId:command.id,repositoryId:repo.id});
            if(command.timeoutMs!==null&&policy.timeoutMs!==command.timeoutMs)throw error('The executor changed the pinned command deadline.','ENGINE_CHECK_BINDING_CHANGED',{commandId:command.id});
            const contract=createAgentTaskContract({taskId:'check-'+hash(canonicalJson({input:s.input,repositoryId:repo.id,commandId:command.id})),
              processId:'phase-'+hash(canonicalJson(codec.binding)),instructionId:command.id,objective:'Execute the exact approved phase check.',
              acceptanceClauses:[],policySnapshotSha256:'sha256:'+captured.snapshot.configuration.content.sha256,programSha256:'sha256:'+s.parameters,
              inputs:['sha256:'+facts.bodySha256],readScope:['repository:'+repo.id],writeScope:['repository:'+repo.id],forbiddenScope:['.git'],allowedDevices:[],
              environmentManifestSha256:policy.command.environmentSha256,candidatePolicy:'immutable-snapshot',outputSchema:{type:'object'},requiredEvidence:['test-report'],
              budgets:{activeMinutes:Math.max(1,Math.ceil((command.timeoutMs??policy.timeoutMs)/60_000)),modelInvocations:0,touchedResources:100_000},stopConditions:[],
              executionUnitManifestSha256:manifest.manifestSha256});steps.push({...selection,manifest,contract});}}
        if(steps.length>1024)throw error('The check set exceeds its bounded execution profile.','ENGINE_STORAGE_LIMIT');
        const actor={actor:facts.actor,agentId:facts.agentId};
        s.plan=phaseCheckRecord('plan',{profile:NAMESPACE_PHASE_CHECK_PROFILE,binding:codec.binding,input:s.input,parametersSha256:s.parameters,
          generation:facts.payload.generation,draft:runtime.draftIdentity(draft),artifact:facts.payload.artifact.current,actor,
          basis:{authorityVersion:captured.basis.authorityVersion,headVersion:captured.basis.headVersion,configurationVersion:captured.basis.configurationVersion,
            configuration:captured.snapshot.configuration,head:captured.basis.head},
          sources:await captureSources(repositories,signal),steps});
        s.planReference=await shared(Buffer.from(canonicalJson(s.plan)),'runtime',signal);await fresh(s,signal);
        const tx=codec.transaction(s.plan,s.planReference,{intent:true});
        try{codec.receipt(await transact(scope,tx,{signal}),tx);}
        catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
          const concurrent=await reader.intent(s.input,{signal});if(!concurrent||!same(concurrent.plan,s.plan))throw cause;}
      }
      const token=Object.freeze({});prepared.set(token,context);return token;
    },
    async execute(context,token,{signal}={}) {
      if(prepared.get(token)!==context)throw error('Use the issued phase-check preparation.');const s=select(context),results=[];
      for(const step of s.plan.steps){cancelled(signal);await runtime.revalidateDraft(s.admission,{signal});const bound=binding(step);
        if(!same(validateExecutionUnitManifest(bound.unit.descriptor()),step.manifest))throw error('The executor changed after preparation.','ENGINE_CHECK_BINDING_CHANGED');
        executionSignals.set(step.contract.contractSha256,signal??null);
        let handle;try{handle=await bound.runtime.start(step.contract);}catch(cause){executionSignals.delete(step.contract.contractSha256);cancelled(signal);throw cause;}
        let stopping=null;
        const stop=()=>{stopping??=(async()=>{try{return await bound.runtime.requestStop(handle,{reason:'The bound phase-check operation was cancelled.'});}
          catch(cause){if(!['SGOS_EXECUTION_ALREADY_SETTLED','SGOS_EXECUTION_LEASE_LOST'].includes(cause.code))throw cause;
            const quiet=await bound.runtime.quiesce(handle);if(quiet.quiescent!==true)throw cause;return quiet;}})();stopping.catch(()=>{});};
        signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
        let candidate=null,failure=null,quiescence;
        try{try{candidate=await bound.runtime.collect(handle);}catch(cause){failure=facts(cause);}
          quiescence=await bound.runtime.quiesce(handle);if(stopping)await stopping;cancelled(signal);
        }finally{signal?.removeEventListener('abort',stop);executionSignals.delete(step.contract.contractSha256);
          if(signal?.aborted){if(!stopping)stop();await stopping;await bound.runtime.quiesce(handle);}}
        results.push({commandId:step.command.id,repositoryId:step.repositoryId,handle,quiescence,candidate,failure});}
      const observed=await reader.observations(s.plan,results,signal),recordedAt=projectEnrollmentTimestamp(await now());
      const body=phaseCheckRecord('result',{profile:NAMESPACE_PHASE_CHECK_PROFILE,plan:s.planReference,recordedAt,results,checks:observed,
        verdict:qualityValidationVerdict(observed,{required:true}).verdict});
      const reference=await shared(Buffer.from(canonicalJson(body)),'evidence',signal),issued=Object.freeze({});completed.set(issued,{context,reference});return issued;
    },
    async commit(context,token,{signal}={}) {
      const saved=completed.get(token);if(!saved||saved.context!==context)throw error('Use this operation\'s completed check set.');const s=select(context);
      for(let attempt=0;attempt<8;attempt++){
        const accepted=await acknowledged(s,signal);if(accepted)return accepted;await fresh(s,signal);
        const previous=await observer.record('evidence',codec.indexKey(s.plan),false,signal,true);
        if(previous){const pointer=codec.index(previous.value),metadata=await observer.record('evidence',pointer.manifestKey,true,signal);
          const prior=await reader.accepted({workId,phaseId:metadata.value.phase,operationId:metadata.value.operationId},{signal});
          if(!prior||codec.indexKey(prior.plan)!==codec.indexKey(s.plan))throw error('The current check index points to another draft.','ENGINE_STORAGE_CORRUPT');}
        const tx=codec.transaction(s.plan,saved.reference,{previousIndexVersion:previous?.version??null});
        try{codec.receipt(await transact(scope,tx,{signal}),tx);return {...await reader.accepted(s.input,{signal}),replayed:false};}
        catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;}
      }throw error('The phase check index changed beyond its bounded acceptance retry.','ENGINE_CONTEXT_CHANGED');
    },
    async finish(context,accepted){const s=select(context);if(!accepted?.record||!same(accepted.plan.input,s.input))throw error('Use the accepted check receipt.','ENGINE_PORT_RESULT_INVALID');
      return {workId,phase:s.input.phaseId,operationId:s.input.operationId,generation:accepted.plan.generation,record:accepted.record,
        recordedAt:accepted.body.recordedAt,principalId:accepted.plan.actor.actor.principalId,checks:accepted.body.checks,verdict:accepted.body.verdict,replayed:accepted.replayed};}
  };
}

export function createNamespacePhaseChecksEngine(options={}) {
  const runtime=options.localRecords&&options.localContent?createNamespacePreparationRuntime(options):null;
  return createEngine({ports:{...createNamespaceReadPorts(options),...(runtime?.ports??{}),phaseChecks:createNamespacePhaseChecksPort(options,runtime)}});
}

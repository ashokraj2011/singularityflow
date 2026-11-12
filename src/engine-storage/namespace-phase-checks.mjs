/** Registry-bound checks over explicit execution, source and storage ports. No command discovery. */
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {captureExecutionUnit,NODE_CHECK_EXECUTION_PROFILE} from '../foundation/execution-unit-port.mjs';
import {sourceSnapshot,validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {qualityValidationVerdict,qualityReportUsesStdout} from '../kernel/phase-checks.mjs';
import {phaseAccessIdentity} from '../kernel/phase-preparation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {normalizeExternalCommand} from '../engine-compatibility/node-configuration-path.mjs';
import {createAgentTaskContract,validateExecutionUnitManifest,sha256 as digest} from '../sgos/node-execution-values.mjs';
import {createDurableExecutionUnit} from '../sgos/durable-execution-unit.mjs';
import {createNamespaceSgosOperationalStore} from '../sgos/namespace-operational-store.mjs';
import {namespaceScope,namespaceIdentifier,namespaceJson,exactObject} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespacePreparationRuntime} from './namespace-preparation.mjs';
import {createNamespaceReadPorts} from './namespace-reader.mjs';
import {phaseCheckRecord,NAMESPACE_PHASE_CHECK_PROFILE} from './namespace-phase-check-contract.mjs';
export {NAMESPACE_PHASE_CHECK_PROFILE};
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
import {createNamespaceCodeHistoryReader} from './namespace-code-history.mjs';
export {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code='ENGINE_INPUT_INVALID',details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
const facts=cause=>({name:cause.name??'Error',code:cause.code??null,message:cause.message??String(cause),details:cause.details??null});
function cancelled(signal){if(signal?.aborted)throw error('Phase checks were cancelled; retained attempts are preserved.','ENGINE_OPERATION_CANCELLED');}

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
      let repairSources=null;
      if(facts.payload.artifactRepair&&facts.payload.sources.length){
        const retained=await createNamespaceSourceRetentionReader({...observer.evidenceReads,observer}).inspectDraft({phaseId:phase.id,
          generation:facts.payload.generation,baseRevision:facts.revision,draft:runtime.draftIdentity(draft),artifact:facts.payload.artifact.current,
          configuration:captured.snapshot.configuration},{signal});
        if(!retained)throw error('Retain the exact repair source before running its checks.','ENGINE_SOURCE_EVIDENCE_REQUIRED',{
          operation:'phase.source.retain',workId,phaseId:phase.id});
        await createNamespaceCodeHistoryReader({observer,scope,workId}).inspect(captured.snapshot,phase.id,retained,{signal});
        repairSources=retained.plan.sources;
      }
      const existing=await reader.intent(s.input,{signal});
      if(existing){s.plan=checked(existing.plan,s);s.planReference=existing.reference;
        if(!same(s.plan.draft,runtime.draftIdentity(draft))||s.plan.basis.headVersion!==facts.revision)throw error('The authored draft changed; preserve this intent and select a new check operation.','ENGINE_CONTEXT_CHANGED');
        await fresh(s,signal);
      }else{
        const commandProof=await createNamespaceTestCommandOwners({observer,scope,workId}).commands(captured.snapshot,phase.id,{signal}),
          commands=commandProof.commands,repositories=captured.snapshot.workflow.sourceBindings?.current?.repositories;
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
        const observedSources=await captureSources(repositories,signal);
        if(repairSources&&observedSources.some(source=>repairSources.find(row=>row.repository.id===source.id)?.observed.revision!==source.revision))
          throw error('The application changed after its admitted repair scope. Retain the current source and check it again.','ENGINE_SOURCE_CHANGED',{
            operation:'phase.source.retain',workId,phaseId:phase.id});
        s.plan=phaseCheckRecord('plan',{profile:NAMESPACE_PHASE_CHECK_PROFILE,...(commandProof.identity.receipts.length?{testCommands:commandProof.identity}:{}),binding:codec.binding,input:s.input,parametersSha256:s.parameters,
          generation:facts.payload.generation,draft:runtime.draftIdentity(draft),artifact:facts.payload.artifact.current,actor,
          basis:{authorityVersion:captured.basis.authorityVersion,headVersion:captured.basis.headVersion,configurationVersion:captured.basis.configurationVersion,
            configuration:captured.snapshot.configuration,head:captured.basis.head},
          sources:observedSources,steps});
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

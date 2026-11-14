/** SDK coordination over a journaled SGOS repair and the same registered source/test operations. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {captureExecutionUnit} from '../foundation/execution-unit-port.mjs';
import {sourceSnapshot,validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceJson} from '../sda/namespace/values.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {createAgentTaskContract,validateExecutionUnitManifest,sha256} from '../sgos/node-execution-values.mjs';
import {createDurableExecutionUnit} from '../sgos/durable-execution-unit.mjs';
import {createNamespaceSgosOperationalStore} from '../sgos/namespace-operational-store.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceTestRepairReader,TEST_REPAIR_EXECUTION_PROFILE} from './namespace-test-repair-reader.mjs';
import {testRepairInput} from './namespace-test-repair-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause}),
  diagnostic=cause=>({name:cause.name??'Error',code:cause.code??null,message:cause.message??String(cause),details:cause.details??null});
const cancelled=signal=>{if(signal?.aborted)throw error('The repair operation was cancelled before its next effect.','ENGINE_OPERATION_CANCELLED');};
export function createNamespaceTestRepairPort(options,runtime,executeOperation){
  const {records,content,scope,workId,access,clock,repairs,sources=[]}=options,observer=createNamespaceStoryObserver(options),
    reader=createNamespaceTestRepairReader({observer,scope,workId}),{codec}=reader,contexts=new WeakMap(),
    hash=codec.digest,units=new Map(),sourceUnits=new Map(),transact=records.transact.bind(records),put=content.put.bind(content);
  const retainedOnly=repairs?.mode==='retained-only',bindings=retainedOnly?[]:repairs?.bindings;
  if(repairs?.mode!==undefined&&(!retainedOnly||Object.keys(repairs).some(key=>key!=='mode')))throw error('Use explicit repair units or an effect-free retained-only binding.','ENGINE_INPUT_INVALID');
  if(!Array.isArray(bindings)||bindings.length>128)throw error('Bind explicit test-repair execution units.','ENGINE_INPUT_INVALID');
  if(retainedOnly)runtime=null;
  const history=createNamespaceSgosOperationalStore({records,content,scope,storeId:'test-repair-'+hash(codec.binding).slice(0,48)});
  for(const source of sources){validateSourceUnit(source);sourceUnits.set(source.descriptor.repositoryId,source);}
  for(const binding of bindings){if(units.has(binding.phaseId))throw error('Bind one repair executor per phase.','ENGINE_INPUT_INVALID');
    const unit=captureExecutionUnit(binding.unit),manifest=validateExecutionUnitManifest(unit.descriptor());
    if(manifest.toolPolicy.profile!==TEST_REPAIR_EXECUTION_PROFILE||manifest.toolPolicy.projectId!==scope.projectId||manifest.toolPolicy.phaseId!==binding.phaseId
      ||!manifest.capabilities.writeFiles||manifest.sandbox.enforcement!=='task-scope'||manifest.network.mode!=='deny')
      throw error('Repair requires a source-scoped executor with an explicit denied-network profile.','ENGINE_EXECUTION_UNIT_PORT_INVALID');
    units.set(binding.phaseId,{unit,manifest,runtime:createDurableExecutionUnit({unit,store:history,content,scope,owner:repairs.owner,clock})});}
  async function save(value,namespace,signal){const data=Buffer.from(canonicalJson(value)),expected={namespace,sha256:NODE_TEXT_DIGESTS.sha256Utf8(data.toString('utf8')),bytes:data.byteLength},
    stored=await put(scope,namespace,data,{signal});
    if(!same(contentReference(stored?.reference),expected)||typeof stored.reused!=='boolean')throw error('The content store acknowledged another repair record.','ENGINE_PORT_RESULT_INVALID');
    await observer.bytes(expected,expected.bytes,signal);return expected;}
  async function authorize(signal,expected=null){const value=phaseTransitionAccess(namespaceJson(await access.current({projectId:scope.projectId,workId,operation:'phase.repair.run',signal})),
    scope.projectId,'phase.repair.run');
    if(expected&&!same(expected,value))throw error('Resume this repair under its original authenticated actor and phase agent.','ENGINE_ACTOR_CHANGED');return value;}
  function state(context){const s=contexts.get(context);if(!s)throw error('Use the issued repair context.','ENGINE_INPUT_INVALID');return s;}
  async function capture(plan,signal){const rows=[];
    for(const row of plan.sources){const unit=sourceUnits.get(row.id);if(!unit||!same(validateSourceUnit(unit),row.descriptor))throw error(
      'Bind the actual repair repository source port.','ENGINE_SOURCE_UNIT_UNAVAILABLE',{repositoryId:row.id});
      const found=await unit.capture({signal}),value=sourceSnapshot(found.snapshot,row.descriptor);
      if(found.revision!=='sha256:'+hash(value))throw error('The source observation returned another revision.','ENGINE_PORT_RESULT_INVALID');
      rows.push({id:row.id,descriptor:row.descriptor,revision:found.revision,content:await save(value,'runtime',signal)});
    }return rows;}
  async function fresh(s,signal){await authorize(signal,s.plan.actor);await runtime.revalidateDraft(s.admission,{signal});
    const current=await observer.capture({signal});if(current.snapshot.revision!==s.plan.basis.headVersion||current.basis.authorityVersion!==s.plan.basis.authorityVersion)
      throw error('The repair Story or authority changed. Preserve the attempt for recovery.','ENGINE_CONTEXT_CHANGED');}
  return {
    async load(input,{signal}={}){testRepairInput(input);if(input.workId!==workId)throw error('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
      const context={subject:{kind:'story',id:workId},phase:input.phaseId};contexts.set(context,{input});return context;},
    async retained(context,_input,{signal}={}){const s=state(context),found=await reader.accepted(s.input,{signal});if(!found)return null;
      await authorize(signal,found.plan.actor);return {...found,replayed:true};},
    async prepare(context,_input,{signal}={}){
      if(retainedOnly)throw error('This repair adapter replays retained results only. Bind actual execution for a new repair.','ENGINE_PORT_UNAVAILABLE',{required:['test-repair-executor'],mode:'retained-only'});
      const s=state(context);if(!runtime)throw error('New repair execution needs its preserved local authoring draft.','ENGINE_PORT_UNAVAILABLE',{required:['machine-local-working-store']});
      const token=await runtime.captureDraft(s.input.phaseId,{signal});s.admission=await runtime.admitDraft(token,'phase.repair.run',{signal});
      const facts=runtime.draftFacts(s.admission),current=await observer.capture({signal}),bound=units.get(s.input.phaseId);
      if(!bound)throw error('Bind the phase\'s explicit test-repair executor.','ENGINE_PORT_UNAVAILABLE',{phase:s.input.phaseId,required:['test-repair-executor']});
      const existing=await reader.acceptedAttempt(s.input,{signal});
      if(existing){s.plan=existing.plan;s.reference=existing.reference;
        if(!same(s.plan.draft,runtime.draftIdentity(token)))throw error('The repair draft changed; preserve its original reservation.','ENGINE_CONTEXT_CHANGED');
      }else{
        const initial={version:null,attempts:[]},source=await reader.source(current.snapshot,s.input,initial,{signal});
        if(!same(source.failed.plan.draft,runtime.draftIdentity(token)))throw error('The failed execution belongs to another authored draft.','TEST_RECOVERY_FAILURE_REQUIRED');
        const provisional={input:s.input,generation:facts.payload.generation,repair:source.repair},key=codec.indexKey(provisional),
          prior=await observer.record('runtime',key,false,signal,true),previous={version:prior?.version??null,attempts:prior?codec.budget(prior.value):[]},
          exact=await reader.source(current.snapshot,s.input,previous,{signal}),basis={...current.basis,configuration:current.snapshot.configuration};
        for(const row of previous.attempts){const originalRequest=(await reader.json(row.record,signal)).input;
          if(originalRequest?.operationId!==row.operationId||originalRequest.workId!==workId||originalRequest.phaseId!==s.input.phaseId)throw error('The repair budget names another Story or phase.','ENGINE_STORAGE_CORRUPT');
          const proof=await reader.acceptedAttempt(originalRequest,{signal});
          if(!proof||!same(proof.reference,row.record)||codec.indexKey(proof.plan)!==key)throw error('The repair budget has an unauthenticated reservation.','ENGINE_STORAGE_CORRUPT');}
        if(!same(bound.manifest,validateExecutionUnitManifest(bound.unit.descriptor())))throw error('The repair executor changed before admission.','ENGINE_CHECK_BINDING_CHANGED');
        const contract=createAgentTaskContract({taskId:'repair-'+hash(s.input),processId:'test-repair-'+hash(codec.binding),instructionId:'repair-failed-checks',
          objective:'Repair only the approved source/support paths while preserving the failed test source and full command inventory.',
          acceptanceClauses:[],policySnapshotSha256:'sha256:'+current.snapshot.configuration.content.sha256,programSha256:'sha256:'+hash(exact.repair),
          inputs:['sha256:'+exact.failed.record.content.sha256,exact.agreement.agreement.contextSha256],readScope:exact.repair.allowedPaths,
          writeScope:exact.repair.allowedPaths,forbiddenScope:['.git','test-source','unplanned-paths','test-command-changes'],allowedDevices:[],
          environmentManifestSha256:sha256(bound.manifest.toolPolicy),candidatePolicy:'immutable-snapshot',outputSchema:{type:'object'},requiredEvidence:['repair-observation'],
          budgets:{activeMinutes:5,modelInvocations:0,touchedResources:exact.repair.allowedPaths.length},stopConditions:['scope-change','test-command-change'],
          executionUnitManifestSha256:bound.manifest.manifestSha256});
        s.plan={schemaVersion:1,profile:'sflow-namespace-test-repair-attempt/v1',binding:codec.binding,input:s.input,
          parametersSha256:hash({binding:codec.binding,input:s.input}),generation:facts.payload.generation,draft:runtime.draftIdentity(token),
          actor:{actor:facts.actor,agentId:facts.agentId},basis,previous,repair:exact.repair,sources:exact.failed.plan.sources,manifest:bound.manifest,contract};
        const observed=await capture(s.plan,signal);if(observed.some((row,index)=>row.revision!==s.plan.sources[index].revision))throw error(
          'Source changed after the failed execution; run its current tests before selecting a repair.','ENGINE_SOURCE_CHANGED');
        s.reference=await save(s.plan,'runtime',signal);await fresh(s,signal);const tx=codec.transaction(s.plan,s.reference);
        try{codec.receipt(await transact(scope,tx,{signal}),tx);}catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
          const retained=await reader.acceptedAttempt(s.input,{signal});if(!retained||!same(retained.plan,s.plan))throw cause;}
      }
      const admitted=await reader.acceptedAttempt(s.input,{signal});if(!admitted||!same(admitted.plan,s.plan))throw error('The repair reservation did not authenticate its original budget and scope.','ENGINE_STORAGE_CORRUPT');
      await fresh(s,signal);if(!same(s.plan.manifest,bound.manifest))throw error('Resume using the original repair executor.','ENGINE_CHECK_BINDING_CHANGED');
      return {operationId:s.input.operationId};
    },
    async execute(context,_token,{signal}={}){
      const s=state(context),bound=units.get(s.input.phaseId);await fresh(s,signal);
      let handle;try{handle=await bound.runtime.start(s.plan.contract,{signal});}catch(cause){cancelled(signal);throw cause;}
      let candidate=null,failure=null,scopeViolation=null,stopping=null;
      const stop=()=>{stopping??=(async()=>{try{return await bound.runtime.requestStop(handle,{reason:'The explicit repair operation was cancelled.'});}
        catch(cause){if(!['SGOS_EXECUTION_ALREADY_SETTLED','SGOS_EXECUTION_LEASE_LOST'].includes(cause.code))throw cause;
          const quiet=await bound.runtime.quiesce(handle);if(quiet.quiescent!==true)throw cause;return quiet;}})();stopping.catch(()=>{});};
      signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();let quiescence;
      try{try{candidate=await bound.runtime.collect(handle);}catch(cause){failure=diagnostic(cause);}
        quiescence=await bound.runtime.quiesce(handle);if(stopping)await stopping;cancelled(signal);
      }finally{signal?.removeEventListener('abort',stop);if(signal?.aborted){if(!stopping)stop();await stopping;await bound.runtime.quiesce(handle);}}
      const after=await capture(s.plan,signal);try{await reader.validateChanges(s.plan,after,signal);}
      catch(cause){if(cause.code!=='TEST_RECOVERY_SCOPE_CHANGED')throw cause;scopeViolation=diagnostic(cause);}
      let source=null,checked=null,verdict=scopeViolation?'scope-review-required':'repair-required';
      if(!failure&&!scopeViolation){await fresh(s,signal);const suffix=hash(s.input),sourceId='repair-source-'+suffix,checkId='repair-check-'+suffix;
        const retained=await executeOperation('phase.source.retain',{operationId:sourceId,workId,phaseId:s.input.phaseId},{signal});
        source={operationId:sourceId,record:retained.record};
        const result=await executeOperation('phase.checks.run',{operationId:checkId,workId,phaseId:s.input.phaseId},{signal});
        checked={operationId:checkId,record:result.record};verdict=result.verdict==='passed'?'repaired':'repair-required';
      }
      s.result={schemaVersion:1,profile:'sflow-namespace-test-repair-result/v1',input:s.input,attempt:s.reference,
        recordedAt:projectEnrollmentTimestamp(await clock.now()),handle,candidate,failure,quiescence,after,scopeViolation,source,checks:checked,verdict};
      s.resultReference=await save(s.result,'evidence',signal);return {operationId:s.input.operationId};
    },
    async commit(context,_token,{signal}={}){const s=state(context),existing=await reader.accepted(s.input,{signal});if(existing)return {...existing,replayed:true};
      await fresh(s,signal);const tx=codec.transaction(s.plan,s.resultReference,{result:true});
      try{codec.receipt(await transact(scope,tx,{signal}),tx);}catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
        const retained=await reader.accepted(s.input,{signal});if(!retained||!same(retained.result,s.result))throw cause;}
      return {...await reader.accepted(s.input,{signal}),replayed:false};
    },
    async finish(_context,accepted){return {schemaVersion:1,profile:'sflow-namespace-test-repair-outcome/v1',workId,phase:accepted.plan.input.phaseId,
      operationId:accepted.plan.input.operationId,generation:accepted.plan.generation,attempt:accepted.plan.repair.attempt,record:accepted.record,
      sourceFilesChanged:accepted.result.after.some((row,index)=>row.revision!==accepted.plan.sources[index].revision),
      verdict:accepted.result.verdict,failure:accepted.result.failure,scopeViolation:accepted.result.scopeViolation,checks:accepted.result.checks,replayed:accepted.replayed,
      actions:[{operation:accepted.result.verdict==='repaired'?'phase.prepublish':'phase.delivery.inspect',inputs:{workId,phaseId:accepted.plan.input.phaseId}}]};}
  };
}

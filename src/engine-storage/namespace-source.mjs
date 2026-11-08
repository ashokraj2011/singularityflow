/** SDK source-baseline coordination over explicit SGOS units and SDA ports. No source I/O here. */
import { createHash } from 'node:crypto';
import { createEngine } from '../engine-sdk/index.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { canonicalJson } from '../foundation/record-schema.mjs';
import { sourceSnapshot,validateSourceUnit } from '../foundation/source-snapshot.mjs';
import { sourceBindingAccess,sourceBindingScope,sourceBindingAdmission,applySourceBinding,storedSourceBinding } from '../kernel/source-binding.mjs';
import { projectEnrollmentTimestamp } from '../kernel/project-enrollment.mjs';
import { namespaceScope,namespaceJson,namespaceIdentityJson } from '../sda/namespace/values.mjs';
import { contentReference } from '../sda/content/contract.mjs';
import { createNamespaceLifecycleCommitter } from './namespace-lifecycle-commit.mjs';
import { createNamespaceLifecycleObserver,namespaceLifecycleStoryKey } from './namespace-lifecycle-reader.mjs';
import { lifecycleRecord } from './namespace-lifecycle-contract.mjs';
import { createNamespaceReadPorts } from './namespace-reader.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('Source binding was cancelled before its next effect.','ENGINE_OPERATION_CANCELLED');}

export function createNamespaceSourceBindingPort({records,content,scope,workId,authority,sources=[],access,clock}={}) {
  scope=namespaceScope(scope);const binding=sourceBindingScope({projectId:scope.projectId,workId,authority},{workId});
  authority=binding.authority;
  const observer=createNamespaceLifecycleObserver({records,content,scope,workId,authority});
  const committer=createNamespaceLifecycleCommitter({records,content,scope,workId,authority});
  if(!Array.isArray(sources)||sources.length>32||typeof access?.current!=='function'||typeof clock?.now!=='function') {
    throw error('Source binding needs explicit source, access and clock ports.','ENGINE_INPUT_INVALID');
  }
  const units=new Map(),unitIds=new Set();
  for(const source of sources) {
    const descriptor=validateSourceUnit(source);
    if(descriptor.projectId!==scope.projectId||units.has(descriptor.repositoryId)||unitIds.has(descriptor.id)) {
      throw error('Source units must have distinct IDs and repositories in the bound project.','ENGINE_INPUT_INVALID');
    }
    units.set(descriptor.repositoryId,{descriptor,capture:source.capture.bind(source)});unitIds.add(descriptor.id);
  }
  const put=content.put.bind(content),current=access.current.bind(access),now=clock.now.bind(clock);
  const recordId=records.descriptor.id,contentId=content.descriptor.id;
  const contexts=new WeakMap(),preparations=new WeakMap(),outcomes=new WeakMap();
  const parameters=inputs=>hash(namespaceIdentityJson({operation:'source.bind',inputs,binding,
    recordsId:recordId,contentId}));
  function selected(context){const value=contexts.get(context);if(!value)throw error('Source binding needs its issued context.','ENGINE_INPUT_INVALID');return value;}
  function unit(repositoryId) {const found=units.get(repositoryId);
    if(!found)throw error('Configure the selected repository source unit before binding it.','ENGINE_SOURCE_UNIT_UNAVAILABLE',{repositoryId});return found;}
  async function authorize(expected,signal) {
    cancelled(signal);const response=await current({projectId:scope.projectId,workId,operation:'source.bind',signal});let facts;
    try {facts=namespaceJson(response);}catch(cause){throw error('The source access port did not return bounded facts.','ENGINE_PORT_RESULT_INVALID',null,cause);}
    cancelled(signal);return sourceBindingAccess(facts,scope.projectId,expected);
  }
  async function capture(repositoryId,signal) {
    cancelled(signal);const source=unit(repositoryId),observed=await source.capture({signal});cancelled(signal);
    let snapshot;
    try {snapshot=sourceSnapshot(observed?.snapshot,source.descriptor);}
    catch(cause){if(cause.code==='SGOS_SOURCE_UNSUPPORTED')throw cause;throw error('The source unit returned invalid snapshot facts.','ENGINE_PORT_RESULT_INVALID',{repositoryId},cause);}
    const data=Buffer.from(canonicalJson(snapshot)),revision='sha256:'+hash(data);
    if(data.byteLength>source.descriptor.limits.maximumManifestBytes)throw error('The source manifest exceeds its declared bound.','ENGINE_STORAGE_LIMIT',{repositoryId});
    if(observed.revision!==revision)throw error('The source unit returned another snapshot digest.','ENGINE_PORT_RESULT_INVALID',{repositoryId});
    return {data,revision,descriptor:source.descriptor};
  }
  function checkIntent(plan,context) {
    if(plan&& (plan.operation!=='source.bind'||plan.inputsSha256!==selected(context).parameters)) {
      throw error('This operation ID belongs to another source binding.','ENGINE_OPERATION_ID_REUSED');
    }
    return plan;
  }
  async function opened(context,signal) {
    return checkIntent(await committer.intent(selected(context).inputs.operationId,{signal}),context);
  }
  async function preparedBody(plan,signal) {
    const body=observer.state(await observer.bytes(plan.state,plan.state.bytes,signal),plan.basis.head);
    const retained=storedSourceBinding(body.workflow.sourceBindings?.current,plan.operationId);
    return {body,retained};
  }
  async function retainedManifest(repository,signal) {
    const data=await observer.bytes(repository.snapshot,repository.snapshot.bytes,signal);let snapshot;
    try {snapshot=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));sourceSnapshot(snapshot,repository.descriptor);}
    catch(cause){if(cause.code==='SGOS_SOURCE_UNSUPPORTED')throw cause;throw error('The retained source manifest is invalid.','ENGINE_STORAGE_CORRUPT',{repositoryId:repository.id},cause);}
    if(repository.revision!=='sha256:'+hash(Buffer.from(canonicalJson(snapshot))))throw error('The source revision differs from its retained manifest.','ENGINE_STORAGE_CORRUPT');
  }
  async function verify(plan,signal) {
    const {retained}=await preparedBody(plan,signal);
    for(const repository of retained.repositories) {
      const source=unit(repository.id);
      if(!same(source.descriptor,repository.descriptor))throw error('The prepared source binding uses another source unit or selection.','ENGINE_SOURCE_UNIT_CHANGED',{repositoryId:repository.id});
      const observed=await capture(repository.id,signal);
      if(observed.revision!==repository.revision)throw error('The selected source changed after capture. Keep this intent and bind a new baseline with a new operation ID.','ENGINE_SOURCE_CHANGED',{
        repositoryId:repository.id,expected:repository.revision,observed:observed.revision});
      await retainedManifest(repository,signal);
    }
    return retained;
  }
  function outcome(context,plan,accepted){const token=Object.freeze({});outcomes.set(token,{context,plan,accepted});return token;}
  async function retained(context,_inputs,{signal}={}) {
    const input=selected(context).inputs,accepted=await committer.inspect(input.operationId,{signal});
    if(accepted.status!=='committed')return null;
    const plan=await opened(context,signal);if(!plan)throw error('The accepted source binding lost its intent.','ENGINE_STORAGE_CORRUPT');
    for(const repository of (await preparedBody(plan,signal)).retained.repositories)await retainedManifest(repository,signal);
    return outcome(context,plan,{...accepted,replayed:true});
  }
  return {
    async load(inputs,{signal}={}) {cancelled(signal);sourceBindingScope(binding,inputs);const context=Object.freeze({binding});
      contexts.set(context,{inputs,parameters:parameters(inputs)});return context;},
    retained,
    async prepare(context,_inputs,{signal}={}) {
      const selection=selected(context);let plan=await opened(context,signal);
      const saved=plan?await preparedBody(plan,signal):null,actor=await authorize(saved?.retained.actor??null,signal);
      if(plan)await verify(plan,signal);
      else {
        const snapshot=await committer.capture({signal});
        if(snapshot.revision!==selection.inputs.expectedRevision)throw error('The Story changed before source binding. Review its current revision.','ENGINE_CONTEXT_CHANGED',{
          expected:selection.inputs.expectedRevision,observed:snapshot.revision});
        sourceBindingAdmission(snapshot.workflow,selection.inputs);
        const repositories=[];
        for(const repositoryId of selection.inputs.repositories) {
          const observed=await capture(repositoryId,signal),expected={namespace:'evidence',sha256:hash(observed.data),bytes:observed.data.byteLength};
          cancelled(signal);const saved=await put(scope,'evidence',observed.data,{signal});
          if(!same(contentReference(saved?.reference),expected)||typeof saved.reused!=='boolean')throw error('The content port did not acknowledge the source manifest.','ENGINE_PORT_RESULT_INVALID');
          await observer.bytes(expected,expected.bytes,signal);
          repositories.push({id:repositoryId,unitId:observed.descriptor.id,provider:observed.descriptor.provider,revision:observed.revision,
            descriptor:observed.descriptor,snapshot:expected});
        }
        const recordedAt=projectEnrollmentTimestamp(await now());
        applySourceBinding(snapshot.workflow,selection.inputs,{repositories,actor,recordedAt});
        const body=lifecycleRecord('state',{projectId:scope.projectId,authorityId:authority.id,epoch:authority.epoch,workId,
          configuration:snapshot.configuration.content,workflow:snapshot.workflow});
        cancelled(signal);
        try {await committer.prepare(snapshot,{operationId:selection.inputs.operationId,operation:'source.bind',inputsSha256:selection.parameters,
          state:Buffer.from(JSON.stringify(body)+'\n'),evidence:repositories.map(repository=>repository.snapshot)},{signal});}
        catch(cause) {
          if(!['ENGINE_OPERATION_ID_REUSED','SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
          plan=await opened(context,signal);if(!plan)throw cause;
          const original=(await preparedBody(plan,signal)).retained;
          if(!same(original.actor,actor)||!same(original.repositories,repositories))throw cause;
        }
        plan=await opened(context,signal);if(!plan)throw error('Source preparation has no retained intent.','ENGINE_STORAGE_CORRUPT');
      }
      const token=Object.freeze({});preparations.set(token,{context,plan});return token;
    },
    async commit(context,token,{signal}={}) {
      const prepared=preparations.get(token);if(!prepared||prepared.context!==context)throw error('Source binding requires its own preparation.','ENGINE_INPUT_INVALID');
      const accepted=await retained(context,selected(context).inputs,{signal});if(accepted!==null)return accepted;
      const plan=await opened(context,signal);if(!plan||!same(plan,prepared.plan))throw error('The prepared source binding changed.','ENGINE_CONTEXT_CHANGED');
      const sources=await verify(plan,signal);await authorize(sources.actor,signal);cancelled(signal);
      return outcome(context,plan,await committer.commit(plan.operationId,{signal}));
    },
    async finish(context,token) {
      const saved=outcomes.get(token);if(!saved||saved.context!==context)throw error('Source binding needs its accepted receipt.','ENGINE_PORT_RESULT_INVALID');
      const {plan,accepted}=saved,{retained}=await preparedBody(plan,null),receipt=accepted.receipt;
      return {projectId:scope.projectId,workId,operationId:plan.operationId,authorityId:authority.id,epoch:authority.epoch,
        principalId:retained.actor.principalId,recordedAt:retained.recordedAt,
        repositories:retained.repositories.map(({id,unitId,provider,revision,snapshot})=>({id,unitId,provider,revision,snapshot})),
        revision:receipt.records.find(record=>record.namespace==='state'&&record.key===namespaceLifecycleStoryKey(workId)).version,
        transactionRevision:receipt.revision,requestDigest:receipt.requestDigest,replayed:accepted.replayed===true};
    }
  };
}

export function createNamespaceSourceEngine({records,content,localContent=null,scope,workId,authority,sources=[],access,clock}={}) {
  scope=namespaceScope(scope);const options={records,content,localContent,scope,workId,authority,sources,access,clock};
  return createEngine({ports:{...createNamespaceReadPorts(options),sourceBinding:createNamespaceSourceBindingPort(options)}});
}

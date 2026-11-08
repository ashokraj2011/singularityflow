/** Explicit configuration approval host. No installed discovery, Git, provider or filesystem. */
import { createHash } from 'node:crypto';
import { createNamespaceConfigurationCodec } from './namespace-configuration-codec.mjs';
import { createNamespaceConfigurationObserver } from './namespace-configuration-reader.mjs';
import { createEngine } from '../engine-sdk/index.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { NODE_NAMESPACE_CONFIGURATION_COMPILER } from '../engine-compatibility/node-namespace-configuration.mjs';
import { namespaceConfigurationJsonValues } from '../kernel/namespace-configuration.mjs';
import { projectConfigurationAccess, projectEnrollmentTimestamp, CONFIGURATION_PACKAGE_MAXIMUM_BYTES } from '../kernel/project-enrollment.mjs';
import { validateNamespaceStore, namespaceLimits } from '../sda/namespace/contract.mjs';
import { exactObject, namespaceScope, namespaceIdentifier, namespaceRevision, namespaceJson, namespaceIdentityJson } from '../sda/namespace/values.mjs';
import { validateContentStore, contentReference } from '../sda/content/contract.mjs';
import { LIFECYCLE_AUTHORITY_KEY, lifecycleAuthority, lifecycleConfiguration, lifecycleRecord } from './namespace-lifecycle-contract.mjs';
import { NAMESPACE_CONFIGURATION_HEAD_KEY, namespaceConfigurationRecord, namespaceConfigurationRecordValue, namespaceConfigurationCompiledValue } from './namespace-configuration-contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const identity = value => hash(namespaceIdentityJson(value));
const same = (a,b) => namespaceIdentityJson(a) === namespaceIdentityJson(b);
const error = (message, code, details = null, cause = undefined) => new SingularityFlowError(message,{ code,details,cause });
function cancelled(signal) { if(signal?.aborted) throw error('Configuration approval was cancelled before its next effect.','ENGINE_OPERATION_CANCELLED'); }

/** access.current authenticates the human; no operation input may supply identity or permission. */
export function createNamespaceConfigurationEngine({ records, content, scope, authority, access, clock } = {}) {
  validateNamespaceStore(records); validateContentStore(content); scope=namespaceScope(scope);
  exactObject(authority,['id','epoch']); authority=Object.freeze({id:namespaceIdentifier(authority.id),epoch:authority.epoch});
  if(!Number.isSafeInteger(authority.epoch) || authority.epoch < 1 || records.descriptor.binding.kind !== 'shared'
    || content.descriptor.binding.kind !== 'shared' || typeof access?.current !== 'function' || typeof clock?.now !== 'function') {
    throw error('Configuration approval needs explicit shared stores, authority, identity and clock ports.','ENGINE_INPUT_INVALID');
  }
  const limits=namespaceLimits(records.descriptor.limits), read=records.read.bind(records), transact=records.transact.bind(records);
  const recordId=records.descriptor.id, contentId=content.descriptor.id;
  const configurationJson=namespaceConfigurationJsonValues();
  const inspect=records.inspectOperation.bind(records), get=content.read.bind(content), put=content.put.bind(content);
  const currentAccess=access.current.bind(access), now=clock.now.bind(clock);
  const contexts=new WeakMap(), preparations=new WeakMap(), outcomes=new WeakMap();
  const binding=Object.freeze({projectId:scope.projectId,authority});
  const parameters=inputs=>identity({operation:'configuration.approve',inputs,binding,recordsId:recordId,contentId});
  const {keys,projected,transaction,prepareTransaction,receipt,txDigest}=createNamespaceConfigurationCodec({scope,authority,limits});
  const {stored,record,bytes,json}=createNamespaceConfigurationObserver({records,content,scope,authority});
  async function compile(inputs,signal) {
    cancelled(signal); const result=NODE_NAMESPACE_CONFIGURATION_COMPILER.compile(json(await bytes(inputs.source,signal)),inputs.source);
    for(const resource of result.resources) {
      cancelled(signal); const data=await bytes(resource.reference,signal);
      if(resource.kind!=='file') {
        try {const text=new TextDecoder('utf-8',{fatal:true}).decode(data);if(!text.trim()||text.includes('\0'))throw new Error('Empty or NUL-containing text resource.');}
        catch(cause){throw error('A configuration text resource is empty or not UTF-8.','ENGINE_CONFIGURATION_INVALID',{kind:resource.kind,key:resource.key},cause);}
      }
    }
    const data=Buffer.from(configurationJson.encode(result.compiled));
    if(data.byteLength>CONFIGURATION_PACKAGE_MAXIMUM_BYTES)throw error('Compiled configuration exceeds its content bound.','ENGINE_STORAGE_LIMIT');
    return {data,reference:{namespace:'config',sha256:hash(data),bytes:data.byteLength},advisories:result.compiled.warnings.length};
  }
  async function save(compiled,signal) {
    cancelled(signal); const result=await put(scope,'config',compiled.data,{signal});
    if(!same(contentReference(result?.reference),compiled.reference) || typeof result.reused!=='boolean') {
      throw error('The content store did not acknowledge the compiled configuration.','ENGINE_PORT_RESULT_INVALID');
    }
    await bytes(compiled.reference,signal); return compiled.reference;
  }
  function select(context) { const selected=contexts.get(context);
    if(!selected)throw error('Configuration approval needs its own issued context.','ENGINE_INPUT_INVALID'); return selected; }
  function admit(plan,selected) {
    stored(namespaceConfigurationRecordValue,'intent',plan,scope,selected.inputs.operationId);
    if(plan.parametersSha256!==selected.parameters || plan.authorityId!==authority.id || plan.epoch!==authority.epoch
      || plan.reason!==selected.inputs.reason || plan.baseRevision!==selected.inputs.expectedRevision || !same(plan.source,selected.inputs.source)) {
      throw error('This operation ID belongs to another configuration approval.','ENGINE_OPERATION_ID_REUSED');
    }
    if(plan.requestDigest!==txDigest(transaction(plan)))throw error('The prepared configuration transaction changed.','ENGINE_STORAGE_CORRUPT'); return plan;
  }
  async function checkpoint(selected,signal) {
    const k=keys(selected.inputs.operationId);let saved=await record('runtime',k.prepared,true,signal);
    const observed=await inspect(scope,k.prepareOperation,{signal});
    if(saved===null && observed?.status==='missing' && observed.receipt===null)return null;
    if(saved===null && observed?.status==='committed')saved=await record('runtime',k.prepared,true,signal);
    if(!saved)throw error('The configuration preparation lost its immutable intent.','ENGINE_STORAGE_CORRUPT');
    const plan=admit(saved.value,selected);receipt(observed,prepareTransaction(plan));return plan;
  }
  function outcome(context,plan,r,replayed,advisories){const token=Object.freeze({});outcomes.set(token,{context,plan,receipt:r,replayed,advisories});return token;}
  async function retained(context,_inputs,{signal}={}) {
    cancelled(signal);const selected=select(context),observed=await inspect(scope,keys(selected.inputs.operationId).operation,{signal});
    if(observed?.status==='missing' && observed.receipt===null)return null;
    const plan=await checkpoint(selected,signal);
    if(!plan)throw error('A configuration approval lost its prepared intent.','ENGINE_STORAGE_CORRUPT');
    const r=receipt(observed,transaction(plan)),saved=await record('evidence',keys(plan.operationId).manifest,true,signal);
    if(!saved || !same(stored(namespaceConfigurationRecordValue,'manifest',saved.value,scope,plan.operationId),projected('manifest',plan)))throw error('The accepted configuration decision is missing or changed.','ENGINE_STORAGE_CORRUPT');
    const configured=await record('config',plan.configuration.key,true,signal);
    if(!configured || !same(stored(lifecycleConfiguration,configured.value,scope).content,plan.configuration.content))throw error('The approved immutable configuration record is missing or changed.','ENGINE_STORAGE_CORRUPT');
    const compiled=stored(namespaceConfigurationCompiledValue,configurationJson.namespaceJson(json(await bytes(plan.configuration.content,signal))),plan.source);
    return outcome(context,plan,r,true,compiled.warnings.length);
  }
  async function authorize(expectedPrincipal,signal) {
    cancelled(signal);let facts;
    const response=await currentAccess({projectId:scope.projectId,operation:'configuration.approve',signal});
    try {facts=namespaceJson(response);}
    catch(cause){throw error('The reviewer port did not return bounded identity facts.','ENGINE_PORT_RESULT_INVALID',null,cause);}
    cancelled(signal);projectConfigurationAccess(facts,scope.projectId,expectedPrincipal);return facts;
  }
  async function basis(inputs,signal) {
    const a=await record('state',LIFECYCLE_AUTHORITY_KEY,false,signal);
    if(!a)throw error('Enroll this project before approving configuration.','ENGINE_PROJECT_NOT_ENROLLED');
    stored(lifecycleAuthority,a.value,scope);
    if(a.value.authorityId!==authority.id || a.value.epoch!==authority.epoch || a.value.status!=='active'
      || a.value.recordsId!==recordId || a.value.contentId!==contentId)throw error('This configuration writer is fenced or uses another authority.','ENGINE_AUTHORITY_FENCED');
    const h=await record('config',NAMESPACE_CONFIGURATION_HEAD_KEY,false,signal);
    if(h){stored(namespaceConfigurationRecordValue,'head',h.value,scope);
      if(h.value.authorityId!==authority.id || h.value.epoch!==authority.epoch)throw error('The configuration head uses another authority.','ENGINE_AUTHORITY_FENCED');}
    if((h?.version??null)!==inputs.expectedRevision)throw error('The approved configuration changed. Review the current revision before creating another operation.','ENGINE_CONTEXT_CHANGED',{expected:inputs.expectedRevision,actual:h?.version??null});
    return {authorityVersion:a.version,baseRevision:h?.version??null};
  }
  return createEngine({ports:{configurationApproval:{
    async load(inputs,{signal}={}) {cancelled(signal);const context=Object.freeze({binding});contexts.set(context,{inputs,parameters:parameters(inputs)});return context;},
    retained,
    async prepare(context,_inputs,{signal}={}) {
      const selected=select(context);let plan=await checkpoint(selected,signal);
      const accessFacts=await authorize(plan?.principalId??null,signal),observed=await basis(selected.inputs,signal);
      const compiled=await compile(selected.inputs,signal);
      if(plan) {
        if(plan.authorityVersion!==observed.authorityVersion || !same(plan.configuration.content,compiled.reference))throw error('The prepared configuration or compiler binding changed.','ENGINE_CONTEXT_CHANGED');
        await bytes(plan.configuration.content,signal);
      } else {
        const reference=await save(compiled,signal),key=`configuration/versions/${reference.sha256}`;
        const existing=await record('config',key,true,signal);
        if(existing && !same(stored(lifecycleConfiguration,existing.value,scope).content,reference))throw error('The compiled configuration identity is occupied by another record.','ENGINE_STORAGE_CORRUPT');
        const draft=namespaceConfigurationRecord('intent',{projectId:scope.projectId,authorityId:authority.id,epoch:authority.epoch,
          operationId:selected.inputs.operationId,parametersSha256:selected.parameters,source:selected.inputs.source,
          configuration:{key,content:reference},baseRevision:observed.baseRevision,authorityVersion:observed.authorityVersion,
          configurationVersion:existing?.version??null,principalId:accessFacts.principalId,recordedAt:projectEnrollmentTimestamp(await now()),
          reason:selected.inputs.reason,requestDigest:'0'.repeat(64)});
        draft.requestDigest=txDigest(transaction(draft));plan=namespaceJson(admit(draft,selected));cancelled(signal);
        try {const tx=prepareTransaction(plan);receipt(await transact(scope,tx,{signal}),tx);}
        catch(cause) {
          if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
          const accepted=await checkpoint(selected,signal);if(!accepted)throw cause;
          projectConfigurationAccess(accessFacts,scope.projectId,accepted.principalId);
          if(!same(accepted.configuration.content,compiled.reference))throw error('Concurrent preparation used another compiler binding.','ENGINE_CONTEXT_CHANGED');plan=accepted;
        }
      }
      const token=Object.freeze({});preparations.set(token,{context,plan});return token;
    },
    async commit(context,token,{signal}={}) {
      cancelled(signal);const prepared=preparations.get(token);
      if(!prepared || prepared.context!==context)throw error('Configuration approval needs its own prepared intent.','ENGINE_INPUT_INVALID');
      const accepted=await retained(context,select(context).inputs,{signal});if(accepted!==null)return accepted;
      const plan=await checkpoint(select(context),signal);
      if(!plan || !same(plan,prepared.plan))throw error('The prepared configuration changed.','ENGINE_CONTEXT_CHANGED');
      const compiled=await compile(select(context).inputs,signal);
      if(!same(compiled.reference,plan.configuration.content))throw error('The configuration compiler result changed after review.','ENGINE_CONTEXT_CHANGED');
      await bytes(plan.configuration.content,signal);
      await authorize(plan.principalId,signal);const observed=await basis(select(context).inputs,signal);
      if(observed.authorityVersion!==plan.authorityVersion)throw error('The configuration authority changed after preparation.','ENGINE_CONTEXT_CHANGED');
      cancelled(signal);
      const tx=transaction(plan);
      try {const committed=await transact(scope,tx,{signal});return outcome(context,plan,receipt(committed,tx),committed.replayed===true,compiled.advisories);}
      catch(cause) {
        if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
        const accepted=await retained(context,select(context).inputs,{signal});if(accepted===null)throw cause;return accepted;
      }
    },
    async finish(context,token) {
      const saved=outcomes.get(token);if(!saved || saved.context!==context)throw error('Configuration approval needs its own accepted receipt.','ENGINE_PORT_RESULT_INVALID');
      const {plan,receipt:r,replayed,advisories}=saved;
      const revision=r.records.find(item=>item.namespace==='config'&&item.key===NAMESPACE_CONFIGURATION_HEAD_KEY).version;
      return {projectId:scope.projectId,operationId:plan.operationId,authorityId:authority.id,epoch:authority.epoch,
        principalId:plan.principalId,source:plan.source,configuration:plan.configuration.content,reason:plan.reason,
        recordedAt:plan.recordedAt,requestDigest:r.requestDigest,revision,transactionRevision:r.revision,replayed,advisories};
    }
  }}});
}

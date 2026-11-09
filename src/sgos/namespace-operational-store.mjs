/** Durable SGOS operational history over explicit SDA ports; never lifecycle authority. */
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {validateNamespaceStore,namespaceLimits} from '../sda/namespace/contract.mjs';
import {namespaceScope,namespaceRevision} from '../sda/namespace/values.mjs';
import {namespaceTransaction,namespaceTransactionIdentity} from '../sda/namespace/transaction.mjs';
import {validateContentStore,contentReference} from '../sda/content/contract.mjs';
import {SGOS_OPERATIONAL_STORE_SPI_VERSION,SGOS_OPERATIONAL_STORE_CAPABILITIES,
  OPERATIONAL_STORE_ID,MAXIMUM_ENTRIES,MAXIMUM_EVENTS,MAXIMUM_BYTES,FORMAT_VERSION,
  createSgosOperationalCodec} from './operational-contract.mjs';

export const SGOS_NAMESPACE_OPERATIONAL_STORE_PROFILE='namespace-runtime-v1';
const profile=SGOS_NAMESPACE_OPERATIONAL_STORE_PROFILE;
const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>'sha256:'+hash(canonicalJson(value));
const {fail,exact,clone,bounded,normalizedChanges,apply,event,replay,validateBackup,sealed}=createSgosOperationalCodec({digest});
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const failure=(message,code='SGOS_OPERATIONAL_STORE_CORRUPT',cause=undefined)=>new SingularityFlowError(message,{code,cause});
const headFields=['format','formatVersion','projectId','storeId','profile','revision','stateSha256','eventSha256','lineage'];

/** No initialization, enrollment, file access or executable selection occurs at construction. */
export function createNamespaceSgosOperationalStore(options={}) {
  exact(options,['records','content','scope','storeId'],'Namespace Operational Store bindings');
  const {storeId}=options,scope=namespaceScope(options.scope);
  if(!OPERATIONAL_STORE_ID.test(String(storeId??'')))fail('Operational Store ID must be a portable lower-case identifier.');
  validateNamespaceStore(options.records);validateContentStore(options.content);
  if(options.records.descriptor.binding.kind!=='shared'||options.content.descriptor.binding.kind!=='shared'
    ||options.content.descriptor.maximumBytes<MAXIMUM_BYTES) {
    fail('Operational history requires explicit shared record/content ports supporting the SGOS byte bound.','SGOS_OPERATIONAL_ADAPTER_INVALID');
  }
  const limits=namespaceLimits(options.records.descriptor.limits);
  const read=options.records.read.bind(options.records),transact=options.records.transact.bind(options.records);
  const inspect=options.records.inspectOperation.bind(options.records),readContent=options.content.read.bind(options.content);
  const putContent=options.content.put.bind(options.content),key=`sgos/operational/${storeId}/head`;
  let queue=Promise.resolve();
  const locked=operation=>{const result=queue.then(operation,operation);queue=result.then(()=>undefined,()=>undefined);return result;};

  function runtimeReference(value) {
    let reference;
    try {reference=contentReference(value,MAXIMUM_BYTES);}
    catch(cause){throw failure('Operational content has an invalid retained reference.',undefined,cause);}
    if(reference.namespace!=='runtime')throw failure('Operational content must remain in its runtime namespace.');
    return reference;
  }
  async function json(reference) {
    reference=runtimeReference(reference);
    const result=await readContent(scope,reference,{maximumBytes:reference.bytes});
    if(result?.status!=='present'||!same(result.reference,reference)||result.truncated!==false
      ||!(result.data instanceof Uint8Array)||result.data.byteLength!==reference.bytes||hash(result.data)!==reference.sha256) {
      throw failure('Retained operational content is missing, truncated or differs from its digest.');
    }
    try {
      const text=new TextDecoder('utf-8',{fatal:true}).decode(result.data),value=JSON.parse(text);
      if(!Buffer.from(canonicalJson(value)).equals(result.data))throw Error('Operational content is not canonical.');
      return value;
    }catch(cause){throw failure('Retained operational content is not canonical UTF-8 JSON.',undefined,cause);}
  }
  async function put(value) {
    bounded(value,MAXIMUM_BYTES,'Operational content');
    const bytes=Buffer.from(canonicalJson(value)),expected={namespace:'runtime',sha256:hash(bytes),bytes:bytes.byteLength};
    const result=await putContent(scope,'runtime',bytes);
    if(!same(result?.reference,expected)||typeof result?.reused!=='boolean') {
      throw failure('The content port did not acknowledge the exact operational bytes.','SGOS_OPERATIONAL_PORT_RESULT_INVALID');
    }
    await json(expected);
    return expected;
  }
  async function load() {
    const result=await read(scope,'runtime',key);
    if(result?.status==='missing'&&result.record===null) {
      const empty=replay(storeId,[]);return {...empty,events:[],references:[],version:null};
    }
    const record=result?.record;
    if(result?.status!=='present'||record?.namespace!=='runtime'||record.key!==key||record.immutable!==false) {
      throw failure('The operational head is not an exact mutable runtime record.');
    }
    let version,head;
    try {
      version=namespaceRevision(record.version);head=clone(record.value);exact(head,headFields,'Operational namespace head');
      if(version===null||head.format!=='sflow.sgos.namespace-operational-head'||head.formatVersion!==1
        ||head.projectId!==scope.projectId||head.storeId!==storeId||head.profile!==profile)throw Error('Head identity differs.');
    }catch(cause){throw failure('The operational head has another identity or format.',undefined,cause);}
    const lineage=await json(head.lineage);
    try {exact(lineage,['format','formatVersion','storeId','events'],'Operational namespace lineage');
      if(lineage.format!=='sflow.sgos.namespace-operational-lineage'||lineage.formatVersion!==1||lineage.storeId!==storeId
        ||!Array.isArray(lineage.events)||lineage.events.length>MAXIMUM_EVENTS)throw Error('Lineage identity or size differs.');
    }catch(cause){throw failure('Operational lineage has another identity or exceeds its bound.',undefined,cause);}
    const references=lineage.events.map(runtimeReference),events=[];
    for(let offset=0;offset<references.length;offset+=16) {
      const batch=await Promise.allSettled(references.slice(offset,offset+16).map(json));
      for(const observed of batch){if(observed.status==='rejected')throw observed.reason;events.push(observed.value);}
    }
    const loaded=replay(storeId,events);
    if(head.revision!==loaded.head.revision||head.stateSha256!==loaded.head.stateSha256||head.eventSha256!==loaded.head.eventSha256) {
      throw failure('Operational head does not match its complete append-only lineage.');
    }
    return {...loaded,events,references,version};
  }
  function cas(current) {
    return new SingularityFlowError('Operational transaction lost its compare-and-swap race.',{
      code:'SGOS_OPERATIONAL_CAS_MISMATCH',details:{currentRevision:current.revision,currentStateSha256:current.stateSha256}});
  }
  function receipt(result,transaction) {
    const r=result?.receipt;
    try {
      exact(r,['operationId','scope','revision','requestDigest','records','eventIds'],'Operational transaction receipt');
      if(result.status!=='committed'||r.operationId!==transaction.operationId||!same(r.scope,scope)
        ||r.requestDigest!==hash(namespaceTransactionIdentity(scope,transaction,limits))||namespaceRevision(r.revision)===null
        ||!Array.isArray(r.records)||r.records.length!==1||r.records[0]?.namespace!=='runtime'||r.records[0].key!==key
        ||namespaceRevision(r.records[0].version)===null||!same(r.eventIds,transaction.events.map(value=>value.eventId))
        ||result.replayed!==undefined&&typeof result.replayed!=='boolean')throw Error('Receipt bindings differ.');
      exact(r.records[0],['namespace','key','version'],'Operational receipt record');
    }catch(cause){throw failure('The namespace port returned another operational receipt.','SGOS_OPERATIONAL_PORT_RESULT_INVALID',cause);}
  }
  function uncertain(cause,transaction,next,reconciliationFailure=null) {
    return new SingularityFlowError(cause.message,{code:cause.code??'SGOS_OPERATIONAL_OUTCOME_UNKNOWN',cause,outcomeClass:'OUTCOME_UNKNOWN',
      details:{...(cause.details&&typeof cause.details==='object'?cause.details:{}),operationId:transaction.operationId,
        requestDigest:hash(namespaceTransactionIdentity(scope,transaction,limits)),storeId,namespace:'runtime',
        revision:next.revision,stateSha256:next.stateSha256,
        ...(reconciliationFailure?.code?{reconciliationErrorCode:reconciliationFailure.code}:{})}});
  }
  async function publish(before,events,references) {
    const next=replay(storeId,events).head;
    const lineage=await put({format:'sflow.sgos.namespace-operational-lineage',formatVersion:1,storeId,events:references});
    const value={format:'sflow.sgos.namespace-operational-head',formatVersion:1,projectId:scope.projectId,storeId,profile,
      revision:next.revision,stateSha256:next.stateSha256,eventSha256:next.eventSha256,lineage};
    // SPI v1 has CAS inputs, not a caller operation ID. Distinct invocations must remain
    // competing writes even when their material changes are identical.
    const operationId=`sgos-${randomUUID()}`;
    const transaction=namespaceTransaction({operationId,preconditions:[{namespace:'runtime',key,version:before.version}],
      changes:[{op:'put',namespace:'runtime',key,immutable:false,value}],
      events:[{eventId:operationId,eventType:'sgos.operational-committed',namespace:'runtime',
        payload:{storeId,revision:next.revision,stateSha256:next.stateSha256,lineage}}]},limits);
    let result;
    try {result=await transact(scope,transaction);}
    catch(cause) {
      if(cause?.code==='SDA_NAMESPACE_REVISION_CONFLICT') {
        const error=cas((await load()).head);error.cause=cause;throw error;
      }
      if(cause?.code!=='SDA_NAMESPACE_OUTCOME_UNKNOWN'&&cause?.outcomeClass!=='OUTCOME_UNKNOWN')throw cause;
      // Resolve this exact in-flight metadata write, never repeat an executor or an unknown effect.
      try {result=await inspect(scope,operationId);}catch(reconciliationFailure){throw uncertain(cause,transaction,next,reconciliationFailure);}
      if(result?.status==='missing'&&result.receipt===null)throw uncertain(cause,transaction,next);
      try {receipt(result,transaction);}
      catch(validationFailure){throw uncertain(cause,transaction,next,validationFailure);}
      return clone(next);
    }
    receipt(result,transaction);return clone(next);
  }
  async function append(loaded,input,{operation='transact',rollbackRevision=null}={}) {
    exact(input,['expectedRevision','expectedStateSha256','changes'],'Operational transaction');
    if(input.expectedRevision!==loaded.head.revision||input.expectedStateSha256!==loaded.head.stateSha256)throw cas(loaded.head);
    if(loaded.events.length>=MAXIMUM_EVENTS)fail('Operational Store event count exceeds the installed ceiling.',
      'SGOS_OPERATIONAL_STORE_LIMIT',{maximumEvents:MAXIMUM_EVENTS});
    const changes=normalizedChanges(input.changes,loaded.head.entries),entries=apply(loaded.head.entries,changes);
    const nextEvent=event(storeId,loaded.head,operation,changes,entries,operation==='rollback'?{rollbackRevision}:{});
    bounded(nextEvent,MAXIMUM_BYTES,'Operational event');
    const reference=await put(nextEvent);
    return publish(loaded,[...loaded.events,nextEvent],[...loaded.references,reference]);
  }
  function restorePlan(loaded,backup) {
    const candidate=validateBackup(backup,storeId,profile);
    if(loaded.events.length>candidate.backup.events.length||!loaded.events.every((value,index)=>value.eventSha256===candidate.backup.events[index]?.eventSha256)) {
      fail('Operational backup does not fast-forward the current lineage.','SGOS_OPERATIONAL_RESTORE_DIVERGED');
    }
    const mode=loaded.head.stateSha256===candidate.backup.head.stateSha256?'noop':'fast-forward';
    const core={kind:'sgos-operational-restore-plan',storeId,profile,mode,beforeStateSha256:loaded.head.stateSha256,
      afterStateSha256:candidate.backup.head.stateSha256,backupSha256:candidate.backup.backupSha256};
    return {candidate,mode,confirmationSha256:digest(core),core};
  }
  function rollbackPlan(loaded,revision) {
    if(!Number.isSafeInteger(revision)||revision<0||revision>=loaded.head.revision) {
      fail('Operational rollback revision must name an earlier retained state.','SGOS_OPERATIONAL_ROLLBACK_INVALID');
    }
    const target=loaded.states[revision],core={kind:'sgos-operational-rollback-plan',storeId,profile,
      beforeRevision:loaded.head.revision,beforeStateSha256:loaded.head.stateSha256,targetRevision:revision,targetStateSha256:target.stateSha256};
    return {target,core,confirmationSha256:digest(core)};
  }
  const adapter={spiVersion:SGOS_OPERATIONAL_STORE_SPI_VERSION,role:'operational',profile,storeId,capabilities:SGOS_OPERATIONAL_STORE_CAPABILITIES,
    descriptor(){return Object.freeze({spiVersion:SGOS_OPERATIONAL_STORE_SPI_VERSION,role:'operational',profile,storeId,
      durability:'durable-reconstructable',authorityEligible:false,maximumEntries:MAXIMUM_ENTRIES,maximumEvents:MAXIMUM_EVENTS,
      maximumBytes:MAXIMUM_BYTES,purposes:Object.freeze(['runtime'])});},
    async doctor(){const observed=await adapter.verify();return Object.freeze({status:'ready',profile,storeId,revision:observed.revision,
      durability:'durable-reconstructable',authorityEligible:false});},
    async read(){await queue;return clone((await load()).head);},
    async transact(input){return locked(async()=>append(await load(),input));},
    async verify(){await queue;const loaded=await load();return Object.freeze({valid:true,profile,storeId,revision:loaded.head.revision,
      stateSha256:loaded.head.stateSha256,eventCount:loaded.events.length});},
    async exportBackup(){await queue;const loaded=await load(),core={format:'sflow.sgos.operational-backup',formatVersion:FORMAT_VERSION,
      profile,storeId,events:clone(loaded.events),head:clone(loaded.head)},backup=sealed(core,'backupSha256');
      bounded(backup,MAXIMUM_BYTES,'Operational backup');return clone(backup);},
    async planRestore(backup){await queue;const plan=restorePlan(await load(),backup);return Object.freeze({...plan.core,confirmationSha256:plan.confirmationSha256});},
    async restore({backup,confirmationSha256}){return locked(async()=>{
      const loaded=await load(),plan=restorePlan(loaded,backup);
      if(confirmationSha256!==plan.confirmationSha256)fail('Operational restore confirmation does not match the current plan.',
        'SGOS_OPERATIONAL_RESTORE_STALE',{requiredConfirmationSha256:plan.confirmationSha256});
      let after=loaded.head;
      if(plan.mode==='fast-forward') {
        const references=[...loaded.references];
        for(const nextEvent of plan.candidate.backup.events.slice(loaded.events.length))references.push(await put(nextEvent));
        after=await publish(loaded,plan.candidate.backup.events,references);
      }
      return Object.freeze({restored:plan.mode!=='noop',mode:plan.mode,storeId,profile,revision:after.revision,
        stateSha256:after.stateSha256,planSha256:plan.confirmationSha256});
    });},
    async planRollback(revision){await queue;const plan=rollbackPlan(await load(),revision);return Object.freeze({...plan.core,confirmationSha256:plan.confirmationSha256});},
    async rollback({revision,confirmationSha256}){return locked(async()=>{
      const loaded=await load(),plan=rollbackPlan(loaded,revision);
      if(confirmationSha256!==plan.confirmationSha256)fail('Operational rollback confirmation does not match the current plan.',
        'SGOS_OPERATIONAL_ROLLBACK_STALE',{requiredConfirmationSha256:plan.confirmationSha256});
      const changes=[];
      for(const name of [...new Set([...Object.keys(loaded.head.entries),...Object.keys(plan.target.entries)])].sort()) {
        if(!Object.hasOwn(plan.target.entries,name))changes.push({op:'delete',key:name});
        else if(!Object.hasOwn(loaded.head.entries,name)||!same(loaded.head.entries[name],plan.target.entries[name]))changes.push({op:'put',key:name,value:clone(plan.target.entries[name])});
      }
      if(!changes.length)fail('Operational rollback target has the same material state.','SGOS_OPERATIONAL_ROLLBACK_INVALID');
      const result=await append(loaded,{expectedRevision:loaded.head.revision,expectedStateSha256:loaded.head.stateSha256,changes},
        {operation:'rollback',rollbackRevision:revision});
      return Object.freeze({rolledBack:true,storeId,profile,targetRevision:revision,revision:result.revision,
        stateSha256:result.stateSha256,planSha256:plan.confirmationSha256});
    });}
  };
  return Object.freeze(adapter);
}

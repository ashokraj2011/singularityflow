/** Frozen v1 Story creation identities, shared by the writer and read-only proof owner. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {recordSha256} from '../records.mjs';
import {namespaceIdentityJson,namespaceRevision} from '../sda/namespace/values.mjs';
import {namespaceTransaction,namespaceTransactionIdentity} from '../sda/namespace/transaction.mjs';
import {namespaceJournalReceipt} from '../sda/namespace/journal-contract.mjs';
import {LIFECYCLE_AUTHORITY_KEY,lifecycleRecord} from './namespace-lifecycle-contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-reader.mjs';
import {namespaceStoryRecord} from './namespace-story-contract.mjs';
import {namespaceReadRecord} from './namespace-read-contract.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const identity=value=>hash(namespaceIdentityJson(value));
const same=(a,b)=>namespaceIdentityJson(a)===namespaceIdentityJson(b);
const error=(message,code,cause)=>new SingularityFlowError(message,{code,cause});

export const namespaceStoryGenesisKey=workId=>namespaceLifecycleStoryKey(workId).replace(/\/head$/u,'/genesis');
// Read projections retain their historical record encoding, distinct from lifecycle identities.
export function namespaceStoryReadKey(workId) {
  if(typeof workId!=='string'||!workId||workId.length>2048)throw error('A namespace read host needs one explicit Story ID.','ENGINE_INPUT_INVALID');
  return `stories/${recordSha256({workId})}/read-head`;
}
export function createNamespaceStoryCodec({scope,workId,authority,limits}) {
  const binding={projectId:scope.projectId,workId,authority},headKey=namespaceLifecycleStoryKey(workId),
    genesisKey=namespaceStoryGenesisKey(workId),readKey=namespaceStoryReadKey(workId);
  const keys=operationId=>{const id=identity({binding,operationId});return {prepared:`stories/prepared/${id}`,manifest:`stories/creations/${id}`,
    prepareOperation:`story-prepare-${id}`,operation:`story-create-${id}`,event:`story-create-${id}`};};
  const txDigest=tx=>hash(namespaceTransactionIdentity(scope,tx,limits));
  const parameters=(inputs,{recordId,contentId})=>identity({operation:'story.create',inputs,binding,recordId,contentId});
  const projected=(kind,plan)=>namespaceStoryRecord(kind,Object.fromEntries(Object.entries(plan).filter(([key])=>!['schemaVersion','format','requestDigest'].includes(key))));
  const firstHead=plan=>lifecycleRecord('head',{projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch,sequence:0,
    configuration:plan.configuration,state:plan.state,previous:null,operationId:plan.operationId});
  function transaction(plan,prepare=false) {
    const k=keys(plan.operationId);
    return namespaceTransaction({operationId:prepare?k.prepareOperation:k.operation,preconditions:[
      {namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:plan.authorityVersion},
      {namespace:'config',key:plan.configuration.key,version:plan.configurationVersion},
      {namespace:'state',key:headKey,version:null},{namespace:'state',key:genesisKey,version:null},
      {namespace:'state',key:readKey,version:null},{namespace:'evidence',key:k.manifest,version:null},
      ...(prepare?[{namespace:'runtime',key:k.prepared,version:null}]:[])
    ],changes:prepare?[{op:'put',namespace:'runtime',key:k.prepared,immutable:true,value:plan}]:[
      {op:'put',namespace:'state',key:headKey,immutable:false,value:firstHead(plan)},
      {op:'put',namespace:'state',key:genesisKey,immutable:true,value:projected('genesis',plan)},
      {op:'put',namespace:'state',key:readKey,immutable:false,value:namespaceReadRecord('lifecycle-head',{
        projectId:scope.projectId,workId,lifecycleHead:headKey,authority})},
      {op:'put',namespace:'evidence',key:k.manifest,immutable:true,value:projected('manifest',plan)}
    ],events:prepare?[]:[{eventId:k.event,eventType:'engine.story-created',namespace:'state',payload:{workId,configuration:plan.configuration,
      source:plan.source,principalId:plan.actor.principalId,authorityId:authority.id,epoch:authority.epoch}}]},limits);
  }
  function receipt(result,tx) {
    let r;
    try {r=namespaceJournalReceipt(result?.receipt,scope,tx.operationId);
      if(result.status!=='committed'||r.requestDigest!==txDigest(tx)||result.replayed!==undefined&&typeof result.replayed!=='boolean'
        ||r.records.length!==tx.changes.length||r.records.some(item=>namespaceRevision(item.version)===null
          ||!tx.changes.some(change=>change.namespace===item.namespace&&change.key===item.key))
        ||!same(r.eventIds,tx.events.map(event=>event.eventId)))throw new Error('Another transaction binding.');
    }catch(cause){throw error('Inspect the original Story creation operation: its receipt is invalid.','ENGINE_PORT_RESULT_INVALID',cause);}
    return r;
  }
  return Object.freeze({keys,parameters,txDigest,projected,firstHead,transaction,receipt,headKey,genesisKey,readKey});
}

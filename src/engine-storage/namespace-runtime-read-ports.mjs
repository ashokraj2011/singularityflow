/** Read-only SGOS replay capabilities over an already scoped, verified Story observer. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {contentStoreDescriptor} from '../sda/content/contract.mjs';
export function namespaceRuntimeReadPorts(observer,scope){
  const denied=()=>{throw new SingularityFlowError('Retained execution inspection cannot write or execute.',{code:'ENGINE_READ_ONLY'});},
    sameScope=selected=>{if(canonicalJson(selected)!==canonicalJson(scope))throw new SingularityFlowError('Use the bound execution project.',{code:'ACTIVE_SUBJECT_MISMATCH'});};
  const records=Object.freeze({descriptor:observer.evidenceReads.records.descriptor,
    async read(selected,namespace,key,{signal}={}){sameScope(selected);const row=await observer.record(namespace,key,false,signal,true);
      // Runtime operational heads are mutable. Their immutable lineage lives in content.
      return row?{status:'present',record:{namespace,key,immutable:false,version:row.version,value:row.value}}:{status:'missing',record:null};},
    list:denied,transact:denied,verify:denied,inspectOperation:observer.evidenceReads.records.inspectOperation});
  const content=Object.freeze({descriptor:contentStoreDescriptor({id:'retained-execution-content',binding:{kind:'shared'},maximumBytes:64*1024*1024}),
    put:denied,async read(selected,reference,{maximumBytes,signal}={}){sameScope(selected);const data=await observer.bytes(reference,maximumBytes??reference.bytes,signal);
      return {status:'present',reference,data,truncated:data.byteLength<reference.bytes};}});
  return Object.freeze({records,content});
}

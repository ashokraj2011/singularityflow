/** Full immutable reads from one explicit device. This reader cannot publish bytes. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {validateContentStore,contentReference} from '../sda/content/contract.mjs';
export function createNamespaceLocalContentReader({content,scope}) {
  if(content){validateContentStore(content);if(content.descriptor.binding.kind!=='machine-local')throw new SingularityFlowError(
    'Local inputs need an explicit device-bound content store.',{code:'ENGINE_INPUT_INVALID'});}
  const read=content?.read.bind(content);
  return async(reference,{signal}={})=>{
    contentReference(reference);if(reference.namespace!=='local')throw new SingularityFlowError('Read one issued local content reference.',{code:'ENGINE_INPUT_INVALID'});
    if(!read)throw new SingularityFlowError('The local input store is not bound on this device.',{code:'ENGINE_STORAGE_CONTENT_MISSING'});
    const result=await read(scope,reference,{maximumBytes:reference.bytes,signal});
    if(result?.status==='missing'&&result.data===null)throw new SingularityFlowError('The original input is unavailable on this device.',{
      code:'ENGINE_STORAGE_CONTENT_MISSING',details:{reference}});
    if(result?.status!=='present'||!(result.data instanceof Uint8Array)||result.data.byteLength!==reference.bytes||result.truncated!==false
      ||canonicalJson(result.reference)!==canonicalJson(reference))throw new SingularityFlowError('The local content reader returned another binding.',{code:'ENGINE_PORT_RESULT_INVALID'});
    if(createHash('sha256').update(result.data).digest('hex')!==reference.sha256)throw new SingularityFlowError('Local input content differs from its original hash.',{code:'ENGINE_STORAGE_CORRUPT'});
    return Buffer.from(result.data);
  };
}

/** Chunk actual source bytes through supplied SGOS/SDA capabilities; no physical location discovery. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {validateSourceContentReader,sourceContentReadResult,SOURCE_CONTENT_MAXIMUM_CHUNKS} from '../foundation/source-snapshot.mjs';
import {contentReference} from '../sda/content/contract.mjs';
const hash=data=>createHash('sha256').update(data).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code='ENGINE_INPUT_INVALID',details=null)=>new SingularityFlowError(message,{code,details});
function cancelled(signal){if(signal?.aborted)throw error('Source retention was cancelled; the draft and prepared evidence are preserved.','ENGINE_OPERATION_CANCELLED');}
export function createNamespaceSourceContent({scope,content,observer,sourceReaders=[]}={}) {
  if(!Array.isArray(sourceReaders)||sourceReaders.length>32)throw error('Bind a bounded explicit source content-reader list.');
  const readers=new Map(),ids=new Set();
  for(const port of sourceReaders){const descriptor=validateSourceContentReader(port),id=descriptor.source.repositoryId;
    if(descriptor.source.projectId!==scope.projectId||readers.has(id)||ids.has(descriptor.id))throw error('Content readers must be distinct and project bound.');
    readers.set(id,{descriptor,read:port.read.bind(port)});ids.add(descriptor.id);}
  const put=content.put.bind(content),maximumBytes=content.descriptor.maximumBytes;
  async function shared(data,namespace,signal) {
    cancelled(signal);const expected={namespace,sha256:hash(data),bytes:data.byteLength},saved=await put(scope,namespace,data,{signal});
    if(!same(contentReference(saved?.reference),expected)||typeof saved.reused!=='boolean')throw error('The content store acknowledged other source bytes.','ENGINE_PORT_RESULT_INVALID');
    await observer.bytes(expected,expected.bytes,signal);return expected;
  }
  function bound(repository,expected,{operation}={}) {
    if(expected===null)return null;const found=readers.get(repository.id);
    if(!found||!same(found.descriptor,expected)||!same(found.descriptor.source,repository.descriptor))throw error(
      'Bind the prepared source content reader before resuming retention.','ENGINE_SOURCE_CONTENT_READER_UNAVAILABLE',{
        repositoryId:repository.id,readerId:expected?.id??null,...(operation?{operation}:{})});
    return found;
  }
  async function retain(entry,reader,{signal,budget={chunks:0},repositoryId}={}) {
    const digest=createHash('sha256'),chunks=[];let offset=0;
    while(offset<entry.bytes){cancelled(signal);
      if(++budget.chunks>SOURCE_CONTENT_MAXIMUM_CHUNKS)throw error('The repository exceeds its bounded source chunk set.','ENGINE_STORAGE_LIMIT');
      if(!reader)throw error('Bind a content reader for the selected nonempty file.','ENGINE_SOURCE_CONTENT_READER_UNAVAILABLE',{repositoryId,path:entry.path});
      const request={entry,offset,maximumBytes:Math.min(reader.descriptor.maximumChunkBytes,maximumBytes,1_048_576,entry.bytes-offset)};
      const result=sourceContentReadResult(await reader.read(request,{signal}),request,reader.descriptor),data=Buffer.from(result.data);
      digest.update(data);chunks.push(await shared(data,'evidence',signal));offset+=data.byteLength;
    }
    if(digest.digest('hex')!==entry.sha256)throw error('Read bytes do not match the selected source snapshot; the draft is preserved.','ENGINE_SOURCE_CHANGED',{
      repositoryId,path:entry.path,stage:'retain-bytes'});
    return {chunks,bytes:offset};
  }
  return Object.freeze({readers,shared,bound,retain});
}

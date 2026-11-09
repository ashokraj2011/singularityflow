/** Reconstruct retained file bytes through a read-only content port. No writes or source I/O. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {SOURCE_CONTENT_MAXIMUM_CHUNKS} from '../foundation/source-snapshot.mjs';
import {contentReference} from '../sda/content/contract.mjs';
const corrupt=message=>{throw new SingularityFlowError(message,{code:'ENGINE_STORAGE_CORRUPT'});};
export async function verifySourceFileChunks(entry,chunks,{maximumChunkBytes,read,signal}={}) {
  if(!Array.isArray(chunks)||chunks.length>SOURCE_CONTENT_MAXIMUM_CHUNKS)corrupt('The retained file has an unbounded chunk set.');
  const digest=createHash('sha256');let bytes=0;
  for(const chunk of chunks){
    const reference=contentReference(chunk),maximum=Math.min(maximumChunkBytes??1,1_048_576);
    if(reference.namespace!=='evidence'||reference.bytes<1||reference.bytes>maximum||bytes+reference.bytes>entry.bytes) {
      corrupt('A retained chunk exceeds its exact file range.');
    }
    digest.update(await read(reference,reference.bytes,signal));bytes+=reference.bytes;
  }
  if(bytes!==entry.bytes||digest.digest('hex')!==entry.sha256)corrupt('Retained source chunks do not reconstruct the observed file.');
  return {bytes,chunks:chunks.length};
}

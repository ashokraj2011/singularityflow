/** Explicit candidate bytes never replace reads of accepted immutable evidence. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
export async function namespaceCandidateContent(observer,reference,{signal,artifactBytes}={}) {
  if(artifactBytes===undefined)return observer.bytes(reference,reference.bytes,signal);
  if(!(artifactBytes instanceof Uint8Array)||artifactBytes.byteLength!==reference.bytes
    ||createHash('sha256').update(artifactBytes).digest('hex')!==reference.sha256)throw new SingularityFlowError(
    'Inspect the exact bytes bound by the candidate artifact reference.',{code:'ENGINE_INPUT_INVALID'});
  return Buffer.from(artifactBytes);
}

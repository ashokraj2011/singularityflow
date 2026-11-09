/** Native reads over the shared implementation-binding replay. Git and legacy best-effort reads stay here. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {buildComprehensionDiffPreview} from './comprehension/diff-preview.mjs';
import {SingularityFlowError} from './foundation/failures.mjs';
import {implementationBindingsReplay} from './engine-compatibility/node-source-analysis.mjs';
export {clauseTagExplanation,EXPLANATION_LIMITS,reviewBindings,BINDING_DECISIONS} from './kernel/code-delivery-evidence.mjs';
export {implementationBindingsDigest as bindingsDigest} from './engine-compatibility/node-source-policy.mjs';

export async function implementationBindings(root,{changeSet,required=[],tags=[]}) {
  const replay=implementationBindingsReplay({changeSet,required,tags});let value;
  for(;;) {
    const step=replay.next(value);if(step.done)return step.value;const request=step.value;
    if(request.kind==='implementation-diff-preview')value=buildComprehensionDiffPreview(root,request.changeSet,{contextLines:request.contextLines,paths:request.paths});
    else if(request.kind==='implementation-source') {
      const bytes=await readFile(path.join(root,...request.path.split('/'))).catch(()=>null);
      value=bytes&&bytes.length<=request.maximumBytes&&!bytes.includes(0)?bytes.toString('utf8'):null;
    }else throw new SingularityFlowError('Unknown implementation-binding evidence request.',{code:'ENGINE_PORT_UNAVAILABLE'});
  }
}

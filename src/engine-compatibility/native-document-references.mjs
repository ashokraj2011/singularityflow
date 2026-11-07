/** Native retained identities shared by reference manifests and byte readers. */
import path from 'node:path';
import {agentBriefReviewDocuments} from '../agent-briefs.mjs';
import {recordSha256} from '../records.mjs';
import {workDirRelative} from '../story-paths.mjs';
import {mimeType} from '../documents-read.mjs';

/** A complete retained inventory is distinct from a discovery catalog that omits missing files. */
export function retainedPhaseInventory(config,workflow,phase,observations) {
  const primary=path.posix.join(workDirRelative(config,workflow.workItem.id),phase.requiredArtifact?.path??'');
  const identity=(role,file)=>JSON.stringify([role,file]);
  const result=[...observations],paths=new Set(result.map(({record})=>identity(record.type,record.path)));
  for(const artifact of phase.artifacts??[]) {
    if(!artifact.path||paths.has(identity('artifact',artifact.path)))continue;
    paths.add(identity('artifact',artifact.path));
    result.push({record:{id:artifact.path===primary?`PHASE-${phase.id.toUpperCase()}`:`ART-RETAINED-${recordSha256(artifact.path).slice(0,20)}`,
      type:'artifact',path:artifact.path,phase:phase.id,generation:phase.generation,
      kind:artifact.kind??phase.requiredArtifact?.kind??'unknown',mimeType:mimeType(artifact.path),
      size:artifact.size??null,sha256:artifact.sha256??null}});
  }
  for(const brief of agentBriefReviewDocuments(workflow,phase)) {
    if(!brief.id||!brief.path||paths.has(identity('agent-brief',brief.path)))continue;
    paths.add(identity('agent-brief',brief.path));
    result.push({record:{...brief,type:'agent-brief',phase:phase.id,kind:'agent-brief',mimeType:'text/markdown',size:null}});
  }
  return {primary,observations:result};
}

export function phaseDocumentReference(workId,phase,record) {
  return {kind:'phase-document',id:`review-document-${recordSha256({workId,phase:phase.id,
    generation:phase.generation,path:record.path,role:record.type})}`,workId,phase:phase.id,generation:Number(phase.generation??0)};
}

/** Installed document/proof readers for phase review; no command handler or new approval path. */
import path from 'node:path';
import {head} from '../git.mjs';
import {loadAcceptedStoryExecution} from '../accepted-story-execution.mjs';
import {documentPolicy,mimeType,readDocumentRecord} from '../documents-read.mjs';
import {agentBriefReviewDocuments} from '../agent-briefs.mjs';
import {recordSha256} from '../records.mjs';
import {workDirRelative} from '../story-paths.mjs';
import {inspectNativePhaseReview} from './native-phase-review.mjs';
import {measureCommandSpan} from '../dx-timing-context.mjs';

function failure(error,depth=0) {
  if(error==null)return null;
  const result={name:error.name??'Error',message:error.message??String(error),code:error.code??null,
    details:error.details??null,cause:null};
  for(const key of ['errno','syscall','path','dest','exitCode'])if(error[key]!=null)result[key]=error[key];
  if(error.cause!=null) {
    if(depth<8)result.cause=failure(error.cause,depth+1);
    else result.cause={truncated:true};
  }
  return result;
}

/** A complete retained inventory is distinct from a discovery catalog that omits missing files. */
function retainedInventory(config,workflow,phase,observations) {
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

export function createGitPhaseReviewPort({root,presentation=null,onContext=()=>{}}) {
  // Rendering preferences are trusted host composition, never public operation inputs.
  const presentationOptions=presentation?Object.freeze({includeContinuation:presentation.includeContinuation===true,
    includeApprovalCheck:presentation.includeApprovalCheck!==false,includeSheet:presentation.includeSheet===true}):null;
  return {
    async load() {
      const accepted=await loadAcceptedStoryExecution(root);
      const context={root,config:accepted.definition,workflow:accepted.workflow,
        subject:{kind:'story',id:accepted.workflow.workItem.id},revision:head(root)};
      onContext(context);
      return context;
    },
    async read(context,selection) {
      const {config,workflow}=context,phase=workflow.phases[selection.phase];
      const inspected=await measureCommandSpan('phase.review',()=>inspectNativePhaseReview(root,config,workflow,phase,presentationOptions));
      Object.assign(context,{phase,review:inspected.review});
      const inventory=retainedInventory(config,workflow,phase,inspected.observations),documents=[];
      for(const observation of inventory.observations) {
        const {record}=observation;
        let {viewed,error}=observation;
        if(!viewed&&!error) {
          try{viewed=await readDocumentRecord(root,config,workflow,record);}catch(cause){error=cause;}
        }
        const registered=record.type==='artifact'?(phase.artifacts??[]).find(item=>item.path===record.path):null;
        const expectedSha256=registered?.sha256??(record.type==='agent-brief'?record.sha256:null);
        const expectedBytes=registered?.size??null;
        documents.push({id:record.id,reference:`review-document-${recordSha256({workId:workflow.workItem.id,
          phase:phase.id,generation:phase.generation,path:record.path,role:record.type})}`,
          sourceKey:record.path,role:record.type,kind:record.kind??'unknown',mimeType:record.mimeType??mimeType(record.path),
          generation:Number(record.generation??phase.generation),primary:record.path===inventory.primary,
          expected:expectedSha256?{sha256:expectedSha256,bytes:expectedBytes??null}:null,
          observed:viewed&&!error?{sha256:viewed.verifiedSha256,bytes:viewed.size,binary:viewed.binary}:null,error:failure(error)});
      }
      const candidate=inspected.reviewBinding,display=workflow.resolution?.codeDelivery?.display??{};
      return {workId:workflow.workItem.id,phase:phase.id,generation:Number(phase.generation??0),status:phase.status,
        revision:context.revision,budgets:{previewBytes:documentPolicy(workflow,config).maxPreviewBytes??1048576,
          sourcePreviewBytes:display.previewBytes??4096,sourceFullBytes:display.fullDocumentMaximumBytes??65536},documents,
        reviewBinding:candidate?{workId:candidate.workId,phase:candidate.phase,generation:candidate.generation,
          packetSha256:candidate.reviewPacketSha256,sourceRevision:candidate.submittedSourceCommit,
          observedRevision:candidate.repositoryHead}:null};
    }
  };
}

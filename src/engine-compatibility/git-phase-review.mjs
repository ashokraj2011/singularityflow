/** Installed document/proof readers for phase review; no command handler or new approval path. */
import {head} from '../git.mjs';
import {loadAcceptedStoryExecution} from '../accepted-story-execution.mjs';
import {documentPolicy,mimeType,readDocumentRecord} from '../documents-read.mjs';
import {inspectNativePhaseReview} from './native-phase-review.mjs';
import {measureCommandSpan} from '../dx-timing-context.mjs';
import {retainedPhaseInventory,phaseDocumentReference} from './native-document-references.mjs';

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
      const inventory=retainedPhaseInventory(config,workflow,phase,inspected.observations),documents=[];
      for(const observation of inventory.observations) {
        const {record}=observation;
        let {viewed,error}=observation;
        if(!viewed&&!error) {
          try{viewed=await readDocumentRecord(root,config,workflow,record);}catch(cause){error=cause;}
        }
        const registered=record.type==='artifact'?(phase.artifacts??[]).find(item=>item.path===record.path):null;
        const expectedSha256=registered?.sha256??(record.type==='agent-brief'?record.sha256:null);
        const expectedBytes=registered?.size??null;
        documents.push({id:record.id,reference:phaseDocumentReference(workflow.workItem.id,phase,record).id,
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

/** Canonical native byte reads. The host alone receives filesystem paths and legacy display data. */
import {head} from '../git.mjs';
import {loadAcceptedStoryExecution} from '../accepted-story-execution.mjs';
import {createDocumentReadSession,readDocumentRecord,documentPolicy,mimeType,utf8Prefix} from '../documents-read.mjs';
import {isLocalDocument} from '../document-storage.mjs';
import {resolveDocumentRecord} from '../document-identity.mjs';
import {retainedPhaseInventory,phaseDocumentReference} from './native-document-references.mjs';

const textMarker='\n… preview truncated …\n',extractedMarker='\n… extracted text truncated …\n';
function boundedContent(viewed,maximumBytes) {
  const extracted=viewed.rendition?.status==='extracted',value=extracted?viewed.rendition:viewed;
  if(viewed.binary&&!extracted||value.content==null&&!extracted)return null;
  let text=extracted?value.text:value.content;
  const marker=extracted?extractedMarker:textMarker;
  if(value.truncated&&text.endsWith(marker))text=text.slice(0,-marker.length);
  const prefix=utf8Prefix(text,maximumBytes);
  return {kind:extracted?'extracted-text':'text',text:prefix.text,bytes:prefix.bytes,truncated:value.truncated||prefix.truncated,
    ...(extracted?{sha256:value.sha256,extractor:value.extractor,version:value.version}:{})};
}

export function createGitDocumentReadPort({root,onContext=()=>{}}) {
  return {
    async load(inputs) {
      const requested=inputs.workId??(typeof inputs.reference==='object'?inputs.reference.workId:null);
      const accepted=await loadAcceptedStoryExecution(root,requested);
      const context={root,config:accepted.definition,workflow:accepted.workflow,
        subject:{kind:'story',id:accepted.workflow.workItem.id},revision:head(root)};
      onContext(context);
      return context;
    },
    async resolve(context,selection) {
      const {config,workflow}=context;
      const session=await createDocumentReadSession(root,config,workflow,{includeDetached:selection.includeDetached});
      const request=selection.reference;
      let record;
      if(typeof request==='object'&&request.kind==='phase-document') {
        const phase=workflow.phases[request.phase];
        const visible=session.records.filter(record=>record.phase===phase.id&&['artifact','agent-brief'].includes(record.type));
        const inventory=retainedPhaseInventory(config,workflow,phase,visible.map(record=>({record})));
        const candidates=inventory.observations.filter(({record})=>phaseDocumentReference(workflow.workItem.id,phase,record).id===request.id);
        record=candidates.length===1?candidates[0].record:resolveDocumentRecord([],request.id);
        // A phase reference reads retained bytes, even if discovery hashed a dirty primary file.
        const retained=record.type==='artifact'?(phase.artifacts??[]).find(item=>item.path===record.path):null;
        if(retained?.sha256)record={...record,sha256:retained.sha256,size:retained.size??null};
      } else record=resolveDocumentRecord(session.records,typeof request==='string'?request:request.id);
      record=structuredClone(record);
      const phase=record.phase!=null&&Object.hasOwn(workflow.phases,record.phase)?workflow.phases[record.phase]:null;
      const retained=record.type==='artifact'?(phase?.artifacts??[]).find(item=>item.path===record.path):null;
      const sha256=record.type==='artifact'?retained?.sha256
        :['agent-brief','file'].includes(record.type)?record.sha256:null;
      const size=record.type==='artifact'?retained?.size:record.type==='file'?record.size:null;
      const reference=['artifact','agent-brief'].includes(record.type)&&phase
        ?phaseDocumentReference(workflow.workItem.id,phase,record):{kind:'story-document',id:record.id,workId:workflow.workItem.id};
      const maximumBytes=Math.min(documentPolicy(workflow,config).maxPreviewBytes??1_048_576,selection.maximumBytes);
      Object.assign(context,{record,session});
      return {workId:workflow.workItem.id,id:record.id,reference,phase:phase?.id??null,generation:phase?Number(phase.generation??0):null,
        sourceKey:record.path??null,role:record.type,name:record.name??record.label??null,kind:record.kind??record.type,
        mimeType:record.mimeType??(record.type==='url'?'text/uri-list':mimeType(record.path??record.name??'')),
        locality:record.type==='url'?'external':isLocalDocument(record)?'machine-local':'project',
        expected:sha256?{sha256,bytes:size??null}:null,maximumBytes,uri:record.type==='url'?record.url:null};
    },
    async read(context,binding) {
      const {config,workflow,record,session}=context;
      await session.assertUnchanged();
      const result=await readDocumentRecord(root,config,workflow,record);
      await session.assertUnchanged();
      context.result=result;
      return {id:record.id,revision:context.revision,
        observed:record.type==='url'?null:{sha256:result.verifiedSha256,bytes:result.size,binary:result.binary},
        content:boundedContent(result,binding.maximumBytes),
        extractionFailure:result.rendition?.status==='unreadable'?{reason:result.rendition.reason}:null};
    }
  };
}

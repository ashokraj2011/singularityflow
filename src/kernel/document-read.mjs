/** Document selection and bounded body contracts. Storage and rendering belong to trusted ports. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseReviewSelection} from './phase-policy.mjs';

export const MAXIMUM_DOCUMENT_READ_BYTES=1_048_576;
const text=value=>typeof value==='string'&&value.length>0&&value.length<=2048;
const bytes=value=>Number.isSafeInteger(value)&&value>=0;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).every(key=>allowed.includes(key));
const sameReference=(left,right)=>['kind','id','workId','phase','generation'].every(key=>left[key]===right[key]);
function bad(){throw new SingularityFlowError('The document read port returned invalid or differently bound facts.',{code:'ENGINE_PORT_RESULT_INVALID'});}

export function validDocumentReference(value) {
  if(typeof value==='string')return text(value);
  if(!keys(value,['kind','id','workId','phase','generation'])||!text(value.id)||!text(value.workId))return false;
  if(value.kind==='story-document')return Object.keys(value).length===3;
  return value.kind==='phase-document'&&Object.keys(value).length===5&&text(value.phase)&&bytes(value.generation);
}

/** Capture native aliases and retained generation/hash bindings before asynchronous resolution. */
export function documentReadSelection(workflow,inputs) {
  const workId=workflow.workItem.id,reference=inputs.reference;
  const aliases=[workId,workflow.workItem.branch,workflow.lineage?.canonicalBranch,
    ...(workflow.lineage?.childBranches??[]).map(entry=>entry.name)].filter(Boolean);
  if(inputs.workId!=null&&!aliases.includes(inputs.workId)||typeof reference==='object'&&reference.workId!==workId) {
    throw new SingularityFlowError('Requested Story does not match the document checkout.',{code:'ACTIVE_SUBJECT_MISMATCH',
      details:{expectedWorkId:typeof reference==='object'?reference.workId:inputs.workId,actualWorkId:workId}});
  }
  const phases=typeof reference==='object'&&reference.kind==='phase-document'
    ?[phaseReviewSelection(workflow,reference.phase)]
    :Object.keys(workflow.phases??{}).map(id=>phaseReviewSelection(workflow,id));
  if(typeof reference==='object'&&reference.kind==='phase-document'&&reference.generation!==phases[0].generation) {
    throw new SingularityFlowError('The document reference belongs to a different phase generation. Read the phase again.',{
      code:'DOCUMENT_REFERENCE_STALE',details:{workId,phase:reference.phase,expectedGeneration:reference.generation,
        actualGeneration:phases[0].generation}});
  }
  return {workId,reference,phases,includeDetached:inputs.includeDetached===true,
    maximumBytes:inputs.maximumBytes??MAXIMUM_DOCUMENT_READ_BYTES};
}

/** Bind the resolved member to the captured inventory; discovery cannot replace retained hashes. */
export function documentReadBinding(selection,facts) {
  if(!keys(facts,['workId','id','reference','phase','generation','sourceKey','role','name','kind','mimeType','locality','expected','maximumBytes','uri'])
    ||facts.workId!==selection.workId||!text(facts.id)||!validDocumentReference(facts.reference)||typeof facts.reference==='string'
    ||facts.reference.workId!==selection.workId||!['artifact','agent-brief','file','url','system','package'].includes(facts.role)
    ||facts.name!==null&&!text(facts.name)||!text(facts.kind)||!text(facts.mimeType)
    ||!['machine-local','project','external'].includes(facts.locality)||!bytes(facts.maximumBytes)||facts.maximumBytes>selection.maximumBytes
    ||facts.sourceKey!==null&&!text(facts.sourceKey)
    ||facts.expected!==null&&(!keys(facts.expected,['sha256','bytes'])||Object.keys(facts.expected).length!==2
      ||!digest(facts.expected.sha256)||facts.expected.bytes!==null&&!bytes(facts.expected.bytes)))bad();
  if(typeof selection.reference==='object'&&!sameReference(selection.reference,facts.reference))bad();
  const phase=selection.phases.find(phase=>phase.phase===facts.phase);
  if(facts.phase===null?facts.generation!==null:!phase||facts.generation!==phase.generation)bad();
  if(facts.reference.kind==='phase-document') {
    if(!['artifact','agent-brief'].includes(facts.role)||facts.reference.phase!==facts.phase
      ||facts.reference.generation!==facts.generation)bad();
  } else if(facts.reference.id!==facts.id)bad();
  const retained=phase?.retained.find(item=>item.sourceKey===facts.sourceKey&&item.role===facts.role);
  let provenance='snapshot';
  if(['artifact','agent-brief'].includes(facts.role)) {
    if(retained?.sha256?facts.expected?.sha256!==retained.sha256||facts.expected?.bytes!==retained.bytes:facts.expected!==null)bad();
    provenance=retained?.sha256?'retained':'snapshot';
  } else if(facts.role==='file')provenance='catalog';
  else if(facts.expected!==null)bad();
  if(facts.role==='url') {
    if(typeof facts.uri!=='string'||!facts.uri||facts.uri.length>MAXIMUM_DOCUMENT_READ_BYTES
      ||facts.locality!=='external'||facts.expected!==null)bad();
    provenance='external';
  } else if(facts.uri!==null||facts.locality==='external')bad();
  return {...facts,provenance};
}

function utf8Bytes(value) {
  let count=0;
  for(const character of value) {
    const code=character.codePointAt(0);
    count+=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;
  }
  return count;
}

export function documentReadResult(binding,facts) {
  if(!keys(facts,['id','revision','observed','content','extractionFailure'])||facts.id!==binding.id||!text(facts.revision))bad();
  const observed=facts.observed,content=facts.content;
  if(facts.extractionFailure!==null&&(!keys(facts.extractionFailure,['reason'])
    ||!text(facts.extractionFailure.reason)||!observed?.binary||content!==null))bad();
  if(binding.role==='url') {if(observed!==null||content!==null)bad();}
  else {
    if(!keys(observed,['sha256','bytes','binary'])||Object.keys(observed).length!==3||!digest(observed.sha256)
      ||!bytes(observed.bytes)||typeof observed.binary!=='boolean')bad();
    if(content!==null) {
      if(!keys(content,['kind','text','bytes','truncated','sha256','extractor','version'])||!['text','extracted-text'].includes(content.kind)
        ||typeof content.text!=='string'||!bytes(content.bytes)||content.bytes>binding.maximumBytes
        ||utf8Bytes(content.text)!==content.bytes||typeof content.truncated!=='boolean')bad();
      if(content.kind==='text') {
        if(observed.binary||Object.keys(content).length!==4||content.bytes<observed.bytes&&!content.truncated)bad();
      } else if(!observed.binary||Object.keys(content).length!==7||!digest(content.sha256)
        ||!text(content.extractor)||!Number.isSafeInteger(content.version)||content.version<1)bad();
    } else if(!observed.binary)bad();
  }
  const integrity=!observed?'reference-only':!binding.expected?'unbound'
    :observed.sha256===binding.expected.sha256&&(binding.expected.bytes===null||observed.bytes===binding.expected.bytes)?'matched':'changed';
  return {schemaVersion:1,contract:'sflow-document-read/v1',id:binding.id,reference:binding.reference,
    phase:binding.phase,generation:binding.generation,role:binding.role,name:binding.name,kind:binding.kind,
    mimeType:binding.mimeType,locality:binding.locality,provenance:binding.provenance,expected:binding.expected,
    observed,integrity,budgetBytes:binding.maximumBytes,uri:binding.uri,content,extractionFailure:facts.extractionFailure};
}

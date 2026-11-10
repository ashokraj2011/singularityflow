/** Read-only declared input inventory. Local attachment bytes never enter shared records. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {approvedInputPhases,resolvedPhaseInputs,workflowInputsMode} from '../kernel/phase-inputs.mjs';
import {pinnedTestEvidenceSource} from '../kernel/phase-policy.mjs';
import {createNamespaceInputDocumentOwners} from './namespace-input-documents-reader.mjs';
import {createNamespacePlanDecisionOwners} from './namespace-plan-decisions-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function utf8(data,label) {try {const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);if(text.includes('\0'))throw Error('NUL');return text;}
  catch(cause){throw error(`${label} must be UTF-8 text without NUL bytes.`,'ENGINE_ARTIFACT_ENCODING_INVALID',null,cause);}}
/** Constructing this reader performs no reads. The caller provides exact approved proofs. */
export function createNamespacePhaseResources({observer,packets,workId,localRead}) {
  const inputs=createNamespaceInputDocumentOwners({observer,scope:observer.evidenceReads.scope,workId});
  async function resources(captured,approved,agent,signal) {
    const w=captured.snapshot.workflow,phase=captured.phase,result=[];
    await inputs.admitted(captured.snapshot,{signal});
    const source=w.workItem.source?.content;
    if(!source)throw error('The Story has no retained source.','ENGINE_STORAGE_CONTENT_MISSING');
    utf8(await observer.bytes(source,source.bytes,signal),'Story source');result.push({kind:'story-source',id:'story-source',reference:source});
    for(const document of w.namespaceDocuments??[]) {
      if(document.role!=='file'||document.id==='story-source'||document.status==='detached'
        ||document.phase!==null&&document.phase!==undefined&&document.phase!==phase.id)continue;
      if(document.locality==='machine-local') {
        try {await localRead(document.content,{signal});}
        catch(cause){if(cause.code!=='ENGINE_STORAGE_CONTENT_MISSING')throw cause;
          throw error('This phase needs the matching original document on this device.','DOCUMENT_REUPLOAD_REQUIRED',{
            workId,phase:phase.id,documentId:document.id,name:document.name,expected:document.content},cause);}
      }else await observer.bytes(document.content,document.content.bytes,signal);
      result.push({kind:'supporting-document',id:document.id,locality:document.locality,reference:document.content});
    }
    const testSource=pinnedTestEvidenceSource(w,phase),inputPhases=[...new Set([...approvedInputPhases(w,phase),...(testSource?[testSource]:[])])],available=inputPhases.filter(id=>w.phases[id]?.status==='approved');
    const proofs=await packets.inspectApprovedMany(captured.snapshot,available,{signal});
    const acceptedInputs=new Map(available.map((id,index)=>[id,proofs[index]]));
    for(const id of inputPhases) {
      const producer=w.phases[id],declarations=resolvedPhaseInputs(w,phase),optional=id!==testSource&&!declarations.some(item=>(typeof item==='string'?item:item.phase)===id&&(typeof item==='string'||item.required!==false));
      if(!producer||producer.status!=='approved') {
        if(id!==testSource&&(optional||workflowInputsMode(w)!=='enforce'))continue;
        throw error('An upstream input has no accepted generation.','PHASE_INPUTS_NOT_READY',{upstreamPhase:id});
      }
      const document=(w.namespaceDocuments??[]).find(item=>item.phase===id&&item.generation===producer.generation&&item.role==='artifact');
      const retained=(producer.artifacts??[]).find(item=>item.path===document?.sourceKey);
      if(!document?.content||!retained||retained.sha256!==document.content.sha256)throw error('The approved input has no matching retained content binding.','PHASE_INPUTS_NOT_READY',{upstreamPhase:id});
      const proof=acceptedInputs.get(id);
      if(!proof||proof.value.generation!==producer.generation||proof.published.artifact.sourceKey!==document.sourceKey
        ||!same(proof.published.artifact.content,document.content))throw error('The approved input differs from its accepted publication and human review.',
        'PHASE_INPUTS_NOT_READY',{upstreamPhase:id});
      await observer.bytes(document.content,document.content.bytes,signal);
      result.push({kind:'approved-input',phase:id,generation:producer.generation,reference:document.content,
        contract:declarations.filter(item=>(typeof item==='string'?item:item.phase)===id)});
      for(const evidence of packets.publicationResources(proof.published).filter(row=>['code-delivery','code-inputs','conformance','artifact-set','artifact-set-member','retained-output','constitution-policy'].includes(row.kind))){
        const resources=(w.namespaceDocuments??[]).filter(row=>row.phase===id&&row.generation===producer.generation&&row.role==='file'
          &&row.kind===evidence.kind&&row.status!=='detached'&&row.locality==='project'&&same(row.content,evidence.reference)&&(!evidence.sourceKey||row.sourceKey===evidence.sourceKey));
        if(resources.length!==1)throw error('The approved Code input has no unique readable evidence document.','ENGINE_STORAGE_CORRUPT',{upstreamPhase:id,kind:evidence.kind});
        await observer.bytes(evidence.reference,evidence.reference.bytes,signal);
        result.push({kind:'supporting-document',id:resources[0].id,locality:'project',reference:evidence.reference});
      }
    }
    // New correction profiles add their exact retained human records. Historical manifests that
    // predate this profile keep their original input inventory, including legacy PAM-only ones.
    if((w.namespaceDecisionReceipts??[]).some(row=>row.operation==='plan.correction.record')){
      const decisions=await createNamespacePlanDecisionOwners({observer,scope:observer.evidenceReads.scope,workId}).projection(captured.snapshot,{signal});
      if(decisions.rows.length!==decisions.receipts.length)throw error('The plan decision inventory lost its exact accepted records.','ENGINE_STORAGE_CORRUPT');
      for(const [index,row]of decisions.rows.entries()){
        if(row.kind==='plan-row-correction'&&(w.phases[row.ownerPhase]?.generation!==row.ownerGeneration||w.phases[row.ownerPhase]?.status!=='approved'))continue;
        const reference=decisions.receipts[index].record;await observer.bytes(reference,reference.bytes,signal);
        result.push({kind:'supporting-document',id:(row.kind==='plan-row-correction'?'plan-correction-':'plan-amendment-')+row.id,locality:'project',reference});
      }
    }
    const seen=new Set();
    const add=async(kind,id,reference)=>{const key=kind+':'+id;if(seen.has(key))return;seen.add(key);
      await observer.bytes(reference,reference.bytes,signal);result.push({kind,id,reference});};
    const instruction=async id=>{const found=approved.instructions.find(item=>item.id===id);if(!found)throw error('A pinned instruction dependency is missing.','WFA_DEPENDENCY_UNAVAILABLE',{id});await add('instruction',id,found.body);};
    const skill=async id=>{const key='skill:'+id;if(seen.has(key))return;const found=approved.skills.find(item=>item.id===id);
      if(!found)throw error('A pinned skill dependency is missing.','WFA_DEPENDENCY_UNAVAILABLE',{id});await add('skill',id,found.body);
      for(const child of found.skills)await skill(child);for(const child of found.instructions)await instruction(child);};
    if(agent.agentId!==null) {
      const found=approved.agents.find(item=>item.id===agent.agentId);if(!found)throw error('The pinned author resource is missing.','WFA_DEPENDENCY_UNAVAILABLE');
      await add('agent',found.id,found.body);
      const activeSkills=found.skillBindings?found.skillBindings.filter(item=>!item.phases.length||item.phases.includes(phase.id)).map(item=>item.id):found.skills;
      for(const id of activeSkills)await skill(id);for(const id of found.instructions)await instruction(id);
    }
    const constitution=w.resolution.constitution;
    if(constitution?.mode!=='off'&&constitution?.path) {
      const found=approved.files.find(item=>item.path===constitution.path);
      if(!found&&constitution.mode==='enforce')throw error('The pinned constitution is unavailable.','WFA_DEPENDENCY_UNAVAILABLE',{path:constitution.path});
      if(found)await add('constitution',constitution.path,found.body);
    }
    return result;
  }
  return Object.freeze({read:resources});
}

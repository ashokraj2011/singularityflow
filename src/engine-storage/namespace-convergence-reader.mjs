/** Read-only convergence inputs from actual Code publications, tests and original human approvals. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceSnapshot,validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {mergePlannedClaimRecords} from '../kernel/specification-policy.mjs';
import {namespaceConvergenceSelection,namespaceConvergencePolicies} from '../kernel/namespace-convergence.mjs';
import {NODE_TEXT_DIGESTS,NODE_TEXT_VALUE_SYNTAX} from '../records.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../engine-compatibility/node-configuration-path.mjs';
import {sourceBaselineInventory} from '../engine-compatibility/node-source-policy.mjs';
import {createNamespaceCodePredecessorReader} from './namespace-code-predecessors.mjs';
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
export function createNamespaceConvergenceReader({observer,scope,workId}){
  const predecessors=createNamespaceCodePredecessorReader({observer,scope,workId}),values=namespaceConvergencePolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX);
  async function json(reference,signal){const bytes=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(cause){throw error('Convergence needs the exact retained UTF-8 JSON input.','ENGINE_STORAGE_CORRUPT',{reference},cause);}}
  async function source(snapshot,phaseId,{signal,policyTraversal}={}){
    const workflow=snapshot.workflow,selected=namespaceConvergenceSelection(workflow,phaseId),
      code=await predecessors.inspect(snapshot,selected.phase,null,{signal,policyTraversal});
    if(!code?.phases.length)throw error('Approve the actual Code producer before preparing convergence.','CONVERGENCE_INPUT_EVIDENCE_REQUIRED',{
      actions:[{operation:'story.next',inputs:{workId}}]});
    const definition=(await observer.approved(snapshot,{signal})).compiled.definition,indices=new Map(),current=new Map(),inputs=[],references=[],reports=new Map();
    for(const phase of code.phases){
      const report=await json(phase.report,signal);reports.set(phase.phase,report);
      if(!same(report.preflight.plan,phase.plan))throw error('The approved plan changed after this Code delivery; preserve it and obtain its owner revalidation.',
        'ENGINE_CONVERGENCE_INPUTS_CHANGED',{phase:selected.phase,sourcePhase:phase.phase,actions:[{operation:'upstream.raise',
          inputs:{workId,phaseId:phase.phase,about:'the approved Code plan',problem:'The approved plan changed after this Code publication. Revalidate the delivered source and tests against the exact current plan.',proposed:'return'},requiredInputs:['operationId','authored']}]});
      inputs.push({phase:phase.phase,generation:phase.generation,publication:phase.publication,reviewPacket:phase.submission.record,
        policy:phase.policy.record,report:phase.report,approvals:phase.approvals.map(row=>row.record)});
      references.push(...phase.references);
      for(const [position,index]of phase.plan.indices.entries()){
        const previous=indices.get(index.phase);
        if(previous&&!same(previous.reference,index.record))throw error('Convergence inputs refer to different approved clause generations.','ENGINE_CONVERGENCE_INPUTS_CHANGED',{phase:index.phase});
        indices.set(index.phase,{reference:index.record,value:phase.indexes[position]});
      }
      for(const repository of phase.repositories)current.set(repository.id,{phase:phase.phase,generation:phase.generation,...repository});
    }
    const repositories=[];
    for(const [id,latest]of current){const view=predecessors.repository(code,id,{workflow,definition}),claims=mergePlannedClaimRecords(view.records),findings=new Map(),planEntries=[];
      for(const phase of code.phases){const report=reports.get(phase.phase),delivery=report.preflight.repositories.find(row=>row.id===id)?.delivery;
        for(const change of delivery?.changeSet?.entries??[]){const path=change.newPath??change.oldPath;
          if(!path)throw error('The retained Code change has no actual source path.','ENGINE_STORAGE_CORRUPT');
          findings.set(path,{path,status:change.newPath===null?'deleted':'present',sha256:change.newContent?.sha256??null,protected:Boolean(change.protected),
            clauseIds:Object.entries(claims).filter(([,row])=>(row.expectedPaths??[]).includes(path)).map(([clauseId])=>clauseId)});
        }
      }
      // Each plan above has been authenticated with its actual submitted packet and human votes.
      for(const record of view.records){if(record.amendment)continue;
        const details=new Map((record.supportingFileDetails??[]).map(row=>[row.path,row]));
        for(const path of new Set([...(record.supportingFiles??[]),...details.keys()])){const detail=details.get(path);
          planEntries.push({file:path,approved:true,problem:detail?null:'the plan lists it with no class or reason',
            entry:{kind:'supporting',phase:record.phase??null,generation:Number(record.generation??0),class:detail?.class??null,text:detail?.reason??null}});}
      }
      repositories.push({id,planned:view.records,observed:view.observed,reconciliation:{profile:'sflow-namespace-retained-changes/v1',
        findings:[...findings.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)},planEntries});
    }
    const selectedInputs={projectId:scope.projectId,workId,phase:selected.phase,generation:selected.generation,configuration:snapshot.configuration,
      inputs,indexes:[...indices.values()].map(row=>row.value),repositories},
      projection=values.project(selectedInputs);
    return {phase:selected.phase,generation:selected.generation,definition,workflow,selectedInputs,projection,
      currentSources:[...current.values()].map(row=>({phase:row.phase,generation:row.generation,id:row.id,descriptor:row.descriptor,...row.source})),
      references:[...new Map(references.map(ref=>[canonicalJson(ref),ref])).values()]};
  }
  async function fresh(found,units,{signal}={}){
    const selected=new Map(units.map(unit=>[validateSourceUnit(unit).repositoryId,unit])),retention=createNamespaceSourceRetentionReader({...observer.evidenceReads,observer});
    for(const source of found.currentSources){const unit=selected.get(source.id);
      if(!unit||!same(unit.descriptor,source.descriptor))throw error('Bind the approved repository checkout before publishing convergence.','ENGINE_SOURCE_UNIT_UNAVAILABLE',{
        repositoryId:source.id,sourcePhase:source.phase});
      const current=await unit.capture({signal}),snapshot=sourceSnapshot(current.snapshot,unit.descriptor),original=await retention.snapshot(source.content,source.descriptor,source.revision,signal);
      if(current.revision!=='sha256:'+NODE_TEXT_DIGESTS.sha256Utf8(canonicalJson(snapshot)))throw error('The source port returned another convergence snapshot digest.','ENGINE_PORT_RESULT_INVALID');
      const inventory=value=>sourceBaselineInventory(value,{workflow:found.workflow,definition:found.definition});
      if(!same(inventory(snapshot),inventory(original)))throw error('Application inputs changed after their approved Code execution.','PRIOR_CODE_TEST_EVIDENCE_REQUIRED',{
        phase:found.phase,sourcePhase:source.phase,repositoryId:source.id,actions:[{operation:'upstream.raise',inputs:{workId,phaseId:source.phase,
          about:'changed inputs before convergence',problem:'Application source or test inputs changed after their approved Code execution. Revalidate the actual changed delivery.',proposed:'return'},requiredInputs:['operationId','authored']}]});
    }
  }
  return Object.freeze({source,fresh,values});
}

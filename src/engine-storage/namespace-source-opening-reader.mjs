/** Actual source opening facts and shared-only replay. No execution, writes or checkout discovery. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {phaseBeginSelection,phaseRequiresCodeDelivery} from '../kernel/phase-policy.mjs';
import {namespaceSourceOpeningPolicies} from '../kernel/source-opening.mjs';
import {sourceSnapshotChanges} from '../kernel/source-changes.mjs';
import {assertTargetedCodeRepairDelta,assertArtifactOnlyCodeRepairDelta} from '../kernel/conformance-decisions.mjs';
import {inspectSourceChanges} from '../engine-compatibility/node-source-policy.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {createNamespaceRepositoryPlanReader} from './namespace-repository-plan.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceCodeHistoryReader} from './namespace-code-history.mjs';
import {createNamespaceCodePredecessorReader} from './namespace-code-predecessors.mjs';
import {namespaceLifecycleStoryKey,createNamespaceLifecycleCodec} from './namespace-lifecycle-codec.mjs';
const rules=namespaceSourceOpeningPolicies(NODE_TEXT_DIGESTS),same=(a,b)=>canonicalJson(a)===canonicalJson(b),
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export function createNamespaceSourceOpeningReader({observer,scope,workId,sources=[]}){
  const observations=createNamespaceSourceObservations({observer,scope,sources}),checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),
    publications=createNamespacePublicationReader({observer,scope,workId,checks}),plans=createNamespaceRepositoryPlanReader({observer,scope,workId,checks});
  async function original(snapshot,phaseId,{signal}={}){
    const w=snapshot.workflow,phase=w.phases[phaseId],selected=phaseBeginSelection(w,{workId,phaseId});
    if(!phaseRequiresCodeDelivery(phase))fail('Reviewed source opening applies to a Code phase.','GENERATION_INTENT_NOT_APPLICABLE');
    if(phase.status==='awaiting_approval')fail('Return the submitted generation through authorized rejection before opening another.','GENERATION_ROLLOVER_REVIEW_REQUIRED',{
      actions:[{operation:'phase.review',inputs:{workId,phaseId}}]});
    if(phase.generation>0&&phase.reworkRevalidation?.generation!==phase.generation&&(w.changeRequests??[]).some(row=>row.status==='open'&&row.targetPhase===phaseId))fail(
      'Review the already published repair generation before opening another author-only successor. Its original reviewer return remains pending.',
      'GENERATION_ROLLOVER_REVIEW_REQUIRED',{actions:[{operation:'phase.review',inputs:{workId,phaseId}}]});
    const repositories=w.sourceBindings?.current?.repositories;
    if(!Array.isArray(repositories)||!repositories.length)fail('Bind the actual sources before reviewing an opening.','ENGINE_SOURCE_UNIT_UNAVAILABLE');
    await plans.guard(snapshot,phaseId,repositories.map(row=>row.id),{signal});
    const actual=await observations.binding(w.sourceBindings.current.operationId,signal);
    if(!same(actual.selected,w.sourceBindings.current))fail('The source selection differs from its original accepted binding.');
    const definition=(await observer.approved(snapshot,{signal})).compiled.definition;
    let predecessor=null,priorCode=null,repair=null,opening=null;
    if(phase.generation>0){
      const bindings=phase.publicationBindings?.filter(row=>row.generation===phase.generation);
      if(bindings?.length!==1)fail('Recover the exact published predecessor before rollover.','GENERATION_INTENT_REQUIRED');
      const publication=await publications.accepted(bindings[0],phaseId,{signal}),code=publications.policies.codeEvidence(publication);
      if(!code)fail('The predecessor has no retained source-backed Code proof.','ENGINE_PORT_UNAVAILABLE',{required:['retained-code-policy']});
      predecessor={publication:bindings[0],policy:code.binding,report:code.manifest.report,artifact:publication.artifact};
      opening=code.sources.map(row=>({repository:row.repository,observed:row.observed}));
      if(phase.reworkRevalidation?.generation===phase.generation){const history=createNamespaceCodeHistoryReader({observer,scope,workId});
        opening=await history.opening(snapshot,phaseId,{signal});repair=await history.repairScope(snapshot,phaseId,{signal});}
    }else{priorCode=await createNamespaceCodePredecessorReader({observer,scope,workId}).opening(snapshot,phaseId,{signal});opening=priorCode?.sources??null;}
    return {phase,selected,definition,predecessor,priorCode,repair,opening,repositories};
  }
  async function context(snapshot,phaseId,privateFields,{signal,archived=null}={}){
    const originalValue=await original(snapshot,phaseId,{signal}),{phase,selected,definition,predecessor,priorCode,repair,opening,repositories}=originalValue,
      rows=[],observed=[];
    for(const repository of repositories){
      const earlier=opening?.find(row=>row.repository.id===repository.id);
      if(opening&&(!earlier||!same(earlier.repository,repository)))fail('The reviewed predecessor has another selected repository.');
      const baseline=earlier?{...repository,snapshot:earlier.observed.content,revision:earlier.observed.revision}:repository,
        before=await observations.baseline(baseline,signal),previous=archived?.repositories.find(row=>row.repository.id===repository.id),
        current=archived?{snapshot:rules.restored(before,previous?.changes,repository.descriptor),revision:previous?.observedRevision}
          :await observations.capture(repository,signal);
      if(current.revision!==rules.hash(current.snapshot))fail('The reviewed delta no longer reconstructs its exact observed snapshot.');
      const changes=sourceSnapshotChanges(before,current.snapshot,repository.descriptor),classification=inspectSourceChanges(changes,{definition,workflow:snapshot.workflow,phase,applicationOnly:true});
      rows.push({repository,baseline:{content:baseline.snapshot,revision:baseline.revision},observedRevision:current.revision,changes,classification});
      observed.push({repository,current});
    }
    const changed=rows.map(row=>({id:row.repository.id,changes:row.classification.entries.map(entry=>({path:entry.newPath??entry.oldPath,before:entry.before,after:entry.after}))}));
    if(repair)assertTargetedCodeRepairDelta(repair.current,changed,{workId,phaseId,ownerPhase:repair.plan.phase});
    if(phase.surgicalReopen)assertArtifactOnlyCodeRepairDelta(changed,{workId,phaseId});
    const value={schemaVersion:1,profile:'sflow-namespace-source-opening-context/v1',kind:predecessor?(phase.reworkRevalidation?.generation===phase.generation?'returned-successor':'successor'):'initial',
      workId,phase:phaseId,generation:selected.generation,fromGeneration:Number(phase.generation??0),
      basis:{revision:snapshot.revision,configuration:snapshot.configuration},sourceBinding:snapshot.workflow.sourceBindings.current,
      predecessor,repair:repair?{sourceRecord:repair.sourceRecord,predecessor:repair.predecessor,current:repair.current}:null,
      priorCode:priorCode?.proof??null,...privateFields,artifact:privateFields.artifact??(predecessor?{key:predecessor.artifact.sourceKey,content:predecessor.artifact.content}:null),
      repositories:rows,dirtyStartPolicy:snapshot.workflow.resolution.codeDelivery?.generationBoundary?.dirtyStart??'block'};
    if(Buffer.byteLength(canonicalJson(value))>2*1024*1024)fail('The reviewed change boundary exceeds its bounded record.','ENGINE_STORAGE_LIMIT');
    if(!archived)await observations.fresh(observed,signal);
    return {value,observed,priorCode:priorCode?.proof??null};
  }
  async function verify(value,{signal}={}){
    rules.assert(value);const c=value.context,accepted=await observer.accepted(c.basis.head.operationId,{signal}),b=observer.evidenceReads,
      codec=createNamespaceLifecycleCodec({...b,limits:b.records.descriptor.limits,textDigests:NODE_TEXT_DIGESTS}),head=codec.head(accepted.plan);
    const actualRevision=accepted.receipt.records.find(row=>row.namespace==='state'&&row.key===namespaceLifecycleStoryKey(workId,NODE_TEXT_DIGESTS))?.version;
    if(!same(head,c.basis.head)||actualRevision!==c.basis.revision||!same(head.configuration,c.basis.configuration)
      ||!same(accepted.state.workflow.sourceBindings.current,c.sourceBinding))fail('The reviewed opening has another original source selection or lifecycle basis.');
    const snapshot={revision:c.basis.revision,configuration:c.basis.configuration,workflow:accepted.state.workflow},
      rebuilt=await context(snapshot,c.phase,{basis:c.basis,previousDraft:c.previousDraft,artifact:c.artifact},{signal,archived:c});
    if(!same(rebuilt.value,c))fail('The reviewed source opening does not replay from its original publication, policy and source comparison.');return value;
  }
  return Object.freeze({context,verify,fresh:(observed,signal)=>observations.fresh(observed,signal),rules});
}

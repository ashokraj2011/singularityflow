/** Registered convergence context and human decisions. Rules/read-only proofs remain separate. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {phaseExplicitlyReopened} from '../kernel/phase-policy.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {createNamespaceConvergenceDecisionOwner} from './namespace-convergence-decisions-reader.mjs';
import {namespaceConvergenceDecisionContract,namespaceConvergenceRequest} from './namespace-convergence-contract.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceConvergencePorts(options,runtime=null){
  const {scope,workId,access}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceConvergenceDecisionOwner({observer,scope,workId}),contexts=new WeakMap();
  async function authorize(signal,expected=null){const facts=await access.current({projectId:scope.projectId,workId,operation:'convergence.context',signal}),
    principal=phaseTransitionAccess(facts,scope.projectId,'convergence.context',{expected:expected?.principal??null}),permissions=[...facts.permissions].sort();
    if(expected&&!same(expected.permissions,permissions))throw error('Convergence access changed during context reading.','ENGINE_CONTEXT_CHANGED');
    return {principal,permissions};}
  const convergenceContext={
    async load(input,{signal}={}){
      if(input.workId!=null&&input.workId!==workId)throw error('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
      const identity=await authorize(signal),captured=await observer.capture({signal}),phaseId=input.phaseId??captured.snapshot.workflow.currentPhase,
        context={subject:{kind:'story',id:workId},workflow:captured.snapshot.workflow,phase:captured.snapshot.workflow.phases[phaseId]};
      contexts.set(context,{captured,phaseId,identity});return context;
    },
    async read(context,{signal}={}){
      const selected=contexts.get(context);if(!selected)throw error('Use the issued convergence context.','ENGINE_INPUT_INVALID');
      const found=await owned.context(selected.captured.snapshot,selected.phaseId,{signal}),projection=found.projection.projection,
        decided=new Set(projection.findings.map(row=>row.itemId)),items=projection.facts.filter(row=>!decided.has(row.id)),
        blocked=projection.findings.filter(row=>projection.unresolvedBlockers.includes(row.id)),
        decisions=[...items.map(row=>row.id),...blocked.map(row=>row.itemId)],
        actions=decisions.map(itemId=>({operation:'convergence.adjudicate',inputs:{workId,phaseId:found.phase,itemId,expectedContext:found.expectedContext},
          requiredInputs:['operationId','disposition','reason']}));
      for(const disposition of new Set(blocked.map(row=>row.disposition))){const intent=disposition==='update-intent',
        clauseIds=new Set(blocked.filter(row=>row.disposition===disposition).flatMap(row=>row.clauseIds)),
        producers=[...new Set(intent?found.selectedInputs.indexes.filter(index=>index.clauses.some(row=>clauseIds.has(row.id))).map(index=>index.phase).filter(Boolean)
          :found.projection.source.inputs.map(row=>row.phase))];
        actions.push({operation:'upstream.raise',inputs:{workId,...(producers.length===1?{phaseId:producers[0]}:{}),
          about:intent?'convergence findings requiring intent correction':'convergence findings requiring producer repair',
          problem:intent?'The convergence reviewer requires the original approved intent owner to correct the exact affected clauses.'
            :'The recorded convergence findings require the original producer to repair or revalidate this delivery.',proposed:'return'},
          requiredInputs:['operationId','authored',...(producers.length===1?[]:['phaseId'])]});}
      if(!actions.length){const phase=context.phase,published=phase.generation>0&&!phaseExplicitlyReopened(context.workflow,phase);let prepared=false;
        if(!published&&runtime){const token=await runtime.captureEntryDraft(phase.id,{signal}),facts=runtime.entryDraftFacts(token),p=facts.draft?.payload,
          text=owned.inputs.values.render(found.projection);
          prepared=facts.revision===selected.captured.snapshot.revision&&p?.baseRevision===facts.revision&&p.generation===found.generation
            &&p.convergence?.sha256===found.identity.projection.sha256&&p.artifact.current.sha256===NODE_TEXT_DIGESTS.sha256Utf8(text);
          await runtime.revalidateEntryDraft(token,{signal});}
        actions.push({operation:published?'convergence.advance':prepared?'phase.publish':'phase.prepare',
          inputs:{workId,...(published?{}:{phaseId:found.phase}),...(prepared?{authored:'deterministic'}:{})}});}
      await authorize(signal,selected.identity);const fresh=await observer.capture({signal});
      if(fresh.snapshot.revision!==selected.captured.snapshot.revision||fresh.basis.authorityVersion!==selected.captured.basis.authorityVersion)throw error(
        'The convergence Story or authority changed during reading.','ENGINE_CONTEXT_CHANGED');
      return {schemaVersion:1,profile:'sflow-namespace-convergence-context/v1',workId,phase:found.phase,generation:found.generation,
        contextBinding:found.expectedContext,sourceSha256:found.projection.sourceSha256,projection:found.projection,
        reads:found.projection.source.inputs.map(row=>({operation:'phase.review.resources',inputs:{workId,phaseId:row.phase}})),
        decisions:found.rows.map(row=>({operationId:row.operationId,phase:row.phase,generation:row.generation,record:row.reference,
          itemId:row.adjudication.itemId,disposition:row.adjudication.disposition})),
        actions};
    }
  };
  const decision=createNamespaceRecordedMutationPort(options,{operation:'convergence.adjudicate',request:namespaceConvergenceRequest,owner:owned.owner,
    contract:namespaceConvergenceDecisionContract,explicitIdentity:true,finish:(value,revision)=>({workId,phase:value.phase,recordKind:'convergence-adjudication',
      record:value.outcome.record,revision,pushed:false,actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
  const load=decision.load;decision.load=(input,options)=>{if(input.fetch)throw error('Remote fetching belongs to the source-control adapter.','ENGINE_INPUT_UNBOUND',{input:'fetch'});return load(input,options);};
  return {convergenceContext,decision,owned};
}

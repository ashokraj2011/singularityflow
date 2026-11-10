/** Scope decisions over observed immutable inputs and the original pinned human authorities. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {standaloneDecisionAdmission,standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {scopeAuthorities} from '../kernel/scope-decisions.mjs';
import {omissionAuthorities,recordApplicabilityDecision} from '../kernel/applicability.mjs';
import {resolvedClarificationPolicy} from '../kernel/clarification-responses.mjs';
import {phaseNeedsGeneration,nextPhaseGeneration} from '../kernel/phase-policy.mjs';
import {phaseDefinesSpecificationClaims} from '../kernel/specification-policy.mjs';
import {scopeStatements,scopeInventory,scopeDecisions} from '../engine-compatibility/node-scope-policy.mjs';
import {extractClauses} from '../engine-compatibility/node-specification-policy.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceClarificationReader} from './namespace-clarification-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDecisionContract,namespaceDecisionReceipts} from './namespace-decision-contract.mjs';
import {createNamespaceInputDocumentOwners} from './namespace-input-documents-reader.mjs';
const same=(a,b)=>a===undefined||b===undefined?a===b:canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(value).digest('hex');
const error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
const collections=Object.freeze({'decision.scope':'scopeDispositions','decision.completeness':'completenessReviews','decision.applicability':'applicability'});
export const NAMESPACE_SCOPE_DECISION_OPERATIONS=Object.freeze(Object.keys(collections));

export function createNamespaceScopeDecisionOwners({observer,scope,workId,runtime=null}) {
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),publications=createNamespacePublicationReader({observer,scope,workId,checks}),
    clarification=createNamespaceClarificationReader({observer,scope,workId,checks}),inputs=createNamespaceInputDocumentOwners({observer,scope,workId}),readers=new Map(),owners=new Map();
  async function text(reference,signal){return new TextDecoder('utf-8',{fatal:true}).decode(await observer.bytes(reference,reference.bytes,signal));}
  async function admittedCollections(snapshot,operation,signal) {
    const selected=operation==='decision.applicability'?['decision.applicability']:operation==='decision.scope'
      ?['decision.applicability','decision.scope']:Object.keys(collections),links=namespaceDecisionReceipts(snapshot.workflow);
    for(const id of selected){
      const key=collections[id],rows=snapshot.workflow[key]??[],last=links.findLast(link=>link.operation===id);
      if(!Array.isArray(rows))throw error('The persisted decision collection is invalid.','ENGINE_STORAGE_CORRUPT',{collection:key});
      if(!last){if(rows.length)throw error('A decision list has no accepted original record.','ENGINE_STORAGE_CORRUPT',{collection:key});continue;}
      const proof=await readers.get(id).accepted(last,{signal});
      if(!same(rows,proof.accepted.state.workflow[key]??[]))throw error('The decision list differs from its last accepted transition.','ENGINE_STORAGE_CORRUPT',{collection:key});
    }
  }
  async function inventory(snapshot,operation,{signal,bound,policyTraversal}={}) {
    if(bound&&(!['sflow-namespace-scope-source/v1','sflow-namespace-scope-source/v2'].includes(bound.profile)||!Array.isArray(bound.artifacts)||!Array.isArray(bound.documents)||!Array.isArray(bound.checkpoints)))throw error(
      'The retained scope source context is invalid.','ENGINE_STORAGE_CORRUPT');
    await admittedCollections(snapshot,operation,signal);
    await inputs.admitted(snapshot,{signal,policyTraversal});
    const workflow=snapshot.workflow,approved=(await observer.approved(snapshot,{signal})).compiled.definition,source=workflow.workItem.source.content,
      original=await text(source,signal),sources=[],artifacts=[],references=[],clauses=[],checkpoints=[],readBindings=[],documents=[],drafts=[],draftReads=[],pendingEvidence=[];
    let parsed=null;try{const value=JSON.parse(original);if(value&&typeof value==='object'&&!Array.isArray(value))parsed=value;}catch{ /* A Markdown Story is an explicit supported source format. */ }
    sources.push({id:'story',kind:'story',path:null,sha256:parsed?hash(JSON.stringify(parsed)):source.sha256,readable:true,
      statements:parsed?scopeStatements.storySourceStatements(parsed):scopeStatements.extractNormativeStatements(original,{sourceId:'story'})});
    for(const phaseId of workflow.phaseOrder){
      const phase=workflow.phases[phaseId],binding=phase.publicationBindings?.find(row=>row.generation===phase.generation);
      let authored=null;
      if(phaseDefinesSpecificationClaims(workflow,phase)&&phaseId===workflow.currentPhase&&phaseNeedsGeneration(workflow,phase)){
        if(bound?.profile==='sflow-namespace-scope-source/v2'){
          const retained=bound.drafts?.find(row=>row.phase===phaseId);
          if(retained){if(retained.generation!==nextPhaseGeneration(phase)||retained.artifact.content.namespace!=='evidence')throw error(
            'The retained draft has another scope generation.','ENGINE_STORAGE_CORRUPT');
            authored={...retained,body:await text(retained.artifact.content,signal)};}
        }else if(!bound&&runtime){
          const token=await runtime.captureEntryDraft(phaseId,{signal}),facts=runtime.entryDraftFacts(token),draft=facts.draft;
          if(facts.revision!==snapshot.revision)throw error('Scope has another private draft basis.','ENGINE_CONTEXT_CHANGED');
          draftReads.push(token);
          if(draft){const payload=draft.payload,bytes=await runtime.entryDraftBytes(token,payload.artifact.current,{signal}),
            reference={namespace:'evidence',sha256:hash(bytes),bytes:bytes.byteLength};
            if(payload.generation!==nextPhaseGeneration(phase))throw error('The scope draft is not the next authored generation.','ENGINE_CONTEXT_CHANGED');
            authored={phase:phaseId,generation:payload.generation,revision:draft.revision,bodySha256:draft.bodySha256,
              artifact:{key:payload.artifact.key,content:reference},body:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
            pendingEvidence.push({reference,bytes});}
        }
      }
      if(authored){const {body,...identity}=authored;drafts.push(identity);references.push(identity.artifact.content);}
      if((authored||binding)&&phaseDefinesSpecificationClaims(workflow,phase)){
        const value=authored?null:await publications.accepted(binding,phaseId,{signal,policyTraversal}),body=authored?.body??await text(value.artifact.content,signal);
        const found=extractClauses(body,{namespace:workflow.resolution.spec?.namespace,sourcePath:authored?.artifact.key??value.artifact.sourceKey});
        for(const clause of found){const previous=clauses.find(row=>row.id===clause.id);if(previous&&previous.bodySha256!==clause.bodySha256)throw error(
          'Active definitions contain another body for the same clause.','SPEC_INDEX_INVALID',{clauseId:clause.id});if(!previous)clauses.push(clause);}
        if(value){artifacts.push({phase:phaseId,generation:phase.generation,publication:binding});references.push(binding.record,value.artifact.content);}
      }
      if(resolvedClarificationPolicy(approved,workflow,phase).mode==='off')continue;
      const generations=[...(phase.generation>0?[phase.generation]:[]),...(workflow.currentPhase===phaseId&&phaseNeedsGeneration(workflow,phase)?[nextPhaseGeneration(phase)]:[])];
      for(const generation of generations){
        let observed,accepted;
        if(bound){const row=bound.checkpoints?.find(item=>item.phase===phaseId&&item.generation===generation);
          if(!row)throw error('The original scope context lost a clarification observation.','ENGINE_STORAGE_CORRUPT');
          observed=row.observed;accepted=row.operationId?await clarification.accepted(row.operationId,{signal}):null;
          if(observed?.namespace!=='evidence'||observed.key!==clarification.key(phaseId,generation)
            ||(accepted?accepted.value.phase!==phaseId||accepted.value.generation!==generation
              ||accepted.receipt.records.find(item=>item.key===observed.key)?.version!==observed.version:observed.version!==null))throw error(
            'The scope context has another clarification receipt.','ENGINE_STORAGE_CORRUPT');
        }else({observed,accepted}=await clarification.checkpoint({phase:phaseId,generation},{signal}));
        checkpoints.push({phase:phaseId,generation,observed,operationId:accepted?.value.operationId??null});readBindings.push(observed);
        if(accepted){references.push(accepted.reference);for(const response of accepted.value.responses){if(response.status!=='answered'||typeof response.answer!=='string')continue;
          const id='clarification:'+phaseId+':'+response.id;sources.push({id,kind:'clarification',path:null,sha256:hash(response.answer),readable:true,
            statements:scopeStatements.extractNormativeStatements(response.answer,{sourceId:id})});}}
      }
    }
    for(const document of workflow.namespaceDocuments??[]){
      if(document.status==='detached'||document.kind!=='input-document'||same(document.content,source))continue;
      const local=document.locality==='machine-local'||document.content?.namespace==='local',readable=!local&&document.encoding==='utf8',
        body=readable?await text(document.content,signal):null;
      const identity={id:document.id,content:document.content,locality:document.locality,encoding:document.encoding};documents.push(identity);
      sources.push({id:document.id,kind:'document',name:document.name??document.id,path:document.sourceKey??null,sha256:document.content?.sha256??null,
        readable,reason:readable?null:local?'machine-local-storage':'no-text-layer',statements:readable?scopeStatements.extractNormativeStatements(body,{sourceId:document.id}):[]});
      if(readable&&document.content.namespace==='evidence')references.push(document.content);
    }
    const decisions=(workflow.scopeDispositions??[]).filter(row=>!row.withdrawnAt),notApplicable=(workflow.applicability??[]).findLast(row=>row.responsibility==='scope'&&!row.withdrawnAt),
      value=scopeInventory.buildScopeInventoryValue(workflow,{sources,clauses,decisions,scopeNotApplicable:Boolean(notApplicable)}),
      identity={profile:drafts.length?'sflow-namespace-scope-source/v2':'sflow-namespace-scope-source/v1',story:source,artifacts,documents,checkpoints,
        sourceSetSha256:value.sourceSetSha256,inventorySha256:value.inventorySha256,...(drafts.length?{drafts}:{})};
    if(bound&&!same(bound,identity))throw error('The original scope inventory no longer replays from its actual inputs.','ENGINE_STORAGE_CORRUPT');
    return {identity,inventory:value,knownClauseIds:[...new Set(clauses.map(row=>row.id))].sort(),references:[...new Map(references.map(ref=>[canonicalJson(ref),ref])).values()],readBindings,
      pendingEvidence,fresh:async()=>{for(const token of draftReads)await runtime.revalidateEntryDraft(token,{signal});}};
  }
  for(const operation of Object.keys(collections)){
    const owner={
      async read(snapshot,request,options={}) {
        const phase=snapshot.workflow.phases[request.phaseId];if(!phase)throw error('The decision phase is not in the pinned Story.','ENGINE_PHASE_UNAVAILABLE');
        if(operation==='decision.applicability'){await admittedCollections(snapshot,operation,options.signal);return {generation:phase.generation,
          identity:{profile:'sflow-namespace-applicability-source/v1',responsibility:request.responsibility,
            authorities:omissionAuthorities(snapshot.workflow,request.responsibility)},references:[]};}
        return {...await inventory(snapshot,operation,options),generation:phase.generation};
      },
      async fresh(snapshot,_request,source,{signal}={}){
        await source.fresh?.();
        for(const expected of source.identity.drafts??[]){
          if(!runtime)throw error('Reopen the authored specification before accepting its prepared scope decision.','ENGINE_WORKING_STORE_REQUIRED',{
            actions:[{operation:'phase.prepare',inputs:{workId,phaseId:expected.phase}}]});
          const token=await runtime.captureEntryDraft(expected.phase,{signal}),facts=runtime.entryDraftFacts(token),draft=facts.draft;
          if(facts.revision!==snapshot.revision||!draft||draft.revision!==expected.revision||draft.bodySha256!==expected.bodySha256
            ||draft.payload.generation!==expected.generation||draft.payload.artifact.key!==expected.artifact.key)throw error(
            'The authored specification changed after this scope decision was prepared. Review its current inventory and use a new operation ID.','ENGINE_CONTEXT_CHANGED',{
              actions:[{operation:'scope.context',inputs:{workId}}],requiredInputs:['operationId']});
          const bytes=await runtime.entryDraftBytes(token,draft.payload.artifact.current,{signal});
          if(bytes.byteLength!==expected.artifact.content.bytes||hash(bytes)!==expected.artifact.content.sha256)throw error(
            'The authored scope bytes changed before human acceptance.','ENGINE_CONTEXT_CHANGED');
          await runtime.revalidateEntryDraft(token,{signal});
        }
      },
      authority(workflow,request,actor){const groups=operation==='decision.applicability'?omissionAuthorities(workflow,request.responsibility):scopeAuthorities(workflow);
        if(!groups.length)throw error('The pinned workflow has no authority for this decision.',operation==='decision.applicability'?'APPLICABILITY_NOT_OMITTED':'SCOPE_AUTHORITY_UNAVAILABLE');
        return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities:groups,requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;},
      plan(workflow,request,facts,source){standaloneDecisionAdmission(operation,workflow);
        if(request.phaseId!==workflow.currentPhase)throw error('The human decision has another current-phase binding.','ENGINE_CONTEXT_CHANGED');
        const proposed=structuredClone(workflow),common={...request,actor:facts.actorId,authorityGroup:facts.authorityGroup,identityAssurance:null,at:facts.at};
        const record=operation==='decision.applicability'?recordApplicabilityDecision(proposed,common):operation==='decision.scope'
          ?scopeDecisions.recordScopeDecision(proposed,{...common,inventory:source.inventory,knownClauseIds:source.knownClauseIds})
          :scopeDecisions.recordCompletenessReview(proposed,{...common,inventory:source.inventory});
        proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:operation==='decision.scope'?'scope_decided':operation==='decision.applicability'?'applicability_decided':'completeness_reviewed',
          phase:workflow.currentPhase,detail:operation==='decision.scope'?record.item+' is '+record.disposition+'. Reason: '+record.reason:
            operation==='decision.applicability'?record.responsibility+' does not apply. Reason: '+record.reason:'Scope inventory '+record.inventorySha256+' reviewed for completeness. '+record.reason});
        return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};
      }
    };
    owners.set(operation,owner);readers.set(operation,createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract}));
  }
  return Object.freeze({owners,readers,inventory});
}

export function createNamespaceScopeDecisionPorts(options,runtime=null) {
  const {scope,workId,access}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceScopeDecisionOwners({observer,scope,workId,runtime}),ports=new Map();
  for(const [operation,owner]of owned.owners){
    const request=(input,workflow)=>{const value=standaloneDecisionRequest(operation,input);return {...value,reason:value.reason.trim(),phaseId:workflow.currentPhase};};
    const base=createNamespaceRecordedMutationPort(options,{operation,request,owner,contract:namespaceDecisionContract,
      explicitIdentity:true,requestUsesWorkflow:true,finish:(value,revision)=>({workId,phase:value.phase,recordKind:operation==='decision.scope'?'scope-disposition':operation==='decision.applicability'?'applicability':'completeness-review',
        record:value.outcome.record,revision,pushed:false,actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
    ports.set(operation,{...base,async prepare(...args){const {phaseId,...intent}=await base.prepare(...args);return intent;},
      commit(context,intent,options){return base.commit(context,{...intent,phaseId:context.workflow.currentPhase},options);}});
  }
  const contexts=new WeakMap(),scopeContext={
    async load(input,{signal}={}){if(input.workId!=null&&input.workId!==workId)throw error('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
      phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:'scope.context',signal}),scope.projectId,'scope.context');
      const snapshot=(await observer.inspect({signal})).snapshot,context={subject:{kind:'story',id:workId},workflow:snapshot.workflow};contexts.set(context,snapshot);return context;},
    async read(context,{signal}={}){const snapshot=contexts.get(context);if(!snapshot)throw error('Use the issued scope context.','ENGINE_INPUT_INVALID');
      const source=await owned.inventory(snapshot,'decision.completeness',{signal}),workflow=snapshot.workflow;
      await source.fresh();
      if((await observer.inspect({signal})).snapshot.revision!==snapshot.revision)throw error('Scope changed during inspection.','ENGINE_CONTEXT_CHANGED');
      return {workId,revision:snapshot.revision,inventory:source.inventory,knownClauseIds:source.knownClauseIds,authorities:scopeAuthorities(workflow),
        completenessReview:(workflow.completenessReviews??[]).findLast(row=>!row.withdrawnAt&&row.inventorySha256===source.inventory.inventorySha256)??null};}
  };
  return {ports,scopeContext};
}

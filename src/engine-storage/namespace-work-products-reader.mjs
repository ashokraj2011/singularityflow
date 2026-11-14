/** Read admitted work products and their original conditional receipts, without running anything. */
import {createHash} from 'node:crypto';
import {canonicalJson,admitRecordSchemaVersion,WORK_PRODUCT_SCHEMAS} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {workProductPolicy,workProductReference,datasetSnapshot,planWorkProductRecord} from '../kernel/work-products.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {phaseNeedsGeneration,nextPhaseGeneration} from '../kernel/phase-policy.mjs';
import {namespaceWorkProductContract} from './namespace-work-product-contract.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceApprovedWorkProductInputs} from './namespace-work-product-inputs.mjs';
import {createNamespaceDataReader} from './namespace-data-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=v=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export function createNamespaceWorkProductOwners({observer,scope,workId}){
  const owners=new Map(),readers=new Map();
  let data;const dataReader=()=>data??=createNamespaceDataReader({observer,scope,workId});
  async function json(ref,signal){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await observer.bytes(ref,ref.bytes,signal)));}
    catch(cause){if(cause.code)throw cause;throw new SingularityFlowError('Work-product content is not UTF-8 JSON.',{code:'ENGINE_STORAGE_CORRUPT',cause});}}
  function policy(workflow){
    if(!workflow.resolution.workProducts)fail('Bind an approved namespace v2 work-product policy.','ENGINE_PORT_UNAVAILABLE',{required:['work-product-policy']});
    return workProductPolicy(workflow.resolution.workProducts,{phaseIds:workflow.phaseOrder});
  }
  async function admitted(snapshot,{signal,policyTraversal}={}){
    const links=namespaceWorkProductContract.receipts(snapshot.workflow),last=links.at(-1),products=snapshot.workflow.namespaceWorkProducts??[],executions=snapshot.workflow.namespaceDataExecutions??[],amendments=snapshot.workflow.namespaceWorkProductAmendments??[];
    if([products,executions,amendments].some(rows=>!Array.isArray(rows)||rows.length>512))fail('The accepted work-product indexes exceed their bounds.');
    if(!last){if(products.length||executions.length||amendments.length)fail('Work products need their actual accepted receipts.');return {products:[],executions:[],amendments:[],references:[]};}
    const proof=await readers.get(last.operation).accepted(last,{signal,policyTraversal});
    if(!same(proof.accepted.state.workflow.namespaceWorkProducts??[],products)||!same(proof.accepted.state.workflow.namespaceDataExecutions??[],executions)||!same(proof.accepted.state.workflow.namespaceWorkProductAmendments??[],amendments))fail('The work-product index differs from its accepted mutation sequence.');
    for(const row of products)workProductReference(row.asset,{projectId:scope.projectId});
    return {products,executions,amendments,references:links.map(row=>row.record)};
  }
  async function context(snapshot,phaseId,{signal,generation=null,policyTraversal}={}){
    const declaration=policy(snapshot.workflow),phase=declaration.phases.find(row=>row.id===phaseId),actual=snapshot.workflow.phases[phaseId];
    if(!phase||!actual)fail('This phase has no declared work-product contract.','ENGINE_PHASE_UNAVAILABLE',{phaseId});
    const state=await admitted(snapshot,{signal,policyTraversal}),selectedGeneration=generation??(phaseNeedsGeneration(snapshot.workflow,actual)?nextPhaseGeneration(actual):actual.generation),assets=phase.inputs.map(id=>{const original=state.products.find(row=>row.asset.id===id)??null,
      amendment=state.amendments.filter(row=>row.asset.id===id&&row.phase===phaseId&&row.generation===selectedGeneration).at(-1);
      return amendment&&original?{...original,asset:amendment.asset,amendment:{operationId:amendment.operationId,originalAsset:amendment.amendment.originalAsset}}:original;}),
      missing=phase.inputs.filter((_id,i)=>assets[i]===null),selected=assets.filter(Boolean),
      binding={projectId:scope.projectId,workId,phaseId,generation:selectedGeneration,policySha256:hash(declaration),
        inputs:selected.map(row=>({id:row.asset.id,phase:row.phase,generation:row.generation,operationId:row.operationId,content:row.asset.content,...(row.amendment?{amendment:row.amendment}:{})}))};
    return {declaration,phase,state,binding,contextSha256:hash(binding),missing,assets:selected,references:state.references};
  }
  const retain={
    async read(snapshot,request,{signal,policyTraversal,principal,at}={}){
      const declaration=policy(snapshot.workflow),phase=declaration.phases.find(row=>row.id===request.phaseId),actual=snapshot.workflow.phases[request.phaseId];
      if(snapshot.workflow.currentPhase!==request.phaseId||!phase||!actual)fail('Retain a work product in its current owning phase.','ENGINE_PHASE_UNAVAILABLE');
      if(!phaseNeedsGeneration(snapshot.workflow,actual))fail('This generation is already published. Review its retained delivery before starting a successor.','PHASE_ALREADY_PUBLISHED',{actions:[{operation:'phase.review',inputs:{workId,phaseId:request.phaseId}}]});
      if(!phase.outputs.includes(request.assetId)||phase.execution!==null)fail('Execution outputs need the real declared data executor.','ENGINE_WORK_PRODUCT_OWNER_REQUIRED',{operation:'data.execute'});
      const declared=declaration.assets.find(row=>row.id===request.assetId),state=await admitted(snapshot,{signal,policyTraversal}),
        bytes=await observer.bytes(request.content,request.content.bytes,signal);
      if(declared.kind==='dataset-snapshot')datasetSnapshot(await json(request.content,signal));
      if(declared.kind==='query'){const sql=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!sql.trim()||sql.length>65536||sql.includes('\0'))fail('Retain the actual bounded query text.','ENGINE_WORK_PRODUCT_INVALID');}
      let encoding='binary';try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.includes('\0'))encoding='utf8';}catch{}
      const generation=nextPhaseGeneration(actual),
        asset={schemaVersion:1,profile:'sflow-work-product-reference/v1',projectId:scope.projectId,id:declared.id,kind:declared.kind,mimeType:declared.mimeType,
          content:request.content,revision:{scheme:'sha256',value:request.content.sha256},observation:{at,consistency:'retained-content',expiresAt:null},
          producer:{operationId:principal.operationId,adapterId:'retained-input'}};
      return {generation,asset,encoding,references:[...state.references,request.content],identity:{profile:'sflow-work-product-retention/v1',projectId:scope.projectId,
        policySha256:hash(declaration),priorIndexSha256:hash({products:state.products,executions:state.executions,amendments:state.amendments}),assetId:declared.id,content:request.content}};
    },authority:()=>null,
    plan:(workflow,request,facts,source)=>planWorkProductRecord(workflow,request,{...facts,operationId:source.asset.producer.operationId},source)
  };
  owners.set('work-product.retain',retain);
  function register(operation,owner){owners.set(operation,owner);readers.set(operation,createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceWorkProductContract}));}
  register('work-product.retain',retain);
  const amend={
    async read(snapshot,request,{signal,policyTraversal,principal,at}={}){
      const selected=await context(snapshot,request.phaseId,{signal,policyTraversal}),actual=snapshot.workflow.phases[request.phaseId];
      if(snapshot.workflow.currentPhase!==request.phaseId||selected.contextSha256!==request.expected)fail('Review the current input binding before approving its amendment.','ENGINE_CONTEXT_CHANGED');
      if(!phaseNeedsGeneration(snapshot.workflow,actual))fail('This generation is already published. Return the reviewed phase before changing an input.','PHASE_ALREADY_PUBLISHED',{actions:[{operation:'phase.review',inputs:{workId,phaseId:request.phaseId}}]});
      if(!selected.phase.execution||!selected.phase.inputs.includes(request.assetId))fail('Amend only a declared current-phase data input.','ENGINE_WORK_PRODUCT_OWNER_REQUIRED');
      const original=selected.state.products.find(row=>row.asset.id===request.assetId),previous=selected.assets.find(row=>row.asset.id===request.assetId);
      if(!original||!previous||!['query','dataset-snapshot'].includes(original.asset.kind))fail('Retained output evidence cannot be manually rewritten as an input repair.','ENGINE_WORK_PRODUCT_OWNER_REQUIRED');
      await namespaceApprovedWorkProductInputs({observer,scope,workId},snapshot,selected,{signal,policyTraversal});
      const bytes=await observer.bytes(request.content,request.content.bytes,signal);
      if(original.asset.kind==='dataset-snapshot')datasetSnapshot(await json(request.content,signal));
      else{const sql=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!sql.trim()||sql.length>65536||sql.includes('\0'))fail('Retain the exact bounded repaired query.');}
      const asset=workProductReference({...original.asset,content:request.content,revision:{scheme:'sha256',value:request.content.sha256},observation:{at,consistency:'retained-content',expiresAt:null},
        producer:{operationId:principal.operationId,adapterId:'human-approved-input-amendment'}},{projectId:scope.projectId}),
        amendment={assetId:request.assetId,originalAsset:original.asset,previousContent:previous.asset.content};
      return {generation:nextPhaseGeneration(actual),asset,amendment,status:'amended',references:[...selected.references,original.asset.content,previous.asset.content,request.content],
        identity:{profile:'sflow-work-product-amendment/v1',projectId:scope.projectId,contextSha256:selected.contextSha256,amendment}};
    },authority(workflow,request,actor){
      if(workflow.resolution.presence)fail('The input amendment requires its configured human-presence proof.','ENGINE_PORT_UNAVAILABLE',{required:['person-presence']});
      const policy=workflow.phases[request.phaseId].approvalPolicy;
      return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities:[...new Set([...(policy.authorities??[]),...(policy.requiredAuthorities??[])])],minimum:1},actor.identity).authorityGroup;},
    plan:(workflow,request,facts,source)=>planWorkProductRecord(workflow,request,{...facts,operationId:source.asset.producer.operationId},source)
  };
  register('work-product.amend',amend);
  const execute={
    async read(snapshot,request,{signal,policyTraversal,principal,at,bound}={}){
      if(snapshot.workflow.currentPhase!==request.phaseId)fail('Data execution belongs to the current phase.','ENGINE_PHASE_UNAVAILABLE');
      const selected=await context(snapshot,request.phaseId,{signal,policyTraversal});
      if(!selected.phase.execution||selected.missing.length)fail('Retain the required data inputs before execution.','ENGINE_DATA_INPUT_REQUIRED',{missing:selected.missing});
      if(selected.contextSha256!==request.expected)fail('The inspected data input binding changed.','ENGINE_CONTEXT_CHANGED');
      await namespaceApprovedWorkProductInputs({observer,scope,workId},snapshot,selected,{signal,policyTraversal});
      const actual=await dataReader().source({...selected,operationId:principal.operationId,actor:principal.actor,agentId:principal.agentId,configuration:snapshot.configuration},request,{signal,bound}),
        declaration=selected.declaration.assets.find(row=>row.id===selected.phase.execution.output),
        asset=actual.data?{schemaVersion:1,profile:'sflow-work-product-reference/v1',projectId:scope.projectId,id:declaration.id,kind:declaration.kind,
          mimeType:declaration.mimeType,content:actual.report.output,revision:{scheme:'sha256',value:actual.report.output.sha256},
          observation:{at:actual.report.recordedAt,consistency:'retained-content',expiresAt:null},producer:{operationId:principal.operationId,adapterId:actual.report.manifest.id}}:null;
      return {generation:selected.binding.generation,asset,encoding:'utf8',operationId:principal.operationId,execution:actual.reference,observation:actual.observed,checks:actual.checks,status:actual.status,
        references:[...selected.references,...selected.assets.map(row=>row.asset.content),...actual.references],
        identity:{profile:'sflow-work-product-execution-source/v1',projectId:scope.projectId,contextSha256:selected.contextSha256,
          priorIndexSha256:hash({products:selected.state.products,executions:selected.state.executions,amendments:selected.state.amendments}),execution:actual.reference,reconciliation:actual.intent.reconciliation??null}};
    },authority:()=>null,
    plan:(workflow,request,facts,source)=>planWorkProductRecord(workflow,request,{...facts,operationId:source.operationId},source)
  };
  register('data.execute',execute);
  return Object.freeze({owners,readers,context,admitted,policy,json,dataReader});
}

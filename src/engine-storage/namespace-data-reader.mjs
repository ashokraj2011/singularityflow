/** Reopen actual terminal SGOS data execution without an interpreter, live handle or executor. */
import {createHash} from 'node:crypto';
import {WORK_PRODUCT_SCHEMAS,admitRecordSchemaVersion,canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {exactObject} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespaceSgosOperationalStore} from '../sgos/namespace-operational-store.mjs';
import {createRetainedExecutionReader} from '../sgos/retained-execution-reader.mjs';
import {validateExecutionUnitManifest,validateAgentTaskContract,sha256} from '../sgos/node-execution-values.mjs';
import {datasetSnapshot,evaluateDataCriteria} from '../kernel/work-products.mjs';
import {sqliteDataObservation,sqliteDataObservationPreview} from '../sgos/sql-data-values.mjs';
import {namespaceRuntimeReadPorts} from './namespace-runtime-read-ports.mjs';
const hash=v=>createHash('sha256').update(canonicalJson(v)).digest('hex'),same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export const dataExecutionKey=(scope,workId,operationId)=>'work-products/data/'+hash({scope,workId,operationId});
export const dataExecutionStoreId=(scope,workId)=>'data-'+hash({scope,workId}).slice(0,48);
export function createNamespaceDataReader({observer,scope,workId}){
  const readPorts=namespaceRuntimeReadPorts(observer,scope),history=createNamespaceSgosOperationalStore({...readPorts,scope,storeId:dataExecutionStoreId(scope,workId)});
  async function json(ref,signal){contentReference(ref);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await observer.bytes(ref,ref.bytes,signal)));}
    catch(cause){if(cause.code)throw cause;throw new SingularityFlowError('The retained data execution is not JSON.',{code:'ENGINE_STORAGE_CORRUPT',cause});}}
  async function record(operationId,{signal,reference=null}={}){
    if(reference===null){
      const entry=await observer.record('runtime',dataExecutionKey(scope,workId,operationId)+'/result',true,signal,true);
      if(!entry)return null;
      const v=entry.value;admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.transaction,v);
      if(v.profile!=='sflow-namespace-data-transaction/v1'||Object.keys(v).length!==3||contentReference(v.reference).namespace!=='evidence')fail('Another data execution result pointer.');
      reference=v.reference;
    }
    const report=await json(reference,signal);admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.execution,report);
    exactObject(report,['schemaVersion','profile','projectId','workId','operationId','phase','generation','contextSha256','kind','batchId','configuration','actor','agentId','recordedAt','manifest','contract','input','handle','output','observation']);
    if(contentReference(reference).namespace!=='evidence'||contentReference(report.input).namespace!=='evidence'||contentReference(report.observation).namespace!=='evidence'||report.output!==null&&contentReference(report.output).namespace!=='evidence')fail('Data evidence must remain in shared immutable evidence.');
    if(report.profile!=='sflow-data-execution/v1'||report.projectId!==scope.projectId||report.workId!==workId||report.operationId!==operationId)fail('Another data execution identity.');
    const intent=(await observer.record('runtime',dataExecutionKey(scope,workId,operationId)+'/intent',true,signal)).value;
    admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.transaction,intent);
    if(intent.profile!=='sflow-namespace-data-intent/v1'||['projectId','workId','operationId','phase','generation','contextSha256','configuration','actor','agentId','manifest','contract','input'].some(key=>!same(report[key],intent[key]))
      ||intent.request.expected!==report.contextSha256||intent.request.batchId!==report.batchId)fail('The execution report differs from its prepared authenticated task.');
    const manifest=validateExecutionUnitManifest(report.manifest),contract=validateAgentTaskContract(report.contract,manifest);
    if(manifest.provider!=='deterministic-sqlite'||manifest.models.length||contract.budgets.modelInvocations!==0
      ||contract.inputs.length!==1||contract.inputs[0]!=='evidence:'+report.input.sha256+':'+report.input.bytes)fail('The data task has another runtime or input binding.');
    const retained=createRetainedExecutionReader({store:history,content:readPorts.content,scope});
    const actual=await retained.collect(report.handle),events=await retained.events(report.handle);
    if(events.at(-1)?.recordedAt!==report.recordedAt)fail('The report restamped its original terminal observation.');
    if(actual.contractSha256!==contract.contractSha256||actual.executionUnitManifestSha256!==manifest.manifestSha256
      ||actual.outputSha256!==sha256(actual.output)||actual.output?.profile!=='sflow-sql-data-result/v1'
      ||actual.output.modelInvocations!==0||actual.output.process?.closed!==true)fail('Data execution has another terminal candidate.');
    const observation=await json(report.observation,signal);admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.observation,observation);
    if(!same(observation,sqliteDataObservation({output:actual.output,usage:actual.usage,recordedAt:report.recordedAt})))fail('The retained diagnostic differs from its actual SGOS result.');
    const data=actual.output.result===null?null:datasetSnapshot(actual.output.result.data);
    if(data){
      const output=await json(report.output,signal);
      if(actual.output.process.status!==0||actual.output.process.timedOut||!same(data,output))fail('The retained output differs from actual successful execution.');
      if(typeof actual.output.result.queryExecuted!=='boolean'||report.kind==='batch'&&!/^sha256:[a-f0-9]{64}$/u.test(actual.output.result.sink?.originalContractSha256??''))fail('The sink lost its actual original execution attribution.');
      if(report.kind==='batch'&&(actual.output.result.sink.batchId!==report.batchId||actual.output.result.sink.requestSha256!==((await json(report.input,signal)).requestSha256)||actual.output.result.sink.outputSha256!==report.output.sha256))fail('The sink acknowledgement differs from its original batch and output.');
      if(report.kind==='batch'&&actual.output.effect!=='confirmed'||report.kind==='query'&&actual.output.effect!=='none')fail('Another confirmed data effect.');
    }else if(report.output!==null)fail('A failed data run cannot claim an output dataset.');
    return {reference,report,intent,actual,data,observation,input:await json(report.input,signal)};
  }
  async function source(context,request,{signal,bound=null}={}){
    const execution=await record(context.operationId,{signal,reference:bound?.execution??null});
    if(!execution)fail('Run the declared data executor before retaining its evidence.','ENGINE_DATA_EXECUTION_REQUIRED',{operation:'data.execute'});
    const {report,data,input}=execution;
    if(!same(report.configuration,context.configuration)||!same(report.actor,context.actor)||report.agentId!==context.agentId)fail('Another actor or configuration cannot adopt a different data attempt.');
    if(report.contextSha256!==context.contextSha256||report.phase!==request.phaseId||report.generation!==context.binding.generation
      ||report.kind!==context.phase.execution.kind||report.batchId!==request.batchId)fail('The data result has another query, dataset, phase or generation.','ENGINE_DATA_EVIDENCE_STALE');
    const query=context.assets.find(row=>row.asset.id===context.phase.execution.query),queryBytes=await observer.bytes(query.asset.content,query.asset.content.bytes,signal),
      sql=new TextDecoder('utf-8',{fatal:true}).decode(queryBytes),datasets=[];
    for(const selected of context.phase.execution.inputs){
      const row=context.assets.find(r=>r.asset.id===selected.assetId);datasets.push({table:selected.table,data:await json(row.asset.content,signal)});
    }
    if(input.kind!==report.kind||input.query!==sql||input.batchId!==request.batchId||!same(input.datasets,datasets))fail('The executor used different retained inputs.');
    const checks=data?evaluateDataCriteria(context.phase.criteria,data):context.phase.criteria.map(c=>({criterionId:c.id,metric:c.metric,operator:c.operator,expected:c.expected,
      observed:null,status:'unavailable',diagnostic:'execution-failed'}));
    return {...execution,checks,status:data?(checks.every(c=>c.status==='passed')?'passed':'failed'):'unavailable',
      observed:{documentId:'DATA-'+context.operationId,reference:report.observation,...sqliteDataObservationPreview(execution.observation)},
      references:[execution.reference,report.input,report.observation,...(report.output?[report.output]:[]),...(execution.intent.reconciliation?[execution.intent.reconciliation.previous,execution.intent.reconciliation.observation]:[])]};
  }
  return Object.freeze({record,source,history,json});
}

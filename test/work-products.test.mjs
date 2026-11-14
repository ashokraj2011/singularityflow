import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetSnapshot,evaluateDataCriteria,workProductPolicy,workProductReference} from '../src/kernel/work-products.mjs';
const h='a'.repeat(64);
const dataset=()=>({schemaVersion:1,profile:'sflow-tabular-snapshot/v1',columns:[
  {name:'id',type:'integer',nullable:false},{name:'amount',type:'number',nullable:true}],
  rows:[{id:1,amount:20},{id:1,amount:30},{id:2,amount:null}]});
const policy=()=>({schemaVersion:1,profile:'sflow-work-product-policy/v1',requirements:[{id:'REQ-TOTAL',statement:'Report the actual expected total.',criteria:['AC-001']}],assets:[
  {id:'orders',kind:'dataset-snapshot',mimeType:'application/json'},
  {id:'query',kind:'query',mimeType:'application/sql'},
  {id:'result',kind:'report',mimeType:'application/json'}],
  phases:[{id:'define',inputs:[],outputs:['orders','query'],execution:null,criteria:[]},{id:'analyze',inputs:['orders','query'],outputs:['result'],
    execution:{adapterId:'local-data',kind:'query',query:'query',inputs:[{assetId:'orders',table:'orders'}],output:'result'},
    criteria:[{id:'AC-001',description:'Retain the expected total.',metric:{kind:'sum',column:'amount'},operator:'eq',expected:50}]}]});
test('data criteria retain actual failed and unavailable observations rather than boolean claims',()=>{
  const checks=[...policy().phases[1].criteria,
    {id:'AC-002',description:'Unique order identifiers.',metric:{kind:'distinct',column:'id'},operator:'eq',expected:3},
    {id:'AC-003',description:'No missing amounts.',metric:{kind:'nulls',column:'amount'},operator:'eq',expected:0},
    {id:'AC-004',description:'A required result column.',metric:{kind:'sum',column:'missing'},operator:'eq',expected:0}];
  const r=evaluateDataCriteria(checks,dataset());
  assert.deepEqual(r.map(x=>[x.status,x.observed]),[['passed',50],['failed',2],['failed',1],['unavailable',null]]);
  assert.equal(r[3].diagnostic,'column-missing');
});
test('an empty or all-null nonnumeric result cannot become a successful numeric aggregate',()=>{
  const criterion={id:'AC-EMPTY',description:'Observe a numeric total.',metric:{kind:'sum',column:'total'},operator:'eq',expected:0},
    snapshot={schemaVersion:1,profile:'sflow-tabular-snapshot/v1',columns:[{name:'total',type:'text',nullable:true}],rows:[]};
  for(const rows of [[],[{total:null}]]){const check=evaluateDataCriteria([criterion],{...snapshot,rows})[0];assert.equal(check.status,'unavailable');assert.equal(check.observed,null);assert.equal(check.diagnostic,'column-not-numeric');}
  const numeric={...snapshot,columns:[{name:'total',type:'number',nullable:true}]};
  assert.equal(evaluateDataCriteria([criterion],numeric)[0].status,'passed','an explicitly numeric empty sum retains its declared zero identity');
});
test('a policy binds exact non-software phases and work products without repositories',()=>{
  assert.deepEqual(workProductPolicy(policy(),{phaseIds:['define','analyze']}),policy());
  assert.throws(()=>workProductPolicy(policy(),{phaseIds:['implementation']}),{code:'ENGINE_WORK_PRODUCT_INVALID'});
  for(const modify of [
    p=>p.phases[1].inputs.push('absent'),p=>p.phases[1].outputs.push('query'),
    p=>p.phases[1].execution.inputs.push({assetId:'orders',table:'orders'}),
    p=>p.phases[1].criteria.push({...p.phases[1].criteria[0]}),
    p=>p.phases[1].criteria[0].expected=Infinity,p=>p.phases[1].execution=null,
    p=>{p.assets.push({id:'extra',kind:'report',mimeType:'application/json'});p.phases[1].outputs.push('extra');}]){
    const p=policy();modify(p);assert.throws(()=>workProductPolicy(p),/./);
  }
});
test('dataset schemas reject coercion, ambiguous columns, unknown fields and non-finite values',()=>{
  for(const modify of [
    d=>d.columns.push({...d.columns[0]}),d=>d.rows[0].id='1',d=>d.rows[0].id=Number.MAX_SAFE_INTEGER+1,
    d=>d.rows[0].amount=NaN,d=>d.rows[0].id=null,d=>d.rows[0].unapproved=true,
    d=>{d.columns[0].name='constructor';d.rows=[];},d=>{d.columns[0].name='prototype';d.rows=[];}]){
    const d=dataset();modify(d);assert.throws(()=>datasetSnapshot(d));
  }
  const d=dataset();datasetSnapshot(d);d.rows[0].amount=999;
  assert.equal(dataset().rows[0].amount,20);
});
test('immutable content, snapshot and live observations remain distinct',()=>{
  const r={schemaVersion:1,profile:'sflow-work-product-reference/v1',projectId:'analytics',id:'orders',
    kind:'dataset-snapshot',mimeType:'application/json',content:{namespace:'evidence',sha256:h,bytes:42},
    revision:{scheme:'snapshot',value:'orders-2026-11-14'},observation:{at:'2026-11-14T00:00:00.000Z',consistency:'snapshot',expiresAt:null},
    producer:{operationId:'retain-orders',adapterId:'data-input'}};
  assert.deepEqual(workProductReference(r,{projectId:'analytics'}),r);
  assert.throws(()=>workProductReference(r,{projectId:'other'}),{code:'ENGINE_WORK_PRODUCT_INVALID'});
  assert.throws(()=>workProductReference({...r,observation:{...r.observation,consistency:'retained-content'}}),{code:'ENGINE_WORK_PRODUCT_INVALID'});
  assert.throws(()=>workProductReference({...r,content:{...r.content,namespace:'local'}}),{code:'ENGINE_WORK_PRODUCT_INVALID'});
  assert.throws(()=>workProductReference({...r,schemaVersion:2}),{code:'SCHEMA_VERSION_FUTURE'});
  const copy=workProductReference(r);assert.throws(()=>{copy.producer.adapterId='other';},TypeError);assert.equal(r.producer.adapterId,'data-input');
});
test('new data acceptance binds every criterion and rejects cyclic or unreachable producers',()=>{
  const cyclic=policy();cyclic.phases[0].inputs=['result'];assert.throws(()=>workProductPolicy(cyclic),error=>error.code==='ENGINE_WORK_PRODUCT_INVALID'&&error.message.includes('cycle'));
  for(const modify of [p=>p.requirements=[],p=>p.requirements[0].criteria=['not-declared'],p=>p.phases[1].criteria=[],
    p=>{p.phases.push({id:'accept',inputs:['orders'],outputs:[],execution:null,criteria:[]});}]){
    const changed=policy();modify(changed);assert.throws(()=>workProductPolicy(changed,{phaseIds:['define','analyze',...(changed.phases.length===3?['accept']:[])]}));
  }
});

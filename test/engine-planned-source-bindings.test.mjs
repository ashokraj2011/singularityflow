/** Replay pre-extraction native file/plan/origin answers without a repository or authority claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {plannedSourceClauseBindingsReplay} from '../src/engine-compatibility/node-source-policy.mjs';
import {plannedSourceClauseBindings} from '../src/delivery-evidence.mjs';
import {predecessorSpecClauses as nativePredecessors} from '../src/specifications.mjs';
import {predecessorSpecClauses,plannedClaimAllocatedTo} from '../src/kernel/specification-policy.mjs';
import {plannedSourceBindingCases,plannedSourceBindingFixture} from './helpers/planned-source-bindings-fixture.mjs';
const oracle=JSON.parse(await readFile(new URL('./fixtures/planned-source-bindings/native-v1.json',import.meta.url),'utf8'));
const clean=(value,root='')=>JSON.parse(root?JSON.stringify(value).split(root).join('<checkout>'):JSON.stringify(value));
const errorValue=error=>({name:error.name,message:error.message,code:error.code,details:error.details,exitCode:error.exitCode});
test('source-clause compatibility comes from the original native policy and actual private-origin helpers',()=>{
  assert.equal(oracle.nativeCommit,'155b0a49fc5a8d2054210c2495658052907dc48d');assert.equal(oracle.cases.length,43);
  assert.equal(oracle.functionSha256,'f3211f61351d9e8fc85681f0e61cdac03a21c4887bdb51d1810e23866af63c89');
  assert.equal(oracle.sourceSha256,'6c521a3085f70ad857aef4d3004ccef082441be240637b2bde544619a967954a');
  assert.equal(nativePredecessors,predecessorSpecClauses);
});
for(const row of oracle.cases)test('native plan/source policy: '+row.id,async t=>{
  const {config,workflow,phase,sourcePaths,options}=row.input,run=plannedSourceClauseBindingsReplay(config,workflow,phase,sourcePaths,options);let cursor=0,actual;
  try{
    let step=run.next();while(!step.done){const request=step.value,saved=row.trace[cursor++];assert.ok(saved,row.id+': unexpected '+request.kind);
      assert.ok(Object.isFrozen(request));assert.equal(request.kind,saved.kind);
      for(const [key,value]of Object.entries(saved.fields)){
        // secureRepositoryPath reports the physical /private alias on Mac. Preserve the original
        // capture, but compare its root-independent member path with the semantic byte request.
        const expected=request.kind==='source-binding-bytes'&&key==='path'&&value.includes('<checkout>/')?value.split('<checkout>/').at(-1):value;
        assert.deepEqual(request[key],expected,row.id+': '+key);
      }
      if(saved.error){const error=Object.assign(new Error(saved.error.message),saved.error);step=run.throw(error);continue;}
      const value=request.kind==='source-binding-bytes'?Buffer.from(saved.value.base64,'base64'):
        ['carried-source-tags','story-added-source-tags'].includes(request.kind)&&saved.value!==null?new Set(saved.value):structuredClone(saved.value);
      step=run.next(value);
    }actual={value:step.value};
  }catch(error){if(error.code==='ERR_ASSERTION')throw error;actual={error:errorValue(error)};}
  assert.equal(cursor,row.trace.length,row.id+': every original observation is consumed');assert.deepEqual(clean(actual),row.expected);
  const f=await plannedSourceBindingFixture(plannedSourceBindingCases().find(value=>value.id===row.id));t.after(f.close);
  let bound;try{bound={value:await plannedSourceClauseBindings(f.root,f.config,f.workflow,f.phase,f.input.sourcePaths,f.input.options)};}catch(error){bound={error:errorValue(error)};}
  assert.deepEqual(clean(bound,f.root),row.expected);
});
test('allocation and predecessor projection keep later phases out and do not infer missing provenance',()=>{
  assert.equal(plannedClaimAllocatedTo({},'custom-code'),true);assert.equal(plannedClaimAllocatedTo({steps:['other']},'custom-code'),false);
  const records={indexes:[{phase:'scope',clauses:[{id:'A:REQ-001'}]},{phase:'late',clauses:[{id:'A:REQ-002'}]}]};
  assert.deepEqual(predecessorSpecClauses(records,{phaseOrder:['scope','custom-code','late']},'custom-code'),[{id:'A:REQ-001'}]);
  assert.deepEqual(predecessorSpecClauses(records,{},'missing'),[]);
});
test('real fact-owner permission and timeout errors retain their identity; policy-off requests read nothing',()=>{
  const row=oracle.cases.find(value=>value.id==='ready'),{config,workflow,phase,sourcePaths,options}=row.input;
  for(const failure of [Object.assign(Error('Original read denied.'),{code:'EACCES'}),Object.assign(Error('Original source deadline.'),{code:'ETIMEDOUT',timeoutMs:300000})]){
    const run=plannedSourceClauseBindingsReplay(config,workflow,phase,sourcePaths,options);assert.equal(run.next().value.kind,'source-binding-records');
    assert.throws(()=>run.throw(failure),error=>error===failure);
  }
  const run=plannedSourceClauseBindingsReplay({}, {resolution:{codeDelivery:{traceability:{sourceBindings:'off'}}}}, {},[]);
  assert.deepEqual(run.next(),{value:{mode:'off',required:[],bindings:[],missing:[]},done:true});
});

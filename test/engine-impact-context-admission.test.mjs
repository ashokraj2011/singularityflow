import test from 'node:test';import assert from 'node:assert/strict';import {createEngine} from '../src/engine-sdk/index.mjs';
const base={schemaVersion:4,profile:'sflow-namespace-evidence-reuse-context/v4',workId:'story',phase:'build',revision:'revision',
  purpose:'review-receiving-reuse',sourceObservation:'fresh',testsExecutedByReceiver:false,candidates:[],decisions:[],authorities:[],actions:[]},
  engine=facts=>createEngine({ports:{evidenceReuseContext:{load:()=>({subject:{kind:'story',id:'story'},workflow:{workItem:{id:'story'}},phase:{id:'build'}}),read:()=>facts}}});
test('malformed reuse contexts cannot escape as an internal TypeError or a legal recovery action',async()=>{
  await assert.rejects(engine({...base,candidates:[null]}).run('evidence-reuse.context',{phaseId:'build'}),{code:'ENGINE_PORT_RESULT_INVALID'});
  await assert.rejects(engine({...base,actions:[null]}).run('evidence-reuse.context',{phaseId:'build'}),{code:'ENGINE_PORT_RESULT_INVALID'});
  const candidate={taskId:'task',retainedExecution:true,checks:{result:{}},command:{id:'tests'},sourceMatches:true,environmentMatches:true,selectionCompatible:true};
  for(const selection of [{},{record:{}},{record:{context:{}}},{record:{phase:'older',context:{baseline:{operationId:'baseline'}}}},
    {record:{phase:'older',context:{baseline:{operationId:'baseline'}}},rows:[null]}]){
    const facts={...base,candidates:[{...candidate,selection}],actions:[{operation:'test-recovery.select-context',inputs:{workId:'story',phaseId:'older',baselineOperationId:'baseline'}}]};
    await assert.rejects(engine(facts).run('evidence-reuse.context',{phaseId:'build'}),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
});
test('selection context cannot change a manual request into analysis or claim impact under its old schema',async()=>{
  const load=()=>({subject:{kind:'story',id:'story'},workflow:{workItem:{id:'story'}}}),
    facts={schemaVersion:1,profile:'sflow-namespace-selective-test-recovery-context/v1',workId:'story',phase:'build',
      expectedContext:'sha256:'+'a'.repeat(64),executionMode:'changed-and-affected',testsExecuted:false,impactComplete:false,failuresWaived:false,rows:[{}],authorities:[]},
    create=value=>createEngine({ports:{selectiveTestRecoveryContext:{load,read:()=>value}}}),input={phaseId:'build',baselineOperationId:'baseline'};
  await assert.rejects(create(facts).run('test-recovery.select-context',{...input,selection:[{repositoryId:'app',commandId:'tests',files:['test.js']}]}),{code:'ENGINE_PORT_RESULT_INVALID'});
  await assert.rejects(create(facts).run('test-recovery.select-context',{...input,mode:'changed-and-affected'}),{code:'ENGINE_PORT_RESULT_INVALID'});
});

import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {consumeRepairAttempt,repairBudgetPhaseForRejection} from '../src/repair-budget.mjs';
const captured=JSON.parse(await readFile(new URL('./fixtures/repair-budget-values/native-v1.json',import.meta.url)));
const base=()=>({workItem:{id:'BUDGET-1'},phaseOrder:['scope','build','verify'],phases:{scope:{id:'scope',generation:1},build:{id:'build',repairBudget:{maxAttempts:2,resetOnPhase:'scope'}},
  verify:{id:'verify',status:'awaiting_approval',approvalPolicy:{rejectTo:['scope','build','verify']}}},resolution:{reworkLoops:[{from:'verify',to:'build',maxAttempts:2,resetOnPhase:'scope'}]}});
for(const expected of captured.cases)test('repair-budget values preserve captured native '+expected.scenario,()=>{
  const scenario=expected.scenario,workflow=base(),phase=workflow.phases.build;let result=null,error=null;
  try{if(['second','exhausted','in-progress','reset-requested','generation-reset','no-reset-route','caller-reset'].includes(scenario))for(let n=1;n<=(scenario==='second'?1:2);n++)
    consumeRepairAttempt(workflow,phase,{targetPhase:'build',actor:'reviewer',at:'2026-11-10T00:00:00.000Z',changeRequestId:'CR-00'+n,sourcePhase:workflow.phases.verify});
    if(scenario==='in-progress')workflow.phases.verify.status='in_progress';if(scenario==='generation-reset')workflow.phases.scope.generation=2;
    if(scenario==='no-reset-route')workflow.phases.verify.approvalPolicy.rejectTo=['build'];if(scenario==='policy-mismatch')phase.repairBudget.maxAttempts=1;
    if(['declared-edge','policy-mismatch','passing-review'].includes(scenario)){if(scenario==='passing-review'){workflow.resolution.reworkLoops=[];phase.validationVerdict='passed';result=repairBudgetPhaseForRejection(workflow,phase,'build');}
      else result=repairBudgetPhaseForRejection(workflow,workflow.phases.verify,'build');}
    else result=consumeRepairAttempt(workflow,phase,{targetPhase:scenario==='reset-requested'?'scope':'build',actor:'reviewer',at:'2026-11-10T01:00:00.000Z',changeRequestId:'CR-003',sourcePhase:workflow.phases.verify,...(scenario==='caller-reset'?{resetGeneration:99}:{})});
  }catch(e){error={name:e.name,message:e.message,code:e.code,details:e.details};}
  assert.deepEqual(JSON.parse(JSON.stringify({scenario,result,error,workflow})),expected);
});

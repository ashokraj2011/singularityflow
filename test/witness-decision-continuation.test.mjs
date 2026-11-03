import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionPacket, decisionRecordPlan, parseDecisionAnswers } from '../src/decision-list.mjs';
import { assertWitnessReviewBinding, witnessContextBinding } from '../src/verification/witness-records.mjs';
import { runWitnessReview, witnessReviewChoices } from '../apps/vscode/src/views/decision-list-model.ts';
import { buildDecisionListView } from '../apps/vscode/src/views/decision-list-model.ts';
import { decisionListHtml } from '../apps/vscode/src/views/decision-list-page.ts';

const W='GRAPH-1', C=`${W}:AC-001`, HASH=`sha256:${'f'.repeat(64)}`;
const authorities={engineering:{label:'Engineering reviewers',allowAnyGitIdentity:true,members:[]}};
const workflow=()=>({workItem:{id:W},currentPhase:'check',phaseOrder:['build','check','finish'],phases:{
  build:{id:'build',label:'Build',generation:1,status:'approved',approvalPolicy:{authorities:['engineering']}},
  check:{id:'check',label:'Check',generation:0,status:'in_progress'},finish:{id:'finish',status:'not_started'}},
  planAmendments:[{id:'PAM-001',changes:[{path:'src/test/setup.js',clauseId:C}],at:'2026-11-03T03:00:00Z'}]});
function packet(w=workflow(), evidence=[]) {
  return decisionPacket(w,{phaseId:w.currentPhase,repositoryPath:'/story-checkout',endsStory:false,gaps:[],issues:[],evidence,
    pending:{owed:[{kind:'witness',clauseId:C,slot:'plot',method:'visual',files:['evidence/plot.png'],owners:['build'],
      contextBinding:witnessContextBinding(w),command:`singularity-flow decision witness --work-id ${W} --criterion ${C} --slot plot --file evidence/plot.png`}]},
    state:{witnessRecords:(w.witnessRecords??[]).length}}, {authorities,actor:{email:'reviewer@example.invalid'},at:'2026-11-03T03:00:00Z'});
}
function host(p=packet()) {
  const calls=[];
  return {calls,read:async()=>p,choose:async choices=>choices[0],file:async()=> 'evidence/plot.png',digest:async()=>HASH,
    inspect:async()=>calls.push('inspect'),answer:async question=>{calls.push(question);return true;},reason:async()=> 'I inspected the current sine graph and its labels.',
    confirm:async detail=>{calls.push(detail);return true;},record:async(repository,argv)=>{calls.push({repository,argv});return {data:{record:{id:'WIT-001'}}};}};
}

test('an owed witness survives entry into a later custom phase without repeating completed plan accounting',()=>{
  for(const name of ['check','audit-results','delivery-review']) {
    const w=workflow();w.phases[name]={...w.phases.check,id:name,label:name};w.currentPhase=name;w.phaseOrder=['build',name,'finish'];
    const p=packet(w);
    assert.equal(p.open,1);assert.equal(p.items[0].holdsApproval,false);
    assert.equal(p.recorded[0].id,'PAM-001');
    assert.ok(p.recorded[0].summary.includes('src/test/setup.js'));
    assert.equal(p.items[0].kind,'owed-decision');
    assert.equal(p.items[0].options[0].recordable,false);
    assert.equal(witnessReviewChoices(p)[0].clauseId,C);
    assert.throws(()=>decisionRecordPlan(p,parseDecisionAnswers({choose:['d1=witness']})));
    const html=decisionListHtml(buildDecisionListView(p));
    assert.match(html,/Review evidence and sign off/u);
    assert.match(html,/Recorded plan accounting/u);
    assert.match(html,/PAM-001/u);
    assert.doesNotMatch(html,/data-option="witness"/u,'a model/list choice cannot stand in for the native witness checklist');
  }
});

test('the same terminal slot appears once when both owed and terminal evidence readers return it',()=>{
  const evidence=[{criterion:C,result:'partial',witnesses:[{slot:'plot',method:'visual',files:['evidence/plot.png'],command:'singularity-flow decision witness GRAPH-1'}],risks:[],categories:[]}];
  const p=packet(workflow(),evidence);
  assert.deepEqual(p.items.map(item=>item.kind),['evidence-obligation']);
  assert.equal(witnessReviewChoices(p).length,1);
});

test('native review records only human answers, after inspection, fresh binding and explicit confirmation',async()=>{
  const h=host();const result=await runWitnessReview({workId:W,criterion:C,slot:'plot'},h);
  assert.equal(result.status,'recorded');assert.equal(h.calls[0],'inspect');
  const {repository,argv}=h.calls.at(-1);
  assert.equal(repository,'/story-checkout');assert.equal(argv[0],'decision');assert.equal(argv[1],'witness');
  assert.equal(argv[argv.indexOf('--expected-file-sha256')+1],HASH);
  assert.equal(argv[argv.indexOf('--expected-context-sha256')+1],witnessContextBinding(workflow()));
  assert.equal(argv.filter(value=>value==='--confirm').length,3);
  assert.equal(argv.includes('--yes'),false);
});

test('closing any native checklist question or final confirmation records nothing',async()=>{
  for (let cancel=0;cancel<5;cancel++) {
    const h=host();let count=0;h.answer=async()=> count++===cancel?undefined:true;
    if(cancel===3)h.reason=async()=>undefined;
    if(cancel===4)h.confirm=async()=>false;
    assert.equal((await runWitnessReview({workId:W},h)).status,'cancelled');
    assert.equal(h.calls.some(call=>call.argv),false);
  }
});

test('a negative human answer stays negative and does not become a passing sign-off',async()=>{
  const h=host();h.answer=async()=>false;
  await runWitnessReview({workId:W},h);
  assert.equal(h.calls.at(-1).argv.filter(value=>value==='--deny').length,3);
  assert.equal(h.calls.at(-1).argv.includes('--confirm'),false);
});

test('a changed evidence file or candidate, and a review already completed elsewhere, never writes a duplicate',async()=>{
  for(const changed of ['file','candidate','completed']) {
    const original=packet(),h=host(original);let reads=0,digests=0;
    h.read=async()=>{if(reads++===0)return original;const fresh=structuredClone(original);
      if(changed==='completed')fresh.items=[];
      if(changed==='candidate')fresh.items[0].options[0].action.humanReview.contextBinding=HASH;
      return fresh;};
    h.digest=async()=>digests++===0||changed!=='file'?HASH:`sha256:${'a'.repeat(64)}`;
    await assert.rejects(runWitnessReview({workId:W},h),/changed while you inspected/u);
    assert.equal(h.calls.some(call=>call.argv),false);
  }
});

test('unavailable authority and wrong Story identity cannot open or record a review',async()=>{
  const p=packet();p.items[0].options[0].decidedBy.allowed=false;
  const h=host(p);assert.equal((await runWitnessReview({workId:W},h)).status,'unavailable');assert.equal(h.calls.length,0);
  await assert.rejects(runWitnessReview({workId:'OTHER'},host()),/verified Story checkout/u);
  await assert.rejects(runWitnessReview({workId:undefined},host()),/exact Story/u);
});

test('the writer verifies the native context and evidence hashes while preserving old terminal commands',()=>{
  const w=workflow(),binding=witnessContextBinding(w);
  assert.doesNotThrow(()=>assertWitnessReviewBinding(w,{expectedContext:binding,expectedFile:HASH,actualFile:HASH}));
  assert.doesNotThrow(()=>assertWitnessReviewBinding(w,{actualFile:HASH}));
  for(const input of [{expectedContext:HASH},{expectedFile:HASH,actualFile:'sha256:bad'},{expectedContext:'unbound'}]) {
    assert.throws(()=>assertWitnessReviewBinding(w,input),{code:'WITNESS_REVIEW_CHANGED'});
  }
  w.phases.build.deliveryEvidence={sourceTreeSha256:'new-source'};
  assert.throws(()=>assertWitnessReviewBinding(w,{expectedContext:binding,expectedFile:HASH,actualFile:HASH}),{code:'WITNESS_REVIEW_CHANGED'});
});

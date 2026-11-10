import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {namespaceSourceClauseFixture} from './helpers/namespace-source-clause-fixture.mjs';
import {PlanRowCorrectionSchema} from '../src/plan-row-corrections.mjs';
import {createEngine} from '../src/engine-sdk/index.mjs';
import {specificationText} from './helpers/namespace-specification-fixture.mjs';
import {WITNESS_CHECKLIST} from '../src/kernel/human-witnesses.mjs';
import {createNamespaceSpecificationReader} from '../src/engine-storage/namespace-specifications.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
const reason='Correct the reviewed delivery classification to this retained output; tests and final human inspection remain required.',
  bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]); // Isolated binary fixture, never production visual evidence.
function reviewer(f){const prior={principalId:f.control.principalId,agentId:f.control.agentId,creator:f.control.creator};
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  return ()=>Object.assign(f.control,prior);}
for(const backend of ['filesystem','sqlite','application'])test(backend+': retained evidence correction preserves approved intent, requires actual tests and human witness, and replays on takeover',{timeout:180000},async t=>{
  let input,recorded,original,content,file;const method=backend==='sqlite'?'inspection':'visual';
  const f=await namespaceTestWitnessFixture(t,{backend,afterPrepare:async(f,engine)=>{
    f.control.permissions.push('plan.correction.context','plan.correction.record','phase.draft.rebase');file='singularity/work-items/'+f.inputs.workId+'/evidence/proof.png';
    content=(await f.content.put(f.scope,'evidence',bytes)).reference;
    const request={ownerPhase:'design',operations:[{op:'reclassify-evidence',clauseId:'STORY-1:AC-001',path:file,method,content}],reason},restore=reviewer(f);
    try{original=await f.capture();const preview=await engine.run('plan.correction.context',request),p=preview.manifest.preview;
      assert.deepEqual(p.before['STORY-1:AC-001'].expectedPaths,['src/converter.js']);assert.equal(p.after['STORY-1:AC-001'].fulfillment,'evidence');
      assert.deepEqual(p.after['STORY-1:AC-001'].tests,p.before['STORY-1:AC-001'].tests);
      assert.equal(p.contractsAfter[0].slots.find(row=>row.method==='test').role,'supporting');
      assert.equal(p.contractsAfter[0].slots.find(row=>row.method===method).role,'primary');assert.deepEqual(await f.capture(),original);
      input={...request,operationId:'human-retained-evidence-correction',expectedPreview:'sha256:'+p.previewSha256};
      recorded=await engine.run('plan.correction.record',input);assert.equal(recorded.record.format,'sflow-namespace-plan-row-correction/v2');
      assert.deepEqual(recorded.record.operations[0].delivery,{phase:'build',generation:1});
      assert.equal(PlanRowCorrectionSchema.safeParse(recorded.record).success,false);
      assert.equal(Object.hasOwn(recorded.record,'reviewAssurance'),false);assert.deepEqual((await f.capture()).workflow.phases.design,original.workflow.phases.design);
    }finally{restore();}
    const draft=await engine.run('phase.draft.read',{phaseId:'build'});await engine.run('phase.draft.rebase',{operationId:'continue-evidence-correction',workId:f.inputs.workId,
      phaseId:'build',expectedRevision:draft.manifest.draft.revision,confirm:draft.manifest.draft.bodySha256,reason:'Continue the same generation after the exact human evidence correction.'});
  }});
  const publication=await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});assert.equal(publication.status,'published');
  const snapshot=await f.capture(),bound=snapshot.workflow.phases.build.publicationBindings[0],published=await f.json(bound.record),
    proof=published.policyEvidence.find(row=>row.kind==='code-delivery/v7'),report=await f.json((await f.json(proof.record)).report);
  assert.equal(report.preflight.repositories[0].delivery.fulfillment.find(row=>row.clauseId==='STORY-1:AC-001').paths[0].sha256,content.sha256);
  assert.equal(report.acceptance[0].contract.slots.find(row=>row.method===method).witness[method==='visual'?'target':'path'],file);assert.equal(f.starts(),1);
  await assert.rejects(f.approve('build'),{code:'ENGINE_WITNESS_DECISION_REQUIRED'});
  f.control.permissions.push('witness.context','decision.witness');const restore=reviewer(f);try{
    const query={clauseId:'STORY-1:AC-001',slotName:'retained-evidence',file},view=await f.engine.run('witness.context',query);
    assert.deepEqual(view.manifest.file.content,content);assert.equal(view.manifest.result.status,'missing');
    await f.engine.run('decision.witness',{...query,workId:f.inputs.workId,operationId:'human-inspected-corrected-output',expectedContext:view.manifest.contextBinding,
      expectedFile:'sha256:'+content.sha256,answers:Object.fromEntries(WITNESS_CHECKLIST.map(id=>[id,'yes'])),reason:'The fixture reviewer inspected the actual retained output for the exact criterion.'});
    assert.equal((await f.approve('build')).approval.selfApproval,false);
    const before=await f.capture(),shared=f.make({working:null,sources:[],sourceReaders:[],clock:{now(){throw Error('Replay cannot restamp the original correction.');}}});
    assert.deepEqual(await shared.run('plan.correction.record',input),recorded);assert.deepEqual(await f.capture(),before);
    const plans=createNamespaceSpecificationReader({observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId}),
      projected=await plans.sourcePlan(before,'build');assert.equal(projected.planned.claims['STORY-1:AC-001'].fulfillment,'evidence');
    assert.deepEqual(before.workflow.phases.design,original.workflow.phases.design);
  }finally{restore();}
});
test('evidence classification rejects unsafe scope, missing bytes, counterfeit authority and stale confirmation without changing the plan',async t=>{
  const f=await namespaceSourceClauseFixture(t);f.control.permissions.push('plan.correction.context','plan.correction.record');
  const content=(await f.content.put(f.scope,'evidence',bytes)).reference,path='singularity/work-items/'+f.inputs.workId+'/evidence/proof.png',
    operation={op:'reclassify-evidence',clauseId:'STORY-1:AC-001',path,method:'visual',content},request={ownerPhase:'design',operations:[operation],reason},
    before=await f.capture();
  for(const change of [{clauseId:'STORY-1:REQ-001'},{path:'other-story/evidence/proof.png'},{path:path.replace('proof.png','../proof.png')},
    {method:'test'},{content:{...content,namespace:'local'}},{testsWaived:true}]){
    await assert.rejects(f.engine.run('plan.correction.context',{...request,operations:[{...operation,...change}]}),{code:'PLAN_ROW_CORRECTION_INVALID'});
    assert.deepEqual(await f.capture(),before);}
  const denied=Object.freeze(Object.assign(Error('The actual retained output cannot be read.'),{code:'EACCES',path:'shared-output'})),
    unreadable=f.make({content:{...f.content,read(scope,ref,options){if(ref.sha256===content.sha256)throw denied;return f.content.read(scope,ref,options);}}});
  await assert.rejects(unreadable.run('plan.correction.context',request),error=>error===denied);
  const restore=reviewer(f);try{const context=await f.engine.run('plan.correction.context',request),input={...request,operationId:'exact-evidence-human',expectedPreview:'sha256:'+context.manifest.preview.previewSha256};
    for(const corrupt of [row=>{row.preview.operations[0].delivery.generation=2;},row=>{row.preview.operations[0].delivery.phase='review';},
      row=>{row.preview.operations[0].path='different.png';},row=>{row.preview.operations[0].content.sha256='f'.repeat(64);},row=>{row.preview.after['STORY-1:AC-001'].tests=[];}]){
      const returned=structuredClone(context.manifest);corrupt(returned);const engine=createEngine({ports:{planCorrectionContext:{
        load:()=>({subject:{kind:'story',id:f.inputs.workId},workflow:before.workflow}),read:()=>returned}}});
      await assert.rejects(engine.run('plan.correction.context',request),{code:'ENGINE_PORT_RESULT_INVALID'});}
    await assert.rejects(f.engine.run('plan.correction.record',{...input,expectedPreview:'sha256:'+'a'.repeat(64)}),{code:'PLAN_CORRECTION_REVIEW_CHANGED'});
    f.control.creator={name:'Unrelated reviewer',email:'unrelated@example.test',login:null};
    await assert.rejects(f.engine.run('plan.correction.record',input),{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});assert.deepEqual(await f.capture(),before);
  }finally{restore();}
});
test('a correction cannot demote the original specification primary automated-test requirement',async t=>{
  const specification=specificationText+'\n## Verification intent\n\n| Clause | Methods | Criterion |\n| --- | --- | --- |\n'
    +'| STORY-1:REQ-001 | test | STORY-1:AC-001 |\n| STORY-1:AC-001 | test | STORY-1:AC-001 |\n',
    f=await namespaceSourceClauseFixture(t,{specification});f.control.permissions.push('plan.correction.context');
  const before=await f.capture(),content=(await f.content.put(f.scope,'evidence',bytes)).reference;
  await assert.rejects(f.engine.run('plan.correction.context',{ownerPhase:'design',reason,operations:[{op:'reclassify-evidence',clauseId:'STORY-1:AC-001',
    path:'singularity/work-items/'+f.inputs.workId+'/evidence/proof.png',method:'visual',content}]}),{code:'SPEC_VERIFICATION_INTENT_INVALID'});
  assert.deepEqual(await f.capture(),before);
});
test('an interrupted classification resumes its exact retained content and never records a second correction',async t=>{
  const f=await namespaceSourceClauseFixture(t);f.control.permissions.push('plan.correction.context','plan.correction.record');const restore=reviewer(f);
  try{const content=(await f.content.put(f.scope,'evidence',bytes)).reference,request={ownerPhase:'design',reason,operations:[{op:'reclassify-evidence',clauseId:'STORY-1:AC-001',
    path:'singularity/work-items/'+f.inputs.workId+'/evidence/proof.png',method:'visual',content}]},context=await f.engine.run('plan.correction.context',request),
    input={...request,operationId:'resume-retained-evidence',expectedPreview:'sha256:'+context.manifest.preview.previewSha256},
    timeout=Object.freeze(Object.assign(Error('Actual classification acknowledgement lost.'),{code:'ETIMEDOUT',details:{deadlineMs:7341}}));let failed=false;
    const interrupted=f.make({records:{...f.records,async transact(scope,transaction,options){const accepted=await f.records.transact(scope,transaction,options);
      if(!failed&&transaction.changes.some(row=>row.namespace==='runtime'&&row.value?.operation==='plan.correction.record')){failed=true;throw timeout;}return accepted;}}});
    await assert.rejects(interrupted.run('plan.correction.record',input),error=>error===timeout);
    const result=await f.make({clock:{now(){throw Error('Resume the original human timestamp.');}}}).run('plan.correction.record',input);
    assert.equal(result.record.schemaVersion,2);assert.deepEqual(result.record.operations[0].content,content);const before=await f.capture();
    assert.equal(before.workflow.planAmendments.length,1);assert.deepEqual(await f.engine.run('plan.correction.record',input),result);assert.deepEqual(await f.capture(),before);
  }finally{restore();}
});

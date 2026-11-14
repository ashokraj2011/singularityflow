import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceSelectiveTestRecoveryFixture,selectionReason} from './helpers/namespace-selective-test-recovery-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
import {converterSource} from './helpers/namespace-source-clause-fixture.mjs';
const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};
test('actual selected failures remain failed and never receive a full-suite or baseline waiver',{timeout:120000},async t=>{
  const f=await namespaceSelectiveTestRecoveryFixture(t,{baselineFiles:{'test/first.test.js':"import test from 'node:test';import assert from 'node:assert/strict';import {convert} from '../src/converter.js';test('first stable regression',()=>assert.equal(convert(0),'0'));\n"},
    source:converterSource.replace('value.toString(16).toUpperCase()',"value===0?'broken':value.toString(16).toUpperCase()")});
  await f.confirm();await f.rebase();const result=await f.run();assert.equal(result.verdict,'failed');
  const failed=result.checks.find(row=>row.id==='legacy-tests');assert.equal(failed.tests.failed,1);assert.equal(failed.tests.passed,0);
  await assert.rejects(f.engine.run('phase.publish',publish),{code:'PHASE_CHECKS_NOT_PASSED'});
  assert.equal((await f.capture()).workflow.phases.build.generation,0);
});
test('a selected timeout retains the process deadline and cannot become missing or passing evidence',{timeout:120000},async t=>{
  const f=await namespaceSelectiveTestRecoveryFixture(t,{baselineFiles:{'test/first.test.js':"import test from 'node:test';import assert from 'node:assert/strict';import {convert} from '../src/converter.js';test('first stable regression',()=>assert.equal(convert(0),'0'));\n"},
    source:converterSource.replace('export const convert=value=>value.toString(16).toUpperCase();',"export const convert=value=>{if(value===0)while(true){}return value.toString(16).toUpperCase();};"),
    configure:source=>{source.definition.phases.build.qualityCommands.find(row=>row.id==='legacy-tests').timeoutMs=1000;}});
  await f.confirm();await f.rebase();const run=await f.run(),body=await f.json(run.record.content),
    selected=body.results.find(row=>row.commandId==='legacy-tests').candidate.output;
  assert.equal(run.verdict,'failed');assert.equal(selected.process.timedOut,true);assert.equal(selected.process.closed,true);
  assert.equal(run.checks.find(row=>row.id==='legacy-tests').status,'failed');
  await assert.rejects(f.engine.run('phase.publish',publish),{code:'PHASE_CHECKS_NOT_PASSED'});
});
test('planned acceptance files cannot be dropped by a human scope reduction',{timeout:120000},async t=>{
  const plan=planText.replaceAll('`test/converter.test.js`','`test/converter.test.js`, `test/second.test.js`'),f=await namespaceSelectiveTestRecoveryFixture(t,{plan});
  await assert.rejects(f.view(),error=>error.code==='SELECTIVE_TEST_REQUIRED_FILE_EXCLUDED'&&error.details.paths.includes('test/second.test.js'));
});
test('planning rejects a verification slot whose file is absent from its claimed test inventory',{timeout:120000},async t=>{
  const plan=planText+'\n## Verification contracts\n\n| Criterion | Slot | Method | Witness | Role | Combination |\n| --- | --- | --- | --- | --- | --- |\n'
    +'| STORY-1:AC-001 | converter | test | `test/converter.test.js` | primary | all |\n'
    +'| STORY-1:AC-001 | stable-slot | test | `test/second.test.js` | primary | all |\n';
  await assert.rejects(namespaceSelectiveTestRecoveryFixture(t,{plan}),{code:'SPEC_VERIFICATION_CONTRACT_INVALID'});
});
test('receipts preserve real read errors, and a lost confirmation acknowledgement cannot duplicate selection',{timeout:120000},async t=>{
  const f=await namespaceSelectiveTestRecoveryFixture(t),view=await f.view();f.human();
  const request={...f.contextInput,operationId:'interrupted-selection-review',expectedContext:view.manifest.expectedContext,reason:selectionReason,
    expires:'2026-11-20',followUpOwner:'suite-owner',remediationRef:'FIX-1'},failure=Object.assign(Error('Actual acceptance response timed out.'),{code:'ETIMEDOUT',timeoutMs:300000});let lost=false;
  const engine=f.make({records:{...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!lost&&args[1].events.some(row=>row.payload?.operation==='test-recovery.select-confirm')){lost=true;throw failure;}return result;}}});
  await assert.rejects(engine.run('test-recovery.select-confirm',request),error=>error===failure);assert.equal(lost,true);
  assert.equal((await engine.run('test-recovery.select-confirm',request)).status,'retained');
  const snapshot=await f.capture(),reference=snapshot.workflow.namespaceDecisionReceipts.find(row=>row.operation==='test-recovery.select-confirm').record;
  assert.equal(snapshot.workflow.namespaceSelectiveTestRecoveries.length,1);
  for(const code of ['EACCES','ETIMEDOUT','SDA_CONTENT_MISSING']){
    const failure=Object.assign(Error('The original selection record is unavailable.'),{code,path:'retained-selection',timeoutMs:300000}),broken=f.make({content:{...f.content,
      read(scope,ref,options){if(ref.sha256===reference.sha256)throw failure;return f.content.read(scope,ref,options);}}});
    await assert.rejects(broken.run('test-recovery.select-confirm',request),error=>error===failure);
  }
});
test('changed source needs renewed scope; an expired published selection cannot be submitted',{timeout:120000},async t=>{
  const f=await namespaceSelectiveTestRecoveryFixture(t);await f.confirm();await f.rebase();await f.run();await f.engine.run('phase.publish',publish);
  f.control.now='2026-11-21T00:00:00.000Z';
  await assert.rejects(f.engine.run('phase.submit',{phaseId:'build'}),{code:'SELECTIVE_TEST_RECOVERY_NOT_CURRENT'});
  f.human();const view=await f.view();await f.engine.run('test-recovery.select-confirm',{...f.contextInput,operationId:'renew-original-file-scope',expectedContext:view.manifest.expectedContext,
    reason:selectionReason,expires:'2026-12-01',followUpOwner:'suite-owner',remediationRef:'FIX-2'});f.author();
  await f.engine.run('phase.submit',{phaseId:'build'});assert.equal((await f.capture()).workflow.namespaceSelectiveTestRecoveries.length,2);assert.equal(f.starts(),4);
});
for(const sourceChanged of [false,true])test('a successor has an executable full-run fallback without inheriting selection: '+(sourceChanged?'changed-source rollover':'clean generation'),{timeout:120000},async t=>{
  const f=await namespaceSelectiveTestRecoveryFixture(t);f.control.permissions.push('phase.begin','phase.rollover');
  await f.confirm();await f.rebase();await f.run();await f.engine.run('phase.publish',publish);
  const original=(await f.capture()).workflow.phases.build.publicationBindings[0],file=path.join(f.root,'src/converter.js');
  if(sourceChanged){await writeFile(file,(await readFile(file,'utf8'))+'\n// Source change reviewed for the successor generation.\n');
    const preview=await f.engine.run('phase.rollover',{phaseId:'build'});
    await f.engine.run('phase.rollover',{phaseId:'build',confirm:preview.plan.confirmation});
  }else await f.engine.run('phase.begin',{phaseId:'build'});
  const draft=await f.engine.run('phase.draft.read',{phaseId:'build'});
  await f.engine.run('phase.draft.write',{operationId:'author-full-run-successor',workId:f.inputs.workId,phaseId:'build',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload('# Implementation\n\n## Agent brief\n\nThe reviewed successor keeps current converter acceptance and executes every configured regression.\n'),reason:selectionReason});
  await f.engine.run('phase.source.retain',{operationId:'retain-full-run-successor',workId:f.inputs.workId,phaseId:'build'});
  await assert.rejects(f.run('refused-inherited-selection'),error=>error.code==='SELECTIVE_TEST_RECOVERY_CONTEXT_CHANGED'
    &&(sourceChanged||error.details.selectedGeneration===1&&error.details.generation===2)
    &&error.details.actions.some(row=>row.operation==='test-recovery.select-confirm'&&row.inputs.revoke==='STR-001'));
  f.human();await f.engine.run('test-recovery.select-confirm',{operationId:'revoke-successor-selection',revoke:'STR-001',reason:selectionReason});
  await f.rebase('rebase-full-run-successor');const checked=await f.run('full-successor-execution');
  assert.equal(checked.execution,undefined);assert.equal(checked.checks.find(row=>row.id==='legacy-tests').tests.discovered,2);assert.equal(checked.verdict,'passed');
  await f.engine.run('phase.publish',publish);const phase=(await f.capture()).workflow.phases.build;
  assert.equal(phase.generation,2);assert.deepEqual(phase.publicationBindings[0],original);
});

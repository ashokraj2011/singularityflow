import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceTargetedRepairFixture,unrelatedSource,targetedReport} from './helpers/namespace-targeted-repair-fixture.mjs';
import {releasePublish} from './helpers/namespace-release-fixture.mjs';
for(const backend of ['sqlite','application','filesystem'])test(backend+': the returned plan-repair action authorizes exact shared support without resetting Code or its original targeted return',{timeout:600000},async t=>{
  const f=await namespaceTargetedRepairFixture(t,{backend}),request={...f.request,clauseIds:['STORY-1:REQ-001','STORY-1:AC-001']};
  const returned=await f.reviewer.run('phase.reject',request);assert.deepEqual(returned.changeRequest.clauseIds,request.clauseIds);await f.begin();
  await writeFile(path.join(f.root,'src/other.js'),unrelatedSource+'\n// @clause:STORY-1:REQ-001 Converts the selected integer into its uppercase hexadecimal output.\nexport const convertHex=value=>value.toString(16).toUpperCase();\n');
  await writeFile(path.join(f.root,'src/converter.js'),"import {convertHex} from './other.js';\n// @clause:STORY-1:AC-001 Returns FF for the approved 255 example through the shared implementation.\nexport const convert=value=>convertHex(value);\n");
  await f.engine.run('phase.source.retain',{operationId:'shared-support-candidate',workId:f.inputs.workId,phaseId:'build'});await f.runChecks('shared-support-diagnostic-tests');
  let failure;await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',...releasePublish}),error=>{failure=error;return error.code==='ENGINE_TARGETED_REPAIR_SCOPE_EXCEEDED';});
  const action=failure.details.actions.find(row=>row.operation==='plan.correction.context');assert.equal(action.inputs.ownerPhase,'design');assert.equal(Object.hasOwn(action.inputs,'phaseId'),false);
  const query={...action.inputs,operations:[{op:'replace-location',clauseId:'STORY-1:REQ-001',from:'src/converter.js',to:'src/other.js'}],
    reason:'The converter now delegates to the exact shared implementation; preserve the identity operation and its independent regression.'},
    context=await f.reviewer.run(action.operation,query),decision=await f.reviewer.run('plan.correction.record',{...query,operationId:'human-shared-converter-location',expectedPreview:'sha256:'+context.manifest.preview.previewSha256});
  assert.equal(decision.record.id,'PRC-001');assert.equal((await f.capture()).workflow.phases.build.generation,1);
  await f.write('build','# Targeted converter repair\n\n## Agent brief\n\nUse the exact human-reviewed shared implementation while retaining the identity regression.\n');
  await f.engine.run('phase.source.retain',{operationId:'approved-shared-support',workId:f.inputs.workId,phaseId:'build'});await f.runChecks('approved-shared-support-tests');
  await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});await f.approve('build');
  const {report}=await f.published('build'),history=report.preflight.history;
  assert.deepEqual(history.targeted.source.scope.repositories[0].paths,['src/converter.js','test/converter.test.js']);
  assert.deepEqual(history.targeted.scope.repositories[0].paths,['src/converter.js','src/other.js','test/converter.test.js']);
  assert.ok(history.targeted.scope.repositories[0].shared.some(row=>row.path==='src/other.js'&&row.clauseIds.includes('STORY-1:REQ-002')));
  assert.ok(history.targeted.plan.amendments.some(row=>row.operation==='plan.correction.record'));
  const snapshot=await f.capture();assert.equal(snapshot.workflow.changeRequests.length,1);assert.equal(snapshot.workflow.namespaceRepairBudgetHistory.length,1);assert.equal(snapshot.workflow.phases.build.generation,2);
  f.control.agentId='release-reviewer';await f.write('release',targetedReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),3);
  for(const root of f.roots)await rm(root,{recursive:true,force:true});assert.deepEqual(await f.reviewer.run('phase.reject',request),returned);
});

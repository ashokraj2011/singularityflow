import test from 'node:test';import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceTestWitnessFixture,actualWitnessTest} from './helpers/namespace-test-witness-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {testWitnessInspectionManifest} from '../src/kernel/verification-witnesses.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': exact Node identities join the actual accepted run, with no execution or Story effect during inspection',async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend}),before=await f.head(),starts=f.starts(),result=await f.inspect(),m=result.manifest;
  assert.equal(m.contract,'sflow-test-witness-inspection/v1');assert.equal(m.status,'observed');assert.equal(m.paths.length,1);
  assert.equal(m.paths[0].status,'met');assert.equal(m.paths[0].witnesses[0].execution,'exact-local-observed');
  assert.equal(m.paths[0].clauseId,'STORY-1:AC-001');assert.equal(m.paths[0].witnesses[0].line,5);
  assert.equal(m.testEvidenceOnly,true);assert.equal(m.verificationContractsCombined,false);assert.equal(m.applicationAcceptanceEstablished,false);
  assert.ok(m.requiredPolicyOwners.includes('code-delivery'));assert.equal(result.effects.testsRun,false);
  assert.deepEqual(await f.head(),before);assert.equal(f.starts(),starts);
  const bounded=(await f.inspect({maximumEntries:0})).manifest;assert.equal(bounded.paths.length,0);assert.equal(bounded.totals.witnesses,1);assert.equal(bounded.truncated,true);
  const fields=['workId','phase','revision','authorityVersion','configuration','draft','status','plan','source','checks','control','repositories','totals','paths','truncated','requiredPolicyOwners'],facts=Object.fromEntries(fields.map(key=>[key,m[key]]));
  assert.throws(()=>testWitnessInspectionManifest(m.workId,m.phase,{...facts,approved:true},200),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.throws(()=>testWitnessInspectionManifest(m.workId,m.phase,{...facts,totals:{...m.totals,met:0}},200),{code:'ENGINE_PORT_RESULT_INVALID'});
  await assert.rejects(f.engine.run('phase.test-witnesses.inspect',{phaseId:'build',ready:true}),{code:'ENGINE_INPUT_INVALID'});
  if(backend==='filesystem'){
    f.control.agentId=null;f.control.permissions=['phase.source.inspect'];
    const reader=createNamespaceEngine({...f.options,clock:{now(){throw Error('A read cannot allocate a new timestamp.');}}});
    assert.equal((await reader.run('phase.test-witnesses.inspect',{phaseId:'build'})).manifest.paths[0].status,'met');
    const checks=createNamespacePhaseCheckReader(f.common),found=await checks.accepted({operationId:'witness-execution',workId:f.inputs.workId,phaseId:'build'}),
      stdout=found.body.results[0].candidate.output.stdout.sha256,original=Object.assign(new Error('Original retained report read deadline.'),{code:'ETIMEDOUT'}),
      content={...f.content,read(scope,reference,options){if(reference.sha256===stdout)throw original;return f.content.read(scope,reference,options);}},
      refused=createNamespaceEngine({...f.options,content});
    await assert.rejects(refused.run('phase.test-witnesses.inspect',{phaseId:'build'}),error=>error===original);
  }
});
test('passing counts without retained exact Node identities cannot verify a declaration',async t=>{
  const f=await namespaceTestWitnessFixture(t,{reporter:false}),m=(await f.inspect()).manifest;
  assert.equal(m.paths[0].status,'missing');assert.equal(m.paths[0].witnesses[0].execution,'module-observed');
  assert.deepEqual(m.paths[0].witnesses[0].reasons,['NO_OCCURRENCE']);assert.equal(m.totals.met,0);
});
test('an unrelated passing test cannot stand in for the tagged skipped declaration',async t=>{
  const source=actualWitnessTest.replace("test('converts the approved value'","test.skip('converts the approved value'")+"test('unrelated pass',()=>assert.equal(2+2,4));\n",
    f=await namespaceTestWitnessFixture(t,{testSource:source}),m=(await f.inspect()).manifest;
  assert.equal(m.paths[0].status,'missing');assert.equal(m.paths[0].witnesses[0].outcome,'unverified-skipped');assert.equal(m.totals.met,0);
});
test('an unattached tag is a concrete gap instead of a file-level pass',async t=>{
  const f=await namespaceTestWitnessFixture(t,{testSource:actualWitnessTest.replace('// @ac:STORY-1:AC-001\n', '// @ac:STORY-1:AC-001\nconst unrelated=1;\n')}),m=(await f.inspect()).manifest;
  assert.equal(m.paths[0].status,'missing');assert.equal(m.paths[0].witnessCount,0);assert.ok(m.paths[0].gaps.includes('code.delivery.acceptance-tag-unattached'));
});
test('failed tagged execution remains failed even when its report was retained successfully',async t=>{
  const f=await namespaceTestWitnessFixture(t,{testSource:actualWitnessTest.replace("'FF'","'FE'")}),m=(await f.inspect()).manifest;
  assert.equal(m.paths[0].status,'failed');assert.equal(m.paths[0].witnesses[0].outcome,'failed');assert.equal(m.totals.failed,1);
});
test('duplicate exact test names remain ambiguous instead of borrowing either passing occurrence',async t=>{
  const f=await namespaceTestWitnessFixture(t,{testSource:actualWitnessTest+"// @ac:STORY-1:AC-001\ntest('converts the approved value',()=>assert.equal(convert(255),'FF'));\n"}),m=(await f.inspect()).manifest;
  assert.equal(m.paths[0].status,'inconclusive');assert.ok(m.paths[0].witnesses.every(witness=>witness.outcome==='inconclusive'||witness.outcome==='ambiguous'));
});
test('no run and a later source revision have explicit check routes and never reuse another candidate',async t=>{
  const f=await namespaceTestWitnessFixture(t,{run:false});let m=(await f.inspect()).manifest;
  assert.equal(m.paths[0].status,'missing');assert.ok(m.actions.some(row=>row.operation==='phase.checks.run'));
  await f.runChecks();await writeFile(path.join(f.root,'src/converter.js'),"// @clause:STORY-1:REQ-001 A later candidate.\nexport const convert=value=>'changed';\n");
  m=(await f.inspect()).manifest;assert.equal(m.paths[0].status,'met','the retained original test still passed its original candidate');
  assert.equal(m.repositories[0].sourceMatched,false);assert.equal(m.repositories[0].checksMatched,false);
  assert.ok(m.actions.some(row=>row.operation==='phase.source.retain'));assert.ok(m.actions.some(row=>row.operation==='phase.checks.run'));
  await f.engine.run('phase.source.retain',{operationId:'witness-later-source',workId:f.inputs.workId,phaseId:'build'});
  m=(await f.inspect()).manifest;assert.equal(m.paths[0].status,'missing');assert.ok(m.paths[0].gaps.includes('CHECK_SOURCE_BINDING_MISMATCH'));
});
test('identical relative files and logical IDs in two repositories keep their own actual run outcomes',async t=>{
  const plan=planText.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`')
    .replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')
    +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | `frontend` |\n| service-1 | `backend` |\n',
    f=await namespaceTestWitnessFixture(t,{repositories:2,plan,testSource:index=>index?actualWitnessTest.replace("'FF'","'FE'"):actualWitnessTest}),m=(await f.inspect()).manifest;
  assert.equal(m.paths.find(row=>row.repositoryId==='app').status,'met');assert.equal(m.paths.find(row=>row.repositoryId==='service-1').status,'failed');
  assert.equal(m.totals.met,1);assert.equal(m.totals.failed,1);assert.ok(m.plan.repositoryPlan);assert.equal(m.applicationAcceptanceEstablished,false);
});
test('a shared namespace needs original accepted AC-line provenance and carried tags do not become this Story’s witnesses',async t=>{
  const own=await namespaceTestWitnessFixture(t,{shared:true});assert.equal((await own.inspect()).manifest.paths[0].status,'met');
  const carried=await namespaceTestWitnessFixture(t,{shared:true,baselineTestSource:actualWitnessTest}),m=(await carried.inspect()).manifest;
  assert.equal(m.paths[0].status,'missing');assert.equal(m.paths[0].witnessCount,0);assert.equal(m.totals.met,0);
});

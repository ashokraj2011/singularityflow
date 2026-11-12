import test from 'node:test';import assert from 'node:assert/strict';import {rm} from 'node:fs/promises';
import {namespaceConvergenceFixture} from './helpers/namespace-convergence-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
test('convergence human decisions retain original evidence, replace an answer explicitly and replay after source deletion',{timeout:300000},async t=>{
  const f=await namespaceConvergenceFixture(t),before=await f.head(),entry=await f.engine.run('convergence.context',{phaseId:'release'}),
    manifest=entry.manifest,item=manifest.projection.projection.settledByPlan.find(row=>row.paths.includes('README.md'));
  assert.ok(item);assert.deepEqual(manifest.projection.projection.facts,[]);assert.equal(manifest.actions[0].operation,'phase.prepare');
  assert.equal(entry.effects.committed,false);assert.deepEqual(await f.head(),before);assert.equal(f.starts(),1);
  const request={operationId:'return-reviewed-document',workId:f.inputs.workId,phaseId:'release',itemId:item.id,disposition:'rework',
    reason:'The reviewer requires the actual supporting documentation to be checked again.',expectedContext:manifest.contextBinding},
    lost=Object.assign(Error('The accepted convergence answer acknowledgement timed out.'),{code:'ETIMEDOUT',details:{deadlineMs:300000}});let interrupted=false;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!interrupted&&args[1].events.some(row=>row.payload?.operation==='convergence.adjudicate')){interrupted=true;throw lost;}return result;}};
  const dropping=createNamespaceEngine({...f.options,records,access:f.reviewerAccess});
  await assert.rejects(dropping.run('convergence.adjudicate',request),actual=>actual===lost);assert.equal(interrupted,true);
  const recorded=await f.reviewer.run('convergence.adjudicate',request);assert.equal(recorded.record.adjudication.disposition,'rework');
  const acceptedHead=await f.head();assert.deepEqual(await f.reviewer.run('convergence.adjudicate',request),recorded);assert.deepEqual(await f.head(),acceptedHead);
  await assert.rejects(f.reviewer.run('convergence.adjudicate',{...request,disposition:'dismissed'}),{code:'ENGINE_OPERATION_ID_REUSED'});
  const blocked=(await f.engine.run('convergence.context',{phaseId:'release'})).manifest;
  assert.equal(blocked.projection.projection.unresolvedBlockers.length,1);
  assert.ok(blocked.actions.some(row=>row.operation==='upstream.raise'&&row.inputs.phaseId==='build'&&row.requiredInputs.includes('authored')));
  const amended={...request,operationId:'accept-reviewed-document',disposition:'accepted-deviation',
    reason:'The independent reviewer inspected the retained documentation and accepts this exact supporting change.',expectedContext:blocked.contextBinding};
  const corrected=await f.reviewer.run('convergence.adjudicate',amended);
  assert.equal(corrected.record.adjudication.replaced[0].disposition,'rework');
  const ready=(await f.engine.run('convergence.context',{phaseId:'release'})).manifest;
  assert.deepEqual(ready.projection.projection.unresolvedBlockers,[]);assert.equal(ready.actions[0].operation,'phase.prepare');
  assert.equal(ready.decisions.length,2);assert.equal(f.starts(),1);
  const finalHead=await f.head();for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const replay=createNamespaceEngine({...f.common,access:f.reviewerAccess,clock:{now(){throw Error('Replay must not restamp the original human answer.');}}});
  assert.deepEqual(await replay.run('convergence.adjudicate',request),recorded);
  assert.deepEqual(await replay.run('convergence.adjudicate',amended),corrected);assert.deepEqual(await f.head(),finalHead);
});

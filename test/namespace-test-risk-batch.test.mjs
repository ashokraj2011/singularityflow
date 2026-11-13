import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestRiskFixture,testRiskReason} from './helpers/namespace-test-risk-fixture.mjs';
test('the offered risk revocation executes through the same registry once and replays its original batch',{timeout:120000},async t=>{
  const f=await namespaceTestRiskFixture(t);f.accessControl.permissions.push('decisions.record');f.human();await f.engine.run('decision.test-risk',f.request);
  const shown=await f.engine.run('decisions.list'),policy=shown.manifest.policy,item=policy.offered.find(row=>row.kind==='test-run-risk');assert.ok(item);
  const input={confirmation:policy.packetSha256,answers:{choose:{[item.id]:'revoke-test-risk'},reason:{[item.id]:testRiskReason}}},
    result=await f.engine.run('decisions.record',input);assert.equal(result.effects.recordedEntries,1);
  const snapshot=(await f.observer.inspect()).snapshot;assert.equal(snapshot.workflow.namespaceTestRunRisks.length,2);assert.equal(snapshot.workflow.namespaceTestRunRisks[1].revokes,'TRR-001');
  assert.deepEqual(await f.engine.run('decisions.record',input),result);assert.deepEqual((await f.observer.inspect()).snapshot,snapshot);assert.equal(f.control.starts,0);
});

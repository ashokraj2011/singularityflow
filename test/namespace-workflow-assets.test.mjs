import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': approved workflow inventory preserves transitive names without body reads or mutations',async t=>{
  const f=await namespaceEngineFixture(t,{backend});f.control.permissions.push('workflow.assets');await f.bootstrap();
  const no=()=>{throw Error('Inventory cannot write or discover local files.');},engine=f.make({records:{...f.records,transact:no},content:{...f.content,put:no}}),
    before=await f.capture(),result=await engine.run('workflow.assets',{workflowIds:['simple']});
  assert.deepEqual(result.manifest.dependencies.workflows,['story:simple']);assert.deepEqual(result.manifest.dependencies.agents,['analyst']);
  assert.deepEqual(result.manifest.dependencies.skills,['framework']);assert.deepEqual(result.manifest.dependencies.instructions,['coding','testing']);
  assert.deepEqual(result.manifest.dependencies.phases,['story:intake']);assert.equal(result.manifest.summary.templates,1);
  assert.equal(result.manifest.contentIncluded,false);assert.equal(result.manifest.approvalRecorded,false);
  assert.deepEqual(await engine.run('workflow.assets',{workflowIds:['story:simple']}),result);assert.deepEqual(await f.capture(),before);
  await assert.rejects(engine.run('workflow.assets',{workflowIds:['missing']}),{code:'WORKFLOW_NOT_FOUND'});
});

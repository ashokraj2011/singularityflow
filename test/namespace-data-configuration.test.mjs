import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceConfigurationFixture} from './helpers/namespace-configuration-fixture.mjs';
import {namespaceDataFixture} from './helpers/namespace-data-fixture.mjs';
import {workProductPolicy} from '../src/kernel/work-products.mjs';
import {namespaceConfigurationCompiledValue} from '../src/engine-storage/namespace-configuration-contract.mjs';
test('new configuration versions preserve Copilot as the only admitted AI harness',async t=>{
  const f=await namespaceConfigurationFixture(t),definition=structuredClone(f.source);definition.schemaVersion=2;definition.format='sflow-namespace-configuration-source/v2';definition.workProducts={};
  definition.definition.models={defaultProvider:'team-copilot',providers:{'team-copilot':{type:'copilot-cli'}}};
  const source=await f.store(definition),approved=await f.engine.run('configuration.approve',{...f.inputs,source,confirm:source.sha256});
  const compiled=JSON.parse(Buffer.from((await f.content.read(f.scope,approved.configuration)).data));assert.equal(compiled.schemaVersion,2);
  assert.equal(compiled.definition.models.providers['team-copilot'].type,'copilot-cli');
  for(const type of ['direct-provider','bridge-harness']){const changed=structuredClone(definition);changed.definition.models.providers['team-copilot'].type=type;const source=await f.store(changed);
    await assert.rejects(f.engine.run('configuration.approve',{...f.inputs,operationId:'invalid-'+type,source,confirm:source.sha256,expectedRevision:approved.revision}),/not supported/u);}
});
test('data policy compilation rejects missing requirement bindings, future dependencies and incomplete closing acceptance',async t=>{
  const f=await namespaceDataFixture(t),state=await f.capture(),policy=state.workflow.resolution.workProducts;
  for(const modify of [p=>p.requirements=[],p=>p.requirements[0].criteria=['unknown'],p=>p.phases[1].criteria=[],p=>p.phases[2].inputs=[]]){
    const changed=structuredClone(policy);modify(changed);assert.throws(()=>workProductPolicy(changed,{phaseIds:state.workflow.phaseOrder}),{code:'ENGINE_WORK_PRODUCT_INVALID'});
  }
  assert.throws(()=>workProductPolicy(policy,{phaseIds:['analyze','intake','accept']}),{code:'ENGINE_WORK_PRODUCT_INVALID'});
  const approval=await f.configurationEngine.run('configuration.approve',{...f.configurationInputs,operationId:'configuration-custom',source:state.workflow.resolution.configurationSource,
    confirm:state.workflow.resolution.configurationSource.sha256,expectedRevision:f.approval.revision});
  const compiled=JSON.parse(Buffer.from((await f.content.read(f.scope,approval.configuration)).data)),broken=structuredClone(compiled);broken.workProducts.simple.phases[1].criteria[0].expected=999;
  assert.throws(()=>namespaceConfigurationCompiledValue(broken,compiled.source),{code:'ENGINE_STORAGE_CORRUPT'});
});

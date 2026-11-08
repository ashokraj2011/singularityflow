/** Real durable effects are interleaved at specific reads; no readiness or receipts are mocked. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { namespaceProjectFixture } from './helpers/namespace-project-fixture.mjs';
import { namespaceConfigurationFixture } from './helpers/namespace-configuration-fixture.mjs';
import { namespaceStoryFixture } from './helpers/namespace-story-fixture.mjs';

const scenarios=[
  {name:'enrollment',fixture:namespaceProjectFixture,operation:'project.enroll',prefix:'enrollment/prepared/',hook:'hook',input:()=>({operationId:'enroll-interleaved'})},
  {name:'configuration',fixture:namespaceConfigurationFixture,operation:'configuration.approve',prefix:'configuration/prepared/',hook:'reviewHook',input:f=>f.inputs},
  {name:'Story',fixture:namespaceStoryFixture,operation:'story.create',prefix:'stories/prepared/',hook:'storyHook',input:f=>f.inputs}
];

for(const backend of ['filesystem','sqlite','application'])for(const scenario of scenarios) {
  test(`${backend}: ${scenario.name} acknowledges a preparation that commits between its intent read and receipt inspection`,async t=>{
    const f=await scenario.fixture(t,{backend}),inputs=scenario.input(f);let injected=false,original;
    const records={...f.records,async read(...args){
      const result=await f.records.read(...args);
      if(!injected&&args[1]==='runtime'&&args[2].startsWith(scenario.prefix)&&result.status==='missing') {
        injected=true;original=await f.make().run(scenario.operation,inputs);
      }
      return result;
    }};
    const acknowledged=await f.make({records}).run(scenario.operation,inputs);
    assert.equal(injected,true);assert.equal(original.replayed,false);
    assert.deepEqual(acknowledged,{...original,replayed:true});
  });
  test(`${backend}: ${scenario.name} acknowledges the identical operation completed after its initial receipt check`,async t=>{
    const f=await scenario.fixture(t,{backend}),inputs=scenario.input(f);let injected=false,original;
    f.control[scenario.hook]=async()=>{
      if(injected)return;injected=true;original=await f.make().run(scenario.operation,inputs);
    };
    const acknowledged=await f.make().run(scenario.operation,inputs);
    assert.equal(injected,true);assert.deepEqual(acknowledged,{...original,replayed:true});
  });
}

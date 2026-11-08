/** A host's selectors are sampled once, so read and write owners cannot receive different roots. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceProjectEngine} from '../src/engine-storage/namespace-project.mjs';
import {createNamespaceConfigurationEngine} from '../src/engine-storage/namespace-configuration.mjs';
import {createNamespaceStoryEngine} from '../src/engine-storage/namespace-story.mjs';
import {createNamespaceSourceEngine} from '../src/engine-storage/namespace-source.mjs';
import {createNamespacePreparationEngine} from '../src/engine-storage/namespace-preparation.mjs';
import {createNamespacePublicationEngine} from '../src/engine-storage/namespace-publication.mjs';
import {createNamespaceSubmissionEngine} from '../src/engine-storage/namespace-submission.mjs';
import {createNamespaceApprovalEngine} from '../src/engine-storage/namespace-approval.mjs';
import {createNamespaceRoutingChoiceEngine} from '../src/engine-storage/namespace-routing-choice.mjs';
const hosts=[createNamespaceProjectEngine,createNamespaceConfigurationEngine,createNamespaceStoryEngine,createNamespaceSourceEngine,
  createNamespacePreparationEngine,createNamespacePublicationEngine,createNamespaceSubmissionEngine,createNamespaceApprovalEngine,createNamespaceRoutingChoiceEngine];
function selected(values) {
  const calls={},options={};
  for(const [key,value]of Object.entries(values))Object.defineProperty(options,key,{enumerable:true,get(){calls[key]=(calls[key]??0)+1;return value;}});
  return {options,calls};
}
for(const factory of hosts)test(`${factory.name}: options selectors have one consistent read/write binding`,async t=>{
  const f=await namespaceEngineFixture(t),values={...f.options,localRecords:f.local.records,localContent:f.local.content,sources:[],modelEnabled:true,notice:()=>{}};
  const {options,calls}=selected(values);factory(options);
  for(const [key,count]of Object.entries(calls))assert.equal(count,1,`${factory.name} sampled ${key} more than once`);
});
test('the combined Engine captures every declared option once',async t=>{
  const f=await namespaceEngineFixture(t),{options,calls}=selected({...f.options,sources:[],modelEnabled:true,notice:()=>{}});
  createNamespaceEngine(options);
  for(const [key,count]of Object.entries(calls))assert.equal(count,1,`The combined Engine sampled ${key} more than once`);
});
test('legacy publication ignores unknown option accessors and the combined host rejects their names without executing them',async t=>{
  const f=await namespaceEngineFixture(t),options={...f.options,localRecords:f.local.records,localContent:f.local.content};
  Object.defineProperty(options,'ignoredOption',{enumerable:true,get(){throw Error('An ignored option accessor executed.');}});
  assert.doesNotThrow(()=>createNamespacePublicationEngine(options));
  const combined={...f.options};Object.defineProperty(combined,'ignoredOption',{enumerable:true,get(){throw Error('A refused option accessor executed.');}});
  assert.throws(()=>createNamespaceEngine(combined),{code:'ENGINE_INPUT_INVALID'});
});

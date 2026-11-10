import test from 'node:test';import assert from 'node:assert/strict';import {rm} from 'node:fs/promises';
import {namespaceSourceClauseFixture,converterSource} from './helpers/namespace-source-clause-fixture.mjs';
import {createNamespaceSourceRetentionReader} from '../src/engine-storage/namespace-source-retention-reader.mjs';
import {createNamespaceSourceBaselineReader} from '../src/engine-storage/namespace-source-baseline-reader.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceSourcePatchReader} from '../src/engine-storage/namespace-source-patches.mjs';
import {phaseDeliveryInspectionManifest} from '../src/kernel/source-changes.mjs';
import {sourceTextHunks} from '../src/kernel/source-text-diff.mjs';
import {createEngine} from '../src/engine-sdk/index.mjs';
const facts=m=>{const {schemaVersion,contract,actions,observationsOnly,publicationReadinessInspected,applicationAcceptanceEstablished,...value}=m;return value;};
for(const backend of ['filesystem','sqlite','application'])test(backend+': explicit implementation inspection binds actual archived regions and keeps legacy output unchanged',async t=>{
  const f=await namespaceSourceClauseFixture(t,{backend}),before=await f.head(),legacy=await f.inspect(),result=await f.inspect({includeImplementation:true}),m=result.manifest;
  assert.equal(legacy.manifest.contract,'sflow-delivery-evidence-inspection/v3');assert.equal(Object.hasOwn(legacy.manifest,'implementation'),false);
  assert.equal(m.contract,'sflow-delivery-evidence-inspection/v5');assert.equal(m.implementation.status,'observed');assert.equal(m.implementation.totals.bindings,2);
  assert.equal(m.implementation.totals.regions,2);assert.equal(m.implementation.totals.problems,0);
  assert.equal(m.implementation.repositories[0].bindings[0].regions[0].path,'src/converter.js');assert.equal(m.implementation.repositories[0].bindings[0].regions[0].hunks,1);
  assert.ok(m.requiredPolicyOwners.includes('code-delivery'));assert.equal(m.applicationAcceptanceEstablished,false);assert.equal(result.effects.testsRun,false);assert.deepEqual(await f.head(),before);
  const bounded=(await f.inspect({includeImplementation:true,maximumEntries:0})).manifest;
  assert.equal(bounded.implementation.totals.bindings,2);assert.equal(bounded.implementation.repositories[0].bindings.length,0);assert.equal(bounded.implementation.repositories[0].truncated,true);
  await assert.rejects(f.engine.run('phase.source.inspect',{phaseId:'build',includeImplementation:true}),{code:'ENGINE_INPUT_INVALID'});
  await assert.rejects(f.inspect({includeImplementation:'yes'}),{code:'ENGINE_INPUT_INVALID'});
  const input=facts(m);assert.throws(()=>phaseDeliveryInspectionManifest(m.workId,m.phase,{...input,implementation:{...input.implementation,ready:true}},200),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.throws(()=>phaseDeliveryInspectionManifest(m.workId,m.phase,{...input,implementation:{...input.implementation,totals:{...input.implementation.totals,regions:0}}},200),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.throws(()=>phaseDeliveryInspectionManifest(m.workId,m.phase,{...input,evidence:{...input.evidence,baseline:null}},200),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.throws(()=>phaseDeliveryInspectionManifest(m.workId,m.phase,{...input,implementation:{...input.implementation,status:'off',baselineRecord:null,retentionRecord:null,totals:null,repositories:[]}},200),{code:'ENGINE_PORT_RESULT_INVALID'});
  if(backend==='filesystem'){
    const old=createEngine({ports:{phaseDeliveryInspection:{load:()=>({subject:{kind:'story',id:m.workId},phase:m.phase}),inspect:()=>facts(legacy.manifest)}}});
    await assert.rejects(old.run('phase.delivery.inspect',{workId:m.workId,phaseId:m.phase,includeImplementation:true}),error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.required.includes('implementation-region-reader'));
    assert.equal((await old.run('phase.delivery.inspect',{phaseId:m.phase})).manifest.schemaVersion,3);
  }
});
test('an original accepted source patch remains readable after the laptop checkout is removed, with fresh index checks',async t=>{
  const f=await namespaceSourceClauseFixture(t),observer=createNamespaceStoryObserver(f.common),retention=createNamespaceSourceRetentionReader({...f.common,observer}),
    baseline=createNamespaceSourceBaselineReader({...f.common,observer}),found=await retention.accepted({operationId:'clause-current-bytes',workId:f.inputs.workId,phaseId:'build'}),
    original=await baseline.inspectBinding(f.sourceBindingId),reader=createNamespaceSourcePatchReader({observer,retention,baseline}),context=await reader.capture(found,original);
  await rm(f.root,{recursive:true,force:true});const result=await reader.repository(context,'app',['src/converter.js']);await reader.finish(context);
  assert.deepEqual(result.files[0].hunks,sourceTextHunks('export const convert=value=>String(value);\n',converterSource).hunks);
  assert.deepEqual(result.source,found.binding);assert.deepEqual(result.baseline.result,original.record);
  await assert.rejects(reader.capture({...found},original),{code:'ENGINE_INPUT_INVALID'});
  await assert.rejects(reader.capture(found,{...original,record:{...original.record,version:'forged'}}),{code:'ENGINE_INPUT_INVALID'});
  const current=found.body.repositories[0].manifest,actual=await retention.verifyRepository(found,found.plan.sources[0],current),
    chunk=actual.value.entries.find(row=>row.newPath==='src/converter.js').chunks[0],permission=Object.assign(Error('Original source chunk permission failure.'),{code:'EACCES'}),
    denied=createNamespaceSourcePatchReader({observer:{...observer,bytes(reference,...rest){if(reference.sha256===chunk.sha256)throw permission;return observer.bytes(reference,...rest);}},retention,baseline}),issued=await denied.capture(found,original);
  await assert.rejects(denied.repository(issued,'app',['src/converter.js']),error=>error===permission);
  const timeout=Object.assign(Error('Original archive read deadline.'),{code:'ETIMEDOUT',timeoutMs:300000}),unavailable=createNamespaceSourcePatchReader({observer:{...observer,
    bytes(reference,...rest){if(reference.sha256===chunk.sha256)throw timeout;return observer.bytes(reference,...rest);}},retention,baseline}),timed=await unavailable.capture(found,original);
  await assert.rejects(unavailable.repository(timed,'app',['src/converter.js']),error=>error===timeout);
  let moved=false;const changing=createNamespaceSourcePatchReader({observer:{...observer,async record(...args){const value=await observer.record(...args);return moved&&args[1]===found.binding.index.key?{...value,version:'moved'}:value;}},retention,baseline}),held=await changing.capture(found,original);moved=true;
  await assert.rejects(changing.finish(held),{code:'ENGINE_CONTEXT_CHANGED'});
});
test('missing explanations have a producer repair route while a missing baseline and binary sources retain explicit owners',async t=>{
  const f=await namespaceSourceClauseFixture(t,{source:converterSource.replace('Converts the selected integer into hexadecimal.','').replace('Returns FF for the approved 255 example.','')}),
    m=(await f.inspect({includeImplementation:true})).manifest;
  assert.equal(m.implementation.totals.problems,2);assert.ok(m.actions.some(action=>action.operation==='phase.prepare'&&action.prerequisites.includes('repair-observed-implementation-bindings')));
  const missing=await namespaceSourceClauseFixture(t,{retainBaseline:false}),unready=(await missing.inspect({includeImplementation:true})).manifest;
  assert.equal(unready.implementation.status,'missing-baseline');assert.ok(unready.actions.some(action=>action.operation==='source.baseline.retain'));
  const binary=await namespaceSourceClauseFixture(t,{source:'\0opaque'}),unsupported=(await binary.inspect({includeImplementation:true})).manifest;
  assert.equal(unsupported.implementation.status,'pending-owner');assert.equal(unsupported.implementation.totals,null);
  assert.deepEqual(unsupported.implementation.requiredPolicyOwners,['implementation-region-analysis']);assert.equal(unsupported.applicationAcceptanceEstablished,false);
});

/** Exact line origins are accepted evidence, not caller-supplied ownership flags. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {namespaceSourceClauseFixture,converterSource} from './helpers/namespace-source-clause-fixture.mjs';
import {createNamespaceSourceControlReader} from '../src/engine-storage/namespace-source-control-reader.mjs';
import {createNamespaceSourceControlEngine} from '../src/engine-storage/namespace-source-control.mjs';
import {createNamespaceSourceBaselineReader} from '../src/engine-storage/namespace-source-baseline-reader.mjs';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
const input={operationId:'clause-line-origins',workId:'story-1',phaseId:'build'};
const request=f=>({...input,workId:f.inputs.workId});
for(const backend of ['filesystem','sqlite','application'])test(backend+': actual accepted first-source archives close shared line-origin ownership',async t=>{
  const f=await namespaceSourceClauseFixture(t,{backend,namespace:'SHARED',lineOrigins:true}),reader=createNamespaceSourceControlReader(f.options),control=await reader.accepted(request(f)),
    result=(await f.inspect()).manifest.clauses;
  assert.equal(control.plan.schemaVersion,2);assert.equal(control.body.schemaVersion,2);assert.equal(control.plan.profile,'sflow-namespace-source-control/v2');
  assert.equal(control.plan.origins[0].origin.sourceBindingId,'clause-source-selection');assert.deepEqual(control.plan.origins[0].origin,control.plan.origins[0].baseline);
  const observed=await reader.readObservation({...control.plan.observations[0],content:control.body.repositories[0].observation},control.source,null,control.plan.origins[0]);
  assert.equal(observed.value.schemaVersion,2);assert.equal(observed.value.origin.revision,f.gitBindings[0].origin);
  assert.deepEqual(observed.value.origin.patch[0].hunks,[{beforeStart:1,beforeLines:1,afterStart:1,afterLines:3}]);
  assert.equal(JSON.stringify(observed.value).includes('Converts the selected integer'),false);
  assert.equal(JSON.stringify(control.plan).includes(f.root),false);
  assert.equal(result.status,'observed');assert.deepEqual(result.requiredPolicyOwners,[]);
  assert.deepEqual(result.repositories[0].totals,{required:2,bindings:2,missing:0});
  assert.equal((await f.inspect()).manifest.applicationAcceptanceEstablished,false);
  await rm(f.root,{recursive:true,force:true});
  const again=await createNamespaceSourceControlEngine({...f.options,localRecords:null,localContent:null,sources:[],sourceReaders:[],sourceControlReaders:[]})
    .run('phase.source-control.retain',request(f));
  assert.equal(again.replayed,true);assert.deepEqual(again.record,control.record);
});
test('a tag carried from before this Story stays unowned when unchanged elsewhere in the same edited file',async t=>{
  const f=await namespaceSourceClauseFixture(t,{namespace:'SHARED',lineOrigins:true,baselineSource:converterSource,source:converterSource+'export const other=true;\n'}),
    c=(await f.inspect()).manifest.clauses;
  assert.equal(c.status,'observed');assert.deepEqual(c.repositories[0].totals,{required:2,bindings:0,missing:2});
  for(const row of c.repositories[0].obligations)assert.equal(row.otherStoryTags.length,1);
});
test('a later baseline cannot erase lines this Story added in an earlier work interval',async t=>{
  const f=await namespaceSourceClauseFixture(t,{namespace:'SHARED',lineOrigins:true,originalSource:'export const convert=value=>String(value);\n',
    baselineSource:converterSource,source:converterSource+'export const other=true;\n'}),reader=createNamespaceSourceControlReader(f.options),control=await reader.accepted(request(f));
  assert.notEqual(f.gitBindings[0].baseline,f.gitBindings[0].origin);
  assert.equal(control.plan.origins[0].origin.sourceBindingId,'clause-source-selection');
  assert.equal(control.plan.origins[0].baseline.sourceBindingId,'clause-generation-selection');
  assert.equal((await f.inspect()).manifest.clauses.repositories[0].totals.bindings,2);
});
test('moved or whitespace-only tag lines are carried; reworded lines are new Story lines',async t=>{
  for(const [name,source,expected]of [
    ['moved','// A new header\n'+converterSource,0],
    ['whitespace',converterSource.replaceAll('// @clause:',' //  @clause:'),0],
    ['reworded',converterSource.replace('Converts the selected integer','Implements the approved integer conversion').replace('Returns FF','Produces FF'),2]
  ]){
    const f=await namespaceSourceClauseFixture(t,{namespace:'SHARED',lineOrigins:true,baselineSource:converterSource,source}),c=(await f.inspect()).manifest.clauses;
    assert.equal(c.repositories[0].totals.bindings,expected,name);
  }
});
test('without accepted origin records a shared namespace returns the registered retention prerequisite',async t=>{
  const f=await namespaceSourceClauseFixture(t,{namespace:'SHARED',lineOrigins:true,retainOrigins:false}),m=(await f.inspect()).manifest;
  assert.equal(m.clauses.status,'pending-owner');assert.deepEqual(m.clauses.requiredPolicyOwners,['source-tag-origin']);
  const next=m.actions.find(row=>row.operation==='phase.source-control.retain');
  assert.deepEqual(next.inputs,{workId:f.inputs.workId,phaseId:'build'});assert.ok(next.prerequisites.includes('origin-bound-source-control-reader'));
});
test('missing original byte archives require the exact existing baseline-retention operation',async t=>{
  const f=await namespaceSourceClauseFixture(t,{namespace:'SHARED',lineOrigins:true,retainBaseline:false,retainOrigins:false});
  await assert.rejects(f.engine.run('phase.source-control.retain',request(f)),error=>error.code==='ENGINE_SOURCE_BASELINE_REQUIRED'
    &&error.details.inputs.sourceBindingId==='clause-source-selection'&&error.details.operation==='source.baseline.retain');
});
test('retained v2 original bytes remain independently reconstructable from their accepted binding',async t=>{
  const f=await namespaceSourceClauseFixture(t,{namespace:'SHARED',lineOrigins:true}),reader=createNamespaceSourceControlReader(f.options),control=await reader.accepted(request(f)),
    baselines=createNamespaceSourceBaselineReader(f.options),original=await baselines.inspectBinding('clause-source-selection');
  assert.equal(control.plan.origins[0].origin.result.content.sha256,original.record.content.sha256);
  assert.equal(reader.isAccepted(control),true);assert.equal(reader.isAccepted(structuredClone(control)),false);
  const file=await readFile(path.join(f.root,'src/converter.js'),'utf8');await writeFile(path.join(f.root,'src/converter.js'),file+'// changed after retention\n');
  const m=(await f.inspect()).manifest;assert.equal(m.repositories[0].sourceMatched,false);
  assert.ok(m.actions.some(row=>row.operation==='phase.source.retain'));
});
test('self-consistent observation hashes cannot hide omitted removals, forged coordinates or another origin',async t=>{
  const f=await namespaceSourceClauseFixture(t,{namespace:'SHARED',lineOrigins:true,retainOrigins:false}),actual=f.options.sourceControlReaders[0];
  for(const [name,mutate]of [
    ['omitted',value=>{value.origin.patch=[];}],
    ['coordinates',value=>{value.origin.patch[0].hunks[0].beforeStart=999;}],
    ['tracking',value=>{value.origin.trackedPaths=[];}],
    ['origin',value=>{value.origin.entries[0].sha256='0'.repeat(64);}]
  ]){
    const port={descriptor:actual.descriptor,async capture(...args){const answer=structuredClone(await actual.capture(...args));mutate(answer.observation);
      answer.revision='sha256:'+createHash('sha256').update(canonicalJson(answer.observation)).digest('hex');return answer;}};
    await assert.rejects(f.make({sourceControlReaders:[port]}).run('phase.source-control.retain',{...request(f),operationId:'forged-'+name}),
      error=>error.code==='ENGINE_SOURCE_CONTROL_BINDING_INVALID');
  }
});
test('accepted origin and baseline archive versions are conditional reads at preparation and final acceptance',async t=>{
  const f=await namespaceSourceClauseFixture(t,{namespace:'SHARED',lineOrigins:true,retainOrigins:false,originalSource:'export const convert=value=>String(value);\n',baselineSource:converterSource}),
    transactions=[],records={...f.records,async transact(scope,tx,options){if(tx.changes.some(row=>row.key.startsWith('source-control/')))transactions.push(tx);return f.records.transact(scope,tx,options);}};
  await f.make({records}).run('phase.source-control.retain',request(f));
  const control=await createNamespaceSourceControlReader(f.options).accepted(request(f));
  assert.equal(transactions.length,2);
  for(const tx of transactions)for(const proof of [control.plan.origins[0].origin,control.plan.origins[0].baseline])for(const item of [proof.result,proof.index])
    assert.ok(tx.preconditions.some(row=>row.namespace==='evidence'&&row.key===item.key&&row.version===item.version));
});
test('a real original-archive permission failure survives retained-proof replay without being relabeled',async t=>{
  const f=await namespaceSourceClauseFixture(t,{namespace:'SHARED',lineOrigins:true}),base=await createNamespaceSourceBaselineReader(f.options).inspectBinding('clause-source-selection'),
    reference=base.body.repositories[0].manifest,failure=Object.assign(Error('Original archive is inaccessible.'),{code:'EACCES'}),
    content={...f.content,read(scope,ref,options){if(ref.sha256===reference.sha256)throw failure;return f.content.read(scope,ref,options);}};
  await assert.rejects(f.make({content}).run('phase.delivery.inspect',{phaseId:'build'}),error=>error===failure);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {NAMESPACE_READER_SCHEMAS,namespaceReaderRecordProfile} from '../src/foundation/record-schema.mjs';
import {projectNamespaceReadState,projectNamespaceLifecycleReadState,namespaceReadState,namespaceReadRecord} from '../src/engine-storage/namespace-read-contract.mjs';
import {readRecord,stampCurrentRecord} from '../src/schema-migrations.mjs';
import {namespaceStoryReadKey} from '../src/engine-storage/namespace-reader.mjs';
import {namespaceReadFixture,readWorkflow} from './helpers/namespace-read-fixture.mjs';
const capture=JSON.parse(await readFile(new URL('./fixtures/namespace-reader-state/native-v1.json',import.meta.url),'utf8'));

test('captured created, published and submitted v1 projections retain their exact bytes and meaning',()=>{
  assert.equal(capture.baseline,'0d57823ea');assert.equal(capture.cases.length,3);
  for(const entry of capture.cases) {
    const view=projectNamespaceReadState(entry.input),wire=JSON.stringify(view);
    assert.equal(wire,entry.wire);assert.equal(createHash('sha256').update(wire).digest('hex'),entry.sha256);
    assert.equal(namespaceReadState(view,entry.input.workItem.id),view);assert.equal(view.schemaVersion,1);assert.equal(Object.hasOwn(view,'status'),false);
    assert.deepEqual(readRecord('namespace-story-read-state',entry.wire),{record:view,storedVersion:1,migratedThrough:[]});
    assert.throws(()=>namespaceReadState({...view,status:'in_progress'},entry.input.workItem.id),{code:'SDA_NAMESPACE_INPUT_INVALID'});
    assert.throws(()=>namespaceReadState({...view,currentPhase:null},entry.input.workItem.id),{code:'ENGINE_STORAGE_CORRUPT'});
    const data=Object.fromEntries(Object.entries(view).filter(([key])=>!['schemaVersion','format'].includes(key)));
    assert.deepEqual(namespaceReadRecord('state',data),view,'the compatibility builder remains explicitly v1');
  }
});

test('v2 read profiles preserve stored versions and never restamp a v1 identity',()=>{
  const entry=NAMESPACE_READER_SCHEMAS.state;
  assert.deepEqual([entry.currentVersion,entry.minimumReadableVersion,entry.maximumReadableVersion],[2,1,2]);
  assert.equal(entry.migrationPolicy,'preserve-versions');
  for(const [kind,value]of Object.entries(NAMESPACE_READER_SCHEMAS))if(kind!=='state')assert.deepEqual(
    [value.currentVersion,value.minimumReadableVersion,value.maximumReadableVersion,value.migrationPolicy],[1,1,1,'frozen-identity']);
  assert.deepEqual(namespaceReaderRecordProfile('state',{schemaVersion:1}).state.terminalStatuses,[]);
  assert.deepEqual(namespaceReaderRecordProfile('state',{schemaVersion:2}).state.terminalStatuses,['closed','cancelled']);
  const original=JSON.parse(capture.cases[0].wire),before=JSON.stringify(original);
  assert.throws(()=>stampCurrentRecord(entry.id,original),{code:'SCHEMA_VERSION_RESTAMP_PROHIBITED'});assert.equal(JSON.stringify(original),before);
  const v2=projectNamespaceLifecycleReadState(capture.cases[0].input);
  assert.equal(v2.schemaVersion,2);assert.equal(v2.format,'sflow-namespace-read-state/v2');assert.equal(v2.status,'in_progress');
  assert.deepEqual(readRecord(entry.id,v2),{record:v2,storedVersion:2,migratedThrough:[]});
  assert.throws(()=>namespaceReaderRecordProfile('constructor',{schemaVersion:1}),{code:'SCHEMA_FAMILY_UNKNOWN'});
});

test('terminal views require explicit current pointers and terminal status, with no guessed active state',()=>{
  const workflow=structuredClone(capture.cases[1].input);
  for(const status of ['closed','cancelled']) {
    workflow.currentPhase=null;workflow.status=status;const view=projectNamespaceLifecycleReadState(workflow);
    assert.equal(view.currentPhase,null);assert.equal(view.status,status);assert.equal(view.phases.intake.generation,1);
    for(const invalid of [null,'in_progress','approved','archived','completed',''])assert.throws(()=>namespaceReadState({...view,status:invalid},workflow.workItem.id),{code:'ENGINE_STORAGE_CORRUPT'});
    const absent=structuredClone(view);delete absent.currentPhase;assert.throws(()=>namespaceReadState(absent,workflow.workItem.id));
    const inherited=structuredClone(workflow);delete inherited.currentPhase;Object.setPrototypeOf(inherited,{currentPhase:null});
    assert.throws(()=>projectNamespaceLifecycleReadState(inherited),{code:'ENGINE_STORAGE_CORRUPT'});
    assert.throws(()=>namespaceReadState({...view,schemaVersion:3},workflow.workItem.id),error=>error.code==='ENGINE_STORAGE_UNSUPPORTED'&&error.cause.code==='SCHEMA_VERSION_FUTURE');
    assert.throws(()=>namespaceReadState({...view,format:'sflow-namespace-read-state/v1'},workflow.workItem.id),{code:'ENGINE_STORAGE_CORRUPT'});
  }
  workflow.currentPhase='intake';delete workflow.status;
  assert.equal(projectNamespaceLifecycleReadState(workflow).status,null,'old active sources retain unknown status rather than manufacturing in-progress');
});

for(const backend of ['filesystem','sqlite','application'])for(const status of ['closed','cancelled'])test(`${backend}: ${status} projections retain historical phase and document reads without granting approval`,async t=>{
  // These are read projections, not accepted lifecycle decisions; actual approval is a separate owner.
  const f=await namespaceReadFixture(t,{backend}),doc=await f.document(),workflow=readWorkflow(f.workId,doc);
  workflow.status=status;workflow.currentPhase=null;workflow.phases.build.status=status==='closed'?'approved':'in_progress';
  await f.seed(workflow,[doc],{lifecycle:true});const key=namespaceStoryReadKey(f.workId);
  const before=await f.records.read(f.scope,'state',key);
  const review=await f.engine.run('phase.review',{phaseId:'build'});
  assert.equal(review.manifest.integrity,'matched');assert.equal(review.manifest.reviewBinding,null);assert.equal(review.manifest.approvalRecorded,false);
  const read=await f.engine.run('document.read',{reference:review.manifest.items[0].reference});assert.equal(read.document.content.text,'Published summary.\n');
  await assert.rejects(f.engine.run('phase.review'),error=>error.code==='ENGINE_PHASE_SELECTION_REQUIRED'&&error.details.status===status
    &&error.details.actions.some(action=>action.operation==='phase.review'&&action.inputs.phaseId==='build'));
  assert.deepEqual(await f.records.read(f.scope,'state',key),before);assert.equal(f.state.workflow.schemaVersion,2);
});

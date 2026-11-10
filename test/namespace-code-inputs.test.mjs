import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile,rm,mkdtemp,cp} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {namespaceCodeInputFixture,codeInputPublication,codeInputArtifact} from './helpers/namespace-code-input-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createFilesystemNamespaceStore} from '../src/sda/filesystem-namespace-adapter.mjs';
import {openNativeSqliteDatabase} from '../src/sda/sqlite-native.mjs';
import {createSqliteContentStore} from '../src/sda/sqlite-content-adapter.mjs';
import {createFilesystemSourceUnit} from '../src/sgos/filesystem-source-unit.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNamespacePublicationReader} from '../src/engine-storage/namespace-publication-reader.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {codeInputPublicationPolicy,primaryDocumentPublicationRequirements} from '../src/kernel/publication-intent.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': downstream Code evidence survives authoring, publication, independent approval and shared-only replay',async t=>{
  const phaseId=backend==='application'?'custom-validation':'verify',f=await namespaceCodeInputFixture(t,{backend,phaseId}),starts=f.starts(),
    input={phaseId,...codeInputPublication};let engine=f.engine;
  await t.test('exact Code report is readable in the authoring manifest with ordinary inputs disabled',async()=>{
  const entry=await engine.run('phase.enter',{phaseId,compose:true}),
    snapshot=await f.capture(),codeDocument=snapshot.workflow.namespaceDocuments.find(row=>row.kind==='code-delivery'),
    codeResource=entry.manifest.resources.find(row=>row.reference.sha256===codeDocument.content.sha256);
  assert.equal(snapshot.workflow.resolution.inputsMode,'off');
  assert.ok(codeResource);assert.equal(codeResource.kind,'supporting-document');assert.equal(entry.manifest.authorAgentId,'verifier');
  const read=await engine.run('phase.context.read',{workId:f.inputs.workId,phaseId,contextSha256:entry.manifest.context.sha256,resourceId:codeResource.id,maximumBytes:1000000});
  assert.equal(read.content.kind,'text');assert.deepEqual(JSON.parse(read.content.text),await f.json(codeDocument.content));
  });
  if(backend==='filesystem'){
    await t.test('other semantic owners remain required rather than being discharged by inherited test evidence',async()=>{
      const original=await f.capture();assert.equal(codeInputPublicationPolicy(original.workflow,original.workflow.phases[phaseId]).testSource,'build');
      for(const change of [w=>{w.phases[phaseId].requiredArtifact.kind='conformance-report';},w=>{w.resolution.phases.find(row=>row.id===phaseId).testEvidenceFrom=null;},
        w=>{w.resolution.obligationGraph.nodes.find(row=>row.id===phaseId).responsibilities.push('scope');}]){
        const w=structuredClone(original.workflow);change(w);assert.equal(codeInputPublicationPolicy(w,w.phases[phaseId]),null);
      }
      const w=structuredClone(original.workflow);w.phases[phaseId].artifactSet={members:[]};
      assert.ok(primaryDocumentPublicationRequirements(w,w.phases[phaseId]).includes('artifact-set'));
      assert.deepEqual(await f.capture(),original);
    });
    const before=await f.head(),draft=await engine.run('phase.draft.read',{phaseId});
    const sameDraft=async()=>{assert.deepEqual(await f.head(),before);assert.deepEqual(await engine.run('phase.draft.read',{phaseId}),draft);assert.equal(f.starts(),starts);};
    for(const filename of ['src/converter.js','test/converter.test.js'])await t.test('changed '+filename+' cannot reuse producer tests',async()=>{
      const file=path.join(f.root,filename),bytes=await readFile(file);await writeFile(file,Buffer.concat([bytes,Buffer.from('\n// Changed after Code approval.\n')]));
      try{await assert.rejects(engine.run('phase.publish',input),error=>error.code==='PRIOR_CODE_TEST_EVIDENCE_REQUIRED'
        &&error.details.operation==='phase.review'&&error.details.inputs.phaseId==='build');}finally{await writeFile(file,bytes);}await sameDraft();
    });
    await t.test('new publication needs a matching explicit repository port',async()=>{
      const missing=createNamespaceEngine({...f.options,sources:[],sourceReaders:[],checks:f.checks});
      await assert.rejects(missing.run('phase.publish',input),{code:'ENGINE_SOURCE_UNIT_UNAVAILABLE'});await sameDraft();
    });
    await t.test('a final source change refuses the prepared candidate and preserves the draft',async()=>{
      let captures=0;const file=path.join(f.root,'src/converter.js'),original=await readFile(file),unit=f.sources[0],
        source={...unit,async capture(options){if(++captures===2)await writeFile(file,Buffer.concat([original,Buffer.from('\n// A concurrent edit before acceptance.\n')]));return unit.capture(options);}},
        guarded=createNamespaceEngine({...f.options,sources:[source],checks:f.checks});
      try{await assert.rejects(guarded.run('phase.publish',input),{code:'PRIOR_CODE_TEST_EVIDENCE_REQUIRED'});}finally{await writeFile(file,original);}
      assert.equal(captures,2);await sameDraft();
    });
    await t.test('another device resumes the same Story using shared evidence and its own private draft',async()=>{
      const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-code-input-takeover-')),root=path.join(directory,'checkout');await cp(f.root,root,{recursive:true});
      const unit=await createFilesystemSourceUnit({root,id:f.sources[0].descriptor.id,projectId:f.scope.projectId,repositoryId:'app'}),
        binding={kind:'machine-local',deviceId:'takeover-device'},records=await createFilesystemNamespaceStore({root:path.join(directory,'records'),binding,create:true}),
        database=await openNativeSqliteDatabase(path.join(directory,'content.db')),content=createSqliteContentStore({database,binding,create:true});
      t.after(async()=>{database.close();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});engine=createNamespaceEngine({...f.common,working:{records,content},sources:[unit]});
      for(const original of f.roots)await rm(original,{recursive:true,force:true});
      await engine.run('phase.prepare',{phaseId});const current=await engine.run('phase.draft.read',{phaseId});
      await engine.run('phase.draft.write',{operationId:'continue-verifier-on-another-device',workId:f.inputs.workId,phaseId,expectedRevision:current.manifest.draft.revision,
        content:(await content.put(f.scope,'local',Buffer.from(codeInputArtifact))).reference,reason:'Continue the existing Story without its old checkout or private files.'});
      assert.deepEqual(await f.head(),before);assert.equal((await f.capture()).workflow.workItem.id,f.inputs.workId);
      assert.equal((await engine.run('phase.review',{phaseId:'build'})).manifest.phase,'build','the issued recovery route works without the old checkout or private draft');
    });
  }
  const published=await f.measured('publish verifier',()=>engine.run('phase.publish',input));assert.equal(published.status,'published');
  const snapshot=await f.capture(),phase=snapshot.workflow.phases[phaseId],publication=await f.json(phase.publicationBindings[0].record),binding=publication.policyEvidence.find(row=>row.kind==='approved-code-inputs/v1'),
    manifest=await f.json(binding.record),report=await f.json(manifest.report);
  assert.equal(report.testEvidenceFrom,'build');assert.equal(report.inputs[0].phase,'build');assert.equal(report.inputs[0].tests[0].tests.passed,1);
  assert.equal(report.inputs[0].repositories[0].observed.phase,'build');assert.equal(report.currentSources[0].phase,'build');assert.equal(publication.agentId,'verifier');
  assert.equal(publication.checks,null,'a producer execution is never relabelled as a consumer run');assert.equal(f.starts(),starts);
  assert.equal((await f.measured('independently approve verifier',()=>f.approve(phaseId))).approval.selfApproval,false);assert.equal((await f.capture()).workflow.phases[phaseId].status,'approved');
  await t.test('the Code input report has an exact readable review-document reference',async()=>{
    const {manifest:review}=await engine.run('phase.review.resources',{phaseId}),resource=review.resources.find(row=>row.kind==='code-inputs');
    assert.ok(resource);assert.equal(resource.expected.sha256,manifest.report.sha256);
    assert.deepEqual(JSON.parse((await engine.run('document.read',{reference:resource.reference})).document.content.text),report);
  });
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const retained=createNamespaceEngine({...f.common,clock:{now(){throw Error('An accepted verification cannot be restamped.');}}});
  assert.equal((await f.measured('shared-only accepted verifier replay',()=>retained.run('phase.publish',input))).status,'retained');assert.equal(f.starts(),starts);
  if(backend==='filesystem')await t.test('altered input reports, schemas and missing archive bytes retain their actual errors',async()=>{
    const observer=createNamespaceStoryObserver(f.common),checks=createNamespacePhaseCheckReader({...f.common,observer}),reader=createNamespacePublicationReader({observer,checks,scope:f.scope,workId:f.inputs.workId}),
      save=async value=>(await f.content.put(f.scope,'evidence',Buffer.from(canonicalJson(value)))).reference,
      changes=[value=>{value.inputs[0].tests[0].tests.passed=100;},value=>{value.inputs[0].generation++;},value=>{value.inputs[0].approvals=[];},value=>{value.currentSources[0].id='another-repository';}];
    for(const [changed,code]of [...changes.map(change=>{const value=structuredClone(report);change(value);return [value,'ENGINE_STORAGE_CORRUPT'];}),
      [{...report,schemaVersion:2},'ENGINE_STORAGE_UNSUPPORTED'],[{...report,ready:true},'ENGINE_STORAGE_CORRUPT']]){
      const candidate={...manifest,report:await save(changed)},value={...publication,policyEvidence:[{...binding,record:await save(candidate)}]},reference={...phase.publicationBindings[0],record:await save(value)};
      await assert.rejects(reader.read(reference,phaseId),{code});
    }
    const denied=Object.assign(Error('The original Code input archive deadline expired.'),{code:'ETIMEDOUT',timedOut:true}),
      guarded=createNamespaceStoryObserver({...f.common,content:{...f.content,read(scope,ref,options){if(ref.sha256===report.inputs[0].report.sha256)throw denied;return f.content.read(scope,ref,options);}}}),
      missing=createNamespacePublicationReader({observer:guarded,scope:f.scope,workId:f.inputs.workId,checks:createNamespacePhaseCheckReader({...f.common,observer:guarded})});
    await assert.rejects(missing.accepted(phase.publicationBindings[0],phaseId),error=>error===denied);
    assert.equal((await reader.accepted(phase.publicationBindings[0],phaseId)).generation,1);assert.equal(f.starts(),starts);
  });
});

/** Real local-only text/image uploads, authoring manifests and takeover, without fixture-inserted metadata. */
import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {createNamespaceReadEngine} from '../src/engine-storage/namespace-reader.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': attached text and images stay local through every phase and require originals on another device', {timeout:120000},async t=>{
  const f=await namespaceEngineFixture(t,{backend,configure(source){
    source.definition.phases.review={...structuredClone(source.definition.phases.intake),label:'Review',artifact:{path:'artifacts/review/report.md'}};
    source.definition.workTypes.simple.phases.push('review');source.agents[0].phases.push('review');source.agents[0].defaultFor.push('review');
  }});
  f.control.permissions.push('story.document.attach','story.document.detach','phase.enter','phase.context.read','scope.context');await f.bootstrap();
  const text=Buffer.from('The converter must reject negative input.\n'),image=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]),
    uploads=[{documentId:'requirements',name:'Requirement notes',mimeType:'text/plain',encoding:'utf8',bytes:text},
      {documentId:'reference-image',name:'Reference screen',mimeType:'image/png',encoding:'binary',bytes:image}],attached=[];
  for(const row of uploads){const content=(await f.local.content.put(f.scope,'local',row.bytes)).reference;
    const input={operationId:'attach-'+row.documentId,workId:f.workId,documentId:row.documentId,name:row.name,mimeType:row.mimeType,encoding:row.encoding,content,
      reason:'Use this exact local reference during the complete Story.'};
    attached.push(await f.engine.run('story.document.attach',input));assert.equal(attached.at(-1).effects.uploadedContent,false);
    assert.equal((await f.content.read(f.scope,{...content,namespace:'evidence'})).status,'missing');
    assert.deepEqual(await f.engine.run('story.document.attach',input),attached.at(-1));
  }
  const scope=(await f.engine.run('scope.context')).manifest.inventory;
  assert.equal(scope.sources.filter(row=>row.kind==='document').length,2);assert.ok(scope.sources.filter(row=>row.kind==='document').every(row=>!row.readable));
  for(const phaseId of ['intake','review']){
    f.asAuthor();const entry=await f.engine.run('phase.enter',{phaseId});
    assert.equal(entry.manifest.resources.filter(row=>row.kind==='supporting-document').length,2);
    for(const resource of entry.manifest.resources.filter(row=>row.kind==='supporting-document')){
      const binary=attached.find(row=>row.document.content.sha256===resource.reference.sha256)?.document.encoding==='binary';
      const read=await f.engine.run('phase.context.read',{workId:f.workId,phaseId,contextSha256:entry.manifest.context.sha256,resourceId:resource.id,
        representation:binary?'base64':'text'});
      assert.ok(read);
    }
    const other=f.make({working:null,localContent:null});
    const unavailable=await other.run('phase.enter',{phaseId});assert.equal(unavailable.status,'documents-required');assert.equal(unavailable.authoringAllowed,false);
    assert.equal(unavailable.manifest.schemaVersion,3);assert.equal(unavailable.manifest.contract,'sflow-phase-entry-manifest/v3');
    assert.deepEqual(unavailable.manifest.documents.missing.map(row=>row.id),['requirements','reference-image']);
    assert.equal(unavailable.manifest.documents.missing[0].sha256,attached[0].document.content.sha256);
    assert.equal(unavailable.manifest.actions[0].operation,'document.read');assert.equal(unavailable.manifest.actions[0].inputs.reference,'requirements');
    await f.author(phaseId);await f.review(phaseId);
  }
  assert.equal((await f.capture()).workflow.status,'closed');
  const shown=await createNamespaceReadEngine({...f.options,localContent:f.local.content}).run('document.read',{reference:'requirements'});
  assert.equal(shown.document.content.text,text.toString());
});

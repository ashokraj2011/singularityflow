/** Real independent plan approval, repository selection and byte-backed source inspection. */
import test from 'node:test';import assert from 'node:assert/strict';
import {rm,mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceSourceClauseFixture} from './helpers/namespace-source-clause-fixture.mjs';
import {namespaceSpecificationFixture,specificationText,planText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createFilesystemSourceUnit} from '../src/sgos/filesystem-source-unit.mjs';
import {createNamespaceSpecificationReader} from '../src/engine-storage/namespace-specifications.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceRepositoryPlanReader} from '../src/engine-storage/namespace-repository-plan.mjs';
const rootTable='\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | `frontend` |\n| service-1 | `backend` |\n';
const qualifiedPlan=planText.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`')
  .replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')+rootTable;
for(const backend of ['filesystem','sqlite','application'])test(backend+': approved repository roots bind identical local paths to their original owner',async t=>{
  const f=await namespaceSourceClauseFixture(t,{backend,plan:qualifiedPlan,repositories:2,configure:source=>{source.definition.phases.build.qualityCommands[0].affectedRoots=['test'];}}),
    before=await f.head(),m=(await f.inspect()).manifest,c=m.clauses,workflow=(await f.capture()).workflow,
    publication=await f.json(workflow.phases.design.publicationBindings[0].record),evidence=await f.json(publication.specifications.record),roots=await f.json(evidence.repositoryPlan);
  assert.equal(evidence.schemaVersion,2);assert.equal(evidence.capabilities.status,'declared');
  assert.equal(roots.format,'sflow-repository-plan/v1');assert.equal(roots.repositories.length,2);
  assert.equal(m.schemaVersion,4);assert.equal(c.profile,'sflow-planned-source-clause-observations/v2');
  assert.deepEqual(c.plan.repositoryPlan,evidence.repositoryPlan);assert.deepEqual(c.repositories.map(row=>row.id),['app','service-1']);
  for(const row of c.repositories){assert.deepEqual(row.totals,{required:2,bindings:2,missing:0});
    for(const obligation of row.obligations)assert.deepEqual(obligation.expectedPaths,['src/converter.js']);}
  assert.equal(workflow.phases.design.approvals[0].selfApproval,false);assert.equal(m.applicationAcceptanceEstablished,false);
  assert.deepEqual(await f.head(),before);
  const reader=createNamespaceSpecificationReader({observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId}),snapshot=await f.capture(),
    first=await reader.sourcePlan(snapshot,'build');
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  assert.deepEqual((await reader.sourcePlan(snapshot,'build')).repositoryPlan,first.repositoryPlan);
  if(backend==='filesystem'){
    const original=Object.assign(new Error('Original content-port permission detail.'),{code:'EACCES'}),observer=createNamespaceStoryObserver(f.common),
      refused=createNamespaceSpecificationReader({observer:{...observer,bytes(reference,...args){if(reference.sha256===evidence.repositoryPlan.sha256)throw original;
        return observer.bytes(reference,...args);}},scope:f.scope,workId:f.inputs.workId});
    await assert.rejects(refused.sourcePlan(snapshot,'build'),error=>error===original);
  }
});
test('a matching comment in another repository cannot satisfy missing comments in the planned repository',async t=>{
  const f=await namespaceSourceClauseFixture(t,{plan:qualifiedPlan,repositories:2});
  await writeFile(path.join(f.roots[1],'src/converter.js'),'export const convert=value=>value.toString(16);\n');await f.retain('qualified-current-repair');
  const c=(await f.inspect()).manifest.clauses;
  assert.deepEqual(c.repositories[0].totals,{required:2,bindings:2,missing:0});assert.deepEqual(c.repositories[1].totals,{required:2,bindings:0,missing:2});
});
test('an incomplete new source selection is refused before captures or state changes',async t=>{
  const f=await namespaceSourceClauseFixture(t,{plan:qualifiedPlan,repositories:2}),before=await f.head();
  let captures=0;const sources=f.sources.map(unit=>({descriptor:unit.descriptor,capture(...args){captures++;return unit.capture(...args);}}));
  await assert.rejects(f.make({sources}).run('source.bind',{operationId:'drop-reviewed-repository',workId:f.inputs.workId,expectedRevision:before.record.version,
    repositories:['app'],reason:'This incomplete request must be refused.'}),error=>error.code==='SPEC_REPOSITORY_BINDING_REQUIRED'&&error.details.missing.includes('service-1'));
  assert.equal(captures,0);assert.deepEqual(await f.head(),before);
});
test('sources bound before planning must satisfy the later approved roots before any code generation opens',async t=>{
  const f=await namespaceSpecificationFixture(t);await f.author('intake',specificationText);await f.approve('intake');
  const sources=[];
  for(const id of ['app','service-1']){const root=path.join(f.directory,'pre-plan-'+id);await mkdir(root);await writeFile(path.join(root,'app.js'),'export const untouched=true;\n');
    sources.push(await createFilesystemSourceUnit({root,id:'source-'+id,projectId:f.scope.projectId,repositoryId:id}));}
  const engine=createNamespaceEngine({...f.common,working:{records:f.localRecords,content:f.localContent},sources});
  await engine.run('source.bind',{operationId:'before-plan-source',workId:f.inputs.workId,expectedRevision:(await f.head()).record.version,repositories:['app'],reason:'Bind before any repository plan exists.'});
  await f.author('design',qualifiedPlan);await f.approve('design');const before=await f.head();
  await assert.rejects(engine.run('phase.prepare',{phaseId:'build'}),error=>error.code==='SPEC_REPOSITORY_BINDING_REQUIRED'&&error.details.operation==='source.bind');
  assert.deepEqual(await f.head(),before);assert.equal((await engine.run('phase.draft.read',{phaseId:'build'})).manifest.status,'missing');
  await engine.run('source.bind',{operationId:'complete-reviewed-sources',workId:f.inputs.workId,expectedRevision:before.record.version,repositories:['app','service-1'],reason:'Bind both repositories from the reviewed plan.'});
  const prepared=await engine.run('phase.prepare',{phaseId:'build'});
  assert.equal(prepared.manifest.codeDeliveryRequired,true);assert.equal(prepared.manifest.generationIntent.generation,1);
  assert.deepEqual((await engine.run('phase.draft.read',{phaseId:'build'})).manifest.status,'open');
});
test('unqualified legacy multi-repository plans keep their explicit gap and v1 evidence bytes',async t=>{
  const f=await namespaceSourceClauseFixture(t,{repositories:2}),m=(await f.inspect()).manifest,w=(await f.capture()).workflow,
    publication=await f.json(w.phases.design.publicationBindings[0].record),evidence=await f.json(publication.specifications.record);
  assert.equal(evidence.schemaVersion,1);assert.equal(Object.hasOwn(evidence,'repositoryPlan'),false);assert.equal(m.schemaVersion,3);
  assert.deepEqual(m.clauses.requiredPolicyOwners,['repository-qualified-claims']);
  const binding=w.phases.design.publicationBindings[0],allowed=new Set([binding.record.sha256,publication.specifications.record.sha256]);let reads=0;
  const hints=createNamespaceRepositoryPlanReader({scope:f.scope,workId:f.inputs.workId,checks:{},observer:{async bytes(reference){
    assert.ok(allowed.has(reference.sha256),'a legacy-shape hint cannot traverse application bytes or prior human review');reads++;
    return (await f.content.read(f.scope,reference)).data;}}});
  assert.equal(await hints.approved(await f.capture(),'build'),null);assert.equal(reads,2);
  assert.equal(await hints.approved(await f.capture(),'build'),null);assert.equal(reads,2,'only the immutable legacy-shape hint is reused');
});
test('a self-consistent approval label does not replace original repository-plan human proof',async t=>{
  const f=await namespaceSourceClauseFixture(t,{plan:qualifiedPlan,repositories:2}),reader=createNamespaceSpecificationReader({observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId}),
    snapshot=await f.capture();snapshot.workflow.phases.design.approvals=[];
  await assert.rejects(reader.sourcePlan(snapshot,'build'),{code:'ENGINE_STORAGE_CORRUPT'});
});

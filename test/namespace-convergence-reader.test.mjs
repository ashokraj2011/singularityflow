/** Actual Code, tests and human approvals feed a read-only custom convergence phase. */
import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceReleaseFixture} from './helpers/namespace-release-fixture.mjs';
import {converterSource} from './helpers/namespace-source-clause-fixture.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceConvergenceReader} from '../src/engine-storage/namespace-convergence-reader.mjs';
test('convergence source readers retain original approvals and refuse changed application inputs or hidden content failures',{timeout:120000},async t=>{
  const f=await namespaceReleaseFixture(t,{backend:'sqlite',configure(source){source.definition.phases.release.artifact.kind='convergence-report';
    source.definition.phases.release.generation={requirement:'required',producer:'deterministic',task:'analyze'};}}),
    observer=createNamespaceStoryObserver(f.common),reader=createNamespaceConvergenceReader({observer,scope:f.scope,workId:f.inputs.workId}),
    before=await f.head(),snapshot=(await observer.capture()).snapshot,source=await reader.source(snapshot,'release');
  assert.equal(source.projection.phase,'release');assert.deepEqual(source.projection.projection.facts,[]);
  assert.deepEqual(source.projection.source.inputs.map(row=>row.phase),['build']);assert.equal(source.projection.source.inputs[0].approvals.length,1);
  assert.doesNotMatch(JSON.stringify(source.projection),/sourceBaseCommit|sourceTargetCommit|branchName|repositoryPath/u);
  assert.equal(source.currentSources.length,1);await reader.fresh(source,f.sources);assert.deepEqual(await f.head(),before);assert.equal(f.starts(),1);
  await writeFile(path.join(f.root,'src/converter.js'),converterSource+'// An actual edit after the approved Code run.\n');
  await assert.rejects(reader.fresh(source,f.sources),error=>error.code==='PRIOR_CODE_TEST_EVIDENCE_REQUIRED'
    &&error.details.actions[0].operation==='upstream.raise');assert.deepEqual(await f.head(),before);
  await writeFile(path.join(f.root,'src/converter.js'),converterSource);
  for(const failure of [Object.assign(Error('The original convergence evidence store denied access.'),{code:'EACCES',path:'content.db'}),
    Object.assign(Error('The original convergence evidence deadline.'),{code:'ETIMEDOUT',details:{deadlineMs:300000}})]){
    const content={...f.content,read(scope,ref,options){if(ref.sha256===source.projection.source.inputs[0].report.sha256)throw failure;return f.content.read(scope,ref,options);}},
      denied=createNamespaceConvergenceReader({observer:createNamespaceStoryObserver({...f.common,content}),scope:f.scope,workId:f.inputs.workId});
    await assert.rejects(denied.source(snapshot,'release'),actual=>actual===failure);
  }
});

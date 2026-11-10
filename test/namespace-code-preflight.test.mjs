import test from 'node:test';import assert from 'node:assert/strict';import {rm,writeFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceSourceClauseFixture} from './helpers/namespace-source-clause-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespaceCodePreflightReader} from '../src/engine-storage/namespace-code-preflight.mjs';
import {createNamespaceSourceRetentionReader} from '../src/engine-storage/namespace-source-retention-reader.mjs';
import {createNamespaceSourceBaselineReader} from '../src/engine-storage/namespace-source-baseline-reader.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceCodeSourceReader} from '../src/engine-storage/namespace-code-source.mjs';
async function facts(f){const snapshot=await f.capture(),retention=createNamespaceSourceRetentionReader(f.common),
  found=await retention.accepted({operationId:'clause-current-bytes',workId:f.inputs.workId,phaseId:'build'});
  return {snapshot,retention,found,identity:{phaseId:'build',generation:found.plan.generation,baseRevision:snapshot.revision,
    draft:found.plan.draft,artifact:found.plan.artifact,configuration:snapshot.configuration}};}
const executableTest="import test from 'node:test';import assert from 'node:assert/strict';import {convert} from '../src/converter.js';\n// @ac:STORY-1:AC-001\ntest('the approved example',()=>assert.equal(convert(255),'FF'));\n";
for(const backend of ['filesystem','sqlite','application'])test(backend+': the shared preflight consumes actual source and approved claims without a Git baseline',async t=>{
  const f=await namespaceSourceClauseFixture(t,{backend,configure:source=>{source.definition.governance={...source.definition.governance,requireAcceptanceCriteriaTags:true};},
    testSource:executableTest}),{snapshot,identity}=await facts(f),before=await f.head();
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const result=await createNamespaceCodePreflightReader(f.common).inspect(snapshot,'build',identity);
  assert.equal(result.profile,'sflow-namespace-code-preflight/v1');assert.equal(result.repositories.length,1);
  const {delivery,coverage}=result.repositories[0];assert.equal(delivery.baselineCommit,null);
  assert.equal(delivery.sourceBasis.repositoryId,'app');assert.equal(delivery.sourceBasis.sourceBindingId,f.sourceBindingId);
  assert.deepEqual(delivery.sourcePaths,['src/converter.js']);assert.deepEqual(delivery.testPaths,['test/converter.test.js']);
  assert.deepEqual(delivery.acceptanceCriteria.required,['STORY-1:AC-001']);
  assert.equal(delivery.implementationBindings.bindings.length,2);assert.equal(coverage.status,'ready');assert.deepEqual(await f.head(),before);
  const forged=structuredClone(snapshot);forged.workflow.phases.build.qualityCommands=[];
  await assert.rejects(createNamespaceCodePreflightReader(f.common).inspect(forged,'build',identity),{code:'ENGINE_STORAGE_CORRUPT'});
});
test('code-source contexts reconstruct changed and unchanged bytes, keep private copies and preserve original I/O failures',async t=>{
  const unchanged='// A retained original test resource.\n',f=await namespaceSourceClauseFixture(t,{baselineTestSource:unchanged,testSource:unchanged}),{retention,found}=await facts(f),observer=createNamespaceStoryObserver(f.common),baseline=createNamespaceSourceBaselineReader(f.common),
    original=await baseline.inspectBinding(f.sourceBindingId),reader=createNamespaceCodeSourceReader({observer,retention,baseline}),context=await reader.capture(found,original,'app');
  await rm(f.root,{recursive:true,force:true});assert.equal(reader.facts(context,'src/converter.js').exists,true);assert.equal(reader.facts(context,'missing').exists,false);
  const bytes=await reader.bytes(context,'src/converter.js'),expected=Buffer.from(bytes);bytes.fill(0);assert.deepEqual(await reader.bytes(context,'src/converter.js'),expected);
  assert.equal((await reader.bytes(context,'test/converter.test.js')).toString('utf8'),unchanged);
  assert.equal(await reader.bytes(context,'missing'),null);await reader.finish(context);
  await assert.rejects(reader.bytes(context,'src/converter.js',{maximumBytes:1}),{code:'ENGINE_CODE_SOURCE_LIMIT'});
  await assert.rejects(reader.bytes(context,'src/converter.js',{maximumBytes:16*1024*1024+1}),{code:'ENGINE_INPUT_INVALID'});
  await assert.rejects(reader.capture({...found},original,'app'),{code:'ENGINE_INPUT_INVALID'});
  await assert.rejects(reader.bytes({...context},'src/converter.js'),{code:'ENGINE_INPUT_INVALID'});
  const manifest=await retention.verifyRepository(found,found.plan.sources[0],found.body.repositories[0].manifest),chunk=manifest.value.entries.find(row=>row.newPath==='src/converter.js').chunks[0],
    denied=Object.assign(Error('Exact source read permission failure.'),{code:'EACCES'}),
    refused=createNamespaceCodeSourceReader({retention,baseline,observer:{...observer,bytes(ref,...rest){if(ref.sha256===chunk.sha256)throw denied;return observer.bytes(ref,...rest);}}}),issued=await refused.capture(found,original,'app');
  await assert.rejects(refused.bytes(issued,'src/converter.js'),error=>error===denied);
});
test('repository-qualified Code preflight cannot borrow another repository’s clause evidence',async t=>{
  const plan=planText.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`')
    .replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')
    +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | frontend |\n| service-1 | backend |\n',
    f=await namespaceSourceClauseFixture(t,{plan,repositories:2,testSource:executableTest}),reader=createNamespaceCodePreflightReader(f.common),{snapshot,identity}=await facts(f),before=await f.head(),
    first=await reader.inspect(snapshot,'build',identity);
  assert.deepEqual(first.repositories.map(row=>row.id),['app','service-1']);assert.ok(first.repositories.every(row=>row.coverage.status==='ready'));
  await writeFile(path.join(f.roots[1],'src/converter.js'),'export const convert=value=>value.toString(16).toUpperCase();\n');await f.retain('service-clause-repair');
  await assert.rejects(reader.inspect(snapshot,'build',identity),error=>error.code==='CODE_DELIVERY_INCOMPLETE'&&error.details.findings.some(row=>row.code==='code.delivery.source-clause-tag-missing'));
  assert.deepEqual(await f.head(),before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {createEngine} from '../src/engine-sdk/index.mjs';
import {createGitEngine} from '../src/engine-compatibility/git-publication.mjs';
import {createGitDocumentReadPort} from '../src/engine-compatibility/git-document-read.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {viewDocument} from '../src/documents-read.mjs';
import {publishedPlanningStory,startedSpecificationStory,CLI} from './helpers/submitted-planning-story.mjs';
import {docx} from './helpers/office-fixtures.mjs';
import {run} from '../src/util.mjs';

const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));
const json=value=>JSON.parse(JSON.stringify(value));
async function observedCli(f,reference,extra=[]) {
  const file=path.join(f.directory,'document-read.capture.json');
  const result=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,
    CLI,'--no-model','documents','view',reference,...extra,'--json'],{cwd:f.root,allowFailure:true,
      env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file}});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  return {actual:JSON.parse(result.stdout),captured:JSON.parse(await readFile(file,'utf8'))};
}

test('native phase references resolve exact retained bytes while legacy CLI views preserve their shape and authority',async t=>{
  const id='SDK-DOCUMENT',f=await publishedPlanningStory(t,id),api=createSflow({root:f.root});
  const accepted=await loadAcceptedStoryExecution(f.root),workflowFile=path.join(f.item,'workflow.json');
  const before=await readFile(workflowFile),head=f.git('rev-parse','HEAD'),status=f.git('status','--porcelain');
  const terminal=path.resolve(f.root,f.git('rev-parse','--git-dir'),'singularity-flow/terminal-reviews');
  const manifest=(await api.run('phase.review',{phaseId:'planning'})).manifest;
  for(const item of manifest.items) {
    const result=await api.run('document.read',{reference:item.reference});
    assert.equal(result.document.integrity,'matched',item.id);assert.equal(result.document.expected.sha256,item.expected.sha256);
    assert.equal(result.document.observed.sha256,item.observed.sha256);assert.equal(result.document.provenance,'retained');
    assert.equal(result.document.content.kind,'text');assert.ok(result.document.content.text);
    assert.equal(JSON.stringify(result).includes(f.root),false);
  }
  const primary=manifest.items.find(item=>item.primary),expected=await viewDocument(f.root,accepted.definition,accepted.workflow,primary.id);
  const observed=await observedCli(f,primary.id),legacy=await api.run('document.read',{reference:primary.id});
  assert.equal(observed.captured.operation,'document.read');assert.deepEqual(observed.captured.result,legacy);
  assert.deepEqual(observed.actual,{...json(expected),absolutePath:await realpath(expected.absolutePath)});assert.ok(observed.actual.absolutePath);
  const aggregate=await createGitEngine({root:f.root}).engine.run('document.read',{reference:primary.reference});
  assert.deepEqual(aggregate,await api.run('document.read',{reference:primary.reference}));
  const limited=await api.run('document.read',{reference:primary.reference,maximumBytes:64});
  assert.ok(limited.document.content.bytes<=64);assert.equal(limited.document.content.truncated,true);
  assert.ok(observed.actual.content.length>limited.document.content.text.length,'SDK budget does not truncate legacy rendering');
  await assert.rejects(api.run('document.read',{reference:'../package.json'}),{code:'DOCUMENT_NOT_FOUND'});

  const original=await readFile(expected.absolutePath);
  await rm(expected.absolutePath);
  await assert.rejects(api.run('document.read',{reference:primary.reference}),error=>error.cause?.code==='ENOENT');
  await writeFile(expected.absolutePath,Buffer.concat([original,Buffer.from('\nUnpublished edit.\n')]));
  await assert.rejects(api.run('document.read',{reference:primary.reference}),{code:'DOCUMENT_HASH_MISMATCH'});
  const dirty=await api.run('document.read',{reference:primary.id});
  assert.equal(dirty.document.integrity,'changed');assert.match(dirty.document.content.text,/Unpublished edit/);
  await writeFile(expected.absolutePath,original);
  assert.equal((await api.run('document.read',{reference:primary.reference})).document.integrity,'matched');
  assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(f.git('status','--porcelain'),status);
  assert.deepEqual(await readFile(workflowFile),before);assert.equal(existsSync(terminal),false);

  const loader=`export async function resolve(specifier,context,next){
    if(specifier.endsWith('/git-publication.mjs')||specifier.endsWith('/commands/legacy.mjs')||specifier.endsWith('/git-phase-review.mjs'))throw Error('Eager unrelated owner: '+specifier);
    return next(specifier,context);
  }`;
  const source=`import {register} from 'node:module';register(${JSON.stringify('data:text/javascript,'+encodeURIComponent(loader))},import.meta.url);
    const {createSflow}=await import(${JSON.stringify(new URL('../src/api.mjs',import.meta.url).href)});
    const result=await createSflow({root:${JSON.stringify(f.root)}}).run('document.read',{reference:'SYS-STORY'});
    console.log(JSON.stringify({status:result.status,role:result.document.role}));`;
  const narrow=run(process.execPath,['--input-type=module','-e',source],{cwd:f.root,allowFailure:true});
  assert.equal(narrow.status,0,narrow.stdout+'\n'+narrow.stderr);
  assert.deepEqual(JSON.parse(narrow.stdout),{status:'read',role:'system'});

  // The final text read must not carry an earlier snapshot's verified hash if bytes changed.
  const raced=`import {mock} from 'node:test';import * as nativeFs from 'node:fs/promises';
    const target=${JSON.stringify(expected.absolutePath)},{default:ignored,...named}=nativeFs;let reads=0;
    const changing=async(candidate,...args)=>{
      const value=await nativeFs.readFile(candidate,...args);
      if(candidate!==target||++reads!==2)return value;
      const changed=Buffer.from(value);changed[changed.length-1]=changed.at(-1)===65?66:65;return changed;
    };
    mock.module('node:fs/promises',{namedExports:{...named,readFile:changing},defaultExport:{...nativeFs.default,readFile:changing}});
    const {loadAcceptedStoryExecution}=await import(${JSON.stringify(new URL('../src/accepted-story-execution.mjs',import.meta.url).href)});
    const accepted=await loadAcceptedStoryExecution(${JSON.stringify(f.root)});
    const {readDocumentRecord}=await import(${JSON.stringify(new URL('../src/documents-read.mjs',import.meta.url).href)});
    reads=0;try{await readDocumentRecord(${JSON.stringify(f.root)},accepted.definition,accepted.workflow,${JSON.stringify(expected.record)});throw Error('Race was accepted');}
    catch(error){if(error.code!=='DOCUMENT_HASH_MISMATCH')throw error;console.log(JSON.stringify({code:error.code,reads,details:error.details}));}`;
  const changedDuringRead=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--input-type=module','-e',raced],{cwd:f.root,allowFailure:true});
  assert.equal(changedDuringRead.status,0,changedDuringRead.stdout+'\n'+changedDuringRead.stderr);
  const race=JSON.parse(changedDuringRead.stdout);assert.equal(race.code,'DOCUMENT_HASH_MISMATCH');assert.equal(race.reads,2);
  assert.equal(race.details.expectedSha256,expected.verifiedSha256);assert.notEqual(race.details.actualSha256,expected.verifiedSha256);
});

test('local text, images and Office originals stay local and a takeover requires the exact original again',async t=>{
  const id='SDK-DOCUMENT-LOCAL',f=await startedSpecificationStory(t,id,{configure(config){
    config.documents.storage={allowed:['local'],default:'local'};config.documents.maxPreviewBytes=96;
  }});
  const notes=path.join(f.directory,'requirements.md'),image=path.join(f.directory,'reference.png'),office=path.join(f.directory,'brief.docx');
  const text='# Requirements\nPreserve the selected value and show the confirmed output.\n';
  await writeFile(notes,text);
  await writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64'));
  await writeFile(office,docx(['A bounded document read preserves the confirmed requirement. '.repeat(5)]));
  f.cli('documents','upload',notes,image,office,'--name','Requirements','--name','Reference image','--name','Office brief');
  f.cli('documents','upload','--url','https://example.com/reference','--name','External reference');
  const api=createSflow({root:f.root}),head=f.git('rev-parse','HEAD');
  const manifest=JSON.parse(await readFile(path.join(f.item,'documents.json'),'utf8'));
  assert.equal(manifest.documents.filter(record=>record.storage?.kind==='local').length,3);
  assert.equal(f.git('ls-tree','-r','--name-only','HEAD','--',path.relative(f.root,path.join(f.item,'inputs'))),'');
  const file=await api.run('document.read',{reference:'Requirements'});
  assert.equal(file.document.locality,'machine-local');assert.equal(file.document.content.text,text);assert.equal(file.document.integrity,'matched');
  assert.equal(JSON.stringify(file).includes(f.root),false);assert.equal(file.document.provenance,'catalog');
  const observed=await observedCli(f,'Requirements');
  assert.deepEqual(observed.captured.result,file);assert.equal(observed.actual.content,text);assert.ok(observed.actual.absolutePath);
  const binary=await api.run('document.read',{reference:'Reference image'});
  assert.equal(binary.document.observed.binary,true);assert.equal(binary.document.content,null);
  const extracted=await api.run('document.read',{reference:'Office brief',maximumBytes:31});
  assert.equal(extracted.document.content.kind,'extracted-text');assert.equal(extracted.document.content.truncated,true);
  assert.ok(extracted.document.content.bytes<=31);assert.equal(extracted.document.observed.binary,true);
  const fetch=t.mock.method(globalThis,'fetch',()=>{throw Error('A document read must not fetch its URL');});
  const link=await api.run('document.read',{reference:'External reference'});
  assert.equal(link.document.integrity,'reference-only');assert.equal(link.document.uri,'https://example.com/reference');
  assert.equal(fetch.mock.callCount(),0);fetch.mock.restore();
  assert.equal(f.git('rev-parse','HEAD'),head);

  const clone=path.join(f.directory,'takeover');
  f.run('git',['clone','--quiet','--branch',id,f.remote,clone],{cwd:f.directory});
  const takeover=createSflow({root:clone});
  await assert.rejects(takeover.run('document.read',{reference:file.document.reference}),error=>
    error.code==='DOCUMENT_LOCAL_UNAVAILABLE'&&/documents restore DOC-001 --file/.test(error.message));
  const cloneHead=f.run('git',['rev-parse','HEAD'],{cwd:clone}).stdout.trim();
  f.run(process.execPath,[CLI,'--no-model','documents','restore','DOC-001','--file',notes,'--json'],{cwd:clone});
  assert.equal((await takeover.run('document.read',{reference:file.document.reference})).document.content.text,text);
  assert.equal(f.run('git',['rev-parse','HEAD'],{cwd:clone}).stdout.trim(),cloneHead,'restoring local bytes does not recreate or republish the Story');

  f.cli('documents','detach','DOC-001','--reason','No longer an offered input','--yes');
  await assert.rejects(api.run('document.read',{reference:'DOC-001'}),{code:'DOCUMENT_NOT_FOUND'});
  assert.equal((await api.run('document.read',{reference:'DOC-001',includeDetached:true})).document.content.text,text);

  const manifestFile=path.join(f.item,'documents.json'),original=await readFile(manifestFile),before=f.git('rev-parse','HEAD');
  const native=createGitDocumentReadPort({root:f.root});let reads=0;
  const engine=createEngine({ports:{documentRead:{load:(...args)=>native.load(...args),
    async resolve(...args){const result=await native.resolve(...args);await writeFile(manifestFile,Buffer.concat([original,Buffer.from('\n')]));return result;},
    read(...args){reads+=1;return native.read(...args);}}}});
  try{await assert.rejects(engine.run('document.read',{reference:'SYS-STORY'}),{code:'DOCUMENT_REVIEW_CHANGED'});}
  finally{await writeFile(manifestFile,original);}
  assert.equal(reads,1);assert.equal(f.git('rev-parse','HEAD'),before,'a changed catalog is refused without an automatic retry or publication');
});

test('the source and actually bundled document command preserve draft and truncation rendering',async t=>{
  const f=await startedSpecificationStory(t,'SDK-DOCUMENT-BUNDLE',{configure(config){config.documents.maxPreviewBytes=96;}});
  f.cli('prepare','specification');
  const expected=JSON.parse(f.cli('documents','view','PHASE-SPECIFICATION','--json').stdout);
  const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-document-read-',import.meta.url)));
  t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');await buildCliBundle({outdir});
  const bundled=run(process.execPath,[CLI,'--no-model','documents','view','PHASE-SPECIFICATION','--json'],{cwd:f.root,allowFailure:true,
    env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir}});
  assert.equal(bundled.status,0,bundled.stdout+'\n'+bundled.stderr);
  assert.deepEqual(JSON.parse(bundled.stdout),expected);assert.equal(expected.previewBytes,96);assert.equal(expected.truncated,true);
  const draft=await createSflow({root:f.root}).run('document.read',{reference:'PHASE-SPECIFICATION'});
  assert.equal(draft.document.integrity,'unbound');assert.equal(draft.document.provenance,'snapshot');
  assert.equal(draft.document.content.truncated,true);assert.equal(draft.document.budgetBytes,96);
  const typo=f.run(process.execPath,[CLI,'--no-model','documents','view','SYS-STORY','--al','--json'],{allowFailure:true});
  assert.notEqual(typo.status,0);assert.match(typo.stdout+typo.stderr,/has no option --al\. Did you mean --all/);
});

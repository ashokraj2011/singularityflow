/** Real local Git observations; no remote, lifecycle authority, installation or model calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {mkdtemp,readFile,writeFile,rm,realpath,mkdir,chmod,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createFilesystemSourceUnit} from '../src/sgos/filesystem-source-unit.mjs';
import {createNodeGitSourceControlReader,NODE_GIT_SOURCE_CONTROL_PROFILE} from '../src/sgos/node-git-source-control-reader.mjs';
import {buildRepositoryChangeSet,verifyRepositoryChangeSetIntegrity} from '../src/repository-change-set.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {gitPatchCoordinates,gitTagLineDeltas} from '../src/git-status-detail.mjs';
import {sourceOriginLineDeltasReplay} from '../src/engine-compatibility/node-source-policy.mjs';
import {SOURCE_CONTROL_READER_CONTRACT,SOURCE_CONTROL_OBSERVATION_FORMAT,SOURCE_CONTROL_LIMITS,
  sourceControlReaderDescriptor,validateSourceControlReader,sourceControlCaptureRequest,sourceControlObservation} from '../src/foundation/source-control.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const subject=Object.freeze({workId:'source-story',phase:'implementation',generation:1,generationIntentId:'source-generation'});
let gitBinary;
// Discovery is confined to this fixture. Production readers require an explicit pinned binary.
for(const directory of (process.env.PATH??'').split(path.delimiter)){
  try{const executable=await realpath(path.join(directory,process.platform==='win32'?'git.exe':'git'));
    gitBinary={executable,executableSha256:'sha256:'+hash(await readFile(executable))};break;}catch{}
}
assert.ok(gitBinary,'A real local Git installation is required for this qualification');
async function fixture(t,{files={'app.js':'baseline application\n'},excludePaths=[],limits={},objectFormat=null}={}){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'sflow-git-reader-')));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const git=(...args)=>execFileSync(gitBinary.executable,args,{cwd:root,encoding:'utf8',timeout:15_000,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0'}}).trim();
  git('init','-q','-b','main',...(objectFormat?['--object-format='+objectFormat]:[]));git('config','user.name','Example fixture');git('config','user.email','fixture@example.test');
  git('config','core.ignorecase','false');git('config','gc.auto','0');git('config','core.filemode','true');
  for(const [name,content]of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),content);}
  git('add','-A');git('commit','--allow-empty','-qm','baseline');const baselineCommit=git('rev-parse','HEAD');
  const unit=await createFilesystemSourceUnit({root,id:'selected-source',projectId:'project',repositoryId:'application',excludePaths,limits});
  const options={id:'local-git',root,source:unit.descriptor,baselineCommit,git:{...gitBinary},authorizeCapture:async()=>true};
  return {root,git,baselineCommit,unit,options,reader:extra=>createNodeGitSourceControlReader({...options,...extra})};
}
test('versioned line origins reconstruct native -G deltas without publishing source text',async t=>{
  const name=process.platform==='win32'?'spaced 🧮.js':'quoted" 🧮.js',before='// @clause:SHARED:REQ-001 earlier statement\nexport const a=1;\n',
    after='// @clause:SHARED:REQ-001 revised statement\nexport const a=2;\n',f=await fixture(t,{files:{[name]:before}});
  await writeFile(path.join(f.root,name),after);f.git('add',name);
  const reader=await f.reader({originCommit:f.baselineCommit}),answer=await reader.capture(subject),value=answer.observation;
  assert.equal(reader.descriptor.contract,'sflow-source-control-reader/v2');assert.equal(value.schemaVersion,2);
  assert.equal(value.origin.patch[0].oldPath,name);assert.equal(JSON.stringify(value).includes('revised statement'),false);
  const run=sourceOriginLineDeltasReplay({patch:value.origin.patch,tag:'clause',pathContext:null});
  let next=run.next();while(!next.done)next=run.next(Buffer.from(next.value.side==='origin'?before:after));
  const raw=execFileSync(gitBinary.executable,['-c','core.quotePath=false','diff','--no-color','--no-ext-diff','--no-textconv',
    '--unified=0','--find-renames','--src-prefix=a/','--dst-prefix=b/','-G@[Cc][Ll][Aa][Uu][Ss][Ee]',f.baselineCommit,'--'],{cwd:f.root,env:process.env,encoding:'utf8'});
  assert.deepEqual(next.value,gitTagLineDeltas(raw));assert.deepEqual(gitPatchCoordinates(raw),value.origin.patch);
  assert.equal((await reader.capture(subject)).revision,answer.revision);
});
test('v2 records include metadata-only renames and binary changes without inventing text hunks',async t=>{
  const f=await fixture(t,{files:{'old.js':'// @clause:SHARED:REQ-001 old tag\n','blob.bin':Buffer.from([0,1,2])}});
  f.git('mv','old.js','new.js');await writeFile(path.join(f.root,'blob.bin'),Buffer.from([0,2,3]));
  const answer=await(await f.reader({originCommit:f.baselineCommit})).capture(subject);
  assert.equal(answer.observation.origin.patch.length,2);
  assert.ok(answer.observation.origin.patch.every(row=>row.hunks.length===0));
  assert.ok(answer.observation.origin.patch.some(row=>row.oldPath==='old.js'&&row.newPath==='new.js'));
});
test('actual committed, staged, working, deleted, mode and untracked changes retain native identities and real baseline hashes',async t=>{
  const files={'app.js':'baseline application\n','old.txt':Array.from({length:40},(_,i)=>'original row '+i).join('\n'),
    'deleted.txt':'deleted baseline\n','mode.sh':'echo example\n'};
  const f=await fixture(t,{files});f.git('mv','old.txt','renamed.txt');f.git('commit','-qm','committed rename');
  await writeFile(path.join(f.root,'app.js'),'staged application\n');f.git('add','app.js');
  await writeFile(path.join(f.root,'app.js'),'actual current application\n');await rm(path.join(f.root,'deleted.txt'));
  await writeFile(path.join(f.root,'untracked.js'),'new regular file\n');await chmod(path.join(f.root,'mode.sh'),0o755);
  const index=await readFile(path.join(f.root,'.git/index')),head=f.git('rev-parse','HEAD'),reader=await f.reader();
  const answer=await reader.capture(subject);
  assert.deepEqual(await readFile(path.join(f.root,'.git/index')),index);assert.equal(f.git('rev-parse','HEAD'),head);
  assert.equal(answer.observation.format,SOURCE_CONTROL_OBSERVATION_FORMAT);assert.equal(answer.observation.profile,NODE_GIT_SOURCE_CONTROL_PROFILE);
  assert.equal(answer.revision,'sha256:'+hash(canonicalJson(answer.observation)));
  assert.equal(verifyRepositoryChangeSetIntegrity(answer.observation.control).valid,true);
  assert.deepEqual(answer.observation.control,await buildRepositoryChangeSet(f.root,{baseCommit:f.baselineCommit,subject}));
  assert.deepEqual(answer.observation.baseline.entries,Object.entries(files).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,content])=>({
    path:name,sha256:hash(content),bytes:Buffer.byteLength(content),executable:false})));
  assert.equal(answer.observation.current.snapshot.entries.find(row=>row.path==='app.js').sha256,hash('actual current application\n'));
  const json=JSON.stringify(answer);assert.equal(json.includes(f.root),false);assert.equal(json.includes('actual current application'),false);
  assert.equal(Object.hasOwn(answer,'approved'),false);assert.equal(Object.hasOwn(answer,'publicationReady'),false);
  assert.equal(answer.metrics.baselineCacheReused,false);assert.ok(answer.metrics.gitCalls>0);
});
test('repeated observations cache only the immutable baseline and recheck current Git facts',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'app.js'),'changed bytes');const reader=await f.reader();
  const cold=await reader.capture(subject),warm=await reader.capture(subject);
  assert.deepEqual(warm.observation,cold.observation);assert.equal(warm.revision,cold.revision);
  assert.equal(warm.metrics.baselineCacheReused,true);assert.equal(cold.metrics.gitCalls-warm.metrics.gitCalls,2);
  await writeFile(path.join(f.root,'app.js'),'later current bytes');const later=await reader.capture(subject);
  assert.notEqual(later.revision,warm.revision);assert.deepEqual(later.observation.baseline,warm.observation.baseline);
});
test('empty committed baselines remain empty and do not invent blob reads',async t=>{
  const f=await fixture(t,{files:{}}),reader=await f.reader(),first=await reader.capture(subject),second=await reader.capture(subject);
  assert.deepEqual(first.observation.baseline.entries,[]);assert.deepEqual(first.observation.control.entries,[]);
  assert.equal(first.metrics.gitCalls-second.metrics.gitCalls,1);
});
test('real SHA-256 Git objects preserve binary baseline bytes and current source identities',async t=>{
  const original=Buffer.from([0,10,255,13,42]),f=await fixture(t,{files:{'app.bin':original},objectFormat:'sha256'});
  await writeFile(path.join(f.root,'app.bin'),Buffer.from([0,7,255,10]));
  const answer=await(await f.reader()).capture(subject);assert.equal(f.baselineCommit.length,64);
  assert.equal(answer.observation.control.base.tree.length,64);assert.equal(answer.observation.control.entries[0].oldObject.length,64);
  assert.deepEqual(answer.observation.baseline.entries,[{path:'app.bin',sha256:hash(original),bytes:5,executable:false}]);
  assert.equal(answer.observation.current.snapshot.entries[0].sha256,hash(Buffer.from([0,7,255,10])));
});
test('a real linked worktree reads its own index and preserves the original checkout',async t=>{
  const f=await fixture(t),root=path.join(f.root,'linked');f.git('worktree','add','-q','--detach',root,f.baselineCommit);
  const index=await readFile(path.join(f.root,'.git/index'));await writeFile(path.join(root,'app.js'),'linked current bytes');
  const answer=await(await f.reader({root})).capture(subject);
  assert.equal(answer.observation.current.snapshot.entries[0].sha256,hash('linked current bytes'));
  assert.equal(await readFile(path.join(f.root,'app.js'),'utf8'),'baseline application\n');
  assert.deepEqual(await readFile(path.join(f.root,'.git/index')),index);
  assert.equal(answer.observation.current.snapshot.entries.some(row=>row.path.startsWith('.git')),false);
});
test('source selection is shared with the filesystem unit and cross-boundary renames are refused',async t=>{
  const f=await fixture(t,{files:{'app.js':'selected','private/internal.txt':'local private content'},excludePaths:['private']});
  await writeFile(path.join(f.root,'private/new.txt'),'private added bytes');await writeFile(path.join(f.root,'private/internal.txt'),'private modified bytes');
  const answer=await(await f.reader()).capture(subject);
  assert.deepEqual(answer.observation.baseline.entries.map(row=>row.path),['app.js']);assert.deepEqual(answer.observation.control.entries,[]);
  assert.equal(JSON.stringify(answer.observation).includes('private/internal.txt'),false);
  f.git('mv','app.js','private/moved.js');
  await assert.rejects((await f.reader()).capture(subject),{code:'SGOS_SOURCE_CONTROL_BOUNDARY'});
});
test('capability fields are copied and frozen and Git selector environment variables are refused',async t=>{
  const f=await fixture(t),options={...f.options,source:structuredClone(f.options.source),git:{...gitBinary,environment:{READER_CANARY:'explicit-only'}}};
  const reader=await createNodeGitSourceControlReader(options),descriptor=structuredClone(reader.descriptor);
  options.git.executable='changed';options.git.environment.READER_CANARY='changed';options.source.selection.excludePaths.push('app.js');
  assert.deepEqual(reader.descriptor,descriptor);assert.equal(Object.isFrozen(reader.descriptor.source.selection.excludePaths),true);
  assert.equal((await reader.capture(subject)).observation.current.snapshot.entries[0].path,'app.js');
  await assert.rejects(f.reader({source:descriptor.source,git:{...gitBinary,environment:{GIT_DIR:'another-repository'}}}),{code:'SGOS_SOURCE_CONTROL_INPUT_INVALID'});
  let getters=0;const invalid={...f.options,git:{...gitBinary},get timeoutMs(){getters++;return 1;}};
  await assert.rejects(createNodeGitSourceControlReader(invalid),{code:'SGOS_SOURCE_CONTROL_INPUT_INVALID'});assert.equal(getters,0);
});
test('denied and failed authorization launch no Git and preserve the real permission failure',async t=>{
  const f=await fixture(t);let calls=0;
  await assert.rejects((await f.reader({authorizeCapture:async()=>false,notice:()=>calls++})).capture(subject),{code:'SGOS_SOURCE_CONTROL_AUTHORITY_REQUIRED'});
  const denied=Object.freeze(Object.assign(new Error('actual application permission failure'),{code:'EACCES'}));
  await assert.rejects((await f.reader({authorizeCapture:async()=>{throw denied;},notice:()=>calls++})).capture(subject),error=>error===denied);
  assert.equal(calls,0);
});
test('authorization timeout cannot turn a late answer into a Git launch',async t=>{
  const f=await fixture(t);let finish,calls=0;
  const reader=await f.reader({timeoutMs:30,authorizeCapture:()=>new Promise(resolve=>{finish=resolve;}),notice:()=>calls++});
  await assert.rejects(reader.capture(subject),error=>error.code==='SGOS_SOURCE_CONTROL_TIMEOUT'&&error.timedOut&&error.timeoutMs===30
    &&error.details.stage==='authorization'&&!error.message.includes('DNS'));
  finish(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
});
test('pre-cancelled and cancelled Git dispatches do not proceed to a source result',async t=>{
  const f=await fixture(t),controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects((await f.reader({notice:()=>calls++})).capture(subject,{signal:controller.signal}),{code:'SGOS_SOURCE_CONTROL_CANCELLED'});
  assert.equal(calls,0);const active=new AbortController();
  const reader=await f.reader({notice:value=>{if(value.stage==='rev-parse')active.abort();}});
  await assert.rejects(reader.capture(subject,{signal:active.signal}),{code:'SGOS_SOURCE_CONTROL_CANCELLED'});
});
test('executable drift and real missing-root errors are preserved before Git dispatch',async t=>{
  const f=await fixture(t);let calls=0;
  await assert.rejects((await f.reader({git:{...gitBinary,executableSha256:'sha256:'+'0'.repeat(64)},notice:()=>calls++})).capture(subject),{code:'SGOS_GEU_EXECUTABLE_CHANGED'});
  assert.equal(calls,0);await assert.rejects(f.reader({root:path.join(f.root,'missing-root')}),{code:'ENOENT'});
});
test('unavailable baseline commits retain Git exit status, stderr and stage without network guesses',async t=>{
  const f=await fixture(t),reader=await f.reader({baselineCommit:'1'.repeat(40)});
  await assert.rejects(reader.capture(subject),error=>{
    assert.equal(error.code,'SGOS_SOURCE_CONTROL_GIT_FAILED');assert.equal(error.details.stage,'rev-parse');
    assert.ok(error.details.status>0);assert.ok(error.details.stderr.length>0);assert.equal(error.details.timedOut,false);
    assert.match(error.details.stderrSha256,/^sha256:[a-f0-9]{64}$/u);assert.doesNotMatch(error.message,/DNS|network failure/u);return true;
  });
});
test('source bytes changed during observation are refused',async t=>{
  const f=await fixture(t),reader=await f.reader({notice:value=>{if(value.stage==='source-after')writeFileSync(path.join(f.root,'app.js'),'concurrent bytes');}});
  await assert.rejects(reader.capture(subject),{code:'SGOS_SOURCE_CONTROL_SOURCE_CHANGED'});
});
test('Git HEAD movement without a source change fails the final fresh binding check',async t=>{
  const f=await fixture(t),reader=await f.reader({notice:value=>{if(value.stage==='source-after')f.git('commit','--allow-empty','-qm','concurrent metadata');}});
  await assert.rejects(reader.capture(subject),{code:'SGOS_SOURCE_CONTROL_SOURCE_CHANGED'});
});
test('tracking changes without different source bytes fail the final fresh binding check',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'new.js'),'same source bytes');
  const reader=await f.reader({notice:value=>{if(value.stage==='source-after')f.git('add','new.js');}});
  await assert.rejects(reader.capture(subject),{code:'SGOS_SOURCE_CONTROL_SOURCE_CHANGED'});
});
test('path-comparison and hidden-index flag changes fail the final fresh binding checks',async t=>{
  const f=await fixture(t),reader=await f.reader({notice:value=>{if(value.stage==='source-after')f.git('config','core.ignorecase','true');}});
  await assert.rejects(reader.capture(subject),{code:'SGOS_SOURCE_CONTROL_SOURCE_CHANGED'});
  f.git('config','core.ignorecase','false');const hidden=await f.reader({notice:value=>{if(value.stage==='source-after')f.git('update-index','--assume-unchanged','app.js');}});
  await assert.rejects(hidden.capture(subject),{code:'SGOS_SOURCE_CONTROL_HIDDEN_CHANGES'});
});
test('existing hidden index flags and actual unresolved merge entries remain explicit failures',async t=>{
  const f=await fixture(t);f.git('update-index','--skip-worktree','app.js');
  await assert.rejects((await f.reader()).capture(subject),{code:'SGOS_SOURCE_CONTROL_HIDDEN_CHANGES'});
  f.git('update-index','--no-skip-worktree','app.js');
  f.git('checkout','-qb','other');await writeFile(path.join(f.root,'app.js'),'other branch');f.git('commit','-am','other');
  f.git('checkout','-q','main');await writeFile(path.join(f.root,'app.js'),'main branch');f.git('commit','-am','main');
  assert.throws(()=>f.git('merge','--no-edit','other'));
  await assert.rejects((await f.reader()).capture(subject),{code:'CHANGE_SET_UNMERGED'});
});
test('a selected baseline symbolic link cannot be replaced with invented regular baseline evidence',async t=>{
  const f=await fixture(t);await symlink('app.js',path.join(f.root,'old-link'));f.git('add','old-link');f.git('commit','-qm','old link');
  const baselineCommit=f.git('rev-parse','HEAD');await rm(path.join(f.root,'old-link'));await writeFile(path.join(f.root,'old-link'),'regular replacement');
  await assert.rejects((await f.reader({baselineCommit})).capture(subject),{code:'SGOS_SOURCE_CONTROL_TYPE_UNSUPPORTED'});
});
test('missing baseline blobs retain exact missing-object details',async t=>{
  const f=await fixture(t),object=f.git('rev-parse',f.baselineCommit+':app.js');
  // An unchanged worktree needs no content diff; only the baseline object read discovers this loss.
  await rm(path.join(f.root,'.git/objects',object.slice(0,2),object.slice(2)));
  await assert.rejects((await f.reader()).capture(subject),error=>{
    assert.equal(error.code,'SGOS_SOURCE_CONTROL_OBJECT_UNAVAILABLE',JSON.stringify(error.details));assert.equal(error.details.objectId,object);
    assert.equal(error.details.path,'app.js');assert.equal(error.details.stage,'ls-tree');
    assert.ok(error.details.gitAnswer.includes(object));assert.match(error.details.gitAnswer,/(?:BAD|-)$/u);return true;
  });
});
test('baseline file and byte limits apply even when those files are no longer in the current source',async t=>{
  const f=await fixture(t,{files:{'app.js':'current','old.txt':'old bytes beyond bound'},limits:{maximumFileBytes:8}});
  await rm(path.join(f.root,'old.txt'));
  await assert.rejects((await f.reader()).capture(subject),{code:'SGOS_SOURCE_CONTROL_LIMIT'});
});
test('pure source-control descriptors and observations preserve exact subjects, versions, bounds and capability separation',async t=>{
  const f=await fixture(t),reader=await f.reader(),answer=await reader.capture(subject),descriptor=reader.descriptor;
  assert.equal(descriptor.contract,SOURCE_CONTROL_READER_CONTRACT);assert.deepEqual(validateSourceControlReader(reader),descriptor);
  assert.equal(Object.hasOwn(f.unit,'control'),false);assert.equal(Object.hasOwn(f.unit.descriptor,'baselineRevision'),false);
  assert.throws(()=>validateSourceControlReader({descriptor}),{code:'SGOS_SOURCE_CONTROL_CONTRACT_INVALID'});
  let getters=0;assert.throws(()=>sourceControlReaderDescriptor({...descriptor,get profile(){getters++;return 'future';}}),{code:'SGOS_SOURCE_CONTROL_CONTRACT_INVALID'});assert.equal(getters,0);
  for(const input of [{...subject,extra:true},{...subject,generation:0},{...subject,workId:'../bad'},{...subject,generationIntentId:''}])assert.throws(()=>sourceControlCaptureRequest(input),{code:'SGOS_SOURCE_CONTROL_CONTRACT_INVALID'});
  assert.throws(()=>sourceControlObservation({...answer.observation,schemaVersion:2},descriptor,subject),{code:'SGOS_SOURCE_CONTROL_UNSUPPORTED'});
  assert.throws(()=>sourceControlObservation(answer.observation,descriptor,{...subject,generation:2}),{code:'SGOS_SOURCE_CONTROL_CONTRACT_INVALID'});
  const changed=structuredClone(answer.observation);changed.baseline.revision='another';
  assert.throws(()=>sourceControlObservation(changed,descriptor,subject),{code:'SGOS_SOURCE_CONTROL_CONTRACT_INVALID'});
  const bytes=structuredClone(answer.observation);bytes.current.snapshot.entries[0].sha256='invalid';
  assert.throws(()=>sourceControlObservation(bytes,descriptor,subject),{code:'SGOS_SOURCE_CONTRACT_INVALID'});
  assert.throws(()=>sourceControlObservation(answer.observation,{...descriptor,limits:{...SOURCE_CONTROL_LIMITS,maximumManifestBytes:1}},subject),{code:'SGOS_SOURCE_CONTROL_CONTRACT_INVALID'});
  const accessor=structuredClone(answer.observation);Object.defineProperty(accessor.control,'entries',{enumerable:true,get(){getters++;return [];}});
  assert.throws(()=>sourceControlObservation(accessor,descriptor,subject),{code:'SGOS_SOURCE_CONTROL_CONTRACT_INVALID'});assert.equal(getters,0);
  const cyclic=structuredClone(answer.observation);cyclic.control.cycle=cyclic;
  assert.throws(()=>sourceControlObservation(cyclic,descriptor,subject),{code:'SGOS_SOURCE_CONTROL_CONTRACT_INVALID'});
});

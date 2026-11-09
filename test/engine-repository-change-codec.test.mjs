import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {createRepositoryChangeSetCodec,REPOSITORY_CHANGE_SET_VALUES} from '../src/kernel/source-path-policies.mjs';
import * as binding from '../src/engine-compatibility/node-source-policy.mjs';
import * as native from '../src/repository-change-set.mjs';
import {schemaFamily} from '../src/schema-migrations.mjs';
import {REPOSITORY_CHANGE_SET_SCHEMA,admitRecordSchemaVersion} from '../src/foundation/record-schema.mjs';
const original=JSON.parse(await readFile(new URL('./fixtures/repository-change-codec/native-v1.json',import.meta.url),'utf8'));
const hash=text=>createHash('sha256').update(text).digest('hex');
const values=extra=>Object.freeze({profile:REPOSITORY_CHANGE_SET_VALUES,sha256Text:text=>'sha256:'+hash(text),
  compareUtf8:(left,right)=>Buffer.compare(Buffer.from(left,'utf8'),Buffer.from(right,'utf8')),...extra});
const codec=()=>createRepositoryChangeSetCodec(values());
const outcome=invoke=>{try{return {value:JSON.parse(JSON.stringify(invoke()))};}catch(error){return {error:{name:error.name,message:error.message,code:error.code??null,details:error.details??null}};}};
test('shared repository change-set admission preserves the original native family metadata and path ownership',()=>{
  const {paths,...metadata}=schemaFamily('repository-change-set');
  assert.deepEqual(metadata,{id:'repository-change-set',currentVersion:1,minimumReadableVersion:1,maximumReadableVersion:1,
    steps:[],immutable:true,unversionedAs:null,migrationPolicy:'migrate-on-read',model:'never'});
  assert.equal(paths.length,1);assert.equal(paths[0].test('singularity/work-items/example/context/code-delivery/implementation-gen1-changes.json'),true);
  assert.equal(paths[0].test('singularity/work-items/example/artifacts/implementation/changes.json'),false);
  assert.equal(admitRecordSchemaVersion(REPOSITORY_CHANGE_SET_SCHEMA,{schemaVersion:1}).storedVersion,1);
  assert.throws(()=>admitRecordSchemaVersion(REPOSITORY_CHANGE_SET_SCHEMA,{schemaVersion:2}),{code:'SCHEMA_VERSION_FUTURE'});
  assert.throws(()=>admitRecordSchemaVersion(REPOSITORY_CHANGE_SET_SCHEMA,{}),{code:'SCHEMA_VERSION_MISSING'});
});
test('649 independently captured raw Git records retain exact endpoints, scores, modes, malformed-record errors and path refusals',()=>{
  assert.equal(original.baseline,'23190d234');assert.equal(original.records.length,649);
  for(const row of original.records)assert.deepEqual(outcome(()=>native.parseRawDiff(row.raw)),row.outcome,JSON.stringify(row.raw));
});
test('225 UTF-8 orderings and 240 native digest/integrity outcomes preserve original record identities',()=>{
  const reader=codec();assert.equal(original.comparisons.length,225);assert.equal(original.digests.length,240);
  for(const row of original.comparisons)assert.equal(reader.compareRepositoryIdentity(row.left,row.right),row.value,JSON.stringify(row));
  for(const row of original.digests){const before=structuredClone(row.value);assert.equal(reader.repositoryChangeSetDigest(row.value),row.digest);
    assert.deepEqual(reader.verifyRepositoryChangeSetIntegrity(row.value),row.integrity);assert.deepEqual(row.value,before);}
  for(const row of original.malformed)assert.deepEqual(outcome(()=>reader.verifyRepositoryChangeSetIntegrity(row.value)),row.outcome);
  assert.equal(reader.compareRepositoryIdentity('\ue000','𐀀')<0,true,'UTF-8 byte order differs from UTF-16 code-unit order');
});
test('five extracted native bodies retain independent fingerprints, and native exports use the shared binding',async()=>{
  const printer=ts.createPrinter({removeComments:false}),found=new Set();
  for(const file of ['../src/kernel/source-path-policies.mjs','../src/repository-change-set.mjs','../src/git-status-detail.mjs']){
    const ast=ts.createSourceFile(file,await readFile(new URL(file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{if(ts.isFunctionDeclaration(node)&&Object.hasOwn(original.functions,node.name?.text??'')){
      assert.equal(hash(printer.printNode(ts.EmitHint.Unspecified,node.body,ast)),original.functions[node.name.text],node.name.text);found.add(node.name.text);}
      ts.forEachChild(node,visit);};visit(ast);
  }assert.equal(found.size,5);
  for(const name of ['compareRepositoryIdentity','repositoryChangeSetDigest','verifyRepositoryChangeSetIntegrity'])assert.equal(native[name],binding[name],name);
});
test('explicit bindings reject accessors without invoking them, do not call primitives during construction, and preserve callback errors',()=>{
  let calls=0;const failure=Object.freeze(Object.assign(new Error('actual hash capability unavailable'),{code:'VALUE_HASH_UNAVAILABLE'}));
  const reader=createRepositoryChangeSetCodec(values({sha256Text(){calls++;throw failure;},compareUtf8(){calls++;throw failure;}}));
  assert.equal(calls,0);
  assert.throws(()=>reader.repositoryChangeSetDigest({}),error=>error===failure);
  assert.throws(()=>reader.compareRepositoryIdentity('a','b'),error=>error===failure);
  let getters=0;const invalid=Object.freeze({...values(),get sha256Text(){getters++;return ()=>'';}});
  assert.throws(()=>createRepositoryChangeSetCodec(invalid),{code:'ENGINE_CHANGE_SET_VALUES_INVALID'});assert.equal(getters,0);
  for(const value of [null,{...values()},Object.freeze({...values(),unexpected:true}),Object.freeze({...values(),profile:'future'})])assert.throws(()=>createRepositoryChangeSetCodec(value),{code:'ENGINE_CHANGE_SET_VALUES_INVALID'});
});
test('logical record paths retain exact data; the codec neither normalizes host paths nor decodes Git wire records',()=>{
  const reader=codec(),one={oldPath:null,newPath:'src\\app.js',status:'added'},two={...one,newPath:'src/app.js'};
  assert.notEqual(reader.withEntryIdentity(one).changeId,reader.withEntryIdentity(two).changeId);
  assert.equal(Object.hasOwn(reader,'parseRawDiff'),false);assert.equal(Object.hasOwn(reader,'normalizeRepositoryPath'),false);
});
test('real native working/index/untracked and materialized-tree captures keep the shared codec and original byte identities',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'sflow-change-codec-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0'}}).trim();
  git('init','-q','-b','main');git('config','user.name','Example fixture');git('config','user.email','fixture@example.test');git('config','core.ignorecase','false');
  await writeFile(path.join(root,'original.txt'),Array.from({length:40},(_,i)=>'original row '+i).join('\n'));
  await writeFile(path.join(root,'app.js'),'baseline');await writeFile(path.join(root,'deleted.txt'),'remove me');await writeFile(path.join(root,'mode.sh'),'echo fixture\n');
  git('add','-A');git('commit','-qm','baseline');const base=git('rev-parse','HEAD');
  git('mv','original.txt','renamed.txt');git('commit','-qm','committed rename');
  await writeFile(path.join(root,'app.js'),'staged');git('add','app.js');await writeFile(path.join(root,'app.js'),'current working bytes');
  await rm(path.join(root,'deleted.txt'));await writeFile(path.join(root,'untracked.js'),'real untracked bytes');await chmod(path.join(root,'mode.sh'),0o755);
  const reader=codec(),changeSet=await native.buildRepositoryChangeSet(root,{baseCommit:base,subject:{workId:'codec-fixture'}});
  assert.equal(changeSet.target.includesIndex,true);assert.equal(changeSet.target.includesWorktree,true);assert.equal(changeSet.target.includesUntracked,true);
  assert.equal(reader.verifyRepositoryChangeSetIntegrity(changeSet).valid,true);assert.equal(reader.repositoryChangeSetDigest(changeSet),changeSet.digest);
  assert.ok(changeSet.entries.some(row=>row.status==='renamed'&&row.oldPath==='original.txt'&&row.newPath==='renamed.txt'));
  assert.ok(changeSet.entries.some(row=>row.untracked&&row.newPath==='untracked.js'));assert.ok(changeSet.entries.some(row=>row.status==='deleted'&&row.oldPath==='deleted.txt'));
  assert.equal(changeSet.entries.find(row=>row.newPath==='app.js').newContent.sha256,'sha256:'+hash('current working bytes'));
  for(const row of changeSet.entries)assert.deepEqual(reader.withEntryIdentity(row),row);
  assert.deepEqual([...changeSet.entries].sort(reader.entryOrder),changeSet.entries);
  const tree=git('write-tree'),materialized=native.buildRepositoryTreeChangeSet(root,{baseTree:base,targetTree:tree});
  assert.equal(reader.verifyRepositoryChangeSetIntegrity(materialized).valid,true);assert.equal(reader.repositoryChangeSetDigest(materialized),materialized.digest);
});

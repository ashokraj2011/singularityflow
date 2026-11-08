import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink,rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFilesystemSourceUnit } from '../src/sgos/filesystem-source-unit.mjs';
import { canonicalJson } from '../src/foundation/record-schema.mjs';
import { sourceSnapshot,sourceUnitDescriptor } from '../src/foundation/source-snapshot.mjs';

async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-source-unit-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const root=path.join(directory,'checkout');await mkdir(path.join(root,'src'),{recursive:true});
  await writeFile(path.join(root,'src/main.js'),'export const answer = 42;\n');
  const options={root,id:'app-checkout',projectId:'project',repositoryId:'app'};
  return {directory,root,options,make:extra=>createFilesystemSourceUnit({...options,...extra})};
}

test('filesystem source capture retains real file hashes without content, root paths or Git',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.root,'.git'));await writeFile(path.join(f.root,'.git/config'),'private transport settings');
  await writeFile(path.join(f.root,'.gitignore'),'node_modules/\n');
  await mkdir(path.join(f.root,'node_modules'));await writeFile(path.join(f.root,'node_modules/library.js'),'dependency');
  await writeFile(path.join(f.root,'src/bytes.bin'),Buffer.from([0,255,17]));
  const unit=await f.make({excludePaths:['node_modules']}),first=await unit.capture(),second=await unit.capture();
  assert.deepEqual(first,second);assert.deepEqual(first.snapshot.entries.map(entry=>entry.path),['.gitignore','src/bytes.bin','src/main.js']);
  assert.equal(first.revision,'sha256:'+createHash('sha256').update(canonicalJson(first.snapshot)).digest('hex'));
  const source=await readFile(path.join(f.root,'src/main.js'));
  assert.equal(first.snapshot.entries.find(entry=>entry.path==='src/main.js').sha256,createHash('sha256').update(source).digest('hex'));
  assert.equal(JSON.stringify(first).includes(f.root),false);assert.equal(JSON.stringify(first).includes(source.toString()),false);
  assert.equal(JSON.stringify(unit.descriptor).includes(f.root),false);
  assert.ok(Object.isFrozen(unit.descriptor.selection.excludePaths));assert.ok(Object.isFrozen(unit.descriptor.limits));
  assert.throws(()=>{unit.descriptor.selection.excludePaths.push('src');},TypeError);
});
test('source identity follows bytes and paths instead of inode, time or the physical clone folder',async t=>{
  const f=await fixture(t),other=path.join(f.directory,'another-laptop');await mkdir(path.join(other,'src'),{recursive:true});
  await writeFile(path.join(other,'src/main.js'),await readFile(path.join(f.root,'src/main.js')));
  const unit=await f.make(),same=await f.make({root:other}),original=await unit.capture();
  assert.equal((await same.capture()).revision,original.revision);
  await writeFile(path.join(f.root,'src/main.js'),'export const answer = 43;\n');assert.notEqual((await unit.capture()).revision,original.revision);
});
test('source capture refuses link traversal and preserves missing-root errors',async t=>{
  const f=await fixture(t),outside=path.join(f.directory,'outside');await mkdir(outside);await writeFile(path.join(outside,'private.txt'),'outside');
  await symlink(outside,path.join(f.root,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects((await f.make()).capture(),{code:'SGOS_SOURCE_LINK_DENIED'});
  await assert.rejects(f.make({root:path.join(f.directory,'missing')}),{code:'ENOENT'});
});
test('file, traversal, total-byte and manifest limits are enforced rather than truncating observations',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'second.txt'),'other');
  for(const limits of [{maximumFiles:1},{maximumVisitedEntries:1},{maximumFileBytes:1},{maximumTotalBytes:1},{maximumManifestBytes:1}]) {
    await assert.rejects((await f.make({limits})).capture(),{code:'SGOS_SOURCE_LIMIT'});
  }
});
test('replacing a source root and cancelling a capture cannot produce a clean baseline',async t=>{
  const f=await fixture(t),unit=await f.make(),controller=new AbortController();controller.abort();
  await assert.rejects(unit.capture({signal:controller.signal}),{code:'SGOS_SOURCE_CANCELLED'});
  await rename(f.root,path.join(f.directory,'old-checkout'));await mkdir(f.root);
  await assert.rejects(unit.capture(),{code:'SGOS_SOURCE_CHANGED'});
});
test('a bounded capture reports an actual deadline with its last stage rather than claiming a DNS failure',async t=>{
  const f=await fixture(t);await Promise.all(Array.from({length:256},(_,index)=>writeFile(path.join(f.root,'file-'+index),'source')));
  await assert.rejects((async()=>{const unit=await f.make({limits:{maximumDurationMs:1}});return unit.capture();})(),
    failure=>failure.code==='SGOS_SOURCE_TIMEOUT'&&failure.timedOut===true&&failure.timeoutMs===1&&typeof failure.details.stage==='string');
});
test('source contracts reject invented bindings, traversal, duplicate entries and future wire versions',async t=>{
  const f=await fixture(t),unit=await f.make(),captured=await unit.capture();
  assert.deepEqual(sourceUnitDescriptor(unit.descriptor),unit.descriptor);
  for(const mutate of [value=>{value.projectId='other';},value=>{value.entries[0].path='../outside';},value=>{value.entries.push(value.entries[0]);},value=>{value.entries[0].sha256='claimed';}]) {
    const value=structuredClone(captured.snapshot);mutate(value);assert.throws(()=>sourceSnapshot(value,unit.descriptor),{code:'SGOS_SOURCE_CONTRACT_INVALID'});
  }
  assert.throws(()=>sourceSnapshot({...captured.snapshot,schemaVersion:99},unit.descriptor),error=>error.code==='SGOS_SOURCE_UNSUPPORTED'&&error.cause?.code==='SCHEMA_VERSION_FUTURE');
  const objectHash=structuredClone(captured.snapshot);objectHash.entries[0].sha256={toString(){throw Error('must not coerce source facts');}};
  assert.throws(()=>sourceSnapshot(objectHash,unit.descriptor),{code:'SGOS_SOURCE_CONTRACT_INVALID'});
  const accessor=structuredClone(captured.snapshot);Object.defineProperty(accessor.entries[0],'sha256',{enumerable:true,get(){throw Error('must not execute source facts');}});
  assert.throws(()=>sourceSnapshot(accessor,unit.descriptor),{code:'SGOS_SOURCE_CONTRACT_INVALID'});
});

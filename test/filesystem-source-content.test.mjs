import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,rename} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createFilesystemSourceUnit,createFilesystemSourceContentReader} from '../src/sgos/filesystem-source-unit.mjs';
import {sourceContentReaderDescriptor,sourceContentReadResult} from '../src/foundation/source-snapshot.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-source-content-')),root=path.join(directory,'source');await mkdir(root);
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const bytes=Buffer.from('Observed binary: \u0000\u00ff\ud83e\uddea\n');await writeFile(path.join(root,'app.bin'),bytes);await writeFile(path.join(root,'empty.bin'),'');
  const unit=await createFilesystemSourceUnit({root,id:'app-source',projectId:'example',repositoryId:'app'}),snapshot=(await unit.capture()).snapshot;
  const reader=await createFilesystemSourceContentReader({root,id:'app-content',source:unit.descriptor,maximumChunkBytes:7});
  return {directory,root,bytes,unit,snapshot,reader,entry:snapshot.entries.find(item=>item.path==='app.bin')};
}
test('optional bounded content reads preserve actual binary bytes without changing Source Unit v1',async t=>{
  const f=await fixture(t),chunks=[];assert.deepEqual(Object.keys(f.unit).sort(),['capture','descriptor']);
  for(let offset=0;offset<f.bytes.byteLength;){const found=await f.reader.read({entry:f.entry,offset,maximumBytes:7});chunks.push(Buffer.from(found.data));offset+=found.data.byteLength;}
  assert.deepEqual(Buffer.concat(chunks),f.bytes);assert.equal(digest(Buffer.concat(chunks)),f.entry.sha256);
  const empty=f.snapshot.entries.find(item=>item.path==='empty.bin');assert.equal((await f.reader.read({entry:empty,offset:0,maximumBytes:1})).data.byteLength,0);
  assert.equal(JSON.stringify(f.reader.descriptor).includes(f.root),false);assert.ok(Object.isFrozen(f.reader.descriptor));
  assert.ok(Object.isFrozen(f.reader.descriptor.source.selection.excludePaths));
});
test('read descriptors capture their source selection and reject arbitrary ranges and private aliases',async t=>{
  const f=await fixture(t),source=structuredClone(f.unit.descriptor);
  const reader=await createFilesystemSourceContentReader({root:f.root,id:'captured',source,maximumChunkBytes:7});source.id='changed';source.limits.maximumDurationMs=1;
  assert.equal((await reader.read({entry:f.entry,offset:0,maximumBytes:1})).data[0],f.bytes[0]);
  for(const request of [{entry:f.entry,offset:-1,maximumBytes:1},{entry:f.entry,offset:0,maximumBytes:8},
    {entry:f.entry,offset:f.entry.bytes+1,maximumBytes:1},{entry:{...f.entry,path:'../outside'},offset:0,maximumBytes:1},
    {entry:{...f.entry,path:'.GIT/config'},offset:0,maximumBytes:1},{entry:{...f.entry,path:'a\\b'},offset:0,maximumBytes:1}]){
    await assert.rejects(reader.read(request),{code:'SGOS_SOURCE_CONTRACT_INVALID'});
  }
  assert.throws(()=>sourceContentReaderDescriptor({...reader.descriptor,maximumChunkBytes:8388609}),{code:'SGOS_SOURCE_CONTRACT_INVALID'});
  const request={entry:f.entry,offset:0,maximumBytes:2};
  assert.throws(()=>sourceContentReadResult({entry:f.entry,offset:0,data:new Uint8Array(1)},request,reader.descriptor),{code:'SGOS_SOURCE_CONTRACT_INVALID'});
});
test('missing files, replaced roots and link traversal remain real read failures',async t=>{
  const f=await fixture(t);await rm(path.join(f.root,'app.bin'));await assert.rejects(f.reader.read({entry:f.entry,offset:0,maximumBytes:1}),{code:'ENOENT'});
  await writeFile(path.join(f.root,'app.bin'),f.bytes);const outside=path.join(f.directory,'outside');await mkdir(outside);await writeFile(path.join(outside,'item'),f.bytes);
  await symlink(outside,path.join(f.root,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.reader.read({entry:{...f.entry,path:'linked/item'},offset:0,maximumBytes:1}),{code:'SGOS_SOURCE_LINK_DENIED'});
  await rename(f.root,path.join(f.directory,'previous'));await mkdir(f.root);
  await assert.rejects(f.reader.read({entry:f.entry,offset:0,maximumBytes:1}),{code:'SGOS_SOURCE_CHANGED'});
});
test('content reads enforce source size/mode, cancellation and explicit I/O deadlines',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'app.bin'),'changed length');
  await assert.rejects(f.reader.read({entry:f.entry,offset:0,maximumBytes:1}),{code:'SGOS_SOURCE_CHANGED'});
  const controller=new AbortController();controller.abort();await assert.rejects(f.reader.read({entry:f.entry,offset:0,maximumBytes:1},{signal:controller.signal}),{code:'SGOS_SOURCE_CANCELLED'});
  const components=Array(48).fill('d'),relative=components.join('/')+'/item';await mkdir(path.join(f.root,...components),{recursive:true});await writeFile(path.join(f.root,...components,'item'),'x');
  const source=structuredClone(f.unit.descriptor);source.limits.maximumDurationMs=1;
  await assert.rejects((async()=>{const reader=await createFilesystemSourceContentReader({root:f.root,id:'deadline',source});
    return reader.read({entry:{path:relative,sha256:digest('x'),bytes:1,executable:false},offset:0,maximumBytes:1});})(),
    failure=>failure.code==='SGOS_SOURCE_TIMEOUT'&&failure.timedOut===true&&failure.details.timeoutMs===1&&typeof failure.details.stage==='string');
});

import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createFilesystemSourceUnit,createFilesystemSourceContentReader} from '../src/sgos/filesystem-source-unit.mjs';
import {createSourceTestImpactUnit} from '../src/sgos/source-test-impact.mjs';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'sflow-impact-port-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'value.js'),'export const value=1;\n');
  const unit=await createFilesystemSourceUnit({root,id:'impact-source',projectId:'project',repositoryId:'app'}),content=await createFilesystemSourceContentReader({root,id:'impact-content',source:unit.descriptor}),
    current=await unit.capture(),input={sources:[{repositoryId:'app',revision:current.revision}]},descriptor={id:'host-ast',version:'1',implementationSha256:'sha256:'+'a'.repeat(64)};
  return {root,unit,content,input,descriptor};}
test('impact receives exact source bytes and preserves actual content-reader errors',async t=>{
  const f=await fixture(t);let calls=0;const analyzer={descriptor:f.descriptor,analyze({files}){calls++;assert.equal(Buffer.from(files[0].bytes).toString(),'export const value=1;\n');
    return {nodes:files.map(({repositoryId,path,sha256})=>({repositoryId,path,sha256,dependencies:[]})),unknown:[]};}},
    unit=createSourceTestImpactUnit({sources:[f],analyzer});assert.equal((await unit.observe(f.input)).nodes.length,1);assert.equal(calls,1);
  for(const code of ['ENOENT','EACCES','ETIMEDOUT']){const failure=Object.assign(Error('Actual input read failure.'),{code,path:'value.js',timeoutMs:300000}),broken=createSourceTestImpactUnit({sources:[{unit:f.unit,content:{...f.content,read(){throw failure;}}}],analyzer});
    await assert.rejects(broken.observe(f.input),error=>error===failure);}assert.equal(calls,1);
});
test('cancellation and real analyzer deadlines cannot become successful graph evidence',async t=>{
  const f=await fixture(t),stop=new AbortController(),reason=Object.freeze(Error('Cancelled before AST execution'));let calls=0;
  const unit=createSourceTestImpactUnit({sources:[f],maximumDurationMs:100,analyzer:{descriptor:f.descriptor,analyze(){calls++;return new Promise(()=>{});}}});
  stop.abort(reason);await assert.rejects(unit.observe(f.input,{signal:stop.signal}),error=>error===reason);assert.equal(calls,0);
  await assert.rejects(unit.observe(f.input),error=>error.code==='SGOS_IMPACT_TIMEOUT'&&error.details.timeoutMs===100);assert.equal(calls,1);
});
test('a source change during analysis invalidates the observation',async t=>{
  const f=await fixture(t),unit=createSourceTestImpactUnit({sources:[f],analyzer:{descriptor:f.descriptor,async analyze({files}){
    await writeFile(path.join(f.root,'value.js'),'export const value=2;\n');return {nodes:files.map(({repositoryId,path,sha256})=>({repositoryId,path,sha256,dependencies:[]})),unknown:[]};}}});
  await assert.rejects(unit.observe(f.input),{code:'TEST_IMPACT_SOURCE_CHANGED'});
});
test('the impact port cannot substitute duplicate repositories for another selected source',async t=>{
  const a=await fixture(t),b=await fixture(t),unit=await createFilesystemSourceUnit({root:b.root,id:'second-source',projectId:'project',repositoryId:'service'}),
    content=await createFilesystemSourceContentReader({root:b.root,id:'second-content',source:unit.descriptor});let analyzed=false;
  const impact=createSourceTestImpactUnit({sources:[a,{unit,content}],analyzer:{descriptor:a.descriptor,analyze(){analyzed=true;return {nodes:[],unknown:[]};}}});
  await assert.rejects(impact.observe({sources:[...a.input.sources,...a.input.sources]}),{code:'SGOS_IMPACT_INPUT_INVALID'});assert.equal(analyzed,false);
});

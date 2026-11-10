import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
import {sourceTextHunks,SOURCE_TEXT_DIFF_PROFILE,SOURCE_TEXT_DIFF_LIMITS} from '../src/kernel/source-text-diff.mjs';
import {gitPatchCoordinates} from '../src/git-status-detail.mjs';
const lines=text=>text.match(/[^\n]*\n|[^\n]+$/gu)??[];
function reconstruct(before,after,hunks){const a=lines(before),b=lines(after),output=[];let left=0,right=0;
  for(const h of hunks){const old=h.beforeStart-(h.beforeLines?1:0),next=h.afterStart-(h.afterLines?1:0);
    assert.ok(old>=left&&next>=right);assert.ok(old+h.beforeLines<=a.length&&next+h.afterLines<=b.length);assert.ok(h.beforeLines+h.afterLines>0);
    assert.deepEqual(a.slice(left,old),b.slice(right,next),'every line outside the claimed changes must be byte-identical');
    output.push(...a.slice(left,old),...b.slice(next,next+h.afterLines));left=old+h.beforeLines;right=next+h.afterLines;}
  assert.deepEqual(a.slice(left),b.slice(right));output.push(...a.slice(left));return output.join('');
}
function distance(a,b){let previous=Array.from({length:b.length+1},(_,index)=>index);for(let row=1;row<=a.length;row++){
  const next=[row];for(let column=1;column<=b.length;column++)next[column]=a[row-1]===b[column-1]?previous[column-1]:Math.min(previous[column]+1,next[column-1]+1);previous=next;}return previous.at(-1);}
test('exact line positions reconstruct additions, removals, replacements, line endings and Unicode',()=>{
  for(const [before,after]of [['',''],['','first\n'],['first\n',''],['a\nb\nc\n','a\nchanged\nc\n'],['a\n','a'],
    ['a\r\nb\r\n','a\nb\n'],['one\ntwo\n','before\none\ntwo\nafter\n'],['λ\n🚀\n','λ\n世界\n'],['a\na\na\n','a\nb\na\na\n']]){
    const result=sourceTextHunks(before,after);assert.equal(result.profile,SOURCE_TEXT_DIFF_PROFILE);assert.equal(reconstruct(before,after,result.hunks),after);
    assert.equal(result.hunks.reduce((sum,h)=>sum+h.beforeLines+h.afterLines,0),distance(lines(before),lines(after)));
    assert.deepEqual(sourceTextHunks(before,after),result);}
});
test('800 repeated-line cases have minimum edit size under an independent dynamic-programming oracle',()=>{
  let seed=37;const random=maximum=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%maximum;},values=['a\n','b\n','c\n','\n','λ\n'];
  for(let i=0;i<800;i++){const before=Array.from({length:random(14)},()=>values[random(values.length)]).join(''),after=Array.from({length:random(14)},()=>values[random(values.length)]).join(''),
    result=sourceTextHunks(before,after);assert.equal(reconstruct(before,after,result.hunks),after,'case '+i);
    assert.equal(result.hunks.reduce((sum,h)=>sum+h.beforeLines+h.afterLines,0),distance(lines(before),lines(after)),'case '+i);}
});
test('unambiguous retained line positions match actual zero-context Git patches',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'sflow-source-hunks-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [before,after]of [['one\ntwo\nthree\n','one\nchanged\nthree\n'],['one\n','before\none\n'],['one\ntwo\n','one\n'],['one\n','one'],['a\r\nb\r\n','a\r\nother\r\n']]){
    await writeFile(path.join(root,'before.txt'),before);await writeFile(path.join(root,'after.txt'),after);
    const result=spawnSync('git',['diff','--no-index','--no-ext-diff','--no-textconv','--no-color','--unified=0','--','before.txt','after.txt'],{cwd:root,env:process.env,encoding:'utf8',timeout:15000});
    assert.ok([0,1].includes(result.status),result.stderr);const files=gitPatchCoordinates(result.stdout);
    assert.deepEqual(sourceTextHunks(before,after).hunks,files[0]?.hunks??[]);}
});
test('comparison quotas are explicit and never replace an unresolved diff with the whole file',()=>{
  assert.throws(()=>sourceTextHunks('a\nb\nc\n','x\ny\nz\n',{maximumWork:1}),{code:'ENGINE_SOURCE_DIFF_LIMIT'});
  assert.throws(()=>sourceTextHunks('a\nb\nc\n','x\ny\nz\n',{maximumTraceCells:1}),{code:'ENGINE_SOURCE_DIFF_LIMIT'});
  assert.throws(()=>sourceTextHunks('long','other',{maximumTextUnits:2}),{code:'ENGINE_SOURCE_DIFF_LIMIT'});
  for(const options of [{ready:true},{maximumWork:SOURCE_TEXT_DIFF_LIMITS.maximumWork+1},{maximumTraceCells:0}])assert.throws(()=>sourceTextHunks('a','b',options),{code:'ENGINE_SOURCE_DIFF_INPUT_INVALID'});
  assert.throws(()=>sourceTextHunks('a\0','b'),{code:'ENGINE_SOURCE_DIFF_INPUT_INVALID'});
  const unchanged='\n'.repeat(SOURCE_TEXT_DIFF_LIMITS.maximumTextUnits);assert.deepEqual(sourceTextHunks(unchanged,unchanged).hunks,[]);
});

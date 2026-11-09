/** Actual Git hunks and file bytes for the independent implementation-binding compatibility oracle. */
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {buildRepositoryChangeSet} from '../../src/repository-change-set.mjs';
import {buildComprehensionDiffPreview} from '../../src/comprehension/diff-preview.mjs';
const clause='BIND:REQ-001',source='// @clause:'+clause+' Returns the exact approved result.\nexport function result(){return 42;}\n';
const obligation=(paths=['src/app.js'],clauseId=clause)=>({clauseId,expectedPaths:paths});
const tag=(sourcePath='src/app.js',line=1,clauseId=clause)=>({clauseId,sourcePath,line,tag:'clause'});
export function implementationBindingCases(){
  const rows=[],add=(id,extra={})=>rows.push({id,baseline:{'src/app.js':'export function result(){return 1;}\n'},
    changes:{'src/app.js':source},required:[obligation()],tags:[tag()],...extra});
  add('modified');add('added',{baseline:{},stage:false});add('staged-added',{baseline:{},stage:true});
  add('deleted',{changes:{'src/app.js':null},tags:[]});
  add('renamed',{changes:{'src/app.js':null,'src/renamed.js':source},required:[obligation(['src/renamed.js'])],tags:[tag('src/renamed.js')],stage:true});
  add('empty',{baseline:{},changes:{'src/app.js':''},tags:[]});add('no-explanation',{changes:{'src/app.js':'// @clause:'+clause+'\nexport const result=42;\n'}});
  add('short-explanation',{changes:{'src/app.js':'// @clause:'+clause+' too short\nexport const result=42;\n'}});
  add('long-explanation',{changes:{'src/app.js':'// @clause:'+clause+' '+('A meaningful result. '.repeat(30))+'\nexport const result=42;\n'}});
  add('crlf',{changes:{'src/app.js':source.replaceAll('\n','\r\n')}});
  add('jsx',{baseline:{},changes:{'src/App.jsx':'export const View=()=> <div>{/* @clause:'+clause+' Displays the approved result */}<p>42</p></div>;\n'},required:[obligation(['src/App.jsx'])],tags:[tag('src/App.jsx')]});
  add('declaration-file',{baseline:{},changes:{'src/app.d.ts':'// @clause:'+clause+' Describes the approved result.\nexport declare function result():number;\n'},required:[obligation(['src/app.d.ts'])],tags:[tag('src/app.d.ts')]});
  add('missing-file',{changes:{},required:[obligation(['src/missing.js'])],tags:[tag('src/missing.js')]});
  add('tag-in-another-file',{changes:{'src/app.js':'export const result=42;\n','src/explanation.js':source},tags:[tag('src/explanation.js')]});
  add('first-adequate-explanation',{changes:{'src/app.js':'// @clause:'+clause+' x\n'+source},tags:[tag('src/app.js',1),tag('src/app.js',2)]});
  add('duplicate-paths',{required:[obligation(['src/app.js','src/app.js'])]});
  add('sorted-obligations',{required:[obligation(['src/app.js'],'BIND:REQ-002'),obligation()],tags:[tag()]});
  add('two-hunks',{baseline:{'src/app.js':Array.from({length:24},(_,index)=>'export const value'+index+' = '+index+';').join('\n')+'\n'},
    changes:{'src/app.js':Array.from({length:24},(_,index)=>index===1?'// @clause:'+clause+' Returns the approved result.':index===20?'export const value20 = 42;':'export const value'+index+' = '+index+';').join('\n')+'\n'},tags:[tag('src/app.js',2)]});
  add('binary',{changes:{'src/app.js':{bytes:[0,255,1]}}});
  add('invalid-utf8',{changes:{'src/app.js':{bytes:[255,254,65,10]}}});
  add('oversized',{changes:{'src/app.js':{repeat:'a',count:2*1024*1024+1}}});
  add('no-obligations',{required:[],tags:[]});
  for(const [name,extension,code]of [
    ['python','py','def result():\n    return 42\n'],['java','java','public class Value {\n  public int result(){return 42;}\n}\n'],
    ['rust','rs','pub fn result() -> i32 {42}\n'],['go','go','func Result() int {return 42}\n'],['unsupported','c','int result(void) {return 42;}\n']]){
    const file='src/value.'+extension,comment=extension==='py'?'# ':'// ';
    add(name,{baseline:{},changes:{[file]:comment+'@clause:'+clause+' Returns the approved result.\n'+code},required:[obligation([file])],tags:[tag(file)]});
  }
  return rows;
}
export async function implementationBindingFixture(row){
  const root=await mkdtemp(path.join(os.tmpdir(),'sflow-implementation-binding-')),close=()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  try{
    const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:15000,env:{...process.env,GIT_TERMINAL_PROMPT:'0',
      GIT_AUTHOR_DATE:'2026-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-01-01T00:00:00Z'}}).trim();
    const write=async(file,value)=>{const target=path.join(root,file);await mkdir(path.dirname(target),{recursive:true});
      if(value===null)await rm(target,{force:true});else await writeFile(target,typeof value==='string'?value:value.bytes?Buffer.from(value.bytes):value.repeat.repeat(value.count));};
    await write('README.md','Isolated binding fixture.\n');for(const [file,value]of Object.entries(row.baseline))await write(file,value);
    git('init','-q','-b','main');git('config','user.name','Example fixture');git('config','user.email','fixture@example.test');git('config','commit.gpgsign','false');
    git('add','.');git('commit','-qm','baseline');
    for(const [file,value]of Object.entries(row.changes))await write(file,value);if(row.stage)git('add','.');
    const changeSet=await buildRepositoryChangeSet(root,{baseCommit:'HEAD'}),input={changeSet,required:row.required,tags:row.tags};
    const entries=new Map(changeSet.entries.flatMap(entry=>[entry.newPath,entry.oldPath].filter(Boolean).map(file=>[file,entry]))),
      planned=[...new Set(row.required.flatMap(value=>value.expectedPaths))].filter(file=>entries.has(file)),edited=planned.filter(file=>!entries.get(file).untracked&&entries.get(file).status!=='added');
    const preview=edited.length?buildComprehensionDiffPreview(root,changeSet,{contextLines:0,paths:edited}):{files:[]},sources={};
    for(const file of new Set([...planned,...row.tags.map(value=>value.sourcePath)])){
      const bytes=await readFile(path.join(root,file)).catch(()=>null);sources[file]=bytes&&bytes.length<=2*1024*1024&&!bytes.includes(0)?bytes.toString('utf8'):null;
    }
    return {root,input,preview,sources,close};
  }catch(error){await close();throw error;}
}

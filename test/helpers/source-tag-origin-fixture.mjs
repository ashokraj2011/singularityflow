/** Genuine Git line/origin cases, including moved tags, duplicates and earlier work intervals. */
import {readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {codeDeliveryPreflightFixture} from './code-delivery-preflight-fixture.mjs';
import {buildRepositoryChangeSet} from '../../src/repository-change-set.mjs';
import {scanSourceClauseTags} from '../../src/source-clause-tags.mjs';
import {applicationPathContext} from '../../src/engine-compatibility/node-source-policy.mjs';
const tag=(kind='clause')=>'// @'+kind+':SHARED:'+(kind==='ac'?'AC':'REQ')+'-001 Preserves the approved observable result.\n';
const code='export const answer=42;\n',before='export const answer=1;\n';
export function sourceTagOriginCases() {
  const rows=[];
  for(const kind of ['clause','ac']) {
    const file=kind==='clause'?'src/app.js':'test/app.test.js',next=kind==='clause'?'src/next.js':'test/next.test.js',line=tag(kind),prefix=kind+':';
    const add=(id,baseline,changes,options={})=>rows.push({id:prefix+id,kind,baseline,changes,paths:[file,next],...options});
    add('new-tracked',{[file]:before},{[file]:line+code});
    add('unchanged-tag',{[file]:line+before},{[file]:line+code});
    add('moved-within-file',{[file]:line+before+'// separator\n'},{[file]:before+'// separator\n'+line});
    add('moved-to-untracked-file',{[file]:line+before},{[file]:before,[next]:line+code});
    add('duplicate-added',{[file]:line+before},{[file]:line+line+code});
    add('old-line-remains-unowned',{[file]:line+before},{[file]:line+code,[next]:line+code});
    add('whitespace-move',{[file]:'  '+line+before},{[file]:before+'\t'+line});
    add('reworded-tag',{[file]:line+before},{[file]:line.replace('observable','documented')+code});
    add('staged-new-file',{[file]:before},{[next]:line+code},{stage:[next]});
    add('renamed-carried',{[file]:line+Array.from({length:40},(_,i)=>'// preserved '+i+'\n').join('')},{},
      {rename:{from:file,to:next}});
    add('first-interval-before-later-baseline',{[file]:before},{[file]:line+code},{laterBaseline:{[file]:line+code.replace('42','43')}});
    add('no-work-interval',{[file]:before},{[file]:line+code},{noInterval:true});
    add('no-generation-change-set',{[file]:line+before},{[file]:line+code},{noChangeSet:true});
    add('missing-untracked-file',{[file]:before},{[next]:line+code},{removeAfterScan:next});
  }
  for(const file of ['src/name with space.js','src/a"quoted.js','src/é change.js','docs/usage.md','config/runner.js','singularity/work-items/PREFLIGHT/inputs/local.js']) {
    rows.push({id:'path:'+file,kind:'clause',baseline:{[file]:before},changes:{[file]:tag()+code},paths:[file]});
  }
  return rows;
}
export async function sourceTagOriginFixture(row) {
  const expected=row.kind==='clause'?row.paths:['src/app.js'],f=await codeDeliveryPreflightFixture({baseline:row.baseline,changes:row.changes,
    claims:{'SHARED:REQ-001':{expectedPaths:expected,tests:['test/actual.test.js'],testDisposition:'applicable',deviation:null}}});
  try {
    f.workflow.resolution.spec.namespace='SHARED';
    if(row.rename)f.git('mv',row.rename.from,row.rename.to);
    if(row.stage)f.git('add','--',...row.stage);
    if(row.laterBaseline) {
      const original=f.workflow.workIntervals.current.sourceBaseCommit;
      f.git('add','--',...Object.keys(row.changes));f.git('commit','-qm','first delivery before a later generation');
      f.workflow.workIntervals.history=[{sourceBaseCommit:original}];f.workflow.workIntervals.current.sourceBaseCommit=f.git('rev-parse','HEAD');
      for(const [file,text]of Object.entries(row.laterBaseline))await f.write(file,text);
    }
    if(row.noInterval)delete f.workflow.workIntervals;
    const occurrences=[];
    for(const relative of row.paths) {
      let text;try{text=await readFile(path.join(f.root,relative),'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
      occurrences.push(...scanSourceClauseTags(text,{sourcePath:relative}).filter(value=>value.tag===row.kind).map(value=>({...value,path:relative})));
    }
    const changeSet=row.noChangeSet?null:await buildRepositoryChangeSet(f.root,{baseCommit:'HEAD'});
    if(row.removeAfterScan)await rm(path.join(f.root,row.removeAfterScan));
    return {...f,occurrences,changeSet,pathContext:applicationPathContext(f.config,f.workflow),kind:row.kind};
  }catch(error){await f.close();throw error;}
}

/** Actual open native generation and pinned plan for preflight compatibility captures. */
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {canonicalJson} from '../../src/foundation/record-schema.mjs';
import {ensureWorkIntervalBaseline} from '../../src/work-intervals.mjs';
import {beginCodeGeneration} from '../../src/generation-boundary.mjs';

const workId='PREFLIGHT',hash=text=>createHash('sha256').update(text).digest('hex');
export const preflightSource='// @clause:PREFLIGHT:REQ-001 returns the approved conversion result\nexport const convert = value => value.toString(16);\n';
export const preflightTests="// @ac:PREFLIGHT:AC-001\ntest('conversion', () => {});\n";
const planned=(path='src/app.js',extra={})=>({expectedPaths:[path],tests:['test/app.test.js'],testDisposition:'applicable',deviation:null,...extra});
export async function codeDeliveryPreflightFixture(options={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'sflow-code-preflight-')),close=()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  try{
    const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:15000,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_DATE:'2026-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-01-01T00:00:00Z'}}).trim();
    const write=async(file,contents)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),contents);};
    const phaseId=options.phaseId??'implementation',relative='singularity/work-items/PREFLIGHT/context/claims/planning-gen1-planned.json';
    const claims=options.claims??{'PREFLIGHT:REQ-001':planned()};
    const planning={id:'planning',generation:1,claimMaps:{planned:{path:relative,generation:1}}};
    const phase={id:phaseId,generation:0,status:'in_progress',writeScope:options.writeScope??'source-and-artifact',sourceBoundary:options.sourceBoundary??'unrestricted',
      generationPolicy:{task:options.task??'code'},requiredArtifact:{kind:'implementation-summary'},qualityCommands:[]};
    const workflow={workItem:{id:workId,workType:'feature',branch:workId},phaseOrder:['planning',phaseId],currentPhase:phaseId,
      phases:{planning,[phaseId]:phase},lineage:{canonicalBranch:workId,requiredChecks:[]},history:[],resolution:{
        configSha256:'c'.repeat(64),sourceSha256:'s'.repeat(64),templates:{},capability:{policy:{protectedPaths:[]}},
        codeDelivery:{traceability:{sourceBindings:options.sourceBindings??'enforce'},changeSet:{symlinks:options.symlinks??'reject'}},
        plannedClaims:{mode:options.plannedMode??'required',owners:{[phaseId]:'planning'}},spec:{mode:'enforce',coverage:'enforce',acceptance:'presence'}}};
    const config={workItemRoot:'singularity/work-items',workTypes:{feature:{}},governance:{requireAcceptanceCriteriaTags:false,protectedPaths:options.protectedPaths??[]}};
    const plan=canonicalJson({schemaVersion:2,kind:'planned',workId,phase:'planning',generation:1,recordedAt:'2026-01-01T00:00:00.000Z',claims});
    await write(relative,plan);planning.claimMaps.planned.sha256=hash(plan);
    await write('singularity/work-items/PREFLIGHT/context/spec-indexes/planning-gen1.json',canonicalJson({schemaVersion:1,kind:'specification-index',workId,phase:'planning',generation:1,
      clauses:[...new Set([...Object.keys(claims),'PREFLIGHT:AC-001'])].map(id=>({id,type:id.split(':')[1].split('-')[0],body:id+' is approved.',bodySha256:hash(id+' is approved.'),source:{path:'plan.md',line:1}}))}));
    await write('src/app.js','export const convert = value => value;\n');
    for(const [file,contents]of Object.entries(options.baseline??{}))await write(file,contents);
    git('init','-q','-b','main');git('config','user.name','Example fixture');git('config','user.email','fixture@example.test');git('config','commit.gpgsign','false');
    git('add','.');git('commit','-qm','approved plan and source baseline');git('switch','-qc',workId);
    if(phase.writeScope==='source-and-artifact'&&phase.generationPolicy.task==='code'){
      await ensureWorkIntervalBaseline(root,config,workflow,{phaseId,itemDirectory:path.join(root,'singularity/work-items/PREFLIGHT'),itemRelative:'singularity/work-items/PREFLIGHT'});
      await beginCodeGeneration(root,config,workflow,phase,{agent:'developer'});
    }
    const changes=options.changes??{'src/app.js':preflightSource,'test/app.test.js':preflightTests};
    for(const [file,contents]of Object.entries(changes)){
      if(contents===null)await rm(path.join(root,file),{force:true});
      else if(contents&&typeof contents==='object'&&contents.symlink){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await symlink(contents.symlink,path.join(root,file));}
      else await write(file,contents);
    }
    return {root,config,workflow,phase,git,write,close};
  }catch(error){await close();throw error;}
}

export function codeDeliveryPreflightCases(){
  const rows=[],add=(id,options={},mode={})=>rows.push({id,options,mode});
  add('ready');add('custom-phase',{phaseId:'custom-code'});add('explicit-non-code',{task:'analyze'});add('invalid-write-scope',{writeScope:'artifact-only'});
  add('unplanned-mode',{plannedMode:'disabled',sourceBindings:'off'});add('no-changes',{changes:{}});add('test-only',{changes:{'test/app.test.js':preflightTests}});
  add('source-only',{changes:{'src/app.js':preflightSource}});add('no-source-tag',{changes:{'src/app.js':'export const convert = value => value.toString(16);\n','test/app.test.js':preflightTests}});
  add('short-explanation',{changes:{'src/app.js':'// @clause:PREFLIGHT:REQ-001 x\nexport const convert = value => value.toString(16);\n','test/app.test.js':preflightTests}});
  add('wrong-source-tag',{changes:{'src/app.js':preflightSource.replace('REQ-001','REQ-999'),'test/app.test.js':preflightTests}});
  add('unknown-criterion',{changes:{'src/app.js':preflightSource,'test/app.test.js':preflightTests.replace('AC-001','AC-999')}});
  add('unsupported-test-folder',{claims:{'PREFLIGHT:REQ-001':planned('src/app.js',{tests:['checks/conversion.test.js']})},changes:{'src/app.js':preflightSource,'checks/conversion.test.js':preflightTests}});
  add('supporting-test',{changes:{'src/app.js':preflightSource,'test/app.test.js':preflightTests,'test/fixture.json':'{"value":15}\n'}});
  add('unreconciled-file',{changes:{'src/app.js':preflightSource,'test/app.test.js':preflightTests,'src/unplanned.js':'export const extra = true;\n'}},{requireReconciled:true});
  add('excluded-file',{changes:{'src/app.js':preflightSource,'test/app.test.js':preflightTests,'src/unplanned.js':'export const extra = true;\n'}});
  add('test-automation-boundary',{sourceBoundary:'test-automation'});add('protected-source',{protectedPaths:['src/**']});
  add('symlink',{changes:{'src/app.js':preflightSource,'test/app.test.js':preflightTests,'test/link.test.js':{symlink:'app.test.js'}}});
  add('strict-coverage',{}, {strictCoverage:true});add('ignore-disputes',{changes:{'src/app.js':preflightSource}}, {ignoreDisputes:true});
  for(const fulfillment of ['existing','removed','document','configuration','evidence','test-only'])for(const changed of [false,true]){
    const file=fulfillment==='configuration'?'config/app.json':fulfillment==='document'?'docs/usage.md':fulfillment==='evidence'?'singularity/work-items/PREFLIGHT/evidence/visual.txt':'src/app.js';
    const baseline=fulfillment==='removed'?{[file]:'approved old behavior\n'}:{};
    const changes={'test/app.test.js':preflightTests};if(changed)changes[file]=fulfillment==='removed'?null:'observed current contents\n';
    add(`fulfillment-${fulfillment}-${changed}`,{claims:{'PREFLIGHT:REQ-001':planned(file,{fulfillment})},baseline,changes});
  }
  return rows;
}

export function preflightProjection(value){
  if(value===null)return null;
  return {requirement:value.requirement,sourcePaths:value.sourcePaths,configurationPaths:value.configurationPaths,deletedSourcePaths:value.deletedSourcePaths,
    testPaths:value.testPaths,supportingTestPaths:value.supportingTestPaths,excludedChanges:value.excludedChanges,fulfillment:value.fulfillment,
    sourceBindings:value.sourceBindings,implementationBindings:value.implementationBindings,acceptanceCriteria:value.acceptanceCriteria,
    documentationCorrection:value.documentationCorrection,intentRevalidation:value.intentRevalidation,testingRepair:value.testingRepair};
}

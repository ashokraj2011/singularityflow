/** Input corpus and real bound-file fixture; expected outcomes are frozen before extraction. */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {canonicalJson} from '../../src/foundation/record-schema.mjs';
import {buildSpecIndex,normalizeClaimMap} from '../../src/specifications.mjs';
export const coverageId='COVER:REQ-001',acceptanceId='COVER:AC-001';
export const coverageAt='2026-01-01T00:00:00.000Z';
const clone=value=>structuredClone(value),hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const clause=(id=coverageId)=>({id,type:id.includes(':AC-')?'AC':'REQ',body:'Convert the approved integer.',source:{line:1}});
const planned=(claim={},extra={})=>({kind:'planned',workId:'COVER',phase:'plan',generation:1,recordedAt:coverageAt,
  claims:{[coverageId]:{expectedPaths:['src/value.mjs'],tests:['test/value.test.mjs'],testDisposition:'applicable',...claim}},...extra});
const observed=(claim={},extra={})=>({kind:'observed',workId:'COVER',phase:'code',generation:1,recordedAt:coverageAt,
  claims:{[coverageId]:{observedPaths:['src/value.mjs'],testResults:['test/value.test.mjs'],commits:[],verdict:'matched',deviation:null,...claim}},...extra});
export function specificationCoverageCases(){
  const cases=[],add=(name,method,args,host=false)=>cases.push({name,method,args:clone(args),...(host?{host:true}:{})});
  for(const coverage of ['off','record','enforce',undefined])for(const conformanceRows of ['qualified','legacy',undefined])
    add('enforcement '+String(coverage)+' '+String(conformanceRows),'codeCoverageEnforcement',[{coverage,conformanceRows}]);
  const indexes=[{workId:'COVER',phase:'spec',generation:1,clauses:[clause()]}];
  for(const fulfillment of ['new','modified','existing','removed','document','configuration','test-only','evidence',null]){
    const source=fulfillment==='document'?'docs/result.md':fulfillment==='configuration'?'package.json':fulfillment==='evidence'?'evidence/result.png':'src/value.mjs',
      plan=planned({fulfillment,expectedPaths:fulfillment==='test-only'?[]:[source]});
    for(const verdict of ['matched','partial','missing','deviated','unplanned'])for(const cohort of ['all','source-only','tests-only','neither']){
      const run=observed({observedPaths:['all','source-only'].includes(cohort)?[source]:[],testResults:['all','tests-only'].includes(cohort)?['test/value.test.mjs']:[],verdict}),
        records={indexes,planned:[plan],observed:[run]};
      add('merge '+fulfillment+' '+verdict+' '+cohort,'mergeObservedClaimRecords',[[run],plan.claims]);
      add('coverage '+fulfillment+' '+verdict+' '+cohort,'evaluateSpecCoverage',[records,[source,'test/value.test.mjs'],{coverage:'enforce'}]);
    }
  }
  const first=observed({observedPaths:['src/first.mjs'],testResults:['test/first.test.mjs'],verdict:'partial'},{phase:'first'}),
    last=observed({observedPaths:['src/last.mjs'],testResults:['test/last.test.mjs'],verdict:'partial'},{phase:'last'}),
    cumulative=planned({expectedPaths:['src/first.mjs','src/last.mjs'],tests:['test/first.test.mjs','test/last.test.mjs']});
  add('two partial intervals merge','mergeObservedClaimRecords',[[first,last],cumulative.claims]);
  add('later missing cannot erase first','mergeObservedClaimRecords',[[first,observed({observedPaths:[],testResults:[],verdict:'missing'},{phase:'last'})],cumulative.claims]);
  const obligations={expectedPaths:['src/first.mjs'],tests:['test/first.test.mjs','test/last.test.mjs'],obligations:[
    {owner:'first-plan',steps:['first'],fulfillment:'new',expectedPaths:['src/first.mjs'],tests:['test/first.test.mjs']},
    {owner:'last-plan',steps:['last'],fulfillment:'test-only',expectedPaths:[],tests:['test/last.test.mjs']} ]},
    workflow={workItem:{id:'COVER'},phaseOrder:['spec','plan','first','last'],resolution:{plannedClaims:{mode:'required',owners:{first:'first-plan',last:'last-plan'}}},
      phases:{spec:{generation:1,requiredArtifact:{kind:'requirements'}},plan:{generation:1},first:{generation:1},last:{generation:1}}};
  for(const order of [[first,last],[last,first],[first],[last]])add('allocated combination '+order.map(row=>row.phase).join(','),'mergeObservedClaimRecords',[order,{[coverageId]:obligations},{workflow}]);
  for(const mode of ['required','disabled',null])for(const owner of ['first-plan','missing',null])add('owner '+mode+' '+owner,'plannedClaimsForObservedPhase',[
    {resolution:{plannedClaims:{mode,owners:{code:owner}}}},'code',[planned({}, {phase:'first-plan'}),planned({expectedPaths:['src/other.mjs']},{phase:'other-plan'})]]);
  const current={indexes:[...indexes,{...indexes[0],workId:'OTHER'},{...indexes[0],generation:0},{...indexes[0],phase:'last'}],
    planned:[planned(),planned({}, {generation:0})],observed:[first,last],acceptance:[{workId:'COVER',phase:'first',generation:1},{workId:'OTHER',phase:'first',generation:1}]};
  for(const selected of [workflow,{...workflow,resolution:{}},{...workflow,workItem:{id:'OTHER'}},null])add('active '+String(selected?.workItem?.id)+' '+String(Boolean(selected?.resolution?.plannedClaims)),'selectActiveSpecRecords',[current,selected]);
  for(const coverage of ['off','record','enforce'])for(const excludes of [[],['generated'],['src/']]){
    const records={indexes,planned:[planned({}, {supportingFiles:['package.json'],accountedPaths:{[coverageId]:['src/accounted.mjs']},amendment:true})],observed:[observed()]};
    add('classification '+coverage+' '+excludes.join(','),'evaluateSpecCoverage',[records,['src/value.mjs','test/value.test.mjs','src/unclaimed.mjs','src/accounted.mjs','package.json','generated/output.mjs'],{coverage,excludes}]);
  }
  for(const mode of ['off','presence','verify'])for(const disposition of ['applicable','not-applicable','non-test'])for(const state of ['none','passed','failed','stale-hash','changed-source','wrong-work','wrong-command']){
    const plan=planned({tests:disposition==='applicable'?['test/value.test.mjs']:[],testDisposition:disposition,testReason:disposition==='not-applicable'?'The approved static interface has no runtime execution.':null,
      ...(disposition==='non-test'?{verificationCriterion:'VISUAL-1'}:{})}),
      index={...indexes[0],clauses:[{...clause(),verification:{methods:disposition==='non-test'?['inspection']:['test']}}]},
      run={workId:'COVER',phase:'verify',generation:1,status:state==='failed'?'failed':'passed',completedAt:coverageAt,commands:[{id:'tests',status:state==='failed'?'failed':'passed'}],
        sourceTreeSha256:'sha256:source',commandSetSha256:'sha256:commands',sourceChangedDuringRun:state==='changed-source'};
    run.recordSha256=hash(run);if(state==='stale-hash')run.recordSha256='wrong';
    add('acceptance '+mode+' '+disposition+' '+state,'evaluateSpecAcceptance',[{indexes:[index],planned:[plan],observed:[observed()],acceptance:state==='none'?[]:[run]},
      {acceptance:mode},{workId:state==='wrong-work'?'OTHER':'COVER',phase:'verify',generation:1,sourceTreeSha256:'sha256:source',commandSetSha256:state==='wrong-command'?'sha256:other':'sha256:commands'}]);
  }
  for(const shape of ['missing-source','missing-test','unreachable-commit','reachable-commit','deleted-source']){
    const run=observed({observedPaths:[shape==='missing-source'||shape==='deleted-source'?'src/missing.mjs':'src/value.mjs'],
      testResults:[shape==='missing-test'?'test/missing.test.mjs':'test/value.test.mjs'],
      commits:shape==='unreachable-commit'?['missing-commit']:shape==='reachable-commit'?['@reachable-commit@']:[]});
    add('host '+shape,'evaluateSpecCoverage',[{indexes,planned:[planned()],observed:[run]},shape==='deleted-source'?['src/missing.mjs']:[],{coverage:'enforce'}],true);
  }
  for(const coverage of ['unknown',false])add('bad policy '+String(coverage),'evaluateSpecCoverage',[{},[],{coverage}]);
  return cases;
}
export async function createSpecificationCoverageHost(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'sflow-coverage-native-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const write=async(relative,value)=>{const file=path.join(root,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,value);};
  const git=(...args)=>{const r=spawnSync('git',['-c','gc.auto=0','-c','maintenance.auto=false',...args],{cwd:root,env:process.env,encoding:'utf8',timeout:15000});
    if(r.status!==0)throw new Error(r.stderr||r.error?.message||'Coverage fixture Git failed.');return r.stdout.trim();};
  git('init','-q','-b','main');git('config','user.name','Coverage fixture');git('config','user.email','fixture@example.test');
  await write('src/value.mjs','export const value=255;\n');await write('test/value.test.mjs','// Original test source.\n');git('add','.');git('commit','-qm','Original coverage inputs');
  return {root,write,git,commit:git('rev-parse','HEAD')};
}
export async function createBoundCoverageFixture(t){
  const f=await createSpecificationCoverageHost(t),workId='COVER',item='singularity/work-items/'+workId,source=item+'/artifacts/spec/spec.md',indexPath=item+'/context/spec-indexes/spec-gen1.json',plannedPath=item+'/context/claims/plan-gen1-planned.json';
  await f.write(source,'# Specification\n\n## Requirements\n\n[COVER:REQ-001] Convert an integer.\n\n[COVER:REQ-002] Reject invalid input.\n');
  const index=await buildSpecIndex(f.root,source,{workId,phase:'spec',generation:1,outputPath:indexPath,policy:{mode:'enforce',coverage:'enforce'}}),
    plan={...normalizeClaimMap({claims:{[coverageId]:{expectedPaths:['src/value.mjs'],tests:[],testDisposition:'not-applicable',testReason:'The approved static contract is inspected without runtime execution.'},
      'COVER:REQ-002':{expectedPaths:['src/invalid.mjs'],tests:[],testDisposition:'not-applicable',testReason:'The approved static error contract is inspected without runtime execution.'}}},
    {kind:'planned',clauseIds:index.clauses.map(row=>row.id)}),workId,phase:'plan',generation:1};
  await f.write(plannedPath,canonicalJson(plan));
  const workflow={workItem:{id:workId,baseCommit:f.commit},phaseOrder:['spec','plan','code'],resolution:{spec:{mode:'enforce',coverage:'enforce'},plannedClaims:{mode:'required',clausePhases:['spec'],owners:{code:'plan'}}},
    phases:{spec:{id:'spec',generation:1,requiredArtifact:{path:'artifacts/spec/spec.md',kind:'requirements'},artifacts:[{path:source,status:'approved',sha256:index.source.sha256,size:index.source.bytes}],
      specIndex:{path:indexPath,generation:1,clauses:index.clauses.length,indexSha256:index.indexSha256,sourceSha256:index.source.sha256}},
      plan:{id:'plan',generation:1,claimMaps:{planned:{path:plannedPath,generation:1,sha256:hash(plan)}}},code:{id:'code',generation:0,requiredArtifact:{kind:'implementation-summary'}}}};
  return {...f,workflow,config:{workItemRoot:'singularity/work-items'},item,index,plan};
}
export function candidateCoverageCases(){
  const cases=[];
  for(const coverage of ['off','record','enforce'])for(const paths of [[],['src/value.mjs'],['src/value.mjs','src/invalid.mjs']])for(const bindings of [false,true]){
    const delivery={changeSet:{entries:paths.map(file=>({oldPath:file,newPath:file}))},sourcePaths:paths,fulfillment:[],acceptanceCriteria:{bindings:[]},sourceBindings:{bindings:bindings?paths.map(sourcePath=>({sourcePath,clauseId:sourcePath.includes('invalid')?'COVER:REQ-002':coverageId})):[]}};
    cases.push({name:'candidate '+coverage+' '+paths.length+' '+bindings,coverage,sourceBindings:'enforce',delivery});
  }
  cases.push({name:'candidate later allocation',coverage:'enforce',sourceBindings:'enforce',later:true,delivery:{changeSet:{entries:[]},sourcePaths:[],fulfillment:[]}});
  return cases;
}

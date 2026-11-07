import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {createGitStoryStatusEngine,readStatus} from '../src/engine-compatibility/git-story-status.mjs';
import {readStatus as compatibilityRead} from '../src/commands/status-read.mjs';
import {workflowAuthoringRoutes} from '../src/code-delivery-policy.mjs';
import {buildRepositorySubjectIndex,resolveContext} from '../src/repository-subject-index.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
import {withFreshReadScope} from '../src/read-scope.mjs';
import {readWorkerValue} from '../src/read-worker-service.mjs';

const previous={...process.env};let machine;
before(async()=>{machine=await mkdtemp(path.join(os.tmpdir(),'sflow-status-machine-'));process.env=isolatedTestEnvironment(machine);});
after(async()=>{process.env=previous;await rm(machine,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
const CLI=fileURLToPath(new URL('../bin/singularity-flow.mjs',import.meta.url));
const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'sflow-status-native-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const git=(...args)=>execFileSync('git',args,{cwd:root,env:process.env,stdio:'pipe',encoding:'utf8',timeout:30000}).trim();
  git('init','-q','-b','team/status');git('config','user.name','Status tester');git('config','user.email','status@example.invalid');
  const state={schemaVersion:2,workItem:{id:'STATUS-1',title:'Example',branch:'team/status',workType:'chore'},
    status:'in_progress',currentPhase:'team-intake',phaseOrder:['team-intake'],
    phases:{'team-intake':{id:'team-intake',status:'in_progress',generation:0,artifacts:[],checks:[],approvals:[],
      generationPolicy:{requirement:'required'},requiredArtifact:{kind:'specification',path:'artifacts/spec.md'}}},
    lineage:{canonicalBranch:'team/status',jiraIssueId:'TEAM-42',childBranches:[],aliases:[]},resolution:{},history:[]};
  const file=path.join(root,'singularity/work-items/STATUS-1/workflow.json');await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,JSON.stringify(state)+'\n');git('add','.');git('-c','commit.gpgsign=false','commit','-qm','fixture');
  const cli=(args,env={})=>{const result=spawnSync(process.execPath,[CLI,'--no-model',...args],
    {cwd:root,env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_BUNDLE:'off',...env},encoding:'utf8',timeout:60000});
    assert.equal(result.status,0,result.stderr||result.error?.message||result.stdout);return JSON.parse(result.stdout);};
  return {root,file,state,git,cli};
}

test('ordinary status preserves native JSON, aliases, current branch and worker projection through one operation',async t=>{
  const f=await fixture(t),head=f.git('rev-parse','HEAD'),bytes=await readFile(f.file),api=createSflow({root:f.root});
  assert.equal(readStatus,compatibilityRead);
  const selected=resolveContext(await buildRepositorySubjectIndex(f.root),{reference:'STATUS-1',kind:'story',required:true});
  const expected={...selected.state,authoringRoutes:workflowAuthoringRoutes(selected.state)};
  for(const reference of ['STATUS-1','TEAM-42','team/status',null]) {
    assert.deepEqual(await readStatus(f.root,reference),expected);
    assert.deepEqual(f.cli(['status',...(reference?[reference]:[]),'--json']),expected);
  }
  const result=await api.run('story.status',{workId:'STATUS-1'});
  assert.equal(result.subject.id,'STATUS-1');assert.equal(result.manifest.currentPhase,'team-intake');
  assert.equal(result.manifest.source.kind,'working-tree');assert.equal(result.manifest.inventoryComplete,true);
  await assert.rejects(api.run('story.status',{workId:'TEAM-42'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
  const worker=await readWorkerValue(f.root,['status','STATUS-1','--json']);
  assert.equal(worker.kind,'value');assert.deepEqual(worker.value,expected);
  const changed=JSON.parse(bytes);changed.workItem.title='Changed outside the worker';await writeFile(f.file,JSON.stringify(changed)+'\n');
  const fresh=await readWorkerValue(f.root,['status','STATUS-1','--json']);assert.equal(fresh.value.workItem.title,changed.workItem.title);
  assert.equal(f.git('rev-parse','HEAD'),head);
});

test('real source and bundled status commands project the actual SDK receipt, including shadow output',async t=>{
  const f=await fixture(t),captured=path.join(f.root,'capture.json');
  const child=spawnSync(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,
    CLI,'--no-model','status','TEAM-42','--json'],{cwd:f.root,env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_BUNDLE:'off',
      SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:captured},encoding:'utf8',timeout:60000});
  assert.equal(child.status,0,child.stderr);const ordinary=JSON.parse(child.stdout),receipt=JSON.parse(await readFile(captured,'utf8'));
  assert.equal(receipt.operation,'story.status');assert.equal(ordinary.workItem.id,receipt.result.subject.id);
  assert.equal(ordinary.currentPhase,receipt.result.manifest.currentPhase);
  const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-story-status-',import.meta.url)));
  t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');await buildCliBundle({outdir});
  const bundled={SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir};
  assert.deepEqual(f.cli(['status','TEAM-42','--json'],bundled),ordinary);
  const shadow=f.cli(['status','--json','--git-shadow'],bundled);
  assert.equal(shadow.gitShadow.equivalent,1);delete shadow.gitShadow;assert.deepEqual(shadow,ordinary);
});

test('unreadable retained publication remains unknown with its actual cause and preserved native recovery',async t=>{
  const f=await fixture(t),marker=path.join(f.root,'.git/singularity-flow/pending-publication/story--STATUS-1.json');
  await mkdir(path.dirname(marker),{recursive:true});await writeFile(marker,'{ malformed retained record');
  const original=await readFile(marker),binding=createGitStoryStatusEngine({root:f.root,reference:'TEAM-42'});
  const result=await binding.engine.run('story.status');
  assert.equal(result.manifest.publication.state,'unreadable');assert.ok(result.manifest.publication.error.message);
  assert.ok(binding.presentation().publicationError instanceof Error);
  assert.equal(result.manifest.publication.error.message,binding.presentation().publicationError.message);
  const legacy=await readStatus(f.root,'STATUS-1');assert.equal(legacy.publicationPending.state,'unreadable');
  assert.equal(legacy.publicationPending.nextAction.command,'singularity-flow doctor --json');
  assert.deepEqual(await readFile(marker),original);
});

test('incomplete legacy phase data remains visible and native missing/detached errors stay exact',async t=>{
  const f=await fixture(t),raw={...f.state,phaseOrder:['missing'],phases:{}};await writeFile(f.file,JSON.stringify(raw));
  const legacy=await withFreshReadScope(()=>readStatus(f.root,'STATUS-1'));assert.deepEqual(legacy.phases,{});
  const status=await createSflow({root:f.root}).run('story.status',{workId:'STATUS-1'});
  assert.equal(status.manifest.inventoryComplete,false);assert.equal(status.manifest.phases[0].status,null);
  await assert.rejects(readStatus(f.root,'UNKNOWN'),/not found|No .*Story|No story|No work item/u);
  const selected=resolveContext(await buildRepositorySubjectIndex(f.root),{reference:'STATUS-1',kind:'story',required:true});
  f.git('checkout','--detach','-q');await assert.rejects(readStatus(f.root),/Detached HEAD is not supported\./u);
  const captured=createGitStoryStatusEngine({root:f.root,initialSelection:selected});
  assert.equal((await captured.engine.run('story.status')).subject.id,'STATUS-1',
    'an already-captured selection needs neither branch discovery nor another subject index scan');
  assert.equal((await readStatus(f.root,'STATUS-1')).workItem.id,'STATUS-1');
});

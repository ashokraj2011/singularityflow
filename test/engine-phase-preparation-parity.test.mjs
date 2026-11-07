import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {prepareConfiguredPhase} from '../src/commands/shared/prepare-configured-phase.mjs';
import {authoredArtifactText} from '../src/publication-preflight.mjs';
import {startedSpecificationStory,specification,CLI} from './helpers/submitted-planning-story.mjs';
import {repository,startQuickFix} from './helpers/run-and-test-fixture.mjs';
import {run} from '../src/util.mjs';

const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));
function environment(extra={}) {
  const env={...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'off',...extra};
  delete env.SINGULARITY_FLOW_NO_MODEL;return env;
}
async function observedCli({directory,root,id},phase,extra={}) {
  const file=path.join(directory,'preparation.capture.json'),commandFile=path.join(directory,'preparation-command.capture.json');
  const result=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,CLI,
    'prepare',phase,'--work-id',id,'--json'],{cwd:root,allowFailure:true,
    env:environment({...extra,SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file,SINGULARITY_FLOW_TEST_COMMAND_CAPTURE:commandFile})});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  return {actual:JSON.parse(result.stdout),command:JSON.parse(await readFile(commandFile,'utf8')),
    captured:JSON.parse(await readFile(file,'utf8'))};
}
async function nativeEnvironment(repo,fn) {
  const saved=new Map(Object.keys(repo.env).map(key=>[key,process.env[key]]));Object.assign(process.env,repo.env);
  try{return await fn();}finally{for(const [key,value] of saved)value===undefined?delete process.env[key]:process.env[key]=value;}
}
const configure=config=>{config.session.workItemSelection='reuse';config.phases.specification.clarification={mode:'off'};};

test('SDK and source CLI prepare preserve authored documents, native failure codes and the existing presentation without publishing',async t=>{
  const id='SDK-PREPARE',f={...await startedSpecificationStory(t,id,{configure}),id};
  const root=await realpath(f.root),api=createSflow({root}),file=path.join(f.item,'workflow.json'),artifact=path.join(f.item,'artifacts/specification/spec.md');
  const head=f.git('rev-parse','HEAD'),index=f.git('write-tree'),branch=f.git('branch','--show-current');
  const prepared=await api.preparePhase({workId:id,phaseId:'specification'});
  assert.equal(prepared.status,'prepared');assert.equal(prepared.manifest.authoringRequired,true);
  assert.equal(prepared.effects.generationOpened,false);assert.equal(prepared.effects.committed,false);
  assert.equal(JSON.stringify(prepared).includes(root),false);assert.equal('instruction' in prepared.manifest,false);
  const observed=await observedCli(f,'specification'),receipt=observed.captured.result;
  assert.equal(observed.captured.operation,'phase.prepare');assert.equal(receipt.subject.id,id);
  assert.equal(receipt.manifest.producer,observed.command.data.preparation.producer);
  assert.equal(receipt.manifest.authoringRequired,observed.command.data.preparation.authoringRequired);
  assert.equal(observed.command.operation.id,'prepare');assert.equal(observed.command.outcome.messageId,'prepare.succeeded');
  assert.equal(observed.command.data.preparation.path,`singularity/work-items/${id}/artifacts/specification/spec.md`);
  assert.match(observed.command.data.preparation.instruction,/does not author it/);
  assert.equal(observed.command.data.preparation.stage,'prepared');assert.ok(observed.command.data.preparation.read);
  assert.ok(observed.command.next.some(action=>action.id==='prepare.author'));

  const content=specification(id,1)+'\n';await writeFile(artifact,content);
  const result=await api.run('phase.prepare',{phaseId:'specification'});
  assert.equal(authoredArtifactText(await readFile(artifact,'utf8')),authoredArtifactText(content));
  assert.equal(result.manifest.artifact.key,'artifacts/specification/spec.md');assert.equal(result.manifest.artifact.contentVerified,false);
  const before=await readFile(file),authored=await readFile(artifact);
  let refusal;
  await assert.rejects(api.preparePhase({phaseId:'planning'}),error=>{
    refusal=error.commandResult;
    return error.exitCode===2&&refusal?.outcome.messageId==='sequence.refused'&&error.enginePhasePreparation.localEffectsMayExist===true;
  });
  const native=run(process.execPath,[CLI,'prepare','planning','--json'],{cwd:f.root,allowFailure:true,env:environment()});
  assert.equal(native.status,2);assert.equal(JSON.parse(native.stdout).outcome.messageId,refusal.outcome.messageId);
  assert.deepEqual(await readFile(file),before);assert.deepEqual(await readFile(artifact),authored);
  const mismatch=run(process.execPath,[CLI,'prepare','specification','--work-id','OTHER','--json'],{cwd:f.root,allowFailure:true,env:environment()});
  assert.notEqual(mismatch.status,0);assert.deepEqual(await readFile(file),before);
  assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(f.git('write-tree'),index);assert.equal(f.git('branch','--show-current'),branch);
});

test('deterministic code preparation opens or reuses its local receipt; legacy next and bundled CLI keep the same authoring contract',async t=>{
  const repo=await repository(t,{implementCommands:false});await startQuickFix(repo);
  await nativeEnvironment(repo,async()=>{
    const root=await realpath(repo.root),api=createSflow({root}),file=path.join(root,'singularity/work-items/QF-1/workflow.json');
    const source=await readFile(path.join(root,'src/value.mjs')),head=repo.must('git',['rev-parse','HEAD']),index=repo.must('git',['write-tree']);
    const result=await api.preparePhase({workId:'QF-1',phaseId:'implement'});
    assert.equal(result.manifest.producer,'deterministic');assert.equal(result.manifest.authoringRequired,true);
    assert.equal(result.manifest.codeDeliveryRequired,true);assert.equal(result.effects.generationOpened,true);
    let stored=JSON.parse(await readFile(file));const intent=stored.phases.implement.generationIntent;
    assert.equal(stored.phases.implement.generation,0);assert.equal(intent.status,'open');assert.equal(intent.id,result.manifest.generationIntent.id);
    assert.equal(intent.receiptSha256,result.manifest.generationIntent.sha256);
    const f={directory:repo.base,root:repo.root,id:'QF-1'},sourceCli=await observedCli(f,'implement',repo.env);
    assert.equal(sourceCli.captured.result.effects.generationOpened,false);
    assert.equal(sourceCli.command.data.preparation.authoringRequired,true);
    assert.match(sourceCli.command.data.preparation.instruction,/code is not written yet/);
    const accepted=await loadAcceptedStoryExecution(root),phase=accepted.workflow.phases.implement;
    const legacy=await prepareConfiguredPhase(root,accepted.config,accepted.workflow,phase);
    assert.equal(legacy.workflow,accepted.workflow,'the legacy host keeps the exact context refreshed by next/composition');
    assert.deepEqual(Object.keys(legacy).sort(),['artifact','workflow','convergence','publicationProducer'].sort());
    assert.equal(legacy.publicationProducer,'deterministic');assert.equal(legacy.convergence,null);
    stored=JSON.parse(await readFile(file));assert.equal(stored.phases.implement.generationIntent.id,intent.id);
    assert.equal((await api.preparePhase({phaseId:'implement'})).effects.generationOpened,false);

    const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-phase-preparation-sdk-',import.meta.url)));
    t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
    const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');await buildCliBundle({outdir});
    const bundled=run(process.execPath,[CLI,'--no-model','prepare','implement','--work-id','QF-1','--json'],{
      cwd:repo.root,allowFailure:true,env:{...repo.env,SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir}});
    assert.equal(bundled.status,0,bundled.stdout+'\n'+bundled.stderr);const actual=JSON.parse(bundled.stdout);
    for(const key of ['path','producer','authoringRequired','instruction','stage'])assert.deepEqual(actual.data.preparation[key],sourceCli.command.data.preparation[key],key);
    assert.deepEqual(actual.next,sourceCli.command.next);assert.deepEqual(await readFile(path.join(root,'src/value.mjs')),source);
    assert.equal(repo.must('git',['rev-parse','HEAD']),head);assert.equal(repo.must('git',['write-tree']),index);
  });
});

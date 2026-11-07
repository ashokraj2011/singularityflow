import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {createGitEngine} from '../src/engine-compatibility/git-publication.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {setAgentSession,restoreAgentSession} from '../src/session.mjs';
import {setCopilotPaused} from '../src/copilot-mode.mjs';
import {currentSchemaVersion} from '../src/schema-migrations.mjs';
import {startedSpecificationStory,publishedPlanningStory,CLI} from './helpers/submitted-planning-story.mjs';
import {run} from '../src/util.mjs';

const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));
async function bind(root) {
  const accepted=await loadAcceptedStoryExecution(root),phase=accepted.workflow.phases[accepted.workflow.currentPhase];
  await setAgentSession(root,accepted.definition,{name:'History Tester',email:'history.tester@example.com'},phase.defaultAgent,
    accepted.workflow.workItem.id,{phaseId:phase.id,source:'test'});
}
async function observedCli(f,...extra) {
  const file=path.join(f.directory,'entry.capture.json');
  const env={...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file};
  delete env.SINGULARITY_FLOW_NO_MODEL;
  const result=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,CLI,
    'phase','enter',...extra,'--json'],{cwd:f.root,allowFailure:true,env});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  return {actual:JSON.parse(result.stdout),captured:JSON.parse(await readFile(file,'utf8'))};
}
const configure=config=>{config.session.workItemSelection='reuse';};

test('native SDK and CLI entry share admission, exact answer bindings and local task progress without exposing prompt prose',async t=>{
  const id='SDK-ENTRY',f=await startedSpecificationStory(t,id,{configure});await bind(f.root);
  const root=await realpath(f.root),api=createSflow({root}),workflowFile=path.join(f.item,'workflow.json');
  const before=await readFile(workflowFile),head=f.git('rev-parse','HEAD'),status=f.git('status','--porcelain');
  const entry=await api.run('phase.enter',{workId:id,phaseId:'specification'}),{actual,captured}=await observedCli(f,'specification','--work-id',id);
  assert.equal(captured.operation,'phase.enter');assert.deepEqual(captured.result,entry);
  assert.equal(entry.status,actual.status);assert.equal(entry.authoringAllowed,actual.authoringAllowed);
  assert.deepEqual(entry.admission.blockers.map(item=>item.code),actual.contextAdmission.blockers.map(item=>item.code));
  assert.equal(entry.manifest.clarification.stage,actual.clarification.checkpoint.stage);
  assert.equal(entry.manifest.task.operationId,actual.taskResume.operationId);assert.equal(entry.manifest.context,null);
  assert.equal(JSON.stringify(entry).includes(root),false);assert.equal('context' in entry,false);
  assert.deepEqual(await createGitEngine({root}).engine.run('phase.enter',{workId:id,phaseId:'specification'}),entry);
  assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(f.git('status','--porcelain'),status);
  assert.deepEqual(await readFile(workflowFile),before);

  const notes=path.join(f.directory,'requirements.md');await writeFile(notes,'# Local requirement\nKeep this supplied requirement local.\n');
  f.cli('documents','upload',notes,'--name','Local requirement');
  const composed=await api.run('phase.enter',{phaseId:'specification',compose:true});
  const again=await observedCli(f,'specification','--compose');
  assert.deepEqual(again.captured.result,composed);
  assert.equal(composed.contextComposition,'delivered');assert.ok(again.actual.context.text.includes('Keep this supplied requirement local.'));
  assert.equal(composed.manifest.context.deliveredSha256,again.actual.context.deliveredSha256);
  assert.equal(composed.manifest.clarification.answerBinding.promptSha256,again.actual.context.renderedSha256);
  const document=composed.manifest.resources.find(item=>item.role==='supporting-document');
  assert.equal(document.locality,'machine-local');assert.equal(document.availability,'verified-local');
  assert.equal((await api.run('document.read',{reference:document.reference})).document.expected.sha256,document.expected.sha256);
  assert.equal(JSON.stringify(composed).includes('Keep this supplied requirement local.'),false);
  assert.equal(composed.effects.testsRun,false);assert.equal(composed.effects.committed,false);assert.equal(composed.effects.modelInvocations,0);

  // A damaged native clarification remains an inspectable human-repair state, not a port-protocol dead end.
  const recordFile=path.resolve(root,again.actual.clarification.path);
  await mkdir(path.dirname(recordFile),{recursive:true});
  await writeFile(recordFile,JSON.stringify({schemaVersion:currentSchemaVersion('clarification-record'),workId:id,phase:'specification',generation:1,
    mode:'required',completed:true,recordedBy:{name:'History Tester',email:'history.tester@example.com'},agent:'product-owner',
    responses:[{question:'Original question',answer:'Original answer'}],promptSha256:'declared-invalid-digest',
    groundingRecordPath:'not-the-record.json',groundingRecordSha256:'a'.repeat(64),promptPath:'not-the-prompt.md'}));
  try {
    const damaged=await api.run('phase.enter',{phaseId:'specification'});
    assert.equal(damaged.authoringAllowed,false);assert.equal(damaged.manifest.clarification.stage,'inspect-binding');
    assert.equal(damaged.manifest.clarification.questioningAllowed,false);
    const observed=await observedCli(f,'specification');assert.ok(observed.actual.clarification.errors.length);
    assert.equal(observed.actual.clarification.recordState,damaged.manifest.clarification.recordState);
  } finally{await rm(recordFile,{force:true});}
});

test('explicit SDK roots ignore machine workspace selection; paused or unbound entry never imports the authoring runtime',async t=>{
  const f=await startedSpecificationStory(t,'SDK-ENTRY-BINDING',{configure});await restoreAgentSession(f.root,null);
  const root=await realpath(f.root);
  const loader=`export async function resolve(specifier,context,next){
    if(specifier.endsWith('/native-phase-entry.mjs')||specifier.endsWith('/phase-prompt-composer.mjs')
      ||specifier.endsWith('/git-publication.mjs')||specifier.endsWith('/commands/legacy.mjs'))throw Error('Eager authoring/legacy owner: '+specifier);
    return next(specifier,context);
  }`;
  const source=`import {register} from 'node:module';register(${JSON.stringify('data:text/javascript,'+encodeURIComponent(loader))},import.meta.url);
    const {mock}=await import('node:test');const workspace=await import(${JSON.stringify(new URL('../src/workspace-context.mjs',import.meta.url).href)});
    mock.module(${JSON.stringify(new URL('../src/workspace-context.mjs',import.meta.url).href)},{namedExports:{...workspace,
      resolveWorkspaceExecutionContext(){throw Error('An explicit SDK root must not select a machine workspace');}}});
    const {createSflow}=await import(${JSON.stringify(new URL('../src/api.mjs',import.meta.url).href)});
    const result=await createSflow({root:process.env.SFLOW_TEST_ENTRY_ROOT}).run('phase.enter',{compose:true});
    console.log(JSON.stringify({status:result.status,manifest:result.manifest,authoringAllowed:result.authoringAllowed}));`;
  const child=(selected,env={})=>run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--input-type=module','-e',source],{
    cwd:f.root,allowFailure:true,env:{...process.env,NODE_ENV:'test',SFLOW_TEST_ENTRY_ROOT:selected,...env}});
  const unbound=child(root);assert.equal(unbound.status,0,unbound.stdout+'\n'+unbound.stderr);
  assert.deepEqual(JSON.parse(unbound.stdout),{status:'binding-required',manifest:null,authoringAllowed:false});
  const pauseFile=path.join(f.directory,'paused.json');await setCopilotPaused(true,pauseFile);
  const paused=child(path.join(f.directory,'not-a-checkout'),{SINGULARITY_FLOW_COPILOT_MODE_FILE:pauseFile});
  assert.equal(paused.status,0,paused.stdout+'\n'+paused.stderr);
  assert.deepEqual(JSON.parse(paused.stdout),{status:'paused',manifest:null,authoringAllowed:false});
});

test('retained entry manifests bind approved inputs and the actually bundled entry preserves native JSON',async t=>{
  const id='SDK-ENTRY-RETAINED',f=await publishedPlanningStory(t,id,{configure});await bind(f.root);
  const root=await realpath(f.root),api=createSflow({root}),entry=await api.run('phase.enter',{phaseId:'planning',compose:true});
  assert.equal(entry.status,'retained-generation');assert.equal(entry.authoringAllowed,false);assert.equal(entry.contextComposition,'not-admitted');
  const input=entry.manifest.resources.find(item=>item.role==='approved-input');assert.ok(input);
  assert.equal(entry.manifest.resources[0].id,input.id);assert.equal(input.producer,'specification');
  const read=await api.run('document.read',{reference:input.reference});
  assert.equal(read.document.integrity,'matched');assert.equal(read.document.observed.sha256,input.expected.sha256);
  const expected=await observedCli(f,'planning');
  const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-phase-entry-sdk-',import.meta.url)));
  t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');await buildCliBundle({outdir});
  const env={...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir};
  delete env.SINGULARITY_FLOW_NO_MODEL;
  const bundled=run(process.execPath,[CLI,'phase','enter','planning','--json'],{cwd:f.root,allowFailure:true,env});
  assert.equal(bundled.status,0,bundled.stdout+'\n'+bundled.stderr);
  const actual=JSON.parse(bundled.stdout);
  assert.equal(actual.status,expected.actual.status);assert.deepEqual(actual.contextAdmission,expected.actual.contextAdmission);
  assert.deepEqual(actual.authoring,expected.actual.authoring);assert.deepEqual(actual.next,expected.actual.next);
  assert.deepEqual(actual.effects,expected.actual.effects);assert.equal(actual.workId,id);assert.equal(actual.phase,'planning');
});

import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {phaseInputArtifacts} from '../src/inputs.mjs';
import {phaseInputArtifacts as compatibilityArtifacts} from '../src/phase-input-presentation.mjs';
import {run} from '../src/util.mjs';
import {approvedSpecificationStory,CLI} from './helpers/submitted-planning-story.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
import {bundledCliUrl} from '../src/bundled-cli.mjs';

const previous={...process.env};let machine;
before(async()=>{machine=await mkdtemp(path.join(os.tmpdir(),'sflow-inputs-machine-'));process.env=isolatedTestEnvironment(machine);});
after(async()=>{process.env=previous;await rm(machine,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));

test('real approved inputs enter the SDK as exact provenance and preserve the native audit and managed artifact',async t=>{
  const id='ENGINE-INPUTS',f=await approvedSpecificationStory(t,id),api=createSflow({root:f.root});
  assert.equal(phaseInputArtifacts,compatibilityArtifacts);
  const workflowFile=path.join(f.item,'workflow.json'),before=await readFile(workflowFile),head=f.git('rev-parse','HEAD');
  const preview=await api.run('phase.inputs',{workId:id,phaseId:'planning',dryRun:true});
  assert.equal(preview.status,'inspected');assert.equal(preview.manifest.ready,true);assert.equal(preview.manifest.audit,null);
  assert.deepEqual(await readFile(workflowFile),before);assert.equal(f.git('rev-parse','HEAD'),head);
  const result=await api.run('phase.inputs',{workId:id,phaseId:'planning'});
  assert.equal(result.status,'prepared');assert.equal(result.effects.inputAuditRecorded,true);assert.equal(result.effects.generationOpened,false);
  assert.equal(result.effects.committed,false);assert.equal(result.manifest.authoringCompleted,false);
  const accepted=await loadAcceptedStoryExecution(f.root,id),audit=JSON.parse(await readFile(path.join(f.root,result.manifest.audit.key),'utf8'));
  assert.equal(audit.phase,'planning');assert.equal(audit.generation,result.generation);assert.equal(audit.renderedSha256,result.manifest.renderedSha256);
  assert.equal(accepted.workflow.phases.planning.inputContext.sha256,result.manifest.audit.sha256);
  assert.equal(result.manifest.artifact.managedMatchesRendered,true);
  assert.equal(result.manifest.records[0].status,'captured');assert.equal(result.manifest.records[0].producerStatus,'approved');
  assert.equal(result.manifest.records[0].approvedSha256,audit.inputs[0].approvedSha256);
  assert.equal(result.manifest.records[0].observedSha256,audit.inputs[0].sha256);
  assert.deepEqual(result.manifest.records[0].representation,audit.inputs[0].representation);
  assert.equal(result.manifest.records[0].maximumBytes,audit.inputs[0].maxBytes);
  assert.equal(result.manifest.records[0].truncated,audit.inputs[0].truncated);
  if (audit.inputs[0].projection.briefPath) assert.deepEqual(result.manifest.records[0].brief,
    {key:audit.inputs[0].projection.briefPath,sha256:audit.inputs[0].projection.briefSha256});
  assert.equal(f.git('rev-parse','HEAD'),head);
  const captured=path.join(path.dirname(f.root),'inputs.capture.json');
  const response=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,CLI,'--no-model',
    'inputs','planning','--dry-run','--json'],{cwd:f.root,allowFailure:true,env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:captured}});
  assert.equal(response.status,0,response.stdout+'\n'+response.stderr);
  const actual=JSON.parse(response.stdout),receipt=JSON.parse(await readFile(captured,'utf8'));
  assert.equal(receipt.operation,'phase.inputs');assert.deepEqual(receipt.result,preview);
  assert.equal(actual.resultType,'sflow-phase-inputs');assert.equal(actual.generation,receipt.result.generation);
  assert.equal(actual.readiness.ready,receipt.result.manifest.ready);assert.equal(actual.records[0].sha256,receipt.result.manifest.records[0].observedSha256);
  assert.equal(Object.hasOwn(actual.records[0],'content'),false);
});

test('source CLI preparation projects its actual SDK snapshot and exact newly issued artifact paths',async t=>{
  const id='ENGINE-INPUTS-CLI',f=await approvedSpecificationStory(t,id),captured=path.join(path.dirname(f.root),'inputs.capture.json');
  const response=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,CLI,'--no-model','inputs','planning','--json'],
    {cwd:f.root,allowFailure:true,env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:captured}});
  assert.equal(response.status,0,response.stdout+'\n'+response.stderr);
  const actual=JSON.parse(response.stdout),receipt=JSON.parse(await readFile(captured,'utf8')).result;
  assert.equal(receipt.operation,'phase.inputs');assert.equal(actual.artifact.sha256,receipt.manifest.artifact.sha256);
  assert.equal(actual.artifact.size,receipt.manifest.artifact.bytes);assert.equal(actual.audit.path,receipt.manifest.audit.key);
  assert.equal(actual.audit.sha256,receipt.manifest.audit.sha256);assert.equal(actual.records.length,receipt.manifest.records.length);
  assert.equal(actual.phase,'planning');assert.equal(actual.dryRun,false);assert.equal(actual.readiness.ready,true);
});

test('missing approved source bytes stay explicit in SDK and CLI dry-run recovery guidance',async t=>{
  const id='ENGINE-INPUTS-MISSING',f=await approvedSpecificationStory(t,id),source=path.join(f.item,'artifacts/specification/spec.md');
  await rm(source);
  const head=f.git('rev-parse','HEAD'),result=await createSflow({root:f.root}).run('phase.inputs',{phaseId:'planning',dryRun:true});
  assert.equal(result.manifest.ready,false);assert.ok(result.manifest.errorCount>0);
  assert.equal(result.manifest.records[0].status,'missing');assert.equal(result.manifest.records[0].producerStatus,'approved');
  const cli=JSON.parse(f.cli('inputs','planning','--dry-run','--json').stdout);
  assert.equal(cli.readiness.ready,false);assert.equal(cli.readiness.findings[0].restorable,true);
  assert.match(cli.readiness.restoreCommand,/inputs restore planning/u);assert.equal(f.git('rev-parse','HEAD'),head);
});

test('actually bundled input preparation retains the native JSON and bounded agent preview',async t=>{
  const id='ENGINE-INPUTS-BUNDLE',f=await approvedSpecificationStory(t,id);
  const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-phase-inputs-',import.meta.url)));
  t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');await buildCliBundle({outdir});
  const env={...process.env,NODE_ENV:'test',SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir};
  assert.ok(bundledCliUrl(fileURLToPath(new URL('..',import.meta.url)),env)?.startsWith(pathToFileURL(outdir+path.sep).href));
  const response=run(process.execPath,[CLI,'--no-model','inputs','planning','--json'],{cwd:f.root,env,allowFailure:true});
  assert.equal(response.status,0,response.stdout+'\n'+response.stderr);const actual=JSON.parse(response.stdout);
  assert.equal(actual.phase,'planning');assert.equal(actual.readiness.ready,true);assert.equal(actual.artifact.managedBlock.matchesRendered,true);
  const audit=JSON.parse(await readFile(path.join(f.root,actual.audit.path),'utf8'));assert.equal(audit.generation,actual.generation);
  const agent=run(process.execPath,[CLI,'--no-model','inputs','planning','--dry-run','--for-agent','--json'],{cwd:f.root,env,allowFailure:true});
  assert.equal(agent.status,0,agent.stdout+'\n'+agent.stderr);const preview=JSON.parse(agent.stdout);
  assert.equal(preview.resultType,'sflow-phase-inputs');assert.equal(preview.dryRun,true);assert.equal(preview.effects.committed,false);
});

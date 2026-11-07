import test,{before,after} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {workflowGuide,workflowGuidePresentation} from '../src/guide.mjs';
import {approvedSpecificationStory,CLI} from './helpers/submitted-planning-story.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';import {run} from '../src/util.mjs';

const previous={...process.env};let machine;
before(async()=>{machine=await mkdtemp(path.join(os.tmpdir(),'sflow-guide-machine-'));process.env=isolatedTestEnvironment(machine);});
after(async()=>{process.env=previous;await rm(machine,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));

test('native guide CLI renders its actual SDK plan without changing accepted Story bytes or lifecycle',async t=>{
  const f=await approvedSpecificationStory(t,'ENGINE-GUIDE'),accepted=await loadAcceptedStoryExecution(f.root,'ENGINE-GUIDE');
  const file=path.join(f.item,'workflow.json'),before=await readFile(file),head=f.git('rev-parse','HEAD');
  const result=await createSflow({root:f.root}).run('story.guide',{workId:'ENGINE-GUIDE'});
  const expected=workflowGuide(accepted.workflow);
  assert.deepEqual(workflowGuidePresentation(accepted.workflow,result.manifest),expected);
  assert.equal(result.manifest.actions[0].kind,'prepare-phase');assert.equal(result.manifest.phaseId,'planning');
  const captured=path.join(path.dirname(f.root),'guide.capture.json');
  const child=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,CLI,'--no-model','guide','ENGINE-GUIDE','--json'],
    {cwd:f.root,env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:captured},allowFailure:true});
  assert.equal(child.status,0,child.stderr+'\n'+child.stdout);assert.deepEqual(JSON.parse(child.stdout),expected);
  const receipt=JSON.parse(await readFile(captured,'utf8'));assert.equal(receipt.operation,'story.guide');
  assert.deepEqual(receipt.result,result);assert.deepEqual(await readFile(file),before);assert.equal(f.git('rev-parse','HEAD'),head);
  const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-engine-guide-',import.meta.url)));
  t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');await buildCliBundle({outdir});
  const bundled=run(process.execPath,[CLI,'--no-model','guide','ENGINE-GUIDE','--json'],{cwd:f.root,
    env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir},allowFailure:true});
  assert.equal(bundled.status,0,bundled.stderr);assert.deepEqual(JSON.parse(bundled.stdout),expected);
  assert.equal(f.git('rev-parse','HEAD'),head);assert.deepEqual(await readFile(file),before);
});

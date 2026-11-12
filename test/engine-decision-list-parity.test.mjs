import test from 'node:test';import assert from 'node:assert/strict';
import {createSflow} from '../src/api.mjs';
import {decisionPolicyPacket} from '../src/kernel/decision-plan.mjs';
import {startedSpecificationStory,CLI} from './helpers/submitted-planning-story.mjs';
import {run} from '../src/util.mjs';
import {mkdtemp,rm} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
import {buildCliBundle} from '../scripts/build-cli-bundle.mjs';
test('native SDK and real CLI listing preserve the same decision policy and legacy card JSON',async t=>{
  const f=await startedSpecificationStory(t,'DECISION-LIST-SDK',{description:'The requested behavior must retain an explanatory audit note.'}),
    api=createSflow({root:f.root}),before=f.git('rev-parse','HEAD'),status=f.git('status','--porcelain'),
    result=await api.run('decisions.list',{workId:'DECISION-LIST-SDK'});
  const cli=run(process.execPath,[CLI,'decisions','DECISION-LIST-SDK','--json'],{cwd:f.root,allowFailure:true,
    env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'off'}});
  assert.equal(cli.status,0,cli.stdout+'\n'+cli.stderr);
  const observed=JSON.parse(cli.stdout).data;assert.deepEqual(result.manifest.policy,decisionPolicyPacket(observed));
  assert.equal(result.phase,'specification');assert.equal(f.git('rev-parse','HEAD'),before);assert.equal(f.git('status','--porcelain'),status);
  assert.equal('record' in result.manifest.policy,false,'host command strings stay in the actual CLI projection');
  const scope=await api.run('scope.context',{workId:'DECISION-LIST-SDK'});
  assert.equal(scope.manifest.workId,'DECISION-LIST-SDK');assert.ok(scope.manifest.inventory.items.length);
  assert.equal(f.git('rev-parse','HEAD'),before);assert.equal(f.git('status','--porcelain'),status);
  const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-decision-list-',import.meta.url)));t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5}));
  await buildCliBundle({outdir});
  const bundled=run(process.execPath,[CLI,'decisions','DECISION-LIST-SDK','--json'],{cwd:f.root,allowFailure:true,
    env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir}});
  assert.equal(bundled.status,0,bundled.stdout+'\n'+bundled.stderr);assert.deepEqual(decisionPolicyPacket(JSON.parse(bundled.stdout).data),result.manifest.policy);
  assert.equal(f.git('rev-parse','HEAD'),before);assert.equal(f.git('status','--porcelain'),status);
});

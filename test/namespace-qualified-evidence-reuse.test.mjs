import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {namespaceEvidenceReuseFixture,reuseReason} from './helpers/namespace-evidence-reuse-fixture.mjs';
import {createEnvironmentQualifiedNodeCheckExecutionUnit} from '../src/sgos/node-check-execution-unit.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNamespaceSubmissionReader} from '../src/engine-storage/namespace-submission-reader.mjs';
import {createNamespacePublicationPolicyReader} from '../src/engine-storage/namespace-policy-reader.mjs';
import {GOVERNED_ROOTS} from '../src/governed-roots.mjs';
const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
async function fixture(t,backend='sqlite'){
  let checks,common,starts=0;
  async function unit(root,content,projectId,hostId='qualified-host',environment={}){
    const raw=await createEnvironmentQualifiedNodeCheckExecutionUnit({id:'qualified-reuse-node',hostId,root,projectId,repositoryId:'app',content,
      command:{executable:process.execPath,executableSha256,arguments:['--test','--test-reporter=tap','case.test.mjs'],environment},
      report:{adapter:'node-tap',files:[]},authorizeCommand:manifest=>manifest.manifestSha256});
    return {...raw,start(task){starts++;return raw.start(task);}};
  }
  const f=await namespaceEvidenceReuseFixture(t,{backend,beforePrepare:async input=>{
    checks=input.checks;common=input.options;
    const dependency=path.join(input.directory,'checkout','node_modules','fixture-dependency');await mkdir(dependency,{recursive:true});
    await writeFile(path.join(dependency,'index.js'),'export const dependencyVersion=1;\n');
    const actual=await unit(path.join(input.directory,'checkout'),common.content,common.scope.projectId);
    checks.environmentSensitiveReuse=true;checks.bindings[0].unit=actual;
    checks.bindings.push({...checks.bindings[0],phaseId:'assess'});
  }});
  const rebind=async(hostId='qualified-host',environment={})=>{
    const actual=await unit(f.root,f.content,f.scope.projectId,hostId,environment);
    return f.make({checks:{...checks,bindings:checks.bindings.map(row=>row.phaseId==='assess'?{...row,environment,unit:actual}:row)}});
  };
  const decide=async()=>{f.human();const view=await f.engine.run('evidence-reuse.context',{phaseId:'assess'});
    assert.equal(view.manifest.profile,'sflow-namespace-evidence-reuse-context/v2');
    assert.equal(view.manifest.candidates[0].environmentMatches,true);
    const request={phaseId:'assess',attemptId:view.manifest.candidates[0].taskId,reason:reuseReason};
    return {request,result:await f.engine.run('decision.evidence-reuse',request)};};
  return {...f,rebind,decide,starts:()=>starts};
}
for(const backend of ['filesystem','sqlite','application'])test('qualified reuse retains current SGOS environment and publishes without another test process: '+backend,{timeout:120000},async t=>{
  const f=await fixture(t,backend),{request,result}=await f.decide();
  assert.equal(result.record.schemaVersion,2);assert.equal(result.record.environments[0].identity.hostId,'qualified-host');assert.equal(f.starts(),1);
  await f.prepareReceiver();await f.engine.run('phase.publish',{phaseId:'assess',authored:'governed-agent',channel:'copilot-host'});
  await f.engine.run('phase.submit',{phaseId:'assess'});
  const snapshot=(await f.observer.inspect()).snapshot,checks=createNamespacePhaseCheckReader({...f.options,observer:f.observer}),
    packets=createNamespaceSubmissionReader({observer:f.observer,scope:f.scope,workId:f.inputs.workId,checks}),
    packet=await packets.inspect(snapshot,'assess'),policy=packet.published.policyEvidence.find(row=>row.kind==='evidence-reuse/v2');
  assert.ok(policy);assert.equal(f.starts(),1);
  const relabelled=structuredClone(packet.published);relabelled.policyEvidence.find(row=>row.kind==='evidence-reuse/v2').kind='evidence-reuse/v1';
  await assert.rejects(createNamespacePublicationPolicyReader({observer:f.observer,scope:f.scope,workId:f.inputs.workId,checks}).verify(relabelled),{code:'ENGINE_STORAGE_CORRUPT'});
  f.human();const review=await f.engine.run('phase.review',{phaseId:'assess'}),binding=review.manifest.reviewBinding;
  await f.engine.run('phase.approve',{phaseId:'assess',confirmation:{workId:f.inputs.workId,phase:'assess',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
  await rm(f.root,{recursive:true,force:true});
  const offline=f.make({sources:[],working:undefined,checks:undefined,clock:{now(){throw Error('Replay must not restamp.');}}});
  assert.deepEqual((await offline.run('decision.evidence-reuse',request)).record,result.record);assert.equal(f.starts(),1);
});
test('a changed actual host or process environment requires fresh checks before publication, submission and approval',{timeout:120000},async t=>{
  const f=await fixture(t);await f.decide();await f.prepareReceiver();
  const moved=await f.rebind('another-host');
  await assert.rejects(moved.run('phase.publish',{phaseId:'assess',authored:'governed-agent',channel:'copilot-host'}),{code:'ENGINE_EVIDENCE_REUSE_ENVIRONMENT_CHANGED'});
  await f.engine.run('phase.publish',{phaseId:'assess',authored:'governed-agent',channel:'copilot-host'});
  const changed=await f.rebind('qualified-host',{TEST_MODE:'different'});
  await assert.rejects(changed.run('phase.submit',{phaseId:'assess'}),{code:'ENGINE_EVIDENCE_REUSE_ENVIRONMENT_CHANGED'});
  await f.engine.run('phase.submit',{phaseId:'assess'});f.human();const review=await f.engine.run('phase.review',{phaseId:'assess'}),binding=review.manifest.reviewBinding;
  await assert.rejects(changed.run('phase.approve',{phaseId:'assess',confirmation:{workId:f.inputs.workId,phase:'assess',generation:binding.generation,reviewPacketSha256:binding.packetSha256}}),{code:'ENGINE_EVIDENCE_REUSE_ENVIRONMENT_CHANGED'});
  assert.equal(f.starts(),1);assert.equal((await f.observer.inspect()).snapshot.workflow.phases.assess.approvals.length,0);
});
test('dependency changes, absent environment capabilities and real reader errors stay explicit',{timeout:120000},async t=>{
  const f=await fixture(t),view=await f.engine.run('evidence-reuse.context',{phaseId:'assess'});f.human();
  const request={phaseId:'assess',attemptId:view.manifest.candidates[0].taskId,reason:reuseReason};
  await writeFile(path.join(f.root,'package-lock.json'),'{}\n');
  await assert.rejects(f.engine.run('decision.evidence-reuse',request),{code:'ENGINE_SOURCE_CHANGED'});
  await rm(path.join(f.root,'package-lock.json'));
  const dependency=path.join(f.root,'node_modules','fixture-dependency','index.js'),before=await readFile(dependency);
  await writeFile(dependency,'export const dependencyVersion=2;\n');
  await assert.rejects(f.engine.run('decision.evidence-reuse',request),{code:'ENGINE_SOURCE_CHANGED'});
  await writeFile(dependency,before);
  const governed=GOVERNED_ROOTS.find(value=>value==='.github')??GOVERNED_ROOTS.find(value=>!value.startsWith('.singularity-flow')),
    generated=path.join(f.root,governed,'probe.generated.md');await mkdir(path.dirname(generated),{recursive:true});await writeFile(generated,'Changed runner input outside application-path accounting.\n');
  const changed=(await f.engine.run('evidence-reuse.context',{phaseId:'assess'})).manifest;
  assert.equal(changed.candidates[0].sourceMatches,true);assert.equal(changed.candidates[0].environmentMatches,false);
  assert.equal(changed.candidates[0].environmentIssue.code,'ENGINE_EVIDENCE_REUSE_ENVIRONMENT_CHANGED');assert.ok(changed.actions.some(row=>row.operation==='phase.checks.run'));
  await assert.rejects(f.engine.run('decision.evidence-reuse',request),{code:'ENGINE_EVIDENCE_REUSE_ENVIRONMENT_CHANGED'});await rm(generated);
  const bindings=f.checks.bindings.map(row=>({...row,unit:{...row.unit,observeEnvironment(){throw Object.assign(new Error('Actual reader denied the checkout.'),{code:'EACCES',path:f.root});}}}));
  await assert.rejects(f.make({checks:{...f.checks,bindings}}).run('decision.evidence-reuse',request),error=>error.code==='EACCES'&&error.path===f.root);
  await f.engine.run('decision.evidence-reuse',request);await f.prepareReceiver();
  await assert.rejects(f.make({checks:undefined}).run('phase.publish',{phaseId:'assess',authored:'governed-agent',channel:'copilot-host'}),{code:'ENGINE_EVIDENCE_REUSE_ENVIRONMENT_REQUIRED'});
  assert.equal(f.starts(),1);
});

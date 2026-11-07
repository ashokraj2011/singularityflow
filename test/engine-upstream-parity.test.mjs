import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {publishedPlanningStory,CLI} from './helpers/submitted-planning-story.mjs';
import {documentStory} from './helpers/upstream-document-story.mjs';
import {run} from '../src/util.mjs';

const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));
const reason='The approved document does not state how long callers may cache the value.';
async function asActor(name,operation) {
  const old={mode:process.env.NODE_ENV,identity:process.env.SINGULARITY_FLOW_TEST_IDENTITY};
  process.env.NODE_ENV='test';process.env.SINGULARITY_FLOW_TEST_IDENTITY=name;
  try{return await operation();}finally{
    if(old.mode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old.mode;
    if(old.identity===undefined)delete process.env.SINGULARITY_FLOW_TEST_IDENTITY;else process.env.SINGULARITY_FLOW_TEST_IDENTITY=old.identity;
  }
}
async function observedCli(f,name,args,identity='History Tester') {
  const file=path.join(f.directory??f.root,name+'.capture.json');
  const result=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,
    CLI,'--no-model',...args,'--json'],{cwd:f.root,allowFailure:true,env:{...process.env,NODE_ENV:'test',
      SINGULARITY_FLOW_TEST_IDENTITY:identity,SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file}});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  const observed=JSON.parse(await readFile(file,'utf8'));
  await rm(file,{force:true});
  return {actual:JSON.parse(result.stdout),observed};
}
async function planned(t,id) {
  const f=await publishedPlanningStory(t,id,{configure(config){
    config.approvalAuthorities['architecture-reviewers']={label:'Plan owners',allowAnyGitIdentity:false,
      members:[{email:'history.tester@example.com'}]};
  }});
  f.cli('submit','planning','--skip-checks');f.cli('approve','planning','--yes');
  return f;
}

test('SDK and CLI upstream records use the same native authority, envelopes and immutable plan approvals',async t=>{
  const id='SDK-UPSTREAM',f=await planned(t,id),api=createSflow({root:f.root});
  const before=(await loadAcceptedStoryExecution(f.root,id)).workflow;
  await asActor('History Tester',async()=>{
    const receipt=await api.run('upstream.raise',{workId:id,phaseId:'planning',about:'Caching',problem:reason});
    assert.equal(receipt.records[0].id,'UPI-001');assert.equal(receipt.currentPhase,'implementation');
    assert.equal(f.git('rev-parse','HEAD'),receipt.revision);
  });
  const raised=await observedCli(f,'raise',['upstream-issue','raise','--work-id',id,'--phase','planning','--about','Caching',
    '--problem',reason+' The second caller also needs an explicit bound.']);
  assert.equal(raised.observed.operation,'upstream.raise');
  assert.deepEqual(raised.actual.data.issues,raised.observed.result.records);
  const listed=await observedCli(f,'list',['upstream-issue','list','--work-id',id,'--open']);
  assert.equal(listed.observed.operation,'upstream.list');
  assert.deepEqual(listed.actual.data.issues,listed.observed.result.issues);
  const head=f.git('rev-parse','HEAD');
  await asActor('Unrelated Reviewer',async()=>{
    await assert.rejects(api.run('upstream.decide',{workId:id,issueId:'UPI-001',outcome:'dismiss',reason}),
      {code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});
  });
  assert.equal(f.git('rev-parse','HEAD'),head);
  await asActor('History Tester',async()=>{
    const result=await api.run('upstream.decide',{workId:id,issueId:'UPI-001',outcome:'dismiss',reason});
    assert.equal(result.records[0].authorityGroup,'architecture-reviewers');
    assert.equal(result.currentPhase,'implementation');
  });
  const decided=await observedCli(f,'decide',['upstream-issue','decide','UPI-002','--work-id',id,'--outcome','dismiss','--reason',reason]);
  assert.equal(decided.observed.operation,'upstream.decide');
  assert.deepEqual(decided.actual.data.decision,decided.observed.result.records[0]);
  const after=(await loadAcceptedStoryExecution(f.root,id)).workflow;
  assert.deepEqual(after.phases.planning.approvals,before.phases.planning.approvals);
  assert.equal(after.phases.planning.generation,1);assert.equal(after.currentPhase,'implementation');

  const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-upstream-',import.meta.url)));
  t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');await buildCliBundle({outdir});
  const bundled=run(process.execPath,[CLI,'--no-model','upstream-issue','raise','--work-id',id,'--phase','planning',
    '--about','Cache lifetime','--problem',reason,'--json'],{cwd:f.root,allowFailure:true,
    env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir}});
  assert.equal(bundled.status,0,bundled.stdout+'\n'+bundled.stderr);
  assert.equal(JSON.parse(bundled.stdout).data.issues[0].id,'UPI-003');
  await asActor('Unrelated Reviewer',async()=>{
    const authored=await api.run('upstream.raise',{workId:id,phaseId:'planning',about:'Author observation',problem:reason});
    assert.equal(authored.records[0].id,'UPI-004','raising needs no approval-group membership');
    assert.equal(authored.currentPhase,'implementation');
  });
});

test('artifact-derived SDK issues are filed once, with unowned recovery commands confined to the CLI',async t=>{
  const id='SDK-UPSTREAM-FROM',f=await planned(t,id),api=createSflow({root:f.root});
  f.cli('prepare','implementation');
  const artifact=path.join(f.root,'singularity/work-items',id,'artifacts/implementation/implementation-summary.md');
  await writeFile(artifact,`${await readFile(artifact,'utf8')}\n## Upstream discrepancies\n\n- planning: ${reason}\n- The cache details need review but no owning step is named.\n`);
  await asActor('History Tester',async()=>{
    const receipt=await api.run('upstream.raise',{workId:id,fromArtifact:true});
    assert.equal(receipt.records.length,1);assert.equal(receipt.records[0].source.path.endsWith('implementation-summary.md'),true);
    assert.equal(receipt.unowned.length,1);assert.equal('command' in receipt.unowned[0],false);
    const repeat=await api.run('upstream.raise',{workId:id,fromArtifact:true});
    assert.equal(repeat.status,'unchanged');assert.deepEqual(repeat.publications,[]);
  });
  const host=await observedCli(f,'artifact-list',['upstream-issue','raise','--work-id',id,'--from-artifact']);
  assert.equal(host.actual.data.unowned.length,1);assert.match(host.actual.data.unowned[0].command,/singularity-flow upstream-issue raise/u);
  assert.deepEqual(host.actual.data.issues,[]);
});

test('native forward amendment approval, revalidation and rejection preserve the document-chain journey',async t=>{
  const f=await documentStory(t),id='AMEND-FWD-1',api=createSflow({root:f.root});
  const approved=await readFile(f.artifact('intake'),'utf8');
  await writeFile(f.artifact('intake'),approved+'\nCallers keep their copy for at most one hour.\n');
  await asActor('Amend Tester',async()=>{
    const proposed=await api.run('forward-amendment.propose',{workId:id,phaseId:'intake',reason});
    assert.equal(proposed.records[0].id,'FAM-001');assert.equal(proposed.currentPhase,'fix-design');
    assert.equal(await readFile(f.artifact('intake'),'utf8'),approved);
  });
  const decided=await observedCli(f,'approve',['upstream-issue','decide-amendment','FAM-001','--work-id',id,
    '--decision','approve','--confirm','FAM-001','--reason',reason],'Amend Tester');
  assert.equal(decided.observed.operation,'forward-amendment.decide');
  assert.deepEqual(decided.actual.data.decision,decided.observed.result.records[0].decision);
  assert.deepEqual(decided.actual.data.revalidate,['design']);assert.equal(decided.actual.data.refreshed,'fix-design');
  await asActor('Amend Tester',async()=>{
    const result=await api.run('forward-amendment.revalidate',{workId:id,phaseId:'design',amendmentId:'FAM-001',outcome:'unchanged',reason});
    assert.equal(result.records[0].outcome,'unchanged');assert.equal(result.currentPhase,'fix-design');
  });
  await writeFile(f.artifact('intake'),await readFile(f.artifact('intake'),'utf8')+'\nCallers refresh their copy whenever the value changes.\n');
  const proposed=await observedCli(f,'propose',['upstream-issue','propose-amendment','--work-id',id,'--phase','intake','--reason',reason],'Amend Tester');
  assert.equal(proposed.observed.operation,'forward-amendment.propose');
  assert.deepEqual(proposed.actual.data.proposal,proposed.observed.result.records[0]);
  await asActor('Amend Tester',async()=>{
    const rejected=await api.run('forward-amendment.decide',{workId:id,amendmentId:'FAM-002',decision:'reject',confirmation:'FAM-002',reason});
    assert.equal(rejected.records[0].applied,false);assert.equal(rejected.records[0].decision.decision,'rejected');
  });
  await writeFile(f.artifact('intake'),await readFile(f.artifact('intake'),'utf8')+'\nThe duration starts when the caller reads the value.\n');
  await asActor('Amend Tester',async()=>{
    await api.run('forward-amendment.propose',{workId:id,phaseId:'intake',reason});
    const approved=await api.run('forward-amendment.decide',{workId:id,amendmentId:'FAM-003',decision:'approve',confirmation:'FAM-003',reason});
    assert.equal(approved.records[0].applied,true);assert.equal(approved.records[0].approval.generation,3);
    assert.deepEqual(approved.revalidate,['design']);assert.equal(approved.refreshed,'fix-design');
  });
  const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-forward-amendment-',import.meta.url)));
  t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');await buildCliBundle({outdir});
  const bundled=run(process.execPath,[CLI,'--no-model','upstream-issue','revalidate','design','--work-id',id,
    '--amendment','FAM-003','--outcome','unchanged','--reason',reason,'--json'],{cwd:f.root,allowFailure:true,
    env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'Amend Tester',SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir}});
  assert.equal(bundled.status,0,bundled.stdout+'\n'+bundled.stderr);
  assert.equal(JSON.parse(bundled.stdout).data.revalidation.binding.producerGeneration,3);
  const after=await f.state();
  assert.equal(after.phases.intake.generation,3);assert.equal(after.phases.design.status,'approved');
  assert.equal(after.phases.design.generation,1);assert.equal(after.currentPhase,'fix-design');
});

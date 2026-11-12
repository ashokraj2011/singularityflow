import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {readFile,rm} from 'node:fs/promises';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {namespacePhaseCheckFixture} from './helpers/namespace-phase-check-fixture.mjs';
import {namespaceApprovalFixture} from './helpers/namespace-approval-fixture.mjs';
import {namespaceReleaseFixture,releaseReport,releasePublish} from './helpers/namespace-release-fixture.mjs';
import {configure as routingConfigure,approval,confirmation,authorSubmit,access as routingAccess} from './helpers/namespace-routing-fixture.mjs';
import {createNodeCheckExecutionUnit} from '../src/sgos/node-check-execution-unit.mjs';
import {NAMESPACE_STORY_COMMAND_PROFILE} from '../src/engine-storage/namespace-test-command-reader.mjs';
const reason='The independent owner reviewed the exact retained facts and accepts this bounded decision.',
  batchInput=(policy,choices)=>({confirmation:policy.packetSha256,answers:{choose:Object.fromEntries(choices.map(([row,option])=>[row.id,option])),
    reason:Object.fromEntries(choices.map(([row])=>[row.id,reason]))}});
test('a batched test-command acceptance drives a genuine fresh executor and replays without restarting it',{timeout:120000},async t=>{
  const f=await namespacePhaseCheckFixture(t,{backend:'sqlite',configure(source){source.definition.phases.intake.approval.allowSelfApproval=false;
    source.definition.approvalAuthorities.reviewers.members.push({email:'author@example.test'},{email:'independent@example.test'});}}),
    {records,content,scope,workId,authority,access,clock,sources}=f.options,
    common={records,content,scope,workId,authority,access,clock,sources,working:{records:f.localRecords,content:f.localContent},checks:f.checks},make=extra=>createNamespaceEngine({...common,...extra}),engine=make();
  f.accessControl.permissions.push('decisions.list','decisions.record','test-command.context','test-command.request','test-command.decide');
  Object.assign(f.accessControl,{principalId:'command-author',creator:{name:'Command author',email:'author@example.test',login:null},agentId:'analyst'});
  const before=await engine.run('test-command.context',{phaseId:'intake'}),original=before.manifest.commands[0],
    command={...original.command,argv:[original.command.argv[0],'--test-concurrency=1',...original.command.argv.slice(1)]};
  await engine.run('test-command.request',{phaseId:'intake',command:{profile:NAMESPACE_STORY_COMMAND_PROFILE,command,
    replaces:{id:command.id,sha256:original.sha256}},reason});
  Object.assign(f.accessControl,{principalId:'independent-reviewer',creator:{name:'Independent reviewer',email:'independent@example.test',login:null},agentId:null});
  const shown=await engine.run('decisions.list'),item=shown.manifest.policy.items.find(row=>row.kind==='test-command');assert.ok(item);
  const input=batchInput(shown.manifest.policy,[[item,'accept-test-command']]),recorded=await engine.run('decisions.record',input);
  assert.equal(recorded.recorded[0].value.accepts,'TCD-001');assert.equal(f.control.starts,0);
  assert.equal((await engine.run('decisions.list')).manifest.policy.items.some(row=>row.kind==='test-command'),false);
  f.accessControl.agentId='analyst';const draft=await engine.run('phase.draft.read',{phaseId:'intake'});
  await engine.run('phase.draft.rebase',{operationId:'rebase-after-batched-command',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    confirm:draft.manifest.draft.bodySha256,reason});
  const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
    raw=await createNodeCheckExecutionUnit({id:'batched-amended-check',root:f.root,projectId:f.scope.projectId,repositoryId:'app',content:f.content,
      command:{executable:process.execPath,executableSha256,arguments:command.argv.slice(1),environment:{}},
      report:{adapter:'node-tap',files:[]},authorizeCommand:manifest=>manifest.manifestSha256}),unit={...raw,start(task){f.control.starts++;return raw.start(task);}},
    amended=make({checks:{...f.checks,bindings:[{...f.checks.bindings[0],unit}]}});
  assert.equal((await amended.run('phase.checks.run',{...f.input,operationId:'batched-amended-execution'})).verdict,'passed');assert.equal(f.control.starts,1);
  await rm(f.root,{recursive:true,force:true});f.accessControl.agentId=null;
  assert.deepEqual(await make({working:null,sources:[],checks:undefined,clock:{now(){throw Error('Acknowledgement cannot restamp decisions.');}}}).run('decisions.record',input),recorded);
  assert.equal(f.control.starts,1);
});
test('a recorded route is the last effect and its original batch survives the phase transition',async t=>{
  const f=await namespaceApprovalFixture(t,{backend:'sqlite',configure:routingConfigure('ask')}),reviewer=approval(f);
  await authorSubmit(f,'intake');await reviewer.run('phase.approve',{phaseId:'intake',confirmation:await confirmation(f,reviewer,'intake')});
  const options={records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,
    access:routingAccess(f,['decisions.list','decisions.record','decision.choose']),clock:f.clock},engine=createNamespaceEngine(options),
    shown=await engine.run('decisions.list'),item=shown.manifest.policy.items.find(row=>row.kind==='routing-decision');assert.ok(item);
  const input=batchInput(shown.manifest.policy,[[item,'continue']]),result=await engine.run('decisions.record',input);
  assert.equal(result.recorded[0].kind,'routing');assert.equal((await f.capture()).workflow.currentPhase,'review');
  assert.deepEqual(await createNamespaceEngine({...options,clock:{now(){throw Error('A retained route cannot restamp time.');}}}).run('decisions.record',input),result);
});
test('linked partial verdicts expose one upstream decision and never a duplicate conformance risk',{timeout:120000},async t=>{
  const f=await namespaceReleaseFixture(t,{backend:'sqlite'});f.control.permissions.push('upstream.raise','upstream.decide','decisions.list','decisions.record','conformance.context');
  await f.engine.run('upstream.raise',{operationId:'batched-release-issue',phaseId:'build',about:'STORY-1:REQ-001 and STORY-1:AC-001',
    problem:'The retained implementation has this explicitly disclosed bounded operational limitation.',proposed:'accept-risk',authored:'human'});
  await f.write('release',releaseReport('partial').replaceAll('| partial |','| partial (UPI-001) |'));
  await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  const shown=await f.engine.run('decisions.list'),items=shown.manifest.policy.items;assert.equal(items.filter(row=>row.kind==='upstream-issue').length,1);
  assert.equal(items.filter(row=>row.kind==='conformance-gap').length,0);
  const item=items.find(row=>row.kind==='upstream-issue'),input=batchInput(shown.manifest.policy,[[item,'accept-risk']]);
  input.answers.expires={[item.id]:new Date(Date.parse(await f.clock.now())+86400000).toISOString().slice(0,10)};
  const result=await f.engine.run('decisions.record',input);assert.equal(result.effects.recordedEntries,1);
  const after=await f.capture();assert.equal(after.workflow.upstreamIssueDecisions.length,1);assert.equal(after.workflow.namespaceHumanDecisionReceipts?.length??0,0);
  const context=await f.engine.run('conformance.context',{phaseId:'release'});assert.ok(context.gaps.every(row=>row.owners.every(owner=>owner.decision?.active)));
  assert.deepEqual(await f.engine.run('decisions.record',input),result);
});
test('unlinked partial verdicts retain exact owner decisions once through the same batch registry',{timeout:120000},async t=>{
  const f=await namespaceReleaseFixture(t,{backend:'sqlite'});f.control.permissions.push('decisions.list','decisions.record','conformance.context','conformance.decide');
  await f.write('release',releaseReport('partial'));await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  const shown=await f.engine.run('decisions.list'),items=shown.manifest.policy.items.filter(row=>row.kind==='conformance-gap');assert.equal(items.length,2);
  const input=batchInput(shown.manifest.policy,items.map(row=>[row,'dismiss'])),result=await f.engine.run('decisions.record',input);
  assert.equal(result.effects.recordedEntries,2);assert.equal((await f.capture()).workflow.namespaceHumanDecisionReceipts.length,2);
  assert.equal((await f.engine.run('decisions.list')).manifest.policy.items.filter(row=>row.kind==='conformance-gap').length,0);
  assert.deepEqual(await f.engine.run('decisions.record',input),result);
});

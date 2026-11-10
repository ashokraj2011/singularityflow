import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {readFile,rm} from 'node:fs/promises';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {namespacePhaseCheckFixture} from './helpers/namespace-phase-check-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceTestCommandOwners,NAMESPACE_STORY_COMMAND_PROFILE} from '../src/engine-storage/namespace-test-command-reader.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNodeCheckExecutionUnit} from '../src/sgos/node-check-execution-unit.mjs';
const sha=value=>'sha256:'+createHash('sha256').update(canonicalJson(value)).digest('hex'),reason='Review this exact structured command for this Story without changing the original repository policy.';
async function fixture(t,backend,configure=()=>{}){
  const f=await namespacePhaseCheckFixture(t,{backend,configure(source){source.definition.phases.intake.approval.allowSelfApproval=false;source.definition.approvalAuthorities.reviewers.members.push({email:'independent@example.test'},{email:'author@example.test'});configure(source);}}),
    {records,content,scope,workId,authority,access,clock,sources}=f.options,
    common={records,content,scope,workId,authority,access,clock,sources,working:{records:f.localRecords,content:f.localContent}},
    make=extra=>createNamespaceEngine({...common,checks:f.checks,...extra}),engine=make(),observer=createNamespaceStoryObserver(common),
    commands=createNamespaceTestCommandOwners({observer,scope,workId});
  f.accessControl.permissions.push('test-command.context','test-command.request','test-command.decide','phase.publish','phase.review');
  const author=()=>Object.assign(f.accessControl,{principalId:'command-author',creator:{name:'Command author',email:'author@example.test',login:null},agentId:'analyst'}),
    human=()=>Object.assign(f.accessControl,{principalId:'command-reviewer',creator:{name:'Command reviewer',email:'reviewer@example.test',login:null},agentId:null});
  author();const view=await engine.run('test-command.context',{phaseId:'intake'}),before=view.manifest.commands[0].command,
    command={...before,argv:[before.argv[0],'--test-concurrency=1',...before.argv.slice(1)]},request={phaseId:'intake',command:{profile:NAMESPACE_STORY_COMMAND_PROFILE,command,replaces:{id:before.id,sha256:view.manifest.commands[0].sha256}},reason};
  const rebase=async id=>{const draft=await engine.run('phase.draft.read',{phaseId:'intake'});await engine.run('phase.draft.rebase',{operationId:id,workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,confirm:draft.manifest.draft.bodySha256,reason});};
  return {...f,common,make,engine,observer,commands,before,command,request,author,human,rebase};
}
for(const backend of ['filesystem','sqlite','application'])test(backend+': a human command amendment drives actual execution and immutable publication',{timeout:120000},async t=>{
  const f=await fixture(t,backend),original=(await f.observer.inspect()).snapshot.workflow;
  const requested=await f.engine.run('test-command.request',f.request);assert.equal(requested.record.id,'TCD-001');assert.equal((await f.engine.run('test-command.context',{phaseId:'intake'})).manifest.requests[0].state,'requested');assert.equal(f.control.starts,0);
  await assert.rejects(f.engine.run('test-command.decide',{accept:'TCD-001',reason}),{code:'TEST_COMMAND_SELF_ACCEPTANCE'});
  f.human();await f.engine.run('test-command.decide',{accept:'TCD-001',reason});f.author();await f.rebase('rebase-after-human-command');
  const snapshot=(await f.observer.inspect()).snapshot;assert.deepEqual(snapshot.workflow.resolution,original.resolution);
  assert.deepEqual(snapshot.workflow.phases.intake.qualityCommands,original.phases.intake.qualityCommands);
  assert.deepEqual((await f.commands.commands(snapshot,'intake')).commands,[f.command]);
  await assert.rejects(f.engine.run('phase.checks.run',{...f.input,operationId:'old-executor-refused'}),{code:'ENGINE_CHECK_BINDING_CHANGED'});assert.equal(f.control.starts,0);
  const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
    raw=await createNodeCheckExecutionUnit({id:'amended-real-node-check',root:f.root,projectId:f.scope.projectId,repositoryId:'app',content:f.content,
      command:{executable:process.execPath,executableSha256,arguments:f.command.argv.slice(1),environment:{}},report:{adapter:'node-tap',files:[]},authorizeCommand:manifest=>manifest.manifestSha256}),
    unit={...raw,start(task){f.control.starts++;return raw.start(task);}},
    amended=f.make({checks:{...f.checks,bindings:[{...f.checks.bindings[0],unit}]}}),input={...f.input,operationId:'accepted-amended-check'};
  assert.equal((await amended.run('phase.checks.run',input)).verdict,'passed');assert.equal(f.control.starts,1);
  const proof=await createNamespacePhaseCheckReader(f.common).accepted(input);assert.equal(proof.plan.schemaVersion,2);assert.equal(proof.plan.testCommands.profile,NAMESPACE_STORY_COMMAND_PROFILE);
  const published=await amended.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});assert.equal(published.status,'published');assert.equal(f.control.starts,1);
  await rm(f.root,{recursive:true,force:true});
  const later=createNamespaceEngine({...f.common,working:undefined,sources:[],clock:{now(){throw Error('Replay cannot manufacture a new command decision time.');}}});
  const retained=await later.run('test-command.request',f.request);assert.deepEqual(retained.record,requested.record);
  assert.equal((await later.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'})).status,'retained');
  assert.equal((await f.observer.inspect()).snapshot.workflow.testCommandDecisions.length,2);
});
test('namespace command inputs and revocation preserve original commands and exact authority',async t=>{
  const f=await fixture(t,'sqlite');
  await assert.rejects(f.engine.run('test-command.request',{...f.request,command:{...f.request.command,command:{...f.command,requirement:'advisory'}}}),{code:'TEST_COMMAND_DECISION_INVALID'});
  await assert.rejects(f.engine.run('test-command.request',{...f.request,command:{...f.request.command,replaces:null}}),{code:'TEST_COMMAND_DECISION_INVALID'});
  await assert.rejects(f.engine.run('test-command.request',{...f.request,command:{...f.request.command,replaces:{id:f.before.id,sha256:'sha256:'+'0'.repeat(64)}}}),{code:'TEST_COMMAND_DECISION_INVALID'});
  await f.engine.run('test-command.request',f.request);f.human();await f.engine.run('test-command.decide',{accept:'TCD-001',reason});
  await f.engine.run('test-command.decide',{revoke:'TCD-001',reason});
  assert.deepEqual((await f.commands.commands((await f.observer.inspect()).snapshot,'intake')).commands,[f.before]);
  await assert.rejects(f.engine.run('test-command.decide',{accept:'TCD-001',reason:'A different attempt cannot revive this revoked command.'}),{code:'TEST_COMMAND_DECISION_CLOSED'});
});
test('command decisions resume a lost acknowledgement without duplicating a request or accepting caller success',async t=>{
  const f=await fixture(t,'sqlite');let interrupted=false;
  const lost=Object.assign(Error('The accepted command receipt acknowledgement was lost.'),{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN'}),
    records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
      if(!interrupted&&tx.operationId.startsWith('lifecycle-')&&tx.changes.some(row=>row.namespace==='state'&&row.key.startsWith('stories/'))){interrupted=true;throw lost;}return result;}},
    engine=f.make({records});
  await assert.rejects(engine.run('test-command.request',{...f.request,ready:true}),{code:'ENGINE_INPUT_INVALID'});
  await assert.rejects(engine.run('test-command.request',f.request),error=>error===lost);assert.equal(interrupted,true);
  const replay=await engine.run('test-command.request',f.request);assert.equal(replay.record.id,'TCD-001');
  const snapshot=(await f.observer.inspect()).snapshot;assert.equal(snapshot.workflow.testCommandDecisions.length,1);assert.equal(f.control.starts,0);
  f.accessControl.creator={name:'Another person',email:'outside@example.test',login:null};
  await assert.rejects(engine.run('test-command.decide',{accept:'TCD-001',reason}),{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});
  assert.deepEqual((await f.observer.inspect()).snapshot,snapshot);
});
test('a retained command cannot hide missing original receipt bytes or silently replace a decision target',async t=>{
  const f=await fixture(t,'sqlite');await f.engine.run('test-command.request',f.request);f.human();await f.engine.run('test-command.decide',{accept:'TCD-001',reason});
  const snapshot=(await f.observer.inspect()).snapshot,reference=snapshot.workflow.namespaceDecisionReceipts.find(row=>row.operation==='test-command.request').record,
    denied=Object.assign(Error('The real original command receipt is unreadable.'),{code:'EACCES',path:'original-command-receipt'}),
    engine=f.make({content:{...f.content,read(scope,ref,options){if(ref.sha256===reference.sha256)throw denied;return f.content.read(scope,ref,options);}}});
  await assert.rejects(engine.run('test-command.context',{phaseId:'intake'}),error=>error===denied);
  await assert.rejects(engine.run('test-command.decide',{accept:'TCD-999',reason}),{code:'TEST_COMMAND_DECISION_UNKNOWN'});
  assert.deepEqual((await f.observer.inspect()).snapshot,snapshot);assert.equal(f.control.starts,0);
});
test('an earlier passing command remains historical evidence and cannot satisfy the amended current draft',async t=>{
  const f=await fixture(t,'sqlite');assert.equal((await f.engine.run('phase.checks.run',f.input)).verdict,'passed');assert.equal(f.control.starts,1);
  await f.engine.run('test-command.request',f.request);f.human();await f.engine.run('test-command.decide',{accept:'TCD-001',reason});f.author();await f.rebase('continue-after-earlier-passing-run');
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),{code:'ENGINE_CHECK_EVIDENCE_REQUIRED'});
  assert.equal((await f.engine.run('phase.checks.run',f.input)).status,'retained');assert.equal(f.control.starts,1);
  assert.equal((await f.observer.inspect()).snapshot.workflow.phases.intake.generation,0);
});
test('test command authority cannot replace person-presence or a recovery agreement with an accepted flag',async t=>{
  const f=await fixture(t,'sqlite'),snapshot=(await f.observer.inspect()).snapshot,actor={identity:{name:'Command reviewer',email:'reviewer@example.test',login:null}},
    owner=f.commands.owners.get('test-command.decide');
  for(const change of [{presence:{status:'required'}},{testRecovery:{enabled:true}}])assert.throws(()=>owner.authority(
    {...snapshot.workflow,resolution:{...snapshot.workflow.resolution,...change}},{phaseId:'intake'},actor),
    error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.required.length===1);
  assert.deepEqual((await f.observer.inspect()).snapshot,snapshot);
});
test('a test-command request cannot replace a configured non-test quality obligation',async t=>{
  const f=await fixture(t,'sqlite',source=>{source.definition.phases.intake.qualityCommands[0].kind='lint';});
  await assert.rejects(f.engine.run('test-command.request',{...f.request,command:{...f.request.command,command:{...f.command,kind:'test'}}}),{code:'TEST_COMMAND_DECISION_INVALID'});
  assert.equal(f.control.starts,0);assert.equal((await f.observer.inspect()).snapshot.workflow.testCommandDecisions,undefined);
});

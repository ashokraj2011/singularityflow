import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceWitnessMappingFixture as fixture} from './helpers/namespace-witness-mapping-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';

for(const backend of ['filesystem','sqlite','application'])test(backend+': exact published mapping approval and original-owner renewal survive shared-only takeover',async t=>{
  const f=await fixture(t,{backend}),before=await f.capture(),ctx=(await f.reviewer.run('test-witness.context',{phaseId:'build'})).manifest;
  assert.deepEqual(await f.capture(),before);assert.equal(ctx.mappings.length,1);assert.equal(ctx.mappings[0].sourcePath,'test/converter.test.js');assert.equal(ctx.approvalRecorded,false);
  const answer={mappingSha256:ctx.mappings[0].mappingSha256,decision:'exception',reason:'Accept the bounded missing boundary facet of this actual passing regression.',
    inadequate:['boundaries'],expiresAt:new Date(f.at()+3600000).toISOString()},input={phaseId:'build',confirmation:f.confirmation,witnessReviewContext:ctx.contextSha256,witnessMappings:[answer]},
    result=await f.reviewer.run('phase.approve',input);
  assert.equal(result.currentPhase,'release');const snapshot=await f.capture(),vote=snapshot.workflow.phases.build.approvals[0],record=await f.json(vote.namespaceVote.record);
  assert.equal(record.profile,'sflow-witness-mapping-approval/v1');assert.equal(vote.witnessMappings[0].decision,'exception');
  assert.equal((await f.reviewer.run('story.evidence')).manifest.report.profile,'sflow-evidence-evaluation/v3');
  await assert.rejects(f.reviewer.run('phase.approve',{...input,witnessMappings:[{...answer,reason:'Changed after the original approval.'}]}),{code:'ENGINE_OPERATION_ID_REUSED'});
  const originalVote=structuredClone(vote),renew={phaseId:'build',mappingSha256:answer.mappingSha256,expires:new Date(f.at()+7200000).toISOString(),reason:'The original phase reviewer renews the exact bounded test adequacy exception.'};
  f.advance(3600001);const expired=(await f.reviewer.run('story.evidence')).manifest.report;
  assert.ok(expired.findings.some(row=>row.code==='EVIDENCE_WITNESS_EXCEPTION_EXPIRED'));
  if(backend==='filesystem'){const listed=(await f.reviewer.run('decisions.list')).manifest;
    assert.equal(listed.policy.items.filter(row=>row.kind==='witness-exception-renewal').length,1);
    assert.ok(listed.actions.some(row=>row.operation==='decision.witness-exception'&&row.inputs.phaseId==='build'));}
  const acknowledged=await f.reviewer.run('decision.witness-exception',renew);assert.equal(acknowledged.record.previousExpiresAt,answer.expiresAt);assert.equal(acknowledged.currentPhase,'release');
  assert.deepEqual((await f.capture()).workflow.phases.build.approvals[0],originalVote);
  const renewed=(await f.reviewer.run('story.evidence')).manifest.report;assert.ok(!renewed.findings.some(row=>row.code==='EVIDENCE_WITNESS_EXCEPTION_EXPIRED'));
  const head=await f.head(),takeover=f.make({working:null,sources:[],sourceReaders:[],checks:{mode:'retained-only'},repairs:{mode:'retained-only'},clock:{now(){throw Error('Receipt replay cannot allocate time.');}}}),
    replay=await takeover.run('decision.witness-exception',renew);assert.deepEqual(replay.record,acknowledged.record);assert.equal(replay.status,'retained');assert.equal(replay.effects.committed,false);assert.deepEqual(await f.head(),head);
});

test('two repositories with identical local filenames keep distinct original mapping identities',async t=>{
  const plan=planText.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`')
    .replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')
    +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | `frontend` |\n| service-1 | `backend` |\n',
    f=await fixture(t,{repositories:2,plan}),ctx=(await f.reviewer.run('test-witness.context',{phaseId:'build'})).manifest;
  assert.deepEqual(ctx.mappings.map(row=>row.sourcePath).sort(),['backend/test/converter.test.js','frontend/test/converter.test.js']);
  assert.equal(new Set(ctx.mappings.map(row=>row.mappingSha256)).size,2);
  await f.reviewer.run('phase.approve',{phaseId:'build',confirmation:f.confirmation,witnessReviewContext:ctx.contextSha256});
  assert.equal((await f.capture()).workflow.phases.build.approvals[0].witnessMappings.length,2);
  assert.ok(!JSON.stringify(ctx).includes(f.directory));
});

test('lost renewal acknowledgements preserve the original error and reconcile one original decision',async t=>{
  const f=await fixture(t),ctx=(await f.reviewer.run('test-witness.context',{phaseId:'build'})).manifest,mappingSha256=ctx.mappings[0].mappingSha256;
  await f.reviewer.run('phase.approve',{phaseId:'build',confirmation:f.confirmation,witnessReviewContext:ctx.contextSha256,witnessMappings:[{mappingSha256,decision:'exception',
    reason:'Accept only the explicitly reviewed boundary inadequacy.',inadequate:['boundaries'],expiresAt:new Date(f.at()+3600000).toISOString()}]});
  const request={phaseId:'build',mappingSha256,expires:new Date(f.at()+7200000).toISOString(),reason:'Renew the same exact exception under the original human authority.'},
    failure=Object.freeze(Object.assign(Error('Original accepted-renewal reply deadline.'),{code:'ETIMEDOUT',details:{deadlineMs:741}}));let lost=false;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!lost&&args[1].events.some(row=>row.payload?.operation==='decision.witness-exception')){lost=true;throw failure;}return result;}};
  await assert.rejects(f.make({records}).run('decision.witness-exception',request),error=>error===failure);assert.equal(lost,true);
  const before=await f.capture(),result=await f.make({working:null}).run('decision.witness-exception',request);
  assert.equal(result.status,'retained');assert.equal(result.effects.committed,false);assert.equal(before.workflow.namespaceWitnessExceptionRenewals.length,1);assert.deepEqual(await f.capture(),before);
});

test('mapping exceptions cannot be renewed before an actual approval or by an unrelated identity',async t=>{
  const f=await fixture(t),ctx=(await f.reviewer.run('test-witness.context',{phaseId:'build'})).manifest,mappingSha256=ctx.mappings[0].mappingSha256,
    request={phaseId:'build',mappingSha256,expires:new Date(f.at()+7200000).toISOString(),reason:'Renew only an actual prior approved mapping exception.'};
  await assert.rejects(f.reviewer.run('decision.witness-exception',request),{code:'WITNESS_EXCEPTION_UNKNOWN'});
  await f.reviewer.run('phase.approve',{phaseId:'build',confirmation:f.confirmation,witnessReviewContext:ctx.contextSha256,witnessMappings:[{mappingSha256,decision:'exception',
    reason:'Human review of the bounded boundary inadequacy.',inadequate:['boundaries'],expiresAt:new Date(f.at()+3600000).toISOString()}]});
  const before=await f.head(),other=f.make({access:{current:()=>({projectId:f.scope.projectId,principalId:'unrelated',actorKind:'human',agentId:null,
    identity:{name:'Unrelated reviewer',email:'unrelated@example.test',login:null},permissions:['decision.witness-exception']})}});
  await assert.rejects(other.run('decision.witness-exception',request),error=>['APPROVAL_AUTHORITY_REQUIRED','APPROVAL_IDENTITY_NOT_AUTHORIZED'].includes(error.code));assert.deepEqual(await f.head(),before);
});
test('mapping context, human authority, unknown mappings and original I/O errors retain explicit refusals',async t=>{
  const f=await fixture(t),ctx=(await f.reviewer.run('test-witness.context',{phaseId:'build'})).manifest,before=await f.head();
  await assert.rejects(f.reviewer.run('phase.approve',{phaseId:'build',confirmation:f.confirmation,witnessReviewContext:'sha256:'+'0'.repeat(64)}),{code:'WEL_WITNESS_MAPPING_STALE'});
  await assert.rejects(f.reviewer.run('phase.approve',{phaseId:'build',confirmation:f.confirmation,witnessReviewContext:ctx.contextSha256,
    witnessMappings:[{mappingSha256:'sha256:'+'0'.repeat(64),decision:'satisfied'}]}),{code:'WEL_WITNESS_MAPPING_UNREVIEWED'});
  f.allowed(false);await assert.rejects(f.reviewer.run('test-witness.context',{phaseId:'build'}),{code:'ENGINE_AUTHORITY_REQUIRED'});f.allowed(true);
  assert.deepEqual(await f.head(),before);
  const original=Object.freeze(Object.assign(Error('The original evidence read timed out.'),{code:'ETIMEDOUT'})),content={...f.content,read(){throw original;}};
  await assert.rejects(f.make({content}).run('test-witness.context',{phaseId:'build'}),error=>error===original);
});

test('a second independent human carries the first exact mapping exception while satisfying the real quorum',async t=>{
  const f=await fixture(t,{configure:source=>{source.definition.phases.build.approval.minimum=2;
    source.definition.approvalAuthorities.reviewers.members.push({email:'second-independent@example.test'});}}),
    ctx=(await f.reviewer.run('test-witness.context',{phaseId:'build'})).manifest,mappingSha256=ctx.mappings[0].mappingSha256,
    answer={mappingSha256,decision:'exception',reason:'The first reviewer acknowledges this exact bounded inadequacy.',inadequate:['boundaries'],expiresAt:new Date(f.at()+3600000).toISOString()},
    input={phaseId:'build',confirmation:f.confirmation,witnessReviewContext:ctx.contextSha256};
  const first=await f.reviewer.run('phase.approve',{...input,witnessMappings:[answer]});assert.equal(first.approval.thresholdReached,false);assert.equal(first.currentPhase,'build');
  const next=f.make({access:{current:()=>({projectId:f.scope.projectId,principalId:'second-independent',actorKind:'human',agentId:null,
    identity:{name:'Second independent reviewer',email:'second-independent@example.test',login:null},permissions:['phase.approve']})}}),second=await next.run('phase.approve',input);
  assert.equal(second.approval.thresholdReached,true);assert.equal(second.currentPhase,'release');
  const row=(await f.capture()).workflow.phases.build.approvals.at(-1).witnessMappings[0];assert.equal(row.decision,'exception');assert.equal(row.source,'carried-forward');assert.equal(row.reason,answer.reason);
});

test('an exception which expires between approval preparation and commit cannot be accepted',async t=>{
  const f=await fixture(t),ctx=(await f.reviewer.run('test-witness.context',{phaseId:'build'})).manifest,before=await f.head();let ticks=0;
  const moving=f.make({clock:{now:()=>new Date(f.at()+(++ticks===1?0:7200000)).toISOString()}});
  await assert.rejects(moving.run('phase.approve',{phaseId:'build',confirmation:f.confirmation,witnessReviewContext:ctx.contextSha256,
    witnessMappings:[{mappingSha256:ctx.mappings[0].mappingSha256,decision:'exception',reason:'Only a still-current exception is eligible for this human vote.',inadequate:['boundaries'],expiresAt:new Date(f.at()+3600000).toISOString()}]}),{code:'WEL_WITNESS_MAPPING_UNREVIEWED'});
  assert.deepEqual(await f.head(),before);
});

test('the actual closing vote checks renewed upstream exceptions without rewriting earlier approvals',async t=>{
  const f=await fixture(t,{storyText:'# Request\n\nConvert the selected integer into hexadecimal.\n',configure:source=>{Object.assign(source.definition.phases.release,
    {artifact:{path:'artifacts/release/evidence.md',kind:'test-evidence'},writeScope:'artifact-only',testEvidenceFrom:'build'});}}),ctx=(await f.reviewer.run('test-witness.context',{phaseId:'build'})).manifest,
    mappingSha256=ctx.mappings[0].mappingSha256;
  await f.reviewer.run('phase.approve',{phaseId:'build',confirmation:f.confirmation,witnessReviewContext:ctx.contextSha256,witnessMappings:[{mappingSha256,decision:'exception',
    reason:'The original reviewer accepts this bounded boundary-test adequacy gap.',inadequate:['boundaries'],expiresAt:new Date(f.at()+3600000).toISOString()}]});
  const inventory=(await f.reviewer.run('scope.context')).manifest.inventory;let n=0;
  for(const item of inventory.items.filter(row=>row.disposition==='unresolved'))await f.reviewer.run('decision.scope',{operationId:'close-mapping-scope-'+(++n),
    item:item.id,disposition:'included',clauseIds:['STORY-1:REQ-001','STORY-1:AC-001'],reason:'These exact approved clauses carry the original converter requirement.'});
  await f.engine.run('phase.prepare',{phaseId:'release'});const draft=(await f.engine.run('phase.draft.read',{phaseId:'release'})).manifest.draft;
  await f.engine.run('phase.draft.write',{operationId:'mapping-release-content',workId:f.inputs.workId,phaseId:'release',expectedRevision:draft.revision,
    content:await f.upload('# Release review\n\n## Agent brief\n\nThe approved converter and exact executed regression are retained; the original bounded test adequacy exception is disclosed.\n'),reason:'Retain the actual final review over the original delivery.'});
  try{await f.engine.run('phase.publish',{phaseId:'release',authored:'governed-agent',channel:'copilot-host'});}catch(error){t.diagnostic(JSON.stringify(error.details));throw error;}
  await f.engine.run('phase.submit',{phaseId:'release'});
  const review=(await f.reviewer.run('phase.review',{phaseId:'release'})).manifest.reviewBinding,confirmation={workId:f.inputs.workId,phase:'release',generation:review.generation,reviewPacketSha256:review.packetSha256};
  f.advance(3600001);const before=await f.head();await assert.rejects(f.reviewer.run('phase.approve',{phaseId:'release',confirmation}),error=>error.code==='ENGINE_TERMINAL_EVIDENCE_REQUIRED'
    &&error.details.rows.some(row=>row.id==='STORY-1:AC-001'));assert.deepEqual(await f.head(),before);
  await f.reviewer.run('decision.witness-exception',{phaseId:'build',mappingSha256,expires:new Date(f.at()+3600000).toISOString(),reason:'The original human reviewer renews the disclosed test inadequacy for final acceptance.'});
  const renewedHead=await f.head();let ticks=0;
  await assert.rejects(f.make({clock:{now:()=>new Date(f.at()+(++ticks===1?0:7200000)).toISOString()}}).run('phase.approve',{phaseId:'release',confirmation}),{code:'ENGINE_TERMINAL_EVIDENCE_REQUIRED'});
  assert.deepEqual(await f.head(),renewedHead);
  try{await f.reviewer.run('phase.approve',{phaseId:'release',confirmation});}catch(error){t.diagnostic(JSON.stringify(error.details));throw error;}
  const snapshot=await f.capture();assert.equal(snapshot.workflow.status,'closed');assert.equal(snapshot.workflow.namespaceWitnessExceptionRenewals.length,1);
  const closed=(await f.reviewer.run('story.evidence')).manifest.report;assert.equal(closed.decision.gate,'allow-with-risk');assert.equal(closed.completion.kind,'complete-with-exceptions');
});

for(const mode of ['routed','terminal','routed-terminal'])test(mode+': exact mapping votes retain their own version and original accepted receipt',async t=>{
  const terminal=mode!=='routed',routed=mode!=='terminal',f=await fixture(t,{storyText:'# Request\n\nConvert the selected integer into hexadecimal.\n',
    ...(routed?{submissionValues:{ready:'Pass'}}:{}),configure:source=>{
      if(terminal)source.definition.workTypes.simple.phases=['intake','design','build'];
      if(routed)source.definition.workTypes.simple.decisions=[{id:'code-complete',label:'Review the completed Code',kind:'branch',after:'build',inputs:[{name:'ready',values:['Pass','Review']}],
        routes:[{id:'complete',label:'Completed',when:{ready:'Pass'},to:terminal?'end':'release'},
          {id:'review',label:'Reviewed',to:terminal?'end':'release'}]}];
    }}),ctx=(await f.reviewer.run('test-witness.context',{phaseId:'build'})).manifest;
  if(terminal){const inventory=(await f.reviewer.run('scope.context')).manifest.inventory;let i=0;
    for(const item of inventory.items.filter(row=>row.disposition==='unresolved'))await f.reviewer.run('decision.scope',{operationId:'terminal-code-scope-'+(++i),item:item.id,
      disposition:'included',clauseIds:['STORY-1:REQ-001','STORY-1:AC-001'],reason:'The original human reviewer confirms these exact approved converter clauses carry the request.'});}
  const input={phaseId:'build',confirmation:f.confirmation,witnessReviewContext:ctx.contextSha256,witnessMappings:[{mappingSha256:ctx.mappings[0].mappingSha256,
    decision:'exception',reason:'The human reviewer accepts this exact bounded boundary-test inadequacy.',inadequate:['boundaries'],expiresAt:new Date(f.at()+3600000).toISOString()}]},
    approved=await f.reviewer.run('phase.approve',input),snapshot=await f.capture(),vote=snapshot.workflow.phases.build.approvals.at(-1),value=await f.json(vote.namespaceVote.record);
  assert.equal(value.schemaVersion,terminal?routed?9:8:7);assert.equal(approved.currentPhase,terminal?null:'release');
  if(terminal){assert.equal(snapshot.workflow.status,'closed');assert.ok(value.terminalEvidence);
    assert.equal((await f.reviewer.run('story.evidence')).manifest.report.completion.kind,'complete-with-exceptions');}
  const replay=await f.make({working:null,sources:[],clock:{now(){throw Error('An accepted exact mapping vote needs no current time.');}}}).run('phase.approve',input);
  assert.deepEqual(replay,approved);assert.deepEqual(await f.capture(),snapshot);
});

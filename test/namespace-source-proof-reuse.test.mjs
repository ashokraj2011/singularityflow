import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceSourceClauseFixture} from './helpers/namespace-source-clause-fixture.mjs';
import {createNamespaceReadSession} from '../src/engine-storage/namespace-read-session.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceSourceRetentionReader} from '../src/engine-storage/namespace-source-retention-reader.mjs';
test('accepted source proof reuse preserves actual receipts, private copies, parser admission and distinct read-port failures',{timeout:60000},async t=>{
  const f=await namespaceSourceClauseFixture(t),session=createNamespaceReadSession(f.common),observer=createNamespaceStoryObserver({...f.common,records:session.records,content:session.content});
  let inspections=0;const records={...observer.evidenceReads.records,refusal:null,inspectOperation(...args){inspections++;if(this.refusal)throw this.refusal;return observer.evidenceReads.records.inspectOperation(...args);}},
    options={...observer.evidenceReads,records,observer},reader=createNamespaceSourceRetentionReader(options),other=createNamespaceSourceRetentionReader(options),
    input={operationId:'clause-current-bytes',workId:f.inputs.workId,phaseId:'build'},
    denied=Object.assign(Error('The original source receipt has an actual permission failure.'),{code:'EACCES',details:{operationId:'clause-current-bytes'}});
  await session.run(async()=>{const first=await reader.accepted(input);assert.equal(reader.isAccepted(first),true);const count=inspections;assert.ok(count>=2);
    first.plan.input.phaseId='forged-phase';assert.equal(reader.isAccepted(first),false);
    const second=await other.accepted(input);assert.equal(second.plan.input.phaseId,'build');assert.equal(other.isAccepted(second),true);assert.equal(inspections,count);
    const different=createNamespaceSourceRetentionReader({...options,records:{...records,refusal:denied}});
    await assert.rejects(different.accepted(input),error=>error===denied);
    const copied=createNamespaceSourceRetentionReader({...options,observer:{...observer,record(){throw denied;}}});
    await assert.rejects(copied.accepted(input),error=>error===denied);
    const pending={...input,operationId:'later-source-result'};assert.equal(await reader.accepted(pending),null);
    await f.engine.run('phase.source.retain',pending);const completed=await reader.accepted(pending);assert.equal(completed.plan.input.operationId,pending.operationId);assert.equal(reader.isAccepted(completed),true);
  });
  const before=inspections;await session.run(()=>reader.accepted(input));assert.ok(inspections>before);
  const timeout=Object.assign(Error('The real source receipt exceeded its deadline.'),{code:'ETIMEDOUT',details:{deadlineMs:1234}});records.refusal=timeout;
  await assert.rejects(session.run(()=>reader.accepted(input)),error=>error===timeout);
});

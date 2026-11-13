import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import * as native from '../src/evidence-reuse.mjs';
import {evidenceReuseValueCases} from './helpers/evidence-reuse-values-fixture.mjs';
import {evidenceReuseExpiry,evidenceReuseReason,namespaceEvidenceReuseState,namespaceEvidenceReusePhase} from '../src/kernel/evidence-reuse.mjs';
test('native reason, expiry and revocation outputs preserve the independently captured original implementation',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/evidence-reuse-values/native-v1.json',import.meta.url),'utf8'));
  assert.equal(fixture.capturedFrom,'70876ea3c:src/evidence-reuse.mjs');assert.equal(fixture.cases.length,24);
  for(const [index,row]of evidenceReuseValueCases(native).entries())assert.deepEqual(row,fixture.cases[index],row.name);
});
test('pure reuse helpers take explicit time and lifecycle status cannot claim a source match',()=>{
  assert.equal(evidenceReuseReason('  A reviewed reason of at least twenty characters.  '),'A reviewed reason of at least twenty characters.');
  assert.equal(evidenceReuseExpiry('2026-10-02','2026-10-01T12:00:00.000Z'),'2026-10-02T23:59:59.999Z');
  const decision={id:'ERU-001',producer:{phase:'build',generation:1},expiresAt:'2026-10-02T23:59:59.999Z'},workflow={phases:{build:{status:'approved',generation:1}}};
  assert.equal(namespaceEvidenceReuseState(workflow,decision,{at:'2026-10-01T12:00:00.000Z'}),'active');
  assert.equal(namespaceEvidenceReuseState(workflow,decision,{at:'2026-10-03T12:00:00.000Z'}),'expired');
  assert.equal(namespaceEvidenceReuseState({...workflow,namespaceEvidenceReuses:[{revokes:'ERU-001'}]},decision,{at:'2026-10-01T12:00:00.000Z'}),'revoked');
  assert.equal(namespaceEvidenceReuseState({phases:{build:{status:'in_progress',generation:1}}},decision,{at:'2026-10-01T12:00:00.000Z'}),'superseded');
  assert.throws(()=>namespaceEvidenceReuseState(workflow,decision,{}),{code:'ENGINE_INPUT_INVALID'});
  for(const [writeScope,recovery,owner]of [['source-and-artifact',false,'code-execution-reuse'],['artifact-only',true,'test-recovery-cohort-reuse']])
    assert.throws(()=>namespaceEvidenceReusePhase({workItem:{id:'example'},phases:{assess:{id:'assess',writeScope}},resolution:{testRecovery:{enabled:recovery}}},'assess'),
      error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.required.includes(owner));
});

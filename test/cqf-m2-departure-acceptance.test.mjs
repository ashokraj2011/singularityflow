/**
 * CQF M2: which existing record accepts each kind of departure [CQF:REQ-025]. A departure gets no record
 * of acceptance of its own: the plan amendment, plan row correction, forward amendment or intent amendment
 * that already exists for its kind accepts it, under that record's own authority. Pure.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEPARTURE_RECORDS, departureAcceptance, departureStatus, recordDeparture } from '../src/departures.mjs';

const AT = '2026-11-08T08:00:00.000Z';
const LATER = '2026-11-08T09:00:00.000Z';
const story = () => ({ workItem: { id: 'W-1' } });

test('each kind is accepted by the record that already exists for it, and a fix on the way by its own [CQF:REQ-066]', () => {
  assert.deepEqual(DEPARTURE_RECORDS, { path: 'plan-amendment', supporting: 'plan-amendment', 'plan-row': 'plan-row-correction',
    test: 'plan-row-correction', wording: 'forward-amendment', clause: 'intent-amendment', finding: 'departure-acceptance' });
});

test('a planned test change is accepted by a plan row correction that asks for its exact change after it was recorded', () => {
  const workflow = story();
  const departure = recordDeparture(workflow, { kind: 'test', phase: 'code', generation: 1, change: { op: 'add-test', clauseId: 'W-1:REQ-001', test: 't/format.test.mjs' },
    clauses: ['W-1:REQ-001'], reason: 'A format test the plan did not list.', at: AT });
  workflow.planRowCorrections = [{ id: 'PRC-001', at: '2026-11-08T07:00:00.000Z', operations: [{ op: 'add-test', clauseId: 'W-1:REQ-001', test: 't/format.test.mjs', previousClaimSha256: 'a'.repeat(64) }] }];
  assert.equal(departureAcceptance(workflow, departure), null, 'a correction made before the departure answered something else');
  workflow.planRowCorrections.push({ id: 'PRC-002', at: LATER, operations: [{ op: 'add-test', clauseId: 'W-1:REQ-001', test: 't/other.test.mjs', previousClaimSha256: 'a'.repeat(64) }] });
  assert.equal(departureAcceptance(workflow, departure), null, 'another test is another change');
  workflow.planRowCorrections.push({ id: 'PRC-003', at: LATER, operations: [{ op: 'add-test', clauseId: 'W-1:REQ-001', test: 't/format.test.mjs', previousClaimSha256: 'b'.repeat(64) }] });
  assert.deepEqual([departureAcceptance(workflow, departure).kind, departureAcceptance(workflow, departure).id], ['plan-row-correction', 'PRC-003']);
  assert.equal(departureStatus(workflow, departure).status, 'accepted');
});

test('wording is accepted when the forward amendment proposed from it is approved, and a clause when its intent amendment is', () => {
  const workflow = story();
  const wording = recordDeparture(workflow, { kind: 'wording', phase: 'code', generation: 1, target: { phase: 'design', generation: 1 }, reason: 'The design said callers never keep a copy.', at: AT });
  workflow.forwardAmendments = [{ id: 'FAM-001', phase: 'design', departure: wording.id }];
  assert.equal(departureStatus(workflow, wording).status, 'open', 'proposed is not decided');
  workflow.forwardAmendmentDecisions = [{ amendment: 'FAM-001', decision: 'rejected', at: LATER }];
  assert.equal(departureStatus(workflow, wording).status, 'open', 'a rejected amendment accepts nothing');
  workflow.forwardAmendmentDecisions.push({ amendment: 'FAM-001', decision: 'approved', at: LATER });
  assert.equal(departureStatus(workflow, wording).status, 'accepted');
  const clause = recordDeparture(workflow, { kind: 'clause', phase: 'code', generation: 1, target: { phase: 'intake', generation: 1 }, clauses: ['W-1:REQ-002'],
    reason: 'The clause must allow a cached value for one request.', at: AT });
  workflow.intentAmendments = [{ id: 'AMD-001', status: 'proposed', departure: clause.id }];
  assert.equal(departureStatus(workflow, clause).status, 'open');
  workflow.intentAmendments[0].status = 'approved';
  assert.equal(departureStatus(workflow, clause).status, 'accepted');
});

test('a withdrawn plan amendment accepts nothing, so its files are asked again', () => {
  const workflow = story();
  const departure = recordDeparture(workflow, { kind: 'supporting', phase: 'code', generation: 1, paths: ['.nvmrc'], supportingClass: 'build-configuration',
    contentHashes: { '.nvmrc': 'h' }, reason: 'The tests run on Node 22, which the repository now pins.', at: AT });
  workflow.planAmendments = [{ id: 'PAM-001', changes: [{ kind: 'add-supporting', path: '.nvmrc', class: 'build-configuration' }], departures: [departure.id], contentHashes: { '.nvmrc': 'h' }, at: LATER, withdrawnAt: LATER }];
  assert.equal(departureStatus(workflow, departure, { '.nvmrc': 'h' }).status, 'open');
  delete workflow.planAmendments[0].withdrawnAt;
  assert.equal(departureStatus(workflow, departure, { '.nvmrc': 'h' }).status, 'accepted');
});

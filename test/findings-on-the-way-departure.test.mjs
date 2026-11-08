/**
 * CQF:REQ-066: a findings register item fixed on the way is a `finding` departure. Pure: its record,
 * how its acceptance and rejection are read, and what the decision list offers for it. Made-up IDs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptAllEligible, DEPARTURE_RECORDS, departureCandidatePaths, departureStatus, departureWords, recordDeparture, recordDepartureAcceptance,
  recordDepartureRejection, rejectedDeparturePaths
} from '../src/departures.mjs';

const AT = '2026-11-08T08:00:00.000Z';
const LATER = '2026-11-08T09:00:00.000Z';
const story = () => ({ workItem: { id: 'W-1' }, history: [] });
const fix = (workflow, fields = {}) => recordDeparture(workflow, { kind: 'finding', phase: 'code', generation: 1, paths: ['src/search.mjs'],
  contentHashes: { 'src/search.mjs': 'fixed' }, baseHashes: { 'src/search.mjs': 'base' }, findings: ['SEC-101'],
  reason: 'Fixes SEC-101 from the findings register on a file this Story touches.', at: AT, ...fields });
const person = { actor: 'reviewer', authorityGroup: 'planners', at: LATER };

test('a fix on the way names its files and the register items it fixes, and is accepted with "Accept all"', () => {
  const workflow = story();
  const departure = fix(workflow);
  assert.equal(departure.id, 'DEP-001');
  assert.deepEqual(departure.findings, ['SEC-101']);
  assert.equal(DEPARTURE_RECORDS.finding, 'departure-acceptance', 'its acceptance is its own record: the plan already names the file');
  assert.equal(acceptAllEligible(departure), true, 'it changes files and no clause');
  assert.equal(departureWords(departure), 'src/search.mjs carries the fix for SEC-101 from the findings register');
  assert.deepEqual(departureCandidatePaths(workflow, 'code'), ['src/search.mjs'], 'publication carries its file');
  assert.throws(() => fix(story(), { findings: [] }), /names the findings register item it fixes with --finding/u);
  assert.throws(() => fix(story(), { paths: [] }), /names the file it changes with --path/u);
  assert.throws(() => fix(story(), { findings: ['not an id'] }), /each by its ID/u);
});

test('accepted by a person\'s own record that binds what its files hold; a later edit reopens it', () => {
  const workflow = story();
  const departure = fix(workflow);
  assert.equal(departureStatus(workflow, departure, { 'src/search.mjs': 'fixed' }).status, 'open');
  const record = recordDepartureAcceptance(workflow, { departures: ['DEP-001'], reason: 'The parameterised query is the right fix here.', hashes: { 'src/search.mjs': 'fixed' }, ...person });
  assert.deepEqual([record.id, record.decision], ['DDC-001', 'accepted']);
  const accepted = departureStatus(workflow, departure, { 'src/search.mjs': 'fixed' });
  assert.deepEqual([accepted.status, accepted.acceptance.kind, accepted.acceptance.id], ['accepted', 'departure-acceptance', 'DDC-001']);
  assert.equal(departureStatus(workflow, departure, { 'src/search.mjs': 'edited again' }).status, 'reopened');
});

test('a rejected fix holds until it is taken out, even from a file that also carries planned work', () => {
  const workflow = story();
  const departure = fix(workflow);
  recordDepartureRejection(workflow, { departures: ['DEP-001'], reason: 'Fix this one with the security team, not here.', hashes: { 'src/search.mjs': 'fixed' }, ...person });
  assert.equal(departureStatus(workflow, departure, { 'src/search.mjs': 'fixed' }).status, 'rejected', 'the file still holds the fix');
  assert.equal(departureStatus(workflow, departure, { 'src/search.mjs': 'planned work only' }).status, 'reverted', 'the fix is out; the planned work stays');
  assert.equal(departureStatus(workflow, departure, { 'src/search.mjs': 'base' }).status, 'reverted');
  assert.deepEqual(departureCandidatePaths(workflow, 'code'), [], 'its own claim on the file goes; the plan\'s stays');
  assert.deepEqual([...rejectedDeparturePaths(workflow, 'code').keys()], ['src/search.mjs']);
});

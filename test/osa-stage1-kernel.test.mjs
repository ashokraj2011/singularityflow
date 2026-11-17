/**
 * SPEC-OSA v1.1 Stage 1: the pure decision owner (src/kernel/step-state.mjs) against independent expectations
 * [OSA:REQ-001, REQ-002, REQ-004, REQ-005, AC-004, AC-005, AC-007, AC-009].
 *
 * The expected values live in test/fixtures/osa/stage1-golden.json and test/fixtures/osa/incidents.json, written by hand
 * from the specification. This file builds every snapshot with its own reader of those facts (`snapshotOf` below): it
 * imports the kernel under test and nothing else from src/ to build or judge a case.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as kernel from '../src/kernel/step-state.mjs';

const { stepState } = kernel;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const golden = json('test/fixtures/osa/stage1-golden.json');
const incidents = json('test/fixtures/osa/incidents.json');

const CAPABILITIES = { code: ['step-artifacts', 'application'], document: ['step-artifacts'], 'kernel-document': [] };

/** One step's facts as StepSnapshot/v1 `step`, read from the fixture's record-like form (section 4.1). */
function stepOf(facts) {
  if (!facts) return null;
  const review = facts.review === undefined || facts.review === null ? { status: 'not-created', generation: null }
    : facts.review === 'unavailable' ? { status: 'unavailable', generation: null }
      : { status: facts.review.status ?? facts.review.retained, generation: facts.review.generation ?? null };
  return { id: facts.phase, status: facts.status ?? 'in_progress', versionRequired: facts.versionRequired !== false,
    published: facts.generation === undefined ? 0 : facts.generation,
    ...(facts.generationHighWatermark === null || facts.generationHighWatermark === undefined ? {} : { recordedHighWatermark: facts.generationHighWatermark }),
    opening: facts.generationIntent ? { status: facts.generationIntent.status, version: facts.generationIntent.generation } : null,
    publicationRecorded: (facts.generation ?? 0) >= 1, rework: facts.rework === undefined ? null : { version: facts.rework },
    amendment: null, rejection: facts.rejected ? { rewritten: false } : null, authorConflict: facts.authorConflict === true, changeRequestOpen: false,
    intentAmendmentPending: false,
    kind: { executionOwner: facts.kind === 'kernel-document' ? 'kernel' : 'agent', code: facts.kind === 'code',
      changeCapabilities: facts.producers?.includes('deterministic') ? [] : CAPABILITIES[facts.kind] },
    pause: facts.pause ? { id: facts.pause } : null, holds: facts.holds ?? [],
    review: { required: facts.reviewRequired !== false, status: review.status, version: review.generation }, damage: null };
}

/** StepSnapshot/v1 for a golden case (the fixture's defaults written out). */
function snapshotOf(entry, { phaseOrder = golden.phaseOrder } = {}) {
  const facts = entry.facts;
  const currentPhaseId = 'currentPhase' in entry ? entry.currentPhase : 'implementation';
  const requestedPhaseId = entry.requestedPhase ?? facts.phase;
  const sources = { lifecycle: { status: 'verified' }, configuration: { status: 'verified' },
    review: { status: facts.review === 'unavailable' ? 'unavailable' : facts.review ? 'verified' : 'not-created' } };
  for (const [name, status] of Object.entries(entry.sources ?? {})) sources[name] = { status, diagnostic: `${name} ${status} in the fixture` };
  return { schemaVersion: 1, record: { family: 'story-workflow', version: entry.recordVersion ?? 13 },
    subject: { projectId: null, workId: entry.workId ?? 'ST-1', requestedPhaseId, currentPhaseId },
    basis: { lifecycleRevision: 'rev-1', configurationRevision: 'cfg-1' }, sources,
    story: { status: entry.storyStatus ?? (currentPhaseId ? 'active' : 'complete'), phaseOrder, pendingDecision: entry.pendingDecision ? { id: entry.pendingDecision } : null },
    step: stepOf(facts), current: stepOf(entry.current ?? null),
    actor: { principalKind: 'agent', role: entry.actor?.role ?? 'author', turnMode: entry.actor?.turnMode ?? 'authoring', permissionsRevoked: entry.actor?.permissionsRevoked === true } };
}

/** The expected next action is a subset of the decision's: every key written in the fixture must match. */
function assertNext(actual, expected, where) {
  for (const key of ['kind', 'operation', 'principalKind', 'role']) if (key in expected) assert.equal(actual[key], expected[key], `${where}: next.${key}`);
  if ('target' in expected) {
    assert.equal(actual.target?.phase, expected.target.phase, `${where}: target phase`);
    assert.equal(actual.target?.version ?? null, expected.target.version ?? null, `${where}: target version`);
  }
  for (const [key, value] of Object.entries(expected.inputs ?? {})) assert.deepEqual(actual.inputs[key], value, `${where}: inputs.${key}`);
  if ('then' in expected) assert.deepEqual(actual.then, expected.then, `${where}: then`);
  for (const code of expected.reasonCodes ?? []) assert.ok(actual.reasonCodes.includes(code), `${where}: reason ${code} in ${actual.reasonCodes}`);
  if ('prerequisites' in expected) assert.deepEqual(actual.prerequisites, expected.prerequisites, `${where}: prerequisites`);
}

function assertDecision(decision, expected, where) {
  assert.equal(decision.state, expected.state, `${where}: state (${JSON.stringify(decision.next.reasonCodes)})`);
  if (expected.version) assert.deepEqual(decision.version, expected.version, `${where}: version`);
  if (expected.publication) assert.deepEqual(decision.publication, expected.publication, `${where}: publication`);
  if (expected.edit) {
    assert.equal(decision.edit.eligible, expected.edit.eligible, `${where}: edit.eligible`);
    if (expected.edit.categories) assert.deepEqual([...decision.edit.permittedCategories].sort(), [...expected.edit.categories].sort(), `${where}: categories`);
  }
  assertNext(decision.next, expected.next, where);
}

/** StepDecision/v1's exact shape: every field present, with its type and enumeration [section 4.2 schema]. */
function assertShape(decision, where) {
  assert.deepEqual(Object.keys(decision).sort(), ['basis', 'edit', 'kind', 'next', 'obligations', 'publication', 'schemaVersion',
    'state', 'subject', 'task', 'turn', 'version'], where);
  assert.equal(decision.schemaVersion, kernel.DECISION_SCHEMA_VERSION, where);
  assert.ok(kernel.STEP_STATES.includes(decision.state), `${where}: ${decision.state}`);
  assert.deepEqual(Object.keys(decision.subject).sort(), ['currentPhaseId', 'projectId', 'requestedPhaseId', 'workId'], where);
  for (const field of ['lifecycleRevision', 'authorityEpoch', 'configurationRevision', 'publicationDigest', 'reviewDigest', 'openVersionReceiptId',
    'workingObservationId', 'principalBinding', 'capabilityRevision', 'executionRevision', 'decisionSnapshotId', 'freshness', 'differences']) {
    assert.ok(field in decision.basis, `${where}: basis.${field}`);
  }
  for (const value of Object.values(decision.version)) assert.ok(value === null || (Number.isSafeInteger(value) && value >= 0), `${where}: version ${value}`);
  for (const value of Object.values(decision.publication)) assert.ok(value === null || typeof value === 'boolean', where);
  const { next } = decision;
  assert.ok(kernel.ACTION_KINDS.includes(next.kind), `${where}: kind ${next.kind}`);
  assert.ok(kernel.OPERATIONS.includes(next.operation), `${where}: operation ${next.operation}`);
  assert.ok(kernel.PRINCIPAL_KINDS.includes(next.principalKind), where);
  assert.ok(kernel.ROLES.includes(next.role), where);
  assert.ok(Array.isArray(next.prerequisites) && Array.isArray(next.reasonCodes) && Array.isArray(next.then), where);
  for (const code of [...next.reasonCodes, ...decision.edit.reasons]) assert.ok(kernel.REASON_CODES.includes(code) || /^[A-Z][A-Z0-9_]+$/u.test(code), `${where}: ${code}`);
  for (const operation of next.then) assert.ok(kernel.OPERATIONS.includes(operation), where);
  assert.ok(decision.edit.permittedCategories.every((entry) => kernel.EDIT_CATEGORIES.includes(entry)), where);
  assert.equal(decision.edit.eligible, decision.edit.permittedCategories.length > 0, `${where}: eligible means a category`);
  // A person's consent, decision or approval is a human principal's; an agent's work an agent's [section 4.2].
  if (/^person-/u.test(next.kind)) assert.equal(next.principalKind, 'human', where);
  if (next.kind === 'agent-work' || next.kind === 'review') assert.equal(next.principalKind, 'agent', where);
  // The kernel returns no shell string, skill name, question wording or prompt [OSA:REQ-021].
  assert.doesNotMatch(JSON.stringify(decision), /singularity-flow |\/sf-|\/sflow-|\?"/u, where);
}

// ---------------------------------------------------------------------------------------------------- golden fixtures

test('Stage 1 golden fixtures: every case decides as the specification says [OSA:REQ-001, REQ-005]', () => {
  assert.equal(golden.cases.length, 40);
  const covered = golden.cases.map((entry) => entry.covers).join('\n');
  // The plan's qualification list, each covered by at least one case (plan section 3).
  for (const topic of [/open successor with publication history/u, /no prior publication/u, /future-phase inspection/u, /last phase/u,
    /submitted work/u, /hold/u, /missing facts/u]) assert.match(covered, topic);
  for (const entry of golden.cases) {
    const decision = stepState(snapshotOf(entry));
    assertShape(decision, entry.id);
    assertDecision(decision, entry.expected, `${entry.id} ${entry.covers}`);
  }
});

test('the eight incident fixtures decide as Stage 0 expected them: state, numbers, predicates, edits and next', () => {
  // Stage 0's names are the kernel's: the vocabulary is frozen as a subset of StepDecision/v1's [section 4.2].
  const { vocabulary } = incidents;
  for (const [field, frozen] of [['states', kernel.STEP_STATES], ['kinds', kernel.ACTION_KINDS], ['operations', kernel.OPERATIONS],
    ['principalKinds', kernel.PRINCIPAL_KINDS], ['roles', kernel.ROLES]]) {
    for (const name of vocabulary[field]) assert.ok(frozen.includes(name), `${field}: ${name}`);
  }
  for (const incident of incidents.incidents) {
    const { facts, story, expected } = incident;
    const entry = { facts: { ...facts, kind: facts.kind, review: facts.review ? { status: facts.review.retained, generation: facts.review.generation } : null },
      currentPhase: story.currentPhase, workId: story.workId,
      actor: { turnMode: facts.turn.mode, role: facts.turn.mode === 'read-only-review' ? 'reviewer' : 'author' } };
    const decision = stepState(snapshotOf(entry, { phaseOrder: story.phaseOrder }));
    assertShape(decision, incident.id);
    const next = { ...expected.next, inputs: Object.fromEntries(Object.entries(expected.next.inputs ?? {}).filter(([key]) => ['version', 'consent', 'reason', 'producer'].includes(key))) };
    assertDecision(decision, { ...expected, next, edit: { eligible: expected.edit.eligible, categories: expected.edit.categories } }, incident.id);
    // Recovery is never the way on for these healthy steps [OSA:REQ-003, AC-005].
    assert.notEqual(decision.next.operation, 'recover-operation', incident.id);
  }
});

// ---------------------------------------------------------------------------------------------------- overlapping conditions

/** A writing code step at version 2 over a published version 1, changed by `changes`. */
function base(changes = {}, entryChanges = {}) {
  return { facts: { phase: 'implementation', kind: 'code', status: 'in_progress', generation: 1, generationIntent: { status: 'open', generation: 2 }, ...changes }, ...entryChanges };
}

test('overlapping conditions follow section 5\'s precedence and keep the other obligations [OSA:REQ-005]', () => {
  const cases = [
    // [name, entry, expected state, expected operation]
    ['rework and an open version: the open version is written', base({ rework: 1 }), 'writing', 'author-version'],
    ['an open version and a stale review asking corrections: the open version', base({ review: { status: 'correction-required', generation: 1 } }), 'writing', 'author-version'],
    ['an open version and a pause: the pause', base({ pause: 'IA-2' }), 'paused', 'decide'],
    ['an open version and revoked authority: the authority', base({}, { actor: { permissionsRevoked: true } }), 'held', 'refresh-authority'],
    ['a pause and revoked authority: the authority', base({ pause: 'IA-2' }, { actor: { permissionsRevoked: true } }), 'held', 'refresh-authority'],
    ['a pause and damage: the damage', base({ generation: 2, generationIntent: { status: 'consumed', generation: 1 }, rework: 2, pause: 'IA-2' }), 'damaged', 'recover-operation'],
    ['submitted and an open version: the approval', base({ status: 'awaiting_approval' }), 'submitted', 'approve-step'],
    ['submitted and a Story decision: the decision', base({ status: 'awaiting_approval' }, { pendingDecision: 'loop-1' }), 'paused', 'decide'],
    ['a blocking hold and a submission: the hold', base({ status: 'awaiting_approval', holds: [{ code: 'WRITER_FENCE_HELD', owner: 'person', blocks: ['authoring'], resolution: 'decide' }] }), 'held', 'decide'],
    ['an unavailable lifecycle and everything else: refresh', base({ pause: 'IA-2', rework: 1 }, { sources: { lifecycle: 'unavailable' } }), 'waiting', 'refresh-authority'],
    ['corruption and an unavailable source: the corruption', base({}, { sources: { lifecycle: 'unavailable', review: 'corrupt' } }), 'damaged', 'recover-operation'],
    ['rework and review corrections on a published step: the reopened successor', base({ generationIntent: { status: 'consumed', generation: 1 }, rework: 1,
      review: { status: 'correction-required', generation: 1 } }), 'reopened', 'open-version'],
    ['review ready and an unread review source: refresh, never "no review owed"', base({ generationIntent: { status: 'consumed', generation: 1 }, review: 'unavailable' }), 'published', 'refresh-facts']
  ];
  for (const [name, entry, state, operation] of cases) {
    const decision = stepState(snapshotOf(entry));
    assertShape(decision, name);
    assert.deepEqual([decision.state, decision.next.operation], [state, operation], name);
  }
  // A submission-only hold stays listed beside a primary action of another kind, and as the submission's prerequisite.
  const hold = { code: 'ACK', owner: 'person', blocks: ['submission'], resolution: 'decide' };
  const writing = stepState(snapshotOf(base({ holds: [hold] })));
  assert.deepEqual([writing.state, writing.obligations.map((entry) => entry.code)], ['writing', ['ACK']]);
  const ready = stepState(snapshotOf(base({ generationIntent: { status: 'consumed', generation: 1 }, review: { status: 'ready', generation: 1 }, holds: [hold] })));
  assert.deepEqual(ready.next.prerequisites, [{ operation: 'decide', principalKind: 'human', code: 'ACK' }]);
});

test('a hold on opening or publishing a version leads the action it blocks; edits of an open version stay (owner, 2026-11-17)', () => {
  // An approved amendment's acknowledgement: the person acknowledges first, then is asked to start the version.
  const hold = { code: 'ACK', owner: 'person', id: 'AMD-1', blocks: ['opening', 'publication', 'submission'], resolution: 'decide' };
  const reopened = base({ generationIntent: { status: 'consumed', generation: 1 }, rework: 1 });
  assert.deepEqual([stepState(snapshotOf(reopened)).state, stepState(snapshotOf(reopened)).next.operation], ['reopened', 'open-version']);
  const asked = stepState(snapshotOf({ ...reopened, facts: { ...reopened.facts, holds: [hold] } }));
  assertShape(asked, 'held successor');
  assert.deepEqual([asked.state, asked.next.kind, asked.next.operation, asked.next.principalKind, asked.next.inputs, asked.next.then, asked.edit.eligible],
    ['held', 'person-decision', 'decide', 'human', { hold: 'ACK', id: 'AMD-1', effect: 'opening' }, ['open-version'], false]);
  // Version 1 is an opening too.
  const initial = stepState(snapshotOf({ facts: { phase: 'implementation', kind: 'code', status: 'in_progress', generation: 0, holds: [hold] } }));
  assert.deepEqual([initial.next.operation, initial.next.then], ['decide', ['open-version']]);
  // An open version: its work leads to publication, so the hold leads; what it may edit is unchanged.
  const open = stepState(snapshotOf(base()));
  const writing = stepState(snapshotOf(base({ holds: [hold] })));
  assert.deepEqual([writing.state, writing.next.operation, writing.next.inputs.effect, writing.next.then], ['held', 'decide', 'publication', ['author-version']]);
  assert.deepEqual(writing.edit.permittedCategories, open.edit.permittedCategories);
  assert.equal(writing.edit.eligible, true);
  // Submission stays the hold's prerequisite, with the amendment named.
  const ready = stepState(snapshotOf(base({ generationIntent: { status: 'consumed', generation: 1 }, review: { status: 'ready', generation: 1 }, holds: [hold] })));
  assert.deepEqual([ready.next.operation, ready.next.prerequisites], ['submit-version', [{ operation: 'decide', principalKind: 'human', code: 'ACK', id: 'AMD-1' }]]);
  // A hold on submission only still leaves the opening to the person's yes.
  const only = stepState(snapshotOf({ ...reopened, facts: { ...reopened.facts, holds: [{ ...hold, blocks: ['submission'] }] } }));
  assert.deepEqual([only.state, only.next.operation], ['reopened', 'open-version']);
});

// ---------------------------------------------------------------------------------------------------- generator

/** Valid and invalid combinations of the lifecycle facts the kernel reads [section 12.1 the generator]. */
function* generated() {
  for (const kind of ['code', 'document', 'kernel-document']) for (const status of ['pending', 'in_progress', 'awaiting_approval', 'approved'])
    for (const generation of [0, 1, 2, -1, '2', null]) for (const hw of [undefined, 0, 3, 'x'])
      for (const intent of [null, 'open-next', 'open-same', 'open-far', 'consumed-same', 'consumed-before'])
        for (const reason of [null, 'rework', 'rejected']) for (const review of [null, 'pending', 'ready', 'correction-required', 'unavailable'])
          for (const turnMode of ['authoring', 'read-only-review']) {
            const g = Number(generation);
            const opening = intent === null ? undefined : intent.startsWith('open')
              ? { status: 'open', generation: intent === 'open-next' ? g + 1 : intent === 'open-same' ? g : g + 3 }
              : { status: 'consumed', generation: intent === 'consumed-same' ? g : g - 1 };
            yield { facts: { phase: 'implementation', kind, status, generation, generationHighWatermark: hw, generationIntent: opening,
              ...(reason === 'rework' ? { rework: g } : {}), ...(reason === 'rejected' ? { rejected: true } : {}),
              review: review === 'unavailable' ? 'unavailable' : review ? { status: review, generation: g } : null }, actor: { turnMode } };
          }
}

test('the generator: every combination gets an exact decision; invalid ones are classified, never coerced [section 12.1]', () => {
  let count = 0, invalid = 0;
  for (const entry of generated()) {
    count += 1;
    const decision = stepState(snapshotOf(entry));
    const where = JSON.stringify(entry.facts);
    assertShape(decision, where);
    const bad = !Number.isSafeInteger(entry.facts.generation) && entry.facts.generation !== '2'
      || entry.facts.generation === -1 || entry.facts.generationHighWatermark === 'x';
    if (bad) { invalid += 1; assert.equal(decision.state, 'invalid', where); }
    // Recovery is the primary action only for positively established damage [OSA:REQ-003, AC-005].
    if (decision.next.operation === 'recover-operation') assert.equal(decision.state, 'damaged', where);
    if (decision.state === 'damaged') assert.ok(decision.next.reasonCodes.some((code) => ['CONSUMED_OPENING_MISMATCH', 'SOURCE_CORRUPT'].includes(code)), where);
    // Nothing is writable outside an authoring turn, and nothing at all in an invalid, damaged or held step [section 6].
    if (entry.actor.turnMode !== 'authoring' || ['invalid', 'damaged', 'held', 'submitted', 'paused', 'waiting'].includes(decision.state)) assert.equal(decision.edit.eligible, false, where);
    // Application edits in a code step only into its open version.
    if (decision.edit.permittedCategories.includes('application') && entry.facts.kind === 'code') assert.notEqual(decision.version.writing, null, where);
    // An open successor is never submitted or reviewed in place of its own version [OSA:REQ-032].
    if (decision.publication.hasOpenVersion) assert.ok(!['submit-version', 'start-review', 'review-version'].includes(decision.next.operation), where);
  }
  assert.ok(count > 10_000 && invalid > 1000, `${count} cases, ${invalid} invalid`);
});

test('unavailable, stale, missing and corrupt sources never become an empty record or a permission [OSA:REQ-004]', () => {
  for (const name of ['lifecycle', 'configuration']) for (const status of ['unavailable', 'stale', 'missing', 'corrupt', 'bogus']) {
    const decision = stepState(snapshotOf(base({}, { sources: { [name]: status } })));
    assert.equal(decision.edit.eligible, false, `${name} ${status}`);
    assert.equal(decision.state, status === 'corrupt' ? 'damaged' : 'waiting', `${name} ${status}`);
    assert.equal(decision.basis.freshness === 'verified', status === 'corrupt' || status === 'missing' || status === 'bogus', `${name} ${status} freshness ${decision.basis.freshness}`);
  }
  // A source the caller did not supply at all is unavailable, never verified.
  const snapshot = snapshotOf(base());
  delete snapshot.sources.configuration;
  assert.equal(stepState(snapshot).state, 'waiting');
  // `not-created` is an answer, not a gap: a step whose review was never created starts its review.
  assert.equal(stepState(snapshotOf(base({ generationIntent: { status: 'consumed', generation: 1 } }))).state, 'in-review');
});

// ---------------------------------------------------------------------------------------------------- AC-007

test('each named publication predicate agrees with its independent definition, including version 1 published while 2 is open [OSA:AC-007]', async () => {
  const wrappers = await import('../src/phase-generation-need.mjs');
  const { nextPhaseGeneration } = await import('../src/phase-generation.mjs');
  for (const published of [0, 1, 2, 3]) for (const watermark of [undefined, 0, 2, 5]) for (const opening of [null, 1, 2, 3, 4, 6]) for (const status of ['open', 'consumed']) {
    const facts = { published, ...(watermark === undefined ? {} : { recordedHighWatermark: watermark }), opening: opening === null ? null : { status, version: opening } };
    // Section 4.3, written out independently.
    const base = Math.max(published, watermark ?? 0);
    const writing = status === 'open' && opening === base + 1 ? opening : null;
    const where = JSON.stringify(facts);
    assert.equal(kernel.hasPublishedVersion(facts), published >= 1, `hasPublishedVersion ${where}`);
    assert.equal(kernel.hasOpenVersion(facts), writing !== null, `hasOpenVersion ${where}`);
    assert.equal(kernel.currentVersionPublished(facts), published >= 1 && writing === null, `currentVersionPublished ${where}`);
    assert.deepEqual(kernel.versionNumbers(facts).proposedNext, writing === null ? base + 1 : null, `proposedNext ${where}`);
    assert.equal(kernel.versionNumbers(facts).highWatermark, Math.max(base, writing ?? 0), `highWatermark ${where}`);
    // The record wrappers mean exactly the same, over the same record [section 4.3 existing helpers].
    const phase = { id: 'x', status: 'in_progress', generation: published, ...(watermark === undefined ? {} : { generationHighWatermark: watermark }),
      ...(opening === null ? {} : { generationIntent: { status, generation: opening } }) };
    assert.equal(wrappers.successorGenerationOpen(phase), writing !== null, `successorGenerationOpen ${where}`);
    assert.equal(nextPhaseGeneration(phase), base + 1, `nextPhaseGeneration ${where}`);
    // Stage 5 deleted the unused P-10 wrapper (consumedByPublishedGeneration); the kernel's predicate is its one owner.
    assert.equal(kernel.consumedByPublishedVersion(facts), status === 'consumed' && published > 0 && opening === published, `consumedByPublishedVersion ${where}`);
  }
  // The example of section 4.3: version 1 published, version 2 open.
  const example = { published: 1, opening: { status: 'open', version: 2 } };
  assert.deepEqual([kernel.hasPublishedVersion(example), kernel.hasOpenVersion(example), kernel.currentVersionPublished(example)], [true, true, false]);
  // Historical publication is not current publication: the P-4 wrapper asks for the record and no open successor.
  assert.equal(wrappers.hasPublishedPhaseGeneration({ generation: 1, generationIntent: { status: 'open', generation: 2 } }), false);
  assert.equal(kernel.hasPublishedVersion({ published: 1, opening: { status: 'open', version: 2 } }), true);
});

// ---------------------------------------------------------------------------------------------------- AC-004

/**
 * The abstract lifecycle: what each operation does to the facts when it succeeds. Each run must reach a real agent
 * milestone (a publication or a review), a human boundary, an explicit wait or a terminal result within six modelled
 * transitions, and never repeat an action without causal progress [OSA:AC-004, AC-012].
 */
function apply(entry, decision) {
  const facts = structuredClone(entry.facts);
  const { operation, inputs } = decision.next;
  if (operation === 'open-version' && inputs.consent === 'not-required') facts.generationIntent = { status: 'open', generation: inputs.version };
  else if (operation === 'author-version' || operation === 'build-version') {
    facts.generation = decision.version.writing ?? inputs.version; facts.generationIntent = { status: 'consumed', generation: facts.generation };
    delete facts.rework; facts.review = { status: 'pending', generation: facts.generation };
    return { entry: { ...entry, facts }, milestone: 'published' };
  } else if (operation === 'start-review') return { entry: { ...entry, facts: { ...facts, review: { status: 'ready', generation: facts.generation } } }, milestone: 'reviewed' };
  else if (operation === 'submit-version') facts.status = 'awaiting_approval';
  return { entry: { ...entry, facts } };
}

test('the abstract lifecycle reaches an agent milestone, a human boundary, a wait or the end within six transitions [OSA:AC-004]', () => {
  const starts = [...golden.cases.filter((entry) => !entry.current && !entry.requestedPhase), ...[...generated()].filter((_, index) => index % 97 === 0)];
  for (const start of starts) {
    let entry = start; const seen = new Set();
    let reached = null;
    for (let step = 0; step < 6 && !reached; step += 1) {
      const decision = stepState(snapshotOf(entry));
      const key = `${decision.next.actionId}|${JSON.stringify(decision.version)}|${decision.state}`;
      assert.ok(!seen.has(key), `${start.id ?? JSON.stringify(start.facts)}: ${key} repeated with no progress`);
      seen.add(key);
      if (decision.next.principalKind === 'human' || ['refresh', 'observe', 'none', 'reconcile'].includes(decision.next.kind)) { reached = decision.next.kind; break; }
      const result = apply(entry, decision);
      if (result.milestone) reached = result.milestone;
      entry = result.entry;
    }
    assert.ok(reached, `${start.id ?? JSON.stringify(start.facts)}: no milestone, boundary, wait or end in six transitions`);
  }
});

// ---------------------------------------------------------------------------------------------------- AC-009

test('the kernel closure has no host I/O, command rendering, prompt or provider: its files import only siblings [OSA:AC-009]', () => {
  const folder = path.join(root, 'src', 'kernel');
  const files = readdirSync(folder).filter((name) => name.endsWith('.mjs'));
  assert.deepEqual(files.sort(), ['step-state.mjs', 'step-versions.mjs'], 'Stage 1 keeps the kernel to its two files (kernel-location.md)');
  for (const name of files) {
    const text = readFileSync(path.join(folder, name), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
    for (const [, specifier] of code.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/gu)) {
      assert.match(specifier, /^\.\/[a-z-]+\.mjs$/u, `${name} imports ${specifier}`);
    }
    assert.doesNotMatch(code, /\bimport\s*\(|\brequire\s*\(|\bprocess\.|\bglobalThis\b|\bfetch\s*\(|\bDate\.now\b|Math\.random/u, `${name}: host I/O or nondeterminism`);
    // No host command, skill name, prompt or question wording [OSA:REQ-021].
    assert.doesNotMatch(code, /singularity-flow|\/sf-|\/sflow-|copilot|prompt/iu, `${name}: a host rendering`);
  }
  // Pure: the same snapshot gives the same decision, and the snapshot is not changed.
  const snapshot = snapshotOf(golden.cases[0]);
  const frozen = JSON.stringify(snapshot);
  assert.deepEqual(stepState(snapshot), stepState(structuredClone(snapshot)));
  assert.equal(JSON.stringify(snapshot), frozen);
});

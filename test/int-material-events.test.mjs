/**
 * Which recorded events count as "what happened" to a piece of work.
 *
 * A Story whose specification was submitted and then approved by its submitter read "phase
 * submitted" in the Handoff view: the material set listed `phase_approved` but history spells that
 * approval `phase_self_approved`, and four of the set's nine names were written by nothing at all.
 * The set now has an entry for every lifecycle event type, and these hold it to the vocabulary, to
 * the spellings the kernel writes, and to the history a real approval leaves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LIFECYCLE_EVENT, LIFECYCLE_EVENT_TYPES } from '../src/lifecycle-event.mjs';
import { MATERIAL_HISTORY_EVENTS, lastMaterialEvent, resolveWorkRecord, workRecords } from '../src/gateway/work-records.mjs';
import { workHandoff } from '../src/gateway/planners/work-handoff.mjs';
import { codeOnly } from './source-text.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { approvedSpecificationStory } from './helpers/submitted-planning-story.mjs';

const SOURCE = new URL('../src/', import.meta.url);
const WORK = 'MAT-101';
const ACTOR = 'reviewer@example.test';
const spellings = () => Object.values(MATERIAL_HISTORY_EVENTS).flatMap((entry) => entry ?? []);

async function sourceFiles(directory = SOURCE) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory()
    ? sourceFiles(new URL(`${entry.name}/`, directory))
    : entry.name.endsWith('.mjs') ? [new URL(entry.name, directory)] : [])));
  return nested.flat();
}

/** Every quoted name on a line that sets an `event:` field, outside the reader under test. */
async function writtenEventNames() {
  const names = new Set();
  for (const file of await sourceFiles()) {
    if (file.pathname.endsWith('/gateway/work-records.mjs')) continue;
    const text = await readFile(file, 'utf8');
    if (!text.includes('event: ')) continue;
    for (const line of codeOnly(text).split('\n')) {
      if (!/\bevent: /u.test(line)) continue;
      for (const match of line.matchAll(/'([a-z][a-z_-]*)'/gu)) names.add(match[1]);
    }
  }
  return names;
}

test('every lifecycle event type says which of its history spellings are material', () => {
  assert.deepEqual(Object.keys(MATERIAL_HISTORY_EVENTS).sort(), [...LIFECYCLE_EVENT_TYPES].sort(),
    'a lifecycle event type has no entry in MATERIAL_HISTORY_EVENTS (src/gateway/work-records.mjs)');
  for (const [type, entry] of Object.entries(MATERIAL_HISTORY_EVENTS)) {
    assert.ok(entry === null || (Array.isArray(entry) && entry.length > 0), `${type}: a list of spellings, or null for none`);
  }
  assert.equal(new Set(spellings()).size, spellings().length, 'a spelling records one event');
  // Approval, rejection (the return), reopening, cancellation and completion are news to anyone.
  for (const type of [
    LIFECYCLE_EVENT.APPROVAL_REQUESTED, LIFECYCLE_EVENT.PHASE_APPROVED, LIFECYCLE_EVENT.PHASE_REJECTED,
    LIFECYCLE_EVENT.WORKFLOW_REOPENED, LIFECYCLE_EVENT.WORK_CANCELLED, LIFECYCLE_EVENT.WORK_COMPLETED
  ]) assert.ok(MATERIAL_HISTORY_EVENTS[type]?.length, `${type} is material`);
  assert.ok(MATERIAL_HISTORY_EVENTS[LIFECYCLE_EVENT.PHASE_APPROVED].includes('phase_self_approved'));
});

test('every material spelling is one the kernel writes', async () => {
  const written = await writtenEventNames();
  assert.deepEqual(spellings().filter((name) => !written.has(name)), [],
    'a material spelling that nothing writes can never match');
});

test('an approval is the last material event, whoever approved', () => {
  const history = (approval) => ({
    history: [
      { at: '2026-10-24T10:00:00.000Z', actor: ACTOR, event: 'work_started', phase: 'specification' },
      { at: '2026-10-24T10:01:00.000Z', actor: ACTOR, event: 'phase_generated', phase: 'specification' },
      { at: '2026-10-24T10:02:00.000Z', actor: ACTOR, event: 'phase_submitted', phase: 'specification' },
      { at: '2026-10-24T10:03:00.000Z', actor: ACTOR, event: approval, phase: 'specification' },
      { at: '2026-10-24T10:03:00.000Z', actor: ACTOR, event: 'phase_retained', phase: 'planning' }
    ]
  });
  for (const approval of ['phase_approved', 'phase_self_approved']) {
    assert.deepEqual(lastMaterialEvent(history(approval)),
      { event: approval, phase: 'specification', actor: ACTOR, at: '2026-10-24T10:03:00.000Z' });
  }
  assert.equal(lastMaterialEvent({ history: [{ event: 'initiative_self_approved', phase: 'requirements' }] }).event,
    'initiative_self_approved');
});

/**
 * The records `start`, `publish`, `submit` and `approve` leave when one person submits and approves
 * the specification, as the CLI writes them (the slow-lane test below drives the CLI itself).
 */
function approvedSpecification() {
  const at = (minute) => `2026-10-24T10:0${minute}:00.000Z`;
  const entry = (minute, event, detail) => ({ at: at(minute), actor: ACTOR, agent: 'product-owner', event, phase: 'specification', detail });
  const projection = (minute, type, generation) => ({ schemaVersion: 1, event: {
    schemaVersion: 1, eventId: `event-${minute}`, type, subject: { kind: 'story', id: WORK }, phaseId: 'specification', generation,
    actor: { name: 'Reviewer', email: ACTOR, login: null }, createdAt: at(minute)
  }, ledgerIntent: null });
  return {
    workItem: { id: WORK, title: 'Validate a value', workType: 'spec-driven-standard', branch: WORK },
    status: 'in_progress',
    phaseOrder: ['specification', 'planning', 'implementation'],
    currentPhase: 'planning',
    phases: {
      specification: { label: 'Specification', status: 'approved', generation: 1 },
      planning: { label: 'Planning', status: 'in_progress', generation: 0 },
      implementation: { label: 'Implementation', status: 'not_started', generation: 0 }
    },
    history: [
      entry(0, 'work_started', `Created spec-driven-standard branch ${WORK}`),
      entry(1, 'phase_generated', 'generation 1'),
      entry(2, 'phase_submitted', '1 artifacts'),
      entry(3, 'phase_self_approved', 'threshold reached; advanced to planning')
    ],
    publicationProjections: [
      projection(0, 'binding', 0), projection(1, 'artifact-generated', 1),
      projection(2, 'approval-requested', 1), projection(3, 'phase-approved', 1)
    ]
  };
}

async function repositoryWith(t, workflow) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-material-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'singularity', 'work-items', workflow.workItem.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workflow.json'), JSON.stringify(workflow));
  return root;
}

/** What the work record and the handoff packet say about one Story, side by side. */
async function readBack(root, { sourceCommit = null } = {}) {
  const item = resolveWorkRecord(await workRecords(root, { includeCompleted: true }), { workId: WORK, workKind: 'story' });
  const handoff = await workHandoff({
    root, arguments: { workId: WORK, workKind: 'story' }, context: sourceCommit ? { sourceCommit } : {}
  });
  return { item, handoff };
}

test('a Story submitted and then approved reports the approval in its work record and its handoff', async (t) => {
  const root = await repositoryWith(t, approvedSpecification());
  const { item, handoff } = await readBack(root, { sourceCommit: 'a'.repeat(40) });
  const approval = { event: 'phase_self_approved', phase: 'specification', actor: ACTOR, at: '2026-10-24T10:03:00.000Z' };
  assert.deepEqual(item.lastMaterialEvent, approval);
  assert.equal(handoff.kind, 'read');
  assert.equal(handoff.data.packet.evidence.state, 'recorded');
  assert.deepEqual(handoff.data.packet.evidence.lastMaterialEvent, approval);
  // The next action is computed from phase state, which the approval moved on, and nothing else.
  assert.deepEqual(item.nextAction, { operation: 'work.continue', reasonCode: 'work.resume-phase' });
  assert.deepEqual(handoff.data.packet.legalNextAction, item.nextAction);
});

test('a real submit and approve leave a history whose material events match the lifecycle stream', slowLane({ timeout: 300_000 }), async (t) => {
  const { root, item: directory } = await approvedSpecificationStory(t, WORK);
  const workflow = JSON.parse(await readFile(path.join(directory, 'workflow.json'), 'utf8'));
  const { item, handoff } = await readBack(root);

  assert.equal(item.lastMaterialEvent?.event, 'phase_self_approved', JSON.stringify(workflow.history.map((entry) => entry.event)));
  assert.equal(item.lastMaterialEvent.phase, 'specification');
  assert.equal(handoff.kind, 'read');
  assert.deepEqual(handoff.data.packet.evidence.lastMaterialEvent, item.lastMaterialEvent);
  assert.deepEqual(item.nextAction, { operation: 'work.continue', reasonCode: 'work.resume-phase' });

  /**
   * Each attested lifecycle event of a material type has a material history entry beside it. A
   * writer that spells one of these events a new way leaves its lifecycle event unmatched here,
   * which is how `phase_self_approved` went unread.
   */
  const counted = (entries) => entries.reduce((counts, type) => counts.set(type, (counts.get(type) ?? 0) + 1), new Map());
  const typeOf = new Map(Object.entries(MATERIAL_HISTORY_EVENTS).flatMap(([type, names]) => (names ?? []).map((name) => [name, type])));
  const attested = counted(workflow.publicationProjections.map((entry) => entry.event.type).filter((type) => MATERIAL_HISTORY_EVENTS[type]));
  const recorded = counted(workflow.history.map((entry) => typeOf.get(entry.event)).filter(Boolean));
  assert.deepEqual([...recorded].sort(), [...attested].sort());
  assert.deepEqual([...attested.keys()].sort(), ['approval-requested', 'artifact-generated', 'binding', 'phase-approved']);
});

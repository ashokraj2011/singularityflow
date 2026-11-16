/**
 * SPEC-OSA v1.1 Stage 2 compatibility [OSA:AC-019, §14]: older-reader and new-writer combinations, tested, not presumed.
 *
 * - New writer, record read the old way: the opening adds `versionOpening` beside the step's generation intent and
 *   receipt, which keep their shape; `generationHighWatermark` is unchanged, so the old arithmetic max(generation,
 *   watermark) + 1 names the same open version. The new lifecycle members (`version-opened`, `version-writer-taken-over`)
 *   are governing members since vocabulary 10.
 * - Old writer, new reader: an older build's local opening of version 1 still authors (normalized, §4.3); its local
 *   opening of a successor grants nothing until it is promoted through the opening operation on the person's yes.
 * - With SINGULARITY_FLOW_OSA_OLDER_CHECKOUT naming a checkout of an older build (Stage 1, 90e7095cc), its CLI reads and
 *   publishes a Story the new build opened, and the new build promotes a version the older build opened locally.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { approvedSpecificationStory, implementationPlan, CLI } from './helpers/submitted-planning-story.mjs';
import { LIFECYCLE_EVENT_VOCABULARY } from '../src/lifecycle-event.mjs';
import { stepState } from '../src/kernel/step-state.mjs';
import { stepSnapshotOf } from '../src/phase-mutation-contract.mjs';

const OLDER = process.env.SINGULARITY_FLOW_OSA_OLDER_CHECKOUT ?? null;
const record = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
const json = (result) => JSON.parse(result.stdout);

/** The old version arithmetic, as Stage 1 and earlier builds compute it: max(generation, high-watermark) + 1. */
const olderNext = (phase) => Math.max(Number(phase.generation ?? 0), Number(phase.generationHighWatermark ?? 0)) + 1;

async function publishedCode(t, WORK) {
  const story = await approvedSpecificationStory(t, WORK);
  const { root, cli, item } = story;
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks'); cli('approve', 'planning', '--yes');
  cli('prepare', 'implementation');
  const clauses = [`${WORK}:AC-001`, `${WORK}:REQ-002`];
  const code = (value) => `${clauses.map((clause) => `// @clause:${clause} returns the approved value to its callers\n`).join('')}export const value = ${value};\n`;
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, 'src'), { recursive: true }); await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'src/value.mjs'), code(1));
  await writeFile(path.join(root, 'test/value.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n${clauses.map((clause) => `// @ac:${clause}\n`).join('')}test('value', () => assert.ok(value >= 1));\n`);
  await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), ['# Implementation summary', '', '## Agent brief', '',
    'Added the value module; both clauses have one focused test that reads the approved value.', '', '## Changed components and decisions', '',
    '- `src/value.mjs` exports the approved value.', '', '## Tests and operational notes', '', '`test/value.test.mjs` verifies the value.', ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/implementation/operator-notes.md'), ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  return { ...story, code };
}

test('the new lifecycle members are governing members of vocabulary 10, kept and restricted by an older reader', () => {
  assert.equal(LIFECYCLE_EVENT_VOCABULARY.version, 10);
  for (const member of ['version-opened', 'version-writer-taken-over']) {
    const descriptor = LIFECYCLE_EVENT_VOCABULARY.descriptors[member];
    assert.equal(descriptor.class, 'core-governing', member);
    assert.equal(descriptor.since, 10, member);
    assert.equal(descriptor.unknownRead, 'preserve-and-restrict', `${member}: an older reader keeps it and restricts, never drops it`);
  }
});

test('an older build\'s local openings: version 1 still authors, a successor grants nothing until promoted on the person\'s yes [§14]', () => {
  const step = (changes) => ({ id: 'implement', label: 'Implement', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact',
    generationPolicy: { requirement: 'required', task: 'code', allowedProducers: ['governed-agent'] }, ...changes });
  const decide = (phase) => stepState(stepSnapshotOf({ workflow: { workItem: { id: 'OLD-1' }, status: 'in_progress', currentPhase: 'implement',
    phaseOrder: ['implement'], phases: { implement: phase }, history: [], resolution: {} }, phase, turnMode: 'authoring' }));
  const initial = decide(step({ generationIntent: { status: 'open', generation: 1 } }));
  assert.equal(initial.state, 'writing');
  assert.deepEqual(initial.edit.permittedCategories.sort(), ['application', 'step-artifacts']);
  const successor = decide(step({ generation: 1, generationIntent: { status: 'open', generation: 2 },
    generationPublications: [{ generation: 1, record: { path: 'context/implement-gen1.json' } }] }));
  assert.equal(successor.state, 'reopened');
  assert.equal(successor.edit.eligible, false);
  assert.deepEqual([successor.next.operation, successor.next.inputs.consent, successor.next.inputs.reason], ['open-version', 'required', 'legacy-promotion']);
});

test('a new writer\'s opening reads the old way: the same open version by the old arithmetic, its intent and receipt unchanged in shape [AC-019]', async (t) => {
  const story = await publishedCode(t, 'COMPAT-NEW');
  const preview = json(story.cli('phase', 'rollover', 'implementation', '--reason', 'Return the value with its unit', '--json'));
  const opened = json(story.run(process.execPath, [CLI, '--no-model', ...preview.argv, '--json']));
  const phase = (await record(story.item)).phases.implementation;
  assert.equal(phase.versionOpening.version, 2);
  assert.equal(phase.generationHighWatermark, undefined, 'the opening leaves the old watermark field as it was');
  assert.equal(olderNext(phase), phase.generationIntent.generation, 'an older reader names the same open version');
  for (const key of ['baseline', 'generation', 'id', 'path', 'publication', 'receiptSha256', 'startedAt', 'startedBy', 'status']) {
    assert.ok(Object.hasOwn(phase.generationIntent, key), `the intent keeps ${key}, which an older reader reads`);
  }
  const receipt = JSON.parse(await readFile(path.join(story.root, phase.generationIntent.path), 'utf8'));
  assert.equal(receipt.kind, 'generation-start');
  assert.equal(receipt.generation, 2);
  assert.equal(opened.opening.version, 2);
  if (!OLDER) return;
  // The older build's own CLI on the new writer's Story: it reads it, and publishes version 2 the new build opened.
  const older = (...args) => story.run(process.execPath, [path.join(OLDER, 'bin/singularity-flow.mjs'), '--no-model', ...args], { allowFailure: true });
  assert.equal(older('nextsteps', '--json').status, 0, 'an older build reads the Story');
  assert.equal(older('phase', 'show', 'implementation', '--json').status, 0);
  await writeFile(path.join(story.root, 'src/value.mjs'), story.code(2));
  story.cli('artifact', 'scan', '--phase', 'implementation');
  const published = older('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place', '--json');
  assert.equal(published.status, 0, `${published.stdout.slice(-1500)}${published.stderr.slice(-800)}`);
  const after = (await record(story.item)).phases.implementation;
  assert.equal(after.generation, 2);
  assert.equal(after.versionOpening.operationId, phase.versionOpening.operationId, 'the older build kept the opening record');
  // And the new build reads what the older one published: version 2, nothing open, version 3 next.
  const decision = stepState(stepSnapshotOf({ workflow: await record(story.item), phase: after, turnMode: 'authoring' }));
  assert.deepEqual([decision.version.published, decision.version.writing, decision.version.highWatermark], [2, null, 2]);
});

test('an older build\'s local successor opening is promoted by the new build through the operation, on the person\'s yes [§14, AC-019]',
  { skip: OLDER ? false : 'needs SINGULARITY_FLOW_OSA_OLDER_CHECKOUT (an older build) to write the local opening' }, async (t) => {
    const story = await publishedCode(t, 'COMPAT-OLD');
    const older = (...args) => story.run(process.execPath, [path.join(OLDER, 'bin/singularity-flow.mjs'), '--no-model', ...args], { allowFailure: true });
    // The older build opens version 2 the old way: in this working copy only, with no commit and no person's yes.
    const head = story.git('rev-parse', 'HEAD');
    const begun = older('phase', 'rollover', 'implementation', '--reason', 'Return the value with its unit', '--json');
    const confirmed = older(...json(begun).argv, '--json');
    assert.equal(confirmed.status, 0, `${confirmed.stdout.slice(-1200)}${confirmed.stderr.slice(-600)}`);
    assert.equal(story.git('rev-parse', 'HEAD'), head, 'the older build committed nothing');
    const legacy = (await record(story.item)).phases.implementation;
    assert.equal(legacy.generationIntent.status, 'open');
    assert.notEqual(legacy.versionOpening?.version, 2, 'the older build wrote no opening record for it (version 1\'s stays as it was)');
    // The new build: a read never rewrites it; the person's yes promotes it through the opening operation, at its own number.
    const view = json(story.cli('phase', 'opening', 'implementation', '--json'));
    assert.deepEqual(view.legacyIntent, { version: 2, record: 'legacy' });
    assert.deepEqual(await record(story.item).then((value) => value.phases.implementation.generationIntent), legacy.generationIntent, 'a read changed nothing');
    const preview = json(story.cli('phase', 'rollover', 'implementation', '--json'));
    assert.equal(preview.kind, 'returned');
    assert.equal(preview.reason, 'legacy-promotion');
    assert.equal(preview.toGeneration, 2);
    const promoted = json(story.run(process.execPath, [CLI, '--no-model', ...preview.argv, '--json']));
    assert.equal(promoted.opening.version, 2);
    const after = (await record(story.item)).phases.implementation;
    assert.equal(after.generationIntent.id, legacy.generationIntent.id, 'the local opening\'s own intent and receipt are kept');
    assert.equal(after.versionOpening.reason, 'legacy-promotion');
    assert.equal(story.git('rev-parse', 'HEAD^'), head, 'one opening commit on top of the publication');
  });

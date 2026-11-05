import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clarificationCheckpoint } from '../src/clarifications.mjs';
import { ownTerminalStep } from '../src/command-skills.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import { scopeItemId, storySourceStatements } from '../src/scope/extract.mjs';
import { buildScopeInventory } from '../src/scope/inventory.mjs';
import { assertSliceSize, buildSlice, MAXIMUM_SLICE_BYTES, parseSliceRequest, parseSliceRequests, sliceClauseItem } from '../src/spec-library/slice.mjs';
import { coverageOf, usageRecords } from '../src/spec-library/usage.mjs';
import { MESSAGES } from '../src/narration/messages.mjs';
import { CLI, specification, startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

// SPEC-SPA v1.3 S2: a Story attaches a slice of a reviewed specification revision, the slice reaches
// its prompt and its scope inventory, and its use is recorded on the state branch. Model-free.

const SPEC = 'SPEC-CHK-004';
const REQ_001 = 'WHEN an INR order total is strictly greater than INR 5000.00, the cart SHALL apply a 10 percent order discount.';
const REQ_002 = 'WHEN a cart is not in INR, the cart SHALL apply no order discount.';
const AC_001 = `An INR 5000.01 cart gets INR 500.00 off and an INR 5000.00 cart gets nothing, as ${SPEC}:REQ-001 states.`;
const AC_002 = `A USD cart of 6000.00 gets nothing off, as ${SPEC}:REQ-002 states.`;

function librarySpec(extra = '') {
  return `# Order discount threshold

## Outcome

The 10 percent order discount applies only to orders strictly above INR 5000.00.

## Actors

- Shopper: places INR orders.

## User scenarios

1. A shopper with an INR 6000.00 cart sees a 10 percent discount.

## Scope

In scope: the order discount rule. Out of scope: tax and shipping.

## Requirements

${REQ_001} [${SPEC}:REQ-001]

${REQ_002} [${SPEC}:REQ-002]

## Acceptance

${AC_001} [${SPEC}:AC-001]

${AC_002} [${SPEC}:AC-002]

## Decisions and open questions

- GAP-001: only totals strictly above INR 5000.00 qualify.${extra}
`;
}

/** A read revision as library.mjs readRevision returns it. */
function revision(spec = librarySpec(), number = 1) {
  return {
    specId: SPEC, revision: number, commit: 'c'.repeat(40), manifestSha256: `sha256:${'a'.repeat(64)}`,
    manifest: { specId: SPEC, revision: number, title: 'Order discount threshold', reviewState: 'reviewed' }, spec,
    gaps: { events: [
      { event: 'opened', gap: 'GAP-001', kind: 'vague-term', question: 'Is INR 5000.00 itself discounted?', options: [], by: 'p', at: 't' },
      { event: 'decided', gap: 'GAP-001', option: null, choice: 'Only totals strictly above INR 5000.00 qualify.', reason: 'Finance.', by: 'p', at: 't' },
      { event: 'opened', gap: 'GAP-002', kind: 'open-question', question: 'Does tax count?', options: [], by: 'p', at: 't' }
    ] }
  };
}

test('a slice request names a specification, an optional revision and its clauses; anything else is refused', () => {
  assert.deepEqual(parseSliceRequest(`${SPEC}@3=REQ-001, ac-002,${SPEC}:REQ-001`),
    { specId: SPEC, revision: 3, clauses: [`${SPEC}:REQ-001`, `${SPEC}:AC-002`], request: `${SPEC}@3=REQ-001, ac-002,${SPEC}:REQ-001` });
  assert.deepEqual(parseSliceRequest(SPEC), { specId: SPEC, revision: null, clauses: null, request: SPEC });
  for (const bad of [`${SPEC}@1=`, `${SPEC}@1=REQ-1`, `${SPEC}@1=SPEC-OTHER:REQ-001`, `${SPEC}@1=REQ-001=AC-001`]) {
    assert.throws(() => parseSliceRequest(bad), { code: 'SPEC_SLICE_REQUEST_INVALID' }, bad);
  }
  assert.throws(() => parseSliceRequest('CHK-004@1'), { code: 'SPEC_ID_INVALID' });
  assert.throws(() => parseSliceRequests([`${SPEC}@1=REQ-001`, `${SPEC}@1=AC-001`]), { code: 'SPEC_SLICE_REQUEST_INVALID' }, 'one --spec per specification');
});

test('a slice carries its clauses, every settled decision and the clauses that are not this Story; a missing clause or dependency is refused (SPA:AC-012)', () => {
  const slice = buildSlice(revision(), { specId: SPEC, clauses: [`${SPEC}:REQ-001`, `${SPEC}:AC-001`] });
  assert.deepEqual(slice.clauses, [{ anchor: `[${SPEC}:REQ-001]`, text: REQ_001 }, { anchor: `[${SPEC}:AC-001]`, text: AC_001 }]);
  assert.deepEqual(slice.decisions, [{ gap: 'GAP-001', question: 'Is INR 5000.00 itself discounted?', status: 'decided', outcome: 'Only totals strictly above INR 5000.00 qualify.' }],
    'a decided gap travels with the slice; an open one does not');
  assert.deepEqual(slice.notThisStory.map((entry) => entry.anchor), [`[${SPEC}:REQ-002]`, `[${SPEC}:AC-002]`]);
  assert.deepEqual([slice.revision, slice.manifestSha256, slice.stateCommit], [`${SPEC}@1`, `sha256:${'a'.repeat(64)}`, 'c'.repeat(40)]);
  assert.equal(buildSlice(revision(), { specId: SPEC, clauses: null }).clauses.length, 4, 'no clause list is the whole revision');

  assert.throws(() => buildSlice(revision(), { specId: SPEC, clauses: [`${SPEC}:REQ-009`] }),
    (error) => error.code === 'SPEC_SLICE_CLAUSE_UNKNOWN' && /SPEC-CHK-004:REQ-009 is not a clause of SPEC-CHK-004@1/u.test(error.message));
  assert.throws(() => buildSlice(revision(), { specId: SPEC, clauses: [`${SPEC}:AC-001`] }),
    (error) => error.code === 'SPEC_SLICE_DEPENDENCY_MISSING'
      && error.message.includes(`${SPEC}:AC-001 depends on ${SPEC}:REQ-001`) && error.message.includes(`--spec ${SPEC}@1=AC-001,REQ-001`));
  const partial = buildSlice(revision(), { specId: SPEC, clauses: [`${SPEC}:AC-001`] }, { dependencyReason: 'REQ-001 ships in S-7.' });
  assert.deepEqual(partial.partialDependency, { reason: 'REQ-001 ships in S-7.', missing: [{ clause: `${SPEC}:AC-001`, dependsOn: `${SPEC}:REQ-001` }] });
});

test('a slice over the Story source limit is refused with its size, never cut (SPA:REQ-019)', () => {
  const long = `${'The cart SHALL keep this sentence. '.repeat(2200)}`;
  const big = buildSlice(revision(librarySpec().replace(REQ_002, long)), { specId: SPEC, clauses: null });
  assert.throws(() => assertSliceSize([big]), (error) => error.code === 'SPEC_SLICE_TOO_LARGE'
    && error.details.limit === MAXIMUM_SLICE_BYTES && error.details.bytes > MAXIMUM_SLICE_BYTES && error.message.includes('Nothing was attached'));
});

test('each sliced clause is its own scope statement; uncovered, the final gate blocks naming its reference (SPA:AC-013)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-slice-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'singularity/work-items/S-1');
  await mkdir(directory, { recursive: true });
  const source = { description: 'Discounts.', specification: [buildSlice(revision(), { specId: SPEC, clauses: [`${SPEC}:REQ-001`, `${SPEC}:AC-001`] })] };
  const statements = storySourceStatements(source).filter((entry) => entry.field === 'specification');
  assert.deepEqual(statements.map((entry) => entry.text), [`[${SPEC}:REQ-001] ${REQ_001}`, `[${SPEC}:AC-001] ${AC_001}`]);
  assert.deepEqual(storySourceStatements({ description: 'Discounts.' }).filter((entry) => entry.field === 'specification'), [], 'no slice, no statement');

  const workflow = {
    workItem: { id: 'S-1', title: 'Discounts' }, status: 'in_progress', currentPhase: 'intake', phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', status: 'in_progress', generation: 1, approvals: [], approvalPolicy: { mode: 'required', authorities: ['product'] } } },
    resolution: { obligationGraph: { nodes: [{ id: 'intake', responsibilities: ['scope', 'plan', 'review'] }], endpoints: [] } }
  };
  const uncovered = await buildScopeInventory(root, directory, workflow, { source, clauses: [{ id: 'S-1:REQ-001', body: REQ_001 }] });
  const items = uncovered.items.filter((item) => item.field === 'specification');
  assert.deepEqual(items.map((item) => [item.id, item.disposition]), [
    [scopeItemId('story', `[${SPEC}:REQ-001] ${REQ_001}`), 'included'],
    [scopeItemId('story', `[${SPEC}:AC-001] ${AC_001}`), 'unresolved']
  ], 'a Story clause stating the sliced text covers it; the other stays open');
  const evaluation = evaluateEvidence(evidenceGraph({ workflow, records: { indexes: [] }, scope: uncovered }));
  assert.equal(evaluation.decision.gate, 'block');
  assert.ok(evaluation.findings.some((entry) => entry.code === 'SCOPE_ITEMS_UNRESOLVED'));
  const linked = await buildScopeInventory(root, directory, workflow, { source, clauses: [
    { id: 'S-1:REQ-001', body: REQ_001 }, { id: 'S-1:AC-001', body: `Both boundary carts behave as the specification says. [scope:${items[1].id}]` }] });
  assert.equal(linked.items.filter((item) => item.field === 'specification').every((item) => item.disposition === 'included'), true,
    'a clause citing the item\'s sourceReference covers it');
});

test('usage records follow the Story\'s committed approval and closing, byte for byte; coverage reads them per clause (SPA:AC-015, AC-017)', () => {
  const slice = buildSlice(revision(), { specId: SPEC, clauses: [`${SPEC}:REQ-001`, `${SPEC}:AC-001`] });
  const story = (overrides = {}) => ({
    workItem: { id: 'S-1' }, status: 'in_progress', phaseOrder: ['specification', 'planning'],
    phases: { specification: { id: 'specification', status: 'in_progress', approvals: [] }, planning: { id: 'planning', approvals: [] } }, ...overrides
  });
  assert.deepEqual(usageRecords(story(), { specification: [slice] }), [], 'nothing before the first step is approved');
  assert.deepEqual(usageRecords(story(), {}), []);
  const approval = { decision: 'approved', generation: 2, at: '2026-11-01T00:00:00.000Z', authorityGroup: 'product', reviewPacketSha256: 'p'.repeat(64) };
  const approved = story({ phases: { specification: { id: 'specification', status: 'approved', approvals: [{ ...approval, generation: 1, invalidatedAt: 'x' }, approval] }, planning: { approvals: [] } } });
  const claimed = usageRecords(approved, { specification: [slice] });
  assert.deepEqual(claimed.map((entry) => entry.path), [`singularity/specifications/${SPEC}/usage/S-1/000002.json`]);
  assert.deepEqual([claimed[0].record.kind, claimed[0].record.revision, claimed[0].record.clauses, claimed[0].record.receipt.reviewPacketSha256],
    ['claimed', 1, [`${SPEC}:REQ-001`, `${SPEC}:AC-001`], 'p'.repeat(64)]);
  assert.deepEqual(usageRecords(structuredClone(approved), { specification: [slice] })[0].bytes, claimed[0].bytes, 'a repair writes the same bytes');
  const closed = { ...approved, status: 'closed', completion: { label: 'Complete', kind: 'complete', inputSha256: 'i'.repeat(64), assuranceFloor: 'tested', evaluatedAt: '2026-11-02T00:00:00.000Z' } };
  const both = usageRecords(closed, { specification: [slice] });
  assert.deepEqual(both.map((entry) => [entry.record.kind, path.posix.basename(entry.path)]), [['claimed', '000002.json'], ['delivered', 'delivered.json']]);
  assert.equal(both[1].record.receipt.inputSha256, 'i'.repeat(64), 'delivery cites the completion its final check recorded');

  const excluded = { ...approved, scopeDispositions: [{ item: sliceClauseItem(slice.clauses[1]), disposition: 'excluded', reason: 'Elsewhere.' }] };
  assert.deepEqual([usageRecords(excluded, { specification: [slice] })[0].record.clauses, usageRecords(excluded, { specification: [slice] })[0].record.dropped],
    [[`${SPEC}:REQ-001`], [`${SPEC}:AC-001`]], 'a clause whose scope item a person excluded is dropped, not claimed');

  const other = { ...claimed[0].record, workId: 'S-2', clauses: [`${SPEC}:REQ-001`] };
  const coverage = coverageOf(revision(), [both[0].record, both[1].record, other]);
  assert.deepEqual(coverage.map((entry) => [entry.clause, entry.status, entry.deliveredBy, entry.claimedBy]), [
    [`${SPEC}:REQ-001`, 'delivered', ['S-1'], ['S-2']], [`${SPEC}:REQ-002`, 'uncovered', [], []],
    [`${SPEC}:AC-001`, 'delivered', ['S-1'], []], [`${SPEC}:AC-002`, 'uncovered', [], []]
  ]);
});

test('dropping a slice clause is the person\'s own step; coverage reads, its repair writes (SPA:AC-014)', () => {
  assert.equal(ownTerminalStep(`singularity-flow spec attach S-1 --drop ${SPEC}:REQ-001 --reason Elsewhere.`), 'spec-slice-change');
  assert.equal(ownTerminalStep(`singularity-flow spec author coverage ${SPEC}@1`), null);
  const operation = (positionals, options = {}) => {
    const resolved = resolveOperation({ requestedCommand: 'spec', positionals, options });
    return [resolved.id, resolved.classification, resolved.modelPolicy];
  };
  assert.deepEqual(operation(['spec', 'author', 'coverage', `${SPEC}@1`]), ['spec.author.coverage', 'read', 'never']);
  assert.deepEqual(operation(['spec', 'author', 'coverage', `${SPEC}@1`], { repair: true, story: 'S-1' }), ['spec.author.coverage.repair', 'mutation', 'never']);
  assert.deepEqual(operation(['spec', 'attach', 'S-1', SPEC]), ['spec.attach', 'mutation', 'never']);
});

const WORK = 'SPS-1';

/** Publish SPEC-CHK-004@1 reviewed from the repository's clone, as a person would. */
async function publishLibrary({ directory, cli }) {
  const file = path.join(directory, 'library-spec.md');
  await writeFile(file, librarySpec());
  cli('spec', 'author', 'new', SPEC, '--kind', 'business', '--title', 'Order discount threshold');
  cli('spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', '1');
  cli('spec', 'author', 'gap', SPEC, '--kind', 'vague-term', '--question', 'Is INR 5000.00 itself discounted?');
  cli('spec', 'author', 'decide', SPEC, 'GAP-001', '--choice', 'Only totals strictly above INR 5000.00 qualify.', '--reason', 'Finance.');
  cli('spec', 'author', 'settle', SPEC, '--all-articles', 'satisfied');
  cli('spec', 'author', 'publish', SPEC, '--reviewed');
}

test('a clarification checkpoint treats a pinned slice as settled, and says nothing of slices for a Story without one (SPA:REQ-018)', () => {
  // The S2 live run: under a required checkpoint every slice Story asked its decided questions again.
  const missing = { recordState: 'missing', record: null, errors: ['missing'] };
  assert.match(clarificationCheckpoint({ mode: 'required' }, missing, { slices: [`${SPEC}@1`] }).instruction,
    /So is the specification slice in the pinned Story source \(SPEC-CHK-004@1\): its clauses and decided questions are never asked again or put up for confirmation; ask only what they leave open\./u);
  assert.doesNotMatch(clarificationCheckpoint({ mode: 'required' }, missing).instruction, /specification slice/u);
  assert.doesNotMatch(clarificationCheckpoint({ mode: 'required' }, { recordState: 'present', errors: [] }, { slices: [`${SPEC}@1`] }).instruction, /specification slice/u);
});

test('prepare names each source statement its draft has yet to link, with its scope reference, in text and JSON; a linked draft and a step that owns no scope add nothing', async (t) => {
  // The S2 live check: both discount Stories went from their clarification answers to prepare, never
  // read the phase-entry scopeReview the bounded result had moved to its file, and linked no sliced clause.
  const story = await startedSpecificationStory(t, 'SPS-4', {
    beforeStart: publishLibrary,
    startArguments: ['--spec', `${SPEC}@1=REQ-001,AC-001`]
  });
  const { cli, item } = story;
  const json = (...args) => JSON.parse(cli(...args, '--json').stdout);
  const sliced = [`[${SPEC}:REQ-001] ${REQ_001}`, `[${SPEC}:AC-001] ${AC_001}`];
  const text = cli('prepare', 'specification').stdout;
  assert.match(text, /source statement\(s\) are not linked yet: cover each with a clause in this draft that cites its reference inside that clause: /u);
  for (const statement of sliced) {
    assert.ok(text.includes(`[scope:${scopeItemId('story', statement)}] "${statement}"`), `the text names ${statement} with its reference`);
  }
  const prepared = json('prepare', 'specification');
  const scope = prepared.data.preparation.scope;
  assert.equal(scope.status, 'repair-or-human-decision');
  for (const statement of sliced) {
    const entry = scope.items.find((candidate) => candidate.text === statement);
    assert.equal(entry?.sourceReference, `[scope:${scopeItemId('story', statement)}]`);
  }
  assert.equal(scope.items.length, scope.unresolvedCount, 'every unresolved statement here is the draft\'s to link');
  assert.equal(prepared.outcome.status, 'succeeded', 'guidance never refuses preparation');
  assert.deepEqual(json('evidence', 'scope', 'SPS-4').data.scope.items.map((entry) => entry.disposition).filter((value) => value !== 'unresolved'), [],
    'preparing decided nothing');

  // Linking every statement inside a real clause leaves nothing to name.
  const draft = path.join(item, 'artifacts/specification/spec.md');
  const references = scope.items.map((entry) => entry.sourceReference).join(' ');
  await writeFile(draft, specification('SPS-4', 1).replace('- The application returns the value 1. [SPS-4:REQ-002]',
    `- ${REQ_001} The approved value is returned. ${references} [SPS-4:REQ-002]`));
  const covered = json('prepare', 'specification');
  assert.equal(covered.data.preparation.scope, undefined);
  assert.doesNotMatch(covered.rendered.headline, /not linked yet|scope preview/u);

  // A step that owns no scope prepares as before.
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  cli('approve', 'specification', '--yes');
  const planning = json('prepare', 'planning');
  assert.equal(planning.data.preparation.scope, undefined);
  assert.doesNotMatch(planning.rendered.headline, /not linked yet|scope preview/u);
});

test('a prepared draft whose scope preview is unavailable says so, never that nothing is left to link', () => {
  const headline = (scope) => MESSAGES['prepare.succeeded'].headline({ phase: 'specification', path: 'spec.md', ...(scope ? { scope } : {}) });
  const unavailable = headline({ status: 'unavailable', reason: 'scope-preview-unavailable', inspect: 'singularity-flow evidence scope W --for-agent --json' });
  assert.match(unavailable, /Its scope preview is unavailable \(scope-preview-unavailable\), so which source statements it must link is not known: singularity-flow evidence scope W --for-agent --json\./u);
  assert.doesNotMatch(unavailable, /not linked yet/u);
  assert.equal(headline(null), 'specification is ready to author in spec.md.', 'no scope block, no change');
  assert.match(headline({ status: 'repair-or-human-decision', items: [{ sourceReference: '[scope:SRI-0123456789ab]', text: 'Totals above INR 5000.00 qualify.' }],
    more: 2, inspect: 'singularity-flow evidence scope W --for-agent --json' }),
  /1 source statement\(s\) are not linked yet: .*\[scope:SRI-0123456789ab\] "Totals above INR 5000\.00 qualify\."\. 2 more: singularity-flow evidence scope W --for-agent --json\.$/u);
});

test('a Story started with a slice sees it in its prompt and scope, records its claim after approval, and repairs a lost write (SPA:AC-011, AC-013 to AC-017)', async (t) => {
  const story = await startedSpecificationStory(t, WORK, {
    beforeStart: publishLibrary,
    startArguments: ['--spec', `${SPEC}@1=REQ-001,AC-001`]
  });
  const { directory, remote, run, git, cli, item } = story;
  const json = (...args) => JSON.parse(cli(...args, '--json').stdout);
  const refused = (...args) => {
    const result = run(process.execPath, [CLI, '--no-model', ...args, '--json'], { allowFailure: true });
    assert.notEqual(result.status, 0, `${args.join(' ')} was expected to be refused`);
    return `${result.stdout}${result.stderr}`;
  };

  // AC-011: the source carries the slice; the composed prompt shows it verbatim.
  const source = JSON.parse(await readFile(path.join(item, 'source.json'), 'utf8'));
  assert.equal(source.specification.length, 1);
  const [slice] = source.specification;
  assert.deepEqual(slice.clauses.map((clause) => clause.anchor), [`[${SPEC}:REQ-001]`, `[${SPEC}:AC-001]`]);
  assert.deepEqual(slice.decisions.map((entry) => entry.gap), ['GAP-001']);
  assert.deepEqual(slice.notThisStory.map((entry) => entry.anchor), [`[${SPEC}:REQ-002]`, `[${SPEC}:AC-002]`]);
  assert.match(await readFile(path.join(item, 'USER-STORY.md'), 'utf8'), /## Specification slice\n\n### SPEC-CHK-004@1 — Order discount threshold/u);
  const prompt = cli('wm', 'compose', '--phase', 'specification', '--work-id', WORK, '--render-only').stdout;
  for (const expected of [REQ_001, 'Only totals strictly above INR 5000.00 qualify.', `[${SPEC}:REQ-002]`, `${SPEC}@1`]) {
    assert.ok(prompt.includes(expected), `the intake prompt shows: ${expected}`);
  }
  // REQ-018: the first step's clarification checkpoint names the slice as settled.
  assert.match(json('clarification', 'status', 'specification').data.checkpoint.instruction, /specification slice in the pinned Story source \(SPEC-CHK-004@1\)/u);

  // AC-013: each sliced clause is a scope item of its own.
  const scope = () => json('evidence', 'scope', WORK).data.scope.items.filter((entry) => entry.field === 'specification');
  assert.deepEqual(scope().map((entry) => [entry.text, entry.disposition]), [[`[${SPEC}:REQ-001] ${REQ_001}`, 'unresolved'], [`[${SPEC}:AC-001] ${AC_001}`, 'unresolved']]);

  // AC-014: the person drops a clause with a reason: its scope item is excluded, so nothing requires it.
  // The source itself never changes after start; attaching to a started Story is refused.
  assert.match(refused('spec', 'attach', WORK, `${SPEC}@1=REQ-002`), /SPEC_SLICE_ATTACH_AT_START/u);
  assert.match(refused('spec', 'attach', WORK, '--drop', 'AC-001'), /SPEC_SLICE_REASON_MISSING/u);
  const sourceBytes = await readFile(path.join(item, 'source.json'));
  cli('spec', 'attach', WORK, '--drop', 'AC-001', '--reason', 'Verified by the pricing Story.');
  assert.deepEqual(await readFile(path.join(item, 'source.json')), sourceBytes, 'the pinned source is unchanged');
  const afterDrop = scope();
  assert.deepEqual(afterDrop.map((entry) => [entry.disposition, entry.decision?.reason ?? null]),
    [['unresolved', null], ['excluded', 'Verified by the pricing Story.']]);

  // The Story covers the rest of its slice and is submitted and approved.
  const storySpec = specification(WORK, 1).replace(`- The application returns the value 1. [${WORK}:REQ-002]`, `- ${REQ_001} [${WORK}:REQ-002]`);
  assert.ok(storySpec.includes(REQ_001));
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), storySpec);
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  assert.deepEqual(scope().map((entry) => entry.disposition), ['included', 'excluded']);
  cli('submit', 'specification', '--skip-checks');

  // AC-016: the usage write fails (the remote refuses usage paths); the approval stands, and names the repair.
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/state ] && git diff --name-only "$old" "$new" | grep -q /usage/; then echo "usage refused" >&2; exit 1; fi\ndone\n');
  await chmod(hook, 0o755);
  const approved = cli('approve', 'specification', '--yes');
  assert.match(approved.stderr, new RegExp(`spec author coverage ${SPEC}@1 --repair --story ${WORK}`, 'u'));
  assert.equal(JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).phases.specification.status, 'approved');
  const before = json('spec', 'author', 'coverage', `${SPEC}@1`);
  assert.deepEqual(before.counts, { delivered: 0, claimed: 0, allocated: 0, 'left-out': 0, uncovered: 4 });
  await rm(hook);
  const repaired = json('spec', 'author', 'coverage', `${SPEC}@1`, '--repair', '--story', WORK);
  assert.deepEqual([repaired.repaired.written.length, repaired.counts], [1, { delivered: 0, claimed: 1, allocated: 0, 'left-out': 0, uncovered: 3 }]);
  assert.deepEqual(repaired.clauses.filter((entry) => entry.status === 'claimed').map((entry) => [entry.clause, entry.claimedBy]),
    [[`${SPEC}:REQ-001`, [WORK]]], 'the dropped clause is not claimed');
  assert.equal(json('spec', 'author', 'coverage', `${SPEC}@1`, '--repair', '--story', WORK).repaired.written.length, 0, 'a second repair writes nothing');

  // AC-017: a new revision changes neither the Story's pinned slice nor coverage of @1.
  const file = path.join(directory, 'library-spec.md');
  git('checkout', '-q', 'main');
  await writeFile(file, librarySpec('\n- Revised wording.'));
  cli('spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', String(json('spec', 'author', 'status', SPEC).sequence));
  cli('spec', 'author', 'settle', SPEC, '--all-articles', 'satisfied');
  assert.equal(json('spec', 'author', 'publish', SPEC, '--reviewed').revision, 2);
  assert.equal(git('show', `${WORK}:singularity/work-items/${WORK}/source.json`).includes(`"revision": "${SPEC}@1"`), true);
  assert.deepEqual(json('spec', 'author', 'coverage', `${SPEC}@1`).counts, { delivered: 0, claimed: 1, allocated: 0, 'left-out': 0, uncovered: 3 });
  assert.deepEqual(json('spec', 'author', 'coverage', `${SPEC}@2`).counts, { delivered: 0, claimed: 0, allocated: 0, 'left-out': 0, uncovered: 4 });

  // AC-015: a second Story's approval records its claim itself, on the revision it pinned.
  cli('start', 'SPS-2', '--from-branch', 'main', '--work-type', 'spec-driven-standard', '--title', 'Foreign carts', '--description', 'No discount outside INR.',
    '--spec', `${SPEC}=REQ-002`);
  const second = path.join(path.dirname(item), 'SPS-2');
  assert.equal(JSON.parse(await readFile(path.join(second, 'source.json'), 'utf8')).specification[0].revision, `${SPEC}@2`, 'without @N, the highest reviewed revision');
  await writeFile(path.join(second, 'artifacts/specification/spec.md'), specification('SPS-2', 1)
    .replace('- The application returns the value 1. [SPS-2:REQ-002]', `- ${REQ_002} [SPS-2:REQ-002]`));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  assert.match(cli('approve', 'specification', '--yes').stdout, new RegExp(`Recorded this Story's use of ${SPEC}@2 on the state branch: claimed`, 'u'));
  assert.deepEqual(json('spec', 'author', 'coverage', `${SPEC}@2`).clauses.filter((entry) => entry.status === 'claimed').map((entry) => [entry.clause, entry.claimedBy]),
    [[`${SPEC}:REQ-002`, ['SPS-2']]]);

  // AC-012 at start: a clause the revision lacks is refused before any Story exists.
  assert.match(refused('start', 'SPS-3', '--from-branch', 'main', '--work-type', 'spec-driven-standard', '--title', 'T', '--description', 'D',
    '--spec', `${SPEC}@1=REQ-009`), /SPEC-CHK-004:REQ-009 is not a clause of SPEC-CHK-004@1/u);
  assert.equal(git('branch', '--list', 'SPS-3'), '', 'nothing was created');
});

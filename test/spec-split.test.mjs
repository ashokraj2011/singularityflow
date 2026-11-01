import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ownTerminalStep } from '../src/command-skills.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { argvAllowed } from '../src/copilot-mutation-guard.mjs';
import { extractClauses } from '../src/specifications.mjs';
import { contradictedClauses, dependencyCycle, dependencyOrder, unallocatedClauses } from '../src/spec-library/allocation.mjs';
import { allocatedCoverage, analyzeSplit, childClauses, childSpecText, splitCoverage } from '../src/spec-library/split.mjs';
import { coverageOf } from '../src/spec-library/usage.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

// SPEC-SPA v1.3 S5: one reviewed revision split into child specifications and Story slices, with
// coverage. Model-free: every CLI runs with models disabled.

const engine = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(engine, 'bin', 'singularity-flow.mjs');
const SPEC = 'SPEC-CHK-004';
const CHILD = 'SPEC-CHK-004-INR';
const REQ_001 = 'WHEN an INR order total is strictly greater than INR 5000.00, the cart SHALL apply a 10 percent order discount.';
const REQ_002 = 'WHEN a cart is not in INR, the cart SHALL apply no order discount.';
const CON_001 = 'The discount SHALL be computed in paise, never in rupees.';
const AC_001 = `An INR 5000.01 cart gets INR 500.00 off and an INR 5000.00 cart gets nothing, as ${SPEC}:REQ-001 states.`;
const AC_002 = `A USD cart of 6000.00 gets nothing off, as ${SPEC}:REQ-002 states.`;

function librarySpec({ req002 = REQ_002 } = {}) {
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

${req002} [${SPEC}:REQ-002]

${CON_001} [${SPEC}:CON-001]

## Acceptance

${AC_001} [${SPEC}:AC-001]

${AC_002} [${SPEC}:AC-002]

## Decisions and open questions

- GAP-001: only totals strictly above INR 5000.00 qualify.
`;
}

/** A read revision as library.mjs readRevision returns it. */
function revision(spec = librarySpec(), number = 1) {
  return {
    specId: SPEC, revision: number, commit: 'c'.repeat(40), manifestSha256: `sha256:${'a'.repeat(64)}`,
    manifest: { specId: SPEC, revision: number, title: 'Order discount threshold', reviewState: 'reviewed' }, spec,
    gaps: { events: [
      { event: 'opened', gap: 'GAP-001', kind: 'vague-term', question: 'Is INR 5000.00 itself discounted?', clauses: [`${SPEC}:REQ-001`], options: [], by: 'p', at: 't' },
      { event: 'decided', gap: 'GAP-001', option: null, choice: 'Only totals strictly above INR 5000.00 qualify.', reason: 'Finance.', by: 'p', at: 't' }
    ] }
  };
}

const PLAN = {
  children: [{ specId: CHILD, title: 'INR order discount', clauses: ['REQ-001', 'AC-001'] }],
  stories: [
    { key: 'S1', title: 'No discount outside INR', description: "A USD cart's total is never discounted.", clauses: ['REQ-002', 'AC-002'] },
    { key: 'S2', title: 'Discount acceptance', clauses: ['AC-001'] }
  ],
  notDelivered: [{ clause: 'CON-001', reason: 'Already true in the pricing module.' }]
};

test('the allocation rules: every clause allocated or left out, no slice cycle, a dependency order (SPA:REQ-025)', () => {
  const allocations = [{ clauses: ['A', 'B'] }, { clauses: ['B'] }];
  assert.deepEqual(unallocatedClauses(['A', 'B', 'C', 'D'], allocations, [{ clause: 'D' }]), ['C']);
  assert.deepEqual(contradictedClauses(allocations, [{ clause: 'B' }, { clause: 'D' }]), ['B']);
  const edges = new Map([['S1', new Set(['S2'])], ['S2', new Set(['S3'])], ['S3', new Set(['S1'])], ['S4', new Set()]]);
  assert.deepEqual(dependencyCycle(['S1', 'S2', 'S3', 'S4'], edges), ['S1', 'S2', 'S3', 'S1']);
  const acyclic = new Map([['S1', new Set(['S2'])], ['S2', new Set()], ['S3', new Set(['S1'])]]);
  assert.equal(dependencyCycle(['S1', 'S2', 'S3'], acyclic), null);
  assert.deepEqual(dependencyOrder(['S1', 'S2', 'S3'], acyclic), ['S2', 'S1', 'S3']);
});

test('a split that leaves a clause unallocated, or whose slices form a cycle, is refused naming it (SPA:AC-026)', () => {
  const read = revision();
  const missing = analyzeSplit(read, { ...PLAN, notDelivered: [] });
  assert.deepEqual(missing.findings.map((entry) => [entry.code, entry.at]), [['split.clause-unallocated', `${SPEC}:CON-001`]]);

  const cycle = analyzeSplit(read, { ...PLAN, stories: [
    { key: 'S1', title: 'One', clauses: ['REQ-002'], dependsOn: ['S2'] },
    { key: 'S2', title: 'Two', clauses: ['AC-002', 'AC-001'], dependsOn: ['S1'] }
  ] });
  const found = cycle.findings.find((entry) => entry.code === 'split.dependency-cycle');
  assert.ok(found, JSON.stringify(cycle.findings));
  assert.match(found.message, /S1 → S2 → S1/u);

  // A clause depending on one another slice delivers orders the slices; S2 after S1 closes no cycle.
  const implied = analyzeSplit(read, { ...PLAN, stories: [
    { key: 'S1', title: 'Rule', clauses: ['REQ-002'] },
    { key: 'S2', title: 'Proof', clauses: ['AC-002'] }
  ] });
  assert.deepEqual(implied.findings, []);
  assert.deepEqual(implied.stories.find((story) => story.key === 'S2').dependsOn, ['S1']);
  assert.deepEqual(implied.order, ['S1', 'S2']);
  const reverse = analyzeSplit(read, { ...PLAN, stories: [
    { key: 'S1', title: 'Rule', clauses: ['REQ-002'], dependsOn: ['S2'] },
    { key: 'S2', title: 'Proof', clauses: ['AC-002'] }
  ] });
  assert.ok(reverse.findings.some((entry) => entry.code === 'split.dependency-cycle'), 'the stated order contradicts the clauses\' own dependency');

  const shapes = analyzeSplit(read, { children: [{ specId: SPEC, title: 'Same', clauses: ['REQ-009'] }], stories: [{ title: '', clauses: [] }], extra: true });
  assert.deepEqual([...new Set(shapes.findings.map((entry) => entry.code))].sort(), ['split.child-id', 'split.clause-unknown', 'split.shape']);
});

test('each Story slice becomes one ready start command; one depending on a clause delivered elsewhere says why (SPA:AC-027)', () => {
  const analysis = analyzeSplit(revision(), PLAN);
  assert.deepEqual(analysis.findings, []);
  const [s1, s2] = analysis.stories;
  assert.equal(s1.command, `singularity-flow start <WORK-ID> --from-branch <BRANCH> --title 'No discount outside INR' --description 'A USD cart'\\''s total is never discounted.' --spec ${SPEC}@1=REQ-002,AC-002`);
  assert.match(s2.command, new RegExp(`--spec ${SPEC}@1=AC-001 --allow-partial-dependency --reason 'Delivered elsewhere by the split of ${SPEC}@1: ${SPEC}:REQ-001 \\(child ${CHILD}\\)'$`, 'u'));
  const whole = analyzeSplit(revision(), { stories: [{ title: 'Everything', workId: 'ENG-7', clauses: ['REQ-001', 'REQ-002', 'CON-001', 'AC-001', 'AC-002'] }] });
  assert.equal(whole.stories[0].command, `singularity-flow start ENG-7 --from-branch <BRANCH> --title 'Everything' --spec ${SPEC}@1`);
});

test('a child draft carries its clauses under its own ID with the parent\'s numbers, and the parent decisions on them', () => {
  const read = revision();
  const text = childSpecText(read, PLAN.children[0] && { ...PLAN.children[0], clauses: [`${SPEC}:REQ-001`, `${SPEC}:AC-001`] }, { split: 1 });
  const clauses = extractClauses(text, { namespace: CHILD });
  assert.deepEqual(clauses.map((clause) => clause.id), [`${CHILD}:REQ-001`, `${CHILD}:AC-001`]);
  assert.equal(clauses[0].body, REQ_001);
  assert.deepEqual(clauses[1].dependsOn, [`${CHILD}:REQ-001`], 'a reference to a taken clause follows it into the child');
  assert.match(text, new RegExp(`Derived from ${SPEC}@1, split 1`, 'u'));
  assert.match(text, /- SPEC-CHK-004 GAP-001: Only totals strictly above INR 5000\.00 qualify\./u);
  const derived = childClauses(read, { specId: CHILD, clauses: [`${SPEC}:REQ-001`] });
  assert.deepEqual(derived.map(({ parent, child }) => [parent, child]), [[`${SPEC}:REQ-001`, `${CHILD}:REQ-001`]]);
  assert.match(derived[0].bodySha256, /^[a-f0-9]{64}$/u);
});

test('coverage per clause: delivered, claimed, allocated, left out or uncovered, and children whose parent moved (SPA:AC-028, AC-029)', () => {
  const one = revision();
  const analysis = analyzeSplit(one, PLAN);
  const split = { specId: SPEC, revision: 1, split: 1, recordedAt: 't', publishedBy: null,
    children: [{ specId: CHILD, title: 'INR order discount', clauses: childClauses(one, { specId: CHILD, clauses: [`${SPEC}:REQ-001`, `${SPEC}:AC-001`] }) }],
    stories: analysis.stories, notDelivered: analysis.plan.notDelivered };
  const at1 = splitCoverage(one, [split]);
  const records = [
    { kind: 'delivered', workId: 'S-1', clauses: [`${SPEC}:REQ-002`], generation: 1 },
    { kind: 'delivered', workId: 'S-2', clauses: [`${SPEC}:AC-002`], generation: 1 },
    { kind: 'claimed', workId: 'S-3', clauses: [`${SPEC}:AC-001`], generation: 1 }
  ];
  const rows = allocatedCoverage(coverageOf(one, records), at1);
  assert.deepEqual(rows.map((row) => [row.clause.slice(SPEC.length + 1), row.status]),
    [['REQ-001', 'allocated'], ['REQ-002', 'delivered'], ['CON-001', 'left-out'], ['AC-001', 'claimed'], ['AC-002', 'delivered']]);
  assert.deepEqual(rows[0].allocatedTo, [{ kind: 'child', specId: CHILD, title: 'INR order discount' }]);
  assert.equal(rows[2].leftOut, 'Already true in the pricing module.');
  assert.deepEqual(at1.children.map((child) => child.status), ['current']);
  assert.equal(allocatedCoverage(coverageOf(one, []), splitCoverage(one, [])).every((row) => row.status === 'uncovered'), true, 'without a split nothing is allocated');

  const two = revision(librarySpec().replace(REQ_001, 'WHEN an INR order total is INR 5000.00 or more, the cart SHALL apply a 10 percent order discount.'), 2);
  const at2 = splitCoverage(two, [split]);
  assert.equal(at2.split, null, 'the split was of @1; @2 has no allocation of its own');
  assert.deepEqual(at2.children, [{ specId: CHILD, title: 'INR order discount', split: 1, fromRevision: 1, status: 'parent-moved', changed: [`${SPEC}:REQ-001`] }]);
  const untouched = splitCoverage(revision(librarySpec({ req002: 'WHEN a cart is in USD, the cart SHALL apply no order discount.' }), 2), [split]);
  assert.equal(untouched.children[0].status, 'unchanged', 'a parent change to a clause the child did not take leaves it alone');
});

test('publishing a split is the person\'s own step; proposing and reading one are not', () => {
  const name = `${SPEC}@1`;
  assert.equal(ownTerminalStep(`singularity-flow spec split ${name} --publish`), 'spec-split-publication');
  assert.equal(ownTerminalStep(`singularity-flow spec split ${name} --propose --file plan.json`), null);
  assert.equal(ownTerminalStep(`singularity-flow spec split ${name}`), null);
  const operation = (options) => resolveOperation({ requestedCommand: 'spec', positionals: ['spec', 'split', name], options });
  assert.deepEqual([operation({}).id, operation({}).classification, operation({}).modelPolicy], ['spec.split', 'read', 'never']);
  assert.deepEqual([operation({ propose: true, file: 'plan.json' }).id, operation({ propose: true, file: 'plan.json' }).classification], ['spec.split.propose', 'mutation']);
  assert.deepEqual([operation({ publish: true }).id, operation({ publish: true }).classification], ['spec.split.publish', 'mutation']);
  assert.equal(argvAllowed(['spec', 'split', name, '--publish'], 'phase', {}), false);
  // The /sf-spec-author turn (S4) stages only the proposal file it was issued: a split is the person's to publish.
  assert.equal(argvAllowed(['spec', 'split', name, '--publish'], 'spec-studio', {}), false);
  assert.equal(argvAllowed(['spec', 'split', name, '--propose', '--file', '/tmp/plan.json'], 'spec-studio', { specStaging: ['/tmp/plan.json'] }), false);
});

// ---- End to end, model off ---------------------------------------------------------------------

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

function sf(cwd, args, { fail = false } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd, encoding: 'utf8', timeout: childTimeout(120_000), maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
  });
  if (fail) assert.notEqual(result.status, 0, `${args.join(' ')} was expected to be refused:\n${result.stdout}`);
  else assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const json = (cwd, args) => JSON.parse(sf(cwd, [...args, '--json']).stdout);
const refused = (cwd, args) => JSON.parse(sf(cwd, [...args, '--json'], { fail: true }).stdout).error;

async function repository(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-split-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const remote = path.join(directory, 'remote.git');
  const root = path.join(directory, 'app');
  git(directory, 'init', '-q', '--bare', '-b', 'main', remote);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{ "name": "storefront", "type": "module" }\n');
  await writeFile(path.join(root, 'src', 'pricing.mjs'), 'export const DISCOUNT_THRESHOLD = 500000;\n');
  git(directory, 'init', '-q', '-b', 'main', root);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Storefront');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  return { directory, root, remote };
}

/** Publish the specification's next reviewed revision from this clone's draft, as a person would. */
async function publishReviewed(root, directory, spec, { first = false } = {}) {
  const file = path.join(directory, `spec-${Date.now()}.md`);
  await writeFile(file, spec);
  if (first) {
    sf(root, ['spec', 'author', 'new', SPEC, '--title', 'Order discount threshold']);
    sf(root, ['spec', 'author', 'gap', SPEC, '--kind', 'vague-term', '--question', 'Is INR 5000.00 itself discounted?', '--clause', `${SPEC}:REQ-001`]);
    sf(root, ['spec', 'author', 'decide', SPEC, 'GAP-001', '--choice', 'Only totals strictly above INR 5000.00 qualify.', '--reason', 'Finance.']);
  }
  sf(root, ['spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', String(json(root, ['spec', 'author', 'status', SPEC]).sequence)]);
  sf(root, ['spec', 'author', 'settle', SPEC, '--all-articles', 'satisfied']);
  return json(root, ['spec', 'author', 'publish', SPEC, '--reviewed']).revision;
}

test('a person splits a reviewed revision: the plan is checked when proposed, the split is bound to the parent digest, children are drafted and no Story starts (SPA:AC-026 to AC-028)', async (t) => {
  const { directory, root, remote } = await repository(t);
  assert.equal(await publishReviewed(root, directory, librarySpec(), { first: true }), 1);
  const name = `${SPEC}@1`;
  const planFile = (plan) => { const file = path.join(directory, `plan-${Math.random().toString(36).slice(2)}.yml`); return writeFile(file, JSON.stringify(plan)).then(() => file); };

  const unallocated = refused(root, ['spec', 'split', name, '--propose', '--file', await planFile({ ...PLAN, notDelivered: [] })]);
  assert.equal(unallocated.code, 'SPEC_SPLIT_CLAUSE_UNALLOCATED');
  assert.match(unallocated.message, /SPEC-CHK-004:CON-001 is allocated to no child or Story slice/u);
  assert.equal(unallocated.details.nextAction, `singularity-flow spec split ${name} --propose --file FILE`);
  const cyclic = refused(root, ['spec', 'split', name, '--propose', '--file', await planFile({ ...PLAN, stories: [
    { key: 'S1', title: 'One', clauses: ['REQ-002'], dependsOn: ['S2'] }, { key: 'S2', title: 'Two', clauses: ['AC-002'] }] })]);
  assert.equal(cyclic.code, 'SPEC_SPLIT_DEPENDENCY_CYCLE');
  assert.equal(json(root, ['spec', 'split', name]).proposal, null, 'a refused plan is not proposed');
  assert.equal(refused(root, ['spec', 'split', name, '--publish']).code, 'SPEC_SPLIT_PROPOSAL_MISSING');

  const proposed = json(root, ['spec', 'split', name, '--propose', '--file', await planFile(PLAN)]);
  assert.deepEqual(proposed.stories.map((story) => story.key), ['S1', 'S2']);
  const read = json(root, ['spec', 'split', name]);
  assert.equal(read.proposal.planSha256, proposed.planSha256);
  assert.deepEqual(read.splits, []);

  const published = json(root, ['spec', 'split', name, '--publish']);
  assert.deepEqual([published.split, published.replayed], [1, false]);
  assert.deepEqual(published.children.map((child) => [child.specId, child.sequence]), [[CHILD, 1]]);
  const [splitRecord] = json(root, ['spec', 'split', name]).splits;
  const manifest = json(root, ['spec', 'author', 'show', name]);
  assert.equal(splitRecord.manifestSha256, manifest.manifestSha256, 'the split is bound to the parent revision\'s manifest digest');
  assert.deepEqual(splitRecord.notDelivered, [{ clause: `${SPEC}:CON-001`, reason: 'Already true in the pricing module.' }]);
  assert.match(splitRecord.stories[1].command, /--allow-partial-dependency --reason/u);
  assert.equal(json(root, ['spec', 'split', name]).proposal, null, 'publishing consumed the proposal');
  const files = git(root, 'ls-tree', '-r', '--name-only', 'origin/state').split('\n').filter((file) => file.includes('/splits/'));
  assert.deepEqual(files, [`singularity/specifications/${SPEC}/splits/000001/split.json`]);

  const child = json(root, ['spec', 'author', 'status', CHILD]);
  assert.deepEqual(child.clauseIds, [`${CHILD}:REQ-001`, `${CHILD}:AC-001`]);
  const draftDirectory = path.join(root, '.git', 'singularity-flow', 'spec-drafts', CHILD);
  assert.deepEqual(await readdir(draftDirectory), ['000001.json']);

  // No Story was started: no work item, and the remote holds only main and the state branch.
  assert.equal(git(root, 'ls-tree', '--name-only', 'HEAD', 'singularity'), '');
  assert.deepEqual(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').sort(), ['refs/heads/main', 'refs/heads/state']);

  // The same plan proposed and published again is the split already published, not a second one.
  json(root, ['spec', 'split', name, '--propose', '--file', await planFile(PLAN)]);
  const again = json(root, ['spec', 'split', name, '--publish']);
  assert.deepEqual([again.split, again.replayed, again.children[0].replayed], [1, true, true]);

  const coverage = json(root, ['spec', 'author', 'coverage', name]);
  assert.deepEqual(coverage.clauses.map((row) => row.status), ['allocated', 'allocated', 'left-out', 'allocated', 'allocated']);
  assert.deepEqual(coverage.split.split, 1);
  assert.deepEqual(coverage.counts, { delivered: 0, claimed: 0, allocated: 4, 'left-out': 1, uncovered: 0 });

  // A later parent revision changes a clause the child took: the child shows "parent moved" and is unchanged.
  assert.equal(await publishReviewed(root, directory, librarySpec().replace(REQ_001, 'WHEN an INR order total is INR 5000.00 or more, the cart SHALL apply a 10 percent order discount.')), 2);
  const moved = json(root, ['spec', 'author', 'coverage', `${SPEC}@2`]);
  assert.deepEqual(moved.children.map((entry) => [entry.specId, entry.status, entry.changed]), [[CHILD, 'parent-moved', [`${SPEC}:REQ-001`]]]);
  assert.equal(moved.split, null);
  assert.deepEqual(await readdir(draftDirectory), ['000001.json'], 'the child draft is unchanged');
  assert.match(sf(root, ['spec', 'author', 'coverage', `${SPEC}@2`]).stdout, /child SPEC-CHK-004-INR \(split 1 of @1\): parent moved; SPEC-CHK-004:REQ-001 changed since @1/u);
});

test('a draft revision cannot be split, and a child ID the library holds is refused before anything is published', async (t) => {
  const { directory, root } = await repository(t);
  await publishReviewed(root, directory, librarySpec(), { first: true });
  const draft = path.join(directory, 'draft.md');
  await writeFile(draft, librarySpec().replace('## Decisions and open questions', '## Decisions and open questions\n\nStill open.'));
  sf(root, ['spec', 'author', 'edit', SPEC, '--file', draft, '--expected-seq', String(json(root, ['spec', 'author', 'status', SPEC]).sequence)]);
  assert.equal(json(root, ['spec', 'author', 'publish', SPEC, '--draft']).revision, 2);
  assert.equal(refused(root, ['spec', 'split', `${SPEC}@2`]).code, 'SPEC_LIBRARY_NOT_REVIEWED');

  const plan = path.join(directory, 'plan.json');
  await writeFile(plan, JSON.stringify({ children: [{ specId: SPEC.replace('004', '005'), title: 'Taken', clauses: ['REQ-001', 'AC-001'] }],
    stories: [{ title: 'Rest', clauses: ['REQ-002', 'CON-001', 'AC-002'] }] }));
  sf(root, ['spec', 'author', 'new', 'SPEC-CHK-005', '--title', 'Another']);
  sf(root, ['spec', 'author', 'settle', 'SPEC-CHK-005', '--all-articles', 'satisfied']);
  json(root, ['spec', 'author', 'publish', 'SPEC-CHK-005', '--draft']);
  sf(root, ['spec', 'author', 'discard', 'SPEC-CHK-005']);
  json(root, ['spec', 'split', `${SPEC}@1`, '--propose', '--file', plan]);
  assert.equal(refused(root, ['spec', 'split', `${SPEC}@1`, '--publish']).code, 'SPEC_LIBRARY_ID_TAKEN');
  assert.deepEqual(json(root, ['spec', 'split', `${SPEC}@1`]).splits, [], 'nothing was published');
});

test('a backup carries this clone\'s split proposals and the Studio proposals staged in a draft; restore puts a missing one back byte-identical and keeps a different local one', async (t) => {
  const { directory, root } = await repository(t);
  assert.equal(await publishReviewed(root, directory, librarySpec(), { first: true }), 1);
  const name = `${SPEC}@1`;
  const planFile = path.join(directory, 'plan.json');
  await writeFile(planFile, JSON.stringify(PLAN));
  const { planSha256 } = json(root, ['spec', 'split', name, '--propose', '--file', planFile]);
  const proposals = path.join(root, '.git', 'singularity-flow', 'spec-split-proposals', SPEC);
  const proposalBytes = await readFile(path.join(proposals, '000001.json'));
  const studio = path.join(directory, 'studio.json');
  await writeFile(studio, JSON.stringify({ proposals: [{ kind: 'research', summary: 'The threshold lives in src/pricing.mjs.' }] }));
  assert.deepEqual(json(root, ['spec', 'author', 'propose', SPEC, '--file', studio]).staged, ['P-001']);

  // Unreadable records are named, never left out silently; what does verify is still carried.
  const drafts = path.join(root, '.git', 'singularity-flow', 'spec-drafts', SPEC);
  const head = json(root, ['spec', 'author', 'status', SPEC]).sequence;
  const torn = path.join(drafts, `${String(head + 1).padStart(6, '0')}.json`);
  await writeFile(torn, '{ "schemaVersion": 1, "torn');
  await writeFile(path.join(proposals, '000002.json'), 'not a proposal');
  const out = path.join(directory, 'backup');
  const created = json(root, ['backup', 'create', '--out', out]);
  assert.deepEqual([created.specDrafts, created.splitProposals], [1, 1]);
  assert.deepEqual(created.unreadableSpecDrafts, [{ specId: SPEC, carriedSequence: head, files: [path.basename(torn)] }]);
  assert.deepEqual(created.unreadableSplitProposals.map(({ specId, revision }) => [specId, revision]), [[SPEC, 2]]);
  await rm(torn);
  await rm(path.join(proposals, '000002.json'));
  assert.match(sf(root, ['backup', 'inspect', out]).stdout, /split proposal already-saved: SPEC-CHK-004@1/u);

  // Lost on this clone: restore puts both back as they were.
  await rm(proposals, { recursive: true });
  sf(root, ['spec', 'author', 'discard', SPEC]);
  const restored = json(root, ['backup', 'restore', out]);
  assert.equal(restored.status, 'restored');
  assert.deepEqual(restored.splitProposals.map((item) => [item.specId, item.revision, item.status]), [[SPEC, 1, 'restored']]);
  assert.deepEqual(restored.counts.splitProposals, { restored: 1, 'already-saved': 0, 'kept-local': 0, refused: 0 });
  assert.deepEqual(await readFile(path.join(proposals, '000001.json')), proposalBytes, 'the proposal is back byte-identical');
  assert.equal(json(root, ['spec', 'split', name]).proposal.planSha256, planSha256);
  assert.deepEqual(json(root, ['spec', 'author', 'status', SPEC]).proposals.map(({ id, kind }) => [id, kind]), [['P-001', 'research']],
    'the Studio proposal staged in the draft came back with it');
  assert.equal(json(root, ['backup', 'restore', out]).splitProposals[0].status, 'already-saved', 'restoring again changes nothing');

  // A different plan proposed here since is kept, never replaced.
  await writeFile(planFile, JSON.stringify({ ...PLAN, notDelivered: [{ clause: 'CON-001', reason: 'Another reason.' }] }));
  const local = json(root, ['spec', 'split', name, '--propose', '--file', planFile]).planSha256;
  assert.notEqual(local, planSha256);
  assert.equal(json(root, ['backup', 'restore', out]).splitProposals[0].status, 'kept-local');
  assert.equal(json(root, ['spec', 'split', name]).proposal.planSha256, local);

  // A backup an earlier build wrote (manifest v2, no split proposals) still restores.
  const older = path.join(directory, 'older');
  await mkdir(path.join(older, 'objects'), { recursive: true });
  const { splitProposals: _carried, ...manifest } = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
  await writeFile(path.join(older, 'manifest.json'), JSON.stringify({ ...manifest, schemaVersion: 2 }));
  sf(root, ['spec', 'author', 'discard', SPEC]);
  const fromOlder = json(root, ['backup', 'restore', older]);
  assert.deepEqual([fromOlder.status, fromOlder.splitProposals, fromOlder.specDrafts[0].status], ['restored', [], 'restored']);
});

/** A command line's words, as a POSIX shell reads single quotes ('\'' included). */
function words(command) {
  const out = [];
  let current = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "'") {
      const end = command.indexOf("'", index + 1);
      current = (current ?? '') + command.slice(index + 1, end);
      index = end;
    } else if (character === '\\') { current = (current ?? '') + command[index + 1]; index += 1; }
    else if (character === ' ') { if (current !== null) out.push(current); current = null; }
    else current = (current ?? '') + character;
  }
  if (current !== null) out.push(current);
  return out;
}

test('a slice\'s start command runs as written: the Story starts with that slice and its stated partial dependency', async (t) => {
  const { stories: [, slice] } = analyzeSplit(revision(), PLAN);
  const argv = words(slice.command);
  const from = argv.indexOf('--spec');
  assert.deepEqual(argv.slice(0, 3), ['singularity-flow', 'start', '<WORK-ID>']);
  const story = await startedSpecificationStory(t, 'SPL-1', {
    beforeStart: async ({ directory, cli }) => {
      const file = path.join(directory, 'library-spec.md');
      await writeFile(file, librarySpec());
      cli('spec', 'author', 'new', SPEC, '--title', 'Order discount threshold');
      cli('spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', '1');
      cli('spec', 'author', 'gap', SPEC, '--kind', 'vague-term', '--question', 'Is INR 5000.00 itself discounted?', '--clause', `${SPEC}:REQ-001`);
      cli('spec', 'author', 'decide', SPEC, 'GAP-001', '--choice', 'Only totals strictly above INR 5000.00 qualify.', '--reason', 'Finance.');
      cli('spec', 'author', 'settle', SPEC, '--all-articles', 'satisfied');
      cli('spec', 'author', 'publish', SPEC, '--reviewed');
      const plan = path.join(directory, 'plan.json');
      await writeFile(plan, JSON.stringify(PLAN));
      cli('spec', 'split', `${SPEC}@1`, '--propose', '--file', plan);
      const published = JSON.parse(cli('spec', 'split', `${SPEC}@1`, '--publish', '--json').stdout);
      assert.equal(published.stories[1].command, slice.command, 'the published command is the one checked here');
    },
    startArguments: argv.slice(from)
  });
  const [attached] = JSON.parse(await readFile(path.join(story.item, 'source.json'), 'utf8')).specification;
  assert.deepEqual(attached.clauses.map((clause) => clause.anchor), [`[${SPEC}:AC-001]`]);
  assert.deepEqual(attached.partialDependency.missing, [{ clause: `${SPEC}:AC-001`, dependsOn: `${SPEC}:REQ-001` }]);
  assert.match(attached.partialDependency.reason, new RegExp(`${SPEC}:REQ-001 \\(child ${CHILD}\\)`, 'u'));
});

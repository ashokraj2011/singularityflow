/**
 * SPEC-OSA v1.1 Stage 0 records (docs/osa/README.md): the eight 2026-11-16 incident fixtures, journeys H–J as fixtures,
 * and the AC-020 inventory scanner.
 *
 * The fixtures are independent of the code under test: this file imports nothing from src/. It checks that each
 * fixture is complete and consistent with the specification's own definitions (section 4.3: the three publication
 * predicates and the version arithmetic, written out here), that recovery is never the expected way on for these
 * healthy steps [OSA:REQ-003, AC-005], and that every incident names a reproducing journey A–E that exists
 * [OSA:AC-014]. Stage 1 compares the decision owner's output with these expected actions.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const incidents = json('test/fixtures/osa/incidents.json');
const journeys = json('test/fixtures/osa/journeys-h-j.json');
const vocabulary = incidents.vocabulary;

/** Section 4.3, written out: what the record's facts mean as versions and publication predicates. */
function versionsOf(facts) {
  const published = Number(facts.generation ?? 0);
  const intent = facts.generationIntent;
  const writing = intent?.status === 'open' ? Number(intent.generation) : null;
  const highWatermark = Math.max(Number(facts.generationHighWatermark ?? 0), published, writing ?? 0);
  return {
    version: { published, writing, highWatermark, proposedNext: writing === null ? Math.max(published, highWatermark) + 1 : null },
    publication: { hasPublishedVersion: published >= 1, hasOpenVersion: writing !== null, currentVersionPublished: published >= 1 && writing === null }
  };
}

function checkNext(next, where, phaseOrder) {
  assert.ok(vocabulary.kinds.includes(next.kind), `${where}: kind ${next.kind}`);
  assert.ok(vocabulary.operations.includes(next.operation), `${where}: operation ${next.operation}`);
  assert.ok(vocabulary.principalKinds.includes(next.principalKind), `${where}: principal ${next.principalKind}`);
  assert.ok(vocabulary.roles.includes(next.role), `${where}: role ${next.role}`);
  assert.ok(phaseOrder.includes(next.target?.phase), `${where}: target ${JSON.stringify(next.target)}`);
  assert.ok(Array.isArray(next.prerequisites), `${where}: prerequisites`);
  for (const later of next.then ?? []) assert.ok(vocabulary.operations.includes(later), `${where}: then ${later}`);
  // A person's consent or decision is a human principal's; an agent's work is an agent's [section 4.2 principals and roles].
  if (/^person-/u.test(next.kind)) assert.equal(next.principalKind, 'human', where);
  if (next.kind === 'agent-work') assert.equal(next.principalKind, 'agent', where);
  // Recovery is for positively established damage only; none of these steps is damaged [OSA:REQ-003, AC-005].
  assert.notEqual(next.operation, 'recover-operation', `${where}: a healthy step is never routed to recovery`);
}

test('the eight incidents of 2026-11-16 are fixtures with their facts and an independent expected next action', () => {
  assert.deepEqual(incidents.incidents.map((entry) => entry.id), Array.from({ length: 8 }, (_, index) => `OSA-INC-${index + 1}`));
  assert.match(incidents.independence, /written by hand from SPEC-OSA v1\.1/u);
  for (const incident of incidents.incidents) {
    const { id, story, facts, expected } = incident;
    assert.ok(incident.title && incident.observed && expected && incident.coverage, id);
    assert.equal(story.currentPhase, facts.phase, `${id}: the incident is about the Story's current step`);
    assert.ok(story.phaseOrder.includes(facts.phase), id);
    assert.ok(vocabulary.states.includes(expected.state), `${id}: state ${expected.state}`);
    checkNext(expected.next, id, story.phaseOrder);
    assert.equal(expected.next.target.phase, facts.phase, `${id}: the next action is on the incident's step`);
    // The expected versions and predicates are section 4.3's, from the record's facts.
    const derived = versionsOf(facts);
    assert.deepEqual(expected.version, derived.version, `${id}: versions`);
    assert.deepEqual(expected.publication, derived.publication, `${id}: publication predicates`);
    if (expected.next.operation === 'open-version') {
      assert.equal(expected.next.inputs.version, derived.version.proposedNext, `${id}: opens the proposed number`);
      assert.equal(expected.next.target.version, derived.version.proposedNext, id);
      // Only the first reservation of version 1 may omit successor consent [section 7.2].
      assert.equal(expected.next.inputs.consent, derived.version.proposedNext === 1 ? 'not-required' : 'required', `${id}: consent`);
      if (expected.next.inputs.consent === 'required') assert.equal(expected.next.kind, 'person-consent', id);
    }
    if (expected.next.operation === 'author-version') assert.equal(expected.next.target.version, derived.version.writing, `${id}: writes the open version`);
    if (derived.publication.hasOpenVersion) {
      // An open successor takes precedence over the review or submission of an earlier version [OSA:REQ-032].
      assert.ok(!['submit-version', 'review-version', 'start-review'].includes(expected.next.operation), id);
    }
    assert.ok(expected.mustNot.length > 0 && expected.rules.length > 0, id);
  }
});

test('every incident names its reproducing journey A–E, and the journey and its checks exist [OSA:AC-014]', () => {
  for (const { id, coverage } of incidents.incidents) {
    assert.ok(['A', 'B', 'C', 'D', 'E'].includes(coverage.journey), `${id}: journey ${coverage.journey}`);
    const text = readFileSync(path.join(root, coverage.test), 'utf8');
    assert.ok(coverage.testTitle.startsWith(`journey ${coverage.journey}:`), id);
    assert.ok(text.includes(`'${coverage.testTitle}'`), `${id}: ${coverage.test} has no test "${coverage.testTitle}"`);
    for (const check of coverage.checks) assert.ok(text.includes(check), `${id}: ${coverage.test} has no check "${check}"`);
    for (const related of coverage.related ?? []) {
      const file = /^test\/[^\s:]+\.test\.mjs/u.exec(related)?.[0];
      if (file) assert.ok(existsSync(path.join(root, file)), `${id}: ${file}`);
    }
    for (const commit of coverage.fixedBy) assert.match(commit, /^[0-9a-f]{9}$/u, id);
    assert.ok(coverage.status, id);
  }
  // All eight incidents are covered; journeys that reproduce none of them stay listed in the docs, not here.
  const covered = new Set(incidents.incidents.map((entry) => entry.coverage.journey));
  assert.deepEqual([...covered].sort(), ['B', 'C', 'E']);
});

test('journeys H, I and J are defined as fixtures with expected actions, for the stages that build them', () => {
  assert.deepEqual(journeys.journeys.map((entry) => [entry.id, entry.journey, entry.stage]), [['OSA-J-H', 'H', 2], ['OSA-J-I', 'I', 2], ['OSA-J-J', 'J', 4]]);
  for (const journey of journeys.journeys) {
    assert.ok(journey.title && journey.rules.length, journey.id);
    for (const [index, expected] of journey.expected.entries()) {
      const where = `${journey.id} #${index + 1} (${expected.at})`;
      assert.ok(vocabulary.states.includes(expected.state), `${where}: state ${expected.state}`);
      if (expected.next) checkNext(expected.next, where, journey.story.phaseOrder);
    }
    if (journey.facts) {
      const [first] = journey.expected;
      const derived = versionsOf(journey.facts);
      if (first.version) assert.deepEqual(first.version, derived.version, `${journey.id}: versions`);
      if (first.publication) assert.deepEqual(first.publication, derived.publication, `${journey.id}: publication predicates`);
    }
  }
  // Journey I is D3's one rule for documents: the person's yes before version 2 [OSA:REQ-030].
  const documents = journeys.journeys.find((entry) => entry.journey === 'I');
  assert.deepEqual([documents.expected[0].next.kind, documents.expected[0].next.inputs.consent], ['person-consent', 'required']);
  // Journey J is D2: /sf-next does the step's own work, with no relay to another command [OSA:REQ-025].
  const next = journeys.journeys.find((entry) => entry.journey === 'J');
  assert.ok(next.expected[0].mustNot.some((entry) => /\/sf-code/u.test(entry)));
});

test('the fixtures hold generic identifiers only: no person, login, email or machine path', () => {
  for (const file of ['test/fixtures/osa/incidents.json', 'test/fixtures/osa/journeys-h-j.json']) {
    const text = readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /@[a-z0-9-]+\.[a-z]/iu, `${file}: an email address`);
    assert.doesNotMatch(text, /\/(?:Users|home|private\/tmp)\//u, `${file}: a machine path`);
  }
  for (const entry of [...incidents.incidents, ...journeys.journeys]) assert.match(entry.story.workId, /^(?:INC|JRN)-[A-Z0-9]+$/u, entry.id);
});

test('the AC-020 inventory scanner counts raw intent reads, version arithmetic, routes and route skills by module', async () => {
  const ts = (await import('typescript')).default;
  const { scanModule, moduleCounts } = await import('../scripts/osa-inventory.mjs');
  const source = [
    "import { stepBeingWritten } from './phase-generation-need.mjs';",
    'export function decide(workflow, phase) {',
    "  const intent = phase.generationIntent ?? {};",
    "  if (phase?.generationIntent?.status === 'open' && intent.status === 'open') return null;",
    '  const next = phase.generation + 1;',
    "  phase.generationIntent = { status: 'open', generation: next };",
    "  if (stepBeingWritten(workflow, phase)) return { command: `singularity-flow prepare ${phase.id}`, skill: '/sf-code' };",
    "  // '/sf-recover' in a comment is not counted",
    "  return { command: 'singularity-flow recover --json', skill: '/sf-recover', label: 'Use /sf-phase-documents or /sf-phase' };",
    '}'
  ].join('\n');
  const counts = moduleCounts('example.mjs', scanModule('example.mjs', source, ts.ScriptKind.JS));
  assert.deepEqual(counts, {
    module: 'example.mjs', role: 'unclassified',
    intentStatus: { direct: 1, aliased: 1 },
    versionArithmetic: 1,
    intentWrites: 1,
    predicateCalls: { stepBeingWritten: 1 },
    routeObjects: 2,
    lifecycleCommands: { prepare: 1, recover: 1 },
    skillLiterals: { '/sf-code': { exact: 1 }, '/sf-recover': { exact: 1 }, '/sf-phase': { text: 1 } }
  });
  const baseline = json('benchmarks/osa/inventory.json');
  assert.equal(baseline.schemaVersion, 1);
  assert.ok(baseline.modules.every((entry) => !('sites' in entry)), 'the committed form keeps no line numbers');
});

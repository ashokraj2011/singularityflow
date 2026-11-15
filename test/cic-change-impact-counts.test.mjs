/**
 * Per Story, what its requirement changes did, as counts [SPEC-CIC v1.1 stage 7; CIC:REQ-017, REQ-019]: revisions by
 * class, cone size, widened share, evidence kept, "still holds" questions and answers, steps reset and the generations
 * they published again, and publications refused, for each approved intent amendment and for the Story, each saying
 * whether it was recorded or derived. A pure function of the Story's records, in the Story report's "Change impact"
 * section and in its `--json`. Content is never counted: no clause text, file contents or paths. A Story pinned before
 * stage 7, or with every switch off, reports what it can derive and names the rest.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { changeImpactCounts, changeImpactSection } from '../src/change-impact-counts.mjs';
import { deriveReport, renderHtml, renderMarkdown, requirementChanges } from '../src/report.mjs';
import { addClause, changeImpactStory as fixture, reviseCriterion, reword } from './helpers/change-impact-story.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const at = (minute) => new Date(Date.UTC(2026, 10, 15, 9, minute)).toISOString();
const body = (letter) => letter.repeat(64);

/** A Story through three approved amendments (editorial, refinement, material), one rejected and one pending. */
function story() {
  const revision = (number, clauses, dependentGenerations, origin) => ({ schema: 'scope-revision/v2', revision: number, revisionSha256: `sha256:r${number}`,
    clauses: Object.entries(clauses).map(([id, letter]) => ({ id: `SYN:${id}`, bodySha256: body(letter) })), dependentGenerations, origin });
  return {
    workItem: { id: 'SYN', title: 'Counts' }, status: 'in_progress', currentPhase: 'code', history: [],
    resolution: { spec: { mode: 'on', changeImpact: 'on', observedDependencies: 'on', preAmendmentDrafts: 'refuse' },
      obligationGraph: { nodes: [{ id: 'scope', responsibilities: ['scope'] }] } },
    phaseOrder: ['scope', 'design', 'code', 'verify'],
    phases: {
      scope: { id: 'scope', label: 'Scope', status: 'approved', generation: 4, approvals: [], usage: [] },
      design: { id: 'design', label: 'Design', status: 'approved', generation: 1, approvals: [], usage: [], generationPublications: [{ generation: 1, publishedAt: at(10) }] },
      code: { id: 'code', label: 'Code', status: 'in_progress', generation: 3, approvals: [], usage: [],
        generationPublications: [{ generation: 1, publishedAt: at(20) }, { generation: 2, publishedAt: at(40) }, { generation: 3, publishedAt: at(60) }] },
      verify: { id: 'verify', label: 'Verify', status: 'not_started', generation: 0, approvals: [], usage: [] }
    },
    scopeRevisions: [
      revision(1, { 'REQ-001': 'a', 'AC-001': 'b', 'AC-002': 'c' }, { design: 0, code: 0, verify: 0 }, { kind: 'approval', phase: 'scope', generation: 1 }),
      revision(2, { 'REQ-001': 'e', 'AC-001': 'b', 'AC-002': 'c' }, { design: 1, code: 0, verify: 0 }, { kind: 'intent-amendment', id: 'AMD-001', phase: 'scope', generation: 2 }),
      revision(3, { 'REQ-001': 'e', 'AC-001': 'f', 'AC-002': 'c' }, { design: 1, code: 1, verify: 0 }, { kind: 'intent-amendment', id: 'AMD-002', phase: 'scope', generation: 3 }),
      // AC-001 goes back to its first statement, and AC-003 is added.
      revision(4, { 'REQ-001': 'e', 'AC-001': 'b', 'AC-002': 'c', 'AC-003': 'd' }, { design: 1, code: 2, verify: 0 }, { kind: 'intent-amendment', id: 'AMD-003', phase: 'scope', generation: 4 })],
    intentAmendments: [
      { id: 'AMD-001', status: 'approved', class: 'editorial', carried: 'editorial', decidedAt: at(15), changedClauses: ['SYN:REQ-001'], staleClauses: ['SYN:REQ-001'],
        affectedPhases: [], retainedPhases: [], preservedEvidence: [], acknowledgementRequired: false, scopeRevision: { revision: 2, revisionSha256: 'sha256:r2' },
        impactCounts: { schema: 'impact-counts/v1', widened: [], setAside: [], carriedEvidence: 1 } },
      { id: 'AMD-002', status: 'approved', class: 'refinement', decidedAt: at(30), changedClauses: ['SYN:AC-001'], staleClauses: ['SYN:AC-001', 'SYN:AC-002'],
        affectedPhases: ['code', 'verify'], retainedPhases: ['design'], preservedEvidence: ['singularity/work-items/SYN/artifacts/design/design.md', 'singularity/work-items/SYN/notes.md'],
        acknowledgementRequired: false, acknowledgedAt: at(31), scopeRevision: { revision: 3, revisionSha256: 'sha256:r3' }, producer: 'scope',
        revalidate: [{ phase: 'design', generation: 1, reason: 'prompt-held', clauses: ['SYN:AC-001'], recommend: 'unchanged' }],
        impactCounts: { schema: 'impact-counts/v1', widened: ['code'], setAside: [] } },
      { id: 'AMD-003', status: 'approved', class: 'material', decidedAt: at(50), changedClauses: ['SYN:AC-001', 'SYN:AC-003'], staleClauses: ['SYN:AC-001', 'SYN:AC-003'],
        affectedPhases: ['code'], retainedPhases: ['design'], preservedEvidence: [], acknowledgementRequired: true, scopeRevision: { revision: 4, revisionSha256: 'sha256:r4' },
        impactCounts: { schema: 'impact-counts/v1', widened: [], setAside: [] } },
      { id: 'AMD-004', status: 'rejected', changedClauses: ['SYN:AC-002'] },
      { id: 'AMD-005', status: 'proposed', class: 'refinement', changedClauses: ['SYN:AC-002'] }],
    amendmentRevalidations: [{ amendment: 'AMD-002', phase: 'design', generation: 1, outcome: 'unchanged', reason: 'The design names no value.' }],
    refusedPublications: [{ amendment: 'AMD-002', phase: 'code', generation: 2 }]
  };
}

const CLAUSE_CONTENT = /SYN:|:AC-|:REQ-|artifacts\/|\.md|bodySha256|The design names/u;

test('each approved amendment and the Story are counted exactly, each count saying whether it was recorded or derived [CIC:REQ-017]', () => {
  const counts = changeImpactCounts(story());
  assert.deepEqual(counts.switches, { changeImpact: 'on', observedDependencies: 'on', preAmendmentDrafts: 'refuse' });
  assert.deepEqual(counts.amendments, { proposed: 5, approved: 3, rejected: 1, pending: 1 });
  assert.deepEqual(counts.revisionsByClass, { editorial: 1, refinement: 1, material: 1, unclassed: 0 });
  const recorded = { class: 'recorded', cone: 'derived', widened: 'recorded', evidenceKept: 'recorded', stillHolds: 'recorded', stepsReset: 'derived',
    generationsRedone: 'derived', publicationsRefused: 'recorded' };
  const none = { asked: 0, answered: 0, stillHolds: 0, redo: 0, open: 0, lapsed: 0 };
  assert.deepEqual(counts.perAmendment, [
    // Editorial: nothing reset, the design's one evidence item carried.
    { amendment: 'AMD-001', class: 'editorial', cone: { clauses: 1, steps: 0 }, widened: { steps: 0, percent: null }, evidenceKept: 1, stillHolds: none,
      stepsReset: 0, generationsRedone: 0, publicationsRefused: 0, sources: recorded },
    // The code step (generation 1) reached only through its incomplete record; verify had not run, so it holds no evidence. The
    // design kept, asked "still holds" and answered; the code step reset and published generation 2 before AMD-003 reset it again.
    { amendment: 'AMD-002', class: 'refinement', cone: { clauses: 2, steps: 1 }, widened: { steps: 1, percent: 100 }, evidenceKept: 2,
      stillHolds: { ...none, asked: 1, answered: 1, stillHolds: 1 }, stepsReset: 1, generationsRedone: 1, publicationsRefused: 1, sources: recorded },
    { amendment: 'AMD-003', class: 'material', cone: { clauses: 2, steps: 1 }, widened: { steps: 0, percent: 0 }, evidenceKept: 0, stillHolds: none,
      stepsReset: 1, generationsRedone: 1, publicationsRefused: 0, sources: recorded }]);
  assert.deepEqual(counts.totals, { cone: { clauses: 5, steps: 2 }, widened: { steps: 1, of: 2, percent: 50 }, evidenceKept: 3,
    stillHolds: { ...none, asked: 1, answered: 1, stillHolds: 1 }, stepsReset: 2, generationsRedone: 2, publicationsRefused: 1 });
  assert.deepEqual(counts.churn, { clauseChanges: 4, clausesChangedAgain: 1, reversals: 1 });
  assert.deepEqual(counts.notRecorded, []);
  assert.doesNotMatch(JSON.stringify(counts), CLAUSE_CONTENT, 'counts and amendment IDs only');
});

test('the report says the same counts in its "Change impact" section as its --json carries, in place of "Requirement changes"', () => {
  const workflow = story();
  const counts = changeImpactCounts(workflow);
  const report = deriveReport(workflow, { now: at(90), changeImpact: counts });
  assert.deepEqual(JSON.parse(JSON.stringify(report)).changeImpact, counts, 'the --json object is the counts as computed');
  const section = changeImpactSection(report.changeImpact, { requirementChanges: report.requirementChanges });
  const markdown = renderMarkdown(report, { changeImpact: section });
  assert.ok(markdown.includes(section.trimEnd()));
  assert.equal(markdown.includes('## Requirement changes'), false, 'one section, holding the clause lines');
  for (const line of [
    '## Change impact',
    '- Requirement changes: 3 intent amendments approved: 1 editorial change, 1 refinement and 1 material change; 1 rejected and 1 waiting for a decision. (recorded)',
    '- Cone size: 5 clauses (changed, or depending on a changed one) and 2 later steps with published work. (derived)',
    '- Widened share: 1 of 2 steps reached (50%) was there only because what it depended on is not fully recorded. (recorded)',
    '- Evidence kept: 3 evidence items, preserved as unaffected or carried as editorial. (recorded)',
    '- "Still holds": 1 question asked: 1 still holds, 0 to redo, 0 open. (recorded)',
    '- Rework: 2 steps reset after they had started, and 2 generations published again since. (derived)',
    '- Publications refused: 1 publication of a draft written before an amendment. (recorded)',
    '- Churn: 4 clause changes; 1 clause changed more than once; 1 time a clause went back to an earlier statement. (derived)',
    '- `SYN:AC-001` changed 2 times.',
    '- `SYN:AC-001` went back to an earlier statement once.',
    '| Amendment | Size | Cone: clauses, steps | Widened | Evidence kept | "Still holds": asked, answered | Steps reset | Generations redone | Publications refused |',
    '| AMD-001 | editorial | 1, 0 | 0 | 1 | 0, 0 | 0 | 0 | 0 |',
    '| AMD-002 | refinement | 2, 1 | 1 (100%) | 2 | 1, 1 | 1 | 1 | 1 |',
    '| AMD-003 | material | 2, 1 | 0 (0%) | 0 | 0, 0 | 1 | 1 | 0 |'
  ]) assert.ok(markdown.includes(line), `${line}\n---\n${section}`);
  // The HTML report says the same, in the same place.
  const html = renderHtml(report, { changeImpact: changeImpactSection(report.changeImpact, { format: 'html', requirementChanges: report.requirementChanges }) });
  assert.match(html, /<h2>Change impact<\/h2>/u);
  assert.doesNotMatch(html, /<h2>Requirement changes<\/h2>/u);
  assert.match(html, /<td>AMD-002<\/td><td>refinement<\/td><td>2, 1<\/td><td>1 \(100%\)<\/td>/u);
  assert.match(html, /<li><code>SYN:AC-001<\/code> changed 2 times\.<\/li>/u);
  // Without the counts the report reads as it did.
  assert.match(renderMarkdown(deriveReport(workflow, { now: at(90) })), /## Requirement changes/u);
  assert.equal(deriveReport(workflow, { now: at(90) }).changeImpact, undefined);
});

test('a Story pinned before stage 7 reports what it can derive and names what it did not record; it never fails [CIC:REQ-019]', () => {
  const before = story();
  for (const summary of before.intentAmendments) delete summary.impactCounts;
  delete before.refusedPublications;
  const counts = changeImpactCounts(before);
  assert.deepEqual(counts.perAmendment.map((entry) => [entry.amendment, entry.widened.steps, entry.evidenceKept, entry.publicationsRefused, entry.stepsReset, entry.generationsRedone]),
    [['AMD-001', null, null, null, 0, 0], ['AMD-002', null, 2, null, 1, 1], ['AMD-003', null, 0, null, 1, 1]]);
  assert.deepEqual(counts.notRecorded, [{ amendment: 'AMD-001', counts: ['widened', 'evidenceKept', 'publicationsRefused'] },
    { amendment: 'AMD-002', counts: ['widened', 'publicationsRefused'] }, { amendment: 'AMD-003', counts: ['widened', 'publicationsRefused'] }]);
  assert.deepEqual([counts.totals.widened, counts.totals.evidenceKept, counts.totals.publicationsRefused], [{ steps: null, of: 0, percent: null }, 2, null]);
  assert.deepEqual([counts.sources.widened, counts.sources.evidenceKept, counts.sources.publicationsRefused], ['not-recorded', 'partial', 'not-recorded']);
  const section = changeImpactSection(counts);
  for (const line of ['- Widened share: not recorded. (not recorded)', '- Evidence kept: 2 evidence items, preserved as unaffected or carried as editorial. (partly recorded)',
    '- Publications refused: not recorded. (not recorded)',
    '- Not recorded: AMD-001 (widened share, evidence kept, publications refused), AMD-002 (widened share, publications refused) and AMD-003 (widened share, publications refused), approved before SFlow kept these counts.',
    '| AMD-001 | editorial | 1, 0 | not recorded | not recorded | 0, 0 | 0 | 0 | not recorded |']) assert.ok(section.includes(line), `${line}\n---\n${section}`);
  // A reset step whose unpublished work its pin set aside counts from the pin when the approval recorded nothing.
  before.phases.verify.scopePin = { amendment: 'AMD-003', generation: 1, setAside: { intent: 'G-9' } };
  assert.equal(changeImpactCounts(before).perAmendment[2].stepsReset, 2);
});

test('with every switch off the counts are derived and unclassed, and nothing is said to be missing [CIC:AC-017]', () => {
  const off = story();
  off.resolution.spec = { mode: 'on' };
  for (const summary of off.intentAmendments) {
    for (const key of ['class', 'carried', 'impactCounts', 'scopeRevision']) delete summary[key];
  }
  delete off.refusedPublications;
  // Without a scope revision each step's generation then comes from its publication times, and the scope step from the graph.
  off.scopeRevisions = off.scopeRevisions.slice(0, 1);
  const counts = changeImpactCounts(off);
  assert.deepEqual(counts.switches, { changeImpact: 'off', observedDependencies: 'off', preAmendmentDrafts: 'legacy' });
  assert.deepEqual(counts.revisionsByClass, { editorial: 0, refinement: 0, material: 0, unclassed: 3 });
  assert.deepEqual(counts.perAmendment.map((entry) => [entry.amendment, entry.class, entry.cone.steps, entry.widened.steps, entry.publicationsRefused, entry.stepsReset, entry.generationsRedone]),
    [['AMD-001', null, 0, 0, 0, 0, 0], ['AMD-002', null, 1, 0, 0, 1, 1], ['AMD-003', null, 1, 0, 0, 1, 1]]);
  assert.deepEqual(counts.notRecorded, []);
  assert.deepEqual(counts.sources, { revisionsByClass: 'derived', cone: 'derived', widened: 'derived', evidenceKept: 'recorded', stillHolds: 'recorded',
    stepsReset: 'derived', generationsRedone: 'derived', publicationsRefused: 'derived', churn: 'derived' });
  const section = changeImpactSection(counts);
  assert.ok(section.includes('Change impact is off: changes have no size, and what each step depended on is not recorded. Drafts written before an amendment are not checked at publication.'), section);
  assert.ok(section.includes('- Widened share: none: with observed dependencies off, no step is widened. (derived)'), section);
  assert.ok(section.includes('| AMD-002 | no size | 2, 1 | 0 (0%) |'), section);
  // A Story with no change at all has no section, and its counts are zeros.
  const quiet = { ...story(), intentAmendments: [], refusedPublications: [] };
  assert.equal(changeImpactSection(changeImpactCounts(quiet)), '');
  assert.deepEqual(changeImpactCounts(quiet).totals.stepsReset, 0);
});

test('records the counts cannot read never fail them', () => {
  for (const workflow of [null, {}, { intentAmendments: 'x', scopeRevisions: 5, phases: null },
    { phaseOrder: ['a'], intentAmendments: [null, 3, { id: 'AMD-001', status: 'approved', affectedPhases: 'x', staleClauses: null, retainedPhases: {}, revalidate: [null],
      scopeRevision: { revision: 'x' }, impactCounts: 'x' }], scopeRevisions: [null, { clauses: [null, 7] }], amendmentRevalidations: 'x', refusedPublications: [null] }]) {
    const counts = changeImpactCounts(workflow);
    assert.equal(counts.schema, 'change-impact-counts/v1');
    assert.equal(typeof changeImpactSection(counts), 'string');
    assert.equal(typeof changeImpactSection(counts, { format: 'html' }), 'string');
  }
  assert.match(changeImpactSection({ schema: 'change-impact-counts/v1', unavailable: 'The change impact counts could not be read.' }), /^## Change impact\n\nThe change impact counts could not be read\./u);
  assert.equal(requirementChanges({ resolution: { spec: { changeImpact: 'on' } }, intentAmendments: [], scopeRevisions: [] }), null);
});


const refusedCode = (result) => { try { const parsed = JSON.parse(result.stdout || result.stderr); return (parsed.error ?? parsed).code; } catch { return null; } };

test('a real Story with change impact on: an editorial change, a refinement partway through its code step and one refused publication, counted exactly; the report and --json agree, and no content is kept [CIC:REQ-017]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const f = await fixture(t);
    await f.designed('CI-1');
    // AMD-001: REQ-001 reworded, untested and no acceptance criterion: editorial, so nothing runs again.
    assert.equal(await f.amend('CI-1', 'wording', reword, 'Clearer wording, same meaning.'), 'AMD-001');
    const afterEditorial = await f.workflow('CI-1');
    assert.deepEqual([afterEditorial.intentAmendments[0].class, afterEditorial.intentAmendments[0].carried], ['editorial', 'editorial']);
    const designEvidence = afterEditorial.phases['fix-design'].artifacts.filter((artifact) => artifact.exists !== false).length;
    // The code step is half done: begun, composed and its code written, not published.
    f.sflow('phase', 'begin', 'implement', '--json');
    await f.code('CI-1');
    f.sflow('prepare', 'implement');
    f.sflow('phase', 'enter', 'implement', '--compose', '--json');
    // AMD-002: AC-001 revised (a bound test, an acceptance criterion): a refinement. The design cites only AC-002, but its record
    // is incomplete, so it is reopened (widened); the code step's open generation is closed, its prompt set aside.
    assert.equal(await f.amend('CI-1', 'criterion', reviseCriterion, 'Say the value is numeric.'), 'AMD-002');
    const amended = await f.workflow('CI-1');
    const second = amended.intentAmendments[1];
    assert.equal(second.class, 'refinement');
    assert.equal(amended.currentPhase, 'fix-design');
    assert.ok(amended.phases.implement.scopePin.setAside.intent, 'the code step\'s generation was closed');
    assert.deepEqual(second.impactCounts, { schema: 'impact-counts/v1', widened: ['fix-design'], setAside: ['implement'] });
    const preserved = second.preservedEvidence.length;
    f.sflow('story', 'intent-amendment', 'acknowledge', 'AMD-002');
    f.sflow('resume', 'CI-1');
    f.sflow('prepare', 'fix-design');
    // An agent's publication of the design, not composed again since: refused, and counted.
    const refused = f.run(['phase', 'publish', 'fix-design', '--json']);
    assert.notEqual(refused.status, 0);
    assert.equal(refusedCode(refused), 'PHASE_DRAFT_PREDATES_AMENDMENT', refused.stdout || refused.stderr);
    assert.deepEqual((await f.workflow('CI-1')).refusedPublications, [{ amendment: 'AMD-002', phase: 'fix-design', generation: 2 }]);
    // The person finds the design still holds and publishes it unchanged; it is approved again.
    f.sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
    f.sflow('submit', 'fix-design'); f.sflow('approve', 'fix-design', '--yes');
    // The code step is written again under the amended scope and published.
    f.sflow('prepare', 'implement'); f.sflow('phase', 'begin', 'implement', '--json');
    await f.code('CI-1');
    f.sflow('phase', 'enter', 'implement', '--compose', '--json'); f.sflow('prepare', 'implement');
    f.sflow('phase', 'publish', 'implement', '--authored', 'deterministic');
    const final = await f.workflow('CI-1');
    assert.deepEqual([final.phases['fix-design'].generation, final.phases.implement.generation], [2, 1]);
    assert.deepEqual(final.refusedPublications, [{ amendment: 'AMD-002', phase: 'fix-design', generation: 2 }], 'the refusal record was committed, unchanged');

    const json = JSON.parse(f.report('CI-1', '--format', 'json'));
    const counts = json.changeImpact;
    assert.deepEqual(counts, changeImpactCounts(final), 'the report counts the Story\'s own records');
    assert.deepEqual(counts.amendments, { proposed: 2, approved: 2, rejected: 0, pending: 0 });
    assert.deepEqual(counts.revisionsByClass, { editorial: 1, refinement: 1, material: 0, unclassed: 0 });
    const none = { asked: 0, answered: 0, stillHolds: 0, redo: 0, open: 0, lapsed: 0 };
    const sources = { class: 'recorded', cone: 'derived', widened: 'recorded', evidenceKept: 'recorded', stillHolds: 'recorded', stepsReset: 'derived',
      generationsRedone: 'derived', publicationsRefused: 'recorded' };
    assert.deepEqual(counts.perAmendment, [
      { amendment: 'AMD-001', class: 'editorial', cone: { clauses: 1, steps: 0 }, widened: { steps: 0, percent: null }, evidenceKept: designEvidence,
        stillHolds: none, stepsReset: 0, generationsRedone: 0, publicationsRefused: 0, sources },
      // The design (generation 1) is the one step with published work it reached, only through its incomplete record. It and
      // the closed code step were reset; each published once since. One publication refused.
      { amendment: 'AMD-002', class: 'refinement', cone: { clauses: 1, steps: 1 }, widened: { steps: 1, percent: 100 }, evidenceKept: preserved,
        stillHolds: none, stepsReset: 2, generationsRedone: 2, publicationsRefused: 1, sources }]);
    assert.deepEqual([designEvidence, preserved], [1, 1], 'the design\'s one document, carried and then preserved');
    assert.deepEqual(counts.totals, { cone: { clauses: 2, steps: 1 }, widened: { steps: 1, of: 1, percent: 100 }, evidenceKept: 2, stillHolds: none,
      stepsReset: 2, generationsRedone: 2, publicationsRefused: 1 });
    assert.deepEqual(counts.churn, { clauseChanges: 2, clausesChangedAgain: 0, reversals: 0 });
    assert.deepEqual(counts.notRecorded, []);
    // No content: no clause text or ID, no file contents or paths, in the counts or the records they read.
    assert.doesNotMatch(JSON.stringify(counts), /CI-1:|value|equals|comment|\.mjs|\.md|artifacts\//u);
    for (const summary of final.intentAmendments) assert.deepEqual(Object.keys(summary.impactCounts).sort(), ['schema', 'setAside', 'widened', ...(summary.carried ? ['carriedEvidence'] : [])].sort());
    // The section in the Markdown and HTML reports is the --json counts said in words.
    const markdown = f.report('CI-1');
    const section = changeImpactSection(counts, { requirementChanges: json.requirementChanges ?? null });
    assert.ok(markdown.includes(section.trimEnd()), `${section}\n---\n${markdown}`);
    assert.ok(markdown.includes('| AMD-002 | refinement | 1, 1 | 1 (100%) | 1 | 0, 0 | 2 | 2 | 1 |'), section);
    assert.ok(f.report('CI-1', '--format', 'html').includes(changeImpactSection(counts, { format: 'html', requirementChanges: json.requirementChanges ?? null })));

    // The same Story as a stage 6 build would have left it: what it cannot derive is named, and it reports.
    const before = structuredClone(final);
    for (const summary of before.intentAmendments) delete summary.impactCounts;
    delete before.refusedPublications;
    const older = changeImpactCounts(before);
    assert.deepEqual(older.notRecorded, [{ amendment: 'AMD-001', counts: ['widened', 'evidenceKept', 'publicationsRefused'] },
      { amendment: 'AMD-002', counts: ['widened', 'publicationsRefused'] }]);
    assert.deepEqual(older.perAmendment.map((entry) => [entry.cone, entry.stepsReset, entry.generationsRedone]),
      [[{ clauses: 1, steps: 0 }, 0, 0], [{ clauses: 1, steps: 1 }, 2, 2]], 'the rest is derived the same, the code step\'s set-aside work from its pin');
    assert.match(renderMarkdown(deriveReport(before, { changeImpact: older }), { changeImpact: changeImpactSection(older) }), /- Not recorded: AMD-001 \(widened share, evidence kept, publications refused\) and AMD-002/u);
  });

test('a Story with every switch off reports its counts, derived and unclassed, without failing [CIC:AC-017, REQ-019]', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await fixture(t, { changeImpact: 'off' });
  await f.designed('CI-2');
  await f.amend('CI-2', 'criterion', reviseCriterion, 'Say the value is numeric.');
  const story = await f.workflow('CI-2');
  assert.deepEqual([story.resolution.spec.changeImpact, story.resolution.spec.observedDependencies, story.resolution.spec.preAmendmentDrafts], ['off', undefined, 'legacy']);
  assert.equal(story.intentAmendments[0].impactCounts, undefined, 'nothing new is written with every switch off');
  const counts = JSON.parse(f.report('CI-2', '--format', 'json')).changeImpact;
  assert.deepEqual(counts.switches, { changeImpact: 'off', observedDependencies: 'off', preAmendmentDrafts: 'legacy' });
  assert.deepEqual(counts.revisionsByClass, { editorial: 0, refinement: 0, material: 0, unclassed: 1 });
  // The design cites none of AC-001 and rule E8 keeps it; the code step had not started, so nothing with work was reset.
  assert.deepEqual(counts.perAmendment.map((entry) => [entry.class, entry.cone, entry.widened, entry.stepsReset, entry.publicationsRefused]),
    [[null, { clauses: 1, steps: 0 }, { steps: 0, percent: null }, 0, 0]]);
  assert.deepEqual(counts.notRecorded, []);
  assert.match(f.report('CI-2'), /## Change impact\n\nWhat this Story's requirement changes did, as counts from its own records/u);
});

test('the stage 7 real Story\'s shape, rebuilt: an editorial and then a refinement amendment while the code step is open, then redone and verified; a scope an amendment publishes and a kernel-assembled step are resolved, so a third amendment widens only what is truly unresolved [CIC:REQ-005, REQ-006, REQ-017]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const f = await fixture(t);
    await f.designed('CI-3');
    // The code step published its first generation and is still open, as on the paid run (RTY-1).
    f.sflow('phase', 'begin', 'implement', '--json');
    await f.code('CI-3');
    f.sflow('prepare', 'implement');
    f.sflow('phase', 'enter', 'implement', '--compose', '--json');
    f.sflow('phase', 'publish', 'implement', '--authored', 'deterministic');
    await f.amend('CI-3', 'wording', reword, 'Clearer wording, same meaning.');
    await f.amend('CI-3', 'criterion', reviseCriterion, 'Say the value is numeric.');
    f.sflow('story', 'intent-amendment', 'acknowledge', 'AMD-002');
    f.sflow('resume', 'CI-3');
    f.sflow('prepare', 'fix-design');
    // A person publishes the design again with no prompt composed: what they read is not recorded, so it stays unresolved.
    f.sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
    f.sflow('submit', 'fix-design'); f.sflow('approve', 'fix-design', '--yes');
    f.sflow('prepare', 'implement'); f.sflow('phase', 'begin', 'implement', '--json');
    await f.code('CI-3');
    f.sflow('phase', 'enter', 'implement', '--compose', '--json'); f.sflow('prepare', 'implement');
    f.sflow('phase', 'publish', 'implement', '--authored', 'deterministic');
    f.sflow('submit', 'implement');
    if ((await f.workflow('CI-3')).phases.implement.status !== 'approved') f.sflow('approve', 'implement', '--yes');
    // The verify step the kernel assembles from its governed inputs, published with no model call and no prompt.
    f.sflow('prepare', 'verify');
    f.sflow('phase', 'publish', 'verify', '--authored', 'deterministic');
    const story = await f.workflow('CI-3');
    // RTY-1's facts: an editorial change that reached no step and reset nothing, then a refinement that reopened the design
    // and reset the code step, both of which published again; scope generations 1 to 3; no publication refused.
    const [first, second] = story.intentAmendments;
    assert.deepEqual([first.class, first.carried, first.affectedPhases, first.acknowledgementRequired, first.revalidate], ['editorial', 'editorial', [], false, undefined]);
    assert.deepEqual([second.class, second.affectedPhases, second.retainedPhases], ['refinement', ['fix-design', 'implement'], []]);
    assert.deepEqual(story.phaseOrder.map((id) => [id, story.phases[id].generation]), [['intake', 3], ['fix-design', 2], ['implement', 2], ['verify', 1]]);
    assert.equal(story.refusedPublications, undefined);
    const two = changeImpactCounts(story);
    assert.deepEqual(two.perAmendment.map((entry) => [entry.amendment, entry.class, entry.cone, entry.stepsReset, entry.generationsRedone, entry.publicationsRefused]), [
      ['AMD-001', 'editorial', { clauses: 1, steps: 0 }, 0, 0, 0],
      ['AMD-002', 'refinement', { clauses: 1, steps: 2 }, 2, 2, 0]]);
    assert.equal(two.perAmendment[1].evidenceKept, second.preservedEvidence.length);
    assert.deepEqual(two.churn, { clauseChanges: 2, clausesChangedAgain: 0, reversals: 0 });
    assert.deepEqual(two.totals.publicationsRefused, 0);

    // E5: the two scope generations the approvals published read the proposals their approvers decided; verify reads its
    // governed inputs. The design the person wrote, twice with no prompt, is the one truly unresolved step.
    const coverage = Object.fromEntries((JSON.parse(f.sflow('spec', 'dependencies', '--json')).steps)
      .map((step) => [step.phase, step.generations.map((row) => [row.generation, row.coverage.state, ...row.coverage.reasons])]));
    assert.deepEqual(coverage, { intake: [[1, 'resolved'], [2, 'resolved'], [3, 'resolved']],
      'fix-design': [[1, 'unresolved', 'receipt-missing'], [2, 'unresolved', 'receipt-missing']],
      implement: [[1, 'resolved'], [2, 'resolved']], verify: [[1, 'resolved']] });
    const read = async (phase, generation) => JSON.parse(await readFile(f.item('CI-3', 'context', 'dependencies', `${phase}-gen${generation}.json`), 'utf8'));
    const scope = await read('intake', 3);
    assert.deepEqual([scope.receipt.kind, scope.receipt.amendment, scope.receipt.path], ['intent-amendment', 'AMD-002', 'singularity/work-items/CI-3/context/intent-amendments/AMD-002-proposed.md']);
    assert.deepEqual(scope.edges.filter((edge) => edge.kind === 'input'), [], 'no step before the scope defines a clause');
    const verify = await read('verify', 1);
    assert.deepEqual([verify.receipt.kind, verify.receipt.path], ['governed-inputs', 'singularity/work-items/CI-3/context/inputs-verify-gen1.json']);
    // Its input is at most every clause the steps before it define, at the scope revision current at its publication.
    assert.deepEqual(verify.edges.filter((edge) => edge.kind === 'input'), story.scopeRevisions.at(-1).clauses.map((clause) => ({ kind: 'input', clause: clause.id, statementSha256: clause.bodySha256 })));
    // A code step's code is never read as kernel-assembled: implement, published as deterministic, had its composed prompt.
    assert.equal((await read('implement', 2)).receipt.path, 'singularity/work-items/CI-3/context/implement-gen2.json');

    // AMD-003 adds a clause, proposed from verify. Only the design is reached for an incomplete record; verify, assembled by
    // the kernel, is not, and runs again only because it comes after the reopened design.
    const added = path.join(f.root, '..', 'CI-3-added.md');
    await writeFile(added, addClause('CI-3')(await readFile(f.item('CI-3', 'artifacts/intake/intake.md'), 'utf8')));
    const preview = JSON.parse(f.sflow('story', 'intent-amendment', 'preview', '--file', added, '--json'));
    assert.equal(preview.effect.classification.effective, 'material');
    assert.deepEqual(preview.effect.steps.map((step) => [step.phase, step.outcome, step.reasons.map((reason) => reason.kind)]),
      [['fix-design', 'reopened', ['unresolved-record']], ['implement', 'reset', ['after-reset']], ['verify', 'reset', ['after-reset']]]);
    const { proposal } = JSON.parse(f.sflow('story', 'intent-amendment', 'propose', '--file', added, '--reason', 'The module must keep no other state.', '--json'));
    f.sflow('story', 'intent-amendment', 'decide', proposal.id, '--decision', 'approve', '--confirm', proposal.id);
    const third = (await f.workflow('CI-3')).intentAmendments[2];
    assert.deepEqual([third.id, third.class, third.impactCounts.widened], ['AMD-003', 'material', ['fix-design']]);
    const counts = JSON.parse(f.report('CI-3', '--format', 'json')).changeImpact;
    assert.deepEqual(counts.perAmendment.map((entry) => [entry.amendment, entry.class, entry.cone, entry.widened]), [
      ['AMD-001', 'editorial', { clauses: 1, steps: 0 }, { steps: 0, percent: null }],
      ['AMD-002', 'refinement', { clauses: 1, steps: 2 }, { steps: 1, percent: 50 }],
      ['AMD-003', 'material', { clauses: 1, steps: 1 }, { steps: 1, percent: 100 }]]);
    assert.deepEqual(counts.totals.widened, { steps: 2, of: 3, percent: 67 }, 'each widened step a truly unresolved design generation');
    assert.equal(counts.perAmendment[2].stepsReset, 3, 'the design, the code step and verify had each published, and all three run again');
  });

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { resolveWorkType } from '../src/config.mjs';
import { phaseAuthoringContract, phaseAuthoringContractLines } from '../src/phase-authoring-contract.mjs';
import { phasePromptExecutionContract, withPhasePromptRuntimeGuidance } from '../src/worldmodel.mjs';
import { compactSourceReviewContext } from '../src/source-review-agent-context.mjs';
import { evaluateSourceGroundedReview, sourceReviewBinding } from '../src/source-grounded-review.mjs';
import {
  REQUIREMENT_COVERAGE, REQUIREMENT_AUTHORING_PROTOCOL, REQUIREMENT_REVIEW_PROTOCOL,
  withRequirementAuthoringProtocol, withRequirementReviewProtocol, initiativeGathersRequirements
} from '../src/requirement-coverage.mjs';

test('all seeded scope producers share an application-neutral repair rubric without changing their workflow', async t => {
  const definition = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  let phases = 0;
  let scope = 0;
  for (const name of Object.keys(definition.workTypes)) {
    const resolved = resolveWorkType(definition, name);
    const workflow = { workItem: { id: 'COVER-1' }, resolution: resolved,
      phases: Object.fromEntries(resolved.phases.map(phase => [phase.id, phase])) };
    const before = structuredClone(workflow);
    for (const phase of resolved.phases) {
      const ownsScope = resolved.obligationGraph.nodes.find(node => node.id === phase.id).responsibilities.includes('scope');
      const contract = phaseAuthoringContract(definition, workflow, phase);
      assert.equal(Boolean(contract.requirementCoverage), ownsScope, `${name}/${phase.id}`);
      const prompt = phaseAuthoringContractLines(contract).join('\n');
      assert.equal(prompt.includes(REQUIREMENT_AUTHORING_PROTOCOL), ownsScope);
      if (ownsScope) {
        assert.equal(contract.requirementCoverage, REQUIREMENT_COVERAGE);
        scope += 1;
      }
      phases += 1;
    }
    assert.deepEqual(workflow, before, 'read-side guidance never changes the accepted definition');
  }
  assert.ok(scope > 10 && phases > 50);
  t.diagnostic(`Audited ${Object.keys(definition.workTypes).length} seeded workflows: ${phases} phases, ${scope} scope producers.`);
});

test('custom/legacy criteria producers receive repair guidance; names, unverified skills and deterministic steps do not gain permission', () => {
  const phase = { id: 'team-intent', requiredArtifact: { kind: 'requirements' }, generationPolicy: { task: 'analyze' } };
  const legacy = { phases: { [phase.id]: phase }, workItem: { id: 'COVER-1' } };
  assert.equal(phaseAuthoringContract({}, legacy, phase).requirementCoverage, REQUIREMENT_COVERAGE);
  assert.ok(phasePromptExecutionContract({}, legacy, phase).lines.join('\n').includes(REQUIREMENT_AUTHORING_PROTOCOL));
  const custom = { ...legacy, resolution: { obligationGraph: { nodes: [{ id: phase.id, responsibilities: ['scope'] }] } } };
  assert.equal(phaseAuthoringContract({}, custom, { ...phase, requiredArtifact: { kind: 'custom:criteria' } }).requirementCoverage, REQUIREMENT_COVERAGE);
  const omitted = { ...custom, resolution: { obligationGraph: { nodes: [{ id: phase.id, responsibilities: [] }] } } };
  assert.equal(phaseAuthoringContract({}, omitted, phase).requirementCoverage, undefined);
  assert.equal(phaseAuthoringContract({}, legacy, { ...phase, kind: 'skill' }).requirementCoverage, undefined);
  assert.equal(phaseAuthoringContract({}, legacy, { id: 'specification' }).requirementCoverage, undefined);
  assert.ok(!phaseAuthoringContractLines(phaseAuthoringContract({}, custom, phase), { deterministicOnly: true })
    .join('\n').includes(REQUIREMENT_AUTHORING_PROTOCOL));
});

test('author guidance is bounded, interface-neutral and explicit about repair, authority and genuine evidence', () => {
  for (const surface of REQUIREMENT_COVERAGE.surfaces) assert.ok(REQUIREMENT_AUTHORING_PROTOCOL.includes(surface));
  for (const phrase of ['Existing acceptance criteria count', 'source obligation -> REQ/AC -> observable assertion',
    'Repair clear omissions in this editable draft before prepublish', 'Reuse settled answers',
    'never invent a disposition', 'Do not repair application code', 'authorized successor or upstream route',
    'configured budget', 'Never retry unchanged content', 'manual repair remains available',
    'requirements until genuine results exist']) assert.ok(REQUIREMENT_AUTHORING_PROTOCOL.includes(phrase), phrase);
  assert.ok(Buffer.byteLength(REQUIREMENT_AUTHORING_PROTOCOL) < 2600, 'a compact rubric, not another large inventory');
  assert.equal(REQUIREMENT_COVERAGE.coverageIsExecution, false);
  assert.equal(REQUIREMENT_COVERAGE.pinnedConstraintsTakePrecedence, true);
  assert.match(REQUIREMENT_AUTHORING_PROTOCOL, /Honor explicit pinned constitution\/template constraints/u);
  assert.match(REQUIREMENT_REVIEW_PROTOCOL, /review constraints; never waive them/u);
  assert.equal(REQUIREMENT_COVERAGE.reviewerEditsArtifact, false);
});

test('old prompts receive current guidance once, without rewriting or granting non-scope authority', () => {
  for (const original of ['Old pinned prompt.\n', 'Old Windows prompt.\r\n']) {
    const delivered = withRequirementAuthoringProtocol(original);
    assert.ok(delivered.startsWith(original.trimEnd()));
    assert.ok(delivered.includes(REQUIREMENT_AUTHORING_PROTOCOL));
    assert.equal(withRequirementAuthoringProtocol(delivered), delivered);
    assert.equal(withRequirementAuthoringProtocol(original, false), original);
    assert.equal(withRequirementReviewProtocol(withRequirementReviewProtocol(original)), withRequirementReviewProtocol(original));
  }
  assert.equal(withRequirementAuthoringProtocol(null), null);
  const phase = { id: 'team-intent', requiredArtifact: { kind: 'requirements' } };
  const workflow = { workItem: { id: 'COVER-1' }, phases: { [phase.id]: phase }, phaseOrder: [phase.id], currentPhase: phase.id };
  const old = 'An immutable pre-upgrade Story prompt.\n';
  const before = structuredClone(workflow);
  const adapted = withPhasePromptRuntimeGuidance(old, {}, workflow, phase);
  assert.ok(adapted.includes(REQUIREMENT_AUTHORING_PROTOCOL));
  assert.equal(withPhasePromptRuntimeGuidance(adapted, {}, workflow, phase), adapted);
  assert.deepEqual(workflow, before);
  assert.ok(!withPhasePromptRuntimeGuidance(old, {}, workflow, { id: 'proof', requiredArtifact: { kind: 'test-evidence' } })
    .includes(REQUIREMENT_AUTHORING_PROTOCOL));
});

test('pinned specification reviewers receive current calibration without replacing instructions, hashes or binding', () => {
  const original = { kind: 'specification', canReview: true, reviewer: { instructions: 'Old reviewer instructions.', sha256: 'a'.repeat(64) } };
  const before = structuredClone(original);
  const delivered = compactSourceReviewContext(original, {});
  assert.equal(delivered.reviewer.instructions, original.reviewer.instructions);
  assert.equal(delivered.reviewer.sha256, original.reviewer.sha256);
  assert.ok(delivered.reviewer.effectiveInstructions.includes(REQUIREMENT_REVIEW_PROTOCOL));
  assert.match(delivered.reviewGuide.requirementCoverage, /existing acceptance criteria count/u);
  assert.equal(delivered.reviewer.effectiveInstructions.split(REQUIREMENT_REVIEW_PROTOCOL).length, 2);
  assert.deepEqual(original, before);
  assert.equal(compactSourceReviewContext({ ...original, kind: 'planning' }, {}).reviewGuide.requirementCoverage, undefined,
    'planning continues to assess its exact approved claims, not redefine scope');
});

test('Initiative requirements follow declared outputs across Epic, discovery, NFR and custom phases', async () => {
  const portfolio = YAML.parse(await readFile(new URL('../templates/portfolio.yml', import.meta.url), 'utf8'));
  for (const id of ['epic-requirements', 'discover-define', 'elaboration']) assert.equal(initiativeGathersRequirements(portfolio.initiativePhases[id]), true, id);
  for (const id of ['epic-intake', 'epic-planning', 'release']) assert.equal(initiativeGathersRequirements(portfolio.initiativePhases[id]), false, id);
  assert.equal(initiativeGathersRequirements({ id: 'arbitrary', outputs: [{ id: 'criteria', kind: 'requirements' }] }), true);
  assert.equal(initiativeGathersRequirements({ id: 'epic-requirements', outputs: [] }), false);
});

// These are reviewer-supplied judgments, not a deterministic semantic classifier. Verify that the
// existing kernel accepts legitimate AC/shared coverage while retaining genuine independent gaps.
for (const [surface, source, outcome] of [
  ['UI', 'Add a Hex button and retain a screenshot showing it.', 'The screenshot shows the Hex button.'],
  ['API', 'The conversion API must return the converted value.', 'The API response contains the converted value.'],
  ['mixed', 'A submitted form must enqueue a conversion job and show its result.', 'The form submits a job and displays its result.']
]) test(`${surface}: AC coverage counts, wording is advisory, and a genuine omission still blocks`, () => {
  const context = { kind: 'specification', workId: 'COVER-1', phase: 'team-intent', generation: 1,
    authorAgentId: 'author', reviewerAgentId: 'independent', reviewerReadOnly: true,
    sources: [{ id: 'story', path: 'USER-STORY.md', text: `${source}\n` }],
    artifact: { path: 'spec.md', text: `## User scenarios\n### S1 — Requested outcome\nGiven the starting state, when triggered, then ${outcome}\n## Requirements\n- ${outcome} (S1) [COVER-1:AC-001]\n` } };
  const report = { schemaVersion: 1, resultType: 'source-grounded-review', kind: 'specification',
    binding: sourceReviewBinding(context), reviewer: { agentId: 'independent', readOnly: true },
    sourcesReviewed: ['story'], findings: [], rows: [{ id: 'requested', sourceId: 'story', line: 1, quote: source,
      outcome: 'covered', scenarioId: 'S1', clauseIds: ['COVER-1:AC-001'] }] };
  const checked = evaluateSourceGroundedReview(report, context);
  assert.equal(checked.status, 'ready', JSON.stringify(checked.findings));
  report.findings = [{ id: 'wording', severity: 'advisory', message: 'The same required outcome could be worded more explicitly.' }];
  assert.equal(evaluateSourceGroundedReview(report, context).status, 'ready');
  report.findings = [{ id: 'missing-behavior', severity: 'blocking', message: 'An implementation could satisfy the named result yet omit another explicit source obligation.' }];
  assert.equal(evaluateSourceGroundedReview(report, context).status, 'correction-required', 'calibration does not override an independent judgment');
});

// Owner policy (2026-11-10): every issue is repairable in the step where it arises. A step's own repairs lead and
// are same-turn whenever one exists; another owner's finding beside them only follows. Stories cplus and anu-bin
// (2026-11-11) each stopped because one foreign finding turned the whole correction into "not this turn".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWN_REPAIR_STOPS, correctionPlan, phaseFindingPolicy } from '../src/phase-finding-policy.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';

const step = (id, status, extra = {}) => ({ id, label: id, status, generation: 1, approvals: [],
  approvalPolicy: { authorities: ['engineering'], minimum: 1, rejectTo: [id] }, ...extra });
function story(currentPhase) {
  return { workItem: { id: 'W-9' }, status: 'in_progress', currentPhase,
    phaseOrder: ['specification', 'planning', 'implementation', 'verification'],
    phases: {
      specification: step('specification', 'approved'),
      planning: step('planning', currentPhase === 'planning' ? 'in_progress' : 'approved'),
      implementation: step('implementation', currentPhase === 'implementation' ? 'in_progress' : 'not_started',
        { generationPolicy: { task: 'code' }, writeScope: 'source-and-artifact', generationIntent: { status: 'open', generation: 2 } }),
      verification: step('verification', 'not_started')
    }, resolution: {} };
}

// The step's own repairs, each a different check.
const OWN = {
  planning: {
    'plan row': { code: 'specification.planned-test-missing', category: 'planning-table', path: 'plan.md', message: 'Clause W-9:REQ-001 has no planned test.', details: { clauseId: 'W-9:REQ-001' } },
    'plan short of the intent (cplus)': { code: 'specification.planned-test-invalid', category: 'planning-table', path: 'plan.md', message: 'unmet',
      details: { clauseId: 'W-9:REQ-002', cause: 'intent-not-met', sourceCode: 'SPEC_VERIFICATION_INTENT_INVALID', ownerPhase: 'specification', upstreamPhase: 'specification', repairScope: 'current-draft' } },
    placeholder: { code: 'artifact.placeholder.unresolved', category: 'artifact', path: 'plan.md', line: 4, value: 'TBD', message: 'TBD' }
  },
  implementation: {
    'binding (anu-bin)': { code: 'code.delivery.incomplete', category: 'code-delivery', phase: 'implementation', message: 'coverage',
      details: { sourceCode: 'SPEC_COVERAGE_INCOMPLETE', coverage: { unimplemented: ['W-9:REQ-001'], unclaimedChangedPaths: ['src/Keypad.jsx'], invalidEvidence: [], withdrawnButClaimed: [] },
        claimGaps: [{ clauseId: 'W-9:REQ-001', verdict: 'partial', missingSourcePaths: [], missingSourceBindings: ['src/Keypad.jsx'], missingTestPaths: [], missingConfigurationPaths: [] }] } },
    'delivery': { code: 'code.delivery.incomplete', category: 'code-delivery', phase: 'implementation', message: 'x', details: { sourceCode: 'CODE_DELIVERY_EVIDENCE_REQUIRED' } },
    'clause tag': { code: 'code.delivery.source-clause-tag-missing', category: 'traceability', path: 'src/a.mjs', value: 'W-9:REQ-003', message: 'tag' },
    // Recovery reports these under its code-delivery wrapper, which no category names as the author's.
    'unapproved clause tag': { code: 'code.delivery.incomplete', category: 'code-delivery', phase: 'implementation', message: 'x', details: { sourceCode: 'EVIDENCE_CLAUSE_UNAPPROVED' } },
    'symlink delivered': { code: 'code.delivery.incomplete', category: 'code-delivery', phase: 'implementation', message: 'x', details: { sourceCode: 'SYMLINK_DELIVERY_FORBIDDEN' } },
    'failed test': { code: 'CODE_TEST_FAILED', category: 'tests', message: 'failed', details: { requiredTestExecution: { failure: { kind: 'failed-tests' } } } }
  }
};
// Another owner's finding: never a reason for the author to fix nothing.
const FOREIGN = {
  'intent row an open issue names': { code: 'specification.planned-test-invalid', category: 'planning-table', path: 'plan.md', message: 'unmet',
    details: { clauseId: 'W-9:REQ-004', cause: 'intent-not-met', ownerPhase: 'specification', upstreamPhase: 'specification', repairScope: 'current-draft',
      upstreamIssues: ['UPI-001'], nextAction: { command: 'singularity-flow decisions W-9 --json', skill: '/sf-decide', label: 'decide' } } },
  'clarification marker': { code: 'specification.unresolved-clarification', category: 'clarification', path: 'spec.md', message: 'question' },
  'unplanned path only': { code: 'code.delivery.incomplete', category: 'code-delivery', message: 'x',
    details: { sourceCode: 'SPEC_COVERAGE_INCOMPLETE', coverage: { unimplemented: [], unclaimedChangedPaths: ['src/unplanned.js'], invalidEvidence: [], withdrawnButClaimed: [] }, claimGaps: [] } },
  'stray file outside the documents': { code: 'PHASE_ARTIFACT_ONLY_CHANGES', category: 'change-scope', path: 'notes.md', message: 'outside', details: { sourceCode: 'PHASE_ARTIFACT_ONLY_CHANGES' } },
  'missing MCP evidence': { code: 'phase.mcp-evidence.not-ready', category: 'external-evidence', message: 'receipt', details: { sourceCode: 'MCP_EVIDENCE_REQUIRED' } },
  'appeal under review': { code: 'phase.appeal.not-ready', category: 'appeal', message: 'appeal', details: { sourceCode: 'PHASE_APPEAL_REVIEW_REQUIRED' } },
  'approved input changed': { code: 'phase.inputs.not-ready', category: 'inputs', path: 'spec.md', message: 'input', details: { sourceCode: 'PHASE_INPUTS_NOT_READY', upstreamPhase: 'specification' } },
  'assignment': { code: 'phase.assignment.required', category: 'collaboration', message: 'assign' },
  'honest partial verdict': { code: 'conformance.verdict-incomplete', category: 'traceability', path: 'report.md', message: 'partial' },
  'excluded changes': { code: 'code.delivery.incomplete', category: 'code-delivery', message: 'x', details: { sourceCode: 'GENERATION_EXCLUDED_CHANGES_UNRESOLVED', paths: ['index.html'] } },
  'staged governed paths': { code: 'LIFECYCLE_STAGED_GOVERNED_REVIEW_REQUIRED', category: 'worktree', path: 'plan.md', message: 'staged' }
};
// The only findings that stop the author's own repair, each with its named stop.
const STOPS = {
  integrity: { code: 'CHANGE_SET_POLICY_VIOLATION', category: 'integrity', message: 'protected', details: { violationKind: 'protected-process-path' } },
  'phase-not-current': { code: 'phase.lifecycle.not-publishable', category: 'lifecycle', message: 'not current' },
  'retained-publication': { code: 'phase.publication.pending', category: 'lifecycle', message: 'pending' },
  'governance-hold': { code: 'PHASE_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED', category: 'amendment', message: 'hold' },
  'agent-not-permitted': { code: 'phase.generation-intent.required', category: 'code-delivery', message: 'begin' },
  'held-evidence-unverified': { code: 'phase.evidence-contract.not-ready', category: 'evidence-contract', path: 'evidence/screen.png', message: 'review',
    details: { sourceCode: 'PLAN_EVIDENCE_CORRECTION_REVIEW_REQUIRED' } },
  'stale-reviewed-input': { code: 'PRIOR_CODE_TEST_EVIDENCE_STALE', category: 'evidence', message: 'stale' }
};

test('own repairs are same-turn beside every foreign finding, and only the named stops suspend them', () => {
  for (const [phaseId, fixtures] of Object.entries(OWN)) {
    const workflow = story(phaseId);
    const phase = workflow.phases[phaseId];
    for (const [ownName, own] of Object.entries(fixtures)) {
      assert.equal(correctionPlan(workflow, phase, [own]).sameTurn, true, `${phaseId}: ${ownName} alone`);
      for (const [foreignName, foreign] of Object.entries(FOREIGN)) {
        const plan = correctionPlan(workflow, phase, [foreign, own]);
        assert.equal(plan.sameTurn, true, `${phaseId}: ${ownName} beside ${foreignName}`);
        assert.deepEqual([plan.own, plan.foreign], [[own], [foreign]], `${phaseId}: ${ownName} beside ${foreignName}`);
        assert.equal(correctionPlan(workflow, phase, [foreign]).sameTurn, false, `${foreignName} alone is not the author's`);
      }
      const answers = correctionPlan(workflow, phase, [own, { code: 'phase.clarification.not-ready', category: 'clarification', message: 'answers',
        details: { sourceCode: 'PHASE_CLARIFICATION_NOT_READY' } }]);
      assert.deepEqual(answers.stops, ['agent-not-permitted'], 'answer first; never draft unknown scope');
      for (const [stop, finding] of Object.entries(STOPS)) {
        const plan = correctionPlan(workflow, phase, [own, finding]);
        assert.equal(plan.sameTurn, false, `${ownName} with ${stop}`);
        assert.deepEqual(plan.stops, [stop], `${ownName} with ${stop}`);
      }
    }
  }
  // The stop list is deliberate: adding one is a policy change, said here.
  assert.deepEqual(Object.keys(OWN_REPAIR_STOPS).sort(), Object.keys(STOPS).sort());
  assert.throws(() => correctionPlan(story('planning'), story('planning').phases.planning, [], { stops: ['person-decides'] }), /Unknown own-repair stop/u);
});

test('every own finding\'s resolution leads with its author, whatever the Story enables', () => {
  for (const [phaseId, fixtures] of Object.entries(OWN)) {
    for (const testRecovery of [false, true]) {
      const workflow = { ...story(phaseId), ...(testRecovery ? { testRecovery: { enabled: true } } : {}) };
      for (const [name, finding] of Object.entries(fixtures)) {
        const resolved = phaseResolutionChoices(workflow, workflow.phases[phaseId], finding);
        assert.equal(resolved.choices[0].owner, phaseId, `${phaseId}: ${name}${testRecovery ? ' with test recovery' : ''}: ${resolved.choices[0].kind}`);
        assert.equal(resolved.status, 'needs-correction', `${phaseId}: ${name}`);
      }
    }
  }
  // A pilot-eligible coverage gap: the author delivers first; the person's risk acceptance follows.
  const workflow = story('implementation');
  const gap = { code: 'code.delivery.incomplete', category: 'code-delivery', phase: 'implementation', message: 'x',
    details: { sourceCode: 'SPEC_COVERAGE_INCOMPLETE', qualityRisk: { eligible: true }, coverage: { unimplemented: ['W-9:REQ-001'], unclaimedChangedPaths: [], invalidEvidence: [], withdrawnButClaimed: [] },
      claimGaps: [{ clauseId: 'W-9:REQ-001', verdict: 'missing', missingSourcePaths: ['src/a.mjs'], missingSourceBindings: [], missingTestPaths: [], missingConfigurationPaths: [] }] } };
  const risk = phaseResolutionChoices(workflow, workflow.phases.implementation, gap);
  assert.deepEqual(risk.choices.slice(0, 2).map((choice) => choice.kind), ['author-correction', 'pilot-risk-review']);
  // A planned file short only of its binding beside a truly unplanned one: bind it now; the unplanned path's review follows.
  const mixed = { ...OWN.implementation['binding (anu-bin)'], details: { ...OWN.implementation['binding (anu-bin)'].details,
    coverage: { ...OWN.implementation['binding (anu-bin)'].details.coverage, unclaimedChangedPaths: ['src/Keypad.jsx', 'src/unplanned.js'] } } };
  assert.equal(phaseFindingPolicy(mixed).repairableByProducer, true);
  assert.equal(phaseFindingPolicy(mixed).riskEligible, false, 'never an accepted risk while a change is unclaimed');
  const both = phaseResolutionChoices(workflow, workflow.phases.implementation, mixed);
  assert.deepEqual(both.choices.slice(0, 2).map((choice) => choice.kind), ['author-correction', 'scope-appeal']);
  assert.match(both.choices[1].detail, /src\/unplanned\.js/u);
  assert.doesNotMatch(both.choices[1].detail, /Keypad/u, 'a planned file short of its binding is not a scope question');
  // Nothing left to deliver: the person's scope review is the way, as before.
  assert.equal(phaseResolutionChoices(workflow, workflow.phases.implementation, FOREIGN['unplanned path only']).choices[0].kind, 'scope-appeal');
});

const sourceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
async function sourceFiles(directory = sourceRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? sourceFiles(path.join(directory, entry.name))
    : entry.name.endsWith('.mjs') ? [path.join(directory, entry.name)] : []));
  return nested.flat();
}

test('no surface decides same-turn over every finding, and recovery puts no person\'s choice ahead of the author', async () => {
  const offenders = [];
  for (const file of await sourceFiles()) {
    if (path.basename(file) === 'phase-finding-policy.mjs') continue;
    const text = await readFile(file, 'utf8');
    // An `.every(` whose callback names ownership or producer repair: one foreign finding would flip them all.
    for (const match of text.matchAll(/\.every\(([^;]{0,240})/gu)) {
      if (/findingOwnedByPhase|repairableByProducer|planCorrectsFirst/u.test(match[1])) offenders.push(`${path.relative(sourceRoot, file)}: ${match[0].slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], 'decide through correctionPlan in phase-finding-policy.mjs instead');
  const recovery = await readFile(path.join(sourceRoot, 'recovery-plan.mjs'), 'utf8');
  assert.doesNotMatch(recovery, /actions\.unshift\(/u, 'a person\'s choice is placed after the author\'s actions, never unshifted ahead of them');
  // The plan's own correction for a row, a person's, follows the code step's delivery of it.
  assert.ok(recovery.indexOf('complete-code-delivery:') < recovery.indexOf('correct-plan-row:'), 'the code step\'s delivery is listed before the plan row correction');
  assert.ok(recovery.indexOf('complete-code-delivery:') < recovery.indexOf('withdraw-return:'), 'the change a return asks for is listed before its withdrawal');
});

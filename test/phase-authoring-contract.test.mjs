import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { phaseAuthoringContract, phaseAuthoringContractLines, phasePlansDelivery, scaffoldPlanningRows } from '../src/phase-authoring-contract.mjs';
import { inspectPlannedClaimMap, derivePlannedClaimMap } from '../src/specifications.mjs';
import { phaseFindingPolicy } from '../src/phase-finding-policy.mjs';
import { phaseContextAdmission } from '../src/phase-entry-admission.mjs';

const ids = ['TEAM-1:REQ-001', 'TEAM-1:REQ-002', 'TEAM-1:AC-001', 'TEAM-1:AC-002'];
const evidenceRoot = 'team/stories/TEAM-1/evidence';
const header = '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |\n|---|---|---|---|---|';

function workflow(names = ['discover', 'design', 'build', 'reconcile', 'test', 'close']) {
  const kinds = ['requirements', 'design', 'implementation-summary', 'convergence-report', 'test-evidence', 'conformance-report'];
  const phases = Object.fromEntries(names.map((id, index) => [id, { id,
    requiredArtifact: { kind: kinds[index] }, generationPolicy: { task: index === 2 ? 'code' : 'analyze' } }]));
  return { workItem: { id: 'TEAM-1' }, phaseOrder: names, currentPhase: names[1], phases,
    resolution: { plannedClaims: { mode: 'required', owners: { [names[2]]: names[1] } },
      obligationGraph: { nodes: names.map((id, index) => ({ id,
        responsibilities: index === 0 ? ['scope'] : index === 1 ? ['plan'] : [] })) } } };
}

test('installed contracts follow capabilities across all phases, renamed workflows and repeated repair steps', () => {
  for (const names of [undefined, ['intake-z', 'outline-z', 'patch-z', 'digest-z', 'proof-z', 'finish-z']]) {
    const story = workflow(names);
    const before = structuredClone(story);
    const contracts = story.phaseOrder.map(id => phaseAuthoringContract({ workItemRoot: 'team/stories' }, story, story.phases[id]));
    assert.deepEqual(contracts.map(entry => entry.roles), [['scope'], ['plan'], ['code'], ['convergence'], ['verification'], ['closure']]);
    for (const contract of contracts) {
      assert.equal(contract.priorApprovalsImmutable, true);
      assert.equal(contract.revalidatePriorDraftQuality, false);
      assert.equal(contract.draftDefectsPreventRepair, false);
      assert.equal(contract.repairIsApproval, false);
      assert.equal(contract.revision, 'phase-authoring-v3');
      assert.deepEqual(contract.advisories, { blockPublication: false, scopeAccountingRequiredBefore: 'approve', commentsRequireHumanDecision: false });
      assert.match(phaseAuthoringContractLines(contract).join('\n'), /When prepublish is ready and returns commands.publish, continue that publication attempt/);
      assert.equal(contract.evidenceRoot, evidenceRoot);
      assert.equal(contract.recovery.exhaustedAutomaticBudget, 'manual-repair-remains-available');
    }
    assert.deepEqual(story, before, 'read-side defaults never amend an accepted workflow');
    const owner = story.phaseOrder[1];
    const extra = { id: 'team-repair-again', generationPolicy: { task: 'code' } };
    story.phases[extra.id] = extra;
    story.resolution.plannedClaims.owners[extra.id] = owner;
    assert.equal(phasePlansDelivery(story, story.phases[owner]), true);
    assert.equal(phaseAuthoringContract({}, story, extra).roles.includes('code'), true);
  }
});

test('a familiar phase name grants no planning or source permission; explicit off remains off', () => {
  const story = workflow();
  story.phases.planning = { id: 'planning', generationPolicy: { task: 'analyze' } };
  assert.equal(phasePlansDelivery(story, story.phases.planning), false);
  story.resolution.plannedClaims = { mode: 'off' };
  assert.equal(phasePlansDelivery(story, story.phases.design), false);
  assert.equal(phaseAuthoringContract({}, story, story.phases.design).planning, undefined, 'descriptive roles cannot override explicit pinned off');
  assert.equal(phaseAuthoringContract({}, story, story.phases.planning).planning, undefined);
  const legacy = { phaseOrder: ['code'], phases: { code: { id: 'code', generationPolicy: { task: 'code' } } } };
  assert.equal(phasePlansDelivery(legacy, { id: 'not-in-workflow' }), false);
});

test('new template scaffolds contain all exact clauses, including every AC, without fabricated paths or proof', async () => {
  const template = await readFile(new URL('../templates/artifacts/spec-driven/plan.md', import.meta.url), 'utf8');
  const rendered = scaffoldPlanningRows(template, [...ids, ids[0].toLowerCase()]);
  assert.equal((rendered.match(/^\| \[TEAM-1:/gmu) ?? []).length, ids.length);
  for (const id of ids) assert.ok(rendered.includes(`| [${id}] | - | TODO | - | TODO |`));
  assert.ok(rendered.includes('TODO: State the implementation order'));
  assert.equal(inspectPlannedClaimMap(rendered, { clauseIds: ids, evidenceRoot }).claimMap, null,
    'a scaffold is an unfinished draft, not passing planned evidence');
  const crlf = scaffoldPlanningRows(template.replaceAll('\n', '\r\n'), ids);
  assert.equal(crlf.replaceAll('\r\n', '').includes('\n'), false);
  assert.equal(scaffoldPlanningRows('An authored draft without a table.', ids), 'An authored draft without a table.');
  const authored = `${header}\n| [TEAM-1:REQ-001] | \`src/App.jsx\` | \`test/app.test.js\` | modified | Returns the approved result. |\n`;
  assert.equal(scaffoldPlanningRows(authored, ids), authored, 'literal authored rows are never replaced');
});

test('one inspection reports the failed evidence path, every malformed witness cell and all missing clauses', () => {
  const broken = [header,
    '| [TEAM-1:REQ-001] | `-` | `test/app.test.js` | evidence | Captures the screen. |',
    '| [TEAM-1:REQ-002] | `src/App.jsx` | `test/app.test.js` | modified | Implements the result. |',
    '', '## Verification contracts',
    '| Criterion | Slot | Method | Witness | Role | Required assurance |', '|---|---|---|---|---|---|',
    '| Hex screenshot | Primary visual | screenshot scenario prose | `screen` | product owner | browser confidence |'
  ].join('\n');
  const options = { clauseIds: ids, evidenceRoot, requireComplete: true };
  const inspected = inspectPlannedClaimMap(broken, options);
  assert.equal(inspected.valid, false);
  assert.equal(inspected.claimMap, null, 'never expose a partially valid map as governed evidence');
  assert.ok(inspected.diagnostics.some(row => row.clauseId === ids[0] && row.field === 'expectedPaths' && row.line === 3));
  for (const field of ['criterion', 'slot', 'method', 'role', 'required assurance']) {
    assert.ok(inspected.diagnostics.some(row => row.field === field && row.line === 9), field);
  }
  for (const clauseId of ids.filter(id => id.includes(':AC-'))) {
    assert.ok(inspected.diagnostics.some(row => row.clauseId === clauseId && row.code === 'SPEC_PLANNED_ROW_REQUIRED'));
  }
  assert.throws(() => derivePlannedClaimMap(broken, options), error => {
    assert.deepEqual(error.details.diagnostics, inspected.diagnostics);
    return true;
  });
  assert.ok(inspected.diagnostics.every(row => phaseFindingPolicy({ code: row.code, category: 'planning-table' }).repairableByProducer));
});

test('correcting all rows once produces a valid plan without counting screenshot existence as acceptance', () => {
  const valid = [header,
    '| [TEAM-1:REQ-001] | `src/App.jsx` | `test/app.test.js` | modified | Returns the result. |',
    '| [TEAM-1:REQ-002] | `src/App.jsx` | `test/app.test.js` | modified | Preserves invalid input behavior. |',
    '| [TEAM-1:AC-001] | `src/App.jsx` | `test/app.test.js` | modified | Automated result check passes. |',
    `| [TEAM-1:AC-002] | \`${evidenceRoot}/desktop.png\` | not-applicable: Visual result needs an independent screenshot review. | evidence | The retained screen shows the result. |`,
    '', '## Verification contracts', '| Criterion | Slot | Method | Witness | Role | Required assurance |', '|---|---|---|---|---|---|',
    `| [TEAM-1:AC-002] | desktop | visual | \`${evidenceRoot}/desktop.png\` | primary | source-bound |`
  ].join('\n');
  const inspected = inspectPlannedClaimMap(valid, { clauseIds: ids, evidenceRoot, requireComplete: true });
  assert.equal(inspected.valid, true);
  assert.deepEqual(Object.keys(inspected.claimMap.claims).sort(), [...ids].sort());
  assert.equal(inspected.claimMap.verificationContracts[0].slots[0].method, 'visual');
  assert.equal(inspected.claimMap.verificationContracts[0].slots[0].requiredAssurance, 'source-bound');
  assert.equal(inspected.claimMap.verificationContracts[0].slots[0].status, undefined, 'no witness verdict invented');
});

test('all phases retain composition for current draft defects, but no upstream integrity/recovery bypass', () => {
  const authoring = { entry: { status: 'authoring-entry' }, policyVerified: true, effectiveAuthoringSkill: '/sf-phase' };
  for (const phase of workflow().phaseOrder) {
    const defect = { code: 'artifact.heading.empty', category: 'artifact', phase };
    assert.equal(phaseContextAdmission({ authoring, recovery: { blockers: [defect], requiresRecovery: false } }).allowed, true);
    assert.equal(phaseContextAdmission({ authoring, recovery: { requiresRecovery: true,
      blockers: [{ code: 'SPECIFICATION_INDEX_UNTRUSTED', category: 'integrity', phase: 'discover' }] } }).allowed, false);
  }
  assert.equal(phaseFindingPolicy({ code: 'SPECIFICATION_INDEX_UNTRUSTED', category: 'integrity' }).repairableByProducer, false);
  assert.equal(phaseFindingPolicy({ code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE', category: 'planning-table' }).riskEligible, false);
});

test('prompt contracts share the approved capsule instead of re-copying or reconstructing prior artifacts', () => {
  const story = workflow();
  const lines = phaseAuthoringContractLines(phaseAuthoringContract({}, story, story.phases.design)).join('\n');
  assert.match(lines, /every approved requirement and acceptance ID from the authoritative clause capsule/u);
  assert.match(lines, /never re-author an earlier phase/u);
  assert.match(lines, /scenario\/reviewer prose outside/u);
  assert.doesNotMatch(lines, /singularity-flow (?:session current|status)/u);
  assert.match(lines, /regenerate kernel-owned artifacts, never hand-edit/u);
});

test('oversized diagnostic sets stay explicitly bounded and can never become partial passing proof', () => {
  const clauseIds = Array.from({ length: 400 }, (_, index) => `TEAM-1:REQ-${String(index + 1).padStart(3, '0')}`);
  const result = inspectPlannedClaimMap('# An incomplete draft', { clauseIds, requireComplete: true });
  assert.equal(result.valid, false);
  assert.equal(result.claimMap, null);
  assert.equal(result.diagnostics.length, 256);
  assert.deepEqual(result.diagnosticSummary, { maximum: 256, omitted: 144, complete: false });
  assert.throws(() => derivePlannedClaimMap('# An incomplete draft', { clauseIds, requireComplete: true }),
    error => error.details.diagnosticSummary.complete === false);
});

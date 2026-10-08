import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { planningEvidenceRepair } from '../src/planning-evidence-repair.mjs';
import { derivePlannedClaimMap } from '../src/specifications.mjs';
import { phaseAgentResult } from '../src/phase-agent-result.mjs';
import { authoredArtifactText } from '../src/publication-preflight.mjs';

const AC = 'PLAN-1:AC-001';
const OTHER = 'PLAN-1:AC-002';
const evidenceRoot = 'singularity/work-items/PLAN-1/evidence';
const file = `${evidenceRoot}/desktop.png`;
const options = { clauseIds: [AC], evidenceRoot };
const plan = [
  '# Delivery plan', '', '## Test strategy',
  '| Clause | Expected paths | Planned tests | Fulfillment | Steps | Observable result |',
  '|---|---|---|---|---|---|',
  `| [${AC}] | \`src/App.jsx\` | \`test/App.test.mjs\` | modified | custom-code | The captured screen shows the approved result. |`,
  '', '## Visual delivery', `Primary visual verification contract for [${AC}].`,
  `Capture the approved desktop result and retain \`${file}\`.`, ''
].join('\n');

function apply(source, result) {
  assert.equal(createHash('sha256').update(source).digest('hex'), result.sourceSha256, 'stale draft');
  for (const patch of result.patches) source = patch.kind === 'append' ? source + patch.after
    : source.replace(patch.before, () => patch.after);
  return source;
}

test('exact producer patches type retained evidence before publication without waiving tests or visual review', () => {
  const original = plan;
  const repair = planningEvidenceRepair(plan, options);
  assert.equal(repair.status, 'producer-repair');
  assert.equal(repair.mutates, false);
  assert.equal(repair.evidenceAccepted, false);
  assert.equal(repair.testsWaived, false);
  assert.equal(repair.requiresSemanticVerification, true);
  assert.deepEqual(repair.targets, [{ clauseId: AC, path: file, method: 'visual' }]);
  const candidate = apply(plan, repair);
  const derived = derivePlannedClaimMap(candidate, options).claimMap;
  assert.equal(derived.claims[AC].fulfillment, 'evidence');
  assert.deepEqual(derived.claims[AC].expectedPaths, [file]);
  assert.deepEqual(derived.claims[AC].tests, ['test/App.test.mjs']);
  assert.deepEqual(derived.claims[AC].steps, ['custom-code']);
  assert.equal(derived.claims[AC].observableResult, 'The captured screen shows the approved result.');
  assert.deepEqual(derived.verificationContracts[0].slots, [
    { slot: 'retained-evidence', method: 'visual', role: 'primary', witness: { target: file }, requiredAssurance: 'source-bound' },
    { slot: 'supporting-test-1', method: 'test', role: 'supporting', witness: { path: 'test/App.test.mjs' }, requiredAssurance: null }
  ]);
  assert.equal(plan, original);
  assert.throws(() => apply(`${plan}changed`, repair), /stale draft/u);
  assert.deepEqual(phaseAgentResult({ resultType: 'sflow-phase-prepublish', phase: 'custom-plan',
    planningEvidenceRepair: repair }).planningEvidenceRepair, repair, 'agent projection must retain exact patches');
});

test('inspection, lower-case IDs, CRLF and missing Fulfillment headers use the same publication validator', () => {
  const source = plan.replaceAll(AC, AC.toLowerCase()).replace('primary visual', 'primary inspection')
    .replace('Primary visual', 'Primary inspection').replace(' | Fulfillment', '').replace('|---|---|---|---|---|---|', '|---|---|---|---|---|')
    .replace(' | modified', '').replaceAll('\n', '\r\n');
  const result = planningEvidenceRepair(source, options);
  assert.equal(result.status, 'producer-repair');
  const candidate = apply(source, result);
  assert.equal(candidate.replaceAll('\r\n', '').includes('\n'), false);
  const derived = derivePlannedClaimMap(candidate, options).claimMap;
  assert.equal(derived.verificationContracts[0].slots[0].method, 'inspection');
  assert.deepEqual(derived.verificationContracts[0].slots[0].witness, { path: file });
});

test('another criterion’s explicit primary tests, any combination and assurance are preserved', () => {
  const source = plan.replace(`| [${AC}]`, `| [${OTHER}] | \`src/other.mjs\` | \`test/other.test.mjs\` | existing | custom-code | Existing behavior stays. |\n| [${AC}]`)
    + ['## Verification contracts', '| Criterion | Slot | Method | Witness | Combination | Reason | Required assurance |',
      '|---|---|---|---|---|---|---|', `| [${OTHER}] | unit | test | \`test/other.test.mjs\` | any | One reviewed witness is sufficient here. | exact-local-observed |`, ''].join('\n');
  const repair = planningEvidenceRepair(source, { ...options, clauseIds: [AC, OTHER] });
  assert.equal(repair.status, 'producer-repair');
  const derived = derivePlannedClaimMap(apply(source, repair), { ...options, clauseIds: [AC, OTHER] }).claimMap;
  assert.equal(derived.claims[OTHER].fulfillment, 'existing');
  const other = derived.verificationContracts.find(contract => contract.clauseId === OTHER);
  assert.equal(other.combination, 'any');
  assert.equal(other.slots[0].role, 'primary');
  assert.equal(other.slots[0].requiredAssurance, 'exact-local-observed');
});

test('an existing contract for the same criterion is never silently downgraded or replaced', () => {
  const source = plan + ['## Verification contracts', '| Criterion | Slot | Method | Witness |', '|---|---|---|---|',
    `| [${AC}] | unit | test | \`test/App.test.mjs\` |`, ''].join('\n');
  const repair = planningEvidenceRepair(source, options);
  assert.equal(repair.status, 'author-review');
  assert.deepEqual(repair.patches, []);
  assert.match(repair.reason, /without replacing primary tests/u);
});

test('ambiguous, foreign, unsafe, duplicate and unapproved declarations require author review', () => {
  const cases = [
    plan.replace('Primary visual', `Primary visual`).replace(`[${AC}].`, `[${AC}] and [${OTHER}].`),
    plan.replace(`\`${file}\``, `\`${file}\` or \`${evidenceRoot}/second.png\``),
    plan.replace(file, 'singularity/work-items/OTHER/evidence/screen.png'),
    plan.replace(file, `${evidenceRoot}/../outside.png`),
    plan.replace(file, `${evidenceRoot}/CON.png`),
    plan + `\n## Another view\nPrimary visual verification contract for [${AC}]. Retain \`${file}\`.`,
    plan.replaceAll(AC, 'OTHER:AC-001'),
    plan.replace(`| [${AC}]`, `| [${AC}] | \`src/dup.jsx\` | \`test/dup.test.mjs\` | modified | custom-code | Duplicate. |\n| [${AC}]`)
  ];
  for (const source of cases) {
    const result = planningEvidenceRepair(source, { ...options, clauseIds: [AC, OTHER] });
    assert.equal(result.status, 'author-review', source);
    assert.deepEqual(result.patches, []);
  }
});

test('examples, comments and managed upstream inputs never become evidence declarations', () => {
  for (const source of [`\`\`\`md\n${plan}\n\`\`\``, `<!--\n${plan}\n-->`,
    `<!-- singularity-flow:inputs:start -->\n${plan}\n<!-- singularity-flow:inputs:end -->`]) {
    assert.equal(planningEvidenceRepair(source, options), null);
  }
  const source = plan + `\n<!-- singularity-flow:inputs:start -->\n${plan}\n<!-- singularity-flow:inputs:end -->`;
  const repair = planningEvidenceRepair(source, options);
  assert.equal(repair.status, 'author-review', 'a patch cannot ambiguously target managed input bytes');
  assert.deepEqual(repair.patches, []);
});

test('valid exact patches leave metadata and distinct approved input bytes untouched', () => {
  const metadata = '<!-- singularity-flow:metadata\n{"binding":"untouched"}\n-->\n';
  const inputs = '\n<!-- singularity-flow:inputs:start -->\nApproved input remains exactly pinned.\n<!-- singularity-flow:inputs:end -->\n';
  const source = metadata + plan + inputs;
  const repair = planningEvidenceRepair(source, options);
  assert.equal(repair.status, 'producer-repair');
  const candidate = apply(source, repair);
  assert.ok(candidate.startsWith(metadata));
  assert.ok(candidate.includes(inputs));
  assert.equal(createHash('sha256').update(authoredArtifactText(candidate)).digest('hex'), repair.proposedAuthoredSha256);
});

test('size bounds, invalid roots and still-invalid plans produce no applicable patches', () => {
  assert.equal(planningEvidenceRepair('x'.repeat(512 * 1024 + 1), options).status, 'author-review');
  for (const root of ['/tmp/evidence', '../escape/evidence', evidenceRoot + '/..']) {
    assert.deepEqual(planningEvidenceRepair(plan, { ...options, evidenceRoot: root }).patches, []);
  }
  const result = planningEvidenceRepair(plan.replace('`test/App.test.mjs`', 'not-applicable: TODO'), options);
  assert.equal(result.status, 'author-review');
  assert.deepEqual(result.patches, []);
});

test('malformed unrelated witness rows never crash the repair projection', () => {
  const source = plan + ['## Verification contracts', '| Criterion | Slot | Method | Witness |', '|---|---|---|---|',
    `| [${OTHER}] | unit | test | \`test/other.test.mjs\` | unexpected column |`, ''].join('\n');
  const result = planningEvidenceRepair(source, { ...options, clauseIds: [AC, OTHER] });
  assert.equal(result.status, 'author-review');
  assert.deepEqual(result.patches, []);
  assert.match(result.reason, /malformed verification-contract/u);
});

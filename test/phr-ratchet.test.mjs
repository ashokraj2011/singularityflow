/**
 * Phase responsibility's ratchet [PHR:REQ-005]: a later step's refusal that judges an earlier step's
 * output has an owner-step check, an upstream route to that step, or both. The evidence evaluator's
 * own findings are classified beside the approval gate's (src/gate-parity.mjs), so a new finding that
 * strands the current author fails here.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { EARLIER_OUTPUT_OWNERS, EVIDENCE_PARITY, EVIDENCE_PARITY_OWNERS, EVIDENCE_PARITY_STAGES, GATE_PARITY } from '../src/gate-parity.mjs';
import { gateFindingOwner, terminalRecoveryActions } from '../src/evidence/terminal.mjs';

const source = (name) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
// The final evaluation's own findings: the evaluator, the records it reads, and each criterion's contract.
const EVALUATOR_SOURCES = ['evidence/evaluate.mjs', 'evidence/graph.mjs', 'verification/contract-results.mjs'];

/**
 * Deliberately empty. A refusal at a later step that judges an earlier step's output with neither an
 * owner-step check nor an upstream route strands the current author with a fix they cannot make, which
 * the owner ruled out (2026-11-09). An entry here needs its reason, and is reported, never added quietly.
 */
const JUDGED_WITHOUT_CHECK_OR_ROUTE = Object.freeze({});

async function evaluatorCodes() {
  const codes = new Set();
  for (const name of EVALUATOR_SOURCES) {
    for (const match of (await source(name)).matchAll(/'((?:EVIDENCE|SCOPE)_[A-Z_]+)'/gu)) codes.add(match[1]);
  }
  return codes;
}

test('[PHR:REQ-005] every EVIDENCE_ and SCOPE_ finding of the final evaluation says whose output it judges and where that is met', async () => {
  const emitted = await evaluatorCodes();
  const listed = new Set(Object.keys(EVIDENCE_PARITY));
  assert.deepEqual([...emitted].filter((code) => !listed.has(code)).sort(), [],
    'the evaluator finds a code src/gate-parity.mjs EVIDENCE_PARITY does not classify: name its owner and its check or route');
  assert.deepEqual([...listed].filter((code) => !emitted.has(code)).sort(), [], 'EVIDENCE_PARITY lists a code the evaluator no longer finds');
  for (const [code, entry] of Object.entries(EVIDENCE_PARITY)) {
    assert.ok(EVIDENCE_PARITY_STAGES.includes(entry.stage), `${code}: unknown stage ${entry.stage}`);
    assert.ok(EVIDENCE_PARITY_OWNERS.includes(entry.owner), `${code}: unknown owner ${entry.owner}`);
    if (entry.stage === 'owner-check') assert.ok(entry.checks.length, `${code}: an owner-check entry names its check`);
    if (entry.stage === 'upstream-route') assert.ok(entry.routes.length, `${code}: an upstream-route entry names its route`);
  }
});

test('[PHR:REQ-005, REQ-010] no later refusal judges an earlier step\'s output without the identical check at the owning step', () => {
  const stranded = [];
  // The evaluator's findings: an earlier step's output owns them, and the owning step runs the same evaluation
  // before its approval. An upstream route alone no longer satisfies this (owner, 2026-11-10).
  for (const [code, entry] of Object.entries(EVIDENCE_PARITY)) {
    if (EARLIER_OUTPUT_OWNERS.includes(entry.owner) && !entry.checks.length) stranded.push(code);
  }
  // The approval gate's: an author-owned code first refused at the ending judges an earlier step's output there.
  for (const [code, entry] of Object.entries(GATE_PARITY)) {
    if (entry.owner === 'author' && entry.stage === 'final-check-preview' && !(entry.routes ?? []).length) stranded.push(code);
  }
  assert.deepEqual(stranded.filter((code) => !Object.hasOwn(JUDGED_WITHOUT_CHECK_OR_ROUTE, code)).sort(), [],
    'give the owning step its check, or route the later refusal back to it; listing it in JUDGED_WITHOUT_CHECK_OR_ROUTE needs a reason and a report');
  assert.deepEqual(Object.keys(JUDGED_WITHOUT_CHECK_OR_ROUTE).filter((code) => !stranded.includes(code)), [],
    'no longer stranded: remove it from JUDGED_WITHOUT_CHECK_OR_ROUTE');
  for (const [code, reason] of Object.entries(JUDGED_WITHOUT_CHECK_OR_ROUTE)) assert.ok(String(reason).length >= 20, `${code}: say why`);
});

test('[PHR:REQ-005] each check and route the tables name exists, so the claim cannot rot', async () => {
  const modules = new Map();
  const named = [...Object.entries(EVIDENCE_PARITY).flatMap(([code, entry]) => [...entry.checks, ...entry.routes].map((item) => [code, item])),
    ...Object.entries(GATE_PARITY).flatMap(([code, entry]) => (entry.routes ?? []).map((item) => [code, item]))];
  for (const [code, item] of named) {
    if (!modules.has(item.module)) modules.set(item.module, await import(`../src/${item.module}`));
    assert.equal(typeof modules.get(item.module)[item.export], 'function', `${code}: ${item.module} has no function ${item.export}`);
    assert.ok(item.at, `${code}: say where ${item.export} runs`);
  }
});

test('[PHR:REQ-005] at the ending, the gate\'s own acceptance and visual findings go back to the step that owns them', () => {
  const step = (id, status, extra = {}) => ({ id, label: id, status, generation: 1, approvals: [],
    approvalPolicy: { authorities: ['engineering'], minimum: 1, rejectTo: [id] }, ...extra });
  const workflow = { workItem: { id: 'END-2' }, status: 'in_progress', currentPhase: 'release', phaseOrder: ['planning', 'implementation', 'release'],
    resolution: { plannedClaims: { mode: 'required', owners: { implementation: 'planning' } } },
    phases: { planning: step('planning', 'approved'), implementation: step('implementation', 'approved', { generationPolicy: { task: 'code' } }),
      release: step('release', 'awaiting_approval') } };
  assert.equal(gateFindingOwner(workflow, 'gate.acceptance.planned-test-missing'), 'planning');
  assert.equal(gateFindingOwner(workflow, 'gate.acceptance.command-failed'), 'implementation');
  assert.equal(gateFindingOwner(workflow, 'gate.visual.threshold'), 'implementation');
  assert.equal(gateFindingOwner(workflow, 'gate.terminal.phase-unapproved'), null, 'the ending\'s own state stays its own');
  const gate = { findings: [{ code: 'gate.acceptance.planned-test-missing', message: 'clause END-2:AC-001 has no planned test' },
    { code: 'gate.acceptance.run-missing', message: 'no specification acceptance run is recorded' }] };
  const actions = terminalRecoveryActions('END-2', { rows: [], findings: [], decision: { gate: 'block' } }, gate, workflow);
  assert.ok(actions.includes('singularity-flow upstream-issue raise --work-id END-2 --phase planning --about END-2:AC-001 --problem <what-is-wrong>'), actions.join('\n'));
  assert.ok(actions.includes('singularity-flow upstream-issue raise --work-id END-2 --phase implementation --about <clause-or-section> --problem <what-is-wrong>'), actions.join('\n'));
});

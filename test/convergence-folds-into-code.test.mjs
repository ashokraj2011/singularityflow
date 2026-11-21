/**
 * Convergence folds into the code approval (owner, 2026-11-21, step intents spec §11, overriding "convergence is always a
 * person's"): the spec-versus-code check is SFlow's own, a section of the code approval (src/convergence-section.mjs),
 * and there is no separate convergence approval by a person. SFlow approves the convergence step when its check is clean
 * (src/automatic-approval.mjs); a real gap never approves itself, and goes back to the code step or to a person's decision.
 *
 * Here, without a Story: the section's table and who fixes each gap, the shipped workflows' setting, the rules that keep
 * a gap and an older Story with their people, and the gate's replay of the record. Journey A and journey W
 * (test/journey-stories.test.mjs) walk the real Stories: two person approvals on the clean path, and a gap back to code.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { approvesAutomatically } from '../src/approval-authority.mjs';
import { automaticApprovalCheck, CONVERGENCE_APPROVAL_CHECKS } from '../src/automatic-approval.mjs';
import { verifyAutomaticApproval } from '../src/automatic-approval-replay.mjs';
import { loadStepIntentSettings, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { CODE_STEP_GAPS, convergenceSection, convergenceSectionForCode, convergenceSectionOf } from '../src/convergence-section.mjs';
import { FACT_KINDS } from '../src/convergence.mjs';
import { automaticApprovalRefusal } from '../src/phase-roles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = async () => YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const fact = (id, kind, clauseIds = [], paths = []) => ({ id, kind, clauseIds, paths, evidence: [], detail: `${kind} detail` });

test('the section: each requirement delivered or a gap, each gap with who fixes it, and clean only when nothing is to decide', () => {
  const clean = convergenceSection({ iteration: 1, clauses: ['W:AC-001', 'W:REQ-002'],
    settledByPlan: [{ id: 'CF-000000000001', paths: ['src/helper.mjs'], settledBy: { kind: 'supporting' } }] });
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.requirements, [{ clause: 'W:AC-001', status: 'delivered' }, { clause: 'W:REQ-002', status: 'delivered' }]);
  assert.match(clean.words, /all 2 requirements are delivered, and the approved plan accounts for the one other change/u);

  const gaps = convergenceSection({ iteration: 2, clauses: ['W:AC-001', 'W:REQ-002'],
    facts: [fact('CF-aaaaaaaaaaaa', 'absent-observed-claim', ['W:REQ-002']), fact('CF-bbbbbbbbbbbb', 'unclaimed-changed-path', [], ['src/extra.mjs'])] });
  assert.equal(gaps.clean, false);
  assert.deepEqual(gaps.requirements, [{ clause: 'W:AC-001', status: 'delivered' }, { clause: 'W:REQ-002', status: 'gap', gaps: ['CF-aaaaaaaaaaaa'] }]);
  assert.deepEqual(gaps.gaps.map((gap) => [gap.id, gap.fixedBy]), [['CF-aaaaaaaaaaaa', 'code-step'], ['CF-bbbbbbbbbbbb', 'person']]);
  assert.match(gaps.words, /found 2 gaps/u);
  // Every fact kind has words and an owner: the code step's own missing or failing evidence, else a person's decision.
  for (const kind of FACT_KINDS) {
    const [gap] = convergenceSection({ facts: [fact('CF-cccccccccccc', kind)] }).gaps;
    assert.notEqual(gap.words, kind, `${kind} has words`);
    assert.equal(gap.fixedBy, CODE_STEP_GAPS.includes(kind) ? 'code-step' : 'person', kind);
  }
  // Something a person decided, an assisted proposal or a blocker is never clean.
  for (const extra of [{ findings: [{ id: 'GF-1', itemId: 'CF-1', disposition: 'accepted-deviation' }] }, { candidates: [{ id: 'CC-1', classification: 'partial', clauseIds: [] }] },
    { unresolvedBlockers: ['GF-1'] }]) assert.equal(convergenceSection({ clauses: ['W:AC-001'], ...extra }).clean, false, JSON.stringify(extra));
  // From a sealed projection, with the specification's clauses from its context.
  const ofProjection = convergenceSectionOf({ iteration: 3, facts: [], settledByPlan: [], candidates: [], findings: [], unresolvedBlockers: [] },
    { records: { indexes: [{ clauses: [{ id: 'W:AC-001' }] }] } });
  assert.deepEqual([ofProjection.iteration, ofProjection.clean, ofProjection.requirements.length], [3, true, 1]);
});

test('the shipped spec-driven workflows: SFlow approves a clean convergence check, and nothing waives it', async () => {
  const raw = await packaged();
  await loadStepIntentSettings(raw);
  const definition = validateDefinition(structuredClone(raw));
  for (const id of ['spec-driven-standard', 'reference-driven-build']) {
    const phases = resolveWorkType(definition, id).phases;
    const convergence = phases.find((phase) => phase.id === 'convergence');
    assert.equal(convergence.approval.mode, 'required', id);
    assert.equal(approvesAutomatically(convergence.approval), true, id);
    // The person approvals on the clean path: the plan and the code.
    assert.deepEqual(phases.filter((phase) => !approvesAutomatically(phase.approval)).map((phase) => phase.id), ['planning', 'implementation'], id);
  }
  assert.equal(automaticApprovalRefusal({ id: 'convergence', artifact: { kind: 'convergence-report' } }), null, 'no longer a rule of its own');
  // Still never waived: no approval, or the low-risk policy, is refused for any step recognised as convergence.
  for (const approval of ['none', { mode: 'policy', policy: 'quick-fix-low-risk-v1', maximumChangedPaths: 5, authorities: ['architecture-reviewers'], minimum: 1 }]) {
    const candidate = structuredClone(raw);
    candidate.phases.convergence.approval = approval;
    assert.throws(() => validateDefinition(candidate), (error) => error.code === 'CONVERGENCE_HUMAN_APPROVAL_REQUIRED'
      && /by a person or by SFlow when its check is clean/u.test(error.message));
  }
  // A convergence step whose workflow says nothing of it keeps a person, with the reason (step intents' derivation): a
  // team's own copy changes only when it says SFlow may approve it.
  const silent = structuredClone(raw);
  delete silent.phases.convergence.approval.automatic;
  delete silent.phases.convergence.because['approval.automatic'];
  await loadStepIntentSettings(silent);
  const kept = resolveWorkType(validateDefinition(structuredClone(silent)), 'spec-driven-standard').phases.find((phase) => phase.id === 'convergence');
  assert.equal(approvesAutomatically(kept.approval), false, 'a person approves it until the workflow says SFlow may');
});

test('a convergence step stays with its people when its check is not clean, cannot be read, or its Story started before', async () => {
  const policy = { mode: 'required', automatic: 'when-ready', authorities: ['architecture-reviewers'], minimum: 1, allowSelfApproval: true };
  const phase = { id: 'convergence', label: 'Convergence', status: 'awaiting_approval', generation: 1, approvals: [], approvalPolicy: policy,
    writeScope: 'artifact-only', requiredArtifact: { kind: 'convergence-report', path: 'artifacts/convergence/convergence.md' }, checks: [] };
  const workflow = { workItem: { id: 'CNV-1', workType: 'spec-driven-standard' }, currentPhase: 'convergence', phaseOrder: ['convergence'],
    phases: { convergence: phase }, resolution: { sourceReview: { mode: 'enforce', phases: [] } } };
  const check = await automaticApprovalCheck(process.cwd(), null, workflow, 'convergence');
  assert.equal(check.applies, true);
  assert.equal(check.eligible, false);
  assert.equal(check.predicates.convergenceClean, false);
  assert.equal(Object.hasOwn(check.predicates, 'reviewReady'), false, 'its own check stands in for a reviewer');
  assert.deepEqual(check.checked, Object.values(CONVERGENCE_APPROVAL_CHECKS));
  assert.ok(check.open.some((line) => /^its convergence check could not be read here/u.test(line)), check.open.join('\n'));
  // A Story started before pinned a convergence approval without it: SFlow never approves it, as before.
  assert.deepEqual(await automaticApprovalCheck(process.cwd(), null,
    { ...workflow, phases: { convergence: { ...phase, approvalPolicy: { mode: 'required', authorities: ['architecture-reviewers'], minimum: 1 } } } }, 'convergence'), { applies: false });
  // A code step's section before convergence is only read for a Story that has a convergence step after its waiting code step.
  assert.equal(await convergenceSectionForCode(process.cwd(), null, { phaseOrder: ['implementation'], phases: { implementation: { id: 'implementation', status: 'awaiting_approval' } } }), null);
});

test('the gate replays a convergence step SFlow approved from the convergence record it names, and refuses one that names none', async () => {
  const policy = { mode: 'required', automatic: 'when-ready', minimum: 1, authorities: ['architecture-reviewers'] };
  const workflow = { workItem: { id: 'CNV-2' }, resolution: { phases: [{ id: 'convergence', approval: policy, writeScope: 'artifact-only',
    artifact: { kind: 'convergence-report' } }] }, lineage: { submissions: [] }, history: [] };
  const phase = { id: 'convergence', generation: 1, approvalPolicy: policy, approvalDisposition: 'approved_automatically', checks: [],
    requiredArtifact: { kind: 'convergence-report' },
    automaticApproval: { rule: 'when-ready-v1', generation: 1, at: 'now', predicates: { convergenceClean: true, nothingOpen: true }, reviewPacketSha256: 'a'.repeat(64) } };
  const unbound = await verifyAutomaticApproval(process.cwd(), {}, workflow, phase);
  assert.equal(unbound.valid, false);
  assert.match(unbound.errors[0], /does not bind this version's submission/u);
  const forged = await verifyAutomaticApproval(process.cwd(), {}, workflow, { ...phase, automaticApproval: { ...phase.automaticApproval, predicates: { convergenceClean: false } } });
  assert.match(forged.errors[0], /not every fact it checked was true/u);
});

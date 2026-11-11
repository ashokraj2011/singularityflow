/**
 * Agent-authored input gets its exact repair [agent input repairs, copied values]. An agent repairs a packet
 * within two attempts; "Invalid input", a raw regular expression, or "stale" for a two-character slip sent it
 * guessing until the budget ran out (Story anu-bin, 2026-11-11). These ratchets hold the shared mechanisms:
 * every zod issue of agent input is said in words with its field; a near miss of a known value carries the
 * exact value through the refusal boundary; a copied confirmation's slip is told apart from a real change.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';

import { agentInputIssues, assertConfirmation, copySlip, nearestKnown } from '../src/records.mjs';
import { refusalEnvelope } from '../src/refusal-remediation.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { UpstreamIssueSchema, UpstreamIssueDecisionSchema } from '../src/upstream-issues.mjs';
import { PlanRowCorrectionSchema } from '../src/plan-row-corrections.mjs';
import { PhaseAppealSchema } from '../src/phase-appeals.mjs';
import { FindingDisputePacketSchema } from '../src/phase-finding-dispute-schema.mjs';
import { sourceReviewReportSchema, validateSourceReviewReport } from '../src/source-review-contract.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const HASH = '0123456789abcdef'.repeat(4);

test('a copying slip is told apart from a real change', () => {
  for (const [given, expected] of [[HASH.slice(0, 40), HASH], [`${HASH.slice(0, 12)}…${HASH.slice(-4)}`, HASH], [`${HASH.slice(0, 20)}...`, HASH],
    [HASH.toUpperCase(), HASH], [`sha256:${HASH}`, HASH], [HASH, `sha256:${HASH}`], [`${HASH.slice(0, 8)}34${HASH.slice(8)}`, HASH],
    [`"sha256:${HASH}"`, `sha256:${HASH}`], ['2', 2], ['code:src:App.tset.jsx', 'code:src:App.test.jsx']]) {
    assert.equal(copySlip(given, expected), 'slip', `${given} for ${expected}`);
  }
  for (const [given, expected] of [['f'.repeat(64), HASH], [HASH.slice(0, 11), HASH], ['d2', 'd1'], ['S1', 'S2'], [undefined, HASH], ['', HASH], [1, 2]]) {
    assert.equal(copySlip(given, expected), 'different', `${given} for ${expected}`);
  }
  assert.equal(copySlip(HASH, HASH), 'exact');
});

test('a near miss of a known value names the one meant; otherwise the choices', () => {
  const sources = ['code:src:App.jsx', 'code:src:App.test.jsx'];
  assert.deepEqual(nearestKnown('code:src/App.test.jsx', sources), { value: 'code:src:App.test.jsx' });
  assert.deepEqual(nearestKnown('code:App.test.jsx', sources), { value: 'code:src:App.test.jsx' });
  assert.deepEqual(nearestKnown('REQ-001', ['W:REQ-001', 'W:REQ-002']), { value: 'W:REQ-001' });
  assert.deepEqual(nearestKnown('w:req-002', ['W:REQ-001', 'W:REQ-002']), { value: 'W:REQ-002' });
  assert.deepEqual(nearestKnown('nothing', sources), { allowed: sources, more: 0 });
  assert.deepEqual(nearestKnown('Q-l', ['Q-1'], { single: true }), { value: 'Q-1' }, 'the one value left is the one meant');
  assert.deepEqual(nearestKnown('d3', ['d1', 'd2']), { allowed: ['d1', 'd2'], more: 0 }, 'short IDs are never guessed');
});

test('a copied confirmation: a slip is MISTYPED with the exact value; a real change keeps its code and carries the value', () => {
  const thrown = (given) => {
    try { assertConfirmation(given, `sha256:${HASH}`, { code: 'PHASE_APPEAL_STALE', message: 'Confirm the exact current packet.',
      fail: (message, code, details) => { throw new SingularityFlowError(message, { code, details }); } }); }
    catch (error) { return refusalEnvelope(error, ['appeal', 'submit']).error; }
    return null;
  };
  assert.equal(thrown(`sha256:${HASH}`), null);
  const slip = thrown(`sha256:${HASH.slice(0, 30)}`);
  assert.equal(slip.code, 'PHASE_APPEAL_MISTYPED');
  assert.match(slip.message, new RegExp(`copying slip of the current value; nothing changed\\. Use --confirm sha256:${HASH} exactly`, 'u'));
  assert.deepEqual(slip.details.confirmation, { expected: `sha256:${HASH}`, given: `sha256:${HASH.slice(0, 30)}`, slip: true });
  const changed = thrown(`sha256:${'f'.repeat(64)}`);
  assert.equal(changed.code, 'PHASE_APPEAL_STALE');
  assert.match(changed.message, new RegExp(`^Confirm the exact current packet\\. The current value is sha256:${HASH}\\.$`, 'u'));
  assert.equal(changed.details.confirmation.slip, false);
  assert.equal(thrown(undefined).code, 'PHASE_APPEAL_STALE', 'no confirmation at all is never a slip');
});

/** Values that break each kind of zod check: a wrong type, an empty string, a pattern miss, a wrong choice. */
const MUTATIONS = Object.freeze([undefined, null, 42, '', 'not/an id with spaces', ['x'], { unknownKey: 1 }, true, 'z'.repeat(3000)]);

/** Every agent-authored schema: what the agent sees for each of its fields, mutated every way. */
const SCHEMAS = Object.freeze({
  'source review (specification)': sourceSchema('specification'), 'source review (planning)': sourceSchema('planning'),
  'source review (document)': sourceSchema('document'), 'source review (code)': sourceSchema('code'),
  'upstream issue': UpstreamIssueSchema, 'upstream issue decision': UpstreamIssueDecisionSchema,
  'plan row correction': PlanRowCorrectionSchema, 'phase appeal': PhaseAppealSchema, 'finding dispute': FindingDisputePacketSchema
});
function sourceSchema(kind) {
  // The validator's own schema, rebuilt from the JSON schema it publishes would differ; validate through it instead.
  return { kind, sourceReview: true };
}

function issuesFor(schema, value) {
  if (schema.sourceReview) return validateSourceReviewReport(value, schema.kind, { known: () => [] }).findings;
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : agentInputIssues(parsed.error.issues, value, { schema });
}
function keysOf(schema) {
  if (schema.sourceReview) return Object.keys(sourceReviewReportSchema(schema.kind).properties);
  return Object.keys(schema._zod.def.shape ?? schema._zod.def.in?._zod?.def?.shape ?? {});
}

test('every field of every agent-authored schema, mutated every way, is refused in words with its field', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    let checked = 0;
    for (const key of keysOf(schema)) {
      for (const mutation of MUTATIONS) {
        const value = { [key]: mutation, extraField: 'x', rows: [{ outcome: 'covered', id: 'a b', sourceId: 'x/y', unknown: 1 }], findings: [{ severity: 'major', explanation: 'x' }] };
        for (const entry of issuesFor(schema, value)) {
          checked += 1;
          assert.doesNotMatch(entry.message, /^Invalid input$|^Invalid input:|must match pattern \//u, `${name} ${key}=${JSON.stringify(mutation)?.slice(0, 40)}: ${entry.message}`);
          assert.ok(typeof entry.field === 'string' && entry.field.length, `${name}: a field is named`);
          assert.ok(entry.message.includes(entry.field.split('.')[0].replace(/\[\d+\]$/u, '')) || entry.message.startsWith('The packet'),
            `${name}: the message names its field (${entry.field}): ${entry.message}`);
        }
      }
    }
    assert.ok(checked > 0, `${name} produced issues to check`);
  }
});

test('a near miss of a known value carries the exact value, and refusalDetails keeps it', () => {
  const schema = z.strictObject({ phase: z.string().regex(/^[a-z][a-z-]{0,31}$/u), clauseId: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}:[A-Z]{2,4}-\d{3}$/u) });
  const value = { phase: 'Specification', clauseId: 'REQ-001', note: 'x' };
  const findings = agentInputIssues(schema.safeParse(value).error.issues, value, { schema, known: [
    { field: /^phase$/u, values: ['specification', 'planning'], what: 'a step of this Story' },
    { field: /^clauseId$/u, values: ['PAY-1:REQ-001', 'PAY-1:REQ-002'], what: 'an approved clause' }] });
  const by = Object.fromEntries(findings.map((entry) => [entry.field, entry]));
  assert.deepEqual(by.phase.proposedEdit, { field: 'phase', value: 'specification' });
  assert.deepEqual(by.clauseId.proposedEdit, { field: 'clauseId', value: 'PAY-1:REQ-001' });
  assert.deepEqual(by.note.allowed, ['phase', 'clauseId']);
  const details = refusalEnvelope(new SingularityFlowError('Refused.', { code: 'X_INVALID', details: { findings } }), ['x']).error.details;
  assert.deepEqual(details.findings.map((entry) => entry.proposedEdit ?? entry.allowed), [by.phase.proposedEdit, by.clauseId.proposedEdit, ['phase', 'clauseId']]);
  // Only plain values cross the boundary.
  const unsafe = refusalEnvelope(new SingularityFlowError('Refused.', { code: 'X_INVALID', details: { findings: [
    { field: 'a', message: 'm', proposedEdit: { field: 'a', value: '$(rm -rf /)' }, allowed: ['ok', '<script>'] }] } }), ['x']).error.details;
  assert.equal(unsafe.findings[0].proposedEdit, undefined);
  assert.deepEqual(unsafe.findings[0].allowed, ['ok']);
});

// Files whose --confirm an agent feeds: each comparison goes through assertConfirmation, so a slip is told
// apart from a real change and the current value always travels with the refusal.
const AGENT_FED = Object.freeze(['src/phase-appeals.mjs', 'src/phase-continuation-runtime.mjs', 'src/phase-evidence-amendment.mjs',
  'src/workflow-task-store.mjs', 'src/phase-repair-journal.mjs', 'src/phase-repair-runtime.mjs', 'src/scope/decisions.mjs',
  'src/commands/decisions.mjs', 'src/approval-decisions.mjs', 'src/source-review-decision.mjs', 'src/story-baseline-admission.mjs']);
// A comparison of two values SFlow computed, or a gate in front of assertConfirmation, is not a copied value.
const COMPUTED = Object.freeze([
  ['src/phase-repair-runtime.mjs', '(await preview(current, dependencies)).confirmation !== plan.confirmation'],
  ['src/commands/decisions.mjs', "if (confirm && confirm !== packet.packetSha256 && (DIGEST.test(confirm) || copySlip(confirm, packet.packetSha256) === 'slip')) changedList"],
  ['src/scope/decisions.mjs', 'if (confirm !== inventory.inventorySha256) {'],
  ['src/story-baseline-admission.mjs', 'fresh.preview.planDigest !== options.confirmation'],
  ['src/phase-quality-risk.mjs', 'confirm !== digest(record)']
]);
const RAW = /\b(?:options\.)?confirm(?:ation)?\b\s*!==|!==\s*(?:options\.)?confirm(?:ation)?\b/u;
// What is left elsewhere: setup, workspace and person-only confirmations. It may shrink, never grow.
const REMAINING_CEILING = 116;

async function sourceFiles(directory) {
  const entries = await readdir(path.join(ROOT, directory), { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => (entry.isDirectory() ? sourceFiles(path.join(directory, entry.name))
    : entry.name.endsWith('.mjs') ? [path.join(directory, entry.name)] : [])));
  return files.flat();
}

test('every --confirm an agent feeds goes through assertConfirmation; the rest may only shrink', async () => {
  let remaining = 0;
  for (const file of await sourceFiles('src')) {
    if (file === path.join('src', 'records.mjs')) continue;
    const lines = (await readFile(path.join(ROOT, file), 'utf8')).split('\n');
    for (const line of lines) {
      if (!RAW.test(line) || COMPUTED.some(([at, text]) => at === file.split(path.sep).join('/') && line.includes(text))) continue;
      assert.ok(!AGENT_FED.includes(file.split(path.sep).join('/')), `${file} compares a copied confirmation without assertConfirmation: ${line.trim()}`);
      remaining += 1;
    }
  }
  assert.ok(remaining <= REMAINING_CEILING, `raw confirmation comparisons grew to ${remaining} (ceiling ${REMAINING_CEILING}); use assertConfirmation`);
});

test('refusals that know the fix say it: steps, clauses, paths, patches and citations', async () => {
  const { raiseUpstreamIssue } = await import('../src/upstream-issues.mjs');
  const workflow = { currentPhase: 'implement', phaseOrder: ['specification', 'planning', 'implement'], workItem: { id: 'W-1' },
    phases: { specification: { generation: 1, status: 'approved', approvalPolicy: { authorities: ['product'] }, artifacts: [] },
      planning: { generation: 1, status: 'approved', approvalPolicy: { authorities: ['eng'] }, artifacts: [] }, implement: { generation: 1, status: 'in_progress' } } };
  const raise = (fields) => raiseUpstreamIssue(structuredClone(workflow), { about: 'W-1:REQ-001', problem: 'The plan names no test for the refund path.',
    raisedBy: 'agent', authored: 'governed-agent', agent: 'sflow-coder', at: '2026-11-11T10:00:00.000Z', ...fields });
  // Before: "spec is not a step of this Story." with nothing to choose from.
  assert.throws(() => raise({ phase: 'spec' }), (error) => /spec is not a step of this Story; use specification exactly/u.test(error.message));
  assert.throws(() => raise({ phase: 'specification', problem: 'Too short.', proposed: 'fix' }), (error) => {
    // Every problem at once, each in words: one per round spent the repair budget a field at a time.
    assert.match(error.message, /problem has 10 characters; it needs at least 20/u);
    assert.match(error.message, /proposed is 'fix'; use one of: 'plan-correction', 'amend', 'return', 'accept-risk', 'unknown'/u);
    return true;
  });

  const { normalizeClaimMap } = await import('../src/specifications.mjs');
  assert.throws(() => normalizeClaimMap({ claims: { 'REQ-001': { expectedPaths: ['src/a.js'], tests: ['test/a.test.js'] } } },
    { kind: 'planned', clauseIds: ['W-1:REQ-001', 'W-1:REQ-002'] }), /references unknown clause REQ-001\. Cite only clauses this Story defines; use W-1:REQ-001 exactly/u);

  const { pathProblem } = await import('../src/plan-row-corrections.mjs');
  assert.match(pathProblem('/src/a.js'), /absolute/u);
  assert.match(pathProblem('./src/a.js'), /without \.\/ or \.\.\//u);
  assert.match(pathProblem('src\\a.js'), /separate folders with \//u);
  assert.match(pathProblem('src/*.js'), /a pattern/u);
  assert.equal(pathProblem('src/a.js'), null);

  const { applyFocusedEdits } = await import('../src/spec-library/proposals.mjs');
  const spec = '# Spec\n\nThe user can   convert “units”.\nThe user can save.\n';
  assert.throws(() => applyFocusedEdits(spec, [{ before: 'The user can save.', after: 'The user can store.' }, { before: 'The user can convert "units".', after: 'x' }]),
    (error) => error.code === 'SPEC_PROPOSAL_STALE' && /Change 2: its before text is not in the draft; draft line 3 nearly matches it \(spacing or quotes differ\)/u.test(error.message));
  assert.throws(() => applyFocusedEdits('same same', [{ before: 'same', after: 'new' }]), /Change 1: its before text occurs 2 times in the draft/u);
});

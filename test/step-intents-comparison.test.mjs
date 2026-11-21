/**
 * Report-only golden (step intents spec, Stage 0; Appendix B as a test): what every shipped step's intent would derive
 * under the current profile and the workflow rules, against the settings the shipped workflow resolves to today.
 *
 * It reports the differences and never fails on them: they are the owner's decisions G1–G7 (spec §4.4), adopted one at
 * a time later, each with its own golden update. The report is test/fixtures/step-intents-comparison.md. When it is
 * stale the test says so and still passes; SINGULARITY_FLOW_GOLDEN_WRITE=1 writes it again, and its diff shows what moved.
 *
 * What fails: a shipped step without a known intent in PACKAGED_STEP_INTENTS that the comparison needs, a derivation
 * that throws, or a comparison that compared nothing.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { approvesAutomatically, automaticApprovalHeldBy } from '../src/approval-authority.mjs';
import { deterministicOnlyGeneration, phaseRequiresCodeDelivery } from '../src/code-delivery-policy.mjs';
import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { isConvergencePhase } from '../src/phase-roles.mjs';
import { stepsHeldByDecisions } from '../src/step-intent-settings.mjs';
import { CURRENT_INTENT_PROFILE, deriveWorkflowSettings, PACKAGED_STEP_INTENTS, STEP_INTENTS } from '../src/step-intents.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'test/fixtures/step-intents-comparison.md');

const todayApproval = (approval) => (approval?.mode === 'none' ? 'none' : approval?.mode === 'policy' ? 'low-risk waiver'
  : approvesAutomatically(approval) ? 'SFlow when clean' : 'a person');
const derivedApproval = (approval) => (approval.by === 'person' ? 'a person' : 'SFlow when clean');
const yesNo = (value) => (value ? 'yes' : 'no');

/** One shipped work type: each step's today and derived settings, and the differences between them. */
function compareWorkType(raw, definition, id) {
  const type = raw.workTypes[id];
  const resolved = resolveWorkType(definition, id);
  const missing = resolved.phases.filter((phase) => !Object.hasOwn(PACKAGED_STEP_INTENTS, phase.id)).map((phase) => phase.id);
  if (missing.length) return { id, missing, rows: [] };
  // As the workflow has each step: whether it changes source, is a code step and is built by SFlow (kept overrides).
  const steps = resolved.phases.map((phase) => ({
    id: phase.id, intent: PACKAGED_STEP_INTENTS[phase.id], editsSource: phase.writeScope === 'source-and-artifact',
    codeStep: phaseRequiresCodeDelivery(phase), builtBySflow: deterministicOnlyGeneration(phase)
  }));
  const heldForPerson = Object.fromEntries(resolved.phases.flatMap((phase) => {
    if (isConvergencePhase(phase)) return [[phase.id, 'only a person moves the Story on from convergence (safety rule)']];
    const held = phase.approval?.mode === 'required' ? automaticApprovalHeldBy({ ...phase.approval, allowSelfApproval: true }) : null;
    return held ? [[phase.id, held]] : [];
  }));
  const { facts, steps: derived } = deriveWorkflowSettings(steps, {
    omitsScope: (type.omits ?? []).some((entry) => entry?.responsibility === 'scope'),
    decisionsAfter: stepsHeldByDecisions(resolved.decisions, resolved.phases.map((phase) => phase.id)),
    loopSources: (resolved.reworkLoops ?? []).map((entry) => entry.from),
    designCaptureStep: type.designSources ? type.designSources.capturePhase ?? 'design-intake' : null,
    screenProfiles: (resolved.verification?.profiles ?? []).length > 0,
    heldForPerson
  });
  const clauses = new Set(resolved.plannedClaims?.mode === 'required' ? resolved.plannedClaims.clausePhases ?? [] : []);
  const owners = resolved.plannedClaims?.mode === 'required' ? resolved.plannedClaims.owners ?? {} : {};
  const documents = new Set(resolved.documents?.allowedPhases ?? []);
  // A work type's own list of steps that take attached documents is kept as it is written (spec Appendix B); one that
  // says why it differs from the intents is a kept difference (G7 since Stage 4), compared as one.
  const ownDocuments = Array.isArray(type.documents?.allowedPhases) && !type.because?.['documents.allowedPhases'];
  const rows = resolved.phases.map((phase, index) => {
    const step = steps[index];
    const next = derived[index];
    const compared = [
      ['approval', todayApproval(phase.approval), derivedApproval(next.approval)],
      ['questions', phase.clarification?.mode ?? 'off', next.clarification.mode],
      ['changes source', yesNo(phase.writeScope === 'source-and-artifact'), yesNo(next.writeScope === 'source-and-artifact')],
      ['code step', yesNo(phaseRequiresCodeDelivery(phase)), yesNo(next.generationTask === 'code')],
      ['writes requirement IDs', yesNo(clauses.has(phase.id)), yesNo(next.writesRequirementIds)],
      ...(Object.hasOwn(owners, phase.id) || Object.hasOwn(facts.plannedClaimOwners, phase.id)
        ? [['planned by', owners[phase.id] ?? 'nobody', facts.plannedClaimOwners[phase.id] ?? 'nobody']] : []),
      ['repository tests', phase.repositoryTests ?? 'off', next.repositoryTests],
      ['cites test results of', phase.testEvidenceFrom ?? 'nothing', next.testEvidenceFrom ?? 'nothing'],
      ['attached documents', yesNo(documents.has(phase.id)), yesNo(ownDocuments ? documents.has(phase.id) : next.attachedDocuments)]
    ];
    const differences = compared.filter(([, before, after]) => before !== after);
    const notes = ownDocuments && documents.has(phase.id) !== next.attachedDocuments
      ? [`attached documents: the workflow's own list is kept (${yesNo(documents.has(phase.id))}; the intent gives ${yesNo(next.attachedDocuments)})`] : [];
    const groups = new Set(differences.map(([setting]) => {
      if (setting === 'approval' && step.builtBySflow) return 'G3';
      if (['approval', 'changes source'].includes(setting) && step.intent === 'test') return 'G1';
      return { approval: 'G2', questions: 'G4', 'repository tests': 'G5', 'writes requirement IDs': 'G6', 'attached documents': 'G7',
        'code step': 'kept override', 'planned by': 'planner', 'cites test results of': 'cited results' }[setting] ?? 'other';
    }));
    if (step.builtBySflow) groups.add('G3');
    return {
      step: phase.id, intent: step.intent, builtBySflow: step.builtBySflow,
      differences: differences.map(([setting, before, after]) => `${setting}: ${before} → ${after}`), notes,
      groups: [...groups].sort(),
      kind: (phase.artifact?.kind ?? null) === next.artifactKind ? null : `${phase.artifact?.kind ?? 'none'} → ${next.artifactKind}`
    };
  });
  return { id, missing: [], rows };
}

function report(compared) {
  const rows = compared.flatMap((entry) => entry.rows.map((row) => ({ workType: entry.id, ...row })));
  const same = rows.filter((row) => !row.differences.length && !row.builtBySflow).length;
  const byGroup = new Map();
  for (const row of rows) for (const group of row.groups) byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
  const lines = [
    '# Shipped steps: today\'s settings against what their intents derive',
    '',
    `Generated by test/step-intents-comparison.test.mjs (profile ${CURRENT_INTENT_PROFILE}); a report, never a gate. `
      + 'Write it again with SINGULARITY_FLOW_GOLDEN_WRITE=1. Groups are the step intents spec\'s §4.4.',
    '',
    `${rows.length} shipped steps in ${compared.filter((entry) => entry.rows.length).length} workflows: ${same} derive today's settings, `
      + `${rows.length - same} differ.`,
    '',
    `By group: ${[...byGroup].sort(([left], [right]) => left.localeCompare(right)).map(([group, count]) => `${group} ${count}`).join(', ')}.`,
    ''
  ];
  const missing = compared.filter((entry) => entry.missing.length);
  if (missing.length) {
    lines.push('Not compared, a shipped step has no intent yet:', ...missing.map((entry) => `- ${entry.id}: ${entry.missing.join(', ')}`), '');
  }
  lines.push('| Work type | Step | Intent | Differences (today → derived) | Group |', '|---|---|---|---|---|');
  for (const row of rows) {
    const built = row.builtBySflow ? ['built by SFlow: kept as shipped'] : [];
    lines.push(`| ${row.workType} | ${row.step} | ${row.intent} | ${[...row.differences, ...built, ...row.notes].join('; ')} | ${row.groups.join(', ')} |`);
  }
  const kinds = rows.filter((row) => row.kind);
  lines.push('', '## Output kinds (not compared above: Stage 4 keeps each shipped kind as written)', '',
    ...kinds.map((row) => `- ${row.workType} / ${row.step} (${row.intent}): ${row.kind}`), '');
  return { text: lines.join('\n'), rows, same };
}

test('the shipped workflows against what their intents derive: reported, never failed on', async (t) => {
  const raw = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
  const definition = validateDefinition(structuredClone(raw));
  for (const intent of Object.values(PACKAGED_STEP_INTENTS)) assert.ok(STEP_INTENTS.includes(intent), intent);
  const compared = Object.keys(raw.workTypes).map((id) => compareWorkType(raw, definition, id));
  const { text, rows, same } = report(compared);
  assert.ok(rows.length > 0, 'the comparison compared some shipped steps');
  t.diagnostic(`${rows.length} shipped steps: ${same} derive today's settings, ${rows.length - same} differ`);
  for (const entry of compared.filter((item) => item.missing.length)) {
    t.diagnostic(`not compared: ${entry.id} has steps with no packaged intent (${entry.missing.join(', ')}); add them to PACKAGED_STEP_INTENTS`);
  }
  if (process.env.SINGULARITY_FLOW_GOLDEN_WRITE === '1') {
    writeFileSync(FIXTURE, text);
    return;
  }
  let recorded = null;
  try { recorded = readFileSync(FIXTURE, 'utf8'); } catch { recorded = null; }
  if (recorded !== text) {
    t.diagnostic('test/fixtures/step-intents-comparison.md is not today\'s comparison. It is a report, so this passes; '
      + 'write it again with SINGULARITY_FLOW_GOLDEN_WRITE=1 and read its diff.');
  }
});

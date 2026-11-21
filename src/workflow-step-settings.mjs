/**
 * `workflow check <WORKFLOW> --settings` (step intents spec §7.4): every framework setting of each step as the
 * workflow resolves it, and where each one came from:
 * - override: the workflow's own `phaseOverrides` for the step;
 * - shared-step: the step's own setting under `phases:`;
 * - intent: the step's intent profile;
 * - workflow-rule: a rule that depends on the other steps (who writes the requirement IDs, which step is the plan,
 *   the one step that asks every time, the code step's results a later step cites);
 * - safety-rule: an SFlow rule nothing overrides (a step that changes source files is a person's to approve);
 * - default: SFlow's default, in a workflow that derives nothing from intents.
 * A setting a step or workflow changes from its intent carries its `because:` reason.
 *
 * Read only: it reports what resolveWorkType gave and what the derivation (step-intent-settings.mjs) says about
 * where each value came from; nothing here changes a setting.
 */
import { approvesAutomatically, automaticApprovalHeldBy } from './approval-authority.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { deriveWorkTypeSettings, workTypeDerivesIntents, workTypeIntentSteps, INTENTS_FILE_VERSION } from './step-intent-settings.mjs';

export const SETTING_SOURCES = Object.freeze(['override', 'shared-step', 'intent', 'workflow-rule', 'safety-rule', 'default']);

const isMapping = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const at = (value, path) => path.reduce((node, key) => (isMapping(node) && Object.hasOwn(node, key) ? node[key] : undefined), value);
const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Where a setting of a workflow that derives nothing came from: its override, the step itself, or SFlow's default. */
function writtenSource(raw, workflowId, stepId, path) {
  const override = raw?.workTypes?.[workflowId]?.phaseOverrides?.[stepId];
  const top = override?.[path[0]];
  if (top !== undefined && (path.length === 1 || typeof top === 'string' || at(override, path) !== undefined)) return 'override';
  const shared = raw?.phases?.[stepId];
  const own = shared?.[path[0]];
  if (own !== undefined && (path.length === 1 || typeof own === 'string' || at(shared, path) !== undefined)) return 'shared-step';
  return 'default';
}

/** Who approves the resolved step, in words, and the rule that holds it with a person at run time, if one does. */
function approvalWords(approval) {
  if (approval?.mode === 'none') return { value: 'none', words: 'nobody: it needs no approval' };
  if (approval?.mode === 'policy') return { value: 'policy', words: `the ${approval.policy ?? 'configured'} policy, or a person when it does not apply` };
  if (approvesAutomatically(approval)) return { value: 'sflow-when-clean', words: 'SFlow, when it is clean' };
  const held = approval?.automatic ? automaticApprovalHeldBy(approval) : null;
  return { value: 'person', words: 'a person', ...(held ? { held } : {}) };
}

/**
 * The settings report of one workflow: `{ derives, profile, why?, steps: [{ id, label, intent, settings }], workflow }`.
 * `resolved` is its resolveWorkType result, `raw` workflow.yml as written, `intents` its Stage 1 intents
 * (`workflow check`'s per-step intent with confidence and source), `groups` the approval group labels by ID.
 */
export function workflowSettingsReport(definition, raw, workflowId, { resolved, intents = [], groups = new Map() } = {}) {
  const workType = definition?.workTypes?.[workflowId];
  const derives = workTypeDerivesIntents(definition, workType);
  let derivation = null;
  if (derives && resolved) {
    try { derivation = deriveWorkTypeSettings(definition, workflowId, { profile: resolved.phases?.[0]?.intentProfile ?? null }); } catch { derivation = null; }
  }
  const stepsWithIntent = workTypeIntentSteps(definition, workType);
  const why = derives ? null
    : !stepsWithIntent.some((step) => step.intent) ? 'its steps have no intent'
      : stepsWithIntent.some((step) => !step.intent) ? `not every step has an intent (${listed(stepsWithIntent.filter((step) => !step.intent).map((step) => step.label))} ${stepsWithIntent.filter((step) => !step.intent).length === 1 ? 'has' : 'have'} none)`
        : `workflow.yml is version ${definition?.version}, and SFlow derives settings from intents only in version ${INTENTS_FILE_VERSION}`;
  const labelOf = (id) => resolved?.phases?.find((phase) => phase.id === id)?.label ?? id;
  const groupLabel = (id) => groups.get(id) ?? id;
  const intentOf = new Map(intents.map((entry) => [entry.step, entry]));
  const documents = new Set(resolved?.documents?.allowedPhases ?? []);

  const steps = (resolved?.phases ?? []).map((phase, index) => {
    const derived = derivation?.steps[index] ?? null;
    const from = (key, path = key.split('.')) => {
      if (derived?.sources?.[key]) return derived.sources[key];
      return { from: writtenSource(raw, workflowId, phase.id, path) };
    };
    const reasonOf = (key) => {
      const because = derived?.because ?? raw?.phases?.[phase.id]?.because ?? null;
      return isMapping(because) ? because[key] ?? because[key.split('.')[0]] ?? null : null;
    };
    const setting = (key, value, words, source = from(key)) => {
      const reason = source.reason ?? (['override', 'shared-step'].includes(source.from) ? reasonOf(key) : null);
      return { key, value, words, from: source.from, ...(reason ? { reason } : {}) };
    };
    const approval = approvalWords(phase.approval);
    const approvalSource = derived?.sources?.approval ?? { from: writtenSource(raw, workflowId, phase.id, ['approval']) };
    const clarification = phase.clarification ?? { mode: 'off', maxQuestions: 5 };
    const entry = intentOf.get(phase.id);
    return {
      id: phase.id, label: phase.label ?? phase.id,
      intent: entry ? { value: entry.intent, confidence: entry.confidence, source: entry.source } : null,
      settings: [
        setting('writeScope', phase.writeScope ?? 'artifact-only', (phase.writeScope ?? 'artifact-only') === 'source-and-artifact' ? 'yes' : 'no'),
        setting('generation.task', phaseRequiresCodeDelivery(phase) ? 'code' : phase.generation?.task ?? null, phaseRequiresCodeDelivery(phase) ? 'yes' : 'no'),
        setting('artifact.kind', phase.artifact?.kind ?? null, phase.artifact?.kind ?? 'nothing SFlow recognises'),
        setting('clarification.mode', clarification.mode, clarification.mode === 'off' ? 'never asks'
          : `${clarification.mode === 'required' ? 'asks every time' : 'asks when needed'}, up to ${clarification.maxQuestions}`),
        setting('approval', approval.value, approval.held ? `${approval.words} (${approval.held})` : approval.words,
          approval.held && approvalSource.from === 'intent' ? { from: 'safety-rule', reason: approval.held } : approvalSource),
        setting('approval.authorities', phase.approval?.authorities ?? [], (phase.approval?.authorities ?? []).map(groupLabel).join(', ') || 'nobody'),
        setting('approval.rejectTo', phase.approval?.rejectTo ?? [], (phase.approval?.rejectTo ?? []).map((id) => (id === phase.id ? 'itself' : labelOf(id))).join(', ') || 'nowhere'),
        setting('repositoryTests', phase.repositoryTests ?? 'off', phase.repositoryTests === 'run' ? 'yes' : 'no'),
        setting('testEvidenceFrom', phase.testEvidenceFrom ?? null, phase.testEvidenceFrom ? labelOf(phase.testEvidenceFrom) : 'nothing'),
        setting('inputs', (phase.inputs ?? []).map((input) => input.phase), (phase.inputs ?? []).map((input) => labelOf(input.phase)).join(', ') || 'nothing'),
        setting('documents', documents.has(phase.id), documents.has(phase.id) ? 'yes' : 'no',
          derivation?.workType.sources['documents.allowedPhases'] ?? { from: raw?.workTypes?.[workflowId]?.documents?.allowedPhases ? 'override' : 'default' })
      ]
    };
  });

  const claims = resolved?.plannedClaims ?? null;
  const workflowSource = (key) => derivation?.workType.sources[key]
    ?? { from: at(raw, ['workTypes', workflowId, ...key.split('.')]) !== undefined ? 'override' : 'default' };
  const claimed = claims?.mode === 'required';
  const workflowSettings = [
    { key: 'plannedClaims.clausePhases', value: claimed ? claims.clausePhases : [],
      words: claimed ? listed(claims.clausePhases.map(labelOf)) : claims?.mode === 'disabled' ? 'none: no step changes code, so no IDs are pinned' : 'none', ...workflowSource('plannedClaims.clausePhases') },
    { key: 'plannedClaims.owners', value: claimed ? claims.owners : {},
      words: claimed ? Object.entries(claims.owners).map(([code, owner]) => `${labelOf(code)} is planned in ${labelOf(owner)}`).join('; ') || 'none' : 'none', ...workflowSource('plannedClaims.owners') },
    ...((derivation?.workType.omits ?? (Array.isArray(workType?.omits) ? workType.omits : [])).map((entry, index) => ({
      key: `omits.${entry.responsibility}`, value: entry, words: `${entry.responsibility} is left out: ${entry.reason}`,
      ...(derivation?.workType.omitSources[index] ? { from: derivation.workType.omitSources[index].from } : { from: 'override' }),
      ...(derivation?.workType.omitSources[index]?.reason ? { reason: derivation.workType.omitSources[index].reason } : {})
    })))
  ];
  return { derives, profile: derivation?.profile ?? null, ...(why ? { why } : {}), steps, workflow: workflowSettings };
}

const FROM_WORDS = Object.freeze({
  override: 'this workflow\'s override', 'shared-step': 'the step\'s own setting', intent: 'its intent',
  'workflow-rule': 'workflow rule', 'safety-rule': 'SFlow rule', default: 'SFlow\'s default'
});
const SETTING_WORDS = Object.freeze({
  writeScope: 'Changes source files', 'generation.task': 'Code step', 'artifact.kind': 'Recognised as', 'clarification.mode': 'Questions',
  approval: 'Approval', 'approval.authorities': 'Approvers', 'approval.rejectTo': 'Can be sent back to', repositoryTests: 'Repository tests at submit',
  testEvidenceFrom: 'Cites the test results of', inputs: 'Reads', documents: 'Takes attached documents',
  'plannedClaims.clausePhases': 'Requirement IDs written by', 'plannedClaims.owners': 'Plans'
});

/** The settings report as lines a person reads. */
export function settingsReportLines(report) {
  const lines = [report.derives ? `  Settings: derived from each step's intent, what the step is for (profile ${report.profile}).`
    : `  Settings: as written; none is derived, because ${report.why}.`];
  const line = (entry) => {
    const name = SETTING_WORDS[entry.key] ?? (entry.key.startsWith('omits.') ? 'Left out' : entry.key);
    const source = FROM_WORDS[entry.from] ?? entry.from;
    return `${name}: ${entry.words} (${source}${entry.reason ? `: ${entry.reason}` : ''})`;
  };
  for (const [index, step] of report.steps.entries()) {
    const intent = step.intent ? `: ${step.intent.value}${step.intent.source === 'declared' ? ', as workflow.yml says' : ` (${step.intent.confidence}, from its ${step.intent.source})`}` : '';
    lines.push(`  ${index + 1}. ${step.label}${intent}`);
    for (const entry of step.settings) lines.push(`     ${line(entry)}`);
  }
  if (report.workflow.length) {
    lines.push('  The workflow:');
    for (const entry of report.workflow) lines.push(`     ${line(entry)}`);
  }
  return lines;
}

/**
 * What a brand-new step is made of. Workflow Studio's blank step and a new step in workflow markup
 * share this one definition, so a workflow designed from a description gets the same steps a person
 * would add by hand, without copying any existing workflow.
 *
 * A new step that says what it is for (its intent, step intents spec §3, Stage 3) starts from that intent: the intent
 * decides what SFlow recognises its output as, so it writes no artifact kind of its own (the blank step's kind, its own
 * ID, is refused on a test step), and its starter template is the intent's (common/requirements.md and the rest). A code
 * step still says it is one (task code, changes source), so it is the same step in a workflow that does not derive yet.
 * Imports only the import-free phase-roles.mjs, so markup and Workflow Studio's page can use it.
 */
import { STEP_INTENTS } from './phase-roles.mjs';

/** What a step makes, in the words the Studio shows; each maps to the engine's generation contract. */
export const STEP_OUTPUTS = Object.freeze([
  Object.freeze({ id: 'document', label: 'A document' }),
  Object.freeze({ id: 'analysis', label: 'An analysis' }),
  Object.freeze({ id: 'code', label: 'Code changes and a summary' }),
  Object.freeze({ id: 'none', label: 'Nothing (sign-off only)' })
]);

/**
 * The answers to "What does this step do?", one per step intent, in the words Workflow Studio and the Builder ask
 * with. `template` is the intent's starter template (the profile's, step-intent-settings.mjs PROFILE_V1).
 */
export const STEP_INTENT_CHOICES = Object.freeze([
  { id: 'intake', label: 'Captures the request', detail: 'what is wanted, why, and what is out of scope, in the requester\'s words', template: 'common/intake.md' },
  { id: 'requirements', label: 'Writes the requirements', detail: 'numbered, testable requirements and acceptance criteria that later steps cite', template: 'common/requirements.md' },
  { id: 'design', label: 'Works out how, or investigates', detail: 'architecture and interfaces, reproducing a bug, impact, what exists today', template: 'common/design.md' },
  { id: 'plan', label: 'Plans the change', detail: 'the exact changes and the tests that prove each requirement; a person approves it', template: 'common/plan.md' },
  { id: 'code', label: 'Changes the code', detail: 'changes source and tests and records what changed; a person approves it', template: 'common/implementation.md' },
  { id: 'test', label: 'Runs the tests', detail: 'runs tests against the change or the product and records the results', template: 'common/verification.md' },
  { id: 'review', label: 'Checks the change against every requirement', detail: 'one requirement at a time, after the last code step', template: 'common/conformance.md' },
  { id: 'release', label: 'Prepares the release', detail: 'pull request text, release notes, publication and rollback check', template: 'common/release.md' },
  { id: 'report', label: 'Writes a report for people', detail: 'what happened and what remains', template: 'common/report.md' },
  { id: 'document', label: 'Writes another document', detail: 'a runbook, threat model, docs update or decision record', template: 'common/document.md' }
].map((entry) => Object.freeze(entry)));

/** The intent's choice entry, or null for anything that is not a step intent. */
export function stepIntentChoice(intent) {
  return STEP_INTENTS.includes(intent) ? STEP_INTENT_CHOICES.find((entry) => entry.id === intent) : null;
}

/**
 * A new step's own contract, before its sign-off: its artifact, starter template and write scope. With `intent`, the
 * step starts from that intent: `intent:` is written, no artifact kind (the intent decides it), and a code step says it
 * is one (task code, changes source) so it is the same step in a workflow that does not derive from intents yet.
 */
export function newStepContract(id, label, output = 'document', { intent = null } = {}) {
  if (intent != null) {
    if (!stepIntentChoice(intent)) throw new RangeError(`'${String(intent)}' is not a step intent. Use one of: ${STEP_INTENTS.join(', ')}.`);
    return {
      intent,
      label,
      artifact: { path: `artifacts/${id}/${id}.md`, minimumBytes: 200 },
      defaultTemplate: `common/${id}.md`,
      // Any other step writes only its own document, the engine's default: nothing to say.
      ...(intent === 'code' ? { generation: { task: 'code' }, writeScope: 'source-and-artifact' } : {})
    };
  }
  const node = {
    label,
    artifact: { path: `artifacts/${id}/${id}.md`, kind: id, minimumBytes: 200 },
    defaultTemplate: `common/${id}.md`,
    writeScope: 'artifact-only'
  };
  if (output === 'none') node.generation = { requirement: 'none' };
  if (output === 'analysis') node.generation = { task: 'analyze' };
  if (output === 'code') {
    node.generation = { task: 'code' };
    node.writeScope = 'source-and-artifact';
  }
  return node;
}

/**
 * The starter template a new step's artifact begins from. `starter` is the text of its intent's packaged template,
 * when it has one: the step starts from that, as its own copy.
 */
export function newStepTemplate(id, label, { starter = null } = {}) {
  if (typeof starter === 'string' && starter.trim()) return starter.endsWith('\n') ? starter : `${starter}\n`;
  // Guidance on one line, marked so publication removes it (src/template-guidance.mjs).
  return [`# ${label}`, '', `<!-- sflow:guidance A starter for the ${id} step: write what the step actually has to answer under each heading. The engine checks that the artifact is at least a couple of hundred bytes, not that it is good. -->`, '',
    '## What this step decides', '', '## Evidence', '', '## Open questions', ''].join('\n');
}

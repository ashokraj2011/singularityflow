/**
 * What a brand-new step is made of. Workflow Studio's blank step and a new step in workflow markup
 * share this one definition, so a workflow designed from a description gets the same steps a person
 * would add by hand, without copying any existing workflow.
 */

/** What a step makes, in the words the Studio shows; each maps to the engine's generation contract. */
export const STEP_OUTPUTS = Object.freeze([
  Object.freeze({ id: 'document', label: 'A document' }),
  Object.freeze({ id: 'analysis', label: 'An analysis' }),
  Object.freeze({ id: 'code', label: 'Code changes and a summary' }),
  Object.freeze({ id: 'none', label: 'Nothing (sign-off only)' })
]);

/** A new step's own contract, before its sign-off: its artifact, starter template and write scope. */
export function newStepContract(id, label, output = 'document') {
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

/** The starter template a new step's artifact begins from. */
export function newStepTemplate(id, label) {
  // Guidance on one line, marked so publication removes it (src/template-guidance.mjs).
  return [`# ${label}`, '', `<!-- sflow:guidance A starter for the ${id} step: write what the step actually has to answer under each heading. The engine checks that the artifact is at least a couple of hundred bytes, not that it is good. -->`, '',
    '## What this step decides', '', '## Evidence', '', '## Open questions', ''].join('\n');
}

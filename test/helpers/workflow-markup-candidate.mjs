/** A deterministic inert candidate for the exact selected installed/approved contract. */
export function workflowMarkupCandidate(catalog, workflowId, {
  id = `candidate-${workflowId}`, description = 'Preserve the selected workflow contract.', approvalGroup = null
} = {}) {
  const base = catalog.definition.workTypes[workflowId];
  const escaped = description.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const selected = base.phases.map(phase => catalog.agents.find(agent => agent.defaultFor.includes(phase)));
  if (selected.some(agent => !agent)) throw new Error(`No default agent for candidate contract '${workflowId}'.`);
  const phaseIds = base.phases.map((_, index) => `${id}-step-${index + 1}`);
  const agents = base.phases.map((_, index) => `<agent id="${id}-owner-${index + 1}" from="${selected[index].id}"/>`).join('\n');
  const phases = base.phases.map((phase, index) => {
    const group = approvalGroup?.(phase, index);
    return `<phase id="${phaseIds[index]}" from="${phase}" agent="${id}-owner-${index + 1}">${group
      ? `<approval authority="${group}" on-reject="${phaseIds[Math.max(0, index - 1)]}"/>` : ''}</phase>`;
  }).join('\n');
  return `<workflow version="2" id="${id}" label="Candidate ${workflowId}" extends="${workflowId}" catalog="${catalog.sourceSha256}" catalog-source="${catalog.source.kind === 'installed-package' ? 'installed' : 'approved'}">
    ${agents}${phases}
    <intent family="software-change"><description>${escaped}</description>
      <requirement id="preserve-contract" maps-to="workflow:${id}">Retain the phases, authority and inherited repair limits.</requirement>
      <pattern ref="sequence"/><pattern ref="human-checkpoint"/>
    </intent></workflow>`;
}

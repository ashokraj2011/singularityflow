import { agentPacketPresentation } from './agent-packet-presentation.mjs';

/** Presentation only: never recompute readiness, eligibility or a runnable command. */
export function phaseAgentResult(result) {
  const omitted = [];
  const metadata = (value, location, fields) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => {
      if (!fields.includes(key)) return true;
      omitted.push(`${location}.${key}`);
      return false;
    }));
  };
  const projected = { ...result };
  projected.artifact = metadata(result.artifact, 'artifact', ['preview', 'content', 'text', 'markdown']);
  if (result.artifacts) projected.artifacts = result.artifacts.map((artifact, index) =>
    metadata(artifact, `artifacts[${index}]`, ['preview', 'content', 'text', 'markdown']));
  projected.coverage = metadata(result.coverage, 'coverage', ['entries', 'paths', 'declarations']);
  projected.documentation = metadata(result.documentation, 'documentation', ['declarations', 'inspected']);
  // Findings, resolution choices, repair actions, test plans, hashes and command guards stay whole.
  return { ...agentPacketPresentation(projected), projection: {
    kind: 'agent', omitted,
    fullCommand: `singularity-flow phase ${result.resultType === 'sflow-phase-prepublish' ? 'prepublish' : 'draft-check'} ${result.phase} --json`,
    documentCommand: `singularity-flow phase show ${result.phase} --json`
  } };
}

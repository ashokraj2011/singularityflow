const LEGACY_MILESTONES = Object.freeze({
  build: 'verification',
  construction: 'verification',
  release: 'conformance',
  delivery: 'conformance'
});

function outputIds(phase) {
  const outputs = phase?.outputs;
  return Array.isArray(outputs) ? outputs.map((output) => output?.id) : Object.keys(outputs ?? {});
}

/**
 * The child-Story milestone a step waits for, from what it produces, so a copied or renamed step
 * keeps its gate: conformance for a step producing the Initiative conformance record, verification
 * for one producing the implementation index. Older pins without outputs keep the seeded IDs.
 */
export function requiredInitiativeMilestone(phaseId, initiative = null) {
  const outputs = outputIds(initiative?.phases?.[phaseId]);
  if (outputs.includes('initiative-conformance')) return 'conformance';
  if (outputs.includes('implementation-index')) return 'verification';
  return outputs.length ? null : LEGACY_MILESTONES[phaseId] ?? null;
}

/** Every step of this Initiative that waits for a child-Story milestone, in order. */
export function milestonePhases(initiative) {
  return (initiative?.phaseOrder ?? Object.keys(initiative?.phases ?? {})).filter((id) => requiredInitiativeMilestone(id, initiative));
}

export function initiativeMilestoneReadiness(initiative, phaseId, stories = Object.values(initiative.childStories ?? {})) {
  const blocking = stories.filter((story) => story.blocking);
  const required = requiredInitiativeMilestone(phaseId, initiative);
  const incomplete = required ? blocking.filter((story) => !story.milestones?.[required] || story.stale) : [];
  return {
    phase: phaseId,
    policy: 'allBlocking',
    requiredMilestone: required,
    blockingStories: blocking.length,
    readyStories: blocking.length - incomplete.length,
    ready: incomplete.length === 0,
    incomplete: incomplete.map((story) => ({
      id: story.id,
      repository: story.repository,
      status: story.status,
      currentPhase: story.currentPhase,
      stale: story.stale
    }))
  };
}

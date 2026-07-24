const PHASE_MILESTONES = Object.freeze({
  build: 'verification',
  construction: 'verification',
  release: 'conformance',
  delivery: 'conformance'
});

export function requiredInitiativeMilestone(phaseId) {
  return PHASE_MILESTONES[phaseId] ?? null;
}

export function initiativeMilestoneReadiness(initiative, phaseId, stories = Object.values(initiative.childStories ?? {})) {
  const blocking = stories.filter((story) => story.blocking);
  const required = requiredInitiativeMilestone(phaseId);
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

import { continuationCases } from './continuation-cases.mjs';

/** Every observation is synthetic; no local session or repository is read. */
export function nextPlanCases() {
  const entries = continuationCases().map(entry => {
    const workflow = structuredClone(entry.workflow);
    workflow.workItem.branch = 'feature/example';
    if (workflow.pendingDecision) Object.assign(workflow.pendingDecision, { by: ['reviewers'], reason: 'ask', key: 'pending-key' });
    return { name: entry.name, options: { workflow, sourceReviewEvidence: entry.review,
      modelMode: { enabled: true } } };
  });
  const create = (name, change) => {
    const entry = structuredClone(entries.find(entry => entry.name === 'document-unpublished'));
    entry.name = name; change(entry.options, entry.options.workflow.phases['team-step']); return entry;
  };
  const published = (options, phase) => { phase.generation = 1; options.workflow.resolution.sourceReview.mode = 'off'; };
  entries.push(
    { name: 'uninitialized', options: { initialized: false, branch: 'main' } },
    { name: 'no-story', options: { branch: 'main' } },
    { name: 'requested-story', options: { branch: 'main', requestedWorkId: 'OTHER-1' } },
    create('publication-before-recovery', options => { options.publicationPending = true; options.recovery = { requiresRecovery: true, phaseId: 'team-step' }; }),
    create('recovery-before-authoring', options => { options.recovery = { requiresRecovery: true, phaseId: 'team-step' }; }),
    create('after-step-delivery', options => { options.stepActionHold = { missing: ['delivery'], nextAction: 'singularity-flow integrations status --work-id CONT-1 --all', reason: 'Delivery receipt missing.' }; }),
    create('mcp-readiness', options => { options.mcpHold = { phase: 'team-step', errors: ['missing-host'], actions: [{ command: 'singularity-flow mcp status --json', label: 'Inspect the server' }] }; }),
    create('visual-before-authoring', options => { options.visualCoverageHold = { published: false, reason: 'Capture required evidence.', routes: [{ command: 'singularity-flow recover CONT-1 --json', label: 'Inspect evidence' }] }; }),
    create('visual-before-submit', (options, phase) => { published(options, phase); options.visualCoverageHold = { published: true, reason: 'Capture required evidence.', routes: [{ command: 'singularity-flow recover CONT-1 --json', label: 'Inspect evidence' }] }; }),
    create('pending-decisions', (options, phase) => { published(options, phase); options.pendingDecisions = { count: 2, headline: 'Two decisions remain.', command: 'singularity-flow decisions CONT-1 --json' }; }),
    create('personal-decision', (options, phase) => { published(options, phase); phase.status = 'awaiting_approval'; options.pendingDecisions = { count: 1, personal: true, headline: 'Human decision owed.', lastKind: 'witness', command: 'singularity-flow decision witness --work-id CONT-1' }; }),
    create('approval-holds', (options, phase) => { published(options, phase); phase.status = 'awaiting_approval'; options.approvalCheck = { ready: false, holds: [
      { owner: 'author', who: 'Author', summary: 'Repair the current draft.', action: { command: 'singularity-flow recover CONT-1 --json', label: 'Inspect repair.' } },
      { owner: 'author', who: 'Author', summary: 'Retain evidence.', action: { command: 'singularity-flow recover CONT-1 --json' } },
      { owner: 'you-decide', who: 'Reviewer', summary: 'Decide the criterion.' }] }; }),
    create('step-sheet', (options, phase) => { published(options, phase); phase.status = 'awaiting_approval'; options.sheet = { headline: 'Review current evidence.', holds: [], next: { effect: 'repairs', command: 'singularity-flow recover CONT-1 --json', label: 'Inspect repair', where: { copilot: '/sf-recover' } } }; }),
    create('no-model', options => { options.modelMode = { enabled: false }; }),
    create('human-no-model', (options, phase) => { phase.generationPolicy.defaultProducer = 'human'; options.modelMode = { enabled: false }; }),
    create('prerequisites', options => { options.prerequisites = [{ timing: 'optional', command: 'singularity-flow assign team-step <assignee>', reason: 'Assign coordinator.' }]; }),
    create('enforced-inputs', options => { options.workflow.resolution.inputsMode = 'enforce'; options.workflow.resolution.phases = [{ id: 'team-step', inputs: [{ phase: 'prior' }] }]; }),
    create('closed-direct', (options, phase) => { published(options, phase); options.workflow.currentPhase = null; options.workflow.status = 'closed'; options.workflow.lineage = { branchCompletionPolicy: 'direct', childBranches: ['child'] }; }),
    create('closed-manual-remote', (options, phase) => { published(options, phase); options.workflow.currentPhase = null; options.workflow.status = 'closed'; options.repositoryHost = { provider: 'gitlab', label: 'GitLab' }; })
  );
  return entries;
}

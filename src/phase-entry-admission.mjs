/** Presentation of the existing composition guards, distinct from draft/publication findings. */
export function phaseContextAdmission({ ready = true, authoring = {}, recovery = {},
  references = {}, deterministic = false } = {}) {
  const blockers = [];
  const add = (code, message, details = {}) => blockers.push({ code, message, ...details });
  if (!ready) {
    add('PHASE_CONTEXT_BINDING_REQUIRED', 'Attach the exact Story and its configured phase agent before composition.');
    return { allowed: false, blockers };
  }
  if (authoring.entry?.status !== 'authoring-entry') add('PHASE_CONTEXT_AUTHORING_ENTRY_REQUIRED',
    'Follow the returned preparation, retained-generation or authority route; composition cannot create that boundary.',
    { entryStatus: authoring.entry?.status ?? null, reason: authoring.entry?.reason ?? null });
  if (deterministic) add('PHASE_CONTEXT_DETERMINISTIC', 'This phase uses its deterministic producer, not model composition.');
  if (!authoring.policyVerified) add('PHASE_CONTEXT_POLICY_UNVERIFIED', 'Verify the pinned phase policy before composing context.');
  if (!authoring.effectiveAuthoringSkill) add('PHASE_CONTEXT_AUTHORING_ROUTE_REQUIRED', 'No verified phase-authoring route is available.');
  if (recovery.requiresRecovery) add('PHASE_CONTEXT_RECOVERY_REQUIRED',
    'Complete the returned recovery boundary before composing. Draft quality findings are separate.',
    { actionIds: (recovery.actions ?? []).filter(action => action.automatic || action.mode === 'manual').map(action => action.id) });
  const worktree = (recovery.actions ?? []).find(action => action.id === 'working-tree' && action.confirmation !== 'none');
  if (worktree) add('PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED',
    'The listed worktree changes require human review. A tag/artifact repair or source-only commit does not clear an unexpected evidence file.',
    { actionIds: (recovery.actions ?? []).filter(action => action.id === 'working-tree'
      || action.id?.startsWith('review-evidence-contract:')).map(action => action.id),
    paths: worktree.unexpectedPaths?.length ? worktree.unexpectedPaths : worktree.paths ?? [],
    confirmation: worktree.confirmation });
  if (references.status === 'blocked') add('PHASE_CONTEXT_REFERENCES_BLOCKED', 'Repair the returned reference-repository findings before composition.');
  return { allowed: blockers.length === 0, blockers };
}

/** Show the actual admission remedy before unrelated, repairable draft quality checks. */
export function phaseAdmissionActions(actions, admission, { authoring, recovery } = {}) {
  if (authoring?.entry?.status !== 'authoring-entry' || recovery?.requiresRecovery
      || !admission.blockers.some(item => item.code === 'PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED')) return actions;
  const rank = action => action.id?.startsWith('review-evidence-contract:') ? 0
    : action.id === 'working-tree' ? 1 : action.id === 'commit-reviewed-worktree' ? 3 : 2;
  return [...actions].sort((left, right) => rank(left) - rank(right));
}

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
  if (!authoring.policyVerified) add('PHASE_CONTEXT_POLICY_UNVERIFIED', 'Verify the pinned phase policy before composing context.',
    authoring.policyReason ? { reason: authoring.policyReason } : {});
  if (!authoring.effectiveAuthoringSkill) add('PHASE_CONTEXT_AUTHORING_ROUTE_REQUIRED', 'No verified phase-authoring route is available.');
  if (recovery.requiresRecovery) add('PHASE_CONTEXT_RECOVERY_REQUIRED',
    'Complete the returned recovery boundary before composing. Draft quality findings are separate.',
    { actionIds: (recovery.actions ?? []).filter(action => action.automatic || action.mode === 'manual').map(action => action.id) });
  const worktree = (recovery.actions ?? []).find(action => action.id === 'working-tree' && action.confirmation !== 'none');
  const continuation = worktree?.authoringContinuation;
  const pendingEvidence = continuation?.allowed === true && continuation.status === 'draft-only'
    ? continuation : null;
  if (worktree && !pendingEvidence) add('PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED',
    'The listed worktree changes require human review. A tag/artifact repair or source-only commit does not clear an unexpected evidence file.',
    { actionIds: (recovery.actions ?? []).filter(action => action.id === 'working-tree'
      || action.id === 'set-aside-worktree' || action.id?.startsWith('review-evidence-contract:')).map(action => action.id),
    paths: worktree.unexpectedPaths?.length ? worktree.unexpectedPaths : worktree.paths ?? [],
    confirmation: worktree.confirmation });
  if (references.status === 'blocked') add('PHASE_CONTEXT_REFERENCES_BLOCKED', 'Repair the returned reference-repository findings before composition.');
  // Composition would embed these inputs and refuse on them; refusing admission instead returns the
  // inspect/restore/return plan without a throw. The bytes belong to the earlier phase named.
  const inputs = (recovery.blockers ?? []).filter(blocker => blocker.category === 'inputs');
  if (inputs.length) {
    const upstreamPhases = [...new Set(inputs.map(blocker => blocker.details?.upstreamPhase).filter(Boolean))];
    add('PHASE_CONTEXT_INPUTS_NOT_READY',
      `Approved inputs${upstreamPhases.length ? ` from ${upstreamPhases.join(', ')}` : ''} are not ready. They belong to that earlier phase and must not be edited here: inspect them, restore their exact approved bytes, or use the producer's return or amendment route.`,
      { upstreamPhases,
        findings: inputs.map(blocker => ({ phase: blocker.details?.upstreamPhase ?? null, path: blocker.path ?? null,
          status: blocker.details?.status ?? null, restorable: blocker.details?.restorable === true })),
        actionIds: (recovery.actions ?? []).filter(action => /^(?:resolve|restore)-inputs:/u.test(action.id ?? ''))
          .map(action => action.id) });
  }
  return { allowed: blockers.length === 0, blockers, ...(pendingEvidence ? { pendingEvidence } : {}) };
}

/** Show the actual admission remedy before unrelated, repairable draft quality checks. */
export function phaseAdmissionActions(actions, admission, { authoring, recovery } = {}) {
  // Preparing or authoring cannot succeed on inputs that are not ready; lead with their routes.
  if (!recovery?.requiresRecovery && admission.blockers.some(item => item.code === 'PHASE_CONTEXT_INPUTS_NOT_READY')) {
    const rank = action => action.id?.startsWith('resolve-inputs:') ? 0 : action.id?.startsWith('restore-inputs:') ? 1 : 2;
    return [...actions].sort((left, right) => rank(left) - rank(right));
  }
  if (authoring?.entry?.status !== 'authoring-entry' || recovery?.requiresRecovery
      || !admission.blockers.some(item => item.code === 'PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED')) return actions;
  const rank = action => action.id?.startsWith('review-evidence-contract:') ? 0
    : action.id === 'working-tree' ? 1 : action.id === 'set-aside-worktree' ? 2 : action.id === 'commit-reviewed-worktree' ? 4 : 3;
  return [...actions].sort((left, right) => rank(left) - rank(right));
}

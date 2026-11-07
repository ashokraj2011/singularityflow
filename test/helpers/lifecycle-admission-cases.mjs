/** Stable native-admission fixtures; fictional identities and no infrastructure. */
export function admissionWorkflow() {
  return { workItem: { id: 'ADMISSION-1' }, status: 'in_progress', currentPhase: 'draft',
    phaseOrder: ['draft','delivery','finish'], history: [{ event: 'prior-publication' }], resolution: {},
    phases: Object.fromEntries(['draft','delivery','finish'].map((id,index) => [id, {
      id, status: index ? 'not_started' : 'in_progress', generation: index ? 0 : 2,
      startedAt: index ? null : 'earlier', submittedAt: index ? null : 'prior-submission', approvedAt: 'prior-approval', approvedBy: 'prior-reviewer',
      defaultAgent: 'phase-author', artifacts: [{ path: `artifacts/${id}/document.md`, sha256: 'a'.repeat(64) }],
      approvals: [{ actor: 'reviewer', generation: 1 }, { actor: 'old-reviewer', invalidatedAt: 'earlier' }],
      approvalDisposition: 'policy_waived', approvalWaiver: { policyId: 'prior-policy' }, decisionValues: { result: 'pass' },
      decisionInputs: [{ generation: 1, values: { result: 'pass' } }]
    }])) };
}

export function lifecycleAdmissionCases() {
  const cases = [];
  const seq = (name, change = () => {}, options = {}) => { const workflow = admissionWorkflow(); change(workflow); cases.push({ kind: 'sequence', name, workflow, options }); };
  seq('current'); seq('explicit-current', undefined, { requestedPhase: 'draft' });
  seq('later', undefined, { requestedPhase: 'delivery' }); seq('unknown', undefined, { requestedPhase: 'absent' });
  seq('awaiting', w => { w.phases.draft.status = 'awaiting_approval'; });
  seq('approval', w => { w.phases.draft.status = 'awaiting_approval'; }, { allowedStatuses: ['awaiting_approval'] });
  seq('several-statuses', w => { w.phases.draft.status = 'approved'; }, { allowedStatuses: ['in_progress','awaiting_approval'] });
  seq('empty-statuses', undefined, { allowedStatuses: [] });
  seq('closed', w => { w.currentPhase = null; w.status = 'closed'; });
  seq('closed-early', w => { w.currentPhase = null; w.status = 'closed'; w.phases.finish.status = 'skipped'; });
  seq('closed-explicit', w => { w.currentPhase = null; }, { requestedPhase: 'delivery' });
  seq('closed-unknown', w => { w.currentPhase = null; }, { requestedPhase: 'absent' });
  seq('no-phases', w => { w.currentPhase = null; w.phases = {}; w.phaseOrder = []; });
  seq('cancelled', w => { w.status = 'cancelled'; });
  seq('pending-choice', w => { w.pendingDecision = { after: 'draft', label: 'Choose channel', by: ['reviewers'] }; });
  seq('pending-before-cancellation', w => { w.status = 'cancelled'; w.pendingDecision = { after: 'draft', label: 'Choose channel', by: ['reviewers'] }; });
  seq('soft-does-not-authorize', w => { w.resolution.sequenceGates = { default: 'soft' }; }, { requestedPhase: 'delivery' });
  for (const [name, policy, gate] of [
    ['gate-default', null, 'currentPhase'], ['gate-soft', { default: 'soft' }, 'currentPhase'],
    ['gate-hard-override', { default: 'soft', currentPhase: 'hard' }, 'currentPhase'],
    ['gate-soft-override', { default: 'hard', currentPhase: 'soft' }, 'currentPhase'],
    ['gate-other', { default: 'unexpected' }, 'currentPhase']
  ]) { const workflow = admissionWorkflow(); if (policy) workflow.resolution.sequenceGates = policy; cases.push({ kind: 'mode', name, workflow, gate }); }
  for (const [name, effect, target, statuses] of [
    ['switch-forward','switch','delivery',null], ['switch-current','switch','draft',null],
    ['status-author','status','draft',['in_progress']], ['status-review','status','draft',['awaiting_approval']],
    ['status-other','status','draft',['approved']], ['no-effect',null,'draft',null], ['invalid-target','switch','absent',null]
  ]) { const workflow = admissionWorkflow(); workflow.pendingDecision = { after: 'draft', label: 'Old choice', by: ['reviewers'] };
    cases.push({ kind: 'apply', name, workflow, decision: { gate: 'currentPhase', targetPhase: target, effect, allowedStatuses: statuses, reason: 'explicitly confirmed fixture' }, at: '2026-01-01T00:00:00.000Z' }); }
  for (const [name, mode, agent, reviewer, operation] of [
    ['no-agent',null,null,null,'publish'], ['writer',null,'writer',null,'publish'],
    ['read-only','read-only','writer',null,'publish'], ['reviewer','read-only-review','writer',null,'publish'],
    ['bound-reviewer',null,'writer','writer','submit'], ['unrelated-reviewer',null,'writer','someone-else','approve'],
    ['reviewer-operation','read-only-review','writer',null,'start-code'], ['read-only-other','read-only','writer',null,'approve']
  ]) { const workflow = admissionWorkflow(); workflow.resolution.sourceReview = { reviewerAgent: reviewer };
    cases.push({ kind: 'agent', name, workflow, config: { agents: { writer: { metadata: { ...(mode ? { 'sflow-mode': mode } : {}) } } } }, phaseId: 'draft', session: { agent }, operation }); }
  for (const [name, value, nonReviewable] of [
    ['policy-default',null,null], ['policy-off',{},null], ['policy-valid',{ mode: 'enforce', phases: ['draft'], reviewerAgent: 'source-reviewer' },null],
    ['policy-array',[],null], ['policy-string','enforce',null], ['policy-field',{ other: true },null],
    ['policy-mode',{ mode: 'maybe' },null], ['policy-phase-duplicate',{ phases: ['draft','draft'] },null],
    ['policy-phase-unknown',{ phases: ['absent'] },null], ['policy-phase-kind',{ phases: ['draft'] },['draft']],
    ['policy-reviewer-id',{ reviewerAgent: 'Invalid ID' },null], ['policy-reviewer-type',{ reviewerAgent: 5 },null],
    ['policy-empty-enforce',{ mode: 'enforce' },null]
  ]) cases.push({ kind: 'review-policy', name, value, nonReviewable });
  for (const [name, mode, agentMode, defaults] of [
    ['review-off','off',null,[]], ['review-missing','enforce',null,[]], ['review-wrong-mode','enforce','read-only',[]],
    ['review-valid','enforce','read-only-review',[]], ['review-collision','enforce','read-only-review',['draft','delivery']],
    ['review-other-default','enforce','read-only-review',['finish']]
  ]) cases.push({ kind: 'review-agent', name, policy: { mode, phases: ['draft','delivery'], reviewerAgent: 'source-reviewer' },
    agents: agentMode ? [{ id: 'source-reviewer', metadata: { 'sflow-mode': agentMode }, defaultFor: defaults }] : [] });
  return cases;
}

export function observeLifecycleAdmission(api, input) {
  const f = structuredClone(input);
  try {
    let value;
    if (f.kind === 'sequence') value = api.evaluateSequence(f.workflow, f.options);
    else if (f.kind === 'mode') value = api.sequenceGateMode(f.workflow, f.gate);
    else if (f.kind === 'apply') value = api.applySequenceDecision(f.workflow, f.decision, f.at);
    else if (f.kind === 'agent') value = { agent: api.readOnlyAgent(f.config, f.workflow, f.session),
      restriction: api.phaseAgentMutationRestriction(f.config, f.workflow, f.workflow.phases[f.phaseId], f.session, f.operation) };
    else if (f.kind === 'review-policy') value = api.normalizeSourceReviewPolicy(f.value, { workTypeId: 'team-workflow',
      phases: ['draft','delivery'], reviewable: f.nonReviewable ? phase => !f.nonReviewable.includes(phase) : null });
    else if (f.kind === 'review-agent') value = api.assertSourceReviewerAvailable(f.policy, f.agents, { workTypeId: 'team-workflow' });
    return { value: value ?? null, workflow: f.workflow ?? null };
  } catch (error) { return { error: { name: error.name, message: error.message, ...Object.fromEntries(Object.entries(error)) }, workflow: f.workflow ?? null }; }
}

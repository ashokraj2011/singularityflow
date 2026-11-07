/** Fixed native routing scenarios, captured before the interpreter extraction. */
export function workflowDecisionCases(api) {
  const phases = ['discover', 'design', 'build', 'check', 'release'].map(id => ({
    id, label: id.toUpperCase(), inputs: [], approval: { mode: 'required', authorities: ['reviewers'] }
  }));
  const authorities = { reviewers: { label: 'Reviewers' } };
  const branch = { id: 'channel', label: 'Delivery channel', after: 'discover', kind: 'branch',
    inputs: [{ name: 'channel', label: 'Channel', values: ['Web', 'Mobile', 'Other'] }],
    routes: [{ id: 'web', label: 'Web application', when: { channel: 'web' }, to: 'design' },
      { id: 'mobile', label: 'Mobile application', when: { channel: 'Mobile' }, to: 'check' },
      { id: 'stop', label: 'Finish here', to: 'end' }] };
  const loop = { id: 'validation', label: 'Validation', after: 'check', kind: 'loop',
    inputs: [{ name: 'score', label: 'Score', type: 'number', minimum: 0, maximum: 100 }],
    goal: { score: { atLeast: 100 } }, back: 'build', maxRounds: 2 };
  const ask = { id: 'direction', label: 'Direction', after: 'design', kind: 'ask',
    routes: [{ id: 'continue', label: 'Continue', to: 'next' }, { id: 'stop', label: 'Finish here', to: 'end' }] };
  const compile = (definitions, options = {}) => api.normalizeDecisions(definitions,
    { workTypeId: 'custom-team', phases, approvalAuthorities: authorities, ...options });
  const observe = call => { try { return { value: call() }; } catch (error) { return { error: error.toJSON() }; } };
  const cases = [];
  const add = (name, call) => cases.push({ name, ...observe(call) });
  for (const [name, definitions, options] of [
    ['compiled-program', [branch, loop, ask]],
    ['no-decisions', undefined],
    ['unknown-field', [{ ...branch, unrecognized: true }]],
    ['duplicate-after', [branch, { ...branch, id: 'second' }]],
    ['invalid-choice', [{ ...branch, routes: [{ ...branch.routes[0], when: { channel: 'missing' } }, branch.routes[2]] }]],
    ['unreviewed-skip', [branch], { phases: phases.map(p => p.id === 'discover' ? { ...p, approval: { mode: 'none' } } : p) }],
    ['unknown-authority', [{ ...ask, by: ['missing'] }]],
    ['required-dependency-skip', [branch], { phases: phases.map(p => p.id === 'check' ? { ...p, inputs: [{ phase: 'design' }] } : p) }],
    ['test-evidence-skip', [branch], { phases: phases.map(p => p.id === 'check' ? { ...p, testEvidenceFrom: 'build' } : p) }],
    ['unknown-reuse', [{ ...loop, inputs: [{ name: 'channel', from: 'missing' }], goal: { channel: 'Web' } }]],
    ['convergence-conflict', [branch], { phases: phases.map(p => p.id === 'discover' ? { ...p, convergence: {} } : p) }],
    ['invalid-round-limit', [{ ...loop, maxRounds: 21 }]]
  ]) add(name, () => compile(definitions, options));

  const make = (definitions = [branch, loop, ask]) => {
    const decisions = compile(definitions);
    return { workItem: { id: 'ROUTING-1' }, currentPhase: 'discover', phaseOrder: phases.map(p => p.id),
      phases: Object.fromEntries(phases.map(p => [p.id, { ...p, status: 'in_progress', generation: 1, approvals: [], artifacts: [] }])),
      resolution: { decisions }, decisionRounds: {}, history: [] };
  };
  for (const [name, phaseId, values, rounds] of [
    ['web-next', 'discover', { channel: 'Web' }, 0], ['mobile-forward', 'discover', { channel: 'Mobile' }, 0],
    ['other-end', 'discover', { channel: 'Other' }, 0], ['ask-pause', 'design', null, 0],
    ['loop-first', 'check', { score: 90 }, 0], ['loop-second', 'check', { score: 90 }, 1],
    ['loop-limit', 'check', { score: 90 }, 2], ['goal-met', 'check', { score: 100 }, 2],
    ['missing-inputs', 'check', null, 0]
  ]) add(name, () => {
    const workflow = make(), phase = workflow.phases[phaseId]; workflow.currentPhase = phaseId;
    const decision = api.decisionAfter(workflow, phaseId);
    workflow.decisionRounds.validation = { count: rounds };
    if (values) phase.decisionInputs = { decision: decision.id, values };
    const outcome = api.decisionOutcome(workflow, phase);
    if (outcome?.kind === 'pause') workflow.pendingDecision = api.pendingDecisionRecord(workflow, phase, outcome, { at: '2026-11-08T10:00:00.000Z' });
    return { outcome, description: api.describeOutcome(workflow, outcome), pending: workflow.pendingDecision ?? null,
      view: api.storyDecisionView(workflow), upcoming: api.upcomingDecision(workflow, phase) };
  });

  const reused = { ...loop, inputs: [{ name: 'channel', from: 'channel' }], goal: { channel: 'Web' } };
  for (const present of [false, true]) add(`reused-channel-${present}`, () => {
    const workflow = make([branch, reused]), phase = workflow.phases.check;
    if (present) workflow.phases.discover.decisionInputs = { decision: 'channel', values: { channel: 'Web' } };
    return api.decisionOutcome(workflow, phase);
  });

  for (const [name, choice, tamper] of [
    ['choice-none', {}], ['choice-both', { option: 'again', to: 'build' }], ['choice-unknown', { option: 'missing' }],
    ['choice-step-denied', { to: 'release' }], ['choice-reopen', { to: 'discover' }],
    ['choice-recorded-route', { option: 'again' }], ['choice-forged-pass', { option: 'goal-met' }, true]
  ]) add(name, () => {
    const workflow = make([branch, { ...loop, enforceConditions: true }]), phase = workflow.phases.check;
    phase.decisionInputs = { decision: 'validation', values: { score: 20 } }; workflow.decisionRounds.validation = { count: 2 };
    const pending = api.pendingDecisionRecord(workflow, phase, api.decisionOutcome(workflow, phase), { at: '2026-11-08T10:00:00.000Z' });
    if (tamper) { pending.values.score = 100; pending.options.push({ id: 'goal-met', label: 'Goal met', to: 'next' }); }
    return api.resolveDecisionChoice(workflow, pending, choice);
  });
  add('choice-not-pending', () => api.resolveDecisionChoice(make(), null, {}));
  for (const supplied of [{ channel: 'mobile' }, { channel: '' }, { channel: 'missing' }, { other: 'Web' }]) {
    add(`input-${JSON.stringify(supplied)}`, () => api.normalizeDecisionInputValues(compile([branch])[0], supplied));
  }
  return cases;
}

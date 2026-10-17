/**
 * A workflow in plain words: what each step does, why it is there (its description, when someone
 * wrote one), who drafts it, what it reads, who signs it off and what happens next. Built from the
 * Workflow Studio model, never by a model, so the Studio, `workflow check` and the workflow builder
 * explain a workflow the same way.
 */

const OUTPUT_WORDS = Object.freeze({
  code: 'Changes code and writes a summary',
  document: 'Writes a document',
  analysis: 'Writes an analysis',
  none: 'Produces nothing of its own; it is a sign-off'
});

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function listWords(items, joiner = 'and') {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${joiner} ${items.at(-1)}`;
}

/** Who signs a step off, from its approval summary and the groups' names. */
export function signOffWords(approval, groupLabel) {
  if (!approval || approval.mode === 'none') return 'Nobody signs it off: it moves on when it is submitted.';
  const groups = (approval.authorities ?? []).map(groupLabel);
  const from = groups.length ? listWords(groups, 'or') : 'a group nobody has chosen yet';
  const minimum = approval.minimum ?? 1;
  const required = (approval.requiredAuthorities ?? []).map(groupLabel);
  return `Signed off by ${minimum === 1 ? 'one person' : `${minimum} people`} from ${from}${required.length ? `, including someone from ${listWords(required)}` : ''}.`;
}

function targetWords(to, after, order, stepLabel) {
  if (to === 'end') return 'the end';
  if (to === 'next') {
    const next = order[order.indexOf(after) + 1];
    return next ? stepLabel(next) : 'the end';
  }
  return stepLabel(to);
}

/** What happens after a step: the next step, its decision's routes, and where a rejection sends work. */
function thenWords(step, workflow, { stepLabel, groupLabel, rejectTo }) {
  const order = workflow.phases;
  const lines = [];
  const decision = (workflow.decisions ?? []).find((entry) => entry.after === step.id);
  if (decision?.kind === 'loop') {
    const goal = Object.entries(decision.goal ?? {}).map(([name, value]) => `${name} is ${Array.isArray(value) ? value.join(' or ') : value}`).join(' and ');
    lines.push(`${decision.label ?? 'Loop'}: back to ${stepLabel(decision.back)} until ${goal || 'its goal is met'}, at most ${plural(decision.maxRounds ?? 3, 'round')}`
      + `${decision.by?.length ? `, then ${listWords(decision.by.map(groupLabel), 'or')} decide` : ''}.`);
    const next = order[order.indexOf(step.id) + 1];
    lines.push(`When the goal is met: ${next ? stepLabel(next) : 'the end'}.`);
  } else if (decision) {
    const who = decision.kind === 'ask' ? `${decision.by?.length ? listWords(decision.by.map(groupLabel), 'or') : 'A person'} choose` : 'Decided by the recorded answer';
    lines.push(`${decision.label ?? 'Decision'} (${who}):`);
    for (const route of decision.routes ?? []) {
      lines.push(`${route.label ?? route.id}: ${targetWords(route.to, step.id, order, stepLabel)}.`);
    }
  } else {
    const next = order[order.indexOf(step.id) + 1];
    lines.push(next ? `Next: ${stepLabel(next)}.` : 'This is the last step.');
  }
  for (const loop of (workflow.reworkLoops ?? []).filter((entry) => entry.from === step.id)) {
    lines.push(`If changes are needed: back to ${stepLabel(loop.to)}, at most ${plural(loop.maxAttempts, 'time')}.`);
  }
  const rejected = step.approval?.mode === 'none' ? [] : rejectTo.filter((id) => !(workflow.reworkLoops ?? []).some((loop) => loop.from === step.id && loop.to === id));
  if (rejected.length) {
    const earlier = rejected.filter((id) => id !== step.id).map(stepLabel);
    const redo = rejected.includes(step.id);
    lines.push(`If it is rejected: ${redo ? 'it is redone' : ''}${redo && earlier.length ? ', or ' : ''}${earlier.length ? `back to ${listWords(earlier, 'or')}` : ''}, as the person rejecting it chooses.`
      .replace(', as the person rejecting it chooses.', rejected.length > 1 ? ', as the person rejecting it chooses.' : '.'));
  }
  for (const action of step.afterStep ?? []) {
    lines.push(`When it is ${listWords(action.on ?? [], 'or')}: tells ${action.target}.`);
  }
  return lines;
}

/**
 * Explain one workflow of a Studio model. `resolved` (optional) is the engine's resolution of it,
 * for rejection targets the model does not show; `guidance` (optional) maps a step ID to the links
 * and API calls its own guidance gives.
 */
export function explainWorkflow(model, workflowId, { resolved = null, guidance = new Map() } = {}) {
  const workflow = model.workflows.find((entry) => entry.id === workflowId);
  if (!workflow) return null;
  const phases = new Map(model.phases.map((phase) => [phase.id, phase]));
  const steps = new Map(workflow.steps.map((step) => [step.id, step]));
  const groups = new Map(model.groups.map((group) => [group.id, group]));
  const agents = new Map(model.agents.map((agent) => [agent.id, agent]));
  const skills = new Map((model.skills ?? []).map((skill) => [skill.id, skill]));
  const stepLabel = (id) => steps.get(id)?.label ?? phases.get(id)?.label ?? id;
  const groupLabel = (id) => groups.get(id)?.label ?? id;
  const resolvedPhases = new Map((resolved?.phases ?? []).map((phase) => [phase.id, phase]));
  const explained = workflow.steps.map((step, index) => {
    const phase = phases.get(step.id) ?? {};
    const artifact = resolvedPhases.get(step.id)?.artifact?.path ?? phase.artifact ?? null;
    const template = step.template ?? phase.template ?? null;
    const what = step.output === 'none'
      ? OUTPUT_WORDS.none
      : `${OUTPUT_WORDS[step.output] ?? 'Writes a document'}${artifact ? ` (${artifact})` : ''}${template && step.output !== 'code' ? `, from the ${template} template` : ''}.`;
    const optional = new Set(step.optionalInputs ?? []);
    const agent = step.agent ? agents.get(step.agent) : null;
    const found = guidance.get(step.id) ?? { links: [], apiCalls: [] };
    return {
      id: step.id,
      number: index + 1,
      label: step.label,
      what,
      why: step.description ? { text: step.description, from: 'description' } : null,
      agent: step.agent ? { id: step.agent, label: agent?.label ?? step.agent } : null,
      skills: (step.skills ?? []).map((entry) => ({ id: entry.id, label: skills.get(entry.id)?.label ?? entry.id, use: entry.use ?? null, scope: entry.scope ?? 'agent' })),
      instructions: [...new Set((step.skills ?? []).flatMap((entry) => skills.get(entry.id)?.instructionRefs ?? []))],
      reads: (step.inputs ?? []).map((id) => ({ id, label: stepLabel(id), optional: optional.has(id) })),
      signOff: signOffWords(step.approval, groupLabel),
      then: thenWords(step, workflow, { stepLabel, groupLabel, rejectTo: resolvedPhases.get(step.id)?.approval?.rejectTo ?? [] }),
      links: found.links,
      apiCalls: found.apiCalls
    };
  });
  const signOffs = workflow.steps.filter((step) => step.approval?.mode !== 'none').length;
  const code = workflow.steps.filter((step) => step.output === 'code').map((step) => step.label);
  const decisions = (workflow.decisions ?? []).length;
  const summary = [
    `${plural(workflow.steps.length, 'step')}, ${signOffs === 0 ? 'none' : signOffs} with a sign-off`,
    decisions ? plural(decisions, 'decision') : null,
    (workflow.reworkLoops ?? []).length ? plural(workflow.reworkLoops.length, 'send-back rule') : null,
    code.length ? `changes code in ${listWords(code)}` : 'changes no code'
  ].filter(Boolean).join('; ');
  return {
    id: workflow.id,
    label: workflow.label,
    description: workflow.description || null,
    summary: `${summary}.`,
    readOnly: Boolean(workflow.readOnly),
    steps: explained
  };
}

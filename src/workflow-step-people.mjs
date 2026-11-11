/**
 * Who does what, where, in each step of a workflow: who drafts it, who is asked questions and who
 * answers them, whether an independent agent reviews it, who approves it and whether that happens in
 * the chat or only in the approver's own terminal, which tests it runs and which sign-offs it owes.
 * Read from the resolved workflow (what a Story would pin) and the person-step catalog the guard
 * enforces, never from a step's name, so it says what a Story will actually ask of people. A team's
 * custom step whose approval had to run in the approver's own terminal was found only mid-approval
 * (2026-11-11); this says it before any Story starts.
 *
 * Deterministic and read-only. `workflow check` puts each step's map at
 * `workflows[].explanation.steps[].people` and `workflow validate` at `workflows[].roles[].people`.
 * The shape is stable (other tools read it); fields are only ever added:
 *
 *   author     { by: 'agent'|'person'|'sflow'|'external-tool', agent: { id, label }|null,
 *                personMayWrite, writesCode, output: 'code'|'document'|'analysis'|'none', text }
 *   questions  { mode: 'off'|'when-needed'|'required', maxQuestions, topics: [], markers: 'off'|'warn'|'block',
 *                markersBlock, asked, answeredBy: { groups: [], where: 'chat'|'chat-or-own-terminal'|'author' }|null, text }
 *   review     { reviewed, reviewer: { id, label }|null, kind: 'document'|'code'|'specification'|'planning'|null,
 *                reason: null|'review-off'|'reviewer-unavailable'|'skipped'|'reviewer-drafts-it'|'not-authored', text }
 *   approval   { mode: 'required'|'policy'|'none', policy: { id, maximumChangedPaths }|null,
 *                groups: [{ id, label, members, teams: [], status: 'people'|'anyone'|'teams'|'auto'|'blocked', canApprove }],
 *                minimum, requiredGroups: [], selfApproval, where: 'none'|'chat'|'own-terminal-when-needed',
 *                ownTerminalWhen: [{ reason: 'evidence-sign-off'|'test-decision', ownTerminalStep, command, text }],
 *                text, groupsText }
 *   tests      { runs, from: 'step'|'repository'|'found'|'code-step'|null, ids: [], levels: [], checks: [], evidenceFrom, text }
 *   signOffs   [{ kind: 'evidence', methods: ['inspection'|'visual'], where: 'own-terminal', text }
 *               | { kind: 'applicability', responsibility, group, where: 'chat', text }]
 *   lines      the plain-words line of each item above, in that order (one per item)
 */
import { DECIDE_SKILL_MUTATIONS, OWN_TERMINAL_STEPS } from './person-step-catalog.mjs';
import { isConvergencePhase, VISUAL_EVIDENCE_ARTIFACT_KIND } from './phase-roles.mjs';

export const STEP_PEOPLE_ITEMS = Object.freeze(['author', 'questions', 'review', 'approval', 'approvers', 'tests', 'signOffs']);

const listWords = (items, joiner = 'and') => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${joiner} ${items.at(-1)}`);
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The person-step catalog entry the guard refuses outside a person's own terminal for this command form, or null. */
function ownTerminalStep(positionals, options) {
  return OWN_TERMINAL_STEPS.find((entry) => entry.matches(positionals, options))?.id ?? null;
}

/** Whether people can sign off with a group: the Studio's words for it (workflow-studio.mjs groupStatus). */
function groupView(id, authorities, security) {
  const group = authorities?.[id];
  if (!group) return { id, label: id, members: 0, teams: [], status: 'blocked', canApprove: false };
  const members = (group.members ?? []).length;
  const teams = [...(group.githubTeams ?? [])];
  const status = members ? 'people' : (group.allowAnyGitIdentity ?? security.allowAnyGitIdentity) ? 'anyone'
    : teams.length ? 'teams' : security.autoEnrollNewIdentities ? 'auto' : 'blocked';
  return { id, label: group.label ?? id, members, teams, status, canApprove: status !== 'blocked' };
}

function groupWords(group) {
  switch (group.status) {
    case 'people': return `${group.label}: ${plural(group.members, 'person', 'people')}${group.teams.length ? ` and the members of ${listWords(group.teams)}` : ''}`;
    case 'anyone': return `${group.label}: any Git identity`;
    case 'teams': return `${group.label}: the members of ${listWords(group.teams)}`;
    case 'auto': return `${group.label}: no named people yet (whoever starts a Story is added)`;
    default: return `${group.label}: nobody (no people, no teams, and nobody is added automatically), so nobody can approve`;
  }
}

function authorOf(step, phase, agents) {
  const allowed = phase.generation?.allowedProducers ?? ['governed-agent', 'human'];
  const preferred = phase.generation?.defaultProducer ?? allowed[0];
  const agent = step.agent ? { id: step.agent, label: agents.get(step.agent)?.label ?? step.agent } : null;
  const by = isConvergencePhase(phase) || preferred === 'deterministic' ? 'sflow'
    : preferred === 'human' ? 'person' : preferred === 'external-tool' ? 'external-tool' : 'agent';
  const personMayWrite = by !== 'person' && allowed.includes('human');
  const writesCode = step.output === 'code';
  const who = by === 'sflow' ? 'Singularity Flow builds it itself; no agent or person drafts it'
    : by === 'person' ? `A person writes it${allowed.includes('governed-agent') && agent ? `, or ${agent.label} (an agent) drafts it` : ''}`
      : by === 'external-tool' ? 'An external tool produces it'
        : `${agent ? `${agent.label} (an agent)` : 'No agent yet'} drafts it${personMayWrite ? ', or a person writes it' : ''}`;
  return { by, agent, personMayWrite, writesCode, output: step.output ?? 'document',
    text: `Author: ${who}. ${writesCode ? 'It changes code.' : step.output === 'none' ? 'It produces nothing of its own.' : 'It changes no code.'}` };
}

function questionsOf(phase, author, approval, groupLabel) {
  const policy = phase.clarification ?? { mode: 'off', maxQuestions: 5, topics: [], markers: { mode: 'off' } };
  const markers = policy.markers?.mode ?? 'off';
  // The checkpoint applies only to an agent's draft (clarificationRoutes): nobody asks a step only a person or Singularity Flow writes.
  const agentDrafts = author.by !== 'sflow' && (phase.generation?.allowedProducers ?? ['governed-agent']).includes('governed-agent');
  const asked = policy.mode !== 'off' && agentDrafts;
  // A member of the step's approval groups answers; with none, its author does (cli.mjs clarification record).
  const groups = approval.mode === 'none' ? [] : approval.groups.map((group) => group.id);
  const remote = ownTerminalStep(['clarification', 'answer'], {});
  const answeredBy = !asked ? null : groups.length ? { groups, where: remote ? 'chat-or-own-terminal' : 'chat' } : { groups: [], where: 'author' };
  const topics = policy.topics?.length ? ` about ${listWords(policy.topics)}` : '';
  const how = policy.mode === 'required' ? `asks before drafting, every time (required), at most ${plural(policy.maxQuestions, 'question')}${topics}`
    : policy.mode === 'when-needed' ? `asks only when something material is unclear (when-needed), at most ${plural(policy.maxQuestions, 'question')}${topics}`
      : 'asks no questions (off)';
  const who = !answeredBy ? ''
    : answeredBy.where === 'author' ? '; the person working on it answers in the chat'
      : `; a member of ${listWords(answeredBy.groups.map(groupLabel), 'or')} answers, in the chat when they are the one asked, otherwise in their own terminal (singularity-flow clarification answer)`;
  const unasked = policy.mode !== 'off' && !asked ? ' Nobody asks, though: no agent drafts it.' : '';
  const marked = markers === 'block' ? ' An unanswered [NEEDS CLARIFICATION] marker in its document stops its publication.'
    : markers === 'warn' ? ' An unanswered [NEEDS CLARIFICATION] marker in its document is a warning at publication.' : '';
  return { mode: policy.mode, maxQuestions: policy.maxQuestions, topics: [...(policy.topics ?? [])], markers, markersBlock: markers === 'block',
    asked, answeredBy, text: `Questions: ${how}${who}.${unasked}${marked}` };
}

function reviewOf(phase, sourceReview, agents) {
  const kinds = sourceReview?.kinds ?? {};
  const reviewerId = sourceReview?.reviewerAgent ?? sourceReview?.unavailableReviewer ?? null;
  const reviewer = reviewerId ? { id: reviewerId, label: agents.get(reviewerId)?.label ?? reviewerId } : null;
  if (sourceReview?.mode === 'enforce' && Object.hasOwn(kinds, phase.id)) {
    const kind = kinds[phase.id];
    const what = { code: 'the code it changes', specification: 'it as a specification', planning: 'it as a plan' }[kind] ?? 'its document';
    return { reviewed: true, reviewer, kind, reason: null,
      text: `Review: ${reviewer.label}, an independent agent, reviews ${what} before it goes to its approvers.` };
  }
  const reason = sourceReview?.unavailableReviewer ? 'reviewer-unavailable' : sourceReview?.mode !== 'enforce' ? 'review-off'
    : (sourceReview.skip ?? []).includes(phase.id) ? 'skipped'
      : (agents.get(sourceReview.reviewerAgent)?.defaultFor ?? []).includes(phase.id) ? 'reviewer-drafts-it' : 'not-authored';
  const why = {
    'reviewer-unavailable': `this configuration has no read-only reviewer '${reviewerId}'`,
    'review-off': "the workflow's review is off (sourceReview.mode: off)",
    skipped: 'the workflow lists it under sourceReview.skip',
    'reviewer-drafts-it': `its reviewer, ${reviewer?.label ?? reviewerId}, also drafts it`,
    'not-authored': 'no agent or person authors it'
  }[reason];
  return { reviewed: false, reviewer: reason === 'reviewer-unavailable' || reason === 'reviewer-drafts-it' ? reviewer : null, kind: null, reason,
    text: `Review: no independent review, because ${why}.` };
}

function testsOf(step, phase, stepLabel) {
  // A step's own test commands are counted with its tests; its other commands are checks.
  const checks = (step.qualityCommands ?? []).filter((entry) => typeof entry === 'string' || (entry && typeof entry === 'object' && entry.kind !== 'test'))
    .map((entry) => String(typeof entry === 'string' ? entry : entry.id ?? (entry.argv ?? []).join(' ')));
  const evidenceFrom = phase.testEvidenceFrom ?? null;
  const from = step.testsFrom;
  let result;
  if (from?.source === 'step') result = { runs: true, from: 'step', ids: [...(from.ids ?? [])], levels: [], words: `its own test commands ${listWords(from.ids ?? [])}` };
  else if (from?.source === 'repository') {
    const levels = [...(from.levels ?? [])];
    const ids = [...(from.runs ?? from.ids ?? [])];
    result = { runs: true, from: 'repository', ids, levels,
      words: `the repository's tests${levels.length ? ` at level ${listWords(levels, 'or')}` : from.ids?.length ? ` ${listWords(from.ids)}` : ''}${ids.length ? ` (${listWords(ids)})` : ''}` };
  } else if (from?.source === 'inferred') {
    result = { runs: true, from: 'found', ids: [], levels: [], words: step.output === 'code' ? 'the tests Singularity Flow finds for the code it changes'
      : "the repository's tests, as Singularity Flow finds them (the configuration lists none under tests)" };
  } else if (step.runsRepositoryTests) result = { runs: true, from: 'repository', ids: [], levels: [], words: "the repository's tests" };
  else if (evidenceFrom) result = { runs: false, from: 'code-step', ids: [], levels: [], words: null };
  else result = { runs: false, from: null, ids: [], levels: [], words: null };
  const checked = checks.length ? `${result.runs ? '; it also runs' : 'It runs'} ${listWords(checks)}` : '';
  const text = result.runs ? `Tests: runs ${result.words} when it is submitted${checked}.`
    : evidenceFrom ? `Tests: runs none itself; it reads the test results of ${stepLabel(evidenceFrom)}${checked ? `. ${checked.replace(/^; it also/u, 'It')}` : ''}.`
      : `Tests: runs none${checks.length ? `; it runs ${listWords(checks)} when it is submitted` : ''}.`;
  const { words, ...shape } = result;
  return { ...shape, checks, evidenceFrom, text };
}

/**
 * The map for every step of one Studio workflow, by step ID; empty when the workflow does not
 * resolve (its finding says why). `resolved` is resolveWorkType's result for it.
 */
export function workflowStepPeople(model, workflow, resolved) {
  const people = new Map();
  if (!resolved || !workflow) return people;
  const agents = new Map((model.agents ?? []).map((agent) => [agent.id, agent]));
  const phases = new Map((resolved.phases ?? []).map((phase) => [phase.id, phase]));
  const authorities = resolved.approvalAuthorities ?? {};
  const security = { allowAnyGitIdentity: false, autoEnrollNewIdentities: true, ...(resolved.approvalSecurity ?? {}) };
  const stepLabel = (id) => workflow.steps.find((step) => step.id === id)?.label ?? id;
  const groupLabel = (id) => authorities[id]?.label ?? id;
  const hasCode = workflow.steps.some((step) => step.output === 'code');
  const visualStep = (resolved.phases ?? []).find((phase) => phase.artifact?.kind === VISUAL_EVIDENCE_ARTIFACT_KIND)?.id ?? null;
  // The person-step catalog's own answers, so this map follows the guard if it ever changes.
  const confirmEvidence = (id) => ownTerminalStep(['approve', id], { 'confirm-evidence': true });
  const testDecision = ownTerminalStep(['decision', 'test-risk'], {});
  const applicabilityInChat = DECIDE_SKILL_MUTATIONS.includes('applicability');
  const omissions = new Map();
  for (const endpoint of resolved.obligationGraph?.endpoints ?? []) {
    for (const entry of endpoint.omits ?? []) {
      const list = omissions.get(endpoint.from) ?? [];
      if (!list.some((item) => item.responsibility === entry.responsibility)) list.push(entry);
      omissions.set(endpoint.from, list);
    }
  }
  for (const step of workflow.steps) {
    const phase = phases.get(step.id);
    if (!phase) continue;
    const author = authorOf(step, phase, agents);
    const policy = phase.approval ?? { mode: 'none', authorities: [], requiredAuthorities: [], minimum: 0 };
    const groups = policy.mode === 'none' ? [] : (policy.authorities ?? []).map((id) => groupView(id, authorities, security));
    const tests = testsOf(step, phase, stepLabel);
    // What makes its approval a person's own-terminal step [person-step-catalog.mjs]: the inspection or
    // visual sign-offs it answers for (owner-step-evidence.mjs ownSignOffs: the code step that delivers a
    // criterion, the visual verification step for visual ones), and its test-run decisions.
    const methods = !hasCode ? [] : step.output === 'code' ? ['inspection', ...(visualStep ? [] : ['visual'])] : step.id === visualStep ? ['visual'] : [];
    const ownTerminalWhen = [];
    if (policy.mode !== 'none' && methods.length && confirmEvidence(step.id)) {
      ownTerminalWhen.push({ reason: 'evidence-sign-off', ownTerminalStep: confirmEvidence(step.id),
        command: `singularity-flow approve ${step.id} --work-id <WORK-ID> --confirm-evidence`,
        text: `when it also confirms the ${listWords(methods, 'or')} evidence of a criterion it delivers (approve --confirm-evidence)` });
    }
    if (policy.mode !== 'none' && (tests.runs || step.id === visualStep) && testDecision) {
      ownTerminalWhen.push({ reason: 'test-decision', ownTerminalStep: testDecision,
        command: `singularity-flow decision test-risk <WORK-ID> --phase ${step.id} --cause <CAUSE> --expires <YYYY-MM-DD> --reason <REASON>`,
        text: `when its test results need a person's decision (a test-run risk, a narrowed or reused run${step.id === visualStep ? ', a screen size that does not apply' : ''}), which VS Code's approval form also takes` });
    }
    const where = policy.mode === 'none' ? 'none' : ownTerminalWhen.length ? 'own-terminal-when-needed' : 'chat';
    const minimum = policy.mode === 'none' ? 0 : policy.minimum ?? 1;
    const requiredGroups = [...(policy.requiredAuthorities ?? [])];
    const from = listWords(groups.map((group) => group.label), 'or') || 'a group nobody has chosen yet';
    const count = minimum === 1 ? 'one person' : `${minimum} people`;
    const including = requiredGroups.length ? `, including someone from ${listWords(requiredGroups.map(groupLabel))}` : '';
    const self = policy.allowSelfApproval ? 'its author may approve it' : 'someone other than its author approves it';
    const place = where === 'chat' ? 'in the chat with /sf-approve (or VS Code\'s Approve, or the approver\'s own terminal)'
      : `in the chat with /sf-approve, but only in the approver's own terminal ${ownTerminalWhen.map((entry) => entry.text).join(', or ')}`;
    const approvalText = policy.mode === 'none' ? 'Approval: none; it moves on when it is submitted.'
      : policy.mode === 'policy' ? `Approval: automatic when the change fits policy ${policy.policy ?? 'quick-fix-low-risk-v1'}${policy.maximumChangedPaths ? ` (at most ${plural(policy.maximumChangedPaths, 'changed path')})` : ''}; otherwise ${count} from ${from}${including} (${self}), ${place}.`
        : `Approval: ${count} from ${from}${including} (${self}), ${place}.`;
    const approval = {
      mode: policy.mode, policy: policy.mode === 'policy' ? { id: policy.policy ?? null, maximumChangedPaths: policy.maximumChangedPaths ?? null } : null,
      groups, minimum, requiredGroups, selfApproval: policy.mode === 'none' ? false : Boolean(policy.allowSelfApproval),
      where, ownTerminalWhen, text: approvalText,
      groupsText: groups.length ? `Approvers: ${groups.map(groupWords).join('; ')}.` : 'Approvers: none.'
    };
    const questions = questionsOf(phase, author, approval, groupLabel);
    const review = reviewOf(phase, resolved.sourceReview, agents);
    const signOffs = [];
    if (methods.length && policy.mode !== 'none') {
      signOffs.push({ kind: 'evidence', methods, where: 'own-terminal',
        text: `the ${listWords(methods, 'and')} sign-offs of the criteria it delivers, when a criterion is verified that way, given by its approver in their own terminal` });
    }
    for (const entry of omissions.get(step.id) ?? []) {
      signOffs.push({ kind: 'applicability', responsibility: entry.responsibility, group: entry.authority, where: applicabilityInChat ? 'chat' : 'own-terminal',
        text: `before the Story finishes, someone from ${groupLabel(entry.authority)} records why ${entry.responsibility} does not apply (singularity-flow decision applicability${applicabilityInChat ? ', or /sf-decide' : ''})` });
    }
    const signOffText = signOffs.length ? `Sign-offs: ${signOffs.map((entry) => entry.text).join('; ')}.` : 'Sign-offs: none of its own.';
    const map = { author, questions, review, approval, tests, signOffs };
    map.lines = [author.text, questions.text, review.text, approval.text, approval.groupsText, tests.text, signOffText];
    people.set(step.id, map);
  }
  return people;
}

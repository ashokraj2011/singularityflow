/**
 * What waits on one person, item by item [FPL:REQ-008 to REQ-013]: pure, from records already read.
 *
 * Each builder answers yes exactly when the command that records the item would accept this person: the same checks as
 * `approve` (src/state.mjs: the approval group, the required group still missing, the distinct-person rule and the
 * self-approval rule), `decision choose`, `decisions record` (the decision list's own `decidedBy`), `configuration
 * approve` (its self-approval rule) and the Initiative approval (src/initiative-approvals.mjs), never a copy of them.
 * When SFlow cannot tell (approval groups it cannot read, a group that names people only by GitHub login while no login
 * is known here), the item is shown and labelled: hiding it could lose work, and acting on it still goes through the
 * real check [FPL:REQ-009].
 *
 * The words are the person's: a step by its label, a version as "version 2", one question ending in "?", choices named
 * by what they do [FPL:REQ-036]. The decision list's items keep the words decision-plain.mjs gave them.
 */
import {
  approvalRequirementsMet, matchApprovalAuthority, normalizeApprovalAuthorities, remainingRequiredAuthorities, sameApprover,
  storyApprovalView
} from './approval-authority.mjs';
import { approveRoute, returnRoute } from './action-command-map.mjs';
import { adviceForStep } from './step-advice.mjs';
import { mayDecideApproval } from './gateway/work-records.mjs';
import { COULD_NOT_TELL, itemKey, LATER_DECISION_KINDS, stepWords } from './needs-you-list.mjs';

const LOGIN_UNKNOWN = 'Your GitHub account is not known here, so SFlow cannot confirm you are in this group: acting on it checks it.';
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const asQuestion = (value) => { const words = text(value) ?? 'Decide this?'; return /\?$/u.test(words) ? words : `${words.replace(/[.!:;]+$/u, '')}?`; };

/** A short, stable name for text that has no ID of its own. */
function shortName(value) {
  let hash = 2166136261;
  for (const character of String(value)) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619) >>> 0; }
  return hash.toString(36);
}

/** The person's identity as an item names it: their email, else their GitHub login. */
export function identityWords(actor) {
  return text(actor?.email) ?? (text(actor?.login) ? `@${actor.login}` : null);
}

function storyOf(workflow) {
  return { id: workflow.workItem?.id ?? null, title: workflow.workItem?.title ?? workflow.workItem?.id ?? null,
    kind: workflow.workItem?.workType ?? null, task: isTask(workflow), branch: workflow.lineage?.canonicalBranch ?? workflow.workItem?.branch ?? null };
}

/** A task's Story (`work --start`, or a composed task's work type), as safe-command-guidance.mjs isTaskStory reads it. */
function isTask(workflow) {
  const composition = workflow?.resolution?.composition;
  return /^task-[a-z]+$/u.test(String(workflow?.workItem?.workType ?? ''))
    || Boolean(composition && typeof composition === 'object' && typeof composition.kind === 'string' && Array.isArray(composition.steps));
}

/** The approval groups a Story pinned, readable; a malformed registry throws, which is "could not tell". */
function groupLabel(authorities, id) {
  try { return normalizeApprovalAuthorities(authorities)?.[id]?.label ?? id; } catch { return id; }
}

/** A group in `policy` that names its members only by GitHub login, while this person has no login known here. */
function loginOnlyGroup(authorities, policy, actor) {
  if (text(actor?.login)) return false;
  let registry;
  try { registry = normalizeApprovalAuthorities(authorities); } catch { return false; }
  return (policy?.authorities ?? []).some((id) => {
    const group = Object.hasOwn(registry, id) ? registry[id] : null;
    return Boolean(group && !group.allowAnyGitIdentity && group.members.some((member) => member.githubLogin && !member.email));
  });
}

/**
 * Whether `actor` is admitted to decide under `policy`: `{ yours, group, couldNotTell, why }`. A registry SFlow cannot read
 * is "could not tell", as is a login-only group with no login known; neither confers anything, the real check decides.
 */
function admitted(authorities, policy, actor, { preferredAuthorities = [] } = {}) {
  let match;
  try { match = matchApprovalAuthority(authorities, policy, actor, { preferredAuthorities }); } catch {
    return { yours: true, couldNotTell: true, group: null, why: `${COULD_NOT_TELL}: its approval groups cannot be read. Acting on it checks it.` };
  }
  if (match.authorized) return { yours: true, couldNotTell: false, group: match.authorityGroup, label: match.authorityLabel ?? match.authorityGroup };
  if (loginOnlyGroup(authorities, policy, actor)) return { yours: true, couldNotTell: true, group: null, why: `${COULD_NOT_TELL}. ${LOGIN_UNKNOWN}` };
  return { yours: false };
}

/** A card's choice from a route of the action map: its Shell command, and its Copilot command naming the step and Story. */
function choiceOf(id, label, route, subject) {
  return { id, label, command: route?.command ?? null, copilotCommand: route?.skill ? `${route.skill} ${subject}` : null };
}

function submittedEvent(workflow, phaseId) {
  return [...(workflow.history ?? [])].reverse().find((entry) => entry.event === 'phase_submitted' && entry.phase === phaseId) ?? null;
}

/**
 * The approval of the Story's current step, when it waits on this person [FPL:REQ-008, first row]: awaiting approval, an
 * approval group admits them (for a required group still missing once enough people approved), they have not approved this
 * version (SF Guard's `counts` decides which records count), and the self-approval rule allows them. From the record only,
 * so it needs no checkout.
 */
export function stepApprovalItem(workflow, { repository, actor, fallbackAuthorities = null, counts = null } = {}) {
  if (!workflow || workflow.status === 'closed' || workflow.status === 'cancelled') return null;
  const phaseId = workflow.currentPhase ?? null;
  const phase = phaseId ? workflow.phases?.[phaseId] : null;
  if (!phase || phase.status !== 'awaiting_approval') return null;
  const policy = phase.approvalPolicy ?? {};
  const active = (phase.approvals ?? []).filter((entry) => !entry.invalidatedAt && entry.decision === 'approved' && (!counts || counts(entry)));
  // An approval they already gave for this version: `approve` refuses a second one from the same person.
  if (actor && active.some((entry) => sameApprover(entry.actor, actor))) return null;
  if (approvalRequirementsMet(policy, active)) return null;
  const authorities = workflow.resolution?.approvalAuthorities ?? fallbackAuthorities;
  const remaining = remainingRequiredAuthorities(policy, active);
  const admission = admitted(authorities, policy, actor, { preferredAuthorities: remaining });
  if (!admission.yours) return null;
  if (!admission.couldNotTell) {
    // Enough people approved and only a required group is missing: only its members move the step now.
    const view = storyApprovalView(workflow, { counts });
    if (view?.remainingAuthorities?.length && view.distinct >= view.minimum && !view.remainingAuthorities.includes(admission.group)) return null;
    // The self-approval rule, against the step's author as `approve` reads it.
    if (!mayDecideApproval(workflow, phase, actor, { actor: phase.generatedBy ?? null }, fallbackAuthorities)) return null;
  }
  const workId = workflow.workItem.id;
  const label = phase.label ?? phaseId;
  const version = Number(phase.generation ?? 0);
  const submitted = submittedEvent(workflow, phaseId);
  const groups = remaining.length ? remaining : policy.authorities ?? [];
  const groupWords = admission.group ? groupLabel(authorities, admission.group) : groups.map((id) => groupLabel(authorities, id)).join(' or ');
  return {
    key: itemKey(repository?.id, workId, 'approve', phaseId, version),
    kind: 'step-approval', group: 'holds-work',
    repository: repository ? { id: repository.id, name: repository.name ?? repository.id } : null,
    story: storyOf(workflow),
    step: { id: phaseId, label, version },
    question: `Approve ${stepWords(label, version)}?`,
    // Why they are asked, by what the step is for (step-advice.mjs); who approves it follows [owner, 2026-11-28].
    why: admission.couldNotTell ? admission.why
      : `${adviceForStep(workflow, phaseId).decides} ${groupWords ? `You are in ${groupWords}, which approves ${label}.` : `Your approval group approves ${label}.`}`,
    waitingSince: phase.submittedAt ?? submitted?.at ?? null,
    submittedBy: submitted?.actor?.name ?? submitted?.actor?.email ?? null,
    approvals: { received: active.length, required: policy.minimum ?? 1 },
    ...(admission.couldNotTell ? { couldNotTell: true } : {}),
    // From the record alone SFlow has not run the approval's checks; the card runs them where the Story is checked out.
    recommended: null,
    recommendation: 'SFlow checks it when you open the card.',
    checked: [],
    // The approval page's two calls, from the one action-to-command map (action-command-map.mjs).
    choices: [
      choiceOf('approve', `Approve ${stepWords(label, version)}`, approveRoute(workflow, phase), `${phaseId} --work-id ${workId}`),
      choiceOf('return', 'Send it back with a note', returnRoute(workflow, phase), `${phaseId} --work-id ${workId}`)
    ],
    source: 'record'
  };
}

/**
 * The workflow decision waiting after the current step, when its groups admit this person [FPL:REQ-008, second row]:
 * what `decision choose` accepts (the step approved and current, the Story in progress, a group in `by`).
 */
export function workflowDecisionItem(workflow, { repository, actor, fallbackAuthorities = null } = {}) {
  const pending = workflow?.pendingDecision ?? null;
  if (!pending || workflow.status !== 'in_progress') return null;
  const phase = workflow.phases?.[pending.after];
  if (!phase || phase.status !== 'approved' || workflow.currentPhase !== phase.id) return null;
  const authorities = workflow.resolution?.approvalAuthorities ?? fallbackAuthorities;
  const policy = { mode: 'required', authorities: pending.by ?? [], requiredAuthorities: [], minimum: 1 };
  const admission = admitted(authorities, policy, actor);
  if (!admission.yours) return null;
  const workId = workflow.workItem.id;
  const label = phase.label ?? phase.id;
  const options = (pending.options ?? []).filter((option) => text(option?.id));
  return {
    key: itemKey(repository?.id, workId, 'decision-after', phase.id, pending.key),
    kind: 'workflow-decision', group: 'holds-work',
    repository: repository ? { id: repository.id, name: repository.name ?? repository.id } : null,
    story: storyOf(workflow),
    step: { id: phase.id, label, version: Number(phase.generation ?? 0) },
    question: asQuestion(pending.label ?? `Choose what happens after ${label}`),
    why: admission.couldNotTell ? admission.why
      : text(pending.reason) ?? `You are in ${admission.label ?? 'the group'}, which decides what happens after ${label}.`,
    waitingSince: pending.askedAt ?? null,
    ...(admission.couldNotTell ? { couldNotTell: true } : {}),
    // A route a person chooses has no recommendation: SFlow leaves the choice to them.
    recommended: null,
    recommendation: 'SFlow leaves this choice to you.',
    checked: [],
    choices: options.map((option) => ({ id: option.id, label: text(option.label) ?? option.id,
      command: `singularity-flow decision choose ${workId} --fetch --option ${option.id} --reason "<REASON>" --expected ${pending.key}`,
      copilotCommand: `/sf-decide ${workId}` })),
    expected: pending.key,
    source: 'record'
  };
}

/** Whether a decision-list item waits on this person now, as `waitsOnPerson` in commands/decisions.mjs reads it. */
export function waitsHere(item) {
  return Boolean(item && !item.settled && !item.optional && !item.machine && item.decidedBy?.allowed && item.plain?.question
    && item.kind !== 'approval');
}

/** What an item's options let the person do from a card: only those the engine marks available and recordable [REQ-014]. */
function offeredChoices(item, workId) {
  return (item.options ?? []).filter((option) => option.available !== false && option.recordable !== false && option.decidedBy?.allowed !== false)
    .map((option) => ({ id: option.id, label: text(option.label) ?? option.id, ...(option.recommended ? { recommended: true } : {}),
      ...(text(option.words) ? { does: option.words } : {}),
      command: `singularity-flow decisions record ${workId} --choose ${item.id}=${option.id}`, copilotCommand: `/sf-decide ${workId}` }));
}

/**
 * The open decision-list items this person answers [FPL:REQ-008, third row], read in the Story's checkout on this
 * computer (`readPendingList(…, { offline: true })`). A step's next version is its own kind; LATER_KINDS go to Later.
 */
export function decisionItems(packet, workflow, { repository, at = null } = {}) {
  const workId = workflow.workItem.id;
  const phase = workflow.phases?.[workflow.currentPhase] ?? null;
  const since = phase?.submittedAt ?? phase?.startedAt ?? workflow.history?.at(-1)?.at ?? workflow.workItem?.createdAt ?? at;
  return [...(packet?.items ?? []), ...(packet?.offered ?? [])].filter(waitsHere).map((item) => {
    // A take-out of code committed on a Story with no code step is no next version [WCB:REQ-017].
    const kind = item.kind === 'generation-rollover' && !item.details?.committedCode ? 'next-version' : 'decision';
    const choices = offeredChoices(item, workId).sort((left, right) => Number(Boolean(right.recommended)) - Number(Boolean(left.recommended)));
    const recommended = choices.find((choice) => choice.recommended) ?? null;
    return {
      key: itemKey(repository?.id, workId, kind, item.kind, shortName(`${item.kind}\0${item.title ?? ''}\0${JSON.stringify(item.details?.clause ?? item.details?.issue ?? '')}`)),
      kind, group: LATER_DECISION_KINDS.includes(item.kind) ? 'later' : 'holds-work',
      repository: repository ? { id: repository.id, name: repository.name ?? repository.id } : null,
      story: storyOf(workflow),
      step: phase ? { id: phase.id, label: phase.label ?? phase.id, version: Number(phase.generation ?? 0) } : null,
      question: asQuestion(item.plain.question),
      why: text(item.plain.why) ?? text(item.why) ?? '',
      waitingSince: item.details?.raisedAt ?? item.details?.at ?? since ?? null,
      expires: item.details?.expires ?? item.details?.dueAt ?? null,
      recommended: recommended ? { choice: recommended.id, words: text(item.plain.recommended) ?? `SFlow recommends: ${recommended.label}` } : null,
      recommendation: recommended ? `SFlow recommends: ${recommended.label}` : 'SFlow does not recommend it yet',
      checked: item.check ? [text(item.check.label) ?? text(item.check.words) ?? 'SFlow checked it.'].filter(Boolean) : [],
      choices,
      decisionKind: item.kind, decisionItem: item.id,
      source: 'checkout'
    };
  });
}

/** A step's next version waiting for the person's yes (`versionOpening`, the Decide card asks it) [FPL:REQ-008, fourth row]. */
export function nextVersionItem(opening, workflow, { repository } = {}) {
  if (!opening?.question) return null;
  const workId = workflow.workItem.id;
  const phase = workflow.phases?.[opening.phase] ?? null;
  const label = phase?.label ?? opening.phase;
  return {
    key: itemKey(repository?.id, workId, 'next-version', opening.phase, opening.version),
    kind: 'next-version', group: 'holds-work',
    repository: repository ? { id: repository.id, name: repository.name ?? repository.id } : null,
    story: storyOf(workflow),
    step: { id: opening.phase, label, version: Number(opening.version) },
    question: asQuestion(opening.question),
    why: `${label} needs a new version before it goes on; SFlow starts it only if you say yes.`,
    waitingSince: phase?.startedAt ?? null,
    recommended: null,
    recommendation: 'SFlow does not recommend it yet',
    checked: [],
    choices: [
      { id: 'yes', label: `Start ${stepWords(label, opening.version)}`, command: opening.terminal ?? `singularity-flow decisions record ${workId}`,
        copilotCommand: `/sf-decide ${workId}` },
      ...(opening.justAQuestion ? [{ id: 'just-a-question', label: 'No, it was just a question', command: `singularity-flow decisions record ${workId}`,
        copilotCommand: `/sf-decide ${workId}` }] : [])
    ],
    opening: { phase: opening.phase, version: Number(opening.version), justAQuestion: opening.justAQuestion === true },
    source: 'checkout'
  };
}

/**
 * A task's intake waiting for its required answers, for the person who started it [FPL:REQ-008, fifth row]. The one
 * derived question: it is answered in the task's chat.
 */
export function intakeItem(workflow, { repository, actor, required, recorded } = {}) {
  if (!required || recorded || !isTask(workflow) || workflow.status !== 'in_progress') return null;
  const phase = workflow.phases?.[workflow.currentPhase] ?? null;
  if (!phase || !['in_progress', 'rework'].includes(phase.status)) return null;
  const creator = workflow.workItem?.createdBy;
  if (!creator || typeof creator !== 'object' || !actor || !sameApprover(creator, actor)) return null;
  const workId = workflow.workItem.id;
  return {
    key: itemKey(repository?.id, workId, 'intake', phase.id, phase.generation ?? 0),
    kind: 'intake', group: 'holds-work',
    repository: repository ? { id: repository.id, name: repository.name ?? repository.id } : null,
    story: storyOf(workflow),
    step: { id: phase.id, label: phase.label ?? phase.id, version: Number(phase.generation ?? 0) },
    question: `Answer what ${workId} needs to know?`,
    why: `${phase.label ?? 'Its intake'} waits for your answers before it goes on, and you started this task.`,
    waitingSince: phase.startedAt ?? workflow.workItem?.createdAt ?? null,
    recommended: null,
    recommendation: 'Answer in Copilot chat.',
    checked: [],
    choices: [{ id: 'answer', label: 'Answer in Copilot chat', copilotCommand: '/sf-task', command: null }],
    source: 'checkout'
  };
}

/**
 * A configuration proposal this person may approve [FPL:REQ-008, sixth row]: open, valid, and not their own where the
 * repository needs another person (`configuration approve` refuses exactly that). Whether they may push sflow/config is
 * the Git host's to say: when the approval groups name people and not this person, the item is labelled.
 */
export function reviewItem(proposal, { repository, actor } = {}) {
  if (!proposal || proposal.merged || proposal.valid !== true) return null;
  const lower = (value) => String(value ?? '').trim().toLowerCase();
  const own = Boolean((actor?.email && lower(proposal.proposer?.email) === lower(actor.email))
    || (actor?.login && lower(proposal.proposer?.githubLogin ?? proposal.proposer?.login) === lower(actor.login)));
  if (own && proposal.approvalPolicy?.allowSelfApproval === false) return null;
  const approvers = Array.isArray(proposal.approvalPolicy?.approvers) ? proposal.approvalPolicy.approvers : [];
  const named = approvers.some((entry) => (actor?.email && lower(entry.email) === lower(actor.email))
    || (actor?.login && lower(entry.githubLogin) === lower(actor.login)));
  const couldNotTell = approvers.length > 0 && !named && !own;
  const workflows = (proposal.workflows ?? []).map((entry) => text(entry.label) ?? text(entry.id)).filter(Boolean);
  const what = workflows.length ? `the ${workflows.length === 1 ? 'workflow' : 'workflows'} ${workflows.join(', ')}`
    : proposal.repositoryTests ? 'the repository\'s test commands' : 'the team\'s configuration';
  const by = text(proposal.proposer?.name) ?? text(proposal.proposer?.email);
  const command = text(proposal.nextAction) ?? text(proposal.activation?.command)
    ?? `singularity-flow configuration approve ${proposal.branch} --confirm ${proposal.proposalCommit}`;
  return {
    key: itemKey(repository?.id, 'review', proposal.branch),
    kind: 'review', group: 'reviews',
    repository: repository ? { id: repository.id, name: repository.name ?? repository.id } : null,
    story: null, step: null,
    question: `Approve the change to ${what}?`,
    why: couldNotTell ? `${COULD_NOT_TELL}: the approval groups do not name you, and the Git host decides who may approve it.`
      : `${by ? `${by} proposed it` : 'It was proposed'}${own ? ', and you may approve your own change here' : ''}.`,
    waitingSince: proposal.proposalCreatedAt ?? null,
    proposal: { branch: proposal.branch, kind: proposal.kind ?? null, state: proposal.state ?? null, by },
    ...(couldNotTell ? { couldNotTell: true } : {}),
    recommended: null,
    recommendation: 'Read what it changes first.',
    checked: [],
    choices: [
      { id: 'approve', label: 'Approve the change', command, copilotCommand: null },
      { id: 'read', label: 'Read what it changes', command: `singularity-flow workflow proposal ${proposal.branch}`, copilotCommand: null }
    ],
    source: 'configuration'
  };
}

/**
 * An Initiative output, pack or phase this person may approve [FPL:REQ-008, seventh row], from the engine's rule
 * (initiative-approvals.mjs `standing: 'yours'`).
 */
export function initiativeItems(approvals, { repository, initiative } = {}) {
  const id = approvals?.initiativeId || initiative?.state?.initiative?.id;
  if (!id) return [];
  const title = initiative?.state?.initiative?.title ?? id;
  return (approvals.pending ?? []).filter((entry) => entry.standing === 'yours').map((entry) => ({
    key: itemKey(repository?.id, id, 'initiative', entry.id),
    kind: 'initiative-approval', group: 'holds-work',
    repository: repository ? { id: repository.id, name: repository.name ?? repository.id } : null,
    story: { id, title, kind: 'initiative', task: false, branch: null },
    step: { id: entry.phase, label: initiative?.state?.phases?.[entry.phase]?.label ?? entry.phase, version: 0 },
    question: `Approve ${entry.label}?`,
    why: entry.couldNotTell ? `${COULD_NOT_TELL}. ${entry.reason}` : `Your group approves ${entry.label}${entry.selfApproval ? ', which you wrote' : ''}.`,
    waitingSince: entry.waitingSince ?? null,
    ...(entry.couldNotTell ? { couldNotTell: true } : {}),
    recommended: null,
    recommendation: 'SFlow checks it when you approve.',
    checked: [],
    choices: [{ id: 'approve', label: `Approve ${entry.label}`,
      command: `singularity-flow initiative choices begin approve ${id} ${entry.subject === 'phase' ? 'phase' : entry.subject}`,
      copilotCommand: `/sf-initiative-approve ${id}` }],
    initiative: { id, subject: entry.subject, expected: entry.expected },
    source: 'initiative'
  }));
}


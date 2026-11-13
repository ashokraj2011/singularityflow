/**
 * Decisions SFlow or the agent settled for the person [owner, 2026-11-13].
 *
 * A question with one clear answer the evidence names is never asked: the agent or SFlow takes that
 * answer and records it here with its evidence, and the decisions card lists it under "Settled for you"
 * with an undo. Undo turns it back into an ordinary question on that kind's own person route. What
 * stays a person's (approvals, sign-offs, accepted risks, scope and intent amendments, where the Story
 * goes next, applicability) is never settled.
 *
 * `workflow.settledDecisions` is append-only: a settlement `{ id, kind, subject, answer, evidence, by, ... }`
 * and an undo `{ id, undoes, actor, at, reason }`, a person's record SF Guard signs (person-step-catalog.mjs).
 * The pure parts below load nothing; writing commits through the Story's own transaction, loaded when used.
 */
import { countedRecords } from './presence/counted.mjs';
import { SingularityFlowError } from './util.mjs';

/** What each kind settles, and the person's route an undo hands it back to. */
export const SETTLED_KINDS = Object.freeze(['story-selection', 'own-correction', 'node-version', 'test-command', 'plan-accounting']);
const ID = /^STL-[0-9]{3,}$/u;
const BY = Object.freeze(['agent', 'sflow']);

const fail = (message, code = 'SETTLED_DECISION_INVALID', details = undefined) => {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
};
const text = (value, maximum) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
const isUndo = (entry) => Boolean(entry?.undoes);

/** Every settlement, oldest first, each with the undo that counts for it (`undone`), or null. */
export function settledDecisions(workflow) {
  const list = countedRecords(workflow, workflow?.settledDecisions, isUndo);
  const undos = new Map(list.filter(isUndo).map((entry) => [entry.undoes, entry]));
  return list.filter((entry) => !isUndo(entry)).map((entry) => {
    const undo = undos.get(entry.id);
    return { ...entry, undone: undo ? { id: undo.id, at: undo.at, actor: undo.actor, ...(undo.reason ? { reason: undo.reason } : {}) } : null };
  });
}

/** The latest settlement of `kind` for `subject`, undone or not; null when there is none. */
export function settledFor(workflow, kind, subject) {
  return settledDecisions(workflow).filter((entry) => entry.kind === kind && entry.subject === subject).at(-1) ?? null;
}

/** Settlements of `kind` that stand (none undone). */
export function activeSettled(workflow, kind) {
  return settledDecisions(workflow).filter((entry) => entry.kind === kind && !entry.undone);
}

/**
 * Whether `subject` may be settled now: never once a person undid a settlement of it, which made it
 * their question again, and not twice. `'settled'` when one stands, `'undone'`, or `'open'`.
 */
export function settlementState(workflow, kind, subject) {
  const latest = settledFor(workflow, kind, subject);
  return !latest ? 'open' : latest.undone ? 'undone' : 'settled';
}

/** A Node pin the repository named and nobody undid: settled before the tests run, never asked (node-version-settle.mjs). */
export const nodeVersionSubject = (phase, pin) => `Node ${pin.version} for ${phase.id}'s tests`;
export function settleableNodePin(workflow, phase, pin) {
  return Boolean(pin?.source && !pin.replaces) && settlementState(workflow, 'node-version', nodeVersionSubject(phase, pin)) === 'open';
}

const nextId = (workflow) => `STL-${String((workflow.settledDecisions ?? []).length + 1).padStart(3, '0')}`;

/** Append one settlement to the aggregate and return it. Pure: the caller commits. */
export function recordSettledDecision(workflow, { kind, subject, answer, evidence = [], by, at, phase = null, effect = null, actor = null, agent = null }) {
  if (!SETTLED_KINDS.includes(kind)) fail(`A settled decision is one of ${SETTLED_KINDS.join(', ')}; not '${kind}'.`);
  if (!BY.includes(by)) fail('A settled decision is settled by the agent or by SFlow.');
  const named = (Array.isArray(evidence) ? evidence : []).map((entry) => ({ what: text(entry?.what, 500), where: text(entry?.where, 300) }))
    .filter((entry) => entry.what && entry.where);
  // No evidence SFlow can name, no settlement: the question is the person's as before.
  if (!named.length || named.length > 8) fail('A settled decision names one to eight pieces of evidence, each what it is and where it is.');
  if (!text(subject, 300) || !text(answer, 600)) fail('A settled decision names its subject and its answer.');
  if (settlementState(workflow, kind, text(subject, 300)) === 'undone') {
    fail(`${text(subject, 300)} was settled once and a person undid it, so it is theirs to answer now.`, 'SETTLED_DECISION_UNDONE');
  }
  workflow.settledDecisions ??= [];
  const entry = { id: nextId(workflow), kind, subject: text(subject, 300), ...(phase ? { phase } : {}), answer: text(answer, 600), evidence: named, by,
    ...(effect ? { effect: structuredClone(effect) } : {}), ...(actor ? { actor } : {}), ...(agent ? { agent } : {}), at };
  workflow.settledDecisions.push(entry);
  return entry;
}

/** Append a person's undo of settlement `id` and return it. Pure: the caller commits. */
export function recordSettledUndo(workflow, { id, actor, at, reason = null, channel = 'terminal' }) {
  if (!ID.test(String(id ?? ''))) fail('Name the settled decision as STL-001.');
  const found = settledDecisions(workflow).find((entry) => entry.id === id);
  if (!found) fail(`This Story has no settled decision ${id}.`, 'SETTLED_DECISION_UNKNOWN');
  if (found.undone) fail(`${id} is already undone; it is a question for a person again.`, 'SETTLED_DECISION_UNDONE');
  const why = text(reason, 1000);
  workflow.settledDecisions ??= [];
  const entry = { id: nextId(workflow), undoes: id, ...(why ? { reason: why } : {}), actor, channel, at };
  workflow.settledDecisions.push(entry);
  return { undo: entry, settled: found };
}

/** What the evidence says, in one line a person reads. */
export function evidenceWords(entry) {
  return (entry?.evidence ?? []).map((item) => `${item.what} (${item.where})`).join('; ');
}

/** Who settled it, in words. */
export const settledByWords = (entry) => (entry?.by === 'agent' ? 'the agent' : 'SFlow');

/**
 * Where the question goes once undone: its kind's own person route, in words and as a command. An undo
 * never reverses what was done; it hands the question back to the person who would have been asked.
 */
export function reraisedRoute(workflow, entry) {
  const workId = workflow?.workItem?.id ?? '<WORK-ID>';
  const step = entry.phase ?? workflow?.currentPhase ?? '<STEP>';
  const list = { command: `singularity-flow decisions ${workId}`, copilotCommand: `/sf-decide ${workId}` };
  if (entry.kind === 'story-selection') return { words: 'The next /sf-session in this checkout lists the Stories and asks which one to open.',
    command: 'singularity-flow session open', copilotCommand: '/sf-session' };
  if (entry.kind === 'own-correction') return { words: `The author asks you before it corrects ${step} again. The generation it opened stays open, and the one before it stays as published.`,
    command: `singularity-flow phase show ${step} --work-id ${workId}`, copilotCommand: `/sf-phase-documents ${step}` };
  if (entry.kind === 'node-version') return { words: `Which Node ${step}'s tests run on is on the decision list again.`, ...list };
  if (entry.kind === 'test-command') return { words: `${entry.effect?.request ?? 'The requested test command'} waits for a person who approves ${step} on the decision list again.`, ...list };
  return { words: `${entry.effect?.path ?? 'The file'} is a question on the decision list again: say where it belongs.`, ...list };
}

/** After a Node settlement's undo: the file SFlow wrote goes, unless someone changed it since; then it is theirs and stays. */
async function removeSettledFile(root, settled) {
  const [{ readFile, rm }, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
  const file = path.join(root, settled.effect?.file ?? '.nvmrc');
  const wrote = (await readFile(file, 'utf8').catch(() => null)) === `${settled.effect?.version}\n`;
  if (wrote) await rm(file, { force: true });
  return wrote;
}

/** Changes a settlement or its undo makes to the Story beside its record, inside the same transaction. */
async function applyKindEffect(aggregate, entry) {
  if (entry.kind === 'test-command' && entry.phase) (await import('./story-test-commands.mjs')).refreshStoryTestCommands(aggregate, entry.phase);
}

async function transact(root, config, workflow, { label, record, actor, agent = null }) {
  const [{ actorKey, assertNoPendingPublication, transactStory }, { LIFECYCLE_EVENT }] = await Promise.all([
    import('./state-stores.mjs'), import('./lifecycle-event.mjs')]);
  record(structuredClone(workflow), actorKey(actor));
  const { value, publication } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
    actor, agent, authorityGroup: null, payload: { decision: 'settled' }
  }, `[${workflow.workItem.id}][settled] ${label}`, async (aggregate) => {
    await assertNoPendingPublication(root, config, aggregate, 'record a settled decision');
    const recorded = record(aggregate, actorKey(actor));
    const settled = recorded.settled ?? recorded;
    await applyKindEffect(aggregate, settled);
    aggregate.history.push({ at: (recorded.undo ?? recorded).at, actor: actorKey(actor), agent, event: 'decision_settled', phase: aggregate.currentPhase ?? null,
      detail: recorded.undo ? `${recorded.undo.id} undoes ${settled.id} (${settled.kind}): ${settled.subject} is a question for a person again.${recorded.undo.reason ? ` ${recorded.undo.reason}` : ''}`
        : `${settled.id} (${settled.kind}) settled by ${settledByWords(settled)}: ${settled.answer} Evidence: ${evidenceWords(settled)}` });
    return recorded;
  }, { eventFromResult: (recorded) => ({ payload: { decision: 'settled', settled: (recorded.undo ?? recorded).id,
    ...(recorded.undo ? { undoes: recorded.undo.undoes } : { kind: recorded.kind }), reviewPacketSha256: null } }) });
  return { value, publication };
}

/**
 * Record a settlement in its own Story commit. One that already stands for the same subject is returned
 * as it is (`reused`), with nothing written; one a person undid is refused (SETTLED_DECISION_UNDONE).
 */
export async function commitSettledDecision(root, config, workflow, settlement, { actor, agent = null }) {
  const { nowIso } = await import('./util.mjs');
  const subject = text(settlement.subject, 300);
  const standing = settledFor(workflow, settlement.kind, subject);
  if (standing && !standing.undone) return { record: standing, publication: null, reused: true };
  const at = settlement.at ?? nowIso();
  const { value, publication } = await transact(root, config, workflow, { label: `${settlement.kind} ${subject}`.slice(0, 120), actor, agent,
    record: (aggregate, who) => recordSettledDecision(aggregate, { ...settlement, subject, at, actor: who, agent }) });
  return { record: value, publication, reused: false };
}

/**
 * A person's undo [owner, 2026-11-13]: the settlement is marked undone and its question is the person's
 * again, on its own route (`reraised`). Anyone working on the Story may undo; the question it hands back
 * still needs whoever decides it. An agent never undoes for the person (a person step: person-step-catalog.mjs).
 */
export async function undoSettledDecision(root, config, workflow, id, { actor, agent = null, reason = null, channel = 'terminal' } = {}) {
  const { nowIso } = await import('./util.mjs');
  const at = nowIso();
  // A Node or a test command changes what a submitted review ran: its step is returned first, as for a test command decision.
  const found = settledDecisions(workflow).find((entry) => entry.id === id);
  const step = workflow.phases?.[found?.phase];
  if (['node-version', 'test-command'].includes(found?.kind) && step?.status === 'awaiting_approval') {
    fail(`${step.label ?? found.phase} is awaiting approval, and undoing ${id} would change what its submitted review ran. An approver returns it for changes first (/sf-reject); then undo it.`,
      'SETTLED_DECISION_DURING_REVIEW', { phase: found.phase, nextAction: { command: `singularity-flow reject ${found.phase} --work-id ${workflow.workItem.id} --fetch --reason <REASON>`, skill: '/sf-reject' } });
  }
  const { value, publication } = await transact(root, config, workflow, { label: `undo ${id}`, actor, agent,
    record: (aggregate, who) => recordSettledUndo(aggregate, { id, actor: who, at, reason, channel }) });
  // The file a Node settlement wrote goes with it, so the choice on the list is a real one again.
  const removed = value.settled.kind === 'node-version' ? await removeSettledFile(root, value.settled).catch(() => false) : null;
  return { undo: value.undo, settled: value.settled, publication, reraised: reraisedRoute(workflow, value.settled), ...(removed === null ? {} : { removed }) };
}

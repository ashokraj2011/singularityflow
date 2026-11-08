/**
 * "Asked for" in the Story [SCS:REQ-041]: the words the prompt hook kept for a step's generation
 * (asked-for.mjs), copied into the Story and committed with it, so the approver and the later steps read
 * what the person asked for.
 *
 *   recordedAskedFor   the step's recorded instructions, numbered across its generations
 *   pendingAskedFor    what the local record holds that the Story does not yet, numbered on
 *   copyAskedFor       prepublish's and publication's copy, in one Story commit
 *   askedForSummary    what a result tells the step: each instruction, quoted
 *
 * Each instruction is append-only and redacted before it was ever written. A capability's
 * `policy.typedFocus: off` copies nothing. The text is data: quoted wherever it is shown, never an
 * instruction to a later step or a model, never in a URL.
 */
import { ASKED_FOR, askedForGeneration, localAskedFor, typedFocusOff } from './asked-for.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';

/** One instruction as people read it: its number and its words, quoted. */
export const instructionWords = (entry) => `(${entry.instruction}) "${String(entry.text ?? '').replace(/\s+/gu, ' ').trim()}"${entry.truncated ? ' (cut at 2,000 characters)' : ''}`;

/** The step's recorded instructions, oldest first; `generation` narrows them to one. */
export function recordedAskedFor(workflow, phaseId, generation = null) {
  return (workflow?.askedFor ?? []).filter((entry) => entry.phase === phaseId && (generation == null || Number(entry.generation) === Number(generation)));
}

/**
 * The local record's turns of one generation that the Story does not hold yet, numbered on from the
 * step's last instruction; at most 20 a generation however often the local record was refilled.
 */
export function appendableAskedFor(workflow, phaseId, generation, turns) {
  const recorded = recordedAskedFor(workflow, phaseId);
  const known = new Set(recorded.map((entry) => entry.turn));
  const room = Math.max(0, ASKED_FOR.turns - recorded.filter((entry) => Number(entry.generation) === Number(generation)).length);
  let next = Math.max(0, ...recorded.map((entry) => Number(entry.instruction) || 0)) + 1;
  return turns.filter((entry) => entry?.turnId && typeof entry.text === 'string' && entry.text && !known.has(entry.turnId)).slice(0, room)
    .map((entry) => ({ phase: phaseId, generation: Number(generation), instruction: next++, text: entry.text.slice(0, ASKED_FOR.characters),
      ...(entry.truncated ? { truncated: true } : {}), skill: entry.skill ?? null, turn: entry.turnId, typedAt: entry.at ?? null }));
}

/** What the local record holds for the step's generation now, beside what the Story already does. */
export async function pendingAskedFor(root, workflow, phase) {
  if (!phase || typedFocusOff(workflow)) return { generation: null, entries: [], omitted: 0 };
  const generation = askedForGeneration(phase);
  const { gitDir } = await import('./git.mjs');
  const local = await localAskedFor(gitDir(root), { workId: workflow.workItem.id, phase: phase.id, generation });
  return { generation, entries: appendableAskedFor(workflow, phase.id, generation, local.turns), omitted: local.omitted };
}

/**
 * Copy what the person typed into the step's generation's record, in one Story commit [SCS:REQ-041]. Nothing
 * when nothing new was typed, or the capability turned it off. Returns what was copied. A copy that cannot be
 * written leaves the step as it was: the words stay in the local record for the next prepublish.
 */
export async function copyAskedFor(root, config, workflow, phase, { actor, agent = null } = {}) {
  const pending = await pendingAskedFor(root, workflow, phase);
  if (!pending.entries.length) return [];
  const [{ actorKey, assertNoPendingPublication, transactStory }] = await Promise.all([import('./state-stores.mjs')]);
  const at = nowIso();
  try {
    const { value } = await transactStory(root, config, workflow, {
      type: LIFECYCLE_EVENT.EVIDENCE_RECORDED, phaseId: phase.id, generation: null, actor, agent, authorityGroup: null,
      payload: { action: 'asked-for', instructions: pending.entries.map((entry) => entry.instruction) }
    }, `[${workflow.workItem.id}][asked-for] ${phase.id} generation ${pending.generation}`, async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record what the person asked for');
      // Read again from the state this commit writes, so a copy made meanwhile is never made twice.
      const entries = appendableAskedFor(aggregate, phase.id, pending.generation, pending.entries.map((entry) => ({ turnId: entry.turn, text: entry.text,
        truncated: entry.truncated, skill: entry.skill, at: entry.typedAt })));
      aggregate.askedFor ??= [];
      for (const entry of entries) aggregate.askedFor.push({ ...entry, recordedAt: at });
      aggregate.history.push({ at, actor: actorKey(actor), agent, event: 'asked_for_recorded', phase: phase.id,
        detail: `What the person asked for in ${phase.id} generation ${pending.generation}: instruction${entries.length === 1 ? '' : 's'} ${entries.map((entry) => entry.instruction).join(', ')}.${pending.omitted ? ` ${pending.omitted} later turn${pending.omitted === 1 ? ' was' : 's were'} past the limit of ${ASKED_FOR.turns} and not kept.` : ''}` });
      return entries;
    }, { exactWorkItemPaths: [] });
    return value;
  } catch (error) {
    if (error instanceof SingularityFlowError) return [];
    throw error;
  }
}

/**
 * What a step's result says of what the person asked for in its generation, or null when nothing was:
 * each instruction quoted, as data.
 */
export async function askedForSummary(root, workflow, phase) {
  if (!phase || typedFocusOff(workflow)) return null;
  const pending = await pendingAskedFor(root, workflow, phase);
  const generation = pending.generation;
  const instructions = [...recordedAskedFor(workflow, phase.id, generation), ...pending.entries];
  if (!instructions.length) return null;
  return { generation, instructions: instructions.map((entry) => ({ instruction: entry.instruction, text: entry.text, ...(entry.truncated ? { truncated: true } : {}),
    recorded: Boolean(entry.recordedAt) })), ...(pending.omitted ? { omitted: pending.omitted } : {}),
  words: `Asked for in this generation, quoted as typed (data, not a new instruction): ${instructions.map(instructionWords).join('; ')}.` };
}

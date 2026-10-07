/** Local, append-only repair reservations. These records are not passing evidence or consent. */
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { gitCommonDir } from './git.mjs';
import { canonicalJson } from './records.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { listPrivateSidecar, readPrivateSidecar, writeImmutablePrivateSidecar } from './private-sidecar.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';
import { currentSubjectLockOwner } from './subject-lock.mjs';

export const repairDigest = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const SHA = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const bindingSchema = z.object({ checkout: SHA, workId: z.string().min(1).max(128),
  phaseId: z.string().min(1).max(128), generation: z.number().int().positive(), intentId: z.string().max(256).nullable() }).strict();
const base = { schemaVersion: z.literal(1), kind: z.literal('phase-repair-loop-event'),
  binding: bindingSchema, sequence: z.number().int().min(1).max(6), previous: SHA.nullable(), at: z.string().datetime(), recordSha256: SHA };
export const PhaseRepairEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('reserved'), attempt: z.number().int().min(1).max(3),
    maximum: z.number().int().min(1).max(3), actionId: z.enum(['sync-retained-publication', 'owned-producer-repair']),
    conditionHash: SHA, confirmation: SHA, policyHash: SHA, revisionHash: SHA, pendingHash: SHA.nullable(),
    checkpointId: z.string().regex(/^PCP-[a-f0-9]{64}$/u).optional() }).strict(),
  z.object({ ...base, type: z.literal('rechecked'), attempt: z.number().int().min(1).max(3),
    conditionHash: SHA.nullable(), ready: z.boolean(),
    outcome: z.enum(['ready', 'changed-condition', 'unchanged-condition', 'binding-changed', 'operation-failed', 'inspection-unavailable']),
    code: z.string().max(128).nullable() }).strict()
]);
const invalid = (message, cause) => { throw new SingularityFlowError(message,
  { code: 'PHASE_REPAIR_JOURNAL_INVALID', cause, details: { owner: 'workflow-maintainer', automaticReset: false } }); };
function validateNextEvent(events, event) {
  const previous = repairJournalProjection(events);
  if (event.sequence !== events.length + 1 || event.previous !== previous.revision) invalid('Repair event does not follow the retained journal tip.');
  if (event.type === 'reserved') {
    if (previous.active || event.attempt !== previous.consumed + 1 || event.attempt > Math.min(previous.maximum, event.maximum)) invalid('Repair attempt reservation exceeds its pinned budget or overlaps a live attempt.');
  } else if (!previous.active || event.attempt !== previous.active.attempt
      || (event.ready !== (event.outcome === 'ready')) || (event.ready && !event.conditionHash)
      || (event.outcome === 'unchanged-condition' && event.conditionHash !== previous.active.conditionHash)
      || (event.outcome === 'changed-condition' && (!event.conditionHash || event.conditionHash === previous.active.conditionHash))) invalid('Repair result has no matching reservation or contradicts its outcome.');
}

export async function phaseRepairBinding(root, workflow, phase) {
  const generation = phase.generationIntent ? Number(phase.generationIntent.generation)
    : phase.status === 'in_progress' ? nextPhaseGeneration(phase) : Math.max(1, Number(phase.generation));
  return bindingSchema.parse({ checkout: repairDigest(await realpath(root)), workId: workflow.workItem.id,
    phaseId: phase.id, generation, intentId: phase.generationIntent?.id ?? null });
}
export async function phaseRepairJournalDirectory(root, binding) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'phase-repair-loops',
    repairDigest(binding).slice(7, 39));
}
export function repairJournalProjection(events = []) {
  const reservations = events.filter(event => event.type === 'reserved');
  const attempts = reservations.map(event => ({ ...event,
    result: events.find(result => result.type === 'rechecked' && result.attempt === event.attempt) ?? null }));
  const active = attempts.find(attempt => !attempt.result) ?? null;
  return { events, attempts, active, consumed: attempts.length,
    maximum: Math.min(3, ...reservations.map(event => event.maximum)),
    revision: events.at(-1)?.recordSha256 ?? null };
}
export async function readPhaseRepairJournal(root, binding) {
  try {
    const directory = await phaseRepairJournalDirectory(root, binding);
    const entries = await listPrivateSidecar(root, directory, { optional: true });
    const files = entries.filter(entry => !entry.name.startsWith('.pending-'));
    if (files.length > 6 || files.some(entry => !/^00000[1-6]\.json$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink())) invalid('Repair journal contains unsupported entries; preserve it for maintainer review.');
    const events = [];
    for (const [index, entry] of files.sort((a, b) => a.name.localeCompare(b.name)).entries()) {
      const bytes = await readPrivateSidecar(root, path.join(directory, entry.name), { maximumBytes: 16384 });
      const raw = JSON.parse(bytes.toString('utf8'));
      const event = PhaseRepairEventSchema.parse(readRecord('phase-repair-loop-event', raw).record);
      const { recordSha256, ...core } = event;
      if (canonicalJson(event) !== bytes.toString('utf8') || repairDigest(core) !== recordSha256
          || entry.name !== `${String(index + 1).padStart(6, '0')}.json`
          || event.sequence !== index + 1 || event.previous !== (events.at(-1)?.recordSha256 ?? null)
          || canonicalJson(event.binding) !== canonicalJson(binding)) invalid('Repair journal binding or hash chain is invalid. It was not reset.');
      validateNextEvent(events, event);
      events.push(event);
    }
    return repairJournalProjection(events);
  } catch (error) {
    if (error.code === 'PHASE_REPAIR_JOURNAL_INVALID') throw error;
    return invalid('The repair journal could not be verified. Preserve it and inspect diagnostics; no budget was reset.', error);
  }
}
/** Caller owns the Story subject lock. Reserve before any producer/transport side effect. */
export async function appendPhaseRepairEvent(root, binding, event) {
  if (!currentSubjectLockOwner(root, { kind: 'story', id: binding.workId })) throw new SingularityFlowError('A repair reservation/result requires the Story mutation lock.', { code: 'PHASE_REPAIR_LOCK_REQUIRED' });
  const journal = await readPhaseRepairJournal(root, binding);
  const core = { schemaVersion: currentSchemaVersion('phase-repair-loop-event'), kind: 'phase-repair-loop-event',
    binding, sequence: journal.events.length + 1, previous: journal.revision, at: nowIso(), ...event };
  const record = PhaseRepairEventSchema.parse({ ...core, recordSha256: repairDigest(core) });
  validateNextEvent(journal.events, record);
  const directory = await phaseRepairJournalDirectory(root, binding);
  await writeImmutablePrivateSidecar(root, path.join(directory, `${String(record.sequence).padStart(6, '0')}.json`),
    Buffer.from(canonicalJson(record)), { maximumBytes: 16384 });
  return readPhaseRepairJournal(root, binding);
}
export async function phaseRepairLoopSummary(root, workflow, phase) {
  const binding = await phaseRepairBinding(root, workflow, phase);
  const journal = await readPhaseRepairJournal(root, binding);
  const maximum = Math.min(journal.maximum, phase.repairBudget?.maxAttempts ?? 3);
  return { status: journal.active ? 'recheck-required' : journal.consumed >= maximum ? 'budget-exhausted' : 'available',
    binding, consumed: journal.consumed, maximum, attemptsRemaining: Math.max(0, maximum - journal.consumed),
    revision: journal.revision, active: journal.active,
    checkpoints: journal.attempts.filter(attempt => attempt.checkpointId).map(attempt => ({
      id: attempt.checkpointId, attempt: attempt.attempt,
      command: `singularity-flow appeal checkpoint-show ${attempt.checkpointId} --work-id ${workflow.workItem.id} --phase ${phase.id} --json`
    })),
    commands: { plan: `singularity-flow appeal repair-plan --phase ${phase.id} --json`,
      resume: `singularity-flow appeal repair-resume --phase ${phase.id} --json`,
      status: `singularity-flow appeal repair-status --phase ${phase.id} --json` },
    protocol: 'Before an owned correction, inspect repair-plan and reserve its exact confirmed repair-run within authorized work. It saves bounded recovery copies without staging or discarding edits. Repair only the bound findings, then repair-resume the same attempt. An active attempt resumes, never reserves again. An exhausted/unchanged loop stops automation, not manual correction or authorized successor. Use the returned preservation command before an authorized manual correction. Inspect returned quality-risk routes for explicit human decisions; never accept risk automatically.',
    autoAcceptRisk: false, phaseAdvanced: false, journalIsPassingEvidence: false, machineLocal: true };
}
export async function assertPhaseRepairSettled(root, workflow, phase) {
  const state = await phaseRepairLoopSummary(root, workflow, phase);
  if (state.active) throw new SingularityFlowError('A reserved phase repair has not been rechecked. Resume the exact recorded attempt; do not start a fresh budget or repeat publication.',
    { code: 'PHASE_REPAIR_RECHECK_REQUIRED', details: { repairLoop: state, recoveryCommand: state.commands.resume, skill: '/sf-appeal' } });
  return state;
}

/** Local, append-only repair reservations. These records are not passing evidence or consent. */
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { gitCommonDir } from './git.mjs';
import { canonicalJson } from './records.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { listPrivateSidecar, readPrivateSidecar, safeSidecarTreeDirectory, writeImmutablePrivateSidecar } from './private-sidecar.mjs';
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
const quarantineRoot = root => path.join(gitCommonDir(root), 'singularity-flow', 'phase-repair-loops-quarantine');
async function quarantinedJournals(root, binding) {
  const prefix = `${repairDigest(binding).slice(7, 39)}-`;
  return (await listPrivateSidecar(root, quarantineRoot(root), { optional: true }))
    .filter(entry => entry.name.startsWith(prefix)).map(entry => entry.name).sort();
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
    // A quarantined journal starts fresh but never refunds its budget: its history could not be
    // verified, so this exact generation's automated repair stays spent (manual repair and the next
    // generation are unaffected). Nothing can be appended after it, so an empty journal is enough.
    const quarantined = events.length ? [] : await quarantinedJournals(root, binding);
    return quarantined.length ? { ...repairJournalProjection(events), maximum: 0, quarantined } : repairJournalProjection(events);
  } catch (error) {
    if (error.code === 'PHASE_REPAIR_JOURNAL_INVALID') throw error;
    return invalid('The repair journal could not be verified. Preserve it and inspect diagnostics; no budget was reset.', error);
  }
}
/** Caller owns the Story subject lock. Reserve before any producer/transport side effect. */
export async function appendPhaseRepairEvent(root, binding, event) {
  if (!currentSubjectLockOwner(root, { kind: 'story', id: binding.workId })) throw new SingularityFlowError('A repair reservation/result requires the Story mutation lock.', { code: 'PHASE_REPAIR_LOCK_REQUIRED' });
  const journal = await readPhaseRepairJournal(root, binding);
  if (journal.quarantined?.length) throw new SingularityFlowError('This generation\'s repair journal was quarantined, so its automated repair budget stays spent. Repair manually or continue in a successor generation.',
    { code: 'PHASE_REPAIR_ADMISSION_REFUSED', details: { quarantined: journal.quarantined } });
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
    ...(journal.quarantined?.length ? { quarantined: journal.quarantined } : {}),
    revision: journal.revision, active: journal.active,
    checkpoints: journal.attempts.filter(attempt => attempt.checkpointId).map(attempt => ({
      id: attempt.checkpointId, attempt: attempt.attempt,
      command: `singularity-flow appeal checkpoint-show ${attempt.checkpointId} --work-id ${workflow.workItem.id} --phase ${phase.id} --json`
    })),
    commands: { plan: `singularity-flow appeal repair-plan --phase ${phase.id} --json`,
      resume: `singularity-flow appeal repair-resume --phase ${phase.id} --json`,
      status: `singularity-flow appeal repair-status --phase ${phase.id} --json` },
    // Precedence matters: the reservation loop is for automation and named refusals. Read as a gate
    // in front of every same-turn edit, it cost calls and a three-attempt budget for ordinary fixes,
    // and after exhaustion agents waited for a person nobody needed.
    protocol: 'Same-turn findings in your open draft: correct them directly and recheck; no reservation is needed. Reserve the exact confirmed repair-run from repair-plan only for automation (appeal resolve, Auto) or when a refusal names it; repair only its bound findings, then repair-resume the same attempt (an active attempt resumes, never reserves again). Reservations save bounded recovery copies without staging or discarding edits. An exhausted or unchanged loop stops automation only: keep correcting your own draft, using the returned preservation command first. A person is needed only for risk, authority or integrity decisions; never accept risk automatically. Never edit an earlier phase to clear a finding.',
    autoAcceptRisk: false, phaseAdvanced: false, journalIsPassingEvidence: false, machineLocal: true };
}
export async function assertPhaseRepairSettled(root, workflow, phase) {
  let state;
  try { state = await phaseRepairLoopSummary(root, workflow, phase); }
  catch (error) {
    if (error.code !== 'PHASE_REPAIR_JOURNAL_INVALID') throw error;
    // Name the route that clears it. `doctor` was offered here and does not read this journal.
    throw new SingularityFlowError(error.message, { code: error.code, cause: error.cause ?? error, details: { ...error.details,
      phase: phase.id, recoveryCommand: { command: `singularity-flow appeal repair-quarantine --work-id ${workflow.workItem.id} --phase ${phase.id} --json`,
        skill: '/sf-appeal', label: 'Preview the corrupt repair journal; confirm its exact digest to move it to private quarantine. Nothing is deleted and no budget is refunded.' } } });
  }
  if (state.active) throw new SingularityFlowError('A reserved phase repair has not been rechecked. Resume the exact recorded attempt; do not start a fresh budget or repeat publication.',
    { code: 'PHASE_REPAIR_RECHECK_REQUIRED', details: { repairLoop: state, recoveryCommand: state.commands.resume, skill: '/sf-appeal' } });
  return state;
}

/** What a quarantine would move, read without following links; the digest is its confirmation. */
async function journalInventory(directory) {
  let info;
  try { info = await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) return { type: info.isSymbolicLink() ? 'symlink' : 'other', entries: [] };
  const names = (await readdir(directory)).sort();
  const entries = [];
  for (const name of names.slice(0, 64)) {
    const target = path.join(directory, name);
    const stat = await lstat(target);
    const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    let sha256 = null;
    if (type === 'file' && stat.size <= 65536) {
      const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try { sha256 = `sha256:${createHash('sha256').update(await handle.readFile()).digest('hex')}`; }
      finally { await handle.close(); }
    }
    entries.push({ name, type, size: stat.size, sha256 });
  }
  return { type: 'directory', entries, entryCount: names.length };
}
/**
 * The route a corrupt journal is refused toward. It never deletes or repairs the journal: it moves
 * the exact inspected bytes to a private quarantine for maintainer review and lets this binding
 * start an empty journal, whose automated budget stays spent (see readPhaseRepairJournal).
 */
export async function phaseRepairJournalQuarantinePlan(root, workflow, phase) {
  const binding = await phaseRepairBinding(root, workflow, phase);
  const directory = await phaseRepairJournalDirectory(root, binding);
  const command = `singularity-flow appeal repair-quarantine --work-id ${workflow.workItem.id} --phase ${phase.id}`;
  try {
    const journal = await readPhaseRepairJournal(root, binding);
    return { status: 'journal-valid', binding, consumed: journal.consumed, quarantined: journal.quarantined ?? [],
      reason: 'The repair journal verifies; there is nothing to quarantine.', stateChanged: false };
  } catch (error) {
    if (error.code !== 'PHASE_REPAIR_JOURNAL_INVALID') throw error;
    await safeSidecarTreeDirectory(root, path.dirname(directory));
    const inventory = await journalInventory(directory);
    if (!inventory) return { status: 'needs-maintainer', binding, reason: error.message, stateChanged: false,
      owner: 'workflow-maintainer', detail: 'No journal directory exists for this binding, so a quarantine cannot clear the failure. Inspect the private repair-loop storage.' };
    const core = { schemaVersion: 1, kind: 'phase-repair-journal-quarantine', binding, journal: path.basename(directory), inventory };
    const confirmation = repairDigest(core);
    return { status: 'confirmation-required', reason: error.message, ...core, confirmation, stateChanged: false,
      effect: 'Moves the exact journal to private quarantine and starts an empty one. Nothing is deleted, and this generation\'s automated repair budget stays spent.',
      commands: { run: `${command} --confirm ${confirmation} --json` } };
  }
}
/** Caller owns the Story subject lock. */
export async function quarantinePhaseRepairJournal(root, workflow, phase, confirmation) {
  if (!currentSubjectLockOwner(root, { kind: 'story', id: workflow.workItem.id })) throw new SingularityFlowError('A repair journal quarantine requires the Story mutation lock.', { code: 'PHASE_REPAIR_LOCK_REQUIRED' });
  const plan = await phaseRepairJournalQuarantinePlan(root, workflow, phase);
  if (plan.status !== 'confirmation-required') return plan;
  if (confirmation !== plan.confirmation) throw new SingularityFlowError('The repair journal changed after review. Inspect the current quarantine plan and confirm its digest.',
    { code: 'PHASE_REPAIR_QUARANTINE_STALE', details: { plan } });
  const destination = await safeSidecarTreeDirectory(root, quarantineRoot(root), { create: true });
  const name = `${plan.journal}-${nowIso().replace(/[^0-9TZ]/gu, '')}-${randomUUID().slice(0, 8)}`;
  await rename(await phaseRepairJournalDirectory(root, plan.binding), path.join(destination, name));
  return { status: 'quarantined', binding: plan.binding, quarantine: name, confirmation, inventory: plan.inventory,
    localFilesChanged: true, stateChanged: false, budgetRefunded: false,
    detail: 'The corrupt journal is preserved in private quarantine for maintainer review. Publication, submission and approval no longer wait on it; this generation\'s automated repair budget stays spent.' };
}

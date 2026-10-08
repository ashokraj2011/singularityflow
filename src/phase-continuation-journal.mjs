/** Private continuation reservations. Not consent, test evidence, approval or a budget reset. */
import path from 'node:path';
import { z } from 'zod';
import { gitCommonDir } from './git.mjs';
import { canonicalJson } from './records.mjs';
import { listPrivateSidecar, readPrivateSidecar, writeImmutablePrivateSidecar } from './private-sidecar.mjs';
import { currentSubjectLockOwner } from './subject-lock.mjs';
import { repairDigest } from './phase-repair-journal.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';

const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const binding = z.object({ checkout: sha, workId: z.string().min(1).max(128), phaseId: z.string().min(1).max(128),
  generation: z.number().int().positive(), intentId: z.string().max(256).nullable() }).strict();
const common = { schemaVersion: z.literal(1), kind: z.literal('phase-continuation-event'), binding,
  sequence: z.number().int().min(1).max(6), previous: sha.nullable(), at: z.string().datetime(), recordSha256: sha,
  attempt: z.number().int().min(1).max(3) };
const schema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('reserved'), action: z.enum(['publish', 'submit']),
    conditionHash: sha, confirmation: sha }).strict(),
  z.object({ ...common, type: z.literal('observed'), outcome: z.enum(['verified', 'not-verified']),
    code: z.string().max(128).nullable(), diagnostic: z.string().max(2048).nullable() }).strict()
]);
const directory = (root, subject) => path.join(gitCommonDir(root), 'singularity-flow', 'phase-continuations', repairDigest(subject).slice(7));
const fail = () => { throw new SingularityFlowError('The continuation journal is invalid. Preserve it for workflow-maintainer review; no retry budget was reset.',
  { code: 'PHASE_CONTINUATION_JOURNAL_INVALID' }); };
export function continuationJournalProjection(events = []) {
  const attempts = events.filter(e => e.type === 'reserved').map(e => ({ ...e,
    result: events.find(result => result.type === 'observed' && result.attempt === e.attempt) ?? null }));
  return { events, attempts, consumed: attempts.length, active: attempts.find(a => !a.result) ?? null,
    revision: events.at(-1)?.recordSha256 ?? null };
}
function validate(events, record) {
  const current = continuationJournalProjection(events);
  if (record.sequence !== events.length + 1 || record.previous !== current.revision) fail();
  if (record.type === 'reserved') {
    if (current.active || record.attempt !== current.consumed + 1 || current.consumed >= 3
        || current.attempts.some(a => a.action === record.action && a.conditionHash === record.conditionHash)) fail();
  } else if (!current.active || record.attempt !== current.active.attempt) fail();
}
export async function readContinuationJournal(root, subject) {
  try {
    binding.parse(subject);
    const entries = (await listPrivateSidecar(root, directory(root, subject), { optional: true }))
      .filter(e => !e.name.startsWith('.pending-')).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > 6 || entries.some(e => !/^00000[1-6]\.json$/u.test(e.name) || !e.isFile() || e.isSymbolicLink())) fail();
    const events = [];
    for (const [index, entry] of entries.entries()) {
      const bytes = await readPrivateSidecar(root, path.join(directory(root, subject), entry.name), { maximumBytes: 16384 });
      const record = schema.parse(readRecord('phase-continuation-event', JSON.parse(bytes.toString('utf8'))).record);
      const { recordSha256, ...core } = record;
      if (canonicalJson(record) !== bytes.toString('utf8') || recordSha256 !== repairDigest(core)
          || canonicalJson(record.binding) !== canonicalJson(subject)
          || entry.name !== `${String(index + 1).padStart(6, '0')}.json`) fail();
      validate(events, record); events.push(record);
    }
    return continuationJournalProjection(events);
  } catch (error) { if (error.code === 'PHASE_CONTINUATION_JOURNAL_INVALID') throw error; fail(); }
}
export async function appendContinuationEvent(root, subject, event) {
  if (!currentSubjectLockOwner(root, { kind: 'phase-continuation', id: subject.workId })) {
    throw new SingularityFlowError('A continuation needs its coordination lock.', { code: 'PHASE_CONTINUATION_LOCK_REQUIRED' });
  }
  const journal = await readContinuationJournal(root, subject);
  const core = { schemaVersion: currentSchemaVersion('phase-continuation-event'), kind: 'phase-continuation-event', binding: subject,
    sequence: journal.events.length + 1, previous: journal.revision, at: nowIso(), ...event };
  const record = schema.parse({ ...core, recordSha256: repairDigest(core) });
  validate(journal.events, record);
  await writeImmutablePrivateSidecar(root, path.join(directory(root, subject), `${String(record.sequence).padStart(6, '0')}.json`),
    Buffer.from(canonicalJson(record)), { maximumBytes: 16384 });
  return readContinuationJournal(root, subject);
}

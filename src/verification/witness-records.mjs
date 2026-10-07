/**
 * Inspection and visual witnesses, bound to a criterion's contract slot [E2G-018].
 *
 * A person in the group that approves the criterion's delivery inspects one exact file (for an
 * inspection slot, the file the contract names; for a visual slot, the captured image of the screen
 * it names) and answers a fixed checklist: the file states the criterion's observable outcome, it
 * matches the criterion as written, and it is current for this change. The record binds the file's
 * SHA-256, the reviewer and their authority, and is append-only. It witnesses the slot only while
 * every answer is yes and the file still has those bytes; a changed file must be inspected again.
 * Nothing here depends on a step's name. Pure.
 */
import { SingularityFlowError } from '../util.mjs';
import { recordSha256 } from '../records.mjs';

export const WITNESS_CHECKLIST = Object.freeze(['states-the-outcome', 'matches-the-criterion', 'current-for-this-change']);
const AC_ID = /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/u;

function invalid(message, code = 'WITNESS_RECORD_INVALID') {
  return new SingularityFlowError(message, { code });
}

/** A visual/inspection decision belongs to this plan, criterion set and published candidate. */
export function witnessContextBinding(workflow) {
  return `sha256:${recordSha256({ workId: workflow.workItem?.id ?? null,
    phases: (workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})).map((id) => {
      const phase = workflow.phases?.[id] ?? {};
      return { id, specification: phase.specIndex?.indexSha256 ?? null,
        plan: phase.claimMaps?.planned?.sha256 ?? null,
        candidate: phase.deliveryEvidence ? { generation: phase.generation, commit: phase.generationCommit ?? null,
          source: phase.deliveryEvidence.sourceTreeSha256 ?? null, tests: phase.deliveryEvidence.testInputSha256 ?? null } : null };
    }) })}`;
}

/**
 * Append one witness record. `slot` is the contract slot it witnesses; `file` the inspected path
 * with its current `sha256`; `answers` maps every checklist item to yes or no.
 */
export function recordWitness(workflow, { clauseId, slot, file, sha256, answers = {}, reason, actor, authorityGroup, identityAssurance = null, at, plannedClaim = null }) {
  if (!AC_ID.test(String(clauseId ?? ''))) throw invalid('--criterion must name one acceptance criterion, such as ORDER:AC-001.');
  if (!slot || !['inspection', 'visual'].includes(slot.method)) {
    throw invalid(`${clauseId}'s contract has no inspection or visual slot by that name; tests are witnessed by their own runs.`);
  }
  if (slot.method === 'inspection' && file !== slot.witness.path) {
    throw invalid(`${clauseId}'s slot ${slot.slot} inspects ${slot.witness.path}, not ${file}.`);
  }
  const retained = (plannedClaim?.obligations ?? (plannedClaim ? [plannedClaim] : []))
    .filter((entry) => entry.fulfillment === 'evidence');
  if (retained.length) {
    const expected = retained.flatMap((entry) => entry.expectedPaths);
    if (!expected.includes(file)) throw invalid(`${clauseId}'s retained evidence is ${expected.join(', ')}, not ${file}.`);
    const published = Object.values(workflow.phases ?? {}).filter((phase) => phase.generationCommit)
      .flatMap((phase) => phase.deliveryEvidence?.fulfillment?.obligations ?? phase.deliveryEvidence?.fulfillment ?? [])
      .filter((entry) => entry.clauseId === clauseId && entry.fulfillment === 'evidence')
      .flatMap((entry) => entry.paths ?? []).filter((entry) => entry.path === file && entry.state === 'present');
    if (!published.length || published.some((entry) => `sha256:${String(entry.sha256 ?? '').replace(/^sha256:/u, '')}` !== sha256)) {
      throw invalid(`${file} does not match the published retained evidence for ${clauseId}. Preserve the image and publish a reviewed correction before witnessing it.`, 'WITNESS_EVIDENCE_UNPUBLISHED');
    }
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(sha256 ?? ''))) throw invalid(`${file} could not be read to bind its bytes.`);
  const unknown = Object.keys(answers).filter((item) => !WITNESS_CHECKLIST.includes(item));
  const missing = WITNESS_CHECKLIST.filter((item) => !['yes', 'no'].includes(answers[item]));
  if (unknown.length || missing.length) {
    throw invalid(`Answer every checklist item once with --confirm or --deny: ${WITNESS_CHECKLIST.join(', ')}${unknown.length ? `; unknown: ${unknown.join(', ')}` : ''}.`);
  }
  const text = String(reason ?? '').trim();
  if (text.length < 10 || text.length > 1000) throw invalid('Say what you inspected in 10 to 1000 characters with --reason.', 'WITNESS_RECORD_REASON_REQUIRED');
  workflow.witnessRecords ??= [];
  const record = {
    id: `WIT-${String(workflow.witnessRecords.length + 1).padStart(3, '0')}`,
    clauseId, slot: slot.slot, method: slot.method, file, sha256,
    contextBinding: witnessContextBinding(workflow),
    ...(slot.method === 'visual' ? { target: slot.witness.target } : {}),
    checklist: Object.fromEntries(WITNESS_CHECKLIST.map((item) => [item, answers[item]])),
    outcome: WITNESS_CHECKLIST.every((item) => answers[item] === 'yes') ? 'met' : 'failed',
    reason: text, actor, authorityGroup, identityAssurance, at
  };
  workflow.witnessRecords.push(record);
  return record;
}

/**
 * What each criterion slot's latest record proves now. `currentSha256` maps a file to the digest
 * of its bytes at evaluation, or null when it cannot be read.
 */
export function witnessRecordResults(records = [], currentSha256 = new Map(), { contextBinding = null } = {}) {
  const latest = new Map();
  for (const record of records) latest.set(`${record.clauseId}\u0000${record.slot}`, record);
  return [...latest.values()].map((record) => {
    const base = { clauseId: record.clauseId, slot: record.slot, method: record.method, recordId: record.id, file: record.file, reviewer: record.actor };
    const what = record.method === 'inspection' ? 'inspection' : 'visual evidence';
    if (record.contextBinding && record.contextBinding !== contextBinding) {
      return { ...base, status: 'missing', message: `The plan or code candidate changed after ${what} ${record.id}; inspect ${record.file} again for this generation.` };
    }
    if (currentSha256.get(record.file) !== record.sha256) {
      return { ...base, status: 'missing', message: `${record.file} changed after its ${what} ${record.id} for ${record.clauseId}; inspect it again.` };
    }
    if (record.outcome !== 'met') {
      const denied = Object.entries(record.checklist).filter(([, answer]) => answer !== 'yes').map(([item]) => item);
      return { ...base, status: 'failed', message: `${record.actor}'s ${what} ${record.id} found ${record.file} does not satisfy ${record.clauseId} (${denied.join(', ')}).` };
    }
    return { ...base, status: 'met', assurance: 'source-bound' };
  });
}

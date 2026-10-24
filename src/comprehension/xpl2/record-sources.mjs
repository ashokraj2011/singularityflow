/**
 * Recorded runs, witnesses, reuse decisions and generation records for XPL2 views [XPL2 M3].
 *
 * Every read goes through the record's own owner and is bounded. Nothing is written, no test is
 * run, no capture is switched on and no model is called. Each reader returns plain data the pure
 * engine admits as sources; an unreadable or tampered record is reported as such and contributes
 * no fact. Machine-local stores (model invocations, the prompt log) are read only for an explicit
 * generation question and are labelled as this machine's records: another person's or machine's
 * records are never visible here.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { secureRepositoryPath } from '../../util.mjs';

export const XPL2_RECORD_LIMITS = Object.freeze({
  attempts: 40,
  witnesses: 200,
  reuses: 50,
  invocations: 100,
  prompts: 100,
  attemptBytes: 8 * 1024 * 1024
});

const bare = (value) => String(value ?? '').replace(/^sha256:/u, '');

async function readAttemptRecord(root, execution) {
  const binding = {
    commandId: typeof execution?.commandId === 'string' ? execution.commandId : null,
    attemptId: typeof execution?.attemptId === 'string' ? execution.attemptId : null,
    receiptPath: execution.receiptPath,
    receiptSha256: typeof execution?.receiptSha256 === 'string' ? bare(execution.receiptSha256) : null
  };
  try {
    const secured = await secureRepositoryPath(root, execution.receiptPath, { label: 'Recorded test attempt' });
    // A kept attempt not yet admitted into the Story has no Story file; it is not recorded here.
    if (!secured.exists) return { binding, status: 'not-recorded', record: null };
    const bytes = await readFile(secured.absolute);
    if (bytes.length > XPL2_RECORD_LIMITS.attemptBytes) return { binding, status: 'inaccessible', record: null };
    const [{ readRecord }, { attemptSha256 }] = await Promise.all([
      import('../../schema-migrations.mjs'), import('../../verification/attempts.mjs')
    ]);
    const record = readRecord('test-execution', bytes).record;
    // The delivery binds each attempt by the digest of its exact record; anything else is tampered.
    if (!binding.receiptSha256 || attemptSha256(record) !== binding.receiptSha256) {
      return { binding, status: 'integrity-failed', record: null };
    }
    return { binding, status: 'verified', record, sha256: `sha256:${binding.receiptSha256}` };
  } catch (error) {
    return { binding, status: String(error?.code ?? '').startsWith('SCHEMA_') ? 'unsupported' : 'inaccessible', record: null };
  }
}

/**
 * The attempts one phase's delivery bound (its submitted runs, or its preflight runs before
 * submission), each criterion witness judged against them by the verification owner, and every
 * evidence-reuse decision with its owner's current state. The current source is observed for reuse
 * only when a decision exists; the evaluation instant is returned for presentation, never hashed.
 */
export async function readStoryRecordSources(root, workflow, { phaseId = null } = {}) {
  if (!workflow) return null;
  const phase = phaseId ? workflow.phases?.[phaseId] ?? null : null;
  const delivery = phase?.deliveryEvidence ?? null;
  const submitted = delivery?.status === 'ready';
  const bound = ((submitted ? delivery?.testExecutions : delivery?.preflightAttempts) ?? [])
    .filter((execution) => execution && execution.kind !== 'phase-validation-observation' && typeof execution.receiptPath === 'string');
  const attempts = [];
  for (const execution of bound.slice(0, XPL2_RECORD_LIMITS.attempts)) attempts.push(await readAttemptRecord(root, execution));

  const declared = Array.isArray(delivery?.acceptanceCriteria?.witnesses) ? delivery.acceptanceCriteria.witnesses : [];
  let witnesses = [];
  if (declared.length) {
    const { witnessResult } = await import('../../verification/witness-results.mjs');
    const byCommand = new Map(attempts.filter((entry) => entry.record).map((entry) => [entry.binding.commandId, entry.record]));
    const unusable = new Set(attempts.filter((entry) => !entry.record).map((entry) => entry.binding.commandId));
    // The same choice the phase review makes: the witness's own command, else the bound command
    // whose affected roots cover the test source.
    const covering = (testSource) => bound.find((execution) => (execution.affectedRoots ?? []).some((affected) => affected === '.'
      || testSource === affected || String(testSource).startsWith(`${String(affected).replace(/\/$/u, '')}/`)))?.commandId ?? null;
    witnesses = declared.slice(0, XPL2_RECORD_LIMITS.witnesses).map((witness) => {
      const commandId = byCommand.has(witness.commandId) || unusable.has(witness.commandId) ? witness.commandId : covering(witness.testSource);
      // A tampered or unreadable attempt never stands in for a run: the witness is judged with none.
      const attempt = byCommand.get(commandId) ?? null;
      return { witness, commandId, attemptUsable: !unusable.has(commandId), result: witnessResult({ ...witness, commandId }, attempt, { submitted }) };
    });
  }

  const decisions = (workflow.evidenceReuses ?? []).filter((entry) => entry && !entry.revokes).slice(0, XPL2_RECORD_LIMITS.reuses);
  const evaluatedAt = new Date().toISOString();
  let reuses = [];
  if (decisions.length) {
    const reuse = await import('../../evidence-reuse.mjs');
    let observed = null;
    try {
      const { loadDefinition } = await import('../../config.mjs');
      observed = await reuse.observeEvidenceReuseSource(root, await loadDefinition(root), workflow);
    } catch (error) {
      observed = { status: 'unavailable', code: error?.code ?? 'EVIDENCE_REUSE_SOURCE_UNAVAILABLE' };
    }
    reuses = decisions.map((decision) => {
      let state = 'unknown';
      try {
        // A record missing what the owner's rule binds is not judged by guesswork.
        state = decision.attempt?.id && decision.source?.treeSha256 ? reuse.evidenceReuseState(workflow, decision, { at: evaluatedAt, observed }) : 'unknown';
      } catch { state = 'unknown'; }
      return { decision, state, digest: reuse.evidenceReuseSha256(decision) };
    });
  }
  return {
    status: 'available',
    phase: phaseId,
    submitted,
    attempts,
    witnesses,
    reuses,
    omitted: {
      attempts: Math.max(0, bound.length - attempts.length),
      witnesses: Math.max(0, declared.length - witnesses.length),
      reuses: Math.max(0, (workflow.evidenceReuses ?? []).filter((entry) => entry && !entry.revokes).length - decisions.length)
    },
    evaluatedAt
  };
}

/** The Story's own directory, from the repository's definition; the built-in root otherwise. */
async function workItemRelative(root, workId) {
  try {
    const { comprehensionDefinition } = await import('../code-scope.mjs');
    const definition = await comprehensionDefinition(root);
    return path.posix.join(definition.workItemRoot ?? 'singularity/work-items', workId);
  } catch {
    return path.posix.join('singularity/work-items', workId);
  }
}

/**
 * What this machine recorded for one phase generation: model invocation metadata, prompt-log
 * entries (never their prompt text) and the phase's test attempts of that generation. Read only for
 * an explicit `--subject generation` question.
 */
export async function readGenerationSources(root, workflow, { phase, generation }) {
  const workId = workflow?.workItem?.id ?? null;
  if (!workId) return null;
  const result = { invocations: null, prompts: null, attempts: null };
  try {
    const { listModelInvocationAudits } = await import('../../model-runner.mjs');
    const all = (await listModelInvocationAudits(root)).filter((record) => record?.subject?.id === workId
      && record.subject?.phase === phase && Number(record.subject?.generation) === Number(generation));
    result.invocations = {
      status: 'available',
      records: all.slice(0, XPL2_RECORD_LIMITS.invocations),
      omitted: Math.max(0, all.length - XPL2_RECORD_LIMITS.invocations)
    };
  } catch (error) {
    result.invocations = { status: String(error?.code ?? '').startsWith('SCHEMA_') ? 'unsupported' : 'inaccessible', records: [], omitted: 0 };
  }
  try {
    const { listPromptAudits } = await import('../../prompt-audit.mjs');
    const listing = await listPromptAudits(root, { workId, phase, limit: 1000 });
    const records = (listing.records ?? []).filter((record) => Number(record.generation) === Number(generation));
    result.prompts = {
      status: 'available',
      enabled: listing.enabled === true,
      retentionDays: Number.isSafeInteger(listing.retentionDays) ? listing.retentionDays : null,
      integrity: listing.integrity?.status ?? null,
      // Only what the record says about itself; never its prompt text, paths or workspace.
      records: records.slice(0, XPL2_RECORD_LIMITS.prompts).map((record) => ({
        id: record.id, recordedAt: record.recordedAt, source: record.source,
        redactions: Number.isSafeInteger(record.redactions) ? record.redactions : 0,
        invocationId: (record.supportingEvidence ?? []).find((entry) => entry?.kind === 'model-invocation-audit')?.id ?? null
      })),
      omitted: Math.max(0, records.length - XPL2_RECORD_LIMITS.prompts)
    };
  } catch {
    result.prompts = { status: 'inaccessible', enabled: null, retentionDays: null, integrity: null, records: [], omitted: 0 };
  }
  try {
    const { stepAttempts } = await import('../../verification/attempts.mjs');
    const all = (await stepAttempts(root, await workItemRelative(root, workId), workId, phase))
      .filter((attempt) => Number(attempt.generation) === Number(generation));
    result.attempts = { status: 'available', records: all.slice(0, XPL2_RECORD_LIMITS.attempts), omitted: Math.max(0, all.length - XPL2_RECORD_LIMITS.attempts) };
  } catch {
    result.attempts = { status: 'inaccessible', records: [], omitted: 0 };
  }
  return result;
}

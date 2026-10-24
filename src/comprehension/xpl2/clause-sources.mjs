/**
 * The Story records an XPL2 view reads: the clause text owned by a Story's specification artifacts,
 * and (below) its recorded runs, witnesses, reuse decisions, implementation bindings and generation
 * records.
 *
 * Clauses. Bounded reader for the clause text owned by a Story's specification artifacts.
 *
 * The specification artifact is the clause owner; this reader only locates the artifacts that the
 * Story's own phase records name, reads their exact bytes through the repository path guard, and
 * uses the existing `extractClauses` parser. It never searches the repository, follows a caller-
 * supplied path, or repairs a malformed artifact. An unreadable or malformed artifact is reported
 * with its own state so a missing clause is never mistaken for a clause that does not exist.
 *
 * Each clause keeps the clauses its text cites (`dependsOn`), the links between clauses an
 * explanation shows. A later phase's specification cites clauses an earlier artifact declares, so
 * the reader accepts every cited ID as known: whether a citation resolves was checked when the
 * artifact was published, against sources this reader does not see, and one it cannot resolve here
 * shows as a clause not declared here rather than turning a valid artifact into a corrupt one.
 */
import { stepResponsibilities } from '../../phase-roles.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { clauseReferences, extractClauses } from '../../specifications.mjs';
import { secureRepositoryPath } from '../../util.mjs';
import { deliveredContent } from './change-subject.mjs';

export const XPL2_CLAUSE_SOURCE_LIMITS = Object.freeze({
  maximumArtifacts: 8,
  maximumArtifactBytes: 1024 * 1024,
  maximumClauses: 500
});

const ACTIVE_PHASE_STATES = new Set(['approved', 'awaiting_approval', 'in_progress']);

function specificationArtifacts(workflow) {
  const artifacts = [];
  for (const phaseId of workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {})) {
    const phase = workflow?.phases?.[phaseId];
    if (!phase || !ACTIVE_PHASE_STATES.has(phase.status)) continue;
    for (const artifact of phase.artifacts ?? []) {
      if (typeof artifact?.path !== 'string' || !artifact.path) continue;
      if (artifact.kind !== 'requirements' && !stepResponsibilities(workflow, phaseId).includes('scope')) continue;
      if (artifacts.some((entry) => entry.path === artifact.path)) continue;
      artifacts.push({ path: artifact.path, phase: phaseId, phaseStatus: phase.status });
    }
  }
  return artifacts;
}

/**
 * Read the Story's specification artifacts once for one explanation snapshot.
 * Returns one record per artifact with `status`: read, inaccessible, too-large, invalid or omitted.
 */
export async function readStoryClauseSources(root, workflow) {
  if (!workflow) return { status: 'not-applicable', reason: 'no-active-story', artifacts: [] };
  const candidates = specificationArtifacts(workflow);
  const artifacts = [];
  let clauseCount = 0;
  for (const [index, candidate] of candidates.entries()) {
    if (index >= XPL2_CLAUSE_SOURCE_LIMITS.maximumArtifacts) {
      artifacts.push({ ...candidate, status: 'omitted', reason: 'partial-inventory', digest: null, clauses: [] });
      continue;
    }
    let bytes;
    try {
      const secured = await secureRepositoryPath(root, candidate.path, {
        label: 'XPL2 specification source', mustExist: true, type: 'file'
      });
      bytes = await readFile(secured.absolute);
    } catch {
      artifacts.push({ ...candidate, status: 'inaccessible', reason: 'source-inaccessible', digest: null, clauses: [] });
      continue;
    }
    if (bytes.length > XPL2_CLAUSE_SOURCE_LIMITS.maximumArtifactBytes) {
      artifacts.push({ ...candidate, status: 'too-large', reason: 'bounded-delivery', digest: null, clauses: [] });
      continue;
    }
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    let parsed;
    try {
      const text = bytes.toString('utf8');
      parsed = extractClauses(text, { sourcePath: candidate.path, externalClauseIds: clauseReferences(text) });
    } catch {
      artifacts.push({ ...candidate, status: 'invalid', reason: 'integrity-failed', digest, clauses: [] });
      continue;
    }
    const remaining = Math.max(0, XPL2_CLAUSE_SOURCE_LIMITS.maximumClauses - clauseCount);
    const clauses = parsed.slice(0, remaining).map((clause) => ({
      id: clause.id,
      type: clause.type,
      line: clause.source?.line ?? null,
      body: clause.body,
      bodySha256: clause.bodySha256,
      dependsOn: clause.dependsOn ?? []
    }));
    clauseCount += clauses.length;
    artifacts.push({
      ...candidate,
      status: 'read',
      reason: parsed.length > clauses.length ? 'partial-inventory' : null,
      digest,
      clauses
    });
  }
  return {
    status: candidates.length ? 'available' : 'not-applicable',
    reason: candidates.length ? null : 'source-not-recorded',
    artifacts
  };
}

/*
 * Recorded runs, witnesses, reuse decisions and generation records for XPL2 views [XPL2 M3].
 *
 * Every read goes through the record's own owner and is bounded. Nothing is written, no test is
 * run, no capture is switched on and no model is called. Each reader returns plain data the pure
 * engine admits as sources; an unreadable or tampered record is reported as such and contributes
 * no fact. Machine-local stores (model invocations, the prompt log) are read only for an explicit
 * generation question and are labelled as this machine's records: another person's or machine's
 * records are never visible here.
 */
export const XPL2_RECORD_LIMITS = Object.freeze({
  attempts: 40,
  witnesses: 200,
  reuses: 50,
  invocations: 100,
  prompts: 100,
  writes: 50,
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
  const result = { invocations: null, prompts: null, attempts: null, writes: null };
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
    const { listPromptAuditRemovals, listPromptAudits } = await import('../../prompt-audit.mjs');
    const listing = await listPromptAudits(root, { workId, phase, limit: PROMPT_LISTING_LIMIT });
    // What retention or a clear removed is noted without text, so it is not read as never kept.
    const removals = await listPromptAuditRemovals(root, { workId, phase }).catch(() => null);
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
      omitted: Math.max(0, records.length - XPL2_RECORD_LIMITS.prompts),
      // The log lists at most this many entries of the Story's phase, newest first, before the
      // generation is chosen; a full listing may have left older entries of this generation out.
      truncated: (listing.records?.length ?? 0) >= PROMPT_LISTING_LIMIT,
      removed: removals ? {
        status: 'available',
        entries: removals.entries.filter((entry) => Number(entry.generation) === Number(generation))
          .map((entry) => ({ reason: entry.reason, recordedAt: entry.recordedAt, removedAt: entry.removedAt })),
        cleared: removals.cleared.map((entry) => ({ removedAt: entry.removedAt, records: entry.records })),
        complete: removals.complete && removals.unreadable === 0
      } : { status: 'inaccessible', entries: [], cleared: [], complete: false }
    };
  } catch {
    result.prompts = { status: 'inaccessible', enabled: null, retentionDays: null, integrity: null, records: [], omitted: 0 };
  }
  try {
    // Observed writes this machine recorded for the generation while it was open.
    const [{ gitDir }, { readObservedWrites }] = await Promise.all([import('../../git.mjs'), import('./observed-writes.mjs')]);
    const read = await readObservedWrites(gitDir(root), { subject: { workId, phase, generation } });
    result.writes = read.status === 'inaccessible' ? { status: 'inaccessible', records: [], omitted: 0 }
      : { status: 'available', records: read.records.slice(-XPL2_RECORD_LIMITS.writes), omitted: read.omitted + Math.max(0, read.records.length - XPL2_RECORD_LIMITS.writes),
        dropped: read.dropped ?? 0, unreadable: read.unreadable ?? 0, retentionDays: read.retentionDays ?? 0 };
  } catch {
    result.writes = { status: 'inaccessible', records: [], omitted: 0 };
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

const MAXIMUM_BINDING_PHASES = 8;
const PROMPT_LISTING_LIMIT = 1000;
const MAXIMUM_BINDINGS = 500;

/**
 * The implementation bindings every code-delivery phase recorded [E2G-011, XPL2 M4]: each clause
 * bound to the exact changed hunks of its planned paths, the delivered content of each bound file,
 * and the decision the phase's approval recorded about that exact binding set. The bindings are
 * checked against their recorded digest and the delivered change set against its own, through
 * their owners; a record that fails either contributes nothing. Pure over the Story state.
 */
export async function readStoryBindingSources(workflow) {
  if (!workflow?.phases) return null;
  const candidates = Object.entries(workflow.phases)
    .filter(([, phase]) => Array.isArray(phase?.deliveryEvidence?.implementationBindings?.bindings));
  if (!candidates.length) return { status: 'available', phases: [], omitted: 0 };
  const [{ bindingsDigest }, { verifyRepositoryChangeSetIntegrity }] = await Promise.all([
    import('../../implementation-bindings.mjs'), import('../../repository-change-set.mjs')
  ]);
  const order = new Map((workflow.phaseOrder ?? []).map((id, index) => [id, index]));
  candidates.sort(([left], [right]) => (order.get(left) ?? 1e9) - (order.get(right) ?? 1e9) || left.localeCompare(right));
  const phases = candidates.slice(0, MAXIMUM_BINDING_PHASES).map(([phaseId, phase]) => {
    const delivery = phase.deliveryEvidence;
    const recorded = delivery.implementationBindings;
    const bindings = recorded.bindings.slice(0, MAXIMUM_BINDINGS);
    const bindingsIntact = typeof recorded.bindingsSha256 === 'string' && bindingsDigest(recorded.bindings) === recorded.bindingsSha256;
    let changeSetIntact = false;
    try { changeSetIntact = Boolean(delivery.changeSet?.entries) && verifyRepositoryChangeSetIntegrity(delivery.changeSet).valid; }
    catch { changeSetIntact = false; }
    const bound = new Set(bindings.flatMap((binding) => (binding.regions ?? []).map((region) => region.path)));
    const files = {};
    if (changeSetIntact) {
      for (const entry of delivery.changeSet.entries) {
        for (const candidate of [entry.newPath, entry.oldPath]) {
          if (candidate && bound.has(candidate) && !files[candidate]) files[candidate] = deliveredContent(entry);
        }
      }
    }
    // The latest standing approval that decided this exact binding set, if any.
    const approval = [...(phase.approvals ?? [])].reverse().find((entry) => !entry?.invalidatedAt
      && entry?.decision === 'approved' && entry.implementationBindings?.bindingsSha256 === recorded.bindingsSha256) ?? null;
    return {
      phaseId,
      generation: Number.isSafeInteger(delivery.generation) ? delivery.generation : Number.isSafeInteger(phase.generation) ? phase.generation : null,
      bindingsSha256: bindingsIntact ? recorded.bindingsSha256 : null,
      changeSetSha256: changeSetIntact ? delivery.changeSet.digest : null,
      integrity: bindingsIntact && changeSetIntact ? 'verified' : 'failed',
      bindings: bindingsIntact && changeSetIntact ? bindings : [],
      omitted: Math.max(0, recorded.bindings.length - bindings.length),
      files,
      decisions: approval ? {
        generation: Number.isSafeInteger(approval.generation) ? approval.generation : null,
        clauses: Object.fromEntries((approval.implementationBindings.decisions ?? [])
          .filter((entry) => typeof entry?.clauseId === 'string')
          .map((entry) => [entry.clauseId, { decision: entry.decision, reason: entry.reason ?? null }]))
      } : null
    };
  });
  return { status: 'available', phases, omitted: Math.max(0, candidates.length - phases.length) };
}

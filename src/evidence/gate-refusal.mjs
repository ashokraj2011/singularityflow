/**
 * One refusal shape for every gate: gate-refusal v1 [E2G-024].
 *
 * A gate that refuses says which obligations are open and why, what it left untouched, which step
 * is responsible, what recovers it and whether risk acceptance may, and it carries a retry
 * fingerprint. The CLI, VS Code and Copilot render this one record, so no surface re-derives the
 * reasons from a message. An unchanged retry is answered from memory (REFUSAL_UNCHANGED) instead of
 * re-running the gate, so nothing loops on a refusal that cannot have changed.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { changedFiles, head } from '../git.mjs';
import { repositoryGitPath } from '../git-directory.mjs';
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';

export const GATE_REFUSAL_VERSION = 'gate-refusal/v1';
export const GATE_BOUNDARIES = Object.freeze([
  'workflow-validation', 'intake-readiness', 'implementation-entry', 'submission', 'approval', 'consumption', 'terminal'
]);
export const RECOVERY_CLASSES = Object.freeze([
  'repair-implementation', 'repair-test-configuration', 'amend-scope-or-plan', 'rerun-verification',
  're-review', 'decide-applicability', 'accept-risk', 'defer-or-cancel', 'repair-records'
]);

const MAX_LISTED = 50;
const OPEN_STATUSES = new Set(['missing', 'partial', 'pending', 'failed', 'inconclusive']);
const sha256 = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const text = (value, limit = 2000) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null);

/** The open obligations an evaluation found, the ones a refusal names. */
function openObligations(evaluation) {
  return (evaluation?.rows ?? []).flatMap((row) => row.obligations ?? [])
    .filter((obligation) => OPEN_STATUSES.has(obligation.status))
    .slice(0, MAX_LISTED)
    .map((obligation) => ({
      id: obligation.id, responsibility: obligation.responsibility, subject: obligation.subject,
      status: obligation.status, owningSteps: [...(obligation.owningSteps ?? [])],
      // Freshness is current for every obligation this version evaluates; a stale relationship is
      // named here once evidence records carry their upstream digests.
      stale: obligation.facets?.freshness === 'stale' ? { relationship: 'upstream-changed' } : null
    }));
}

/** The one recovery that unblocks the most: decide first, then repair what failed, then the rest. */
function recoveryClassOf({ obligations, findings, nonWaivable }) {
  if (nonWaivable) return 'repair-records';
  const codes = new Set(findings.map((entry) => entry.code).filter(Boolean));
  if (codes.has('APPLICABILITY_DECISION_REQUIRED')) return 'decide-applicability';
  const statuses = (responsibility, ...wanted) => obligations.some((entry) =>
    entry.responsibility === responsibility && wanted.includes(entry.status));
  if (statuses('verify', 'failed') || statuses('implement', 'missing', 'partial')) return 'repair-implementation';
  if (statuses('verify', 'inconclusive', 'missing')) return 'rerun-verification';
  if (statuses('scope', 'missing', 'pending') || statuses('plan', 'missing')) return 'amend-scope-or-plan';
  if (statuses('review', 'pending')) return 're-review';
  return 'repair-implementation';
}

/**
 * Build a gate-refusal v1 record. `evaluation` is the evidence evaluation that blocked (or null for
 * a gate that refused on its own checks), `findings` the reasons outside the obligations (governance
 * errors), and `actions` the recovery commands in the order to try them.
 */
export function gateRefusal({
  code, gate, subject = {}, evaluation = null, findings = [], actions = [],
  checkpoint = null, risk = null, fingerprint = null
}) {
  if (!GATE_BOUNDARIES.includes(gate)) throw new Error(`Unknown gate '${gate}'.`);
  const obligations = openObligations(evaluation);
  const reasons = findings.slice(0, MAX_LISTED).map((entry) => (typeof entry === 'string'
    ? { code: null, message: text(entry) }
    : { code: text(entry?.code, 120), message: text(entry?.message) })).filter((entry) => entry.message);
  const nonWaivable = Boolean(evaluation?.findings?.some((entry) => entry.category === 'records' && entry.blocking));
  const record = {
    schema: GATE_REFUSAL_VERSION,
    code: text(code, 120),
    gate,
    subject: {
      workId: text(subject.workId, 200), repository: text(subject.repository, 200),
      phase: text(subject.phase, 200), generation: Number.isInteger(subject.generation) ? subject.generation : null,
      candidate: text(subject.candidate, 200)
    },
    obligations,
    findings: reasons,
    preserved: { state: 'unchanged', description: 'Nothing was recorded; the Story stays where it was.' },
    checkpoint: text(checkpoint, 200) ?? obligations.find((entry) => entry.owningSteps.length)?.owningSteps.at(-1) ?? null,
    recoveryClass: recoveryClassOf({ obligations, findings: [...(evaluation?.findings ?? []), ...reasons], nonWaivable }),
    actions: actions.slice(0, 10).map((entry) => (typeof entry === 'string' ? { command: entry, confirmation: null }
      : { command: text(entry?.command, 500), confirmation: text(entry?.confirmation, 200) })).filter((entry) => entry.command),
    risk: {
      eligible: Boolean(risk?.eligible) && !nonWaivable,
      authorities: [...(risk?.authorities ?? [])].slice(0, 20),
      maximumDays: Number.isInteger(risk?.maximumDays) ? risk.maximumDays : null
    },
    nonWaivable,
    evaluationInputSha256: text(evaluation?.inputSha256, 80),
    fingerprint: text(fingerprint, 80)
  };
  return Object.freeze(record);
}

/**
 * The closed projection of a gate refusal for the process boundary: only the v1 fields, bounded
 * and typed, whatever else an error's details carry.
 */
export function projectGateRefusal(value) {
  if (!value || typeof value !== 'object' || value.schema !== GATE_REFUSAL_VERSION || !GATE_BOUNDARIES.includes(value.gate)) return null;
  const list = (entries, project, limit = MAX_LISTED) => (Array.isArray(entries) ? entries.slice(0, limit).map(project).filter(Boolean) : []);
  return {
    schema: GATE_REFUSAL_VERSION,
    code: text(value.code, 120),
    gate: value.gate,
    subject: {
      workId: text(value.subject?.workId, 200), repository: text(value.subject?.repository, 200),
      phase: text(value.subject?.phase, 200),
      generation: Number.isInteger(value.subject?.generation) ? value.subject.generation : null,
      candidate: text(value.subject?.candidate, 200)
    },
    obligations: list(value.obligations, (entry) => (entry && typeof entry === 'object' && text(entry.id, 300) ? {
      id: text(entry.id, 300), responsibility: text(entry.responsibility, 40), subject: text(entry.subject, 300),
      status: text(entry.status, 40), owningSteps: list(entry.owningSteps, (step) => text(step, 200), 20),
      stale: entry.stale && typeof entry.stale === 'object' ? { relationship: text(entry.stale.relationship, 80) } : null
    } : null)),
    findings: list(value.findings, (entry) => (entry && text(entry.message) ? { code: text(entry.code, 120), message: text(entry.message) } : null)),
    preserved: { state: text(value.preserved?.state, 40), description: text(value.preserved?.description, 300) },
    checkpoint: text(value.checkpoint, 200),
    recoveryClass: RECOVERY_CLASSES.includes(value.recoveryClass) ? value.recoveryClass : null,
    actions: list(value.actions, (entry) => (entry && text(entry.command, 500) ? { command: text(entry.command, 500), confirmation: text(entry.confirmation, 200) } : null), 10),
    risk: {
      eligible: value.risk?.eligible === true,
      authorities: list(value.risk?.authorities, (entry) => text(entry, 200), 20),
      maximumDays: Number.isInteger(value.risk?.maximumDays) ? value.risk.maximumDays : null
    },
    nonWaivable: value.nonWaivable === true,
    evaluationInputSha256: text(value.evaluationInputSha256, 80),
    fingerprint: text(value.fingerprint, 80)
  };
}

function memoryFile(root, workId) {
  return repositoryGitPath(root, 'singularity-flow', 'refusals', `${String(workId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

/**
 * What a retry would be decided on, taken before anything runs: the operation and its subject, who
 * asks, the commit, and the content of every changed or untracked file. Any edit, commit or other
 * person changes it; an identical retry does not, even after a refused transaction rewrote the same
 * bytes while rolling back.
 */
export async function refusalFingerprint(root, { operation, workId, phase = null, actor = null, args = [] }) {
  const files = [];
  // Content up to a total budget, so a checkout full of large untracked files never slows a retry;
  // past it a file is identified by its size and modification time.
  let budget = 64 * 1024 * 1024;
  for (const file of changedFiles(root).slice(0, 5000)) {
    const absolute = path.join(root, file);
    const stats = await lstat(absolute).catch(() => null);
    if (!stats?.isFile()) { files.push([file, stats ? 'not-a-file' : 'absent']); continue; }
    if (stats.size > budget) { files.push([file, `size:${stats.size}:${Math.trunc(stats.mtimeMs)}`]); continue; }
    budget -= stats.size;
    files.push([file, createHash('sha256').update(await readFile(absolute)).digest('hex')]);
  }
  return sha256({ operation, workId, phase, actor, args, head: head(root), files });
}

/** Refuse at once when this exact retry was refused before and nothing it depends on changed. */
export async function assertRefusalChanged(root, workId, fingerprint) {
  let remembered = null;
  try { remembered = JSON.parse(await readFile(memoryFile(root, workId), 'utf8')); } catch { return; }
  if (remembered?.fingerprint !== fingerprint || !remembered.refusal) return;
  const refusal = projectGateRefusal(remembered.refusal);
  if (!refusal) return;
  const first = refusal.obligations[0]?.id ?? refusal.findings[0]?.message ?? refusal.code;
  throw new SingularityFlowError(
    `Story ${workId} was refused for these reasons at ${remembered.at}, and nothing it depends on has changed since `
    + `(the first: ${first}). Change something first, then retry.`
    + (refusal.actions.length ? `\nRecover:\n${refusal.actions.map((entry) => `  ${entry.command}`).join('\n')}` : ''),
    { code: 'REFUSAL_UNCHANGED', exitCode: 2, details: { gate: { ...refusal, code: 'REFUSAL_UNCHANGED' }, refusedAt: remembered.at } }
  );
}

/** Remember a gate refusal for this exact retry; a later identical retry is answered from it. */
export async function rememberRefusal(root, workId, fingerprint, refusal, at) {
  const file = memoryFile(root, workId);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const memory = {
    schemaVersion: 1, // schema-transient: disposable git-private retry memory; an unreadable or older file is ignored
    fingerprint, at, refusal: { ...refusal, fingerprint }
  };
  await writeFile(file, `${JSON.stringify(memory, null, 2)}\n`, { mode: 0o600 });
}

/** Forget a remembered refusal once the Story moved on. */
export async function forgetRefusal(root, workId) {
  await rm(memoryFile(root, workId), { force: true });
}

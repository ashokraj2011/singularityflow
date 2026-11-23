/**
 * Stop repairing a finding that keeps returning unchanged. `[recoverable-findings M3]`
 *
 * The repair budget counts automated attempts only; an author correcting its own draft has no
 * limit, by design. An Android Story's agent therefore cycled through prepublish, the appeal
 * preflight and recovery for the same CODE_DELIVERY_EVIDENCE_REQUIRED, each routing it back to
 * itself, because its repairs could not change what the check misread. When the same finding comes
 * back a third time after the author changed something, the routes now say to stop and hand the
 * finding to someone other than the author: a dispute where the gate honours one, the finding's
 * documentation, and recovery. The count is machine-local and best effort: it never blocks, never
 * accepts anything and never changes Story state.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedFiles, gitCommonDir, head } from './git.mjs';
import { canonicalJson } from './records.mjs';
import { findingDocumentation } from './finding-catalog.mjs';
import { DISPUTABLE_GATES } from './phase-finding-dispute-schema.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';

export const ESCALATION_THRESHOLD = 3;
const MAX_KEYS = 64;
const digest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

/**
 * What makes two observations "the same finding": its identity, never its wording [SDA-AC-022]. A
 * gate that names its problems by canonical finding ID is that set of IDs; any other finding is its
 * code, path and value. Messages and problem sentences are presentation, so rewording one, or moving
 * a line, keeps the streak.
 */
export function findingFingerprint(findings) {
  return digest([...findings].map((finding) => {
    const code = String(finding?.details?.sourceCode ?? finding?.code ?? 'UNKNOWN');
    const ids = finding?.details?.findingIds;
    return Array.isArray(ids) ? { code, findingIds: [...ids].map(String).sort() }
      : { code, path: finding?.path ?? null, value: finding?.value ?? finding?.details?.clauseId ?? null };
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))));
}

/**
 * Kept outside the repository, in a private per-user directory under the system temporary
 * directory (as the session Git cache is): a read such as prepublish promises to write nothing in
 * the repository, and this count is a hint, not Story state. One file per repository.
 */
function storeFile(root, env = process.env) {
  try {
    const configured = String(env.SINGULARITY_FLOW_FINDING_STREAKS ?? '').trim();
    if (configured.toLowerCase() === 'off') return null;
    const user = typeof process.getuid === 'function' ? process.getuid() : (os.userInfo().username ?? 'user');
    const directory = configured && path.isAbsolute(configured) ? configured
      : path.join(os.tmpdir(), `singularity-flow-${user}`, 'finding-streaks');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // A shared temporary directory: only one this user owns and nobody else can open.
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()
        || (typeof process.getuid === 'function' && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) return null;
    return path.join(directory, `${createHash('sha256').update(path.resolve(gitCommonDir(root))).digest('hex').slice(0, 32)}.json`);
  } catch { return null; }
}

/**
 * Count this observation and return how many times in a row the same finding has been seen for
 * this Story step. With `attempt`, a repeat counts only when the attempt changed (a recheck of the
 * same draft is not a repair); without it, every repeat counts (a refused command retried). With
 * `windowMs`, an observation older than the window starts the count again.
 */
export function observeFindingStreak(root, { workId, phaseId, generation = null, fingerprint, attempt = null, windowMs = null, now = Date.now() }) {
  const file = storeFile(root);
  if (!file || !workId || !phaseId || !fingerprint) return 1;
  const key = `${workId}\u0000${phaseId}\u0000${generation ?? ''}`;
  let store = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) store = parsed;
  } catch { store = {}; }
  const prior = store[key];
  const fresh = windowMs == null || now - Date.parse(prior?.at ?? 0) <= windowMs;
  const same = fresh && prior?.fingerprint === fingerprint;
  const repeated = same && (attempt == null || prior.attempt !== attempt);
  const count = !same ? 1 : repeated ? Number(prior.count ?? 1) + 1 : Number(prior.count ?? 1);
  store[key] = { fingerprint, attempt, count, at: new Date(now).toISOString() };
  const keys = Object.keys(store).sort((left, right) => String(store[right].at).localeCompare(String(store[left].at)));
  for (const stale of keys.slice(MAX_KEYS)) delete store[stale];
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(store)}\n`);
    renameSync(temporary, file);
  } catch {
    try { rmSync(temporary, { force: true }); } catch {}
  }
  return count;
}

/**
 * The step's streaks end: what was refused passed (its check is ready), so a later return of the same finding starts again
 * [review 2026-11-17, kernel #7]. Best effort, like the count.
 */
export function settleFindingStreak(root, { workId, phaseId }) {
  const file = storeFile(root);
  if (!file || !workId || !phaseId) return;
  try {
    const store = JSON.parse(readFileSync(file, 'utf8'));
    const prefix = `${workId}\u0000${phaseId}\u0000`;
    const kept = Object.fromEntries(Object.entries(store ?? {}).filter(([key]) => !key.startsWith(prefix)));
    if (Object.keys(kept).length === Object.keys(store ?? {}).length) return;
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(kept)}\n`);
    renameSync(temporary, file);
  } catch { /* nothing kept, nothing to settle */ }
}

/**
 * A cheap fingerprint of the author's current attempt: the draft's own fingerprint, HEAD, and the
 * size and time of every changed file. An edit changes it; a recheck with nothing changed does not.
 */
export function worktreeAttempt(root, draftFingerprint = null) {
  try {
    const stamps = changedFiles(root).slice(0, 2000).map((relative) => {
      try { const info = statSync(path.join(root, relative)); return [relative, info.size, info.mtimeMs]; }
      catch { return [relative, null, null]; }
    });
    return digest({ draftFingerprint, head: head(root), stamps });
  } catch { return digest({ draftFingerprint }); }
}

/** The escalation for a finding seen `count` times in a row, or null below the threshold. */
export function findingEscalation({ count, code, workId, phaseId, overrideKey = null }) {
  if (!(count >= ESCALATION_THRESHOLD)) return null;
  const documentation = findingDocumentation({ code });
  const disputable = DISPUTABLE_GATES.includes(code);
  const work = workId ? ` --work-id ${workId}` : '';
  const routes = [
    ...(disputable ? [{ kind: 'dispute', owner: 'phase-approval-authority',
      command: `singularity-flow appeal risk-prepare${work} --phase ${phaseId} --finding ${code} --evidence-file <PATH> --expires <YYYY-MM-DD> --reason <why> --json`,
      detail: 'Prepare a dispute with the evidence; one of the step\'s approvers reviews it live and may accept it as an exception for this exact candidate.' }] : []),
    // A finding its gate lets a person override (finding-overrides.mjs) [owner, 2026-11-23].
    ...(overrideKey && workId ? [{ kind: 'override', owner: 'phase-approval-authority',
      command: `singularity-flow decision override-finding ${workId} --phase ${phaseId} --finding ${overrideKey} --reason "<REASON>"`,
      detail: 'If the check is wrong, someone the step\'s approval rules name overrides this exact finding with their own reason, on the decision list or in their terminal; recorded as overridden, never passed.' }] : []),
    { kind: 'documentation', owner: 'reader', command: documentation.command,
      detail: 'What the finding means, its usual causes, and who else can act.' },
    // The step's own read (the map's inspect form), never recovery: a repeated finding is not damage, and the instruction
    // says to stop recovering [D4]. Written here: this module is on the agent's output path, which never loads the map.
    { kind: 'inspect', owner: phaseId, command: `singularity-flow phase show ${phaseId} --json`,
      detail: 'The step as it stands now; nothing changes.' }
  ];
  return Object.freeze({
    required: true, repeated: count, code, documentation,
    instruction: `The same ${code} finding has returned ${count} times after repairs; repeating the repair cannot pass. `
      + 'Stop repairing, prepublishing, recovering or re-running the appeal preflight for it. Tell the person what is blocked and hand it to someone other than the author: '
      + (disputable ? 'prepare a dispute with the evidence for the step\'s approvers, or ' : '')
      + (overrideKey && workId ? 'someone the step\'s approval rules name may override it with their reason on the decision list, or ' : '')
      + 'follow the route its documentation names. Nothing was accepted or waived.',
    routes: Object.freeze(routes)
  });
}

/**
 * A refusal envelope with the escalation added when the same phase refusal has returned after repairs: its first
 * step becomes "stop and read the finding's entry", and the plan carries the routes for someone
 * other than the author. Anything else is returned unchanged. A repeat counts only when the author's attempt changed, as
 * prepublish counts it: the same command retried on the same work is no repair [review 2026-11-17, kernel #7]. `waits`: the
 * refusal stops at a person's or the environment's step (workflow-task-outcome.mjs refusalOutcome), which no repair
 * reaches, so it is never escalated as a repair that cannot pass.
 */
export function escalateRefusalEnvelope(envelope, error, root = process.cwd(), { waits = false } = {}) {
  const plan = envelope?.remediationPlan;
  const context = plan?.context;
  const code = envelope?.error?.code ?? error?.code ?? null;
  // A refusal that waits (a test run that may still be going, a person's or the environment's step) is no repair that keeps failing.
  if (context?.scope !== 'phase' || !context.phaseId || !code || waits || error?.details?.waits === true) return envelope;
  const count = observeFindingStreak(root, { workId: context.workId ?? root, phaseId: context.phaseId,
    generation: error?.details?.generation ?? null, attempt: worktreeAttempt(root),
    fingerprint: findingFingerprint([{ code, details: error?.details, message: error?.message }]) });
  const escalation = findingEscalation({ count, code, workId: context.workId ?? null, phaseId: context.phaseId });
  if (!escalation) return envelope;
  // The same route fields every other plan step carries, so no surface prints a missing Copilot route.
  const guidance = safeCommandGuidance({ argv: [...escalation.documentation.argv] });
  const step = Object.freeze({ id: 'escalate-repeated-finding',
    label: `Stop: ${code} has returned ${count} times; repeating the repair cannot pass. Read its entry, then hand it to someone other than the author.`,
    command: guidance?.command ?? escalation.documentation.command, argv: [...escalation.documentation.argv],
    executable: guidance?.executable ?? 'singularity-flow', skill: guidance?.skill ?? null,
    copilotCommand: guidance?.copilotCommand ?? null, copyable: guidance?.copyable ?? false,
    platformCommands: guidance?.platformCommands ?? null, automatic: false });
  return { ...envelope, remediationPlan: Object.freeze({ ...plan, escalation,
    // Agents follow context.strategy; "repair in place" is exactly what can no longer help.
    context: Object.freeze({ ...context, strategy: 'escalate-repeated-finding' }),
    steps: Object.freeze([step, ...plan.steps]) }) };
}

/**
 * Reused test evidence: a person who approves a step decides that a test run an earlier step of the
 * Story recorded stands for this step, while the source it ran on is unchanged.
 *
 *   singularity-flow decision evidence-reuse [WORK-ID] --phase PHASE --from-attempt TA-... --reason TEXT [--expires YYYY-MM-DD]
 *   singularity-flow decision evidence-reuse [WORK-ID] --revoke ERU-001 --reason TEXT
 *
 * A step whose output is test evidence but which records no run of its own (its packet says
 * `no-governed-tests-in-this-packet`) can only cite runs that others recorded. This decision makes
 * such a citation explicit, bounded and attributable, and it never says the reusing step ran tests:
 *
 * - Only a retained, passed, structured attempt of an earlier step qualifies. The attempt is bound
 *   by that step's approved submission at its current generation; its bytes at the submission's
 *   evidence commit match the digest the submission bound; it is that step's own attempt, ran
 *   against the candidate the submission retained, passed with structured counts that meet the
 *   Story's pinned minimums, and skipped no test.
 * - The decision binds the attempt ID, the digest of the attempt record, the attempt's source commit
 *   and the application source tree digest it ran on. That digest is the engine's own
 *   `sourceTreeHash`: every repository path except the Story's own work-item paths and the other
 *   configured singularity roots (`applicationPathContext`), with separately hashed test inputs
 *   bound by `testInputTreeHash`. The decision is refused while the current tree differs from it,
 *   naming the changed paths (bounded), and the routes are a repair (return to the code step) or a
 *   fresh recorded run.
 * - Every read re-checks the binding against the current source and the attempt record, and that the
 *   step which recorded the run is still approved at that generation. A decision whose binding no
 *   longer holds lapses there and then, with nothing written: it is reported as lapsed and
 *   satisfies nothing.
 * - Wherever it is shown it reads `reused: TA-... recorded by <step> at <commit>; approved for
 *   <PHASE> by <who> (ERU-NNN), not a run by <PHASE>`.
 *
 * Decisions and revocations are append-only in `workflow.evidenceReuses`, stored as test-run risk
 * decisions are (src/test-run-risk.mjs); they are not a registered record family.
 *
 * Gates read `activeEvidenceReuse` (pure, given an observation of the current source) or
 * `evidenceReuseFor` (which observes it): the decisions that apply to a step now, the decisions
 * that lapsed, and the clause IDs the reused attempts cover. Nothing here relaxes any other check.
 */
import { recordSha256 } from './records.mjs';
import { countedRecords } from './presence/counted.mjs';
import { SingularityFlowError } from './util.mjs';

export const MAX_EVIDENCE_REUSE_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
const ATTEMPT_ID = /^TA-[a-f0-9]{20}$/u;
const REUSE_ID = /^ERU-\d{3,}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const TREE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PATH_LIMIT = 20;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;

const bare = (value) => String(value ?? '').replace(/^sha256:/u, '');

function textBetween(value, minimum, maximum, option, what) {
  const text = String(value ?? '').trim();
  if (text.length < minimum || text.length > maximum) {
    throw new SingularityFlowError(`Say ${what} in ${minimum} to ${maximum} characters with ${option}.`, {
      code: 'EVIDENCE_REUSE_INVALID'
    });
  }
  return text;
}

/** The digest a gate or record binds a decision by. */
export function evidenceReuseSha256(decision) {
  return `sha256:${recordSha256(decision)}`;
}

/** The command a person who approves `phaseId` runs to reuse one recorded attempt for it. */
export function evidenceReuseDecisionCommand(workflow, { phaseId, attemptId }) {
  return `singularity-flow decision evidence-reuse ${workflow?.workItem?.id ?? '<WORK-ID>'} --phase ${phaseId}`
    + ` --from-attempt ${attemptId} --reason "<why the recorded run stands for this step>"`;
}

/** The decision recorded under `id` (never a revocation), or null. */
export function evidenceReuseDecision(workflow, id) {
  return countedRecords(workflow, workflow?.evidenceReuses).find((entry) => !entry.revokes && entry.id === id) ?? null;
}

/**
 * Whether one decision applies now: `active`, or why it lapsed — `revoked`, `expired`, `superseded`
 * (the step that recorded the run was reopened, so the run is no longer its retained evidence),
 * `unobserved` (the current source was not observed, so nothing is assumed), `source-changed` (the
 * application source or its test inputs differ from the tree the attempt ran on) or
 * `attempt-changed` (the attempt record no longer has the bytes the decision bound). `observed`
 * comes from `observeEvidenceReuseSource`, or from a caller that already holds the current tree
 * digests (then the attempt record is not re-read).
 */
export function evidenceReuseState(workflow, decision, { at, observed = null } = {}) {
  if (countedRecords(workflow, workflow?.evidenceReuses).some((entry) => entry.revokes === decision.id)) return 'revoked';
  if (decision.expiresAt && new Date(decision.expiresAt) <= new Date(at ?? Date.now())) return 'expired';
  const producer = workflow?.phases?.[decision.attempt?.phase];
  if (producer?.status !== 'approved' || Number(producer.generation) !== Number(decision.attempt?.generation)) return 'superseded';
  if (observed?.status !== 'available' || !TREE_DIGEST.test(String(observed.sourceTreeSha256 ?? ''))) return 'unobserved';
  if (observed.sourceTreeSha256 !== decision.source?.treeSha256
      || (observed.testInputSha256 ?? null) !== (decision.source?.testInputSha256 ?? null)) return 'source-changed';
  if (observed.attempts) {
    const seen = observed.attempts[decision.attempt?.id];
    if (seen === undefined) return 'unobserved';
    if (seen !== decision.attempt?.sha256) return 'attempt-changed';
  }
  return 'active';
}

/** The honest label of an active decision: whose run it is and who reused it for what (its commit stays in the record). */
export function evidenceReuseLabel(decision) {
  return `reused: ${decision.attempt.id} recorded by ${decision.attempt.phase};`
    + ` approved for ${decision.phase} by ${decision.actor} (${decision.id}), not a run by ${decision.phase}`;
}

const LAPSED = {
  revoked: () => 'it was revoked',
  expired: (decision) => `it expired on ${String(decision.expiresAt).slice(0, 10)}`,
  superseded: (decision) => `${decision.attempt.phase} was reopened, so the run is no longer its retained evidence`,
  'source-changed': () => 'the application source or its test inputs changed after that run',
  'attempt-changed': () => 'the attempt record no longer has the bytes the decision bound',
  unobserved: () => 'the current source could not be read, so its binding was not confirmed'
};

/** What a lapsed decision says: why it no longer applies, and that the reusing step still has no run of its own. */
export function lapsedEvidenceReuseLabel(decision, state) {
  return `${decision.id} no longer applies (${(LAPSED[state] ?? LAPSED.unobserved)(decision)}):`
    + ` ${decision.attempt.id} was recorded by ${decision.attempt.phase},`
    + ` and no run by ${decision.phase} is recorded. A fresh recorded run, or a new decision on an unchanged source, is needed.`;
}

function decisionView(decision, state) {
  return {
    id: decision.id, phase: decision.phase, state,
    attemptId: decision.attempt.id, recordedBy: decision.attempt.phase, commandId: decision.attempt.commandId,
    sourceCommit: decision.source.commit, tests: decision.attempt.tests ?? null,
    actor: decision.actor, authorityGroup: decision.authorityGroup, at: decision.at, expiresAt: decision.expiresAt ?? null,
    clauses: [...(decision.clauses ?? [])],
    // Stated in the data as well as the words: the reusing step ran nothing.
    runByThisStep: false,
    label: state === 'active' ? evidenceReuseLabel(decision) : lapsedEvidenceReuseLabel(decision, state)
  };
}

/** The latest decision for each (step, attempt): an earlier one on the same pair is history. */
function governingDecisions(workflow, phases) {
  const latest = new Map();
  for (const entry of countedRecords(workflow, workflow?.evidenceReuses)) {
    if (entry.revokes || !phases.has(entry.phase)) continue;
    latest.set(`${entry.phase}\u0000${entry.attempt?.id}`, entry);
  }
  return [...latest.values()];
}

function scopedPhases(workflow, phaseId, through) {
  if (!through) return new Set([phaseId]);
  const order = workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
  const position = order.indexOf(phaseId);
  return new Set(position < 0 ? [phaseId] : order.slice(0, position + 1));
}

/**
 * The evidence-reuse decisions that apply to `phaseId` at `at`, for gates: `active` (with the clause
 * IDs their attempts cover, in `clauseIds`) and `lapsed`, each with its honest `label`. With
 * `through`, decisions for every step up to and including `phaseId` are read too, which is what a
 * conformance step's inputs consist of. Pure; without an `observed` source no decision is active.
 */
export function activeEvidenceReuse(workflow, phaseId, { at, observed = null, through = false } = {}) {
  const active = [];
  const lapsed = [];
  for (const decision of governingDecisions(workflow, scopedPhases(workflow, phaseId, through))) {
    const state = evidenceReuseState(workflow, decision, { at, observed });
    (state === 'active' ? active : lapsed).push(decisionView(decision, state));
  }
  return { phase: phaseId, through, active, lapsed,
    clauseIds: [...new Set(active.flatMap((entry) => entry.clauses))].sort() };
}

/**
 * Record a decision on the aggregate. The caller verified the attempt and its source binding
 * (`prepareEvidenceReuse`) and checked authority; this re-checks the shape it was handed.
 */
export function recordEvidenceReuse(workflow, { phaseId, candidate, reason, expires = null, actor, authorityGroup, identityAssurance = null, at }) {
  const attempt = candidate?.attempt;
  const source = candidate?.source;
  if (!ATTEMPT_ID.test(String(attempt?.id ?? '')) || !DIGEST.test(String(attempt?.sha256 ?? ''))
      || !COMMIT.test(String(source?.commit ?? '')) || !TREE_DIGEST.test(String(source?.treeSha256 ?? ''))
      || !workflow?.phases?.[phaseId] || !workflow.phases[attempt.phase]) {
    throw new SingularityFlowError('The evidence to reuse was not verified.', { code: 'EVIDENCE_REUSE_INVALID' });
  }
  const text = textBetween(reason, 20, 1000, '--reason', 'why the recorded run stands for this step');
  let expiresAt = null;
  if (expires != null) {
    const expiry = /^\d{4}-\d{2}-\d{2}$/u.test(String(expires)) ? new Date(`${expires}T23:59:59.999Z`) : null;
    const now = new Date(at);
    if (!expiry || Number.isNaN(expiry.getTime()) || expiry <= now || expiry - now > MAX_EVIDENCE_REUSE_DAYS * DAY) {
      throw new SingularityFlowError(`--expires must be a date after today and at most ${MAX_EVIDENCE_REUSE_DAYS} days ahead (YYYY-MM-DD).`, {
        code: 'EVIDENCE_REUSE_INVALID'
      });
    }
    expiresAt = expiry.toISOString();
  }
  // The same attempt on the same tree for the same step is already decided while that decision stands.
  const standing = governingDecisions(workflow, new Set([phaseId])).find((entry) => entry.attempt?.id === attempt.id);
  if (standing && !['revoked', 'expired', 'superseded'].includes(evidenceReuseState(workflow, standing, { at, observed: { status: 'available',
    sourceTreeSha256: source.treeSha256, testInputSha256: source.testInputSha256 ?? null } }))) {
    throw new SingularityFlowError(`${standing.id} already reuses ${attempt.id} for ${phaseId}.`, {
      code: 'EVIDENCE_REUSE_ALREADY_RECORDED', details: { phase: phaseId }
    });
  }
  workflow.evidenceReuses ??= [];
  const decision = {
    id: `ERU-${String(workflow.evidenceReuses.filter((entry) => !entry.revokes).length + 1).padStart(3, '0')}`,
    phase: phaseId,
    attempt: {
      id: attempt.id, sha256: attempt.sha256, path: attempt.path, phase: attempt.phase,
      generation: attempt.generation, commandId: attempt.commandId, status: attempt.status,
      tests: attempt.tests, completedAt: attempt.completedAt ?? null
    },
    source: { commit: source.commit, treeSha256: source.treeSha256, testInputSha256: source.testInputSha256 ?? null },
    clauses: [...new Set(candidate.clauses ?? [])].sort(),
    reason: text, expiresAt, actor, authorityGroup, identityAssurance, at
  };
  workflow.evidenceReuses.push(decision);
  return decision;
}

/** Revoke a decision; the decision stays, and so does the revocation. */
export function recordEvidenceReuseRevocation(workflow, { reuseId, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const target = REUSE_ID.test(String(reuseId ?? '')) ? evidenceReuseDecision(workflow, reuseId) : null;
  if (!target) throw new SingularityFlowError(`This Story has no evidence-reuse decision ${reuseId}.`, { code: 'EVIDENCE_REUSE_UNKNOWN' });
  if (countedRecords(workflow, workflow.evidenceReuses).some((entry) => entry.revokes === reuseId)) {
    throw new SingularityFlowError(`${reuseId} is already revoked.`, { code: 'EVIDENCE_REUSE_REVOKED' });
  }
  const text = textBetween(reason, 20, 1000, '--reason', 'why the decision is revoked');
  const revocation = { revokes: reuseId, phase: target.phase, attemptId: target.attempt.id, reason: text,
    actor, authorityGroup, identityAssurance, at };
  workflow.evidenceReuses.push(revocation);
  return revocation;
}

// ---------------------------------------------------------------------------------------------
// Reading the repository. Heavy modules load on first use, so a step with no decision pays nothing.

function ineligible(attemptId, phaseId, reason) {
  return new SingularityFlowError(`${attemptId} cannot be reused for ${phaseId}: ${reason}.`, {
    code: 'EVIDENCE_REUSE_NOT_ELIGIBLE', details: { phase: phaseId }
  });
}

/** The step whose submission bound `attemptId` and the bound entry, wherever it is in the route. */
function boundExecution(workflow, attemptId) {
  for (const id of workflow?.phaseOrder ?? []) {
    const phase = workflow.phases?.[id];
    const execution = (phase?.deliveryEvidence?.testExecutions ?? []).find((entry) => entry?.attemptId === attemptId);
    if (execution) return { producer: phase, execution };
  }
  return null;
}

function readCommittedJson(root, gitModule, commit, relative, maximumBytes) {
  const bytes = gitModule.exactFileAtObject(root, commit, relative, { regularOnly: true, maximumBytes });
  if (!bytes) return { missing: true };
  try { return { value: JSON.parse(bytes.toString('utf8')) }; } catch { return { invalid: true }; }
}

/**
 * Verify that `attemptId` is a retained, passed, structured test attempt of a step before
 * `phaseId`, the way the engine checks a submission's attempts, and return what a decision binds.
 * Refuses `EVIDENCE_REUSE_NOT_ELIGIBLE` naming the first reason it is not.
 */
export async function verifyReusableAttempt(root, config, workflow, { phaseId, attemptId }) {
  const consumer = workflow?.phases?.[phaseId];
  if (!consumer) throw new SingularityFlowError(`Story ${workflow?.workItem?.id} has no step ${phaseId}.`, { code: 'EVIDENCE_REUSE_INVALID' });
  if (!ATTEMPT_ID.test(String(attemptId ?? ''))) {
    throw new SingularityFlowError('Name the recorded attempt with --from-attempt TA-... (20 hexadecimal characters).', { code: 'EVIDENCE_REUSE_INVALID' });
  }
  const order = workflow.phaseOrder ?? [];
  const bound = boundExecution(workflow, attemptId);
  if (!bound) {
    throw ineligible(attemptId, phaseId, 'no step of this Story bound it at its submission; only a run a step\'s submission retained can be reused (a preflight attempt, or a run kept only in this checkout, cannot)');
  }
  const { producer, execution } = bound;
  if (producer.id === phaseId) throw ineligible(attemptId, phaseId, `it is ${phaseId}'s own run, which needs no reuse`);
  if (order.indexOf(producer.id) > order.indexOf(phaseId)) throw ineligible(attemptId, phaseId, `${producer.id} comes after ${phaseId}`);
  if (producer.status !== 'approved' || producer.deliveryEvidence?.status !== 'ready') {
    throw ineligible(attemptId, phaseId, `${producer.id} is ${producer.status}; only an approved step's submitted runs can be reused`);
  }
  if (execution.kind === 'phase-validation-observation') throw ineligible(attemptId, phaseId, 'it is a risk observation, not a test attempt');
  if (execution.testRunRisk) throw ineligible(attemptId, phaseId, 'the environment stopped it (a test-run risk decision let it through), so nothing passed');
  const submission = [...(workflow.lineage?.submissions ?? [])].reverse().find((entry) =>
    entry.phase === producer.id && Number(entry.generation) === Number(producer.generation));
  if (!submission) throw ineligible(attemptId, phaseId, `${producer.id} has no retained submission at generation ${producer.generation}`);
  const [{ readStoryReviewPacket }, gitModule, { readRecord }, { testReceiptPassing }] = await Promise.all([
    import('./story-lineage.mjs'), import('./git.mjs'), import('./schema-migrations.mjs'), import('./code-delivery-tests.mjs')]);
  let packet;
  try { packet = await readStoryReviewPacket(root, config, workflow, submission.packetSha256); } catch (error) {
    throw ineligible(attemptId, phaseId, `the submission of ${producer.id} that retained it does not verify (${error.code ?? error.message})`);
  }
  if (packet.workId !== workflow.workItem.id || packet.phase !== producer.id
      || Number(packet.generation) !== Number(producer.generation) || !COMMIT.test(String(packet.evidenceCommit ?? ''))) {
    throw ineligible(attemptId, phaseId, 'its retained submission belongs to another step or generation');
  }
  const reference = (packet.submissionEvidence?.testExecutions ?? []).find((entry) =>
    entry?.path === execution.receiptPath && entry.kind !== 'phase-validation-observation');
  if (!reference || !DIGEST.test(bare(reference.sha256)) || bare(reference.sha256) !== bare(execution.receiptSha256)) {
    throw ineligible(attemptId, phaseId, `the submission of ${producer.id} does not retain it`);
  }
  // Read at the submission's evidence commit, never the mutable working copy.
  const stored = readCommittedJson(root, gitModule, packet.evidenceCommit, reference.path, MAX_RECORD_BYTES);
  if (stored.missing) throw ineligible(attemptId, phaseId, 'its record is not in the submission commit');
  if (stored.invalid) throw ineligible(attemptId, phaseId, 'its record is not JSON');
  const sha256 = recordSha256(stored.value);
  if (sha256 !== bare(reference.sha256)) throw ineligible(attemptId, phaseId, 'its record differs from the digest the submission bound');
  let record;
  try { record = readRecord('test-execution', stored.value).record; } catch (error) {
    throw ineligible(attemptId, phaseId, `its record is not a valid test attempt (${error.message})`);
  }
  if (record.attemptId !== attemptId || record.commandId !== execution.commandId
      || !String(reference.path).endsWith(`/${attemptId}.json`)) {
    throw ineligible(attemptId, phaseId, 'its record is not the attempt the submission bound');
  }
  if (record.workId !== workflow.workItem.id || record.phase !== producer.id || Number(record.generation) !== Number(producer.generation)) {
    throw ineligible(attemptId, phaseId, 'it is an attempt of another Story, step or generation');
  }
  const checks = (packet.checks ?? []).filter((check) => check?.kind === 'test' && check.id === record.commandId);
  if (checks.length !== 1 || record.candidate?.commit !== checks[0].sourceCommit
      || record.candidate?.treeSha256 !== checks[0].sourceTreeSha256
      || (record.candidate?.testInputSha256 ?? null) !== (checks[0].testInputSha256 ?? null)
      || record.process?.status !== checks[0].status) {
    throw ineligible(attemptId, phaseId, 'it did not run against the candidate the submission retained');
  }
  const minimums = workflow.resolution?.codeDelivery?.tests ?? {};
  if (record.status !== 'passed' || record.process?.status !== 'passed' || record.exitCode !== 0) {
    throw ineligible(attemptId, phaseId, `its run is ${record.status}, not passed`);
  }
  if (!record.adapter || !record.tests || Number(record.tests.skipped) !== 0
      || !testReceiptPassing(record, minimums.minimumDiscovered ?? 1, minimums.minimumPassed ?? 1)) {
    throw ineligible(attemptId, phaseId, 'it has no structured result meeting the Story\'s pinned minimum counts with no skipped test');
  }
  if (!COMMIT.test(String(record.candidate?.commit ?? '')) || !TREE_DIGEST.test(String(record.candidate?.treeSha256 ?? ''))) {
    throw ineligible(attemptId, phaseId, 'it does not name the source commit and tree it ran on');
  }
  // The clauses this attempt's command covered in the delivery the submission bound.
  let clauses = [];
  const delivery = packet.submissionEvidence?.codeDelivery;
  if (delivery?.path) {
    const receipt = readCommittedJson(root, gitModule, packet.evidenceCommit, delivery.path, MAX_RECEIPT_BYTES);
    if (!receipt.value || recordSha256(receipt.value) !== bare(delivery.sha256)) {
      throw ineligible(attemptId, phaseId, `the delivery receipt of ${producer.id} differs from the digest its submission bound`);
    }
    const traceability = receipt.value.traceability ?? {};
    clauses = [...new Set([...(traceability.bindings ?? []), ...(traceability.witnesses ?? [])]
      .filter((entry) => entry?.commandId === record.commandId && typeof entry.clauseId === 'string')
      .map((entry) => entry.clauseId))].sort();
  }
  return {
    producer, consumer, packet, record,
    attempt: { id: attemptId, sha256, path: reference.path, phase: producer.id, generation: Number(record.generation),
      commandId: record.commandId, status: record.status,
      tests: { discovered: record.tests.discovered, passed: record.tests.passed, failed: record.tests.failed, skipped: record.tests.skipped },
      completedAt: record.process?.completedAt ?? null },
    source: { commit: record.candidate.commit, treeSha256: record.candidate.treeSha256, testInputSha256: record.candidate.testInputSha256 ?? null },
    clauses
  };
}

/**
 * The current application source, as the binding compares it: the source and test-input tree
 * digests (pass them when already computed) and, for each recorded decision, the digest of its
 * attempt record's working bytes (null when unreadable). `status: 'unavailable'` when the tree could
 * not be read; then no decision is active.
 */
export async function observeEvidenceReuseSource(root, config, workflow, { sourceTreeSha256 = null, testInputSha256 = undefined } = {}) {
  let tree = sourceTreeSha256;
  let inputs = testInputSha256;
  try {
    if (!tree || inputs === undefined) {
      const { sourceTreeHash, testInputTreeHash } = await import('./state-stores.mjs');
      tree ??= await sourceTreeHash(root, config, workflow);
      if (inputs === undefined) inputs = await testInputTreeHash(root, config, workflow);
    }
  } catch (error) {
    return { status: 'unavailable', code: error?.code ?? 'EVIDENCE_REUSE_SOURCE_UNAVAILABLE' };
  }
  const attempts = {};
  const decisions = countedRecords(workflow, workflow?.evidenceReuses).filter((entry) => !entry.revokes && entry.attempt?.path);
  if (decisions.length) {
    const [{ readFile }, { secureRepositoryPath }] = await Promise.all([import('node:fs/promises'), import('./util.mjs')]);
    for (const decision of decisions) {
      if (Object.hasOwn(attempts, decision.attempt.id)) continue;
      try {
        const secured = await secureRepositoryPath(root, decision.attempt.path, { label: 'Reused test attempt' });
        attempts[decision.attempt.id] = secured.exists ? recordSha256(JSON.parse(await readFile(secured.absolute, 'utf8'))) : null;
      } catch { attempts[decision.attempt.id] = null; }
    }
  }
  return { status: 'available', sourceTreeSha256: tree, testInputSha256: inputs ?? null, attempts };
}

/** Application paths that differ between `commit` and the working tree, bounded, or unavailable. */
async function changedApplicationPaths(root, config, workflow, commit) {
  try {
    const [{ buildRepositoryChangeSet }, { applicationPathContext, isApplicationChangePath }] = await Promise.all([
      import('./repository-change-set.mjs'), import('./application-paths.mjs')]);
    const context = applicationPathContext(config, workflow);
    const changeSet = await buildRepositoryChangeSet(root, { baseCommit: commit });
    const paths = [...new Set(changeSet.entries.flatMap((entry) => [entry.oldPath, entry.newPath].filter(Boolean)
      .filter((candidate) => isApplicationChangePath(candidate, { ...context,
        untracked: entry.untracked === true && candidate === entry.newPath }))))].sort();
    return { available: true, paths: paths.slice(0, PATH_LIMIT), omitted: Math.max(0, paths.length - PATH_LIMIT) };
  } catch {
    return { available: false, paths: [], omitted: 0 };
  }
}

/**
 * The two ways forward when a recorded run no longer describes the source: repair (return the
 * change to the step that ran the tests, whose next generation runs and records them again), or a
 * fresh recorded run of the reusing step's own test command when it has one.
 */
async function reuseRoutes(workflow, consumer, producer) {
  const { isTestQualityCommand, reviewMayReturnToCode, reviewRepairTarget } = await import('./delivery-evidence.mjs');
  const id = workflow.workItem.id;
  const repairCommand = reviewRepairTarget(workflow, consumer)?.id === producer.id
    ? `singularity-flow reject ${consumer.id} --to ${producer.id} --repair --reason <REASON>`
    : consumer.status === 'awaiting_approval' && reviewMayReturnToCode(consumer, producer)
      ? `singularity-flow reject ${consumer.id} --to ${producer.id} --reason <REASON>`
      : `singularity-flow nextsteps ${id} --json`;
  const repair = { command: repairCommand, label: repairCommand.includes(' reject ')
    ? `Repair: return the change to ${producer.id}; its next generation runs and records the tests again.`
    : `Repair: ${consumer.id} has no direct return to ${producer.id} now; inspect the legal next actions and request a return to ${producer.id}.` };
  const ownTests = (consumer.qualityCommands ?? []).some((command) => isTestQualityCommand(command));
  const fresh = ownTests
    ? { command: `singularity-flow phase publish ${consumer.id}`,
      label: `Fresh recorded run: publish ${consumer.id}; its own test command runs and its run is recorded.` }
    : { command: repair.command,
      label: `Fresh recorded run: ${consumer.id} has no test command of its own, so a new ${producer.id} generation records a new attempt; a person who approves ${consumer.id} may then reuse that one.` };
  return { repair, fresh };
}

/**
 * Everything a decision binds, verified now: the attempt (`verifyReusableAttempt`), its source
 * commit still in this branch's history, and the current application source and test inputs
 * byte-identical to the ones it ran on. Refuses `EVIDENCE_REUSE_SOURCE_CHANGED` naming the changed
 * paths, with a repair route and a fresh-run route, or `EVIDENCE_REUSE_SOURCE_UNAVAILABLE`.
 */
export async function prepareEvidenceReuse(root, config, workflow, { phaseId, attemptId }) {
  const verified = await verifyReusableAttempt(root, config, workflow, { phaseId, attemptId });
  const { producer, consumer, source } = verified;
  const { commitIsAncestor } = await import('./git.mjs');
  if (!commitIsAncestor(root, source.commit, 'HEAD')) {
    throw new SingularityFlowError(`${attemptId} ran on a commit that is not in this branch's history, so its source cannot be compared.`, {
      code: 'EVIDENCE_REUSE_SOURCE_UNAVAILABLE', details: { phase: phaseId }
    });
  }
  const observed = await observeEvidenceReuseSource(root, config, workflow);
  if (observed.status !== 'available') {
    throw new SingularityFlowError(`The current application source could not be read (${observed.code}), so ${attemptId} cannot be compared with it.`, {
      code: 'EVIDENCE_REUSE_SOURCE_UNAVAILABLE', details: { phase: phaseId }
    });
  }
  if (observed.sourceTreeSha256 !== source.treeSha256 || (observed.testInputSha256 ?? null) !== (source.testInputSha256 ?? null)) {
    // A run of the publication's preflight sat just before that generation's commit, with the same tree.
    const changed = await changedApplicationPaths(root, config, workflow, producer.generationCommit ?? source.commit);
    const routes = await reuseRoutes(workflow, consumer, producer);
    const named = changed.paths.length
      ? `: ${changed.paths.join(', ')}${changed.omitted ? ` and ${changed.omitted} more` : ''}`
      : changed.available ? ' (the tree digests differ, though no single changed application path could be named)' : ' (the changed paths could not be listed)';
    throw new SingularityFlowError(
      `${attemptId} cannot be reused for ${phaseId}: the application source changed after ${producer.id} recorded it${named}.`
        + ` A recorded run stands only for the exact source it tested. ${routes.repair.label} Shell: ${routes.repair.command}.`
        + ` ${routes.fresh.label}${routes.fresh.command === routes.repair.command ? '' : ` Shell: ${routes.fresh.command}.`}`,
      { code: 'EVIDENCE_REUSE_SOURCE_CHANGED', details: {
        phase: phaseId, sourcePhase: producer.id, attemptId, sourceCommit: source.commit,
        paths: changed.paths, omittedPaths: changed.omitted, routes,
        nextAction: { command: routes.repair.command, label: routes.repair.label },
        recoveryCommands: routes.fresh.command === routes.repair.command ? [routes.repair] : [routes.repair, routes.fresh]
      } }
    );
  }
  return { ...verified, observed };
}

/**
 * `activeEvidenceReuse` with the current source observed: what conformance and other gates call.
 * Reads nothing when the Story has no decision in scope. Pass `observed` to reuse an observation
 * (for a historical replay, the tree digests the replayed gate bound).
 */
export async function evidenceReuseFor(root, config, workflow, phaseId, { at = new Date().toISOString(), through = false, observed = null } = {}) {
  const phases = scopedPhases(workflow, phaseId, through);
  if (!countedRecords(workflow, workflow?.evidenceReuses).some((entry) => !entry.revokes && phases.has(entry.phase))) {
    return { phase: phaseId, through, active: [], lapsed: [], clauseIds: [] };
  }
  return activeEvidenceReuse(workflow, phaseId, { at, through,
    observed: observed ?? await observeEvidenceReuseSource(root, config, workflow) });
}

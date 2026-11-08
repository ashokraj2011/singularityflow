/**
 * Immutable test-execution attempts (test-execution v5) [E2G-016, D15].
 *
 * Every run of a required test command — the preflight before publication, each submission and
 * each runner-amendment epoch — is one attempt: a record written once, at a path named by its own
 * attempt ID, and never replaced. A failed run is recorded like a passing one, and the occurrences
 * of every test its report names are always kept, with the report's raw bytes content-addressed
 * beside them. Each attempt names the previous attempt of the same command for the same step, so a
 * later failure can never hide behind an earlier pass.
 *
 * An attempt is first kept in the checkout's private Git storage, so a refused publication or
 * submission leaves the Story's files exactly as they were. The next successful publication or
 * submission of the step admits every kept attempt into the Story, failed ones included, and they
 * are committed with it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildTestExecutionReceipt, parseTestResult } from '../code-delivery-tests.mjs';
import { commitIsAncestor, gitDir } from '../git.mjs';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { canonicalJson } from '../records.mjs';
import { readRecord } from '../schema-migrations.mjs';
import { posix, secureRepositoryPath, writeAtomicExclusive } from '../util.mjs';
import { classifyTestCommand } from './adapters.mjs';
import { profileForCommand } from './profiles.mjs';

// `local` is a run started with tests run for a Story step [RUN M2], and `candidate` an Auto Candidate's
// run on its own worktree [TCE:REQ-084]: staged and later admitted like the others. A gate reuses a
// passing one while nothing it ran on moved [TCE:REQ-082]; a decision or a test-run risk never reads one.
export const ATTEMPT_PURPOSES = Object.freeze(['preflight', 'submission', 'epoch', 'local', 'candidate']);
const RUN_OUTSIDE_A_GATE = new Set(['local', 'candidate']);
const ATTEMPT_FILE = /^TA-[a-f0-9]{20}\.json$/u;
const MAX_ATTEMPT_FILES = 10_000;

// Loaded from the CLI source, out of the long-lived VS Code bundles, only for a run with a coverage report [CQF:REQ-030].
const coverageReports = () => import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'verification', 'coverage-reports.mjs')).href);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** The Story-relative directory holding one step's admitted attempts. */
export function attemptsDirectory(itemRelative, phaseId) {
  return posix(path.join(itemRelative, 'context', 'code-delivery', 'tests', 'attempts', phaseId));
}

/** The Story-relative, content-addressed path of one raw report. */
export function rawReportPath(itemRelative, digest, adapter) {
  const extension = ['junit-xml', 'dotnet-trx'].includes(adapter) ? '.xml' : '.bin';
  return posix(path.join(itemRelative, 'context', 'code-delivery', 'tests', 'raw', `${digest}${extension}`));
}

function stagingDirectory(root, workId) {
  return path.join(gitDir(root), 'singularity-flow', 'test-attempts', workId);
}

/** A fresh attempt identity: a random nonce and the ID derived from it. */
export function newAttemptIdentity(random = randomBytes) {
  const nonce = random(16).toString('hex');
  return { nonce, attemptId: `TA-${sha256(nonce).slice(0, 20)}` };
}

/** The digest an attempt is bound by: SHA-256 of its canonical JSON, as every receipt binding is. */
export function attemptSha256(attempt) {
  return sha256(canonicalJson(attempt));
}

async function readAttempts(directory) {
  let names;
  try { names = (await readdir(directory)).filter((name) => ATTEMPT_FILE.test(name)).sort(); } catch { return []; }
  if (names.length > MAX_ATTEMPT_FILES) throw new Error(`more than ${MAX_ATTEMPT_FILES} test attempts in one step`);
  const records = [];
  for (const name of names) {
    try { records.push(readRecord('test-execution', await readFile(path.join(directory, name))).record); } catch { /* unreadable: not lineage */ }
  }
  return records;
}

/** Every attempt known for a step, kept or admitted, latest completed last. */
export async function stepAttempts(root, itemRelative, workId, phaseId) {
  const admitted = await secureRepositoryPath(root, attemptsDirectory(itemRelative, phaseId), { label: 'Test attempt directory' });
  const byId = new Map();
  for (const record of [
    ...(admitted.exists ? await readAttempts(admitted.absolute) : []),
    ...await readAttempts(path.join(stagingDirectory(root, workId), phaseId))
  ]) byId.set(record.attemptId, record);
  return [...byId.values()].sort((left, right) =>
    `${attemptRecordedAt(left)}\u0000${left.attemptId}`.localeCompare(`${attemptRecordedAt(right)}\u0000${right.attemptId}`));
}

// A reused run keeps the times of the run it reuses; its place in the history is when a gate reused it.
const attemptRecordedAt = (attempt) => attempt.reusedFrom?.at ?? attempt.process?.completedAt ?? '';

/** The latest recorded gate run of each test command of a step, by command ID; other runs only when asked. */
export async function latestStepAttempts(root, itemRelative, workId, phaseId, { includeLocal = false } = {}) {
  const latest = new Map();
  for (const attempt of await stepAttempts(root, itemRelative, workId, phaseId)) {
    if (RUN_OUTSIDE_A_GATE.has(attempt.purpose) && !includeLocal) continue;
    latest.set(attempt.commandId, attempt);
  }
  return latest;
}

/** The same program in the same folder, reporting the same way: what a run of `command` would run. */
function ranCommand(attempt, command) {
  return attempt.argvSha256 === sha256(Buffer.from(JSON.stringify(command?.argv ?? null)))
    && attempt.workingDirectory === command?.workingDirectory && attempt.adapter === (command?.result?.adapter ?? null);
}

/**
 * The recorded run that still stands for `command`, or `{ moved }`, what differs from the latest run on
 * this code, when one exists [TCE:REQ-080]. Owner, 2026-11-06: "dont rerun if the code has not changed".
 *
 * A run stands when a gate would run the same command on the same application source and separately
 * hashed test inputs (test configuration among them), under the same pin, in the same environment.
 * Any recorded run qualifies, whichever step made it, a local `tests run` too [TCE:REQ-082]; for a
 * run of only the new tests, one of the whole command already ran them. The latest run on this code
 * speaks for it, so a failure never hides behind an earlier pass, and it must have passed with a
 * report that can be replayed. A run given an environment's values is never reused, since SFlow
 * cannot compare those values.
 */
export async function unchangedTestRun(root, itemRelative, workflow, phaseId, command, {
  commit, treeSha256, codeTreeSha256 = null, testInputSha256 = null, environmentSha256, pinSha256
}) {
  const workId = workflow.workItem.id;
  let latest = null;
  // A documentation edit is no change to the code a run ran on [CQF:REQ-011]; a run recorded before the code digest compares its whole tree.
  const sameCode = (candidate) => candidate?.treeSha256 === treeSha256 || Boolean(codeTreeSha256 && candidate?.codeTreeSha256 === codeTreeSha256);
  for (const id of workflow.phaseOrder ?? [phaseId]) {
    for (const attempt of await stepAttempts(root, itemRelative, workId, id)) {
      if ((!ranCommand(attempt, command) && !ranCommand(attempt, command.testScope?.baseCommand))
          || !sameCode(attempt.candidate) || (attempt.candidate?.testInputSha256 ?? null) !== (testInputSha256 ?? null)) continue;
      if (!latest || attemptRecordedAt(attempt).localeCompare(attemptRecordedAt(latest)) >= 0) latest = attempt;
    }
  }
  if (!latest) return { moved: null };
  if (latest.status !== 'passed' || latest.exitCode !== 0 || latest.reportError || !latest.tests) return { moved: `its last run on this code ${latest.status}` };
  if (latest.evidenceClass === 'local-integration') return { moved: "its last run was given an environment's values, which cannot be compared" };
  if (latest.environmentSha256 !== environmentSha256) return { moved: `the environment changed since ${latest.attemptId}` };
  const pin = pinSha256 !== undefined ? pinSha256
    : (workflow.testCommandPins ?? []).filter((entry) => entry.commandId === latest.commandId).at(-1)?.sha256 ?? null;
  if (latest.pin?.sha256 && pin && latest.pin.sha256 !== pin) return { moved: `the command's pin changed since ${latest.attemptId}` };
  if (!latest.candidate.commit || !commitIsAncestor(root, latest.candidate.commit, commit)) return { moved: `${latest.attemptId} ran on a commit outside this branch's history` };
  const reports = await rawReportBytes(root, workId, latest);
  if (!reports) return { moved: `the report of ${latest.attemptId} is not available` };
  return { attempt: latest, reports, path: `${attemptsDirectory(itemRelative, latest.phase)}/${latest.attemptId}.json`, sha256: attemptSha256(latest) };
}

/** A run's raw reports, each checked against its address, from private storage or the Story; null when one is missing. */
async function rawReportBytes(root, workId, attempt) {
  if (!attempt.rawReports?.length) return null;
  const reports = [];
  for (const report of attempt.rawReports) {
    let bytes = null;
    try { bytes = await readFile(path.join(stagingDirectory(root, workId), 'raw', report.sha256)); } catch { /* admitted, or gone */ }
    if (!bytes) {
      try {
        const secured = await secureRepositoryPath(root, report.path, { label: 'Raw test report' });
        if (secured.exists) bytes = await readFile(secured.absolute);
      } catch { /* unavailable */ }
    }
    if (!bytes || sha256(bytes) !== report.sha256) return null;
    reports.push({ report, bytes });
  }
  return reports;
}

/**
 * A gate's attempt for a run that still stands. It is that run's own record when it is already this
 * step's attempt of this generation under this pin (publish, then submit); otherwise a new attempt
 * of this step carrying the run's counts and reports, naming it in `reusedFrom`, so every receipt
 * still binds an attempt of its own step and generation. Nothing here says the step ran anything.
 */
async function recordReusedAttempt(root, itemRelative, { command, check, purpose, workId, phaseId, generation, epoch, random, pin, narrowing }) {
  const { attempt: source, reports, path: sourcePath, sha256: sourceSha256 } = check.unchangedRun;
  const parsed = { adapter: source.adapter, tests: source.tests, minimumDiscovered: command.result.minimumDiscovered, minimumPassed: command.result.minimumPassed };
  if (source.phase === phaseId && Number(source.generation) === Number(generation) && !RUN_OUTSIDE_A_GATE.has(source.purpose)
      && source.commandId === command.id && (source.pin?.sha256 ?? null) === (pin?.sha256 ?? null)) {
    return { attempt: source, parsed, reportError: null, path: sourcePath, sha256: sourceSha256 };
  }
  const staging = stagingDirectory(root, workId);
  for (const { report, bytes } of reports) {
    try { await writeAtomicExclusive(path.join(staging, 'raw', report.sha256), bytes, { mode: 0o600 }); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  // Its coverage report goes with it [CQF:REQ-030].
  const coverage = source.coverage?.report ? await (await coverageReports()).reusedCoverage(root, staging, source.coverage) : source.coverage;
  const previous = (await stepAttempts(root, itemRelative, workId, phaseId)).filter((entry) => entry.commandId === command.id).at(-1);
  const { localRunId, uncommittedChanges, epoch: _epoch, pin: _pin, narrowing: _narrowing, coverage: _coverage, ...measured } = source;
  const attempt = { ...measured, ...newAttemptIdentity(random), parentAttemptId: previous?.attemptId ?? null, purpose, phase: phaseId, generation,
    ...(epoch ? { epoch } : {}), commandId: command.id, affectedRoots: command.affectedRoots, ...(coverage ? { coverage } : {}),
    reusedFrom: source.reusedFrom ?? { attemptId: source.attemptId, phase: source.phase, generation: source.generation, purpose: source.purpose,
      at: new Date().toISOString() } };
  if (pin) attempt.pin = pin;
  if (narrowing) attempt.narrowing = (await import('../test-narrowing.mjs')).observedNarrowing(attemptNarrowingFacts(narrowing, source), source.tests);
  await writeAtomicExclusive(path.join(staging, phaseId, `${attempt.attemptId}.json`), `${JSON.stringify(attempt, null, 2)}\n`, { mode: 0o600 });
  return { attempt, parsed, reportError: null, path: `${attemptsDirectory(itemRelative, phaseId)}/${attempt.attemptId}.json`, sha256: attemptSha256(attempt) };
}

// A run of only the new tests finds fewer tests than the suite by design: its scope says so, and its baseline is not compared [TCE:REQ-093].
const attemptNarrowingFacts = (facts, { testScope }) => (testScope?.files ? { ...facts, baseline: null, baselineSkipped: null } : facts);

/**
 * Run-result → attempt. Parses the run's own report when it produced one, keeps its raw bytes and
 * the attempt in private storage, and returns the attempt with its Story path and digest. A run that
 * failed or was blocked carries its `cause`, read against the paths `delivery` changed [TCE:REQ-041].
 */
export async function recordTestAttempt(root, itemRelative, {
  command, check, purpose, workId, phaseId, generation, epoch = null, random = randomBytes, localRunId = null,
  uncommittedChanges = null, delivery = null, pin = null, narrowing = null
}) {
  if (check?.unchangedRun) return recordReusedAttempt(root, itemRelative, { command, check, purpose, workId, phaseId, generation, epoch, random, pin, narrowing });
  let parsed = null;
  let reportError = null;
  if (check && check.status !== 'skipped-warning' && check.resultIsolated !== false) {
    try { parsed = await parseTestResult(root, command, { startedAt: check.startedAt }); }
    catch (error) { reportError = String(error?.message ?? error).slice(0, 500); }
  }
  const staging = stagingDirectory(root, workId);
  const rawReports = [];
  for (const report of parsed?.rawReports ?? []) {
    const target = path.join(staging, 'raw', report.sha256);
    try { await writeAtomicExclusive(target, report.contents, { mode: 0o600 }); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    rawReports.push({ path: rawReportPath(itemRelative, report.sha256, parsed.adapter), sha256: report.sha256, bytes: report.bytes });
  }
  const previous = (await stepAttempts(root, itemRelative, workId, phaseId)).filter((entry) => entry.commandId === command.id).at(-1);
  const profile = profileForCommand(command);
  const attempt = buildTestExecutionReceipt(command, check, parsed, {
    ...newAttemptIdentity(random), parentAttemptId: previous?.attemptId ?? null, purpose, workId, phase: phaseId,
    generation, epoch, rawReports, reportError, profile, selection: classifyTestCommand(profile, command), localRunId,
    uncommittedChanges
  });
  if (attempt.status === 'failed' || attempt.status === 'blocked') {
    attempt.cause = (await import('../test-run-cause.mjs')).attemptRunCause({ check, parsed, attempt, delivery });
  }
  // The coverage report this run wrote, a second raw report beside its test report [CQF:REQ-030].
  if (check?.coverageReport) attempt.coverage = await (await coverageReports()).keptCoverage(staging, itemRelative, check.coverageReport);
  // The pin a gate ran it under, which replay finds on the Story [TCE:REQ-014], and what narrowed it [TCE:REQ-021].
  if (pin) attempt.pin = pin;
  // A run of the Story's new tests only says so: which files, and why it may run fewer than the suite [TCE:REQ-093].
  if (command.testScope) attempt.testScope = { mode: command.testScope.mode, ...(command.testScope.files ? { files: command.testScope.files } : { whole: command.testScope.whole }),
    ...(command.testScope.importers ? { importers: command.testScope.importers } : {}) };
  if (narrowing) attempt.narrowing = (await import('../test-narrowing.mjs')).observedNarrowing(attemptNarrowingFacts(narrowing, attempt), parsed?.tests);
  await writeAtomicExclusive(path.join(staging, phaseId, `${attempt.attemptId}.json`), `${JSON.stringify(attempt, null, 2)}\n`, { mode: 0o600 });
  return {
    attempt, parsed, reportError,
    path: `${attemptsDirectory(itemRelative, phaseId)}/${attempt.attemptId}.json`,
    sha256: attemptSha256(attempt)
  };
}

/** The runs a refused run leaves behind, each one attempt in private storage until a later gate admits it [E2G-016]. */
export async function recordRunsBeforeRefusal(root, itemRelative, commands, ran, { pins = null, ...fields }) {
  for (const check of ran) {
    const command = commands.find((entry) => entry?.id === check.id && entry.kind === 'test');
    if (command && check.status !== 'skipped-warning') await recordTestAttempt(root, itemRelative, { command, check, ...fields, ...pins?.attempt(command.id) });
  }
}

async function admitFile(root, relative, bytes, label) {
  const secured = await secureRepositoryPath(root, relative, { label });
  if (secured.exists) {
    if (sha256(await readFile(secured.absolute)) !== sha256(bytes)) throw new Error(`${relative} already exists with other bytes`);
    return;
  }
  await writeAtomicExclusive(secured.absolute, bytes);
}

/**
 * Admit every kept attempt of a step into the Story, with its raw reports. Called by a successful
 * publication or submission, before its commit, so failed and earlier attempts are committed too.
 * Returns the admitted attempts in completion order.
 */
export async function admitTestAttempts(root, itemRelative, workId, phaseId) {
  const staging = stagingDirectory(root, workId);
  for (const attempt of await readAttempts(path.join(staging, phaseId))) {
    for (const report of attempt.rawReports ?? []) {
      const bytes = await readFile(path.join(staging, 'raw', report.sha256));
      if (sha256(bytes) !== report.sha256) throw new Error(`kept raw report ${report.sha256} changed`);
      await admitFile(root, report.path, bytes, 'Raw test report');
    }
    // A coverage report is shown, never judged: one gone from both places admits nothing and refuses nothing.
    const coverage = attempt.coverage?.report ? await (await coverageReports()).coverageReportBytes(root, staging, attempt.coverage.report) : null;
    if (coverage) await admitFile(root, attempt.coverage.report.path, coverage, 'Coverage report');
    // The kept bytes themselves are admitted, so the committed record is exactly the one written.
    await admitFile(root, `${attemptsDirectory(itemRelative, phaseId)}/${attempt.attemptId}.json`,
      await readFile(path.join(staging, phaseId, `${attempt.attemptId}.json`)), 'Test attempt');
  }
  return (await stepAttempts(root, itemRelative, workId, phaseId)).map((attempt) => ({
    attemptId: attempt.attemptId, commandId: attempt.commandId, purpose: attempt.purpose,
    generation: attempt.generation, status: attempt.status
  }));
}

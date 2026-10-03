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

import { buildTestExecutionReceipt, parseTestResult } from '../code-delivery-tests.mjs';
import { gitDir } from '../git.mjs';
import { canonicalJson } from '../records.mjs';
import { readRecord } from '../schema-migrations.mjs';
import { posix, secureRepositoryPath, writeAtomicExclusive } from '../util.mjs';
import { classifyTestCommand } from './adapters.mjs';
import { profileForCommand } from './profiles.mjs';

export const ATTEMPT_PURPOSES = Object.freeze(['preflight', 'submission', 'epoch']);
const ATTEMPT_FILE = /^TA-[a-f0-9]{20}\.json$/u;
const MAX_ATTEMPT_FILES = 10_000;

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
    `${left.process?.completedAt ?? ''}\u0000${left.attemptId}`.localeCompare(`${right.process?.completedAt ?? ''}\u0000${right.attemptId}`));
}

/**
 * Run-result → attempt. Parses the run's own report when it produced one, keeps its raw bytes and
 * the attempt in private storage, and returns the attempt with its Story path and digest.
 */
export async function recordTestAttempt(root, itemRelative, {
  command, check, purpose, workId, phaseId, generation, epoch = null, random = randomBytes
}) {
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
    generation, epoch, rawReports, reportError, profile, selection: classifyTestCommand(profile, command)
  });
  await writeAtomicExclusive(path.join(staging, phaseId, `${attempt.attemptId}.json`), `${JSON.stringify(attempt, null, 2)}\n`, { mode: 0o600 });
  return {
    attempt, parsed, reportError,
    path: `${attemptsDirectory(itemRelative, phaseId)}/${attempt.attemptId}.json`,
    sha256: attemptSha256(attempt)
  };
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
    // The kept bytes themselves are admitted, so the committed record is exactly the one written.
    await admitFile(root, `${attemptsDirectory(itemRelative, phaseId)}/${attempt.attemptId}.json`,
      await readFile(path.join(staging, phaseId, `${attempt.attemptId}.json`)), 'Test attempt');
  }
  return (await stepAttempts(root, itemRelative, workId, phaseId)).map((attempt) => ({
    attemptId: attempt.attemptId, commandId: attempt.commandId, purpose: attempt.purpose,
    generation: attempt.generation, status: attempt.status
  }));
}

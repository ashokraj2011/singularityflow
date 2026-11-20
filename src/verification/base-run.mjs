/**
 * Was it this change? The same test command once on the Story's base commit (owner decision, 2026-11-06).
 *
 * A Story's tests can fail for a reason that was there before it: on one repository's base 17 of 31 tests
 * fail on Node 26 and pass on Node 22, and agents stubbed `localStorage` into the product to get past it
 * (bin-opr, myl-graph). Now anyone can ask. The run is made as a gate makes it, in a throwaway worktree of
 * the base commit with this checkout's dependencies, and kept by base commit, command and Node, so unchanged
 * facts never run twice. It is a fact for a person: never evidence, it records no attempt, and it refuses nothing.
 *
 * The decisions card asks it itself before it recommends on a test-run risk (decision-probes.mjs) [owner, 2026-11-16]:
 * a run its time cut short is not kept as an answer, only noted (`.cut.json`), and baseCheckFacts reads what is kept.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { addCandidateWorktree, gitCommonDir, gitDir, removeCandidateWorktree } from '../git.mjs';
import { canonicalJson } from '../records.mjs';

const MAX_NAMES = 20;
/** The failed tests' names a report or an attempt holds. */
export const failedNames = (occurrences) => [...new Set((occurrences ?? []).filter((entry) => entry.outcome === 'failed').map((entry) => entry.name).filter(Boolean))];

/**
 * Each failed test's own message, by name, from a report's raw bytes: `{ [name]: message }`, empty when the report holds none.
 * Two runs whose same test fails for another reason are two failures, not one (Story new-ash-graph: Node 26's localStorage
 * error on the base was read as the failure here) [owner, 2026-11-18].
 */
export async function failureMessages(adapter, contents, occurrences) {
  const list = Array.isArray(occurrences) ? occurrences : [];
  const messages = contents?.length ? (await import('../test-case-messages.mjs')).testCaseMessages(adapter, contents, list.length) : null;
  const found = {};
  list.forEach((entry, index) => {
    if (entry?.outcome === 'failed' && entry.name && messages?.[index] && !(entry.name in found)) found[entry.name] = String(messages[index]).slice(0, 600);
  });
  return found;
}

/** The failure messages of a step's recorded run, read from its raw reports in the Story or the checkout's private staging. */
export async function attemptFailureMessages(root, workId, attempt) {
  const contents = [];
  for (const entry of (attempt?.rawReports ?? []).slice(0, 8)) {
    const bytes = await readFile(path.join(root, String(entry.path ?? ''))).catch(() => null)
      ?? await readFile(path.join(gitDir(root), 'singularity-flow', 'test-attempts', String(workId), 'raw', String(entry.sha256 ?? ''))).catch(() => null);
    if (bytes) contents.push(bytes);
  }
  return failureMessages(attempt?.adapter ?? null, contents, attempt?.occurrences);
}

// The cause, its first line, not its place: colour, times, durations and file positions differ between two runs of one failure.
const causeOf = (message) => (String(message ?? '').replace(/\u001b\[[0-9;]*m/gu, '').split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? '')
  .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/gu, '').replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|seconds)\b/giu, '')
  .replace(/(?:[\w./\\-]+)?:\d+(?::\d+)?/gu, '').replace(/\s+/gu, ' ').trim();
const listed = (names) => names.slice(0, MAX_NAMES).join(', ') + (names.length > MAX_NAMES ? ` and ${names.length - MAX_NAMES} more` : '');

/** The Node a Story's tests run on here and the version file that chose it (`{ name, text }`), or PATH's Node and none. */
export async function storyTestNode(root, cwd) {
  const { requestedNodeVersion } = await import('../project-node-version.mjs');
  const requested = await requestedNodeVersion({ cwd, root, environment: process.env }).catch(() => null);
  if (requested && ['current', 'selected', 'settled'].includes(requested.status) && requested.node) {
    const file = path.join(root, requested.file);
    const text = path.dirname(file) === path.resolve(root) ? await readFile(file, 'utf8').catch(() => null) : null;
    return { version: requested.node, versionFile: text == null ? null : { name: path.basename(file), text } };
  }
  const { nodeVersion } = await import('../test-toolchain.mjs');
  return { version: await nodeVersion('node', { cwd, environment: process.env }).catch(() => null), versionFile: null };
}

/** The commit the Story started from, which is what "without this change" means. */
export function storyBaseCommit(workflow, phase) {
  return workflow?.workItem?.baseCommit ?? phase?.generationIntent?.baseline?.commit ?? workflow?.workIntervals?.current?.sourceBaseCommit ?? null;
}

const cachePath = (root, key) => path.join(gitCommonDir(root), 'singularity-flow', 'test-base-runs', `${key}.json`);
const cutPath = (root, key) => path.join(gitCommonDir(root), 'singularity-flow', 'test-base-runs', `${key}.cut.json`);
const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);
/**
 * How long a kept base run answers "does it fail without this change?". The key holds the base commit, the command and the
 * Node; the machine's dependencies and services are not in it, so a run that failed on an environment fixed since kept
 * recommending "fails without this change too" [limit audit, item 9]. Older, it is run again (`tests base --refresh` now).
 */
export const BASE_RUN_FRESH_MS = 24 * 60 * 60 * 1000;
const freshBaseRun = (kept, now = Date.now()) => Boolean(kept) && Number.isFinite(Date.parse(kept.at ?? '')) && now - Date.parse(kept.at) < BASE_RUN_FRESH_MS;

/** What a base run is kept by: the base commit, the command as it runs and the Node it runs on. */
export function baseRunKey(baseCommit, command, nodeVersion = null) {
  return createHash('sha256').update(canonicalJson({ baseCommit, argv: command.argv, workingDirectory: command.workingDirectory ?? '.', adapter: command.result?.adapter ?? null, nodeVersion })).digest('hex').slice(0, 40);
}

/**
 * One run of `command` on the base commit, or the one already kept. `gateRun` is how a gate runs it, and is the caller's;
 * it answers `{ cutShort: true, why }` for a run its time ran out on, which is noted and never kept as an answer.
 */
export async function runOnBase(root, command, { baseCommit, nodeVersion = null, gateRun, within = null, versionFile = null, refresh = false }) {
  const key = baseRunKey(baseCommit, command, nodeVersion);
  const kept = refresh ? null : await readJson(cachePath(root, key));
  if (freshBaseRun(kept)) return { ...kept, reused: true };
  const holder = await mkdtemp(path.join(os.tmpdir(), 'sflow-base-run-'));
  const target = path.join(holder, 'base');
  let outcome;
  let cut = null;
  try {
    if (!addCandidateWorktree(root, target, baseCommit)) return { commandId: command.id, baseCommit, nodeVersion, status: 'not-run', why: `Git could not check out the base commit ${baseCommit.slice(0, 12)} here.` };
    const { copyRepositoryDependencies } = await import('../repository-dependencies.mjs');
    await copyRepositoryDependencies(root, target).catch(() => null);
    // The Story's pinned Node, where the base commit names none: "without this change" means without its code, on the
    // Node its tests run on, never on whatever Node is on PATH (Story new-ash-graph's base ran on Node 26).
    if (versionFile?.name && !await lstat(path.join(target, versionFile.name)).then(() => true, () => false)) {
      await writeFile(path.join(target, versionFile.name), versionFile.text);
    }
    const ran = await gateRun(await realpath(target));
    if (ran.cutShort) cut = ran.why ?? 'it ran out of time';
    else {
      const { check, parsed, reportError } = ran;
      const occurrences = parsed?.testcaseObservation?.occurrences;
      const messages = await failureMessages(command.result?.adapter ?? parsed?.adapter ?? null, (parsed?.rawReports ?? []).map((entry) => entry.contents), occurrences).catch(() => ({}));
      outcome = { commandId: command.id, baseCommit, nodeVersion, status: check.status, exitCode: check.exitCode ?? null, tests: parsed?.tests ?? null,
        failed: failedNames(occurrences), ...(Object.keys(messages).length ? { messages } : {}), ...(reportError ? { reportError } : {}), at: new Date().toISOString() };
    }
  } catch (error) {
    // A run that could not be made says why, and is not kept: the next ask may find the machine different.
    return { commandId: command.id, baseCommit, nodeVersion, status: 'not-run', why: String(error?.message ?? error).slice(0, 500) };
  } finally {
    removeCandidateWorktree(root, target);
    await rm(holder, { recursive: true, force: true }).catch(() => null);
  }
  await mkdir(path.dirname(cachePath(root, key)), { recursive: true });
  if (cut) {
    await writeFile(cutPath(root, key), `${JSON.stringify({ commandId: command.id, within, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 }).catch(() => null);
    return { commandId: command.id, baseCommit, nodeVersion, status: 'not-run', cutShort: true, why: cut };
  }
  await writeFile(cachePath(root, key), `${JSON.stringify(outcome, null, 2)}\n`, { mode: 0o600 }).catch(() => null);
  return outcome;
}

/**
 * What a base run says about the failures here. `here` is the latest run's failed test names; empty when
 * nothing ran or the last run passed. Only names both runs report are compared: a run that reads counts says so.
 */
export function baseComparison(result, { here = [], hereMessages = null, hereNode = null } = {}) {
  const node = result.nodeVersion ? `, on Node ${result.nodeVersion}` : '';
  const at = `the base commit ${String(result.baseCommit).slice(0, 12)}${node}`;
  if (result.status === 'not-run') return { verdict: 'not-run', alsoOnBase: [], onlyHere: here, words: `It could not run on ${at}: ${result.why}` };
  const counts = result.tests ? `${result.tests.discovered} tests, ${result.tests.passed} passed, ${result.tests.failed} failed` : `exit ${result.exitCode}, with no report SFlow could read`;
  // Runs on two Node majors compare nothing: a failure the Node causes there says nothing about one here.
  const major = (version) => String(version ?? '').replace(/^v/u, '').split('.')[0];
  if (here.length && hereNode && result.nodeVersion && major(hereNode) !== major(result.nodeVersion)) {
    return { verdict: 'other-node', alsoOnBase: [], onlyHere: here, words: `It ran without this change on ${at} (${counts}), but the failures here ran on Node ${hereNode}, so it says nothing about them.` };
  }
  const failed = result.failed ?? [];
  // The same test failing for another reason is not the same failure: compared by its message where both runs kept one.
  const sameFailure = (name) => failed.includes(name) && (!hereMessages?.[name] || !result.messages?.[name]
    || causeOf(hereMessages[name]) === causeOf(result.messages[name]));
  const alsoOnBase = here.filter(sameFailure);
  const onlyHere = here.filter((name) => !sameFailure(name));
  if (result.status === 'passed') {
    return { verdict: 'passes-on-base', alsoOnBase, onlyHere, words: `It passes without this change on ${at} (${counts})${here.length ? `, so ${listed(here)} ${here.length === 1 ? 'fails' : 'fail'} only with it` : ''}.` };
  }
  if (!here.length) return { verdict: 'fails-on-base', alsoOnBase, onlyHere, words: `It fails without this change too, on ${at} (${counts})${failed.length ? `: ${listed(failed)}` : ''}.` };
  if (!onlyHere.length) return { verdict: 'fails-on-base', alsoOnBase, onlyHere, words: `Every failure here also fails without this change, on ${at} (${counts}): ${listed(alsoOnBase)}. A person decides what to do: repair it in this Story, pin another Node, or accept it as a known failure.` };
  return { verdict: 'partly-on-base', alsoOnBase, onlyHere, words: `${alsoOnBase.length} of ${here.length} failures here also fail without this change, on ${at} (${counts}). These fail only with it: ${listed(onlyHere)}.` };
}

/**
 * What the kept base runs say about a step's test-run risks, by command ID [owner, 2026-11-16]: `checked` with the
 * comparison's verdict when a run of that command on the base commit is kept, else `unknown` (`cutShort` when the last
 * try ran out of time). Reads only what is kept; runs nothing.
 */
export async function baseCheckFacts(root, config, workflow, phase, commandIds) {
  const baseCommit = storyBaseCommit(workflow, phase);
  const found = new Map();
  if (!baseCommit || !commandIds.length) return found;
  const [{ resolveStoryLocalTestCommands }, { stepAttempts }, { workDirRelative }] = await Promise.all([
    import('../local-test-runs.mjs'), import('./attempts.mjs'), import('../story-paths.mjs')]);
  const { commands } = await resolveStoryLocalTestCommands(root, config, workflow, { phaseId: phase.id });
  // Every run of the step, a local one too, as `tests base` compares them: the latest of each command is "here".
  const attempts = await stepAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phase.id).catch(() => []);
  for (const id of commandIds) {
    const selected = commands.find((entry) => entry.id === id);
    if (!selected) continue;
    const command = selected.testScope?.baseCommand ?? selected;
    const { version } = await storyTestNode(root, path.join(root, command.workingDirectory ?? '.'));
    const key = baseRunKey(baseCommit, command, version);
    const kept = await readJson(cachePath(root, key));
    if (freshBaseRun(kept)) {
      const attempt = attempts.filter((entry) => entry.commandId === id).at(-1);
      const here = attempt && attempt.status !== 'passed' ? failedNames(attempt.occurrences) : [];
      // The verdict alone: its words name the base commit, which a person never reads.
      const { verdict } = baseComparison(kept, { here, hereNode: attempt?.environment?.toolchain?.node ?? null,
        hereMessages: here.length ? await attemptFailureMessages(root, workflow.workItem.id, attempt).catch(() => null) : null });
      found.set(id, { status: 'checked', verdict });
    } else {
      const cut = await readJson(cutPath(root, key));
      // A kept run older than its day is asked again, never recommended from [limit audit, item 9].
      found.set(id, { status: 'unknown', ...(kept ? { stale: true } : {}), ...(cut ? { cutShort: true, seconds: cut.within ?? null } : {}) });
    }
  }
  return found;
}

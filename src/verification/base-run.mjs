/**
 * Was it this change? The same test command once on the Story's base commit (owner decision, 2026-11-06).
 *
 * A Story's tests can fail for a reason that was there before it: on one repository's base 17 of 31 tests
 * fail on Node 26 and pass on Node 22, and agents stubbed `localStorage` into the product to get past it
 * (bin-opr, myl-graph). Now anyone can ask. The run is made as a gate makes it, in a throwaway worktree of
 * the base commit with this checkout's dependencies, and kept by base commit, command and Node, so unchanged
 * facts never run twice. It is a fact for a person: never evidence, it records no attempt, and it refuses nothing.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { addCandidateWorktree, gitCommonDir, removeCandidateWorktree } from '../git.mjs';
import { canonicalJson } from '../foundation/record-schema.mjs';

const MAX_NAMES = 20;
/** The failed tests' names a report or an attempt holds. */
export const failedNames = (occurrences) => [...new Set((occurrences ?? []).filter((entry) => entry.outcome === 'failed').map((entry) => entry.name).filter(Boolean))];
const listed = (names) => names.slice(0, MAX_NAMES).join(', ') + (names.length > MAX_NAMES ? ` and ${names.length - MAX_NAMES} more` : '');

/** The commit the Story started from, which is what "without this change" means. */
export function storyBaseCommit(workflow, phase) {
  return workflow?.workItem?.baseCommit ?? phase?.generationIntent?.baseline?.commit ?? workflow?.workIntervals?.current?.sourceBaseCommit ?? null;
}

const cachePath = (root, key) => path.join(gitCommonDir(root), 'singularity-flow', 'test-base-runs', `${key}.json`);

/** One run of `command` on the base commit, or the one already kept. `gateRun` is how a gate runs it, and is the caller's. */
export async function runOnBase(root, command, { baseCommit, nodeVersion = null, gateRun }) {
  const key = createHash('sha256').update(canonicalJson({ baseCommit, argv: command.argv, workingDirectory: command.workingDirectory ?? '.', adapter: command.result?.adapter ?? null, nodeVersion })).digest('hex').slice(0, 40);
  const kept = await readFile(cachePath(root, key), 'utf8').then(JSON.parse, () => null);
  if (kept) return { ...kept, reused: true };
  const holder = await mkdtemp(path.join(os.tmpdir(), 'sflow-base-run-'));
  const target = path.join(holder, 'base');
  let outcome;
  try {
    if (!addCandidateWorktree(root, target, baseCommit)) return { commandId: command.id, baseCommit, nodeVersion, status: 'not-run', why: `Git could not check out the base commit ${baseCommit.slice(0, 12)} here.` };
    const { copyRepositoryDependencies } = await import('../repository-dependencies.mjs');
    await copyRepositoryDependencies(root, target).catch(() => null);
    const { check, parsed, reportError } = await gateRun(await realpath(target));
    outcome = { commandId: command.id, baseCommit, nodeVersion, status: check.status, exitCode: check.exitCode ?? null, tests: parsed?.tests ?? null,
      failed: failedNames(parsed?.testcaseObservation?.occurrences), ...(reportError ? { reportError } : {}), at: new Date().toISOString() };
  } catch (error) {
    // A run that could not be made says why, and is not kept: the next ask may find the machine different.
    return { commandId: command.id, baseCommit, nodeVersion, status: 'not-run', why: String(error?.message ?? error).slice(0, 500) };
  } finally {
    removeCandidateWorktree(root, target);
    await rm(holder, { recursive: true, force: true }).catch(() => null);
  }
  await mkdir(path.dirname(cachePath(root, key)), { recursive: true });
  await writeFile(cachePath(root, key), `${JSON.stringify(outcome, null, 2)}\n`, { mode: 0o600 }).catch(() => null);
  return outcome;
}

/**
 * What a base run says about the failures here. `here` is the latest run's failed test names; empty when
 * nothing ran or the last run passed. Only names both runs report are compared: a run that reads counts says so.
 */
export function baseComparison(result, { here = [] } = {}) {
  const node = result.nodeVersion ? `, on Node ${result.nodeVersion}` : '';
  const at = `the base commit ${String(result.baseCommit).slice(0, 12)}${node}`;
  if (result.status === 'not-run') return { verdict: 'not-run', alsoOnBase: [], onlyHere: here, words: `It could not run on ${at}: ${result.why}` };
  const failed = result.failed ?? [];
  const counts = result.tests ? `${result.tests.discovered} tests, ${result.tests.passed} passed, ${result.tests.failed} failed` : `exit ${result.exitCode}, with no report SFlow could read`;
  const alsoOnBase = here.filter((name) => failed.includes(name));
  const onlyHere = here.filter((name) => !failed.includes(name));
  if (result.status === 'passed') {
    return { verdict: 'passes-on-base', alsoOnBase, onlyHere, words: `It passes without this change on ${at} (${counts})${here.length ? `, so ${listed(here)} ${here.length === 1 ? 'fails' : 'fail'} only with it` : ''}.` };
  }
  if (!here.length) return { verdict: 'fails-on-base', alsoOnBase, onlyHere, words: `It fails without this change too, on ${at} (${counts})${failed.length ? `: ${listed(failed)}` : ''}.` };
  if (!onlyHere.length) return { verdict: 'fails-on-base', alsoOnBase, onlyHere, words: `Every failure here also fails without this change, on ${at} (${counts}): ${listed(alsoOnBase)}. A person decides what to do: repair it in this Story, pin another Node, or accept it as a known failure.` };
  return { verdict: 'partly-on-base', alsoOnBase, onlyHere, words: `${alsoOnBase.length} of ${here.length} failures here also fail without this change, on ${at} (${counts}). These fail only with it: ${listed(onlyHere)}.` };
}

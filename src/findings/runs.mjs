/**
 * Finding command runs and the code step's fix-loop rounds, kept in the checkout's private Git storage
 * (as test attempts are first kept): written once, never replaced, never committed. The Story records
 * what a gate decided from them in its delivery evidence.
 *
 * - A run (`QR-…`) is one command's outcome on one tree: the findings it read, or why it could not
 *   read any. A later gate reuses the latest run of the same command on the same code, tool version
 *   and ruleset digest [CQF:REQ-045], from whichever step made it.
 * - A round (`QL-…`) is one publish check of a step's generation that returned findings, with the
 *   fingerprints that counted: the loop's attempts [CQF:REQ-043].
 */
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { commitIsAncestor, gitDir } from '../git.mjs';
import { writeAtomicExclusive } from '../util.mjs';

const RUN_FILE = /^QR-[a-f0-9]{20}\.json$/u;
const ROUND_FILE = /^QL-[a-f0-9]{20}\.json$/u;
const MAX_FILES = 5_000;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const identifier = (prefix) => `${prefix}-${sha256(randomBytes(16)).slice(0, 20)}`;

function directory(root, workId, phaseId) {
  return path.join(gitDir(root), 'singularity-flow', 'quality-runs', workId, phaseId);
}

async function readRecords(folder, pattern) {
  let names;
  try { names = (await readdir(folder)).filter((name) => pattern.test(name)).sort(); } catch { return []; }
  const records = [];
  for (const name of names.slice(-MAX_FILES)) {
    try { records.push(JSON.parse(await readFile(path.join(folder, name), 'utf8'))); } catch { /* unreadable: not history */ }
  }
  return records.sort((left, right) => `${left.at}\u0000${left.id}`.localeCompare(`${right.at}\u0000${right.id}`));
}

/** What a run of `command` is keyed by besides the code: the program, its folder, its report and its environment literals. */
export function findingCommandSha256(command) {
  return `sha256:${sha256(JSON.stringify([command.argv ?? null, command.command ?? null, command.workingDirectory ?? '.',
    command.result?.adapter ?? null, command.result?.path ?? null, command.env ?? null, ...(command.result?.from ? [command.result.from] : [])]))}`;
}

export async function recordFindingRun(root, { workId, phaseId, generation, purpose, command, candidate, identity, status,
  reason = null, exitCode = null, findings = [], counts = null, database = null, startedAt, completedAt }) {
  const run = { schemaVersion: 1, kind: 'finding-run', id: identifier('QR'), at: completedAt ?? new Date().toISOString(), workId, phase: phaseId,
    generation, purpose, commandId: command.id, commandSha256: findingCommandSha256(command), adapter: command.result?.adapter ?? null,
    candidate, tool: identity, status, ...(reason ? { reason: String(reason).slice(0, 500) } : {}), exitCode,
    startedAt: startedAt ?? null, completedAt: completedAt ?? null, findings, ...(counts ? { counts } : {}),
    // An audit's advisories are as of this date, which a run reused later keeps [CQF:REQ-050].
    ...(database ? { database } : {}) };
  await writeAtomicExclusive(path.join(directory(root, workId, phaseId), `${run.id}.json`), `${JSON.stringify(run)}\n`, { mode: 0o600 });
  return run;
}

export async function stepFindingRuns(root, workId, phaseId) {
  return readRecords(directory(root, workId, phaseId), RUN_FILE);
}

/**
 * The run that still stands for `command`, or `{ moved }`: the latest read of the same command on the
 * same application source and test inputs, with the same tool version and ruleset digest, from any
 * step of the Story, on a commit in this branch's history. A run that could not read its report never
 * stands; a run with no tool identity never does either.
 */
export async function unchangedFindingRun(root, workflow, command, { commit, treeSha256, testInputSha256 = null, identity }) {
  if (!identity?.toolVersion || !identity.rulesetSha256) return { moved: 'its tool version could not be read here' };
  const key = findingCommandSha256(command);
  let latest = null;
  for (const phaseId of workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})) {
    for (const run of await stepFindingRuns(root, workflow.workItem.id, phaseId)) {
      if (run.commandSha256 !== key || run.candidate?.treeSha256 !== treeSha256
          || (run.candidate?.testInputSha256 ?? null) !== (testInputSha256 ?? null)) continue;
      if (!latest || String(run.at).localeCompare(String(latest.at)) >= 0) latest = run;
    }
  }
  if (!latest) return { moved: null };
  if (latest.status !== 'read') return { moved: `its last run on this code was ${latest.status}` };
  if (latest.tool?.toolVersion !== identity.toolVersion) return { moved: `the tool version changed since ${latest.id}` };
  if (latest.tool?.rulesetSha256 !== identity.rulesetSha256) return { moved: `its rules changed since ${latest.id}` };
  if (!latest.candidate?.commit || !commitIsAncestor(root, latest.candidate.commit, commit)) return { moved: `${latest.id} ran on a commit outside this branch's history` };
  return { run: latest };
}

/** Record one fix-loop round: the generation's publish check that returned findings. */
export async function recordFindingRound(root, { workId, phaseId, generation, counted, at = new Date().toISOString() }) {
  const round = { schemaVersion: 1, kind: 'finding-round', id: identifier('QL'), at, workId, phase: phaseId, generation,
    counted: [...new Set(counted)].sort() };
  await writeAtomicExclusive(path.join(directory(root, workId, phaseId), `${round.id}.json`), `${JSON.stringify(round)}\n`, { mode: 0o600 });
  return round;
}

/** The rounds of one generation, earliest first. */
export async function generationFindingRounds(root, workId, phaseId, generation) {
  return (await readRecords(directory(root, workId, phaseId), ROUND_FILE)).filter((round) => Number(round.generation) === Number(generation));
}

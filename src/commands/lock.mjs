/**
 * `singularity-flow lock show|release|release-file` (SDA M3, lease-proven lock recovery).
 *
 * A lease is taken over automatically only when its owner is proven gone (src/lease-liveness.mjs);
 * age never decides. A lease whose owner runs on another machine, or runs here but stopped renewing,
 * is ended only by a person: `show` reads it, and `release` removes exactly the generation that person
 * reviewed (its token), recording the release. A refusal that meets such a lease prints these routes.
 */
import path from 'node:path';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['show', 'release', 'release-file']);
const OPTIONS = Object.freeze({ show: ['json'], release: ['confirm', 'json'], 'release-file': ['confirm', 'json'] });

function fail(message, code = 'LOCK_COMMAND_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

export async function lockCommand(positionals, options = {}) {
  const subcommand = positionals[1] ?? 'show';
  if (!SUBCOMMANDS.includes(subcommand)) {
    fail(`Unknown lock subcommand '${subcommand}'. Supported: ${SUBCOMMANDS.join(', ')}.`, 'UNKNOWN_SUBCOMMAND',
      { command: 'lock', subcommand, available: [...SUBCOMMANDS] });
  }
  const unknown = Object.keys(options).filter((key) => ![...OPTIONS[subcommand], 'timings'].includes(key)).sort();
  if (unknown.length) fail(`lock ${subcommand} does not accept ${unknown.map((key) => `--${key}`).join(', ')}.`);
  if (subcommand === 'release-file') {
    const file = positionals[2];
    if (!file || positionals.length > 3) fail('Name the lease file: singularity-flow lock release-file <LEASE-FILE> --confirm <TOKEN>.');
    const token = optionString(options, 'confirm');
    if (!token) fail('Confirm the reviewed lease token with --confirm <TOKEN>, as the refusal printed it.');
    const { releaseRegistryLeaseAfterReview } = await import('../file-lease.mjs');
    return { schemaVersion: 1, resultType: 'sflow-lock-release',
      ...await releaseRegistryLeaseAfterReview(path.resolve(file), { expectedToken: token }) };
  }
  const [, , kind, id] = positionals;
  if (!kind || !id || positionals.length > 4) fail(`Name the lease: singularity-flow lock ${subcommand} <KIND> <ID>.`);
  const { repoRoot } = await import('../git-execution.mjs');
  const root = repoRoot(process.cwd());
  const subject = { kind, id };
  if (subcommand === 'show') {
    const { inspectSubjectLease } = await import('../subject-lock.mjs');
    return { schemaVersion: 1, resultType: 'sflow-lock-show', ...await inspectSubjectLease(root, subject) };
  }
  const token = optionString(options, 'confirm');
  if (!token) fail(`Review the lease first (singularity-flow lock show ${kind} ${id}), then confirm its token with --confirm <TOKEN>.`);
  const { releaseLeaseAfterReview } = await import('../subject-lock.mjs');
  return { schemaVersion: 1, resultType: 'sflow-lock-release',
    ...await releaseLeaseAfterReview(root, subject, { expectedLockToken: token }) };
}

function printResult(result) {
  if (result.resultType === 'sflow-lock-show') {
    if (!result.held) return console.log(`No lease is held for ${result.subject.kind} ${result.subject.id}.`);
    const owner = result.owner ?? {};
    console.log(`Lease ${result.subject.kind} ${result.subject.id}: held by process ${owner.pid ?? 'unknown'} on ${owner.host ?? 'unknown host'}`
      + `${result.liveness?.state ? ` (${result.liveness.state}${result.liveness.heartbeat ? `, heartbeat ${result.liveness.heartbeat}` : ''})` : ''}.`);
    if (result.releaseCommand) console.log(`Only a person can end it. When that process is gone: ${result.releaseCommand}`);
    else console.log('Its owner is alive here and still renewing it; it ends when that command finishes.');
    return;
  }
  console.log(result.released ? `Released the reviewed lease${result.lock ? ` at ${result.lock}` : ''}.`
    : `Nothing released (${result.reason ?? 'the lease changed since it was reviewed'}).`);
}

export async function run(_argv, { positionals, options = {} }) {
  const result = await lockCommand(positionals, options);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  return result;
}

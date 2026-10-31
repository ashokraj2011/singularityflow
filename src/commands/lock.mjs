/**
 * `singularity-flow lock show|release|show-file|release-file` (SDA M3, lease-proven lock recovery).
 *
 * A lease is taken over automatically only when its owner is proven gone (src/lease-liveness.mjs);
 * age never decides. A lease whose owner runs on another machine, or runs here but stopped renewing,
 * is ended only by a person: `show` reads it, and `release` removes exactly the generation that person
 * reviewed (its token), recording the release. A refusal that meets such a lease prints these routes.
 * `show-file` and `release-file` do the same for a lease named by its path: a registry lease file
 * (in the home, so they run outside any repository), a cache lease file (a read index refresh lease
 * that `index status` names) or an Authority Store lock directory.
 */
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['show', 'release', 'show-file', 'release-file']);
const OPTIONS = Object.freeze({
  show: ['json'], release: ['confirm', 'json'], 'show-file': ['json'], 'release-file': ['confirm', 'json']
});

function fail(message, code = 'LOCK_COMMAND_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

/** The module that owns a lease named by path: an Authority Store lock directory, or a registry or cache lease file. */
async function fileLeaseOwner(file) {
  const info = await lstat(file).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
  if (info && !info.isFile() && !info.isDirectory()) {
    fail(`${file} is neither a lease file nor a lock directory. Name the path the refusal printed.`, 'LOCK_COMMAND_INVALID', { lock: file });
  }
  if (info?.isDirectory()) {
    const authority = await import('../sgos/platform/authority-store.mjs');
    return {
      inspect: () => authority.inspectAuthorityStoreLock(file),
      release: (token) => authority.releaseAuthorityStoreLockAfterReview(file, { expectedToken: token })
    };
  }
  const leases = await import('../file-lease.mjs');
  return {
    inspect: () => leases.inspectLeaseFile(file),
    release: (token) => leases.releaseLeaseFileAfterReview(file, { expectedToken: token })
  };
}

export async function lockCommand(positionals, options = {}) {
  const subcommand = positionals[1] ?? 'show';
  if (!SUBCOMMANDS.includes(subcommand)) {
    fail(`Unknown lock subcommand '${subcommand}'. Supported: ${SUBCOMMANDS.join(', ')}.`, 'UNKNOWN_SUBCOMMAND',
      { command: 'lock', subcommand, available: [...SUBCOMMANDS] });
  }
  const unknown = Object.keys(options).filter((key) => ![...OPTIONS[subcommand], 'timings'].includes(key)).sort();
  if (unknown.length) fail(`lock ${subcommand} does not accept ${unknown.map((key) => `--${key}`).join(', ')}.`);
  if (subcommand === 'show-file' || subcommand === 'release-file') {
    const file = positionals[2];
    if (!file || positionals.length > 3) {
      fail(`Name the lease file: singularity-flow lock ${subcommand} <LEASE-FILE>${subcommand === 'release-file' ? ' --confirm <TOKEN>' : ''}.`);
    }
    const owner = await fileLeaseOwner(path.resolve(file));
    if (subcommand === 'show-file') return { schemaVersion: 1, resultType: 'sflow-lock-show', ...await owner.inspect() };
    const token = optionString(options, 'confirm');
    if (!token) fail(`Review the lease first (singularity-flow lock show-file ${JSON.stringify(path.resolve(file))}), then confirm its token with --confirm <TOKEN>.`);
    return { schemaVersion: 1, resultType: 'sflow-lock-release', ...await owner.release(token) };
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
    const name = result.subject ? `${result.subject.kind} ${result.subject.id}` : result.lock;
    if (!result.held) {
      console.log(`No lease is held for ${name}.`);
      if (result.subject) console.log('A lease file or lock directory a refusal named by its path is read with: singularity-flow lock show-file <PATH>');
      return;
    }
    const owner = result.owner ?? {};
    console.log(`Lease ${name}: held by process ${owner.pid ?? 'unknown'} on ${owner.host ?? 'unknown host'}`
      + `${result.liveness?.state ? ` (${result.liveness.state}${result.liveness.heartbeat ? `, heartbeat ${result.liveness.heartbeat}` : ''})` : ''}.`);
    if (result.releaseCommand) console.log(`Only a person can end it. When that process is gone: ${result.releaseCommand}`);
    else if (result.form === 'cache' && result.state === 'reclaimable') console.log('Its owner stopped; the next command that needs it takes it over.');
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

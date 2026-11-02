/**
 * SF Guard's remote check of the state branch (SPEC-PSS-v1 §10.9): `governance verify --presence
 * --state-records [--base <REF>]`, run by the CI recipe on every push to the state branch.
 *
 * The repository's person records that live there (a published specification revision, a published
 * split, a configuration approval's seal) are verified as each push adds them: a record recorded while
 * SF Guard was on needs a presence seal that verifies against the approver's pinned key, and no seal
 * may disappear. A record already on the base that does not verify is reported, never failed, so a
 * push is never held by an older one. A repository that never opted in passes with nothing to check.
 *
 * The state branch takes direct pushes, so this check cannot hold one; it fails the run, which is the
 * alarm, and every reader counts only records whose seal verifies whatever the check says.
 */
import { createHash } from 'node:crypto';

import { CONFIGURATION_SEAL_ROOT, parseSeal, repositorySealVerdict, sealedRecord } from './repository-seals.mjs';

const LIBRARY_ROOT = 'singularity/specifications';
const REVISION = /^singularity\/specifications\/(SPEC-[A-Z0-9]+(?:-[A-Z0-9]+)*)\/(\d{6})\/manifest\.json$/u;
const SPLIT = /^singularity\/specifications\/(SPEC-[A-Z0-9]+(?:-[A-Z0-9]+)*)\/splits\/(\d{6})\/split\.json$/u;
const SEAL = /^singularity\/(?:specifications\/.+\/presence\.json|presence-seals\/configuration\/[0-9a-f]{40,64}\.json)$/u;
const CONFIGURATION_SEAL = new RegExp(`^${CONFIGURATION_SEAL_ROOT}/([0-9a-f]{40}(?:[0-9a-f]{24})?)\\.json$`, 'u');
const NO_BASE = /^0+$/u;
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const directoryOf = (file) => file.slice(0, file.lastIndexOf('/'));

function defaultDependencies(root) {
  const git = import('../git.mjs');
  return {
    readPolicy: async (verify) => (await import('./store.mjs')).readPresencePolicy(root, verify ? { verify } : {}),
    head: async () => (await git).refCommit(root, 'HEAD'),
    paths: async (ref) => (await git).committedTreePaths(root, ref, [LIBRARY_ROOT, 'singularity/presence-seals']),
    ledgerPaths: async (ref) => { try { return (await git).committedTreePaths(root, ref, ['ledger/entries']); } catch { return []; } },
    file: async (ref, relative) => (await git).committedFileBytes(root, ref, relative) ?? null
  };
}

/** One record the state branch holds: what its seal must cover, when it says it was recorded, and its route. */
async function recordAt(deps, ref, file) {
  const bytes = await deps.file(ref, file);
  if (!bytes) return null;
  let match = REVISION.exec(file);
  if (match) {
    let manifest = null;
    try { manifest = JSON.parse(bytes.toString('utf8')); } catch { manifest = null; }
    const name = `${match[1]}@${Number(match[2])}`;
    return { name: `revision ${name}`, sealFile: `${directoryOf(file)}/presence.json`, recordedAt: manifest?.recordedAt ?? null,
      record: sealedRecord('spec-revision', name, { manifestSha256: digest(bytes) }),
      route: `a person publishes ${match[1]} again from its draft in their own terminal (singularity-flow spec author publish ${match[1]} --reviewed), where it takes their Touch ID` };
  }
  match = SPLIT.exec(file);
  if (match) {
    let record = null;
    try { record = JSON.parse(bytes.toString('utf8')); } catch { record = null; }
    return { name: `split ${Number(match[2])} of ${match[1]}`, sealFile: `${directoryOf(file)}/presence.json`, recordedAt: record?.recordedAt ?? null,
      record: sealedRecord('spec-split', `${match[1]}#${Number(match[2])}`, { splitSha256: digest(bytes) }),
      route: `a person publishes the split again in their own terminal (singularity-flow spec split ${match[1]}@${record?.revision ?? 'N'} --publish), where it takes their Touch ID` };
  }
  return null;
}

/**
 * Run the check in `root`, a checkout of the state branch as pushed. `base` is the state branch before
 * the push; without it every record is checked. It never throws for what it finds.
 */
export async function remoteStateCheck(root, { base = null, verify = undefined } = {}, dependencies = {}) {
  const baseRef = base && !NO_BASE.test(base) ? base : null;
  const deps = { ...defaultDependencies(root), ...dependencies };
  const failures = [];
  const warnings = [];
  const fail = (code, message, route) => failures.push({ code, message, route: route ?? null });
  const policy = await deps.readPolicy(verify);
  if (!policy?.present || !policy.chain) {
    return { schemaVersion: 1, resultType: 'sflow-presence-state-check', status: 'not-opted-in', base: baseRef, failures, warnings, checked: 0 }; // schema-transient: command result
  }
  const head = await deps.head();
  const headPaths = new Set(await deps.paths(head));
  const basePaths = baseRef ? new Set(await deps.paths(baseRef)) : new Set();
  const verdictOf = (entry, sealBytes) => repositorySealVerdict(policy, { record: entry.record, recordedAt: entry.recordedAt, seal: parseSeal(sealBytes), ...(verify ? { verify } : {}) });
  let checked = 0;
  for (const file of [...headPaths].sort()) {
    const entry = await recordAt(deps, head, file);
    if (entry) {
      checked += 1;
      const verdict = verdictOf(entry, await deps.file(head, entry.sealFile));
      if (verdict.counts) continue;
      const before = baseRef && basePaths.has(file) ? await deps.file(baseRef, file) : null;
      const unchanged = before && Buffer.compare(before, await deps.file(head, file)) === 0;
      if (unchanged) warnings.push(`The ${entry.name} does not verify (${verdict.reason}); it is already on the base and counts for nothing.`);
      else fail(verdict.code ?? 'PSS_RECORD_UNSIGNED', `The ${entry.name} does not verify: ${verdict.reason}.`, entry.route);
      continue;
    }
    const sealed = CONFIGURATION_SEAL.exec(file);
    if (sealed && !(baseRef && basePaths.has(file))) {
      checked += 1;
      const seal = parseSeal(await deps.file(head, file));
      const fields = seal && !seal.invalid ? seal.record ?? {} : {};
      const record = sealedRecord('configuration-approval', sealed[1], { proposalCommit: sealed[1], baseCommit: fields.baseCommit ?? null, branch: fields.branch ?? null });
      const verdict = fields.proposalCommit === sealed[1] ? verdictOf({ record, recordedAt: seal?.presence?.at ?? null }, await deps.file(head, file))
        : { counts: false, code: 'PSS_SIGNATURE_INVALID', reason: 'it is the seal of another commit' };
      if (!verdict.counts) fail(verdict.code ?? 'PSS_SIGNATURE_INVALID', `The configuration approval seal for ${sealed[1].slice(0, 12)} does not verify: ${verdict.reason}.`,
        'remove it; a person approves the configuration in their own terminal (singularity-flow configuration approve <proposal>), where it takes their Touch ID');
    }
  }
  // Capability lease grants and revocations in the ledger (SPEC-PSS-v1 §10.10).
  const { storeRecordProblems } = await import('./store-check.mjs');
  const leases = await storeRecordProblems(policy, { head, base: baseRef, state: true }, { paths: deps.ledgerPaths ?? deps.paths, file: deps.file });
  failures.push(...leases.failures);
  warnings.push(...leases.warnings);
  checked += leases.checked;
  // No seal, and no sealed record, disappears.
  for (const file of [...basePaths].sort()) {
    if (headPaths.has(file)) continue;
    if (SEAL.test(file)) fail('PSS_RECORD_REMOVED', `The presence seal ${file} is on the base and this push removes it.`, 'restore it from the base; a person decides again with its own command, never by deleting a record');
    else if (REVISION.test(file) || SPLIT.test(file)) {
      const sealFile = `${directoryOf(file)}/presence.json`;
      if (basePaths.has(sealFile)) fail('PSS_RECORD_REMOVED', `The sealed record ${file} is on the base and this push removes it.`, 'restore it from the base; a published revision or split is never deleted');
    }
  }
  return { schemaVersion: 1, resultType: 'sflow-presence-state-check', status: failures.length ? 'failed' : 'passed', base: baseRef, failures, warnings, checked }; // schema-transient: command result
}

export function remoteStateText(result) {
  if (result.status === 'not-opted-in') return 'SF Guard state branch check: this repository never opted in; nothing to check.';
  const lines = [`SF Guard state branch check: ${result.status} (${result.checked} record(s) checked${result.base ? ` against ${String(result.base).slice(0, 12)}` : ''}).`];
  for (const failure of result.failures) lines.push(`  FAIL ${failure.code}: ${failure.message}${failure.route ? ` Route: ${failure.route}.` : ''}`);
  for (const warning of result.warnings) lines.push(`  note: ${warning}`);
  return lines.join('\n');
}

/**
 * Portable Git-commit ancestry evidence: that today's `sflow/config` commit descends from the commit a
 * running Story started from, for reviewed approver, skill-version and test-command adoption.
 *
 * SCF:REQ-020: one commits-only fetch of `sflow/config` with no depth limit (CH-F2: the 128-commit
 * window left every long-lived Story unable to adopt anything after about sixty approvals). A proof
 * that fits 128 commits is still written as v1, which every build reads. A longer chain is a v2 proof,
 * bounded by size (1 MiB) instead of a commit count, and is written only once the repository's
 * minimum build reads v2 (`minimumBuildReadsV2`). When there is no ancestry at all, because
 * `sflow/config` was rewritten outside SFlow, the refusal says so and names the route (D9): an approver
 * adopts the new configuration in the same step, recorded in a v2 proof as adopted without ancestry.
 *
 * Replay (verify) is here, on every Story read; capture and adoption fetch, so they load only when a
 * command records one (skp-ancestry-capture.mjs).
 */
import { createHash } from 'node:crypto';
import { assertCredentialFreeRemote } from './git-remote-diagnostics.mjs';
import { readRecord } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
// `commits` and `proofBytes` bound a v1 proof: every build reads it, so they never change. A v2 proof is
// bounded by `v2ProofBytes` alone, about 2,000 commits of the measured size. `repositoryBytes` bounds the
// commits-only scratch: 16 MiB holds roughly 70,000 commits (3,000 typical approval commits measured 330 KB
// with their index), so the unbounded fetch needs no larger bound.
export const SKP_ANCESTRY_LIMITS = Object.freeze({ commits: 128, commitBytes: 65536,
  proofBytes: 512 * 1024, v2ProofBytes: 1024 * 1024, repositoryBytes: 16 * 1024 * 1024 });
/**
 * The first build that reads ancestry proof v2 [SCF:REQ-020]. A repository's minimum build is the build
 * its approved package baseline names (SCF:REQ-016, `singularity/.product/configuration-baseline.yml`
 * v2); a build is ordered by its clean stamp's `builtAt`, the source commit's time (D1). Builds made from
 * a source commit at or after this instant read v2, so v2 is written only where the minimum build is that
 * recent. It must not be earlier than the commit that lands this reader on main.
 */
export const ANCESTRY_PROOF_V2_READERS_SINCE = '2026-11-17T00:00:00.000Z';
export const ANCESTRY_ADOPTION_CAUSES = Object.freeze(['sflow-config-rewritten', 'ancestry-beyond-proof-limit']);

export function fail(message, code = 'SKP_AMENDMENT_ANCESTRY_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
export function commitParents(bytes, oid, format) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > SKP_ANCESTRY_LIMITS.commitBytes
      || createHash(format).update(`commit ${bytes.length}\0`).update(bytes).digest('hex') !== oid) {
    fail('Configuration ancestry contains bytes that do not identify their exact Git commit.');
  }
  const end = bytes.indexOf(Buffer.from('\n\n'));
  if (end < 0) fail('Configuration ancestry commit has no complete Git header.');
  const headers = bytes.subarray(0, end).toString('utf8').split('\n');
  const width = format === 'sha1' ? 40 : 64;
  if (!new RegExp(`^tree [a-f0-9]{${width}}$`, 'u').test(headers[0])) {
    fail('Configuration ancestry commit has no exact tree header.');
  }
  const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
  if (parents.length > 32 || parents.some((parent) => !OID.test(parent) || parent.length !== width)
      || new Set(parents).size !== parents.length) fail('Configuration ancestry has malformed parents.');
  return parents;
}

const PROOF_KEYS = ['schemaVersion', 'kind', 'repository', 'ancestorCommit', 'descendantCommit', 'objectFormat', 'commits'];

/**
 * Replays retained object hashes/parent edges; requires no Git, remote, or machine-local cache. A v1
 * proof holds at most 128 commits; a v2 proof any number within 1 MiB. A v2 proof may instead record
 * that an approver adopted the configuration without ancestry (D9); only a caller that records such an
 * adoption with its own approver binding (an approver refresh) passes `allowAdoption`.
 */
export function verifySkillConfigurationAncestry(proof, { repository, ancestorCommit, descendantCommit }, {
  allowAdoption = false
} = {}) {
  let storedVersion;
  try { storedVersion = readRecord('skill-configuration-ancestry', proof).storedVersion; }
  catch { fail('Configuration ancestry has no supported registered reader.'); }
  const v2 = storedVersion === 2;
  const adoption = v2 && proof && Object.hasOwn(proof, 'adoptedWithoutAncestry') ? proof.adoptedWithoutAncestry : null;
  if (!exact(proof, adoption ? [...PROOF_KEYS, 'adoptedWithoutAncestry'] : PROOF_KEYS)
      || proof.kind !== 'skill-configuration-ancestry'
      || proof.repository !== repository || proof.ancestorCommit !== ancestorCommit
      || proof.descendantCommit !== descendantCommit || !OID.test(ancestorCommit ?? '')
      || !OID.test(descendantCommit ?? '') || ancestorCommit === descendantCommit
      || ancestorCommit.length !== descendantCommit.length
      || proof.objectFormat !== (ancestorCommit.length === 40 ? 'sha1' : 'sha256')
      || !Array.isArray(proof.commits) || (adoption ? proof.commits.length !== 0 : !proof.commits.length)
      || (!v2 && proof.commits.length > SKP_ANCESTRY_LIMITS.commits)
      || Buffer.byteLength(JSON.stringify(proof)) > (v2 ? SKP_ANCESTRY_LIMITS.v2ProofBytes : SKP_ANCESTRY_LIMITS.proofBytes)) {
    fail('Configuration ancestry does not bind the exact prior and next authority commits.');
  }
  assertCredentialFreeRemote(repository);
  if (adoption) {
    if (!allowAdoption) {
      fail('Configuration ancestry records an adoption without ancestry, which only an approver refresh may record.');
    }
    if (!exact(adoption, ['cause', 'confirmedBy']) || !ANCESTRY_ADOPTION_CAUSES.includes(adoption.cause)
        || typeof adoption.confirmedBy !== 'string' || !adoption.confirmedBy.trim() || adoption.confirmedBy.length > 512) {
      fail('Configuration ancestry adoption does not name its cause and the approver who confirmed it.');
    }
    return true;
  }
  let expected = descendantCommit;
  const seen = new Set();
  for (let index = 0; index < proof.commits.length; index += 1) {
    const entry = proof.commits[index];
    if (!exact(entry, ['oid', 'bytesBase64']) || entry.oid !== expected || seen.has(entry.oid)
        || typeof entry.bytesBase64 !== 'string'
        || entry.bytesBase64.length > Math.ceil(SKP_ANCESTRY_LIMITS.commitBytes / 3) * 4) {
      fail('Configuration ancestry commit sequence is missing, repeated, or out of order.');
    }
    seen.add(entry.oid);
    const bytes = Buffer.from(entry.bytesBase64, 'base64');
    if (bytes.toString('base64') !== entry.bytesBase64) fail('Configuration ancestry bytes are not canonical.');
    const parents = commitParents(bytes, entry.oid, proof.objectFormat);
    expected = index + 1 < proof.commits.length ? proof.commits[index + 1]?.oid : ancestorCommit;
    if (!parents.includes(expected)) fail('The proposed configuration does not descend from the prior authority commit.');
  }
  return true;
}

/** Whether `build`, a repository's minimum build, reads ancestry proof v2 [SCF:REQ-020]. */
export function minimumBuildReadsV2(build) {
  return Boolean(build?.builtAt) && Date.parse(build.builtAt) >= Date.parse(ANCESTRY_PROOF_V2_READERS_SINCE);
}

/** The proof that `snapshot`'s configuration descends from `priorSource`'s commit (skp-ancestry-capture.mjs). */
export async function captureSkillConfigurationAncestry(snapshot, priorSource) {
  return (await import('./skp-ancestry-capture.mjs')).captureSkillConfigurationAncestry(snapshot, priorSource);
}

/** An approver's adoption of `snapshot`'s configuration without ancestry, as a v2 proof (D9; skp-ancestry-capture.mjs). */
export async function adoptConfigurationWithoutAncestry(snapshot, priorSource, adoption) {
  return (await import('./skp-ancestry-capture.mjs')).adoptConfigurationWithoutAncestry(snapshot, priorSource, adoption);
}

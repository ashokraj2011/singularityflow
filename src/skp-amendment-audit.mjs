/** Portable, bounded Git-commit ancestry evidence for reviewed skill adoption. */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runRemoteGitAsync } from './git-execution.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { assertCredentialFreeRemote, frozenRemoteTransport } from './git-remote-diagnostics.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { processResultSucceeded } from './process-result.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { removeTemporaryTree, run, SingularityFlowError } from './util.mjs';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const SKP_ANCESTRY_LIMITS = Object.freeze({ commits: 128, commitBytes: 65536,
  proofBytes: 512 * 1024, repositoryBytes: 16 * 1024 * 1024 });
const CAPTURED = new WeakMap();

function fail(message, code = 'SKP_AMENDMENT_ANCESTRY_INVALID') {
  throw new SingularityFlowError(message, { code });
}
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function commitParents(bytes, oid, format) {
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

/** Replays retained object hashes/parent edges; requires no Git, remote, or machine-local cache. */
export function verifySkillConfigurationAncestry(proof, { repository, ancestorCommit, descendantCommit }) {
  try { readRecord('skill-configuration-ancestry', proof); }
  catch { fail('Configuration ancestry has no supported registered reader.'); }
  if (!exact(proof, ['schemaVersion', 'kind', 'repository', 'ancestorCommit', 'descendantCommit',
    'objectFormat', 'commits'])
      || proof.kind !== 'skill-configuration-ancestry'
      || proof.repository !== repository || proof.ancestorCommit !== ancestorCommit
      || proof.descendantCommit !== descendantCommit || !OID.test(ancestorCommit ?? '')
      || !OID.test(descendantCommit ?? '') || ancestorCommit === descendantCommit
      || ancestorCommit.length !== descendantCommit.length
      || proof.objectFormat !== (ancestorCommit.length === 40 ? 'sha1' : 'sha256')
      || !Array.isArray(proof.commits) || !proof.commits.length
      || proof.commits.length > SKP_ANCESTRY_LIMITS.commits
      || Buffer.byteLength(JSON.stringify(proof)) > SKP_ANCESTRY_LIMITS.proofBytes) {
    fail('Configuration ancestry does not bind the exact prior and next authority commits.');
  }
  assertCredentialFreeRemote(repository);
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

async function directoryBytes(root) {
  let total = 0;
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail('Configuration ancestry scratch storage contains a symlink.');
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) total += (await lstat(absolute)).size;
      else fail('Configuration ancestry scratch storage contains a special file.');
      if (total > SKP_ANCESTRY_LIMITS.repositoryBytes) {
        fail('Configuration ancestry exceeds its bounded repository storage.', 'SKP_AMENDMENT_ANCESTRY_LIMIT');
      }
    }
  };
  await visit(root);
}

/** Fetches only the exact approved source into disposable, bounded commit-only storage. */
export async function captureSkillConfigurationAncestry(snapshot, priorSource) {
  const subject = { repository: snapshot?.authority?.remote, ancestorCommit: priorSource?.commit,
    descendantCommit: snapshot?.sourceCommit };
  if (!snapshot || typeof snapshot !== 'object' || subject.repository !== priorSource?.repository
      || !OID.test(subject.ancestorCommit ?? '') || !OID.test(subject.descendantCommit ?? '')
      || subject.ancestorCommit === subject.descendantCommit
      || subject.ancestorCommit.length !== subject.descendantCommit.length) {
    fail('Configuration ancestry requires two exact commits on the same approved authority.');
  }
  const key = JSON.stringify(subject);
  const prior = CAPTURED.get(snapshot)?.get(key);
  if (prior) { verifySkillConfigurationAncestry(prior, subject); return structuredClone(prior); }
  assertCredentialFreeRemote(subject.repository);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-ancestry-'));
  const objectFormat = subject.descendantCommit.length === 40 ? 'sha1' : 'sha256';
  let objectService = null;
  let firstFailure = null;
  let capturedProof = null;
  try {
    run('git', ['init', '--bare', '--quiet', '--template=', `--object-format=${objectFormat}`, scratch],
      { cwd: scratch, env: withoutGitProcessOverrides() });
    const transport = frozenRemoteTransport(subject.repository);
    const fetched = await runRemoteGitAsync(['-c', 'fetch.unpackLimit=1', 'fetch', '--no-tags',
      '--no-write-fetch-head', '--filter=tree:0', `--depth=${SKP_ANCESTRY_LIMITS.commits}`,
      '--', transport.remote, subject.descendantCommit], { cwd: scratch, env: transport.env,
      operation: 'remote-configuration', maxBuffer: 1024 * 1024 });
    if (!processResultSucceeded(fetched)) fail('The exact configuration ancestry is unavailable from its approved authority.',
      'SKP_AMENDMENT_ANCESTRY_UNAVAILABLE');
    await directoryBytes(scratch);
    // Capture is an explicit adoption operation, not part of ordinary offline proof replay.
    // PACKAGE_ROOT selects the source owner in development and the staged CLI owner in a VSIX;
    // the computed URL keeps its process/runtime graph out of long-lived editor read bundles.
    const runtimeUrl = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'fos-object-service.mjs')).href;
    const { FosGitObjectService } = await import(runtimeUrl);
    objectService = new FosGitObjectService(scratch, {
      maxObjectBytes: SKP_ANCESTRY_LIMITS.commitBytes
    });
    const pending = [{ oid: subject.descendantCommit, chain: [] }];
    const seen = new Set();
    while (pending.length && seen.size < SKP_ANCESTRY_LIMITS.commits) {
      const { oid, chain } = pending.shift();
      if (seen.has(oid)) continue;
      seen.add(oid);
      const result = await objectService.read(oid);
      if (!result) continue;
      if (result.type !== 'commit') fail('Configuration ancestry names a non-commit Git object.');
      const bytes = Buffer.from(result.bytes);
      const parents = commitParents(bytes, oid, objectFormat);
      const commits = [...chain, { oid, bytesBase64: bytes.toString('base64') }];
      if (parents.includes(subject.ancestorCommit)) {
        const proof = { schemaVersion: currentSchemaVersion('skill-configuration-ancestry'),
          kind: 'skill-configuration-ancestry', ...subject,
          objectFormat, commits };
        verifySkillConfigurationAncestry(proof, subject);
        capturedProof = proof;
        break;
      }
      for (const parent of parents) if (!seen.has(parent)) pending.push({ oid: parent, chain: commits });
    }
    if (!capturedProof) {
      fail('The proposed configuration has no proven ancestry within the bounded authority history.',
        'SKP_AMENDMENT_ANCESTRY_UNAVAILABLE');
    }
  } catch (error) {
    firstFailure = error;
    throw error;
  } finally {
    try {
      const cleanup = objectService ? await objectService.close() : { terminated: true };
      if (!cleanup.terminated) fail('Configuration ancestry worker cleanup is unproven.',
        'SKP_AMENDMENT_ANCESTRY_UNAVAILABLE');
      await removeTemporaryTree(scratch);
    } catch (error) {
      // No scratch removal occurs before worker termination is proven. Preserve the first
      // refusal if cleanup also fails, but a successful capture cannot bypass unknown cleanup.
      if (!firstFailure) throw error;
    }
  }
  // A proof cannot become replayable until its worker and private scratch have both retired.
  // Otherwise retrying the same approved snapshot would bypass a preceding cleanup refusal.
  const cache = CAPTURED.get(snapshot) ?? new Map();
  cache.set(key, structuredClone(capturedProof)); CAPTURED.set(snapshot, cache);
  return capturedProof;
}

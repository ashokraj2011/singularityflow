/**
 * Capturing configuration ancestry proofs [SCF:REQ-020, D9]: one commits-only fetch of `sflow/config` with
 * no depth limit, a v1 proof when the chain fits 128 commits, else v2 where the repository's minimum build
 * reads it, and an approver's adoption without ancestry when `sflow/config` was rewritten outside SFlow.
 * Loaded only by a command that records a proof; every Story read replays it with skp-amendment-audit.mjs.
 */
import { mkdtemp, readdir, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runRemoteGitAsync } from './git-execution.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { assertCredentialFreeRemote, frozenRemoteTransport } from './git-remote-diagnostics.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { processResultSucceeded } from './process-result.mjs';
import { ANCESTRY_ADOPTION_CAUSES, ANCESTRY_PROOF_V2_READERS_SINCE, SKP_ANCESTRY_LIMITS, commitParents, fail,
  minimumBuildReadsV2, verifySkillConfigurationAncestry } from './skp-amendment-audit.mjs';
import { sourceContains, sourceRevision } from './source-inspection.mjs';
import { removeTemporaryTree, run, SingularityFlowError } from './util.mjs';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PACKAGE_BASELINE_PATH = 'singularity/.product/configuration-baseline.yml';
const BASELINE_FORMAT_V2 = 'singularity-flow-configuration-baseline/v2';
const CAPTURED = new WeakMap();

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

/** A private, empty bare repository for one capture's fetched objects. */
function initScratch(scratch, objectFormat) {
  run('git', ['init', '--bare', '--quiet', '--template=', `--object-format=${objectFormat}`, scratch],
    { cwd: scratch, env: withoutGitProcessOverrides() });
}

const short = (commit) => String(commit ?? '').slice(0, 12);
const day = (instant) => String(instant ?? '').slice(0, 10);

/**
 * The build the repository's approved package baseline names at `commit`, its minimum build (SCF:REQ-016):
 * `{ builtAt, commit }`, or null when its baseline names none (v1, none recorded, or no baseline).
 * One shallow fetch of that commit, made only when a v2 proof is needed.
 */
async function repositoryMinimumBuild(transport, commit, objectFormat) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-baseline-'));
  try {
    initScratch(scratch, objectFormat);
    const fetched = await runRemoteGitAsync(['fetch', '--no-tags', '--no-write-fetch-head', '--depth=1',
      '--', transport.remote, commit], { cwd: scratch, env: transport.env, operation: 'remote-configuration' });
    if (!processResultSucceeded(fetched)) {
      fail('The repository\'s minimum build could not be read from its approved configuration.', 'SKP_AMENDMENT_ANCESTRY_UNAVAILABLE');
    }
    const { sourceFileAt } = await import('./source-inspection.mjs');
    const file = sourceFileAt(scratch, commit, PACKAGE_BASELINE_PATH, { offline: true, maxBytes: 4 * 1024 * 1024 });
    if (file.status === 'absent') return null;
    if (file.status !== 'present') {
      fail('The repository\'s minimum build could not be read from its approved configuration.', 'SKP_AMENDMENT_ANCESTRY_UNAVAILABLE');
    }
    const { default: YAML } = await import('yaml');
    let baseline = null;
    try { baseline = YAML.parse(file.value); } catch { return null; }
    const build = baseline?.format === BASELINE_FORMAT_V2 ? baseline.build : null;
    return build && Number.isFinite(Date.parse(build.builtAt ?? ''))
      ? { builtAt: new Date(Date.parse(build.builtAt)).toISOString(), commit: typeof build.commit === 'string' ? build.commit : null }
      : null;
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/** A v2 proof may be written here: the repository's minimum build reads it. Else the specific refusal. */
async function assertV2Readable(subject, transport, objectFormat, why) {
  const minimum = await repositoryMinimumBuild(transport, subject.descendantCommit, objectFormat);
  if (minimumBuildReadsV2(minimum)) return minimum;
  const since = day(ANCESTRY_PROOF_V2_READERS_SINCE);
  fail(`${why} Recording it needs the newer proof format (v2), which builds from before ${since} cannot read, and this `
    + `repository's minimum build is ${minimum ? `from ${day(minimum.builtAt)}` : 'not recorded'}. Nothing was changed. `
    + `Once everyone on the team runs a build from ${since} or later, upgrade this repository with it, which records that build `
    + 'as its minimum, then run this again.', 'SKP_AMENDMENT_ANCESTRY_UPGRADE_REQUIRED', {
    minimumBuild: minimum, readersSince: ANCESTRY_PROOF_V2_READERS_SINCE,
    nextAction: { command: 'singularity-flow workspace refresh-configuration',
      label: `Upgrade this repository to a build from ${since} or later, then retry` }
  });
}

/** The refusal for a Story whose starting commit is no longer in sflow/config's history (D9). */
function rewrittenRefusal(subject, { v2Readable }) {
  return new SingularityFlowError(
    `sflow/config was rewritten outside SFlow: the commit this Story started from (${short(subject.ancestorCommit)}) is no longer `
      + `in its history, so nothing proves today's configuration (${short(subject.descendantCommit)}) came from it. Nothing was changed.`, {
      code: 'SKP_AMENDMENT_ANCESTRY_REWRITTEN',
      details: { cause: 'sflow-config-rewritten', ancestorCommit: subject.ancestorCommit,
        descendantCommit: subject.descendantCommit, v2Readable,
        actions: [{ label: 'An approver may adopt the rewritten configuration for this Story\'s approvers in the same step, recorded as '
          + 'adopted without ancestry (story approvers refresh <WORK-ID> --reason <WHY> --adopt-without-ancestry). For a skill or test-command '
          + 'change, restore sflow/config\'s history on the Git host (push the commit this Story started from back into it), or start a new Story on today\'s configuration.' }] }
    });
}

/**
 * Record that an approver adopts `snapshot`'s configuration without ancestry (D9), as a v2 proof. Only
 * when the repository's minimum build reads v2; its confirmation is the caller's own reviewed step.
 */
export async function adoptConfigurationWithoutAncestry(snapshot, priorSource, { cause, confirmedBy }) {
  const subject = { repository: snapshot?.authority?.remote, ancestorCommit: priorSource?.commit,
    descendantCommit: snapshot?.sourceCommit };
  if (!snapshot || subject.repository !== priorSource?.repository || !OID.test(subject.ancestorCommit ?? '')
      || !OID.test(subject.descendantCommit ?? '') || subject.ancestorCommit === subject.descendantCommit
      || subject.ancestorCommit.length !== subject.descendantCommit.length) {
    fail('Configuration adoption requires two exact commits on the same approved authority.');
  }
  if (!ANCESTRY_ADOPTION_CAUSES.includes(cause) || typeof confirmedBy !== 'string' || !confirmedBy.trim()) {
    fail('Configuration adoption names its cause and the approver who confirms it.');
  }
  assertCredentialFreeRemote(subject.repository);
  const objectFormat = subject.descendantCommit.length === 40 ? 'sha1' : 'sha256';
  await assertV2Readable(subject, frozenRemoteTransport(subject.repository), objectFormat,
    'Adopting this configuration without ancestry is recorded with the approver\'s confirmation.');
  const proof = { schemaVersion: 2, kind: 'skill-configuration-ancestry', ...subject, objectFormat, commits: [],
    adoptedWithoutAncestry: { cause, confirmedBy } };
  verifySkillConfigurationAncestry(proof, subject, { allowAdoption: true });
  return proof;
}

/**
 * Fetches every commit of the exact approved source, commits only and with no depth limit, into
 * disposable storage bounded by its size, and proves the prior commit is in its history. The chain
 * from the new commit back to the prior one is a v1 proof when it fits 128 commits, else v2.
 */
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
  const transport = frozenRemoteTransport(subject.repository);
  let objectService = null;
  let firstFailure = null;
  let capturedProof = null;
  try {
    initScratch(scratch, objectFormat);
    // One commits-only fetch with no depth limit [SCF:REQ-020]: the whole history of sflow/config.
    const fetched = await runRemoteGitAsync(['-c', 'fetch.unpackLimit=1', 'fetch', '--no-tags',
      '--no-write-fetch-head', '--filter=tree:0',
      '--', transport.remote, subject.descendantCommit], { cwd: scratch, env: transport.env,
      operation: 'remote-configuration', maxBuffer: 1024 * 1024 });
    if (!processResultSucceeded(fetched)) fail('The exact configuration ancestry is unavailable from its approved authority.',
      'SKP_AMENDMENT_ANCESTRY_UNAVAILABLE');
    await directoryBytes(scratch);
    // The whole history is here, so a prior commit that is not in it was rewritten away (D9).
    const local = withoutGitProcessOverrides();
    const known = sourceRevision(scratch, subject.ancestorCommit, { env: local, offline: true });
    const contained = known.status === 'present'
      ? sourceContains(scratch, subject.ancestorCommit, subject.descendantCommit, { env: local, offline: true }) : known;
    if (contained.status === 'absent' || (contained.status === 'present' && contained.value === false)) {
      let v2Readable = false;
      try { v2Readable = minimumBuildReadsV2(await repositoryMinimumBuild(transport, subject.descendantCommit, objectFormat)); }
      catch { v2Readable = false; }
      throw rewrittenRefusal(subject, { v2Readable });
    }
    if (contained.status !== 'present') fail('The exact configuration ancestry could not be read from its fetched history.',
      'SKP_AMENDMENT_ANCESTRY_UNAVAILABLE');
    // Capture is an explicit adoption operation, not part of ordinary offline proof replay.
    // PACKAGE_ROOT selects the source owner in development and the staged CLI owner in a VSIX;
    // the computed URL keeps its process/runtime graph out of long-lived editor read bundles.
    const runtimeUrl = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'fos-object-service.mjs')).href;
    const { FosGitObjectService } = await import(runtimeUrl);
    objectService = new FosGitObjectService(scratch, {
      maxObjectBytes: SKP_ANCESTRY_LIMITS.commitBytes
    });
    // Breadth first over the whole fetched history, each commit remembering the child that reached it,
    // so the chain is the shortest path from the new commit back to the prior one.
    const reachedFrom = new Map([[subject.descendantCommit, null]]);
    const bytesOf = new Map();
    const pending = [subject.descendantCommit];
    let found = null;
    for (let head = 0; head < pending.length && !found; head += 1) {
      const oid = pending[head];
      const result = await objectService.read(oid);
      if (!result) continue;
      if (result.type !== 'commit') fail('Configuration ancestry names a non-commit Git object.');
      const bytes = Buffer.from(result.bytes);
      bytesOf.set(oid, bytes.toString('base64'));
      const parents = commitParents(bytes, oid, objectFormat);
      if (parents.includes(subject.ancestorCommit)) { found = oid; break; }
      for (const parent of parents) {
        if (!reachedFrom.has(parent)) { reachedFrom.set(parent, oid); pending.push(parent); }
      }
    }
    if (!found) {
      fail('The proposed configuration has no proven ancestry in the authority\'s fetched history.',
        'SKP_AMENDMENT_ANCESTRY_UNAVAILABLE');
    }
    const commits = [];
    for (let oid = found; oid != null; oid = reachedFrom.get(oid)) commits.unshift({ oid, bytesBase64: bytesOf.get(oid) });
    const v1 = { schemaVersion: 1, kind: 'skill-configuration-ancestry', ...subject, objectFormat, commits };
    if (commits.length <= SKP_ANCESTRY_LIMITS.commits && Buffer.byteLength(JSON.stringify(v1)) <= SKP_ANCESTRY_LIMITS.proofBytes) {
      capturedProof = v1;
    } else {
      const v2 = { ...v1, schemaVersion: 2 };
      if (Buffer.byteLength(JSON.stringify(v2)) > SKP_ANCESTRY_LIMITS.v2ProofBytes) {
        fail(`sflow/config moved ${commits.length} commits past the commit this Story started from, more than one ancestry `
          + `proof can hold (1 MiB). Nothing was changed. An approver may adopt today's configuration for this Story's approvers, `
          + 'recorded as adopted without ancestry (story approvers refresh <WORK-ID> --reason <WHY> --adopt-without-ancestry).',
        'SKP_AMENDMENT_ANCESTRY_LIMIT', { cause: 'ancestry-beyond-proof-limit', commits: commits.length,
          actions: [{ label: 'An approver may adopt today\'s configuration for this Story\'s approvers, recorded as adopted without ancestry '
            + '(story approvers refresh <WORK-ID> --reason <WHY> --adopt-without-ancestry). For a skill or test-command change, start a new Story on today\'s configuration.' }] });
      }
      await assertV2Readable(subject, transport, objectFormat,
        `sflow/config moved ${commits.length} commits past the commit this Story started from, more than older builds can check (128).`);
      capturedProof = v2;
    }
    verifySkillConfigurationAncestry(capturedProof, subject);
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

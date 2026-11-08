/**
 * Where the findings register lives [CQF:REQ-063], and reading and writing it.
 *
 * It is a governed file on the SFlow state branch, written through `publishToStateBranch` (src/ledger.mjs),
 * so every developer and every Story reads the same list. A read uses the state ref this clone already
 * has and never fetches. A write fetches, as that writer does, and publishes under an exact precondition
 * on each file it read, so two imports never overwrite each other's rows.
 *
 * The state branch is readable by anyone who can read the repository. So on a public repository the
 * register stays in this clone's private local store (below the Git directory), and the result says
 * why. Whether a repository is public: a GitHub remote is asked with `gh api` (read-only, gh's own
 * sign-in); any other remote counts as private; a check that cannot be made keeps the register local
 * this time and says so. A write that cannot reach the remote keeps it local too, and the next write
 * that can publish carries it.
 */
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from '../../git-execution.mjs';
import { refCommit } from '../../git.mjs';
import { readRefTreeResult } from '../../git-ref-tree.mjs';
import { normalizeLedgerConfig } from '../../ledger-config.mjs';
import { readPrivateSidecar, writeMutablePrivateSidecar } from '../../private-sidecar.mjs';
import { run, SingularityFlowError } from '../../util.mjs';
import { repositoryKey } from './format.mjs';
import { emptyRegister, mergeRegisters, registerFile, REGISTER_PATHS } from './model.mjs';

const MAXIMUM_FILE_BYTES = 16 * 1024 * 1024;
const PUBLISH_ATTEMPTS = 3;
// A definite answer about visibility is kept a week; "could not check" is never kept.
const VISIBILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PARTS = Object.freeze(['security', 'tlm', 'imports']);

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const localDirectory = (root) => path.join(gitCommonDir(root), 'singularity-flow', 'findings');
const localFile = (root, part) => path.join(localDirectory(root), `${part}.json`);

/** The repository's ledger settings: workflow.yml's `ledger`, or the defaults (origin, state). */
export async function registerLedger(root) {
  const { existsSync } = await import('node:fs');
  if (!existsSync(path.join(root, 'singularity', 'workflow.yml'))) return normalizeLedgerConfig({});
  const { loadConfig } = await import('../../state-stores.mjs');
  return normalizeLedgerConfig((await loadConfig(root))?.ledger ?? {});
}

/** What the register's Story reads need from workflow.yml: the default branch, remote and work-item root. */
export async function repositorySettings(root) {
  const { existsSync } = await import('node:fs');
  const config = existsSync(path.join(root, 'singularity', 'workflow.yml'))
    ? await (await import('../../state-stores.mjs')).loadConfig(root).catch(() => ({})) : {};
  return { defaultBranch: config.defaultBaseBranch ?? 'main', remote: config.git?.remote ?? 'origin',
    workItemRoot: config.workItemRoot ?? 'singularity/work-items' };
}

/** This repository as the register names repositories: `owner/name` from its remote, and its name. */
export async function currentRepository(root, ledger, { env = process.env } = {}) {
  const { configuredRemoteIdentity } = await import('../../git-remote-diagnostics.mjs');
  const identity = configuredRemoteIdentity(root, ledger.remote, { direction: 'fetch', env });
  const url = identity.configured && !identity.ambiguous ? identity.url : null;
  const slug = url ? repositoryKey(url) : null;
  const name = (slug ?? path.basename(root)).split('/').at(-1).toLowerCase();
  return { url, slug: slug && slug.includes('/') ? slug.split('/').slice(-2).join('/') : null, name };
}

/** The state ref this clone has: the remote-tracking one when it exists, else the local branch. */
export function registerStateRef(root, ledger, { env = process.env } = {}) {
  for (const ref of [`refs/remotes/${ledger.remote}/${ledger.branch}`, `refs/heads/${ledger.branch}`]) {
    const commit = refCommit(root, ref, { env });
    if (commit) return { ref, commit };
  }
  return { ref: null, commit: null };
}

function parse(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { return { damaged: label }; }
}

/** The register on the state branch at this clone's state ref, with the exact bytes each file had. */
export function readStateRegister(root, ledger, { env = process.env } = {}) {
  const { ref, commit } = registerStateRef(root, ledger, { env });
  const register = emptyRegister();
  const bytes = {};
  const damaged = [];
  if (commit) {
    // One tree listing and one batch read for the three files, at the commit just resolved.
    const observed = readRefTreeResult(root, commit, Object.values(REGISTER_PATHS), { env, maxObjectBytes: MAXIMUM_FILE_BYTES, maxBatchBytes: 3 * MAXIMUM_FILE_BYTES });
    if (observed.status !== 'ok') {
      throw new SingularityFlowError(`The findings register at ${ref} could not be read: ${observed.errors[0]?.message ?? observed.status}`, {
        code: 'FINDINGS_REGISTER_UNAVAILABLE', details: { ref, status: observed.status } });
    }
    for (const part of PARTS) {
      const content = observed.contents.get(REGISTER_PATHS[part]);
      const found = content == null ? null : Buffer.from(content);
      bytes[part] = found;
      if (!found) continue;
      const value = parse(found, REGISTER_PATHS[part]);
      const read = registerFile(part, value.damaged ? undefined : value);
      if (value.damaged || read.damaged) damaged.push(REGISTER_PATHS[part]);
      else register[part] = read.file;
    }
  }
  return { ref, commit, register, bytes, damaged };
}

/** The register kept in this clone's private local store, or null when there is none. */
export async function readLocalRegister(root) {
  const register = emptyRegister();
  let found = false;
  for (const part of PARTS) {
    const bytes = await readPrivateSidecar(root, localFile(root, part), { maximumBytes: MAXIMUM_FILE_BYTES, optional: true }).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!bytes) continue;
    const read = registerFile(part, parse(bytes, part));
    if (!read.damaged) { register[part] = read.file; found = true; }
  }
  return found ? register : null;
}

/** The register this clone reads: the state branch's, with anything kept locally laid over it. */
export async function readRegister(root, { env = process.env, ledger = null } = {}) {
  const settings = ledger ?? await registerLedger(root);
  const state = readStateRegister(root, settings, { env });
  const local = await readLocalRegister(root);
  return {
    ledger: settings, ref: state.ref, commit: state.commit, damaged: state.damaged,
    location: local ? (state.commit && state.bytes.security ? 'state-branch and local' : 'local') : state.commit ? 'state-branch' : 'none',
    register: mergeRegisters(state.register, local), state
  };
}

async function cachedVisibility(root) {
  const bytes = await readPrivateSidecar(root, localFile(root, 'visibility'), { maximumBytes: 4096, optional: true }).catch(() => null);
  const value = bytes ? parse(bytes, 'visibility') : null;
  return value && !value.damaged && Date.now() - Date.parse(value.observedAt ?? '') < VISIBILITY_TTL_MS ? value : null;
}

/**
 * Where the register may be written: the state branch, or this clone's local store with the reason.
 * `runCommand` is the process runner (tests stand in for gh).
 */
export async function registerDestination(root, ledger, { runCommand = run, env = process.env } = {}) {
  const [{ configuredRemoteIdentity }, { classifyGitHost }] = await Promise.all([
    import('../../git-remote-diagnostics.mjs'), import('../../git-host.mjs')]);
  const identity = configuredRemoteIdentity(root, ledger.remote, { direction: 'fetch', env });
  if (!identity.configured || !identity.url) {
    return { store: 'local', reason: 'no-remote', message: `This repository has no remote '${ledger.remote}', so the register is kept on this computer.` };
  }
  const host = classifyGitHost(identity.url);
  if (host.provider !== 'github') return { store: 'state-branch', visibility: 'private', reason: 'not-github', message: `The remote is ${host.label ?? 'not GitHub'}, so it counts as private: the register goes to the ${ledger.branch} branch.` };
  const cached = await cachedVisibility(root);
  const slug = repositoryKey(identity.url);
  let visibility = cached?.slug === slug ? cached.visibility : null;
  if (!visibility) {
    const { githubRepositoryVisibility } = await import('../../github-evidence.mjs');
    const answer = githubRepositoryVisibility(root, identity.url, { runCommand });
    if (!answer.visibility) {
      return { store: 'local', reason: 'visibility-unknown', message: `Whether this GitHub repository is public could not be checked (${answer.reason}), so the register is kept on this computer this time. The next import that can check publishes it to the ${ledger.branch} branch.` };
    }
    visibility = answer.visibility;
    await writeMutablePrivateSidecar(root, localFile(root, 'visibility'), Buffer.from(JSON.stringify({ slug, visibility, observedAt: new Date().toISOString() })),
      { maximumBytes: 4096 }).catch(() => {});
  }
  if (visibility === 'public') {
    return { store: 'local', visibility, reason: 'public-repository', message: `This repository is public, and anyone who can read it can read its ${ledger.branch} branch. The register is kept on this computer (in the Git directory, never committed).` };
  }
  return { store: 'state-branch', visibility, reason: 'private-repository', message: `This repository is ${visibility}: the register goes to the ${ledger.branch} branch.` };
}

const fileBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

async function writeLocal(root, register) {
  for (const part of PARTS) {
    const bytes = fileBytes(register[part]);
    if (bytes.length > MAXIMUM_FILE_BYTES) throw new SingularityFlowError(`The findings register's ${part} file is larger than ${MAXIMUM_FILE_BYTES} bytes.`, { code: 'FINDINGS_REGISTER_TOO_LARGE' });
    await writeMutablePrivateSidecar(root, localFile(root, part), bytes, { maximumBytes: MAXIMUM_FILE_BYTES });
  }
}

/**
 * Write the register `change(current)` returns, where `destination` says. `change` runs on the latest
 * register each attempt (the state branch's, with the local copy laid over it), so a concurrent write
 * is merged, never lost. Returns where it went, and the register written.
 */
export async function writeRegister(root, ledger, destination, change, message, { env = process.env } = {}) {
  if (destination.store === 'local') {
    const current = await readRegister(root, { env, ledger });
    const register = change(current.register);
    await writeLocal(root, register);
    return { store: 'local', register, reason: destination.reason, message: destination.message };
  }
  const { publishToStateBranch } = await import('../../ledger.mjs');
  let lastError = null;
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt += 1) {
    const state = readStateRegister(root, ledger, { env });
    const local = await readLocalRegister(root);
    const register = change(mergeRegisters(state.register, local));
    const files = {};
    const preconditions = {};
    const exact = {};
    for (const part of PARTS) {
      const bytes = fileBytes(register[part]);
      const before = state.bytes[part] ?? null;
      if (before && before.equals(bytes)) continue;
      files[REGISTER_PATHS[part]] = bytes;
      exact[REGISTER_PATHS[part]] = digest(bytes);
      preconditions[REGISTER_PATHS[part]] = before
        ? { condition: 'exact', bytes: before.length, sha256: digest(before), gitMode: '100644' }
        : { condition: 'absent' };
    }
    try {
      const published = Object.keys(files).length
        ? await publishToStateBranch(root, ledger, files, `[findings] ${message}`, { pathPreconditions: preconditions, exactBlobSha256: exact, env })
        : null;
      // What was kept locally is on the state branch now.
      if (local) for (const part of PARTS) await rm(localFile(root, part), { force: true }).catch(() => {});
      return { store: 'state-branch', register, commit: published?.commit ?? state.commit, changed: Boolean(published?.commit), branch: ledger.branch,
        reason: destination.reason, message: destination.message };
    } catch (error) {
      lastError = error;
      if (error?.concurrent || error?.code === 'state_branch.path_precondition_failed') continue;
      break;
    }
  }
  // The remote could not take it: keep it here, say so, and let the next write publish it.
  const current = await readRegister(root, { env, ledger });
  const register = change(current.register);
  await writeLocal(root, register);
  const detail = String(lastError?.message ?? lastError ?? 'the publication failed').split('\n')[0].slice(0, 300);
  return { store: 'local', register, reason: 'publication-failed',
    message: `The ${ledger.branch} branch could not be written (${detail}). The register is kept on this computer; the next import or Story that can publish carries it.` };
}

/**
 * The committed files and manifest text `repository-projects.mjs` reads, from a checkout or a remote URL.
 *
 * A checkout is read at HEAD from its own objects. A remote is read without a working tree: one shallow, blobless
 * clone of its branch (trees only) into a throwaway folder, then, for what that clone lacks, one fetch of exactly
 * the manifest blobs the tree names, as Git's own partial-clone fetch asks for them. Every local read goes through
 * the reviewed tree reader with lazy fetch off (git-ref-tree.mjs), and every network call through the governed
 * remote boundary (git-execution.mjs). Nothing else of the repository is downloaded; the folder is always removed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { typedRevision } from './git-access.mjs';
import { repoRoot, runRemoteGitAsync } from './git-execution.mjs';
import { readRefTreeResult } from './git-ref-tree.mjs';
import { assertCredentialFreeRemote, frozenRemoteTransport, sanitizeRemote } from './git-remote-diagnostics.mjs';
import { remoteUrl } from './git.mjs';
import { PROJECT_LIMITS, projectManifestFiles } from './repository-projects.mjs';
import { SingularityFlowError } from './util.mjs';

const MAXIMUM_TREE_FILES = 500_000;
const FETCH_CHUNK = 400;

const unavailable = (message, nextAction) => new SingularityFlowError(message, { code: 'REPOSITORY_PROJECTS_TREE_UNAVAILABLE', details: { nextAction } });

/** Every committed file of HEAD in `root`, with its blob ID; no blob is read. */
function committedTree(root, env) {
  const files = []; const oids = new Map();
  const listed = readRefTreeResult(root, 'HEAD', [], { env, pathFilter: (file, entry) => {
    if (entry.type === 'blob' && files.length <= MAXIMUM_TREE_FILES) { files.push(file); oids.set(file, entry.oid); }
    return false;
  } });
  if (listed.status !== 'ok') throw unavailable('Could not list the repository\'s committed files.', 'singularity-flow capability projects --path <CHECKOUT> --json');
  return { files, oids, truncated: files.length > MAXIMUM_TREE_FILES };
}

/** The manifests' text at HEAD, keyed by path, or null when some of their blobs are not in `root` yet. */
function manifestText(root, manifests, env) {
  const wanted = new Set(manifests);
  const read = readRefTreeResult(root, 'HEAD', [], { env, maxObjectBytes: PROJECT_LIMITS.manifestBytes, pathFilter: (file) => wanted.has(file) });
  if (read.status !== 'ok' && read.status !== 'partial') return null;
  if (read.status === 'partial' && read.errors?.some((error) => /MISSING|PROMISOR|NOT_FOUND|UNAVAILABLE/u.test(error.code ?? ''))) return null;
  return new Map([...read.contents].map(([file, text]) => [file, String(text)]));
}

/** A checkout's projects' input, read at its HEAD. */
export function checkoutProjectFiles(directory, { env = process.env } = {}) {
  let root;
  try { root = repoRoot(directory); } catch {
    throw new SingularityFlowError(`${directory} is not inside a Git checkout.`, { code: 'REPOSITORY_PROJECTS_NOT_A_CHECKOUT',
      details: { nextAction: 'singularity-flow capability projects <GIT-URL> --json' } });
  }
  const tree = committedTree(root, env);
  const manifests = projectManifestFiles(tree.files);
  const text = manifestText(root, manifests.files, env) ?? new Map();
  let repositoryUrl = null;
  try { const origin = remoteUrl(root, 'origin', { env }); repositoryUrl = origin ? assertCredentialFreeRemote(origin) : null; } catch { repositoryUrl = null; }
  return { root, repositoryUrl, commit: typedRevision(root, 'HEAD'), files: tree.files, text, manifestsTruncated: manifests.truncated || tree.truncated };
}

/** A remote repository's projects' input: its default branch, or `branch`, read without a working tree. */
export async function remoteProjectFiles(remote, { branch = null, env = process.env, runRemoteCommand = runRemoteGitAsync } = {}) {
  const repositoryUrl = assertCredentialFreeRemote(remote);
  const transport = frozenRemoteTransport(repositoryUrl, { env });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-repository-projects-'));
  const failed = (what, outcome) => new SingularityFlowError(`Could not read the ${what} of ${sanitizeRemote(repositoryUrl)}. ${outcome.failure?.advice ?? 'Git failed.'}`, {
    code: outcome.failure?.code ?? 'REPOSITORY_PROJECTS_UNAVAILABLE',
    details: { nextAction: 'singularity-flow capability projects --path <CHECKOUT> --json' } });
  try {
    const cloned = await runRemoteCommand(['-c', 'core.autocrlf=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1', '--filter=blob:none', '--no-checkout',
      ...(branch ? ['--branch', branch] : []), transport.remote, scratch], { cwd: path.dirname(scratch), operation: 'remote-configuration', env: transport.env });
    if (cloned.status !== 0) throw failed('projects', cloned);
    const tree = committedTree(scratch, env);
    const manifests = projectManifestFiles(tree.files);
    // A server that ignores the blob filter already sent every blob, and may refuse a request for one by ID.
    let text = manifestText(scratch, manifests.files, env);
    if (!text) {
      const ids = [...new Set(manifests.files.map((file) => tree.oids.get(file)))];
      // Exactly the manifest blobs, as Git's own partial-clone fetch asks for them, in bounded requests.
      for (let start = 0; start < ids.length; start += FETCH_CHUNK) {
        const fetched = await runRemoteCommand(['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head',
          '--recurse-submodules=no', '--filter=blob:none', 'origin', ...ids.slice(start, start + FETCH_CHUNK)],
        { cwd: scratch, operation: 'remote-configuration', env: transport.env });
        if (fetched.status !== 0) throw failed('build files', fetched);
      }
      text = manifestText(scratch, manifests.files, env);
      if (!text) throw unavailable(`Could not read the build files of ${sanitizeRemote(repositoryUrl)} after fetching them.`, 'singularity-flow capability projects --path <CHECKOUT> --json');
    }
    return { root: null, repositoryUrl, commit: typedRevision(scratch, 'HEAD'), branch, files: tree.files, text,
      manifestsTruncated: manifests.truncated || tree.truncated };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

import { mkdtemp, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { classifyPartialCloneResult } from './clone-strategy.mjs';
import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { refHead } from './git.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';
import { assertCredentialFreeRemote, frozenRemoteTransport, isPortableAbsoluteGitPath } from './git-remote-diagnostics.mjs';
import {
  enqueueRepositoryOnboardingCleanup, repositoryOnboardingCleanupContention
} from './repository-onboarding-cleanup.mjs';
import { readRecord } from './schema-migrations.mjs';
import { validateId } from './state.mjs';
import { posix, removeTemporaryTree, SingularityFlowError } from './util.mjs';

const CONFIGURATION_BRANCH = 'sflow/config';
const MAX_HEADS = 4096;
const MAX_TREE_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BLOB_BYTES = 1024 * 1024;
const MAX_METADATA_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_OBJECT_STORE_BYTES = 256 * 1024 * 1024;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Framework-owned refs can carry configuration history but are never Story branches. */
export function isStoryDiscoveryBranch(branch) {
  return branch !== 'state' && !branch.startsWith('sflow/');
}

function remoteUrl(url) {
  const checked = assertCredentialFreeRemote(String(url ?? '').trim());
  if (!/^(?:https?:\/\/|git@|ssh:\/\/|file:\/\/)/u.test(checked)
      && !isPortableAbsoluteGitPath(checked)) {
    throw new SingularityFlowError('Story discovery requires an explicit repository URL or absolute bare-repository path.', {
      code: 'SESSION_REMOTE_URL_REQUIRED'
    });
  }
  return checked;
}

function advertisedHeads(output) {
  const heads = new Map();
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    if (!line) continue;
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/heads\/(.+)$/u.exec(line);
    if (!match) throw new SingularityFlowError('The Story remote advertised an invalid branch ref.', {
      code: 'SESSION_REMOTE_REFS_INVALID'
    });
    heads.set(match[2], match[1]);
  }
  if (heads.size > MAX_HEADS) throw new SingularityFlowError(
    `The Story remote advertises more than ${MAX_HEADS} branches; discovery cannot safely inspect them in one request.`,
    { code: 'SESSION_REMOTE_DISCOVERY_LIMIT' }
  );
  return heads;
}

async function objectStoreBytes(directory) {
  let total = 0;
  const pending = [path.join(directory, '.git', 'objects')];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) total += (await stat(target)).size;
      if (total > MAX_OBJECT_STORE_BYTES) return total;
    }
  }
  return total;
}

function refBlobOid(root, ref, file, env) {
  const oid = refHead(root, `${ref}:${file}`, { env: { ...env, GIT_NO_LAZY_FETCH: '1' } });
  return OID.test(oid ?? '') ? oid : null;
}

async function storyPathsAtRef(root, ref, workRoot, env) {
  const listed = await runRemoteGitAsync([
    'ls-tree', '-r', '-z',
    '--format=%(objectmode)%x09%(objecttype)%x09%(objectname)%x09%(path)',
    ref, '--', workRoot
  ], {
    cwd: root, env: { ...env, GIT_NO_LAZY_FETCH: '1' }, operation: 'local-read',
    maxBuffer: MAX_TREE_OUTPUT_BYTES
  });
  if (listed.status !== 0) throw new SingularityFlowError(
    `Could not list Story state at '${ref}'.`, { code: 'SESSION_REMOTE_TREE_UNAVAILABLE' }
  );
  return listed.stdout.split('\0').filter(Boolean).map((row) => {
    const [mode, type, oid, ...pathParts] = row.split('\t');
    return { mode, type, oid, file: pathParts.join('\t') };
  }).filter((entry) => entry.file.endsWith('/workflow.json'));
}

function unavailable(code, branch, relative, reason, claimedId = null) {
  return {
    code, claimedId, branch, ref: `origin/${branch}`, path: relative ?? null, reason
  };
}

async function probeHeads(transport, label) {
  const advertised = await runRemoteGitAsync([
    'ls-remote', '--heads', '--', transport.remote
  ], { operation: 'remote-probe', env: transport.env, maxBuffer: MAX_TREE_OUTPUT_BYTES });
  if (advertised.status !== 0) throw new SingularityFlowError(
    `Could not inspect the ${label} remote. ${advertised.failure?.advice ?? 'Git access failed.'}`,
    { code: advertised.failure?.code ?? 'SESSION_REMOTE_UNAVAILABLE' }
  );
  return advertisedHeads(advertised.stdout);
}

async function cleanupScratch(scratch) {
  if (!scratch) return;
  try { await removeTemporaryTree(scratch); }
  catch (error) {
    if (!repositoryOnboardingCleanupContention(error)) throw error;
    const queued = await enqueueRepositoryOnboardingCleanup(scratch).catch(() => false);
    if (!queued) process.emitWarning('A temporary Story discovery checkout could not be deleted or queued for cleanup.');
  }
}

async function negotiateBloblessFetch(transport, branch) {
  const probe = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-discovery-'));
  try {
    const initialized = await runRemoteGitAsync(['init', '--bare', '--quiet', probe], {
      cwd: path.dirname(probe), operation: 'remote-configuration', env: transport.env
    });
    if (initialized.status !== 0) throw new SingularityFlowError(
      'Could not prepare the temporary Story discovery probe.',
      { code: 'SESSION_REMOTE_DISCOVERY_UNAVAILABLE' }
    );
    // Git's dry run negotiates the filter capability without fetching a pack. This is needed
    // when the delivery remote has no small configuration branch to clone as its first ref.
    const negotiated = await runRemoteGitAsync([
      'fetch', '--dry-run', '--no-tags', '--depth=1', '--filter=blob:none',
      transport.remote, `refs/heads/${branch}`
    ], { cwd: probe, operation: 'remote-probe', env: transport.env });
    if (negotiated.status !== 0) throw new SingularityFlowError(
      `Could not negotiate blobless Story discovery. ${negotiated.failure?.advice ?? 'Git access failed.'}`,
      { code: negotiated.failure?.code ?? 'SESSION_REMOTE_UNAVAILABLE' }
    );
    // This only rejects an explicit server warning; the subsequent clone must independently
    // prove the promisor/filter configuration before any all-heads fetch is allowed.
    if (classifyPartialCloneResult(negotiated, { configured: true }).kind !== 'partial-established') {
      throw new SingularityFlowError(
        'The Story remote does not support a blobless fetch, so URL-only discovery stopped before cloning a delivery branch.',
        { code: 'SESSION_REMOTE_FILTER_UNSUPPORTED' }
      );
    }
  } finally {
    await cleanupScratch(probe);
  }
}

async function cloneBloblessBranch(transport, branch, expectedCommit, {
  negotiateFilterFirst = false
} = {}) {
  if (negotiateFilterFirst) await negotiateBloblessFetch(transport, branch);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-discovery-'));
  try {
    // Preflight one explicitly advertised ref before fetching every branch. No application
    // checkout is created, and a remote that ignores blob filtering never gets an all-heads fetch.
    const cloned = await runRemoteGitAsync([
      '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
      'clone', '--quiet', '--no-local', '--no-tags', '--depth', '1', '--filter=blob:none',
      '--no-checkout', '--single-branch', `--branch=${branch}`,
      transport.remote, scratch
    ], { cwd: path.dirname(scratch), operation: 'remote-configuration', env: transport.env });
    if (cloned.status !== 0) throw new SingularityFlowError(
      `Could not inspect the advertised '${branch}' branch. ${cloned.failure?.advice ?? 'Git access failed.'}`,
      { code: cloned.failure?.code ?? 'SESSION_REMOTE_UNAVAILABLE' }
    );
    const promisor = await runRemoteGitAsync(['config', '--local', '--get', 'remote.origin.promisor'], {
      cwd: scratch, operation: 'local-read', env: transport.env
    });
    const filter = await runRemoteGitAsync(['config', '--local', '--get', 'remote.origin.partialclonefilter'], {
      cwd: scratch, operation: 'local-read', env: transport.env
    });
    const partial = classifyPartialCloneResult(cloned, {
      configured: promisor.status === 0 && promisor.stdout.trim() === 'true'
        && filter.status === 0 && filter.stdout.trim() === 'blob:none'
    });
    if (partial.kind !== 'partial-established') throw new SingularityFlowError(
      'The Story remote did not establish a verified blobless fetch, so URL-only discovery stopped before fetching source branches.',
      { code: 'SESSION_REMOTE_FILTER_UNSUPPORTED' }
    );
    const observed = refHead(scratch, `refs/remotes/origin/${branch}`, {
      env: { ...transport.env, GIT_NO_LAZY_FETCH: '1' }
    });
    if (observed !== expectedCommit) throw new SingularityFlowError(
      `Branch '${branch}' changed while its remote metadata was being read. Refresh and retry.`,
      { code: 'SESSION_REMOTE_CHANGED' }
    );
    if (await objectStoreBytes(scratch) > MAX_OBJECT_STORE_BYTES) throw new SingularityFlowError(
      'The remote did not provide a bounded blobless branch preflight.',
      { code: 'SESSION_REMOTE_DISCOVERY_LIMIT' }
    );
    return scratch;
  } catch (error) {
    await cleanupScratch(scratch);
    throw error;
  }
}

/**
 * Read published Story metadata from a URL before its delivery repository is materialized.
 * The temporary object store receives only shallow commits/trees and explicitly requested
 * configuration/Story blobs. No application checkout or workspace repository is created.
 */
export async function discoverRemoteStoryCandidatesByUrl(url, {
  env = process.env, configurationUrl = null, approvedDefinition = null
} = {}) {
  const selectedUrl = remoteUrl(url);
  const transport = frozenRemoteTransport(selectedUrl, { env });
  // Materialized workspace discovery may already hold a validated approved definition from its
  // lead repository. Delivery repositories need not own sflow/config; never force one onto them.
  if (approvedDefinition != null) validateDefinition(approvedDefinition);
  const selectedConfigurationUrl = approvedDefinition == null
    ? (configurationUrl == null ? selectedUrl : remoteUrl(configurationUrl)) : null;
  const configurationTransport = approvedDefinition != null ? null
    : selectedConfigurationUrl === selectedUrl ? transport
      : frozenRemoteTransport(selectedConfigurationUrl, { env });
  const heads = await probeHeads(transport, 'Story');
  const configurationHeads = configurationTransport == null ? null
    : configurationTransport === transport ? heads : await probeHeads(configurationTransport, 'configuration');
  if (configurationHeads && !configurationHeads.has(CONFIGURATION_BRANCH)) throw new SingularityFlowError(
    `The configuration remote has no approved ${CONFIGURATION_BRANCH} branch for metadata-only discovery.`,
    { code: 'SESSION_REMOTE_CONFIGURATION_REQUIRED' }
  );

  let configurationScratch = null;
  let scratch = null;
  try {
    if (configurationTransport) configurationScratch = await cloneBloblessBranch(
      configurationTransport, CONFIGURATION_BRANCH, configurationHeads.get(CONFIGURATION_BRANCH)
    );

    let metadataBytes = 0;
    const blobs = new Map();
    const readBlob = async (store, storeTransport, oid) => {
      const cacheKey = `${store}:${oid}`;
      if (blobs.has(cacheKey)) return blobs.get(cacheKey);
      const observed = await runRemoteGitAsync(['cat-file', 'blob', oid], {
        cwd: store, operation: 'remote-configuration', env: storeTransport.env,
        maxBuffer: MAX_METADATA_BLOB_BYTES + 1
      });
      if (observed.status !== 0) throw new SingularityFlowError(
        'A Story metadata blob could not be read within its size and Git access limits.',
        { code: 'SESSION_REMOTE_METADATA_UNAVAILABLE' }
      );
      metadataBytes += Buffer.byteLength(observed.stdout, 'utf8');
      if (metadataBytes > MAX_METADATA_TOTAL_BYTES) throw new SingularityFlowError(
        'Story metadata exceeds the discovery request limit.',
        { code: 'SESSION_REMOTE_DISCOVERY_LIMIT' }
      );
      blobs.set(cacheKey, observed.stdout);
      return observed.stdout;
    };
    let effectiveApprovedDefinition = approvedDefinition;
    if (configurationTransport) {
      const approvedOid = refBlobOid(
        configurationScratch, `refs/remotes/origin/${CONFIGURATION_BRANCH}`,
        WORKFLOW_PATH, configurationTransport.env
      );
      if (!approvedOid) throw new SingularityFlowError(
        `Approved ${CONFIGURATION_BRANCH} is missing ${WORKFLOW_PATH}.`,
        { code: 'SESSION_REMOTE_CONFIGURATION_UNAVAILABLE' }
      );
      try {
        effectiveApprovedDefinition = YAML.parse(await readBlob(configurationScratch, configurationTransport, approvedOid));
        validateDefinition(effectiveApprovedDefinition);
      } catch (error) {
        throw new SingularityFlowError(`Approved Story configuration is unreadable: ${error.message}`, {
          code: 'SESSION_REMOTE_CONFIGURATION_UNAVAILABLE'
        });
      }
    }

    // The delivery repository need not own sflow/config. Select only a ref it actually
    // advertised; no default/application branch is guessed or checked out.
    const preflightBranch = heads.has(CONFIGURATION_BRANCH)
      ? CONFIGURATION_BRANCH : [...heads.keys()].sort()[0];
    if (!preflightBranch) return {
      source: 'remote-url', repositoryPath: null, remote: 'origin', fetched: true,
      count: 0, items: [], unavailableCount: 0, unavailable: []
    };
    if (configurationTransport === transport) {
      scratch = configurationScratch;
      configurationScratch = null;
    } else {
      await cleanupScratch(configurationScratch);
      configurationScratch = null;
      scratch = await cloneBloblessBranch(transport, preflightBranch, heads.get(preflightBranch), {
        negotiateFilterFirst: true
      });
    }

    const fetched = await runRemoteGitAsync([
      'fetch', '--no-tags', '--depth=1', '--filter=blob:none',
      transport.remote, '+refs/heads/*:refs/remotes/origin/*'
    ], { cwd: scratch, operation: 'remote-configuration', env: transport.env });
    if (fetched.status !== 0) throw new SingularityFlowError(
      `Could not fetch Story branch metadata. ${fetched.failure?.advice ?? 'Git access failed.'}`,
      { code: fetched.failure?.code ?? 'SESSION_REMOTE_UNAVAILABLE' }
    );
    if (classifyPartialCloneResult(fetched, { configured: true }).kind !== 'partial-established'
        || await objectStoreBytes(scratch) > MAX_OBJECT_STORE_BYTES) {
      throw new SingularityFlowError(
        'The Story remote did not provide a bounded blobless branch inventory.',
        { code: 'SESSION_REMOTE_DISCOVERY_LIMIT' }
      );
    }
    for (const [branch, expected] of heads) {
      const ref = `refs/remotes/origin/${branch}`;
      const observed = refHead(scratch, ref, {
        env: { ...transport.env, GIT_NO_LAZY_FETCH: '1' }
      });
      if (observed !== expected) throw new SingularityFlowError(
        `Story branch '${branch}' changed while its remote metadata was being read. Refresh and retry.`,
        { code: 'SESSION_REMOTE_CHANGED' }
      );
    }

    const items = new Map();
    const diagnostics = [];
    for (const [branch, commit] of heads) {
      if (!isStoryDiscoveryBranch(branch)) continue;
      const ref = `refs/remotes/origin/${branch}`;
      let definition = effectiveApprovedDefinition;
      try {
        const ownOid = refBlobOid(scratch, ref, WORKFLOW_PATH, transport.env);
        if (ownOid) {
          definition = YAML.parse(await readBlob(scratch, transport, ownOid));
          validateDefinition(definition);
        }
        const workRoot = definition.workItemRoot ?? 'singularity/work-items';
        const entries = await storyPathsAtRef(scratch, ref, workRoot, transport.env);
        for (const entry of entries) {
          const claimedId = path.posix.basename(path.posix.dirname(entry.file));
          try {
            if (!/^100(?:644|755)$/u.test(entry.mode) || entry.type !== 'blob' || !OID.test(entry.oid)) {
              throw new Error('Story state is not a regular Git blob');
            }
            validateId(definition, claimedId);
            const expectedPath = posix(path.join(workRoot, claimedId, 'workflow.json'));
            if (entry.file !== expectedPath) throw new Error('Story state path does not match its pinned root');
            const workflow = readRecord('story-workflow', JSON.parse(
              await readBlob(scratch, transport, entry.oid)
            )).record;
            if (workflow?.workItem?.id !== claimedId
                || !workflow?.phases || !Array.isArray(workflow?.phaseOrder)) {
              throw new Error('Story state identity or workflow structure is invalid');
            }
            const canonical = workflow.lineage?.canonicalBranch ?? workflow.workItem.branch ?? claimedId;
            if (canonical !== branch) continue;
            if (items.has(claimedId)) throw new Error('Story ID is claimed by more than one canonical branch');
            items.set(claimedId, {
              id: claimedId, branch: canonical, title: workflow.workItem.title,
              status: workflow.status, phase: workflow.currentPhase, commit: commit.slice(0, 8)
            });
          } catch (error) {
            diagnostics.push(unavailable(
              'SESSION_STORY_INVALID', branch, entry.file, error.message, claimedId
            ));
          }
        }
      } catch (error) {
        if (error.code === 'SESSION_REMOTE_DISCOVERY_LIMIT') throw error;
        diagnostics.push(unavailable(
          'SESSION_REMOTE_BRANCH_UNAVAILABLE', branch, null, error.message
        ));
      }
    }
    return {
      source: 'remote-url', repositoryPath: null, remote: 'origin', fetched: true,
      count: items.size, items: [...items.values()].sort((a, b) => a.id.localeCompare(b.id)),
      unavailableCount: diagnostics.length, unavailable: diagnostics
    };
  } finally {
    await cleanupScratch(scratch);
    await cleanupScratch(configurationScratch);
  }
}

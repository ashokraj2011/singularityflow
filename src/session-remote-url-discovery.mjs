import { mkdtemp, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { classifyPartialCloneResult } from './clone-strategy.mjs';
import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { refHead } from './git.mjs';
import { readObjectsBatch } from './git-ref-tree.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';
import { assertCredentialFreeRemote, frozenRemoteTransport, isPortableAbsoluteGitPath } from './git-remote-diagnostics.mjs';
import {
  enqueueRepositoryOnboardingCleanup, repositoryOnboardingCleanupContention
} from './repository-onboarding-cleanup.mjs';
import { readRecord } from './schema-migrations.mjs';
import { storyLifecycleProgress } from './session-roster.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { storyPointersFromLedger } from './story-state-index.mjs';
import { validateId } from './state-stores.mjs';
import { posix, removeTemporaryTree, SingularityFlowError } from './util.mjs';

const CONFIGURATION_BRANCH = 'sflow/config';
const MAX_HEADS = 4096;
const MAX_TREE_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BLOB_BYTES = 1024 * 1024;
const MAX_METADATA_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_OBJECT_STORE_BYTES = 256 * 1024 * 1024;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
// Object IDs per by-ID fetch: 256 SHA-256 IDs stay far below the Windows command-line limit.
const PREFETCH_GROUP = 256;

/** Framework-owned refs can carry configuration history but are never Story branches. */
export function isStoryDiscoveryBranch(branch) {
  return branch !== 'state' && !branch.startsWith('sflow/');
}

/**
 * The refusal when the approved configuration never writes the state index.
 *
 * With `ledger.enabled: false` nothing appends Story pointers, so the index is missing by
 * configuration, not because a refresh failed. The refresh wording sent people back to Refresh,
 * which cannot succeed; this names the setting and the migration that makes discovery work.
 */
export function ledgerDisabledDiscoveryError(authority, cause = undefined) {
  return new SingularityFlowError(
    `Remote Story discovery reads the state ledger on branch '${authority.branch}', but ledger.enabled is false in the approved configuration, so Stories started from other clones are not indexed. Enable the ledger in approved configuration, run singularity-flow ledger init, then singularity-flow ledger reconcile. Application branches are not scanned; a Story already in this checkout opens with singularity-flow session open-local <STORY-ID>.`,
    { code: 'SESSION_STATE_INDEX_UNAVAILABLE', details: { ledgerEnabled: false, stateBranch: authority.branch }, cause }
  );
}

/**
 * The candidate row for a Story the ledger summarized, or null to read its committed state.
 *
 * The row is what discovery shows and offers; `session attach` still proves the Story from its
 * own committed state before it is used. An ID the approved definition does not accept is read
 * from that state as before, under the Story's own pinned definition.
 */
export function ledgerSummaryCandidate(definition, pointer) {
  const story = pointer?.story;
  if (!story) return null;
  try { validateId(definition, pointer.id); } catch { return null; }
  return {
    id: story.id, branch: story.branch, title: story.title, createdAt: story.createdAt ?? null,
    status: story.status, phase: story.phase, progress: story.progress,
    commit: story.commit, commitOid: story.commitOid, aliases: story.aliases
  };
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

async function probeHeads(transport, label, branches = [CONFIGURATION_BRANCH]) {
  const advertised = await runRemoteGitAsync([
    'ls-remote', '--heads', '--', transport.remote, ...branches.map(branch => `refs/heads/${branch}`)
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
  const configurationHeads = configurationTransport == null ? null
    : await probeHeads(configurationTransport, 'configuration');
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
    // Blobs a by-ID fetch brought into a clone, read in one local batch. Each one counts toward
    // the metadata limit only when it is read, as a blob fetched on its own does.
    const prefetched = new Map();
    /**
     * Fetch the named blobs in one request per group instead of one lazy fetch each. `[perf]`
     *
     * A blobless clone fetched every blob discovery read on its own, one after another: each
     * ledger entry, then each Story's definition and workflow.json. Each is an authenticated
     * round trip, and on Windows each also starts Git, its HTTPS helper and the credential
     * manager. This is best effort: a blob it does not bring is still fetched by readBlob.
     */
    const prefetchBlobs = async (store, storeTransport, oids) => {
      const wanted = [...new Set(oids)].filter((oid) => OID.test(oid ?? '')
        && !blobs.has(`${store}:${oid}`) && !prefetched.has(`${store}:${oid}`));
      if (!wanted.length) return;
      const limits = { env: storeTransport.env, maxObjectBytes: MAX_METADATA_BLOB_BYTES + 1, maxBatchBytes: MAX_METADATA_TOTAL_BYTES };
      const present = readObjectsBatch(store, wanted, { ...limits, checkOnly: true });
      const missing = wanted.filter((oid) => present?.get(oid)?.status !== 'ok');
      for (let offset = 0; offset < missing.length; offset += PREFETCH_GROUP) {
        // The request Git makes for a lazy fetch, made once for the group. A failed request is
        // not repeated for the next group; readBlob reports the blob it could not bring.
        const fetched = await runRemoteGitAsync([
          '-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '--no-tags', '--no-write-fetch-head',
          '--recurse-submodules=no', '--filter=blob:none', '--refmap=', storeTransport.remote,
          ...missing.slice(offset, offset + PREFETCH_GROUP)
        ], { cwd: store, operation: 'remote-configuration', env: storeTransport.env });
        if (fetched.status !== 0) break;
      }
      for (const [oid, answer] of readObjectsBatch(store, wanted, limits) ?? []) {
        if (answer.status === 'ok' && answer.bytes) prefetched.set(`${store}:${oid}`, answer.bytes.toString('utf8'));
      }
    };
    const readBlob = async (store, storeTransport, oid) => {
      const cacheKey = `${store}:${oid}`;
      if (blobs.has(cacheKey)) return blobs.get(cacheKey);
      let text = prefetched.get(cacheKey);
      if (text == null) {
        const observed = await runRemoteGitAsync(['cat-file', 'blob', oid], {
          cwd: store, operation: 'remote-configuration', env: storeTransport.env,
          maxBuffer: MAX_METADATA_BLOB_BYTES + 1
        });
        if (observed.status !== 0) throw new SingularityFlowError(
          'A Story metadata blob could not be read within its size and Git access limits.',
          { code: 'SESSION_REMOTE_METADATA_UNAVAILABLE' }
        );
        text = observed.stdout;
      }
      metadataBytes += Buffer.byteLength(text, 'utf8');
      if (metadataBytes > MAX_METADATA_TOTAL_BYTES) throw new SingularityFlowError(
        'Story metadata exceeds the discovery request limit.',
        { code: 'SESSION_REMOTE_DISCOVERY_LIMIT' }
      );
      blobs.set(cacheKey, text);
      return text;
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

    const authority = normalizeLedgerConfig(effectiveApprovedDefinition.ledger ?? {});
    const heads = await probeHeads(transport, 'Story state', [authority.branch]);
    if (!heads.has(authority.branch) && !authority.enabled) throw ledgerDisabledDiscoveryError(authority);
    if (!heads.has(authority.branch)) throw new SingularityFlowError(
      `The Story remote has no '${authority.branch}' state index. Initialize or reconcile its ledger; application branches were not scanned.`,
      { code: 'SESSION_STATE_INDEX_UNAVAILABLE' }
    );
    scratch = await cloneBloblessBranch(transport, authority.branch, heads.get(authority.branch));
    const stateRef = `refs/remotes/origin/${authority.branch}`;
    const headOid = refBlobOid(scratch, stateRef, 'ledger/head.json', transport.env);
    if (!headOid) throw new SingularityFlowError('The Story state index has no ledger head.', { code: 'SESSION_STATE_INDEX_INVALID' });
    const listed = await runRemoteGitAsync(['ls-tree', '-r', '-z', stateRef, '--', 'ledger/entries'], {
      cwd: scratch, operation: 'local-read', env: { ...transport.env, GIT_NO_LAZY_FETCH: '1' }, maxBuffer: MAX_TREE_OUTPUT_BYTES
    });
    if (listed.status !== 0) throw new SingularityFlowError('The Story state index is unreadable.', { code: 'SESSION_STATE_INDEX_INVALID' });
    const rows = [];
    for (const row of listed.stdout.split('\0').filter(Boolean)) {
      const match = /^100(?:644|755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(ledger\/entries\/.+\.json)$/u.exec(row);
      if (!match) throw new SingularityFlowError('The Story state index contains unsafe ledger metadata.', { code: 'SESSION_STATE_INDEX_INVALID' });
      rows.push(match);
    }
    await prefetchBlobs(scratch, transport, [headOid, ...rows.map((match) => match[1])]);
    const entries = new Map();
    for (const match of rows) entries.set(match[2], await readBlob(scratch, transport, match[1]));
    const pointers = storyPointersFromLedger(readRecord('ledger-entry', await readBlob(scratch, transport, headOid)).record, entries);
    if (pointers.length > MAX_HEADS) throw new SingularityFlowError('The state Story roster exceeds its request bound.', { code: 'SESSION_REMOTE_DISCOVERY_LIMIT' });
    const items = new Map();
    const diagnostics = [];
    // A Story whose ledger entry carries its summary is listed from it. The others are proven
    // from their committed state below.
    const proven = [];
    for (const pointer of pointers) {
      if (!isStoryDiscoveryBranch(pointer.branch)) continue;
      const summarized = ledgerSummaryCandidate(effectiveApprovedDefinition, pointer);
      if (summarized) items.set(summarized.id, summarized);
      else proven.push(pointer);
    }
    // Fetch only immutable commits named by this verified state chain, never a wildcard head set.
    const commits = [...new Set(proven.map(item => item.commitOid))];
    for (let offset = 0; offset < commits.length; offset += 128) {
      const fetched = await runRemoteGitAsync([
        'fetch', '--no-tags', '--depth=1', '--filter=blob:none', '--refmap=',
        transport.remote, ...commits.slice(offset, offset + 128)
      ], { cwd: scratch, operation: 'remote-configuration', env: transport.env });
      if (fetched.status !== 0 || classifyPartialCloneResult(fetched, { configured: true }).kind !== 'partial-established') {
        throw new SingularityFlowError('The exact state-indexed Story metadata could not be fetched.', { code: 'SESSION_REMOTE_METADATA_UNAVAILABLE' });
      }
    }
    if (await objectStoreBytes(scratch) > MAX_OBJECT_STORE_BYTES) throw new SingularityFlowError('State-indexed Story metadata exceeds its object-store bound.', { code: 'SESSION_REMOTE_DISCOVERY_LIMIT' });

    // Each Story below reads its pinned definition, then its workflow.json under the root that
    // definition names: fetch each of the two sets in one request.
    const definitionOids = new Map(proven.map(({ commitOid }) => [commitOid, refBlobOid(scratch, commitOid, WORKFLOW_PATH, transport.env)]));
    await prefetchBlobs(scratch, transport, [...definitionOids.values()]);
    const listedPaths = new Map();
    const pathsAt = (ref, pathspec) => {
      const key = `${ref}\0${pathspec}`;
      if (!listedPaths.has(key)) listedPaths.set(key, storyPathsAtRef(scratch, ref, pathspec, transport.env));
      return listedPaths.get(key);
    };
    const stateOids = [];
    for (const { id: indexedId, commitOid } of proven) {
      const source = prefetched.get(`${scratch}:${definitionOids.get(commitOid)}`);
      if (source == null) continue;
      try {
        const workRoot = YAML.parse(source)?.workItemRoot ?? 'singularity/work-items';
        for (const entry of await pathsAt(commitOid, `${workRoot}/${indexedId}/workflow.json`)) stateOids.push(entry.oid);
      } catch {
        // The Story below reports what is wrong with it.
      }
    }
    await prefetchBlobs(scratch, transport, stateOids);

    for (const { id: indexedId, branch, commitOid: commit } of proven) {
      const ref = commit;
      let definition = effectiveApprovedDefinition;
      try {
        const ownOid = definitionOids.get(commit);
        if (!ownOid) throw new Error('The state-indexed Story has no pinned workflow definition.');
        definition = YAML.parse(await readBlob(scratch, transport, ownOid));
        validateDefinition(definition);
        const workRoot = definition.workItemRoot ?? 'singularity/work-items';
        const entries = await pathsAt(ref, `${workRoot}/${indexedId}/workflow.json`);
        if (!entries.length) throw new Error('The state-indexed Story metadata is missing at its pinned path.');
        for (const entry of entries) {
          const claimedId = path.posix.basename(path.posix.dirname(entry.file));
          if (claimedId !== indexedId) continue;
          try {
            if (!/^100(?:644|755)$/u.test(entry.mode) || entry.type !== 'blob' || !OID.test(entry.oid)) {
              throw new Error('Story state is not a regular Git blob');
            }
            validateId(definition, claimedId);
            const expectedPath = posix(path.join(workRoot, claimedId, 'workflow.json'));
            if (entry.file !== expectedPath) throw new Error('Story state path does not match its pinned root');
            const rawWorkflow = JSON.parse(await readBlob(scratch, transport, entry.oid));
            const workflow = readRecord('story-workflow', rawWorkflow).record;
            if (workflow?.workItem?.id !== claimedId
                || !workflow?.phases || !Array.isArray(workflow?.phaseOrder)) {
              throw new Error('Story state identity or workflow structure is invalid');
            }
            const canonical = workflow.lineage?.canonicalBranch ?? workflow.workItem.branch ?? claimedId;
            if (canonical !== branch) throw new Error('The state-indexed Story canonical branch does not match its ledger location.');
            if (items.has(claimedId)) throw new Error('Story ID is claimed by more than one canonical branch');
            items.set(claimedId, {
              id: claimedId, branch: canonical, title: workflow.workItem.title,
              createdAt: workflow.workItem.createdAt ?? null,
              status: workflow.status, phase: workflow.currentPhase,
              commit: commit.slice(0, 8), commitOid: commit,
              progress: storyLifecycleProgress(rawWorkflow),
              aliases: [workflow.lineage?.planId, workflow.lineage?.jiraIssueId, workflow.lineage?.sourceStableId,
                workflow.workItem?.source?.stableId, workflow.lineage?.initialJiraKey, workflow.lineage?.currentJiraKey,
                ...(workflow.lineage?.aliases ?? []).map(item => typeof item === 'string' ? item : item?.value ?? item?.key)].filter(Boolean)
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
      source: 'remote-url', discovery: 'state-ledger', stateRef, repositoryPath: null, remote: 'origin', fetched: true,
      count: items.size, items: [...items.values()].sort((a, b) => a.id.localeCompare(b.id)),
      unavailableCount: diagnostics.length, unavailable: diagnostics
    };
  } finally {
    await cleanupScratch(scratch);
    await cleanupScratch(configurationScratch);
  }
}

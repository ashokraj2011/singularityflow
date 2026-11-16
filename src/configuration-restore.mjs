/**
 * Restore `sflow/config` when it is missing or does not load [SCF:REQ-002, D7, finding ER-F5].
 *
 * One route, shown in full and approved by a person:
 * - `sflow/config` does not load (an edit merged on the Git host, or pushed past SFlow): a repair proposal back to
 *   the newest commit in its own history that loads. It is an ordinary proposal; `configuration approve` lands it.
 * - `sflow/config` is missing: the newest copy available, in this order: a clone's `<remote>/sflow/config`, the
 *   newest Story pin whose commit this machine holds, then the copy an earlier build kept on the `state` branch.
 *   `configuration restore` shows its files; `configuration restore --confirm <SOURCE>` recreates `sflow/config` from
 *   it, where it is still absent, recording who approved it.
 * The copies are evidence, never authority: nothing is restored until a person confirms what was shown.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import YAML from 'yaml';
import { CONFIGURATION_BRANCH, STATE_CONFIGURATION_MANIFEST, resolveConfigurationRemote, configurationAuthorityCandidate,
  readConfigurationSourceRecord } from './configuration-branch.mjs';
import { CONFIGURATION_STATE_PATH } from './configuration-state-contract.mjs';
import { isConfigurationAssetPath, DEFAULT_CONFIGURATION_ASSET_POLICY } from './configuration-assets.mjs';
import { validateDefinition } from './config.mjs';
import { executeGitQuery } from './git-query.mjs';
import { sourceFileAt, sourceRevision } from './source-inspection.mjs';
import { GitRemoteSession, requireRemoteObservation, runRemoteGitAsync } from './git-execution.mjs';
import { frozenRemoteTransport, sanitizeRemote, gitFailureDiagnostic } from './git-remote-diagnostics.mjs';
import { enterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import { sameGitRepository } from './git-repository-identity.mjs';
import { run, SingularityFlowError } from './util.mjs';

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const RESTORE_REF = 'refs/sflow/configuration-restore/source';
const HISTORY_LIMIT = 200;
const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

/** Why `text` (a workflow.yml) does not load, or null when it does. */
function definitionProblem(text) {
  if (text == null) return `${CONFIGURATION_BRANCH} has no singularity/workflow.yml`;
  try { validateDefinition(YAML.parse(text, { maxAliasCount: 100 })); return null; }
  catch (error) { return error?.message ?? String(error); }
}

/** The configuration paths of `commit`, read in `root`, without the transaction receipt. */
function configurationPaths(root, commit, env) {
  return executeGitQuery(root, 'configuration.tree-paths', { commit }, { env })
    .filter((relative) => isConfigurationAssetPath(relative, DEFAULT_CONFIGURATION_ASSET_POLICY) && relative !== CONFIGURATION_STATE_PATH);
}

/** Fetch `ref` of `remote` into this repository under the restore ref; its commit, or null when absent. */
async function fetchInto(root, remote, ref, env, { depth = null } = {}) {
  const transport = frozenRemoteTransport(remote, { env });
  const fetched = await runRemoteGitAsync(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', ...(depth ? [`--depth=${depth}`] : []),
    '--', transport.remote, `+${ref}:${RESTORE_REF}`], { cwd: root, env: transport.env, operation: 'remote-configuration' });
  if (fetched.status !== 0) fail(`Cannot read ${ref.replace('refs/heads/', '')} from '${sanitizeRemote(remote)}'. ${fetched.failure?.advice ?? gitFailureDiagnostic(fetched)}`,
    fetched.failure?.code ?? 'CONFIGURATION_RESTORE_UNAVAILABLE');
  const tip = sourceRevision(root, RESTORE_REF, { env, offline: true });
  return tip.status === 'present' ? tip.value : null;
}

/** The remote that holds, or should hold, this checkout's `sflow/config`. */
async function restoreTarget(root, session) {
  const holding = await resolveConfigurationRemote(root, 'origin', { session });
  if (holding) return holding;
  const candidate = await configurationAuthorityCandidate(root, 'origin');
  if (!candidate) fail(`No remote is known to hold ${CONFIGURATION_BRANCH} for this checkout. Run this in a clone of the repository whose configuration it is.`,
    'CONFIGURATION_RESTORE_TARGET_UNKNOWN');
  return candidate;
}

/** The newest copy of a missing `sflow/config` this machine holds, in D7's order, or null. */
async function newestLocalCopy(root, remote, env) {
  const copies = executeGitQuery(root, 'configuration.restore-copies', {}, { env });
  const tracking = copies.filter((entry) => entry.ref.startsWith('refs/remotes/') && entry.ref.endsWith(`/${CONFIGURATION_BRANCH}`))
    .filter((entry) => {
      const name = entry.ref.slice('refs/remotes/'.length, -(`/${CONFIGURATION_BRANCH}`.length));
      let url = null;
      try { url = executeGitQuery(root, 'repository.remote-url', { remote: name }, { env }); } catch { url = null; }
      return url && sameGitRepository(url, remote);
    });
  if (tracking.length) return { kind: 'clone', label: `this clone's ${tracking[0].ref.replace('refs/remotes/', '')}`, commit: tracking[0].commit, date: tracking[0].date };
  // The newest Story pin whose sflow/config commit this machine still holds.
  for (const branch of executeGitQuery(root, 'configuration.recent-branches', {}, { env })) {
    const pin = sourceFileAt(root, branch.commit, 'singularity/configuration-source.json', { env, offline: true, maxBytes: 1024 * 1024 });
    if (pin.status !== 'present') continue;
    const record = readConfigurationSourceRecord(pin.value);
    if (!record || record.branch !== CONFIGURATION_BRANCH || !OID.test(record.commit ?? '') || !sameGitRepository(record.repository ?? '', remote)) continue;
    if (sourceRevision(root, record.commit, { env, offline: true }).status !== 'present') continue;
    return { kind: 'story-pin', label: `the configuration Story ${branch.ref.replace('refs/heads/', '')} pinned`, commit: record.commit, date: branch.date };
  }
  return null;
}

/**
 * The copy an earlier build kept on `state`, checked against its own manifest: `{ files, commit, source }` or null.
 * Read from its newest commit alone, in a private repository, so a long ledger history is never fetched and this
 * checkout is never made shallow.
 */
async function stateCopy(remote, env) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-configuration-restore-state-'));
  try {
    run('git', ['init', '--quiet', '--bare', scratch], { env });
    let commit;
    try { commit = await fetchInto(scratch, remote, 'refs/heads/state', env, { depth: 1 }); } catch { return null; }
    if (!commit) return null;
    const manifestText = sourceFileAt(scratch, commit, STATE_CONFIGURATION_MANIFEST, { env, offline: true, maxBytes: 4 * 1024 * 1024 });
    if (manifestText.status !== 'present') return null;
    let manifest;
    try { manifest = JSON.parse(manifestText.value); } catch { return null; }
    if (manifest?.layout !== 'canonical-paths' || !manifest.files || typeof manifest.files !== 'object') return null;
    const files = new Map();
    for (const [relative, sha256] of Object.entries(manifest.files)) {
      if (!isConfigurationAssetPath(relative) || relative === CONFIGURATION_STATE_PATH) return null;
      const shown = sourceFileAt(scratch, commit, relative, { env, offline: true, encoding: 'buffer', maxBytes: 16 * 1024 * 1024 });
      if (shown.status !== 'present') return null;
      if (createHash('sha256').update(shown.value).digest('hex') !== String(sha256).replace(/^sha256:/u, '')) return null;
      files.set(relative, shown.value);
    }
    return files.has('singularity/workflow.yml') ? { files, commit, source: manifest.source ?? null } : null;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/**
 * What restoring `sflow/config` would do, writing nothing on the remote. `status`: `current` (it loads),
 * `unloadable` (a repair proposal back to `source`), `missing` (recreate it from `source`), or `no-copy`.
 */
export async function previewConfigurationRestore(root, { env = process.env } = {}) {
  const gitEnv = enterpriseGitEnvironment(env);
  const session = new GitRemoteSession({ cwd: root, env: gitEnv });
  const remote = await restoreTarget(root, session);
  const observed = await session.observeAsync(remote, { refs: [`refs/heads/${CONFIGURATION_BRANCH}`], includeHead: false, refresh: true });
  requireRemoteObservation(observed, `${CONFIGURATION_BRANCH} authority`);
  const tip = observed.refs.get(`refs/heads/${CONFIGURATION_BRANCH}`) ?? null;
  const base = { schemaVersion: 1, resultType: 'configuration-restore', remote: sanitizeRemote(remote), branch: CONFIGURATION_BRANCH };
  if (tip) {
    await fetchInto(root, remote, `refs/heads/${CONFIGURATION_BRANCH}`, gitEnv);
    const workflow = sourceFileAt(root, tip, 'singularity/workflow.yml', { env: gitEnv, offline: true, maxBytes: 8 * 1024 * 1024 });
    const problem = definitionProblem(workflow.status === 'present' ? workflow.value : null);
    if (!problem) return { ...base, status: 'current', commit: tip, words: `${CONFIGURATION_BRANCH} (${tip.slice(0, 12)}) loads; there is nothing to restore.` };
    // The newest earlier commit in its own history that loads.
    const history = executeGitQuery(root, 'configuration.first-parent-history', { commit: tip, limit: HISTORY_LIMIT }, { env: gitEnv }).slice(1);
    for (const commit of history) {
      const text = sourceFileAt(root, commit, 'singularity/workflow.yml', { env: gitEnv, offline: true, maxBytes: 8 * 1024 * 1024 });
      if (definitionProblem(text.status === 'present' ? text.value : null)) continue;
      const current = new Set(configurationPaths(root, tip, gitEnv));
      const source = configurationPaths(root, commit, gitEnv);
      const files = changedFiles(root, tip, commit, gitEnv).filter((relative) => relative !== CONFIGURATION_STATE_PATH);
      return { ...base, status: 'unloadable', commit: tip, problem,
        source: { kind: 'history', id: commit, commit, label: `${CONFIGURATION_BRANCH}'s own history (${commit.slice(0, 12)}), the newest commit that loads` },
        files, removed: [...current].filter((relative) => !source.includes(relative)),
        nextAction: { label: 'Propose going back to it, then approve that proposal', command: `singularity-flow configuration restore --confirm ${commit}` } };
    }
    return { ...base, status: 'no-copy', commit: tip, problem,
      words: `${CONFIGURATION_BRANCH} does not load, and none of its last ${HISTORY_LIMIT} commits does either. Repair it with a proposal: singularity-flow workflow fix.`,
      nextAction: { label: 'Draft the repair', command: 'singularity-flow workflow fix', skill: '/sf-fix-workflow' } };
  }
  const local = await newestLocalCopy(root, remote, gitEnv);
  if (local) {
    return { ...base, status: 'missing', commit: null,
      source: { kind: local.kind, id: local.commit, commit: local.commit, label: local.label, date: local.date ?? null },
      files: configurationPaths(root, local.commit, gitEnv),
      nextAction: { label: `Recreate ${CONFIGURATION_BRANCH} from it`, command: `singularity-flow configuration restore --confirm ${local.commit}` } };
  }
  const copy = await stateCopy(remote, gitEnv);
  if (copy) {
    return { ...base, status: 'missing', commit: null,
      source: { kind: 'state-copy', id: copy.commit, commit: copy.source?.commit ?? null, label: `the copy an earlier build kept on the state branch (${copy.commit.slice(0, 12)})` },
      files: [...copy.files.keys()].sort(),
      nextAction: { label: `Recreate ${CONFIGURATION_BRANCH} from it`, command: `singularity-flow configuration restore --confirm ${copy.commit}` } };
  }
  return { ...base, status: 'no-copy', commit: null,
    words: `${CONFIGURATION_BRANCH} is missing on '${sanitizeRemote(remote)}', and this machine holds no copy of it. Run this in a clone that still has it, or set the repository up again: singularity-flow capability onboard.`,
    nextAction: { label: 'Set the repository up again', command: 'singularity-flow capability onboard' } };
}

function changedFiles(root, from, to, env) {
  return executeGitQuery(root, 'configuration.changed-paths', { from, to }, { env });
}

/**
 * Do what the preview showed, for the source the person named (`confirm`). A repair is a proposal that
 * `configuration approve` lands; recreating a missing `sflow/config` pushes one commit, only while it is absent.
 */
export async function applyConfigurationRestore(root, { confirm, identity, agent = () => false, env = process.env } = {}) {
  const preview = await previewConfigurationRestore(root, { env });
  if (preview.status === 'current' || preview.status === 'no-copy') return { ...preview, restored: false };
  if (String(confirm ?? '').trim() !== preview.source.id) {
    fail(`The copy to restore from is ${preview.source.id}, not ${confirm}. Nothing was changed. Read it again: singularity-flow configuration restore`,
      'CONFIGURATION_RESTORE_CONFIRMATION_MISMATCH', { nextAction: { command: 'singularity-flow configuration restore', label: 'Read what restoring does again' }, shown: preview.source.id });
  }
  if (agent()) {
    const command = `singularity-flow configuration restore --confirm ${preview.source.id}`;
    fail(`Restoring ${CONFIGURATION_BRANCH} is a person's step, and an agent started this command. Nothing was changed. Run it in your own terminal: ${command}`,
      'PSS_CARD_NOT_SHOWN', { nextAction: { command, label: `Run in your own terminal: ${command}` } });
  }
  const gitEnv = enterpriseGitEnvironment(env);
  const approver = identity(root);
  const target = await restoreTarget(root, new GitRemoteSession({ cwd: root, env: gitEnv }));
  if (preview.status === 'unloadable') {
    const { proposeConfigurationChange } = await import('./configuration-proposal.mjs');
    const source = preview.source.commit;
    const proposal = await proposeConfigurationChange(root, {
      kind: 'workflow', operation: 'restore', subject: `sflow-config-${source.slice(0, 12)}`,
      message: `[configuration] restore ${CONFIGURATION_BRANCH} to ${source.slice(0, 12)}, the newest commit that loads`,
      expectedAuthority: { commit: preview.commit },
      intent: { kind: 'configuration-restore', operations: [{ op: 'restore', from: source, removes: preview.removed }] },
      mutate: async (scratch) => {
        for (const relative of preview.removed) await rm(path.join(scratch, relative), { force: true });
        for (const relative of configurationPaths(root, source, gitEnv)) {
          const shown = sourceFileAt(root, source, relative, { env: gitEnv, offline: true, encoding: 'buffer', maxBytes: 16 * 1024 * 1024 });
          if (shown.status !== 'present') fail(`${relative} at ${source.slice(0, 12)} could not be read. Nothing was proposed.`, 'CONFIGURATION_RESTORE_UNAVAILABLE');
          await mkdir(path.dirname(path.join(scratch, relative)), { recursive: true });
          await writeFile(path.join(scratch, relative), shown.value);
        }
        return { restoredFrom: source };
      }
    }, { env });
    return { ...preview, restored: false, proposed: true, proposal: { branch: proposal.branch, commit: proposal.commit },
      nextAction: { label: 'Approve the repair proposal', command: `singularity-flow configuration approve ${proposal.branch}` } };
  }
  // Missing: one commit holding the copy's files, made by the person, pushed only while sflow/config is absent.
  const person = `${approver.name} <${approver.email}>`;
  const message = `[configuration] restore ${CONFIGURATION_BRANCH} from ${preview.source.label}\n\n`
    + `Sflow-Restored-From: ${preview.source.kind} ${preview.source.id}\nApproved-by: ${person}\n`;
  const commitEnv = { ...gitEnv, GIT_AUTHOR_NAME: approver.name, GIT_AUTHOR_EMAIL: approver.email,
    GIT_COMMITTER_NAME: approver.name, GIT_COMMITTER_EMAIL: approver.email };
  let tree, parents = [];
  if (preview.source.kind === 'state-copy') {
    const copy = await stateCopy(target, gitEnv);
    if (copy?.commit !== preview.source.id) fail('The state copy changed after it was shown. Nothing was changed; read it again: singularity-flow configuration restore',
      'CONFIGURATION_RESTORE_CONFIRMATION_MISMATCH');
    tree = await treeFromFiles(root, copy.files, gitEnv);
  } else {
    tree = `${preview.source.id}^{tree}`;
    parents = ['-p', preview.source.id];
  }
  const commit = run('git', ['commit-tree', tree, ...parents, '-F', '-'], { cwd: root, env: commitEnv, input: message }).stdout.trim();
  const transport = frozenRemoteTransport(target, { push: true, env: gitEnv });
  const pushed = await runRemoteGitAsync(['push', '--porcelain', `--force-with-lease=refs/heads/${CONFIGURATION_BRANCH}:`, '--', transport.remote,
    `${commit}:refs/heads/${CONFIGURATION_BRANCH}`], { cwd: root, env: transport.env, operation: 'remote-push' });
  if (pushed.status !== 0) {
    fail(`${CONFIGURATION_BRANCH} could not be recreated on '${preview.remote}': ${pushed.failure?.advice ?? gitFailureDiagnostic(pushed)}. Nothing else changed; if it exists again now, there is nothing to restore.`,
      pushed.failure?.code ?? 'CONFIGURATION_RESTORE_PUSH_FAILED', { nextAction: { command: 'singularity-flow configuration restore', label: 'Look again' } });
  }
  return { ...preview, restored: true, commit, approvedBy: { name: approver.name, email: approver.email },
    nextAction: { label: 'Refresh workspace configuration', command: 'singularity-flow workspace refresh-configuration' } };
}

/** A tree of exactly `files` (path → bytes), written to this repository's objects through a private index. */
async function treeFromFiles(root, files, env) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-configuration-restore-'));
  try {
    const indexEnv = { ...env, GIT_INDEX_FILE: path.join(scratch, 'index') };
    for (const [relative, bytes] of files) {
      const blobFile = path.join(scratch, 'blob');
      await writeFile(blobFile, bytes);
      const oid = run('git', ['hash-object', '-w', '--no-filters', blobFile], { cwd: root, env }).stdout.trim();
      run('git', ['update-index', '--add', '--cacheinfo', `100644,${oid},${relative}`], { cwd: root, env: indexEnv });
    }
    return run('git', ['write-tree'], { cwd: root, env: indexEnv }).stdout.trim();
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** The preview and its outcome as a person reads them. */
export function restoreLines(result) {
  if (result.words) return [result.words];
  const lines = [];
  if (result.status === 'unloadable') {
    lines.push(`${result.branch} (${result.commit.slice(0, 12)}) on '${result.remote}' does not load: ${result.problem}`);
  } else if (result.status === 'missing') {
    lines.push(`${result.branch} is missing on '${result.remote}'.`);
  }
  if (result.source) lines.push(`The newest copy that loads: ${result.source.label}.`);
  if (result.files?.length) lines.push(`${result.status === 'missing' ? 'Recreating it from that copy holds' : 'Going back to it changes'} these ${result.files.length} file(s):`,
    ...result.files.map((file) => `  ${file}`));
  if (result.removed?.length) lines.push('And removes:', ...result.removed.map((file) => `  ${file}`));
  if (result.restored) lines.push(`Recreated ${result.branch} at ${result.commit.slice(0, 12)}, approved by ${result.approvedBy.name}.`);
  if (result.proposed) lines.push(`Proposed going back as ${result.proposal.branch}. Nothing changes until it is approved.`);
  if (result.nextAction?.command) lines.push(`${result.restored || result.proposed ? 'Next' : 'To do it'}: ${result.nextAction.command}`);
  return lines;
}

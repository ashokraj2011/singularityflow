/** One explicit human operation: reconstruct pending intent, archive, fast-forward, and retire. */
import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { CONFIGURATION_BRANCH, resolveConfigurationRemote } from './configuration-branch.mjs';
import { configurationAssetPolicy, mergeConfigurationAssetPolicies, isConfigurationAssetPath,
  portableConfigurationPath, configurationAssetSearchRoots } from './configuration-assets.mjs';
import { enterpriseGitEnvironment, withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { frozenRemoteTransport, sanitizeRemote } from './git-remote-diagnostics.mjs';
import { GitRemoteSession, requireRemoteObservation, runRemoteGitAsync } from './git-execution.mjs';
import { readGitNameStatusDiff } from './git-diff-name-status.mjs';
import { gitCommitIdentity } from './git.mjs';
import { gitIsAncestor } from './git-ancestry.mjs';
import { validateEditorConfiguration } from './editor.mjs';
import { validateDefinition } from './config.mjs';
import { replayConfigurationJson, replayConfigurationYaml } from './configuration-intent-replay.mjs';
import { loadSkillLibrary } from './skill-library.mjs';
import { readInstruction } from './instruction-library.mjs';
import { syncConfigurationReferences } from './configuration-reference-sync.mjs';
import { removeTemporaryTree, run, SingularityFlowError } from './util.mjs';

const PREFIX = 'refs/heads/sflow/config-change/';
const BRANCH = /^sflow\/config-change\/(?:workflow|capability|onboarding)\/[a-z0-9._/-]+$/u;
const MAX_FILES = 2_000;
const MAX_BYTES = 32 * 1024 * 1024;
const LOG = 'singularity/configuration-recreate-log.md';
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const backupRef = (kind, commit) => `refs/tags/sflow-config-recreate/${kind}-${commit}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const fail = (message, code = 'CONFIGURATION_RECREATE_UNSAFE', details = {}) => {
  throw new SingularityFlowError(message, { code, details });
};

function git(root, args, env, extra = {}) {
  return run('git', args, { cwd: root, env, maxBuffer: MAX_BYTES, timeoutMs: 15_000, ...extra });
}

function blob(root, commit, relative, env) {
  const listing = git(root, ['ls-tree', '-z', commit, '--', relative], env).stdout;
  if (!listing) return null;
  const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/u.exec(listing);
  if (!match || match[3] !== relative) fail(`Configuration asset '${relative}' is not a regular file.`);
  const bytes = git(root, ['cat-file', 'blob', match[2]], env, { encoding: 'buffer' }).stdout;
  if (!Buffer.isBuffer(bytes)) fail(`Cannot read exact configuration bytes for '${relative}'.`);
  return { bytes, mode: match[1], sha256: hash(bytes) };
}

function definition(root, ref, env) {
  const file = blob(root, ref, 'singularity/workflow.yml', env);
  if (!file) fail('Approved workflow configuration is missing.');
  return YAML.parse(utf8(file.bytes), { maxAliasCount: 100 });
}

function policyAt(root, ref, env) {
  const portfolio = blob(root, ref, 'singularity/portfolio.yml', env);
  return configurationAssetPolicy(definition(root, ref, env),
    portfolio ? YAML.parse(utf8(portfolio.bytes), { maxAliasCount: 100 }) : {});
}

async function writeAsset(root, relative, file) {
  const target = path.join(root, relative);
  // Never follow a repository-owned symlink, including an ancestor directory.
  let cursor = root;
  for (const component of relative.split('/')) {
    cursor = path.join(cursor, component);
    try { if ((await lstat(cursor)).isSymbolicLink()) fail(`Unsafe configuration link: ${relative}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!file) { await rm(target, { force: true }); return; }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.bytes);
  await chmod(target, file.mode === '100755' ? 0o755 : 0o644);
}

async function checkoutConfigurationOnly(root, commit, env) {
  const policy = policyAt(root, commit, env);
  const rows = git(root, ['ls-tree', '-r', '-z', commit, '--', ...configurationAssetSearchRoots(policy)], env).stdout.split('\0').filter(Boolean);
  if (rows.length > 10_000) fail('The configuration tree exceeds the bounded recreation inventory.');
  let bytes = 0;
  // Populate the index with the exact base tree, but never materialize application source.
  git(root, ['read-tree', commit], env);
  for (const row of rows) {
    const relative = row.slice(row.indexOf('\t') + 1);
    if (!isConfigurationAssetPath(relative, policy)) continue;
    const file = blob(root, commit, relative, env);
    bytes += file?.bytes.length ?? 0;
    if (bytes > MAX_BYTES) fail('The configuration tree exceeds the bounded recreation byte budget.');
    await writeAsset(root, relative, file);
  }
}

function stageAsset(root, relative, file, env) {
  if (!file) { git(root, ['update-index', '--force-remove', '--', relative], env); return; }
  const oid = git(root, ['hash-object', '-w', '--stdin'], env, { input: file.bytes }).stdout.trim();
  if (!HASH.test(oid)) fail('Cannot retain exact recreated configuration bytes.');
  // No clean filters, hooks or whole-worktree add; only these admitted exact bytes enter the index.
  git(root, ['update-index', '--add', '--cacheinfo', file.mode, oid, relative], env);
}

function captureCandidate(root, baseCommit, allowedPaths, env) {
  // Application blobs need not be downloaded. Their original object identities remain in the
  // index; only configuration objects are read/changed. The tree diff proves that boundary.
  const candidateTree = git(root, ['write-tree', '--missing-ok'], env).stdout.trim();
  if (!HASH.test(candidateTree)) fail('Cannot capture the recreated configuration tree.');
  const changedPaths = git(root, ['diff-tree', '-r', '--no-ext-diff', '--name-only', '-z',
    `${baseCommit}^{tree}`, candidateTree, '--'], env).stdout.split('\0').filter(Boolean);
  if (changedPaths.some(relative => !allowedPaths.has(relative))) fail('The recreated tree changes an unapproved path.');
  return { candidateTree, changedPaths };
}

/** The menu click / --apply is the authorization. No implicit approval or Story mutation. */
export async function recreateAndSyncConfiguration(root, {
  apply = false, env = process.env, runRemoteCommand = runRemoteGitAsync,
  syncReferences = syncConfigurationReferences
} = {}) {
  const gitEnv = enterpriseGitEnvironment(env);
  const session = new GitRemoteSession({ env: gitEnv, runAsyncCommand: runRemoteCommand });
  const remote = await resolveConfigurationRemote(root, 'origin', { session });
  if (!remote) fail('No configuration authority is registered for this repository.', 'CONFIGURATION_RECREATE_AUTHORITY_MISSING');
  const transport = frozenRemoteTransport(remote, { push: true, env: gitEnv });
  const targetRef = `refs/heads/${CONFIGURATION_BRANCH}`;
  const before = await session.observeAsync(remote, { refs: [targetRef, `${PREFIX}*`], includeHead: false, refresh: true });
  requireRemoteObservation(before, 'configuration recreation');
  const baseCommit = before.refs.get(targetRef);
  if (!HASH.test(baseCommit ?? '')) fail('The approved configuration branch is missing.', 'CONFIGURATION_RECREATE_AUTHORITY_MISSING');
  const proposals = [...before.refs].filter(([ref]) => ref.startsWith(PREFIX)).map(([ref, commit]) => {
    const branch = ref.slice('refs/heads/'.length);
    if (!BRANCH.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) {
      fail('An advertised configuration proposal has an unsafe identity.');
    }
    return { ref, branch, commit };
  });
  if (proposals.length > 100) fail('Configuration recreation is limited to 100 proposals per operation.');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-recreate-'));
  try {
    const cloned = await runRemoteCommand(['clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--no-checkout', '--filter=blob:none',
      '--branch', CONFIGURATION_BRANCH, transport.remote, scratch], { operation: 'remote-configuration', env: transport.env });
    if (cloned.status !== 0) fail(cloned.failure?.advice ?? 'Configuration authority could not be read.', 'CONFIGURATION_RECREATE_TRANSPORT_FAILED');
    if (git(scratch, ['rev-parse', 'HEAD'], transport.env).stdout.trim() !== baseCommit) {
      fail('Approved configuration moved during recreation. Click Recreate & sync again; nothing changed.', 'CONFIGURATION_RECREATE_AUTHORITY_MOVED');
    }
    await checkoutConfigurationOnly(scratch, baseCommit, transport.env);
    const baseline = validateDefinition(definition(scratch, baseCommit, transport.env));
    for (const item of proposals) {
      const local = `refs/remotes/recreate/${item.branch}`;
      const fetched = await runRemoteCommand(['fetch', '--quiet', '--no-tags', '--', transport.remote,
        `+${item.ref}:${local}`], { cwd: scratch, operation: 'remote-configuration', env: transport.env });
      if (fetched.status !== 0) fail(fetched.failure?.advice ?? 'A configuration proposal could not be read.', 'CONFIGURATION_RECREATE_TRANSPORT_FAILED');
      if (git(scratch, ['rev-parse', local], transport.env).stdout.trim() !== item.commit) {
        fail('A proposal moved during recreation. Click Recreate & sync again; nothing changed.', 'CONFIGURATION_RECREATE_PROPOSAL_MOVED');
      }
      item.merged = gitIsAncestor(scratch, item.commit, baseCommit, { env: transport.env });
      item.time = Number(git(scratch, ['show', '-s', '--format=%ct', item.commit], transport.env).stdout.trim());
    }
    // Older pending edits first; the most recent explicit edit wins when proposals overlap.
    proposals.sort((a, b) => a.time - b.time || a.branch.localeCompare(b.branch));
    const files = new Map();
    const replacements = [];
    let bytesRead = 0;
    const currentPolicy = policyAt(scratch, baseCommit, transport.env);
    for (const item of proposals.filter(item => !item.merged)) {
      const ancestor = git(scratch, ['merge-base', baseCommit, item.commit], transport.env, { allowFailure: true });
      if (ancestor.status !== 0) fail(`Proposal '${item.branch}' has no configuration history. Original branches remain preserved.`);
      const sourceBase = ancestor.stdout.trim();
      const policy = mergeConfigurationAssetPolicies(currentPolicy, policyAt(scratch, sourceBase, transport.env),
        policyAt(scratch, item.commit, transport.env));
      const changed = readGitNameStatusDiff(scratch, sourceBase, item.commit, { env: transport.env, maximumRecords: MAX_FILES });
      for (const relative of changed.names) {
        if (!portableConfigurationPath(relative) || !isConfigurationAssetPath(relative, policy) || relative === LOG) {
          fail(`Proposal '${item.branch}' changes non-configuration path '${relative}'. No application or Story files were changed.`);
        }
        const original = blob(scratch, sourceBase, relative, transport.env);
        const proposed = blob(scratch, item.commit, relative, transport.env);
        const current = files.has(relative) ? files.get(relative) : blob(scratch, baseCommit, relative, transport.env);
        bytesRead += (original?.bytes.length ?? 0) + (proposed?.bytes.length ?? 0) + (current?.bytes.length ?? 0);
        if (bytesRead > MAX_BYTES || files.size >= MAX_FILES) fail('Configuration recreation exceeded its bounded asset budget.');
        let result = proposed;
        if (proposed && /\.(?:ya?ml|json)$/iu.test(relative)) {
          const replay = (/\.json$/iu.test(relative) ? replayConfigurationJson : replayConfigurationYaml)(
            original ? utf8(original.bytes) : null, utf8(proposed.bytes), current ? utf8(current.bytes) : null);
          const bytes = Buffer.from(replay.text);
          result = { bytes, sha256: hash(bytes), mode: original?.mode === proposed.mode
            ? current?.mode ?? proposed.mode : proposed.mode };
          replacements.push(...replay.replacements.map(pointer => ({ branch: item.branch, path: relative, pointer })));
        } else if ((original?.sha256 ?? null) !== (current?.sha256 ?? null)
            && (proposed?.sha256 ?? null) !== (current?.sha256 ?? null)) {
          replacements.push({ branch: item.branch, path: relative, pointer: '/' });
        }
        files.set(relative, result);
      }
    }
    for (const [relative, file] of files) await writeAsset(scratch, relative, file);
    // Full validation checks agents, skills, instruction references, templates, and workflow routes.
    const validation = await validateEditorConfiguration(scratch, { baselineDefinition: baseline });
    if (!validation.valid) fail('Recreated configuration did not validate. Original configuration and proposals remain intact.',
      'CONFIGURATION_RECREATE_VALIDATION_FAILED', { findings: validation.errors ?? validation });
    const library = await loadSkillLibrary(scratch);
    if (library.problems.length) fail('The recreated skill library is invalid.',
      'CONFIGURATION_RECREATE_VALIDATION_FAILED', { problems: library.problems });
    for (const skill of library.skills.values()) {
      for (const id of skill.instructionRefs ?? []) await readInstruction(scratch, id);
    }
    for (const [relative, file] of files) stageAsset(scratch, relative, file, transport.env);
    const allowedPaths = new Set(files.keys());
    const staged = captureCandidate(scratch, baseCommit, allowedPaths, transport.env);
    const backupRefs = [...new Map([
      [backupRef('approved', baseCommit), baseCommit],
      ...proposals.map(item => [backupRef('proposal', item.commit), item.commit])
    ])].map(([ref, commit]) => ({ ref, commit }));
    const result = {
      schemaVersion: 1, // schema-transient: configuration recreation operation result, no lifecycle authority
      resultType: 'sflow-configuration-recreate-sync', status: apply ? 'current' : 'preview',
      remote: sanitizeRemote(remote), targetBranch: CONFIGURATION_BRANCH, baseCommit, targetCommit: baseCommit,
      proposals: proposals.map(({ branch, commit, merged }) => ({ branch, commit, merged })),
      files: staged.changedPaths, replacements, backupRefs,
      effects: { applicationCode: 'unchanged', worktree: 'unchanged', index: 'unchanged', stories: 'unchanged', approvals: 'unchanged' }
    };
    if (!apply) return result;
    if (!proposals.length) {
      result.referenceSync = await syncReferences(root, remote, baseCommit, { env });
      return result;
    }
    const actor = gitCommitIdentity(root, { env: withoutGitProcessOverrides(env) });
    if (!actor.name || !actor.email) fail('Set the repository Git name and email before recreating configuration.', 'CONFIGURATION_RECREATE_IDENTITY_REQUIRED');
    const oldLog = await readFile(path.join(scratch, LOG), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '# Configuration recreation history\n'; throw error;
    });
    const receipt = `\n## ${new Date().toISOString()} — recreate and sync\n\n`
      + `Approved base: ${baseCommit}\n\nPolicy: explicit pending edits win; unrelated approved settings are retained.\n\n`
      + proposals.map(item => `- ${item.branch}@${item.commit} → ${backupRef('proposal', item.commit)}`).join('\n')
      + `\n\nReplaced current values: ${JSON.stringify(replacements)}\n`;
    if (Buffer.byteLength(oldLog + receipt) > 1024 * 1024) fail('Configuration recreation history needs archival before another update.');
    const log = { bytes: Buffer.from(oldLog + receipt), mode: '100644' };
    await writeAsset(scratch, LOG, log);
    stageAsset(scratch, LOG, log, transport.env);
    allowedPaths.add(LOG);
    const candidate = captureCandidate(scratch, baseCommit, allowedPaths, transport.env);
    const committed = git(scratch, ['-c', `user.name=${actor.name}`, '-c', `user.email=${actor.email}`,
      'commit-tree', candidate.candidateTree, '-p', baseCommit,
      '-m', '[configuration] recreate pending intent and sync'], transport.env);
    if (committed.status !== 0) fail('Recreated configuration could not be committed.');
    result.targetCommit = committed.stdout.trim();
    if (!HASH.test(result.targetCommit)) fail('Recreated configuration commit is not an exact identity.');
    git(scratch, ['update-ref', 'HEAD', result.targetCommit, baseCommit], transport.env);
    if (git(scratch, ['rev-parse', `${result.targetCommit}^{tree}`], transport.env).stdout.trim() !== candidate.candidateTree
        || !gitIsAncestor(scratch, baseCommit, result.targetCommit, { env: transport.env })) fail('Recreated candidate changed after validation.');
    const backups = await session.observeAsync(remote, { refs: backupRefs.map(item => item.ref), includeHead: false, refresh: true });
    requireRemoteObservation(backups, 'configuration backup tags');
    for (const item of backupRefs) {
      if (backups.refs.has(item.ref) && backups.refs.get(item.ref) !== item.commit) fail('A configuration backup tag is occupied by different history.');
    }
    // Atomic server transaction: backups + descendant config commit + exact proposal retirement.
    // No Git merge, rebase, reset, or rewrite. Server protection and hooks remain authoritative.
    const pushed = await runRemoteCommand(['push', '--porcelain', '--atomic',
      `--force-with-lease=${targetRef}:${baseCommit}`,
      ...proposals.map(item => `--force-with-lease=${item.ref}:${item.commit}`),
      ...backupRefs.map(item => `--force-with-lease=${item.ref}:${backups.refs.get(item.ref) ?? ''}`),
      '--', transport.remote, `HEAD:${targetRef}`,
      ...backupRefs.map(item => `${item.commit}:${item.ref}`), ...proposals.map(item => `:${item.ref}`)],
    { cwd: scratch, operation: 'remote-push', env: transport.env });
    session.invalidate(remote);
    const after = await session.observeAsync(remote, {
      refs: [targetRef, ...proposals.map(item => item.ref), ...backupRefs.map(item => item.ref)], includeHead: false, refresh: true
    });
    const complete = after.ok && after.refs.get(targetRef) === result.targetCommit
      && proposals.every(item => !after.refs.has(item.ref))
      && backupRefs.every(item => after.refs.get(item.ref) === item.commit);
    if (!complete) {
      result.status = after.ok ? 'not-synced' : 'outcome-unknown';
      result.failure = { code: 'CONFIGURATION_RECREATE_PUSH_REFUSED',
        message: pushed.failure?.advice ?? 'The server did not confirm the atomic configuration update. Original refs were not deliberately overwritten.' };
      result.retryCommand = 'singularity-flow configuration recreate-sync --apply --json';
      return result;
    }
    result.status = 'synced';
    result.reconciled = pushed.status !== 0;
    result.referenceSync = await syncReferences(root, remote, result.targetCommit, { env });
    return result;
  } finally { await removeTemporaryTree(scratch); }
}

/** Git adapter for one semantic configuration transaction, independent of the app worktree. */
import path from 'node:path';
import { lstat, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { ConfigurationObjectReader } from './configuration-object-reader.mjs';
import { configurationAssetPolicy, mergeConfigurationAssetPolicies, isConfigurationAssetPath, configurationAssetSearchRoots,
  portableConfigurationPath, portableFilesystemPathIdentity } from './configuration-assets.mjs';
import { readGitNameStatusDiff } from './git-diff-name-status.mjs';
import { validateDefinition } from './config.mjs';
import { validateEditorConfiguration } from './editor.mjs';
import { loadSkillLibrary } from './skill-library.mjs';
import { readInstruction } from './instruction-library.mjs';
import { replayConfigurationYaml, replayConfigurationJson } from './configuration-intent-replay.mjs';
import { CONFIGURATION_STATE_PATH, CONFIGURATION_OID, readConfigurationState,
  createConfigurationTransaction, appendConfigurationTransaction, isConfigurationStatePath } from './configuration-state-contract.mjs';
import { run, SingularityFlowError } from './util.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const text = file => file ? new TextDecoder('utf-8', { fatal: true }).decode(file.bytes) : null;
const same = (a, b) => a?.sha256 === b?.sha256 && a?.mode === b?.mode;
const fail = (message, code = 'CONFIGURATION_TRANSACTION_UNSAFE', details = {}) => {
  throw new SingularityFlowError(message, { code, details });
};
function git(root, args, env, extra = {}) {
  return run('git', args, { cwd: root, env, timeoutMs: 15_000, maxBuffer: 32 * 1024 * 1024, ...extra });
}
/** Raw Git trees can contain two names that collapse to one file on an installed host. */
export function assertConfigurationAssetPathIdentities(paths) {
  const identities = new Set();
  for (const relative of paths) {
    const identity = portableFilesystemPathIdentity(relative);
    if (!portableConfigurationPath(relative) || identities.has(identity)) fail('Configuration assets contain unsafe or colliding portable paths.');
    identities.add(identity);
  }
}
function policy(reader, commit) {
  return configurationAssetPolicy(YAML.parse(text(reader.file(commit, 'singularity/workflow.yml')) ?? '{}'),
    YAML.parse(text(reader.file(commit, 'singularity/portfolio.yml')) ?? '{}'));
}
async function install(root, relative, file, env, { stage = true } = {}) {
  let cursor = root;
  for (const component of relative.split('/')) {
    cursor = path.join(cursor, component);
    try { if ((await lstat(cursor)).isSymbolicLink()) fail(`Unsafe configuration link: ${relative}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!file) {
    await rm(cursor, { force: true });
    git(root, ['update-index', '--force-remove', '--', relative], env);
    return;
  }
  await mkdir(path.dirname(cursor), { recursive: true });
  await writeFile(cursor, file.bytes);
  await chmod(cursor, file.mode === '100755' ? 0o755 : 0o644);
  if (!stage) return;
  const oid = git(root, ['hash-object', '-w', '--stdin'], env, { input: file.bytes }).stdout.trim();
  if (!CONFIGURATION_OID.test(oid)) fail('Configuration asset could not be retained.');
  git(root, ['update-index', '--add', '--cacheinfo', file.mode, oid, relative], env);
}

/** A configuration transaction never needs an application checkout or its blob population. */
export async function materializeConfigurationSnapshot(root, remote, commit, env, runRemoteCommand) {
  const reader = new ConfigurationObjectReader(root, remote, env, runRemoteCommand);
  await reader.hydrate(reader.inventory(commit, ['singularity/workflow.yml', 'singularity/portfolio.yml']));
  const assetPolicy = policy(reader, commit);
  const entries = reader.inventory(commit, configurationAssetSearchRoots(assetPolicy), relative => isConfigurationAssetPath(relative, assetPolicy));
  assertConfigurationAssetPathIdentities(entries.map(entry => entry.path));
  await reader.hydrate(entries);
  git(root, ['read-tree', commit], env);
  for (const entry of entries) {
    if (isConfigurationStatePath(entry.path) && entry.path !== CONFIGURATION_STATE_PATH) fail('Ambiguous kernel receipt path.');
    await install(root, entry.path, reader.file(commit, entry.path), env, { stage: false });
  }
  return reader;
}

export async function hydrateConfigurationProposal(reader, proposalRef, env) {
  const proposal = git(reader.root, ['rev-parse', '--verify', `${proposalRef}^{commit}`], env).stdout.trim();
  const base = git(reader.root, ['rev-parse', '--verify', `${proposalRef}^`], env).stdout.trim();
  const current = git(reader.root, ['rev-parse', 'HEAD'], env).stdout.trim();
  await reader.hydrate([proposal, base].flatMap(commit => reader.inventory(commit, ['singularity/workflow.yml', 'singularity/portfolio.yml', CONFIGURATION_STATE_PATH])));
  const assetPolicy = mergeConfigurationAssetPolicies(...[base, proposal, current].map(commit => policy(reader, commit)));
  const paths = readGitNameStatusDiff(reader.root, base, proposal, { env, maximumRecords: 2_000 }).names.filter(relative => isConfigurationAssetPath(relative, assetPolicy));
  await reader.hydrate(paths.flatMap(relative => [proposal, base, current].map(commit => reader.lookup(commit, relative))));
}

export async function configurationStateAtRef(root, remote, commit, env, runRemoteCommand) {
  const reader = new ConfigurationObjectReader(root, remote, env, runRemoteCommand);
  const entry = reader.lookup(commit, CONFIGURATION_STATE_PATH);
  await reader.hydrate([entry]);
  return readConfigurationState(text(reader.file(commit, CONFIGURATION_STATE_PATH)));
}

/** Changed values are applied to the current snapshot; competing values are explicit conflicts. */
export async function prepareConfigurationStateTransaction(root, remote, reviewed, {
  env, runRemoteCommand, actor, proposalId
}) {
  const reader = new ConfigurationObjectReader(root, remote, env, runRemoteCommand);
  const commits = [reviewed.proposalBase, reviewed.proposalCommit, reviewed.targetCommit];
  await reader.hydrate(commits.flatMap(commit => reader.inventory(commit, [
    'singularity/workflow.yml', 'singularity/portfolio.yml', CONFIGURATION_STATE_PATH
  ])));
  const approvedPolicy = policy(reader, reviewed.targetCommit);
  const assetPolicy = mergeConfigurationAssetPolicies(...commits.map(commit => policy(reader, commit)));
  const paths = readGitNameStatusDiff(root, reviewed.proposalBase, reviewed.proposalCommit,
    { env, maximumRecords: 2_000 }).names;
  if (paths.some(relative => isConfigurationStatePath(relative) || !isConfigurationAssetPath(relative, assetPolicy))) {
    fail('A proposal cannot change application/runtime paths or author kernel transaction receipts.', 'WORKFLOW_PROPOSAL_INVALID');
  }
  await reader.hydrate(paths.flatMap(relative => commits.map(commit => reader.lookup(commit, relative))));
  const files = new Map();
  const changes = [];
  for (const relative of paths) {
    const original = reader.file(reviewed.proposalBase, relative);
    const proposed = reader.file(reviewed.proposalCommit, relative);
    const current = reader.file(reviewed.targetCommit, relative);
    let result;
    if (same(proposed, current)) continue;
    if (same(original, current)) result = proposed;
    else if (original && proposed && current && /\.(?:json|ya?ml)$/iu.test(relative)) {
      if (original.mode !== current.mode && current.mode !== proposed.mode) {
        fail(`Configuration file mode changed concurrently: ${relative}`, 'CONFIGURATION_ENTITY_CONFLICT', { path: relative, pointers: ['/mode'] });
      }
      try {
        const replay = (/\.json$/iu.test(relative) ? replayConfigurationJson : replayConfigurationYaml)(
          text(original), text(proposed), text(current), { conflictPolicy: 'reject' });
        result = { bytes: Buffer.from(replay.text), mode: original.mode === proposed.mode ? current.mode : proposed.mode };
      } catch (error) {
        if (error.code === 'CONFIGURATION_ENTITY_CONFLICT') error.details = { ...error.details, path: relative,
          proposalId, proposalRevision: reviewed.proposalCommit, currentRevision: reviewed.targetCommit,
          nextAction: { label: 'Review current configuration and this preserved revision. To explicitly replace competing pending intent, preview Recreate & sync; do not retry activation unchanged.',
            command: 'singularity-flow configuration recreate-sync --json' } };
        throw error;
      }
    } else fail(`Configuration asset '${relative}' changed concurrently. Review this asset, not a Git merge.`,
      'CONFIGURATION_ENTITY_CONFLICT', { path: relative, pointers: ['/'] });
    if (result) result = { ...result, sha256: hash(result.bytes) };
    if (same(current, result)) continue;
    files.set(relative, result);
    changes.push({ path: relative, beforeSha256: current?.sha256 ?? null, afterSha256: result?.sha256 ?? null,
      beforeMode: current?.mode ?? null, afterMode: result?.mode ?? null });
  }
  // Compute every conflict before materializing any candidate change.
  const state = readConfigurationState(text(reader.file(reviewed.targetCommit, CONFIGURATION_STATE_PATH)));
  const transaction = createConfigurationTransaction({ proposalId, proposalRevision: reviewed.proposalCommit,
    branch: reviewed.branch, baseCommit: reviewed.proposalBase, expectedAuthorityCommit: reviewed.targetCommit, actor, changes });
  const currentPaths = reader.inventory(reviewed.targetCommit, configurationAssetSearchRoots(assetPolicy),
    relative => isConfigurationAssetPath(relative, assetPolicy)).map(entry => entry.path);
  assertConfigurationAssetPathIdentities([...currentPaths.filter(relative => !files.has(relative)),
    ...[...files].filter(([, file]) => file).map(([relative]) => relative)]);
  for (const [relative, file] of files) await install(root, relative, file, env);
  const baselineDefinition = validateDefinition(YAML.parse(text(reader.file(reviewed.targetCommit, 'singularity/workflow.yml'))));
  await validateEditorConfiguration(root, { baselineDefinition });
  const library = await loadSkillLibrary(root);
  if (library.problems.length) fail('The configuration skill library is invalid.', 'CONFIGURATION_TRANSACTION_VALIDATION_FAILED', { problems: library.problems });
  for (const skill of library.skills.values()) for (const id of skill.instructionRefs ?? []) await readInstruction(root, id);
  const next = appendConfigurationTransaction(state, transaction);
  await install(root, CONFIGURATION_STATE_PATH, { bytes: Buffer.from(JSON.stringify(next, null, 2) + '\n'), mode: '100644' }, env);
  const candidateTree = git(root, ['write-tree', '--missing-ok'], env).stdout.trim();
  const changed = readGitNameStatusDiff(root, reviewed.targetCommit, candidateTree, { env, maximumRecords: 2_001 }).names;
  if (changed.some(relative => !files.has(relative) && relative !== CONFIGURATION_STATE_PATH)
      || changes.some(change => !isConfigurationAssetPath(change.path, approvedPolicy) && !isConfigurationAssetPath(change.path, assetPolicy))) {
    fail('The validated configuration transaction changed an unapproved path.');
  }
  // A second parent retains reviewed history, but no textual Git merge is performed. Stable
  // timestamps make an interrupted prepared operation reconstruct the same exact candidate.
  const date = reviewed.proposalCreatedAt;
  if (!date) fail('The reviewed proposal has no valid creation time.');
  const commitEnv = { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const targetCommit = git(root, ['-c', `user.name=${actor.name}`, '-c', `user.email=${actor.email}`,
    'commit-tree', candidateTree, '-p', reviewed.targetCommit, '-p', reviewed.proposalCommit,
    '-m', `[configuration] activate ${transaction.id}`], commitEnv).stdout.trim();
  if (!CONFIGURATION_OID.test(targetCommit)) fail('The configuration transaction commit is invalid.');
  git(root, ['update-ref', 'HEAD', targetCommit, reviewed.targetCommit], env);
  return { targetCommit, transaction };
}

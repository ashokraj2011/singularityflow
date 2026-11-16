/** Git adapter for one semantic configuration transaction, independent of the app worktree. */
import path from 'node:path';
import { lstat, mkdir, writeFile, rm, rmdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { ConfigurationObjectReader } from './configuration-object-reader.mjs';
import { configurationAssetPolicy, mergeConfigurationAssetPolicies, isConfigurationAssetPath, configurationAssetSearchRoots,
  portableConfigurationPath, portableFilesystemPathIdentity } from './configuration-assets.mjs';
import { readGitNameStatusDiff } from './git-diff-name-status.mjs';
import { validateDefinition } from './config.mjs';
import { loadSkillLibrary } from './skill-library.mjs';
import { readInstruction } from './instruction-library.mjs';
import { replayConfigurationYaml, replayConfigurationJson, replayFileMode, configurationFieldChanges } from './configuration-intent-replay.mjs';
import { readProposalHistory } from './git-proposal-history.mjs';
import { CONFIGURATION_STATE_PATH, CONFIGURATION_OID, readConfigurationState, configurationDigest, configurationProposalKind,
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
    // Git keeps no empty folders. A removed skill or instruction must not leave one behind, or the
    // library read below refuses a folder without its SKILL.md (docs/SPEC-WORKFLOW-RETIREMENT-v1.md).
    const top = path.resolve(root);
    for (let parent = path.dirname(path.resolve(cursor)); parent.startsWith(top + path.sep); parent = path.dirname(parent)) {
      try { await rmdir(parent); } catch { break; }
    }
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

/** `commit`'s admitted configuration assets, hydrated through `reader`; nothing is written. */
async function admittedConfigurationSnapshot(reader, commit) {
  await reader.hydrate(reader.inventory(commit, ['singularity/workflow.yml', 'singularity/portfolio.yml']));
  const assetPolicy = policy(reader, commit);
  const entries = reader.inventory(commit, configurationAssetSearchRoots(assetPolicy), relative => isConfigurationAssetPath(relative, assetPolicy));
  assertConfigurationAssetPathIdentities(entries.map(entry => entry.path));
  await reader.hydrate(entries);
  for (const entry of entries) {
    if (isConfigurationStatePath(entry.path) && entry.path !== CONFIGURATION_STATE_PATH) fail('Ambiguous kernel receipt path.');
  }
  return entries;
}

/** A configuration transaction never needs an application checkout or its blob population. */
export async function materializeConfigurationSnapshot(root, remote, commit, env, runRemoteCommand) {
  const reader = new ConfigurationObjectReader(root, remote, env, runRemoteCommand);
  const entries = await admittedConfigurationSnapshot(reader, commit);
  git(root, ['read-tree', commit], env);
  for (const entry of entries) await install(root, entry.path, reader.file(commit, entry.path), env, { stage: false });
  return reader;
}

/**
 * The same admitted snapshot as `materializeConfigurationSnapshot`, with the same refusals, read in
 * place from an object store (a configuration object pool): no index, file or checkout is written,
 * so listing and inspecting proposals create none (SDA-AC-013).
 */
export async function readConfigurationSnapshot(root, remote, commit, env, runRemoteCommand) {
  const reader = new ConfigurationObjectReader(root, remote, env, runRemoteCommand);
  await admittedConfigurationSnapshot(reader, commit);
  return reader;
}

/**
 * The exact commits one approval binds [SCF:REQ-005]: the proposal's tip, its merge base with the
 * current `sflow/config` (its change is everything from there to the tip, however many commits it has
 * and whether or not the Git host merged `sflow/config` into it), and that `sflow/config` commit.
 * A proposal already in `sflow/config`'s history keeps its tip's first parent, only to show what it
 * changed. `proposer` is the author of the proposal's first own commit.
 */
export async function hydrateConfigurationProposal(reader, proposalRef, env) {
  const proposal = git(reader.root, ['rev-parse', '--verify', `${proposalRef}^{commit}`], env).stdout.trim();
  const current = git(reader.root, ['rev-parse', 'HEAD'], env).stdout.trim();
  const history = readProposalHistory(reader.root, current, proposal, { env, branch: proposalRef.replace(/^refs\/(?:heads|remotes\/origin)\//u, '') });
  const base = history.merged ? history.firstParent ?? history.mergeBase : history.mergeBase;
  await reader.hydrate([proposal, base].flatMap(commit => reader.inventory(commit, ['singularity/workflow.yml', 'singularity/portfolio.yml', CONFIGURATION_STATE_PATH])));
  const assetPolicy = mergeConfigurationAssetPolicies(...[base, proposal, current].map(commit => policy(reader, commit)));
  const paths = readGitNameStatusDiff(reader.root, base, proposal, { env, maximumRecords: 2_000 }).names.filter(relative => isConfigurationAssetPath(relative, assetPolicy));
  await reader.hydrate(paths.flatMap(relative => [proposal, base, current].map(commit => reader.lookup(commit, relative))));
  return { proposalCommit: proposal, proposalBase: base, mergeBase: history.mergeBase, merged: history.merged,
    targetCommit: current, proposer: history.proposer };
}

const STRUCTURED = /\.(?:json|ya?ml)$/iu;
const CLASH_TEXT_LIMIT = 4_000;
const clashText = file => {
  if (!file) return null;
  let value;
  try { value = text(file); } catch { return { value: `(${file.bytes.length} bytes that are not text)`, sha256: file.sha256 }; }
  return { value: value.length > CLASH_TEXT_LIMIT ? `${value.slice(0, CLASH_TEXT_LIMIT)}\n…` : value, sha256: file.sha256 };
};
/**
 * The key a person's pick names: the file and, inside it, the field (a JSON pointer), `/` (the whole
 * file, for one that is not YAML or JSON), or `@mode` (its file mode, which no field can be named).
 */
export const configurationClashKey = (relative, pointer) => `${relative}#${pointer}`;

/** `choices` as given (a Map or a plain object of clash key → 'proposal' | 'current'), checked. */
export function configurationChoices(choices) {
  const entries = choices instanceof Map ? [...choices] : Object.entries(choices ?? {});
  const result = new Map();
  for (const [key, pick] of entries) {
    if (typeof key !== 'string' || !/^[^#\0]+#(?:\/.*|@mode)$/su.test(key) || !['proposal', 'current'].includes(pick)) {
      fail(`A pick must name a field as <file>#<pointer> and keep 'proposal' or 'current': ${String(key)}=${String(pick)}.`, 'CONFIGURATION_CHOICE_INVALID');
    }
    result.set(key, pick);
  }
  return result;
}

/** Picks as typed: `--pick '<file>#<field>=proposal|current'`, repeated or comma-separated. */
export function configurationPicks(values = []) {
  return configurationChoices(new Map(values.flatMap(value => String(value).split(',')).map(value => value.trim()).filter(Boolean).map(value => {
    const at = value.lastIndexOf('=');
    return at > 0 ? [value.slice(0, at), value.slice(at + 1)] : [value, null];
  })));
}

/**
 * What approving `reviewed` lands on `reviewed.targetCommit`, written nowhere [SCF:REQ-005, REQ-007,
 * REQ-008]: the proposal's change, from its merge base to its tip, re-applied field by field onto the
 * current `sflow/config` by the same engine activation uses. A field both sides changed differently is
 * a clash, with both values, decided only by the approver's pick in `choices`; a clash with no pick
 * keeps the current value here and is listed. `files` maps each path to its landed file (null:
 * removed); `changes` are the transaction's file records; `fields` say, per landed file, each value
 * before and after; `invalid` lists paths a proposal may not change.
 */
export async function planConfigurationLanding(reader, reviewed, { env, choices = null } = {}) {
  const picks = configurationChoices(choices);
  const commits = [reviewed.proposalBase, reviewed.proposalCommit, reviewed.targetCommit];
  await reader.hydrate(commits.flatMap(commit => reader.inventory(commit, [
    'singularity/workflow.yml', 'singularity/portfolio.yml', CONFIGURATION_STATE_PATH
  ])));
  const assetPolicy = mergeConfigurationAssetPolicies(...commits.map(commit => policy(reader, commit)));
  const paths = readGitNameStatusDiff(reader.root, reviewed.proposalBase, reviewed.proposalCommit,
    { env, maximumRecords: 2_000 }).names;
  const invalid = paths.filter(relative => isConfigurationStatePath(relative) || !isConfigurationAssetPath(relative, assetPolicy));
  if (invalid.length) return { files: new Map(), changes: [], fields: [], clashes: [], decided: [], unused: [], invalid, assetPolicy };
  await reader.hydrate(paths.flatMap(relative => commits.map(commit => reader.lookup(commit, relative))));
  const files = new Map();
  const changes = [];
  const fields = [];
  const clashes = [];
  const decided = [];
  for (const relative of paths) {
    const original = reader.file(reviewed.proposalBase, relative);
    const proposed = reader.file(reviewed.proposalCommit, relative);
    const current = reader.file(reviewed.targetCommit, relative);
    const pick = pointer => {
      const key = configurationClashKey(relative, pointer);
      const chosen = picks.get(key) ?? null;
      if (chosen) decided.push({ key, pick: chosen });
      return chosen;
    };
    let result;
    if (same(proposed, current)) continue;
    if (same(original, current)) result = proposed;
    else if (proposed && current && STRUCTURED.test(relative)) {
      let mode = replayFileMode(original?.mode ?? proposed.mode, proposed.mode, current.mode);
      if (mode == null) {
        const chosen = pick('@mode');
        if (chosen) mode = chosen === 'proposal' ? proposed.mode : current.mode;
        else {
          clashes.push({ key: configurationClashKey(relative, '@mode'), path: relative, pointer: '@mode', kind: 'mode',
            base: original ? { value: original.mode } : null, proposal: { value: proposed.mode }, current: { value: current.mode } });
          mode = current.mode;
        }
      }
      let replay;
      try {
        replay = (/\.json$/iu.test(relative) ? replayConfigurationJson : replayConfigurationYaml)(
          original ? text(original) : null, text(proposed), text(current), {
            conflictPolicy: 'collect',
            choices: new Map([...picks].filter(([key]) => key.startsWith(`${relative}#`)).map(([key, value]) => [key.slice(relative.length + 1), value]))
          });
      } catch (error) {
        if (error instanceof SingularityFlowError) throw error;
        fail(`Configuration file '${relative}' could not be read to apply this proposal: ${error.message}`, 'WORKFLOW_PROPOSAL_INVALID', { path: relative });
      }
      for (const clash of replay.clashes) clashes.push({ key: configurationClashKey(relative, clash.pointer), path: relative, kind: 'value', ...clash });
      for (const entry of replay.decided) decided.push({ key: configurationClashKey(relative, entry.pointer), pick: entry.pick });
      result = { bytes: Buffer.from(replay.text), mode };
    } else {
      // Two versions of a file that is not YAML or JSON, or one side removed it: the approver keeps one.
      const chosen = pick('/');
      if (chosen === 'proposal') result = proposed;
      else if (chosen === 'current') result = current;
      else {
        clashes.push({ key: configurationClashKey(relative, '/'), path: relative, pointer: '/', kind: 'file',
          base: clashText(original), proposal: clashText(proposed), current: clashText(current) });
        result = current;
      }
    }
    if (result) result = { ...result, sha256: result.sha256 ?? hash(result.bytes) };
    if (same(current, result)) continue;
    files.set(relative, result);
    changes.push({ path: relative, beforeSha256: current?.sha256 ?? null, afterSha256: result?.sha256 ?? null,
      beforeMode: current?.mode ?? null, afterMode: result?.mode ?? null });
    fields.push(landedFile(relative, current, result));
  }
  // A pick that decides nothing was made against another state of either side: what lands is not what was shown.
  const used = new Set(decided.map(entry => entry.key));
  return { files, changes, fields, clashes, decided: decided.sort((a, b) => a.key.localeCompare(b.key)),
    unused: [...picks.keys()].filter(key => !used.has(key)), invalid, assetPolicy };
}

/** One landed file as a person reads it: its values before and after, or its text before and after. */
function landedFile(relative, before, after) {
  const status = !before ? 'added' : !after ? 'removed' : 'changed';
  if (STRUCTURED.test(relative)) {
    try {
      const parse = file => file ? (/\.json$/iu.test(relative) ? JSON.parse(text(file)) : YAML.parse(text(file), { maxAliasCount: 100 })) : undefined;
      const values = configurationFieldChanges(parse(before), parse(after));
      if (values.length || before?.mode === after?.mode) return { path: relative, status, values };
    } catch { /* shown as text below */ }
  }
  let beforeText = null, afterText = null;
  try { beforeText = before ? text(before) : null; afterText = after ? text(after) : null; }
  catch { return { path: relative, status, binary: true }; }
  return { path: relative, status, ...(before && after && before.mode !== after.mode ? { mode: { before: before.mode, after: after.mode } } : {}),
    text: { before: beforeText, after: afterText } };
}

export async function configurationStateAtRef(root, remote, commit, env, runRemoteCommand) {
  const reader = new ConfigurationObjectReader(root, remote, env, runRemoteCommand);
  const entry = reader.lookup(commit, CONFIGURATION_STATE_PATH);
  await reader.hydrate([entry]);
  return readConfigurationState(text(reader.file(commit, CONFIGURATION_STATE_PATH)));
}

/**
 * Changed values are applied to the current snapshot; a value both sides changed is the approver's
 * pick, and without one nothing is written [SCF:REQ-007]. The approval commit says who proposed and who
 * approved [SCF:REQ-018]: its author is the proposer, its committer the approver.
 */
export async function prepareConfigurationStateTransaction(root, remote, reviewed, {
  env, runRemoteCommand, actor, proposalId, objectReader = null, choices = null
}) {
  const reader = objectReader ?? new ConfigurationObjectReader(root, remote, env, runRemoteCommand);
  if (reader.root !== root || reader.remote !== remote) fail('Configuration object reader belongs to another checkout or authority.');
  const approvedPolicy = policy(reader, reviewed.targetCommit);
  const landing = await planConfigurationLanding(reader, reviewed, { env, choices });
  const { files, changes, assetPolicy } = landing;
  if (landing.invalid.length) {
    fail('A proposal cannot change application/runtime paths or author kernel transaction receipts.', 'WORKFLOW_PROPOSAL_INVALID', { paths: landing.invalid });
  }
  if (landing.unused.length) {
    fail(`${landing.unused.length === 1 ? 'A pick names a field' : `${landing.unused.length} picks name fields`} that this proposal and ${reviewed.targetBranch ?? 'sflow/config'} no longer both changed: ${landing.unused.join(', ')}. `
      + 'Look at the proposal again and approve what it shows now; nothing was changed.', 'CONFIGURATION_CHOICE_STALE', {
      unused: landing.unused, nextAction: { label: 'Look at the proposal again', command: `singularity-flow configuration approve ${reviewed.branch ?? '<PROPOSAL>'}` }
    });
  }
  if (landing.clashes.length) {
    const command = configurationApproveCommand(reviewed.branch, reviewed.proposalCommit, landing.clashes);
    fail(`Both this proposal and ${reviewed.targetBranch ?? 'sflow/config'} changed ${landing.clashes.length === 1 ? 'one field' : `${landing.clashes.length} fields`} differently since the proposal was made. `
      + 'Pick one of the two values for each; nothing was changed.', 'CONFIGURATION_ENTITY_CONFLICT', {
      path: landing.clashes[0].path, pointers: landing.clashes.map(clash => clash.pointer), clashes: landing.clashes,
      proposalId, proposalRevision: reviewed.proposalCommit, currentRevision: reviewed.targetCommit,
      nextAction: { label: 'Approve with your pick for each field (proposal or current)', command }
    });
  }
  // Compute every conflict before materializing any candidate change.
  // Only a workflow proposal's approval is appended to the shared receipt, which every build checks field by
  // field; a people or package approval is recorded by its approval commit alone (SCF:REQ-018), so the receipt
  // file older builds read never holds a kind they refuse.
  const receipt = configurationProposalKind(reviewed.branch) === 'workflow';
  const state = receipt ? readConfigurationState(text(reader.file(reviewed.targetCommit, CONFIGURATION_STATE_PATH))) : null;
  const transaction = receipt ? createConfigurationTransaction({ proposalId, proposalRevision: reviewed.proposalCommit,
    branch: reviewed.branch, baseCommit: reviewed.proposalBase, expectedAuthorityCommit: reviewed.targetCommit, actor, changes })
    : approvalRecord({ proposalId, proposalRevision: reviewed.proposalCommit, branch: reviewed.branch,
      baseCommit: reviewed.proposalBase, expectedAuthorityCommit: reviewed.targetCommit, actor, changes });
  const currentPaths = reader.inventory(reviewed.targetCommit, configurationAssetSearchRoots(assetPolicy),
    relative => isConfigurationAssetPath(relative, assetPolicy)).map(entry => entry.path);
  assertConfigurationAssetPathIdentities([...currentPaths.filter(relative => !files.has(relative)),
    ...[...files].filter(([, file]) => file).map(([relative]) => relative)]);
  for (const [relative, file] of files) await install(root, relative, file, env);
  // A sflow/config that does not load (an outside edit) is repaired by a proposal like any other [SCF:REQ-002]:
  // the candidate must load, the broken baseline only grants nothing.
  const baselineDefinition = loadableDefinition(text(reader.file(reviewed.targetCommit, 'singularity/workflow.yml')));
  // Validation is a mutation/candidate concern. Read-only catalog/proposal callers must not
  // import the editor's doctor/model graph just to inspect committed configuration objects.
  const { validateEditorConfiguration } = await import('./editor.mjs');
  await validateEditorConfiguration(root, { baselineDefinition });
  const library = await loadSkillLibrary(root);
  if (library.problems.length) fail('The configuration skill library is invalid.', 'CONFIGURATION_TRANSACTION_VALIDATION_FAILED', { problems: library.problems });
  for (const skill of library.skills.values()) for (const id of skill.instructionRefs ?? []) await readInstruction(root, id);
  if (receipt) {
    const next = appendConfigurationTransaction(state, transaction);
    await install(root, CONFIGURATION_STATE_PATH, { bytes: Buffer.from(JSON.stringify(next, null, 2) + '\n'), mode: '100644' }, env);
  }
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
  const proposer = reviewed.proposer?.name && reviewed.proposer?.email ? reviewed.proposer : actor;
  const commitEnv = { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
    GIT_AUTHOR_NAME: proposer.name, GIT_AUTHOR_EMAIL: proposer.email, GIT_COMMITTER_NAME: actor.name, GIT_COMMITTER_EMAIL: actor.email };
  const message = approvalCommitMessage(transaction.id, { proposer: reviewed.proposer ?? null, approver: actor, decided: landing.decided,
    branch: receipt ? null : reviewed.branch });
  const targetCommit = git(root, ['commit-tree', candidateTree, '-p', reviewed.targetCommit, '-p', reviewed.proposalCommit,
    '-F', '-'], commitEnv, { input: message }).stdout.trim();
  if (!CONFIGURATION_OID.test(targetCommit)) fail('The configuration transaction commit is invalid.');
  git(root, ['update-ref', 'HEAD', targetCommit, reviewed.targetCommit], env);
  return { targetCommit, transaction, receipt, files, selfApproved: selfApproval(reviewed.proposer, actor), decided: landing.decided };
}

const sameIdentity = (left, right) => Boolean(left?.email && right?.email) && left.email.trim().toLowerCase() === right.email.trim().toLowerCase();
/** Whether the approver also proposed: shown and recorded as a self-approval [SCF:REQ-011, REQ-018]. */
export function selfApproval(proposer, approver) { return sameIdentity(proposer, approver); }

/**
 * The record a people or package approval keeps instead of a receipt entry: the same bindings and digest, written
 * only into its approval commit's message [SCF:REQ-018].
 */
function approvalRecord({ proposalId, proposalRevision, branch, baseCommit, expectedAuthorityCommit, actor, changes }) {
  const orderedChanges = [...changes].sort((a, b) => a.path.localeCompare(b.path));
  return { id: `cft-${configurationDigest({ proposalId, proposalRevision, expectedAuthorityCommit, actor, changes: orderedChanges })}`,
    proposalId, proposalRevision, branch, baseCommit, expectedAuthorityCommit, actor, changes: orderedChanges };
}

/** The approved definition, or null when it does not load: a broken baseline relaxes no check on the candidate. */
function loadableDefinition(source) {
  try { return validateDefinition(YAML.parse(source ?? '')); } catch { return null; }
}

/** The approval commit's message: who proposed, who approved, and each pick the approver made [SCF:REQ-018, REQ-007]. */
export function approvalCommitMessage(transactionId, { proposer = null, approver, decided = [], branch = null }) {
  const person = identity => `${identity.name} <${identity.email}>`;
  const trailers = [...(branch ? [`Sflow-Proposal: ${branch}`] : []), ...(proposer ? [`Proposed-by: ${person(proposer)}`] : []), `Approved-by: ${person(approver)}`,
    ...(selfApproval(proposer, approver) ? ['Self-approved: yes'] : []),
    ...decided.map(entry => `Sflow-Picked: ${entry.pick} ${entry.key}`)];
  return `[configuration] activate ${transactionId}\n\n${trailers.join('\n')}\n`;
}

/** The approve command for one proposal revision, with a pick for each clash still to make. */
export function configurationApproveCommand(branch, commit, clashes = []) {
  const picks = clashes.map(clash => ` --pick '${String(clash.key).replace(/'/gu, "'\\''")}=<proposal|current>'`).join('');
  return `singularity-flow configuration approve ${branch ?? '<PROPOSAL>'} --confirm ${commit ?? '<COMMIT>'}${picks}`;
}

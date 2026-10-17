/** Automatic, machine-local new-Story execution locations. Never fetch in the old objects. */
import { lstat, readFile, realpath } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { repositoryGitDirectory } from './git-directory.mjs';
import { activeWorkspaceFile, readActiveWorkspaceContext, workspaceRegistryFile } from './workspace-context.mjs';
import { readWorkspace, workspaceRepositoryPath } from './workspace-manifest.mjs';
import { capabilityRepositories, parseBaseSelection, assertStoryBaseSelection } from './capability-branches.mjs';
import { prepareWorkspaceBranch } from './workspace-branch-checkout.mjs';
import { workspaceBranchFolder, workspaceBranchMember } from './workspace-branch-locations.mjs';
import { optionBoolean, optionString, optionStrings, SingularityFlowError } from './util.mjs';
import { validatePortableWorkId } from './work-id.mjs';
import { measureCommandSpan } from './dx-timing-context.mjs';

const preparations = new WeakMap();
const preparationScope = new AsyncLocalStorage();
export function withAutomaticStoryCheckout(preparation, action) { return preparationScope.run(preparation, action); }
const canonical = async (file) => realpath(file).catch(error => {
  if (error.code === 'ENOENT') return path.resolve(file);
  throw error;
});
const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

export function automaticStoryCheckoutRequest(command, positionals, options) {
  if (options.help === true || options.h === true || optionBoolean(options, 'dry-run')
      || optionBoolean(options, 'offline') || optionString(options, 'managed-story-worktree')) return null;
  const start = command === 'start' || command === 'story' && positionals[1] === 'start';
  const preflight = command === 'workspace' && positionals[1] === 'branches' && optionString(options, 'preflight-story');
  const prepare = command === 'story' && positionals[1] === 'prepare-worktree';
  if (!start && !preflight && !prepare) return null;
  const id = start ? positionals[command === 'start' ? 1 : 2]
    : preflight ? optionString(options, 'preflight-story') : optionString(options, 'work-id');
  validatePortableWorkId(id);
  const values = optionStrings(options, 'from-branch');
  const base = optionString(options, 'base');
  if (base && values.length) throw new SingularityFlowError('Choose either --from-branch or --base, not both.', { code: 'STORY_BASE_INVALID' });
  if (!values.length && base) values.push(base);
  if (!values.length && !(start && optionString(options, 'selection-receipt'))) return null;
  const selection = parseBaseSelection(values);
  assertStoryBaseSelection(selection, { stateBranch: 'state' });
  for (const value of [selection.all, ...Object.values(selection.overrides)].filter(Boolean)) workspaceBranchFolder(value);
  const ref = optionString(options, 'ref', id);
  workspaceBranchFolder(ref);
  return { id, start, values, selection, ref };
}

async function checkoutDirectory(cwd) {
  let current = cwd;
  while (true) {
    if (await lstat(path.join(current, '.git')).catch(() => null)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function localStoryPresent(root, id, ref) {
  if (await lstat(path.join(root, 'singularity/work-items', id, 'workflow.json')).catch(() => null)) return true;
  const common = repositoryGitDirectory(root);
  if (!common) return false;
  if (await lstat(path.join(common, 'singularity-flow/story-start', `${encodeURIComponent(id).replace(/%/gu, '_')}.json`)).catch(() => null)) return true;
  if (await lstat(path.join(common, 'refs/heads', ref)).catch(() => null)) return true;
  const packed = path.join(common, 'packed-refs');
  const info = await lstat(packed).catch(() => null);
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new SingularityFlowError(
    'Local Story references require inspection before a new checkout can be selected. Existing work was preserved.',
    { code: 'WORKSPACE_LOCAL_STORY_REVIEW_REQUIRED' });
  return (`${await readFile(packed, 'utf8')}\n`).includes(` refs/heads/${ref}\n`);
}

/** A signed receipt stays checked/consumed at its original root; it is never copied or rebound. */
export function automaticStorySelection(options, workId) {
  const handoff = (preparations.get(options) ?? preparationScope.getStore())?.selectionHandoff;
  return handoff?.receipt.workId === workId && handoff.token === optionString(options, 'selection-receipt') ? handoff : null;
}

export async function automaticWorkspaceStoryCheckout(command, positionals, options, {
  cwd = process.cwd(), env = process.env, prepareBranch = prepareWorkspaceBranch
} = {}) {
  const request = automaticStoryCheckoutRequest(command, positionals, options);
  if (!request) return null;
  const fingerprint = JSON.stringify([request.id, request.values, request.ref, optionString(options, 'capability')]);
  const launchDirectory = await canonical(cwd);
  const prior = preparations.get(options) ?? preparationScope.getStore();
  if (prior?.fingerprint === fingerprint && [prior.launchDirectory, prior.repositoryPath].some(file => same(file, launchDirectory))) return prior;
  const selected = await readActiveWorkspaceContext(activeWorkspaceFile(env), workspaceRegistryFile(env), { refresh: false }).catch(() => null);
  if (!selected?.workspacePath) return null;
  const root = await checkoutDirectory(launchDirectory);
  let workspace;
  try {
    workspace = await readWorkspace(selected.workspacePath);
    if (workspace.id !== selected.workspaceId) throw new SingularityFlowError('The selected workspace identity changed. Select the workspace again.');
  } catch (error) {
    const selectedRoot = selected.repositoryPath ? await canonical(selected.repositoryPath) : null;
    const relative = path.relative(path.resolve(selected.workspacePath), launchDirectory);
    const insideWorkspace = !path.isAbsolute(relative) && !relative.startsWith('..');
    if (!root || insideWorkspace || selectedRoot && same(root, selectedRoot)) throw error;
    return null; // A stale machine-wide selection cannot block an unrelated opened repository.
  }
  const common = root ? repositoryGitDirectory(root) : null;
  const recovered = common ? await workspaceBranchMember(common, workspace) : null;
  let repositoryId = recovered?.repositoryId ?? null;
  if (!repositoryId && !root) repositoryId = selected.repositoryId;
  if (!repositoryId && root && Object.hasOwn(workspace.repositories, selected.repositoryId)) {
    const paths = [selected.repositoryPath, selected.checkoutPath,
      workspaceRepositoryPath(workspace, workspace.repositories[selected.repositoryId])].filter(Boolean);
    if ((await Promise.all(paths.map(canonical))).some(file => same(file, root))) repositoryId = selected.repositoryId;
  }
  // The selected member and receipt-owned branch checkout above are the hot paths. Only an
  // unselected sibling needs filesystem membership discovery; never open every old Git directory.
  if (!repositoryId && root) for (const repository of Object.values(workspace.repositories)) {
    const original = await canonical(workspaceRepositoryPath(workspace, repository));
    const originalCommon = repositoryGitDirectory(original);
    if (same(root, original) || common && originalCommon && same(await canonical(common), await canonical(originalCommon))) {
      repositoryId = repository.id; break;
    }
  }
  if (!repositoryId || !Object.hasOwn(workspace.repositories, repositoryId)) return null;
  const repository = workspace.repositories[repositoryId];
  const original = await canonical(workspaceRepositoryPath(workspace, repository));
  // An unpublished local Story or an interrupted start must keep its own journal, branch and pin.
  // Inspect only exact local metadata; never traverse Git history or open the old object store.
  if (await localStoryPresent(original, request.id, request.ref)
      || root && !same(root, original) && await localStoryPresent(root, request.id, request.ref)) return null;
  let selectionHandoff = null;
  if (request.start && optionString(options, 'selection-receipt')) {
    selectionHandoff = await (await import('./choices.mjs')).readStartSelectionReceipt(root ?? original,
      optionString(options, 'selection-receipt'), request.id);
    const value = selectionHandoff.receipt.answers?.['base-branch']?.id;
    if (!value) throw new SingularityFlowError('The start selection receipt has no selected base branch.');
    if (!request.values.length) request.selection = parseBaseSelection([value]);
  }
  assertStoryBaseSelection(request.selection, { stateBranch: 'state' });
  const capability = optionString(options, 'capability') ?? repository.capabilities?.[0] ?? null;
  if (!optionString(options, 'capability') && (repository.capabilities?.length ?? 0) > 1) throw new SingularityFlowError(
    'Choose --capability before preparing this Story so only its repositories are downloaded.', { code: 'CAPABILITY_SELECTION_REQUIRED' });
  if (capability && !repository.capabilities.includes(capability)) throw new SingularityFlowError('The selected repository does not belong to this capability.', { code: 'CAPABILITY_BRANCH_INVALID' });
  const required = capability ? capabilityRepositories(workspace, capability) : [repository];
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  try {
    const repositories = await measureCommandSpan('start.branch-checkout', async () => {
      const locations = [];
      for (const member of required) {
        const branch = request.selection.overrides[member.id] ?? request.selection.all ?? member.defaultBranch;
        workspaceBranchFolder(branch);
        if (recovered?.repositoryId === member.id && recovered.record.branch === branch) {
          locations.push({ repositoryId: member.id, repositoryPath: recovered.repositoryPath, branch, reused: true });
        } else locations.push(await prepareBranch(workspace, member.id, branch, { reuse: true, env, signal: controller.signal }));
      }
      return locations;
    });
    const primary = repositories.find(member => member.repositoryId === repositoryId);
    const result = { ...primary, fingerprint, launchDirectory, originalRepositoryPath: original,
      workspacePath: workspace.path, repositories, originalPreserved: true, selectionHandoff };
    preparations.set(options, result);
    return result;
  } finally { process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); }
}

/** Only the two existing file-valued Story inputs change interpretation after a cwd handoff. */
export function rebaseAutomaticStoryFiles(options, launchDirectory) {
  if (optionString(options, 'story-file')) options['story-file'] = path.resolve(launchDirectory, optionString(options, 'story-file'));
  if (optionStrings(options, 'document').length) options.document = optionStrings(options, 'document').map(file => path.resolve(launchDirectory, file));
}

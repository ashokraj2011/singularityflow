import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { commandDefinition, operationById, resolveOperation } from './command-registry.mjs';
import {
  commandTimer, recordCommandTiming, withCommandTiming, writeCommandTimings
} from './dx-command-timing.mjs';
import { installGitFactStore } from './git-fact-store.mjs';
import { repoRoot } from './git-execution.mjs';
import {
  gitReadOutput, isTransportIntentId, optionBoolean, optionString, optionStrings, parseArgs, refuseUnreadableRepository, requirePositional, run,
  SingularityFlowError
} from './util.mjs';
import { validatePortableWorkId } from './work-id.mjs';
import { VERSION } from './version.mjs';
import { versionLine } from './build-info.mjs';
import { resolveModelMode, stripGlobalModelOptions } from './model-mode.mjs';
import { modelOffCause, withOperationContext } from './operation-context.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';
import { FROZEN_REMOTE_ALIAS } from './git-remote-diagnostics.mjs';
import { abandonRemoteBranchObservations } from './remote-observation-prefetch.mjs';
import { installFileLeaseSignalHandlers } from './file-lease.mjs';
import { configurationReviewRetryDue, firstRunPassDue } from './product-alignment-gate.mjs';
import { productRequirementDue } from './product-requirement-gate.mjs';
import { agentViewRequested, interpretsForAgent, withCliJsonOutput, withoutAgentFlag } from './cli-json-output.mjs';
import { scopedUtilityRead, validateUtilityEntry, withoutUtilityEntry } from './utility-entry.mjs';
import { withCommandReadScope } from './read-scope.mjs';
import { executionContextArguments, surfaceContext, withExecutionContextScope } from './execution-context-scope.mjs';
// copilot-mode.mjs (the pause check, with personalization and the skill catalog) and
// creation-context.mjs (Story creation only) load where they are read, not in root dispatch.
// The bundled CLI keeps both in cold-core (build-cold-cli-bundle.mjs), so no chunk is added.

// These commands promise to remove machine-local Singularity state. Recording their own duration
// after they finish would immediately recreate `.git/singularity-flow/` and make that promise false.
const LOCAL_STATE_RESET_COMMANDS = new Set(['factory-reset', 'reset-all', 'local-reset', 'reinstall']);

// These commands deliberately replace or forget SFlow state and therefore own their stronger
// reset/machine-state barriers. Wrapping them in an ordinary repository mutation lease would make
// factory reset detect itself as an in-flight command, while wrapping local reset would recreate
// the private state it has just removed.
const REPOSITORY_MUTATION_LEASE_EXCLUSIONS = new Set([
  ...LOCAL_STATE_RESET_COMMANDS,
  'fresh-install',
  // A governance rebuild holds the repository reset barrier itself and refuses while any subject
  // lock is held, so an ordinary mutation lease around it would refuse it.
  'governance',
  // `lock` touches only the lease it names. Its release is the way out of a reset barrier another
  // machine left behind; a mutation lease around it met that barrier and refused its own release.
  'lock'
]);

// These commands either operate on machine-local installation/workspace state, explain the product,
// or intentionally initialize the caller's current directory. Redirecting one of them into the
// selected workspace would be surprising at best and destructive at worst. Every other command is
// repository-scoped and may safely use the repository explicitly selected by `workspace use` when
// Copilot or another host starts the CLI outside a Git checkout.
export const ACTIVE_WORKSPACE_ROUTING_EXCLUSIONS = new Set([
  'about', 'help', 'guide', 'show', 'quickstart', 'home', 'pause',
  'init', 'precheck', 'bootstrap', 'onboard', 'authority', 'cache',
  'factory-reset', 'reset-all', 'local-reset', 'fresh-install', 'reinstall', 'product',
  'workspace', 'session', 'inbox', 'repositories', 'plugin', 'goal', 'journal', 'push', 'local'
]);

/** Commands with a Work ID operand; story-routing.mjs says where it sits. */
export const STORY_OPERAND_COMMANDS = new Set(['status', 'nextsteps', 'report', 'approvals', 'progress', 'snapshot',
  'recover', 'doctor', 'reopen', 'cancel', 'sync', 'resume', 'return', 'watch', 'agent', 'specify', 'plan', 'implement',
  'verify', 'converge', 'receipt', 'change', 'tokens', 'context', 'impact', 'documents', 'state', 'ledger', 'delivery',
  'pr', 'story', 'decisions', 'decision']);

/**
 * Capability-map operations that address an organisation lead by URL rather than a checkout.
 *
 * These are the first-install path: before a capability is mapped there cannot be a workspace,
 * because a workspace is assembled from mapped capabilities. Treating the whole `capability`
 * command as repository-independent would break `capability tree|show|of|add|set|remove`, which do
 * read the selected repository. The subcommand boundary preserves both behaviours.
 */
export const REPOSITORY_INDEPENDENT_CAPABILITY_SUBCOMMANDS = new Set([
  'map', 'map-team', 'edit', 'publish', 'proposals', 'proposal', 'activate', 'cancel-proposal', 'discard-proposal',
  'rebase-proposal',
  'world-model', 'organisation', 'leads', 'inspect-repository', 'fsck', 'reconcile',
  'repository', 'repair-proposal', 'adopt-managed', 'onboard',
  'setup-proposals', 'setup-proposal', 'setup-activate'
]);

// Consent and capability inspection belong to the machine, not to the repository that happened
// to be selected in another window. Reconciliation is deliberately excluded: it mutates a Story
// and therefore keeps the ordinary repository/workspace routing boundary.
export const MACHINE_LOCAL_TELEMETRY_SUBCOMMANDS = new Set([
  'status', 'probe', 'enable', 'disable'
]);

// Browser-check capability discovery reports only which foundations and authorities are installed
// on this machine. It must work before a repository or workspace is selected. Every other browser-
// check action remains Story/repository-bound, so the exclusion is deliberately action-specific.
export const REPOSITORY_INDEPENDENT_REVISION_CHECK_ACTIONS = new Set(['capabilities']);

/** `lock` forms that name a lease by its path, not by a subject of the current repository. */
const LOCK_FILE_SUBCOMMANDS = new Set(['show-file', 'release-file']);

export function excludesActiveWorkspaceRouting(
  command, subcommand = null, options = {}, action = null
) {
  return ACTIVE_WORKSPACE_ROUTING_EXCLUSIONS.has(command)
    // Local skill inspection reads an explicit directory and remains repository-independent.
    // Approved inspection selects the current repository or active workspace's authority.
    || (command === 'skill' && subcommand === 'inspect')
    // Shared authoring writes must stay with the explicitly opened repository. A neutral cwd
    // cannot silently choose a different configuration authority from a machine-local selection.
    || (command === 'workflow' && subcommand === 'author')
    // Team import and workflow builds read explicit directories and write only machine-local state
    // (and an explicit --out file); relative paths must resolve where the person ran it.
    || (command === 'workflow' && subcommand === 'import-team')
    || (command === 'workflow' && subcommand === 'build')
    || (command === 'workflow' && subcommand === 'markup')
    || (command === 'workflow' && subcommand === 'intent')
    // Documentation topics remain machine-local and repository-independent. Code explanation is
    // deliberately repository-bound and may use the repository selected by `workspace use` when
    // Copilot starts from a neutral directory.
    || (command === 'explain' && subcommand !== 'code')
    // `doctor --performance` measures the Git checkout a person invoked it from, including a fresh
    // checkout with no workflow yet. Ordinary doctor remains repository-scoped and follows the
    // selected workspace when Copilot starts it outside a checkout.
    || (command === 'doctor' && (options.performance === true || options['git-speed'] === true))
    || (command === 'telemetry'
      && MACHINE_LOCAL_TELEMETRY_SUBCOMMANDS.has(subcommand ?? 'status'))
    // A lease file or lock directory is named by its own path: registry leases live in the home, so
    // reading or releasing one needs no repository (D6).
    || (command === 'lock' && LOCK_FILE_SUBCOMMANDS.has(subcommand))
    || (command === 'capability' && REPOSITORY_INDEPENDENT_CAPABILITY_SUBCOMMANDS.has(subcommand))
    || (command === 'revision' && subcommand === 'checks'
      && REPOSITORY_INDEPENDENT_REVISION_CHECK_ACTIONS.has(action))
    // Portable Process Evidence verification consumes only the named bundle bytes. It must work
    // in a fresh directory and must never be redirected to the last selected workspace.
    || (command === 'evidence' && subcommand === 'verify')
    // `sync <INTENT-ID>` retries a saved push in its own checkout, like `push`; no repository need be open.
    || (command === 'sync' && isTransportIntentId(subcommand));
}

/**
 * Commands that read whichever Git repository they are run in, governed or not: repository
 * knowledge (the brief, calls, explanations) and code explanation. The selected workspace stands in
 * only when no repository is open; otherwise a plain repository would be answered from another one.
 */
export function readsOpenedRepository(command, subcommand = null) {
  return (command === 'wm' && subcommand === 'knowledge') || (command === 'explain' && subcommand === 'code');
}

/**
 * These commands check the Story branch's remote tip before they publish. Ask now, from the
 * current branch and the default remote, so the answer arrives during loading and checks rather
 * than after them (remote-observation-prefetch.mjs). A Story publishing to another remote asks
 * again from its handler; an unused ask is abandoned when the command ends.
 */
function askPublicationTipEarly(root) {
  Promise.all([import('./git.mjs'), import('./git-remote-diagnostics.mjs'), import('./remote-observation-prefetch.mjs')])
    .then(([{ branch, exactRemoteBranchObservationAsync }, { configuredRemoteAuthority }, { prefetchRemoteBranchObservation }]) => {
      const url = configuredRemoteAuthority(root, 'origin')?.url;
      const current = branch(root);
      if (url && current) prefetchRemoteBranchObservation(root, url, current, exactRemoteBranchObservationAsync);
    }).catch(() => { /* the command asks at publication */ });
}

/** The paused answer for the entries that check pause before Git, or null; paused, it reads no personalization. */
async function copilotPause() {
  const { copilotModePresentation, readCopilotMode } = await import('./copilot-mode.mjs');
  const mode = readCopilotMode();
  return mode.paused ? copilotModePresentation(mode) : null;
}

/**
 * Whether any Copilot turn holds a mutation contract on this machine. Only then can a command's
 * result change one, so only then is the guard (and, when stale, the whole Story) loaded after it.
 */
async function hasMutationContracts() {
  try {
    const { copilotModeFile } = await import('./copilot-mode.mjs');
    return readdirSync(path.join(path.dirname(copilotModeFile()), 'copilot-boundaries'))
      .some(name => name.endsWith('.mutation.json'));
  } catch { return false; }
}

function rootIfAvailable(cwd = process.cwd()) {
  try { return repoRoot(cwd); } catch { return null; }
}

function timingMode(options) {
  if (options.offline === true) return 'offline';
  if (options['authority-local'] === true || options.local === true) return 'local';
  if (options.network === true) return 'network';
  return 'standard';
}

/** Pure launch-shape refusals must not first probe the machine's selected workspace. */
export function validateStoryStartRequestShape(command, positionals, options) {
  const start = command === 'start';
  const preflight = command === 'workspace' && positionals[1] === 'branches'
    && (optionString(options, 'preflight-story') || (options.entry === true && optionString(options, 'work-id')));
  if (!start && !preflight) return;
  const id = start ? requirePositional(positionals, 1, 'work ID') : preflight;
  validatePortableWorkId(id);
  // The approved workflow can narrow or broaden its ID pattern. Portable shape is all that can
  // be decided without that policy, for both existing Stories and new-work previews.
  if (!start) return;
  if ([optionBoolean(options, 'jira'), Boolean(optionString(options, 'github')),
    Boolean(optionString(options, 'story-file'))].filter(Boolean).length > 1) {
    throw new SingularityFlowError('Choose exactly one of --jira, --github, or --story-file.');
  }
  if (optionString(options, 'base') && optionStrings(options, 'from-branch').length) {
    throw new SingularityFlowError('Choose either --from-branch or the compatibility --base option, not both.', {
      code: 'STORY_BASE_INVALID'
    });
  }
}

export function commandFailureTiming(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  if (/(?:CANCELLED|CANCELED|STOP_REQUESTED|_ABORTED)$/.test(code ?? '')
      || /\bcancelled\b/i.test(error?.message ?? '')) {
    return Object.freeze({ outcome: 'cancelled', errorCode: code ?? 'COMMAND_CANCELLED' });
  }
  if (/(?:RECOVERY|INTERRUPTED)/.test(code ?? '')) {
    return Object.freeze({ outcome: 'recovery_required', errorCode: code });
  }
  if (error instanceof SingularityFlowError || error?.commandResult) {
    return Object.freeze({ outcome: 'refused', errorCode: code || 'SINGULARITY_FLOW_ERROR' });
  }
  return Object.freeze({ outcome: 'error', errorCode: code ?? 'UNEXPECTED_ERROR' });
}

/**
 * A Git root is not automatically the repository a workspace command should govern.
 *
 * Copilot can be rooted in the extension source, a workspace shell repository, or another nested
 * Git checkout. Only a working-tree workflow is an unambiguous claim that this checkout should
 * override the explicitly selected workspace. State/configuration branch authority is still
 * consumed by commands after routing; this narrow test prevents an unrelated Git root from
 * shadowing the selected repository before those readers can run.
 */
export function hasWorkingTreeGovernance(root) {
  return Boolean(root && existsSync(path.join(root, 'singularity', 'workflow.yml')));
}

/**
 * Git's answer to a routing probe, or a refusal when Git could not give one.
 *
 * Every "no" here routes the command to another workspace. A failed read used to be that "no", so
 * a Story disappeared exactly when its damaged repository needed repair. Only a successful read, or
 * Git's documented negative answer (`absentStatus`), may say this checkout carries no governance.
 */
function routingGitRead(root, args, label, { absentStatus = null, input = undefined } = {}) {
  return gitReadOutput(run('git', args, { cwd: root, allowFailure: true, input }), label, { absentStatus }) ?? '';
}

/** A production application branch may be configuration-free while these exact refs govern it. */
export function hasLocalGovernanceAuthority(root) {
  if (hasWorkingTreeGovernance(root)) return true;
  if (!root) return false;
  // The common application-branch case has an approved configuration/state ref locally. Ask that
  // bounded ref namespace first; walking the tracked index and then grepping every candidate
  // aggregate is fallback work for damaged/custom layouts, not the price of every invocation.
  const refs = routingGitRead(root, [
    'for-each-ref', '--format=%(refname)',
    'refs/heads/sflow/config', 'refs/remotes/*/sflow/config',
    'refs/heads/state', 'refs/remotes/*/state'
  ], 'Configuration and Flow Ledger branches');
  if (refs.split(/\r?\n/).some((entry) => entry.trim())) return true;

  // A lifecycle branch is self-contained after Story creation. Its immutable configuration
  // snapshot remains authoritative even when the shared configuration/state branches are
  // temporarily unavailable. Only the current checkout can make that claim; a sibling branch's
  // configuration must not turn repository routing into an all-branch Story discovery fallback.
  const checked = routingGitRead(root, ['cat-file', '--batch-check'], 'Current lifecycle configuration snapshot', {
    input: 'HEAD:singularity/workflow.yml\n'
  });
  if (checked.split(/\r?\n/).some((line) => /\sblob\s\d+$/.test(line.trim()))) return true;
  // A checked-out lifecycle aggregate is itself an unambiguous repository claim. Recovery and
  // read-only review commands must stay with it even if its configuration snapshot is damaged or
  // absent; redirecting those commands to the machine's last selected workspace makes the Story
  // disappear precisely when it needs repair. Use Git's tracked-file index instead of accepting an
  // arbitrary untracked directory that merely happens to use a Singularity-looking name.
  const governedSubjects = routingGitRead(root, [
    'ls-files', '--',
    'singularity/work-items/*/workflow.json',
    'singularity/initiatives/*/state.json'
  ], 'Tracked subjects');
  if (governedSubjects.trim()) return true;
  // workItemRoot and initiativeRoot are configurable. If the configuration snapshot itself is the
  // damaged file being recovered, the exact roots are no longer available to route the command.
  // Recognize tracked aggregate content in one bounded Git search instead of falling back to fixed
  // product-default directories or recursively searching the filesystem.
  const configuredSubjects = routingGitRead(root, [
    'grep', '-l', '-E',
    '-e', '"workItem"[[:space:]]*:',
    '-e', '"initiative"[[:space:]]*:',
    '--', ':(glob)**/workflow.json', ':(glob)**/state.json'
  ], 'Tracked aggregates', { absentStatus: 1 });
  if (configuredSubjects.trim()) return true;
  return false;
}

/**
 * Resolve the last ambiguous case without treating every Git remote as SFlow authority.
 *
 * Fresh production clones may intentionally fetch only `main`, so the configuration refs are not
 * local yet. Probe only the two exact governance branches, and only when a different active
 * workspace would otherwise replace the caller's current Git root.
 */
export async function hasRemoteGovernanceAuthority(root) {
  if (!root) return false;
  const remotes = routingGitRead(root, ['remote'], 'Configured remotes')
    .split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry && !FROZEN_REMOTE_ALIAS.test(entry));
  for (const remote of remotes) {
    const advertised = await runRemoteGitAsync([
      'ls-remote', '--heads', '--', remote,
      'refs/heads/sflow/config', 'refs/heads/state'
    ], { cwd: root, operation: 'remote-probe' });
    if (advertised.status === 0
        && advertised.stdout.split(/\r?\n/).some((entry) => entry.trim())) return true;
  }
  return false;
}

/**
 * Resolve the repository selected by the machine-local workspace context.
 *
 * A child CLI process cannot change the working directory of Copilot or VS Code. Workspace
 * selection therefore has to be an explicit routing input at the CLI boundary rather than a hint
 * that every command is expected to rediscover independently. The persisted selection is used
 * without refreshing the complete workspace: `workspace use` already validated it, and command
 * dispatch should not scan or materialize every repository before a single-repository operation.
 */
export async function activeWorkspaceRepositoryRoot(command, {
  env = process.env,
  home = undefined,
  subcommand = null,
  action = null,
  options = {}
} = {}) {
  if (excludesActiveWorkspaceRouting(command, subcommand, options, action)) return null;
  const {
    activeWorkspaceFile,
    readActiveWorkspaceContext,
    workspaceRegistryFile
  } = await import('./workspace-context.mjs');
  const context = await readActiveWorkspaceContext(
    activeWorkspaceFile(env, home),
    workspaceRegistryFile(env, home),
    { refresh: false }
  );
  if (!context) return null;
  const selectedPath = String(context.repositoryPath ?? '').trim();
  if (!selectedPath) {
    throw new SingularityFlowError(
      `Active workspace '${context.workspaceName ?? context.workspaceId}' does not select a repository. Select the workspace again.`,
      { code: 'ACTIVE_WORKSPACE_REPOSITORY_MISSING', details: { workspaceId: context.workspaceId } }
    );
  }
  let selectedRoot = null;
  try {
    const root = repoRoot(selectedPath);
    // A planned checkout can be an empty directory inside some other Git repository. Git then
    // reports that ancestor as the root; it is not the workspace member the person selected.
    if (sameWorkspaceRepositoryPath(root, selectedPath)) selectedRoot = root;
  } catch {
    // Story start is the first operation that needs application code. A selected, planned member
    // may be materialized below after its registry, manifest, and local target are rechecked.
  }
  if (command === 'start' && !optionBoolean(options, 'dry-run')) {
    const materialized = await materializeSelectedStoryRepositories(context, {
      env, home, selectedPath, options
    });
    if (materialized) return materialized;
  }
  if (selectedRoot) return selectedRoot;
  // A member not cloned yet: work clones it, a read is told what will (SPEC-SDA §11).
  const deferred = await (await import('./workspace-story-checkout.mjs')).deferredSelectionRoot(context, {
    env, home, selectedPath, command, subcommand, action, options
  });
  if (deferred) return deferred;
  // A member whose clone failed is missing: its own repair is the way on (C7), not another selection.
  const repair = context.workspacePath && context.repositoryId
    ? `singularity-flow workspace repair ${JSON.stringify(context.workspacePath)} --repository ${context.repositoryId}` : null;
  throw new SingularityFlowError(
    `Active workspace '${context.workspaceName ?? context.workspaceId}' points to '${selectedPath}', which is not an available Git repository. ${repair ? `Repair it with '${repair}'` : 'Repair the workspace'}, or select another with 'singularity-flow workspace use <WORKSPACE>'.`,
    {
      code: 'ACTIVE_WORKSPACE_REPOSITORY_UNAVAILABLE',
      details: {
        workspaceId: context.workspaceId, repositoryId: context.repositoryId, repositoryPath: selectedPath,
        // Workspace commands run without a repository; doctor and nextsteps would meet this again.
        nextAction: repair ?? 'singularity-flow workspace list',
        recoveryCommands: [...(repair ? ['singularity-flow workspace list'] : []), 'singularity-flow workspace use <WORKSPACE>']
      }
    }
  );
}

function sameWorkspaceRepositoryPath(left, right) {
  const canonical = (value) => {
    const resolved = path.resolve(value);
    // Git and the workspace registry may spell the same existing checkout through different
    // system aliases (notably macOS /var versus /private/var). Never accept an ancestor repo
    // merely because a planned target lies beneath it, but compare existing roots canonically.
    let actual;
    try { actual = realpathSync.native(resolved); }
    catch { actual = resolved; }
    return process.platform === 'win32' ? actual.toLowerCase() : actual;
  };
  return canonical(left) === canonical(right);
}

async function materializeSelectedStoryRepositories(context, { env, home, selectedPath, options }) {
  // A selected Story points at a specific checkout. Never replace a missing Story worktree with
  // the canonical repository, even if that repository could be cloned or repaired independently.
  if (context.storyId || context.requestedStoryId || context.selectionStatus === 'stale'
      || !context.workspacePath || !context.repositoryId) return null;
  const { resolveWorkspaceReference, workspaceRegistryFile } = await import('./workspace-context.mjs');
  const { readWorkspace, repairWorkspace, workspaceRepositoryPath, workspaceStatus } =
    await import('./workspace.mjs');
  const registered = await resolveWorkspaceReference(
    workspaceRegistryFile(env, home), context.workspacePath
  );
  if (registered.id !== context.workspaceId) return null;
  const workspace = await readWorkspace(registered.path);
  const repository = workspace.repositories[context.repositoryId];
  if (workspace.id !== context.workspaceId || !repository) return null;
  const expectedPath = workspaceRepositoryPath(workspace, repository);
  if (!sameWorkspaceRepositoryPath(expectedPath, selectedPath)) return null;
  const requestedCapability = Array.isArray(options.capability)
    ? options.capability.at(-1) : options.capability;
  const explicitCapability = String(requestedCapability ?? '').trim();
  const memberCapabilities = repository.capabilities ?? [];
  if (explicitCapability && !memberCapabilities.includes(explicitCapability)) {
    throw new SingularityFlowError(
      `Selected repository '${repository.id}' does not belong to capability '${explicitCapability}'. Choose one of its mapped capabilities before starting.`,
      { code: 'CAPABILITY_BRANCH_INVALID' }
    );
  }
  if (!explicitCapability && memberCapabilities.length > 1) {
    throw new SingularityFlowError(
      `Selected repository '${repository.id}' belongs to multiple capabilities. Choose one with --capability before starting so only its repositories are cloned.`,
      { code: 'CAPABILITY_SELECTION_REQUIRED' }
    );
  }
  const capability = explicitCapability || memberCapabilities[0] || null;
  const requiredRepositories = capability
    ? (await import('./capability-branches.mjs'))
      .capabilityRepositories(workspace, capability)
    : [repository];
  const requiredIds = [...new Set(requiredRepositories.map((item) => item.id))];
  let after;
  try {
    // Repair owns the one initial readiness scan and, if cloning was necessary, its final scan.
    // Scanning here before and after repair used to multiply local Git status commands across
    // every member of a large workspace, even though only this capability's repositories matter.
    // A fully ready selection returns from repair before touching its journal.
    const result = await withOperationContext({
      operation: operationById('workspace.repair'),
      modelMode: { enabled: false },
      root: null,
      command: 'workspace',
      startedAt: new Date().toISOString()
    }, () => repairWorkspace(workspace.path, {
      repositoryIds: requiredIds,
      recoverCapabilityDrops: false,
      returnIfSelectedReady: true,
      statusLevel: 'readiness',
      env
    }));
    after = result.status;
  } catch (error) {
    // Another Story launch may have claimed the same staged clones first. A fresh readiness
    // check can prove that this launch can continue. An occupied/unsafe target retains the
    // existing routing refusal rather than being mistaken for a clonable missing checkout.
    const raced = await workspaceStatus(workspace.path, { level: 'readiness', env });
    const states = requiredIds.map((id) => raced.repositories
      .find((item) => item.id === id)?.state);
    if (states.some((state) => !['ready', 'missing', 'empty', 'deferred'].includes(state))) return null;
    if (!states.every((state) => state === 'ready')) throw error;
    after = raced;
  }
  if (!requiredIds.every((id) => after.repositories
    .find((item) => item.id === id)?.state === 'ready')) return null;
  const root = repoRoot(expectedPath);
  return sameWorkspaceRepositoryPath(root, expectedPath) ? root : null;
}

/**
 * Workspace operations whose implementation can write a member checkout or its Git control data.
 *
 * `workspace` is intentionally excluded from active-workspace cwd routing, so the process cwd may
 * be the SFlow source tree, another application, or no repository at all. These operations must be
 * fenced against factory reset at the checkout(s) named by the workspace manifest, not at cwd.
 */
const WORKSPACE_REPOSITORY_MUTATION_SUBCOMMANDS = new Set([
  'attach-capability', 'detach-capability', 'archive', 'sync', 'repair',
  'refresh-configuration', 'reinitialize'
]);

function workspaceOperationTouchesRepositories(subcommand, options, classification) {
  if (WORKSPACE_REPOSITORY_MUTATION_SUBCOMMANDS.has(subcommand)) {
    return classification === 'mutation';
  }
  // Archive readiness is presented as a read, but its default `--fetch` refreshes local remote-
  // tracking refs. Treat that small Git write as a mutation for reset exclusion without changing
  // the command's public read classification or output contract.
  if (subcommand === 'archive-status') return optionBoolean(options, 'fetch', true);
  if (subcommand === 'status') {
    return optionBoolean(options, 'archive-readiness')
      && optionBoolean(options, 'fetch', true);
  }
  return false;
}

function workspaceReferencePosition(subcommand, positionals) {
  if (subcommand === 'impact') return positionals[3] ?? null;
  if (subcommand === 'documents' && positionals[2] === 'import') return positionals[3] ?? null;
  return positionals[2] ?? null;
}

async function workspaceManifestsForRepositoryMutation(subcommand, positionals, options) {
  const { readWorkspace, readWorkspaceRegistry } = await import('./workspace.mjs');
  const { resolveWorkspaceReference, workspaceRegistryFile } = await import('./workspace-context.mjs');
  if (['refresh-configuration', 'reinitialize'].includes(subcommand)) {
    const registry = workspaceRegistryFile();
    const selected = positionals[2]
      ?? (Array.isArray(options.workspace) ? options.workspace.at(-1) : options.workspace)
      ?? null;
    if (selected) {
      const entry = await resolveWorkspaceReference(registry, selected);
      const manifest = await readWorkspace(entry.path).catch(() => null);
      // Reinitialization is itself the recovery path for an obsolete manifest. Do not replace its
      // structured migration diagnosis with a target-lease preflight error; an unreadable manifest
      // cannot authorize any repository mutation, and the handler will fail/repair it normally.
      return manifest ? [manifest] : [];
    }
    const entries = (await readWorkspaceRegistry(registry)).filter((entry) => !entry.archivedAt);
    const manifests = await Promise.all(entries.map((entry) => readWorkspace(entry.path).catch(() => null)));
    // The command itself reports damaged registry entries as partial/blocked. Lease every checkout
    // that can be proved from readable manifests and leave those diagnostics to its normal path.
    return manifests.filter(Boolean);
  }
  const reference = workspaceReferencePosition(subcommand, positionals);
  if (!reference) return [];
  // Ordinary workspace mutators already require a directory and pass it directly to readWorkspace;
  // use the same boundary so target discovery cannot silently select a different saved workspace.
  return [await readWorkspace(reference)];
}

/**
 * Resolve the real Git roots a command can mutate, or `null` when it has no explicit target model.
 *
 * Missing/unmaterialized repositories are skipped because there is no Git control directory on
 * which factory reset could operate. Invalid existing checkouts remain the command's own recovery
 * diagnostic. Available member roots are canonicalized by Git and deduplicated across workspaces.
 *
 * A checkout the command is about to drop stays in the set. Its lease has to fence it right up to
 * the move, and the drop hands that lease over (`prepareHeldLockRemoval`) so its release can tell
 * the command's own removal from a takeover.
 */
export async function explicitRepositoryMutationRoots({
  command, subcommand = null, positionals = [], options = {}, classification = 'mutation'
} = {}) {
  if (command !== 'workspace'
      || !workspaceOperationTouchesRepositories(subcommand, options, classification)) return null;
  const { workspaceRepositoryPath } = await import('./workspace.mjs');
  const manifests = await workspaceManifestsForRepositoryMutation(subcommand, positionals, options);
  const requestedRepositoryIds = ['refresh-configuration', 'reinitialize'].includes(subcommand)
    ? new Set((Array.isArray(options.repository)
      ? options.repository : options.repository == null ? [] : [options.repository])
      .map((value) => String(value).trim()).filter(Boolean))
    : null;
  const roots = new Map();
  for (const workspace of manifests) {
    for (const [repositoryId, repository] of Object.entries(workspace.repositories ?? {})) {
      if (requestedRepositoryIds?.size && !requestedRepositoryIds.has(repositoryId)) continue;
      const candidate = workspaceRepositoryPath(workspace, repository);
      let canonical;
      try { canonical = repoRoot(candidate); }
      catch { continue; }
      const key = process.platform === 'win32'
        ? path.resolve(canonical).toLowerCase() : path.resolve(canonical);
      roots.set(key, canonical);
    }
  }
  return [...roots.values()].sort((left, right) => left.localeCompare(right));
}

/** Hold reset-visible leases on every explicit checkout for the complete command handler. */
export async function withExplicitRepositoryMutationLeases(roots, operationId, callback) {
  const targets = [...new Set((roots ?? []).map((entry) => path.resolve(entry)))]
    .sort((left, right) => left.localeCompare(right));
  if (!targets.length) return callback();
  const { withRepositoryMutationLease } = await import('./subject-lock.mjs');
  const enter = (index) => index >= targets.length
    ? callback()
    : withRepositoryMutationLease(targets[index], operationId, () => enter(index + 1));
  return enter(0);
}

export async function main(argv) {
  // Where the agent's terminal is, before a command moves into a Story's checkout: kept results are
  // filed under it, and `result last` looks there (agent-result-keeper.mjs).
  if (!(globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH > 0)) globalThis.__SFLOW_INVOCATION_CWD = process.cwd();
  const contextRequest = executionContextArguments(argv);
  argv = contextRequest.argv;
  // Git answers earlier commands in this session already proved; see git-fact-store.mjs.
  installGitFactStore();
  const uninstall = installFileLeaseSignalHandlers();
  const { positionals, options } = parseArgs(argv);
  try {
    const utilityEntry = options['utility-entry'] !== undefined ? { operation: positionals.join(' ') } : null;
    if (utilityEntry) validateUtilityEntry(positionals, options);
    // Every command accepts --for-agent. The compact entries read it (and check a pause) themselves;
    // for the others it shapes the output only, and a paused SFlow answers before any Git or lookup.
    const agentFlag = options['for-agent'] !== undefined;
    const ownsFlag = interpretsForAgent(positionals);
    if ((utilityEntry || agentFlag && !ownsFlag) && !['pause', 'hook'].includes(positionals[0])) {
      const paused = await copilotPause();
      if (paused) return console.log(optionBoolean(options, 'json') ? JSON.stringify(paused, null, 2) : paused.message);
    }
    const commandArgv = utilityEntry ? withoutUtilityEntry(argv) : argv;
    const invoke = () => withCliJsonOutput(optionBoolean(options, 'json'),
      () => runMain(agentFlag && !ownsFlag ? withoutAgentFlag(commandArgv) : commandArgv, utilityEntry, contextRequest.root),
      { forAgent: agentViewRequested(options), kind: positionals[0], utilityEntry, argv: commandArgv });
    // Include the first-build gate, accounting and authoring in one bounded immutable capture.
    // No branch tip, identity authorization or working-tree validation is cached here.
    return await (positionals[0] === 'start'
      || positionals[0] === 'workspace' && positionals[1] === 'branches'
      || positionals[0] === 'story' && positionals[1] === 'prepare-worktree'
      ? (await import('./creation-context.mjs')).withCreationContext(invoke, { configurationTransfers: positionals[0] === 'start' })
      : invoke());
  }
  finally {
    uninstall();
    // SF Guard's foreign-key alarm (SPEC-PSS-v1 REQ-023).
    if (process.stderr.isTTY && !(globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH > 0) && positionals[0] !== 'hook' && presencePolicyAbove(process.cwd())) {
      await (await import('./presence/alarm.mjs')).presenceAlarm(process.cwd());
    }
  }
}

/** Whether `directory` or a parent holds SF Guard's policy file. */
function presencePolicyAbove(directory) {
  for (let at = path.resolve(directory), parent = null; at !== parent; parent = at, at = path.dirname(at)) {
    if (existsSync(path.join(at, 'singularity', 'presence.json'))) return true;
  }
  return false;
}

async function runMain(argv, utilityEntry = null, explicitContextRoot = null) {
  const invocationCwd = process.cwd();
  const modelMode = resolveModelMode(argv);
  const effectiveArgv = stripGlobalModelOptions(argv);
  // Product reinstall and product alignment are intentionally not repository operations. Resolving
  // a root would invoke Git before the command even reached its strict no-repository boundary.
  const localOnlyRequest = ['about', 'reinstall', 'product', 'pause'].includes(effectiveArgv[0])
    || (effectiveArgv[0] === 'skill'
      && parseArgs(effectiveArgv).positionals[1] === 'inspect');
  let root = null;
  const argvSha256 = createHash('sha256').update(JSON.stringify(effectiveArgv)).digest('hex');
  /**
   * Which build this is, on its own flag rather than folded into `--version`.
   *
   * `--version` is a machine-parsed contract: `reinstall.mjs` compares its output to the planned
   * version with `!==`, so appending provenance to it would make every `--clean-reinstall` throw.
   * `test/cli.test.mjs`'s "print only the package version" was guarding exactly that, and it was
   * right. So the version stays a bare semver forever and the provenance gets its own opt-in flag.
   */
  if (effectiveArgv.length === 1 && effectiveArgv[0] === '--build') {
    return withOperationContext({
      operation: { id: 'version', modelPolicy: 'never', classification: 'read', output: 'human' },
      modelMode, root, argvSha256, argvHash: `sha256:${argvSha256}`, command: 'version', startedAt: new Date().toISOString()
    }, () => console.log(versionLine()));
  }
  if (effectiveArgv.length === 1 && ['--version', '-v'].includes(effectiveArgv[0])) {
    return withOperationContext({
      operation: { id: 'version', modelPolicy: 'never', classification: 'read', output: 'human' },
      modelMode, root, argvSha256, argvHash: `sha256:${argvSha256}`, command: 'version', startedAt: new Date().toISOString()
    }, () => console.log(VERSION));
  }
  const { positionals, options } = parseArgs(effectiveArgv);
  const requested = positionals[0];
  if (!requested || ['--help', '-h'].includes(requested)) {
    root = localOnlyRequest ? null : rootIfAvailable();
    return withOperationContext({
      operation: { id: 'help.root', modelPolicy: 'never', classification: 'read', output: 'human' },
      modelMode,
      root,
      argvSha256,
      argvHash: `sha256:${argvSha256}`,
      command: 'help',
      startedAt: new Date().toISOString()
    }, async () => {
      if (effectiveArgv.every((token) => ['--help', '-h', '--all'].includes(token))
          && effectiveArgv.some((token) => ['--help', '-h'].includes(token))) {
        if (effectiveArgv.includes('--all')) {
          const { HELP } = await import('./help-text.mjs');
          return console.log(HELP);
        }
        const { renderOverview } = await import('./help-pages.mjs');
        return console.log(renderOverview(VERSION));
      }
      const legacy = await import('./commands/legacy.mjs');
      return legacy.run(effectiveArgv, { positionals, options });
    });
  }
  if (requested === 'version') {
    return withOperationContext({
      operation: { id: 'version', modelPolicy: 'never', classification: 'read', output: 'human' },
      modelMode, root, argvSha256, argvHash: `sha256:${argvSha256}`, command: 'version', startedAt: new Date().toISOString()
    }, () => console.log(VERSION));
  }

  // Rejects an unknown name with a correction and two entry points. It throws rather than returning
  // nothing, so there is no falsy case to test for here.
  const definition = commandDefinition(requested);
  // Before the operation is resolved and long before the handler loads. `--help` used to be parsed
  // into `options` and then ignored — and because unknown options are accepted silently, the command
  // simply ran. `singularity-flow status --help` printed a status; `singularity-flow approve --help`
  // would have attempted an approval. Asking a governance tool what a command does must never be the
  // thing that performs it.
  if (options.help === true || options.h === true) {
    root = localOnlyRequest ? null : rootIfAvailable();
    const { renderCommandHelp } = await import('./help-pages.mjs');
    return withOperationContext({
      operation: { id: 'help.command', modelPolicy: 'never', classification: 'read', output: 'human' },
      modelMode, root, argvSha256, argvHash: `sha256:${argvSha256}`, command: 'help', startedAt: new Date().toISOString()
    }, () => console.log(renderCommandHelp(definition.name)));
  }
  // Pause controls and paused host hooks must be served before Git routing, product review,
  // command timing, telemetry, or repository/session discovery. Installing skills is opt-in;
  // pausing guidance is never permission to bypass an explicitly invoked CLI gate.
  if (definition.name === 'pause') {
    const operation = resolveOperation({ requestedCommand: 'pause', positionals, options });
    return withOperationContext({ operation, modelMode, root: null, argvSha256,
      argvHash: `sha256:${argvSha256}`, command: 'pause', startedAt: new Date().toISOString() },
    async () => (await import('./commands/pause.mjs')).run(effectiveArgv, { positionals, options, operation }));
  }
  // /sf-session uses this composed entry instead of a separate pause/workspace preflight. Serve
  // pause before root discovery or product gates, including a broken or absent Git installation.
  if (definition.name === 'workspace' && positionals[1] === 'branches' && options.entry === true) {
    const paused = await copilotPause();
    if (paused) return console.log(JSON.stringify({
      resultType: 'intake-entry', status: 'paused', paused: true,
      agentInstruction: paused.agentInstruction
    }));
  }
  if (definition.name === 'session' && positionals[1] === 'open') {
    const { validateSessionOpenRequest, pausedSessionOpenResult } = await import('./commands/session-open.mjs');
    validateSessionOpenRequest({ positionals, options });
    const paused = await copilotPause();
    if (paused) {
      const result = pausedSessionOpenResult(paused.agentInstruction);
      return console.log(options.json ? JSON.stringify(result, null, 2)
        : 'Singularity Flow guidance is paused. Resume it with /sf-pause off.');
    }
  }
  // Host hooks are machine-local dispatch: SDK chats commonly have a non-Git cwd. Discovery
  // guards must not perform routing, telemetry or product migrations just to return no decision.
  if (definition.name === 'hook') {
    const operation = resolveOperation({ requestedCommand: 'hook', positionals, options });
    return withOperationContext({ operation, modelMode, root: null, argvSha256,
      argvHash: `sha256:${argvSha256}`, command: 'hook', startedAt: new Date().toISOString() }, async () => {
      if (['boundary-turn', 'boundary-guard', 'boundary-after', 'boundary-end'].includes(positionals[1])) {
        return (await import('./copilot-repository-boundary.mjs')).runRepositoryBoundaryHook(positionals[1]);
      }
      // A declared agent's stamping hook [SPEC-SFG-v1 D4]; it records while paused too, and answers {}.
      if (positionals[1] === 'agent-stamp') return (await import('./comprehension/xpl2/sf-guard-recorder.mjs')).runSfGuardStamp(positionals[2], positionals[3]);
      if (await copilotPause()) return console.log('{}');
      return (await import('./commands/legacy.mjs')).run(effectiveArgv, { positionals, options });
    });
  }
  const phaseEntry = definition.name === 'phase' && positionals[1] === 'enter';
  if (phaseEntry) (await import('./agent-entry-options.mjs')).validatePhaseEntryRequest({ positionals, options });
  if (definition.name === 'session' && positionals[1] === 'takeover') {
    (await import('./commands/session-takeover.mjs')).validateSessionTakeoverRequest({ positionals, options });
    const paused = options['for-agent'] ? await copilotPause() : null;
    if (paused) return console.log(JSON.stringify(paused));
  }
  if (definition.name === 'session' && !['open', 'takeover'].includes(positionals[1]) && options['for-agent'] !== undefined) {
    const paused = (await import('./session-agent-entry.mjs')).sessionAgentEntryGuard(positionals, options);
    if (paused) return console.log(JSON.stringify(paused));
  }
  const agentEntry = ['inputs', 'nextsteps', 'review-source'].includes(definition.name) && options['for-agent'] !== undefined;
  if (agentEntry) (await import('./agent-entry-options.mjs')).validateAgentEntryRequest(definition.name, { positionals, options });
  if (['hook', 'home', 'check'].includes(definition.name) || phaseEntry || agentEntry) {
    const paused = await copilotPause();
    if (paused) {
      if (definition.name === 'hook') return console.log('{}');
      return console.log(optionBoolean(options, 'json') ? JSON.stringify(paused, null, 2) : paused.message);
    }
  }
  // Skill option errors must precede repository discovery/routing. In particular, a diagnostic
  // without an explicit Story and phase cannot accidentally select an active workspace first.
  if (definition.name === 'skill') {
    const { validateSkillRequest } = await import('./commands/skill-request.mjs');
    await validateSkillRequest({ positionals, options });
  }
  if (definition.name === 'instruction') (await import('./commands/instruction-request.mjs')).validateInstructionRequest({ positionals, options });
  if (definition.name === 'workflow' && positionals[1] === 'author') {
    const { validateWorkflowAuthorRequest } = await import('./commands/workflow-author.mjs');
    validateWorkflowAuthorRequest({ positionals, options });
  }
  validateStoryStartRequestShape(definition.name, positionals, options);
  const timingInput = {
    started: globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT ?? process.hrtime.bigint(),
    commandClass: 'unknown', operationId: null, mode: timingMode(options)
  };
  if (process.env.SINGULARITY_FLOW_PERF_TRACE === '1' && !(definition.name === 'logs' && positionals[1] === 'performance')) {
    timingInput.trace = (await import('./performance-trace.mjs')).createPerformanceTrace({
      command: definition.name, started: timingInput.started,
      temperature: process.env.SINGULARITY_FLOW_PERF_TEMPERATURE
    });
    timingInput.invocationId = timingInput.trace.invocationId;
  }
  const timer = commandTimer(definition.name, timingInput);
  // An explicit window/chat binding beats the profile default. It is only a selector: the
  // existing command still verifies Git, accepted Story, permissions and publication freshness.
  const contextRoutingExcluded = excludesActiveWorkspaceRouting(definition.name,
    positionals[1] ?? null, options, positionals[2] ?? null);
  const boundRoot = explicitContextRoot
    ?? (contextRoutingExcluded ? null : surfaceContext()?.repositoryPath ?? null);
  if (boundRoot) {
    let selectedRoot;
    try { selectedRoot = repoRoot(boundRoot); }
    catch (error) {
      throw new SingularityFlowError(`The bound checkout is unavailable: ${error.message}. Another workspace was not selected.`, {
        code: 'EXECUTION_CONTEXT_ROOT_UNAVAILABLE', details: { repositoryPath: boundRoot,
          cause: { code: error.code ?? null, message: error.message, details: error.details ?? null } }
      });
    }
    if (!selectedRoot || !sameWorkspaceRepositoryPath(selectedRoot, boundRoot)) {
      throw new SingularityFlowError('The bound checkout is unavailable. Reopen or repair that checkout; another workspace was not selected.', {
        code: 'EXECUTION_CONTEXT_ROOT_UNAVAILABLE', details: { repositoryPath: boundRoot }
      });
    }
    process.chdir(selectedRoot);
  }
  // Resolve workspace membership before generic routing. Intake only selects existing storage;
  // Start reuses its Git objects and creates the Story worktree without a second full checkout.
  let automaticIntake = null;
  let automaticScope = action => action();
  if (definition.name === 'start' || definition.name === 'story' && ['start', 'prepare-worktree', 'prepare-configuration'].includes(positionals[1])
      || definition.name === 'workspace' && positionals[1] === 'branches' && optionString(options, 'preflight-story')) {
    resolveOperation({ requestedCommand: requested, positionals, options });
    // A new Story's branch follows the repository's naming pattern unless the person named one
    // (--ref). Chosen before the checkout below, which is keyed by that branch.
    const storyWorkId = definition.name === 'start' ? positionals[1]
      : definition.name === 'workspace' ? optionString(options, 'preflight-story')
        : positionals[1] === 'start' ? positionals[2] : optionString(options, 'work-id');
    await withCommandTiming(timer, async () => (await import('./story-branch-name.mjs')).applyStoryBranchNaming(storyWorkId, options));
    const { automaticWorkspaceStoryCheckout, rebaseAutomaticStoryFiles, withAutomaticStoryCheckout } = await import('./workspace-story-checkout.mjs');
    automaticIntake = await withCommandTiming(timer, () => automaticWorkspaceStoryCheckout(definition.name, positionals, options));
    if (automaticIntake) {
      automaticScope = action => withAutomaticStoryCheckout(automaticIntake, action);
      rebaseAutomaticStoryFiles(options, process.cwd());
      process.chdir(automaticIntake.repositoryPath);
      if (definition.name === 'start' || definition.name === 'story' && positionals[1] === 'start') options['isolated-worktree'] = true;
    }
  }
  // Root discovery is part of the command. Bind the timing context before the first Git probe so
  // --timings and durable events no longer omit dispatch work performed ahead of module loading.
  root = automaticIntake?.repositoryPath ?? (localOnlyRequest ? null : withCommandTiming(timer, () => rootIfAvailable()));
  const subcommand = positionals[1] ?? null;
  const action = positionals[2] ?? null;
  const routingExcluded = excludesActiveWorkspaceRouting(
    definition.name, subcommand, options, action
  );
  await withCommandTiming(timer, async () => {
    const opened = Boolean(automaticIntake) || Boolean(root) && readsOpenedRepository(definition.name, subcommand);
    if (!boundRoot && !routingExcluded && !opened && (!root || !hasLocalGovernanceAuthority(root))) {
      const selectedRoot = await activeWorkspaceRepositoryRoot(definition.name, {
        subcommand, action, options
      });
      const selectedDiffers = selectedRoot && (!root || path.resolve(selectedRoot) !== path.resolve(root));
      const currentClaimsAuthority = selectedDiffers && root
        ? await hasRemoteGovernanceAuthority(root) : false;
      if (selectedRoot && !currentClaimsAuthority) {
        // All existing repository services resolve relative paths from process.cwd(). Moving this
        // short-lived CLI process is the compatibility bridge that makes the selected workspace
        // authoritative without teaching dozens of commands about machine-local workspace state.
        process.chdir(selectedRoot);
        root = selectedRoot;
      }
    }
  });
  // A command naming another Story runs in its checkout, or refuses (story-routing.mjs).
  if (root && !boundRoot && !routingExcluded && !automaticIntake
      && (options['work-id'] !== undefined || positionals.length > 1 && STORY_OPERAND_COMMANDS.has(definition.name))) {
    const routed = await withCommandTiming(timer, async () => (await import('./story-routing.mjs'))
      .routeNamedStory({ command: definition.name, positionals, options, argv: effectiveArgv, root }));
    if (routed) {
      process.chdir(root = routed.root);
      globalThis.__SFLOW_STORY_ROUTE = routed.route;
      if (!optionBoolean(options, 'json')) process.stderr.write(`${routed.route.workId} → ${root}\n`);
    }
  }
  if (!root && !routingExcluded) {
    // Git's refusal to read the repository the person is in, rather than a request for one.
    if (!localOnlyRequest) refuseUnreadableRepository(process.cwd());
    throw new SingularityFlowError(
      "Run Singularity Flow from inside a Git repository, or select one with 'singularity-flow workspace use <WORKSPACE>'.",
      { code: 'REPOSITORY_CONTEXT_REQUIRED', details: {
        nextAction: 'singularity-flow workspace list',
        recoveryCommands: ['singularity-flow workspace use <WORKSPACE>']
      } }
    );
  }
  if (utilityEntry) utilityEntry.repositoryPath = root;
  // A publication whose index refresh another program blocked finished anyway and left a record;
  // complete that refresh before this command reads the tree. Without a record this is one file
  // lookup and no Git process.
  if (root) await (await import('./deferred-index-refresh.mjs')).completeDeferredIndexRefresh(root);
  if (root && (['submit', 'approve', 'reject'].includes(definition.name) || (definition.name === 'phase' && subcommand === 'publish'))) {
    askPublicationTipEarly(root);
  }
  const requestedOperation = resolveOperation({
    requestedCommand: requested,
    positionals: [definition.name, ...positionals.slice(1)],
    options
  });
  const operation = requestedOperation.modelPolicy === 'optional' && !modelMode.enabled
    ? operationById(requestedOperation.fallback.operationId)
    : requestedOperation;
  if (operation.modelPolicy === 'required' && !modelMode.enabled) {
    const fallback = operation.fallback?.operationId
      ? ` Use the model-free fallback: singularity-flow ${operation.fallback.operationId.replace('.', ' ')}.`
      : '';
    throw new SingularityFlowError(`Operation '${operation.id}' requires a model and cannot run with --no-model.${fallback} ${modelOffCause(modelMode)}`, {
      code: 'MODEL_UNAVAILABLE', details: { operationId: operation.id, fallback: operation.fallback ?? null, modelSource: modelMode.source ?? null }
    });
  }
  // The resolved operation, not the command. Some command nouns carry both read and mutating
  // subcommands; classification is known only after the now-measured dispatch probes complete.
  timingInput.commandClass = operation.classification;
  timingInput.operationId = operation.id;
  // The passes below run before the command's module loads. Each is a named span, with its Git work
  // counted, so a slow command says where its first seconds went instead of one opaque root-dispatch.
  const dispatchSpan = (name, action) => withCommandTiming(timer, () => timer.measure(name, action));
  // A repository whose approved configuration requires a newer build installs that build's signed
  // release before any mutation runs on an older one, then continues the command on it.
  const requiredBuild = await productRequirementDue({
    root, command: definition.name, classification: operation.classification
  });
  if (requiredBuild) {
    const required = await dispatchSpan('dispatch.product-requirement', async () => {
      const { enforceProductRequirement } = await import('./product-requirement.mjs');
      return enforceProductRequirement({ root, runningBuild: requiredBuild, argv });
    });
    if (required.status === 'handed-off') {
      process.exitCode = required.exitCode;
      return null;
    }
  }
  // A new build's first mutation brings every product surface on the machine to the installed
  // build and repairs machine-local state, once. Reads never do: they must stay free of side
  // effects. The gate is one small file read; the pass and its modules load only when due.
  const passBuild = await firstRunPassDue({
    command: definition.name, classification: operation.classification
  });
  if (passBuild) {
    const aligned = await dispatchSpan('dispatch.first-run', async () => {
      const { firstRunPass } = await import('./first-run-pass.mjs');
      return firstRunPass({ runningBuild: passBuild, argv });
    });
    if (aligned.status === 'handed-off') {
      process.exitCode = aligned.exitCode;
      return null;
    }
  } else {
    // The first-run pass starts a build's first configuration-review pass. A terminal has no other
    // trigger, so a pass that failed, left repositories unchecked or lost its worker is retried here,
    // at most hourly. One small file read; the pass and its modules load only when one is due.
    const retryBuild = await configurationReviewRetryDue({
      command: definition.name, subcommand, classification: operation.classification
    });
    if (retryBuild) {
      await dispatchSpan('dispatch.configuration-reviews', async () => {
        const { startConfigurationReviews } = await import('./configuration-review-pass.mjs');
        await startConfigurationReviews({ runningBuild: retryBuild });
      });
    }
  }
  const smartInitDryRun = definition.name === 'init'
    && optionBoolean(options, 'smart-detect') && optionBoolean(options, 'dry-run');
  const durableTimingStart = process.env.SINGULARITY_FLOW_DX_DURABLE_START === '1'
    || process.env.CI === 'true';
  if (durableTimingStart && !LOCAL_STATE_RESET_COMMANDS.has(definition.name) && !smartInitDryRun) {
    await recordCommandTiming(root, timer.startEvent());
  }
  timer.stage('root-dispatch');
  try {
    // A literal loader when there is one, so the bundled CLI carries the module (command-loaders.mjs).
    const module = await withCommandTiming(timer, async () => {
      const { COMMAND_LOADERS } = await import('./command-loaders.mjs');
      return COMMAND_LOADERS[definition.modulePath]?.() ?? import(definition.modulePath);
    });
    /**
     * A module that defers the rest of its own graph reports that cost here, not inside `execute`.
     *
     * `commands/legacy.mjs` is a four-line shim in front of `cli.mjs`, so importing the shim
     * measures nothing and the 110 ms it fronts landed in `execute` alongside the command's real
     * work. Optional, because command modules with no deferred graph have nothing to declare.
     */
    await withCommandTiming(timer, () => module.load?.({
      argv: effectiveArgv,
      positionals: [definition.name, ...positionals.slice(1)],
      options,
      definition,
      operation,
      requestedOperation,
      modelMode
    }));
    timer.stage('module-load');
    const startedAt = new Date().toISOString();
    const execute = () => automaticScope(() => withExecutionContextScope(root, () => withOperationContext({
      operation,
      modelMode,
      root,
      argvSha256,
      argvHash: `sha256:${argvSha256}`,
      fallbackFrom: operation.id === requestedOperation.id ? null : requestedOperation.id,
      command: definition.name,
      startedAt
    }, () => module.run(effectiveArgv, {
      positionals: [definition.name, ...positionals.slice(1)], options, definition,
      operation, requestedOperation, modelMode, invocationCwd
    })), { boundRoot: explicitContextRoot ?? surfaceContext()?.repositoryPath ?? null }));
    // Keep the complete mutating handler visible to factory reset. The reset barrier and this
    // short-lived, uniquely named lease form a two-way exclusion boundary: a reset refuses while
    // any current-build mutation is active, and a mutation refuses once reset has begun. Loading
    // this machinery lazily preserves the startup cost of read-only commands.
    const explicitMutationRoots = !smartInitDryRun
      && !REPOSITORY_MUTATION_LEASE_EXCLUSIONS.has(definition.name)
      ? await withCommandTiming(timer, () => explicitRepositoryMutationRoots({
        command: definition.name,
        subcommand,
        positionals: [definition.name, ...positionals.slice(1)],
        options,
        classification: operation.classification
      }))
      : null;
    // An explicit target model replaces cwd rather than augmenting it. A workspace command issued
    // from the SFlow source checkout must not create the comforting but useless lease there while
    // leaving the member repository it drops/fetches open to a concurrent factory reset.
    const mutationRoots = explicitMutationRoots ?? (
      operation.classification === 'mutation' && root ? [root] : []
    );
    const guardedExecute = mutationRoots.length
      && !smartInitDryRun
      && !REPOSITORY_MUTATION_LEASE_EXCLUSIONS.has(definition.name)
      ? () => withExplicitRepositoryMutationLeases(mutationRoots, operation.id, execute)
      : execute;
    // A command that did not publish leaves its early remote ask unanswered; never wait for it.
    // Only closed read forms share configuration through accounting and execution. A mutation,
    // repair, phase entry or unknown option never inherits cached configuration decisions.
    const invoke = scopedUtilityRead([definition.name, ...positionals.slice(1)], options)
      ? () => withCommandReadScope(guardedExecute) : guardedExecute;
    const result = await withCommandTiming(timer, invoke).finally(abandonRemoteBranchObservations);
    timer.stage('execute');
    // The handler has printed its result; what follows is bookkeeping the person does not wait on
    // to read it, though the host still waits for the process. Each part is its own timed stage.
    timer.feedback();
    // A private refresh cannot turn a successful publication into a replayable failure.
    if (!LOCAL_STATE_RESET_COMMANDS.has(definition.name) && definition.name !== 'hook' && root
        && await hasMutationContracts()) {
      await import('./copilot-mutation-guard.mjs').then(module => module.refreshMutationContracts(root, null, {
        decisionEnded: ['approve', 'reject'].includes(definition.name)
          || definition.name === 'review-source' && positionals[1] === 'decide',
        advanceBaseline: operation.classification === 'mutation'
      })).catch(() => {});
      timer.stage('contract-refresh');
    }
    /**
     * Private return memory is downstream of authority, never inside its transaction.
     *
     * The handler has returned, so its governed mutation is already authoritative. Capture is a
     * best-effort machine-local observation: a full disk, corrupt preference file, or unavailable
     * workspace registration cannot turn a successful publish into a failed command, and retrying
     * journal capture can never replay the governed operation.
     */
    if (operation.classification === 'mutation' && !smartInitDryRun) {
      await import('./local-work-journal.mjs').then(({ captureCommandOutcome }) => captureCommandOutcome({
        root,
        operationId: operation.id,
        positionals: [definition.name, ...positionals.slice(1)],
        options,
        result,
        startedAt
      })).catch((error) => {
        if (process.env.SINGULARITY_FLOW_DEBUG_JOURNAL === '1') {
          console.warn(`Local journal capture was skipped: ${error.message}`);
        }
      });
      timer.stage('journal');
    }
    // A long history gets Git's changed-path index once, in the background; see history-index.mjs.
    if (operation.classification === 'mutation' && root && !smartInitDryRun
        && !LOCAL_STATE_RESET_COMMANDS.has(definition.name)) {
      await import('./history-index.mjs').then(({ refreshHistoryIndex }) => refreshHistoryIndex(root)).catch(() => {});
      timer.stage('history-index');
      // The Story index learns this checkout's phase and status (story-index.mjs).
      await import('./story-index.mjs').then(({ recordStoryCheckout }) => recordStoryCheckout(root)).catch(() => {});
      timer.stage('story-index');
    }
    // Even legacy handlers that print directly instead of using the narration boundary have now
    // produced their terminal result. Record that as feedback before sealing the timing event so
    // success/refusal/error records never leave first-feedback unknowable merely because they used
    // an older renderer.
    timer.feedback();
    const event = timer.finish({ outcome: 'success' });
    if (!LOCAL_STATE_RESET_COMMANDS.has(definition.name) && !smartInitDryRun) await recordCommandTiming(root, event,
      timer.trace?.finish({ firstFeedbackMs: event.firstFeedbackMs, counters: event.counters, outcome: event.outcome, operationId: event.operationId, commandClass: event.commandClass }));
    if (options.timings === true) writeCommandTimings(event);
    return result;
  } catch (error) {
    if (root && (['approve', 'reject'].includes(definition.name)
        || definition.name === 'review-source' && positionals[1] === 'decide')) {
      await import('./copilot-mutation-guard.mjs').then(module => module.endMutationDecisionTurns(root)).catch(() => {});
    } else if (root && (definition.name === 'decision' ? positionals[1] !== 'show' : definition.name === 'decisions' && positionals[1] === 'record')) {
      await import('./copilot-mutation-guard.mjs').then(module => module.endMutationDecisionTurns(root, { modes: ['decision-only'] })).catch(() => {});
    }
    timer.stage('execute');
    timer.feedback();
    const terminal = commandFailureTiming(error);
    const event = timer.finish({
      ...terminal,
      errorClass: error?.name ?? 'Error'
    });
    if (!LOCAL_STATE_RESET_COMMANDS.has(definition.name) && !smartInitDryRun) await recordCommandTiming(root, event,
      timer.trace?.finish({ firstFeedbackMs: event.firstFeedbackMs, counters: event.counters, outcome: event.outcome, operationId: event.operationId, commandClass: event.commandClass }));
    if (options.timings === true) writeCommandTimings(event);
    throw error;
  }
}

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { commandDefinition, operationById, resolveOperation } from './command-registry.mjs';
import {
  commandTimer, recordCommandTiming, withCommandTiming, writeCommandTimings
} from './dx-command-timing.mjs';
import { repoRoot } from './git.mjs';
import { optionBoolean, parseArgs, run, SingularityFlowError } from './util.mjs';
import { VERSION } from './version.mjs';
import { versionLine } from './build-info.mjs';
import { resolveModelMode, stripGlobalModelOptions } from './model-mode.mjs';
import { withOperationContext } from './operation-context.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';

// These commands promise to remove machine-local Singularity state. Recording their own duration
// after they finish would immediately recreate `.git/singularity-flow/` and make that promise false.
const LOCAL_STATE_RESET_COMMANDS = new Set(['factory-reset', 'reset-all', 'local-reset', 'reinstall']);

// These commands deliberately replace or forget SFlow state and therefore own their stronger
// reset/machine-state barriers. Wrapping them in an ordinary repository mutation lease would make
// factory reset detect itself as an in-flight command, while wrapping local reset would recreate
// the private state it has just removed.
const REPOSITORY_MUTATION_LEASE_EXCLUSIONS = new Set([
  ...LOCAL_STATE_RESET_COMMANDS,
  'fresh-install'
]);

// These commands either operate on machine-local installation/workspace state, explain the product,
// or intentionally initialize the caller's current directory. Redirecting one of them into the
// selected workspace would be surprising at best and destructive at worst. Every other command is
// repository-scoped and may safely use the repository explicitly selected by `workspace use` when
// Copilot or another host starts the CLI outside a Git checkout.
export const ACTIVE_WORKSPACE_ROUTING_EXCLUSIONS = new Set([
  'about', 'help', 'guide', 'show', 'quickstart', 'home',
  'init', 'precheck', 'bootstrap', 'onboard', 'authority', 'cache',
  'factory-reset', 'reset-all', 'local-reset', 'fresh-install', 'reinstall',
  'workspace', 'session', 'repositories', 'plugin', 'goal', 'journal', 'push', 'local'
]);

/**
 * Capability-map operations that address an organisation lead by URL rather than a checkout.
 *
 * These are the first-install path: before a capability is mapped there cannot be a workspace,
 * because a workspace is assembled from mapped capabilities. Treating the whole `capability`
 * command as repository-independent would break `capability tree|show|of|add|set|remove`, which do
 * read the selected repository. The subcommand boundary preserves both behaviours.
 */
export const REPOSITORY_INDEPENDENT_CAPABILITY_SUBCOMMANDS = new Set([
  'map', 'map-team', 'edit', 'publish', 'proposals', 'proposal', 'activate', 'discard-proposal',
  'world-model', 'organisation', 'leads', 'inspect-repository', 'fsck', 'reconcile',
  'repository', 'repair-proposal', 'adopt-managed', 'onboard'
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

export function excludesActiveWorkspaceRouting(
  command, subcommand = null, options = {}, action = null
) {
  return ACTIVE_WORKSPACE_ROUTING_EXCLUSIONS.has(command)
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
    || (command === 'capability' && REPOSITORY_INDEPENDENT_CAPABILITY_SUBCOMMANDS.has(subcommand))
    || (command === 'revision' && subcommand === 'checks'
      && REPOSITORY_INDEPENDENT_REVISION_CHECK_ACTIONS.has(action))
    // Portable Process Evidence verification consumes only the named bundle bytes. It must work
    // in a fresh directory and must never be redirected to the last selected workspace.
    || (command === 'evidence' && subcommand === 'verify');
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

/** A production application branch may be configuration-free while these exact refs govern it. */
export function hasLocalGovernanceAuthority(root) {
  if (hasWorkingTreeGovernance(root)) return true;
  if (!root) return false;
  // The common application-branch case has an approved configuration/state ref locally. Ask that
  // bounded ref namespace first; walking the tracked index and then grepping every candidate
  // aggregate is fallback work for damaged/custom layouts, not the price of every invocation.
  const refs = run('git', [
    'for-each-ref', '--format=%(refname)',
    'refs/heads/sflow/config', 'refs/remotes/*/sflow/config',
    'refs/heads/state', 'refs/remotes/*/state'
  ], { cwd: root, allowFailure: true });
  if (refs.status === 0 && refs.stdout.split(/\r?\n/).some((entry) => entry.trim())) return true;

  // A lifecycle branch is self-contained after Story creation. Its immutable configuration
  // snapshot remains authoritative even when the shared configuration/state branches are
  // temporarily unavailable. Batch-check every local branch tip in one Git process.
  const lifecycleRefs = run('git', [
    'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'
  ], { cwd: root, allowFailure: true }).stdout
    .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (lifecycleRefs.length) {
    const checked = run('git', ['cat-file', '--batch-check'], {
      cwd: root, allowFailure: true,
      input: `${lifecycleRefs.map((ref) => `${ref}:singularity/workflow.yml`).join('\n')}\n`
    });
    if (checked.status === 0 && checked.stdout.split(/\r?\n/)
      .some((line) => /\sblob\s\d+$/.test(line.trim()))) return true;
  }
  // A checked-out lifecycle aggregate is itself an unambiguous repository claim. Recovery and
  // read-only review commands must stay with it even if its configuration snapshot is damaged or
  // absent; redirecting those commands to the machine's last selected workspace makes the Story
  // disappear precisely when it needs repair. Use Git's tracked-file index instead of accepting an
  // arbitrary untracked directory that merely happens to use a Singularity-looking name.
  const governedSubjects = run('git', [
    'ls-files', '--',
    'singularity/work-items/*/workflow.json',
    'singularity/initiatives/*/state.json'
  ], { cwd: root, allowFailure: true });
  if (governedSubjects.status === 0 && governedSubjects.stdout.trim()) return true;
  // workItemRoot and initiativeRoot are configurable. If the configuration snapshot itself is the
  // damaged file being recovered, the exact roots are no longer available to route the command.
  // Recognize tracked aggregate content in one bounded Git search instead of falling back to fixed
  // product-default directories or recursively searching the filesystem.
  const configuredSubjects = run('git', [
    'grep', '-l', '-E',
    '-e', '"workItem"[[:space:]]*:',
    '-e', '"initiative"[[:space:]]*:',
    '--', ':(glob)**/workflow.json', ':(glob)**/state.json'
  ], { cwd: root, allowFailure: true });
  if (configuredSubjects.status === 0 && configuredSubjects.stdout.trim()) return true;
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
  const remotes = run('git', ['remote'], { cwd: root, allowFailure: true }).stdout
    .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
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
  try {
    return repoRoot(selectedPath);
  } catch {
    throw new SingularityFlowError(
      `Active workspace '${context.workspaceName ?? context.workspaceId}' points to '${selectedPath}', which is not an available Git repository. Repair the workspace or run 'singularity-flow workspace use <WORKSPACE>'.`,
      {
        code: 'ACTIVE_WORKSPACE_REPOSITORY_UNAVAILABLE',
        details: { workspaceId: context.workspaceId, repositoryId: context.repositoryId, repositoryPath: selectedPath }
      }
    );
  }
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

/**
 * Supply the command registry with the small approved policy fragment needed to classify a
 * versioned World-model operation before its handler is loaded.
 *
 * `wm build` is historically model-required, while a registered-v4 build defaults to the
 * deterministic renderer. Looking only at argv therefore rejected `--no-model wm build` for a
 * repository whose approved configuration selected registered-v4. Read only the same governed
 * definition the handler will use; do not mutate argv or make the registry discover a repository.
 */
async function operationResolutionContext(root, definition, subcommand) {
  if (definition.name !== 'wm' || !['build', 'ensure'].includes(subcommand)
      || !root) return {};
  const { loadDefinition } = await import('./config.mjs');
  let approved;
  try {
    approved = await loadDefinition(root);
  } catch (error) {
    // An uninitialised Git checkout has no registered-v4 policy to override the legacy operation
    // classification. Preserve admission ordering there: `--no-model wm build` must be refused as
    // model-required before its handler is imported. Other configuration failures remain visible;
    // silently treating malformed governed policy as legacy would weaken a repository's contract.
    if (/^Missing singularity\/workflow\.yml\. Run: singularity-flow init$/.test(error?.message ?? '')) {
      return {};
    }
    throw error;
  }
  return {
    worldModel: {
      format: approved.worldModel?.format ?? 'legacy-v3',
      composer: approved.worldModel?.v4?.composer ?? 'deterministic'
    }
  };
}

export async function main(argv) {
  const modelMode = resolveModelMode(argv);
  const effectiveArgv = stripGlobalModelOptions(argv);
  // Product reinstall is intentionally not a repository operation. Resolving a root would invoke
  // Git before the command even reached its strict no-repository transaction boundary.
  const localOnlyRequest = effectiveArgv[0] === 'reinstall';
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
  const timingInput = {
    started: globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT ?? process.hrtime.bigint(),
    commandClass: 'unknown', operationId: null, mode: timingMode(options)
  };
  const timer = commandTimer(definition.name, timingInput);
  // Root discovery is part of the command. Bind the timing context before the first Git probe so
  // --timings and durable events no longer omit dispatch work performed ahead of module loading.
  root = localOnlyRequest ? null : withCommandTiming(timer, () => rootIfAvailable());
  const subcommand = positionals[1] ?? null;
  const action = positionals[2] ?? null;
  const routingExcluded = excludesActiveWorkspaceRouting(
    definition.name, subcommand, options, action
  );
  await withCommandTiming(timer, async () => {
    if (!routingExcluded && (!root || !hasLocalGovernanceAuthority(root))) {
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
  if (!root && !routingExcluded) {
    throw new SingularityFlowError(
      "Run Singularity Flow from inside a Git repository, or select one with 'singularity-flow workspace use <WORKSPACE>'.",
      { code: 'REPOSITORY_CONTEXT_REQUIRED' }
    );
  }
  const resolutionContext = await withCommandTiming(timer, () => operationResolutionContext(
    root, definition, subcommand
  ));
  const requestedOperation = resolveOperation({
    requestedCommand: requested,
    positionals: [definition.name, ...positionals.slice(1)],
    options,
    context: resolutionContext
  });
  const operation = requestedOperation.modelPolicy === 'optional' && !modelMode.enabled
    ? operationById(requestedOperation.fallback.operationId)
    : requestedOperation;
  if (operation.modelPolicy === 'required' && !modelMode.enabled) {
    const fallback = operation.fallback?.operationId
      ? ` Use the model-free fallback: singularity-flow ${operation.fallback.operationId.replace('.', ' ')}.`
      : '';
    throw new SingularityFlowError(`Operation '${operation.id}' requires a model and cannot run with --no-model.${fallback}`, {
      code: 'MODEL_UNAVAILABLE', details: { operationId: operation.id, fallback: operation.fallback ?? null }
    });
  }
  // The resolved operation, not the command. Some command nouns carry both read and mutating
  // subcommands; classification is known only after the now-measured dispatch probes complete.
  timingInput.commandClass = operation.classification;
  timingInput.operationId = operation.id;
  const smartInitDryRun = definition.name === 'init'
    && optionBoolean(options, 'smart-detect') && optionBoolean(options, 'dry-run');
  const durableTimingStart = process.env.SINGULARITY_FLOW_DX_DURABLE_START === '1'
    || process.env.CI === 'true';
  if (durableTimingStart && !LOCAL_STATE_RESET_COMMANDS.has(definition.name) && !smartInitDryRun) {
    await recordCommandTiming(root, timer.startEvent());
  }
  timer.stage('root-dispatch');
  try {
    const module = await withCommandTiming(timer, () => import(definition.modulePath));
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
    const execute = () => withOperationContext({
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
      operation, requestedOperation, modelMode
    }));
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
    const result = await withCommandTiming(timer, guardedExecute);
    timer.stage('execute');
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
    }
    // Even legacy handlers that print directly instead of using the narration boundary have now
    // produced their terminal result. Record that as feedback before sealing the timing event so
    // success/refusal/error records never leave first-feedback unknowable merely because they used
    // an older renderer.
    timer.feedback();
    const event = timer.finish({ outcome: 'success' });
    if (!LOCAL_STATE_RESET_COMMANDS.has(definition.name) && !smartInitDryRun) await recordCommandTiming(root, event);
    if (options.timings === true) writeCommandTimings(event);
    return result;
  } catch (error) {
    timer.stage('execute');
    timer.feedback();
    const terminal = commandFailureTiming(error);
    const event = timer.finish({
      ...terminal,
      errorClass: error?.name ?? 'Error'
    });
    if (!LOCAL_STATE_RESET_COMMANDS.has(definition.name) && !smartInitDryRun) await recordCommandTiming(root, event);
    if (options.timings === true) writeCommandTimings(event);
    throw error;
  }
}

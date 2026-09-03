import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { commandDefinition, operationById, resolveOperation } from './command-registry.mjs';
import {
  commandTimer, recordCommandTiming, withCommandTiming, writeCommandTimings
} from './dx-command-timing.mjs';
import { repoRoot } from './git.mjs';
import { parseArgs, run, SingularityFlowError } from './util.mjs';
import { VERSION } from './version.mjs';
import { versionLine } from './build-info.mjs';
import { resolveModelMode, stripGlobalModelOptions } from './model-mode.mjs';
import { withOperationContext } from './operation-context.mjs';
import { runRemoteGit } from './git-execution.mjs';

// These commands promise to remove machine-local Singularity state. Recording their own duration
// after they finish would immediately recreate `.git/singularity-flow/` and make that promise false.
const LOCAL_STATE_RESET_COMMANDS = new Set(['factory-reset', 'reset-all', 'local-reset', 'reinstall']);

// These commands either operate on machine-local installation/workspace state, explain the product,
// or intentionally initialize the caller's current directory. Redirecting one of them into the
// selected workspace would be surprising at best and destructive at worst. Every other command is
// repository-scoped and may safely use the repository explicitly selected by `workspace use` when
// Copilot or another host starts the CLI outside a Git checkout.
export const ACTIVE_WORKSPACE_ROUTING_EXCLUSIONS = new Set([
  'about', 'help', 'explain', 'guide', 'show', 'quickstart', 'home',
  'init', 'bootstrap',
  'factory-reset', 'reset-all', 'local-reset', 'fresh-install', 'reinstall',
  'workspace', 'session', 'plugin', 'goal', 'journal', 'push'
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
  'map', 'edit', 'publish', 'proposals', 'proposal', 'activate',
  'world-model', 'organisation', 'leads', 'inspect-repository'
]);

export function excludesActiveWorkspaceRouting(command, subcommand = null, options = {}) {
  return ACTIVE_WORKSPACE_ROUTING_EXCLUSIONS.has(command)
    // `doctor --performance` measures the Git checkout a person invoked it from, including a fresh
    // checkout with no workflow yet. Ordinary doctor remains repository-scoped and follows the
    // selected workspace when Copilot starts it outside a checkout.
    || (command === 'doctor' && options.performance === true)
    || (command === 'capability' && REPOSITORY_INDEPENDENT_CAPABILITY_SUBCOMMANDS.has(subcommand))
    // Portable Process Evidence verification consumes only the named bundle bytes. It must work
    // in a fresh directory and must never be redirected to the last selected workspace.
    || (command === 'evidence' && subcommand === 'verify');
}

function rootIfAvailable(cwd = process.cwd()) {
  try { return repoRoot(cwd); } catch { return null; }
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
  const refs = run('git', [
    'for-each-ref', '--format=%(refname)',
    'refs/heads/sflow/config', 'refs/remotes/*/sflow/config',
    'refs/heads/state', 'refs/remotes/*/state'
  ], { cwd: root, allowFailure: true });
  if (refs.status === 0 && refs.stdout.split(/\r?\n/).some((entry) => entry.trim())) return true;

  // A lifecycle branch is self-contained after Story creation. Its immutable configuration
  // snapshot remains authoritative even when the shared configuration/state branches are
  // temporarily unavailable. Batch-check every local branch tip in one Git process so an active
  // workspace elsewhere on the laptop cannot redirect `resume` away from the repository that
  // actually carries the requested Story.
  const lifecycleRefs = run('git', [
    'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'
  ], { cwd: root, allowFailure: true }).stdout
    .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (!lifecycleRefs.length) return false;
  const checked = run('git', ['cat-file', '--batch-check'], {
    cwd: root, allowFailure: true,
    input: `${lifecycleRefs.map((ref) => `${ref}:singularity/workflow.yml`).join('\n')}\n`
  });
  return checked.status === 0 && checked.stdout.split(/\r?\n/)
    .some((line) => /\sblob\s\d+$/.test(line.trim()));
}

/**
 * Resolve the last ambiguous case without treating every Git remote as SFlow authority.
 *
 * Fresh production clones may intentionally fetch only `main`, so the configuration refs are not
 * local yet. Probe only the two exact governance branches, and only when a different active
 * workspace would otherwise replace the caller's current Git root.
 */
export function hasRemoteGovernanceAuthority(root) {
  if (!root) return false;
  const remotes = run('git', ['remote'], { cwd: root, allowFailure: true }).stdout
    .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  return remotes.some((remote) => {
    const advertised = runRemoteGit([
      'ls-remote', '--heads', '--', remote,
      'refs/heads/sflow/config', 'refs/heads/state'
    ], { cwd: root, operation: 'remote-probe' });
    return advertised.status === 0 && advertised.stdout.split(/\r?\n/).some((entry) => entry.trim());
  });
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
  options = {}
} = {}) {
  if (excludesActiveWorkspaceRouting(command, subcommand, options)) return null;
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
  let root = localOnlyRequest ? null : rootIfAvailable();
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
    const { renderCommandHelp } = await import('./help-pages.mjs');
    return withOperationContext({
      operation: { id: 'help.command', modelPolicy: 'never', classification: 'read', output: 'human' },
      modelMode, root, argvSha256, argvHash: `sha256:${argvSha256}`, command: 'help', startedAt: new Date().toISOString()
    }, () => console.log(renderCommandHelp(definition.name)));
  }
  const subcommand = positionals[1] ?? null;
  const routingExcluded = excludesActiveWorkspaceRouting(definition.name, subcommand, options);
  if (!routingExcluded && (!root || !hasLocalGovernanceAuthority(root))) {
    const selectedRoot = await activeWorkspaceRepositoryRoot(definition.name, { subcommand, options });
    const selectedDiffers = selectedRoot && (!root || path.resolve(selectedRoot) !== path.resolve(root));
    const currentClaimsAuthority = selectedDiffers && root ? hasRemoteGovernanceAuthority(root) : false;
    if (selectedRoot && !currentClaimsAuthority) {
      // All existing repository services resolve relative paths from process.cwd(). Moving this
      // short-lived CLI process is the compatibility bridge that makes the selected workspace
      // authoritative without teaching dozens of commands about machine-local workspace state.
      process.chdir(selectedRoot);
      root = selectedRoot;
    }
  }
  if (!root && !routingExcluded) {
    throw new SingularityFlowError(
      "Run Singularity Flow from inside a Git repository, or select one with 'singularity-flow workspace use <WORKSPACE>'.",
      { code: 'REPOSITORY_CONTEXT_REQUIRED' }
    );
  }
  const resolutionContext = await operationResolutionContext(
    root, definition, subcommand
  );
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
  const timer = commandTimer(definition.name, {
    started: globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT ?? process.hrtime.bigint(),
    // The resolved operation, not the command. `report`, `telemetry`, `review`, `inputs`, `spec` and
    // `visual` each carry both read and mutating subcommands, so the command-level value calls every
    // one of them a mutation and mis-partitions the DX timing dataset. The VS Code adapter already
    // classifies per subcommand; this keeps the two surfaces telling the same story.
    commandClass: operation.classification,
    operationId: operation.id
  });
  timer.stage('root-dispatch');
  try {
    const module = await import(definition.modulePath);
    /**
     * A module that defers the rest of its own graph reports that cost here, not inside `execute`.
     *
     * `commands/legacy.mjs` is a four-line shim in front of `cli.mjs`, so importing the shim
     * measures nothing and the 110 ms it fronts landed in `execute` alongside the command's real
     * work. Optional, because command modules with no deferred graph have nothing to declare.
     */
    await module.load?.({
      argv: effectiveArgv,
      positionals: [definition.name, ...positionals.slice(1)],
      options,
      definition,
      operation,
      requestedOperation,
      modelMode
    });
    timer.stage('module-load');
    const startedAt = new Date().toISOString();
    const result = await withCommandTiming(timer, () => withOperationContext({
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
    })));
    timer.stage('execute');
    /**
     * Private return memory is downstream of authority, never inside its transaction.
     *
     * The handler has returned, so its governed mutation is already authoritative. Capture is a
     * best-effort machine-local observation: a full disk, corrupt preference file, or unavailable
     * workspace registration cannot turn a successful publish into a failed command, and retrying
     * journal capture can never replay the governed operation.
     */
    if (operation.classification === 'mutation') {
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
    const event = timer.finish({ outcome: 'success' });
    if (!LOCAL_STATE_RESET_COMMANDS.has(definition.name)) await recordCommandTiming(root, event);
    if (options.timings === true) writeCommandTimings(event);
    return result;
  } catch (error) {
    timer.stage('execute');
    const event = timer.finish({ outcome: 'error', errorClass: error?.name ?? 'Error' });
    if (!LOCAL_STATE_RESET_COMMANDS.has(definition.name)) await recordCommandTiming(root, event);
    if (options.timings === true) writeCommandTimings(event);
    throw error;
  }
}

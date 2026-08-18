import { createHash } from 'node:crypto';
import { commandDefinition, operationById, resolveOperation } from './command-registry.mjs';
import { commandTimer, recordCommandTiming, writeCommandTimings } from './dx-command-timing.mjs';
import { repoRoot } from './git.mjs';
import { parseArgs, SingularityFlowError } from './util.mjs';
import { VERSION } from './version.mjs';
import { versionLine } from './build-info.mjs';
import { resolveModelMode, stripGlobalModelOptions } from './model-mode.mjs';
import { withOperationContext } from './operation-context.mjs';

// These commands promise to remove machine-local Singularity state. Recording their own duration
// after they finish would immediately recreate `.git/singularity-flow/` and make that promise false.
const LOCAL_STATE_RESET_COMMANDS = new Set(['factory-reset', 'reset-all', 'local-reset', 'reinstall']);

// These commands either operate on machine-local installation/workspace state, explain the product,
// or intentionally initialize the caller's current directory. Redirecting one of them into the
// selected workspace would be surprising at best and destructive at worst. Every other command is
// repository-scoped and may safely use the repository explicitly selected by `workspace use` when
// Copilot or another host starts the CLI outside a Git checkout.
export const ACTIVE_WORKSPACE_ROUTING_EXCLUSIONS = new Set([
  'about', 'help', 'explain', 'guide', 'show', 'quickstart',
  'init', 'bootstrap',
  'factory-reset', 'reset-all', 'local-reset', 'fresh-install', 'reinstall',
  'workspace', 'session', 'plugin'
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
  'world-model', 'organisation', 'leads'
]);

export function excludesActiveWorkspaceRouting(command, subcommand = null) {
  return ACTIVE_WORKSPACE_ROUTING_EXCLUSIONS.has(command)
    || (command === 'capability' && REPOSITORY_INDEPENDENT_CAPABILITY_SUBCOMMANDS.has(subcommand));
}

function rootIfAvailable(cwd = process.cwd()) {
  try { return repoRoot(cwd); } catch { return null; }
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
  subcommand = null
} = {}) {
  if (excludesActiveWorkspaceRouting(command, subcommand)) return null;
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
  if (!root) {
    const subcommand = positionals[1] ?? null;
    const routingExcluded = excludesActiveWorkspaceRouting(definition.name, subcommand);
    const selectedRoot = await activeWorkspaceRepositoryRoot(definition.name, { subcommand });
    if (selectedRoot) {
      // All existing repository services resolve relative paths from process.cwd(). Moving this
      // short-lived CLI process is the compatibility bridge that makes the selected workspace
      // authoritative without teaching dozens of commands about machine-local workspace state.
      process.chdir(selectedRoot);
      root = selectedRoot;
    } else if (!routingExcluded) {
      throw new SingularityFlowError(
        "Run Singularity Flow from inside a Git repository, or select one with 'singularity-flow workspace use <WORKSPACE>'.",
        { code: 'REPOSITORY_CONTEXT_REQUIRED' }
      );
    }
  }
  const requestedOperation = resolveOperation({ requestedCommand: requested, positionals: [definition.name, ...positionals.slice(1)], options });
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
    commandClass: operation.classification
  });
  timer.stage('root-dispatch');
  try {
    const module = await import(definition.modulePath);
    timer.stage('module-load');
    const result = await withOperationContext({
      operation,
      modelMode,
      root,
      argvSha256,
      argvHash: `sha256:${argvSha256}`,
      fallbackFrom: operation.id === requestedOperation.id ? null : requestedOperation.id,
      command: definition.name,
      startedAt: new Date().toISOString()
    }, () => module.run(effectiveArgv, { positionals: [definition.name, ...positionals.slice(1)], options, definition, operation, requestedOperation, modelMode }));
    timer.stage('execute');
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

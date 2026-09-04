/**
 * Which CLI to run, and the small set of commands the extension actually needs.
 *
 * Resolution order is explicit setting → the CLI shipped beside this extension → `singularity-flow`
 * on PATH. The middle case matters most: an extension bundled with its own engine must not silently
 * drive a different version that happens to be installed globally, because the two can disagree
 * about a resolution's meaning. Whichever is chosen is reported, so a mismatch is diagnosable
 * instead of mysterious.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  CAPABILITY_AUTHORITY_TIMEOUT_MS, CLI_TIMEOUT_MS, SNAPSHOT_TIMEOUT_MS, VALIDATION_TIMEOUT_MS,
  WORKSPACE_MUTATION_TIMEOUT_MS, WORK_START_TIMEOUT_MS, WORLD_MODEL_TIMEOUT_MS,
  invokeCli, type OutputStream
} from './runner.ts';
import type { RepositorySnapshot, SnapshotSlice } from './snapshot.ts';

export const CORE_SNAPSHOT_SLICES: readonly SnapshotSlice[] = Object.freeze([
  'repository', 'lifecycle', 'capabilities'
]);

interface SnapshotEnvelope {
  included?: SnapshotSlice[];
  notModified?: boolean;
  revision?: RepositorySnapshot['revision'];
  repository?: Record<string, unknown>;
  lifecycle?: Partial<RepositorySnapshot>;
  configuration?: Partial<RepositorySnapshot>;
  capabilities?: { path?: string; capabilities?: unknown[] | null; error?: string };
  integrations?: Partial<RepositorySnapshot>;
  diagnostics?: RepositorySnapshot['diagnostics'];
  sgos?: RepositorySnapshot['sgos'];
  worldModel?: RepositorySnapshot['worldModel'];
}

function snapshotArgs(slices: readonly SnapshotSlice[], ifRevision?: string | null): string[] {
  const args = ['snapshot'];
  for (const slice of slices) args.push('--include', slice);
  if (ifRevision) args.push('--if-revision', ifRevision);
  args.push('--json');
  return args;
}

/** Flatten public slice envelopes into the compatibility projection every existing view consumes. */
function flattenSnapshot(envelope: SnapshotEnvelope): RepositorySnapshot {
  const repository = { ...(envelope.repository ?? {}) };
  const identities = repository.identities as RepositorySnapshot['identities'] | undefined;
  delete repository.identities;
  const capability = envelope.capabilities;
  return {
    workItems: [], initiatives: [], selectedWorkId: null, selectedInitiativeId: null,
    initiative: null, workflow: null,
    ...(envelope.lifecycle ?? {}),
    ...(envelope.configuration ?? {}),
    ...(envelope.integrations ?? {}),
    ...(Object.keys(repository).length ? { repository } : {}),
    ...(identities ? { identities } : {}),
    ...(capability ? {
      capabilityMapPath: capability.path,
      capabilityMap: capability.capabilities == null && !capability.error
        ? null
        : { capabilities: capability.capabilities ?? [], ...(capability.error ? { error: capability.error } : {}) }
    } : {}),
    ...(envelope.diagnostics ? { diagnostics: envelope.diagnostics } : {}),
    ...(envelope.sgos ? { sgos: envelope.sgos } : {}),
    // A separately leased WMB v4 projection wins over the legacy compatibility value embedded in
    // Configuration. It is bounded and carries no complete Fact/Evidence catalogs.
    ...(envelope.worldModel ? { worldModel: envelope.worldModel } : {}),
    included: [...(envelope.included ?? [])],
    ...(envelope.notModified ? { notModified: true } : {}),
    ...(envelope.revision ? { revision: envelope.revision } : {})
  } as RepositorySnapshot;
}

const READ_ONLY_COMMANDS = new Set([
  'about', 'help', 'show', 'choices', 'inbox', 'home', 'recommend', 'status', 'progress',
  'guide', 'logs', 'doctor', 'nextsteps', 'snapshot', 'validate', 'precheck', 'change', 'proof'
]);
const READ_ONLY_CONFIGURATION_COMMANDS = new Set([
  'snapshot', 'validate', 'read', 'export-bundle', 'initiative-materialize-preview', 'explain'
]);
const REMOTE_CAPABILITY_OPERATIONS = new Set([
  'map', 'edit', 'publish', 'proposals', 'proposal', 'activate', 'world-model', 'organisation',
  'fsck', 'discard-proposal'
]);

function hasOption(args: string[], name: string): boolean {
  const option = `--${name}`;
  return args.some((argument) => argument === option || argument.startsWith(`${option}=`));
}

function enabledBooleanOption(args: string[], name: string): boolean {
  const option = `--${name}`;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === `--no-${name}`) return false;
    if (argument === option) return true;
    if (!argument.startsWith(`${option}=`)) continue;
    const value = argument.slice(option.length + 1).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(value);
  }
  return false;
}

export function commandClass(args: string[]): 'read' | 'mutation' | 'unknown' {
  if (!args[0]) return 'unknown';
  if (args[0] === 'init' && enabledBooleanOption(args, 'smart-detect')
      && enabledBooleanOption(args, 'dry-run') && !hasOption(args, 'output')) return 'read';
  // Configuration inventory and previews are read-only. Every other configuration subcommand is
  // conservative-by-default because it either writes a governed file, changes the local session,
  // promotes planning output, materializes Jira/Git state, or commits and pushes. The previous
  // inverse test classified all new subcommands as reads until somebody remembered this adapter.
  if (args[0] === 'configuration') {
    return READ_ONLY_CONFIGURATION_COMMANDS.has(args[1] ?? '') ? 'read' : 'mutation';
  }
  if (args[0] === 'return') return enabledBooleanOption(args, 'apply') ? 'mutation' : 'read';
  if (args[0] === 'recover') return enabledBooleanOption(args, 'apply') ? 'mutation' : 'read';
  if (args[0] === 'story' && args[1] === 'return') return 'read';
  if (args[0] === 'report' || args[0] === 'review') return hasOption(args, 'out') ? 'mutation' : 'read';
  if (args[0] === 'telemetry') return (args[1] ?? 'status') === 'status' ? 'read' : 'mutation';
  if (args[0] === 'help-metrics') return (args[1] ?? 'status') === 'status' ? 'read' : 'mutation';
  if (args[0] === 'inputs') return enabledBooleanOption(args, 'dry-run') ? 'read' : 'mutation';
  if (args[0] === 'spec') {
    const action = args[1] ?? 'trace';
    if (action === 'coverage' || action === 'trace') return 'read';
    if ((action === 'index' || action === 'acceptance') && enabledBooleanOption(args, 'dry-run')) return 'read';
    return 'mutation';
  }
  if (args[0] === 'visual') return (args[1] ?? 'status') === 'status' ? 'read' : 'mutation';
  if (args[0] === 'capabilities' && args[1] === 'doctor') return 'read';
  if (args[0] === 'capability') {
    return ['tree', 'show', 'of', 'proposals', 'proposal', 'fsck', 'world-model', 'organisation', 'leads']
      .includes(args[1] ?? 'tree') ? 'read' : 'mutation';
  }
  if (args[0] === 'session') {
    return ['current', 'doctor', 'context', 'candidates', 'status'].includes(args[1] ?? 'status')
      ? 'read'
      : 'mutation';
  }
  if (args[0] === 'workspace' && ['current', 'list', 'status', 'doctor', 'branches'].includes(args[1] ?? 'list')) return 'read';
  if (args[0] === 'workspace' && args[1] === 'refresh-configuration' && hasOption(args, 'dry-run')) return 'read';
  if (args[0] === 'workspace' && ['attach-capability', 'detach-capability'].includes(args[1] ?? '')
      && hasOption(args, 'dry-run')) return 'read';
  if (args[0] === 'goal') return ['list', 'show', 'status', 'next'].includes(args[1] ?? 'list') ? 'read' : 'mutation';
  if (args[0] === 'fault') return (args[1] ?? 'list') === 'report' ? 'mutation' : 'read';
  if (args[0] === 'fix') return hasOption(args, 'plan-only') ? 'read' : 'mutation';
  if (args[0] === 'repair') return ['list', 'show', 'status', 'history'].includes(args[1] ?? 'list') ? 'read' : 'mutation';
  if (args[0] === 'journal') {
    const action = args[1] ?? 'today';
    if (['today', 'doctor'].includes(action)) return 'read';
    if (action === 'settings' && args.length <= 3) return 'read';
    if (action === 'export' && hasOption(args, 'dry-run')) return 'read';
    return 'mutation';
  }
  if (args[0] === 'local-reset') return hasOption(args, 'dry-run') ? 'read' : 'mutation';
  if (args[0] === 'wm' && args[1] === 'ast') {
    const action = args[2] ?? 'status';
    if (['doctor', 'status', 'context', 'query', 'gate'].includes(action)) return 'read';
    if (action === 'cache') return (args[3] ?? 'status') === 'status' ? 'read' : 'mutation';
    if (action === 'preference') return (args[3] ?? 'show') === 'show' ? 'read' : 'mutation';
    return 'mutation';
  }
  if (args[0] === 'intent') {
    return ['show', 'validate', 'workflow-guide'].includes(args[1] ?? 'show')
      ? 'read' : 'mutation';
  }
  if (args[0] === 'program') return ['show', 'validate', 'simulate', 'explain'].includes(args[1] ?? 'show') ? 'read' : 'mutation';
  if (args[0] === 'process') {
    const action = args[1] ?? 'list';
    if (['list', 'status', 'graph', 'fsck'].includes(action)) return 'read';
    if (action === 'recover' && !hasOption(args, 'resolution')) return 'read';
    return 'mutation';
  }
  if (args[0] === 'task') return ['list', 'show', 'evidence'].includes(args[1] ?? 'list') ? 'read' : 'mutation';
  if (args[0] === 'request') return ['list', 'show'].includes(args[1] ?? 'list') ? 'read' : 'mutation';
  if (args[0] === 'candidate') {
    const action = args[1] ?? 'list';
    if (['list', 'show', 'diff-argv'].includes(action)) return 'read';
    return 'mutation';
  }
  if (args[0] === 'execution-unit') return 'read';
  if (args[0] === 'device') {
    const action = args[1] ?? 'list';
    if (['list', 'doctor', 'intent', 'result'].includes(action)) return 'read';
    if (action === 'revoke' && !hasOption(args, 'confirm')) return 'read';
    return 'mutation';
  }
  if (args[0] === 'authority-store') {
    const action = args[1] ?? 'status';
    if (['status', 'verify', 'inspect', 'trust-scaffold'].includes(action)) return 'read';
    if (action === 'recover' && !hasOption(args, 'confirm')) return 'read';
    if (['import', 'rollback', 'publish', 'sync'].includes(action) && !hasOption(args, 'confirm')) return 'read';
    return 'mutation';
  }
  if (args[0] === 'learn') return 'read';
  if (args[0] === 'pack') return ['list', 'active', 'show'].includes(args[1] ?? 'list') ? 'read' : 'mutation';
  if (args[0] === 'memory') return ['inspect', 'dependencies'].includes(args[1] ?? 'inspect') ? 'read' : 'mutation';
  if (args[0] === 'meta-tool') return (args[1] ?? 'list') === 'list' ? 'read' : 'mutation';
  return READ_ONLY_COMMANDS.has(args[0]) ? 'read' : 'mutation';
}

export interface CliLocation {
  /** The Node executable used to run the CLI. */
  executable: string;
  /** Absolute path to bin/singularity-flow.mjs. */
  cli: string;
  source: 'setting' | 'bundled' | 'path';
}

export interface ResolveOptions {
  /** `singularityFlow.cliPath`, when the user has set one. */
  configuredCli?: string;
  /** `singularityFlow.nodePath`, when the user has set one. */
  configuredNode?: string;
  /** Directory the extension is installed in, used to find the CLI shipped beside it. */
  extensionPath?: string;
  /** Injected for tests; defaults to the real filesystem. */
  exists?: (candidate: string) => boolean;
}

/**
 * @throws when no CLI can be found, naming both places that were looked at — a "command not found"
 *   with no indication of what was searched is the least actionable error a tool can produce.
 */
export function resolveCli(options: ResolveOptions = {}): CliLocation {
  const { configuredCli, configuredNode, extensionPath, exists = existsSync } = options;
  const executable = configuredNode?.trim() || process.execPath;

  if (configuredCli?.trim()) {
    const cli = path.resolve(configuredCli.trim());
    if (!exists(cli)) throw new Error(`singularityFlow.cliPath points at a file that does not exist: ${cli}`);
    return { executable, cli, source: 'setting' };
  }

  if (extensionPath) {
    // Both the packaged layout (cli/ beside the bundle) and the in-repo layout (apps/vscode/../..).
    const candidates = [
      path.join(extensionPath, 'cli', 'bin', 'singularity-flow.mjs'),
      path.join(extensionPath, '..', '..', 'bin', 'singularity-flow.mjs')
    ];
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      if (exists(resolved)) return { executable, cli: resolved, source: 'bundled' };
    }
  }

  const onPath = process.env.SINGULARITY_FLOW_CLI;
  if (onPath && exists(onPath)) return { executable, cli: path.resolve(onPath), source: 'path' };

  throw new Error(
    'No Singularity Flow CLI was found. Set singularityFlow.cliPath to bin/singularity-flow.mjs, '
    + 'or install the CLI and set SINGULARITY_FLOW_CLI.'
  );
}

export interface ClientOptions {
  location: CliLocation;
  repository: string;
  /** Secrets are supplied by VS Code SecretStorage and exist only in the child process. */
  environment?: NodeJS.ProcessEnv;
  onOutput?: (text: string, stream: OutputStream) => void;
}

/**
 * A thin, typed surface over the commands this extension issues.
 *
 * Only commands the extension actually uses appear here. A generic `run(args)` escape exists for the
 * governed actions the tree offers, because enumerating all ~40 of them would be a second command
 * registry that drifts from the real one in src/command-registry.mjs.
 */
export class SingularityFlowClient {
  private readonly options: ClientOptions;
  constructor(options: ClientOptions) { this.options = options; }

  get repository(): string { return this.options.repository; }
  get location(): CliLocation { return this.options.location; }

  /**
   * Point every later command at a different repository.
   *
   * Choosing a workspace changes which repository the window acts on, and it used to be answered by
   * reloading the window — which is a heavy, disorienting way to change one string, and impossible
   * while somebody is mid-edit. The commands already carry no state between calls, so re-pointing
   * is genuinely just this: the next spawn runs somewhere else.
   *
   * Callers must refresh whatever they have already read. This does not invalidate anything on its
   * own, because it cannot know what a caller is holding.
   */
  useRepository(repository: string): void {
    this.options.repository = repository;
  }

  private invoke<T>(args: string[], timeoutMs: number, signal?: AbortSignal, json = true,
    input: string | null = null): Promise<T> {
    // JSON stdout is the read model, not progress. Streaming it into VS Code's Output channel made
    // every structured payload exist three times (runner buffer, Output channel, parsed object) and
    // could flood the UI with megabytes of implementation detail. Human progress and diagnostics
    // are emitted on stderr; prose commands deliberately retain their stdout stream.
    const visibleOutput = json
      ? (text: string, stream: OutputStream): void => {
          if (stream === 'stderr') this.options.onOutput?.(text, stream);
        }
      : this.options.onOutput;
    return invokeCli<T>({
      executable: this.options.location.executable,
      cli: this.options.location.cli,
      repository: this.options.repository,
      args,
      json,
      input,
      env: this.options.environment,
      timeoutMs,
      commandClass: commandClass(args),
      onOutput: visibleOutput,
      onTiming: (event) => {
        try {
          this.options.onOutput?.(
            `[Singularity Flow timing] ${JSON.stringify(event)}\n`,
            'stderr'
          );
        } catch { /* timing diagnostics must never fail a command */ }
      },
      signal
    });
  }

  /** A coherent, bounded read model. Heavy domains are added only when their surface opens. */
  async snapshot(signal?: AbortSignal, slices: readonly SnapshotSlice[] = CORE_SNAPSHOT_SLICES,
    ifRevision: string | null = null): Promise<RepositorySnapshot> {
    const envelope = await this.invoke<SnapshotEnvelope>(snapshotArgs(slices, ifRevision), SNAPSHOT_TIMEOUT_MS, signal);
    return flattenSnapshot(envelope);
  }

  /**
   * Lightweight exact repository revision used to distinguish our delayed watcher echo from a
   * later external write. This requests only the core repository slice; it never fans out the
   * lifecycle/configuration readers and never publishes a WorkspaceStore event.
   */
  async revisionProbe(signal?: AbortSignal): Promise<RepositorySnapshot['revision'] | null> {
    return (await this.snapshot(signal, ['repository'], null)).revision ?? null;
  }

  /**
   * Read editable configuration even when its lifecycle schema is obsolete or invalid.
   * The engine returns inventory, never an operational lifecycle snapshot, so this cannot
   * accidentally make invalid configuration runnable.
   */
  async configurationSnapshot(signal?: AbortSignal): Promise<RepositorySnapshot> {
    const envelope = await this.invoke<SnapshotEnvelope>(
      ['snapshot', '--include', 'configuration', '--json'], SNAPSHOT_TIMEOUT_MS, signal);
    return flattenSnapshot(envelope);
  }

  /** Computed impact, reconciled against the published map. */
  impact(initiativeId?: string, signal?: AbortSignal): Promise<unknown> {
    const args = ['epic', 'impact', '--json'];
    if (initiativeId) args.push('--epic', initiativeId);
    return this.invoke(args, CLI_TIMEOUT_MS, signal);
  }

  /** Everything else, for the governed actions the tree offers. */
  run<T = unknown>(args: string[], signal?: AbortSignal): Promise<T> {
    return this.invoke<T>(args, this.timeoutFor(args), signal);
  }

  /**
   * For commands that print prose rather than JSON — `--markdown`, reports, `gate --terminal`.
   *
   * `input` is what the command reads from stdin; `desktop save` takes the replacement file that
   * way, so writing governed configuration goes through the engine's validation like everything
   * else rather than the editor writing the file itself.
   */
  async runText(args: string[], options: { signal?: AbortSignal; input?: string } = {}): Promise<string> {
    const result = await this.invoke<{ output: string }>(
      args, this.timeoutFor(args), options.signal, false, options.input ?? null);
    return result.output;
  }

  private timeoutFor(args: string[]): number {
    if (args[0] === 'submit') return VALIDATION_TIMEOUT_MS;
    if (args[0] === 'repair' && args[1] === 'attempt') return VALIDATION_TIMEOUT_MS;
    if (args[0] === 'start'
        || (['story', 'epic', 'initiative'].includes(args[0] ?? '') && args[1] === 'start')
        || (args[0] === 'workspace' && args[1] === 'branches' && hasOption(args, 'preflight-story'))) {
      return WORK_START_TIMEOUT_MS;
    }
    // Validated workspace deletion can move large monorepo checkouts into rollback staging before
    // it commits the reset. The ordinary two-minute UI timeout must not kill that transaction in
    // the middle; the CLI still owns rollback and the panel remains non-shelling.
    if (args[0] === 'local-reset') return CAPABILITY_AUTHORITY_TIMEOUT_MS;
    if (args[0] === 'capability' && REMOTE_CAPABILITY_OPERATIONS.has(args[1] ?? '')) {
      return CAPABILITY_AUTHORITY_TIMEOUT_MS;
    }
    // Workflow Designer proposals clone the approved configuration authority and publish an exact
    // review ref. Office Git proxies can make that bounded remote transaction slower than an
    // ordinary local CLI action, so it gets the same ceiling as capability authority changes. A
    // real timeout still carries the complete terminal recovery command from the shared runner.
    if ((args[0] === 'workflow' && hasOption(args, 'propose'))
        || (args[0] === 'configuration' && args[1] === 'save' && hasOption(args, 'propose'))) {
      return CAPABILITY_AUTHORITY_TIMEOUT_MS;
    }
    if (args[0] === 'workspace' && [
      'prepare', 'create', 'duplicate', 'update', 'repair', 'sync', 'archive',
      'refresh-configuration', 'attach-capability', 'detach-capability'
    ].includes(args[1] ?? '')) {
      return WORKSPACE_MUTATION_TIMEOUT_MS;
    }
    if (args[0] === 'workspace' && args[1] === 'bootstrap'
        && ['resume', 'retry'].includes(args[2] ?? '')) {
      return WORKSPACE_MUTATION_TIMEOUT_MS;
    }
    return (args[0] === 'wm' && args[1] === 'build')
      || (args[0] === 'workspace' && args[1] === 'impact' && args[2] === 'analyze')
      ? WORLD_MODEL_TIMEOUT_MS : CLI_TIMEOUT_MS;
  }
}

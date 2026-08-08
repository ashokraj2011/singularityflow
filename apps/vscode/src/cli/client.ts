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
  CLI_TIMEOUT_MS, SNAPSHOT_TIMEOUT_MS, WORLD_MODEL_TIMEOUT_MS,
  invokeCli, type OutputStream
} from './runner.ts';
import type { RepositorySnapshot } from './snapshot.ts';

const READ_ONLY_COMMANDS = new Set([
  'about', 'help', 'show', 'choices', 'inbox', 'status', 'progress', 'report', 'telemetry',
  'guide', 'logs', 'doctor', 'review', 'nextsteps', 'inputs', 'spec', 'visual', 'snapshot', 'validate'
]);

function commandClass(args: string[]): 'read' | 'mutation' | 'unknown' {
  if (!args[0]) return 'unknown';
  if (args[0] === 'configuration' && args[1] !== 'save') return 'read';
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
      onOutput: this.options.onOutput,
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

  /** The whole read model in one public, surface-neutral call. */
  snapshot(signal?: AbortSignal): Promise<RepositorySnapshot> {
    return this.invoke<RepositorySnapshot>(['snapshot', '--json'], SNAPSHOT_TIMEOUT_MS, signal);
  }

  /**
   * Read editable configuration even when its lifecycle schema is obsolete or invalid.
   * The engine returns inventory, never an operational lifecycle snapshot, so this cannot
   * accidentally make invalid configuration runnable.
   */
  async configurationSnapshot(signal?: AbortSignal): Promise<RepositorySnapshot> {
    const envelope = await this.invoke<{ configuration?: Partial<RepositorySnapshot> }>(
      ['snapshot', '--include', 'configuration', '--json'], SNAPSHOT_TIMEOUT_MS, signal);
    return {
      workItems: [], initiatives: [], selectedWorkId: null, selectedInitiativeId: null,
      initiative: null, workflow: null,
      ...(envelope.configuration ?? {})
    };
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
    return (args[0] === 'wm' && args[1] === 'build')
      || (args[0] === 'workspace' && args[1] === 'impact' && args[2] === 'analyze')
      ? WORLD_MODEL_TIMEOUT_MS : CLI_TIMEOUT_MS;
  }
}

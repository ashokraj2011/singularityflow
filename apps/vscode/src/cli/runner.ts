/**
 * Every read and every write goes through the CLI. The extension never imports `src/*.mjs`.
 *
 * That is a deliberate constraint rather than an accident of packaging. The engine's guarantee is
 * that state re-derives from Git; a second in-process caller with its own copy of the rules is
 * exactly how two surfaces start disagreeing about what an Epic's status is. The desktop app proved
 * the shape works — this is a port of apps/desktop/electron/cli-runner.mjs, with the parts that were
 * Electron-specific corrected rather than carried over.
 *
 * Deliberately kept dependency-free and free of any `vscode` import, so it can be unit-tested in a
 * plain Node process against a fake spawn.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

/** Lifecycle snapshots include branch cataloguing and deterministic governance checks. */
export const CLI_TIMEOUT_MS = 120_000;
export const SNAPSHOT_TIMEOUT_MS = 120_000;
/** `wm build` runs a model over a whole repository and legitimately takes minutes. */
export const WORLD_MODEL_TIMEOUT_MS = 15 * 60_000;
/** Remote capability authority may establish or review configuration on a very large monorepo. */
export const CAPABILITY_AUTHORITY_TIMEOUT_MS = 15 * 60_000;
/** Submission may run repository-native compile and browser suites; keep it above the seeded POC budget. */
export const VALIDATION_TIMEOUT_MS = 30 * 60_000;
/** Governed image/PDF previews may carry a 25 MiB document encoded as base64. */
const MAX_OUTPUT_BYTES = 40 * 1024 * 1024;

/*
 * Constructors assign their fields explicitly rather than using TypeScript parameter properties.
 * Parameter properties are the one common syntax that cannot be *stripped* — they emit assignments —
 * so avoiding them keeps every module here runnable under `node --experimental-strip-types`. That is
 * what lets the tests exercise this code directly, with no build step and no bundler in the loop.
 */
export class LegacyControlRootError extends Error {
  readonly code = 'SINGULARITY_FLOW_LEGACY_CONTROL_ROOT';
  readonly repository: string;
  readonly legacyRoot: string;
  constructor(repository: string, legacyRoot: string) {
    super(`This repository uses the former ${legacyRoot}/ control folder. Migrate it to the visible singularity/ folder before opening it.`);
    this.name = 'LegacyControlRootError';
    this.repository = repository;
    this.legacyRoot = legacyRoot;
  }
}

export class UninitializedRepositoryError extends Error {
  readonly code = 'SINGULARITY_FLOW_UNINITIALIZED_REPOSITORY';
  readonly repository: string;
  constructor(repository: string) {
    super("This folder is not initialized with Singularity Flow. Open the folder containing singularity/workflow.yml, or run 'singularity-flow init' there first.");
    this.name = 'UninitializedRepositoryError';
    this.repository = repository;
  }
}

/** A non-zero exit carrying the CLI's own message, so callers can show it verbatim. */
export class CliError extends Error {
  readonly code = 'SINGULARITY_FLOW_CLI_ERROR';
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Refuse anything that is not a real Git working tree with a real control directory.
 *
 * Every symbolic-link check here is load-bearing: the extension resolves artifact paths relative to
 * this root, and a symlinked control directory is how a path inside the workspace comes to point
 * outside it. Ported unchanged in intent from the desktop, which had the same exposure.
 */
export async function validateRepositoryDirectory(repository: string): Promise<string> {
  const resolved = path.resolve(repository || '');
  const canonical = await realpath(resolved).catch(() => null);
  const root = canonical ? await lstat(canonical).catch(() => null) : null;
  if (!canonical || !root?.isDirectory()) throw new Error('The selected folder does not exist or is not a directory.');

  const git = await lstat(path.join(canonical, '.git')).catch(() => null);
  if (!git) throw new Error(`The selected folder is not a Git repository: ${resolved}`);
  if (git.isSymbolicLink()) throw new Error(`The selected repository has unsafe symbolic-link Git metadata: ${canonical}`);

  const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: canonical,
    encoding: 'utf8',
    windowsHide: true
  });
  if (probe.status !== 0 || !probe.stdout?.trim()) {
    throw new Error(`The selected folder is not a valid Git working tree: ${canonical}`);
  }
  const topLevel = await realpath(probe.stdout.trim()).catch(() => null);
  if (!topLevel || topLevel !== canonical) {
    throw new Error(`Open the Git repository root instead of a nested directory: ${canonical}`);
  }

  const control = await lstat(path.join(canonical, 'singularity')).catch(() => null);
  if (control?.isSymbolicLink()) throw new Error(`The singularity control directory cannot be a symbolic link: ${canonical}`);
  const workflow = await lstat(path.join(canonical, 'singularity', 'workflow.yml')).catch(() => null);
  if (workflow?.isSymbolicLink()) throw new Error(`The Singularity Flow workflow cannot be a symbolic link: ${canonical}`);
  if (!workflow?.isFile()) {
    for (const legacyRoot of ['.singularity', '.sdlc']) {
      const legacyControl = await lstat(path.join(canonical, legacyRoot)).catch(() => null);
      if (legacyControl?.isSymbolicLink()) throw new Error(`The former ${legacyRoot} control directory cannot be a symbolic link: ${canonical}`);
      const legacyWorkflow = await lstat(path.join(canonical, legacyRoot, 'workflow.yml')).catch(() => null);
      const legacyConfig = await lstat(path.join(canonical, legacyRoot, 'config.json')).catch(() => null);
      if (legacyWorkflow?.isSymbolicLink() || legacyConfig?.isSymbolicLink()) {
        throw new Error(`Former Singularity Flow configuration files cannot be symbolic links: ${canonical}/${legacyRoot}`);
      }
      if (legacyWorkflow?.isFile() || legacyConfig?.isFile()) throw new LegacyControlRootError(canonical, legacyRoot);
    }
    throw new UninitializedRepositoryError(canonical);
  }
  return canonical;
}

/**
 * The sentence a person should read, out of everything the CLI wrote to stderr.
 *
 * The engine logs a structured line — timestamp, level, the whole error serialized as JSON with a
 * stack trace — and then prints the human sentence after it. Taking stderr whole meant every screen
 * that reports a failure showed the log line: a wall of JSON where a sentence belonged, with the
 * actual explanation somewhere in the middle of it.
 *
 * So the explicit `Singularity Flow error:` line wins wherever it appears, and structured log lines
 * are dropped rather than shown. Anything else is passed through, because an unrecognised message is
 * still better than none.
 */
export function humanError(stderr: string): string {
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  const stated = lines.filter((line) => line.startsWith('Singularity Flow error:'));
  if (stated.length) return stated.at(-1)!.replace(/^Singularity Flow error:\s*/, '');
  // A structured line starts with an ISO timestamp and a level; nothing a reader wants is in it that
  // is not also in the sentence beside it.
  const readable = lines.filter((line) =>
    !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+(ERROR|WARN|INFO|DEBUG)\b/.test(line));
  return readable.join('\n').trim();
}

export type OutputStream = 'stdout' | 'stderr';

export interface CliCommandTiming {
  schemaVersion: 2;
  event: 'dx.vscode-command-timing';
  command: string;
  commandClass: 'read' | 'mutation' | 'unknown';
  startedAt: string;
  durationMs: number;
  outcome: 'success' | 'error' | 'cancelled';
  cancelled: boolean;
  exitCode: number | null;
  fallback: 'none';
  stages: { spawnMs: number };
}

export interface InvokeOptions {
  executable: string;
  cli: string;
  repository: string;
  args: string[];
  input?: string | null;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
  onOutput?: (text: string, stream: OutputStream) => void;
  commandClass?: 'read' | 'mutation' | 'unknown';
  /** Completion telemetry is separate from the child process' stdout/stderr stream. */
  onTiming?: (event: CliCommandTiming) => void;
  /** Aborting a run the user cancelled, or that a newer refresh has superseded. */
  signal?: AbortSignal;
}

/**
 * Run the CLI once and resolve its parsed `--json` output.
 *
 * Rejects rather than resolving a failure value: a caller that forgets to check a status field
 * silently renders wrong governance state, and there is no safe default for "did this approval
 * happen". The error carries the CLI's own message so it can be shown without rewording.
 */
export function invokeCli<T = unknown>(options: InvokeOptions): Promise<T> {
  const {
    executable, cli, repository, args, input = null, json = true,
    env = process.env, timeoutMs = CLI_TIMEOUT_MS, spawnImpl = spawn, onOutput, onTiming,
    commandClass = 'unknown', signal
  } = options;

  const startedAt = process.hrtime.bigint();
  const startedAtWall = new Date().toISOString();
  return new Promise<T>((resolve, reject) => {
    let child: ChildProcess | undefined;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timingReported = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const reportTiming = (
      outcome: CliCommandTiming['outcome'], exitCode: number | null, cancelled = false
    ) => {
      if (timingReported) return;
      timingReported = true;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      try {
        onTiming?.({
          schemaVersion: 2,
          event: 'dx.vscode-command-timing',
          command: args[0] ?? 'command',
          commandClass,
          startedAt: startedAtWall,
          durationMs,
          outcome,
          cancelled,
          exitCode,
          fallback: 'none',
          stages: { spawnMs: durationMs }
        });
      } catch { /* diagnostic only */ }
    };
    const succeed = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown, outcome: CliCommandTiming['outcome'] = 'error', cancelled = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      reportTiming(outcome, child?.exitCode ?? null, cancelled);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    function onAbort() {
      child?.kill('SIGTERM');
      fail(new Error('The Singularity Flow command was cancelled.'), 'cancelled', true);
    }

    if (signal?.aborted) return fail(new Error('The Singularity Flow command was cancelled.'), 'cancelled', true);

    const collect = (target: string, chunk: Buffer, stream: OutputStream): string => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child?.kill('SIGTERM');
        fail(new Error('The Singularity Flow CLI returned too much data to display.'));
        return target;
      }
      const text = chunk.toString('utf8');
      // A progress observer that throws must never take the command down with it.
      try { onOutput?.(text, stream); } catch { /* ignored on purpose */ }
      return target + text;
    };

    try {
      child = spawnImpl(executable, [cli, ...args], {
        cwd: repository,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      return fail(error);
    }

    timer = setTimeout(() => {
      child?.kill('SIGTERM');
      fail(new Error(`The Singularity Flow CLI did not finish within ${Math.ceil(timeoutMs / 1000)} seconds. Run the same command in a terminal to see what it is waiting on.`));
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk, 'stdout'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk, 'stderr'); });
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const message = humanError(stderr)
          || stdout.trim()
          || `The Singularity Flow CLI exited with ${code}.`;
        return fail(new CliError(message, code, stderr));
      }
      if (!json) {
        reportTiming('success', code);
        return succeed({ output: stdout.trim() } as T);
      }
      try {
        const value = JSON.parse(stdout) as T;
        reportTiming('success', code);
        succeed(value);
      } catch {
        fail(new Error(`The CLI returned data this extension could not read: ${stdout.slice(0, 500)}`));
      }
    });

    if (input == null) child.stdin?.end();
    else child.stdin?.end(input, 'utf8');
  });
}

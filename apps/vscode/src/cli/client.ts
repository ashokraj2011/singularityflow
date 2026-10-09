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
  FACTORY_RESET_TRANSACTION_TIMEOUT_MS, WORKSPACE_MUTATION_TIMEOUT_MS, WORK_START_TIMEOUT_MS,
  STORY_DESCRIPTION_ENHANCEMENT_TIMEOUT_MS, WORLD_MODEL_TIMEOUT_MS,
  invokeCli, cliInvocationTimeoutError, type OutputStream, type CliCommandTiming
} from './runner.ts';
import type { RepositorySnapshot, SnapshotSlice } from './snapshot.ts';

export const CORE_SNAPSHOT_SLICES: readonly SnapshotSlice[] = Object.freeze([
  'repository', 'lifecycle', 'capabilities'
]);
const READ_RESULT_CACHE_TTL_MS = 250;
/** Bounds supervised invocations across clients, not attested living native processes. */
export const CLI_READ_CONCURRENCY = 4;

/**
 * Who is waiting on a read. `[perf]`
 *
 * The pool used to be one first-come queue, so a person waiting on the intake form queued behind
 * activation's background discovery and product checks — and that wait was invisible, because the
 * timing clock started only when the process spawned. Queued reads start in priority order, and
 * background reads never hold more than all but one slot, so the next read a person waits on always
 * finds room. A background read queued for 30 s is promoted so it cannot starve.
 */
export type ReadPriority = 'interactive' | 'normal' | 'background';
const READ_PRIORITY_RANK: Record<ReadPriority, number> = { interactive: 0, normal: 1, background: 2 };
const BACKGROUND_PROMOTION_MS = 30_000;

interface ReadTicket {
  run(queuedMs: number, priority: ReadPriority): Promise<void>;
  cancelled: boolean;
  priority: ReadPriority;
  enqueuedAt: number;
}
const queuedReads: ReadTicket[] = [];
let runningReads = 0;
let runningBackgroundReads = 0;

function effectiveReadPriority(ticket: ReadTicket, now: number): ReadPriority {
  return ticket.priority === 'background' && now - ticket.enqueuedAt >= BACKGROUND_PROMOTION_MS
    ? 'normal' : ticket.priority;
}

function nextReadTicket(): number {
  const now = Date.now();
  const backgroundSlotFree = runningBackgroundReads < CLI_READ_CONCURRENCY - 1;
  let best = -1;
  for (let index = 0; index < queuedReads.length; index += 1) {
    const priority = effectiveReadPriority(queuedReads[index]!, now);
    if (priority === 'background' && !backgroundSlotFree) continue;
    if (best < 0 || READ_PRIORITY_RANK[priority]
        < READ_PRIORITY_RANK[effectiveReadPriority(queuedReads[best]!, now)]) best = index;
  }
  return best;
}

function drainReads(): void {
  while (runningReads < CLI_READ_CONCURRENCY && queuedReads.length) {
    const index = nextReadTicket();
    if (index < 0) return;
    const [ticket] = queuedReads.splice(index, 1);
    if (!ticket || ticket.cancelled) continue;
    const priority = effectiveReadPriority(ticket, Date.now());
    const background = priority === 'background';
    runningReads += 1;
    if (background) runningBackgroundReads += 1;
    // A slot includes bounded process-tree cleanup and unknown-close handle release, not only its
    // subscribers' wait. Releasing a slot does not attest that every native descendant has died.
    void ticket.run(Date.now() - ticket.enqueuedAt, priority).finally(() => {
      runningReads -= 1;
      if (background) runningBackgroundReads -= 1;
      drainReads();
    }).catch(() => {});
  }
}

function queueRead(
  run: ReadTicket['run'], priority: ReadPriority
): { cancel(): void; raise(priority: ReadPriority): void } {
  const ticket: ReadTicket = { run, cancelled: false, priority, enqueuedAt: Date.now() };
  queuedReads.push(ticket);
  queueMicrotask(drainReads);
  return {
    cancel: () => {
      ticket.cancelled = true;
      const index = queuedReads.indexOf(ticket);
      if (index >= 0) queuedReads.splice(index, 1);
    },
    // A higher-priority caller joining a queued read must not wait at the lower priority.
    raise: (next) => {
      if (READ_PRIORITY_RANK[next] < READ_PRIORITY_RANK[ticket.priority]) {
        ticket.priority = next;
        queueMicrotask(drainReads);
      }
    }
  };
}

/** Priority when the caller does not say: the reads a person is waiting on, and the ones nobody is. */
export function defaultReadPriority(args: readonly string[]): ReadPriority {
  if (args[0] === 'workspace' && args[1] === 'branches' && args.includes('--intake')) return 'interactive';
  if (args[0] === 'session' && args[1] === 'candidates') return 'background';
  if (args[0] === 'product') return 'background';
  if (args[0] === 'jira' && args[1] === 'status') return 'background';
  return 'normal';
}

interface ReadSubscriber {
  resolve(value: unknown): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface ClientRead {
  key: string | null;
  epoch: number;
  controller: AbortController;
  subscribers: Set<ReadSubscriber>;
  ticket: { cancel(): void; raise(priority: ReadPriority): void } | null;
  started: boolean;
  finished: boolean;
}

interface SnapshotEnvelope {
  included?: SnapshotSlice[];
  notModified?: boolean;
  revision?: RepositorySnapshot['revision'];
  repository?: Record<string, unknown>;
  lifecycle?: Partial<RepositorySnapshot>;
  configuration?: Partial<RepositorySnapshot>;
  capabilities?: {
    path?: string;
    mode?: 'implicit' | 'explicit-legacy' | 'explicit-managed';
    authorityRepository?: string | null;
    capabilities?: unknown[] | null;
    error?: string;
  };
  integrations?: Partial<RepositorySnapshot>;
  diagnostics?: RepositorySnapshot['diagnostics'];
  sgos?: RepositorySnapshot['sgos'];
  worldModel?: RepositorySnapshot['worldModel'];
  comprehension?: RepositorySnapshot['comprehension'];
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
        : {
          mode: capability.mode,
          authorityRepository: capability.authorityRepository ?? null,
          capabilities: capability.capabilities ?? [],
          ...(capability.error ? { error: capability.error } : {})
        }
    } : {}),
    ...(envelope.diagnostics ? { diagnostics: envelope.diagnostics } : {}),
    ...(envelope.sgos ? { sgos: envelope.sgos } : {}),
    // A separately leased WMB v4 projection wins over the legacy compatibility value embedded in
    // Configuration. It is bounded and carries no complete Fact/Evidence catalogs.
    ...(envelope.worldModel ? { worldModel: envelope.worldModel } : {}),
    ...(envelope.comprehension ? { comprehension: envelope.comprehension } : {}),
    included: [...(envelope.included ?? [])],
    ...(envelope.notModified ? { notModified: true } : {}),
    ...(envelope.revision ? { revision: envelope.revision } : {})
  } as RepositorySnapshot;
}

const READ_ONLY_COMMANDS = new Set([
  'about', 'help', 'show', 'choices', 'inbox', 'home', 'recommend', 'status', 'progress',
  'guide', 'logs', 'doctor', 'nextsteps', 'snapshot', 'validate', 'precheck', 'change', 'proof',
  'comprehension'
]);
const READ_ONLY_CONFIGURATION_COMMANDS = new Set([
  'snapshot', 'validate', 'read', 'export-bundle', 'initiative-materialize-preview', 'explain'
]);
const REMOTE_CAPABILITY_OPERATIONS = new Set([
  'map', 'map-team', 'edit', 'publish', 'proposals', 'proposal', 'activate', 'world-model', 'organisation',
  'fsck', 'discard-proposal', 'repair-proposal',
  'setup-proposals', 'setup-proposal', 'setup-activate'
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

/**
 * Whether an otherwise read-only invocation may reuse bytes from the short-lived client cache.
 *
 * Configuration validation is deliberately excluded: the editor writes candidate bytes to disk
 * immediately before invoking it, and a second save can replace those bytes well inside the
 * ordinary 250 ms read TTL. Reusing or coalescing that result would validate the previous save
 * while presenting it as the current one. It remains classified as a read for timeout and mutation
 * policy; only result reuse is forbidden.
 */
function cacheableRead(args: string[]): boolean {
  return !(args[0] === 'configuration' && args[1] === 'validate')
    // Publication uses current authored bytes. A 250 ms cached preflight could approve a draft
    // that changed after the previous check; the kernel will still recheck inside publication.
    && !(args[0] === 'phase' && args[1] === 'prepublish')
    // An explicit test-setup inspection must reread the selected module manifests, including
    // edits made since the previous click; suggestions are not a cached readiness receipt.
    && !(args[0] === 'capability' && args[1] === 'test-setup')
    // Revocation can arrive from another process; the chat status command must see the store now.
    && !(args[0] === 'revision' && args[1] === 'attachments' && args[2] === 'status')
    // Candidate selection, interval progress, and recovery may change in another Copilot/CLI host.
    // A card presented for human review must therefore be read from the journal now, not from the
    // extension's short-lived coalescing cache.
    && !(args[0] === 'revision' && ['status', 'card', 'show'].includes(args[1] ?? ''))
    // A peer can save or delete a shared draft at any moment. CAS cards must be owner reads,
    // not a replay of this window's previous acknowledgement.
    && !(args[0] === 'workflow' && args[1] === 'author')
    // Recovery must freshly observe an exact proposal ref, including peer activation/deletion.
    && !(args[0] === 'workflow' && args[1] === 'proposal-status')
    // A destructive apply is guarded by a second byte-current preview. Reusing the first preview
    // here would turn that freshness check into a comparison with its own cached answer.
    && args[0] !== 'factory-reset'
    // A test delivery reaches another system every time it is asked for; never replay the last answer.
    && !(args[0] === 'integrations' && args[1] === 'test' && enabledBooleanOption(args, 'send-test'))
    // A readiness check that mints an intake receipt answers with a single-use bearer token. Sharing
    // one answer between two callers would hand both of them the same receipt.
    && !(args[0] === 'workspace' && args[1] === 'branches' && args.includes('--mint-intake-receipt'));
}

export function commandClass(args: string[]): 'read' | 'mutation' | 'unknown' {
  if (!args[0]) return 'unknown';
  if (args[0] === 'adhoc') return args[1] === 'status' ? 'read' : 'mutation';
  if (args[0] === 'jira') return args[1] === 'status' ? 'read' : 'mutation';
  if (args[0] === 'integrations') return ['list', 'status', 'test'].includes(args[1] ?? 'status') ? 'read' : 'mutation';
  if (args[0] === 'prompt-log') return ['status', 'list', 'view'].includes(args[1] ?? 'status') ? 'read' : 'mutation';
  if (args[0] === 'impact') {
    if (args[1] === 'study') return ['list', 'show', 'prompt-hash'].includes(args[2] ?? 'list') ? 'read' : 'mutation';
    if (args[1] === 'exposure') return (args[2] ?? 'status') === 'status' ? 'read' : 'mutation';
    return ['preview', 'explain', 'refresh', 'status', 'compare', 'verify', 'doctor'].includes(args[1] ?? 'status') ? 'read' : 'mutation';
  }
  if (args[0] === 'revision' && args[1] === 'checks') {
    const action = args[2] ?? '';
    if (['capabilities', 'plan', 'status', 'result'].includes(action)) return 'read';
    if (action === 'run') return 'mutation';
    return 'unknown';
  }
  // Preview writes an expiring private plan cache. It is not a cacheable read even though it does
  // not alter Story/Git state; register appends a durable private receipt.
  if (args[0] === 'revision' && args[1] === 'attachments') {
    return ['capabilities', 'list', 'status'].includes(args[2] ?? '') ? 'read' : 'mutation';
  }
  if (args[0] === 'revision') {
    if (['activation', 'capabilities', 'status', 'card', 'show'].includes(args[1] ?? '')) {
      return 'read';
    }
    return args[1] === 'abandon' && enabledBooleanOption(args, 'preview')
      ? 'read' : 'mutation';
  }
  if (args[0] === 'revise') {
    return enabledBooleanOption(args, 'dry-run') ? 'read' : 'mutation';
  }
  if (args[0] === 'factory-reset') {
    return enabledBooleanOption(args, 'dry-run') ? 'read' : 'mutation';
  }
  if (args[0] === 'product') {
    return (args[1] ?? 'status') === 'status' || enabledBooleanOption(args, 'dry-run') ? 'read' : 'mutation';
  }
  if (args[0] === 'init' && enabledBooleanOption(args, 'smart-detect')
      && enabledBooleanOption(args, 'dry-run') && !hasOption(args, 'output')) return 'read';
  // Configuration inventory and previews are read-only. Every other configuration subcommand is
  // conservative-by-default because it either writes a governed file, changes the local session,
  // promotes planning output, materializes Jira/Git state, or commits and pushes. The previous
  // inverse test classified all new subcommands as reads until somebody remembered this adapter.
  if (args[0] === 'configuration') {
    return READ_ONLY_CONFIGURATION_COMMANDS.has(args[1] ?? '') ? 'read' : 'mutation';
  }
  if (args[0] === 'precheck') {
    if (!enabledBooleanOption(args, 'run')) return 'read';
    return hasOption(args, 'confirm-plan') ? 'mutation' : 'read';
  }
  if (args[0] === 'return') return enabledBooleanOption(args, 'apply') ? 'mutation' : 'read';
  if (args[0] === 'recover') return enabledBooleanOption(args, 'apply') ? 'mutation' : 'read';
  if (args[0] === 'story' && args[1] === 'return') return 'read';
  if (args[0] === 'story' && args[1] === 'enhance-description') return 'read';
  if (args[0] === 'story' && args[1] === 'references') {
    return (args[2] ?? 'list') === 'materialize' ? 'mutation' : 'read';
  }
  if (args[0] === 'report' || args[0] === 'review') return hasOption(args, 'out') ? 'mutation' : 'read';
  if (args[0] === 'telemetry') return (args[1] ?? 'status') === 'status' ? 'read' : 'mutation';
  if (args[0] === 'help-metrics') return (args[1] ?? 'status') === 'status' ? 'read' : 'mutation';
  if (args[0] === 'repositories') {
    return args[1] === 'cache' && (args[2] ?? 'status') === 'clear' ? 'mutation' : 'read';
  }
  if (args[0] === 'inputs') return enabledBooleanOption(args, 'dry-run') ? 'read' : 'mutation';
  if (args[0] === 'documents') return ['list', 'browse', 'artifacts'].includes(args[1] ?? 'list') ? 'read' : 'mutation';
  if (args[0] === 'decision') return (args[1] ?? 'show') === 'show' ? 'read' : 'mutation';
  if (args[0] === 'mcp' && args[1] === 'sources') return 'read';
  // A preview fetches and stages bytes and a check re-reads sources; neither changes governed state.
  if (args[0] === 'import') return args[1] === 'preview' ? 'read' : 'mutation';
  if (args[0] === 'imports') return ['list', 'check'].includes(args[1] ?? 'list') ? 'read' : 'mutation';
  if (args[0] === 'marketplace') return ['list', 'browse'].includes(args[1] ?? 'list') ? 'read' : 'mutation';
  if (args[0] === 'workflow' && args[1] === 'author') {
    return ['list', 'read', 'show', 'history', 'op-status', 'preview', 'catalog'].includes(args[2] ?? 'list') ? 'read' : 'mutation';
  }
  if (args[0] === 'workflow' && args[1] === 'studio') {
    return (args[2] ?? 'show') === 'show' || enabledBooleanOption(args, 'dry-run') ? 'read' : 'mutation';
  }
  if (args[0] === 'workflow') return ['list', 'proposals', 'proposal', 'proposal-status'].includes(args[1] ?? 'list') ? 'read' : 'mutation';
  if (args[0] === 'phase') return ['show', 'draft-check', 'prepublish'].includes(args[1] ?? '')
    ? 'read' : 'mutation';
  if (args[0] === 'converge' || args[0] === 'explain') return 'read';
  if (args[0] === 'spec') {
    const action = args[1] ?? 'trace';
    if (action === 'coverage' || action === 'trace') return 'read';
    if ((action === 'index' || action === 'acceptance') && enabledBooleanOption(args, 'dry-run')) return 'read';
    return 'mutation';
  }
  if (args[0] === 'visual') return (args[1] ?? 'status') === 'status' ? 'read' : 'mutation';
  if (args[0] === 'capabilities' && args[1] === 'doctor') return 'read';
  if (args[0] === 'capability') {
    if (args[1] === 'onboard') {
      return hasOption(args, 'confirm-plan') ? 'mutation'
        : enabledBooleanOption(args, 'dry-run') ? 'read' : 'unknown';
    }
    return ['tree', 'show', 'of', 'proposals', 'proposal', 'setup-proposals', 'setup-proposal',
      'fsck', 'world-model', 'organisation',
      'leads', 'inspect-repository', 'test-setup']
      .includes(args[1] ?? 'tree') ? 'read' : 'mutation';
  }
  if (args[0] === 'session') {
    return ['current', 'doctor', 'context', 'candidates', 'status'].includes(args[1] ?? 'status')
      ? 'read'
      : 'mutation';
  }
  if (args[0] === 'workspace' && ['current', 'list', 'status', 'doctor', 'branches'].includes(args[1] ?? 'list')) return 'read';
  if (args[0] === 'workspace' && args[1] === 'bootstrap') {
    return args[2] === 'status' ? 'read' : 'mutation';
  }
  if (args[0] === 'workspace' && args[1] === 'refresh-configuration' && enabledBooleanOption(args, 'dry-run')) return 'read';
  if (args[0] === 'workspace' && args[1] === 'reinitialize' && enabledBooleanOption(args, 'dry-run')) return 'read';
  if (args[0] === 'workspace' && ['attach-capability', 'detach-capability'].includes(args[1] ?? '')
      && enabledBooleanOption(args, 'dry-run')) return 'read';
  if (args[0] === 'goal') return ['list', 'show', 'status', 'next', 'propose', 'inspect', 'impact', 'change', 'trace'].includes(args[1] ?? 'list') ? 'read' : 'mutation';
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
  if (args[0] === 'evidence') return ['verify', 'reconstruct', 'matrix', 'scope'].includes(args[1] ?? 'verify') ? 'read' : 'mutation';
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
  if (args[0] === 'meta-tool') {
    const action = args[1] ?? 'list';
    if (action === 'list') return 'read';
    if (['activate', 'observe', 'revoke', 'rollback'].includes(action)
        && !hasOption(args, 'confirm')) return 'read';
    return 'mutation';
  }
  if (args[0] === 'delivery') {
    const action = args[1] ?? 'recommend';
    return [
      'recommend', 'workflow-status', 'execution-status', 'promotion-preview',
      'promotion-status', 'assurance-evaluate', 'provenance-status',
      'authenticated-runner-status', 'wel-readiness', 'readiness',
      'local-runner-status', 'local-runner-options', 'local-runner-plan',
      'local-runner-verify'
    ].includes(action) ? 'read' : 'mutation';
  }
  return READ_ONLY_COMMANDS.has(args[0]) ? 'read' : 'mutation';
}

/** A repository-context cancellation, never a lifecycle/configuration fault. */
export function isCliReadSuperseded(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && 'code' in error && error.code === 'CLI_READ_SUPERSEDED';
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
  /**
   * Secrets are supplied by VS Code SecretStorage and exist only in the child process. A function is
   * read at every spawn, so a secret stored after activation reaches the next command without a reload.
   */
  environment?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  onOutput?: (text: string, stream: OutputStream) => void;
  /** Sanitized completion diagnostics independent of whether child output is displayed. */
  onTiming?: (event: CliCommandTiming) => void;
}

/** Per-call options. Priority only orders reads in the shared pool; writes never queue. */
export interface RunOptions {
  priority?: ReadPriority;
  /** Story start stages as the engine reports them; see `cli/progress.ts`. Writes only. */
  onProgress?: (step: string) => void;
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
  private readonly readResults = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly readInFlight = new Map<string, ClientRead>();
  private readonly readJobs = new Set<ClientRead>();
  private readEpoch = 0;
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
   * Callers must refresh whatever they have already read. Old native reads are cancelled and their
   * results cannot enter the new repository's cache or in-flight set.
   */
  useRepository(repository: string): void {
    if (repository !== this.options.repository) this.invalidateReadResults(true);
    this.options.repository = repository;
  }

  private invalidateReadResults(cancelExisting = false): void {
    this.readEpoch += 1;
    this.readResults.clear();
    this.readInFlight.clear();
    // A write invalidates reuse, not the subscribers who already paid for this read. Clearing the
    // sharing map makes every post-write request fresh; the epoch prevents old results being cached.
    // Only changing the repository makes those subscribers' context unusable and cancels them.
    if (!cancelExisting) return;
    for (const job of this.readJobs) {
      for (const subscriber of [...job.subscribers]) {
        this.leaveRead(job, subscriber, Object.assign(
          new Error('The Singularity Flow read was superseded.'), { code: 'CLI_READ_SUPERSEDED' }
        ));
      }
    }
  }

  private readResultKey(args: string[]): string {
    return JSON.stringify([this.readEpoch, this.options.repository, args]);
  }

  private leaveRead(job: ClientRead, subscriber: ReadSubscriber, error: Error): void {
    if (!job.subscribers.delete(subscriber)) return;
    if (subscriber.timer) clearTimeout(subscriber.timer);
    subscriber.signal?.removeEventListener('abort', subscriber.onAbort);
    subscriber.reject(error);
    if (job.subscribers.size || job.finished) return;
    if (job.key && this.readInFlight.get(job.key) === job) this.readInFlight.delete(job.key);
    this.readJobs.delete(job);
    job.controller.abort(error);
    if (!job.started) {
      job.ticket?.cancel();
      job.finished = true;
    }
  }

  private finishRead(job: ClientRead, value: unknown, error: Error | null): void {
    if (job.finished) return;
    job.finished = true;
    this.readJobs.delete(job);
    if (job.key && this.readInFlight.get(job.key) === job) this.readInFlight.delete(job.key);
    if (!error && job.key && job.subscribers.size && job.epoch === this.readEpoch) {
      const now = Date.now();
      for (const [key, cached] of this.readResults) {
        if (cached.expiresAt < now) this.readResults.delete(key);
      }
      this.readResults.set(job.key, {
        expiresAt: now + READ_RESULT_CACHE_TTL_MS, value: structuredClone(value)
      });
      // A long-lived extension host must not retain every expired distinct result indefinitely.
      if (this.readResults.size > 32) this.readResults.delete(this.readResults.keys().next().value!);
    }
    for (const subscriber of job.subscribers) {
      if (subscriber.timer) clearTimeout(subscriber.timer);
      subscriber.signal?.removeEventListener('abort', subscriber.onAbort);
      if (error) subscriber.reject(error);
      else subscriber.resolve(structuredClone(value));
    }
    job.subscribers.clear();
  }

  private invoke<T>(args: string[], timeoutMs: number | null, signal?: AbortSignal, json = true,
    input: string | null = null, priority: ReadPriority = defaultReadPriority(args),
    onProgress?: (step: string) => void): Promise<T> {
    // Capture before entering the process-wide queue: repository changes and caller argv edits
    // must never change which command a previously requested read eventually launches.
    args = [...args];
    const repository = this.options.repository;
    // JSON stdout is the read model, not progress. Streaming it into VS Code's Output channel made
    // every structured payload exist three times (runner buffer, Output channel, parsed object) and
    // could flood the UI with megabytes of implementation detail. Human progress and diagnostics
    // are emitted on stderr; prose commands deliberately retain their stdout stream.
    const visibleOutput = json
      ? (text: string, stream: OutputStream): void => {
          if (stream === 'stderr') this.options.onOutput?.(text, stream);
        }
      : this.options.onOutput;
    const classification = commandClass(args);
    if (classification !== 'read') this.invalidateReadResults();
    const cacheable = json && input == null && classification === 'read' && cacheableRead(args);
    const cacheKey = cacheable ? this.readResultKey(args) : null;
    if (classification === 'read' && signal?.aborted) {
      return Promise.reject(new Error('The Singularity Flow command was cancelled.'));
    }
    if (cacheKey) {
      const cached = this.readResults.get(cacheKey);
      if (cached && cached.expiresAt >= Date.now()) {
        return Promise.resolve(structuredClone(cached.value) as T);
      }
      if (cached) this.readResults.delete(cacheKey);
    }
    const invocation = {
      executable: this.options.location.executable,
      cli: this.options.location.cli,
      repository,
      args,
      json,
      input,
      env: { ...((typeof this.options.environment === 'function' ? this.options.environment() : this.options.environment) ?? process.env) },
      timeoutMs,
      commandClass: classification,
      onOutput: visibleOutput,
      onTiming: (event: CliCommandTiming) => {
        try { this.options.onTiming?.(structuredClone(event)); } catch { /* diagnostic only */ }
        try {
          this.options.onOutput?.(
            `[Singularity Flow timing] ${JSON.stringify(event)}\n`,
            'stderr'
          );
        } catch { /* timing diagnostics must never fail a command */ }
      },
      signal
    };
    // Writes keep the original runner deadline/rollback contract and never wait in the read pool.
    if (classification !== 'read') return invokeCli<T>({ ...invocation, ...(onProgress ? { onProgress } : {}) });
    let job = cacheKey ? this.readInFlight.get(cacheKey) : undefined;
    const fresh = !job;
    if (job && !job.started) job.ticket?.raise(priority);
    if (!job) {
      job = { key: cacheKey, epoch: this.readEpoch, controller: new AbortController(),
        subscribers: new Set(), ticket: null, started: false, finished: false };
      this.readJobs.add(job);
      if (cacheKey) this.readInFlight.set(cacheKey, job);
    }
    const current = job;
    const result = new Promise<T>((resolve, reject) => {
      const subscriber: ReadSubscriber = {
        resolve: (value) => resolve(value as T), reject, signal,
        onAbort: () => this.leaveRead(current, subscriber, new Error('The Singularity Flow command was cancelled.'))
      };
      current.subscribers.add(subscriber);
      signal?.addEventListener('abort', subscriber.onAbort, { once: true });
      if (timeoutMs !== null) subscriber.timer = setTimeout(() => {
        this.leaveRead(current, subscriber, cliInvocationTimeoutError(invocation, timeoutMs));
      }, timeoutMs);
      if (signal?.aborted) subscriber.onAbort();
    });
    if (fresh && current.subscribers.size) current.ticket = queueRead(async (queuedMs, queuedPriority) => {
      if (!current.subscribers.size || current.finished) return;
      current.started = true;
      try {
        // Subscribers retain the existing command-specific deadlines, including explicit null
        // contracts, across queue+execution. A runner timer owned by the first subscriber would
        // wrongly kill later subscribers; their last departure still supervises native cleanup.
        const value = await invokeCli({ ...invocation,
          timeoutMs: null, signal: current.controller.signal, queuedMs, priority: queuedPriority });
        this.finishRead(current, value, null);
      } catch (error) {
        this.finishRead(current, undefined, error instanceof Error ? error : new Error(String(error)));
      }
    }, priority);
    return result;
  }

  /** A coherent, bounded read model. Heavy domains are added only when their surface opens. */
  async snapshot(signal?: AbortSignal, slices: readonly SnapshotSlice[] = CORE_SNAPSHOT_SLICES,
    ifRevision: string | null = null, priority?: ReadPriority): Promise<RepositorySnapshot> {
    const args = snapshotArgs(slices, ifRevision);
    const envelope = await this.invoke<SnapshotEnvelope>(args, SNAPSHOT_TIMEOUT_MS, signal, true, null,
      priority ?? defaultReadPriority(args));
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
  run<T = unknown>(args: string[], signal?: AbortSignal, options: RunOptions = {}): Promise<T> {
    return this.invoke<T>(args, this.timeoutFor(args, signal !== undefined), signal, true, null,
      options.priority ?? defaultReadPriority(args), options.onProgress);
  }

  /** JSON CLI result with private stdin payload; input is never appended to child argv. */
  runWithInput<T = unknown>(args: string[], input: string, signal?: AbortSignal,
    options: RunOptions = {}): Promise<T> {
    return this.invoke<T>(args, this.timeoutFor(args, signal !== undefined), signal, true, input,
      options.priority ?? defaultReadPriority(args));
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
      args, this.timeoutFor(args, options.signal !== undefined), options.signal, false, options.input ?? null);
    return result.output;
  }

  private timeoutFor(args: string[], cancellable = false): number | null {
    // Engine bounds human browser review at 15 minutes; leave time for its guarded transaction.
    if (args[0] === 'appeal' && args[1] === 'evidence-accept' && enabledBooleanOption(args, 'review-ui')) return 20 * 60_000;
    // The dry-run only inventories bytes and stays under the ordinary bounded read deadline. Once
    // the exact reset is confirmed, however, the engine may have moved old roots into rollback
    // staging. A host timeout at that point is less safe than waiting for the engine's guarded
    // commit-or-rollback boundary, so the apply has an explicit no-host-deadline contract.
    if (args[0] === 'factory-reset') {
      return enabledBooleanOption(args, 'dry-run')
        ? CLI_TIMEOUT_MS : FACTORY_RESET_TRANSACTION_TIMEOUT_MS;
    }
    if (args[0] === 'submit') return VALIDATION_TIMEOUT_MS;
    // Baseline execution already has bounded per-command timeouts; do not kill it at the read UI budget.
    if (args[0] === 'precheck' && enabledBooleanOption(args, 'run') && hasOption(args, 'confirm-plan')) return 30 * 60_000;
    // Alignment reinstalls product surfaces from retained bytes; npm resolves the CLI's dependencies.
    if (args[0] === 'product' && (args[1] === 'align' || args[1] === 'reviews')) return WORKSPACE_MUTATION_TIMEOUT_MS;
    if (args[0] === 'repair' && args[1] === 'attempt') return VALIDATION_TIMEOUT_MS;
    if (args[0] === 'story' && args[1] === 'enhance-description') {
      return STORY_DESCRIPTION_ENHANCEMENT_TIMEOUT_MS;
    }
    if (args[0] === 'start'
        || (['story', 'epic', 'initiative'].includes(args[0] ?? '') && args[1] === 'start')
        || (args[0] === 'workspace' && args[1] === 'branches' && hasOption(args, 'preflight-story'))) {
      return WORK_START_TIMEOUT_MS;
    }
    // An exact workspace Story attach may materialize one deferred repository before creating or
    // reusing its isolated checkout. Give the governed clone and Git credential negotiation the
    // same host budget as other workspace mutations; the engine still bounds each Git operation.
    if (args[0] === 'session' && args[1] === 'attach' && hasOption(args, 'workspace')) {
      return WORKSPACE_MUTATION_TIMEOUT_MS;
    }
    // Validated workspace deletion can move large monorepo checkouts into rollback staging before
    // it commits the reset. The ordinary two-minute UI timeout must not kill that transaction in
    // the middle; the CLI still owns rollback and the panel remains non-shelling.
    if (args[0] === 'local-reset') return CAPABILITY_AUTHORITY_TIMEOUT_MS;
    if (args[0] === 'capability' && REMOTE_CAPABILITY_OPERATIONS.has(args[1] ?? '')) {
      return CAPABILITY_AUTHORITY_TIMEOUT_MS;
    }
    // Fast attachment and authority refresh observe one exact configuration ref. They still cross
    // the office Git/proxy boundary, so the ordinary two-minute UI ceiling is too short and can
    // interrupt a valid receipt transaction while Git is negotiating credentials.
    if (args[0] === 'onboard' || args[0] === 'authority'
        || (args[0] === 'capability' && args[1] === 'onboard')) {
      return CAPABILITY_AUTHORITY_TIMEOUT_MS;
    }
    // URL-only Story discovery can inspect thousands of small remote metadata blobs. Each Git
    // operation is independently bounded by the engine; do not impose the ordinary two-minute
    // host deadline over the whole sequence and misreport a slow enterprise remote as empty.
    if (args[0] === 'session' && args[1] === 'candidates' && hasOption(args, 'repository-url')) {
      return CAPABILITY_AUTHORITY_TIMEOUT_MS;
    }
    // Workflow configuration proposals clone the approved configuration authority and publish an exact
    // review ref. Office Git proxies can make that bounded remote transaction slower than an
    // ordinary local CLI action, so it gets the same ceiling as capability authority changes. A
    // real timeout still carries the complete terminal recovery command from the shared runner.
    if ((args[0] === 'workflow' && hasOption(args, 'propose'))
        || (args[0] === 'workflow' && args[1] === 'author')
        || (['import', 'imports', 'marketplace'].includes(args[0] ?? '') && hasOption(args, 'propose'))
        || (args[0] === 'configuration' && args[1] === 'save' && hasOption(args, 'propose'))) {
      return CAPABILITY_AUTHORITY_TIMEOUT_MS;
    }
    // A machine-wide safe reinitialization is a sequence of independently leased repository
    // transactions. Its duration grows with the registry and office Git latency, so a host-wide
    // 30-minute kill can interrupt a healthy later repository. The Workspaces notification is
    // explicitly cancellable and its AbortSignal still terminates the process tree. A selected
    // workspace keeps the ordinary bounded mutation deadline.
    if (cancellable && args[0] === 'workspace' && args[1] === 'reinitialize'
        && (!args[2] || args[2].startsWith('--'))) return null;
    if (args[0] === 'workspace' && [
      'prepare', 'create', 'duplicate', 'update', 'repair', 'sync', 'archive',
      'refresh-configuration', 'reinitialize', 'attach-capability', 'detach-capability'
    ].includes(args[1] ?? '')) {
      return WORKSPACE_MUTATION_TIMEOUT_MS;
    }
    if (args[0] === 'workspace' && args[1] === 'bootstrap'
        && ['resume', 'retry'].includes(args[2] ?? '')) {
      return WORKSPACE_MUTATION_TIMEOUT_MS;
    }
    // A model-written repository brief or explanation can take minutes; a cached or template brief returns at once.
    return (args[0] === 'wm' && ['build'].includes(args[1] ?? ''))
      || (args[0] === 'wm' && args[1] === 'knowledge' && ['brief', 'explain', 'calls'].includes(args[2] ?? ''))
      || (args[0] === 'workspace' && args[1] === 'impact' && args[2] === 'analyze')
      ? WORLD_MODEL_TIMEOUT_MS : CLI_TIMEOUT_MS;
  }
}

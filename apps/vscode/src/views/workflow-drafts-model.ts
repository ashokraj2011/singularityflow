/** Shared writes belong to workflow author; optional private checkpoints grant no shared authority. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { addWorkflowDraftStage, bindWorkflowDraftBase, editWorkflowDraftGuide, reorderWorkflowDraftStage, selectWorkflowDraftCatalog,
  prepareWorkflowDraftChange, WORKFLOW_DRAFT_GUIDE_FIELDS, workflowDraftGuide, type WorkflowDraftGuideField } from './workflow-drafts-guide.ts';
import type { WorkflowDraftRecoveryCheckpoint, WorkflowDraftRecoveryScope, WorkflowDraftRecoveryStore, WorkflowDraftRecoveryLockInspection } from './workflow-drafts-recovery.ts';

export const WORKFLOW_DRAFT_INPUT_MAX_BYTES = 5 * 1024 * 1024;
const DRAFT_ID = /^WFD-[A-Z0-9]{6,32}$/u;
const HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;

/** `errorCode` is the CLI's closed refusal code from its structured result; prose is never scanned for one. */
export type WorkflowDraftRunner = (argv: string[], root: string) => Promise<{
  result: unknown; error: string | null; errorCode?: string | null;
}>;
export type WorkflowDraftInputTransport = <T>(text: string, invoke: (file: string) => Promise<T>) => Promise<T>;
export interface WorkflowDraftRecord {
  draftId: string; displayName: string; revision: number;
  lifecycleEpoch: number; revisionSha256: string;
}
export interface WorkflowDraftEditor {
  binding: string; record: WorkflowDraftRecord; head: string; authority: string;
  name: string; inputText: string; savedName: string; savedText: string;
  readOnlyReason: string | null;
}
export interface SharedWorkflowDraftView {
  repository: string; drafts: WorkflowDraftRecord[]; listHead: string | null;
  authority: string | null; editor: WorkflowDraftEditor | null;
  busy: boolean; dirty: boolean; error: string | null; notice: string | null;
  show: Record<string, unknown> | null;
  preview: Record<string, unknown> | null;
  usage: { skillId: string; selectors: string; historyDepth: number;
    report: Record<string, unknown> | null; error: string | null };
  operationId: string | null;
  stage: number;
  autosave: boolean;
  durability: 'shared' | 'memory' | 'saving' | 'failed' | 'conflict' | 'uncertain' | 'deleted';
  recovery: { status: 'unavailable' | 'none' | 'checking' | 'writing' | 'saved' | 'failed';
    checkpoint: WorkflowDraftRecoveryCheckpoint | null; candidate: WorkflowDraftRecoveryCheckpoint | null;
    candidateAvailable: boolean; restoreAllowed: boolean; message?: string;
    locks?: WorkflowDraftRecoveryLockInspection[] };
}
interface AuthorResult {
  resultType: 'workflow-author'; status: string;
  operation: { id: string; modelPolicy: string; classification?: string };
  capability?: { repository?: string };
  data: Record<string, unknown>;
}
export interface WorkflowDraftPresentation {
  changed: () => void;
  /** Status-only updates preserve the live managed editor buffer and focus. */
  statusChanged?: () => void;
  exit?: () => void;
  /** A rejected DOM buffer must not be replaced by the previous bounded host buffer. */
  editorRejected?: (binding: string, message: string) => void;
  confirmDiscard: (reason?: 'private-checkpoint' | 'editor') => Promise<boolean>;
  copyReview: (root: string, argv: readonly string[], surface: 'shell' | 'copilot') => Promise<void>;
  compareRecovery?: (comparison: { draftId: string; checkpointName: string; checkpointText: string;
    sharedName: string; sharedText: string; checkpointId: string; baseRevision: number; currentRevision: number }) => Promise<void>;
  /** Native host consent, not a webview yes, timestamp or PID-only claim. */
  confirmLockRepair?: (inspection: WorkflowDraftRecoveryLockInspection) => Promise<boolean>;
}

/** A copied Copilot route has no cwd operand; never infer its folder from a picker or HOME. */
export function workflowDraftCopilotContextIssue(
  root: string, openedFolders: readonly string[], platform: NodeJS.Platform = process.platform
): string | null {
  const refusal = 'Copilot folder context is ambiguous; use the rooted Shell review command or open this exact repository alone.';
  const paths = platform === 'win32' ? path.win32 : path;
  if (!paths.isAbsolute(root) || openedFolders.length !== 1
      || !openedFolders[0] || !paths.isAbsolute(openedFolders[0])) return refusal;
  const normalize = (value: string): string => {
    const resolved = paths.resolve(value);
    return platform === 'win32' ? resolved.replace(/^[A-Z]:/u, (drive) => drive.toLowerCase()) : resolved;
  };
  return normalize(root) === normalize(openedFolders[0]) ? null : refusal;
}
interface SaveSnapshot { draftId: string; authority: string; head: string; epoch: number; name: string; text: string }
interface PendingSave { key: string; operationId: string; snapshot: SaveSnapshot; uncertain: boolean }
const saveKey = (snapshot: SaveSnapshot): string => JSON.stringify([snapshot.draftId, snapshot.authority,
  snapshot.head, snapshot.epoch, snapshot.name, snapshot.text]);
const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const STORY_REF = /^refs\/(?:heads|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
function selectedUsageQuery(skillId: unknown, selectors: unknown, depth: unknown): {
  skillId: string; selectors: string; historyDepth: number; roots: string[]
} {
  if (typeof skillId !== 'string' || skillId.length > 128 || !SKILL_ID.test(skillId)
      || typeof selectors !== 'string' || Buffer.byteLength(selectors) > 8192
      || !Number.isSafeInteger(depth) || Number(depth) < 1 || Number(depth) > 16) {
    throw new Error('Select one portable skill ID, exact local Story refs and history depth 1–16.');
  }
  const entries = selectors.split(/\r?\n/u).filter(Boolean);
  if (entries.length < 1 || entries.length > 8 || entries.length * Number(depth) > 32) {
    throw new Error('Select 1–8 explicit Story/ref windows and at most 32 retained revisions. No repository scan is performed.');
  }
  const roots: string[] = [];
  for (const entry of entries) {
    const marker = entry.indexOf('#'); const equals = entry.indexOf('=', marker + 1);
    const root = entry.slice(0, marker); const story = entry.slice(marker + 1, equals); const ref = entry.slice(equals + 1);
    if (entry !== entry.trim() || marker < 1 || equals <= marker + 1 || entry.includes(',') || entry.includes('#', marker + 1)
        || entry.includes('=', equals + 1) || !path.isAbsolute(root) || path.normalize(root) !== root
        || root === path.parse(root).root || Buffer.byteLength(root) > 4096 || /[\u0000-\u001f\u007f]/u.test(root)
        || !STORY_ID.test(story) || story.length > 64 || !STORY_REF.test(ref)
        || /(?:\.\.|@\{|\/\/|\/$|\.lock(?:\/|$))/u.test(ref)) {
      throw new Error('Use one exact ABSOLUTE-REPOSITORY#STORY=refs/heads/BRANCH per line. Wildcards, URLs and repository discovery are unavailable.');
    }
    if (!roots.includes(root)) roots.push(root);
  }
  if (roots.length > 4) throw new Error('Select at most four distinct local repositories.');
  return { skillId, selectors: entries.join(','), historyDepth: Number(depth), roots };
}
interface PendingCreate { draftId: string; operationId: string; expectedHead: string; expectedAuthority: string }
export interface WorkflowDraftScheduler {
  now: () => number;
  set: (callback: () => void, milliseconds: number) => unknown;
  clear: (handle: unknown) => void;
}
const scheduler: WorkflowDraftScheduler = { now: Date.now,
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): WorkflowDraftRecord {
  if (!object(value) || typeof value.draftId !== 'string' || !DRAFT_ID.test(value.draftId)
      || typeof value.displayName !== 'string' || Buffer.byteLength(value.displayName) > 512
      || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
      || !Number.isSafeInteger(value.lifecycleEpoch) || Number(value.lifecycleEpoch) < 1
      || typeof value.revisionSha256 !== 'string' || !SHA.test(value.revisionSha256)) {
    throw new Error('The shared-draft CLI returned an invalid revision observation.');
  }
  return { draftId: value.draftId, displayName: value.displayName,
    revision: Number(value.revision), lifecycleEpoch: Number(value.lifecycleEpoch),
    revisionSha256: value.revisionSha256 };
}
function head(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !HEAD.test(value)) throw new Error('The shared-draft CLI did not identify an exact store head.');
  return value;
}
function authority(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 4096 || /[\0\r\n]/u.test(value)) {
    throw new Error('The shared-draft CLI did not identify an exact repository authority.');
  }
  return value;
}
function authorResult(value: unknown, action: string): AuthorResult {
  // The dynamic runner may return the CLI's versioned command-result wrapper or its inner result.
  const wrapped = object(value) && value.resultType === 'command-result'
    && object(value.data) ? value.data.result : value;
  if (!object(wrapped) || wrapped.resultType !== 'workflow-author' || !object(wrapped.operation)
      || wrapped.operation.id !== `workflow.author.${action}` || wrapped.operation.modelPolicy !== 'never'
      || typeof wrapped.status !== 'string' || !object(wrapped.data)) {
    throw new Error('The shared-draft CLI returned an unexpected authoring result.');
  }
  return wrapped as unknown as AuthorResult;
}
function inputIssue(text: string): string | null {
  if (Buffer.byteLength(text, 'utf8') > WORKFLOW_DRAFT_INPUT_MAX_BYTES) return 'The draft input exceeds the 5 MiB interactive transport limit.';
  if (Buffer.from(text, 'utf8').toString('utf8') !== text) return 'Draft input must contain well-formed literal Unicode; no replacement bytes will be sent.';
  // Preserve the original literal text for the CLI. Parsing here must not silently remove duplicate
  // fields or reinterpret paths; closed-envelope and storage admission remain CLI checks.
  try {
    const input: unknown = JSON.parse(text);
    if (!object(input) || Object.keys(input).some((key) => !['payload', 'assets'].includes(key))
        || !Object.keys(input).length) return 'Use a JSON object containing only payload and/or assets.';
  } catch { return 'The draft input is not valid JSON. Your text has been retained.'; }
  return null;
}
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
}
/** A CLI failure that keeps the runner's structured refusal code beside the displayed text. */
class WorkflowDraftRefusal extends Error {
  readonly refusalCode: string | null;
  constructor(message: string, refusalCode: string | null) { super(message); this.refusalCode = refusalCode; }
}
function refusalCode(error: unknown): string | null {
  return error instanceof WorkflowDraftRefusal ? error.refusalCode : null;
}

/** Private recovery is inert and separate from the canonical shared draft and consent owners. */
export class SharedWorkflowDraftController {
  readonly view: SharedWorkflowDraftView;
  private readonly runner: WorkflowDraftRunner;
  private readonly input: WorkflowDraftInputTransport;
  private readonly presentation: WorkflowDraftPresentation;
  private readonly root: string;
  private pendingSave: PendingSave | null = null;
  private pendingCreate: PendingCreate | null = null;
  private disposed = false;
  private readonly clock: WorkflowDraftScheduler;
  private timer: unknown = null;
  private dirtySince: number | null = null;
  private autosavePaused = false;
  private readonly recoveryStore?: WorkflowDraftRecoveryStore;
  private recoveryWanted: WorkflowDraftRecoveryCheckpoint | null = null;
  private recoveryDrain: Promise<void> | null = null;
  private recoveryError: Error | null = null;
  private recoveryReadFailed = false;
  private recoveryClearing = false;
  private readonly recoveryAcknowledged = new Map<string, WorkflowDraftRecoveryCheckpoint>();
  private candidateNotFoundOperation: string | null = null;
  private recoveryPendingNeedsStatus = false;
  constructor(
    root: string,
    runner: WorkflowDraftRunner,
    input: WorkflowDraftInputTransport,
    presentation: WorkflowDraftPresentation,
    clock: WorkflowDraftScheduler = scheduler,
    recoveryStore?: WorkflowDraftRecoveryStore
  ) {
    if (!root || !path.isAbsolute(root) || /[\0\r\n]/u.test(root)) {
      throw new Error('Open an explicit repository before opening Shared Workflow Drafts.');
    }
    this.runner = runner; this.input = input; this.presentation = presentation; this.clock = clock; this.root = path.resolve(root);
    this.recoveryStore = recoveryStore;
    this.view = { repository: this.root, drafts: [], listHead: null, authority: null,
      editor: null, busy: false, dirty: false, error: null, notice: null, show: null, preview: null, operationId: null,
      usage: { skillId: '', selectors: '', historyDepth: 1, report: null, error: null },
      stage: 1, autosave: false, durability: 'shared', recovery: { status: recoveryStore ? 'none' : 'unavailable',
        checkpoint: null, candidate: null, candidateAvailable: false, restoreAllowed: false } };
  }
  dispose(): void {
    this.cancelTimer();
    if (this.view.dirty || this.pendingSave) this.queueRecovery();
    this.disposed = true; // Already captured local writes finish; no new shared call starts.
  }
  private changed(): void { if (!this.disposed) this.presentation.changed(); }
  private statusChanged(): void {
    if (!this.disposed) (this.presentation.statusChanged ?? this.presentation.changed)();
  }
  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clear(this.timer);
    this.timer = null;
  }
  private recoveryScope(editor = this.view.editor): WorkflowDraftRecoveryScope | null {
    return editor ? { repository: this.root, authority: editor.authority, draftId: editor.record.draftId } : null;
  }
  private scopeKey(scope: WorkflowDraftRecoveryScope): string { return JSON.stringify([scope.repository, scope.authority, scope.draftId]); }
  private checkpoint(): WorkflowDraftRecoveryCheckpoint | null {
    const editor = this.view.editor; const scope = this.recoveryScope(editor);
    if (!editor || !scope) return null;
    return { schemaVersion: 1, checkpointId: randomUUID(), capturedAt: new Date().toISOString(), scope,
      base: { record: { ...editor.record }, head: editor.head, savedName: editor.savedName, savedText: editor.savedText },
      buffer: { name: editor.name, text: editor.inputText },
      ...(this.pendingSave ? { pendingSave: { operationId: this.pendingSave.operationId,
        snapshot: { ...this.pendingSave.snapshot }, uncertain: true as const } } : {}) };
  }
  private queueRecovery(): void {
    if (!this.recoveryStore || !this.view.editor) return;
    if (this.view.recovery.candidate || this.view.recovery.status === 'checking' || this.recoveryReadFailed) {
      this.view.recovery.message = 'Private recovery needs an explicit Refresh, Restore, Compare or Discard decision. New captured edits remain in memory; the retained checkpoint has not been overwritten.';
      this.statusChanged(); return;
    }
    this.recoveryWanted = this.checkpoint(); this.recoveryError = null;
    this.view.recovery.status = 'writing'; this.view.recovery.message = 'Saving a private checkpoint on this device; shared acknowledgement is separate.';
    this.statusChanged(); if (!this.recoveryClearing) void this.drainRecovery().catch(() => {});
  }
  private drainRecovery(): Promise<void> {
    if (this.recoveryDrain) return this.recoveryDrain;
    if (!this.recoveryStore) return Promise.resolve();
    const store = this.recoveryStore;
    const drain = (async () => {
      while (this.recoveryWanted) {
        const checkpoint = this.recoveryWanted; this.recoveryWanted = null;
        const key = this.scopeKey(checkpoint.scope);
        try { await store.write(checkpoint, this.recoveryAcknowledged.get(key)?.checkpointId ?? null); }
        catch (error) {
          this.recoveryWanted ??= checkpoint; this.recoveryError = new Error(errorMessage(error));
          this.autosavePaused = true;
          if (this.recoveryScope() && this.scopeKey(this.recoveryScope()!) === key) {
            this.view.recovery.status = 'failed';
            this.view.recovery.message = `The latest private checkpoint was not acknowledged: ${this.recoveryError.message} The existing private checkpoint was not replaced; shared Save is blocked.`;
            this.view.error = this.view.recovery.message; this.statusChanged();
          }
          throw this.recoveryError;
        }
        this.recoveryAcknowledged.set(key, checkpoint);
        if (this.recoveryScope() && this.scopeKey(this.recoveryScope()!) === key) {
          this.view.recovery.checkpoint = checkpoint;
          this.view.recovery.status = this.recoveryWanted ? 'writing' : 'saved';
          this.view.recovery.message = this.recoveryWanted ? 'Newer captured text is awaiting its private checkpoint.'
            : 'Saved privately on this device. This is recovery only, not shared storage, approval or execution.';
          this.statusChanged();
        }
      }
    })();
    this.recoveryDrain = drain;
    void drain.finally(() => { if (this.recoveryDrain === drain) this.recoveryDrain = null; }).catch(() => {});
    return drain;
  }
  private async flushRecovery(): Promise<void> {
    if (!this.recoveryStore) return;
    if (this.view.recovery.candidate) throw new Error('Resolve the offered private checkpoint before writing or replacing it.');
    await this.drainRecovery();
    if (this.recoveryError) throw this.recoveryError;
  }
  private matchesRecoveryBase(editor: WorkflowDraftEditor, checkpoint: WorkflowDraftRecoveryCheckpoint): boolean {
    if (editor.readOnlyReason || checkpoint.scope.repository !== this.root || checkpoint.scope.authority !== editor.authority
        || checkpoint.scope.draftId !== editor.record.draftId || checkpoint.base.head !== editor.head
        || checkpoint.base.record.draftId !== editor.record.draftId
        || checkpoint.base.record.displayName !== editor.record.displayName
        || checkpoint.base.record.revision !== editor.record.revision
        || checkpoint.base.record.lifecycleEpoch !== editor.record.lifecycleEpoch
        || checkpoint.base.record.revisionSha256 !== editor.record.revisionSha256
        || checkpoint.base.savedName !== editor.savedName) return false;
    // Retain literal baseline formatting, but require it to describe the exact fresh shared bytes.
    // A partial/ambiguous old envelope cannot prove full closure; Compare remains available.
    try {
      const old: unknown = JSON.parse(checkpoint.base.savedText); const current: unknown = JSON.parse(editor.savedText);
      const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
        : object(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
      return object(old) && object(current) && JSON.stringify(canonical(old)) === JSON.stringify(canonical(current));
    } catch { return false; }
  }
  private setRecoveryCandidate(candidate: WorkflowDraftRecoveryCheckpoint | null): void {
    this.view.recovery.candidate = candidate; this.view.recovery.candidateAvailable = Boolean(candidate);
    this.view.recovery.restoreAllowed = Boolean(candidate && this.view.editor && !this.pendingSave?.uncertain
      && !this.recoveryPendingNeedsStatus && this.matchesRecoveryBase(this.view.editor, candidate));
  }
  private async clearRecovery(lease?: ReturnType<SharedWorkflowDraftController['editingLease']>, candidate?: WorkflowDraftRecoveryCheckpoint): Promise<void> {
    if (!this.recoveryStore) return;
    if (!candidate) await this.flushRecovery();
    if (lease) this.assertEditingLease(lease);
    const scope = this.recoveryScope(); if (!scope) return;
    const key = this.scopeKey(scope); const checkpoint = candidate ?? this.recoveryAcknowledged.get(key);
    if (!checkpoint) return;
    this.recoveryClearing = true;
    try {
      if (!await this.recoveryStore.remove(scope, checkpoint.checkpointId)) {
        this.recoveryReadFailed = true;
        this.recoveryError = new Error('A newer private checkpoint won its compare-and-swap. It was not removed; Refresh private recovery before reviewing it again.');
        this.view.recovery.status = 'failed'; this.view.recovery.message = this.recoveryError.message;
        throw this.recoveryError;
      }
      if (this.recoveryAcknowledged.get(key)?.checkpointId === checkpoint.checkpointId) this.recoveryAcknowledged.delete(key);
      this.view.recovery.checkpoint = null; this.setRecoveryCandidate(null);
      this.view.recovery.status = this.recoveryWanted ? 'writing' : 'none';
      this.view.recovery.message = 'The exact reviewed private checkpoint was removed; no shared draft was deleted.';
    } catch (error) {
      this.recoveryReadFailed = true; this.recoveryError = new Error(errorMessage(error));
      this.view.recovery.status = 'failed';
      this.view.recovery.message = 'The private checkpoint removal was not acknowledged. Refresh private recovery before reviewing or replacing it; current captured text remains retained.';
      throw this.recoveryError;
    } finally {
      this.recoveryClearing = false;
      if (this.recoveryWanted && !this.recoveryReadFailed) void this.drainRecovery().catch(() => {});
    }
    if (lease) this.assertEditingLease(lease);
  }
  private async recoveryAction(action: string): Promise<void> {
    const candidate = this.view.recovery.candidate;
    const editor = this.view.editor;
    if (!editor || !this.recoveryStore) throw new Error('Private recovery is unavailable for this exact draft scope.');
    if (action === 'recovery-inspect-locks') {
      if (!this.recoveryStore.inspectLocks) throw new Error('Private lock inspection is unavailable in this host. Nothing was removed.');
      const lease = this.editingLease(); const scope = this.recoveryScope(editor)!;
      this.cancelTimer(); this.view.autosave = false; this.autosavePaused = true;
      if (this.recoveryDrain) await this.recoveryDrain.catch(() => {});
      this.assertEditingLease(lease);
      const inspected = await this.recoveryStore.inspectLocks(scope);
      this.assertEditingLease(lease);
      if (this.scopeKey(inspected.scope) !== this.scopeKey(scope)) throw new Error('Lock inspection returned another private scope. Nothing was removed.');
      this.view.recovery.locks = inspected.locks;
      this.view.notice = 'Inspected private lock ownership only. Shared autosave is paused; text, checkpoint, encryption key and shared Git draft are unchanged. Only proven-dead same-domain locks can be explicitly repaired.';
      return;
    }
    if (action === 'recovery-refresh') {
      // A failed/foreign CAS is not permission to overwrite the winner. Retain current text in
      // memory while explicitly reading a new candidate; no queued replacement may cross it.
      this.view.recovery.status = 'checking'; this.recoveryReadFailed = true;
      if (this.recoveryDrain) await this.recoveryDrain.catch(() => {});
      this.recoveryWanted = null;
      const scope = this.recoveryScope(editor)!; const key = this.scopeKey(scope);
      try {
        const fresh = await this.recoveryStore.read(scope);
        if (fresh && this.scopeKey(fresh.scope) !== key) throw new Error('Private recovery returned another repository/draft scope.');
        if (this.view.editor !== editor) throw new Error('The open editor changed during private recovery refresh.');
        if (fresh) this.recoveryAcknowledged.set(key, fresh); else this.recoveryAcknowledged.delete(key);
        this.recoveryError = null; this.recoveryReadFailed = false; this.candidateNotFoundOperation = null;
        this.view.recovery.checkpoint = null; this.setRecoveryCandidate(fresh);
        this.view.recovery.status = fresh ? 'saved' : 'none';
        this.view.operationId = this.pendingSave?.operationId ?? fresh?.pendingSave?.operationId ?? null;
        this.view.recovery.message = fresh ? 'Private recovery refreshed. Current editor text is unchanged; review this exact candidate before replacing it.'
          : 'No private checkpoint exists in this exact scope. Current editor text is unchanged; explicit Save can checkpoint it.';
      } catch (error) {
        this.recoveryError = new Error(errorMessage(error)); this.view.recovery.status = 'failed';
        this.view.recovery.message = 'Private recovery refresh failed. Current text and the previously offered checkpoint remain retained; no absence or replacement was inferred.';
        throw this.recoveryError;
      }
      return;
    }
    if (!candidate) throw new Error('There is no offered private checkpoint for this exact draft scope.');
    const lease = this.editingLease();
    if (action === 'recovery-restore' && (this.pendingSave?.uncertain || this.recoveryPendingNeedsStatus)) {
      this.view.recovery.restoreAllowed = false;
      throw new Error('The current Save operation has an unresolved acknowledgement. Inspect Operation Status before Restore can replace its pending identity or captured text. The offered private candidate is unchanged.');
    }
    if (action === 'recovery-discard') {
      if (candidate.pendingSave && this.candidateNotFoundOperation !== candidate.pendingSave.operationId) {
        throw new Error('The private checkpoint contains an unresolved Save operation. Inspect its operation status before discarding recovery.');
      }
      if (!await this.presentation.confirmDiscard('private-checkpoint')) return;
      this.assertEditingLease(lease);
      if (this.view.recovery.candidate !== candidate) throw new Error('The offered checkpoint changed during the discard review. Nothing was removed.');
      await this.clearRecovery(lease, candidate);
      this.view.operationId = this.pendingSave?.operationId ?? null;
      if (this.view.dirty || this.pendingSave) { this.queueRecovery(); await this.flushRecovery(); }
      this.view.notice = 'Discarded the exact private checkpoint only. The shared revision and any current captured editor text are unchanged.';
      return;
    }
    const fresh = await this.readShared(editor.record.draftId, editor.authority);
    this.assertEditingLease(lease);
    if (this.view.recovery.candidate !== candidate) throw new Error('The offered recovery checkpoint changed; retry this explicit decision.');
    if (action === 'recovery-compare') {
      if (!this.presentation.compareRecovery) throw new Error('The read-only recovery comparison surface is unavailable. No text was restored.');
      await this.presentation.compareRecovery({ draftId: editor.record.draftId, checkpointName: candidate.buffer.name,
        checkpointText: candidate.buffer.text, sharedName: fresh.savedName, sharedText: fresh.savedText,
        checkpointId: candidate.checkpointId, baseRevision: candidate.base.record.revision, currentRevision: fresh.record.revision });
      this.assertEditingLease(lease);
      this.view.recovery.restoreAllowed = !this.pendingSave?.uncertain && !this.recoveryPendingNeedsStatus
        && this.matchesRecoveryBase(fresh, candidate) && this.matchesRecoveryBase(editor, candidate);
      this.view.notice = 'Compared private candidate text with a fresh exact-authority shared read. Neither editor nor shared head was rebased.';
      return;
    }
    if (!this.matchesRecoveryBase(fresh, candidate) || !this.matchesRecoveryBase(editor, candidate)) {
      this.view.recovery.restoreAllowed = false;
      throw new Error('The shared authority, head, revision, digest, epoch or literal baseline changed. Stale recovery cannot overwrite or rebase it; Compare is available and the private checkpoint is retained.');
    }
    if (this.view.dirty && !await this.presentation.confirmDiscard()) return;
    this.assertEditingLease(lease);
    editor.savedName = candidate.base.savedName; editor.savedText = candidate.base.savedText;
    editor.name = candidate.buffer.name; editor.inputText = candidate.buffer.text;
    this.pendingSave = candidate.pendingSave ? { operationId: candidate.pendingSave.operationId,
      snapshot: Object.freeze({ ...candidate.pendingSave.snapshot }),
      key: saveKey(candidate.pendingSave.snapshot), uncertain: true } : null;
    this.recoveryPendingNeedsStatus = Boolean(this.pendingSave);
    this.view.operationId = this.pendingSave?.operationId ?? null;
    this.view.dirty = editor.name !== editor.savedName || editor.inputText !== editor.savedText;
    this.view.autosave = false; this.autosavePaused = true; this.cancelTimer();
    this.view.durability = this.pendingSave ? 'uncertain' : this.view.dirty ? 'memory' : 'shared';
    this.view.show = null; this.view.preview = null;
    this.view.recovery.checkpoint = candidate; this.setRecoveryCandidate(null);
    this.view.recovery.status = 'saved';
    this.view.recovery.message = 'Restored private text in this editor only. Shared autosave is off; a pending operation must be inspected before explicit Save.';
    this.view.notice = 'Explicitly restored the exact-base private checkpoint. No shared write, approval or execution was requested.';
  }
  private async repairRecoveryLock(kind: unknown): Promise<void> {
    if (kind !== 'scope' && kind !== 'key-init') throw new Error('Select one inspected private lock kind. Nothing was removed.');
    const editor = this.view.editor; const scope = this.recoveryScope(editor);
    const inspection = this.view.recovery.locks?.find((item) => item.kind === kind);
    const repair = this.recoveryStore?.repairLock; const confirm = this.presentation.confirmLockRepair;
    if (!editor || !scope || !repair || !confirm || !inspection?.reviewId || !inspection.repairSupported
        || inspection.status !== 'dead') throw new Error('Inspect a proven-dead private lock first. Live, legacy, unknown or unsupported ownership cannot be repaired.');
    const lease = this.editingLease();
    this.cancelTimer(); this.view.autosave = false; this.autosavePaused = true;
    if (this.recoveryDrain) await this.recoveryDrain.catch(() => {});
    this.assertEditingLease(lease);
    // The ticket stays host-side. The browser selects a kind, never supplies owner proof or consent.
    const result = await repair(scope, inspection.reviewId, async (exact) => {
      this.assertEditingLease(lease);
      if (exact.reviewId !== inspection.reviewId || exact.kind !== kind
          || this.scopeKey(exact.scope) !== this.scopeKey(scope)) throw new Error('Private lock review changed. Nothing was removed.');
      const allowed = await confirm(exact);
      this.assertEditingLease(lease);
      return allowed;
    });
    this.assertEditingLease(lease);
    this.view.recovery.locks = undefined;
    this.view.notice = result.status === 'repaired'
      ? 'Removed only the exact proven-dead private lock. Text, checkpoint, encryption key and shared draft are unchanged. Refresh private recovery before choosing another action; no save or retry was started.'
      : 'Private lock repair cancelled. No lock, text, checkpoint, key or shared draft was changed.';
  }
  private schedule(): void {
    this.cancelTimer();
    if (this.disposed || !this.view.autosave || !this.view.dirty || this.autosavePaused || this.view.busy) return;
    this.dirtySince ??= this.clock.now();
    this.timer = this.clock.set(() => {
      this.timer = null;
      void this.leased(() => this.save(), true);
    }, Math.max(0, Math.min(750, 2000 - (this.clock.now() - this.dirtySince))));
  }
  private async call(action: string, args: string[] = []): Promise<AuthorResult> {
    if (this.disposed) throw new Error('The shared-draft panel is closed.');
    const response = await this.runner(['workflow', 'author', action, ...args, '--json'], this.root);
    if (response.error) {
      const code = typeof response.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(response.errorCode)
        ? response.errorCode : null;
      throw new WorkflowDraftRefusal(code && !response.error.includes(code) ? `${code}: ${response.error}` : response.error, code);
    }
    return authorResult(response.result, action);
  }
  private async leased(work: () => Promise<void>, statusOnly = false): Promise<void> {
    if (this.disposed || this.view.busy) return;
    this.view.busy = true; this.view.error = null;
    const update = () => statusOnly ? this.statusChanged() : this.changed();
    update();
    try { await work(); } catch (error) {
      this.view.error = errorMessage(error);
      if (this.view.dirty || this.pendingSave?.uncertain || this.view.durability === 'saving') {
        this.autosavePaused = true;
        const code = refusalCode(error);
        this.view.durability = code === 'WCA_DRAFT_DELETED' ? 'deleted'
          : code === 'WCA_DRAFT_CONFLICT' || code === 'WCA_DRAFT_AUTHORITY_CHANGED' ? 'conflict'
          : this.pendingSave?.uncertain ? 'uncertain' : 'failed';
        if (this.view.durability === 'deleted' && this.view.editor) {
          this.view.editor.readOnlyReason = 'The shared draft was deleted. Captured text is retained; only acknowledged private checkpoints survive a crash. This ID will not be recreated.';
        }
      }
    }
    finally { this.view.busy = false; update(); this.schedule(); }
  }
  private capture(raw: Record<string, unknown>): void {
    const editor = this.view.editor;
    if (!editor || raw.binding !== editor.binding || typeof raw.name !== 'string'
        || typeof raw.inputText !== 'string') return;
    if (Buffer.byteLength(raw.name, 'utf8') > 512 || /[\0\r\n]/u.test(raw.name)
        || Buffer.byteLength(raw.inputText, 'utf8') > WORKFLOW_DRAFT_INPUT_MAX_BYTES) {
      throw new Error('Editor input exceeds its bounded single-name/JSON transport limit.');
    }
    const changed = editor.name !== raw.name || editor.inputText !== raw.inputText;
    editor.name = raw.name; editor.inputText = raw.inputText;
    this.view.dirty = editor.name !== editor.savedName || editor.inputText !== editor.savedText;
    if (changed) {
      this.view.show = null;
      this.view.preview = null;
      if (this.view.dirty) {
        this.dirtySince ??= this.clock.now();
        if (!this.autosavePaused && this.view.durability !== 'saving') this.view.durability = 'memory';
      } else { this.dirtySince = null; if (!this.pendingSave) this.view.durability = 'shared'; }
      this.queueRecovery();
      this.schedule(); this.statusChanged();
    }
  }
  private async list(): Promise<void> {
    const result = await this.call('list', ['--limit', '64']);
    if (result.status !== 'read' || !Array.isArray(result.data.drafts) || result.data.drafts.length > 64
        || result.data.nextCursor !== null) throw new Error('The shared-draft list is incomplete or invalid.');
    const drafts = result.data.drafts.map(record);
    const listHead = head(result.data.head, true);
    const listAuthority = authority(result.capability?.repository);
    // Publish the validated list observation as one paired value. A refused read/Show/write, or a
    // malformed replacement list, must never rebind still-rendered rows to another repository.
    Object.assign(this.view, { drafts, listHead, authority: listAuthority });
    // Never copy listHead into an editor. Its head must remain paired with its exact retained read.
  }
  async initialize(): Promise<void> { await this.leased(() => this.list()); }
  private async readShared(draftId: string, expectedAuthority: string): Promise<WorkflowDraftEditor> {
    const result = await this.call('read', [draftId]);
    if (authority(result.capability?.repository) !== expectedAuthority) {
      throw new Error('The draft authority changed during this read. Refresh the shared list and explicitly reopen the draft; the editor buffer has not been replaced.');
    }
    const selected = record(result.data.record);
    if (result.status !== 'read' || selected.draftId !== draftId || !object(result.data.payload)
        || !Array.isArray(result.data.assets) || result.data.assets.length > 64) {
      throw new Error('The shared-draft CLI returned an invalid draft input.');
    }
    let readOnlyReason: string | null = result.data.tombstone || selected.lifecycleEpoch !== 1
      ? 'This retained revision is not live and cannot be edited.' : null;
    const assets = result.data.assets.map((asset: unknown) => {
      if (!object(asset) || typeof asset.path !== 'string' || typeof asset.contentBase64 !== 'string'
          || !Number.isSafeInteger(asset.bytes) || Number(asset.bytes) < 0
          || Number(asset.bytes) > 8 * 1024 * 1024) throw new Error('The shared-draft CLI returned an invalid asset.');
      const bytes = Buffer.from(asset.contentBase64, 'base64');
      if (bytes.length !== asset.bytes || bytes.toString('base64') !== asset.contentBase64) {
        throw new Error('The shared-draft CLI returned an invalid asset encoding.');
      }
      try {
        // Preserve a leading UTF-8 BOM as literal text, not as a decoder transport marker.
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error('Non-round-tripping asset.');
        return { path: asset.path, content };
      }
      catch {
        readOnlyReason = 'This draft contains binary assets. Literal-text editing is unavailable; no asset bytes will be replaced.';
        return { path: asset.path, bytes: asset.bytes, encoding: 'binary-not-editable' };
      }
    });
    const inputText = JSON.stringify({ payload: result.data.payload, assets }, null, 2);
    if (Buffer.byteLength(inputText) > WORKFLOW_DRAFT_INPUT_MAX_BYTES) {
      readOnlyReason = 'This retained draft exceeds the interactive editor budget. Use the bounded CLI for inspection; text Save is unavailable.';
    }
    return { binding: randomUUID(), record: selected, head: head(result.data.head)!,
      authority: authority(result.capability?.repository),
      name: selected.displayName, inputText, savedName: selected.displayName, savedText: inputText, readOnlyReason };
  }
  private async load(draftId: string, expectedAuthority: string): Promise<void> {
    const lease = this.editingLease();
    const editor = await this.readShared(draftId, expectedAuthority);
    this.assertEditingLease(lease);
    this.view.editor = editor;
    // Navigation already flushed/explicitly discarded the previous scope. Retain no cross-draft
    // plaintext checkpoint cache; the store is reread when that exact scope is explicitly opened.
    this.recoveryAcknowledged.clear();
    this.view.dirty = false; this.view.show = null; this.view.preview = null; this.pendingSave = null; this.view.operationId = null;
    this.cancelTimer(); this.dirtySince = null; this.autosavePaused = false;
    this.view.autosave = false; this.view.stage = 1;
    this.view.durability = editor.readOnlyReason && editor.record.lifecycleEpoch !== 1 ? 'deleted' : 'shared';
    this.recoveryError = null; this.recoveryReadFailed = false; this.candidateNotFoundOperation = null; this.recoveryPendingNeedsStatus = false;
    this.view.recovery = { status: this.recoveryStore ? 'checking' : 'unavailable',
      checkpoint: null, candidate: null, candidateAvailable: false, restoreAllowed: false };
    if (!this.recoveryStore) return;
    const scope = this.recoveryScope(editor)!; const key = this.scopeKey(scope);
    try {
      const candidate = await this.recoveryStore.read(scope);
      if (candidate && this.scopeKey(candidate.scope) !== key) throw new Error('Private recovery returned another repository/draft scope. No buffer was restored.');
      if (candidate) this.recoveryAcknowledged.set(key, candidate); else this.recoveryAcknowledged.delete(key);
      this.setRecoveryCandidate(candidate);
      this.view.recovery.status = candidate ? 'saved' : 'none';
      this.view.recovery.message = candidate
        ? 'A private checkpoint was found. Choose Restore, Compare or Discard. No text was restored or shared automatically.' : 'No private recovery checkpoint was found for this exact repository and authority.';
      if (candidate?.pendingSave) this.view.operationId = candidate.pendingSave.operationId;
      if (!candidate && this.view.dirty) this.queueRecovery();
    } catch (error) {
      this.recoveryError = new Error(errorMessage(error)); this.recoveryReadFailed = true; this.autosavePaused = true;
      this.view.recovery.status = 'failed'; this.view.recovery.message = `Private recovery could not be read: ${this.recoveryError.message} No checkpoint was treated as absent or replaced.`;
      this.view.error = this.view.recovery.message;
    }
  }
  private editingLease(): { editor: WorkflowDraftEditor | null; name?: string; text?: string } {
    const editor = this.view.editor;
    return { editor, name: editor?.name, text: editor?.inputText };
  }
  private assertEditingLease(lease: ReturnType<SharedWorkflowDraftController['editingLease']>): void {
    if (this.view.editor !== lease.editor || (lease.editor
        && (lease.editor.name !== lease.name || lease.editor.inputText !== lease.text))) {
      throw new Error('New captured edits arrived during navigation. The previous editor is retained; finish editing and retry navigation.');
    }
  }
  private async discardAllowed(explicitDiscard = false): Promise<boolean> {
    if (this.pendingSave?.uncertain || (this.view.recovery.candidate?.pendingSave
        && this.candidateNotFoundOperation !== this.view.recovery.candidate.pendingSave.operationId)) {
      const operation = this.pendingSave?.operationId ?? this.view.recovery.candidate?.pendingSave?.operationId;
      throw new Error(`Save operation ${operation} has an unresolved acknowledgement. Check operation status before replacing or closing this editor, even if the visible text matches an older saved buffer. The exact pending checkpoint is retained.`);
    }
    if (this.view.recovery.candidate) throw new Error('Choose Restore, Compare or explicitly Discard the offered private checkpoint before replacing or closing this editor.');
    if (!explicitDiscard && this.view.autosave && this.view.dirty) { await this.flush(); return !this.view.dirty; }
    if (!this.view.dirty) { await this.flushRecovery(); return true; }
    const lease = this.editingLease(); const allowed = await this.presentation.confirmDiscard();
    this.assertEditingLease(lease);
    if (allowed) await this.clearRecovery(lease);
    return allowed;
  }
  private async flush(): Promise<void> {
    this.cancelTimer();
    if (this.view.autosave && this.view.dirty) {
      if (this.autosavePaused) throw new Error('Autosave is paused. Resolve the retained operation/conflict or explicitly Save before navigation. Captured text is retained; private acknowledgement and shared storage are separate.');
      await this.save();
      if (this.view.dirty) throw new Error('Edits arrived during the navigation flush. They remain in memory; finish editing and retry navigation.');
    }
  }
  private async create(): Promise<void> {
    const lease = this.editingLease();
    const selectedAuthority = this.view.authority;
    if (!await this.discardAllowed()) return;
    this.assertEditingLease(lease);
    await this.list();
    this.assertEditingLease(lease);
    if (!selectedAuthority || this.view.authority !== selectedAuthority) {
      throw new Error('The shared draft destination was not observed or changed while creating. Review the refreshed authority and explicitly choose Create again; no draft was written to a new destination.');
    }
    if (!this.pendingCreate) {
      this.pendingCreate = { draftId: `WFD-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        operationId: randomUUID(), expectedHead: this.view.listHead ?? 'empty', expectedAuthority: authority(this.view.authority) };
    } else {
      const pending = this.pendingCreate;
      if (this.view.authority !== pending.expectedAuthority) {
        throw new Error('The draft authority changed while a Create acknowledgement was unresolved. Resolve its operation ID in the original repository before creating another draft.');
      }
      const observed = await this.call('op-status', [pending.operationId]);
      if (observed.status !== 'read' || authority(observed.capability?.repository) !== pending.expectedAuthority) {
        throw new Error('The prior Create operation could not be inspected at its exact authority.');
      }
      if (observed.data.status === 'shared-acknowledged') {
        const acknowledged = record(observed.data.record);
        if (observed.data.operationId !== pending.operationId || acknowledged.draftId !== pending.draftId) {
          throw new Error('The prior Create acknowledgement does not match its retained identity.');
        }
        this.pendingCreate = null;
        if (observed.data.currentLifecycle === 'deleted') {
          throw new Error('The previous Create was shared-acknowledged, but that draft has since been deleted. No replacement was created.');
        }
        this.assertEditingLease(lease); await this.load(pending.draftId, pending.expectedAuthority);
        this.view.notice = 'The previous Create was shared-acknowledged. Opened that same draft; no duplicate was created.';
        return;
      }
      if (observed.data.status !== 'not-found') throw new Error('The prior Create operation has no recognized acknowledgement state.');
      // A fresh exact not-found observation permits reusing the same DraftID/operation after a
      // losing CAS, with its newly observed head. If an old request arrives first, the core's
      // request-hash/idempotency owner will refuse the changed request rather than duplicate it.
      pending.expectedHead = head(observed.data.head, true) ?? 'empty';
    }
    const { draftId, operationId, expectedHead, expectedAuthority } = this.pendingCreate;
    this.view.operationId = operationId;
    const result = await this.call('create', [draftId, '--operation-id', operationId,
      '--expected-head', expectedHead, '--expected-authority', expectedAuthority]);
    const created = record(result.data.record);
    if (result.status !== 'shared-acknowledged' || authority(result.capability?.repository) !== expectedAuthority || created.draftId !== draftId
        || result.data.operationId !== operationId) throw new Error('Draft creation was not shared-acknowledged. Resolve the displayed operation ID before retrying.');
    this.pendingCreate = null;
    this.view.notice = `Created ${draftId} in the shared draft store. No workflow was approved or activated.`;
    this.assertEditingLease(lease);
    await this.load(draftId, expectedAuthority); await this.list();
  }
  private async save(): Promise<void> {
    const editor = this.view.editor;
    if (!editor || editor.readOnlyReason) throw new Error(editor?.readOnlyReason ?? 'Open a live draft before saving.');
    if (!editor.name.trim()) throw new Error('A bounded display name is required.');
    const issue = inputIssue(editor.inputText); if (issue) throw new Error(issue);
    if (this.view.recovery.candidate) throw new Error('Choose Restore, Compare or Discard before replacing the offered private checkpoint or making a shared Save.');
    if (this.recoveryStore && this.recoveryReadFailed) throw new Error('Private recovery must be refreshed after an unavailable read or foreign checkpoint conflict. Shared Save is blocked; the latest text remains captured.');
    if (this.recoveryPendingNeedsStatus) throw new Error('This restored Save operation must be inspected with Operation Status before any shared retry. No shared write was attempted.');
    const snapshot: SaveSnapshot = Object.freeze({ draftId: editor.record.draftId, authority: editor.authority,
      head: editor.head, epoch: editor.record.lifecycleEpoch, name: editor.name, text: editor.inputText });
    const key = saveKey(snapshot);
    if (this.pendingSave?.uncertain && this.pendingSave.key !== key) {
      throw new Error('The prior Save acknowledgement is unresolved. Check its operation status before saving changed text; no new write or automatic rebase was attempted.');
    }
    if (this.pendingSave?.key !== key) this.pendingSave = { key, operationId: randomUUID(), snapshot, uncertain: false };
    const pending = this.pendingSave;
    const operationId = pending.operationId; this.view.operationId = operationId;
    // Persist a possibly-issued immutable operation before the runner can contact the shared store.
    // A crash anywhere after this acknowledgement can recover by the exact existing operation ID.
    this.queueRecovery(); await this.flushRecovery();
    if (this.recoveryStore) {
      const retained = this.recoveryAcknowledged.get(this.scopeKey(this.recoveryScope(editor)!));
      if (retained?.pendingSave?.operationId !== operationId
          || saveKey(retained.pendingSave.snapshot) !== pending.key) throw new Error('The exact pending Save was not privately checkpointed. No shared write was attempted.');
    }
    this.cancelTimer(); this.dirtySince = null; this.view.durability = 'saving'; this.statusChanged();
    let result: AuthorResult;
    try {
      result = await this.input(snapshot.text, (file) => this.call('save', [snapshot.draftId,
        '--input', file, '--name', snapshot.name, '--operation-id', operationId,
        '--expected-head', snapshot.head, '--expected-authority', snapshot.authority,
        '--epoch', String(snapshot.epoch)]));
    } catch (error) {
      // A generic timeout's replay command contains --input pointing at a request already removed
      // by the transport's finally block. Surface only its bounded diagnostic, never that replay.
      const message = errorMessage(error);
      const firstLine = message.split(/[\r\n]/u)[0] ?? '';
      const reportedCode = refusalCode(error);
      const definiteRefusal = new Set(['WCA_DRAFT_CONFLICT', 'WCA_DRAFT_AUTHORITY_CHANGED', 'WCA_DRAFT_DELETED',
        'WCA_DRAFT_CONTENT_BLOCKED', 'WCA_DRAFT_INVALID', 'WCA_DRAFT_LIMIT', 'WCA_DRAFT_NOT_FOUND',
        'WCA_DRAFT_REMOTE_INVALID', 'WCA_OPERATION_ID_REUSED', 'WCA_INPUT_INVALID', 'WCA_INPUT_LIMIT',
        'WCA_INPUT_UNAVAILABLE', 'WCA_AUTHOR_REQUEST_INVALID', 'WCA_DRAFT_SCOPE_UNAVAILABLE']);
      pending.uncertain = !reportedCode || !definiteRefusal.has(reportedCode);
      this.queueRecovery();
      const diagnostic = firstLine.includes('--input')
        ? `Shared Save was not acknowledged${reportedCode ? ` (reported ${reportedCode})` : ''}.` : firstLine;
      throw new WorkflowDraftRefusal(`${diagnostic}\nCheck workflow author op-status ${operationId} first. Then use explicit Save with the retained editor text; unchanged text reuses this operation ID and creates a fresh private input file. Do not replay a temporary --input path.`, reportedCode);
    }
    pending.uncertain = true;
    await this.acceptSave(result, pending, editor);
    this.autosavePaused = Boolean(editor.readOnlyReason);
    try { await this.list(); } catch (error) {
      this.view.notice += ` List refresh failed: ${errorMessage(error)} The Save acknowledgement is retained.`;
    }
  }
  private async acceptSave(result: AuthorResult, pending: PendingSave, editor: WorkflowDraftEditor): Promise<void> {
    const snapshot = pending.snapshot;
    const saved = record(result.data.record);
    if (!['read', 'shared-acknowledged'].includes(result.status)
        || (result.status === 'read' && result.data.status !== 'shared-acknowledged')
        || authority(result.capability?.repository) !== snapshot.authority || saved.draftId !== snapshot.draftId
        || result.data.operationId !== pending.operationId) throw new Error('Save was not shared-acknowledged. Resolve the displayed operation ID before retrying.');
    const savedHead = head(result.data.operationHead)!;
    if (this.disposed || this.view.editor !== editor) return;
    // An exact idempotent retry can acknowledge an older revision after a peer has moved the global
    // head. Keep the operation's head, not that newer observation, so the next Save still fences it.
    editor.head = savedHead; editor.record = saved;
    editor.savedName = snapshot.name; editor.savedText = snapshot.text;
    editor.readOnlyReason = result.data.currentLifecycle === 'deleted' ? 'The acknowledged operation is historical; this draft has since been deleted.' : null;
    this.view.dirty = editor.name !== snapshot.name || editor.inputText !== snapshot.text;
    this.view.show = null; this.view.preview = null; this.pendingSave = null;
    this.recoveryPendingNeedsStatus = false;
    this.view.durability = editor.readOnlyReason ? 'deleted' : this.view.dirty ? 'memory' : 'shared';
    this.view.notice = `Revision ${saved.revision} shared-acknowledged. Save is storage only, not approval, publication or execution.`;
    if (this.view.recovery.candidate) {
      // Explicit refresh can reveal another window's private candidate while this operation was
      // unresolved. Reconcile the exact shared ACK, but never replace that separately offered copy.
      this.setRecoveryCandidate(this.view.recovery.candidate);
      this.view.operationId = this.view.recovery.candidate?.pendingSave?.operationId ?? pending.operationId;
      this.view.recovery.message = 'The retained operation was shared-acknowledged. The separately offered private candidate is unchanged and still needs explicit review.';
      return;
    }
    if (this.view.dirty) this.queueRecovery();
    await this.flushRecovery();
    if (!this.view.dirty && !this.pendingSave) await this.clearRecovery();
  }
  private async show(): Promise<void> {
    const editor = this.view.editor;
    if (!editor) throw new Error('Open a draft before requesting Show.');
    const lease = this.editingLease();
    const result = await this.call('show', [editor.record.draftId, '--revision', String(editor.record.revision)]);
    const view = result.data.view;
    if (result.status !== 'read' || authority(result.capability?.repository) !== editor.authority || !object(view) || !object(view.subject)
        || view.subject.draftId !== editor.record.draftId || view.subject.revision !== editor.record.revision
        || view.subject.lifecycleEpoch !== editor.record.lifecycleEpoch || view.subject.revisionSha256 !== editor.record.revisionSha256) {
      throw new Error('Show did not match the retained saved revision.');
    }
    this.assertEditingLease(lease);
    this.view.show = view;
    this.view.notice = 'Show describes the exact saved revision, not unsaved editor text. Compiler coverage and unresolved findings are explicit; static validation is not approval, host acceptance or readiness to execute.';
  }
  private async preview(): Promise<void> {
    const editor = this.view.editor;
    if (!editor) throw new Error('Open a saved draft before requesting Preview.');
    const lease = this.editingLease();
    const result = await this.call('preview', [editor.record.draftId, '--revision', String(editor.record.revision)]);
    const preview = result.data.preview;
    if (result.status !== 'read' || authority(result.capability?.repository) !== editor.authority
        || !object(preview) || preview.kind !== 'workflow-authoring-package-preview'
        || !object(preview.source) || !object(preview.approvedSource)
        || preview.source.repository !== editor.authority || preview.approvedSource.repository !== editor.authority
        || preview.source.draftId !== editor.record.draftId || preview.source.revision !== editor.record.revision
        || preview.source.lifecycleEpoch !== editor.record.lifecycleEpoch
        || preview.source.revisionSha256 !== editor.record.revisionSha256
        || !['live', 'deleted'].includes(String(preview.source.lifecycle))
        || typeof preview.approvedSource.baseRevision !== 'string' || !HEAD.test(preview.approvedSource.baseRevision)
        || typeof preview.planSha256 !== 'string' || !SHA.test(preview.planSha256)
        || !Array.isArray(preview.findings) || preview.findings.length > 128 || !object(preview.readiness)) {
      throw new Error('Preview did not match the exact retained draft revision and approved repository authority.');
    }
    this.assertEditingLease(lease);
    this.view.preview = preview;
    this.view.notice = 'Preview assessed this exact saved revision only. Findings and unsupported host contracts remain explicit; no approval, submission or execution readiness is inferred.';
  }
  private async lookupUsage(raw: Record<string, unknown>, nextPage: boolean): Promise<void> {
    const previous = this.view.usage;
    if (!nextPage && typeof raw.usageSkillId === 'string' && Buffer.byteLength(raw.usageSkillId) <= 128
        && typeof raw.usageSelectors === 'string' && Buffer.byteLength(raw.usageSelectors) <= 8192
        && typeof raw.usageHistoryDepth === 'number' && Number.isSafeInteger(raw.usageHistoryDepth)) {
      // A rejected selector remains visible for correction, but cannot retain an older result.
      this.view.usage = { skillId: raw.usageSkillId, selectors: raw.usageSelectors,
        historyDepth: raw.usageHistoryDepth, report: null, error: null };
    }
    let query: ReturnType<typeof selectedUsageQuery>;
    try {
      query = nextPage
        ? selectedUsageQuery(previous.skillId, previous.selectors.replace(/,/gu, '\n'), previous.historyDepth)
        : selectedUsageQuery(raw.usageSkillId, raw.usageSelectors, raw.usageHistoryDepth);
      const prior = previous.report;
      const priorPage = prior && object(prior.page) ? prior.page : null;
      const cursor = nextPage ? priorPage?.nextCursor : 0;
      const expectedSource = nextPage ? prior?.sourceSha256 : undefined;
      if (nextPage && (!Number.isSafeInteger(cursor) || Number(cursor) < 1 || typeof expectedSource !== 'string' || !SHA.test(expectedSource))) {
        throw new Error('No verified next page is available. Run an explicit first-page lookup again.');
      }
      this.view.usage = { skillId: query.skillId, selectors: query.selectors.replace(/,/gu, '\n'),
        historyDepth: query.historyDepth, report: null, error: null };
      const args = [query.skillId, '--repository-story-refs', query.selectors,
        '--history-depth', String(query.historyDepth), '--limit', '32',
        ...(nextPage ? ['--cursor', String(cursor), '--expected-source', String(expectedSource)] : [])];
      const result = await this.call('where-used', args);
      const usage = result.data.usage;
      if (result.status !== 'read' || result.operation.classification !== 'read'
          || !object(usage) || usage.format !== 'sflow-cross-repository-story-skill-inventory/v1'
          || !object(usage.subject) || usage.subject.skillId !== query.skillId
          || !object(usage.readScope) || usage.readScope.kind !== 'explicit-local-repository-story-ref-windows'
          || usage.readScope.network !== 'not-contacted' || usage.permissionEffect !== 'none'
          || typeof usage.sourceSha256 !== 'string' || !SHA.test(usage.sourceSha256)
          || nextPage && usage.sourceSha256 !== expectedSource
          || !object(usage.source) || !Array.isArray(usage.source.repositories)
          || usage.source.repositories.length !== query.roots.length
          || usage.source.repositories.some((item, index) => !object(item) || item.requestedRoot !== query.roots[index])
          || !object(usage.coverage) || usage.coverage.otherRepositories !== 'not-searched'
          || !object(usage.page) || usage.page.cursor !== cursor || usage.page.limit !== 32
          || !Number.isSafeInteger(usage.page.total) || Number(usage.page.total) < 0 || Number(usage.page.total) > 2048
          || !Array.isArray(usage.references) || usage.references.length > 32
          || !Array.isArray(usage.observations) || usage.observations.length > 32
          || usage.page.returned !== usage.references.length
          || usage.page.nextCursor !== null && (!Number.isSafeInteger(usage.page.nextCursor)
            || Number(usage.page.nextCursor) <= Number(usage.page.cursor)
            || Number(usage.page.nextCursor) > Number(usage.page.total))
          || Buffer.byteLength(JSON.stringify(usage)) > 512 * 1024) {
        throw new Error('The read-only usage result did not match the exact selected local repositories, source or page. No inventory was displayed.');
      }
      this.view.usage.report = usage;
      this.view.notice = 'Verified only the explicitly selected local Story/ref windows. No repository discovery, fetch, draft edit, approval or imported-skill execution occurred.';
    } catch (error) {
      this.view.usage.report = null;
      this.view.usage.error = errorMessage(error);
    }
  }
  private async operationStatus(): Promise<void> {
    const operationId = this.view.operationId;
    const expectedAuthority = this.pendingCreate?.operationId === operationId
      ? this.pendingCreate.expectedAuthority : this.view.editor?.authority ?? this.view.authority;
    if (!operationId || !expectedAuthority) throw new Error('There is no retained write operation to inspect.');
    const result = await this.call('op-status', [operationId]);
    if (result.status !== 'read' || authority(result.capability?.repository) !== expectedAuthority
        || !['not-found', 'shared-acknowledged'].includes(String(result.data.status))
        || result.data.operationId !== operationId) throw new Error('Operation status did not match the retained write authority and ID.');
    head(result.data.head, true);
    const pending = this.pendingSave;
    const candidate = this.view.recovery.candidate;
    if (pending?.operationId !== operationId && candidate?.pendingSave?.operationId === operationId && this.view.editor && this.recoveryStore) {
      const lease = this.editingLease();
      if (result.data.status === 'shared-acknowledged') {
        const saved = record(result.data.record); const snapshot = candidate.pendingSave.snapshot;
        if (saved.draftId !== snapshot.draftId) throw new Error('The private pending operation acknowledgement names another draft.');
        const updated: WorkflowDraftRecoveryCheckpoint = { ...candidate, checkpointId: randomUUID(), capturedAt: new Date().toISOString(),
          base: { record: saved, head: head(result.data.operationHead)!, savedName: snapshot.name, savedText: snapshot.text } };
        delete updated.pendingSave;
        await this.recoveryStore.write(updated, candidate.checkpointId);
        this.recoveryAcknowledged.set(this.scopeKey(updated.scope), updated);
        this.setRecoveryCandidate(updated); this.view.recovery.status = 'saved'; this.view.operationId = null;
        if (result.data.currentLifecycle === 'deleted') {
          this.view.editor.readOnlyReason = 'The recovered operation is historical; the shared draft has since been deleted.';
          this.view.durability = 'deleted'; this.view.recovery.restoreAllowed = false;
        }
        this.view.recovery.message = 'The exact private pending operation was shared-acknowledged. Its own operation head is retained; a newer shared revision cannot be silently rebased.';
        this.assertEditingLease(lease);
      } else {
        this.candidateNotFoundOperation = operationId;
        this.view.recovery.message = 'The private pending operation was not found at this exact authority. No write was retried; explicit recovery decisions remain required.';
      }
    }
    if (pending?.operationId === operationId && this.view.editor) {
      this.recoveryPendingNeedsStatus = false;
      if (result.data.status === 'shared-acknowledged') await this.acceptSave(result, pending, this.view.editor);
      else {
        pending.uncertain = false;
        if (this.view.recovery.candidate) this.view.operationId = this.view.recovery.candidate.pendingSave?.operationId ?? operationId;
        else { this.queueRecovery(); await this.flushRecovery(); }
      }
      // Inspecting status never automatically resumes writes or installs the global observed head.
    }
    if (this.view.recovery.candidate) this.setRecoveryCandidate(this.view.recovery.candidate);
    this.view.notice = result.data.status === 'shared-acknowledged'
      ? `Operation ${operationId} is shared-acknowledged. This can be historical storage acknowledgement, not readiness. Explicit Save of unchanged retained text reuses its operation ID.`
      : `Operation ${operationId} was not found at the observed store head. Use explicit Save with the retained text; unchanged text reuses this operation ID with a fresh private input file.`;
  }
  /** Closed host message boundary. Repository, head, epoch and operation authority are not inputs. */
  async receive(raw: unknown): Promise<void> {
    if (this.disposed || !object(raw) || typeof raw.type !== 'string') return;
    if (this.view.busy && raw.type !== 'change') return;
    const allowed = ['change', 'refresh', 'open', 'create', 'save', 'reload', 'show', 'operation-status', 'terminal-review', 'copilot-review', 'usage-query', 'usage-next',
      'autosave-on', 'autosave-off', 'stage', 'back-drafts', 'exit', 'guide-answer', 'add-stage', 'move-stage', 'preview', 'catalog-answer', 'submit-review', 'copilot-submit-review',
      'recovery-restore', 'recovery-compare', 'recovery-discard', 'recovery-refresh', 'recovery-inspect-locks', 'recovery-repair-lock'];
    if (!allowed.includes(raw.type)) { this.view.error = 'This shared-draft action is not supported.'; this.changed(); return; }
    if (Object.keys(raw).some((key) => !['type', 'binding', 'name', 'inputText', 'draftId', 'stage', 'field', 'value', 'index', 'direction', 'choiceKind', 'choiceId', 'lockKind', 'usageSkillId', 'usageSelectors', 'usageHistoryDepth'].includes(key))) {
      this.view.error = 'The shared-draft message contains unsupported fields.'; this.changed(); return;
    }
    try { if (!['usage-query', 'usage-next'].includes(raw.type)) this.capture(raw); } catch (error) {
      this.view.error = errorMessage(error);
      if (this.view.editor && this.presentation.editorRejected) {
        this.presentation.editorRejected(this.view.editor.binding, this.view.error);
      } else this.changed();
      return;
    }
    if (raw.type === 'change') return;
    if (['save', 'reload', 'show', 'terminal-review', 'copilot-review', 'autosave-on', 'autosave-off', 'stage', 'back-drafts', 'exit', 'guide-answer', 'add-stage', 'move-stage', 'preview', 'catalog-answer', 'submit-review', 'copilot-submit-review',
      'recovery-restore', 'recovery-compare', 'recovery-discard', 'recovery-refresh', 'recovery-inspect-locks', 'recovery-repair-lock'].includes(raw.type)
        && raw.binding !== this.view.editor?.binding) return;
    await this.leased(async () => {
      if (raw.type === 'usage-query' || raw.type === 'usage-next') await this.lookupUsage(raw, raw.type === 'usage-next');
      else if (raw.type === 'refresh') { await this.list(); this.view.notice = 'Shared list refreshed. The open editor and its retained head have not been rebased.'; }
      else if (raw.type === 'create') await this.create();
      else if (raw.type === 'save') await this.save();
      else if (raw.type === 'show') { const lease = this.editingLease(); await this.flush(); this.assertEditingLease(lease); await this.show(); }
      else if (raw.type === 'preview') { const lease = this.editingLease(); await this.flush(); this.assertEditingLease(lease); await this.preview(); }
      else if (raw.type === 'operation-status') await this.operationStatus();
      else if (raw.type === 'recovery-repair-lock') await this.repairRecoveryLock(raw.lockKind);
      else if (['recovery-restore', 'recovery-compare', 'recovery-discard', 'recovery-refresh', 'recovery-inspect-locks'].includes(String(raw.type))) await this.recoveryAction(String(raw.type));
      else if (raw.type === 'catalog-answer') {
        const editor = this.view.editor; const preview = this.view.preview;
        if (!editor || editor.readOnlyReason || this.view.dirty || !preview || !object(preview.source)
            || preview.source.revisionSha256 !== editor.record.revisionSha256 || preview.source.lifecycle !== 'live'
            || !object(preview.catalogChoices) || preview.catalogChoices.kind !== 'workflow-authoring-catalog-choices'
            || preview.catalogChoices.permissionEffect !== 'none' || !Array.isArray(preview.catalogChoices.groups)
            || !object(preview.approvedSource) || JSON.stringify(preview.catalogChoices.approvedSource) !== JSON.stringify(preview.approvedSource)) {
          throw new Error('Refresh exact saved-revision Preview before selecting its source-bound navigation-only catalog values.');
        }
        let text: string;
        if (raw.choiceKind === 'approved-base') {
          const base = preview.approvedSource.baseRevision;
          if (typeof base !== 'string') throw new Error('The exact approved base is unavailable.');
          text = bindWorkflowDraftBase(editor.inputText, base);
        } else {
          if (typeof raw.choiceKind !== 'string' || !['phase', 'agent', 'template', 'execution-task', 'approval-authority', 'quality-command', 'workflow-edit', 'workflow-fork'].includes(raw.choiceKind)
              || typeof raw.choiceId !== 'string' || !Number.isSafeInteger(raw.index)) throw new Error('Choose a typed catalog reference captured by Preview.');
          const kind = raw.choiceKind.startsWith('workflow-') ? 'workflow' : raw.choiceKind;
          const group = preview.catalogChoices.groups.find((value) => object(value) && value.kind === kind);
          const choices = object(group) && Array.isArray(group.choices) && group.choices.length <= 64 ? group.choices : [];
          const selected = choices.find((value) => object(value) && object(value.ref) && value.ref.source === 'catalog'
            && value.ref.kind === kind && value.ref.id === raw.choiceId);
          if (!selected) throw new Error('That reference was not present in the exact captured catalog choice set. No binding was changed.');
          if (kind === 'workflow') {
            if (!object(selected) || typeof selected.rawDefinitionSha256 !== 'string' || !Array.isArray(selected.phaseOrder)
                || selected.phaseOrder.some((phase) => typeof phase !== 'string') || typeof preview.approvedSource.baseRevision !== 'string') {
              throw new Error('The captured raw workflow parent is unavailable. No edit/copy was prepared.');
            }
            text = prepareWorkflowDraftChange(editor.inputText, raw.choiceKind === 'workflow-edit' ? 'edit' : 'fork', {
              id: raw.choiceId, rawDefinitionSha256: selected.rawDefinitionSha256,
              phaseOrder: selected.phaseOrder as string[] }, preview.approvedSource.baseRevision);
          } else text = selectWorkflowDraftCatalog(editor.inputText, String(raw.choiceKind), raw.choiceId, Number(raw.index));
        }
        this.capture({ binding: editor.binding, name: editor.name, inputText: text }); this.changed();
        this.view.notice = 'Captured approved catalog reference applied as a candidate request only. Membership, tools and host acceptance were not granted. Preview again after the new shared checkpoint.';
        if (this.view.autosave) await this.flush();
      }
      else if (raw.type === 'guide-answer' || raw.type === 'add-stage' || raw.type === 'move-stage') {
        const editor = this.view.editor;
        if (!editor || editor.readOnlyReason) throw new Error('Open a live editable draft before applying guided changes.');
        let text: string;
        if (raw.type === 'guide-answer') {
          if (typeof raw.field !== 'string' || !WORKFLOW_DRAFT_GUIDE_FIELDS.includes(raw.field as WorkflowDraftGuideField)
              || typeof raw.value !== 'string' || !Number.isSafeInteger(raw.index)) throw new Error('Choose a bounded typed guide field.');
          text = editWorkflowDraftGuide(editor.inputText, raw.field as WorkflowDraftGuideField, raw.value, Number(raw.index));
        } else if (raw.type === 'add-stage') {
          const namespace = workflowDraftGuide(editor.inputText).payload.id;
          if (typeof namespace !== 'string') throw new Error('Choose a package identity in Goal before adding candidate stages.');
          text = addWorkflowDraftStage(editor.inputText, namespace);
        } else {
          if (!Number.isSafeInteger(raw.index) || typeof raw.direction !== 'number' || ![-1, 1].includes(raw.direction)) {
            throw new Error('Choose a typed adjacent stage move.');
          }
          text = reorderWorkflowDraftStage(editor.inputText, Number(raw.index), raw.direction);
        }
        this.capture({ binding: editor.binding, name: editor.name, inputText: text });
        // Publish the complete semantic edit before an asynchronous save: the managed advanced
        // textbox must not remain on the pre-answer bytes while accepting concurrent edits.
        this.changed();
        this.view.notice = 'Typed candidate answer applied. Unrelated definitions and hand-written content were retained. Catalog choices remain unresolved until exact approved compilation.';
        if (this.view.autosave) await this.flush();
      }
      else if (raw.type === 'autosave-on') {
        if (!this.view.editor || this.view.editor.readOnlyReason) throw new Error('Open a live editable draft before enabling shared autosave.');
        if (this.pendingSave?.uncertain || this.recoveryPendingNeedsStatus) throw new Error('Resolve the retained Save operation before enabling autosave.');
        if (this.view.recovery.candidate || (this.recoveryStore && this.recoveryError)) throw new Error('Resolve private recovery before enabling shared autosave. No checkpoint was overwritten.');
        if (this.view.durability === 'conflict' || this.view.durability === 'deleted') throw new Error('Resolve the conflict by explicit Reload before enabling autosave; no head is silently rebased.');
        this.view.autosave = true; this.autosavePaused = false;
        if (this.view.dirty) this.dirtySince = this.clock.now();
        this.view.notice = 'Shared autosave enabled for this exact draft, authority and lifecycle epoch. Git repository authorization is rechecked on every write. This is editing scope, not submission or execution consent.';
      } else if (raw.type === 'autosave-off') {
        this.view.autosave = false; this.cancelTimer();
        this.view.notice = 'Shared autosave paused. Captured text is retained; private checkpoints and shared Git acknowledgement are separate. Explicit Save remains available.';
      } else if (raw.type === 'stage') {
        if (!Number.isSafeInteger(raw.stage) || Number(raw.stage) < 1 || Number(raw.stage) > 6) throw new Error('Choose one of the six authoring stages.');
        const lease = this.editingLease(); await this.flush(); this.assertEditingLease(lease); this.view.stage = Number(raw.stage);
      } else if (raw.type === 'back-drafts' || raw.type === 'exit') {
        const lease = this.editingLease();
        if (!await this.discardAllowed()) return;
        this.assertEditingLease(lease);
        this.cancelTimer();
        if (raw.type === 'exit') this.presentation.exit?.();
        else { this.view.editor = null; this.view.autosave = false; this.view.dirty = false; this.view.show = null; this.view.preview = null; this.changed(); await this.list(); }
      }
      else if (raw.type === 'reload') {
        const editor = this.view.editor;
        const lease = this.editingLease();
        if (editor && await this.discardAllowed(true)) { this.assertEditingLease(lease); await this.load(editor.record.draftId, editor.authority); this.view.notice = 'Loaded the latest shared revision. Shared autosave is off until its editing scope is explicitly enabled again.'; }
      } else if (raw.type === 'open') {
        if (typeof raw.draftId !== 'string' || !this.view.drafts.some((draft) => draft.draftId === raw.draftId)) {
          throw new Error('Choose one draft from the current shared list.');
        }
        const selectedAuthority = authority(this.view.authority);
        const lease = this.editingLease();
        if (await this.discardAllowed()) { this.assertEditingLease(lease); await this.load(raw.draftId, selectedAuthority); this.view.notice = 'Opened the shared draft; no local copy was created.'; }
      } else if (raw.type === 'submit-review' || raw.type === 'copilot-submit-review') {
        const editor = this.view.editor;
        if (editor) {
          const lease = this.editingLease(); await this.flush(); this.assertEditingLease(lease);
          if (this.view.dirty || this.pendingSave?.uncertain || this.view.recovery.candidate) throw new Error('Save and resolve the captured checkpoint before copying an exact saved-revision submission review route. No route was copied.');
          await this.presentation.copyReview(this.root, ['workflow', 'author', 'submit', editor.record.draftId,
            '--revision', String(editor.record.revision)], raw.type === 'submit-review' ? 'shell' : 'copilot');
          this.view.notice = 'Submission review route copied only. Nothing was submitted or executed. The terminal must independently refresh and present the exact package with Cancel as default; headless Copilot cannot mint human confirmation.';
        }
      } else if (raw.type === 'terminal-review' || raw.type === 'copilot-review') {
        const id = this.view.editor?.record.draftId;
        if (id) { await this.presentation.copyReview(this.root, ['workflow', 'author', 'delete', id], raw.type === 'terminal-review' ? 'shell' : 'copilot');
          this.view.notice = 'Review route copied. Nothing was deleted; headless Copilot returns a terminal handoff, and only the terminal can separately present the current revision.'; }
      }
    });
  }
}

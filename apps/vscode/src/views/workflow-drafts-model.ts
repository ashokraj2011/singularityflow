/** In-memory presentation only. Every durable draft read/write belongs to workflow author. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { addWorkflowDraftStage, bindWorkflowDraftBase, editWorkflowDraftGuide, reorderWorkflowDraftStage, selectWorkflowDraftCatalog,
  WORKFLOW_DRAFT_GUIDE_FIELDS, workflowDraftGuide, type WorkflowDraftGuideField } from './workflow-drafts-guide.ts';

export const WORKFLOW_DRAFT_INPUT_MAX_BYTES = 5 * 1024 * 1024;
const DRAFT_ID = /^WFD-[A-Z0-9]{6,32}$/u;
const HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;

export type WorkflowDraftRunner = (argv: string[], root: string) => Promise<{
  result: unknown; error: string | null;
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
  operationId: string | null;
  stage: number;
  autosave: boolean;
  durability: 'shared' | 'memory' | 'saving' | 'failed' | 'conflict' | 'uncertain' | 'deleted';
}
interface AuthorResult {
  resultType: 'workflow-author'; status: string;
  operation: { id: string; modelPolicy: string };
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
  confirmDiscard: () => Promise<boolean>;
  copyReview: (root: string, argv: readonly string[], surface: 'shell' | 'copilot') => Promise<void>;
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

/** Shared draft-only autosave. No private durable replica, execution or approval authority. */
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
  constructor(
    root: string,
    runner: WorkflowDraftRunner,
    input: WorkflowDraftInputTransport,
    presentation: WorkflowDraftPresentation,
    clock: WorkflowDraftScheduler = scheduler
  ) {
    if (!root || !path.isAbsolute(root) || /[\0\r\n]/u.test(root)) {
      throw new Error('Open an explicit repository before opening Shared Workflow Drafts.');
    }
    this.runner = runner; this.input = input; this.presentation = presentation; this.clock = clock; this.root = path.resolve(root);
    this.view = { repository: this.root, drafts: [], listHead: null, authority: null,
      editor: null, busy: false, dirty: false, error: null, notice: null, show: null, preview: null, operationId: null,
      stage: 1, autosave: false, durability: 'shared' };
  }
  dispose(): void { this.cancelTimer(); this.disposed = true; }
  private changed(): void { if (!this.disposed) this.presentation.changed(); }
  private statusChanged(): void {
    if (!this.disposed) (this.presentation.statusChanged ?? this.presentation.changed)();
  }
  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clear(this.timer);
    this.timer = null;
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
    if (response.error) throw new Error(response.error);
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
        this.view.durability = /WCA_DRAFT_DELETED/u.test(this.view.error) ? 'deleted'
          : /WCA_DRAFT_CONFLICT|WCA_DRAFT_AUTHORITY_CHANGED/u.test(this.view.error) ? 'conflict'
          : this.pendingSave?.uncertain ? 'uncertain' : 'failed';
        if (this.view.durability === 'deleted' && this.view.editor) {
          this.view.editor.readOnlyReason = 'The shared draft was deleted. Pending text stays in memory only; this ID will not be recreated.';
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
  private async load(draftId: string, expectedAuthority: string): Promise<void> {
    const lease = this.editingLease();
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
    this.assertEditingLease(lease);
    this.view.editor = { binding: randomUUID(), record: selected, head: head(result.data.head)!,
      authority: authority(result.capability?.repository),
      name: selected.displayName, inputText, savedName: selected.displayName, savedText: inputText, readOnlyReason };
    this.view.dirty = false; this.view.show = null; this.view.preview = null; this.pendingSave = null; this.view.operationId = null;
    this.cancelTimer(); this.dirtySince = null; this.autosavePaused = false;
    this.view.autosave = false; this.view.stage = 1;
    this.view.durability = result.data.tombstone || selected.lifecycleEpoch !== 1 ? 'deleted' : 'shared';
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
    if (this.pendingSave?.uncertain) {
      throw new Error(`Save operation ${this.pendingSave.operationId} has an unresolved acknowledgement. Check operation status before replacing or closing this editor, even if the visible text matches an older saved buffer. The exact pending checkpoint is retained in memory.`);
    }
    if (!explicitDiscard && this.view.autosave && this.view.dirty) { await this.flush(); return !this.view.dirty; }
    if (!this.view.dirty) return true;
    const lease = this.editingLease(); const allowed = await this.presentation.confirmDiscard();
    this.assertEditingLease(lease); return allowed;
  }
  private async flush(): Promise<void> {
    this.cancelTimer();
    if (this.view.autosave && this.view.dirty) {
      if (this.autosavePaused) throw new Error('Autosave is paused. Resolve the retained operation/conflict or explicitly Save before navigation. The editor text remains in memory only.');
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
    const snapshot: SaveSnapshot = Object.freeze({ draftId: editor.record.draftId, authority: editor.authority,
      head: editor.head, epoch: editor.record.lifecycleEpoch, name: editor.name, text: editor.inputText });
    const key = JSON.stringify(snapshot);
    if (this.pendingSave?.uncertain && this.pendingSave.key !== key) {
      throw new Error('The prior Save acknowledgement is unresolved. Check its operation status before saving changed text; no new write or automatic rebase was attempted.');
    }
    if (this.pendingSave?.key !== key) this.pendingSave = { key, operationId: randomUUID(), snapshot, uncertain: false };
    const pending = this.pendingSave;
    const operationId = pending.operationId; this.view.operationId = operationId;
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
      const reportedCode = /\bWCA_[A-Z_]{1,64}\b/u.exec(message)?.[0];
      const definiteRefusal = new Set(['WCA_DRAFT_CONFLICT', 'WCA_DRAFT_AUTHORITY_CHANGED', 'WCA_DRAFT_DELETED',
        'WCA_DRAFT_CONTENT_BLOCKED', 'WCA_DRAFT_INVALID', 'WCA_DRAFT_LIMIT', 'WCA_DRAFT_NOT_FOUND',
        'WCA_DRAFT_REMOTE_INVALID', 'WCA_OPERATION_ID_REUSED', 'WCA_INPUT_INVALID', 'WCA_INPUT_LIMIT',
        'WCA_INPUT_UNAVAILABLE', 'WCA_AUTHOR_REQUEST_INVALID', 'WCA_DRAFT_SCOPE_UNAVAILABLE']);
      pending.uncertain = !reportedCode || !definiteRefusal.has(reportedCode);
      const diagnostic = firstLine.includes('--input')
        ? `Shared Save was not acknowledged${reportedCode ? ` (reported ${reportedCode})` : ''}.` : firstLine;
      throw new Error(`${diagnostic}\nCheck workflow author op-status ${operationId} first. Then use explicit Save with the retained editor text; unchanged text reuses this operation ID and creates a fresh private input file. Do not replay a temporary --input path.`);
    }
    pending.uncertain = true;
    this.acceptSave(result, pending, editor);
    this.autosavePaused = Boolean(editor.readOnlyReason);
    try { await this.list(); } catch (error) {
      this.view.notice += ` List refresh failed: ${errorMessage(error)} The Save acknowledgement is retained.`;
    }
  }
  private acceptSave(result: AuthorResult, pending: PendingSave, editor: WorkflowDraftEditor): void {
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
    this.view.durability = editor.readOnlyReason ? 'deleted' : this.view.dirty ? 'memory' : 'shared';
    this.view.notice = `Revision ${saved.revision} shared-acknowledged. Save is storage only, not approval, publication or execution.`;
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
    if (pending?.operationId === operationId && this.view.editor) {
      if (result.data.status === 'shared-acknowledged') this.acceptSave(result, pending, this.view.editor);
      else pending.uncertain = false;
      // Inspecting status never automatically resumes writes or installs the global observed head.
    }
    this.view.notice = result.data.status === 'shared-acknowledged'
      ? `Operation ${operationId} is shared-acknowledged. This can be historical storage acknowledgement, not readiness. Explicit Save of unchanged retained text reuses its operation ID.`
      : `Operation ${operationId} was not found at the observed store head. Use explicit Save with the retained text; unchanged text reuses this operation ID with a fresh private input file.`;
  }
  /** Closed host message boundary. Repository, head, epoch and operation authority are not inputs. */
  async receive(raw: unknown): Promise<void> {
    if (this.disposed || !object(raw) || typeof raw.type !== 'string') return;
    if (this.view.busy && raw.type !== 'change') return;
    const allowed = ['change', 'refresh', 'open', 'create', 'save', 'reload', 'show', 'operation-status', 'terminal-review', 'copilot-review',
      'autosave-on', 'autosave-off', 'stage', 'back-drafts', 'exit', 'guide-answer', 'add-stage', 'move-stage', 'preview', 'catalog-answer', 'submit-review', 'copilot-submit-review'];
    if (!allowed.includes(raw.type)) { this.view.error = 'This shared-draft action is not supported.'; this.changed(); return; }
    if (Object.keys(raw).some((key) => !['type', 'binding', 'name', 'inputText', 'draftId', 'stage', 'field', 'value', 'index', 'direction', 'choiceKind', 'choiceId'].includes(key))) {
      this.view.error = 'The shared-draft message contains unsupported fields.'; this.changed(); return;
    }
    try { this.capture(raw); } catch (error) {
      this.view.error = errorMessage(error);
      if (this.view.editor && this.presentation.editorRejected) {
        this.presentation.editorRejected(this.view.editor.binding, this.view.error);
      } else this.changed();
      return;
    }
    if (raw.type === 'change') return;
    if (['save', 'reload', 'show', 'terminal-review', 'copilot-review', 'autosave-on', 'autosave-off', 'stage', 'back-drafts', 'exit', 'guide-answer', 'add-stage', 'move-stage', 'preview', 'catalog-answer', 'submit-review', 'copilot-submit-review'].includes(raw.type)
        && raw.binding !== this.view.editor?.binding) return;
    await this.leased(async () => {
      if (raw.type === 'refresh') { await this.list(); this.view.notice = 'Shared list refreshed. The open editor and its retained head have not been rebased.'; }
      else if (raw.type === 'create') await this.create();
      else if (raw.type === 'save') await this.save();
      else if (raw.type === 'show') { const lease = this.editingLease(); await this.flush(); this.assertEditingLease(lease); await this.show(); }
      else if (raw.type === 'preview') { const lease = this.editingLease(); await this.flush(); this.assertEditingLease(lease); await this.preview(); }
      else if (raw.type === 'operation-status') await this.operationStatus();
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
          if (typeof raw.choiceKind !== 'string' || !['phase', 'agent', 'template', 'execution-task', 'approval-authority', 'quality-command'].includes(raw.choiceKind)
              || typeof raw.choiceId !== 'string' || !Number.isSafeInteger(raw.index)) throw new Error('Choose a typed catalog reference captured by Preview.');
          const group = preview.catalogChoices.groups.find((value) => object(value) && value.kind === raw.choiceKind);
          const choices = object(group) && Array.isArray(group.choices) && group.choices.length <= 64 ? group.choices : [];
          const selected = choices.find((value) => object(value) && object(value.ref) && value.ref.source === 'catalog'
            && value.ref.kind === raw.choiceKind && value.ref.id === raw.choiceId);
          if (!selected) throw new Error('That reference was not present in the exact captured catalog choice set. No binding was changed.');
          text = selectWorkflowDraftCatalog(editor.inputText, String(raw.choiceKind), raw.choiceId, Number(raw.index));
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
        if (this.pendingSave?.uncertain) throw new Error('Resolve the retained Save operation before enabling autosave.');
        if (this.view.durability === 'conflict' || this.view.durability === 'deleted') throw new Error('Resolve the conflict by explicit Reload before enabling autosave; no head is silently rebased.');
        this.view.autosave = true; this.autosavePaused = false;
        if (this.view.dirty) this.dirtySince = this.clock.now();
        this.view.notice = 'Shared autosave enabled for this exact draft, authority and lifecycle epoch. Git repository authorization is rechecked on every write. This is editing scope, not submission or execution consent.';
      } else if (raw.type === 'autosave-off') {
        this.view.autosave = false; this.cancelTimer();
        this.view.notice = 'Shared autosave paused. Pending text exists in this panel memory only; explicit Save remains available.';
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
          if (this.view.dirty || this.pendingSave?.uncertain) throw new Error('Save and resolve the captured checkpoint before copying an exact saved-revision submission review route. No route was copied.');
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

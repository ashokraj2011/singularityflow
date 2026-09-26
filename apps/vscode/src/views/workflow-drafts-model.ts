/** In-memory presentation only. Every durable draft read/write belongs to workflow author. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';

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
  operationId: string | null;
}
interface AuthorResult {
  resultType: 'workflow-author'; status: string;
  operation: { id: string; modelPolicy: string };
  capability?: { repository?: string };
  data: Record<string, unknown>;
}
export interface WorkflowDraftPresentation {
  changed: () => void;
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
interface PendingSave { key: string; operationId: string }
interface PendingCreate { draftId: string; operationId: string; expectedHead: string; expectedAuthority: string }

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

/** No local store, autosave, compiler, execution or approval authority lives in this controller. */
export class SharedWorkflowDraftController {
  readonly view: SharedWorkflowDraftView;
  private readonly runner: WorkflowDraftRunner;
  private readonly input: WorkflowDraftInputTransport;
  private readonly presentation: WorkflowDraftPresentation;
  private pendingSave: PendingSave | null = null;
  private pendingCreate: PendingCreate | null = null;
  private disposed = false;
  constructor(
    root: string,
    runner: WorkflowDraftRunner,
    input: WorkflowDraftInputTransport,
    presentation: WorkflowDraftPresentation
  ) {
    if (!root || !path.isAbsolute(root) || /[\0\r\n]/u.test(root)) {
      throw new Error('Open an explicit repository before opening Shared Workflow Drafts.');
    }
    this.runner = runner; this.input = input; this.presentation = presentation;
    this.view = { repository: path.resolve(root), drafts: [], listHead: null, authority: null,
      editor: null, busy: false, dirty: false, error: null, notice: null, show: null, operationId: null };
  }
  dispose(): void { this.disposed = true; }
  private changed(): void { if (!this.disposed) this.presentation.changed(); }
  private async call(action: string, args: string[] = []): Promise<AuthorResult> {
    if (this.disposed) throw new Error('The shared-draft panel is closed.');
    const response = await this.runner(['workflow', 'author', action, ...args, '--json'], this.view.repository);
    if (response.error) throw new Error(response.error);
    return authorResult(response.result, action);
  }
  private async leased(work: () => Promise<void>): Promise<void> {
    if (this.disposed || this.view.busy) return;
    this.view.busy = true; this.view.error = null; this.changed();
    try { await work(); } catch (error) { this.view.error = errorMessage(error); }
    finally { this.view.busy = false; this.changed(); }
  }
  private capture(raw: Record<string, unknown>): void {
    const editor = this.view.editor;
    if (!editor || raw.binding !== editor.binding || typeof raw.name !== 'string'
        || typeof raw.inputText !== 'string') return;
    if (Buffer.byteLength(raw.name, 'utf8') > 512 || /[\0\r\n]/u.test(raw.name)
        || Buffer.byteLength(raw.inputText, 'utf8') > WORKFLOW_DRAFT_INPUT_MAX_BYTES) {
      throw new Error('Editor input exceeds its bounded single-name/JSON transport limit.');
    }
    editor.name = raw.name; editor.inputText = raw.inputText;
    this.view.dirty = editor.name !== editor.savedName || editor.inputText !== editor.savedText;
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
    this.view.editor = { binding: randomUUID(), record: selected, head: head(result.data.head)!,
      authority: authority(result.capability?.repository),
      name: selected.displayName, inputText, savedName: selected.displayName, savedText: inputText, readOnlyReason };
    this.view.dirty = false; this.view.show = null; this.pendingSave = null; this.view.operationId = null;
  }
  private async discardAllowed(): Promise<boolean> {
    return !this.view.dirty || await this.presentation.confirmDiscard();
  }
  private async create(): Promise<void> {
    if (!await this.discardAllowed()) return;
    await this.list();
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
        await this.load(pending.draftId, pending.expectedAuthority);
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
    await this.load(draftId, expectedAuthority); await this.list();
  }
  private async save(): Promise<void> {
    const editor = this.view.editor;
    if (!editor || editor.readOnlyReason) throw new Error(editor?.readOnlyReason ?? 'Open a live draft before saving.');
    if (!editor.name.trim()) throw new Error('A bounded display name is required.');
    const issue = inputIssue(editor.inputText); if (issue) throw new Error(issue);
    const key = JSON.stringify([editor.record.draftId, editor.authority, editor.head, editor.record.lifecycleEpoch, editor.name, editor.inputText]);
    if (this.pendingSave?.key !== key) this.pendingSave = { key, operationId: randomUUID() };
    const operationId = this.pendingSave.operationId; this.view.operationId = operationId;
    let result: AuthorResult;
    try {
      result = await this.input(editor.inputText, (file) => this.call('save', [editor.record.draftId,
        '--input', file, '--name', editor.name, '--operation-id', operationId,
        '--expected-head', editor.head, '--expected-authority', editor.authority,
        '--epoch', String(editor.record.lifecycleEpoch)]));
    } catch (error) {
      // A generic timeout's replay command contains --input pointing at a request already removed
      // by the transport's finally block. Surface only its bounded diagnostic, never that replay.
      const message = errorMessage(error);
      const firstLine = message.split(/[\r\n]/u)[0] ?? '';
      const reportedCode = /\bWCA_[A-Z_]{1,64}\b/u.exec(message)?.[0];
      const diagnostic = firstLine.includes('--input')
        ? `Shared Save was not acknowledged${reportedCode ? ` (reported ${reportedCode})` : ''}.` : firstLine;
      throw new Error(`${diagnostic}\nCheck workflow author op-status ${operationId} first. Then use explicit Save with the retained editor text; unchanged text reuses this operation ID and creates a fresh private input file. Do not replay a temporary --input path.`);
    }
    const saved = record(result.data.record);
    if (result.status !== 'shared-acknowledged' || authority(result.capability?.repository) !== editor.authority || saved.draftId !== editor.record.draftId
        || result.data.operationId !== operationId) throw new Error('Save was not shared-acknowledged. Resolve the displayed operation ID before retrying.');
    // An exact idempotent retry can acknowledge an older revision after a peer has moved the global
    // head. Keep the operation's head, not that newer observation, so the next Save still fences it.
    editor.head = head(result.data.operationHead)!; editor.record = saved;
    editor.savedName = editor.name; editor.savedText = editor.inputText;
    editor.binding = randomUUID();
    editor.readOnlyReason = result.data.currentLifecycle === 'deleted' ? 'The acknowledged operation is historical; this draft has since been deleted.' : null;
    this.view.dirty = false; this.view.show = null; this.pendingSave = null;
    this.view.notice = `Revision ${saved.revision} shared-acknowledged. Save is storage only, not approval, publication or execution.`;
    try { await this.list(); } catch (error) {
      this.view.notice += ` List refresh failed: ${errorMessage(error)} The Save acknowledgement is retained.`;
    }
  }
  private async show(): Promise<void> {
    const editor = this.view.editor;
    if (!editor) throw new Error('Open a draft before requesting Show.');
    const result = await this.call('show', [editor.record.draftId, '--revision', String(editor.record.revision)]);
    const view = result.data.view;
    if (result.status !== 'read' || authority(result.capability?.repository) !== editor.authority || !object(view) || !object(view.subject)
        || view.subject.draftId !== editor.record.draftId || view.subject.revisionSha256 !== editor.record.revisionSha256) {
      throw new Error('Show did not match the retained saved revision.');
    }
    this.view.show = view;
    this.view.notice = 'Show describes the exact saved revision, not unsaved editor text. Complete package validation and execution readiness are unavailable.';
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
    this.view.notice = result.data.status === 'shared-acknowledged'
      ? `Operation ${operationId} is shared-acknowledged. This can be historical storage acknowledgement, not readiness. Explicit Save of unchanged retained text reuses its operation ID.`
      : `Operation ${operationId} was not found at the observed store head. Use explicit Save with the retained text; unchanged text reuses this operation ID with a fresh private input file.`;
  }
  /** Closed host message boundary. Repository, head, epoch and operation authority are not inputs. */
  async receive(raw: unknown): Promise<void> {
    if (this.disposed || this.view.busy || !object(raw) || typeof raw.type !== 'string') return;
    const allowed = ['change', 'refresh', 'open', 'create', 'save', 'reload', 'show', 'operation-status', 'terminal-review', 'copilot-review'];
    if (!allowed.includes(raw.type)) { this.view.error = 'This shared-draft action is not supported.'; this.changed(); return; }
    if (Object.keys(raw).some((key) => !['type', 'binding', 'name', 'inputText', 'draftId'].includes(key))) {
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
    if (['save', 'reload', 'show', 'terminal-review', 'copilot-review'].includes(raw.type)
        && raw.binding !== this.view.editor?.binding) return;
    await this.leased(async () => {
      if (raw.type === 'refresh') { await this.list(); this.view.notice = 'Shared list refreshed. The open editor and its retained head have not been rebased.'; }
      else if (raw.type === 'create') await this.create();
      else if (raw.type === 'save') await this.save();
      else if (raw.type === 'show') await this.show();
      else if (raw.type === 'operation-status') await this.operationStatus();
      else if (raw.type === 'reload') {
        const editor = this.view.editor;
        if (editor && await this.discardAllowed()) { await this.load(editor.record.draftId, editor.authority); this.view.notice = 'Loaded the latest shared revision.'; }
      } else if (raw.type === 'open') {
        if (typeof raw.draftId !== 'string' || !this.view.drafts.some((draft) => draft.draftId === raw.draftId)) {
          throw new Error('Choose one draft from the current shared list.');
        }
        const selectedAuthority = authority(this.view.authority);
        if (await this.discardAllowed()) { await this.load(raw.draftId, selectedAuthority); this.view.notice = 'Opened the shared draft; no local copy was created.'; }
      } else if (raw.type === 'terminal-review' || raw.type === 'copilot-review') {
        const id = this.view.editor?.record.draftId;
        if (id) { await this.presentation.copyReview(this.view.repository, ['workflow', 'author', 'delete', id], raw.type === 'terminal-review' ? 'shell' : 'copilot');
          this.view.notice = 'Review route copied. Nothing was deleted; headless Copilot returns a terminal handoff, and only the terminal can separately present the current revision.'; }
      }
    });
  }
}

/**
 * The VS Code 1.90 ChatRequest API exposes references, not native Copilot attachment bytes.
 * Only a genuine host-provided file Uri is a candidate for governed local-file import. A Location
 * carries a range that this whole-file path cannot honor, so it is not imported. The
 * engine still reopens, validates, and hashes the original bytes; this module never interprets a
 * model description, thumbnail, prompt path, or arbitrary string as an attachment.
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type * as vscode from 'vscode';

export type ChatFilePreviewInput = Readonly<{
  kind: 'local-file';
  paths: readonly string[];
  feedback: string;
}>;

export type ChatFilePreviewRefusal = Readonly<{
  kind: 'unavailable';
  code: 'REV_CHAT_ATTACHMENT_UNAVAILABLE' | 'REV_ATTACHMENT_FEEDBACK';
  reason: string;
}>;

type Reference = Pick<vscode.ChatPromptReference, 'value' | 'range'>;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HANDLE = /^[A-Za-z0-9_-]{32}$/;
const MAX_PENDING = 8;
const HANDLE_TTL_MS = 10 * 60 * 1000;

export type PendingChatAttachment = Readonly<{
  repositoryRoot: string;
  workId: string;
  phaseId: string;
  phaseGeneration: number;
  localPaths: readonly string[];
  feedback: string;
  planSha256: string;
  attachments: readonly Readonly<{
    originalSha256: string;
    displayName: string;
    mediaType: string;
    bytes: number;
  }>[];
}>;

export type PendingChatAttachmentRemoval = Readonly<{
  repositoryRoot: string;
  workId: string;
  phaseId: string;
  phaseGeneration: number;
  attachmentSetSha256: string;
  planSha256: string;
}>;

export type ChatAttachmentAction =
  | Readonly<{ kind: 'preview' }>
  | Readonly<{ kind: 'status' }>
  | Readonly<{ kind: 'remove'; attachmentSetSha256: string }>
  | Readonly<{ kind: 'unavailable'; reason: string }>;

/** Commands must be exact; a chat reference cannot be silently ignored during status/removal. */
export function chatAttachmentAction(prompt: string, referenceCount: number): ChatAttachmentAction {
  const value = prompt.trim();
  if (/^status$/i.test(value)) {
    return referenceCount === 0 ? { kind: 'status' }
      : { kind: 'unavailable', reason: 'Status does not accept chat file references. Remove them and retry.' };
  }
  const remove = /^remove\s+(sha256:[a-f0-9]{64})$/i.exec(value);
  if (remove?.[1]) {
    return referenceCount === 0 ? { kind: 'remove', attachmentSetSha256: remove[1].toLowerCase() }
      : { kind: 'unavailable', reason: 'Removal does not accept chat file references. Remove them and retry.' };
  }
  if (/^(?:status|remove)\b/i.test(value)) {
    return { kind: 'unavailable', reason: 'Use `status` or `remove sha256:<exact 64-hex set digest>` with no file references.' };
  }
  return { kind: 'preview' };
}

/** Project the status envelope to digest/state only; never render stored file or feedback metadata. */
export function chatAttachmentStatusSets(value: unknown): ReadonlyArray<Readonly<{
  attachmentSetSha256: string; status: 'active' | 'revoked'
}>> | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const seen = new Set<string>();
  const sets = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    if (typeof record.attachmentSetSha256 !== 'string' || !DIGEST.test(record.attachmentSetSha256)
        || (record.status !== 'active' && record.status !== 'revoked')
        || seen.has(record.attachmentSetSha256)) return null;
    seen.add(record.attachmentSetSha256);
    sets.push(Object.freeze({ attachmentSetSha256: record.attachmentSetSha256, status: record.status }));
  }
  return sets;
}

export function matchesChatRemovalPlan(plan: unknown, expected: {
  workId: string; phaseId: string; attachmentSetSha256: string
}): plan is {
  kind: string; workId: string; phaseId: string; phaseGeneration: number;
  attachmentSetSha256: string; planSha256: string
} {
  if (!plan || typeof plan !== 'object') return false;
  const record = plan as Record<string, unknown>;
  return record.kind === 'revision-feedback-attachment-revocation-plan'
    && record.workId === expected.workId && record.phaseId === expected.phaseId
    && record.attachmentSetSha256 === expected.attachmentSetSha256
    && typeof record.planSha256 === 'string' && DIGEST.test(record.planSha256)
    && Number.isSafeInteger(record.phaseGeneration) && (record.phaseGeneration as number) >= 0
    && Array.isArray(record.expectedEffects)
    && record.expectedEffects.length === 2
    && record.expectedEffects[0] === 'append-local-revocation'
    && record.expectedEffects[1] === 'exclude-set-from-future-routing'
    && typeof record.expiresAt === 'string' && Number.isFinite(Date.parse(record.expiresAt))
    && Date.parse(record.expiresAt) > Date.now();
}

export function matchesChatRemovalReceipt(receipt: unknown, pending: PendingChatAttachmentRemoval): boolean {
  if (!receipt || typeof receipt !== 'object') return false;
  const record = receipt as Record<string, unknown>;
  return record.kind === 'revision-feedback-attachment-revocation'
    && record.workId === pending.workId && record.phaseId === pending.phaseId
    && record.phaseGeneration === pending.phaseGeneration
    && record.attachmentSetSha256 === pending.attachmentSetSha256
    && record.planSha256 === pending.planSha256
    && typeof record.revocationSha256 === 'string' && DIGEST.test(record.revocationSha256);
}

/** Separate one-use capability for the irreversible routing exclusion confirmation. */
export class ChatAttachmentRemovals {
  private readonly pending = new Map<string, { input: PendingChatAttachmentRemoval; expiresAt: number }>();

  issue(input: PendingChatAttachmentRemoval, now = Date.now()): string {
    if (!path.isAbsolute(input.repositoryRoot) || !input.workId || !input.phaseId
      || !Number.isSafeInteger(input.phaseGeneration) || input.phaseGeneration < 0
      || !DIGEST.test(input.attachmentSetSha256) || !DIGEST.test(input.planSha256)
      || !Number.isFinite(now)) {
      throw new Error('Cannot offer removal confirmation for an incomplete attachment set.');
    }
    for (const [handle, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(handle);
    }
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    let handle: string;
    do { handle = randomBytes(24).toString('base64url'); }
    while (this.pending.has(handle));
    this.pending.set(handle, { input: Object.freeze({ ...input }), expiresAt: now + HANDLE_TTL_MS });
    const cleanup = setTimeout(() => this.pending.delete(handle), HANDLE_TTL_MS);
    cleanup.unref?.();
    return handle;
  }

  take(handle: unknown, now = Date.now()): PendingChatAttachmentRemoval | null {
    if (typeof handle !== 'string' || !HANDLE.test(handle) || !Number.isFinite(now)) return null;
    const entry = this.pending.get(handle);
    this.pending.delete(handle);
    return entry && entry.expiresAt > now ? entry.input : null;
  }

  clear(): void { this.pending.clear(); }
}

/** Verify that a CLI registration response is exactly the ordered, select-all set confirmed. */
export function matchesChatAttachmentReceipt(receipt: unknown, pending: PendingChatAttachment): boolean {
  if (!receipt || typeof receipt !== 'object') return false;
  const record = receipt as {
    kind?: unknown; workId?: unknown; phaseId?: unknown; phaseGeneration?: unknown;
    importPlanSha256?: unknown; attachmentSetSha256?: unknown;
    attachments?: unknown
  };
  if (record.kind !== 'revision-feedback-attachment-set'
    || record.workId !== pending.workId || record.phaseId !== pending.phaseId
    || record.phaseGeneration !== pending.phaseGeneration
    || record.importPlanSha256 !== pending.planSha256
    || !DIGEST.test(String(record.attachmentSetSha256 ?? ''))
    || !Array.isArray(record.attachments)
    || record.attachments.length !== pending.attachments.length) return false;
  return record.attachments.every((value: unknown, index: number) => {
    if (!value || typeof value !== 'object') return false;
    const attachment = value as Record<string, unknown>;
    const selected = pending.attachments[index];
    return selected !== undefined && attachment.originalSha256 === selected.originalSha256
      && attachment.displayName === selected.displayName
      && attachment.mediaType === selected.mediaType
      && attachment.bytes === selected.bytes;
  });
}

/** In-memory, one-use UI capability. Command arguments contain only this random handle. */
export class ChatAttachmentConfirmations {
  private readonly pending = new Map<string, { input: PendingChatAttachment; expiresAt: number }>();

  issue(input: PendingChatAttachment, now = Date.now()): string {
    if (!path.isAbsolute(input.repositoryRoot)
      || input.localPaths.length < 1 || input.localPaths.length > 5
      || input.localPaths.length !== input.attachments.length
      || input.localPaths.some((item) => !path.isAbsolute(item))
      || new Set(input.localPaths.map((item) => path.normalize(item).toLowerCase())).size !== input.localPaths.length
      || input.attachments.some((item) => !DIGEST.test(item.originalSha256)
        || !item.displayName || !item.mediaType || !Number.isSafeInteger(item.bytes) || item.bytes < 1)
      || !input.workId || !input.phaseId || !Number.isSafeInteger(input.phaseGeneration)
      || input.phaseGeneration < 0 || !input.feedback.trim()
      || Buffer.byteLength(input.feedback) > 8192 || !DIGEST.test(input.planSha256)
      || !Number.isFinite(now)) {
      throw new Error('Cannot offer confirmation for an incomplete attachment preview.');
    }
    this.prune(now);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    let handle: string;
    do { handle = randomBytes(24).toString('base64url'); }
    while (this.pending.has(handle));
    this.pending.set(handle, {
      input: Object.freeze({ ...input,
        localPaths: Object.freeze([...input.localPaths]),
        attachments: Object.freeze(input.attachments.map((item) => Object.freeze({ ...item })))
      }), expiresAt: now + HANDLE_TTL_MS
    });
    const cleanup = setTimeout(() => this.pending.delete(handle), HANDLE_TTL_MS);
    cleanup.unref?.();
    return handle;
  }

  take(handle: unknown, now = Date.now()): PendingChatAttachment | null {
    if (typeof handle !== 'string' || !HANDLE.test(handle) || !Number.isFinite(now)) return null;
    const entry = this.pending.get(handle);
    this.pending.delete(handle);
    return entry && entry.expiresAt > now ? entry.input : null;
  }

  clear(): void { this.pending.clear(); }

  private prune(now: number): void {
    for (const [handle, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(handle);
    }
  }
}

function filePath(value: unknown, isHostUri: (value: unknown) => boolean): string | null {
  if (!isHostUri(value) || !value || typeof value !== 'object') return null;
  const candidate = value as {
    scheme?: unknown; fsPath?: unknown;
    authority?: unknown; query?: unknown; fragment?: unknown
  };
  if (candidate.scheme === 'file' && typeof candidate.fsPath === 'string'
      && path.isAbsolute(candidate.fsPath) && Buffer.byteLength(candidate.fsPath) <= 4096
      && (candidate.authority === undefined || candidate.authority === '' || candidate.authority === 'localhost')
      && (candidate.query === undefined || candidate.query === '')
      && (candidate.fragment === undefined || candidate.fragment === '')
      && !/[\u0000-\u001f\u007f]/.test(candidate.fsPath)) {
    return candidate.fsPath;
  }
  return null;
}

/** Every supplied reference must be a host-resolved local file; all files are selected whole. */
export function chatFilePreviewInput(
  prompt: string,
  references: readonly Reference[] | undefined,
  isHostUri: (value: unknown) => boolean
): ChatFilePreviewInput | ChatFilePreviewRefusal {
  const supplied = references ?? [];
  if (supplied.length < 1 || supplied.length > 5) {
    return {
      kind: 'unavailable', code: 'REV_CHAT_ATTACHMENT_UNAVAILABLE',
      reason: supplied.length === 0
        ? 'No verifiable local file reference was supplied to @sflow.'
        : 'Attach at most five local files for one preview. Other chat references are not imported.'
    };
  }
  const paths = supplied.map((reference) => filePath(reference?.value, isHostUri));
  if (paths.some((item) => !item)) {
    return {
      kind: 'unavailable', code: 'REV_CHAT_ATTACHMENT_UNAVAILABLE',
      reason: 'One or more references are not verifiable local files. Mixed, opaque, and model-described attachments cannot be registered as original bytes.'
    };
  }
  const localPaths = paths as string[];
  if (new Set(localPaths.map((item) => path.normalize(item).toLowerCase())).size !== localPaths.length) {
    return {
      kind: 'unavailable', code: 'REV_CHAT_ATTACHMENT_UNAVAILABLE',
      reason: 'The same local file was referenced more than once. Attach each original only once.'
    };
  }
  let feedback = prompt;
  const ranges: Array<[number, number]> = [];
  for (const reference of supplied) {
    const range = reference?.range;
    if (range === undefined) continue;
    if (!Array.isArray(range) || range.length !== 2) {
      return {
        kind: 'unavailable', code: 'REV_CHAT_ATTACHMENT_UNAVAILABLE',
        reason: 'A file reference has an invalid prompt range; authored feedback cannot be distinguished safely.'
      };
    }
    const [start, end] = range;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end <= start || end > prompt.length) {
      return {
        kind: 'unavailable', code: 'REV_CHAT_ATTACHMENT_UNAVAILABLE',
        reason: 'A file reference has an invalid prompt range; authored feedback cannot be distinguished safely.'
      };
    }
    ranges.push([start, end]);
  }
  ranges.sort((left, right) => right[0] - left[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]![1] > ranges[index - 1]![0]) {
      return {
        kind: 'unavailable', code: 'REV_CHAT_ATTACHMENT_UNAVAILABLE',
        reason: 'File-reference prompt ranges overlap; authored feedback cannot be distinguished safely.'
      };
    }
  }
  for (const [start, end] of ranges) {
    feedback = `${feedback.slice(0, start)} ${feedback.slice(end)}`;
  }
  feedback = feedback.trim();
  if (!feedback || Buffer.byteLength(feedback) > 8192) {
    return {
      kind: 'unavailable', code: 'REV_ATTACHMENT_FEEDBACK',
      reason: 'Write bounded, nonempty feedback alongside the local file reference.'
    };
  }
  return { kind: 'local-file', paths: localPaths, feedback };
}

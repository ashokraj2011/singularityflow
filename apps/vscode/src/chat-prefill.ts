/**
 * The next SFlow command, put in Copilot Chat's input box and never sent (owner, 2026-11-16).
 *
 * The command is the Story's next action as the journey already computes it from the engine's own
 * readiness, decision and step-sheet fields, through the engine's command crosswalk. Nothing here
 * chooses a command, and no model is asked: the fill is `workbench.action.chat.open` with
 * `isPartialQuery`, which only sets the input's text.
 *
 * Only a chat route is filled: a `/sf-*` skill or an `@sflow` command. A next action with no chat
 * route (terminal only), or one someone else takes, fills nothing.
 *
 * VS Code 1.146 fills the chat the person focused last, whatever kind of session it holds: the
 * Copilot agent's, or a Copilot CLI session (`copilotcli:`) in the Chat view or an editor. Only with
 * no chat focused yet does it open the Chat view. It always focuses that chat's input when it does,
 * and it replaces whatever the input held. So the automatic fill waits while the person types in an
 * editor or in a chat input, never replaces text they wrote there, fills only where a chat is open,
 * and waits for an `@sflow` request to finish.
 *
 * VS Code does not say whether a Copilot request is running, and a step usually publishes in the middle
 * of one: a fill then, and an Enter, would steer or queue into that turn. SFlow's own prompt and stop
 * hooks keep an open-turn marker for a repository that uses SFlow (copilotTurnDirectory() in
 * src/copilot-mode.mjs), so the fill waits until the turn has ended and then fills the state it ended
 * on. A marker older than TURN_STALE_MS (a turn that crashed or never stopped) is ignored, and
 * removeOldCopilotTurns clears this repository's that are older than a day when the extension starts.
 * The hooks never sweep: their only work is the one write and its removal.
 *
 * No `vscode` import: extension.ts supplies the host, so tests drive this in plain Node.
 */
import { readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { RepositorySnapshot } from './cli/snapshot.ts';
import { routedCommandGuidance } from './copilot-command.ts';
import { carryRoute, isTaskStory, TASK_ROUTE, withTaskRoute } from '../../../src/safe-command-guidance.mjs';
import { buildJourney } from './views/journey-model.ts';
import { startsFreshChat } from './views/submission-presentation.ts';

/** The setting that turns the automatic fill off; the status-bar button keeps working. */
export const PREFILL_SETTING = 'chat.prefillNextCommand';
export const PREFILL_COMMAND = 'singularityFlow.prefillNextCommand';
/** Continue: sends the Story's one way on to the chat the person used last [owner, 2026-11-28]. */
export const CONTINUE_COMMAND = 'singularityFlow.continueStory';
/** The documents VS Code gives extensions for chat inputs: a window's chats, and the Agents window's. */
export const CHAT_INPUT_SCHEMES: readonly string[] = Object.freeze(['chatSessionInput', 'sessions-chat']);
const FILLED_KEY = 'singularityFlow.chatPrefill.filled';

/** A `/sf-*` skill or an `@sflow` command, with plain arguments. Anything else is not filled. */
const CHAT_ROUTE = /^(?:\/sf-[a-z0-9]+(?:-[a-z0-9]+)*|@sflow \/[a-z0-9]+(?:-[a-z0-9]+)*)(?: [A-Za-z0-9._:/=@,+#-]+)*$/u;

export interface ChatPrefillAction {
  /** Exactly what goes in the chat input, before the trailing space. */
  command: string;
  /** The skill or participant command alone, for the status bar. */
  head: string;
  label: string;
  reason: string;
  workId: string;
  /** The Story state this action belongs to: one automatic fill per state. */
  stateKey: string;
  /**
   * Review, submission and approval cost less from a new chat (startsFreshChat). Said, never done:
   * a new chat from here could change the session's kind, and the fill belongs in the person's own.
   */
  freshChat: boolean;
}

export function isChatRoute(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && CHAT_ROUTE.test(value);
}

interface SheetView { next: { effect?: unknown; available?: unknown; where?: { copilot?: unknown } | null } | null; waitingFor: unknown }

function sheetOf(value: unknown): SheetView | null {
  if (!value || typeof value !== 'object') return null;
  const sheet = value as { next?: unknown; waitingFor?: unknown };
  const next = sheet.next && typeof sheet.next === 'object' ? sheet.next as SheetView['next'] : null;
  return { next, waitingFor: sheet.waitingFor ?? null };
}

/**
 * The person's next action in this snapshot as a chat command, or null when there is none to fill.
 *
 * The journey's next action covers generation, source review, submission, after-step deliveries
 * and decisions. A step awaiting approval has none there; the step sheet says whether this person
 * may approve now, and the engine's approve command gives its route. When the sheet names someone
 * else as the one who clears what the step waits on, the action is theirs and nothing is filled.
 */
export function nextChatPrefill(snapshot: RepositorySnapshot | null | undefined): ChatPrefillAction | null {
  const workflow = snapshot?.workflow;
  const workId = workflow?.workItem?.id;
  const phaseId = workflow?.currentPhase;
  if (!workflow || !workId || !phaseId) return null;
  if (snapshot.included && !snapshot.included.includes('lifecycle')) return null;
  const phase = workflow.phases?.[phaseId];
  if (!phase) return null;
  const readiness = snapshot.submissionReadiness?.phaseId === phaseId ? snapshot.submissionReadiness : null;
  const sheet = sheetOf(readiness?.sheet);
  if (sheet?.waitingFor) return null;

  const next = buildJourney(snapshot).nextAction;
  // The decision list is next because the sheet says so; where its step has no chat route, only the
  // person's terminal or the Decide card takes it.
  if (next?.execution === 'decide-list' && sheet?.next && !isChatRoute(sheet.next.where?.copilot)) return null;
  let command: string | null = isChatRoute(next?.copilotCommand) ? next.copilotCommand : null;
  let skill: string | null = next?.skill ?? null;
  let label = next?.label ?? next?.reason ?? '';
  let reason = next?.reason ?? '';
  // The sheet says whether this approval is the person's and whether a chat takes it (a signature
  // in their own terminal has no chat route); the engine's approve command gives the route itself.
  if (!next && phase.status === 'awaiting_approval' && sheet?.next?.effect === 'approves' && sheet.next.available !== false
      && isChatRoute(sheet.next.where?.copilot)) {
    const approve = routedCommandGuidance({ command: readiness?.nextCommand, skill: '/sf-approve' });
    if (approve && isChatRoute(approve.copilotCommand)) {
      command = approve.copilotCommand;
      skill = approve.skill;
      label = `Review and approve ${phase.label}`;
      reason = `${phase.label} waits for your approval.`;
    }
  }
  if (!command) return null;
  // A task's Story goes on with /sf-task in the same chat, whatever turn comes next [ITW:REQ-008] (withTaskRoute).
  command = withTaskRoute(workflow, { skill, copilotCommand: command }).copilotCommand ?? command;
  const stateKey = JSON.stringify([workId, phaseId, phase.status, phase.generation,
    workflow.pendingDecision?.key ?? null, command]);
  const head = command.split(' ').slice(0, command.startsWith('@sflow ') ? 2 : 1).join(' ');
  return { command, head, label, reason, workId, stateKey, freshChat: startsFreshChat(command) };
}

/**
 * What the chat is sent once a person approved a step on a page (the approval page the chat's own approve flow opened, the
 * Approvals list, the Journey, the tree) [ITW:REQ-008; owner, 2026-11-28: every Story carries on like a task]: the Story's
 * one way on, `/sf-task` on a task and `/sf-next` on any other, in the chat the person used last, never a new one, and only
 * once that step reads approved, or reads sent back by the person (owner, 2026-11-28: a page's Send back carries the chat on
 * as its approval does): their open send-back from that step, never SFlow's own, whose target is now the Story's step, so the
 * chat writes its next version. A closed Story has nothing to carry on.
 */
export function taskChatContinuation(workflow: unknown, workId: string, phaseId: string): string | null {
  type SendBack = { automatic?: unknown; status?: unknown; sourcePhase?: unknown; targetPhase?: unknown };
  const story = workflow as { workItem?: { id?: unknown }; status?: unknown; currentPhase?: unknown;
    phases?: Record<string, { status?: unknown } | undefined>; changeRequests?: SendBack[] } | null | undefined;
  if (!story || !workId || story.workItem?.id !== workId || story.status === 'closed') return null;
  if (story.phases?.[phaseId]?.status === 'approved') return carryRoute(story);
  const sentBack = (Array.isArray(story.changeRequests) ? story.changeRequests : []).some((entry) => entry && !entry.automatic
    && entry.status === 'open' && entry.sourcePhase === phaseId && entry.targetPhase === story.currentPhase);
  return sentBack ? carryRoute(story) : null;
}

/**
 * What the chat is sent once a person decided on the Decide card what a task's step waited on (a refactor's behaviour)
 * [ITW:REQ-008, REQ-015]: `/sf-task`, in the chat the person used last, as after a page approval, when the record said the
 * task goes on (`decisions record`'s `continueTask`) and the card was not a chat's own: that chat's turn reads the same answer.
 * Null for any other Story or answer.
 */
export function taskDecisionContinuation(workflow: unknown, workId: string, result: { continueTask?: unknown } | null | undefined,
  { askedInChat = false }: { askedInChat?: boolean } = {}): string | null {
  const story = workflow as { workItem?: { id?: unknown }; status?: unknown } | null | undefined;
  if (askedInChat || !story || !workId || story.workItem?.id !== workId || !isTaskStory(story) || story.status === 'closed') return null;
  return result?.continueTask === TASK_ROUTE ? TASK_ROUTE : null;
}

// --- Copilot turns in flight ---------------------------------------------------------------------

/**
 * How long an open-turn marker holds the fill. A turn that runs tests can take many minutes, and a fill
 * in the middle of one (an Enter then steers it) is worse than a late fill after a turn that crashed and
 * never closed its marker; the Next button fills at any time. Past this the marker is ignored.
 */
export const TURN_STALE_MS = 30 * 60 * 1000;
/** A marker this old is a turn that crashed: the extension removes this repository's when it starts. */
export const TURN_REMOVE_AFTER_MS = 24 * 60 * 60 * 1000;

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Whether a Copilot turn is open in this repository, from the markers the hooks keep in `directory`, and
 * when the newest stops counting. A turn counts when its chat's folder holds the repository or lies inside
 * it. Bounded: at most 200 markers of 4 KiB, local reads only.
 */
export async function copilotTurnOpen(directory: string, repository: string,
  { now = Date.now(), staleMs = TURN_STALE_MS }: { now?: number; staleMs?: number } = {}): Promise<{ open: boolean; until: number | null }> {
  let names: string[];
  try { names = await readdir(directory); } catch { return { open: false, until: null }; }
  const root = await realpath(repository).catch(() => path.resolve(repository));
  let until: number | null = null;
  for (const name of names.filter((entry) => /^[a-f0-9]{64}$/u.test(entry)).slice(0, 200)) {
    try {
      const file = path.join(directory, name);
      const info = await stat(file);
      const expires = info.mtimeMs + staleMs;
      if (!info.isFile() || info.size > 4096 || expires <= now) continue;
      const folder = (await readFile(file, 'utf8')).split(/\r?\n/u)[0]?.trim() ?? '';
      if (!folder || !path.isAbsolute(folder)) continue;
      const cwd = await realpath(folder).catch(() => path.resolve(folder));
      if (within(root, cwd) || within(cwd, root)) until = Math.max(until ?? 0, expires);
    } catch { /* a marker removed while it was read is a turn that ended */ }
  }
  return { open: until !== null, until };
}

/**
 * Remove this repository's markers older than a day: a crashed turn's, which nothing else removes. Only a
 * marker whose chat folder is the repository or inside it; another repository's or a parent folder's chat is
 * left alone. Bounded as copilotTurnOpen; returns how many went.
 */
export async function removeOldCopilotTurns(directory: string, repository: string,
  { now = Date.now(), olderThanMs = TURN_REMOVE_AFTER_MS }: { now?: number; olderThanMs?: number } = {}): Promise<number> {
  let names: string[];
  try { names = await readdir(directory); } catch { return 0; }
  const root = await realpath(repository).catch(() => path.resolve(repository));
  let removed = 0;
  for (const name of names.filter((entry) => /^[a-f0-9]{64}$/u.test(entry)).slice(0, 200)) {
    try {
      const file = path.join(directory, name);
      const info = await stat(file);
      if (!info.isFile() || info.size > 4096 || now - info.mtimeMs < olderThanMs) continue;
      const folder = (await readFile(file, 'utf8')).split(/\r?\n/u)[0]?.trim() ?? '';
      if (!folder || !path.isAbsolute(folder)) continue;
      const cwd = await realpath(folder).catch(() => path.resolve(folder));
      if (!within(root, cwd)) continue;
      await unlink(file);
      removed += 1;
    } catch { /* already gone, or not ours to judge */ }
  }
  return removed;
}

// --- @sflow requests in flight ------------------------------------------------------------------

/**
 * VS Code says nothing to an extension about Copilot's requests, but SFlow's own participant knows
 * when it is answering. sflow-chat.ts brackets each request; the fill waits until none is running.
 */
const participant = { running: 0, listeners: new Set<() => void>() };

export function participantRequestStarted(): void { participant.running += 1; }

export function participantRequestEnded(): void {
  participant.running = Math.max(0, participant.running - 1);
  if (!participant.running) for (const listener of participant.listeners) listener();
}

export function participantRequestRunning(): boolean { return participant.running > 0; }

function onParticipantIdle(listener: () => void): { dispose(): void } {
  participant.listeners.add(listener);
  return { dispose: () => { participant.listeners.delete(listener); } };
}

// --- The controller -----------------------------------------------------------------------------

export interface ChatPrefillHost {
  executeCommand(id: string, ...args: unknown[]): PromiseLike<unknown>;
  /** The automatic fill's setting; only `true` turns it on. */
  enabled(): boolean;
  /** Chat is turned off in this window (`chat.disableAIFeatures`). */
  chatDisabled(): boolean;
  /** The text of every open chat input; null when the host cannot tell. */
  chatInputs(): string[] | null;
  /** Whether a Copilot turn is open in the selected repository (copilotTurnOpen), and until when. */
  turnOpen?: () => Promise<{ open: boolean; until: number | null }>;
  /** The latest confirmed snapshot of the selected repository, and that repository. */
  current(): { snapshot: RepositorySnapshot | null; repository: string } | null;
  memento: { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> };
  status: { show(action: ChatPrefillAction): void; hide(): void };
  /** Said when the button is pressed with nothing to fill. */
  inform(message: string): void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ChatPrefillOptions {
  /** How long a record change settles before its action is read again. */
  settleMs?: number;
  /** Quiet time after the last keystroke the fill waits for. */
  quietMs?: number;
}

export type PrefillOutcome = 'filled' | 'off' | 'none' | 'same' | 'held' | 'turn' | 'busy' | 'typing' | 'composing' | 'no-chat' | 'failed';

export class ChatPrefill {
  private readonly host: ChatPrefillHost;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly settleMs: number;
  private readonly quietMs: number;
  private readonly filled: string[];
  private seen: string | null = null;
  private timer: unknown = null;
  private activityAt = Number.NEGATIVE_INFINITY;
  private ours: string | null = null;
  /** A prompt the extension sent itself: the state it was sent in is that chat's, not a fill's. */
  private hold: { key: string | null } | null = null;
  private readonly idle: { dispose(): void };
  /** What the last evaluation decided, for tests and the output channel. */
  last: PrefillOutcome | null = null;

  constructor(host: ChatPrefillHost, options: ChatPrefillOptions = {}) {
    this.host = host;
    this.now = host.now ?? Date.now;
    this.setTimer = host.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = host.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.settleMs = options.settleMs ?? 500;
    this.quietMs = options.quietMs ?? 4_000;
    const stored = host.memento.get<unknown>(FILLED_KEY);
    this.filled = Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === 'string').slice(-50) : [];
    this.idle = onParticipantIdle(() => { if (this.seen) this.schedule(0); });
  }

  private keyOf(repository: string, action: ChatPrefillAction): string {
    return JSON.stringify([repository, action.stateKey]);
  }

  private action(): { action: ChatPrefillAction; key: string } | null {
    const current = this.host.current();
    const action = current ? nextChatPrefill(current.snapshot) : null;
    return current && action ? { action, key: this.keyOf(current.repository, action) } : null;
  }

  /** A confirmed snapshot: show the button, and fill once when the next action changed. */
  observe(): void {
    const next = this.action();
    if (next) this.host.status.show(next.action); else this.host.status.hide();
    if (!next) { this.seen = null; this.cancel(); return; }
    if (next.key === this.seen) return;
    this.seen = next.key;
    this.schedule(this.settleMs);
  }

  /** Someone typed in an editor or in the chat input. */
  noteActivity(): void { this.activityAt = this.now(); }

  /** A chat input changed: the fill's own text is not the person typing. */
  noteChatInput(text: string): void {
    if (this.ours !== null && text.trim() === this.ours.trim()) return;
    this.noteActivity();
  }

  /** A turn marker appeared, changed or went: a state held for the turn is filled once it has ended. */
  turnChanged(): void {
    if (this.seen) this.schedule(this.settleMs);
  }

  /** The extension sent a whole prompt itself (a Copilot handoff): no fill over it. */
  noteRequestSent(): void {
    this.hold = { key: this.action()?.key ?? null };
  }

  private cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.cancel();
    this.timer = this.setTimer(() => { this.timer = null; void this.evaluate(); }, ms);
  }

  private remember(key: string): void {
    if (this.filled.includes(key)) return;
    this.filled.push(key);
    this.filled.splice(0, Math.max(0, this.filled.length - 50));
    void Promise.resolve(this.host.memento.update(FILLED_KEY, [...this.filled])).then(undefined, () => undefined);
  }

  /** The automatic fill, after a change has settled. */
  async evaluate(): Promise<PrefillOutcome> {
    const outcome = await this.decide();
    this.last = outcome;
    return outcome;
  }

  private async decide(): Promise<PrefillOutcome> {
    const next = this.action();
    if (!next) return 'none';
    if (this.host.enabled() !== true) return 'off';
    if (this.filled.includes(next.key)) return 'same';
    if (this.hold) {
      if (this.hold.key === null) this.hold.key = next.key;
      if (this.hold.key === next.key) { this.remember(next.key); return 'held'; }
      this.hold = null;
    }
    // A turn still answering: wait for its stop, or for its marker to go stale.
    const turn = this.host.turnOpen ? await this.host.turnOpen().catch(() => null) : null;
    if (turn?.open) {
      this.schedule(Math.max(0, (turn.until ?? this.now()) - this.now()) + 50);
      return 'turn';
    }
    if (participantRequestRunning()) return 'busy';
    const quiet = this.now() - this.activityAt;
    if (quiet < this.quietMs) { this.schedule(this.quietMs - quiet); return 'typing'; }
    if (this.host.chatDisabled()) return 'no-chat';
    const inputs = this.host.chatInputs();
    // No chat input open: opening the Chat view unasked would be the disruption. The button still fills.
    if (inputs && !inputs.length) return 'no-chat';
    // Text the person wrote is theirs. This state is not filled; the button still is.
    if (inputs?.some((text) => text.trim() && (this.ours === null || text.trim() !== this.ours.trim()))) {
      this.remember(next.key);
      return 'composing';
    }
    return await this.fill(next) ? 'filled' : 'failed';
  }

  private async fill(next: { action: ChatPrefillAction; key: string }): Promise<boolean> {
    const query = `${next.action.command} `;
    this.remember(next.key);
    try {
      this.ours = query;
      await this.host.executeCommand('workbench.action.chat.open', { query, isPartialQuery: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The button: fill again now, whatever was filled before, in the chat the person used last. It
   * opens no new chat, even for a step that costs less from one: VS Code's New Chat can start a
   * session of another kind than the person's Copilot CLI session, and the chat may still be answering.
   */
  async fillNow(): Promise<boolean> {
    const next = this.action();
    if (!next) {
      this.host.inform('Singularity Flow has no next command for Copilot Chat right now. Its next step, if any, is not a chat command or is someone else\'s.');
      return false;
    }
    this.cancel();
    return this.fill(next);
  }

  dispose(): void {
    this.cancel();
    this.idle.dispose();
  }
}

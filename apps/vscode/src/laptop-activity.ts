/**
 * This window's share of the laptop's activity stamp (src/machine-activity.mjs). Git work SFlow starts by itself, sharing
 * Spec Studio drafts and clean-up of finished Story folders, waits until the laptop has been idle [owner, 2026-11-19], so
 * what the person does here counts: edits, focus, terminals, SFlow commands and Spec Studio writing. The window's own
 * timers and CLI calls never count (cli/client.ts marks them). No vscode import, so it is checked without a host.
 */
import { DEFAULT_IDLE_MINUTES, idleState, noteActivity } from '../../../src/machine-activity.mjs';

const NOTE_EVERY_MS = 60_000;
let lastNoted = Number.NEGATIVE_INFINITY;

/** Record that the person did something; between the once-a-minute writes a keystroke costs nothing. */
export function noteLaptopActivity(now = Date.now()): void {
  if (now >= lastNoted && now - lastNoted < NOTE_EVERY_MS) return;
  lastNoted = now;
  noteActivity({ now });
}

/** The idle wait the person chose (singularityFlow.automaticWork.idleMinutes): whole minutes, 0 to a day. */
export function idleMinutesSetting(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1440 ? value : DEFAULT_IDLE_MINUTES;
}

/** Whether the laptop has been idle that long by the stamp, and the time left when not. */
export function laptopQuiet(idleMinutes: number, now = Date.now()): { idle: boolean; remainingMs: number } {
  const state = idleState({ now, idleMs: idleMinutesSetting(idleMinutes) * 60_000 });
  return { idle: state.idle, remainingMs: state.remainingMs };
}

/** How long sharing waits, in the words the Spec Studio header uses. */
export function idleWaitWords(idleMinutes: number): string {
  const minutes = idleMinutesSetting(idleMinutes);
  return minutes === 0 ? 'shares when saved' : `shares after ${minutes} minute${minutes === 1 ? '' : 's'} idle`;
}

type Listen<T> = ((listener: (event: T) => unknown) => { dispose(): unknown }) | undefined;
interface ActivitySources {
  window: {
    onDidChangeWindowState?: Listen<{ focused: boolean }>;
    onDidOpenTerminal?: Listen<unknown>;
    onDidChangeActiveTerminal?: Listen<unknown>;
    onDidChangeTerminalState?: Listen<unknown>;
    onDidStartTerminalShellExecution?: Listen<unknown>;
    onDidChangeTextEditorSelection?: Listen<{ kind?: number }>;
  };
  workspace: { onDidChangeTextDocument?: Listen<{ document: { uri: { scheme: string } }; contentChanges: readonly unknown[] }> };
}

/** Writing a person does: files, new files, notebooks and the chat box. Output and other generated text are not. */
const PERSON_SCHEMES = new Set(['file', 'untitled', 'vscode-notebook-cell', 'chatSessionInput', 'sessions-chat', 'comment']);

/** Listen where the person's activity shows. Each event is optional: an older VS Code simply has fewer. */
export function watchLaptopActivity(api: ActivitySources, note: () => void = noteLaptopActivity): Array<{ dispose(): unknown }> {
  const watch = <T>(event: Listen<T>, accept: (value: T) => boolean = () => true) =>
    typeof event === 'function' ? [event((value: T) => { if (accept(value)) note(); })] : [];
  return [
    ...watch(api.window.onDidChangeWindowState, state => state.focused),
    ...watch(api.window.onDidOpenTerminal), ...watch(api.window.onDidChangeActiveTerminal),
    ...watch(api.window.onDidChangeTerminalState), ...watch(api.window.onDidStartTerminalShellExecution),
    // Keyboard (1) and mouse (2) selections; one a command made (3) is not the person.
    ...watch(api.window.onDidChangeTextEditorSelection, change => change.kind === 1 || change.kind === 2),
    ...watch(api.workspace.onDidChangeTextDocument, change => change.contentChanges.length > 0 && PERSON_SCHEMES.has(change.document.uri.scheme))
  ];
}

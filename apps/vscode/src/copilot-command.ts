/**
 * One presentation boundary for a safe shell command and its direct Copilot equivalent.
 *
 * CLI responses are still treated as untrusted process output by the extension. A command is
 * displayable only when it is a bounded, credential-free SFlow invocation. The Copilot route is
 * then resolved through the engine-owned crosswalk; panels never manufacture `/sf-*` names from
 * command strings themselves.
 */
import { safeCommandGuidance } from '../../../src/safe-command-guidance.mjs';

export type CommandGuidance = Readonly<{
  command: string;
  executable: 'singularity-flow';
  argv: readonly string[];
  /** Null, with `copilotCommand`, for a command no packaged skill carries out. */
  skill: string | null;
  copilotCommand: string | null;
  modelFreeCommand: string | null;
  copyable: boolean;
  platformCommands: Readonly<{ darwin: string; linux: string; win32: string }> | null;
}>;

/**
 * Validate one surfaced command and supply both invocation forms.
 *
 * Missing route fields are derived for older envelopes. Supplied fields are assertions and must
 * exactly match the engine-owned crosswalk, including the intentional argument-preserving SGOS and
 * Auto relays. The shared validator also rejects unknown CLI families and shell syntax.
 */
export function commandGuidance(value: unknown): CommandGuidance | null {
  const guidance = safeCommandGuidance(value) as CommandGuidance | null;
  return guidance == null ? null : Object.freeze({
    command: guidance.command,
    executable: guidance.executable,
    argv: Object.freeze([...guidance.argv]),
    skill: guidance.skill,
    copilotCommand: guidance.copilotCommand,
    modelFreeCommand: guidance.modelFreeCommand,
    copyable: guidance.copyable,
    platformCommands: guidance.platformCommands
  });
}

/** Guidance for a command a packaged skill carries out, so both Copilot fields are present. */
export type RoutedCommandGuidance = CommandGuidance & Readonly<{ skill: string; copilotCommand: string }>;

/** `commandGuidance` for surfaces that only offer actions with a Copilot route; null otherwise. */
export function routedCommandGuidance(value: unknown): RoutedCommandGuidance | null {
  const guidance = commandGuidance(value);
  return guidance?.skill && guidance.copilotCommand ? guidance as RoutedCommandGuidance : null;
}

/** The value after a "Copilot:" label: the route, or the contract's words when no skill carries it out. */
export function copilotRouteText(command: string | null | undefined): string {
  return command || 'no verified equivalent';
}

/**
 * VS Code resolves a chat model before it delivers any participant request (1.142: `$invokeAgent`
 * awaits `getLanguageModelForRequest`), so with no model `@sflow` never runs, model-free or not.
 * sflow-chat.ts records whether any chat model is registered. Each bundle has its own copy of this
 * module, so the answer lives in one process-wide slot. Unknown keeps the plain route.
 */
const CHAT_MODELS = Symbol.for('singularityFlow.chatModels');
type ChatModelState = { available?: boolean; listeners: Set<() => void> };

function chatModelState(): ChatModelState {
  const slot = globalThis as unknown as Record<symbol, ChatModelState | undefined>;
  return slot[CHAT_MODELS] ??= { listeners: new Set() };
}

export function chatModelsMissing(): boolean {
  return chatModelState().available === false;
}

export function setChatModelsAvailable(available: boolean | undefined): void {
  const state = chatModelState();
  if (state.available === available) return;
  state.available = available;
  for (const listener of state.listeners) listener();
}

export function onChatModelsChanged(listener: () => void): { dispose(): void } {
  const { listeners } = chatModelState();
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
}

export const NO_CHAT_MODEL_NOTE = 'VS Code chat has no language model now, so it cannot reach @sflow; use Shell';

/** The value after a "VS Code (model-free):" label. */
export function modelFreeRouteText(command: string | null | undefined): string {
  if (!command) return 'not available for this action';
  // A Command Palette route (the Decide card) needs no chat model.
  return chatModelsMissing() && command.startsWith('@sflow') ? `${command} (${NO_CHAT_MODEL_NOTE})` : command;
}

/** HTML form of `modelFreeRouteText`; `escape` is the page's own escaper. */
export function modelFreeRouteHtml(command: string | null | undefined, escape: (value: string) => string): string {
  if (!command) return 'not available for this action';
  return `<code>${escape(command)}</code>${chatModelsMissing() && command.startsWith('@sflow') ? ` <span class="muted">(${escape(NO_CHAT_MODEL_NOTE)})</span>` : ''}`;
}

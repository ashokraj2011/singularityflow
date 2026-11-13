/**
 * Counting Copilot Chat in VS Code for Singularity Flow reports.
 *
 * Copilot Chat sends SFlow nothing until it writes its OpenTelemetry spans to a local file. With the
 * developer's consent, asked once, this sets Copilot Chat's own settings to write SFlow's file. Content
 * capture stays off, and an OpenTelemetry setup someone else configured is never changed. While
 * counting is on, a background sync records this repository's requests from the file; nothing is
 * committed, so a report shows only this computer's Copilot Chat use.
 */
import * as vscode from 'vscode';
import { showCompactInformationMessage } from './compact-message.ts';
import type { SingularityFlowClient } from './cli/client.ts';
import { copilotChatCounting, type CopilotChatCounting, type CopilotChatOtelSettings } from './copilot-chat-counting-state.ts';

export const COPILOT_CHAT_COUNTING_ASKED = 'singularityFlow.copilotChatCountingAsked';
const SECTION = 'github.copilot.chat.otel';
const COPILOT_CHAT = 'GitHub.copilot-chat';
const SYNC_INTERVAL_MS = 5 * 60_000;
const FIRST_SYNC_DELAY_MS = 30_000;
const OFFER_DELAY_MS = 20_000;
const COPILOT_CHAT_UNAVAILABLE = 'Copilot Chat\'s settings are not available in this window. Make sure Copilot Chat is installed and enabled, then try again.';
/**
 * Whether Copilot Chat is here. Its extension can run in another extension host, where
 * getExtension cannot see it; the settings it contributes are visible from every host.
 */
function copilotChatInstalled(): boolean {
  return vscode.extensions.getExtension(COPILOT_CHAT) !== undefined
    || vscode.workspace.getConfiguration(SECTION).inspect('enabled')?.defaultValue !== undefined;
}

/** What the person (not the defaults) set, the most specific scope winning. */
function explicitSettings(): CopilotChatOtelSettings {
  const config = vscode.workspace.getConfiguration(SECTION);
  const value = (key: string): unknown => {
    const inspected = config.inspect(key);
    return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  };
  return {
    enabled: value('enabled'), outfile: value('outfile'), exporterType: value('exporterType'),
    otlpEndpoint: value('otlpEndpoint'), captureContent: value('captureContent')
  };
}

async function usageFile(client: SingularityFlowClient): Promise<string> {
  return (await client.run<{ file: string }>(['telemetry', 'chat', '--json'])).file;
}

async function currentCounting(client: SingularityFlowClient): Promise<{ state: CopilotChatCounting; file: string }> {
  const file = await usageFile(client);
  return { state: copilotChatCounting(explicitSettings(), process.env, file), file };
}

/** Turn counting on (the person asked for it). Copilot Chat reads its settings at window load. */
export async function turnOnCopilotChatCounting(client: SingularityFlowClient): Promise<void> {
  const { state, file } = await currentCounting(client);
  if (state === 'on') {
    void showCompactInformationMessage('Copilot Chat usage is already counted on this computer.');
    return;
  }
  if (state === 'other-setup') {
    void showCompactInformationMessage('Copilot Chat already sends its OpenTelemetry somewhere else. Singularity Flow leaves that setup alone, so Copilot Chat is not counted in its reports.');
    return;
  }
  const config = vscode.workspace.getConfiguration(SECTION);
  try {
    await config.update('enabled', true, vscode.ConfigurationTarget.Global);
    await config.update('outfile', file, vscode.ConfigurationTarget.Global);
  } catch {
    // VS Code writes only settings a loaded extension declares: here, Copilot Chat's own.
    void showCompactInformationMessage(COPILOT_CHAT_UNAVAILABLE);
    return;
  }
  const choice = await showCompactInformationMessage(
    'Copilot Chat usage will be counted after the window reloads.', 'Reload Window');
  if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/** Turn counting off, removing only the settings Singularity Flow wrote. */
export async function turnOffCopilotChatCounting(client: SingularityFlowClient): Promise<void> {
  const { state } = await currentCounting(client);
  if (state !== 'on') {
    void showCompactInformationMessage('Singularity Flow is not counting Copilot Chat usage on this computer.');
    return;
  }
  const config = vscode.workspace.getConfiguration(SECTION);
  try {
    await config.update('enabled', undefined, vscode.ConfigurationTarget.Global);
    await config.update('outfile', undefined, vscode.ConfigurationTarget.Global);
  } catch {
    void showCompactInformationMessage(COPILOT_CHAT_UNAVAILABLE);
    return;
  }
  void showCompactInformationMessage('Copilot Chat usage is no longer counted. Requests already recorded stay in this computer\'s reports.');
}

const SESSION_SYNC_DELAY_MS = 45_000;

/**
 * Copilot's own session logs, recorded for this repository's Story reports. [owner, 2026-11-13]
 * Copilot CLI and VS Code's Copilot agent write every session's model calls, premium requests and
 * cache use there on their own, so this needs no consent or setting: once the window has settled,
 * and every few minutes after, the CLI records what they added (`telemetry sessions sync`), and Story
 * Analytics shows it without anyone running `report`. Kept in this module so the extension bundle
 * gains no file for it; it shares nothing with Copilot Chat's counting.
 */
export function startCopilotSessionSync(context: vscode.ExtensionContext, client: SingularityFlowClient,
  log: (line: string) => void): void {
  let running = false;
  const sync = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await client.run(['telemetry', 'sessions', 'sync', '--json'], undefined, { priority: 'background' });
    } catch (error) {
      log(`Copilot's session logs could not be read: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => { void sync(); }, SESSION_SYNC_DELAY_MS);
  const timer = setInterval(() => { void sync(); }, SYNC_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => { clearTimeout(first); clearInterval(timer); } });
}

/**
 * Ask once per computer, and only when it can work: Copilot Chat is installed and nobody has
 * configured its OpenTelemetry. Any answer, including closing the message, is final; the commands
 * still turn counting on or off later.
 */
export async function offerCopilotChatCounting(context: vscode.ExtensionContext, client: SingularityFlowClient,
  log: (line: string) => void): Promise<void> {
  if (context.globalState.get<boolean>(COPILOT_CHAT_COUNTING_ASKED, false)) return;
  if (!copilotChatInstalled()) {
    log('Copilot Chat counting not offered: Copilot Chat is not installed or is disabled.');
    return;
  }
  // Decided from the settings alone: any setup at all (SFlow's included) means there is nothing to ask.
  const state = copilotChatCounting(explicitSettings(), process.env, '');
  await context.globalState.update(COPILOT_CHAT_COUNTING_ASKED, true);
  if (state !== 'off') {
    log('Copilot Chat counting not offered: Copilot Chat\'s OpenTelemetry is already configured.');
    return;
  }
  const choice = await showCompactInformationMessage(
    'Count your Copilot Chat requests in Singularity Flow reports? Copilot Chat will write request counts, model names and token usage to a file on this computer: never your prompts, code or replies. It applies to all your VS Code windows, and nothing is shared.',
    'Turn on', 'No thanks');
  if (choice === 'Turn on') await turnOnCopilotChatCounting(client);
}

/**
 * Once the window has settled, offer counting (once per computer) and, while it is on, record this
 * repository's requests every few minutes. With counting off this never runs the CLI.
 */
export function startCopilotChatCounting(context: vscode.ExtensionContext, client: SingularityFlowClient,
  log: (line: string) => void): void {
  let running = false;
  const sync = async (): Promise<void> => {
    const settings = explicitSettings();
    if (running || settings.enabled !== true || typeof settings.outfile !== 'string') return;
    running = true;
    try {
      if ((await currentCounting(client)).state === 'on') {
        await client.run(['telemetry', 'chat', 'sync', '--json'], undefined, { priority: 'background' });
      }
    } catch (error) {
      log(`Copilot Chat usage could not be read: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };
  const offer = setTimeout(() => {
    void offerCopilotChatCounting(context, client, log).catch((error) => log(`Copilot Chat counting could not be offered: ${(error as Error).message}`));
  }, OFFER_DELAY_MS);
  const first = setTimeout(() => { void sync(); }, FIRST_SYNC_DELAY_MS);
  const timer = setInterval(() => { void sync(); }, SYNC_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => { clearTimeout(offer); clearTimeout(first); clearInterval(timer); } });
}

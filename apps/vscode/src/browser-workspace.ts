/** VS Code is a scoped launcher/bridge. The independent service remains owned by SFlow. */
import * as vscode from 'vscode';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SingularityFlowClient } from './cli/client.ts';
import { copilotPrompt, validSpecId } from './views/spec-studio-model.ts';

interface BrowserLaunch {
  url: string; instance: string; clientId: string; discoveryFile: string; bridgeModule: string;
  build: { fingerprint: string; engineRoot: string };
}
interface Handoff { type: string; root: string; specId?: string; menu?: string }
interface EditorBridge { dispose(): void }
interface BridgeModule { connectEditorBridge(options: {
  instance: string; build: string; root: string; clientId: string; discoveryFile: string; copilot: boolean;
  onRequest(request: Handoff): Promise<string>; onError(error: Error): void;
}): Promise<EditorBridge> }
const bridges = new Map<string, EditorBridge>();
const menus: Record<string, string> = {
  specs: 'singularityFlow.openSpecStudio', workflows: 'singularityFlow.openWorkflowStudio',
  stories: 'singularityFlow.openStories', intake: 'singularityFlow.startWork', run: 'singularityFlow.workspaceRunTest',
  decisions: 'singularityFlow.decisions', configuration: 'singularityFlow.openConfigurationCenter'
};
const copilotAvailable = (): boolean => Boolean(vscode.extensions.getExtension('GitHub.copilot-chat'))
  && vscode.workspace.getConfiguration('singularityFlow').get<string>('modelMode', 'auto') !== 'disabled'
  && !vscode.workspace.getConfiguration('chat').get<boolean>('disableAIFeatures', false);

export async function openBrowserWorkspace(client: SingularityFlowClient, context: vscode.ExtensionContext,
  output: { appendLine(line: string): void }): Promise<void> {
  if (vscode.env.remoteName || vscode.env.uiKind === vscode.UIKind.Web) {
    throw new Error('The browser workspace currently supports a local desktop extension host. Remote forwarding is not qualified yet; use the existing SFlow panels in this window.');
  }
  const repository = client.repository;
  const launch = await client.run<BrowserLaunch>(['ui', 'open', '--no-open', '--json']);
  const url = new URL(launch.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search
    || url.pathname !== '/' || !/^#ticket=[A-Za-z0-9_-]{43}$/u.test(url.hash)) {
    throw new Error('SFlow did not return a valid local browser bootstrap URL.');
  }
  try {
    if (typeof launch.bridgeModule !== 'string' || !path.isAbsolute(launch.bridgeModule)
      || path.relative(launch.build.engineRoot, launch.bridgeModule) !== path.join('src', 'local-ui', 'bridge-client.mjs')) {
      throw new Error('The CLI did not issue a bridge module belonging to its verified package. Reopen with matching installed builds.');
    }
    const module = await import(pathToFileURL(launch.bridgeModule).href) as BridgeModule;
    const bridge = await module.connectEditorBridge({ instance: launch.instance, build: launch.build.fingerprint,
      root: repository, clientId: launch.clientId, discoveryFile: launch.discoveryFile, copilot: copilotAvailable(),
      onRequest: async request => {
        if (client.repository !== repository) throw new Error('This VS Code window moved to a different checkout. Reopen the browser workspace from the intended window.');
        if (request.type === 'spec.assist') {
          if (!copilotAvailable() || !validSpecId(request.specId)) throw new Error('Copilot is unavailable or the specification is invalid.');
          await vscode.commands.executeCommand('workbench.action.chat.open', { query: copilotPrompt(request.specId, false), isPartialQuery: true });
          return 'Prepared the Spec Studio request in the matching Copilot window. Choose Send there. Model execution has not been observed.';
        }
        const command = request.type === 'native.menu' && request.menu ? menus[request.menu] : null;
        if (!command) throw new Error('This editor handoff is unsupported.');
        await vscode.commands.executeCommand(command, ...(request.menu === 'specs' && request.specId ? [request.specId] : []));
        return 'Opened the existing SFlow menu in the matching VS Code window.';
      }, onError: error => output.appendLine(`SFlow browser bridge: ${error.message}`) });
    const key = `${launch.instance}:${launch.clientId}`;
    bridges.set(key, bridge);
    context.subscriptions.push({ dispose: () => { bridge.dispose(); if (bridges.get(key) === bridge) bridges.delete(key); } });
  } catch (error) {
    output.appendLine(`SFlow editor bridge unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const opened = await vscode.env.openExternal(vscode.Uri.parse(launch.url));
  if (!opened) throw new Error('VS Code could not open the default browser. Run singularity-flow ui open from the same checkout.');
}

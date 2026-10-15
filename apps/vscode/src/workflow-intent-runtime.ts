/** Optional native-chat tool. Loaded only by an explicitly opened workflow designer. */
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
export { workflowIntentPrompt } from './views/workflow-intent-prompt.ts';

export const WORKFLOW_INTENT_TOOL = 'singularityFlow_workflowAuthoring';
interface Input { action: string; session: string; revision: number; source?: string; kind?: string; id?: string; query?: string; cursor?: number }
interface OptionalTools {
  lm?: { registerTool(name: string, tool: unknown): vscode.Disposable };
  LanguageModelTextPart?: new (text: string) => unknown;
  LanguageModelToolResult?: new (parts: unknown[]) => unknown;
}
const targets = new Map<string, (input: Input) => Promise<unknown>>();
let registration: vscode.Disposable | null = null;

function input(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Supply one workflow-authoring request.');
  const record = value as Record<string, unknown>;
  const fields = record.action === 'draft' ? ['source'] : record.action === 'asset' ? ['kind', 'id'] : ['kind', 'query', 'cursor'];
  if (Object.keys(record).some(key => !['action', 'session', 'revision', ...fields].includes(key))
      || !['catalog', 'asset', 'draft'].includes(String(record.action)) || typeof record.session !== 'string' || record.session.length > 64
      || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0) throw new Error('Use a known action and the exact open-designer session/revision.');
  for (const key of ['source', 'kind', 'id', 'query']) if (record[key] !== undefined && typeof record[key] !== 'string') throw new Error('Workflow-authoring content must be text.');
  if (record.action === 'draft' && (typeof record.source !== 'string' || Buffer.byteLength(record.source) > 256 * 1024)) throw new Error('Supply one XML draft of at most 256 KiB.');
  if (String(record.query ?? '').length > 512 || String(record.id ?? '').length > 256 || String(record.kind ?? '').length > 64
      || (record.cursor !== undefined && (!Number.isSafeInteger(record.cursor) || Number(record.cursor) < 0))) throw new Error('Use bounded catalog selectors.');
  return record as unknown as Input;
}

export function attachWorkflowIntentTool(handler: (input: Input) => Promise<unknown>): { available: boolean; session: string; dispose(): void } {
  const host = vscode as unknown as OptionalTools;
  if (typeof host.lm?.registerTool !== 'function' || typeof host.LanguageModelTextPart !== 'function' || typeof host.LanguageModelToolResult !== 'function') return { available: false, session: '', dispose() {} };
  if (!registration) registration = host.lm.registerTool(WORKFLOW_INTENT_TOOL, {
    prepareInvocation: () => ({ invocationMessage: 'Inspecting or checking an inert SFlow workflow draft; no Story or configuration transition.' }),
    invoke: async (options: { input: unknown }) => {
      if (vscode.workspace.getConfiguration('singularityFlow').get<string>('modelMode', 'auto') === 'disabled'
          || vscode.workspace.getConfiguration('chat').get<boolean>('disableAIFeatures', false)) throw new Error('Model features are disabled. Use the model-free designer or CLI.');
      const request = input(options.input); const target = targets.get(request.session);
      if (!target) throw new Error('This designer session is unavailable. Open Create with Copilot and request a fresh authoring handoff.');
      const value = await target(request);
      return new host.LanguageModelToolResult!([new host.LanguageModelTextPart!(JSON.stringify(value))]);
    }
  });
  const session = randomUUID(); targets.set(session, handler);
  void vscode.commands.executeCommand('setContext', 'singularityFlow.workflowIntentOpen', true);
  return { available: true, session, dispose() {
    targets.delete(session);
    if (!targets.size) { registration?.dispose(); registration = null; void vscode.commands.executeCommand('setContext', 'singularityFlow.workflowIntentOpen', false); }
  } };
}

import * as vscode from 'vscode';
import { ASK_HINT, askSuggestions } from '../../../src/ask/navigation.mjs';
import { askIntent } from '../../../src/ask/query.mjs';
import { escape } from './views/webview.ts';

const destinations = new Map([
  ['home', 'singularityFlow.myWork'],
  ['specs', 'singularityFlow.openSpecStudio'],
  ['stories', 'singularityFlow.openWorkspaceStories'],
  ['workflows', 'singularityFlow.openWorkflowStudio'],
  ['skills', 'singularityFlow.openSkills'],
  ['instructions', 'singularityFlow.openInstructionDesigner'],
  ['code', 'singularityFlow.openCodeExplainer'],
  ['run', 'singularityFlow.workspaceRunTest'],
  ['decisions', 'singularityFlow.openReviews'],
  ['help', 'singularityFlow.openHelp'],
  ['workspaces', 'singularityFlow.openWorkspaces'],
  ['configuration', 'singularityFlow.openConfigurationCenter'],
  ['analytics', 'singularityFlow.openDashboard'],
  ['activity', 'singularityFlow.openActivityLog'],
  ['about', 'singularityFlow.about']
]);
const installed = new Set(destinations.keys());

interface Specification {
  reference: string;
  title: string;
  reviewState: string;
  stateCommit: string;
  manifestSha256: string;
}
interface Answer {
  schemaVersion: number;
  resultType: string;
  work?: { id: string; title: string; kind: string; phaseLabel: string | null; status: string | null;
    workStatus: string | null; blockers: string[] };
  help?: { id: string; title: string; citation: string };
  items?: Array<{ id: string; label: string; detail: string }>;
  diagnostics?: Array<{ code: string; message: string }>;
  choices?: Array<{ id: string; kind: string }>;
  candidates?: Array<{ id: string; title: string }>;
  specifications?: Specification[];
  artifact?: Specification & { content: string };
}
interface Scope { root: string; workspaceId: string | null; repositoryId: string | null }
interface Pick extends vscode.QuickPickItem {
  query?: string;
  destination?: string;
  topic?: string;
  specification?: Specification;
}
type Run = (root: string | null, args: string[]) => Promise<Answer>;

export function askLookupArguments(query: string): string[] {
  return ['ask', '--question=' + query, '--no-model', '--for-person', '--json'];
}

function initialChoice(): Promise<Pick | null> {
  const picker = vscode.window.createQuickPick<Pick>();
  picker.title = 'Ask SFlow';
  picker.placeholder = ASK_HINT;
  const update = () => {
    const query = picker.value.trim();
    const suggestions = askSuggestions(query, installed).map(item => ({
      label: item.label, description: item.detail, destination: item.id, alwaysShow: true
    }));
    picker.items = [...(query ? [{ label: 'Ask “' + query + '”', query, alwaysShow: true }] : []), ...suggestions];
    picker.activeItems = picker.items.slice(0, 1);
  };
  return new Promise(resolve => {
    const disposables = [
      picker.onDidChangeValue(update),
      picker.onDidAccept(() => { resolve(picker.selectedItems[0] ?? picker.activeItems[0] ?? null); picker.hide(); }),
      picker.onDidHide(() => { resolve(null); for (const disposable of disposables) disposable.dispose(); picker.dispose(); })
    ];
    update();
    picker.show();
  });
}

function choices(value: Answer): Pick[] {
  const items: Pick[] = [];
  if (value.work) {
    const work = value.work;
    items.push({ label: work.id + ' · ' + work.title, description: [work.phaseLabel, work.status ?? work.workStatus].filter(Boolean).join(' · '),
      detail: work.blockers.length ? 'Blockers · ' + work.blockers.map(item => item.replaceAll('-', ' ')).join(', ') : undefined });
    if (work.kind === 'story') items.push({ label: 'Open the specification used for this Story', query: 'spec used for story ' + work.id });
  }
  for (const specification of value.specifications ?? []) {
    items.push({ label: specification.reference + ' · ' + specification.title, description: specification.reviewState, specification });
  }
  if (value.help) items.push({ label: value.help.title, detail: value.help.citation, topic: value.help.id });
  for (const item of value.items ?? []) {
    if (installed.has(item.id)) items.push({ label: item.label, description: item.detail, destination: item.id });
  }
  for (const option of value.choices ?? []) items.push({ label: option.id + ' · ' + option.kind, query: option.kind + ' ' + option.id });
  for (const topic of value.candidates ?? []) items.push({ label: topic.title, topic: topic.id });
  for (const finding of value.diagnostics ?? []) items.push({ label: finding.message, description: finding.code });
  return items;
}

function showArtifact(artifact: NonNullable<Answer['artifact']>): void {
  const panel = vscode.window.createWebviewPanel('singularityFlow.askSpecification', artifact.reference, vscode.ViewColumn.Active, {});
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{max-width:80ch;margin:2em auto;padding:0 1em;color:var(--vscode-editor-foreground)}
    pre{white-space:pre-wrap;overflow-wrap:anywhere;font:var(--vscode-editor-font-size)/1.65 var(--vscode-editor-font-family)}
    p{color:var(--vscode-descriptionForeground)}</style></head>
    <body><h1>${escape(artifact.title)}</h1><p>${escape(artifact.reference)} · ${escape(artifact.reviewState)}</p>
    <pre aria-label="Specification Markdown">${escape(artifact.content)}</pre></body></html>`;
}

function scopeKey(scope: Scope | null): string {
  return JSON.stringify(scope && [scope.root, scope.workspaceId, scope.repositoryId]);
}

export async function openAskSFlow(active: () => Scope | null, readAnswer: Run): Promise<void> {
  let picked = await initialChoice();
  if (!picked) return;
  const selectedScope = active();
  const root = selectedScope?.root ?? null;
  const ensureScope = () => {
    if (scopeKey(active()) !== scopeKey(selectedScope)) throw new Error('The active checkout changed. Open Ask SFlow to search there.');
  };
  while (picked) {
    ensureScope();
    if (picked.destination) {
      const command = destinations.get(picked.destination);
      if (command) await vscode.commands.executeCommand(command);
      return;
    }
    if (picked.topic) {
      await vscode.commands.executeCommand('singularityFlow.explainTopic', { id: 'help:topic:' + picked.topic });
      return;
    }
    if (picked.specification) {
      const { reference, stateCommit, manifestSha256 } = picked.specification;
      const result = await readAnswer(root, [...askLookupArguments(reference), '--open-spec',
        '--state-commit=' + stateCommit, '--manifest-sha256=' + manifestSha256]);
      ensureScope();
      if (!result.artifact) throw new Error('The specification reader did not return the selected revision.');
      showArtifact(result.artifact);
      return;
    }
    if (!picked.query) return;
    if (!root && ['work', 'story-spec', 'spec'].includes(askIntent(picked.query).kind)) {
      await vscode.window.showInformationMessage('Open a checkout to inspect its work or specifications.');
      return;
    }
    const result = await readAnswer(root, askLookupArguments(picked.query));
    ensureScope();
    if (result.resultType !== 'sflow-ask' || result.schemaVersion !== 1) throw new Error('The selected SFlow CLI needs an update to use Ask SFlow.');
    const results = choices(result);
    if (!results.length) {
      await vscode.window.showInformationMessage(ASK_HINT + '.');
      return;
    }
    picked = await vscode.window.showQuickPick(results, {
      title: 'Ask SFlow' + (root ? ' · ' + (selectedScope?.repositoryId ?? root) : ''),
      placeHolder: 'Inspect the answer or choose a destination',
      matchOnDescription: true,
      matchOnDetail: true
    }) ?? null;
  }
}

import * as vscode from 'vscode';
import { ASK_HINT, askSuggestions } from '../../../src/ask/navigation.mjs';
import { askIntent, askNeedsRepository } from '../../../src/ask/query.mjs';
import { askHistoryDisplay } from '../../../src/ask/history-display.mjs';
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
  evidenceId?: string;
}
interface Answer {
  schemaVersion: number;
  resultType: 'sflow-ask';
  work?: { id: string; title: string; kind: string; phaseLabel: string | null; status: string | null;
    workStatus: string | null; blockers: string[]; evidenceId?: string };
  help?: { id: string; title: string; citation: string; evidenceId?: string };
  items?: Array<{ id: string; label: string; detail: string }>;
  diagnostics?: Array<{ code: string; message: string }>;
  choices?: Array<{ id: string; kind: string; selection?: string }>;
  candidates?: Array<{ id: string; title: string; selection?: string }>;
  specifications?: Specification[];
  artifact?: Specification & { content: string };
  continuation?: { cursor: string; behavior: string };
  conversation?: { id: string; revision: number; hasMore: boolean; canExplain: boolean; taskAdmissionId?: string;
    portability?: string; taskAvailability?: string };
  currentConversation?: { conversationId: string };
  task?: { workId: string; workStatus?: string; status: string; phase?: string };
  savedResults?: Array<{ position: number; availability: string; title?: string; evidenceId: string }>;
  evidence?: { id: string; title: string; revision: string; locator: string; details?: Record<string, unknown>;
    specification?: Specification; content?: string };
  explanation?: { status: string; statements: Array<{ text: string; evidenceId: string }> };
  status?: string;
  kind?: string;
}
interface TaskHandoff {
  schemaVersion: number;
  resultType: 'sflow-task-handoff';
  id: string;
  message: string;
  intent: string;
  plan: string;
  specification?: { reference: string; clauseIds: string[] };
  evidence: Array<{ id: string; ref: { kind: string; commit?: string; reference?: string; workId?: string; path?: string; topic?: string } }>;
  diagnostic?: { message: string };
  conversation?: { id: string; revision: number };
  actions: Array<{ id: string; label: string; command: string }>;
}
interface Scope { root: string; workspaceId: string | null; repositoryId: string | null }
interface Pick extends vscode.QuickPickItem {
  query?: string;
  portable?: boolean;
  destination?: string;
  topic?: string;
  specification?: Specification;
  cursor?: string;
  patch?: string;
  action?: 'resume' | 'explain' | 'forget' | 'evidence' | 'select' | 'follow-up' | 'task-prepare' | 'task-inspect' | 'task-start';
  target?: string;
  taskSpec?: boolean;
}
type Run = (root: string | null, args: string[]) => Promise<Answer | TaskHandoff>;

export function askLookupArguments(query: string): string[] {
  return ['ask', '--question=' + query, '--no-model', '--for-person', '--json'];
}

function initialChoice(savedAvailable: boolean): Promise<Pick | null> {
  const picker = vscode.window.createQuickPick<Pick>();
  picker.title = 'Ask SFlow';
  picker.placeholder = ASK_HINT;
  const update = () => {
    const query = picker.value.trim();
    const suggestions = askSuggestions(query, installed).map(item => ({
      label: item.label, description: item.detail, destination: item.id, alwaysShow: true
    }));
    const first: Pick[] = query ? [
      { label: 'Ask “' + query + '”', query, alwaysShow: true },
      ...(savedAvailable ? [{ label: 'Ask and save across devices', query, portable: true, alwaysShow: true }] : [])
    ] : savedAvailable ? [
      { label: 'Resume saved Ask conversation', action: 'resume' },
      { label: 'Resume Ask conversation across devices', action: 'resume', portable: true }
    ] : [];
    picker.items = [...first, ...suggestions];
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

const evidenceAction = (target?: string): Pick['action'] => target ? 'evidence' : undefined;

function choices(value: Answer): Pick[] {
  const items: Pick[] = [];
  if (value.work) {
    const work = value.work;
    items.push({ label: work.id + ' · ' + work.title, description: [work.phaseLabel, work.status ?? work.workStatus].filter(Boolean).join(' · '),
      detail: work.blockers.length ? 'Blockers · ' + work.blockers.map(item => item.replaceAll('-', ' ')).join(', ') : undefined,
      action: evidenceAction(work.evidenceId), target: work.evidenceId });
    if (work.kind === 'story') items.push({ label: 'Open the specification used for this Story', query: work.evidenceId
      ? 'show the specification behind the first result' : 'spec used for story ' + work.id });
  }
  for (const specification of value.specifications ?? []) {
    items.push({ label: specification.reference + ' · ' + specification.title, description: specification.reviewState, ...(specification.evidenceId
      ? { action: 'evidence', target: specification.evidenceId } : { specification }) });
    if (!value.conversation?.taskAvailability && specification.evidenceId && specification.reviewState === 'reviewed') items.push({
      label: 'Prepare a task from ' + specification.reference, action: 'task-prepare', target: specification.evidenceId, taskSpec: true
    });
  }
  if (value.help) items.push({ label: value.help.title, detail: value.help.citation,
    ...(value.help.evidenceId ? { action: 'evidence', target: value.help.evidenceId } : { topic: value.help.id }) });
  for (const item of value.items ?? []) {
    if (installed.has(item.id)) items.push({ label: item.label, description: item.detail, destination: item.id });
  }
  for (const option of value.choices ?? []) items.push({ label: option.id + ' · ' + option.kind, ...(option.selection
    ? { action: 'select', target: option.selection } : { query: option.kind + ' ' + option.id }) });
  for (const topic of value.candidates ?? []) items.push({ label: topic.title, ...(topic.selection ? { action: 'select', target: topic.selection } : { topic: topic.id }) });
  const display = askHistoryDisplay(value);
  if (display) {
    items.push({ label: display.title, description: display.summary[0], detail: display.summary.slice(1).join(' · ') });
    items.push(...display.rows.map(({ evidenceId, ...row }) => ({ ...row, action: evidenceAction(evidenceId), target: evidenceId })));
    if (display.patch?.text) items.push({ label: 'View patch', patch: display.patch.text });
    else if (display.patch?.status === 'binary') items.push({ label: 'Binary files have no text patch.' });
  }
  for (const row of value.savedResults ?? []) {
    items.push({ label: 'Result ' + row.position + ' · ' + (row.title ?? (row.availability === 'local-only'
      ? 'Available on the original device' : 'Unavailable in this checkout')), ...(row.availability === 'available'
        ? { action: 'evidence' as const, target: row.evidenceId } : {}) });
  }
  if (value.continuation) items.push({
    label: value.continuation.behavior === 'retry' ? 'Retry this page' : 'Next page',
    cursor: value.continuation.cursor
  });
  if (value.evidence) {
    items.push({ label: value.evidence.title, detail: value.evidence.locator + ' · ' + value.evidence.revision });
    for (const [field, detail] of Object.entries(value.evidence.details ?? {})) {
      if (detail != null) items.push({ label: field, detail: String(detail) });
    }
    if (!value.conversation?.taskAvailability && (!value.evidence.specification || value.evidence.specification.reviewState === 'reviewed')) items.push({
      label: 'Prepare a task from this evidence', action: 'task-prepare', target: value.evidence.id, taskSpec: Boolean(value.evidence.specification)
    });
  }
  if (value.explanation) {
    items.push({ label: value.explanation.status === 'copilot-assisted' ? 'Copilot-organized explanation' : 'Explanation from recorded evidence' });
    items.push(...value.explanation.statements.map(item => ({ label: item.text, action: 'evidence' as const, target: item.evidenceId })));
  }
  if (value.task?.workId && !value.conversation?.taskAdmissionId) items.push({
    label: 'Task ' + value.task.workId, description: value.task.workStatus ?? value.task.status, detail: value.task.phase });
  if (value.conversation?.hasMore) items.push({ label: 'Next page', query: 'next page' });
  if (value.conversation?.canExplain) items.push({ label: 'Explain with Copilot', action: 'explain' });
  if (value.conversation?.taskAdmissionId) items.push({ label: 'Open task handoff', action: 'task-inspect', target: value.conversation.taskAdmissionId });
  if (value.conversation) items.push({ label: 'Ask a follow-up', action: 'follow-up' },
    { label: 'Forget saved conversation', action: 'forget' });
  if (value.status === 'conflict') items.push({ label: 'Resume latest version', action: 'resume', target: value.currentConversation?.conversationId });
  for (const finding of value.diagnostics ?? []) items.push({ label: finding.message, description: finding.code });
  return items;
}

function handoffChoices(value: TaskHandoff): Pick[] {
  const items: Pick[] = [{ label: value.message, detail: value.intent }, { label: value.plan }];
  if (value.specification) items.push({ label: value.specification.reference, description: value.specification.clauseIds.join(', ') });
  for (const { ref } of value.evidence) items.push({ label: 'Evidence · ' + (ref.reference ?? ref.workId ?? ref.path ?? ref.commit ?? ref.topic ?? ref.kind) });
  if (value.diagnostic) items.push({ label: value.diagnostic.message });
  for (const action of value.actions) {
    items.push(action.id === 'start' || action.id === 'inspect'
      ? { label: action.label, action: action.id === 'start' ? 'task-start' : 'task-inspect', target: value.id }
      : { label: action.label, detail: action.command });
  }
  return items;
}

type EvidenceChoice = vscode.QuickPickItem & { id: string };
function evidenceChoices(value: Answer): EvidenceChoice[] {
  const visible = [value.work, ...(value.specifications ?? []), value.help, ...(askHistoryDisplay(value)?.rows ?? []),
    ...(value.savedResults ?? []).filter(row => row.availability === 'available').map(row => ({ evidenceId: row.evidenceId, title: row.title ?? 'Result ' + row.position }))];
  return [...new Map(visible.flatMap(item => item?.evidenceId
    ? [[item.evidenceId, { id: item.evidenceId, label: 'title' in item ? item.title : item.label }] as const] : [])).values()];
}

async function prepareTaskInputs(pick: Pick, sources: EvidenceChoice[]): Promise<string[] | null> {
  const words = await vscode.window.showInputBox({ title: 'What should the task do?',
    validateInput: text => text.length > 2000 ? 'Keep the task under 2,000 characters.' : undefined });
  if (!words?.trim()) return null;
  const kinds = ['change', 'fix', 'feature', 'investigate', 'review', 'docs', 'tests', 'refactor', 'chore'];
  const kind = await vscode.window.showQuickPick(kinds, { placeHolder: 'Choose a task type' });
  if (!kind || !kinds.includes(kind)) return null;
  const clauses = pick.taskSpec ? await vscode.window.showInputBox({ title: 'Clause IDs (optional)',
    placeHolder: 'Leave empty for the whole revision, or enter REQ-001, AC-001' }) : '';
  if (clauses === undefined) return null;
  const alternatives = sources.filter(entry => entry.id !== pick.target);
  const support = alternatives.length ? await vscode.window.showQuickPick(alternatives, { canPickMany: true, placeHolder: 'Choose supporting evidence (optional)' }) : [];
  if (!support) return null;
  return ['--request=' + words.trim(), '--kind=' + kind, '--target=' + pick.target,
    ...clauses.split(/[\s,]+/u).filter(Boolean).map(id => '--clause=' + id), ...support.map(item => '--supporting-evidence=' + item.id)];
}

function showArtifact(artifact: { reference: string; title: string; reviewState: string; content: string }): void {
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
  const selectedScope = active();
  const root = selectedScope?.root ?? null;
  let picked = await initialChoice(Boolean(root));
  if (!picked) return;
  let conversation: Answer['conversation'];
  let sources: EvidenceChoice[] = [];
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
      if (result.resultType !== 'sflow-ask' || !result.artifact) throw new Error('The specification reader did not return the selected revision.');
      showArtifact(result.artifact);
      return;
    }
    if (picked.patch) {
      const document = await vscode.workspace.openTextDocument({ content: picked.patch, language: 'diff' });
      ensureScope();
      await vscode.window.showTextDocument(document);
      return;
    }
    if (picked.action === 'follow-up') {
      const question = await vscode.window.showInputBox({ title: 'Ask a follow-up',
        placeHolder: 'For example, the second result', validateInput: text => text.length > 2000 ? 'Keep questions under 2,000 characters.' : undefined });
      ensureScope();
      if (!question?.trim()) return;
      picked = { label: question, query: question.trim() };
      continue;
    }
    if (!picked.query && !picked.cursor && !picked.action) return;
    const query = picked.query ?? '';
    if (!root && (picked.cursor || picked.action || askNeedsRepository(askIntent(query)))) {
      await vscode.window.showInformationMessage('Open a checkout to inspect its work, source history, or specifications.');
      return;
    }
    const bindings = conversation ? ['--conversation=' + conversation.id, '--revision=' + conversation.revision] : [];
    let args: string[];
    if (picked.action === 'task-prepare') {
      if (!conversation || !picked.target) return;
      const inputs = await prepareTaskInputs(picked, sources);
      ensureScope();
      if (!inputs) return;
      args = ['work', 'handoff', '--for-person', '--no-model', '--json', ...bindings, ...inputs];
    } else if (picked.action === 'task-inspect' || picked.action === 'task-start') {
      if (!picked.target) return;
      args = ['work', 'handoff', picked.target, '--for-person', '--no-model', '--json', ...(picked.action === 'task-start' ? ['--start'] : [])];
    } else if (picked.action) {
      if (picked.action === 'forget' && await vscode.window.showWarningMessage('Forget this private Ask conversation?', { modal: true }, 'Forget') !== 'Forget') return;
      args = ['ask', '--for-person', '--json', ...(picked.action === 'explain' ? [] : ['--no-model']),
        ...(picked.action === 'resume' ? ['--resume', ...(picked.target ? ['--conversation=' + picked.target] : []), ...(picked.portable ? ['--portable'] : [])]
          : ['--' + picked.action + (picked.target ? '=' + picked.target : ''), ...bindings])];
    } else if (picked.cursor) args = ['ask', '--cursor=' + picked.cursor, '--no-model', '--for-person', '--json'];
    else args = [...askLookupArguments(query), ...(conversation ? bindings : root ? ['--remember', ...(picked.portable ? ['--portable'] : [])] : [])];
    const result = await readAnswer(root, args);
    ensureScope();
    if (result.resultType === 'sflow-task-handoff') {
      if (result.schemaVersion !== 1) throw new Error('The selected SFlow CLI needs an update to show this handoff.');
      if (result.conversation && conversation) conversation = { ...conversation, ...result.conversation, taskAdmissionId: result.id };
      picked = await vscode.window.showQuickPick(handoffChoices(result), { title: 'Ask SFlow · Task handoff' }) ?? null;
      continue;
    }
    if (result.resultType !== 'sflow-ask' || result.schemaVersion !== 1) throw new Error('The selected SFlow CLI needs an update to use Ask SFlow.');
    if (result.kind === 'forgotten') {
      await vscode.window.showInformationMessage('Saved Ask conversation removed.');
      return;
    }
    if (result.conversation) conversation = result.conversation;
    if (result.kind === 'conversation' && !result.conversation) conversation = undefined;
    if (!result.evidence && !result.explanation) sources = evidenceChoices(result);
    if (result.evidence?.content != null) {
      const evidence = result.evidence;
      showArtifact({ reference: evidence.locator, title: evidence.title,
        reviewState: evidence.specification?.reviewState ?? evidence.revision, content: result.evidence.content });
    }
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

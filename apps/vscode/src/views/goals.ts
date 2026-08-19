/** Workspace Goals: outcomes remain CLI-owned; this panel owns only the current selection. */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { commandData, list, bounded } from './surface-adapters.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { enumField, registerMessageRouter, stringField } from './messages.ts';
import { canActivateGoal, goalCreateArgs } from './surface-contracts.ts';

interface GoalLink { kind?: string; id?: string; repositoryId?: string; title?: string; status?: string; availability?: string }
export interface GoalWorkChoice { id: string; title?: string; status?: string; kind: 'story' | 'initiative' }
interface Goal { id: string; statement?: string; status?: string; successCriteria?: string[]; links?: GoalLink[]; createdAt?: string; completedAt?: string }
interface GoalList { goals?: Goal[]; state?: { activeGoalId?: string | null } }
interface GoalDetail { goal?: Goal; links?: GoalLink[]; state?: { activeGoalId?: string | null }; recommendation?: { action?: { label?: string } } }

const SCRIPT = `
  const vscode = window.__sfVscode;
  const sendForm = (form) => vscode.postMessage({ type: form.dataset.message, ...Object.fromEntries(new FormData(form)) });
  document.addEventListener('submit', (event) => { event.preventDefault(); sendForm(event.target); });
  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-message]');
    if (el && el.tagName !== 'FORM') vscode.postMessage({ type: el.dataset.message, id: el.dataset.id, work: el.dataset.work, kind: el.dataset.kind });
  });
`;

function workOptions(work: readonly GoalWorkChoice[]): string {
  return `<option value="">Choose governed work…</option><option value="none">No link yet (explicit)</option>${work.map((item) =>
    `<option value="${item.kind}:${escape(item.id)}">${escape(item.id)} — ${escape(item.title ?? item.status ?? item.kind)}</option>`).join('')}`;
}

export function goalsBody(data: GoalList | null, detail: GoalDetail | null, work: readonly GoalWorkChoice[], error: string | null): string {
  const goals = list<Goal>(data?.goals);
  const active = data?.state?.activeGoalId ?? null;
  const selected = detail?.goal ?? goals.find((goal) => goal.id === active) ?? goals[0] ?? null;
  const links = list<GoalLink>(detail?.links ?? selected?.links);
  return `<header><p class="eyebrow">Lifecycle</p><h1>${icon('impact', { size: 24 })} Goals</h1>
    <p class="meta">Connect an outcome and observable success criteria to governed Stories or Initiatives. Goal state is stored in the active workspace.</p></header>
  ${error ? `<section class="warning"><strong>Could not read Goals</strong><p>${escape(error)}</p></section>` : ''}
  <div class="split-layout">
    <section><div class="section-title"><h2>Goals</h2><button class="secondary" data-message="refresh">Refresh</button></div>
      ${goals.length ? `<div class="audit-list">${goals.map((goal) => `<button class="audit-record${selected?.id === goal.id ? ' selected' : ''}" data-message="show" data-id="${escape(goal.id)}">
        <strong>${escape(goal.statement ?? goal.id)}</strong><span>${escape(goal.id)} · ${escape(goal.status ?? 'unknown')}${active === goal.id ? ' · active' : ''}</span></button>`).join('')}</div>`
        : '<div class="empty"><p>No Goal exists in this workspace yet.</p></div>'}
    </section>
    <section><h2>${selected ? escape(selected.id) : 'Create a Goal'}</h2>
      ${selected ? `<div class="card"><h3>${escape(selected.statement ?? selected.id)}</h3><span class="badge">${escape(selected.status ?? 'unknown')}</span>
        <h4>Observable success</h4><ul>${list<string>(selected.successCriteria).map((item) => `<li>${escape(item)}</li>`).join('') || '<li>None recorded</li>'}</ul>
        <h4>Linked governed work</h4>${links.length ? `<ul>${links.map((link) => `<li><strong>${escape(link.id ?? '')}</strong> · ${escape(link.kind ?? 'work')} · ${escape(link.status ?? link.availability ?? 'unknown')}
          <button class="link" data-message="unlink" data-id="${escape(selected.id)}" data-work="${escape(link.id ?? '')}" data-kind="${escape(link.kind ?? 'story')}">Unlink</button></li>`).join('')}</ul>` : '<p class="muted">No work linked.</p>'}
        ${detail?.recommendation?.action?.label ? `<p class="callout">Next: ${escape(bounded(detail.recommendation.action.label))}</p>` : ''}
        <p class="card-foot">${canActivateGoal(selected, active) ? `<button data-message="activate" data-id="${escape(selected.id)}">Make active</button>` : ''}</p>
        <form data-message="link"><input type="hidden" name="id" value="${escape(selected.id)}"><label>Link governed work<select name="work" required>${workOptions(work)}</select></label><button type="submit">Link</button></form>
        <details><summary>Complete or abandon</summary><form data-message="close"><input type="hidden" name="id" value="${escape(selected.id)}"><label>Action<select name="action"><option value="complete">Complete</option><option value="abandon">Abandon</option></select></label><label>Exact Goal ID<input name="confirm" autocomplete="off" required placeholder="${escape(selected.id)}"></label><label>Note / reason<input name="note" required></label><button class="secondary" type="submit">Confirm transition</button></form></details>
      </div>` : '<p class="muted">Create a Goal or select one from the list.</p>'}
    </section>
  </div>
  <section><h2>Create Goal</h2><form data-message="create" class="form-grid"><label>Outcome statement<input name="statement" required></label>
    <label>Observable success criteria <span class="muted">one per line</span><textarea name="success" required rows="4"></textarea></label>
    <label>Initial governed work<select name="work" required>${workOptions(work)}</select></label><button type="submit">Create Goal</button></form></section>`;
}

export class GoalsPanel {
  private static current: GoalsPanel | null = null;
  private data: GoalList | null = null;
  private detail: GoalDetail | null = null;
  private error: string | null = null;
  private epoch: string;
  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private readonly work: () => readonly GoalWorkChoice[];
  private readonly afterMutation: () => Promise<void>;

  private constructor(
    panel: vscode.WebviewPanel, client: SingularityFlowClient,
    work: () => readonly GoalWorkChoice[], afterMutation: () => Promise<void>
  ) {
    this.panel = panel; this.client = client; this.work = work; this.afterMutation = afterMutation;
    this.epoch = client.repository;
    panel.webview.onDidReceiveMessage((raw) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      this.router.route(raw);
    });
    panel.onDidDispose(() => { GoalsPanel.current = null; });
    void this.refresh();
  }

  static show(context: vscode.ExtensionContext, client: SingularityFlowClient,
    work: () => readonly GoalWorkChoice[], afterMutation: () => Promise<void>): GoalsPanel {
    if (GoalsPanel.current) { GoalsPanel.current.panel.reveal(); void GoalsPanel.current.rebind(); return GoalsPanel.current; }
    const panel = vscode.window.createWebviewPanel('singularityFlow.goals', 'Goals', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    GoalsPanel.current = new GoalsPanel(panel, client, work, afterMutation);
    return GoalsPanel.current;
  }
  static repositoryChanged(): void { if (GoalsPanel.current) void GoalsPanel.current.rebind(); }

  private router = registerMessageRouter('singularityFlow.goals', {
    refresh: () => { void this.refresh(); },
    show: (message) => { const id = stringField(message, 'id'); if (id) void this.showGoal(id); },
    activate: (message) => { const id = stringField(message, 'id'); if (id) void this.mutate(['goal', 'use', id, '--json']); },
    unlink: (message) => {
      const id = stringField(message, 'id'); const work = stringField(message, 'work'); const kind = stringField(message, 'kind') ?? 'story';
      if (id && work) void this.mutate(['goal', 'unlink', id, work, '--kind', kind, '--json']);
    },
    link: (message) => {
      const id = stringField(message, 'id'); const selection = stringField(message, 'work');
      if (!id || !selection || selection === 'none') return void vscode.window.showWarningMessage('Choose governed work to link.');
      const [kind, work] = selection.split(':');
      if (work && (kind === 'story' || kind === 'initiative')) void this.mutate(['goal', 'link', id, work, '--kind', kind, '--json']);
    },
    create: (message) => {
      const statement = stringField(message, 'statement'); const rawSuccess = stringField(message, 'success'); const selection = stringField(message, 'work');
      if (!statement || !rawSuccess || !selection) return void vscode.window.showWarningMessage('Outcome, observable success, and an explicit work choice are required.');
      const success = rawSuccess.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      const [kind, workId = ''] = selection.split(':');
      if (!success.length || !['story', 'initiative', 'none'].includes(kind ?? '')) return;
      void this.mutate(goalCreateArgs({ statement, success, workId, kind: kind as 'story' | 'initiative' | 'none' }));
    },
    close: (message) => {
      const id = stringField(message, 'id'); const confirm = stringField(message, 'confirm'); const note = stringField(message, 'note');
      const action = enumField(message, 'action', ['complete', 'abandon'] as const);
      if (!id || confirm !== id || !action || !note) return void vscode.window.showWarningMessage('Type the exact Goal ID and provide a note or reason.');
      const args = ['goal', action, id, '--confirm', confirm, action === 'complete' ? '--note' : '--reason', note, '--json'];
      void this.mutate(args);
    }
  });

  private async rebind(): Promise<void> {
    if (this.epoch !== this.client.repository) { this.epoch = this.client.repository; this.detail = null; }
    await this.refresh();
  }
  private async showGoal(id: string): Promise<void> {
    try { this.detail = commandData<GoalDetail>(await this.client.run(['goal', 'show', id, '--json'])); this.error = null; } catch (error) { this.error = (error as Error).message; }
    this.render();
  }
  private async mutate(args: string[]): Promise<void> {
    if (this.epoch !== this.client.repository) return void vscode.window.showWarningMessage('The active workspace changed. Refresh Goals before making changes.');
    try { await this.client.run(args); await this.afterMutation(); await this.refresh(); } catch (error) { this.error = (error as Error).message; this.render(); }
  }
  private async refresh(): Promise<void> {
    this.epoch = this.client.repository;
    try {
      this.data = commandData<GoalList>(await this.client.run(['goal', 'list', '--all', '--json'])); this.error = null;
      const selected = this.detail?.goal?.id ?? this.data.state?.activeGoalId ?? this.data.goals?.[0]?.id;
      if (selected) this.detail = commandData<GoalDetail>(await this.client.run(['goal', 'show', selected, '--json'])); else this.detail = null;
    } catch (error) { this.error = (error as Error).message; }
    this.render();
  }
  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Goals', goalsBody(this.data, this.detail, this.work(), this.error), contentSecurityPolicy(this.panel.webview, token), token, SCRIPT);
  }
}

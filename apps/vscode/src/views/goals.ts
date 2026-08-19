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
interface GovernedGoalSummary { id: string; statement?: string; status?: string; assurance?: string; planGeneration?: number; planApproved?: boolean; linkedWork?: number }
interface GovernedGoalList { goals?: GovernedGoalSummary[]; unreadable?: Array<{ id?: string; error?: string }> }
interface GovernedCriterion { id?: string; statement?: string; oracle?: { type?: string } }
interface GovernedPlanStep { id?: string; subject?: { id?: string } }
interface GovernedGoalDetail {
  goal?: Goal & { assurance?: string; planGeneration?: number; planApproved?: boolean };
  contract?: { criteria?: GovernedCriterion[] };
  state?: { status?: string; assurance?: string; paused?: unknown; approvedPlan?: { planSha256?: string }; currentStepId?: string | null };
  plan?: { generation?: number; planSha256?: string; steps?: GovernedPlanStep[] };
  recommendation?: { action?: { label?: string } };
}

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

export function goalsBody(
  data: GoalList | null, detail: GoalDetail | null, work: readonly GoalWorkChoice[], error: string | null,
  governedData: GovernedGoalList | null = null, governedDetail: GovernedGoalDetail | null = null
): string {
  const goals = list<Goal>(data?.goals);
  const active = data?.state?.activeGoalId ?? null;
  const selected = detail?.goal ?? goals.find((goal) => goal.id === active) ?? goals[0] ?? null;
  const links = list<GoalLink>(detail?.links ?? selected?.links);
  const governed = list<GovernedGoalSummary>(governedData?.goals);
  const selectedGoverned = governedDetail?.goal ?? null;
  const governedPlan = governedDetail?.plan ?? null;
  const governedState = governedDetail?.state ?? null;
  return `<header><p class="eyebrow">Lifecycle</p><h1>${icon('impact', { size: 24 })} Goals</h1>
    <p class="meta">Personal outcomes stay local. Governed executions use durable GEX branches, typed success oracles, and exact-hash plan approval.</p></header>
  ${error ? `<section class="warning"><strong>Could not read Goals</strong><p>${escape(error)}</p></section>` : ''}
  <div class="split-layout">
    <section><div class="section-title"><h2>Goals</h2><button class="secondary" data-message="refresh">Refresh</button></div>
      ${goals.length ? `<div class="audit-list">${goals.map((goal) => `<button class="audit-record${selected?.id === goal.id ? ' selected' : ''}" data-message="show" data-id="${escape(goal.id)}">
        <strong>${escape(goal.statement ?? goal.id)}</strong><span>${escape(goal.id)} · ${escape(goal.status ?? 'unknown')}${active === goal.id ? ' · active' : ''}</span></button>`).join('')}</div>`
        : '<div class="empty"><p>No Goal exists in this workspace yet.</p></div>'}
    </section>
    <section><h2>${selected ? escape(selected.id) : 'Create a Goal'}</h2>
      ${selected ? `<div class="card"><h3>${escape(selected.statement ?? selected.id)}</h3><span class="badge">personal · ${escape(selected.status ?? 'unknown')}</span>
        <h4>Observable success</h4><ul>${list<string>(selected.successCriteria).map((item) => `<li>${escape(item)}</li>`).join('') || '<li>None recorded</li>'}</ul>
        <h4>Linked governed work</h4>${links.length ? `<ul>${links.map((link) => `<li><strong>${escape(link.id ?? '')}</strong> · ${escape(link.kind ?? 'work')} · ${escape(link.status ?? link.availability ?? 'unknown')}
          <button class="link" data-message="unlink" data-id="${escape(selected.id)}" data-work="${escape(link.id ?? '')}" data-kind="${escape(link.kind ?? 'story')}">Unlink</button></li>`).join('')}</ul>` : '<p class="muted">No work linked.</p>'}
        ${detail?.recommendation?.action?.label ? `<p class="callout">Next: ${escape(bounded(detail.recommendation.action.label))}</p>` : ''}
        <p class="card-foot">${canActivateGoal(selected, active) ? `<button data-message="activate" data-id="${escape(selected.id)}">Make active</button>` : ''}
          ${selected.status === 'active' ? `<button class="secondary" data-message="govern" data-id="${escape(selected.id)}">Promote to governed execution</button>` : ''}</p>
        <form data-message="link"><input type="hidden" name="id" value="${escape(selected.id)}"><label>Link governed work<select name="work" required>${workOptions(work)}</select></label><button type="submit">Link</button></form>
        <details><summary>Complete or abandon</summary><form data-message="close"><input type="hidden" name="id" value="${escape(selected.id)}"><label>Action<select name="action"><option value="complete">Complete</option><option value="abandon">Abandon</option></select></label><label>Exact Goal ID<input name="confirm" autocomplete="off" required placeholder="${escape(selected.id)}"></label><label>Note / reason<input name="note" required></label><button class="secondary" type="submit">Confirm transition</button></form></details>
      </div>` : '<p class="muted">Create a Goal or select one from the list.</p>'}
    </section>
  </div>
  <section><h2>Create Goal</h2><form data-message="create" class="form-grid"><label>Outcome statement<input name="statement" required></label>
    <label>Observable success criteria <span class="muted">one per line</span><textarea name="success" required rows="4"></textarea></label>
    <label>Initial governed work<select name="work" required>${workOptions(work)}</select></label><button type="submit">Create personal Goal</button></form></section>
  <section><div class="section-title"><div><p class="eyebrow">Repository-owned</p><h2>Governed executions</h2></div><button class="secondary" data-message="refresh">Refresh</button></div>
    ${governed.length ? `<div class="audit-list">${governed.map((goal) => `<button class="audit-record${selectedGoverned?.id === goal.id ? ' selected' : ''}" data-message="showGoverned" data-id="${escape(goal.id)}">
      <strong>${escape(goal.statement ?? goal.id)}</strong><span>${escape(goal.id)} · ${escape(goal.status ?? 'unknown')} · ${escape(goal.assurance ?? 'unassessed')} · plan ${goal.planGeneration ?? 0}${goal.planApproved ? ' approved' : ''}</span></button>`).join('')}</div>`
      : '<div class="empty"><p>No governed Goal exists yet. Promote an active personal Goal after linking its existing Stories or Initiatives.</p></div>'}
    ${governedData?.unreadable?.length ? `<div class="warning"><strong>${governedData.unreadable.length} governed Goal branch(es) could not be read</strong></div>` : ''}
    ${selectedGoverned ? `<div class="card"><h3>${escape(selectedGoverned.statement ?? selectedGoverned.id)}</h3>
      <p><span class="badge">governed</span> <span class="badge">${escape(governedState?.status ?? selectedGoverned.status ?? 'unknown')}</span> <span class="badge">${escape(governedState?.assurance ?? selectedGoverned.assurance ?? 'unassessed')}</span></p>
      <h4>Success oracles</h4><ul>${list<GovernedCriterion>(governedDetail?.contract?.criteria).map((criterion) => `<li><strong>${escape(criterion.id ?? '')}</strong> ${escape(criterion.statement ?? '')} <span class="badge">${escape(criterion.oracle?.type ?? 'unknown')}</span></li>`).join('')}</ul>
      <h4>Plan rail</h4>${governedPlan ? `<p>Generation ${governedPlan.generation} · <code>${escape(governedPlan.planSha256 ?? '')}</code></p><ol>${list<GovernedPlanStep>(governedPlan.steps).map((step) => `<li>${escape(step.id ?? '')} — ${escape(step.subject?.id ?? '')}${governedState?.currentStepId === step.id ? ' · current' : ''}</li>`).join('')}</ol>` : '<p class="muted">No plan compiled.</p>'}
      ${governedDetail?.recommendation?.action?.label ? `<p class="callout">Next: ${escape(bounded(governedDetail.recommendation.action.label))}</p>` : ''}
      <div class="actions">
        ${!governedPlan ? `<button data-message="planGoverned" data-id="${escape(selectedGoverned.id)}">Compile plan</button>` : ''}
        ${governedPlan && !governedState?.approvedPlan ? `<form data-message="approveGoverned"><input type="hidden" name="id" value="${escape(selectedGoverned.id)}"><input type="hidden" name="generation" value="${governedPlan.generation ?? ''}"><label>Exact plan hash<input name="confirm" autocomplete="off" required value="${escape(governedPlan.planSha256 ?? '')}"></label><button type="submit">Approve exact plan</button></form>` : ''}
        ${governedState?.approvedPlan ? `<button data-message="runGoverned" data-id="${escape(selectedGoverned.id)}">Run / navigate one step</button><button class="secondary" data-message="verifyGoverned" data-id="${escape(selectedGoverned.id)}">Verify oracles</button>` : ''}
        ${governedState?.paused ? `<button class="secondary" data-message="resumeGoverned" data-id="${escape(selectedGoverned.id)}">Resume</button>` : `<form data-message="pauseGoverned"><input type="hidden" name="id" value="${escape(selectedGoverned.id)}"><label>Pause reason<input name="reason" required></label><button class="secondary" type="submit">Pause</button></form>`}
      </div>
      <details><summary>Abandon governed execution</summary><form data-message="abandonGoverned"><input type="hidden" name="id" value="${escape(selectedGoverned.id)}"><label>Exact GEX ID<input name="confirm" autocomplete="off" required></label><label>Reason<input name="reason" required></label><button class="secondary" type="submit">Abandon; keep linked work</button></form></details>
    </div>` : ''}
  </section>`;
}

export class GoalsPanel {
  private static current: GoalsPanel | null = null;
  private data: GoalList | null = null;
  private detail: GoalDetail | null = null;
  private governedData: GovernedGoalList | null = null;
  private governedDetail: GovernedGoalDetail | null = null;
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
    govern: (message) => { const id = stringField(message, 'id'); if (id) void this.mutate(['goal', 'govern', id, '--json'], true); },
    showGoverned: (message) => { const id = stringField(message, 'id'); if (id) void this.showGovernedGoal(id); },
    planGoverned: (message) => { const id = stringField(message, 'id'); if (id) void this.mutate(['goal', 'plan', id, '--json'], true); },
    approveGoverned: (message) => {
      const id = stringField(message, 'id'); const generation = stringField(message, 'generation'); const confirm = stringField(message, 'confirm');
      if (id && generation && confirm) void this.mutate(['goal', 'plan', 'approve', id, '--generation', generation, '--confirm', confirm, '--json'], true);
    },
    runGoverned: (message) => { const id = stringField(message, 'id'); if (id) void this.mutate(['goal', 'run-next', id, '--json'], true); },
    verifyGoverned: (message) => { const id = stringField(message, 'id'); if (id) void this.mutate(['goal', 'verify', id, '--json'], true); },
    pauseGoverned: (message) => {
      const id = stringField(message, 'id'); const reason = stringField(message, 'reason');
      if (id && reason) void this.mutate(['goal', 'pause', id, '--reason', reason, '--json'], true);
    },
    resumeGoverned: (message) => { const id = stringField(message, 'id'); if (id) void this.mutate(['goal', 'resume', id, '--json'], true); },
    abandonGoverned: (message) => {
      const id = stringField(message, 'id'); const confirm = stringField(message, 'confirm'); const reason = stringField(message, 'reason');
      if (!id || confirm !== id || !reason) return void vscode.window.showWarningMessage('Type the exact governed Goal ID and provide a reason.');
      void this.mutate(['goal', 'abandon', id, '--confirm', confirm, '--reason', reason, '--json'], true);
    },
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
    if (this.epoch !== this.client.repository) { this.epoch = this.client.repository; this.detail = null; this.governedDetail = null; }
    await this.refresh();
  }
  private async showGoal(id: string): Promise<void> {
    try { this.detail = commandData<GoalDetail>(await this.client.run(['goal', 'show', id, '--json'])); this.error = null; } catch (error) { this.error = (error as Error).message; }
    this.render();
  }
  private async showGovernedGoal(id: string): Promise<void> {
    try { this.governedDetail = commandData<GovernedGoalDetail>(await this.client.run(['goal', 'inspect', id, '--json'])); this.error = null; } catch (error) { this.error = (error as Error).message; }
    this.render();
  }
  private async mutate(args: string[], governed = false): Promise<void> {
    if (this.epoch !== this.client.repository) return void vscode.window.showWarningMessage('The active workspace changed. Refresh Goals before making changes.');
    try {
      const result = commandData<GovernedGoalDetail>(await this.client.run(args));
      if (governed && result.goal?.id?.startsWith('GEX-')) this.governedDetail = result;
      await this.afterMutation(); await this.refresh();
    } catch (error) { this.error = (error as Error).message; this.render(); }
  }
  private async refresh(): Promise<void> {
    this.epoch = this.client.repository;
    try {
      this.data = commandData<GoalList>(await this.client.run(['goal', 'list', '--all', '--json'])); this.error = null;
      this.governedData = commandData<GovernedGoalList>(await this.client.run(['goal', 'list', '--mode', 'governed', '--json']));
      const selected = this.detail?.goal?.id ?? this.data.state?.activeGoalId ?? this.data.goals?.[0]?.id;
      if (selected) this.detail = commandData<GoalDetail>(await this.client.run(['goal', 'show', selected, '--json'])); else this.detail = null;
      const selectedGoverned = this.governedDetail?.goal?.id ?? this.governedData.goals?.[0]?.id;
      if (selectedGoverned) this.governedDetail = commandData<GovernedGoalDetail>(await this.client.run(['goal', 'inspect', selectedGoverned, '--json']));
      else this.governedDetail = null;
    } catch (error) { this.error = (error as Error).message; }
    this.render();
  }
  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Goals', goalsBody(
      this.data, this.detail, this.work(), this.error, this.governedData, this.governedDetail
    ), contentSecurityPolicy(this.panel.webview, token), token, SCRIPT);
  }
}

/** Private local journal viewer. Governed state remains in the CLI; this is a bounded summary UI. */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { bounded, commandData, dateValue, list } from './surface-adapters.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { enumField, registerMessageRouter, stringField } from './messages.ts';

interface JournalItem { id?: string; at?: string; kind?: string; workId?: string | null; text?: string }
interface JournalDay { date: string; timeZone?: string; capture?: { mode?: string; paused?: boolean }; privacy?: { label?: string }; summaries?: JournalItem[]; attention?: JournalItem[]; totalEvents?: number; malformedLines?: number[] }
interface JournalSettings { mode?: string; paused?: boolean; retentionDays?: number; timeZone?: string }
interface JournalDoctor { healthy?: boolean; findings?: Array<{ id?: string; state?: string; detail?: string }> }

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => { const el = event.target.closest('[data-message]'); if (el) vscode.postMessage({ type: el.dataset.message }); });
  document.addEventListener('submit', (event) => { event.preventDefault(); const submitter = event.submitter; vscode.postMessage({ type: event.target.dataset.message, ...Object.fromEntries(new FormData(event.target)), action: submitter?.value }); });
`;

function items(title: string, values: readonly JournalItem[]): string {
  return `<section><h2>${escape(title)}</h2>${values.length ? `<ol class="timeline">${values.map((item) => `<li><strong>${escape(item.workId ?? item.kind ?? 'Workspace')}</strong><span>${escape(bounded(item.text ?? 'Recorded activity'))}</span><small>${escape(item.at ?? '')}</small></li>`).join('')}</ol>` : '<p class="muted">Nothing recorded for this day.</p>'}</section>`;
}

export function journalBody(day: JournalDay | null, settings: JournalSettings | null, doctor: JournalDoctor | null,
  preview: string | null, error: string | null): string {
  const selected = day?.date ?? dateValue();
  return `<header><p class="eyebrow">My Work · Help</p><h1>${icon('book', { size: 24 })} Local Journal</h1>
    <p class="meta">A private, machine-local stopping-point summary. Prompts, source bytes, command output, and remote sync are excluded.</p></header>
  ${error ? `<section class="warning"><strong>Journal operation refused</strong><p>${escape(error)}</p></section>` : ''}
  <section class="plain"><div class="summary-grid"><div class="summary-card important"><strong>${escape(day?.totalEvents ?? 0)}</strong><span>events on ${escape(selected)}</span></div>
    <div class="summary-card"><strong>${settings?.paused ? 'Paused' : 'On'}</strong><span>capture</span></div><div class="summary-card"><strong>${escape(settings?.retentionDays ?? '—')}</strong><span>retention days</span></div></div>
    <p class="muted">${escape(day?.privacy?.label ?? 'Stored locally · Never pushed')}</p></section>
  <section><form data-message="date" class="form-row"><label>Today / history<input type="date" name="date" value="${escape(selected)}" required></label><button type="submit">Open day</button><button type="button" class="secondary" data-message="refresh">Refresh repository observation</button></form></section>
  <div class="split-layout">${items('Progress', list<JournalItem>(day?.summaries))}${items('Worth checking', list<JournalItem>(day?.attention))}</div>
  ${list<number>(day?.malformedLines).length ? `<section class="warning"><p>${list<number>(day?.malformedLines).length} malformed local record(s) were ignored.</p></section>` : ''}
  <div class="split-layout"><section><h2>Capture & retention</h2><form data-message="settings"><label>Capture mode<select name="mode"><option value="off"${settings?.mode === 'off' ? ' selected' : ''}>Off</option><option value="sflow-only"${settings?.mode === 'sflow-only' ? ' selected' : ''}>SFlow activity only</option><option value="workspace-facts"${settings?.mode === 'workspace-facts' ? ' selected' : ''}>Workspace facts</option><option value="enhanced"${settings?.mode === 'enhanced' ? ' selected' : ''}>Enhanced local summary</option></select></label>
    <label>Retention days<input type="number" min="1" max="365" name="retention" value="${escape(settings?.retentionDays ?? 30)}" required></label><label>Time zone<input name="timeZone" value="${escape(settings?.timeZone ?? 'UTC')}" required></label><button type="submit">Save settings</button></form>
    <p class="card-foot"><button class="secondary" data-message="${settings?.paused ? 'resume' : 'pause'}">${settings?.paused ? 'Resume' : 'Pause'} capture</button></p></section>
    <section><h2>Journal doctor</h2><p class="badge">${doctor?.healthy === false ? 'Needs attention' : 'Healthy'}</p><ul>${list<{ id?: string; state?: string; detail?: string }>(doctor?.findings).map((finding) => `<li><strong>${escape(finding.id ?? 'check')}</strong> · ${escape(finding.state ?? 'unknown')}<br><span class="muted">${escape(bounded(finding.detail))}</span></li>`).join('') || '<li>Run doctor to inspect local journal health.</li>'}</ul><button class="secondary" data-message="doctor">Run doctor</button></section></div>
  <section><h2>Export</h2><p>Preview or save the selected day outside every workspace and Git worktree.</p><form data-message="export"><input type="hidden" name="date" value="${escape(selected)}"><label>Format<select name="format"><option value="markdown">Markdown</option><option value="json">JSON</option></select></label><button class="secondary" type="submit" value="preview">Preview export</button><button type="submit" value="save">Save export</button></form>
    ${preview ? `<details open><summary>Export preview</summary><pre><code>${escape(preview)}</code></pre></details>` : ''}</section>
  <section><h2>Delete local history</h2><div class="split-layout"><form data-message="delete-day"><input type="hidden" name="date" value="${escape(selected)}"><label>Type the exact date<input name="confirm" autocomplete="off" placeholder="${escape(selected)}" required></label><button class="secondary" type="submit">Delete this day</button></form>
    <form data-message="delete-all"><label>Type DELETE LOCAL JOURNAL<input name="confirm" autocomplete="off" required></label><button class="secondary" type="submit">Delete all history</button></form></div></section>`;
}

export class JournalPanel {
  private static current: JournalPanel | null = null;
  private day: JournalDay | null = null; private settings: JournalSettings | null = null; private doctor: JournalDoctor | null = null;
  private preview: string | null = null; private error: string | null = null; private epoch: string;
  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private readonly afterMutation: () => Promise<void>;
  private constructor(panel: vscode.WebviewPanel, client: SingularityFlowClient, afterMutation: () => Promise<void>) {
    this.panel = panel; this.client = client; this.afterMutation = afterMutation;
    this.epoch = client.repository;
    panel.webview.onDidReceiveMessage((raw) => { const navigation = navigationTarget(raw); if (navigation) return void navigateTo(navigation); this.router.route(raw); });
    panel.onDidDispose(() => { JournalPanel.current = null; }); void this.load();
  }
  static show(context: vscode.ExtensionContext, client: SingularityFlowClient, afterMutation: () => Promise<void>): JournalPanel {
    if (JournalPanel.current) { JournalPanel.current.panel.reveal(); void JournalPanel.current.rebind(); return JournalPanel.current; }
    const panel = vscode.window.createWebviewPanel('singularityFlow.journal', 'Local Journal', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    JournalPanel.current = new JournalPanel(panel, client, afterMutation); return JournalPanel.current;
  }
  static repositoryChanged(): void { if (JournalPanel.current) void JournalPanel.current.rebind(); }
  private router = registerMessageRouter('singularityFlow.journal', {
    date: (m) => { const date = stringField(m, 'date'); if (date) void this.load(date); },
    refresh: () => { void this.mutate(['journal', 'refresh', '--json']); },
    settings: (m) => { const mode = stringField(m, 'mode'); const retention = stringField(m, 'retention'); const zone = stringField(m, 'timeZone'); if (mode && retention && zone) void this.mutate(['journal', 'settings', '--mode', mode, '--retention-days', retention, '--time-zone', zone, '--json']); },
    pause: () => { void this.mutate(['journal', 'pause', '--json']); }, resume: () => { void this.mutate(['journal', 'resume', '--json']); },
    doctor: () => { void this.loadDoctor(); }, export: (m) => { void this.export(m); },
    'delete-day': (m) => { const date = stringField(m, 'date'); const confirm = stringField(m, 'confirm'); if (!date || confirm !== date) return void vscode.window.showWarningMessage('Type the exact selected date.'); void this.mutate(['journal', 'delete', '--date', date, '--confirm', confirm, '--json']); },
    'delete-all': (m) => { const confirm = stringField(m, 'confirm'); if (confirm !== 'DELETE LOCAL JOURNAL') return void vscode.window.showWarningMessage('Type DELETE LOCAL JOURNAL exactly.'); void this.mutate(['journal', 'delete', '--all', '--confirm', confirm, '--json']); }
  });
  private validEpoch(): boolean { if (this.epoch === this.client.repository) return true; void vscode.window.showWarningMessage('The active workspace changed. Refresh the Local Journal before making changes.'); return false; }
  private async export(m: Readonly<Record<string, unknown>>): Promise<void> {
    if (!this.validEpoch()) return;
    const date = stringField(m as never, 'date'); const format = enumField(m as never, 'format', ['markdown', 'json'] as const); const action = enumField(m as never, 'action', ['preview', 'save'] as const);
    if (!date || !format || !action) return;
    const destination = await vscode.window.showSaveDialog({ title: action === 'preview' ? 'Choose a safe export destination for preview validation' : 'Save local journal export', filters: format === 'json' ? { JSON: ['json'] } : { Markdown: ['md'] } });
    if (!destination) return;
    try {
      const args = ['journal', 'export', '--date', date, '--format', format, '--output', destination.fsPath, ...(action === 'preview' ? ['--dry-run'] : []), '--json'];
      const data = commandData<{ preview?: string }>(await this.client.run(args)); this.preview = action === 'preview' ? data.preview ?? '' : null; this.error = null;
      if (action === 'save') void vscode.window.showInformationMessage(`Local journal export saved as ${destination.path.split('/').at(-1)}.`);
      await this.afterMutation(); this.render();
    } catch (e) { this.error = (e as Error).message; this.render(); }
  }
  private async mutate(args: string[]): Promise<void> { if (!this.validEpoch()) return; try { await this.client.run(args); await this.afterMutation(); await this.load(this.day?.date); } catch (e) { this.error = (e as Error).message; this.render(); } }
  private async loadDoctor(): Promise<void> { try { this.doctor = commandData<JournalDoctor>(await this.client.run(['journal', 'doctor', '--json'])); this.error = null; } catch (e) { this.error = (e as Error).message; } this.render(); }
  private async rebind(): Promise<void> { if (this.epoch !== this.client.repository) { this.day = null; this.preview = null; } await this.load(); }
  private async load(date?: string): Promise<void> {
    this.epoch = this.client.repository;
    try {
      const args = ['journal', 'today', ...(date ? ['--date', date] : []), '--json'];
      const [day, settings, doctor] = await Promise.all([this.client.run(args), this.client.run(['journal', 'settings', '--json']), this.client.run(['journal', 'doctor', '--json'])]);
      this.day = commandData<JournalDay>(day); this.settings = commandData<JournalSettings>(settings); this.doctor = commandData<JournalDoctor>(doctor); this.error = null;
    } catch (e) { this.error = (e as Error).message; }
    this.render();
  }
  private render(): void { const token = nonce(); this.panel.webview.html = page('Local Journal', journalBody(this.day, this.settings, this.doctor, this.preview, this.error), contentSecurityPolicy(this.panel.webview, token), token, SCRIPT, { nav: 'journal' }); }
}

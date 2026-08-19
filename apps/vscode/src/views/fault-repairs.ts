/** Fault and repair operations with redacted rendering and structured verification argv. */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { bounded, commandData, list, publicFaultText, publicVerificationArgv } from './surface-adapters.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { enumField, registerMessageRouter, stringField } from './messages.ts';
import { repairPlanArgs, verificationArgv } from './surface-contracts.ts';

type Tab = 'faults' | 'repairs';
interface FaultSummary { faultId: string; severity?: string; status?: string; disposition?: string; occurredAt?: string; failure?: { type?: string; message?: string }; story?: string | null }
interface FaultRecord extends FaultSummary { source?: string; environment?: string; capability?: string | null; integrity?: { sha256?: string } }
interface RepairSummary { repairId: string; faultId?: string; status?: string; attempts?: unknown[]; plan?: RepairPlan; planGeneration?: number; stopReason?: string | null }
interface RepairPlan { allowedPaths?: string[]; verification?: Array<{ argv?: string[] }>; budgets?: { maxAttempts?: number }; integrity?: { sha256?: string } }
interface FaultList { faults?: FaultSummary[] }
interface RepairList { repairs?: RepairSummary[] }

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-message]');
    if (el) vscode.postMessage({ type: el.dataset.message, id: el.dataset.id, tab: el.dataset.tab });
  });
  document.addEventListener('submit', (event) => {
    event.preventDefault(); vscode.postMessage({ type: event.target.dataset.message, ...Object.fromEntries(new FormData(event.target)), mode: event.submitter?.value });
  });
`;

function faultRows(faults: readonly FaultSummary[], selected: string | null): string {
  if (!faults.length) return '<div class="empty"><p>No recorded faults.</p></div>';
  return `<div class="audit-list">${faults.map((fault) => `<button class="audit-record${fault.faultId === selected ? ' selected' : ''}" data-message="show-fault" data-id="${escape(fault.faultId)}">
    <strong>${escape(fault.failure?.type ?? fault.faultId)}</strong><span>${escape(fault.faultId)} · ${escape(fault.severity ?? 'unknown')} · ${escape(fault.disposition ?? fault.status ?? 'recorded')}</span>
    <small>${escape(fault.story ?? 'repository')} · ${escape(fault.occurredAt ?? '')}</small></button>`).join('')}</div>`;
}

function repairRows(repairs: readonly RepairSummary[], selected: string | null): string {
  if (!repairs.length) return '<div class="empty"><p>No governed repairs.</p></div>';
  return `<div class="audit-list">${repairs.map((repair) => `<button class="audit-record${repair.repairId === selected ? ' selected' : ''}" data-message="show-repair" data-id="${escape(repair.repairId)}">
    <strong>${escape(repair.repairId)}</strong><span>${escape(repair.faultId ?? 'fault')} · ${escape(repair.status ?? 'unknown')}</span>
    <small>${list(repair.attempts).length} attempt(s)</small></button>`).join('')}</div>`;
}

export function faultRepairsBody(input: {
  tab: Tab; faults: FaultSummary[]; repairs: RepairSummary[]; fault: FaultRecord | null;
  repair: RepairSummary | null; preview: RepairSummary | null; error: string | null;
}): string {
  const { tab, faults, repairs, fault, repair, preview, error } = input;
  const selectedFault = fault?.faultId ?? null; const selectedRepair = repair?.repairId ?? null;
  const planHash = repair?.plan?.integrity?.sha256 ?? '';
  return `<header><p class="eyebrow">Inbox</p><h1>${icon('warning', { size: 24 })} Faults & Repairs</h1>
    <p class="meta">Inspect sanitized fault summaries, bound a repair, and authorize exactly the reviewed plan. Raw evidence and verifier output never enter this view.</p></header>
  ${error ? `<section class="warning"><strong>Operation refused</strong><p>${escape(error)}</p></section>` : ''}
  <nav class="tabs" aria-label="Fault and repair views"><button class="${tab === 'faults' ? 'active' : ''}" data-message="tab" data-tab="faults">Faults</button><button class="${tab === 'repairs' ? 'active' : ''}" data-message="tab" data-tab="repairs">Repairs</button></nav>
  ${tab === 'faults' ? `<div class="split-layout"><section><div class="section-title"><h2>Faults</h2><button class="secondary" data-message="refresh">Refresh</button></div>${faultRows(faults, selectedFault)}</section>
    <section><h2>${fault ? escape(fault.faultId) : 'Fault details'}</h2>${fault ? `<div class="card"><dl>
      <dt>Type</dt><dd>${escape(fault.failure?.type ?? 'unknown')}</dd><dt>Severity</dt><dd>${escape(fault.severity ?? 'unknown')}</dd>
      <dt>Disposition</dt><dd>${escape(fault.disposition ?? fault.status ?? 'recorded')}</dd><dt>Story</dt><dd>${escape(fault.story ?? 'repository')}</dd>
      <dt>Message</dt><dd>${escape(publicFaultText(fault.failure?.message ?? 'No sanitized message', 320))}</dd></dl>
      <p class="card-foot"><button data-message="diagnose" data-id="${escape(fault.faultId)}">Diagnose</button></p>
      <h3>Bound a repair</h3><form data-message="plan"><input type="hidden" name="id" value="${escape(fault.faultId)}"><label>Allowed paths <span class="muted">one repository-relative path per line</span><textarea name="paths" required></textarea></label>
      <label>Verification argv <span class="muted">one JSON string array per line; never a shell command</span><textarea name="verify" required placeholder='["npm","test"]'></textarea></label>
      <label>Maximum attempts<input name="attempts" type="number" min="1" max="20" value="1" required></label>
      <button class="secondary" name="mode" value="preview" type="submit">Preview plan</button><button name="mode" value="create" type="submit">Create repair</button></form></div>` : '<p class="muted">Select a fault.</p>'}
      ${preview ? `<section class="callout"><h3>Plan preview</h3><p>Allowed paths: ${escape(list<string>(preview.plan?.allowedPaths).join(', ') || 'none')}</p><p>Verification steps: ${list(preview.plan?.verification).length}</p><p>Plan hash: <code>${escape(preview.plan?.integrity?.sha256 ?? '')}</code></p></section>` : ''}</section></div>
    <section><h2>Report a fault</h2><form data-message="report" class="form-grid"><label>Type<select name="failureType"><option value="unknown">Unknown</option><option value="compile">Compile</option><option value="lint">Lint</option><option value="unit-test">Unit test</option><option value="integration-test">Integration test</option><option value="verification">Verification</option><option value="runtime">Runtime</option><option value="dependency">Dependency</option><option value="configuration">Configuration</option><option value="schema">Schema</option><option value="deployment">Deployment</option><option value="production">Production</option><option value="security">Security</option><option value="policy">Policy</option><option value="requirement">Requirement</option><option value="architecture">Architecture</option></select></label><label>Sanitized message<textarea name="message" required></textarea></label>
      <label>Severity<select name="severity"><option>medium</option><option>low</option><option>high</option><option>critical</option></select></label><label>Environment<input name="environment" value="local"></label>
      <label>Story / work ID<input name="story"></label><label>Requested action<select name="requested"><option value="policy-decides">Policy decides</option><option value="record">Record only</option><option value="diagnose">Diagnose</option><option value="propose">Propose repair</option><option value="guided">Guided repair</option><option value="bounded-auto">Bounded automatic repair</option></select></label>
      <button type="submit">Record fault</button></form><p class="muted">Attach evidence through the CLI or governed ingestion API; this form deliberately does not accept host paths or secrets.</p></section>`
    : `<div class="split-layout"><section><div class="section-title"><h2>Repairs</h2><button class="secondary" data-message="refresh">Refresh</button></div>${repairRows(repairs, selectedRepair)}</section>
      <section><h2>${repair ? escape(repair.repairId) : 'Repair details'}</h2>${repair ? `<div class="card"><dl><dt>Fault</dt><dd>${escape(repair.faultId ?? '')}</dd><dt>Status</dt><dd>${escape(repair.status ?? 'unknown')}</dd><dt>Plan generation</dt><dd>${escape(repair.planGeneration ?? '—')}</dd><dt>Attempts</dt><dd>${list(repair.attempts).length} / ${escape(repair.plan?.budgets?.maxAttempts ?? '—')}</dd></dl>
      <h3>Reviewed plan</h3><p>Allowed paths: ${escape(list<string>(repair.plan?.allowedPaths).join(', ') || 'none')}</p><ul>${list<{ argv?: string[] }>(repair.plan?.verification).map((entry) => `<li><code>${escape(publicVerificationArgv(entry.argv))}</code></li>`).join('') || '<li>No verification commands</li>'}</ul>
      <p>Plan hash: <code>${escape(planHash)}</code></p>
      <form data-message="authorize"><input name="id" type="hidden" value="${escape(repair.repairId)}"><label>Exact plan hash<input name="confirm" required autocomplete="off"></label><button type="submit">Authorize this plan</button></form>
      <p class="card-foot"><button class="secondary" data-message="attempt" data-id="${escape(repair.repairId)}">Choose patch and attempt</button></p>
      <form data-message="cancel"><input name="id" type="hidden" value="${escape(repair.repairId)}"><label>Cancellation reason<input name="reason" required></label><button class="secondary" type="submit">Cancel repair</button></form>
      <details><summary>History</summary><ol>${list<Record<string, unknown>>(repair.attempts).map((attempt, index) => `<li>Attempt ${index + 1} · ${escape(publicFaultText(attempt.outcome ?? attempt.status ?? 'recorded'))}</li>`).join('') || '<li>No attempts yet.</li>'}</ol>${repair.stopReason ? `<p>${escape(publicFaultText(repair.stopReason))}</p>` : ''}</details></div>` : '<p class="muted">Select a repair.</p>'}</section></div>`}`;
}

export class FaultRepairsPanel {
  private static current: FaultRepairsPanel | null = null;
  private tab: Tab = 'faults'; private faults: FaultSummary[] = []; private repairs: RepairSummary[] = [];
  private fault: FaultRecord | null = null; private repair: RepairSummary | null = null; private preview: RepairSummary | null = null;
  private error: string | null = null; private epoch: string;
  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private readonly afterMutation: () => Promise<void>;

  private constructor(panel: vscode.WebviewPanel, client: SingularityFlowClient, afterMutation: () => Promise<void>) {
    this.panel = panel; this.client = client; this.afterMutation = afterMutation;
    this.epoch = client.repository;
    panel.webview.onDidReceiveMessage((raw) => { const navigation = navigationTarget(raw); if (navigation) return void navigateTo(navigation); this.router.route(raw); });
    panel.onDidDispose(() => { FaultRepairsPanel.current = null; }); void this.refresh();
  }
  static show(context: vscode.ExtensionContext, client: SingularityFlowClient, afterMutation: () => Promise<void>): FaultRepairsPanel {
    if (FaultRepairsPanel.current) { FaultRepairsPanel.current.panel.reveal(); void FaultRepairsPanel.current.rebind(); return FaultRepairsPanel.current; }
    const panel = vscode.window.createWebviewPanel('singularityFlow.faultRepairs', 'Faults & Repairs', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    FaultRepairsPanel.current = new FaultRepairsPanel(panel, client, afterMutation); return FaultRepairsPanel.current;
  }
  static repositoryChanged(): void { if (FaultRepairsPanel.current) void FaultRepairsPanel.current.rebind(); }
  private router = registerMessageRouter('singularityFlow.faultRepairs', {
    tab: (m) => { const tab = enumField(m, 'tab', ['faults', 'repairs'] as const); if (tab) { this.tab = tab; this.render(); } },
    refresh: () => { void this.refresh(); },
    'show-fault': (m) => { const id = stringField(m, 'id'); if (id) void this.showFault(id); },
    'show-repair': (m) => { const id = stringField(m, 'id'); if (id) void this.showRepair(id); },
    diagnose: (m) => { const id = stringField(m, 'id'); if (id) void this.mutate(['fix', id, '--diagnose-only', '--json']); },
    report: (m) => {
      const type = stringField(m, 'failureType'); const message = stringField(m, 'message'); if (!type || !message) return;
      const args = ['fault', 'report', '--type', type, '--message', message, '--severity', stringField(m, 'severity') ?? 'medium', '--environment', stringField(m, 'environment') ?? 'local', '--requested-action', stringField(m, 'requested') ?? 'policy-decides'];
      const story = stringField(m, 'story'); if (story) args.push('--work-id', story); void this.mutate([...args, '--json']);
    },
    plan: (m) => { void this.plan(m); },
    authorize: (m) => {
      const id = stringField(m, 'id'); const confirm = stringField(m, 'confirm'); const expected = this.repair?.repairId === id ? this.repair.plan?.integrity?.sha256 : null;
      if (!id || !expected || confirm !== expected) return void vscode.window.showWarningMessage('Type the exact current repair-plan hash.');
      void this.mutate(['repair', 'authorize', id, '--confirm', confirm, '--json']);
    },
    attempt: (m) => { const id = stringField(m, 'id'); if (id) void this.attempt(id); },
    cancel: (m) => { const id = stringField(m, 'id'); const reason = stringField(m, 'reason'); if (id && reason) void this.mutate(['repair', 'cancel', id, '--reason', reason, '--json']); }
  });
  private async plan(m: Readonly<Record<string, unknown>>): Promise<void> {
    const faultId = stringField(m as never, 'id'); const rawPaths = stringField(m as never, 'paths'); const rawVerify = stringField(m as never, 'verify');
    const mode = enumField(m as never, 'mode', ['preview', 'create'] as const); const attempts = Number(stringField(m as never, 'attempts') ?? '1');
    if (!faultId || !rawPaths || !rawVerify || !mode || !Number.isInteger(attempts) || attempts < 1 || attempts > 20) return;
    const paths = rawPaths.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
    const verification = rawVerify.split(/\r?\n/).map(verificationArgv);
    if (!paths.length || verification.some((v) => v === null)) return void vscode.window.showWarningMessage('Each verification line must be a non-empty JSON string array, for example ["npm","test"].');
    const args = repairPlanArgs({ faultId, paths, verification: verification as string[][], maxAttempts: attempts, persist: mode === 'create' });
    if (mode === 'preview') {
      try { const data = commandData<{ repair?: RepairSummary; plan?: RepairPlan }>(await this.client.run(args)); this.preview = data.repair ?? { repairId: 'preview', faultId, status: 'preview', plan: data.plan }; this.error = null; } catch (e) { this.error = (e as Error).message; }
      this.render(); return;
    }
    this.tab = 'repairs'; await this.mutate(args);
  }
  private async attempt(id: string): Promise<void> {
    if (!this.validEpoch()) return;
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, title: `Choose the reviewed patch for ${id}` });
    if (!selected?.[0]) return; await this.mutate(['repair', 'attempt', id, '--patch', selected[0].fsPath, '--json']);
  }
  private validEpoch(): boolean { if (this.epoch === this.client.repository) return true; void vscode.window.showWarningMessage('The active workspace changed. Refresh Faults & Repairs before making changes.'); return false; }
  private async mutate(args: string[]): Promise<void> { if (!this.validEpoch()) return; try { await this.client.run(args); await this.afterMutation(); await this.refresh(); } catch (e) { this.error = (e as Error).message; this.render(); } }
  private async showFault(id: string): Promise<void> { try { const data = commandData<{ fault?: FaultRecord }>(await this.client.run(['fault', 'show', id, '--json'])); this.fault = data.fault ?? null; this.error = null; } catch (e) { this.error = (e as Error).message; } this.render(); }
  private async showRepair(id: string): Promise<void> { try { this.repair = commandData<RepairSummary>(await this.client.run(['repair', 'status', id, '--json'])); this.error = null; } catch (e) { this.error = (e as Error).message; } this.render(); }
  private async rebind(): Promise<void> { if (this.epoch !== this.client.repository) { this.fault = null; this.repair = null; this.preview = null; } await this.refresh(); }
  private async refresh(): Promise<void> {
    this.epoch = this.client.repository;
    try {
      const selectedFault = this.fault?.faultId ?? null; const selectedRepair = this.repair?.repairId ?? null;
      const [faults, repairs, fault, repair] = await Promise.all([
        this.client.run(['fault', 'list', '--json']), this.client.run(['repair', 'list', '--json']),
        selectedFault ? this.client.run(['fault', 'show', selectedFault, '--json']) : null,
        selectedRepair ? this.client.run(['repair', 'status', selectedRepair, '--json']) : null
      ]);
      this.faults = list<FaultSummary>(commandData<FaultList>(faults).faults); this.repairs = list<RepairSummary>(commandData<RepairList>(repairs).repairs); this.error = null;
      this.fault = selectedFault && this.faults.some((entry) => entry.faultId === selectedFault)
        ? commandData<{ fault?: FaultRecord }>(fault).fault ?? null : null;
      this.repair = selectedRepair && this.repairs.some((entry) => entry.repairId === selectedRepair)
        ? commandData<RepairSummary>(repair) : null;
    } catch (e) { this.error = (e as Error).message; }
    this.render();
  }
  private render(): void { const token = nonce(); this.panel.webview.html = page('Faults & Repairs', faultRepairsBody({ tab: this.tab, faults: this.faults, repairs: this.repairs, fault: this.fault, repair: this.repair, preview: this.preview, error: this.error }), contentSecurityPolicy(this.panel.webview, token), token, SCRIPT); }
}

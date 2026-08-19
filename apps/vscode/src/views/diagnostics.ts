/** Canonical visual diagnostics, including the bounded schema census from `doctor --json`. */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { bounded, commandData, list } from './surface-adapters.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { enumField, registerMessageRouter } from './messages.ts';
import { SCHEMA_REMEDIES, schemaRecordRemedy } from './surface-contracts.ts';

type Tab = 'repository' | 'capabilities' | 'workspace' | 'schema';
interface Check { id?: string; status?: string; state?: string; title?: string; message?: string; detail?: string; remedy?: string }
interface SchemaRecord { family?: string; path?: string; storedVersion?: number; schemaVersion?: number; error?: string; reason?: string }
interface SchemaFamily { family?: string; currentVersion?: number; readable?: { minimum?: number; maximum?: number }; records?: number; versions?: Record<string, number> | Array<{ version?: number; count?: number }>; outsideRange?: SchemaRecord[]; unreadable?: SchemaRecord[] }
interface SchemaCensus { scanned?: number; scannedFiles?: number; truncated?: boolean; healthy?: boolean; totals?: Record<string, number>; families?: SchemaFamily[]; unregistered?: SchemaRecord[]; unreadable?: SchemaRecord[] }
interface DoctorResult { healthy?: boolean; repository?: string; branch?: string; head?: string; workId?: string | null; checks?: Check[]; schemaCensus?: SchemaCensus }

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => { const el = event.target.closest('[data-message]'); if (el) vscode.postMessage({ type: el.dataset.message, tab: el.dataset.tab }); });
`;

function checks(values: unknown): string {
  const entries = list<Check>(values);
  if (!entries.length) return '<div class="empty"><p>No checks were returned for this scope.</p></div>';
  return `<div class="check-list">${entries.map((check) => { const status = check.status ?? check.state ?? 'unknown'; return `<article class="card"><h3>${escape(check.title ?? check.id ?? 'Check')} <span class="badge">${escape(status)}</span></h3><p>${escape(bounded(check.message ?? check.detail ?? ''))}</p>${check.remedy ? `<p class="callout"><strong>Remedy:</strong> ${escape(bounded(check.remedy, 500))}</p>` : ''}</article>`; }).join('')}</div>`;
}

function genericChecks(value: unknown): unknown {
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  return object.checks ?? object.findings ?? object.results ?? [];
}

function versions(family: SchemaFamily): string {
  if (Array.isArray(family.versions)) return family.versions.map((entry) => `${entry.version ?? '?'}: ${entry.count ?? 0}`).join(', ');
  return family.versions && typeof family.versions === 'object' ? Object.entries(family.versions).map(([version, count]) => `${version}: ${count}`).join(', ') : 'none';
}

export function schemaHealth(census: SchemaCensus | null | undefined): string {
  if (!census) return '<div class="empty"><p>Schema census requires a governed repository. Select a workspace, then refresh Diagnostics.</p></div>';
  const families = list<SchemaFamily>(census.families);
  const outsideRange = families.flatMap((family) => list<SchemaRecord>(family.outsideRange).map((record) => ({
    ...record, family: family.family,
    error: schemaRecordRemedy(record.storedVersion, family.readable?.minimum, family.readable?.maximum)
  })));
  const problematic = [
    ...outsideRange,
    ...list<SchemaRecord>(census.unreadable), ...list<SchemaRecord>(census.unregistered)
  ];
  const healthy = census.healthy === true && Number(census.totals?.unregistered ?? 0) === 0;
  return `<section class="plain"><div class="summary-grid"><div class="summary-card ${healthy ? '' : 'important'}"><strong>${healthy ? 'Healthy' : 'Needs attention'}</strong><span>schema census</span></div><div class="summary-card"><strong>${escape(census.scannedFiles ?? census.scanned ?? 0)}</strong><span>files scanned</span></div><div class="summary-card"><strong>${escape(census.scanned ?? 0)}</strong><span>records scanned</span></div><div class="summary-card"><strong>${census.truncated ? 'Bounded' : 'Complete'}</strong><span>${census.truncated ? 'census truncated at safety limit' : 'within census limit'}</span></div></div></section>
  <section><h2>Record families</h2><div class="table-wrap"><table><thead><tr><th>Family</th><th>Versions found</th><th>Readable range</th><th>Current</th><th>Records</th><th>Outside / unreadable</th></tr></thead><tbody>${families.map((family) => `<tr><td>${escape(family.family ?? 'unknown')}</td><td>${escape(versions(family))}</td><td>${escape(family.readable?.minimum ?? '?')}–${escape(family.readable?.maximum ?? '?')}</td><td>${escape(family.currentVersion ?? '?')}</td><td>${escape(family.records ?? 0)}</td><td>${list(family.outsideRange).length} / ${list(family.unreadable).length}</td></tr>`).join('')}</tbody></table></div></section>
  <section><h2>Unreadable, future, or unregistered records</h2>${problematic.length ? `<ul>${problematic.map((record) => `<li><strong>${escape(record.family ?? 'unregistered')}</strong> · version ${escape(record.storedVersion ?? record.schemaVersion ?? 'unknown')} · <code>${escape(record.path ?? 'record')}</code> · ${escape(bounded(record.error ?? record.reason ?? 'record requires attention'))}</li>`).join('')}</ul>` : '<p>No unreadable, future, or unregistered records were found.</p>'}
    <div class="callout"><h3>Exact remedies</h3><ul><li><strong>Future version:</strong> ${escape(SCHEMA_REMEDIES.future)}</li><li><strong>Older unreadable version:</strong> ${escape(SCHEMA_REMEDIES.older)}</li><li><strong>Unregistered family:</strong> ${escape(SCHEMA_REMEDIES.unregistered)}</li></ul></div></section>`;
}

export function diagnosticsBody(tab: Tab, repository: DoctorResult | null, capabilities: unknown, workspace: unknown, errors: Partial<Record<Tab, string>>): string {
  const tabs: Array<[Tab, string]> = [['repository', 'Repository'], ['capabilities', 'Capabilities'], ['workspace', 'Workspace Reliability'], ['schema', 'Schema Health']];
  const error = errors[tab];
  const body = tab === 'repository' ? `${repository ? `<section class="plain"><div class="summary-grid"><div class="summary-card ${repository.healthy ? '' : 'important'}"><strong>${repository.healthy ? 'Healthy' : 'Needs attention'}</strong><span>repository</span></div><div class="summary-card"><strong>${escape(repository.branch ?? '—')}</strong><span>branch</span></div><div class="summary-card"><strong>${escape(repository.workId ?? 'No active work')}</strong><span>work item</span></div></div></section>${checks(repository.checks)}` : '<div class="empty"><p>No governed repository is selected. Workspace and capability diagnostics remain available.</p></div>'}`
    : tab === 'capabilities' ? checks(genericChecks(capabilities))
      : tab === 'workspace' ? checks(genericChecks(workspace)) : schemaHealth(repository?.schemaCensus);
  return `<header><p class="eyebrow">Help</p><h1>${icon('statusCurrent', { size: 24 })} Diagnostics</h1><p class="meta">Repository, capability, workspace-reliability, and schema compatibility checks in one read-only view.</p></header>
    <nav class="tabs" aria-label="Diagnostic scopes">${tabs.map(([id, label]) => `<button class="${id === tab ? 'active' : ''}" data-message="tab" data-tab="${id}">${label}</button>`).join('')}</nav>
    <p class="card-foot"><button class="secondary" data-message="refresh">Run diagnostics again</button></p>${error ? `<section class="warning"><strong>${escape(tab)} diagnostics unavailable</strong><p>${escape(error)}</p></section>` : ''}${body}`;
}

export class DiagnosticsPanel {
  private static current: DiagnosticsPanel | null = null;
  private tab: Tab = 'repository'; private repository: DoctorResult | null = null; private capabilities: unknown = null; private workspace: unknown = null;
  private errors: Partial<Record<Tab, string>> = {};
  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private readonly hasRepository: () => boolean;
  private constructor(panel: vscode.WebviewPanel, client: SingularityFlowClient, hasRepository: () => boolean) {
    this.panel = panel; this.client = client; this.hasRepository = hasRepository;
    panel.webview.onDidReceiveMessage((raw) => { const navigation = navigationTarget(raw); if (navigation) return void navigateTo(navigation); this.router.route(raw); });
    panel.onDidDispose(() => { DiagnosticsPanel.current = null; }); void this.refresh();
  }
  static show(context: vscode.ExtensionContext, client: SingularityFlowClient, hasRepository: () => boolean): DiagnosticsPanel {
    if (DiagnosticsPanel.current) { DiagnosticsPanel.current.panel.reveal(); void DiagnosticsPanel.current.refresh(); return DiagnosticsPanel.current; }
    const panel = vscode.window.createWebviewPanel('singularityFlow.diagnostics', 'Diagnostics', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    DiagnosticsPanel.current = new DiagnosticsPanel(panel, client, hasRepository); return DiagnosticsPanel.current;
  }
  static refreshCurrent(): void { if (DiagnosticsPanel.current) void DiagnosticsPanel.current.refresh(); }
  private router = registerMessageRouter('singularityFlow.diagnostics', {
    tab: (m) => { const tab = enumField(m, 'tab', ['repository', 'capabilities', 'workspace', 'schema'] as const); if (tab) { this.tab = tab; this.render(); } },
    refresh: () => { void this.refresh(); }
  });
  async refresh(): Promise<void> {
    this.errors = {};
    const read = async (tab: Tab, args: string[]): Promise<unknown> => { try { return commandData(await this.client.run(args)); } catch (error) { this.errors[tab] = (error as Error).message; return null; } };
    const [repository, capabilities, workspace] = await Promise.all([
      this.hasRepository() ? read('repository', ['doctor', '--offline', '--json']) : null,
      read('capabilities', ['capabilities', 'doctor', '--offline', '--json']),
      read('workspace', ['workspace', 'doctor', '--json'])
    ]);
    this.repository = repository as DoctorResult | null; this.capabilities = capabilities; this.workspace = workspace;
    if (this.errors.repository) this.errors.schema = this.errors.repository;
    this.render();
  }
  private render(): void { const token = nonce(); this.panel.webview.html = page('Diagnostics', diagnosticsBody(this.tab, this.repository, this.capabilities, this.workspace, this.errors), contentSecurityPolicy(this.panel.webview, token), token, SCRIPT, { nav: 'doctor' }); }
}

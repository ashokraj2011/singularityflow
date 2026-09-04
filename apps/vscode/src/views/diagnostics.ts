/** Canonical visual diagnostics, including the bounded schema census from `doctor --json`. */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { bounded, commandData, list } from './surface-adapters.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { enumField, registerMessageRouter } from './messages.ts';
import { SCHEMA_REMEDIES, schemaRecordRemedy } from './surface-contracts.ts';

type Tab = 'repository' | 'capabilities' | 'workspace' | 'schema' | 'passport';
interface Check { id?: string; status?: string; state?: string; title?: string; message?: string; detail?: string; remedy?: string }
interface SchemaRecord { family?: string; path?: string; storedVersion?: number; schemaVersion?: number; error?: string; reason?: string }
interface SchemaFamily { family?: string; currentVersion?: number; readable?: { minimum?: number; maximum?: number }; records?: number; versions?: Record<string, number> | Array<{ version?: number; count?: number }>; outsideRange?: SchemaRecord[]; unreadable?: SchemaRecord[] }
interface SchemaCensus { scanned?: number; scannedFiles?: number; truncated?: boolean; healthy?: boolean; totals?: Record<string, number>; families?: SchemaFamily[]; unregistered?: SchemaRecord[]; unreadable?: SchemaRecord[] }
interface DoctorResult { healthy?: boolean; repository?: string; branch?: string; head?: string; workId?: string | null; checks?: Check[]; schemaCensus?: SchemaCensus }
interface ShadowGap { code?: string; status?: string; message?: string }
interface ShadowPassport {
  mode?: string; authority?: string; status?: string;
  subject?: { kind?: string; id?: string };
  candidate?: { status?: string; candidateSha256?: string | null };
  records?: { proofSubject?: { proofSubjectSha256?: string }; passport?: { passportId?: string; passportSha256?: string } } | null;
  policies?: { status?: string; proofProfile?: { value?: string; status?: string } };
  evidence?: { status?: string; proofSummarySha256?: string | null; decisionRefs?: string[]; publicationRefs?: string[] };
  worldModel?: { status?: string; reasonCode?: string | null };
  gaps?: ShadowGap[];
  comparison?: { category?: string; explained?: boolean; legacyLifecycleStatus?: string; shadowStatus?: string };
  guarantees?: { consumedByLifecycle?: boolean; noWrites?: boolean; noModel?: boolean; worldModelRequired?: boolean };
}
interface ProofResult {
  predicate?: { id?: string; version?: number };
  verdict?: string; reasonCode?: string; resultSha256?: string;
}
interface ProofObservation {
  mode?: string; authority?: string; status?: string;
  proofSubject?: { proofSubjectSha256?: string } | null;
  summary?: {
    verdict?: string; summarySha256?: string;
    predicateResults?: { passed?: string[]; failed?: string[]; unavailable?: string[]; notApplicable?: string[] };
  } | null;
  results?: ProofResult[];
  gaps?: Array<ShadowGap & { gapId?: string; proposition?: string }>;
  signals?: unknown[];
  guarantees?: { consumedByLifecycle?: boolean; noWrites?: boolean; noModel?: boolean; signalsGateEligible?: boolean };
}

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

function digestLabel(value: unknown): string {
  const source = typeof value === 'string' ? value : '';
  return /^sha256:[a-f0-9]{64}$/.test(source) ? `${source.slice(0, 19)}…` : 'unavailable';
}

export function shadowPassportHealth(passport: ShadowPassport | null | undefined, proof?: ProofObservation | null): string {
  if (!passport) return '<div class="empty"><p>No active Story is available for the optional shadow Passport diagnostic.</p></div>';
  const gaps = list<ShadowGap>(passport.gaps);
  const proofResults = list<ProofResult>(proof?.results);
  const proofGaps = list<ShadowGap & { gapId?: string; proposition?: string }>(proof?.gaps);
  return `<section class="warning"><strong>Diagnostic only — no authority</strong><p>This GDP-M2 shadow view is read-only. Gates, approvals, publishers, and lifecycle decisions do not consume it.</p></section>
  <section class="plain"><div class="summary-grid"><div class="summary-card"><strong>${escape(passport.status ?? 'unavailable')}</strong><span>shadow status</span></div><div class="summary-card"><strong>${escape(passport.subject?.id ?? 'No Story')}</strong><span>${escape(passport.subject?.kind ?? 'subject')}</span></div><div class="summary-card"><strong>${escape(passport.comparison?.category ?? 'unavailable')}</strong><span>legacy comparison</span></div><div class="summary-card"><strong>${escape(passport.worldModel?.status ?? 'unavailable')}</strong><span>World Model · never blocking</span></div></div></section>
  <section><h2>Identity</h2><div class="table-wrap"><table><tbody><tr><th>Candidate</th><td><code>${escape(digestLabel(passport.candidate?.candidateSha256))}</code></td></tr><tr><th>Proof Subject</th><td><code>${escape(digestLabel(passport.records?.proofSubject?.proofSubjectSha256))}</code></td></tr><tr><th>Change Passport</th><td><code>${escape(digestLabel(passport.records?.passport?.passportSha256))}</code></td></tr><tr><th>Proof profile</th><td>${escape(passport.policies?.proofProfile?.value ?? 'standard')} · ${escape(passport.policies?.proofProfile?.status ?? 'shadow')}</td></tr><tr><th>Evidence</th><td>${escape(passport.evidence?.status ?? 'unavailable')} · Proof Summary ${passport.evidence?.proofSummarySha256 ? escape(digestLabel(passport.evidence.proofSummarySha256)) : 'unavailable'}</td></tr></tbody></table></div></section>
  <section><h2>Known gaps</h2>${gaps.length ? `<ul>${gaps.map((gap) => `<li><strong>${escape(gap.code ?? 'GDP_GAP')}</strong> · ${escape(gap.status ?? 'unavailable')} · ${escape(bounded(gap.message ?? '', 500))}</li>`).join('')}</ul>` : '<p>No shadow gaps were reported.</p>'}</section>
  <section><h2>Deterministic proof observation</h2>${proof?.summary ? `<div class="summary-grid"><div class="summary-card"><strong>${escape(proof.summary.verdict ?? proof.status ?? 'unavailable')}</strong><span>proof verdict</span></div><div class="summary-card"><strong>${proofResults.length}</strong><span>bounded predicates</span></div><div class="summary-card"><strong>${proofGaps.length}</strong><span>explicit gaps</span></div><div class="summary-card"><strong>${list(proof.signals).length}</strong><span>signals · never verdicts</span></div></div><div class="table-wrap"><table><thead><tr><th>Predicate</th><th>Result</th><th>Reason</th><th>Identity</th></tr></thead><tbody>${proofResults.map((result) => `<tr><td>${escape(result.predicate?.id ?? 'unknown')}@${escape(result.predicate?.version ?? '?')}</td><td>${escape(result.verdict ?? 'unavailable')}</td><td>${escape(result.reasonCode ?? 'PFC_RESULT_UNAVAILABLE')}</td><td><code>${escape(digestLabel(result.resultSha256))}</code></td></tr>`).join('')}</tbody></table></div>${proofGaps.length ? `<h3>Proof gaps</h3><ul>${proofGaps.map((gap) => `<li><strong>${escape(gap.gapId ?? gap.code ?? 'GDP_GAP')}</strong> · ${escape(gap.status ?? 'unavailable')} · ${escape(bounded(gap.proposition ?? gap.message ?? '', 500))}</li>`).join('')}</ul>` : ''}<p class="callout"><strong>Observe only:</strong> deterministic results and Signals cannot approve, publish, or change Story state in GDP-M3. Summary <code>${escape(digestLabel(proof.summary.summarySha256))}</code>.</p>` : '<div class="empty"><p>No GDP-M3 proof observation is available for this Story.</p></div>'}</section>`;
}

export function diagnosticsBody(tab: Tab, repository: DoctorResult | null, capabilities: unknown, workspace: unknown, passport: ShadowPassport | null, proof: ProofObservation | null, errors: Partial<Record<Tab, string>>): string {
  const tabs: Array<[Tab, string]> = [['repository', 'Repository'], ['capabilities', 'Capabilities'], ['workspace', 'Workspace Reliability'], ['schema', 'Schema Health'], ['passport', 'Shadow Passport']];
  const error = errors[tab];
  const body = tab === 'repository' ? `${repository ? `<section class="plain"><div class="summary-grid"><div class="summary-card ${repository.healthy ? '' : 'important'}"><strong>${repository.healthy ? 'Healthy' : 'Needs attention'}</strong><span>repository</span></div><div class="summary-card"><strong>${escape(repository.branch ?? '—')}</strong><span>branch</span></div><div class="summary-card"><strong>${escape(repository.workId ?? 'No active work')}</strong><span>work item</span></div></div></section>${checks(repository.checks)}` : '<div class="empty"><p>No governed repository is selected. Workspace and capability diagnostics remain available.</p></div>'}`
    : tab === 'capabilities' ? checks(genericChecks(capabilities))
      : tab === 'workspace' ? checks(genericChecks(workspace))
        : tab === 'schema' ? schemaHealth(repository?.schemaCensus) : shadowPassportHealth(passport, proof);
  return `<header><p class="eyebrow">Help</p><h1>${icon('statusCurrent', { size: 24 })} Diagnostics</h1><p class="meta">Repository, capability, workspace-reliability, schema compatibility, and optional shadow Passport checks in one read-only view.</p></header>
    <nav class="tabs" aria-label="Diagnostic scopes">${tabs.map(([id, label]) => `<button class="${id === tab ? 'active' : ''}" data-message="tab" data-tab="${id}">${label}</button>`).join('')}</nav>
    <p class="card-foot"><button class="secondary" data-message="refresh">Run diagnostics again</button></p>${error ? `<section class="warning"><strong>${escape(tab)} diagnostics unavailable</strong><p>${escape(error)}</p></section>` : ''}${body}`;
}

export class DiagnosticsPanel {
  private static current: DiagnosticsPanel | null = null;
  private tab: Tab = 'repository'; private repository: DoctorResult | null = null; private capabilities: unknown = null; private workspace: unknown = null; private passport: ShadowPassport | null = null; private proof: ProofObservation | null = null;
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
    tab: (m) => { const tab = enumField(m, 'tab', ['repository', 'capabilities', 'workspace', 'schema', 'passport'] as const); if (tab) { this.tab = tab; this.render(); } },
    refresh: () => { void this.refresh(); }
  });
  async refresh(): Promise<void> {
    this.errors = {};
    const read = async (tab: Tab, args: string[]): Promise<unknown> => { try { return commandData(await this.client.run(args)); } catch (error) { this.errors[tab] = (error as Error).message; return null; } };
    const [repository, capabilities, workspace, passport, proof] = await Promise.all([
      this.hasRepository() ? read('repository', ['doctor', '--offline', '--json']) : null,
      read('capabilities', ['capabilities', 'doctor', '--offline', '--json']),
      read('workspace', ['workspace', 'doctor', '--json']),
      this.hasRepository() ? read('passport', ['change', 'show', '--shadow', '--json']) : null,
      this.hasRepository() ? read('passport', ['proof', 'status', '--json']) : null
    ]);
    this.repository = repository as DoctorResult | null; this.capabilities = capabilities; this.workspace = workspace; this.passport = passport as ShadowPassport | null; this.proof = proof as ProofObservation | null;
    if (this.errors.repository) this.errors.schema = this.errors.repository;
    this.render();
  }
  private render(): void { const token = nonce(); this.panel.webview.html = page('Diagnostics', diagnosticsBody(this.tab, this.repository, this.capabilities, this.workspace, this.passport, this.proof, this.errors), contentSecurityPolicy(this.panel.webview, token), token, SCRIPT, { nav: 'doctor' }); }
}

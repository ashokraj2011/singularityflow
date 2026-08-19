/**
 * Governed Flow Impact measurement and study reporting.
 *
 * This deliberately does not share a name with `impact.ts`: that panel answers "what repositories
 * will this proposed change touch?". This one answers "what delivery outcome did the configured
 * study observe?" and delegates every calculation and mutation to the CLI.
 */
import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { WorkspaceStore } from '../state.ts';
import { brandLockup, contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';

interface ImpactGroup { id: string; label: string; assistanceMode: string }
export interface ImpactStudy {
  id: string; label: string; enabled: boolean; method: string;
  groups: ImpactGroup[];
  primaryMetric: { id: string; direction: string; unit: string };
  guardrails: Array<{ id: string; maximumRegressionPercent: number }>;
  privacy: { minimumCohortSize: number; allowedDimensions: string[] };
}

interface ImpactMeasurement {
  status: string;
  plan?: { studyId?: string; groupId?: string; path?: string; sha256?: string } | null;
  classification?: {
    suggested?: { complexity?: string; risk?: string } | null;
    confirmed?: { complexity?: string; risk?: string } | null;
  } | null;
  exposures?: Array<{ phaseId: string; level: string; assurance: string; sha256: string }>;
  evidence?: Array<{ evidenceId: string; metric?: string; path?: string; sha256?: string }>;
  receipt?: { status: string; path: string; sha256: string; finalizedAt?: string } | null;
}

interface ImpactStatus { workId: string; measurement: ImpactMeasurement }
interface ImpactFinding { severity: string; code: string; message: string }
interface ImpactDoctor { valid: boolean; findings: ImpactFinding[]; bandDrift?: unknown[] }
export interface ImpactComparison {
  study: string; method: string; evidenceGrade: string; inference: string; label: string;
  primaryMetric: { id: string; direction: string; unit: string };
  cohorts: { baseline: string; treatment: string; matchedBaseline: number; matchedTreatment: number; privacyFloor: number };
  result: {
    baselineMedian: number; treatmentMedian: number; gainPercent: number;
    confidenceInterval: { lower: number; upper: number };
  };
  guardrails: Array<{ metric: string; passed: boolean; regressionPercent: number | null; maximumRegressionPercent: number }>;
  qualityGatePassed: boolean;
  completeness: { eligibleReceipts: number; matchedStrata: number; usableBaseline: number; usableTreatment: number };
}

export interface FlowImpactState {
  studies: ImpactStudy[];
  workIds: Array<{ id: string; title?: string }>;
  selectedWorkId: string | null;
  status: ImpactStatus | null;
  doctor: ImpactDoctor | null;
  comparison: ImpactComparison | null;
  selectedStudyId: string | null;
  configText: string;
  configMissing: boolean;
  loading: boolean;
  notice: string | null;
  error: string | null;
}

const DEFAULT_IMPACT = `version: 1
automaticEnrollment: true

studies:
  - id: governed-ai-delivery
    label: Governed AI delivery
    enabled: false
    unit: story
    method: matched-observational
    eligibility:
      workTypes: [feature, bugfix, chore]
      capabilities: []
    groups:
      - id: baseline
        label: Baseline
        assistanceMode: baseline
        weight: 1
      - id: governed-agent
        label: Governed agent
        assistanceMode: governed-agent
        weight: 1
    matching:
      dimensions: [capability, repository-class, work-type, complexity, risk, time-period]
      timePeriod: quarter
      seed: governed-ai-delivery-v1
    primaryMetric:
      id: flow-time-excluding-approval-wait-ms
      direction: lower
    guardrails:
      - id: rework-cycles
        maximumRegressionPercent: 10
    reporting:
      bootstrapSamples: 1000
      confidenceLevel: 0.95
    privacy:
      individualReporting: false
      minimumCohortSize: 5
      pseudonymizeContributors: true
      allowedDimensions: [capability, repository-class, work-type, complexity, risk, time-period]
`;

function titleCase(value: string): string {
  return value.replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function numeric(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Unavailable';
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function studyCards(studies: ImpactStudy[], selected: string | null): string {
  if (!studies.length) return '<div class="empty"><p>No Flow Impact studies are configured yet. Start in the Configuration tab.</p></div>';
  return `<div class="decision-cards">${studies.map((study) => `<button class="artifact-card ${study.id === selected ? 'selected' : ''}" data-study="${escape(study.id)}">
    <span class="artifact-title">${icon('impact')}${escape(study.label)}</span><span class="pill ${study.enabled ? 'ok' : ''}">${study.enabled ? 'enabled' : 'disabled'}</span>
    <span class="artifact-meta">${escape(titleCase(study.method))} · ${escape(study.primaryMetric.id)} · privacy floor ${study.privacy.minimumCohortSize} per cohort</span>
  </button>`).join('')}</div>`;
}

function storyHtml(state: FlowImpactState): string {
  const status = state.status;
  const measurement = status?.measurement;
  const options = state.workIds.map((item) => `<option value="${escape(item.id)}" ${item.id === state.selectedWorkId ? 'selected' : ''}>${escape(item.id)}${item.title ? ` — ${escape(item.title)}` : ''}</option>`).join('');
  if (!state.workIds.length) return `<section><h2>${icon('story')}Story measurement</h2><div class="empty"><p>No Story is available in this repository. Start or attach a Story to inspect its study enrollment.</p></div></section>`;
  const suggested = measurement?.classification?.suggested;
  const confirmed = measurement?.classification?.confirmed;
  const exposures = measurement?.exposures ?? [];
  const evidence = measurement?.evidence ?? [];
  const doctor = state.doctor;
  const doctorFindings = doctor?.findings ?? [];
  return `<section>
    <div class="section-heading"><div class="grow"><h2>${icon('story')}Story measurement</h2><p class="muted">Classification, observed assistance, imported evidence, and the final receipt are committed with the Story.</p></div>
      <label>Story <select id="impact-story">${options}</select></label></div>
    ${status ? `<div class="summary-grid">
      <div class="summary-card important"><strong>${escape(titleCase(measurement?.status ?? 'not-enrolled'))}</strong><span>Measurement state</span></div>
      <div class="summary-card"><strong>${escape(measurement?.plan?.studyId ?? 'None')}</strong><span>Study</span></div>
      <div class="summary-card"><strong>${escape(measurement?.plan?.groupId ?? 'Not assigned')}</strong><span>Cohort</span></div>
      <div class="summary-card"><strong>${evidence.length}</strong><span>Evidence records</span></div>
    </div>
    <div class="card"><div class="card-head"><h3>Classification</h3><span class="pill ${confirmed ? 'ok' : 'wait'}">${confirmed ? 'confirmed' : 'human confirmation required'}</span></div>
      <p>Suggested <strong>${escape(suggested?.complexity ?? 'unknown')} / ${escape(suggested?.risk ?? 'unknown')}</strong> · Confirmed <strong>${escape(confirmed ? `${confirmed.complexity} / ${confirmed.risk}` : 'pending')}</strong></p>
      <p class="card-foot"><button data-action="enroll" ${!measurement?.plan || confirmed ? 'disabled' : ''}>Confirm classification</button><button class="secondary" data-action="opt-out" ${!measurement?.plan || measurement?.status === 'opted-out' ? 'disabled' : ''}>Opt out with reason</button></p>
    </div>
    <div class="analytics-columns">
      <div><h3>Assistance exposure</h3>${exposures.length ? `<table><thead><tr><th>Phase</th><th>Level</th><th>Assurance</th><th>Hash</th></tr></thead><tbody>${exposures.map((item) => `<tr><td>${escape(item.phaseId)}</td><td>${escape(item.level)}</td><td>${escape(item.assurance)}</td><td><code>${escape(item.sha256.slice(0, 12))}</code></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No exposure has been observed or attested.</p>'}<p><button class="secondary" data-action="attest" ${!measurement?.plan ? 'disabled' : ''}>Record exposure attestation</button></p></div>
      <div><h3>Metric evidence</h3>${evidence.length ? `<table><thead><tr><th>ID</th><th>Metric</th><th>Hash</th></tr></thead><tbody>${evidence.map((item) => `<tr><td><code>${escape(item.evidenceId)}</code></td><td>${escape(item.metric ?? 'unknown')}</td><td><code>${escape(item.sha256?.slice(0, 12) ?? '')}</code></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No external metric evidence has been imported.</p>'}<p><button class="secondary" data-action="import-evidence" ${!measurement?.plan ? 'disabled' : ''}>Import evidence JSON</button></p></div>
    </div>
    <div class="card"><div class="card-head"><h3>Impact Receipt</h3><span class="pill ${measurement?.receipt?.status === 'active' ? 'ok' : ''}">${escape(measurement?.receipt?.status ?? 'not finalized')}</span></div>
      ${measurement?.receipt ? `<p><code>${escape(measurement.receipt.path)}</code> · <code>${escape(measurement.receipt.sha256.slice(0, 12))}</code></p>` : '<p class="muted">Finalizing the Story creates the normalized, hash-bound Impact Receipt.</p>'}
      <p class="card-foot"><button class="secondary" data-action="verify" ${!measurement?.receipt ? 'disabled' : ''}>Verify receipt</button><button class="link" data-action="doctor">Run measurement doctor</button></p>
    </div>
    ${doctor ? `<div class="card ${doctor.valid ? '' : 'blocked'}"><div class="card-head"><h3>${icon(doctor.valid ? 'ok' : 'warning')}Measurement diagnostics</h3><span class="pill ${doctor.valid ? 'ok' : 'bad'}">${doctor.valid ? 'healthy' : 'attention required'}</span></div>
      ${doctorFindings.length ? `<ul>${doctorFindings.map((finding) => `<li><strong>${escape(finding.severity.toUpperCase())} · ${escape(finding.code)}</strong><br><span class="muted">${escape(finding.message)}</span></li>`).join('')}</ul>` : '<p>No measurement findings.</p>'}</div>` : ''}` : '<div class="empty"><p>Choose a Story to load its governed measurement state.</p></div>'}
  </section>`;
}

function comparisonHtml(result: ImpactComparison | null): string {
  if (!result) return '<div class="empty"><p>Choose an enabled study and run the comparison. The engine will refuse results below the privacy floor.</p></div>';
  return `<div class="summary-grid">
    <div class="summary-card important"><strong>${numeric(result.result.gainPercent)}%</strong><span>${escape(result.label)}</span></div>
    <div class="summary-card"><strong>${escape(result.evidenceGrade)}</strong><span>Evidence grade · ${escape(result.inference)}</span></div>
    <div class="summary-card"><strong>${result.cohorts.matchedBaseline} / ${result.cohorts.matchedTreatment}</strong><span>Usable baseline / treatment</span></div>
    <div class="summary-card"><strong>${result.completeness.matchedStrata}</strong><span>Matched strata</span></div>
  </div>
  <div class="card"><h3>${escape(result.primaryMetric.id)}</h3><p>Baseline median <strong>${numeric(result.result.baselineMedian)}</strong> · Treatment median <strong>${numeric(result.result.treatmentMedian)}</strong></p>
    <p>Bootstrap confidence interval <strong>${numeric(result.result.confidenceInterval.lower)}% to ${numeric(result.result.confidenceInterval.upper)}%</strong></p></div>
  <table><thead><tr><th>Guardrail</th><th>Regression</th><th>Maximum</th><th>Result</th></tr></thead><tbody>${result.guardrails.map((item) => `<tr><td>${escape(item.metric)}</td><td>${item.regressionPercent == null ? 'Unavailable' : `${numeric(item.regressionPercent)}%`}</td><td>${numeric(item.maximumRegressionPercent)}%</td><td><span class="pill ${item.passed ? 'ok' : 'bad'}">${item.passed ? 'pass' : 'fail'}</span></td></tr>`).join('')}</tbody></table>`;
}

export function flowImpactBody(state: FlowImpactState, tab = 'overview'): string {
  const selectedStudy = state.studies.find((item) => item.id === state.selectedStudyId) ?? null;
  const tabButton = (id: string, label: string): string => `<button class="${tab === id ? '' : 'secondary'}" data-tab="${id}">${label}</button>`;
  const banner = state.error ? `<p class="blockers">${icon('bad')}${escape(state.error)}</p>` : state.notice ? `<p class="ok-text">${icon('ok')}${escape(state.notice)}</p>` : '';
  return `<header class="inbox-header">${brandLockup()}<p class="eyebrow">Governed delivery measurement</p>
    <h1>${icon('impact', { size: 24 })}Flow Impact</h1><p class="meta">Configure studies, inspect Story enrollment and evidence, compare privacy-safe cohorts, and export normalized receipts.</p></header>
    <nav class="instruction-tabs" aria-label="Flow Impact sections">${tabButton('overview', 'Overview')}${tabButton('story', 'Story measurement')}${tabButton('reports', 'Study reports')}${tabButton('configuration', 'Configuration')}</nav>
    ${banner}
    ${state.loading ? '<p class="muted">Refreshing governed impact data…</p>' : ''}
    ${tab === 'overview' ? `<section class="plain"><div class="section-heading"><div class="grow"><h2>${icon('impact')}Configured studies</h2><p class="muted">Only enabled studies may enroll new Stories. Assignment is deterministic and the human confirms complexity and risk before implementation.</p></div><button class="secondary" data-action="refresh">Refresh</button></div>${studyCards(state.studies, state.selectedStudyId)}</section>${storyHtml(state)}` : ''}
    ${tab === 'story' ? storyHtml(state) : ''}
    ${tab === 'reports' ? `<section class="plain"><div class="section-heading"><div class="grow"><h2>${icon('impact')}Cohort comparison</h2><p class="muted">Statistics, matching, confidence intervals, guardrails, and privacy-floor refusal come from the Flow engine.</p></div><button class="secondary" data-action="export">Export receipts</button></div>
      <div class="card-foot"><label>Study <select id="report-study">${state.studies.map((study) => `<option value="${escape(study.id)}" ${study.id === state.selectedStudyId ? 'selected' : ''}>${escape(study.label)}${study.enabled ? '' : ' (disabled)'}</option>`).join('')}</select></label><button data-action="compare" ${!selectedStudy ? 'disabled' : ''}>Run comparison</button></div>
      ${comparisonHtml(state.comparison)}</section>` : ''}
    ${tab === 'configuration' ? `<section class="plain"><div class="section-heading"><div class="grow"><h2>${icon('configuration')}Study configuration</h2><p class="muted"><code>singularity/impact.yml</code> is validated by the CLI before it is saved. Enabling a study affects future enrollment; active Stories retain their pinned study hash.</p></div><button class="secondary" data-action="open-config">Open as file</button></div>
      ${state.configMissing ? '<p class="warning-text">No impact.yml exists. The starter below is disabled by default and safe to review before saving.</p>' : ''}
      <textarea id="impact-config" class="prompt-content" rows="30" spellcheck="false">${escape(state.configText)}</textarea><p class="card-foot"><button data-action="save-config">Validate and save configuration</button><span class="muted">Saving changes the working tree; commit it through your normal governed configuration review.</span></p></section>` : ''}`;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  let tab = 'overview';
  document.addEventListener('click', (event) => {
    const tabTarget = event.target.closest('[data-tab]');
    if (tabTarget) { vscode.postMessage({ type: 'tab', tab: tabTarget.dataset.tab }); return; }
    const study = event.target.closest('[data-study]');
    if (study) { vscode.postMessage({ type: 'study', studyId: study.dataset.study }); return; }
    const action = event.target.closest('[data-action]');
    if (!action) return;
    const message = { type: 'action', action: action.dataset.action };
    if (message.action === 'save-config') message.content = document.getElementById('impact-config').value;
    if (message.action === 'compare') message.studyId = document.getElementById('report-study')?.value;
    vscode.postMessage(message);
  });
  document.addEventListener('change', (event) => {
    if (event.target.id === 'impact-story') vscode.postMessage({ type: 'story', workId: event.target.value });
    if (event.target.id === 'report-study') vscode.postMessage({ type: 'study', studyId: event.target.value });
  });
`;

type Message =
  | { type: 'tab'; tab: string }
  | { type: 'story'; workId: string }
  | { type: 'study'; studyId: string }
  | { type: 'action'; action: string; content?: string; studyId?: string };

export class FlowImpactPanel {
  private static current: FlowImpactPanel | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly subscription: { dispose(): void };
  private refreshRevision = 0;
  private refreshPending = false;
  private tab = 'overview';
  private state: FlowImpactState = {
    studies: [], workIds: [], selectedWorkId: null, status: null, doctor: null,
    comparison: null, selectedStudyId: null, configText: DEFAULT_IMPACT,
    configMissing: true, loading: true, notice: null, error: null
  };

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    _context: vscode.ExtensionContext,
    private readonly store: WorkspaceStore,
    private readonly client: SingularityFlowClient
  ) {
    this.subscription = store.onDidChange((_state, change) => {
      if (change.kind !== 'snapshot' || !change.revisionChanged) return;
      if (this.panel.visible === false) { this.refreshPending = true; return; }
      void this.refresh();
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      void this.onMessage(raw as Message);
    }, null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.onDidChangeViewState?.(({ webviewPanel }) => {
      if (webviewPanel.visible === false || !this.refreshPending) return;
      this.refreshPending = false;
      void this.refresh();
    }, null, this.disposables);
    void this.refresh();
  }

  static show(context: vscode.ExtensionContext, store: WorkspaceStore, client: SingularityFlowClient): FlowImpactPanel {
    if (FlowImpactPanel.current) {
      FlowImpactPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void FlowImpactPanel.current.refresh();
      return FlowImpactPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.flowImpact', 'Flow Impact', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    FlowImpactPanel.current = new FlowImpactPanel(panel, context, store, client);
    return FlowImpactPanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Flow Impact', flowImpactBody(this.state, this.tab), contentSecurityPolicy(this.panel.webview, token), token, SCRIPT);
  }

  private async refresh(notice: string | null = this.state.notice): Promise<void> {
    const revision = ++this.refreshRevision;
    const snapshot = this.store.current.snapshot;
    const workIds = (snapshot?.workItems ?? []).map((item) => ({ id: item.id, title: item.title }));
    const previousWorkId = this.state.selectedWorkId;
    const selected = this.state.selectedWorkId && workIds.some((item) => item.id === this.state.selectedWorkId)
      ? this.state.selectedWorkId : snapshot?.selectedWorkId ?? snapshot?.workflow?.workItem.id ?? workIds[0]?.id ?? null;
    this.state = {
      ...this.state, workIds, selectedWorkId: selected,
      doctor: selected === previousWorkId ? this.state.doctor : null,
      loading: true, notice, error: null
    };
    this.render();
    try {
      const [studies, configText, status] = await Promise.all([
        this.client.run<ImpactStudy[]>(['impact', 'study', 'list', '--json']).catch(() => []),
        readFile(path.join(this.client.repository, 'singularity/impact.yml'), 'utf8').catch(() => null),
        selected ? this.client.run<ImpactStatus>(['impact', 'status', selected, '--json']).catch(() => null) : Promise.resolve(null)
      ]);
      if (revision !== this.refreshRevision) return;
      const selectedStudyId = this.state.selectedStudyId && studies.some((item) => item.id === this.state.selectedStudyId)
        ? this.state.selectedStudyId : status?.measurement.plan?.studyId ?? studies[0]?.id ?? null;
      this.state = {
        ...this.state, studies, status, selectedStudyId, configText: configText ?? DEFAULT_IMPACT,
        configMissing: configText == null, loading: false
      };
    } catch (error) {
      if (revision !== this.refreshRevision) return;
      this.state = { ...this.state, loading: false, error: (error as Error).message };
    }
    this.render();
  }

  private async mutation(action: () => Promise<string>, success: string): Promise<void> {
    try {
      const output = await action();
      this.state = { ...this.state, notice: output.trim() || success, error: null };
      await this.store.refresh();
    } catch (error) {
      this.state = { ...this.state, error: (error as Error).message, notice: null };
      this.render();
    }
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.type === 'tab') { this.tab = message.tab; this.render(); return; }
    if (message.type === 'study') { this.state = { ...this.state, selectedStudyId: message.studyId, comparison: null }; this.render(); return; }
    if (message.type === 'story') {
      this.state = { ...this.state, selectedWorkId: message.workId, status: null, doctor: null };
      await this.refresh(); return;
    }
    const workId = this.state.selectedWorkId;
    if (message.action === 'refresh') { await this.refresh('Flow Impact data refreshed.'); return; }
    if (message.action === 'open-config') {
      if (this.state.configMissing) {
        this.state = { ...this.state, notice: 'Save the reviewed starter configuration first; no impact.yml exists yet.', error: null };
        this.render();
        return;
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(this.client.repository, 'singularity/impact.yml')));
      await vscode.window.showTextDocument(document, { preview: false }); return;
    }
    if (message.action === 'save-config') {
      await this.mutation(
        () => this.client.runText(['configuration', 'save', 'singularity/impact.yml'], { input: message.content ?? '' }),
        'Impact configuration validated and saved.'
      ); return;
    }
    if (message.action === 'compare') {
      const studyId = message.studyId ?? this.state.selectedStudyId;
      if (!studyId) return;
      this.state = { ...this.state, loading: true, error: null }; this.render();
      try {
        const comparison = await this.client.run<ImpactComparison>(['impact', 'compare', studyId, '--json']);
        this.state = { ...this.state, comparison, selectedStudyId: studyId, loading: false };
      } catch (error) { this.state = { ...this.state, loading: false, error: (error as Error).message }; }
      this.render(); return;
    }
    if (message.action === 'export') {
      const target = await vscode.window.showSaveDialog({
        title: 'Export normalized Flow Impact receipts',
        defaultUri: vscode.Uri.file(path.join(this.client.repository, `flow-impact-${this.state.selectedStudyId ?? 'all'}.jsonl`)),
        filters: { 'JSON Lines': ['jsonl'] }
      });
      if (!target) return;
      const args = ['impact', 'export', '--out', target.fsPath, '--json'];
      if (this.state.selectedStudyId) args.push('--study', this.state.selectedStudyId);
      try {
        const result = await this.client.run<{ receipts: number; output: string; sha256: string }>(args);
        this.state = { ...this.state, notice: `Exported ${result.receipts} receipt(s) to ${result.output}.`, error: null };
      } catch (error) { this.state = { ...this.state, error: (error as Error).message }; }
      this.render(); return;
    }
    if (!workId) return;
    if (message.action === 'enroll') {
      const bands = ['small', 'medium', 'large', 'extra-large'];
      const complexity = await vscode.window.showQuickPick(bands, { title: `${workId}: confirm complexity` });
      if (!complexity) return;
      const risk = await vscode.window.showQuickPick(bands, { title: `${workId}: confirm risk` });
      if (!risk) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Confirm Flow Impact classification for ${workId}?`,
        { modal: true, detail: `Complexity: ${complexity}\nRisk: ${risk}\nThis decision is committed and pushed with the Story.` }, 'Confirm classification'
      );
      if (confirmed !== 'Confirm classification') return;
      await this.mutation(() => this.client.runText(['impact', 'enroll', workId, '--complexity', complexity, '--risk', risk, '--confirm']), 'Classification confirmed.'); return;
    }
    if (message.action === 'opt-out') {
      const reason = await vscode.window.showInputBox({ title: `${workId}: opt out of Flow Impact`, prompt: 'Reason (required)', validateInput: (value) => value.trim() ? null : 'A reason is required.' });
      if (!reason?.trim()) return;
      const confirmed = await vscode.window.showWarningMessage(`Opt ${workId} out of its Flow Impact study?`, { modal: true, detail: reason.trim() }, 'Opt out');
      if (confirmed !== 'Opt out') return;
      await this.mutation(() => this.client.runText(['impact', 'enroll', workId, '--opt-out', '--reason', reason.trim(), '--confirm']), 'Story opted out.'); return;
    }
    if (message.action === 'attest') {
      const phases = this.store.current.snapshot?.workflow?.workItem.id === workId ? this.store.current.snapshot.workflow.phaseOrder : [];
      const phase = phases.length
        ? await vscode.window.showQuickPick(phases, { title: `${workId}: phase where assistance was used` })
        : await vscode.window.showInputBox({ title: `${workId}: phase where assistance was used` });
      if (!phase) return;
      const level = await vscode.window.showQuickPick(['available', 'invoked', 'artifact-assisted', 'code-assisted', 'agent-executed', 'unknown'], { title: 'Observed assistance level' });
      if (!level) return;
      const assurance = await vscode.window.showQuickPick(['host-observed', 'provider-verified', 'attested', 'unknown'], { title: 'Evidence assurance' });
      if (!assurance) return;
      const reason = await vscode.window.showInputBox({ title: 'Attestation note', prompt: 'Explain the observation (optional)' });
      const args = ['impact', 'exposure', 'attest', workId, '--phase', phase, '--level', level, '--assurance', assurance];
      if (reason?.trim()) args.push('--reason', reason.trim());
      await this.mutation(() => this.client.runText(args), 'Exposure recorded.'); return;
    }
    if (message.action === 'import-evidence') {
      const files = await vscode.window.showOpenDialog({ title: `${workId}: import Flow Impact evidence JSON`, canSelectMany: false, filters: { JSON: ['json'] } });
      const file = files?.[0]; if (!file) return;
      await this.mutation(() => this.client.runText(['impact', 'evidence', 'import', file.fsPath, workId]), 'Evidence imported.'); return;
    }
    if (message.action === 'verify') {
      try {
        const result = await this.client.run<{ valid: boolean; errors: string[] }>(['impact', 'verify', workId, '--json']);
        this.state = { ...this.state, notice: result.valid ? `Impact Receipt verified for ${workId}.` : null, error: result.valid ? null : result.errors.join('; ') };
      } catch (error) { this.state = { ...this.state, error: (error as Error).message }; }
      this.render(); return;
    }
    if (message.action === 'doctor') {
      try {
        const doctor = await this.client.run<ImpactDoctor>(['impact', 'doctor', workId, '--json']);
        this.state = { ...this.state, doctor, notice: doctor.valid ? `Impact measurement is healthy for ${workId}.` : null, error: doctor.valid ? null : doctor.findings.map((item) => item.message).join('; ') };
      } catch (error) { this.state = { ...this.state, error: (error as Error).message }; }
      this.render();
    }
  }

  dispose(): void {
    FlowImpactPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

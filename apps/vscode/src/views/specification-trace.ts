/** Clause-level specification traceability for the active Story. */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, escape, icon, nonce, page } from './webview.ts';

interface TraceRow {
  id: string;
  type: string;
  source: string;
  verdict: string;
  dependsOn?: string[];
  planned?: { expectedPaths?: string[]; tests?: string[] } | null;
  observed?: { observedPaths?: string[]; testResults?: string[] } | null;
}

function list(values: string[] | undefined): string {
  return values?.length ? values.map((value) => `<code>${escape(value)}</code>`).join('<br>') : '<span class="muted">—</span>';
}

function body(rows: TraceRow[] | null, error: string | null): string {
  if (!rows) return `<header><div class="brand-lockup">SINGULARITY <span>FLOW</span></div><h1>${icon('document', { size: 24 })}Specification traceability</h1></header>
    <section class="plain"><p class="warning-text">${icon('warning')}${escape(error ?? 'Reading clause indexes and claim maps…')}</p></section>`;
  const complete = rows.filter((row) => row.verdict === 'matched').length;
  return `<header class="inbox-header"><div class="brand-lockup">SINGULARITY <span>FLOW</span></div>
    <p class="eyebrow">Active Story · governed evidence</p><h1>${icon('document', { size: 24 })}Specification traceability</h1>
    <p class="meta">Follow each stable clause from its approved specification to planned files, observed source, tests, and conformance verdict.</p></header>
    <section class="plain"><div class="summary-grid"><div class="summary-card important"><strong>${rows.length}</strong><span>Indexed clauses</span></div>
      <div class="summary-card"><strong>${complete}</strong><span>Matched</span></div><div class="summary-card"><strong>${rows.length - complete}</strong><span>Need evidence</span></div></div>
      ${rows.length ? `<div class="table-wrap"><table class="analytics-table"><thead><tr><th>Clause</th><th>Verdict</th><th>Source</th><th>Planned</th><th>Observed</th><th>Tests</th></tr></thead><tbody>${rows.map((row) => `<tr>
        <td><strong>${escape(row.id)}</strong><small>${escape(row.type)}${row.dependsOn?.length ? ` · depends on ${escape(row.dependsOn.join(', '))}` : ''}</small></td>
        <td><span class="pill ${row.verdict === 'matched' ? 'ok' : row.verdict === 'missing' ? 'bad' : ''}">${escape(row.verdict)}</span></td>
        <td><code>${escape(row.source)}</code></td><td>${list(row.planned?.expectedPaths)}</td><td>${list(row.observed?.observedPaths)}</td>
        <td>${list([...(row.planned?.tests ?? []), ...(row.observed?.testResults ?? [])])}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty"><p>No clauses are indexed yet. Publish a requirements, implementation-spec, fix-spec, or conformance artifact containing stable clause anchors.</p><p><code>[APP:REQ-001]</code></p></div>'}
    </section>`;
}

export class SpecificationTracePanel {
  private static current: SpecificationTracePanel | null = null;

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly client: SingularityFlowClient) {
    panel.onDidDispose(() => { SpecificationTracePanel.current = null; });
    void this.refresh();
  }

  static show(context: vscode.ExtensionContext, client: SingularityFlowClient): SpecificationTracePanel {
    if (SpecificationTracePanel.current) {
      SpecificationTracePanel.current.panel.reveal(vscode.ViewColumn.Active);
      void SpecificationTracePanel.current.refresh();
      return SpecificationTracePanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.specificationTrace', 'Specification traceability', vscode.ViewColumn.Active, {
      enableScripts: false, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    SpecificationTracePanel.current = new SpecificationTracePanel(panel, client);
    return SpecificationTracePanel.current;
  }

  private async refresh(): Promise<void> {
    let rows: TraceRow[] | null = null;
    let error: string | null = null;
    try { rows = await this.client.run<TraceRow[]>(['spec', 'trace', '--format', 'json']); }
    catch (cause) { error = (cause as Error).message; }
    const token = nonce();
    this.panel.webview.html = page('Specification traceability', body(rows, error), contentSecurityPolicy(this.panel.webview, token), token);
  }
}

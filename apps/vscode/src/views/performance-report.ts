/** A read-only local report, loaded only when its menu or palette command is invoked. */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { emptyPerformanceFilters, filteredPerformanceTraces, performanceFiltersFrom, PerformanceReportReader } from './performance-report-model.ts';
import { performanceReportBody, PERFORMANCE_REPORT_SCRIPT, PERFORMANCE_REPORT_STYLE } from './performance-report-page.ts';

export class PerformanceReportPanel implements vscode.Disposable {
  private static current: PerformanceReportPanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly reader: PerformanceReportReader;
  private readonly disposables: vscode.Disposable[] = [];
  private filters = emptyPerformanceFilters();
  private selectedId: string | null = null;
  private disposed = false;

  private constructor(panel: vscode.WebviewPanel, client: SingularityFlowClient) {
    this.panel = panel;
    this.reader = new PerformanceReportReader(client, () => this.render());
    const router = registerMessageRouter('singularityFlow.performanceReport', {
      refresh: () => this.reader.refresh(),
      filters: message => {
        const filters = performanceFiltersFrom(message.filters);
        if (!filters) return;
        this.filters = filters; this.render();
      },
      select: message => {
        const id = stringField(message, 'invocationId');
        if (!filteredPerformanceTraces(this.reader.report, this.filters).some(trace => trace.invocationId === id)) return;
        this.selectedId = id; this.render();
      },
      settings: () => vscode.commands.executeCommand('workbench.action.openSettings', 'singularityFlow.performanceTrace')
    });
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return router.route(raw);
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('singularityFlow.performanceTrace')) this.render();
    }));
    void this.reader.refresh();
  }

  static show(context: vscode.ExtensionContext, client: SingularityFlowClient): PerformanceReportPanel {
    if (this.current) {
      this.current.panel.reveal(vscode.ViewColumn.Active);
      if (this.current.reader.repository !== client.repository) {
        this.current.filters = emptyPerformanceFilters(); this.current.selectedId = null;
      }
      this.current.reader.rebind(client);
      return this.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.performanceReport', 'Performance', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    this.current = new PerformanceReportPanel(panel, client);
    context.subscriptions.push(this.current);
    return this.current;
  }

  static repositoryChanged(client: SingularityFlowClient): void {
    if (!this.current) return;
    this.current.filters = emptyPerformanceFilters(); this.current.selectedId = null;
    this.current.reader.rebind(client);
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page('Performance', performanceReportBody({
      repository: this.reader.repository, report: this.reader.report, error: this.reader.error,
      loading: this.reader.loading, filters: this.filters, selectedId: this.selectedId,
      captureEnabled: vscode.workspace.getConfiguration('singularityFlow').get<boolean>('performanceTrace', false)
        || process.env.SINGULARITY_FLOW_PERF_TRACE === '1'
    }), contentSecurityPolicy(this.panel.webview, token), token, PERFORMANCE_REPORT_SCRIPT, { styles: PERFORMANCE_REPORT_STYLE });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.reader.dispose();
    if (PerformanceReportPanel.current === this) PerformanceReportPanel.current = null;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.panel.dispose();
  }
}

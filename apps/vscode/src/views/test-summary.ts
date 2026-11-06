/**
 * The Test summary page (lazy panels runtime). [RUN, docs/SPEC-RUN-AND-TEST-v1.md]
 *
 * It reads `tests summary --json` for a capability (local runs on this computer) or a Story step,
 * and again for a run the picker names. Filters are this page's own state. A file link opens only a
 * file a test case on the page names, and only inside the repository.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { showCompactInformationMessage } from '../compact-message.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { booleanField, integerField, registerMessageRouter, stringField } from './messages.ts';
import { containedWorkingPath } from './change-explorer-source.ts';
import {
  buildTestSummaryView, caseFiles, targetTitle, testBaseFrom, testsBaseArgv, testsSummaryArgv, testSummaryFrom,
  type TestBaseAnswer, type TestSummary, type TestSummaryFilters, type TestSummaryTarget
} from './test-summary-model.ts';
import { testSummaryHtml, TEST_SUMMARY_SCRIPT, TEST_SUMMARY_STYLE } from './test-summary-page.ts';

const sameTarget = (left: TestSummaryTarget, right: TestSummaryTarget): boolean => JSON.stringify(left) === JSON.stringify(right);

export class TestSummaryPanel implements vscode.Disposable {
  private static current: TestSummaryPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private summary: TestSummary | null = null;
  private runId: string | null = null;
  private filters: TestSummaryFilters = { failedOnly: false, untagged: false };
  private error: string | null = null;
  private busy = false;
  private generation = 0;
  private disposed = false;
  private baseAnswer: TestBaseAnswer | null = null;
  private baseBusy = false;
  private baseError: string | null = null;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: SingularityFlowClient,
    private target: TestSummaryTarget
  ) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
  }

  /** Open (or retarget) the one Test summary page and read it fresh. `beside` keeps a review page visible. */
  static show(client: SingularityFlowClient, target: TestSummaryTarget, options: { runId?: string | null; beside?: boolean } = {}): TestSummaryPanel {
    const existing = TestSummaryPanel.current;
    if (existing && existing.client === client) {
      if (!sameTarget(existing.target, target)) { existing.summary = null; existing.filters = { failedOnly: false, untagged: false }; existing.baseAnswer = null; existing.baseError = null; }
      existing.target = target;
      existing.runId = options.runId ?? null;
      existing.panel.reveal(options.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, options.beside);
      void existing.load();
      return existing;
    }
    existing?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('singularityFlow.testSummary', targetTitle(target),
      options.beside ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true } : vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    const created = new TestSummaryPanel(panel, client, target);
    created.runId = options.runId ?? null;
    TestSummaryPanel.current = created;
    void created.load();
    return created;
  }

  /** A run finished for this target: show its summary if the page is open on it. */
  static refreshFor(target: TestSummaryTarget): void {
    const current = TestSummaryPanel.current;
    if (current && sameTarget(current.target, target)) { current.runId = null; void current.load(); }
  }

  private router = registerMessageRouter('singularityFlow.testSummary', {
    'summary.refresh': () => this.load(),
    'summary.run': (message) => {
      const run = stringField(message, 'run');
      if (!run || !this.summary?.history.some((entry) => entry.runId === run) && run !== this.summary?.run?.id) return;
      this.runId = run;
      return this.load();
    },
    'summary.filter': (message) => {
      this.filters = { failedOnly: booleanField(message, 'failedOnly'), untagged: booleanField(message, 'untagged') };
      this.render();
    },
    'summary.open': (message) => this.open(stringField(message, 'file'), integerField(message, 'line') ?? 0),
    'summary.base': () => this.compareWithBase()
  });

  /** A person's question: it runs repository tests on the base commit, so it asks first and only ever runs from here. */
  private async compareWithBase(): Promise<void> {
    const target = this.target;
    if (target.kind !== 'story' || this.baseBusy) return;
    const go = 'Run on the base commit';
    const chosen = await showCompactInformationMessage(`Run ${target.workId}'s tests on its base commit?`,
      { modal: true, detail: 'Each test command runs once on the commit this Story started from, in a throwaway checkout with this checkout\'s dependencies. The answer is kept per base commit, command and Node. It is a fact for you: it records no evidence and refuses nothing.' }, go);
    if (chosen !== go) return;
    this.baseBusy = true; this.baseError = null; this.render();
    try {
      const answer = testBaseFrom(await this.client.run(testsBaseArgv(target)));
      if (!sameTarget(this.target, target)) return;
      this.baseAnswer = answer;
      if (!answer) this.baseError = 'The engine did not return a comparison with the base commit.';
    } catch (failure) {
      if (sameTarget(this.target, target)) this.baseError = (failure as Error).message;
    } finally {
      this.baseBusy = false;
      this.render();
    }
  }

  /** Read the summary now; only the latest of overlapping reads is shown. */
  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.busy = true; this.render();
    let summary: TestSummary | null = null;
    let error: string | null = null;
    try {
      summary = testSummaryFrom(await this.client.run(testsSummaryArgv(this.target, this.runId)));
      if (!summary) error = 'The engine did not return a test summary.';
    } catch (failure) {
      error = (failure as Error).message;
    }
    if (generation !== this.generation) return;
    if (summary) this.summary = summary;
    this.error = error;
    this.busy = false;
    this.render();
  }

  private async open(file: string | null, line: number): Promise<void> {
    if (!file || !caseFiles(this.summary).has(file)) return;
    const { target, refusal } = await containedWorkingPath(this.client.repository, file);
    if (!target) { this.error = refusal; return this.render(); }
    const options = line > 0 ? { selection: new vscode.Range(line - 1, 0, line - 1, 0), preview: true } : { preview: true };
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target), options);
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    const view = buildTestSummaryView(this.summary, { target: this.target, filters: this.filters, busy: this.busy, error: this.error,
      base: { busy: this.baseBusy, answer: this.baseAnswer, error: this.baseError } });
    this.panel.title = view.title;
    this.panel.webview.html = page(view.title, testSummaryHtml(view), contentSecurityPolicy(this.panel.webview, token), token,
      TEST_SUMMARY_SCRIPT, { styles: TEST_SUMMARY_STYLE });
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (TestSummaryPanel.current === this) TestSummaryPanel.current = null;
  }
}

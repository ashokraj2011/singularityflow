/**
 * "What this phase sees": the Repository brief a Story phase's prompt carries, beside that phase in
 * the Story lifecycle. The CLI composes it render-only (`wm brief`), so nothing is recorded and it is
 * exactly what the phase receives; "Phrase with model" runs `wm brief --polish`, whose checked
 * phrasing the phase prompt then reuses. This panel only asks and shows; it never writes.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import {
  PHASE_BRIEF_SCRIPT, PHASE_BRIEF_STYLES, phaseBriefBody, type PhaseBriefResult, type PhaseBriefState
} from './phase-brief-page.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';

export class PhaseBriefPanel {
  private static current: PhaseBriefPanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private result: PhaseBriefResult | null = null;
  /** The Story and phase `result` was read for: a phase of the same name in another Story is another brief. */
  private resultFor: string | null = null;
  private state: PhaseBriefState;
  private request = 0;
  private disposed = false;

  static show(client: SingularityFlowClient, workId: string, phase: string, phases: PhaseBriefState['phases']): PhaseBriefPanel {
    const existing = PhaseBriefPanel.current;
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      existing.open(workId, phase, phases);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.phaseBrief', 'What this phase sees', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    PhaseBriefPanel.current = new PhaseBriefPanel(panel, client, { workId, phase, phases, loading: 'read', error: null });
    return PhaseBriefPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, client: SingularityFlowClient, state: PhaseBriefState) {
    this.panel = panel;
    this.client = client;
    this.state = state;
    const router = registerMessageRouter('singularityFlow.phaseBrief', {
      phase: (message) => { const phase = stringField(message, 'phase'); if (phase) this.select(phase); },
      polish: () => void this.load(true),
      refresh: () => void this.load(false)
    });
    panel.webview.onDidReceiveMessage((raw) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      router.route(raw);
    });
    panel.onDidDispose(() => { this.disposed = true; PhaseBriefPanel.current = null; });
    this.render();
    void this.load(false);
  }

  /** Show a Story's phase; the brief already shown is kept only when it is that Story's and that phase's. */
  private open(workId: string, phase: string, phases: PhaseBriefState['phases']): void {
    this.state = { ...this.state, workId, phases };
    this.select(phase);
  }

  /** Only a phase of this Story: a message cannot name another. */
  private select(phase: string): void {
    if (!this.state.phases.some((entry) => entry.id === phase)) return;
    if (this.resultFor === `${this.state.workId}\u0000${phase}`) return;
    this.state = { ...this.state, phase };
    this.result = null;
    void this.load(false);
  }

  private async load(polish: boolean): Promise<void> {
    const request = ++this.request;
    this.state = { ...this.state, loading: polish ? 'polish' : 'read', error: null };
    this.render();
    const args = ['wm', 'brief', '--phase', this.state.phase, '--work-id', this.state.workId, '--json'];
    if (polish) args.push('--polish');
    try {
      const result = await this.client.run<PhaseBriefResult>(args);
      if (request !== this.request || this.disposed) return;
      this.result = result;
      this.resultFor = `${this.state.workId}\u0000${this.state.phase}`;
    } catch (error) {
      if (request !== this.request || this.disposed) return;
      this.result = null;
      this.resultFor = null;
      this.state = { ...this.state, error: `What this phase sees could not be read: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      if (request === this.request && !this.disposed) {
        this.state = { ...this.state, loading: null };
        this.render();
      }
    }
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.title = `What ${this.state.phases.find((entry) => entry.id === this.state.phase)?.label ?? this.state.phase} sees`;
    this.panel.webview.html = page('What this phase sees', phaseBriefBody(this.result, this.state),
      contentSecurityPolicy(this.panel.webview, token), token, PHASE_BRIEF_SCRIPT, { nav: 'help', styles: PHASE_BRIEF_STYLES });
  }
}

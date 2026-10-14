/** Import a team workflow: machine-local, available with or without a governed repository open. */
import * as vscode from 'vscode';
import { TeamImportJourney, type TeamImportHost } from './team-import-model.ts';
import { teamImportHtml, TEAM_IMPORT_SCRIPT, TEAM_IMPORT_STYLE } from './team-import-page.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { booleanField, registerMessageRouter, stringField } from './messages.ts';

export class TeamImportPanel {
  private static current: TeamImportPanel | null = null;
  private readonly journey: TeamImportJourney;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly panel: vscode.WebviewPanel, host: TeamImportHost) {
    this.journey = new TeamImportJourney(host, () => this.render());
    const router = registerMessageRouter('singularityFlow.teamImport', {
      pick: () => this.journey.pick(),
      inspect: () => this.journey.inspect(),
      entry: message => {
        const path = stringField(message, 'path');
        if (path) this.journey.chooseEntry(path);
      },
      destination: message => this.journey.setDestination(booleanField(message, 'on')),
      convert: () => this.journey.convert(),
      copy: () => this.journey.copyCommand(),
      sessions: () => this.journey.refreshSessions(),
      session: message => {
        const id = stringField(message, 'id');
        if (id) this.journey.selectSession(id);
      },
      check: () => this.journey.check(),
      answer: message => {
        const question = stringField(message, 'question');
        const choice = stringField(message, 'choice');
        if (question && choice) return this.journey.answer(question, choice);
      },
      write: () => this.journey.write(),
      studio: () => this.journey.openInStudio()
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return navigateTo(navigation);
      return router.route(raw);
    }, null, this.disposables);
    panel.onDidDispose(() => {
      this.journey.dispose();
      if (TeamImportPanel.current === this) TeamImportPanel.current = null;
      for (const disposable of this.disposables) disposable.dispose();
    }, null, this.disposables);
    this.render();
    void this.journey.load();
  }

  /** One panel: reopening reveals it and rereads the sessions, keeping the inspected directory. */
  static show(context: vscode.ExtensionContext, host: TeamImportHost): TeamImportPanel {
    if (TeamImportPanel.current) {
      TeamImportPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void TeamImportPanel.current.journey.load();
      return TeamImportPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.teamImport', 'Import a team workflow',
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    TeamImportPanel.current = new TeamImportPanel(panel, host);
    return TeamImportPanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Import a team workflow',
      `<style nonce="${token}">${TEAM_IMPORT_STYLE}</style>${teamImportHtml(this.journey.view)}`,
      contentSecurityPolicy(this.panel.webview, token), token, TEAM_IMPORT_SCRIPT);
  }
}

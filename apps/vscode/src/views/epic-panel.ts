/**
 * The Start-an-Epic panel: the form, and the one governed command it finally runs.
 *
 * The profiles and lenses it offers come from the repository — `initiative profiles --json` and the
 * workflow definition — rather than from a list this extension keeps. A profile the repository does
 * not declare cannot be started, so offering one would be offering a failure.
 */
import * as vscode from 'vscode';
import { contentSecurityPolicy, nonce, page } from './webview.ts';
import {
  EMPTY_EPIC_FORM, epicFormHtml, epicProblems, EPIC_FORM_SCRIPT,
  type EpicForm, type LensChoice, type ProfileChoice
} from './epic-form.ts';

export class EpicPanel {
  private static current: EpicPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly onStart: (form: EpicForm) => Promise<string | null>;
  private readonly disposables: vscode.Disposable[] = [];
  private form: EpicForm = { ...EMPTY_EPIC_FORM };

  private constructor(
    panel: vscode.WebviewPanel,
    choices: { profiles: ProfileChoice[]; lenses: LensChoice[] },
    onStart: (form: EpicForm) => Promise<string | null>
  ) {
    this.panel = panel;
    this.onStart = onStart;
    this.form = {
      ...EMPTY_EPIC_FORM,
      profiles: choices.profiles,
      lenses: choices.lenses,
      // A single choice is not a choice; pre-selecting it saves a click without hiding anything.
      profile: choices.profiles.length === 1 ? choices.profiles[0]!.id : null,
      lens: choices.lenses.length === 1 ? choices.lenses[0]!.id : null
    };

    this.panel.webview.onDidReceiveMessage((raw: unknown) => { void this.receive(raw); }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    choices: { profiles: ProfileChoice[]; lenses: LensChoice[] },
    onStart: (form: EpicForm) => Promise<string | null>
  ): EpicPanel {
    if (EpicPanel.current) {
      EpicPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return EpicPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.startEpic', 'Start an Epic', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    EpicPanel.current = new EpicPanel(panel, choices, onStart);
    return EpicPanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Start an Epic',
      epicFormHtml(this.form),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      EPIC_FORM_SCRIPT
    );
  }

  private update(changes: Partial<EpicForm>): void {
    this.form = { ...this.form, ...changes };
    this.render();
  }

  private async receive(raw: unknown): Promise<void> {
    const message = raw as { type?: unknown; id?: unknown; field?: unknown; value?: unknown };

    // Typed values are recorded without re-rendering: replacing the document on every keystroke
    // would move the caret out from under whoever is typing.
    if (message?.type === 'field' && typeof message.value === 'string') {
      if (message.field === 'title' || message.field === 'description' || message.field === 'goal') {
        this.form[message.field] = message.value;
      } else if (message.field === 'lens') {
        // Only a lens the repository declares; the page names one, it does not introduce one.
        this.form.lens = this.form.lenses.some((lens) => lens.id === message.value) ? message.value : null;
      }
      return;
    }

    if (message?.type === 'profile' && typeof message.id === 'string') {
      if (!this.form.profiles.some((profile) => profile.id === message.id)) return;
      this.update({ profile: message.id, error: null });
      return;
    }

    if (message?.type === 'start') await this.start();
  }

  private async start(): Promise<void> {
    // Re-checked rather than trusted from the page: the disabled button is a courtesy, and a page
    // can post whatever it likes.
    if (epicProblems(this.form).length || this.form.busy) return;
    this.update({ busy: true, error: null });

    const failure = await this.onStart(this.form);
    if (failure) return void this.update({ busy: false, error: failure });
    this.panel.dispose();
  }

  dispose(): void {
    EpicPanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

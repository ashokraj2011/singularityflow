/**
 * "Suggest from run configurations" (lazy panels runtime). [RUN amendment 3, docs/SPEC-RUN-AND-TEST-v1.md]
 *
 * Reads `app suggest --capability <ID> --json` and `app plan` (the IDs already declared), lets the
 * person keep and rename suggestions, then shows the exact application block and the environments.yml
 * additions on a review page. On acceptance the block is written to a private temporary file (0600,
 * in a 0700 directory, deleted afterwards) and handed to the capability page's own route: a reviewed
 * `capability edit --lead` proposal for an explicit map, `capability set` for an implicit or local
 * one. environments.yml is never written here; its additions are copied by the person.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { integerField, registerMessageRouter } from './messages.ts';
import { containedWorkingPath } from './change-explorer-source.ts';
import { collectReviewConfirmation } from './review-confirmation.ts';
import { chooseApplicationRoute, writeApplicationBlock } from './application-block-write.ts';
import { appPlanArgv, appPlanFrom } from './run-and-test-model.ts';
import {
  appSuggestArgv, applicationDraftYaml, defaultSelection, keptStarts, selectionFrom, selectionProblems, suggestionReviewRequest,
  suggestionsFrom, type ApplicationRoute, type SuggestionChoice, type SuggestionSet
} from './run-suggestions-model.ts';
import { runSuggestionsHtml, RUN_SUGGESTIONS_SCRIPT, RUN_SUGGESTIONS_STYLE } from './run-suggestions-page.ts';

export interface RunSuggestionsHost {
  localRunConfiguration?: boolean;
  client: SingularityFlowClient;
  output?: { appendLine(line: string): void };
  /** The capability map's mode and approved authority, as the capability page reads them. */
  capabilityAuthority?(): { mode: string | null; authorityRepository: string | null };
  /** Open the review of the proposal the engine created, as the capability page does. */
  openCapabilityProposal?(lead: string, branch: string, capability: string): void;
  /** After a local save: refresh what this window shows of the capability. */
  afterLocalChange?(capability: string): Promise<void>;
}

const NO_PROBLEMS = { rows: {}, general: null };

export class RunSuggestionsPanel implements vscode.Disposable {
  private static current: RunSuggestionsPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private set: SuggestionSet | null = null;
  private selection: SuggestionChoice[] = [];
  private problems: { rows: Record<number, string>; general: string | null } = NO_PROBLEMS;
  private declaredIds: string[] = [];
  private busy = false;
  private error: string | null = null;
  private notice: string | null = null;
  private generation = 0;
  private disposed = false;

  private constructor(private readonly panel: vscode.WebviewPanel, private host: RunSuggestionsHost, private capability: string) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
  }

  /** Open (or retarget) the one suggestion page and read the suggestions fresh. */
  static show(host: RunSuggestionsHost, capability: string): RunSuggestionsPanel {
    const existing = RunSuggestionsPanel.current;
    if (existing && existing.host.client === host.client) {
      existing.host = host;
      if (existing.capability !== capability) { existing.set = null; existing.selection = []; }
      existing.capability = capability;
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.load();
      return existing;
    }
    existing?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('singularityFlow.runSuggestions', `Run configurations · ${capability}`,
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    const created = new RunSuggestionsPanel(panel, host, capability);
    RunSuggestionsPanel.current = created;
    void created.load();
    return created;
  }

  private router = registerMessageRouter('singularityFlow.runSuggestions', {
    'suggest.refresh': () => this.load(),
    'suggest.review': (message) => this.review((message as Record<string, unknown>).selection),
    'suggest.copy': () => this.copyEnvironments(),
    'suggest.open': (message) => this.open(integerField(message, 'index'))
  });

  /** `app suggest` and `app plan` together: the suggestions, and the start IDs already taken. */
  async load({ keepNotice = false }: { keepNotice?: boolean } = {}): Promise<void> {
    const generation = ++this.generation;
    this.busy = true; this.error = null;
    if (!keepNotice) this.notice = null;
    this.render();
    const capability = this.capability;
    const [suggested, planned] = await Promise.allSettled([
      this.host.client.run(appSuggestArgv(capability)), this.host.client.run(appPlanArgv(capability))
    ]);
    if (generation !== this.generation || this.disposed) return;
    this.busy = false;
    if (suggested.status === 'rejected') {
      this.error = `The run configurations could not be read: ${(suggested.reason as Error).message}`;
      return this.render();
    }
    const set = suggestionsFrom(suggested.value);
    if (!set || set.capability !== capability) {
      this.error = 'The engine did not return suggestions for this capability.';
      return this.render();
    }
    this.set = set;
    // Taken IDs: what the engine's draft keeps, and what app plan runs.
    this.declaredIds = [...new Set([...(set.existing?.start ?? []).map((entry) => String(entry.id ?? '')).filter(Boolean),
      ...(planned.status === 'fulfilled' ? appPlanFrom(planned.value).entries.map((entry) => entry.id) : [])])];
    this.selection = defaultSelection(set);
    this.problems = NO_PROBLEMS;
    this.render();
  }

  private async review(raw: unknown): Promise<void> {
    const set = this.set;
    if (!set || this.busy) return;
    this.selection = selectionFrom(raw, set);
    this.problems = selectionProblems(set, this.selection, this.declaredIds);
    this.notice = null; this.error = null;
    if (Object.keys(this.problems.rows).length || this.problems.general) return this.render();
    let route: ApplicationRoute | null;
    try { route = await chooseApplicationRoute(this.host); } catch (error) {
      this.error = `The capability map's authority could not be read: ${(error as Error).message}`;
      return this.render();
    }
    if (!route) { this.notice = 'Nothing was proposed.'; return this.render(); }
    const kept = keptStarts(set, this.selection);
    if (!set.existing || !kept.length) { this.error = 'Nothing can be proposed: the engine drafted none of the kept entries.'; return this.render(); }
    const applicationYaml = applicationDraftYaml(set.existing, kept.map((item) => item.entry));
    const accepted = await collectReviewConfirmation(suggestionReviewRequest({
      capability: set.capability, kept, route, applicationYaml, environmentsDraft: set.environmentsDraft, existing: set.existing
    }));
    if (!accepted) { this.notice = 'Nothing was proposed or saved.'; return this.render(); }
    this.busy = true; this.render();
    const saved = await this.write(route, set.capability, applicationYaml);
    this.busy = false;
    // A local save changed what is declared: read the suggestions again, keeping what was said. Seen
    // in a real VS Code: the page still offered the saved entry under its old ID.
    if (saved) return this.load({ keepNotice: true });
    this.render();
  }

  /**
   * The file exists only while the command reads it (application-block-write.ts). True when this
   * checkout's map changed (a local save); a proposal changes nothing here until approved.
   */
  private async write(route: ApplicationRoute, capability: string, applicationYaml: string): Promise<boolean> {
    try {
      const outcome = await writeApplicationBlock(this.host, route, capability, applicationYaml);
      if (outcome.kind === 'proposal') {
        this.notice = `Proposal ${outcome.branch} was created on ${outcome.lead}. Review it on its page; nothing is applied before it is approved.`;
        this.host.openCapabilityProposal?.(outcome.lead, outcome.branch, capability);
      } else if (outcome.kind === 'local') {
        this.notice = route.kind === 'personal' ? 'Saved personal run settings for this checkout. Restart the application to use them; team configuration and tests stay unchanged.' : `Saved to ${outcome.path ?? 'singularity/capabilities.yml'} in this checkout, as a local authoring change. Commit it, or propose it to the capability map's authority.`;
        await this.host.afterLocalChange?.(capability);
        return true;
      } else {
        this.notice = 'The capability already declares these start entries; nothing changed.';
      }
    } catch (error) {
      this.error = (error as Error).message;
    }
    return false;
  }

  private async copyEnvironments(): Promise<void> {
    if (!this.set?.environmentsDraft) return;
    await vscode.env.clipboard.writeText(this.set.environmentsDraft);
    void vscode.window.setStatusBarMessage('$(clippy) Copied the singularity/environments.yml additions. They hold names, never secret values.', 4_000);
  }

  /** Only a source file a suggestion on the page names, and only inside the repository. */
  private async open(index: number | null): Promise<void> {
    const file = index === null ? null : this.set?.suggestions[index]?.source.file ?? null;
    if (!file) return;
    const { target, refusal } = await containedWorkingPath(this.host.client.repository, file);
    if (!target) { this.error = refusal; return this.render(); }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target), { preview: true });
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    const title = `Run configurations · ${this.capability}`;
    this.panel.title = title;
    this.panel.webview.html = page(title, runSuggestionsHtml({
      capability: this.capability, set: this.set, selection: this.selection, problems: this.problems,
      declaredIds: this.declaredIds, busy: this.busy, error: this.error, notice: this.notice
    }), contentSecurityPolicy(this.panel.webview, token), token, RUN_SUGGESTIONS_SCRIPT, { styles: RUN_SUGGESTIONS_STYLE });
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (RunSuggestionsPanel.current === this) RunSuggestionsPanel.current = null;
  }
}

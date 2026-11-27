/**
 * The Rules place in VS Code [FPL:REQ-019 to REQ-026]: the sidebar tab's list and the one reused Rules page with its form
 * and preview. Loaded lazily (lazy-panels-runtime), and only while `singularityFlow.navigation.layout` is `places`.
 *
 * Opening the page changes nothing [REQ-003]. The preview is `rules preview --change-set -` (pure, no network); Propose
 * sends one Studio change set through `workflow studio apply --change-set - --propose`, the reviewed path every
 * configuration change takes [REQ-022], after the person's yes. The proposal is then a Review item in the Needs you of each
 * person who may approve it; this module records nothing of its own.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { showCompactWarningMessage } from '../compact-message.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import { studioPublishArgs, type StudioAuthority } from './workflow-studio-page.ts';
import {
  formFieldOf, ruleChangeSet, ruleInputFrom, RULES_PAGE_SCRIPT, RULES_PAGE_STYLE, RULES_SCRIPT, RULES_STYLE, rulesListFrom, rulesPageHtml,
  rulesPanelHtml, rulesPreviewFrom, rulesPreviewHtml, type RuleInput, type RuleRow, type RulesList, type RulesPreview
} from './rules-page.ts';

/** What the extension lends the place: the window's client, today's commands, and the refresh after a change. */
export interface RulesHost {
  readonly client: SingularityFlowClient;
  /** A VS Code command by its ID: Workflow Studio, People and approval groups, the Constitution, Lessons. */
  command(id: string, ...args: unknown[]): Promise<void>;
  /** After an SFlow change in this window (refreshAfterKnownMutation): Needs you then shows the proposal's Review item. */
  refresh(): Promise<void>;
  showRefusal(error: unknown, headline: string): void;
}

const LINKS: Record<string, string> = {
  studio: 'singularityFlow.openWorkflowStudio', people: 'singularityFlow.configurePeople',
  constitution: 'singularityFlow.openConstitution', lessons: 'singularityFlow.lessons'
};

/** The Rules tab: the team's rules, read from the approved configuration. */
export class RulesPlace {
  private list: RulesList | null = null;
  private reading = false;
  private error: string | null = null;
  private pending: Promise<void> | null = null;

  constructor(private readonly host: RulesHost, private readonly changed: () => void) {}

  readonly style = RULES_STYLE;
  readonly script = RULES_SCRIPT;

  /** Paint from the approved rules alone, then read the proposals waiting for review too. */
  start(): void {
    void this.read({ offline: true }).then(() => this.read({}));
  }

  attach(): void { /* the Rules tab repaints whole; nothing is posted to it */ }

  /** The tab opened: read again. */
  activate(): void { void this.read({}); }

  get current(): RulesList | null { return this.list; }

  read({ offline = false } = {}): Promise<void> {
    if (this.pending && !offline) return this.pending;
    const run = (async () => {
      this.reading = !offline;
      this.changed();
      try {
        const list = rulesListFrom(await this.host.client.run(['rules', ...(offline ? ['--offline'] : []), '--json'], undefined,
          { priority: offline ? 'interactive' : 'background' }));
        if (list) { this.list = list; this.error = null; }
      } catch (error) {
        this.error = `The team's rules could not be read: ${(error as Error).message}`.slice(0, 300);
      } finally {
        this.reading = false;
        this.changed();
        RulesPagePanel.listChanged(this);
      }
    })();
    if (!offline) this.pending = run.finally(() => { this.pending = null; });
    return run;
  }

  panel(): string {
    return rulesPanelHtml(this.list, { reading: this.reading, error: this.error });
  }

  /** A message from the Rules tab; true when it was the Rules tab's. */
  receive(message: { action?: unknown; rule?: unknown; act?: unknown }): boolean {
    if (message.action === 'rules-open' && typeof message.rule === 'string') {
      const rule = this.list?.rules.find((entry) => entry.id === message.rule) ?? null;
      if (rule) void RulesPagePanel.show(this.host, this, rule.id);
      return Boolean(rule);
    }
    if (message.action === 'rules-act' && typeof message.act === 'string') {
      if (message.act === 'add' || message.act === 'page') { void RulesPagePanel.show(this.host, this, null); return true; }
      const command = LINKS[message.act];
      if (command) void this.host.command(command);
      return Boolean(command);
    }
    return false;
  }
}

/** The one Rules page: a second row replaces what it shows, never another tab [FPL:REQ-003]. */
export class RulesPagePanel {
  private static current: RulesPagePanel | null = null;
  private editing: RuleRow | null = null;
  private preview: RulesPreview | null = null;
  private result: string | null = null;
  private asked = 0;
  private busy = false;

  private constructor(private readonly panel: vscode.WebviewPanel, private host: RulesHost, private place: RulesPlace) {
    const router = registerMessageRouter('rules', {
      preview: (message: InboundMessage) => { void this.previewRule(message.rule, stringField(message, 'editing')); },
      propose: (message: InboundMessage) => { void this.propose(message.rule, stringField(message, 'editing')); },
      edit: (message: InboundMessage) => { const id = stringField(message, 'id'); if (id) this.edit(id); },
      remove: (message: InboundMessage) => { const id = stringField(message, 'id'); if (id) void this.remove(id); },
      act: (message: InboundMessage) => { const act = stringField(message, 'act'); if (act) void this.act(act); }
    });
    // The footer's destinations, as every page with a script has them; the rest is this page's router.
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return router.route(raw);
    });
    panel.onDidDispose(() => { if (RulesPagePanel.current === this) RulesPagePanel.current = null; });
  }

  static async show(host: RulesHost, place: RulesPlace, ruleId: string | null): Promise<void> {
    let shown = RulesPagePanel.current;
    if (!shown) {
      const panel = vscode.window.createWebviewPanel('singularityFlow.rules', 'Rules', vscode.ViewColumn.Active, { enableScripts: true });
      shown = new RulesPagePanel(panel, host, place);
      RulesPagePanel.current = shown;
    } else {
      shown.host = host;
      shown.place = place;
      shown.panel.reveal(vscode.ViewColumn.Active);
    }
    shown.open(ruleId);
  }

  /** The place read the rules again: the page shows them, keeping the form only while nothing was just proposed. */
  static listChanged(place: RulesPlace): void {
    const shown = RulesPagePanel.current;
    if (shown && shown.place === place && !shown.busy) shown.render();
  }

  /** Opening the page changes nothing; only its buttons do [FPL:REQ-003]. */
  private open(ruleId: string | null): void {
    this.editing = ruleId ? this.place.current?.rules.find((entry) => entry.id === ruleId) ?? null : null;
    this.preview = null;
    this.result = null;
    this.render();
  }

  private render(): void {
    const list = this.place.current;
    const token = nonce();
    this.panel.title = 'Rules';
    this.panel.webview.html = page('Rules', list ? rulesPageHtml(list, { editing: this.editing, preview: this.preview, result: this.result })
      : '<main class="rules-page"><h1 id="rules-title" tabindex="-1">The team\'s rules</h1><p role="status">Reading the team\'s rules…</p></main>',
    contentSecurityPolicy(this.panel.webview, token), token, RULES_PAGE_SCRIPT, { styles: RULES_PAGE_STYLE });
  }

  private edit(id: string): void {
    this.editing = this.place.current?.rules.find((entry) => entry.id === id) ?? null;
    this.preview = null;
    this.result = null;
    this.render();
  }

  private changeOf(list: RulesList, rule: RuleInput, editing: string | null): string {
    return editing && list.rules.some((entry) => entry.id === editing) ? ruleChangeSet(list, { op: 'change', id: editing, rule }) : ruleChangeSet(list, { op: 'add', rule });
  }

  /** What the rule adds to each kind, after typing paused [FPL:REQ-021]: only the newest form's answer is shown. */
  private async previewRule(raw: unknown, editing: string | null): Promise<void> {
    const list = this.place.current;
    const rule = ruleInputFrom(raw, list);
    if (!list || !rule) return;
    const asked = ++this.asked;
    let preview: RulesPreview | null = null;
    try {
      preview = rulesPreviewFrom(await this.host.client.runWithInput(['rules', 'preview', '--change-set', '-', '--json'], this.changeOf(list, rule, editing)));
    } catch (error) {
      preview = { valid: false, problems: [{ field: 'tasks', message: (error as Error).message.slice(0, 400) }], warnings: [], summary: [], others: null, lines: [] };
    }
    if (asked !== this.asked) return;
    this.preview = preview;
    void this.panel.webview.postMessage({ type: 'rules-preview', html: rulesPreviewHtml(preview),
      fields: [...new Set((preview?.problems ?? []).map((problem) => formFieldOf(problem.field)))] });
  }

  /** Propose this rule: one change set through Workflow Studio's reviewed path, after the person's yes [FPL:REQ-022]. */
  private async propose(raw: unknown, editing: string | null): Promise<void> {
    const list = this.place.current;
    const rule = ruleInputFrom(raw, list);
    if (!list || !rule || this.busy) return;
    if (!rule.because) {
      this.preview = { valid: false, problems: [{ field: 'tasks.because', message: 'Say why: one line, which is what a refused "skip the tests" says.' }],
        warnings: [], summary: [], others: null, lines: [] };
      void this.panel.webview.postMessage({ type: 'rules-preview', html: rulesPreviewHtml(this.preview), fields: ['why'] });
      return;
    }
    await this.send(list, this.changeOf(list, rule, editing), editing ? 'Propose this change to the rule?' : 'Propose this rule?', editing ? 'Propose this change' : 'Propose this rule');
  }

  /** Remove a rule: the preview first, naming each step it stops adding, then the same reviewed path [FPL:REQ-021, A14]. */
  private async remove(id: string): Promise<void> {
    const list = this.place.current;
    const row = list?.rules.find((entry) => entry.id === id);
    if (!list || !row || this.busy) return;
    const changeSet = ruleChangeSet(list, { op: 'remove', id });
    let stops = '';
    try {
      const preview = rulesPreviewFrom(await this.host.client.runWithInput(['rules', 'preview', '--change-set', '-', '--json'], changeSet));
      if (preview) {
        this.preview = preview;
        stops = preview.lines.map((line) => line.words).slice(0, 6).join(' ');
        void this.panel.webview.postMessage({ type: 'rules-preview', html: rulesPreviewHtml(preview), fields: [] });
      }
    } catch { /* the proposal below checks it again */ }
    await this.send(list, changeSet, `Propose removing the rule "${row.words}"?`, 'Propose removing it', stops);
  }

  private async send(list: RulesList, changeSet: string, question: string, yes: string, extra = ''): Promise<void> {
    let args: string[];
    try { args = studioPublishArgs(list.authority as StudioAuthority); }
    catch (error) { this.host.showRefusal(error, 'Could not propose this'); return; }
    const proposal = args.includes('--propose');
    const kept = list.inFlight?.words ? ` ${list.inFlight.words}` : ' Tasks already started keep the rules they started with.';
    const answer = await showCompactWarningMessage(question, { modal: true, detail: `${proposal
      ? 'It becomes one review proposal on the approved configuration, and applies once a person who may approve it does.'
      : 'It is written to singularity/workflow.yml in this repository; commit it through your usual review.'}${kept}${extra ? ` ${extra}` : ''}`.slice(0, 1200) }, yes);
    if (answer !== yes) return;
    this.busy = true;
    try {
      const result = await this.host.client.runWithInput<{ reviewRequired?: boolean; branch?: string | null; written?: string[] }>(args, changeSet);
      this.result = result?.reviewRequired && result.branch
        ? `Proposed for review as ${result.branch}. It is a Review item in the Needs you of each person who may approve it, and applies once approved.${kept}`
        : `Written to singularity/workflow.yml in this repository. Review the change and commit it.${kept}`;
      this.editing = null;
      this.preview = null;
      this.busy = false;
      await this.host.refresh().catch(() => {});
      await this.place.read({});
      this.render();
    } catch (error) {
      this.result = (error as Error).message?.slice(0, 800) ?? null;
      this.render();
      this.host.showRefusal(error, 'Could not propose this');
    } finally {
      this.busy = false;
    }
  }

  private async act(act: string): Promise<void> {
    if (act === 'clear') { this.edit(''); return; }
    if (act === 'prefix') {
      const list = this.place.current;
      if (!list) return;
      const value = await vscode.window.showInputBox({ title: 'Task names', prompt: 'Tasks are named <prefix>-<n>. Letters and digits, starting with a letter.',
        value: list.idPrefix.value, ignoreFocusOut: true, validateInput: (entry) => (/^[A-Za-z][A-Za-z0-9]{0,15}$/u.test(entry.trim()) ? null : 'Letters and digits, starting with a letter (for example TASK).') });
      if (!value?.trim() || value.trim() === list.idPrefix.value) return;
      await this.send(list, ruleChangeSet(list, { op: 'prefix', idPrefix: value.trim() }), `Name new tasks ${value.trim()}-<n>?`, 'Propose this name');
      return;
    }
    const command = LINKS[act];
    if (command) await this.host.command(command);
  }
}

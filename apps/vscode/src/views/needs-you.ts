/**
 * The Needs-you place in VS Code [FPL:REQ-012 to REQ-018]: the sidebar tab's list, its badge, and the one reused card page.
 * Loaded lazily (lazy-panels-runtime), and only while `singularityFlow.navigation.layout` is `places` (off until M5).
 *
 * Every choice runs today's path for its kind with a client bound to the item's repository and Story: the approval page
 * (`approveWithReceipt`), the Decide card, `decision choose`, `reject`, `configuration approve`. A client bound to that
 * place runs each command, never the window's [REQ-014]; the extension passes those paths in (`NeedsYouHost`), so this
 * module adds no way to record anything.
 */
import path from 'node:path';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import {
  advancedBackHtml, needsYouBadge, needsYouCardFrom, needsYouCardHtml, needsYouListFrom, needsYouPlaceBody, NEEDS_YOU_CARD_SCRIPT,
  NEEDS_YOU_CARD_STYLE, NEEDS_YOU_SCRIPT, NEEDS_YOU_STYLE, PLACE_TABS, placePanelBody, PLACES_TABS_SCRIPT, type NeedsYouCard, type NeedsYouItem,
  type NeedsYouList, type PlaceTab
} from './needs-you-page.ts';
import { decisionChooseArgv, decisionChoiceItems, pendingDecisionSummary } from '../decisions.ts';
import { activateReviewedWorkflowProposal, selfApprovalWords, type ConfigurationSelfApproval } from './configuration-save.ts';
import type { StoryDecisionView } from '../cli/snapshot.ts';

/** How often the list is read while VS Code has focus [FPL:REQ-016]. */
export const NEEDS_YOU_INTERVAL_MS = 5 * 60_000;

type ApprovalRequest =
  | { kind: 'story'; workId: string; phaseId: string; expected: string; summary: string }
  | { kind: 'initiative'; initiativeId: string; subject: string; expected: string; summary: string };

/** What the extension lends the place: today's paths, each bound by the client it is given. */
export interface NeedsYouHost {
  readonly client: SingularityFlowClient;
  readonly output: vscode.OutputChannel;
  /** A client bound to `place`, a Story checkout or a repository clone on this computer. */
  bind(place: string): SingularityFlowClient;
  /** The approval page (actions.ts approveWithReceipt) with this client. */
  approve(client: SingularityFlowClient, request: ApprovalRequest): Promise<boolean>;
  /** The Decide card (decide-card.ts reviewDecisions) with this client. */
  decide(client: SingularityFlowClient, workId: string): Promise<{ status?: string; message?: string; continueTask?: unknown } | null>;
  /** After an SFlow change in this window (refreshAfterKnownMutation). */
  refresh(): Promise<void>;
  /** A task's chat carries on after an approval, only when its checkout is this window's (continueTaskInChat). */
  continueTask(workId: string, phaseId: string): Promise<void>;
  continueAfterDecision(workId: string, result: { continueTask?: unknown } | null): Promise<void>;
  /** The chat the person used last (workbench.action.chat.open, isPartialQuery false). */
  sendChat(text: string): Promise<void>;
  /** The background governor: the 5-minute read never competes with a Story start or the intake form. */
  waitUntilIdle(): Promise<void>;
  showRefusal(error: unknown, headline: string): void;
}

/** Another place in the tab strip (Work, views/work.ts): its panel, its style and script, and its messages. */
export interface PlacePart {
  panel(): string;
  readonly style: string;
  /** Runs after the places' `vscode` handle and tab keys. */
  readonly script: string;
  receive(message: Record<string, unknown>): boolean;
  /** The tab opened. */
  activate(): void;
  /** How it reaches the sidebar's page without repainting it. */
  attach(post: (message: unknown) => void): void;
}

/**
 * The sidebar's places while they are on: the Needs-you list and its badge, the tab shown, and the other places beside it
 * (Work from M2). The sidebar opens on Work [FPL:REQ-001].
 */
export class NeedsYouPlace implements vscode.Disposable {
  private list: NeedsYouList | null = null;
  private reading = false;
  private error: string | null = null;
  private all = false;
  private tab: PlaceTab = 'work';
  private work: PlacePart | null = null;
  private post: ((message: unknown) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private readonly removed = new Set<string>();

  constructor(private readonly host: NeedsYouHost, private readonly changed: () => void) {}

  /** Paint from what is kept, then read; every five minutes while VS Code has focus, after the background governor. */
  start(): void {
    void this.read({ offline: true }).then(() => this.read({}));
    this.timer = setInterval(() => {
      if (!vscode.window.state.focused) return;
      void this.host.waitUntilIdle().then(() => this.read({}));
    }, NEEDS_YOU_INTERVAL_MS);
  }

  /** Read the list; Refresh and a known change never wait for the governor. */
  read({ offline = false } = {}): Promise<void> {
    if (this.pending && !offline) return this.pending;
    const run = (async () => {
      this.reading = !offline;
      this.changed();
      try {
        const value = await this.host.client.run(['needs-you', ...(offline ? ['--offline'] : []), '--json'], undefined,
          { priority: offline ? 'interactive' : 'background' });
        const list = needsYouListFrom(value);
        if (list) {
          if (!offline) this.removed.clear();
          this.list = { ...list, items: list.items.filter((item) => !this.removed.has(item.key)) };
          this.error = null;
        }
      } catch (error) {
        this.error = `Needs you could not be read: ${(error as Error).message}`.slice(0, 300);
      } finally {
        this.reading = false;
        this.changed();
      }
    })();
    if (!offline) this.pending = run.finally(() => { this.pending = null; });
    return run;
  }

  /** The item leaves the list and the badge drops at once; the next read confirms it [FPL:REQ-015]. */
  acted(key: string): void {
    this.removed.add(key);
    if (this.list) {
      const items = this.list.items.filter((item) => item.key !== key);
      const badge = items.filter((item) => item.group !== 'later').length;
      this.list = { ...this.list, items, counts: { ...this.list.counts, badge, total: items.length,
        badgeTooltip: badge === 1 ? '1 thing needs you' : `${badge} things need you`, badgeLabel: `Needs you: ${badge} waiting` } };
    }
    this.changed();
  }

  get items(): readonly NeedsYouItem[] { return this.list?.items ?? []; }
  /** The items once read, or null before the first read (Work's "Waiting for you" lines). */
  readItems(): readonly NeedsYouItem[] | null { return this.list ? this.list.items : null; }
  badge(): { value: number; tooltip: string } | undefined { return needsYouBadge(this.list); }

  /** Work beside Needs you [FPL:REQ-004 to REQ-007]: its tab comes first, and the sidebar opens on it. */
  setWork(work: PlacePart): void {
    this.work = work;
    if (this.post) work.attach(this.post);
    this.changed();
  }

  /** How a place reaches the sidebar's page without repainting it. */
  attach(post: (message: unknown) => void): void {
    this.post = post;
    this.work?.attach(post);
  }

  /** The sidebar's body for the open tab, or null under Advanced (today's Navigator, unchanged, below `advancedHeader`). */
  body(): { body: string; style: string; script: string } | null {
    if (this.tab === 'advanced') return null;
    if (this.tab === 'work' && this.work) {
      return { body: placePanelBody('work', this.list, this.work.panel()), style: `${NEEDS_YOU_STYLE}${this.work.style}`,
        script: `const vscode = acquireVsCodeApi();\n${PLACES_TABS_SCRIPT}\n${this.work.script}` };
    }
    return { body: needsYouPlaceBody(this.list, { reading: this.reading, error: this.error, all: this.all }), style: NEEDS_YOU_STYLE, script: NEEDS_YOU_SCRIPT };
  }

  /** The tab strip above today's Navigator, with its own small script and style. */
  advancedHeader(): { html: string; style: string; script: string } {
    return { html: advancedBackHtml(this.list), style: NEEDS_YOU_STYLE, script: PLACES_TABS_SCRIPT };
  }

  /** A message from the sidebar's places; true when it was the places'. */
  receive(message: { action?: unknown; tab?: unknown; key?: unknown } & Record<string, unknown>): boolean {
    if (message.action === 'tab' && PLACE_TABS.includes(message.tab as PlaceTab)) {
      this.tab = message.tab as PlaceTab;
      if (this.tab === 'needs-you') void this.read({});
      if (this.tab === 'work') this.work?.activate();
      this.changed();
      return true;
    }
    if (this.work?.receive(message)) return true;
    if (message.action === 'more') { this.all = true; this.changed(); return true; }
    if (message.action === 'open' && typeof message.key === 'string' && this.list?.items.some((item) => item.key === message.key)) {
      void NeedsYouCardPanel.show(this.host, this, message.key);
      return true;
    }
    return false;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Where an item's commands run on this computer: its Story's checkout, else its repository's clone. */
function placeOf(item: NeedsYouItem): string | null {
  return item.route?.checkout ?? item.route?.clone ?? null;
}

/** The one Needs-you card page: a second row replaces what it shows, never another tab [FPL:REQ-003, REQ-012]. */
export class NeedsYouCardPanel {
  private static current: NeedsYouCardPanel | null = null;
  private card: NeedsYouCard | null = null;
  private result: string | null = null;
  private busy = false;

  private constructor(private readonly panel: vscode.WebviewPanel, private host: NeedsYouHost, private place: NeedsYouPlace) {
    const router = registerMessageRouter('needsYou', {
      choose: (message: InboundMessage) => { const choice = stringField(message, 'choice'); if (choice) void this.choose(choice); },
      open: (message: InboundMessage) => { const key = stringField(message, 'key'); if (key) void this.open(key); },
      read: () => { void this.readDocument(); }
    });
    // The footer's destinations, as every page with a script has them; the rest is this page's router.
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return router.route(raw);
    });
    panel.onDidDispose(() => { if (NeedsYouCardPanel.current === this) NeedsYouCardPanel.current = null; });
  }

  static async show(host: NeedsYouHost, place: NeedsYouPlace, key: string): Promise<void> {
    let shown = NeedsYouCardPanel.current;
    if (!shown) {
      const panel = vscode.window.createWebviewPanel('singularityFlow.needsYou', 'Needs you', vscode.ViewColumn.Active, { enableScripts: true });
      shown = new NeedsYouCardPanel(panel, host, place);
      NeedsYouCardPanel.current = shown;
    } else {
      shown.host = host;
      shown.place = place;
      shown.panel.reveal(vscode.ViewColumn.Active);
    }
    await shown.open(key);
  }

  /** Opening a card changes nothing; only its buttons do [FPL:REQ-003]. */
  private async open(key: string): Promise<void> {
    this.result = null;
    try {
      const card = needsYouCardFrom(await this.host.client.run(['needs-you', 'show', key, '--json'], undefined, { priority: 'interactive' }));
      if (!card) throw new Error('The card could not be read.');
      this.card = card;
      this.panel.title = `Needs you · ${card.item.story?.id ?? card.item.repository?.name ?? 'card'}`;
    } catch (error) {
      this.host.showRefusal(error, 'Could not open this card');
      return;
    }
    this.render();
  }

  private render(): void {
    if (!this.card) return;
    const token = nonce();
    this.panel.webview.html = page(this.card.card.question, needsYouCardHtml(this.card, { result: this.result }),
      contentSecurityPolicy(this.panel.webview, token), token, NEEDS_YOU_CARD_SCRIPT, { styles: NEEDS_YOU_CARD_STYLE });
  }

  private async done(words: string, { acted = true } = {}): Promise<void> {
    this.result = words;
    if (acted && this.card) this.place.acted(this.card.key);
    this.render();
    if (acted) await this.host.refresh().catch(() => {});
  }

  /** One choice, through today's path for its kind, with a client bound to the item's place [FPL:REQ-014]. */
  private async choose(choiceId: string): Promise<void> {
    const card = this.card;
    if (!card || this.busy) return;
    const choice = card.card.choices.find((entry) => entry.id === choiceId);
    if (!choice) return;
    const item = card.item;
    const where = placeOf(item);
    if (!where) {
      // Not on this computer yet: the route that opens it, never a command that would fail.
      return this.done(`${item.route?.words ?? 'This repository is not on this computer.'} ${item.route?.elsewhere?.commands?.join(' then ') ?? ''}`.trim(), { acted: false });
    }
    this.busy = true;
    try {
      const bound = this.host.bind(where);
      const workId = item.story?.id ?? '';
      if (item.kind === 'step-approval' && item.step && choice.id === 'approve') {
        const approved = await this.host.approve(bound, { kind: 'story', workId, phaseId: item.step.id, expected: item.step.id, summary: choice.label });
        if (!approved) return;
        await this.done(`${choice.label}: recorded.${item.story?.task && !item.route?.here ? ` ${workId} goes on when its author continues it.` : ''}`);
        await this.host.continueTask(workId, item.step.id);
      } else if (item.kind === 'step-approval' && item.step && choice.id === 'return') {
        const reason = await vscode.window.showInputBox({ title: `Send ${item.step.label} back`, prompt: `What must change in ${item.step.label}? It is recorded and given to its next version.`,
          ignoreFocusOut: true, validateInput: (value) => (value.trim() ? null : 'A reason is required.') });
        if (!reason?.trim()) return;
        // The engine's own return command for this card (action-command-map.mjs), with the person's words for its reason.
        const words = (choice.command ?? '').split(/\s+/u).filter(Boolean);
        if (words[0] !== 'singularity-flow' || !words.includes('<reason>')) return this.done('This card cannot send it back; open it again.', { acted: false });
        await bound.runText(words.slice(1).map((word) => (word === '<reason>' ? reason.trim() : word)));
        await this.done(`${item.step.label} was sent back with your note.`);
      } else if (item.kind === 'workflow-decision') {
        await this.chooseRoute(bound, item, choice.id);
      } else if (item.kind === 'decision' || item.kind === 'next-version') {
        const result = await this.host.decide(bound, workId);
        if (result?.status === 'recorded' || result?.status === 'decided') {
          await this.done(result.message ?? 'Recorded.');
          await this.host.continueAfterDecision(workId, result);
        } else if (result?.message) await this.done(result.message, { acted: false });
      } else if (item.kind === 'intake') {
        if (item.route?.here) { await this.host.sendChat('/sf-task'); await this.done('Sent /sf-task to Copilot chat: answer there.', { acted: false }); }
        else await this.done(`Its chat is in ${item.repository?.name ?? 'its repository'}: ${item.route?.elsewhere?.commands?.join(' then ') ?? ''}`.trim(), { acted: false });
      } else if (item.kind === 'review' && item.proposal) {
        await this.approveConfiguration(bound, item.proposal.branch);
      } else if (item.kind === 'initiative-approval' && item.initiative) {
        const approved = await this.host.approve(bound, { kind: 'initiative', initiativeId: item.initiative.id, subject: item.initiative.subject,
          expected: item.initiative.expected, summary: choice.label });
        if (approved) await this.done(`${choice.label}: recorded.`);
      }
    } catch (error) {
      // The refusal in its own words, with its one route (uncommitted work in that clone, the Story's checkout elsewhere).
      this.host.showRefusal(error, `Could not ${choice.label.toLowerCase()}`);
    } finally {
      this.busy = false;
    }
  }

  /** `decision choose` as the Story view asks it, with the bound client: the option, the person's reason, the question shown. */
  private async chooseRoute(bound: SingularityFlowClient, item: NeedsYouItem, optionId: string): Promise<void> {
    const workId = item.story?.id ?? '';
    const view = await bound.run<StoryDecisionView>(['decision', 'show', workId, '--json']);
    const pending = view.pending;
    if (!pending || (item.expected && pending.key !== item.expected)) return this.done('The decision changed since this card was read. Open it again.', { acted: false });
    const picked = decisionChoiceItems(pending).find((entry) => entry.option === optionId);
    if (!picked?.option) return;
    const reason = await vscode.window.showInputBox({ title: `${pending.label}: ${picked.label}`, prompt: `${pendingDecisionSummary(pending)} Why this choice? It is recorded with your name.`,
      ignoreFocusOut: true, validateInput: (value) => (value.trim() ? null : 'A reason is required.') });
    if (!reason?.trim()) return;
    await bound.runText(decisionChooseArgv(workId, pending, { option: picked.option }, reason));
    await this.done(`${picked.label}: recorded.`);
  }

  /** `configuration approve`, as Workflow Studio's Changes view asks it: the summary first, then the person's acknowledgement. */
  private async approveConfiguration(bound: SingularityFlowClient, branch: string): Promise<void> {
    const reviewed = await bound.run<{ branch: string; proposalCommit: string; merged?: boolean; selfApproval?: ConfigurationSelfApproval | null }>(
      ['workflow', 'proposal', branch, '--json']);
    const result = await activateReviewedWorkflowProposal(reviewed, {
      acknowledge: async (selfApproval) => (await vscode.window.showWarningMessage(`Approve ${branch}?`,
        { modal: true, detail: selfApprovalWords(selfApproval) }, 'Approve')) === 'Approve',
      activate: (args) => bound.run(args)
    });
    if (result) await this.done('The change is approved and applies now.');
  }

  private async readDocument(): Promise<void> {
    const card = this.card;
    const where = card ? placeOf(card.item) : null;
    if (!card?.card.read || !where) return;
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(where, card.card.read.path)), { viewColumn: vscode.ViewColumn.Beside, preview: true })
      .then(undefined, (error: unknown) => this.host.showRefusal(error, 'Could not open the document'));
  }
}

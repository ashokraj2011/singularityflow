/**
 * The Work place in VS Code [FPL:REQ-004 to REQ-007]: the sidebar tab's box, In progress and Done this week, and the one
 * reused task page. Loaded lazily (lazy-panels-runtime), and only while `singularityFlow.navigation.layout` is `places`.
 *
 * Start sends exactly `/sf-task <words>` through today's singularityFlow.startTask, and never waits for the likely plan.
 * Each button of the task page runs today's command for it with a client bound to the Story's checkout or its
 * repository's clone, never the window's [REQ-014]: `work add`, `cancel` with its confirmation, the Copilot chat. This
 * module adds no way to record anything; the extension lends it those paths (`WorkHost`).
 */
import path from 'node:path';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { showCompactWarningMessage } from '../compact-message.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import {
  chatRouteOf, likelyPlanFrom, WORK_SCRIPT, WORK_STYLE, WORK_TASK_SCRIPT, WORK_TASK_STYLE, workListFrom, workPanelHtml, workTaskFrom, workTaskHtml,
  withLiveWaiting, type WaitingItem, type WorkList, type WorkRow, type WorkTask
} from './work-page.ts';

/** What the extension lends the place: today's commands and paths, each bound by the client it is given. */
export interface WorkHost {
  readonly client: SingularityFlowClient;
  /** A client bound to `place`, a Story checkout or a repository clone on this computer. */
  bind(place: string): SingularityFlowClient;
  /** singularityFlow.startTask with the words: `/sf-task <words>` to the chat the person used last [REQ-004]. */
  startTask(words: string): Promise<void>;
  /** A VS Code command by its ID, with its arguments: Start Work, the repository switcher, the Stories page, the intake, the explainer. */
  command(id: string, ...args: unknown[]): Promise<void>;
  /** The chat the person used last (workbench.action.chat.open, isPartialQuery false). */
  sendChat(text: string): Promise<void>;
  /** After an SFlow change in this window (refreshAfterKnownMutation). */
  refresh(): Promise<void>;
  /** The Needs-you card of an item, in its one page. */
  openCard(key: string): void;
  /** The person's live Needs-you items, so a Story they hold says "Waiting for you: …"; null before the first read. */
  waiting(): readonly WaitingItem[] | null;
  showRefusal(error: unknown, headline: string): void;
}

/** The Work tab: its list, the box's draft and likely plan. */
export class WorkPlace {
  private list: WorkList | null = null;
  private reading = false;
  private error: string | null = null;
  private draft = '';
  private likely: { words: string; text: string | null } | null = null;
  private asked = 0;
  private pending: Promise<void> | null = null;
  private post: ((message: unknown) => void) | null = null;

  constructor(private readonly host: WorkHost, private readonly changed: () => void) {}

  readonly style = WORK_STYLE;
  readonly script = WORK_SCRIPT;

  /** Paint from what is kept, then read. */
  start(): void {
    void this.read({ offline: true }).then(() => this.read({}));
  }

  /** How the place reaches the sidebar's page without repainting it (the likely plan's line). */
  attach(post: (message: unknown) => void): void { this.post = post; }

  /** The tab opened: read again. */
  activate(): void { void this.read({}); }

  read({ offline = false } = {}): Promise<void> {
    if (this.pending && !offline) return this.pending;
    const run = (async () => {
      this.reading = !offline;
      this.changed();
      try {
        const list = workListFrom(await this.host.client.run(['work', 'list', ...(offline ? ['--offline'] : []), '--json'], undefined,
          { priority: offline ? 'interactive' : 'background' }));
        if (list) { this.list = list; this.error = null; }
      } catch (error) {
        this.error = `Your tasks could not be read: ${(error as Error).message}`.slice(0, 300);
      } finally {
        this.reading = false;
        this.changed();
      }
    })();
    if (!offline) this.pending = run.finally(() => { this.pending = null; });
    return run;
  }

  panel(): string {
    const likely = this.likely && this.likely.words === this.draft ? this.likely.text : null;
    return workPanelHtml(this.list, { draft: this.draft, likely, reading: this.reading, error: this.error, waiting: this.host.waiting() });
  }

  /** A row by its key (`<repository>:<ID>`), as the live Needs-you list says it. */
  row(key: string): WorkRow | null {
    const found = [...(this.list?.inProgress ?? []), ...(this.list?.doneThisWeek ?? [])].find((entry) => entry.key === key) ?? null;
    return found ? withLiveWaiting(found, this.host.waiting()) : null;
  }

  /** A message from the Work tab; true when it was Work's. */
  receive(message: { action?: unknown; key?: unknown; words?: unknown; act?: unknown }): boolean {
    if (message.action === 'work-start' && typeof message.words === 'string' && message.words.trim()) {
      // Start never waits for the likely plan [REQ-004].
      this.draft = '';
      this.likely = null;
      void this.host.startTask(message.words.trim().slice(0, 2000));
      return true;
    }
    if (message.action === 'work-plan' && typeof message.words === 'string') {
      this.draft = message.words.slice(0, 2000);
      void this.likelyPlan(this.draft);
      return true;
    }
    if (message.action === 'work-act' && typeof message.act === 'string') {
      const command = ({ workflow: 'singularityFlow.startWork', repository: 'singularityFlow.switchWorkspaceRepository',
        stories: 'singularityFlow.openWorkspaceStories' } as Record<string, string>)[message.act];
      // Start with a workflow… opens Start Story on the workflow choice, whatever was chosen there last [ITW:REQ-115].
      if (command) void this.host.command(command, ...(message.act === 'workflow' ? [{ startMode: 'workflow' }] : []));
      return Boolean(command);
    }
    if (message.action === 'work-open' && typeof message.key === 'string') {
      const row = this.row(message.key);
      if (row) void WorkTaskPanel.show(this.host, this, row);
      return Boolean(row);
    }
    return false;
  }

  /** The likely plan for the words, after typing paused [REQ-004]; only the newest words' answer is shown. */
  private async likelyPlan(words: string): Promise<void> {
    const asked = ++this.asked;
    let text: string | null = null;
    if (words.trim()) {
      try {
        text = likelyPlanFrom(await this.host.client.run(['work', words.trim(), '--plan-only', '--json'], undefined, { priority: 'interactive' }));
      } catch { text = null; }
    }
    if (asked !== this.asked || words !== this.draft) return;
    this.likely = { words, text };
    this.post?.({ type: 'work-likely', words, text: text ?? '' });
  }
}

/** Where a Story's commands run on this computer: its checkout, else its repository's clone. */
const placeOf = (row: WorkRow): string | null => row.route.checkout ?? row.route.clone ?? null;

/** The one task page: a second row replaces what it shows, never another tab [FPL:REQ-003, REQ-006]. */
export class WorkTaskPanel {
  private static current: WorkTaskPanel | null = null;
  private row: WorkRow | null = null;
  private task: WorkTask | null = null;
  private lessons = 0;
  private result: string | null = null;
  private error: string | null = null;
  private busy = false;

  private constructor(private readonly panel: vscode.WebviewPanel, private host: WorkHost, private place: WorkPlace) {
    const router = registerMessageRouter('workTask', {
      act: (message: InboundMessage) => { const act = stringField(message, 'act'); if (act) void this.act(act, stringField(message, 'step')); },
      document: (message: InboundMessage) => { const file = stringField(message, 'path'); if (file) void this.openDocument(file); },
      card: (message: InboundMessage) => { const key = stringField(message, 'key'); if (key) this.host.openCard(key); }
    });
    // The footer's destinations, as every page with a script has them; the rest is this page's router.
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return router.route(raw);
    });
    panel.onDidDispose(() => { if (WorkTaskPanel.current === this) WorkTaskPanel.current = null; });
  }

  static async show(host: WorkHost, place: WorkPlace, row: WorkRow): Promise<void> {
    let shown = WorkTaskPanel.current;
    if (!shown) {
      const panel = vscode.window.createWebviewPanel('singularityFlow.workTask', 'Task', vscode.ViewColumn.Active, { enableScripts: true });
      shown = new WorkTaskPanel(panel, host, place);
      WorkTaskPanel.current = shown;
    } else {
      shown.host = host;
      shown.place = place;
      shown.panel.reveal(vscode.ViewColumn.Active);
    }
    await shown.open(row);
  }

  /** Opening the page changes nothing; only its buttons do [FPL:REQ-003]. */
  private async open(row: WorkRow): Promise<void> {
    this.row = row;
    this.task = null;
    this.lessons = 0;
    this.result = null;
    this.error = null;
    this.panel.title = `Task · ${row.id}`;
    this.render();
    const where = placeOf(row);
    if (!where) return;
    const bound = this.host.bind(where);
    try {
      this.task = workTaskFrom(await bound.run(['work', 'status', row.id, '--json'], undefined, { priority: 'interactive' }));
    } catch (error) {
      this.error = `Its steps could not be read here: ${(error as Error).message}`.slice(0, 400);
    }
    try {
      const lessons = await bound.run<{ items?: unknown[] }>(['lessons', '--story', row.id, '--json'], undefined, { priority: 'background' });
      this.lessons = Array.isArray(lessons?.items) ? lessons.items.length : 0;
    } catch { this.lessons = 0; }
    if (this.row === row) this.render();
  }

  private render(): void {
    if (!this.row) return;
    const token = nonce();
    this.panel.webview.html = page(this.row.title, workTaskHtml(this.row, this.task, { result: this.result, lessons: this.lessons, error: this.error }),
      contentSecurityPolicy(this.panel.webview, token), token, WORK_TASK_SCRIPT, { styles: WORK_TASK_STYLE });
  }

  private async done(words: string, { changed = true } = {}): Promise<void> {
    this.result = words;
    this.render();
    if (!changed || !this.row) return;
    await this.host.refresh().catch(() => {});
    await this.place.read({});
    const fresh = this.place.row(this.row.key);
    await this.open(fresh ?? this.row);
    this.result = words;
    this.render();
  }

  /** One button, through today's path for it, with a client bound to the Story's place [FPL:REQ-006, A10]. */
  private async act(act: string, step: string | null): Promise<void> {
    const row = this.row;
    if (!row || this.busy) return;
    this.busy = true;
    try {
      if (act === 'chat') {
        const route = chatRouteOf(row);
        if (route.kind === 'task' || route.kind === 'next') { await this.host.sendChat(route.text); await this.done(`Sent ${route.text} to Copilot chat: ${row.id} goes on there.`, { changed: false }); }
        else await this.done(`${row.id} is not open in this window. Open it with: ${route.text}`, { changed: false });
      } else if (act === 'add' && step && this.task?.addable.some((entry) => entry.step === step)) {
        const where = placeOf(row);
        if (!where) return;
        // `work add`: a refusal is shown in its own words, with its one route [A10].
        const result = await this.host.bind(where).run<{ words?: string }>(['work', 'add', step, '--work-id', row.id, '--json']);
        await this.done(typeof result?.words === 'string' ? result.words : `The ${step} step was added to ${row.id}.`);
      } else if (act === 'stop') {
        await this.stop(row);
      } else if (act === 'intake' && row.route.here) {
        await this.host.command('singularityFlow.openStoryIntake');
      } else if (act === 'explain' && row.route.here) {
        // "Explain the change" opens the Code Explainer in My change [FPL:REQ-006].
        await this.host.command('singularityFlow.openCodeExplainer', { mode: 'change' });
      } else if (act === 'change-story' && this.task?.changeStory && row.route.checkout) {
        // "What this change does": the Story's page, as SFlow wrote it, in a Markdown preview [CSP:REQ-008].
        await vscode.commands.executeCommand('markdown.showPreviewToSide', vscode.Uri.file(path.join(row.route.checkout, this.task.changeStory.path)));
      } else if (act === 'lessons') {
        await this.host.command('singularityFlow.lessons');
      }
    } catch (error) {
      this.result = (error as Error).message?.slice(0, 600) ?? null;
      this.render();
      this.host.showRefusal(error, act === 'add' ? 'Could not add the step' : act === 'stop' ? `Could not stop ${row.id}` : 'Could not do that');
    } finally {
      this.busy = false;
    }
  }

  /** Today's cancel, with its confirmation: a reason, then a yes [FPL:REQ-006, A10]. */
  private async stop(row: WorkRow): Promise<void> {
    const where = placeOf(row);
    if (!where) return;
    const reason = await vscode.window.showInputBox({ title: `Stop ${row.id}`, ignoreFocusOut: true,
      prompt: 'Why is this work being stopped? The reason, who stopped it, its documents and approvals stay in Git.',
      validateInput: (value) => (value.trim() ? null : 'A reason is required.') });
    if (!reason?.trim()) return;
    const yes = await showCompactWarningMessage(`Stop ${row.id}? Its steps stop and it moves to Archived. Its documents are kept.`,
      { modal: true, detail: `Reason: ${reason.trim()}` }, 'Stop the task');
    if (yes !== 'Stop the task') return;
    await this.host.bind(where).runText(['cancel', row.id, '--reason', reason.trim(), '--confirm', row.id]);
    await this.done(`${row.id} was stopped and moved to Archived.`);
  }

  private async openDocument(relative: string): Promise<void> {
    const checkout = this.row?.route.checkout;
    if (!checkout || !this.task?.documents.some((entry) => entry.path === relative)) return;
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(checkout, relative)), { viewColumn: vscode.ViewColumn.Beside, preview: true })
      .then(undefined, (error: unknown) => this.host.showRefusal(error, 'Could not open the document'));
  }
}

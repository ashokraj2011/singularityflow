/**
 * The Decisions page: everything a Story's step waits on, decided in one place. [decision list]
 *
 * It reads `decisions --json`, previews the person's choices with the same command, shows the
 * engine's summary and the exact record command on a review-confirmation page, and records only
 * after that page is accepted, through `decisions record --answers FILE`. The answers file holds the
 * choices and the digest of the list they were made from, so the engine refuses them when the list
 * has changed; it lives in a private temporary folder for the one command and is removed after it.
 * The list is read again after every attempt, so what remains is always the engine's answer.
 */
import { mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import { collectReviewConfirmation } from './review-confirmation.ts';
import {
  runWitnessReview, type WitnessReviewTarget, buildDecisionListView, decisionAnswersDocument, decisionAnswersFromChoices, decisionConfirmationRequest, decisionListArgv,
  decisionPacketFrom, decisionPreviewArgv, decisionPreviewEmptyReason, decisionPreviewFrom, decisionRecordArgv, decisionRecordOutcome,
  type DecisionAnswers, type DecisionChoice, type DecisionListOutcome, type DecisionPacket
} from './decision-list-model.ts';
import { decisionListHtml, DECISION_LIST_SCRIPT, DECISION_LIST_STYLE } from './decision-list-page.ts';

export interface DecisionListTarget { workId: string; phase?: string | null }
export interface DecisionListHooks {
  /** Refresh every view after something was recorded. */
  refresh?: () => Promise<unknown>;
  output?: { appendLine(line: string): void };
}

const today = (): string => new Date().toISOString().slice(0, 10);

export class DecisionListPanel implements vscode.Disposable {
  private static current: DecisionListPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private packet: DecisionPacket | null = null;
  private draft: DecisionChoice[] = [];
  private notice: string | null = null;
  private error: string | null = null;
  private outcome: DecisionListOutcome | null = null;
  private busy = false;
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: SingularityFlowClient,
    private target: DecisionListTarget,
    private hooks: DecisionListHooks
  ) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      void this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
  }

  /** Open (or retarget) the one Decisions page and read the list fresh. */
  static show(client: SingularityFlowClient, target: DecisionListTarget, hooks: DecisionListHooks = {}): DecisionListPanel {
    const existing = DecisionListPanel.current;
    if (existing && existing.client === client) {
      if (existing.target.workId !== target.workId) { existing.packet = null; existing.draft = []; }
      existing.target = target;
      existing.hooks = hooks;
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.guard(() => existing.load());
      return existing;
    }
    existing?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('singularityFlow.decisions', `Decisions · ${target.workId}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    DecisionListPanel.current = new DecisionListPanel(panel, client, target, hooks);
    void DecisionListPanel.current.load();
    return DecisionListPanel.current;
  }

  /** The messages this page speaks: refresh, review the chosen options, copy a share line or command. */
  private router = registerMessageRouter('singularityFlow.decisions', {
    'decisions.refresh': () => this.guard(() => this.load()),
    'decisions.review': (message) => this.guard(() => this.review(message.choices, stringField(message, 'digest'))),
    'decisions.witness': (message) => this.guard(() => this.witness(stringField(message, 'item'), stringField(message, 'option'))),
    'decisions.copy': (message) => this.copy(stringField(message, 'item'), stringField(message, 'option'))
  });

  /** One operation at a time: a second click while one runs does nothing. */
  private async guard(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    await action();
  }

  private log(argv: string[]): void {
    this.hooks.output?.appendLine(`\n$ singularity-flow ${argv.join(' ')}`);
  }

  /** Read the list as it stands now; a failed read keeps the last list on screen with the error. */
  private async load(): Promise<void> {
    this.busy = true; this.render();
    try {
      const argv = decisionListArgv(this.target.workId, this.target.phase ?? null);
      const packet = decisionPacketFrom(await this.client.run(argv));
      if (!packet) throw new Error('The decision list could not be read from the engine\'s answer.');
      // Choices belong to the list they were made on: item IDs are renumbered when it changes.
      if (this.packet?.packetSha256 !== packet.packetSha256) this.draft = [];
      this.packet = packet;
      this.error = null;
    } catch (error) {
      this.error = (error as Error).message;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async review(raw: unknown, digest: string | null): Promise<void> {
    const packet = this.packet;
    if (!packet) return this.load();
    this.notice = null; this.error = null; this.outcome = null;
    const { answers, choices, errors } = decisionAnswersFromChoices(packet, raw, { today: today() });
    this.draft = choices;
    if (digest !== packet.packetSha256) {
      this.draft = [];
      this.notice = 'The list on screen was replaced while you chose; review the current list.';
      return this.load();
    }
    if (errors.length) { this.error = errors.join(' '); return this.render(); }
    this.busy = true; this.render();
    try {
      const argv = decisionPreviewArgv(packet.workId, answers, this.target.phase ?? null);
      const result = await this.client.run(argv);
      const fresh = decisionPacketFrom(result);
      const preview = decisionPreviewFrom(result);
      if (!fresh || !preview) throw new Error('The engine did not return a preview of these choices.');
      if (fresh.packetSha256 !== packet.packetSha256) {
        // The list changed between showing it and previewing: show the current one, choose again.
        this.packet = fresh;
        this.draft = [];
        this.notice = 'The decision list changed since it was shown, so nothing was previewed. This is the current list.';
        return;
      }
      const request = decisionConfirmationRequest(fresh, preview);
      if (!request) { this.error = decisionPreviewEmptyReason(fresh, preview); return; }
      if (!await collectReviewConfirmation(request)) {
        this.notice = 'Nothing was recorded. Your choices are kept on this page.';
        return;
      }
      await this.record(answers, fresh.packetSha256);
    } catch (error) {
      this.error = (error as Error).message;
    } finally {
      this.busy = false;
      if (!this.disposed) this.render();
    }
  }

  /** Record through an answers file in a private temporary folder, then read the list again. */
  private async record(answers: DecisionAnswers, digest: string): Promise<void> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-decisions-'));
    const file = path.join(directory, 'answers.json');
    let fresh: DecisionPacket | null = null;
    try {
      await writeFile(file, `${JSON.stringify(decisionAnswersDocument(answers, digest))}\n`, { mode: 0o600, flag: 'wx' });
      const argv = decisionRecordArgv(this.target.workId, file, this.target.phase ?? null);
      this.log(argv);
      try {
        this.outcome = decisionRecordOutcome(await this.client.run(argv)).outcome;
        this.draft = [];
      } catch (error) {
        const failed = decisionRecordOutcome(null, { message: (error as Error).message, result: (error as { result?: unknown }).result });
        this.outcome = failed.outcome;
        fresh = failed.packet;
        if (fresh) this.draft = [];
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    this.hooks.output?.appendLine(`  ${this.outcome?.message ?? ''}`);
    if (this.outcome?.kind !== 'stale' || this.outcome.recorded.length) await this.hooks.refresh?.().catch(() => undefined);
    if (fresh) { this.packet = fresh; return; }
    // The engine's answer to what remains: never inferred from what was just recorded.
    this.busy = false;
    await this.load();
  }

  private async witness(itemId: string | null, optionId: string | null): Promise<void> {
    const item = this.packet?.items.find(entry => entry.id === itemId);
    const option = item?.options.find(entry => entry.id === optionId);
    const review = option?.action?.humanReview;
    if (!review || !option?.decidedBy.allowed) return;
    this.busy = true; this.render();
    try {
      const result = await reviewWitness(this.client, { workId: this.target.workId, criterion: review.clauseId, slot: review.slot }, this.hooks.refresh);
      this.notice = result.message ?? 'The witness review finished. The list below shows what remains.';
      this.error = null;
    } catch (error) { this.error = (error as Error).message; }
    finally { this.busy = false; await this.load(); }
  }

  private async copy(itemId: string | null, optionId: string | null): Promise<void> {
    const item = this.packet?.items.find((entry) => entry.id === itemId);
    if (!item) return;
    const option = optionId ? item.options.find((entry) => entry.id === optionId) : null;
    const value = option ? option.action?.command : item.decidedBy?.share ?? this.packet?.record?.share;
    if (!value) return;
    await vscode.env.clipboard.writeText(value);
    void vscode.window.setStatusBarMessage('$(clippy) Copied.', 3_000);
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    const view = buildDecisionListView(this.packet, { draft: this.draft, notice: this.notice, error: this.error, outcome: this.outcome, busy: this.busy });
    this.panel.title = `Decisions · ${this.target.workId}`;
    this.panel.webview.html = page(`Decisions · ${this.target.workId}`, decisionListHtml(view),
      contentSecurityPolicy(this.panel.webview, token), token, DECISION_LIST_SCRIPT, { styles: DECISION_LIST_STYLE });
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (DecisionListPanel.current === this) DecisionListPanel.current = null;
  }
}

let reviewing = false;

async function reviewedPath(repository: string, file: string): Promise<string> {
  const root = await realpath(repository);
  const absolute = await realpath(path.resolve(root, file));
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Select evidence inside this Story checkout. Outside files must first be attached or captured through the Story evidence flow.');
  }
  return absolute;
}

export async function reviewWitness(client: SingularityFlowClient, target: WitnessReviewTarget, refresh?: () => Promise<unknown>) {
  if (reviewing) return { status: 'busy', message: 'Finish or cancel the open witness review first.' };
  if (!target || Object.keys(target).some(key => !['workId', 'criterion', 'slot'].includes(key))) {
    throw new Error('A witness review accepts only a Story ID, criterion and slot. Checklist answers, reasons and commands come from the person in the native review.');
  }
  reviewing = true;
  try {
    const result = await runWitnessReview(target, {
      read: async () => {
        client.invalidateReads();
        const packet = decisionPacketFrom(await client.run(['decisions', target.workId, '--json'], undefined, { priority: 'interactive' }));
        if (!packet) throw new Error('The current witness decisions could not be read.');
        return packet;
      },
      choose: async choices => (await vscode.window.showQuickPick(choices.map(choice => ({ label: `${choice.clauseId} · ${choice.slot}`, choice })),
        { title: 'Choose a human evidence review', ignoreFocusOut: true }))?.choice,
      file: async (repository, files) => {
        if (files.length === 1) return files[0];
        const selected = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(repository), canSelectFiles: true,
          canSelectFolders: false, canSelectMany: false, openLabel: 'Inspect this evidence file' });
        if (!selected?.[0]) return undefined;
        const file = path.relative(repository, await reviewedPath(repository, selected[0].fsPath)).split(path.sep).join('/');
        if (files.length && !files.includes(file)) throw new Error('Select one of the evidence files named by this witness slot.');
        return file;
      },
      digest: async (repository, file) => `sha256:${createHash('sha256').update(await readFile(await reviewedPath(repository, file))).digest('hex')}`,
      inspect: async (repository, file) => { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(await reviewedPath(repository, file))); },
      answer: async question => (await vscode.window.showQuickPick([{ label: 'Yes', answer: true }, { label: 'No', answer: false }],
        { title: 'Human evidence review', placeHolder: question, ignoreFocusOut: true }))?.answer,
      reason: async () => vscode.window.showInputBox({ title: 'What did you inspect?', prompt: 'Describe your observation of this evidence, in your own words.',
        ignoreFocusOut: true, validateInput: value => value.trim().length >= 10 && value.trim().length <= 1000 ? null : 'Enter 10 to 1000 characters.' }),
      confirm: detail => collectReviewConfirmation({ title: 'Record human evidence review', summary: 'Review your file, answers and reason. This records a witness, not phase approval.',
        detail, confirmLabel: 'Record my review' }),
      record: (repository, argv) => client.forkForRepository(repository).run(argv)
    });
    if (result.status !== 'recorded') return result;
    let refreshWarning: string | undefined;
    try { await refresh?.(); } catch (error) { refreshWarning = (error as Error).message; }
    const data = (result.result as { data?: { record?: { id?: string; outcome?: string; clauseId?: string }; commit?: string } })?.data;
    if (!data?.record?.id) throw new Error('The witness command returned no verifiable record ID. Refresh Decisions before retrying.');
    return { status: 'recorded', ...(refreshWarning ? { refreshWarning } : {}), record: data?.record?.id, outcome: data?.record?.outcome,
      criterion: data?.record?.clauseId, commit: data?.commit, message: 'The human witness review was recorded. Refresh Decisions for remaining items; no phase approval was performed.' };
  } finally { reviewing = false; }
}

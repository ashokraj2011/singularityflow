/**
 * One action for the decisions a step waits on. The chat passes a Story ID and nothing else: the person
 * answers on this page, and the extension records through the CLI outside the chat's shell, so no
 * answer, reason or selection ever comes from the model. A list that changed while open records nothing.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import { navigateTo } from './navigate.ts';
import { collectReviewConfirmation } from './review-confirmation.ts';
import { createTerminalIn } from '../terminal-start.ts';
import { decisionAnswersDocument, decisionAnswersFromChoices, decisionListArgv, decisionPacketFrom, decisionRecordArgv, decisionRecordOutcome,
  type DecisionAnswers, type DecisionPacket } from './decision-list-model.ts';
import { reviewWitness } from './decision-list.ts';
import { DECIDE_SCRIPT, DECIDE_STYLE, decideChoicesFrom, decideDraftFrom, decideHtml, decideRows, decideSummary, type DecideDraft } from './decide-card-page.ts';

export interface DecideResult { status: string; message: string; recorded?: string[]; remaining?: string[]; next?: unknown }

let open: vscode.WebviewPanel | null = null;

async function readList(client: SingularityFlowClient, workId: string): Promise<DecisionPacket> {
  client.invalidateReads();
  const packet = decisionPacketFrom(await client.run(decisionListArgv(workId), undefined, { priority: 'interactive' }));
  if (!packet || packet.workId !== workId) throw new Error('The decision list could not be read.');
  return packet;
}

/** The answers reach the CLI in a private file that is gone once it has run. */
async function record(client: SingularityFlowClient, packet: DecisionPacket, answers: DecisionAnswers) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-decide-'));
  const file = path.join(directory, 'answers.json');
  try {
    await writeFile(file, JSON.stringify(decisionAnswersDocument(answers, packet.packetSha256)), { mode: 0o600, flag: 'wx' });
    return await client.run(decisionRecordArgv(packet.workId, file), undefined, { priority: 'interactive' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const today = () => new Date().toISOString().slice(0, 10);

export async function reviewDecisions(client: SingularityFlowClient, target: { workId?: unknown }, refresh?: () => Promise<unknown>): Promise<DecideResult> {
  if (!target || Object.keys(target).some((key) => key !== 'workId') || typeof target.workId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(target.workId)) {
    throw new Error('This page takes only a Story ID. Answers and reasons come from the person on the page.');
  }
  const workId = target.workId;
  if (open) { open.reveal(); return { status: 'busy', message: 'The decisions page is already open. Finish it there.' }; }
  let packet = await readList(client, workId);
  if (!decideRows(packet).length) return { status: 'nothing-to-decide', message: packet.headline, next: packet.next ?? null };
  const panel = vscode.window.createWebviewPanel('singularityFlow.decide', `Decide · ${workId}`, vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  open = panel;
  return new Promise<DecideResult>((resolve) => {
    let busy = false;
    let settled = false;
    let draft: DecideDraft | undefined;
    let recorded: string[] = [];
    const render = (error: string | null = null, notice: string | null = null) => {
      const token = nonce();
      panel.webview.html = page(`Decide · ${workId}`, `<style nonce="${token}">${DECIDE_STYLE}</style>${decideHtml(packet, { error, notice, busy, draft })}`,
        contentSecurityPolicy(panel.webview, token), token, DECIDE_SCRIPT);
    };
    const finish = (result: DecideResult) => { if (settled) return; settled = true; resolve(result); panel.dispose(); };
    const notNow = () => (recorded.length ? { status: 'recorded', recorded, message: `${recorded.length} recorded; the rest stay open.` }
      : { status: 'cancelled', message: 'No decision was recorded.' });
    const reread = async () => { packet = await readList(client, workId).catch(() => packet); };
    const optionOf = (message: InboundMessage) => packet.items.find((item) => item.id === stringField(message, 'item'))
      ?.options.find((option) => option.id === stringField(message, 'option'));
    const router = registerMessageRouter('singularityFlow.decide', {
      'decide.cancel': () => finish(notNow()),
      'decide.open': async (message) => {
        const file = stringField(message, 'path');
        if (!file || !packet.repositoryPath || !packet.items.some((item) => item.details?.path === file)) return;
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(packet.repositoryPath, file)), { viewColumn: vscode.ViewColumn.Beside, preview: true })
          .then(undefined, () => vscode.window.showInformationMessage(`${file} is not in this checkout now; it may have been removed.`));
      },
      'decide.copy': async (message) => {
        const command = optionOf(message)?.action?.command;
        if (command) { await vscode.env.clipboard.writeText(command); void vscode.window.setStatusBarMessage('$(clippy) Copied.', 3_000); }
      },
      // Typed, not run: the person presses Enter themselves, in a terminal this page opened in the Story's checkout.
      'decide.terminal': (message) => {
        const command = optionOf(message)?.action?.command;
        if (!command) return;
        const terminal = createTerminalIn({ name: `Singularity Flow · ${workId}` }, packet.repositoryPath ?? client.repository);
        terminal.show(false);
        terminal.sendText(command, false);
      },
      'decide.witness': async (message) => {
        if (busy) return;
        draft = decideDraftFrom(message);
        const review = optionOf(message)?.action?.humanReview;
        if (!review) return;
        busy = true; render();
        try {
          const result = await reviewWitness(client, { workId, criterion: review.clauseId, slot: review.slot }, refresh) as { status?: string; record?: string; message?: string };
          if (result.status === 'recorded' && result.record) recorded = [...recorded, result.record];
          await reread();
          busy = false; panel.reveal();
          if (!decideRows(packet).length) return finish({ status: 'recorded', recorded, remaining: [], message: `${recorded.length} recorded. All decided.`, next: packet.next ?? null });
          render(null, result.message ?? null);
        } catch (error) { busy = false; panel.reveal(); render((error as Error).message); }
      },
      'decide.review': async (message) => {
        if (busy) return;
        draft = decideDraftFrom(message);
        const { choices: raw, problem } = decideChoicesFrom(packet, message);
        if (problem) return render(problem);
        const { answers, choices, errors } = decisionAnswersFromChoices(packet, raw, { today: today() });
        if (errors.length) return render(errors.join(' '));
        busy = true; render();
        try {
          const confirmed = await collectReviewConfirmation({ title: `Record ${choices.length} decision${choices.length === 1 ? '' : 's'} on ${workId}`,
            summary: 'Each one is recorded with its own reason, under your name.', detail: decideSummary(packet, choices), confirmLabel: 'Record these decisions' });
          if (!confirmed) { busy = false; panel.reveal(); return render(); }
          const outcome = decisionRecordOutcome(await record(client, packet, answers)).outcome;
          await refresh?.();
          const all = [...recorded, ...outcome.recorded];
          finish({ status: 'recorded', recorded: all, remaining: outcome.remaining,
            message: `${all.length} recorded.${outcome.remaining.length ? ` Still open: ${outcome.remaining.join('; ')}.` : ' All decided.'}` });
        } catch (error) {
          const failure = error as Error & { result?: unknown };
          const { outcome, packet: fresh } = decisionRecordOutcome(null, { message: failure.message, result: failure.result });
          busy = false;
          if (outcome.recorded.length) recorded = [...recorded, ...outcome.recorded];
          if (fresh) packet = fresh; else await reread();
          panel.reveal();
          render(outcome.message);
        }
      }
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const target = navigationTarget(raw);
      return target ? navigateTo(target) : router.route(raw);
    });
    panel.onDidDispose(() => { open = null; finish(notNow()); });
    render();
  });
}

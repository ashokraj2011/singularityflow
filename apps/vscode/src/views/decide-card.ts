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
import { cliRefusalCode } from '../cli/runner.ts';
import { decisionAnswersDocument, decisionAnswersFromChoices, decisionListArgv, decisionPacketFrom, decisionRecordArgv, decisionRecordOutcome,
  type DecisionAnswers, type DecisionPacket } from './decision-list-model.ts';
import { reviewWitness } from './decision-list.ts';
import { approvalRows, DECIDE_SCRIPT, DECIDE_STYLE, decideChoicesFrom, decideDraftFrom, decideHtml, decideRows, decideSummary, draftFileOf, draftsOnly, evidencePaths, GUARD_WORDS,
  guardRoute, openRows, type DecideDraft } from './decide-card-page.ts';

export interface DecideResult { status: string; message: string; recorded?: string[]; decided?: string[]; drafted?: string[]; remaining?: string[]; summaryUpdate?: string; next?: unknown }

/** An absolute file the engine named, opened beside the page for the person to write in. */
const openBeside = (file: string) => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside, preview: false })
  .then(undefined, () => vscode.window.showInformationMessage(`${file} could not be opened; it may have been moved.`));

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

export async function reviewDecisions(client: SingularityFlowClient, target: { workId?: unknown }, refresh?: () => Promise<unknown>, { askedInChat = false } = {}): Promise<DecideResult> {
  if (!target || Object.keys(target).some((key) => key !== 'workId') || typeof target.workId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(target.workId)) {
    throw new Error('This page takes only a Story ID. Answers and reasons come from the person on the page.');
  }
  const workId = target.workId;
  if (open) { open.reveal(); return { status: 'busy', message: 'The decisions page is already open. Finish it there.' }; }
  let packet = await readList(client, workId);
  // A chat that asked carries on when nothing waits: only a person who opened this page sees a review nothing waits on,
  // or the approval, whose row opens its page [owner, 2026-11-13].
  if (!(askedInChat ? openRows(packet) : [...decideRows(packet), ...approvalRows(packet)]).length) return { status: 'nothing-to-decide', message: packet.headline, next: packet.next ?? null };
  const panel = vscode.window.createWebviewPanel('singularityFlow.decide', `Decide · ${workId}`, vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  open = panel;
  return new Promise<DecideResult>((resolve) => {
    let busy = false;
    let settled = false;
    let draft: DecideDraft | undefined;
    let recorded: string[] = [];
    // Drafts written here: files, never records [SCS:REQ-020].
    let drafted: string[] = [];
    let route: string | null = null;
    // A pin or plan amendment recorded here changed the open code step after its summary was written: however the page
    // closes, the chat's agent and the person are told to update the summary before prepublishing [owner, 2026-11-13].
    let summaryUpdate: string | undefined;
    const render = (error: string | null = null, notice: string | null = null) => {
      const token = nonce();
      panel.webview.html = page(`Decide · ${workId}`, `<style nonce="${token}">${DECIDE_STYLE}</style>${decideHtml(packet, { error, notice, busy, draft, route })}`,
        contentSecurityPolicy(panel.webview, token), token, DECIDE_SCRIPT);
    };
    const finish = (result: DecideResult) => {
      if (settled) return;
      settled = true;
      resolve(summaryUpdate && !result.message.includes(summaryUpdate) ? { ...result, summaryUpdate, message: `${result.message} ${summaryUpdate}` }
        : summaryUpdate ? { ...result, summaryUpdate } : result);
      panel.dispose();
    };
    const notNow = () => (recorded.length ? { status: 'recorded', recorded, ...(drafted.length ? { drafted } : {}), message: `${recorded.length} recorded; the rest stay open.${drafted.length ? ` ${drafted.join(' ')}` : ''}` }
      : drafted.length ? { status: 'drafted', recorded, drafted, message: `No decision was recorded. ${drafted.join(' ')}` }
        : { status: 'cancelled', message: 'No decision was recorded.' });
    const reread = async () => { packet = await readList(client, workId).catch(() => packet); };
    const optionOf = (message: InboundMessage) => decideRows(packet).find((item) => item.id === stringField(message, 'item'))
      ?.options.find((option) => option.id === stringField(message, 'option'));
    // A row's own step, or a held package's accept command for a person who may accept it [CQF:REQ-052]: always from the list as read.
    const commandOf = (message: InboundMessage) => {
      const hold = stringField(message, 'hold');
      if (hold === null) return optionOf(message)?.action?.command ?? optionOf(message)?.terminal ?? null;
      const entry = /^\d{1,2}$/u.test(hold) ? packet.approvalEvidence?.hold?.entries?.[Number(hold)] : undefined;
      return entry?.allowed === true && typeof entry.command === 'string' ? entry.command : null;
    };
    const router = registerMessageRouter('singularityFlow.decide', {
      'decide.cancel': () => finish(notNow()),
      'decide.open': async (message) => {
        const file = stringField(message, 'path');
        // A row offered beside the list opens its file too: a convergence answer someone may change names the file it is about [SCS:REQ-034].
        if (!file || !packet.repositoryPath || !(decideRows(packet).some((item) => item.details?.path === file) || evidencePaths(packet).includes(file))) return;
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(packet.repositoryPath, file)), { viewColumn: vscode.ViewColumn.Beside, preview: true })
          .then(undefined, () => vscode.window.showInformationMessage(`${file} is not in this checkout now; it may have been removed.`));
      },
      // The draft a row's own step names, from the list as read: never a path the page sends.
      'decide.draft': async (message) => {
        const file = optionOf(message)?.action?.file;
        if (typeof file === 'string' && path.isAbsolute(file)) await openBeside(file);
      },
      'decide.copy': async (message) => {
        const command = commandOf(message);
        if (command) { await vscode.env.clipboard.writeText(command); void vscode.window.setStatusBarMessage('$(clippy) Copied.', 3_000); }
      },
      // Typed, not run: the person presses Enter themselves, in a terminal this page opened in the Story's checkout.
      'decide.terminal': (message) => {
        const command = commandOf(message);
        if (!command) return;
        const terminal = createTerminalIn({ name: `Singularity Flow · ${workId}` }, packet.repositoryPath ?? client.repository);
        terminal.show(false);
        terminal.sendText(command, false);
      },
      // The approval starts from this card: its row opens the approval page with the documents [owner, 2026-11-13].
      'decide.approval': () => { void vscode.commands.executeCommand('singularityFlow.openApprovals'); },
      'decide.route': () => {
        if (!route) return;
        const terminal = createTerminalIn({ name: `Singularity Flow · ${workId}` }, packet.repositoryPath ?? client.repository);
        terminal.show(false);
        terminal.sendText(route, false);
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
          if (!openRows(packet).length) return finish({ status: 'recorded', recorded, remaining: [], message: `${recorded.length} recorded. All decided.`, next: packet.next ?? null });
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
          const writesOnly = draftsOnly(packet, choices);
          const confirmed = await collectReviewConfirmation(writesOnly
            ? { title: `Draft the amendment on ${workId}`, summary: 'A draft is written beside the checkout\'s Git data, with your reason in its slot; nothing is recorded or decided.',
              detail: decideSummary(packet, choices), confirmLabel: 'Write the draft' }
            : { title: `Record ${choices.length} decision${choices.length === 1 ? '' : 's'} on ${workId}`,
              summary: 'Each one is recorded with its own reason, under your name.', detail: decideSummary(packet, choices), confirmLabel: 'Record these decisions' });
          if (!confirmed) { busy = false; panel.reveal(); return render(); }
          const outcome = decisionRecordOutcome(await record(client, packet, answers)).outcome;
          summaryUpdate = outcome.summaryUpdate ?? summaryUpdate;
          await refresh?.();
          const all = [...recorded, ...outcome.recorded];
          const decided = outcome.decided ?? [];
          if (outcome.drafted?.length) {
            // Writing and proposing the draft is next, on this list: the page stays, says where it is, and opens it beside.
            // What the person typed on other rows stays on the page.
            recorded = all; drafted = [...drafted, ...outcome.drafted]; busy = false;
            await reread();
            const file = draftFileOf(packet);
            if (file) await openBeside(file);
            panel.reveal();
            return render(null, `${outcome.message} ${outcome.drafted.join(' ')}`);
          }
          finish({ status: 'recorded', recorded: all, decided, remaining: outcome.remaining,
            message: `${decided.length ? `${decided.length} decision${decided.length === 1 ? '' : 's'} recorded. ${decided.join('. ')}.` : all.length ? `${all.length} recorded.` : outcome.message}${outcome.remaining.length ? ` Still open: ${outcome.remaining.join('; ')}.` : ' All decided.'}` });
        } catch (error) {
          const failure = error as Error & { result?: unknown };
          const { outcome, packet: fresh } = decisionRecordOutcome(null, { message: failure.message, result: failure.result });
          busy = false;
          if (cliRefusalCode(error) === 'PSS_CARD_NOT_SHOWN') { route = guardRoute(workId); panel.reveal(); return render(GUARD_WORDS); }
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

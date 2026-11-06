/**
 * One action for the convergence decisions. The chat passes a Story ID and nothing else: the person
 * answers on this page, and the extension records through the CLI outside the chat's shell, so no
 * answer, reason or selection ever comes from the model.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import { navigateTo } from './navigate.ts';
import { collectReviewConfirmation } from './review-confirmation.ts';
import {
  ADJUDICATION_SCRIPT, ADJUDICATION_STYLE, adjudicationAnswersFrom, adjudicationDraftFrom, adjudicationHtml, adjudicationListFrom, adjudicationSummary,
  type AdjudicationAnswer, type AdjudicationDraft, type AdjudicationList
} from './adjudication-page.ts';

export interface AdjudicationResult { status: string; message: string; recorded?: string[]; unchanged?: string[]; remaining?: string[]; next?: string }

let open: vscode.WebviewPanel | null = null;

async function readList(client: SingularityFlowClient, workId: string): Promise<AdjudicationList> {
  client.invalidateReads();
  const list = adjudicationListFrom(await client.run(['story', 'adjudications', '--work-id', workId, '--json'], undefined, { priority: 'interactive' }));
  if (!list || list.workId !== workId) throw new Error('The list of convergence decisions could not be read.');
  return list;
}

/** The answers reach the CLI in a private file that is gone once it has run. */
async function record(client: SingularityFlowClient, list: AdjudicationList, answers: readonly AdjudicationAnswer[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `sflow-adjudication-${randomBytes(4).toString('hex')}-`));
  const file = path.join(directory, 'answers.json');
  try {
    await writeFile(file, JSON.stringify({ answers }), { mode: 0o600, flag: 'wx' });
    return await client.run(['story', 'adjudicate', '--answers', file, '--expect', list.digest ?? '', '--work-id', list.workId], undefined, { priority: 'interactive' }) as
      { recorded?: string[]; unchanged?: string[]; remaining?: string[]; next?: string };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function nothingOpen(list: AdjudicationList): AdjudicationResult {
  const settled = (list.settled ?? []).flatMap((item) => item.paths);
  return { status: 'nothing-open', recorded: [], unchanged: [], remaining: [],
    message: `Nothing here needs a decision.${settled.length ? ` Settled by the plan, not asked: ${settled.join(', ')}.` : ''}` };
}

export async function reviewAdjudications(client: SingularityFlowClient, target: { workId?: unknown }, refresh?: () => Promise<unknown>, { askedInChat = false } = {}): Promise<AdjudicationResult> {
  if (!target || Object.keys(target).some((key) => key !== 'workId') || typeof target.workId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(target.workId)) {
    throw new Error('This page takes only a Story ID. Answers and reasons come from the person on the page.');
  }
  const workId = target.workId;
  if (open) { open.reveal(); return { status: 'busy', message: 'The decisions page is already open. Finish it there.' }; }
  let list = await readList(client, workId);
  if (list.status !== 'open') return { status: list.status, message: list.message ?? 'There is nothing to decide here.' };
  // A chat that asked with nothing open carries on: a page with no question must not stop its turn.
  if (askedInChat && !list.open) return nothingOpen(list);
  const panel = vscode.window.createWebviewPanel('singularityFlow.adjudicate', `Decide · ${workId}`, vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  open = panel;
  return new Promise<AdjudicationResult>((resolve) => {
    let busy = false;
    let settled = false;
    let draft: AdjudicationDraft | undefined;
    const render = (error: string | null = null) => {
      const token = nonce();
      panel.webview.html = page(`Decide · ${workId}`, `<style nonce="${token}">${ADJUDICATION_STYLE}</style>${adjudicationHtml(list, { error, busy, draft })}`,
        contentSecurityPolicy(panel.webview, token), token, ADJUDICATION_SCRIPT);
    };
    const finish = (result: AdjudicationResult) => { if (settled) return; settled = true; resolve(result); panel.dispose(); };
    const router = registerMessageRouter('singularityFlow.adjudicate', {
      'adjudicate.cancel': () => finish({ status: 'cancelled', message: 'No decision was recorded.' }),
      'adjudicate.open': async (message) => {
        const file = stringField(message, 'path');
        if (!file || ![...list.items, ...(list.settled ?? [])].some((item) => item.paths.includes(file))) return;
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(list.repositoryPath, file)), { viewColumn: vscode.ViewColumn.Beside, preview: true })
          .then(undefined, () => vscode.window.showInformationMessage(`${file} is not in this checkout now; it may have been removed.`));
      },
      'adjudicate.review': async (message) => {
        if (busy) return;
        draft = adjudicationDraftFrom(message);
        const { answers, problem } = adjudicationAnswersFrom(list, message);
        if (problem) return render(problem);
        busy = true; render();
        try {
          const confirmed = await collectReviewConfirmation({ title: `Record ${answers.length} decision${answers.length === 1 ? '' : 's'} on ${workId}`,
            summary: 'Each one is recorded with its own reason, under your name.', detail: adjudicationSummary(list, answers), confirmLabel: 'Record these decisions' });
          if (!confirmed) { busy = false; panel.reveal(); return render(); }
          const result = await record(client, list, answers);
          await refresh?.();
          const remaining = result.remaining ?? [];
          finish({ status: 'recorded', recorded: result.recorded ?? [], unchanged: result.unchanged ?? [], remaining, next: result.next,
            message: `${(result.recorded ?? []).length} recorded.${remaining.length ? ` ${remaining.length} still need a decision.` : ' All decided.'}` });
        } catch (error) {
          busy = false;
          list = await readList(client, workId).catch(() => list);
          panel.reveal();
          render((error as Error).message);
        }
      }
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const target = navigationTarget(raw);
      return target ? navigateTo(target) : router.route(raw);
    });
    panel.onDidDispose(() => { open = null; finish({ status: 'cancelled', message: 'No decision was recorded.' }); });
    render();
  });
}

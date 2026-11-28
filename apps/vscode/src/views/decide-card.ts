/**
 * One action for the decisions a step waits on. The chat passes a Story ID and nothing else: the person
 * answers on this page, and the extension records through the CLI outside the chat's shell, so no
 * answer, reason or selection ever comes from the model. A list that changed while open records nothing.
 *
 * On a Story SF Guard requires, the confirmation is SF Guard's card as the engine renders it for these
 * answers (`guard card decisions`), and the record carries its digest, so the CLI signs with Touch ID from
 * here once the card matches; nothing is signed without the person's click and touch [owner, 2026-11-19].
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
  justAQuestionArgv, nextWords, versionConsentArgv, versionConsentOutcome, versionOpeningOf, type DecisionAnswers, type DecisionItemPacket, type DecisionPacket,
  type VersionOpeningPacket } from './decision-list-model.ts';
import { reviewWitness } from './decision-list.ts';
import { guardCardDecisionsArgv, guardCardFrom, guardCardText, presenceCardArgs, type GuardCardRead } from './sf-guard-model.ts';
import { approvalElsewhereWords, approvalFocus, approvalPageWords, approvalRows, chatNext, shareText, checkNames, checkOf, DECIDE_SCRIPT, filledCommand, DECIDE_STYLE, decideChoicesFrom, decideDraftFrom, decideHtml, decideRows,
  decideSummary, draftFileOf, draftsOnly, evidencePaths, GUARD_WORDS, guardRoute, joinedWords, openRows, othersApproval, othersApprovalWords, approveInChat, approversNext, readyApproval,
  selectStoryNext, type DecideDraft } from './decide-card-page.ts';

// How long the page's first read checks before it asks, and how long "Check first" waits (src/decision-probes.mjs).
const CHECK_SECONDS = 60;
const CHECK_FIRST_SECONDS = 900;

export interface DecideResult { status: string; message: string; recorded?: string[]; decided?: string[]; drafted?: string[]; remaining?: string[]; summaryUpdate?: string; next?: unknown; declined?: string;
  /** A task's step goes on after what was recorded: the chat route that carries it on (decisions record's `continueTask`). */
  continueTask?: string;
  /** What the chat's agent does then, in the engine's words: a chat that opened this card goes on with /sf-task. */
  instruction?: string }

/** An absolute file the engine named, opened beside the page for the person to write in. */
const openBeside = (file: string) => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside, preview: false })
  .then(undefined, () => vscode.window.showInformationMessage(`${file} could not be opened; it may have been moved.`));

/** The card open in this window, for which Story, and what it will answer. */
let open: { panel: vscode.WebviewPanel; workId: string; answer: Promise<DecideResult> } | null = null;

async function readList(client: SingularityFlowClient, workId: string, { probe = null as number | null } = {}): Promise<DecisionPacket> {
  client.invalidateReads();
  const packet = decisionPacketFrom(await client.run(decisionListArgv(workId, null, { probe }), undefined, { priority: 'interactive' }));
  if (!packet || packet.workId !== workId) throw new Error('The decision list could not be read.');
  return packet;
}

/** The answers reach the CLI in a private file that is gone once SF Guard's card was read and the record ran. */
async function withAnswers<T>(packet: DecisionPacket, answers: DecisionAnswers, action: (file: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-decide-'));
  const file = path.join(directory, 'answers.json');
  try {
    await writeFile(file, JSON.stringify(decisionAnswersDocument(answers, packet.packetSha256)), { mode: 0o600, flag: 'wx' });
    return await action(file);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** SF Guard's card for these answers, or null from an engine without one (its refusal then hands over the terminal route). */
const readGuardCard = (client: SingularityFlowClient, workId: string, file: string): Promise<GuardCardRead | null> =>
  client.run(guardCardDecisionsArgv(workId, file), undefined, { priority: 'interactive' }).then(guardCardFrom, () => null);

const today = () => new Date().toISOString().slice(0, 10);

/**
 * `forApproval`: opened from the approval page's "Decide what blocks this step". Only what blocks it is shown, the card
 * records it, and the approval page opens again after it (actions.ts), so the person never goes round other pages.
 */
export async function reviewDecisions(client: SingularityFlowClient, target: { workId?: unknown }, refresh?: () => Promise<unknown>, { askedInChat = false, forApproval = false } = {}): Promise<DecideResult> {
  if (!target || Object.keys(target).some((key) => key !== 'workId') || typeof target.workId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(target.workId)) {
    throw new Error('This page takes only a Story ID. Answers and reasons come from the person on the page.');
  }
  const workId = target.workId;
  // A card already open (an earlier turn's, or the Command Palette's): this ask waits for it, never a "busy" with nothing to
  // follow, nor a chat asking its rows beside it. This Story's gets that card's answer, as a chat is handed one; another
  // Story's is finished or closed first, then this one opens [hardening C, F5].
  while (open) {
    const earlier = open;
    earlier.panel.reveal();
    if (earlier.workId !== workId) void vscode.window.showInformationMessage(`Finish or close the Decide card for ${earlier.workId}; the one for ${workId} opens next.`);
    const answer = await earlier.answer;
    if (earlier.workId === workId) {
      const next = askedInChat ? chatNext(answer.next) : answer.next ?? null;
      return { ...answer, message: `${joinedWords(workId)} ${answer.message}`, ...(next ? { next } : askedInChat && 'next' in answer ? { next: null } : {}) };
    }
  }
  let packet = await readList(client, workId);
  // A step's next version waiting for the person's yes is asked on this card, and what they answered here.
  let declined: VersionOpeningPacket | null = null;
  /**
   * The list as the engine gives it. Its older row for the same next version (decision-list.mjs rolloverItem) no longer
   * offers starting it while its preview waits for the person's yes or their yes is kept: the question asks that once, here
   * as on the Copilot CLI card and in the terminal, and the row keeps only leaving the change out [stage5b.md section 5].
   */
  const shown = (): DecisionPacket => packet;
  // A chat that asked carries on when nothing waits: only a person who opened this page sees a review nothing waits on,
  // or the approval, whose row opens its page [owner, 2026-11-13].
  const waiting = () => (askedInChat || forApproval ? openRows(shown()) : [...decideRows(shown()), ...approvalRows(shown())]);
  /**
   * In VS Code the person approves on the approval page, which this card opens [owner, 2026-11-19]. A chat that asked while
   * only the step's approval is left (VS Code's /sf-approve comes here) opens that page on this Story and step and is told so,
   * with no next step: the approve route it was handed back sent it round again [owner's Story, 2026-11-20]. Null when the
   * chat did not ask, something else is still open, or the approval is not theirs to give now.
   */
  const approvalPage = async (): Promise<{ words: string; elsewhere: boolean; opened: boolean; approval: DecisionItemPacket } | null> => {
    const approval = askedInChat ? readyApproval(packet) : null;
    if (!approval) return null;
    const page = await Promise.resolve(vscode.commands.executeCommand('singularityFlow.openApprovals', approvalFocus(packet, approval)))
      .then((panel) => ({ opened: true, panel }), () => ({ opened: false, panel: null }));
    // The page shows this window's Story: one that shows another, or none, does not have this approval on it, and the chat
    // is never told it does [hardening C, F4]. A page that cannot tell yet (still reading) is taken at its word.
    const shown = (page.panel as { focusShown?: () => { status: string; story: string | null } } | null)?.focusShown?.();
    return shown?.status === 'elsewhere' ? { words: approvalElsewhereWords(packet, approval, shown.story), elsewhere: true, opened: page.opened, approval }
      : { words: approvalPageWords(packet, approval, page.opened), elsewhere: false, opened: page.opened, approval };
  };
  // A chat's answer once the approval page opened: nothing to type, since the person approves or sends it back on that page,
  // so the chat never shows an approve route again [owner, 2026-11-28]; the person's own @sflow /approve only when the page
  // could not open; or the Story to select first (the page shows only the Story this window shows).
  const approvalAnswer = (page: { words: string; elsewhere: boolean; opened: boolean; approval: DecisionItemPacket }) => (page.elsewhere
    ? { status: 'approval-elsewhere', next: selectStoryNext(workId) } : { status: 'approval-open', next: page.opened ? null : approveInChat(packet, page.approval) });
  // What a chat is handed next: never an approve route or this card again (chatNext). A person who opened it keeps the Story's.
  const nextFor = <T>(route: T | null | undefined): T | null => (askedInChat ? chatNext(route) : route ?? null);
  // From the approval page with nothing left to decide: straight back to it.
  if (forApproval && !waiting().length && !versionOpeningOf(packet)) return { status: 'nothing-to-decide', message: packet.headline };
  // Nothing waits on this person: the Story's own next step ends it [owner, 2026-11-18].
  if (!waiting().length && !versionOpeningOf(packet)) {
    const page = await approvalPage();
    if (page) return { ...approvalAnswer(page), message: page.words };
    // An approval left that is not theirs to give now says why, in the list's words: what holds it, or who approves it.
    const approval = askedInChat ? approvalRows(packet)[0] : undefined;
    // Someone else's, ready: who, and the route to see and ask them, never a bare "nothing to decide" [hardening C].
    if (approval && approval.details?.ready !== false && othersApproval(approval)) {
      return { status: 'approval-by-others', message: othersApprovalWords(approval), next: approversNext(workId) };
    }
    const why = approval ? (approval.decidedBy?.allowed ? approval.why : approval.decidedBy?.words) : null;
    // A held approval: the Story's next step, else the person's own @sflow /approve, which says what holds it and approves it
    // once cleared. An approve turn never ends with no route [owner's Story arshy, 2026-11-20]. What was settled is one line
    // at most, never asked [owner, 2026-11-20].
    return { status: 'nothing-to-decide', message: [packet.headline, why, packet.plain?.settledLine, nextWords(nextFor(packet.storyNext))].filter(Boolean).join(' '),
      next: nextFor(packet.storyNext ?? packet.next) ?? (approval ? approveInChat(packet, approval) : null) };
  }
  const panel = vscode.window.createWebviewPanel('singularityFlow.decide', `Decide · ${workId}`, vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  const answer = new Promise<DecideResult>((resolve) => {
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
    // A task whose step goes on after what was recorded here: the chat route that carries it on, and what a chat's agent does.
    let continueTask: string | undefined;
    let continueTaskInstruction: string | undefined;
    const render = (error: string | null = null, notice: string | null = null) => {
      const token = nonce();
      panel.webview.html = page(`Decide · ${workId}`, `<style nonce="${token}">${DECIDE_STYLE}</style>${decideHtml(shown(), { error, notice, busy, draft, route, declined: declined?.digest ?? null, forApproval })}`,
        contentSecurityPolicy(panel.webview, token), token, DECIDE_SCRIPT);
    };
    const finish = (answer: DecideResult) => {
      if (settled) return;
      settled = true;
      const result = continueTask ? { ...answer, continueTask, ...(continueTaskInstruction ? { instruction: continueTaskInstruction } : {}) } : answer;
      resolve(summaryUpdate && !result.message.includes(summaryUpdate) ? { ...result, summaryUpdate, message: `${result.message} ${summaryUpdate}` }
        : summaryUpdate ? { ...result, summaryUpdate } : result);
      panel.dispose();
    };
    const notNow = () => (recorded.length ? { status: 'recorded', recorded, ...(drafted.length ? { drafted } : {}), message: `${recorded.length} recorded; the rest stay open.${drafted.length ? ` ${drafted.join(' ')}` : ''}` }
      : drafted.length ? { status: 'drafted', recorded, drafted, message: `No decision was recorded. ${drafted.join(' ')}` }
        : { status: 'cancelled', message: 'No decision was recorded.' });
    const reread = async () => { packet = await readList(client, workId).catch(() => packet); };
    // What an answer depends on, SFlow checks itself, read-only and bounded, and the rows recommend from it [owner, 2026-11-16].
    const check = async (seconds: number, { asked = false } = {}) => {
      const names = checkNames(packet, { asked });
      if (!names.length || busy) return;
      busy = true;
      render(null, `Checking: ${names.join('; ')} (up to ${seconds >= 120 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`}; nothing is recorded).`);
      packet = await readList(client, workId, { probe: seconds }).catch(() => packet);
      busy = false;
      // Closed while it checked: nothing to show it on.
      if (settled) return;
      panel.reveal();
      // The row itself says so when the first check ran out of time; only a check the person asked for is reported,
      // and one that failed in its own words (a screenshot whose build failed).
      const failed = decideRows(packet).map((item) => checkOf(item)?.failed).find(Boolean);
      render(null, asked && checkNames(packet, { asked }).length ? failed ? `${failed} Nothing was recorded.` : 'The check did not finish in time; nothing was recorded.' : null);
    };
    // Runs `decision screenshot`: SFlow opens what was published in its own browser, the person brings up the screen and
    // captures it, then the list is read again and its sign-off asks them to look at the screenshot.
    const screenshot = async (shot: { criterion?: string; slot?: string }) => {
      if (busy || !shot.criterion || !shot.slot) return;
      busy = true;
      render(null, 'SFlow is opening what was published in its own browser: bring up the screen the criterion is about, then click "Capture this screen" on SFlow\'s bar.');
      let failed: string | null = null;
      try {
        await client.run(['decision', 'screenshot', '--work-id', workId, '--criterion', shot.criterion, '--slot', shot.slot, '--json'], undefined, { priority: 'interactive' });
      } catch (error) { failed = `No screenshot was taken: ${(error as Error).message}`; }
      await reread();
      busy = false;
      if (settled) return;
      panel.reveal();
      render(failed, failed ? null : 'The screenshot is taken: look at it and sign it off below.');
    };
    const optionOf = (message: InboundMessage) => decideRows(packet).find((item) => item.id === stringField(message, 'item'))
      ?.options.find((option) => option.id === stringField(message, 'option'));
    // A row's own step, or a held package's accept command for a person who may accept it [CQF:REQ-052]: always from the list as read.
    const commandOf = (message: InboundMessage) => {
      const hold = stringField(message, 'hold');
      if (hold === null) return optionOf(message)?.action?.command ?? optionOf(message)?.terminal ?? null;
      const entry = /^\d{1,2}$/u.test(hold) ? packet.approvalEvidence?.hold?.entries?.[Number(hold)] : undefined;
      return entry?.allowed === true && typeof entry.command === 'string' ? entry.command : null;
    };
    // The whole command, with the reason and date the person typed in the row: never one with a blank left in it [owner, 2026-11-19].
    // Any other value it takes the card asks for right here, by its name, never "decide it from your terminal" [owner, 2026-11-28].
    const completeCommandOf = async (message: InboundMessage) => {
      const command = commandOf(message);
      if (!command) return null;
      const given = { reason: stringField(message, 'reason'), expires: stringField(message, 'expires') };
      // Each other value the command takes, asked here by its name, then the row's reason and date.
      let text = command;
      for (const slot of [...new Set(command.match(/<[^<>\s]+>/gu) ?? [])].filter((entry) => !/^<(?:REASON|reason|why|TEXT|YYYY-MM-DD)>$/u.test(entry))) {
        const name = slot.slice(1, -1).replace(/[-_]/gu, ' ').toLowerCase();
        const typed = await vscode.window.showInputBox({ title: `This step needs the ${name}`, prompt: `Type the ${name}: it goes into the command, which then runs as it is.`,
          ignoreFocusOut: true, validateInput: (value) => (value.trim() && !/[\s"'`$\;|&<>]/u.test(value.trim()) ? null : 'One word, with no spaces or quotes.') });
        if (!typed?.trim()) return null;
        text = text.split(slot).join(typed.trim());
      }
      const filled = filledCommand(text, given, process.platform === 'win32');
      if ('command' in filled) return filled.command;
      void vscode.window.showWarningMessage(filled.missing === 'reason' ? 'Write your reason in the row first: it goes into the command, so there is nothing left to fill in.'
        : 'Choose the date in the row first: it goes into the command, so there is nothing left to fill in.');
      return null;
    };
    const router = registerMessageRouter('singularityFlow.decide', {
      'decide.cancel': () => finish(notNow()),
      // "Check first", chosen on a row: what the person typed stays on the page.
      'decide.check': async (message) => {
        draft = decideDraftFrom(message);
        // A visual sign-off's screenshot is the person's own capture at SFlow's browser, never a check [owner, 2026-11-18].
        const row = decideRows(packet).find((item) => item.id === stringField(message, 'item'));
        const shot = row ? checkOf(row) : null;
        if (shot?.kind === 'screenshot') return screenshot(shot);
        await check(CHECK_FIRST_SECONDS, { asked: true });
      },
      'decide.open': async (message) => {
        const file = stringField(message, 'path');
        // A row offered beside the list opens its file too: a convergence answer someone may change names the file it is about [SCS:REQ-034].
        if (!file || !packet.repositoryPath || !(decideRows(packet).some((item) => item.details?.path === file) || evidencePaths(packet).includes(file))) return;
        // The page of what the change does reads as a page: its Markdown preview, beside the card [CSP:REQ-007].
        if (file.endsWith('/CHANGE-STORY.md')) {
          await vscode.commands.executeCommand('markdown.showPreviewToSide', vscode.Uri.file(path.join(packet.repositoryPath, file))).then(undefined, () => undefined);
          return;
        }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(packet.repositoryPath, file)), { viewColumn: vscode.ViewColumn.Beside, preview: true })
          .then(undefined, () => vscode.window.showInformationMessage(`${file} is not in this checkout now; it may have been removed.`));
      },
      // The draft a row's own step names, from the list as read: never a path the page sends.
      'decide.draft': async (message) => {
        const file = optionOf(message)?.action?.file;
        if (typeof file === 'string' && path.isAbsolute(file)) await openBeside(file);
      },
      // What another person decides: the words to send them, copied from the list as read [owner, 2026-11-28].
      'decide.share': async (message) => {
        const text = shareText(packet, stringField(message, 'row') ?? '');
        if (text) { await vscode.env.clipboard.writeText(text); void vscode.window.setStatusBarMessage('$(clippy) Copied what to send them.', 3_000); }
      },
      'decide.copy': async (message) => {
        const command = await completeCommandOf(message);
        if (command) { await vscode.env.clipboard.writeText(command); void vscode.window.setStatusBarMessage('$(clippy) Copied.', 3_000); }
      },
      // Typed, not run: the person presses Enter themselves, in a terminal this page opened in the Story's checkout.
      'decide.terminal': async (message) => {
        const command = await completeCommandOf(message);
        if (!command) return;
        const terminal = createTerminalIn({ name: `Singularity Flow · ${workId}` }, packet.repositoryPath ?? client.repository);
        terminal.show(false);
        terminal.sendText(command, false);
      },
      // The approval starts from this card: its row opens the approval page with the documents [owner, 2026-11-13].
      // Opened from the approval page, it closes and that page opens again (actions.ts). Otherwise the approval page itself,
      // for this step: never the Approvals list first, whose Approve opened this page again [owner, 2026-11-28].
      'decide.approval': () => {
        if (forApproval) return finish(notNow());
        const approval = approvalRows(packet)[0];
        const focus = approvalFocus(packet, approval);
        const label = `${packet.phaseLabel} v${Number(approval?.details?.generation) || 0}`;
        void vscode.commands.executeCommand('singularityFlow.approve', { kind: 'action', id: `story:${focus.phase}:approve`, label: `Approve ${label}`,
          approve: { kind: 'story', workId: focus.workId, phaseId: focus.phase, expected: focus.phase, summary: `Approve ${packet.workId} / ${packet.phaseLabel}` } });
      },
      // A step's next version: the person's yes to the exact proposal this page showed, kept by the engine's own command
      // (`decisions record --version-consent`), as on the Copilot CLI card [D3, OSA:REQ-030]. This page writes no record,
      // never runs the opening itself and never sends anything to a chat; "Not now" records nothing.
      'decide.version': async (message) => {
        if (busy) return;
        const asked = versionOpeningOf(packet);
        const answer = stringField(message, 'answer');
        if (!asked || asked.digest === declined?.digest || stringField(message, 'digest') !== asked.digest
          || (answer !== 'yes' && answer !== 'no' && !(answer === 'question' && asked.justAQuestion === true))) {
          await reread();
          return render('This question changed since the page showed it, so nothing was recorded. Read it again below.');
        }
        const version = `Version ${asked.version} of ${asked.phase}`;
        if (answer === 'no') {
          declined = asked;
          // The person's "Not now" ends it for this chat too: the list read after the card still shows the proposal waiting,
          // and a chat that asked it again asked twice in one turn [hardening C, F8].
          if (!waiting().length) { const result = notNow(); return finish({ ...result, declined: 'version-opening', message: `${version} was not started. ${result.message} The person chose Not now: do not ask it again in this chat.` }); }
          return render(null, `${version} was not started; nothing was recorded for it.`);
        }
        busy = true; render();
        // The list as it is now: the yes is kept only for the proposal still waiting, on this Story.
        let fresh: DecisionPacket;
        try { fresh = await readList(client, workId); } catch {
          busy = false; panel.reveal();
          return render(`The decisions for ${workId} could not be read in this checkout now, so nothing was recorded. If it holds another Story, open ${workId}'s checkout and ask again.`);
        }
        packet = fresh;
        const now = versionOpeningOf(packet);
        if (!now || now.digest !== asked.digest) {
          busy = false; panel.reveal();
          return render(now ? 'The proposal changed since the page showed it, so nothing was recorded. This is the one waiting now.'
            : `${version} no longer waits for your yes, so nothing was recorded.`);
        }
        try {
          // "No, it was just a question" is kept by the engine's own command too, and opens nothing (owner, 2026-11-18).
          const question = answer === 'question';
          const outcome = versionConsentOutcome(await client.run(question ? justAQuestionArgv(now) : versionConsentArgv(now), undefined, { priority: 'interactive' }));
          recorded = [...recorded, question ? 'version-question' : 'version-opening'];
          // Kept: a view that fails to refresh never turns it into a failure.
          await Promise.resolve(refresh?.()).catch(() => undefined);
          await reread();
          busy = false;
          if (!waiting().length) return finish({ status: 'recorded', recorded, remaining: [], message: outcome.message, next: nextFor(outcome.next) });
          panel.reveal();
          render(null, outcome.message);
        } catch (error) {
          const failure = error as Error & { result?: unknown };
          const outcome = versionConsentOutcome(null, { message: failure.message, result: failure.result });
          // The engine's own words: what it refused, and for a moved or other proposal, that nothing was kept.
          await reread();
          busy = false; panel.reveal();
          render(outcome.message);
        }
      },
      // The Story's own next step, typed into a terminal in the Story's checkout; the person presses Enter.
      'decide.next': () => {
        const command = packet.storyNext?.command;
        if (!command) return;
        const terminal = createTerminalIn({ name: `Singularity Flow · ${workId}` }, packet.repositoryPath ?? client.repository);
        terminal.show(false);
        terminal.sendText(command, false);
      },
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
          if (!openRows(packet).length) {
            // The approval is all that is left: a chat that asked gets its page, as when it opened this card [owner's Story, 2026-11-20].
            const page = settled ? null : await approvalPage();
            return finish({ ...(page ? approvalAnswer(page) : { status: 'recorded', next: nextFor(packet.storyNext ?? packet.next) }), recorded, remaining: [],
              message: [`${recorded.length} recorded. All decided.`, page?.words ?? nextWords(nextFor(packet.storyNext))].filter(Boolean).join(' ') });
          }
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
          const ran = await withAnswers(packet, answers, async (file) => {
            // A draft writes no record; a decision on a Story SF Guard requires shows the card Touch ID signs.
            const guard = writesOnly ? null : await readGuardCard(client, workId, file);
            const signing = presenceCardArgs(guard);
            // Where SF Guard does not sign here (an exception, no key, Windows or Linux), it says why; where it is off, it offers itself.
            const noted = guard?.bypass ? ` SF Guard: ${guard.reason}.` : guard?.required && guard.reason ? ` SF Guard cannot sign this here: ${guard.reason}.`
              : guard?.offer ? ` ${guard.offer}` : '';
            const confirmed = await collectReviewConfirmation(writesOnly
              ? { title: `Draft the amendment on ${workId}`, summary: 'A draft is written beside the checkout\'s Git data, with your reason in its slot; nothing is recorded or decided.',
                detail: decideSummary(shown(), choices), confirmLabel: 'Write the draft' }
              : signing.length && guard
                ? { title: `Record and sign your decisions on ${workId}`,
                  summary: 'SF Guard signs this with your Touch ID. Read its card: Touch ID asks right after you click, and nothing is recorded if you cancel it there.',
                  detail: guardCardText(guard), confirmLabel: 'Record and sign with Touch ID' }
                : { title: `Record ${choices.length} decision${choices.length === 1 ? '' : 's'} on ${workId}`,
                  summary: `Each one is recorded with its own reason, under your name.${noted}`, detail: decideSummary(shown(), choices), confirmLabel: 'Record these decisions' });
            if (!confirmed) return null;
            if (signing.length) { panel.reveal(); render(null, 'Touch ID is asking now: touch the sensor to sign, or cancel it there and nothing is recorded.'); }
            const asking = signing.length ? vscode.window.setStatusBarMessage('$(lock) SF Guard: Touch ID is asking now.') : null;
            try { return await client.run([...decisionRecordArgv(packet.workId, file), ...signing], undefined, { priority: 'interactive' }); }
            finally { asking?.dispose(); }
          });
          if (ran === null) { busy = false; panel.reveal(); return render(); }
          const outcome = decisionRecordOutcome(ran).outcome;
          summaryUpdate = outcome.summaryUpdate ?? summaryUpdate;
          continueTask = outcome.continueTask ?? continueTask;
          continueTaskInstruction = outcome.continueTaskInstruction ?? continueTaskInstruction;
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
          // The list after it: with nothing left that waits on this person, its last words are the Story's next step, or, for a
          // chat that asked, the approval page when the approval is all that is left [owner's Story, 2026-11-20].
          await reread();
          const page = settled ? null : await approvalPage();
          const next = page ? null : nextFor(packet.storyNext);
          // The approval is no decision still open: with its page open, or nothing else left, a chat is not told it is.
          const approvalLeft = outcome.approvalLeft ?? [];
          const remaining = askedInChat && (page || outcome.remaining.every((entry) => approvalLeft.includes(entry)))
            ? outcome.remaining.filter((entry) => !approvalLeft.includes(entry)) : outcome.remaining;
          finish({ ...(page ? approvalAnswer(page) : { status: 'recorded', ...(next ? { next } : {}) }), recorded: all, decided, remaining,
            message: [`${decided.length ? `${decided.length} decision${decided.length === 1 ? '' : 's'} recorded. ${decided.join('. ')}.` : all.length ? `${all.length} recorded.` : outcome.message}${remaining.length ? ` Still open: ${remaining.join('; ')}.` : ' All decided.'}`,
              page?.words ?? nextWords(next)].filter(Boolean).join(' ') });
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
    panel.onDidDispose(() => { if (open?.panel === panel) open = null; finish(notNow()); });
    render();
    void check(CHECK_SECONDS);
  });
  open = { panel, workId, answer };
  return answer;
}

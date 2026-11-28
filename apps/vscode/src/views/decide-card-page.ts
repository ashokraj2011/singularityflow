/**
 * Everything a step waits on, as one table on one page: each thing, its choices, and each answer's own
 * reason, or one answer for all that offer it. Pure, so a test can read every word. The engine's list
 * and record own every rule; a page never preselects a choice or fills in a reason.
 *
 * In plain words, the same as Copilot CLI's card and the terminal [owner, 2026-11-16]: each row its question, why in
 * one sentence and "Recommended: …", then its options, recommended first; a check SFlow runs itself offered first until
 * it has a result; what nobody can answer yet on one "Later:" line; what was settled one line each, its evidence behind
 * a detail.
 */
import { escape } from './webview.ts';
import { VSCODE_SELECT_STORY } from '../../../../src/model-free-commands.mjs';
import type { InboundMessage } from './messages.ts';
import { checkOf, laterOf, nextWords, optionRow, plainWords, versionOpeningOf, type DecisionArticleAnswer, type DecisionChoice, type DecisionItemPacket, type DecisionOptionPacket, type DecisionPacket } from './decision-list-model.ts';

export { checkOf, laterOf, plainWords };

/** What the person has entered, by the item's title: IDs are renumbered when the list changes. A render never loses it. */
export type DecideDraft = ReadonlyMap<string, { option: string; reason: string; cause: string; expires: string; clause: string; article: DecisionArticleAnswer[] }>;

const decidable = (option: DecisionOptionPacket) => optionRow(option).choosable;

// What only the person can give a command typed into their terminal: their reason, and a date. The row collects them, so
// "Put it in a terminal" types the whole command, never one with a blank to fill in [owner, 2026-11-19].
const REASON_SLOT = /"<(?:REASON|reason|why|TEXT|why [^<>"]*)>"|<(?:REASON|reason|why|TEXT)>/u;
const DATE_SLOT = /<YYYY-MM-DD>/u;
/** What "Do this now" does, beside every own step on the card: it runs here, and only a step that must ask in a terminal goes there. */
export const RUN_WORDS = 'Do this now runs this step for you with what you wrote here; Put it in a terminal types it in for you to run.';
/** Beside a step that is only a preview (it shows a plan and changes nothing): it is typed into a terminal, never run as if done. */
export const PREVIEW_WORDS = 'This shows what it would do first: Put it in a terminal types it in for you to run.';
/**
 * A row's preview the card shows before one Yes runs it [owner, 2026-11-28]: leaving changes out of a step
 * (`recover W --phase P --json`), whose plan lists the files that go back and the plan it is confirmed by. Null for any other.
 */
export const setAsidePreviewArgv = (command: string): string[] | null => {
  if (!/^singularity-flow recover [A-Za-z0-9][A-Za-z0-9._-]* --phase [A-Za-z0-9][A-Za-z0-9._-]* --json$/u.test(String(command ?? '').trim())) return null;
  const planned = ownStepArgv(command, {});
  return 'argv' in planned ? planned.argv : null;
};
/** What a set-aside preview returned: the files and the plan its one Yes confirms, or null when it offers none. */
export interface SetAsidePreview { kind?: 'set-aside'; option: string; item: string; workId: string; phase: string; planId: string; paths: string[]; argv: string[] }
export function setAsidePreviewOf(result: unknown, at: { option: string; item: string; workId: string; phase: string }): SetAsidePreview | null {
  const seen = new Set<unknown>();
  const find = (value: unknown, depth = 0): SetAsidePreview | null => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 6) return null;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const actions = Array.isArray(record.actions) ? record.actions as Array<Record<string, unknown>> : [];
    const action = actions.find((entry) => entry?.id === 'set-aside-worktree');
    const planId = typeof record.planId === 'string' && /^[A-Za-z0-9._:-]{8,160}$/u.test(record.planId) ? record.planId : null;
    const paths = Array.isArray(action?.paths) ? (action!.paths as unknown[]).filter((entry): entry is string => typeof entry === 'string').slice(0, 200) : [];
    // The plan's own confirming command, as recovery wrote it: this Story and step, set aside, bound to this plan.
    const planned = typeof action?.command === 'string' ? ownStepArgv(action.command, {}) : null;
    const argv = planned && 'argv' in planned ? planned.argv : null;
    const bound = argv && argv[1] === at.workId && argv.includes('--set-aside') && argv[argv.indexOf('--confirm') + 1] === planId && argv[argv.indexOf('--phase') + 1] === at.phase;
    if (action && planId && paths.length && bound) return { ...at, planId, paths, argv: argv! };
    for (const child of Object.values(record)) { const found = find(child, depth + 1); if (found) return found; }
    return null;
  };
  return find(result);
}
/** The one Yes that sets the previewed files aside, bound to the plan the preview showed. */
export const setAsideArgv = (preview: SetAsidePreview) => preview.argv;
/** The preview on the card: the files that go back, that a private copy is kept first, and the one button that does it. */
export function setAsidePreviewHtml(preview: SetAsidePreview | null): string {
  if (!preview) return '';
  return `<section class="dc-own dc-preview" aria-label="What setting aside does"><p><strong>These ${preview.paths.length === 1 ? 'file goes' : `${preview.paths.length} files go`} back to their committed bytes.</strong>
    SFlow first keeps a private copy of every changed file and the Git index, so it can be undone; nothing else changes.</p>
    <ul class="dc-ev-list">${preview.paths.map((file) => `<li>${escape(file)}</li>`).join('')}</ul>
    <button type="button" data-preview-apply>Set ${preview.paths.length === 1 ? 'it' : 'them'} aside</button> <button type="button" class="secondary" data-preview-cancel>Not now</button></section>`;
}
/**
 * The web address a Story's browser checks trust, named on its row [owner, 2026-11-28]: the Story its preview
 * (`story target-origin W --url <AUTHORIZED-URL> --json`) is for, or null for any other command.
 */
export const targetOriginWork = (command: string): string | null =>
  /^singularity-flow story target-origin ([A-Za-z0-9][A-Za-z0-9._-]*) --url <AUTHORIZED-URL> --json$/u.exec(String(command ?? '').trim())?.[1] ?? null;
/** The preview with the address the person wrote: HTTPS, or HTTP on this machine, which the command checks again; else null. */
export function targetOriginPreviewArgv(command: string, url: string | null | undefined): string[] | null {
  const work = targetOriginWork(command);
  const address = String(url ?? '').trim();
  return work && /^https?:\/\/[^\s<>"'`]{1,2000}$/u.test(address) ? ['story', 'target-origin', work, '--url', address, '--json'] : null;
}
/** What the preview would pin, and the plan its one Yes confirms; `conflicts` when recorded evidence would break, so none is offered. */
export interface TargetOriginPreview { kind: 'target-origin'; option: string; item: string; workId: string; origin: string; servers: string[]; steps: string[]; planSha256: string; conflicts: string[] }
export function targetOriginPreviewOf(result: unknown, at: { option: string; item: string; workId: string }): TargetOriginPreview | null {
  const seen = new Set<unknown>();
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, 50) : []);
  const find = (value: unknown, depth = 0): TargetOriginPreview | null => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 6) return null;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record.origin === 'string' && typeof record.planSha256 === 'string' && /^sha256:[a-f0-9]{64}$/u.test(record.planSha256) && record.workId === at.workId) {
      return { kind: 'target-origin', ...at, origin: record.origin, servers: strings(record.servers), steps: strings(record.steps), planSha256: record.planSha256, conflicts: strings(record.evidenceConflicts) };
    }
    for (const child of Object.values(record)) { const found = find(child, depth + 1); if (found) return found; }
    return null;
  };
  return find(result);
}
/** The one Yes that pins the previewed address, bound to the plan the preview showed, with the person's reason. */
export const targetOriginArgv = (preview: TargetOriginPreview, reason: string) => ['story', 'target-origin', preview.workId, '--url', preview.origin, '--reason', reason, '--confirm', preview.planSha256];
/** The preview on the card: the address, the checks that trust it, the reason it takes, and the one button that pins it. */
export function targetOriginPreviewHtml(preview: TargetOriginPreview): string {
  const steps = preview.steps.join(', ') || 'the browser checks';
  if (preview.conflicts.length) {
    return `<section class="dc-own dc-preview" aria-label="What pinning the address does"><p><strong>${escape(preview.origin)} cannot be pinned:</strong> evidence this Story recorded would stop counting.</p>
    <ul class="dc-ev-list">${preview.conflicts.map((entry) => `<li>${escape(entry)}</li>`).join('')}</ul><button type="button" class="secondary" data-preview-cancel>Close</button></section>`;
  }
  return `<section class="dc-own dc-preview" aria-label="What pinning the address does"><p><strong>${escape(steps)} will check the app only at ${escape(preview.origin)}.</strong>
    A check against any other address is refused, and a pinned address is never widened.</p>
    <input data-preview-reason aria-label="Why this is the address to trust" placeholder="Why this is the address to trust" maxlength="2000">
    <button type="button" data-preview-apply>Pin it</button> <button type="button" class="secondary" data-preview-cancel>Not now</button></section>`;
}
/** A preview on the card, whichever row asked for it. */
export type RowPreview = SetAsidePreview | TargetOriginPreview;
const previewHtml = (preview: RowPreview | null) => (!preview ? '' : preview.kind === 'target-origin' ? targetOriginPreviewHtml(preview) : setAsidePreviewHtml(preview));

/** Whether the card runs a step on Do this now: a step that changes something, never a preview (`--json`, `--dry-run`). */
export const runnableStep = (command: string) => !/\s--(?:json|dry-run)(?=\s|$)/u.test(String(command ?? ''));
/**
 * What another person decides: one button that copies the exact words to send them, with their own route, never a command
 * shown with nothing to press [owner, 2026-11-28]. The host copies the text it holds for that row (shareText).
 */
export const shareButton = (row: string) => ` <button type="button" class="dc-link" data-share="${escape(row)}">Copy what to send them</button>`;
/** An SFlow check the person says is wrong here: the report for SFlow's maintainer, to copy as it is [owner, 2026-11-28]. */
export const reportButton = (row: string) => ` <button type="button" class="dc-link" data-share="${escape(row)}">Copy the report for SFlow's maintainer</button>`;
/** The words to send the person who decides a row, from the list as read: what it is, who decides, and their route. */
export function shareText(packet: DecisionPacket, row: string): string | null {
  const item = [...packet.items, ...(packet.offered ?? [])].find((entry) => entry.id === row);
  const report = typeof item?.details?.report === 'string' ? item.details.report : null;
  const share = item?.decidedBy?.share ?? (/^hold-\d{1,2}$/u.test(row) ? `/sf-decide ${packet.workId}` : null);
  if (!share) return report;
  return `Please decide this on Story ${packet.workId}${item ? `: ${item.title}` : ''}. ${item?.decidedBy?.words ?? ''} In Copilot: ${share} (or Decide in VS Code).`.replace(/\s+/gu, ' ').trim();
}

/** The values a command's own step asks for in its row: a reason, a date, or neither. */
export const commandSlots = (command: string) => ({ reason: REASON_SLOT.test(command), expires: DATE_SLOT.test(command) });
const quoted = (value: string, windows: boolean) => (windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`);

/**
 * The command with the person's reason and date in it, quoted for their shell (PowerShell on Windows), or what is still
 * missing: 'reason', 'expires', or 'value' for a blank no row can fill. Never a command with a blank in it.
 */
export function filledCommand(command: string, given: { reason?: string | null; expires?: string | null }, windows = false): { command: string } | { missing: 'reason' | 'expires' | 'value' } {
  const slots = commandSlots(command);
  const reason = String(given.reason ?? '').trim();
  const expires = String(given.expires ?? '').trim();
  if (slots.reason && !reason) return { missing: 'reason' };
  if (slots.expires && !/^\d{4}-\d{2}-\d{2}$/u.test(expires)) return { missing: 'expires' };
  const filled = command.replace(new RegExp(REASON_SLOT.source, 'gu'), () => quoted(reason, windows)).replace(new RegExp(DATE_SLOT.source, 'gu'), expires);
  return /<[^<>\s]+>/u.test(filled) ? { missing: 'value' } : { command: filled };
}

/**
 * A row's own step as the argv the card runs for the person on "Do this now" [owner, 2026-11-28: terminal-only steps move to the
 * card]: the reason and date they gave in the row go in as values of their own, never through a shell, so nothing they type is
 * read as a command. Only a whole `singularity-flow` command, as the list wrote it; anything with a blank the row cannot fill,
 * or a shell character outside quotes (the forward amendment's old `approve|reject`), is not run and says what is missing.
 */
export function ownStepArgv(command: string, given: { reason?: string | null; expires?: string | null }): { argv: string[] } | { missing: 'reason' | 'expires' | 'value' } {
  const reason = String(given.reason ?? '').trim();
  const expires = String(given.expires ?? '').trim();
  const tokens: Array<{ text: string; raw: string; shell: boolean }> = [];
  let text = ''; let raw = ''; let quote: string | null = null; let shell = false; let open = false;
  for (const char of String(command ?? '')) {
    if (quote) { if (char === quote) quote = null; else text += char; raw += char; continue; }
    if (/\s/u.test(char)) { if (open) tokens.push({ text, raw, shell }); text = ''; raw = ''; shell = false; open = false; continue; }
    open = true; raw += char;
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/[|;&$`\\(){}]/u.test(char)) shell = true;
    text += char;
  }
  if (quote) return { missing: 'value' };
  if (open) tokens.push({ text, raw, shell });
  if (!tokens.length || !['singularity-flow', 'sflow'].includes(tokens[0]!.text)) return { missing: 'value' };
  const whole = new RegExp(`^(?:${REASON_SLOT.source})$`, 'u');
  const argv: string[] = [];
  for (const token of tokens.slice(1)) {
    if (whole.test(token.raw)) {
      if (!reason) return { missing: 'reason' };
      argv.push(reason);
    } else if (DATE_SLOT.test(token.raw)) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(expires)) return { missing: 'expires' };
      argv.push(token.text.replace(DATE_SLOT, expires));
    } else if (token.shell || /<[^<>\s]+>/u.test(token.text)) return { missing: 'value' };
    else argv.push(token.text);
  }
  return { argv };
}

/**
 * The refusals that mean only the person's own terminal can take this step, and why, in one line each: SF Guard's Touch ID,
 * a step whose own command shows its card there, an adjudication table, a reviewed Jira plan. The card then opens that terminal
 * with the whole command typed in, and the person presses Enter.
 */
export const OWN_TERMINAL_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  PSS_CARD_NOT_SHOWN: 'SF Guard signs this with your Touch ID, which only your own terminal can ask for',
  ACTION_TERMINAL_PRESENTATION_REQUIRED: 'its command shows you its exact card and asks you there',
  ADJUDICATION_TERMINAL_REQUIRED: 'its table asks you each row there',
  JIRA_PLAN_CURRENT_NEEDS_TERMINAL: 'it shows the reviewed Jira plan again and asks you there',
  DEPARTURE_OWN_TERMINAL: 'its command asks you there'
});
/** What the card says when a step must go to the person's own terminal: why, and that it is typed in for them. */
export const ownTerminalWords = (code: string) => `This one runs in your own terminal: ${OWN_TERMINAL_REFUSALS[code] ?? 'its command asks you there'}. It is typed in there for you; press Enter.`;
/** What a row still needs before "Do this now" can run its step. */
export const runMissingWords = (missing: 'reason' | 'expires' | 'value') => (missing === 'reason' ? 'Write your reason in the row first: it goes into the step as you wrote it.'
  : missing === 'expires' ? 'Choose the date in the row first: it goes into the step.' : 'This step needs a value the row cannot fill in, so nothing ran. Put it in a terminal: it is typed in there for you to finish.');

/** The fields an own step's command needs, in its row: shown only where the command takes them. */
const slotFields = (command: string, key: string, name: string) => {
  const slots = commandSlots(command);
  return `${targetOriginWork(command) ? `<input type="url" data-own-url="${escape(key)}" aria-label="The web address, for ${escape(name)}" placeholder="https://… the address the app runs at" maxlength="2000">` : ''}${slots.reason ? `<input data-own-reason="${escape(key)}" aria-label="Your reason, for ${escape(name)}" placeholder="Your reason, typed into the command" maxlength="1000">` : ''}${slots.expires
    ? `<label class="dc-date">Until <input type="date" data-own-expires="${escape(key)}" aria-label="Until when, for ${escape(name)}"></label>` : ''}`;
};
const ownSteps = (item: DecisionItemPacket) => item.options.filter((option) => option.action?.command && !option.action.humanReview && option.decidedBy?.allowed && option.available !== false);
const witnesses = (item: DecisionItemPacket) => item.options.filter((option) => option.action?.humanReview && option.decidedBy?.allowed && option.available !== false);

/**
 * The checks this page's read waits on, in words ("run the tests on Node 22"). One that runs only when the person asks
 * (SFlow's screenshot builds the app) is left to its row's button unless `asked`.
 */
export const checkNames = (packet: DecisionPacket, { asked = false } = {}): string[] => decideRows(packet)
  .filter((item) => checkOf(item) && item.decidedBy?.allowed && (asked || !checkOf(item)!.onRequest))
  .map((item) => checkOf(item)!.label.replace(/^Check first: /u, ''));
/** The recommended option first, then the rest in the list's order. */
const recommendedFirst = (item: DecisionItemPacket, options: DecisionOptionPacket[]) => [...options]
  .sort((left, right) => Number(item.recommended?.option === right.id) - Number(item.recommended?.option === left.id));

/** Every open decision: the approval is reviewed on its own page, which its row here opens. */
export const openRows = (packet: DecisionPacket): DecisionItemPacket[] => packet.items.filter((item) => item.kind !== 'approval');
/**
 * What this page decides: the open decisions, then anything offered that nothing waits on, then what SFlow settled for
 * the person and carries beside the list, each with its Undo [owner, 2026-11-13].
 */
export const decideRows = (packet: DecisionPacket): DecisionItemPacket[] => {
  const rows = [...openRows(packet), ...(packet.offered ?? [])];
  return [...rows, ...(packet.settled ?? []).filter((item) => item?.settled === true && !rows.some((row) => row.id === item.id))];
};
/** What SFlow settled for the person: under "Settled for you", never among what waits. */
export const settledRows = (packet: DecisionPacket): DecisionItemPacket[] => decideRows(packet).filter((item) => item.settled === true);
/** The step's approval: it starts from this card, whose row opens the approval page [owner, 2026-11-13]. */
export const approvalRows = (packet: DecisionPacket): DecisionItemPacket[] => packet.items.filter((item) => item.kind === 'approval');

/**
 * Whether the approval is plainly someone else's: `allowed` false, with the read sure who the person is, and who approves
 * named. Anything less (unknown, not established, nobody named) is not: the approval page checks identity and authority
 * when the person approves [owner's Story arshy, 2026-11-20, hardening C].
 */
export const othersApproval = (item: DecisionItemPacket): boolean => item.decidedBy?.allowed === false && item.decidedBy.established !== false
  && Boolean(item.decidedBy.labels?.length || item.decidedBy.people?.length);

/**
 * The step's approval when it is the only thing left and the person may give it now: nothing above holds it, and it is not
 * plainly someone else's. A chat that opened this card then gets the approval page, never an approve route back [owner's
 * Story, 2026-11-20]; an approval whose approver this read could not establish opens it too ("nothing to decide" ended that
 * chat with the approval theirs, owner's Story arshy, 2026-11-20).
 */
export const readyApproval = (packet: DecisionPacket): DecisionItemPacket | null => (openRows(packet).length ? null
  : approvalRows(packet).find((item) => item.details?.ready !== false && !othersApproval(item)) ?? null);

/**
 * Someone else's approval, ready: who approves it, in the list's words, and where to see them and send it, never a bare
 * "nothing to decide". The route is /sf-approvals, the step's approval chain with its groups and people.
 */
export function othersApprovalWords(item: DecisionItemPacket): string {
  return [item.decidedBy.words, 'They approve it on their own approval page.'].join(' ');
}
export const approversNext = (workId: string) => ({ kind: 'approvers', title: `See who approves ${workId} and ask them`, command: `singularity-flow approvals ${workId}`,
  copilotCommand: `/sf-approvals ${workId}`, modelFreeCommand: 'Command Palette: Singularity Flow: Approvals' });

/**
 * The approval in VS Code's chat box with no model between: `@sflow /approve <step> --work-id <W>`, which the person types and
 * the extension takes through the one approval screen (lifecycle-chat.ts approveWithReceipt). The only approve route a chat is
 * handed, and only as the person's model-free one: an approve turn never ends with no route [owner's Story arshy, 2026-11-20].
 */
export function approveInChat(packet: DecisionPacket, item?: DecisionItemPacket | null) {
  const version = Number(item?.details?.generation);
  const step = `${packet.phaseLabel}${Number.isSafeInteger(version) && version > 0 ? ` v${version}` : ''}`;
  return { kind: 'approve-in-chat', title: `Approve ${step} yourself: type this in the chat box`, command: null, copilotCommand: null,
    modelFreeCommand: `@sflow /approve ${approvalFocus(packet, item).phase} --work-id ${packet.workId}` };
}

/** The Story and step the approval page opens on: the approval row's own step. */
export function approvalFocus(packet: DecisionPacket, item?: DecisionItemPacket | null): { workId: string; phase: string } {
  const phase = item?.details?.phase;
  return { workId: packet.workId, phase: typeof phase === 'string' && phase ? phase : packet.phase };
}

/**
 * What a chat that opened this card is told once the approval page is open: nothing to relay, nothing it records. A page
 * that could not open leaves one route, the person's own @sflow /approve (approveInChat), the tool's next [owner, 2026-11-21].
 */
export function approvalPageWords(packet: DecisionPacket, item: DecisionItemPacket, opened = true): string {
  const version = Number(item.details?.generation);
  const step = `${packet.phaseLabel}${Number.isSafeInteger(version) && version > 0 ? ` v${version}` : ''}`;
  return opened ? `The approval page is open for ${step} with its documents. The person approves or sends it back there; this chat records nothing and offers no command.`
    : `The approval page for ${step} could not open here. The person approves by typing ${approveInChat(packet, item).modelFreeCommand} in the chat box; this chat records nothing.`;
}

/**
 * The approval page opened on a window that shows another Story, or none: the approval is not on it, so the chat is never told
 * "the approval page is open" [hardening C, F4]. What the person does: select this Story here, then approve on the page.
 */
export function approvalElsewhereWords(packet: DecisionPacket, item: DecisionItemPacket, shown: string | null): string {
  const version = Number(item.details?.generation);
  const step = `${packet.phaseLabel}${Number.isSafeInteger(version) && version > 0 ? ` v${version}` : ''}`;
  return [`${packet.workId}'s approval of ${step} is not on the approval page: this VS Code window shows ${shown ?? 'no Story'}.`,
    `The person selects ${packet.workId} here with the page's "Open Stories" button, or ${VSCODE_SELECT_STORY}, then Attach.`,
    'Then they approve it on the approval page; this chat records nothing.'].join(' ');
}
/** The route a chat relays for it: the Stories page, no Copilot or terminal form. */
export const selectStoryNext = (workId: string) => ({ kind: 'select-story', title: `Show ${workId} in this VS Code window`, command: null, copilotCommand: null, modelFreeCommand: VSCODE_SELECT_STORY });

/**
 * A second ask while a card is open (an earlier turn's, or one opened from the Command Palette) waits for that card and gets its
 * answer: never a "busy" with nothing to follow, and never this chat asking its rows beside the open page [hardening C, F5].
 */
export const joinedWords = (workId: string) => `The Decide card for ${workId} was already open; this is what the person did there.`;

// Routes that approve: Copilot's /sf-approve, VS Code's @sflow /approve and the terminal's `approve`.
const APPROVE_ROUTE = /^(?:\/sf-approve|@sflow\s+\/approve|(?:singularity-flow|sflow)\s+approve)(?:\s|$)/u;
const CARD_ROUTE = /^\/(?:sf-)?decide(?:\s+[A-Za-z0-9._-]+)?\s*$/u;
const routeFields = (route: unknown) => (route && typeof route === 'object'
  ? ['copilotCommand', 'command', 'modelFreeCommand', 'skill'].map((key) => (route as Record<string, unknown>)[key]).filter((value): value is string => typeof value === 'string')
  : []);
/** Whether a next step approves: in VS Code the approval page does that, which this card opens [owner, 2026-11-19]. */
export const approvesRoute = (route: unknown): boolean => routeFields(route).some((value) => APPROVE_ROUTE.test(value.trim()));
/**
 * The next step a chat that opened this card is handed: never an approve route, which sent /sf-approve back here, and
 * never this card itself, which opens it again with nothing new (owner's Story, 2026-11-20: "why is it again asking for approval").
 */
export function chatNext<T>(route: T | null | undefined): T | null {
  if (!route) return null;
  // The person's own model-free @sflow /approve (approveInChat): no Copilot or terminal form for a chat to take itself.
  const own = route as { kind?: unknown; copilotCommand?: unknown; command?: unknown };
  if (own.kind === 'approve-in-chat' && !own.copilotCommand && !own.command) return route;
  const card = (route as { kind?: unknown }).kind === 'decide-card' || routeFields(route).some((value) => CARD_ROUTE.test(value.trim()));
  return approvesRoute(route) || card ? null : route;
}

/**
 * The recommendation, then the options with what each does, recommended first, the check first of all [owner, 2026-11-16]:
 * under the question and why, on every row, whether the person decides it or not. Shown, never preselected. What was
 * settled shows its one line, and its evidence behind a detail.
 */
function adviceHtml(item: DecisionItemPacket): string {
  const plain = plainWords(item);
  if (item.settled) {
    const evidence = [item.evidence ?? item.details?.evidence].flat().filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
    const undo = item.options.find((option) => option.available !== false && option.does);
    return evidence.length || undo ? `<details class="dc-detail"><summary>What it rests on</summary><ul class="dc-ev-list">${evidence.map((line) => `<li>${escape(line)}</li>`).join('')}${
      undo ? `<li><strong>${escape(undo.label.replace(/[.!?]+$/u, ''))}</strong>: ${escape(undo.does!)}</li>` : ''}</ul></details>` : '';
  }
  const choices = recommendedFirst(item, item.options.filter((option) => option.available !== false && option.does));
  const check = checkOf(item);
  const tag = ' <span class="dc-tag">recommended</span>';
  return `${plain.recommended ? `<p class="dc-rec">${escape(plain.recommended)}</p>` : ''}${choices.length || check ? `<ul class="dc-does">${check
    ? `<li><strong>${escape(check.label)}</strong>${item.recommended?.check ? tag : ''}: ${escape(check.does)}</li>` : ''}${choices.map((option) => `<li><strong>${escape(option.label.replace(/[.!?]+$/u, ''))}</strong>${
    item.recommended?.option === option.id ? tag : ''}: ${escape(option.does!)}</li>`).join('')}</ul>` : ''}`;
}

/**
 * The answers one reason may cover: offered by two or more rows this person decides, needing nothing but a
 * reason. A departure's plan row, test or clause-touching wording is decided one by one (`oneByOne`), never
 * here. `others` counts the rows offering the same answer that other approvers decide: Apply to all leaves them.
 */
export function sharedAnswers(packet: DecisionPacket): Array<{ id: string; label: string; rows: number; others: number }> {
  const seen = new Map<string, { id: string; label: string; rows: number; others: number }>();
  for (const item of decideRows(packet)) {
    // An undo of what was settled, or a row offered beside the list, is each row's own, never one answer for all [owner, 2026-11-20].
    if (!item.decidedBy?.allowed || item.settled || item.optional) continue;
    for (const option of item.options.filter(decidable)) {
      const needs = option.needs ?? {};
      if (option.oneByOne || needs.cause || needs.expires || needs.clause || needs.article) continue;
      const known = seen.get(option.id);
      // One word for every row it covers, as the Copilot CLI says it: a row's own label may name its step ("Code still holds").
      if (known) known.rows += 1; else seen.set(option.id, { id: option.id, label: option.sharedLabel ?? option.label, rows: 1, others: 0 });
    }
  }
  for (const entry of seen.values()) {
    entry.others = decideRows(packet).filter((item) => item.options.some((option) => option.id === entry.id
      && (!item.decidedBy?.allowed || !decidable(option)))).length;
  }
  return [...seen.values()].filter((entry) => entry.rows > 1);
}

function fieldsHtml(item: DecisionItemPacket, entered: DecideDraft extends ReadonlyMap<string, infer V> ? V | undefined : never): string {
  const name = escape(item.title);
  const needed = (flag: 'reason' | 'cause' | 'expires' | 'clause' | 'article') => item.options.filter(decidable).find((option) => option.needs?.[flag])?.needs?.[flag];
  // The rule a choice here needs most: a convergence item may be sent back unexplained, and its other answers may not.
  const reason = item.options.filter(decidable).map((option) => option.needs?.reason as { default: string; minimum: number; maximum: number } | undefined)
    .filter((need) => need !== undefined).sort((left, right) => right.minimum - left.minimum)[0];
  const cause = needed('cause') as { default: string; minimum: number; maximum: number } | undefined;
  const expires = needed('expires') as { latest: string } | undefined;
  const clause = needed('clause') as { known?: string[]; words?: string } | undefined;
  const article = needed('article') as { articles: Array<{ id: string; title: string; question: string }>; decisions: string[] } | undefined;
  return [
    clause ? `<input data-field="clause" aria-label="${escape(clause.words ?? 'The clauses that carry')}${clause.words ? ', for' : ''} ${name}" placeholder="Clauses: ${escape((clause.known ?? []).slice(0, 4).join(', ') || 'their IDs, separated by commas')}" value="${escape(entered?.clause ?? '')}">` : '',
    article ? `<div data-field="article" class="dc-articles">${article.articles.map(({ id, title, question }) => {
      const given = entered?.article?.find((entry) => entry.article === id);
      return `<label class="dc-article"><span title="${escape(question)}">${escape(title)}</span><select data-article="${escape(id)}" aria-label="${escape(question)}"><option value="">Choose…</option>${article.decisions.map((decision) => `<option value="${escape(decision)}"${given?.decision === decision ? ' selected' : ''}>${escape(decision)}</option>`).join('')}</select>
        <input data-article-reason="${escape(id)}" aria-label="Why, for ${escape(title)}" placeholder="Why, if not satisfied" maxlength="500" value="${escape(given?.reason ?? '')}"></label>`;
    }).join('')}</div>` : '',
    // The rule beside the field, before it is refused: a limit met only as an error ended in typed filler on a real Story.
    reason ? `<label class="dc-field"><small class="muted">Reason (${reason.minimum} to ${reason.maximum} characters)</small><input data-field="reason" aria-label="Reason for ${name}" placeholder="${escape(reason.default || 'Your reason')}" minlength="${reason.minimum}" maxlength="${reason.maximum}" value="${escape(entered?.reason ?? '')}"></label>` : '',
    cause ? `<label class="dc-field"><small class="muted">What stops the tests (${cause.minimum} to ${cause.maximum} characters)</small><input data-field="cause" aria-label="What stops the tests, ${name}" placeholder="${escape(cause.default || 'What stops the tests')}" minlength="${cause.minimum}" maxlength="${cause.maximum}" value="${escape(entered?.cause ?? '')}"></label>` : '',
    expires ? `<label class="dc-date">Until, at most ${escape(expires.latest)} <input type="date" data-field="expires" aria-label="Until when, ${name}" max="${escape(expires.latest)}" value="${escape(entered?.expires ?? '')}"></label>` : ''
  ].join('');
}

function rowHtml(item: DecisionItemPacket, draft?: DecideDraft): string {
  const entered = draft?.get(item.title);
  const file = typeof item.details?.path === 'string' ? item.details.path : null;
  // A departure from an earlier document shows the change itself; its file departures open the file.
  const diff = item.kind === 'departure' && typeof item.details?.diff === 'string' ? item.details.diff : null;
  // An intent amendment shows each clause it changes, who proposed it and what it reaches: what its approver decides [owner, 2026-11-13].
  const text = (key: string) => (typeof item.details?.[key] === 'string' ? `<p class="muted dc-why">${escape(item.details[key] as string)}</p>` : '');
  const lines = Array.isArray(item.details?.lines) ? item.details.lines as string[] : [];
  const plain = plainWords(item);
  const heading = item.settled ? `<strong>${escape(plain.settled ?? item.title)}</strong>` : `<strong>${escape(plain.question ?? item.title)}</strong>`;
  // A row offered beside the list says so: nothing waits on it [owner, 2026-11-20].
  const what = `${heading}${file ? ` <button type="button" class="dc-link" data-open="${escape(file)}">${escape(file)}</button>` : ''}${
    item.optional && !item.settled ? ' <span class="dc-tag">optional</span>' : ''}
    ${plain.why ? `<div class="muted dc-why">${escape(plain.why)}</div>` : ''}${diff ? `<details class="dc-diff"><summary>The change</summary><pre>${escape(diff)}</pre></details>` : ''}${lines.length
      ? `<ul class="dc-ev-list">${lines.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>` : ''}${text('proposedBy')}${text('reach')}${adviceHtml(item)}${
      // Where else its decider may answer it: yes or no in chat, or their own terminal when SF Guard signs it [owner, 2026-11-14].
      item.decidedBy?.allowed && item.answer?.also ? `<p class="muted">${escape(item.answer.also)}</p>` : ''}${
      typeof item.details?.report === 'string' ? `<div class="dc-own">${reportButton(item.id)}</div>` : ''}`;
  if (!item.decidedBy?.allowed) {
    return `<tr data-other="${escape(item.id)}"><td>${what}</td><td colspan="2"><span class="muted">${escape(item.decidedBy?.words ?? '')}</span>${item.decidedBy?.share ? shareButton(item.id) : ''}</td></tr>`;
  }
  const choices = recommendedFirst(item, item.options.filter(decidable));
  // SFlow's own check, first and on a button of its own: it runs, then the row recommends from its result [owner, 2026-11-16].
  const check = checkOf(item);
  const checking = check ? `<div class="dc-own"><button type="button"${item.recommended?.check ? '' : ' class="secondary"'} data-check="${escape(item.id)}">${escape(check.label)}</button></div>` : '';
  // Its empty choice says what leaving it does, as the Copilot CLI card's skip does: kept, its default, or open [owner, 2026-11-20].
  const skip = item.settled ? KEEP_SETTLED : plain.skip ?? (item.optional ? LEAVE_AS_IS : STAYS_OPEN);
  const select = choices.length ? `<select data-choice aria-label="Decision for ${escape(plain.question ?? item.title)}"><option value="">${escape(skip)}</option>${choices.map((option) => {
    const needs = Object.keys(option.needs ?? {}).join(' ');
    return `<option value="${escape(option.id)}" data-needs="${escape(needs)}"${option.oneByOne ? ' data-one="1"' : ''}${entered?.option === option.id ? ' selected' : ''}>${escape(option.label)}${item.recommended?.option === option.id ? ' (recommended)' : ''}</option>`;
  }).join('')}</select>` : '';
  const reviews = witnesses(item).map((option) => `<button type="button" class="secondary" data-witness="${escape(option.id)}">${escape(option.label)}</button>`).join('');
  // A label that already ends a sentence (a hold's route often does) gets no second full stop.
  // A drafted amendment is written in the editor before its command runs [SCS:REQ-021]: the page opens the engine's own file.
  // "Do this now" runs the row's own step for the person, from the list as read; only a step that must ask in their own terminal
  // goes there, typed in [owner, 2026-11-28].
  const own = ownSteps(item).map((option) => `<div class="dc-own"><span>${escape(option.label.replace(/[.!?]+$/u, ''))}.</span> <span class="muted">${escape(runnableStep(option.action!.command!) ? RUN_WORDS : PREVIEW_WORDS)}</span>
      ${option.action?.file ? `<span class="muted">${escape(option.words ?? '')}</span><button type="button" data-draft="${escape(option.id)}">Open the draft</button>` : ''}
      <code>${escape(option.action!.command!)}</code>${slotFields(option.action!.command!, option.id, option.label)}
      ${runnableStep(option.action!.command!) ? `<button type="button" data-run="${escape(option.id)}">Do this now</button>` : setAsidePreviewArgv(option.action!.command!) ? `<button type="button" data-preview="${escape(option.id)}">Show what it sets aside</button>` : targetOriginWork(option.action!.command!) ? `<button type="button" data-preview="${escape(option.id)}">See what it trusts</button>` : ''}
      <button type="button" class="secondary" data-terminal="${escape(option.id)}">Put it in a terminal</button>
      <button type="button" class="secondary" data-copy="${escape(option.id)}">Copy</button></div>`).join('');
  // A choice recorded here may also be made in the person's own terminal, with its exact command (SF Guard signs it there).
  const terminal = choices.filter((option) => option.terminal).map((option) => `<div class="dc-own"><span class="muted">Or in your own terminal:</span>
      <code>${escape(option.terminal!)}</code><button type="button" class="secondary" data-copy="${escape(option.id)}">Copy</button></div>`).join('');
  return `<tr data-item="${escape(item.id)}" data-title="${escape(item.title)}">
    <td>${what}</td><td>${checking}${select}${reviews}${own}${terminal}</td><td class="dc-fields">${choices.length ? fieldsHtml(item, entered) : ''}</td></tr>`;
}

/** Files the evidence names: the page opens these beside it, as it opens a row's file. */
export function evidencePaths(packet: DecisionPacket): string[] {
  const evidence = packet.approvalEvidence;
  return [...new Set([...(evidence?.coverage?.files ?? []).map((file) => file.path), ...(evidence?.proof?.assertionCheck?.tests ?? []).map((entry) => entry.path),
    ...(evidence?.findings?.letThrough ?? []).map((finding) => finding.file), ...approvalDocuments(packet)].filter((file): file is string => typeof file === 'string' && file.length > 0))];
}

type ApprovalCover = { label?: unknown; generation?: unknown; documents?: unknown; words?: unknown };
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value : []).filter((file): file is string => typeof file === 'string' && file.length > 0);
const coversOf = (item: DecisionItemPacket): ApprovalCover[] => (Array.isArray(item.details?.covers) ? item.details.covers as ApprovalCover[] : []);
/** Each finding of the step's review a person disputed, in its words, beside its approval [owner, 2026-11-20]. */
const disputesOf = (item: DecisionItemPacket): string[] => (Array.isArray(item.details?.disputes)
  ? (item.details.disputes as Array<{ words?: unknown }>).map((entry) => entry?.words).filter((words): words is string => typeof words === 'string') : []);

/** What a code step's change does, in one line, and its page (`details.changeStory`) [CSP:REQ-007]. */
export const changeStoryOf = (item: DecisionItemPacket): { summary: string; path: string } | null => {
  const story = item.details?.changeStory as { summary?: unknown; path?: unknown } | undefined;
  return story && typeof story.summary === 'string' && typeof story.path === 'string' ? { summary: story.summary, path: story.path } : null;
};

/** The documents the approval row asks about: its step's, and those of the steps SFlow approved since (approve twice). */
export function approvalDocuments(packet: DecisionPacket): string[] {
  return approvalRows(packet).flatMap((item) => [...stringsOf(item.details?.documents), ...coversOf(item).flatMap((cover) => stringsOf(cover.documents)),
    ...stringsOf([changeStoryOf(item)?.path])]);
}

const fileLink = (file: string) => `<button type="button" class="dc-link" data-open="${escape(file)}">${escape(file)}</button>`;
/** The engine's words for a line, with the file it names as a link to open: the words stay the engine's. */
const linked = (words: string, file: string | null | undefined) => (file && words.includes(file) ? escape(words).replace(escape(file), fileLink(file)) : escape(words));

/**
 * What the step's records say beside its decisions [CQF:REQ-031, REQ-033, REQ-034, REQ-052, REQ-055]: the
 * changed lines its tests ran, each criterion's tests, the findings the loop let through, the vulnerable new
 * package that holds the approval and the command a person who may accept it runs, the required checks, and what
 * the person asked for with each instruction's account [SCS:REQ-043]. Evidence only: no choice here, and a held
 * package's command is the person's own, typed into their terminal. What was typed is shown as text, never markup.
 */
export function evidenceHtml(packet: DecisionPacket): string {
  const evidence = packet.approvalEvidence;
  if (!evidence) return '';
  const part = (title: string, body: string, warn: boolean) => `<section class="dc-ev${warn ? ' dc-ev-warn' : ''}"><h3>${escape(title)}</h3>${body}</section>`;
  const list = (items: string[]) => (items.length ? `<ul class="dc-ev-list">${items.map((item) => `<li>${item}</li>`).join('')}</ul>` : '');
  const more = (count?: number) => (count ? `<p class="muted">And ${count} more.</p>` : '');
  const { coverage, proof, findings, hold, requiredChecks, askedFor, carried } = evidence;
  // A held package whose command a row above already offers is not offered twice.
  const offered = new Set(decideRows(packet).filter((item) => item.decidedBy?.allowed).flatMap((item) => ownSteps(item).map((option) => option.action?.command)));
  const holdStep = (entry: NonNullable<typeof hold>['entries'][number], index: number) => (!entry.allowed
    ? shareButton(`hold-${index}`)
    : offered.has(entry.command) ? '<span class="muted">Its command is on the hold\'s row above.</span>'
      : `<div class="dc-own"><span>Accept it with your reason and an expiry of at most 90 days.</span> <span class="muted">${escape(runnableStep(entry.command) ? RUN_WORDS : PREVIEW_WORDS)}</span>
      <code>${escape(entry.command)}</code>${slotFields(entry.command, `hold-${index}`, 'the held package')}
      ${runnableStep(entry.command) ? `<button type="button" data-hold-run="${index}">Do this now</button>` : ''}
      <button type="button" class="secondary" data-hold-terminal="${index}">Put it in a terminal</button>
      <button type="button" class="secondary" data-hold-copy="${index}">Copy</button></div>`);
  const parts = [
    // Never silent: what counts on a person's word instead of a run, with whose word and for which amendment.
    carried ? part('Carried by "still holds"', `<p class="muted">${escape(carried.words)}</p>${list(carried.entries.map((entry) => escape(entry.words)))}${more(carried.more)}`, true) : '',
    askedFor ? part('Asked for', `<p class="muted">${escape(askedFor.words)}</p>${list(askedFor.instructions.map((entry) => `<q class="dc-asked">${escape(entry.text)}</q>${entry.plainChat ? ' <span class="muted">(plain chat)</span>' : ''}${entry.accountWords
      ? ` <span class="muted">${escape(entry.accountWords)}</span>` : ''}`))}${more(askedFor.more)}`, askedFor.unaccounted > 0) : '',
    coverage ? part('Changed-line coverage', `<p>${escape(coverage.words)}</p>${list((coverage.files ?? []).map((file) => linked(file.words, file.path)))}${more(coverage.more)}`,
      coverage.status !== 'measured' || coverage.below === true) : '',
    proof ? part('Criteria and the tests that prove them', `${list(proof.criteria.map((entry) => escape(entry.words)))}${more(proof.more)}${proof.assertionCheck
      ? `<p>${escape(proof.assertionCheck.words)}</p>${list(proof.assertionCheck.tests.map((entry) => `'${escape(entry.name)}' at ${fileLink(entry.path)}${entry.line ? `:${entry.line}` : ''} asserts nothing`))}` : ''}`,
    proof.criteria.some((entry) => entry.silent > 0 || entry.tests === 0) || proof.assertionCheck?.status === 'incomplete') : '',
    findings ? part('Findings the loop let through', `<p>${escape(findings.words)}</p>${list(findings.letThrough.map((finding) =>
      `<span class="dc-sev">${escape(finding.severity)}</span> ${linked(finding.words.replace(new RegExp(`^${finding.severity} `, 'u'), ''), finding.file)}`))}${more(findings.more)}`,
    findings.letThrough.some((finding) => !finding.accepted)) : '',
    hold ? part('Vulnerable dependency hold', `<p>${escape(hold.words)}</p>${hold.entries.map((entry, index) => `<div class="dc-hold"><strong>${escape(entry.words)}</strong>
      <span class="muted">${escape(entry.who)}</span>${holdStep(entry, index)}</div>`).join('')}${more(hold.more)}`, true) : '',
    requiredChecks ? part('GitHub required checks', `${requiredChecks.words ? `<p>${escape(requiredChecks.words)}</p>` : ''}${list(requiredChecks.checks.map((check) =>
      `${escape(check.name)}: <span class="dc-check dc-check-${escape(check.status)}">${escape(check.status)}</span>`))}`,
    requiredChecks.status !== 'read' || requiredChecks.checks.some((check) => check.status !== 'passed')) : ''
  ].join('');
  return `<section class="dc-evidence" aria-label="Evidence for this approval"><h2>Evidence for this approval</h2>
    <p class="muted">${escape(evidence.words)}</p>${parts}</section>`;
}

/** The approval's row: what holds it, its recommendation, and a button that opens the approval page with its documents. */
/** The two answers to a waiting next version, in the Copilot CLI card's words (plugin/extensions/decisions/card.mjs). */
export const START_VERSION = 'Yes, start it';
export const NOT_NOW = 'Not now';
/** A row's empty choice, in the Copilot CLI card's words (card.mjs LEAVE and KEEP_SETTLED): what leaving it does. */
export const STAYS_OPEN = 'Not now (stays open)';
export const KEEP_SETTLED = 'Keep it';
export const LEAVE_AS_IS = 'Leave it as it is';
// The third answer to a version proposed for words the person typed (owner, 2026-11-18).
export const JUST_A_QUESTION = 'No, it was just a question';
const QUESTION_NOTE = `"${JUST_A_QUESTION}" keeps what you typed as a question and starts nothing.`;

/**
 * A step's next version waiting for the person's yes, asked first as its own question, as the Copilot CLI card asks it:
 * the proposal's question with its real numbers and reason, and two answers bound to that proposal's digest
 * [D3, OSA:REQ-030]. Nothing is preselected, and none shows once the person said "Not now" to it on this page.
 */
export function versionOpeningHtml(packet: DecisionPacket, { declined = null as string | null, busy = false } = {}): string {
  const opening = versionOpeningOf(packet);
  if (!opening || opening.digest === declined) return '';
  const digest = escape(opening.digest);
  return `<section class="dc-opening" aria-label="Start version ${opening.version} of ${escape(opening.phase)}"><h2>${escape(opening.question)}</h2>
    <p class="muted">Your yes is kept for this exact proposal; the step's work command then opens it. Nothing starts on "${NOT_NOW}".${opening.justAQuestion === true ? ` ${QUESTION_NOTE}` : ''}</p>
    <div class="dc-answers"><button type="button" data-version="yes" data-digest="${digest}"${busy ? ' disabled' : ''}>${START_VERSION}</button>
      ${opening.justAQuestion === true ? `<button type="button" class="secondary" data-version="question" data-digest="${digest}"${busy ? ' disabled' : ''}>${JUST_A_QUESTION}</button>
      ` : ''}<button type="button" class="secondary" data-version="no" data-digest="${digest}"${busy ? ' disabled' : ''}>${NOT_NOW}</button></div></section>`;
}

/** The code step's change in one line, first in its approval row, with its page opened beside the card. */
function changeStoryHtml(story: { summary: string; path: string } | null): string {
  return story ? `<p class="dc-docs">What this change does: ${escape(story.summary)} <button type="button" class="dc-link" data-open="${escape(story.path)}">Open the page</button></p>` : '';
}

function approvalHtml(packet: DecisionPacket, { forApproval = false } = {}): string {
  // Opened from the approval page: the approval is that page's, and this card brings the person back to it [owner, 2026-11-28].
  if (forApproval) {
    return `<section class="dc-approval" aria-label="Back to the approval page"><div class="dc-own">
      <button type="button" data-approval>Back to the approval page</button>
      <span class="muted">Record what you decided first; the approval page then opens again with it.</span></div></section>`;
  }
  return approvalRows(packet).map((item) => ({ item, plain: plainWords(item) })).map(({ item, plain }) => `<section class="dc-approval" aria-label="${escape(item.title)}"><h2>${escape(plain.question ?? item.title)}</h2>
    ${plain.why ? `<p class="muted dc-why">${escape(plain.why)}</p>` : ''}${plain.recommended ? `<p class="dc-rec">${escape(plain.recommended)}</p>` : ''}
    ${changeStoryHtml(changeStoryOf(item))}
    ${stringsOf(item.details?.documents).length ? `<p class="dc-docs">Documents: ${stringsOf(item.details?.documents).map(fileLink).join(' ')}</p>` : ''}
    ${coversOf(item).map((cover) => `<p class="dc-docs">Also covered: ${escape(String(cover.label ?? ''))} v${Number(cover.generation) || 0} (${escape(String(cover.words ?? 'approved automatically'))}) ${stringsOf(cover.documents).map(fileLink).join(' ')}</p>`).join('')}
    ${disputesOf(item).map((entry) => `<p class="dc-docs">Disputed: ${escape(entry)}</p>`).join('')}
    ${item.decidedBy?.allowed ? `<div class="dc-own"><button type="button" data-approval="${escape(item.id)}">Review and approve</button>
      <span class="muted">Opens the approval page: these documents, the same question, and its one choice. Nothing is approved until you choose it there.</span></div>`
    : `<p class="muted">${escape(item.decidedBy?.words ?? '')}${item.decidedBy?.share ? shareButton(item.id) : ''}</p>`}</section>`).join('');
}

export function decideHtml(packet: DecisionPacket, { error = null as string | null, notice = null as string | null, busy = false, draft = undefined as DecideDraft | undefined, route = null as string | null,
  declined = null as string | null, forApproval = false, preview = null as RowPreview | null } = {}): string {
  const opening = versionOpeningHtml(packet, { declined, busy });
  const open = decideRows(packet).filter((item) => !item.settled);
  // What nobody can answer yet is one line, never a row [owner, 2026-11-16].
  const later = [...open, ...approvalRows(packet)].map(laterOf).filter((line): line is string => Boolean(line));
  const rows = open.filter((item) => !laterOf(item));
  const settled = settledRows(packet);
  const shared = sharedAnswers(packet);
  // An Undo under "Settled for you" is recorded like any answer, so it alone enables the review [owner, 2026-11-13].
  const yours = [...rows, ...settled].some((item) => item.decidedBy?.allowed && item.options.some(decidable));
  return `<main class="dc" data-digest="${escape(packet.packetSha256)}">
    <header><h1>Decide · ${escape(packet.workId)} · ${escape(packet.phaseLabel)}</h1>
      <p class="muted">${escape(packet.plain?.headline ?? packet.headline)} Nothing is recorded until you press Record what I chose; Not now records nothing.</p></header>
    ${error ? `<p class="dc-error" role="alert">${escape(error)}</p>` : ''}
    ${notice ? `<p class="dc-notice" role="status">${escape(notice)}</p>` : ''}
    ${route ? `<div class="dc-own"><code>${escape(route)}</code><button type="button" data-route>Put it in a terminal</button></div>` : ''}
    ${previewHtml(preview)}
    ${opening}
    ${shared.length ? `<section class="dc-all"><label for="dc-all-choice">One answer for all that offer it</label>
      <select id="dc-all-choice"><option value="">Choose…</option>${shared.map((entry) => `<option value="${escape(entry.id)}">${escape(entry.label)} (${entry.rows} rows)</option>`).join('')}</select>
      <input id="dc-all-reason" aria-label="One reason for all of them" placeholder="One reason" maxlength="1000"><button type="button" data-apply-all>Apply to all</button>
      ${shared.filter((entry) => entry.others).map((entry) => `<p class="muted">"${escape(entry.label)}" covers only the rows you decide; ${entry.others === 1 ? '1 more stays' : `${entry.others} more stay`} listed for their own approvers.</p>`).join('')}</section>` : ''}
    ${rows.length || (!settled.length && !later.length && !opening) ? `<div class="dc-table"><table>
      <thead><tr><th>The question</th><th>Your decision</th><th>Your reason</th></tr></thead>
      <tbody>${rows.map((item) => rowHtml(item, draft)).join('')}</tbody>
    </table></div>` : ''}
    ${later.map((line) => `<p class="dc-later">Waiting: ${escape(line)}</p>`).join('')}
    ${settled.length ? `<section class="dc-settled" aria-label="Settled for you"><h2>Settled for you</h2>
      <div class="dc-table"><table><thead><tr><th>What SFlow chose</th><th>Your decision</th><th>Your reason</th></tr></thead>
      <tbody>${settled.map((item) => rowHtml(item, draft)).join('')}</tbody></table></div></section>` : ''}
    ${approvalHtml(packet, { forApproval })}
    ${evidenceHtml(packet)}
    ${packet.storyNext ? `<div class="dc-own dc-next" role="status"><strong>${escape(nextWords(packet.storyNext))}</strong>${packet.storyNext.command
      ? `<button type="button" class="secondary" data-next>Put it in a terminal</button>` : ''}</div>`
    : packet.plain?.afterAnswer ? `<p class="dc-next" role="status"><strong>Next: ${escape(packet.plain.afterAnswer)}</strong></p>` : ''}
    <footer><button type="button" class="secondary" data-cancel>Not now</button>
      ${yours ? `<button type="button" data-review${busy ? ' disabled' : ''}>Record what I chose</button>`
    // Nothing here is theirs to record: the card says why on itself, never a button that does nothing [owner, 2026-11-18].
    : packet.plain?.nothingToRecord ? `<p class="muted" role="status">${escape(packet.plain.nothingToRecord)}</p>` : ''}</footer>
  </main>`;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const pageRows = (message: InboundMessage) => (Array.isArray(message.rows) ? message.rows as Array<Record<string, unknown>> : []);

export function decideDraftFrom(message: InboundMessage): DecideDraft {
  return new Map(pageRows(message).filter((row) => typeof row?.title === 'string')
    .map((row) => [row.title as string, { option: text(row.option), reason: text(row.reason), cause: text(row.cause), expires: text(row.expires), clause: text(row.clause),
      article: (Array.isArray(row.article) ? row.article as DecisionArticleAnswer[] : []) }]));
}

/** The rows the person answered, as the list's choices, or what is wrong: a reason with no decision is never taken for one. */
export function decideChoicesFrom(packet: DecisionPacket, message: InboundMessage): { choices: unknown[]; problem: string | null } {
  const choices: unknown[] = [];
  for (const row of pageRows(message)) {
    const item = decideRows(packet).find((entry) => entry.id === row?.item);
    if (!item) return { choices: [], problem: 'The page named an item that is not on this list. Nothing was recorded.' };
    if (!text(row.option)) {
      if (text(row.reason).trim()) return { choices: [], problem: `Choose a decision for "${item.title}", or clear its reason.` };
      continue;
    }
    const option = item.options.find((entry) => entry.id === row.option);
    choices.push({ item: item.id, option: row.option, ...(option?.needs?.reason ? { reason: text(row.reason) } : {}),
      ...(option?.needs?.cause ? { cause: text(row.cause) } : {}), ...(option?.needs?.expires ? { expires: text(row.expires) } : {}),
      ...(option?.needs?.clause ? { clause: text(row.clause) } : {}), ...(option?.needs?.article ? { article: row.article } : {}) });
  }
  return choices.length ? { choices, problem: null } : { choices, problem: 'Choose a decision for at least one row.' };
}

/** The exact words a person confirms: one line per answer with its own reason, and what stays undecided. */
export function decideSummary(packet: DecisionPacket, choices: readonly DecisionChoice[]): string {
  const rows = decideRows(packet);
  const lines = choices.map((choice) => {
    const item = rows.find((entry) => entry.id === choice.item);
    const option = item?.options.find((entry) => entry.id === choice.option);
    const articles = choice.article?.map((entry) => `${entry.article}: ${entry.decision}${entry.reason ? ` (${entry.reason})` : ''}`).join('; ');
    return `${item?.title ?? choice.item}: ${option?.label ?? choice.option}.${choice.clause ? ` ${option?.needs?.clause?.label ? `${option.needs.clause.label}:` : 'Carried by'} ${choice.clause}.` : ''}${articles ? ` ${articles}.` : ''}${choice.expires ? ` Until ${choice.expires}.` : ''}${choice.cause ? ` What stops the tests: ${choice.cause.replace(/\.+$/u, '')}.` : ''}${choice.reason ? ` Reason: ${choice.reason}` : ''}`;
  });
  const left = openRows(packet).filter((item) => item.decidedBy?.allowed && !choices.some((choice) => choice.item === item.id));
  return [...lines, ...(left.length ? ['', `Still undecided: ${left.map((item) => item.title).join('; ')}`] : [])].join('\n');
}

/** Whether every chosen answer only drafts an amendment: a file written, never a record or a decision [SCS:REQ-020]. */
export function draftsOnly(packet: DecisionPacket, choices: readonly DecisionChoice[]): boolean {
  return choices.length > 0 && choices.every((choice) => {
    const effects = decideRows(packet).find((entry) => entry.id === choice.item)?.options.find((entry) => entry.id === choice.option)?.effects ?? [];
    return effects.length > 0 && effects.every((effect) => effect.kind === 'intent-amendment-draft');
  });
}

/** The engine's own draft file a row's step names, from the list as read; null when none does. */
export function draftFileOf(packet: DecisionPacket, itemId: string | null = null): string | null {
  const file = decideRows(packet).filter((item) => !itemId || item.id === itemId).flatMap((item) => item.options).map((option) => option.action?.file).find((entry) => typeof entry === 'string' && entry);
  return file ?? null;
}

/**
 * With SF Guard the card signs with Touch ID itself; where it cannot (an older engine, or a process the CLI will not take a
 * touch from), the signature is taken in the person's own terminal: the one command with nothing to fill in, which asks the
 * same questions there.
 */
export const guardRoute = (workId: string) => `singularity-flow decisions record ${workId}`;
export const GUARD_WORDS = 'SF Guard could not take your Touch ID here, so nothing was written. Put this in a terminal and press Enter: it asks again and shows the card to sign.';

export const DECIDE_STYLE = `
.dc { display:grid; gap:1rem; padding:1rem 0; max-width:80rem; }
.dc h1 { margin:0 0 .25rem; }
.dc-all { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
.dc input, .dc select { padding:.35rem .5rem; box-sizing:border-box; max-width:100%; }
.dc-all input { flex:1 1 18rem; min-width:0; }
.dc-table { overflow-x:auto; }
.dc table { width:100%; border-collapse:collapse; }
.dc th, .dc td { text-align:left; vertical-align:top; padding:.5rem; border-bottom:var(--sf-border); }
.dc td select { width:100%; min-width:12rem; }
.dc-fields input { display:block; width:100%; min-width:12rem; box-sizing:border-box; margin-bottom:.35rem; }
.dc-fields [hidden], .dc-date[hidden], .dc-field[hidden] { display:none; }
.dc-field { display:block; }
.dc-field small { display:block; margin-bottom:.15rem; }
.dc-date { display:block; }
.dc-articles { display:grid; gap:.35rem; margin-bottom:.35rem; }
.dc-articles[hidden] { display:none; }
.dc-article { display:grid; grid-template-columns:minmax(8rem,1fr) minmax(8rem,1fr); gap:.25rem .5rem; align-items:center; }
.dc-article input { grid-column:1 / -1; margin:0; }
.dc-article input[hidden] { display:none; }
.dc-why { font-size:.9em; margin-top:.25rem; overflow-wrap:anywhere; }
.dc-diff pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:16rem; overflow:auto; font-size:.85em; }
.dc-own { display:grid; gap:.3rem; margin-top:.35rem; justify-items:start; }
.dc-own code { overflow-wrap:anywhere; white-space:pre-wrap; }
.dc-link { all:unset; cursor:pointer; color:var(--vscode-textLink-foreground); overflow-wrap:anywhere; font-weight:600; }
.dc-link:hover, .dc-link:focus-visible { text-decoration:underline; }
.dc footer { display:flex; gap:.5rem; justify-content:flex-end; position:sticky; bottom:0; padding:.5rem 0; background:var(--vscode-editor-background); }
.dc-evidence { display:grid; gap:.75rem; min-width:0; }
.dc-evidence h2 { margin:0; font-size:1.1em; }
.dc-evidence > p { margin:0; }
.dc-ev { border-left:3px solid var(--sf-border-color, var(--vscode-panel-border)); padding:.1rem 0 .1rem .75rem; min-width:0; }
.dc-ev-warn { border-left-color:var(--sf-wait, var(--vscode-editorWarning-foreground)); }
.dc-ev h3 { margin:0 0 .25rem; font-size:1em; }
.dc-ev p { margin:.2rem 0; overflow-wrap:anywhere; }
.dc-ev-list { margin:.25rem 0; padding-left:1.25rem; }
.dc-ev-list li { margin:.15rem 0; overflow-wrap:anywhere; }
.dc-sev { display:inline-block; padding:0 .35rem; border-radius:3px; font-size:.85em; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); }
.dc-hold { display:grid; gap:.3rem; margin:.4rem 0; justify-items:start; min-width:0; }
.dc-hold strong { overflow-wrap:anywhere; }
.dc-check { font-weight:600; }
.dc-asked { font-style:italic; overflow-wrap:anywhere; }
.dc-check-passed { color:var(--sf-ok, var(--vscode-testing-iconPassed)); }
.dc-check-failed { color:var(--sf-bad, var(--vscode-errorForeground)); }
.dc-error { color:var(--vscode-errorForeground); margin:0; }
.dc-rec { margin:.35rem 0 0; font-weight:600; overflow-wrap:anywhere; }
.dc-does { margin:.25rem 0 0; padding-left:1.1rem; font-size:.9em; }
.dc-does li { margin:.1rem 0; overflow-wrap:anywhere; }
.dc-tag { display:inline-block; padding:0 .3rem; border-radius:3px; font-size:.8em; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); }
.dc-settled h2, .dc-approval h2, .dc-opening h2 { margin:0 0 .25rem; font-size:1.05em; }
.dc-opening { border-left:3px solid var(--sf-border-color, var(--vscode-panel-border)); padding:.1rem 0 .1rem .75rem; display:grid; gap:.4rem; }
.dc-opening p { margin:0; overflow-wrap:anywhere; }
.dc-answers { display:flex; flex-wrap:wrap; gap:.5rem; }
.dc-approval { border-left:3px solid var(--sf-border-color, var(--vscode-panel-border)); padding:.1rem 0 .1rem .75rem; }
.dc-notice { margin:0; }
.dc-later { margin:0; overflow-wrap:anywhere; }
.dc-detail summary { cursor:pointer; font-size:.9em; }
`;

export const DECIDE_SCRIPT = `
const vscode = window.__sfVscode;
const rows = () => [...document.querySelectorAll('tr[data-item]')];
const field = (row, name) => row.querySelector('[data-field="' + name + '"]');
const sync = (row) => {
  const choice = row.querySelector('[data-choice]');
  if (!choice) return;
  const needs = (choice.selectedOptions[0]?.dataset.needs ?? '').split(' ');
  for (const name of ['reason', 'cause', 'expires', 'clause', 'article']) {
    const input = field(row, name);
    if (!input) continue;
    (input.closest('.dc-date, .dc-field') ?? input).hidden = !needs.includes(name);
  }
  for (const pick of row.querySelectorAll('[data-article]')) {
    const why = row.querySelector('[data-article-reason="' + pick.dataset.article + '"]');
    if (why) why.hidden = !pick.value || pick.value === 'satisfied';
  }
};
const value = (row, name) => field(row, name)?.value ?? '';
const answers = () => rows().map((row) => ({ item: row.dataset.item, title: row.dataset.title, option: row.querySelector('[data-choice]')?.value ?? '',
  reason: value(row, 'reason'), cause: value(row, 'cause'), expires: value(row, 'expires'), clause: value(row, 'clause'),
  article: [...row.querySelectorAll('[data-article]')].map((pick) => ({ article: pick.dataset.article, decision: pick.value,
    reason: row.querySelector('[data-article-reason="' + pick.dataset.article + '"]')?.value ?? '' })) }));
rows().forEach(sync);
document.addEventListener('change', (event) => { const row = event.target.closest('tr[data-item]'); if (row) sync(row); });
document.addEventListener('click', (event) => {
  const open = event.target.closest('[data-open]');
  if (open) return vscode.postMessage({ type: 'decide.open', path: open.dataset.open });
  // A held package's own command, by its place in the evidence: the extension reads the command from the list itself.
  const held = event.target.closest('[data-hold-terminal],[data-hold-copy],[data-hold-run]');
  // The reason and date typed beside a step go with it, so the terminal gets the whole command.
  const typed = (key) => ({ reason: document.querySelector('[data-own-reason="' + key + '"]')?.value ?? '', expires: document.querySelector('[data-own-expires="' + key + '"]')?.value ?? '' });
  if (held) {
    const index = held.dataset.holdRun ?? held.dataset.holdTerminal ?? held.dataset.holdCopy;
    return vscode.postMessage({ type: held.dataset.holdRun !== undefined ? 'decide.run' : held.dataset.holdTerminal !== undefined ? 'decide.terminal' : 'decide.copy', hold: index,
      ...typed('hold-' + index) });
  }
  const drafted = event.target.closest('[data-draft]');
  if (drafted) return vscode.postMessage({ type: 'decide.draft', item: drafted.closest('tr[data-item]').dataset.item, option: drafted.dataset.draft });
  if (event.target.closest('[data-preview-apply]')) return vscode.postMessage({ type: 'decide.preview-apply', reason: document.querySelector('[data-preview-reason]')?.value ?? '' });
  if (event.target.closest('[data-preview-cancel]')) return vscode.postMessage({ type: 'decide.preview-cancel' });
  const previewed = event.target.closest('[data-preview]');
  if (previewed) return vscode.postMessage({ type: 'decide.preview', item: previewed.closest('tr[data-item]').dataset.item, option: previewed.dataset.preview,
    url: previewed.closest('tr[data-item]').querySelector('[data-own-url="' + previewed.dataset.preview + '"]')?.value ?? '' });
  const step = event.target.closest('[data-run],[data-terminal],[data-copy],[data-witness]');
  if (step) {
    const row = step.closest('tr[data-item]');
    const type = step.dataset.run ? 'decide.run' : step.dataset.terminal ? 'decide.terminal' : step.dataset.copy ? 'decide.copy' : 'decide.witness';
    const id = step.dataset.run ?? step.dataset.terminal ?? step.dataset.copy ?? step.dataset.witness;
    const own = row.querySelector('[data-own-reason="' + id + '"],[data-own-expires="' + id + '"]') ? { reason: row.querySelector('[data-own-reason="' + id + '"]')?.value ?? '',
      expires: row.querySelector('[data-own-expires="' + id + '"]')?.value ?? '' } : {};
    return vscode.postMessage({ type, item: row.dataset.item, option: id, rows: answers(), ...own });
  }
  if (event.target.closest('[data-route]')) return vscode.postMessage({ type: 'decide.route' });
  // A waiting next version: the answer with the digest of the proposal this page showed.
  const version = event.target.closest('[data-version]');
  if (version) return vscode.postMessage({ type: 'decide.version', answer: version.dataset.version, digest: version.dataset.digest });
  if (event.target.closest('[data-next]')) return vscode.postMessage({ type: 'decide.next' });
  const check = event.target.closest('[data-check]');
  if (check) return vscode.postMessage({ type: 'decide.check', item: check.dataset.check, rows: answers() });
  if (event.target.closest('[data-approval]')) return vscode.postMessage({ type: 'decide.approval' });
  const share = event.target.closest('[data-share]');
  if (share) return vscode.postMessage({ type: 'decide.share', row: share.dataset.share });
  if (event.target.closest('[data-cancel]')) return vscode.postMessage({ type: 'decide.cancel' });
  if (event.target.closest('[data-apply-all]')) {
    const chosen = document.getElementById('dc-all-choice');
    const reason = document.getElementById('dc-all-reason');
    if (!chosen.value) return chosen.focus();
    if (!reason.value.trim()) return reason.focus();
    for (const row of rows()) {
      const choice = row.querySelector('[data-choice]');
      // A row decided one by one keeps its own answer and reason.
      if (!choice || ![...choice.options].some((entry) => entry.value === chosen.value && !entry.dataset.one)) continue;
      choice.value = chosen.value;
      if (field(row, 'reason')) field(row, 'reason').value = reason.value.trim();
      sync(row);
    }
    return;
  }
  if (event.target.closest('[data-review]')) vscode.postMessage({ type: 'decide.review', rows: answers() });
});
`;

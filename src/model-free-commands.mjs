/** Closed command crosswalk and shared display layout. These routes grant no execution authority. */
import { createRequire } from 'node:module';
import { PACKAGE_ROOT } from './package-root.mjs';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function parseModelFreeTarget(text = '') {
  const tokens = String(text).trim().split(/\s+/u).filter(Boolean);
  let phase = null;
  let workId = null;
  if (tokens[0] && !tokens[0].startsWith('--')) phase = tokens.shift();
  if (tokens.length === 2 && tokens[0] === '--work-id') workId = tokens[1];
  else if (tokens.length) throw new Error('Use an optional phase and --work-id <Story-ID>; arbitrary flags and prose are not accepted.');
  if ((phase && !ID.test(phase)) || (workId && !ID.test(workId))) {
    throw new Error('Phase and Story selectors must be literal identifiers.');
  }
  return { phase, workId };
}

/** A decision's VS Code route is the Decide card, never "not available" [owner, 2026-11-13]. */
export const VSCODE_DECIDE_CARD = 'Command Palette: Singularity Flow: Decide Everything This Step Waits On';
/**
 * The Decide card in VS Code's own chat, which has no /decide (Copilot CLI's): its tool, given the Story ID. A person types
 * it as a chat message; an agent calls the tool with workId only [hardening C, F3].
 */
export const vscodeDecideCardChat = (workId) => `#sflowDecide ${workId}`;
/** Where a person selects a Story in this VS Code window: the Stories page, whose Attach shows it here [hardening C, F4]. */
export const VSCODE_SELECT_STORY = 'Command Palette: Singularity Flow: Stories';
const decideCard = (t) => t[0] === 'decisions' && /^(?: --work-id)? [A-Za-z0-9][\w.-]*$|^$/u.test(t.slice(t[1] === 'record' ? 2 : 1)
  .filter((v) => !['--fetch', '--for-agent'].includes(v)).map((v) => ` ${v}`).join(''));

/**
 * A person's own step the Decide card records or opens [owner, 2026-11-13 and 2026-11-15]: an amendment's decision or
 * acknowledgement, a settled one's undo, an accepted risk, test-run risk or test command, a sign-off and its screenshot (2026-11-18),
 * keeping or accepting what a refactor changed [ITW:REQ-015]. Its Copilot route is the card, which /sf-decide opens; no turn runs the command, which stays the person's.
 */
export const decideCardStep = ([top, sub, verb, ...rest] = []) => (top === 'story' && sub === 'intent-amendment' && ['decide', 'acknowledge'].includes(verb))
  || (top === 'decisions' && sub === 'undo') || (top === 'work' && sub === 'behaviour' && ['keep', 'accept'].includes(verb)) || (top === 'decision' && ![verb, ...rest].includes('--revoke')
    && (['risk', 'test-risk', 'test-narrowing', 'evidence-reuse', 'visual-profile', 'witness', 'screenshot'].includes(sub) || (sub === 'test-command' && [verb, ...rest].includes('--accept'))));
/** Its Copilot route: /sf-decide with the Story it names. */
export function decideCardCopilotCommand(argv) {
  const named = argv.includes('--work-id') ? argv[argv.indexOf('--work-id') + 1] : ['decision', 'decisions'].includes(argv[0]) ? argv[2] : null;
  return `/sf-decide${ID.test(named ?? '') ? ` ${named}` : ''}`;
}
// What the card records with no model, as decision-list.mjs EFFECT_ORDER (paid run, 2026-11-14); a revocation is not on
// the card. A plan's row correction is, kept there with its exact rows shown [owner, 2026-11-19].
const cardRecords = (t) => decideCardStep(t) || (t[0] === 'upstream-issue' && ['decide', 'revalidate'].includes(t[1]))
  || (t[0] === 'story' && t[1] === 'adjudicate' && /^[A-Za-z]/u.test(t[2] ?? '') && !t.includes('--answers'))
  || (t[0] === 'decision' && ['choose', 'applicability', 'scope', 'completeness', 'plan', 'departure'].includes(t[1]));
/** A sign-off's VS Code route: the review page that shows the evidence and records it. */
export const VSCODE_WITNESS_REVIEW = 'Command Palette: Singularity Flow: Review Story Evidence and Sign Off';

// Lazy, as config.mjs's commit policy [audit 2026-11-19, entry 4]
let screens;
const screenFor = (t) => (process.features?.require_module
  ? (screens ??= createRequire(`${PACKAGE_ROOT}/package.json`)(`${PACKAGE_ROOT}/src/model-free-screens.mjs`)).vscodeScreenForArgv(t) : null);

export function modelFreeCommandForArgv(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) return null;
  const tokens = argv.filter((value) => value !== '--json');
  if (tokens[0] === 'decision' && tokens[1] === 'witness') return VSCODE_WITNESS_REVIEW;
  if (decideCard(tokens) || cardRecords(tokens)) return VSCODE_DECIDE_CARD;
  if (screenFor(tokens)) return screenFor(tokens);
  const [top, operation] = tokens;
  const exact = (expected) => tokens.length === expected.length && tokens.every((value, i) => value === expected[i]);
  for (const [route, expected] of [
    ['next', ['nextsteps']], ['status', ['status']], ['checks', ['precheck', '--quick']],
    ['check', ['check']], ['git-policy', ['git-policy', 'show']],
    ['docs', ['documents', 'list', '--active']], ['workflows', ['workflow', 'list']],
    ['validate', ['validate']], ['converge', ['converge']], ['instructions', ['instruction', 'list']]
  ]) if (exact(expected)) return `@sflow /${route}`;
  if (top === 'inputs' && tokens.length === 3 && ID.test(operation ?? '') && tokens[2] === '--dry-run') {
    // The participant resolves the phase itself; don't claim a different explicit phase is equivalent.
    return null;
  }
  const route = top === 'submit' || top === 'approve' ? top
    : top === 'phase' && operation === 'publish' ? 'publish' : null;
  if (!route) return null;
  const rest = tokens.slice(route === 'publish' ? 2 : 1).filter((value) => value !== '--fetch' && value !== '--no-model');
  if (route === 'publish') {
    // The phase contract, not chat arguments, chooses provenance. Recognise only ordinary published-draft routes.
    const authored = rest.indexOf('--authored');
    const channel = rest.indexOf('--channel');
    if (channel >= 0 && (authored < 0 || rest[channel + 1] !== ({
      'governed-agent': 'copilot-host', deterministic: 'kernel-generator'
    })[rest[authored + 1]])) return null;
    for (const [flag, allowed] of [['--authored', ['governed-agent', 'deterministic']], ['--channel', ['copilot-host', 'kernel-generator']]]) {
      const index = rest.indexOf(flag);
      if (index >= 0) {
        if (!allowed.includes(rest[index + 1])) return null;
        rest.splice(index, 2);
      }
    }
  }
  try {
    const target = parseModelFreeTarget(rest.join(' '));
    return `@sflow /${route}${target.phase ? ` ${target.phase}` : ''}${target.workId ? ` --work-id ${target.workId}` : ''}`;
  } catch { return null; }
}

export function modelFreeCommandForCommand(command) {
  // Strict literal grammar here. The shared safe-command boundary handles quoted argv separately. The card's routes name
  // no argument, so a quoted reason does not hide them.
  if (typeof command !== 'string' || !/^(?:singularity-flow|sflow)\s/u.test(command)) return null;
  const argv = command.trim().split(/\s+/u).slice(1);
  if (/^(?:singularity-flow|sflow)\s+[A-Za-z0-9._ -]+$/u.test(command)) return modelFreeCommandForArgv(argv);
  return argv[0] === 'decision' && argv[1] === 'witness' ? VSCODE_WITNESS_REVIEW : cardRecords(argv) ? VSCODE_DECIDE_CARD
    : screenFor(argv);
}

/** Layout only: callers still validate untrusted routes and retain their existing execution gates. */
// One plain next line [owner, 2026-11-28]. Every turn SFlow's note does not carry on ends with the one thing to type,
// /sf-next: in a host that runs no SFlow hook (IntelliJ Copilot's local agent) no note ever comes, so there that is every
// turn's last line and the person types /sf-next between steps. That is the limit there: SFlow cannot carry such a turn on.
export const COMMAND_PRESENTATION_CONTRACT = 'Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow\'s note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). Every turn that no SFlow note carries on ends with "/sf-next carries it on" (or press Continue).';

export function commandRouteRows(guidance = {}) {
  guidance ??= {};
  // A confirmation a person types by its short code reads the same in their terminal: the code, never the digest (confirm-code.mjs).
  const code = typeof guidance.copilotCommand === 'string' ? guidance.copilotCommand.match(/^\/sf-confirm ([0-9A-Z]{4}-[0-9A-Z]{4})$/u)?.[1] : null;
  return [
    { label: /^\/decide /u.test(guidance.copilotCommand) ? 'Copilot CLI' : 'Copilot', command: guidance.copilotCommand, unavailable: 'no verified equivalent' },
    { label: 'Shell', command: code && guidance.command ? `singularity-flow confirm ${code}` : guidance.command, unavailable: 'not available for this action' },
    // A decisions route given without its model-free field still names the Decide card.
    { label: 'VS Code (model-free)', command: guidance.modelFreeCommand ?? (modelFreeCommandForCommand(guidance.command) === VSCODE_DECIDE_CARD ? VSCODE_DECIDE_CARD : null),
      unavailable: 'not available for this action' }
  ];
}

/** Choose a Markdown code span that preserves literal backticks in quoted command arguments. */
export function commandInlineCode(value) {
  const text = String(value);
  const length = (text.match(/`+/gu) ?? []).reduce((maximum, run) => Math.max(maximum, run.length), 0) + 1;
  const fence = '`'.repeat(length);
  const padding = text.startsWith('`') || text.endsWith('`') || text.startsWith(' ') && text.endsWith(' ') ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

export function formatCommandRouteLines(guidance, { indent = '', markdown = false, modelFreeNote = '' } = {}) {
  return commandRouteRows(guidance).map(({ label, command, unavailable }, index) => {
    const value = command ? markdown ? commandInlineCode(command) : command : unavailable;
    const note = index === 2 && command && modelFreeNote ? ` ${modelFreeNote}` : '';
    return `${indent}- ${label}: ${value}${note}`;
  });
}

/** Apply at delivery, without rewriting pinned skill, agent, instruction or artifact bytes. */
export function withCommandPresentationProtocol(text) {
  return text.includes(COMMAND_PRESENTATION_CONTRACT) ? text : `# Runtime command presentation\n\n${COMMAND_PRESENTATION_CONTRACT}\n\n${text}`;
}

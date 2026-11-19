/** Closed command crosswalk and shared display layout. These routes grant no execution authority. */
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
const decideCard = (t) => t[0] === 'decisions' && /^(?: --work-id)? [A-Za-z0-9][\w.-]*$|^$/u.test(t.slice(t[1] === 'record' ? 2 : 1)
  .filter((v) => !['--fetch', '--for-agent'].includes(v)).map((v) => ` ${v}`).join(''));

/**
 * A person's own step the Decide card records or opens [owner, 2026-11-13 and 2026-11-15]: an amendment's decision or
 * acknowledgement, a settled one's undo, an accepted risk, test-run risk or test command, a sign-off and its screenshot (2026-11-18). Its Copilot route is the card, which /sf-decide opens; no turn runs the command, which stays the person's.
 */
export const decideCardStep = ([top, sub, verb, ...rest] = []) => (top === 'story' && sub === 'intent-amendment' && ['decide', 'acknowledge'].includes(verb))
  || (top === 'decisions' && sub === 'undo') || (top === 'decision' && ![verb, ...rest].includes('--revoke')
    && (['risk', 'test-risk', 'test-narrowing', 'evidence-reuse', 'visual-profile', 'witness', 'screenshot'].includes(sub) || (sub === 'test-command' && [verb, ...rest].includes('--accept'))));
/** Its Copilot route: /sf-decide with the Story it names. */
export function decideCardCopilotCommand(argv) {
  const named = argv.includes('--work-id') ? argv[argv.indexOf('--work-id') + 1] : ['decision', 'decisions'].includes(argv[0]) ? argv[2] : null;
  return `/sf-decide${ID.test(named ?? '') ? ` ${named}` : ''}`;
}
// What the card records with no model, as decision-list.mjs EFFECT_ORDER (paid run, 2026-11-14); a plan's row
// correction is a live terminal review, and a revocation is not on the card.
const cardRecords = (t) => decideCardStep(t) || (t[0] === 'upstream-issue' && ['decide', 'revalidate'].includes(t[1]))
  || (t[0] === 'story' && t[1] === 'adjudicate' && /^[A-Za-z]/u.test(t[2] ?? '') && !t.includes('--answers'))
  || (t[0] === 'decision' && ['choose', 'applicability', 'scope', 'completeness', 'plan', 'departure'].includes(t[1])
    && !t.some((v) => /^--(?:add-row|remove-row|set-fulfillment|(?:add|remove|replace)-test|(?:remove|replace)-location)\b/u.test(v)));
/** A sign-off's VS Code route: the review page that shows the evidence and records it. */
export const VSCODE_WITNESS_REVIEW = 'Command Palette: Singularity Flow: Review Story Evidence and Sign Off';

/**
 * The VS Code screens that finish a person's own command with no chat model [audit 2026-11-19, entry 4]. Each opens on
 * the Story this window works on, as the Decide card does, and asks for the rest itself (the step, the reason, the
 * workspace); apps/vscode/package.json names each title. A command maps here only when its screen runs that command.
 */
const palette = (title) => `Command Palette: Singularity Flow: ${title}`;
export const VSCODE_SCREENS = Object.freeze({
  // Approvals' "Request changes…" runs `reject <W> --phase <P> --to <T> --reason …` (extension.ts onApprovalsMessage).
  reject: palette('Approvals, then Request changes…'),
  reopen: palette('Request Changes to a Closed Story'),
  cancel: palette('Cancel and Archive Story'),
  start: palette('Start Work'),
  sessionWorkspace: palette('Attach Copilot Session to Workspace'),
  workspaceUse: palette('Work in This Workspace'),
  configuration: palette('Configuration Approvals'),
  testPolicy: palette('Review Story Test Policy and Recovery'),
  appeal: palette('Resolve Phase Issues and Appeals')
});
// What each screen runs: Start Work's form (intake-form.ts), the test recovery choices (story-test-recovery.ts and
// story-test-risk.ts) and the phase issues page (extension.ts resolvePhaseIssues). Anything else keeps no screen.
const START_FLAGS = new Set(['--from-branch', '--title', '--description', '--acceptance-criteria', '--jira', '--github', '--work-type',
  '--fetch', '--spec', '--capability', '--isolated-worktree', '--document', '--document-name', '--document-phases', '--document-store',
  '--reference-repository', '--reference-branch']);
const TEST_POLICY_VERBS = new Set(['show', 'amend', 'attest', 'risks', 'accept-risk', 'revoke-risk', 'attest-risk']);
const APPEAL_VERBS = new Set(['preflight', 'resolve', 'resolve-resume', 'resolve-run', 'checkpoint', 'risk-prepare', 'risk-accept',
  'repair-plan', 'repair-run', 'repair-resume', 'list', 'show', 'attest', 'decide']);
const flags = (tokens) => tokens.filter((value) => value.startsWith('--'));
export function vscodeScreenForArgv(tokens) {
  const [top, sub] = tokens;
  const without = (...names) => !tokens.some((value) => names.includes(value));
  if (top === 'reject') return without('--clause', '--repair', '--yes') ? VSCODE_SCREENS.reject : null;
  if (top === 'reopen') return VSCODE_SCREENS.reopen;
  if (top === 'cancel') return without('--release') ? VSCODE_SCREENS.cancel : null;
  if (top === 'start') return sub && !sub.startsWith('--') && flags(tokens).every((flag) => START_FLAGS.has(flag)) ? VSCODE_SCREENS.start : null;
  if (top === 'session' && sub === 'workspace') return without('--story', '--repository') ? VSCODE_SCREENS.sessionWorkspace : null;
  if (top === 'workspace' && sub === 'use') return without('--story', '--repository') ? VSCODE_SCREENS.workspaceUse : null;
  if (top === 'configuration' && ['approve', 'reject'].includes(sub)) return without('--pick', '--lead') ? VSCODE_SCREENS.configuration : null;
  if (top === 'story' && sub === 'test-policy') return TEST_POLICY_VERBS.has(tokens[2]) ? VSCODE_SCREENS.testPolicy : null;
  if (top === 'appeal') return APPEAL_VERBS.has(sub) && without('--evidence-file', '--clause', '--transition') ? VSCODE_SCREENS.appeal : null;
  return null;
}

export function modelFreeCommandForArgv(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) return null;
  const tokens = argv.filter((value) => value !== '--json');
  if (tokens[0] === 'decision' && tokens[1] === 'witness') return VSCODE_WITNESS_REVIEW;
  if (decideCard(tokens) || cardRecords(tokens)) return VSCODE_DECIDE_CARD;
  const screen = vscodeScreenForArgv(tokens);
  if (screen) return screen;
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
  // A screen asks for the reason itself, so a quoted one does not hide it either.
  return argv[0] === 'decision' && argv[1] === 'witness' ? VSCODE_WITNESS_REVIEW : cardRecords(argv) ? VSCODE_DECIDE_CARD
    : vscodeScreenForArgv(argv.filter((value) => value !== '--json'));
}

/** Layout only: callers still validate untrusted routes and retain their existing execution gates. */
export const COMMAND_PRESENTATION_CONTRACT = 'Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.';

export function commandRouteRows(guidance = {}) {
  guidance ??= {};
  // A confirmation a person types by its short code reads the same in their terminal: the code, never the digest (confirm-code.mjs).
  const code = typeof guidance.copilotCommand === 'string' ? guidance.copilotCommand.match(/^\/sf-confirm ([0-9A-Z]{4}-[0-9A-Z]{4})$/u)?.[1] : null;
  return [
    { label: 'Copilot', command: guidance.copilotCommand, unavailable: 'no verified equivalent' },
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

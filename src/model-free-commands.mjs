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

export function modelFreeCommandForArgv(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) return null;
  const tokens = argv.filter((value) => value !== '--json');
  if (decideCard(tokens)) return VSCODE_DECIDE_CARD;
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
  // Strict literal grammar here. The shared safe-command boundary handles quoted argv separately.
  if (typeof command !== 'string' || !/^(?:singularity-flow|sflow)\s+[A-Za-z0-9._ -]+$/u.test(command)) return null;
  return modelFreeCommandForArgv(command.trim().split(/\s+/u).slice(1));
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

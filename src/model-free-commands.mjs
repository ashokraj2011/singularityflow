/** Closed presentation crosswalk. These are explicit VS Code routes, never shell relays. */
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

export function modelFreeCommandForArgv(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) return null;
  const tokens = argv.filter((value) => value !== '--json');
  const [top, operation] = tokens;
  const exact = (expected) => tokens.length === expected.length && tokens.every((value, i) => value === expected[i]);
  for (const [route, expected] of [
    ['next', ['nextsteps']], ['status', ['status']], ['checks', ['precheck', '--quick']],
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

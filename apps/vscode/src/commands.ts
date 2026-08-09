/**
 * Reading the engine's suggested commands, including the ones a person is meant to finish.
 *
 * `initiative next` returns commands as strings, and some of them carry placeholders — the sources
 * step suggests `epic sources add --epic SF-E-001 --file <PATH>`, where `<PATH>` is an instruction to
 * a human, not an argument. Splitting on whitespace and running the result passes the literal string
 * `<PATH>` to the CLI, which then fails on a file of that name. So a command has to be inspected
 * before it is offered, and a placeholder has to become a prompt.
 *
 * No `vscode` import: what a placeholder *is* is decided here and tested here; how it is asked for
 * belongs to actions.ts.
 */

export interface Placeholder {
  /** Where it sits in argv, so the answer replaces the right token. */
  index: number;
  /** The placeholder's own text, e.g. "PATH". */
  name: string;
  /** The flag it follows, when it follows one — this is what says a path is wanted. */
  flag: string | null;
  kind: 'file' | 'text';
}

/** Flags whose value is a filesystem path, and so deserve a file picker rather than a text box. */
const FILE_FLAGS = new Set(['--file', '--path', '--out', '--plan-file', '--usage-json']);

/**
 * Strip the binary name and parse a suggested command into argv without invoking a shell.
 *
 * Engine suggestions may quote placeholder values such as `"<WHAT WAS REVIEWED>"`. A whitespace
 * split turns that into three arguments and makes the editor prompt for the wrong value. This small
 * tokenizer supports the quoting and escaping the engine emits while deliberately doing no shell
 * expansion, command substitution, or environment interpolation.
 */
export function commandArgv(command: string): string[] {
  const source = String(command ?? '').trim().replace(/^singularity-flow\s+/, '');
  const argv: string[] = [];
  let token = '', quote: '"' | "'" | null = null, escaped = false, started = false;
  const finish = () => {
    if (!started) return;
    argv.push(token); token = ''; started = false;
  };
  for (const character of source) {
    if (escaped) { token += character; started = true; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/.test(character)) { finish(); continue; }
    token += character; started = true;
  }
  if (escaped) token += '\\';
  if (quote) throw new Error(`Suggested command contains an unterminated ${quote} quote.`);
  finish();
  return argv;
}

/**
 * The placeholders in an argv, in order.
 *
 * Only `<NAME>` is treated as a placeholder. Bracketed forms the engine uses for optionality —
 * `[PHASE]` — are not: those mean "you may omit this", and the command runs correctly without them.
 */
export function commandPlaceholders(argv: string[]): Placeholder[] {
  const found: Placeholder[] = [];
  argv.forEach((argument, index) => {
    const match = /^<(.+)>$/.exec(argument);
    if (!match?.[1]) return;
    const previous = index > 0 ? argv[index - 1] ?? null : null;
    const flag = previous && previous.startsWith('--') ? previous : null;
    found.push({
      index,
      name: match[1],
      flag,
      kind: (flag && FILE_FLAGS.has(flag)) || /PATH|FILE/i.test(match[1]) ? 'file' : 'text'
    });
  });
  return found;
}

/** Substitute answers back into argv, positionally. */
export function fillPlaceholders(argv: string[], answers: Map<number, string>): string[] {
  return argv.map((argument, index) => answers.get(index) ?? argument);
}

/** A human-readable prompt for a placeholder, using the flag it belongs to where there is one. */
export function placeholderPrompt(placeholder: Placeholder): string {
  const label = placeholder.name.toLowerCase().replace(/_/g, ' ');
  return placeholder.flag
    ? `Value for ${placeholder.flag} (${label})`
    : `Value for ${label}`;
}

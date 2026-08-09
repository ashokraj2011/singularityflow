/**
 * Terminal styling.
 *
 * The tool had no colour anywhere: 962 `console.log` calls in one file, every line the same weight,
 * so a commit SHA, a refusal and a section heading all looked identical and the reader had to
 * re-derive the structure on every screen. This adds the smallest amount of emphasis that makes
 * output scannable — and nothing beyond it.
 *
 * Three rules hold this honest:
 *
 *   1. No dependency. Styling a terminal is a lookup table, not a supply-chain decision, and a
 *      governance tool should not grow one for it.
 *   2. Off unless stdout is a TTY, and off under NO_COLOR. Piped, redirected and captured output is
 *      byte-identical to what it was before this file existed — which is what keeps the VS Code
 *      adapter, the --json transports and every existing test unaffected.
 *   3. Colour is never the only signal. Each helper pairs with a word or a glyph, so the meaning
 *      survives a monochrome terminal, a screen reader, and a copy-paste into a bug report.
 */

const CODES = Object.freeze({
  reset: 0, bold: 1, dim: 2, italic: 3, underline: 4,
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90
});

/**
 * Decide once whether this process should emit escape codes.
 *
 * NO_COLOR wins over everything (https://no-color.org). FORCE_COLOR exists so tests and CI can
 * assert the styled form without attaching a pseudo-terminal.
 */
export function colorEnabled(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  if (env.SINGULARITY_FLOW_NO_COLOR === '1') return false;
  return Boolean(stream?.isTTY);
}

let enabled = null;

// Resolved lazily so environment changes made by a test or a wrapper are honoured, then cached so a
// thousand log lines do not each re-read the environment.
function active() {
  if (enabled === null) enabled = colorEnabled();
  return enabled;
}

// Test seam. Passing null restores environment-derived behaviour.
export function setColorEnabled(value) {
  enabled = value === null ? null : Boolean(value);
}

function wrap(code, text) {
  const value = String(text ?? '');
  if (!active() || !value) return value;
  return `\x1b[${code}m${value}\x1b[${CODES.reset}m`;
}

export const bold = (text) => wrap(CODES.bold, text);
export const dim = (text) => wrap(CODES.dim, text);
export const underline = (text) => wrap(CODES.underline, text);
export const red = (text) => wrap(CODES.red, text);
export const green = (text) => wrap(CODES.green, text);
export const yellow = (text) => wrap(CODES.yellow, text);
export const cyan = (text) => wrap(CODES.cyan, text);
export const gray = (text) => wrap(CODES.gray, text);

/**
 * The four things worth emphasising, and nothing else.
 *
 * Deliberately a closed set. An open palette is how a CLI ends up with nine shades of blue meaning
 * nine different things, none of them learnable.
 */

// A section heading. Bold rather than coloured, so it reads as structure and not as status.
export const heading = (text) => bold(String(text));

// The headline of a refusal. Paired with the word so the meaning survives without colour.
export const failure = (text) => red(bold(String(text)));

// A passing check. The glyph carries the meaning; the colour only makes it findable.
export const pass = (text = '✓') => green(String(text));

// A failing check, at the same visual weight as a passing one — they were previously identical.
export const fail = (text = '✗') => red(String(text));

// Something in progress or awaiting a person.
export const pending = (text = '○') => yellow(String(text));

// The next action. This is the single most-looked-for line in any output, and it had no emphasis.
export const action = (text) => cyan(String(text));

// Supporting detail: paths, hashes, counts, timings. Present but out of the way.
export const detail = (text) => dim(String(text));

/**
 * The glyph for a check outcome.
 *
 * Three places rendered this inline and picked a different warning glyph each time — `~`, `!`, `~`.
 * One vocabulary, one place, and the pass and fail marks are no longer the same visual weight.
 */
export function mark(status) {
  const value = String(status ?? '').toLowerCase();
  if (['pass', 'passed', 'ok', 'healthy'].includes(value)) return pass('✓');
  if (['warn', 'warning'].includes(value)) return pending('~');
  return fail('✗');
}

/**
 * The separator between fields on one line.
 *
 * Output used ` · ` 138 times, ` → ` 27, ` | ` 12, and raw tabs elsewhere — four glyphs for one
 * meaning. This is the one, and `SEPARATOR_ARROW` stays available for the genuinely directional
 * case (a transition from one state to another), which is a different meaning and not a synonym.
 */
export const SEPARATOR = ' · ';
export const SEPARATOR_ARROW = ' → ';

// Join fields for a single status line, dropping anything absent so no output ever reads "· ·".
export function fields(...parts) {
  return parts.filter((part) => part !== null && part !== undefined && part !== '').join(SEPARATOR);
}

/**
 * Printable width of a string.
 *
 * Escape codes occupy no columns, and East Asian characters occupy two. `String.length` got both
 * wrong, which is why one long title or a single CJK cell wrapped a table into rubble.
 */
export function displayWidth(text) {
  const plain = String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  let width = 0;
  for (const character of plain) {
    const point = character.codePointAt(0);
    // Combining marks add nothing; wide and fullwidth ranges take two columns.
    if (point >= 0x0300 && point <= 0x036F) continue;
    width += (point >= 0x1100 && (
      point <= 0x115F
      || (point >= 0x2E80 && point <= 0xA4CF && point !== 0x303F)
      || (point >= 0xAC00 && point <= 0xD7A3)
      || (point >= 0xF900 && point <= 0xFAFF)
      || (point >= 0xFE30 && point <= 0xFE6F)
      || (point >= 0xFF00 && point <= 0xFF60)
      || (point >= 0xFFE0 && point <= 0xFFE6)
      || (point >= 0x1F300 && point <= 0x1F64F)
      || (point >= 0x20000 && point <= 0x3FFFD)
    )) ? 2 : 1;
  }
  return width;
}

/**
 * Truncate to a printable width, marking the cut so a shortened value is never mistaken for a
 * complete one. Never returns something wider than `width`.
 *
 * Distinct from `truncate` in util.mjs, which bounds a captured stdout by character count for the
 * activity log. This one is about fitting a terminal column; that one is about bounding a record.
 */
export function truncateDisplay(text, width) {
  const value = String(text ?? '');
  if (width <= 0) return '';
  if (displayWidth(value) <= width) return value;
  if (width === 1) return '…';
  let out = '';
  for (const character of value.replace(/\x1b\[[0-9;]*m/g, '')) {
    if (displayWidth(out + character) > width - 1) break;
    out += character;
  }
  return `${out}…`;
}

// Pad to a printable width. `padEnd` counts code units, so it under-pads anything styled or wide.
export function padDisplay(text, width) {
  const value = String(text ?? '');
  const deficit = width - displayWidth(value);
  return deficit > 0 ? value + ' '.repeat(deficit) : value;
}

// How wide the terminal is, with a conservative default for pipes and CI.
export function terminalWidth(stream = process.stdout, fallback = 100) {
  const columns = Number(stream?.columns);
  return Number.isFinite(columns) && columns >= 40 ? columns : fallback;
}

function humanDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * Announce a long operation and keep saying it is alive.
 *
 * `wm build` allows twenty minutes and captures the provider's output, so the product's most
 * impressive feature printed nothing at all while it ran: silence meant success and output meant
 * trouble, backwards from every other command. Returns a function to call when the work finishes.
 *
 * On a terminal this rewrites one line. Everywhere else — a pipe, CI, the VS Code adapter — it emits
 * a start line and a finish line and nothing in between, so no log ends up full of carriage returns.
 * It writes to stderr, never stdout, because stdout may be carrying JSON.
 */
export function heartbeat(label, { stream = process.stderr, intervalMs = 15_000 } = {}) {
  const started = Date.now();
  const interactive = Boolean(stream?.isTTY) && active();
  stream.write(`${label}\n`);
  const timer = interactive
    ? setInterval(() => {
      stream.write(`\r${dim(`  … still working (${humanDuration(Date.now() - started)})`)}\x1b[K`);
    }, intervalMs)
    : null;
  // Never hold the event loop open on account of a progress indicator.
  timer?.unref?.();
  return (outcome = 'done') => {
    if (timer) {
      clearInterval(timer);
      stream.write('\r\x1b[K');
    }
    stream.write(`${dim(`  ${outcome} in ${humanDuration(Date.now() - started)}`)}\n`);
  };
}

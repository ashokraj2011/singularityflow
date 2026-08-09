/**
 * The only place terminal prose for a command result is produced.
 *
 * Handlers return data. This turns it into words. Keeping that boundary is what lets the wording
 * improve, or be translated, without touching a handler — and what stops a future handler printing
 * a reassuring sentence that its own effects contradict.
 */
import { MESSAGES, REASONS } from './messages.mjs';
import { preservedEverything } from './command-result.mjs';

/**
 * The reassurance line, derived from declared effects rather than authored.
 *
 * `preserves` in the catalog only marks a message as *allowed* to reassure; what it says is
 * computed here from what the command reports it changed. A message can never promise more than
 * the effects support.
 */
function preservationLine(result) {
  if (!preservedEverything(result)) return null;
  const message = MESSAGES[result.outcome.messageId];
  if (!message?.preserves) return null;
  return 'No governed state, files, publications or external systems were changed.';
}

function headline(result) {
  const message = MESSAGES[result.outcome.messageId];
  if (!message) return result.outcome.messageId;
  return message.headline(result.outcome.slots ?? {});
}

function whyLines(result) {
  return result.why
    .map((entry) => {
      const reason = REASONS[entry.code];
      const text = reason ? reason.render(entry.slots ?? {}) : entry.code;
      // The friendly reason carries its provenance. A citation a reviewer cannot resolve is a
      // claim, not evidence, so the immutable reference stays visible beside the readable line.
      return entry.ref ? `  - ${text}\n      ↳ ${entry.source}:${entry.ref}` : `  - ${text}`;
    });
}

function nextLines(result) {
  const order = { NOW: 0, SOON: 1, LATER: 2 };
  return [...result.next]
    .sort((a, b) => (order[a.rank] - order[b.rank]) || a.id.localeCompare(b.id))
    .map((entry) => `  ${entry.rank.padEnd(5)} ${entry.label}\n        ${entry.command}`);
}

const REST_STATE_LINES = Object.freeze({
  complete: 'This work is complete. There is nothing further to do.',
  cancelled: 'This work is cancelled and archived.',
  'awaiting-others': 'Nothing to do here — this is waiting on someone else.',
  informational: null
});

export function renderCommandResult(result) {
  const lines = [headline(result)];

  const preservation = preservationLine(result);
  if (preservation) lines.push(preservation);

  const why = whyLines(result);
  if (why.length) lines.push('', 'Why:', ...why);

  const next = nextLines(result);
  if (next.length) lines.push('', 'Next:', ...next);
  else if (result.restState) {
    const rest = REST_STATE_LINES[result.restState];
    if (rest) lines.push('', rest);
  }

  return lines.join('\n');
}

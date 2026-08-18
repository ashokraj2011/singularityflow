/**
 * The only place terminal prose for a command result is produced.
 *
 * Handlers return data. This turns it into words. Keeping that boundary is what lets the wording
 * improve, or be translated, without touching a handler — and what stops a future handler printing
 * a reassuring sentence that its own effects contradict.
 */
import { MESSAGES, REASONS } from './messages.mjs';
import { preservedEverything } from './command-result.mjs';
import { approvalChainText } from '../approval-chain.mjs';
import * as style from '../style.mjs';

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
      const lines = [entry.ref ? `  - ${text}\n      ↳ ${entry.source}:${entry.ref}` : `  - ${text}`];
      // A terminal has no links, so the deep link is the command that would follow it. Explaining
      // *why* something was refused is only half an answer when the reader does not yet know what
      // the thing being refused is called `[DOC:REQ-041]`.
      if (entry.topic) lines.push(`      ↳ sflow explain ${entry.topic}`);
      return lines.join('\n');
    });
}

function nextLines(result) {
  const order = { NOW: 0, SOON: 1, LATER: 2 };
  return [...result.next]
    .sort((a, b) => (order[a.rank] - order[b.rank]) || a.id.localeCompare(b.id))
    // The command is the thing the reader came for, so it is the thing that carries the emphasis.
    .map((entry) => `  ${style.detail(entry.rank.padEnd(5))} ${entry.label}\n        ${style.action(entry.command)}`);
}

function goalLines(result) {
  if (!result.operation.id.startsWith('goal.')) return [];
  const { goal, goals, links = [], activeGoalId } = result.data ?? {};
  if (Array.isArray(goals)) {
    if (!goals.length) return ['', style.detail('No Goals match this view.')];
    return ['', ...goals.flatMap((item) => [
      `${item.id === activeGoalId ? style.success('●') : '○'} ${style.heading(item.id)}  ${item.statement}`,
      `  ${style.detail(`${item.status} · ${item.links.length} linked work item(s) · ${item.successCriteria.length} success criterion/criteria`)}`
    ])];
  }
  if (!goal) return [];
  const lines = [
    '',
    style.heading(goal.statement),
    style.detail(`Goal: ${goal.id} · ${goal.status} · personal advisory state`),
    '',
    style.heading('Success means:'),
    ...goal.successCriteria.map((criterion) => `  - ${criterion}`)
  ];
  if (goal.links.length) {
    lines.push('', style.heading('Governed work:'));
    const facts = new Map(links.map((link) => [`${link.repositoryId}:${link.kind}:${link.id}`, link]));
    for (const link of goal.links) {
      const live = facts.get(`${link.repositoryId}:${link.kind}:${link.id}`);
      lines.push(`  - ${link.id} · ${link.repositoryId} · ${live?.status ?? 'not inspected'}${live?.phase ? ` · ${live.phase}` : ''}`);
    }
  }
  return lines;
}

const REST_STATE_LINES = Object.freeze({
  complete: 'This work is complete. There is nothing further to do.',
  cancelled: 'This work is cancelled and archived.',
  'awaiting-others': 'Nothing to do here — this is waiting on someone else.',
  informational: null
});

export function renderCommandResult(result) {
  if (result.operation.id === 'approvals' && result.data?.approvalChain) {
    return approvalChainText(result.data.approvalChain).trimEnd();
  }
  // A refusal is the one outcome the reader must not skim past, so it is the one that gets weight.
  const emphasise = ['refused', 'failed'].includes(result.outcome.status) ? style.failure : style.heading;
  const lines = [emphasise(headline(result))];

  lines.push(...goalLines(result));

  const preservation = preservationLine(result);
  if (preservation) lines.push(style.detail(preservation));

  const why = whyLines(result);
  if (why.length) lines.push('', style.heading('Why:'), ...why);

  const next = nextLines(result);
  if (next.length) lines.push('', style.heading('Next:'), ...next);
  else if (result.restState) {
    const rest = REST_STATE_LINES[result.restState];
    if (rest) lines.push('', rest);
  }

  return lines.join('\n');
}

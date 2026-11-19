/**
 * `--recommended`: the person's own Yes to an item's recommended answer, recorded in chat with no reason typed [owner,
 * 2026-11-19, C10]. The command checks it, not the agent: it builds the one item it decides with the decision list's own
 * builder and its recommendation, and refuses before writing anything when the chosen option is not the single
 * recommended one, or is an exception that always takes the person's reason. The refusal keeps the turn: it says to ask
 * the person why, and gives that option's own command with their reason in place of --recommended. The answer binding
 * (copilot-answer-binding.mjs) still requires the person's own Yes for that row.
 *
 * Every chat decision command also writes its advice entry (advice-outcomes.mjs) in its own commit [Q13]: with
 * --recommended always, and with a typed reason whenever the list can be read.
 */
import { SingularityFlowError } from './util.mjs';

/** The list item `matches` finds, with the option `optionOf(item)` names, as the person sees them now; null when absent. */
async function listedChoice(root, config, workflow, matches, optionOf) {
  const { readPendingList } = await import('./decision-list-reads.mjs');
  const packet = await readPendingList(root, config, workflow, { card: true });
  const item = [...(packet.items ?? []), ...(packet.offered ?? [])].find(matches) ?? null;
  const option = item ? item.options.find((entry) => entry.id === optionOf(item)) ?? null : null;
  return { packet, item, option };
}

/**
 * What a chat decision records for the person's answer: `{ reason, advice }`. With `recommended`, the reason is the
 * recommendation's own and a refusal stops anything that is not the recommended answer; without it, the reason is theirs
 * and the advice entry is best-effort (null when the list cannot be read).
 */
export async function chatAnswer(root, config, workflow, { recommended = false, reason = '', matches, optionOf, what }) {
  if (!recommended) {
    try {
      const { item, option, packet } = await listedChoice(root, config, workflow, matches, optionOf);
      if (!item || !option) return { reason, advice: null };
      const { adviceOf } = await import('./decision-list.mjs');
      return { reason, advice: adviceOf(item, option, { typed: Boolean(String(reason ?? '').trim()), phase: packet.phase ?? null }) };
    } catch { return { reason, advice: null }; }
  }
  if (String(reason ?? '').trim()) {
    throw new SingularityFlowError('Pass either the person\'s reason (--reason) or --recommended, not both: --recommended records the recommendation\'s own reason.', {
      code: 'DECISION_RECOMMENDED_INVALID' });
  }
  const { item, option, packet } = await listedChoice(root, config, workflow, matches, optionOf);
  if (!item || !option) {
    throw new SingularityFlowError(`${what} is not on the decision list now, so it has no recommendation to follow. Read the list again and ask the person.`, {
      code: 'DECISION_NOT_RECOMMENDED', details: { nextAction: { command: `singularity-flow decisions ${workflow.workItem.id}`, label: 'Read the decision list again.' } } });
  }
  const need = option.needs?.reason;
  if (item.recommended?.option !== option.id || !need || need.minimum !== 0 || !need.default) {
    const own = option.chat?.command && !/--recommended\b/u.test(option.chat.command) ? option.chat.command : null;
    throw new SingularityFlowError(`${option.label} is not the recommended answer, so it takes the person's own reason. Nothing was recorded: ask them why, then run it with their words.`, {
      code: 'DECISION_NOT_RECOMMENDED', details: { item: item.id, option: option.id, recommended: item.recommended?.option ?? null, minimum: need?.minimum ?? null,
        nextAction: own ? { command: own, label: 'Run it with the person\'s own reason.' } : { command: `singularity-flow decisions ${workflow.workItem.id}`, label: 'Read the decision list again.' } } });
  }
  const { adviceOf } = await import('./decision-list.mjs');
  return { reason: need.default, advice: adviceOf(item, option, { typed: false, phase: packet.phase ?? null }) };
}

/** Write a chat decision with its advice entry in the same commit, the surface said as `chat` without a terminal. */
export async function withChatAdvice(advice, write) {
  if (!advice) return write();
  const { withAdvice } = await import('./advice-outcomes.mjs');
  return withAdvice([advice], { surface: process.stdin.isTTY && process.stdout.isTTY ? 'terminal' : 'chat' }, write);
}

/** The option of a departure row a `decision departure` names: its Reject, the kind it keeps, the row it names, or its Accept. */
export function departureOptionOf(item, { as, clause = null, fulfillment = null }) {
  if (as === 'rejected') return 'reject';
  const accepts = item.options.filter((entry) => /^accept(?:-|$)/u.test(entry.id));
  if (fulfillment) return `accept-${fulfillment}`;
  if (clause) {
    const named = String(clause).toUpperCase();
    return accepts.find((entry) => (entry.effects?.[0]?.changes ?? []).some((change) => String(change.clauseId ?? '').toUpperCase() === named))?.id ?? null;
  }
  return accepts.find((entry) => entry.id === 'accept')?.id ?? (accepts.length === 1 ? accepts[0].id : null);
}

const changeKey = (change) => `${change.kind}\u0000${change.path}\u0000${String(change.clauseId ?? change.class ?? '').toUpperCase()}`;
const sameChanges = (entry, changes) => {
  const effect = entry.effects?.[0];
  const listed = effect?.kind === 'plan-amendment' ? (effect.changes ?? [effect.change]).filter(Boolean) : [];
  return listed.length === changes.length && listed.map(changeKey).sort().join('\u0001') === changes.map(changeKey).sort().join('\u0001');
};

/**
 * `decision plan --add-location|--add-supporting` in chat: the reason, the changes with each supporting change's own reason,
 * and the advice entry. With --recommended the changes must be exactly the plan row the list recommends.
 */
export async function planChatAnswer(root, config, workflow, changes, { recommended = false, reason = '' }) {
  const answer = await chatAnswer(root, config, workflow, { recommended, reason, what: changes.map((change) => change.path).join(', ') || 'That plan change',
    matches: (item) => item.kind === 'plan-accounting' && item.options.some((entry) => sameChanges(entry, changes)),
    optionOf: (item) => item.options.find((entry) => sameChanges(entry, changes))?.id ?? null });
  return { ...answer, changes: recommended ? changes.map((change) => (change.kind === 'add-supporting' && !change.reason ? { ...change, reason: answer.reason.slice(0, 500) } : change)) : changes };
}

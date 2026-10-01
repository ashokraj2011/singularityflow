/**
 * Workflow decisions in the editor: what a person is offered at a waiting decision, the exact
 * command each choice runs, and the values a phase must record before it is submitted.
 *
 * Pure on purpose. The extension owns the prompts and the engine owns every rule and transition;
 * this module only turns the engine's decision view into choices and argv, so the tests can pin
 * exactly what each control would run without an extension host.
 */
import type { DecisionInputSpec, DecisionOptionView, PendingDecisionView } from './cli/snapshot.ts';

export interface DecisionChoiceItem {
  label: string;
  description: string;
  /** The decision option this item chooses, or absent for "another step". */
  option?: string;
  anyStep?: boolean;
}

/** Where an option leads, in words: the next step, a later one, back, or the end of the Story. */
export function decisionTargetText(option: Pick<DecisionOptionView, 'to' | 'toLabel' | 'reach' | 'skips' | 'skipLabels'>): string {
  const name = option.toLabel ?? option.to;
  const skipped = option.skipLabels ?? option.skips ?? [];
  const skips = skipped.length ? `, skipping ${skipped.join(', ')}` : '';
  if (option.reach === 'backward') return `back to ${name}`;
  if (option.reach === 'end') return `finish the Story${skips}`;
  return `${name}${skips}`;
}

/** The options of a waiting decision as pickable items, plus "another step" when it allows one. */
export function decisionChoiceItems(pending: PendingDecisionView): DecisionChoiceItem[] {
  const items: DecisionChoiceItem[] = pending.options.map((option) => ({
    label: option.label,
    description: decisionTargetText(option),
    option: option.id
  }));
  if (pending.anyStep) items.push({ label: 'Another step…', description: 'Choose any step of this Story, or finish it', anyStep: true });
  return items;
}

/** Why the Story is waiting, as one sentence for a heading or a notification. */
export function pendingDecisionSummary(pending: PendingDecisionView): string {
  const limit = pending.reason === 'limit' ? ` All ${pending.maxRounds} rounds are used, so a person chooses.` : '';
  return `${pending.label}${limit} Decided by ${pending.by.join(', ') || 'the step\'s approvers'}.`;
}

/**
 * The exact command that records a choice. `--expected` binds it to the question that was shown,
 * so a stale screen cannot answer a decision that has since changed.
 */
export function decisionChooseArgv(
  workId: string,
  pending: Pick<PendingDecisionView, 'key'>,
  choice: { option?: string; to?: string },
  reason: string
): string[] {
  const target = choice.option ? ['--option', choice.option] : ['--to', choice.to ?? ''];
  return ['decision', 'choose', workId, '--fetch', ...target, '--reason', reason.trim(), '--expected', pending.key];
}

/** Replace the shown `--decision NAME=<NAME>` placeholders with the values a person chose. */
export function submitArgvWithDecisionValues(argv: readonly string[], values: Record<string, string>): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--decision' && /^[^=\s]+=<[^>]*>$/u.test(argv[index + 1] ?? '')) { index += 1; continue; }
    result.push(token);
  }
  for (const [name, value] of Object.entries(values)) result.push('--decision', `${name}=${value}`);
  return result;
}

/** How to ask for one value: its choices, or a validator for a number within its bounds. */
export function decisionInputPrompt(input: DecisionInputSpec): {
  title: string; choices: string[] | null; validate: (value: string) => string | null;
} {
  const title = `${input.decisionLabel ?? 'Decision'}: ${input.label ?? input.name}`;
  if (input.type !== 'number') return { title, choices: [...(input.values ?? [])], validate: () => null };
  return {
    title,
    choices: null,
    validate: (value: string) => {
      const number = Number(value.trim());
      if (!value.trim() || !Number.isFinite(number)) return 'Enter a number.';
      if (input.minimum != null && number < input.minimum) return `Enter at least ${input.minimum}.`;
      if (input.maximum != null && number > input.maximum) return `Enter at most ${input.maximum}.`;
      return null;
    }
  };
}

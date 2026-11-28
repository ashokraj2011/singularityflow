/**
 * A step's submission records the Story values its own clarification asked, from the person's answers there
 * [ITW:REQ-011, phase-roles.mjs storyValueTopic]: a marketplace agent's hard gate is asked once, in the agent's words with its
 * choices, and no route carries a `<channel>` to fill in. An answer that names none of the choices, or none recorded,
 * asks the person the agent's question again with one complete command per choice. Loaded by `submit` only.
 */
import { answeredChoice, clarifiedValueQuestions } from './phase-roles.mjs';
import { SingularityFlowError } from './util.mjs';

/**
 * `given` with each value the step's clarification asked and the person answered there; refused, asking the person with
 * a complete command per choice, for one it asked and nobody answered.
 */
export async function clarifiedDecisionValues(root, config, workflow, phase, decision, given = {}) {
  const asked = clarifiedValueQuestions(workflow, phase.id);
  const open = decision.inputs.filter((input) => asked.has(input.name) && !Object.hasOwn(given, input.name));
  if (!open.length) return given;
  const { readClarificationRecord } = await import('./clarifications.mjs');
  // This version's answer, else the latest earlier version's: a value answered once is never asked again, and a later
  // version's author is told not to ask it (ask once, owner 2026-11-28).
  const generations = [...new Set([Number(phase.generation), ...(phase.clarifications ?? []).map((entry) => Number(entry?.generation))
    .filter((generation) => Number.isSafeInteger(generation)).sort((left, right) => right - left)])];
  const records = [];
  for (const generation of generations) records.push(await readClarificationRecord(root, config, workflow, phase, generation).catch(() => null));
  const values = { ...given };
  for (const input of open) {
    const choice = records.map((record) => answeredChoice(asked.get(input.name), record?.responses ?? [])).find(Boolean);
    if (choice) values[input.name] = choice;
  }
  const unanswered = open.find((input) => !Object.hasOwn(values, input.name));
  if (!unanswered) return values;
  const question = asked.get(unanswered.name);
  const workId = workflow.workItem.id;
  // The step's own submission from the action-to-command map, with each value as one shell word, one command per choice.
  const { actionCommandLine } = await import('./action-command-map.mjs');
  const submit = actionCommandLine('submit-version', 'exact', { step: phase.id, workId });
  const value = (name, chosen) => { const word = `${name}=${chosen}`; return /^[A-Za-z0-9_./:=@%+,-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`; };
  const others = Object.entries(values).map(([name, chosen]) => ` --decision ${value(name, chosen)}`).join('');
  const choices = submit ? question.choices.map((choice) => ({ id: choice.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'choice', label: choice,
    command: `${submit}${others} --decision ${value(unanswered.name, choice)}` })) : [];
  throw new SingularityFlowError(`${question.question} The person chooses ${question.choices.join(' or ')}, then submit with it: ${choices[0]?.command ?? `singularity-flow status ${workId}`}.`, {
    code: 'DECISION_INPUTS_MISSING',
    details: { workId, phase: phase.id, decision: decision.id, inputs: decision.inputs, question: question.question, choices,
      recoveryCommands: choices.map((entry) => ({ command: entry.command, label: `If the person chooses ${entry.label}` })) } });
}

/**
 * One filled submission per value of the first value a decision after `phase` still needs, the values already given kept
 * [owner, 2026-11-28, dead end 15]: the Decide card holds no decision inputs, so it was no way on. A number has no list to
 * fill, so none is offered for one (the person types it). Returns `{ recoveryCommands, nextAction }`, both empty when none.
 */
export function decisionInputChoiceRoutes(actionCommandLine, workflow, phase, decision, given = {}) {
  const open = (decision?.inputs ?? []).find((input) => !Object.hasOwn(given, input.name));
  const submit = actionCommandLine('submit-version', 'exact', { step: phase.id, workId: workflow.workItem.id });
  if (!open || !submit || !Array.isArray(open.values) || !open.values.length) return { recoveryCommands: [], nextAction: null };
  const value = (name, chosen) => { const word = `${name}=${chosen}`; return /^[A-Za-z0-9_./:=@%+,-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`; };
  const others = Object.entries(given).map(([name, chosen]) => ` --decision ${value(name, chosen)}`).join('');
  const recoveryCommands = open.values.slice(0, 8).map((chosen) => ({ command: `${submit}${others} --decision ${value(open.name, chosen)}`,
    label: `Submit ${phase.label ?? phase.id} with ${open.name} ${chosen}${decision.label ? ` (it decides ${decision.label})` : ''}` }));
  return { recoveryCommands, nextAction: null };
}


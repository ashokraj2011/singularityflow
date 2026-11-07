/**
 * `clarification answer` and `clarification import`: an approver answers a step's question in
 * their own clone, and the author's checkout records it (clarification-remote.mjs).
 */
import { identity } from '../git.mjs';
import { publishClarificationAnswer, remoteClarificationAnswers } from '../clarification-remote.mjs';
import { recordClarificationResponses } from '../clarifications.mjs';
import { storyDraftTransaction } from '../engine-compatibility/story-draft-transaction.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString } from '../util.mjs';

export async function clarificationAnswerCommand(root, config, workflow, phase, options) {
  const json = optionBoolean(options, 'json');
  const sent = await publishClarificationAnswer(root, config, workflow, phase, {
    question: optionString(options, 'question'), marker: optionString(options, 'marker'),
    answer: optionString(options, 'answer'), why: optionString(options, 'why'), actor: identity(root)
  });
  if (!json) {
    console.log(`Sent your answer for ${phase.id} generation ${sent.packet.generation} to ${sent.remote} (${sent.ref}). Nothing changed on the Story branch.`);
    console.log(`Next, in the author's checkout: singularity-flow clarification import ${phase.id}`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'clarification.answer', classification: 'mutation' }, subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('clarification.answer-sent', { phase: phase.id, generation: sent.packet.generation }),
    effects: effects({ filesChanged: false }),
    data: { ref: sent.ref, commit: sent.commit, remote: sent.remote, questionSha256: sent.packet.questionSha256,
      nextAction: `singularity-flow clarification import ${phase.id}` }
  }), { json, postState: workflow });
}

export async function clarificationImportCommand(root, config, workflow, phase, options) {
  const json = optionBoolean(options, 'json');
  const found = await remoteClarificationAnswers(root, config, workflow, phase);
  const recorded = [];
  // One record call per person, so each one's answers carry that person as the human actor.
  const byPerson = new Map();
  for (const entry of found.accepted) {
    const key = entry.actor.email.toLowerCase();
    byPerson.set(key, [...(byPerson.get(key) ?? []), entry]);
  }
  for (const entries of byPerson.values()) {
    const result = await storyDraftTransaction(root, config, workflow, `clarification:${phase.id}`, () =>
      recordClarificationResponses(root, config, workflow, phase, {
        responses: entries.map((entry) => entry.response), actor: entries[0].actor, agent: null
      }));
    recorded.push({ by: entries[0].actor.email, answers: entries.length, path: result.path, completed: result.record.completed });
  }
  if (!json) {
    if (!found.accepted.length && !found.refused.length) console.log(`No answers from another clone are waiting for ${phase.id} generation ${found.generation}.`);
    for (const entry of recorded) console.log(`Recorded ${entry.answers} answer${entry.answers === 1 ? '' : 's'} from ${entry.by} for ${phase.id} generation ${found.generation}.`);
    for (const entry of found.refused) console.log(`Not recorded: ${entry.ref.split('/').pop()} (${entry.commit.slice(0, 12)}): ${entry.why}.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'clarification.import', classification: 'mutation' }, subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('clarification.imported', { phase: phase.id, generation: found.generation, answers: String(found.accepted.length) }),
    effects: recorded.length ? effects({ filesChanged: true }) : noEffects(),
    data: { generation: found.generation, recorded, refused: found.refused }
  }), { json, postState: workflow });
}

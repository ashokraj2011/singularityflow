/**
 * The owner's output after the primary-first fix (2026-11-11): the agent listed the labels, then every route apart
 * from them, and "Now" read as the authoring instruction. Each action now has a short label for people, shown as its
 * "<timing> — <label>" line with its own three routes right under it; the presentation contract every skill embeds says so.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMAND_PRESENTATION_CONTRACT } from '../src/model-free-commands.mjs';
import { startedSpecificationStory, CLI } from './helpers/submitted-planning-story.mjs';

const json = (result) => JSON.parse(result.stdout);

test('the presentation contract says what happens next in one plain line, no longer than the three bullets were', () => {
  // One plain next line (owner, 2026-11-28), in place of three commands for each action.
  assert.equal(COMMAND_PRESENTATION_CONTRACT, 'Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; '
    + 'run returned routes exactly, never invent one. When SFlow\'s note says this turn goes on, do it in this same turn. Where a person decides, '
    + 'say what, why and where (this question, the page or the card). Every turn that no SFlow note carries on ends with '
    + '"/sf-next carries it on" (or press Continue).');
  // Every skill embeds it: the three bullets' wording was 436 characters (109 estimated tokens).
  assert.ok(COMMAND_PRESENTATION_CONTRACT.length <= 436, `${COMMAND_PRESENTATION_CONTRACT.length} characters`);
});

test('a Story at Specification shows "Now — Write the Specification" and "Optional — Record who coordinates specification", each with its routes', async (t) => {
  const story = await startedSpecificationStory(t, 'LABEL-1');
  const run = (...args) => story.run(process.execPath, [CLI, '--no-model', ...args]);
  const text = run('nextsteps').stdout;
  assert.match(text, /\n1\. Now — Write the Specification\n {3}- Copilot: \/sf-phase\n {3}- Shell: singularity-flow prepare specification\n {3}- VS Code \(model-free\): [^\n]+\n2\. Optional — Record who coordinates specification\n {3}- Copilot: \/sf-assign\n {3}- Shell: singularity-flow assign specification <assignee>\n {3}- VS Code \(model-free\): [^\n]+\n/u);
  assert.doesNotMatch(text, /Preserve any existing authored draft/u, 'the agent\'s instruction is not a person\'s label');
  // Every surface's actions carry the label; the reason stays the agent's.
  const actions = json(run('nextsteps', '--json')).actions;
  assert.deepEqual(actions.slice(0, 2).map((action) => action.label), ['Write the Specification', 'Record who coordinates specification']);
  assert.match(actions[0].reason, /Preserve any existing authored draft/u);
  assert.ok(actions.every((action) => typeof action.label === 'string' && action.label.length > 0 && action.label.length <= 80));
  const opened = json(run('session', 'open', 'LABEL-1', '--for-agent', '--json'));
  assert.deepEqual(opened.act.next.map((entry) => [entry.timing, entry.label, entry.copilot]),
    [['now', 'Write the Specification', '/sf-phase'], ['optional', 'Record who coordinates specification', '/sf-assign']]);
});

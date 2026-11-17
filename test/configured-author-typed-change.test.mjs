/**
 * A change typed after a step's configured author (review finding 1, 2026-11-17). A published document step whose
 * workflow names its own writer (`authoringSkill`, here /sf-design on planning) is refused `phase rollover` without
 * words, and the refusal says to type the change after that writer. The words typed there were never kept: only
 * /sf-code and /sf-phase turns recorded them, so the writer previewed nothing, was refused the same way and named itself
 * again. One behaviour for every writer (D1): what is typed after the step's own writer is kept as what the person asked
 * for, and its version question follows in the same turn, on the person's yes.
 */
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import test from 'node:test';

import { publishedPlanningStory, CLI } from './helpers/submitted-planning-story.mjs';
import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { typedInstruction } from '../src/asked-for.mjs';
import { ASKED_FOR_SKILLS } from '../src/writing-aliases.mjs';
import { AUTHORING_SKILL_DECLARATION } from '../src/authoring-skills.mjs';

const WORK = 'AUTHOR-WORDS-1';
const ASKED = 'name who owns the rollback in the risks section';
const json = (result) => JSON.parse(result.stdout);

test('every step writer keeps what is typed after it, as /sf-code and /sf-phase do', async () => {
  for (const source of Object.keys(AUTHORING_SKILL_DECLARATION)) {
    for (const skill of [source, source.replace(/^sflow-/u, 'sf-')]) {
      assert.ok(ASKED_FOR_SKILLS.includes(skill), skill);
      assert.deepEqual(await typedInstruction({ prompt: `/${skill} ${ASKED}` }, skill), { text: ASKED }, skill);
      // A host's expanded skill context says the same.
      assert.deepEqual(await typedInstruction({ prompt: `<skill-context name="${skill}">x\nARGUMENTS: ${ASKED}\n</skill-context>` }, skill), { text: ASKED }, skill);
    }
  }
  // Still nothing for a skill that writes no step, a bare step word or a subagent's task.
  assert.equal(await typedInstruction({ prompt: `/sf-approve ${ASKED}` }, 'sf-approve'), null);
  assert.equal(await typedInstruction({ prompt: '/sf-design status' }, 'sf-design'), null);
  assert.equal(await typedInstruction({ prompt: `/sf-design ${ASKED}`, agentId: 'reviewer' }, 'sf-design'), null);
});

test('a change typed after a published step\'s configured author is previewed as its next version, on the person\'s yes', async (t) => {
  const story = await publishedPlanningStory(t, WORK, { configure: (configuration) => { configuration.phases.planning.authoringSkill = 'sf-design'; } });
  const { root, cli, run, git } = story;
  const publishedHead = git('rev-parse', 'HEAD');

  // Nothing asked yet: the refusal names the step's own writer, with the words to type after it.
  const unasked = run(process.execPath, [CLI, '--no-model', 'phase', 'rollover', 'planning', '--json'], { allowFailure: true });
  assert.notEqual(unasked.status, 0);
  const refusal = JSON.parse(unasked.stdout);
  assert.equal(refusal.error.code, 'GENERATION_CHANGE_NOT_REQUESTED');
  assert.match(refusal.error.message, /Say what to change: \/sf-design planning <what to change>/u);

  // The person does exactly that; the prompt hook keeps the words for version 2.
  const hook = { cwd: await realpath(root), sessionId: 'author-words', prompt: `/sf-design planning ${ASKED}` };
  await recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, record) => captureMutationTurn(payload, record, { resolveRoot: async () => hook.cwd }) });

  // The writer's entry leads with the version question, and its preview runs in that turn.
  const entry = json(cli('phase', 'enter', '--compose', '--for-agent', '--json'));
  assert.equal(entry.act.do.shell, 'singularity-flow phase rollover planning --json', JSON.stringify(entry.act));
  const preview = await mutationToolGuard({ ...hook, toolName: 'bash', toolArgs: { command: 'singularity-flow phase rollover planning --json', cwd: hook.cwd } });
  assert.deepEqual(preview, {}, 'the preview runs in the /sf-design turn');
  const proposed = json(cli('phase', 'rollover', 'planning', '--json'));
  assert.equal(proposed.kind, 'requested-change');
  assert.deepEqual([proposed.fromGeneration, proposed.toGeneration], [1, 2]);
  assert.deepEqual(proposed.requestedChange.requests, [ASKED], 'the step word is the target, never part of what was asked');
  assert.ok(proposed.command.endsWith(`--confirm ${proposed.confirmation}`));
  // Nothing opened without the person's yes.
  assert.equal(git('rev-parse', 'HEAD'), publishedHead);
});

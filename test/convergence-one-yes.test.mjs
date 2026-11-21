/**
 * The convergence confirmation folds into its approval (owner, 2026-11-19): `story advance --submit` sends the report for
 * approval in the author's own turn, and the person reviews it there and approves it with one bound Yes, which advances
 * the Story out of convergence [SPK:REQ-032]. No digest to confirm and no /sf-confirm code to type.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';

test('the convergence report goes for approval without a separate confirmation or code', async () => {
  const act = agentAct({ resultType: 'sflow-submission-readiness', workId: 'W', phaseId: 'convergence', classification: 'convergence-advance-required',
    reason: 'Submit the convergence report for approval; the person reviews it there and approves it with one Yes.',
    nextCommand: 'singularity-flow story advance --work-id W', nextSkill: '/sf-submit' });
  assert.equal(act.state, 'next');
  assert.match(act.said, /run its --submit command once in this same turn/u);
  assert.match(act.said, /Never ask them to confirm it first/u);
  const skill = await readFile(new URL('../plugin/skills/sflow-submit/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /run its `--submit` command once now: SFlow approves a clean report itself, else the person approves it at its approval with one Yes, never a separate confirmation/u);
  assert.doesNotMatch(skill, /--confirm sha256:<DIGEST>/u);
  const story = await readFile(new URL('../src/commands/story.mjs', import.meta.url), 'utf8');
  assert.match(story, /singularity-flow story advance --work-id \$\{workflow\.workItem\.id\} --submit/u);
  assert.doesNotMatch(story.slice(story.indexOf('const confirmation = optionBoolean(options, \'submit\')')), /confirmationCode|rememberConfirmCommand/u, 'the /sf-confirm code goes');
});

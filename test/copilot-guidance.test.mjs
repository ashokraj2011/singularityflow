import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionCommandLines,
  copilotAction,
  copilotSkillForCommand,
  directCopilotSkill
} from '../src/copilot-guidance.mjs';

test('user-facing skills always use the direct sf namespace', () => {
  assert.equal(directCopilotSkill('/sflow-submit'), '/sf-submit');
  assert.equal(directCopilotSkill('sflow-approve'), '/sf-approve');
  assert.equal(directCopilotSkill('/sf-next'), '/sf-next');
});

test('CLI lifecycle commands map to installed direct Copilot skills', () => {
  assert.equal(copilotSkillForCommand('singularity-flow prepare intake'), '/sf-phase');
  assert.equal(copilotSkillForCommand('singularity-flow submit intake'), '/sf-submit');
  assert.equal(copilotSkillForCommand('singularity-flow epic create-stories'), '/sf-epic-publish');
  assert.equal(copilotSkillForCommand('singularity-flow initiative evidence add check-1'), '/sf-initiative-evidence');
  assert.equal(copilotSkillForCommand('singularity-flow gate --terminal'), '/sf-next');
});

test('rendered action guidance pairs Copilot and CLI commands', () => {
  const action = copilotAction({ skill: '/sflow-phase', command: 'singularity-flow prepare intake' });
  assert.deepEqual(actionCommandLines(action), [
    'Next action in Copilot: /sf-phase',
    'CLI equivalent: singularity-flow prepare intake'
  ]);
});

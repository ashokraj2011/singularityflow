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
  assert.equal(copilotSkillForCommand('singularity-flow intent workflow-guide intent-ir.json'), '/sf-sgos-create');
  assert.equal(copilotSkillForCommand('singularity-flow intent workflow-create intent-ir.json'), '/sf-sgos-create');
  assert.equal(copilotSkillForCommand('singularity-flow intent ratify intent-ir.json'), '/sf-workflows');
  assert.equal(copilotSkillForCommand('singularity-flow prepare intake'), '/sf-phase');
  assert.equal(copilotSkillForCommand('singularity-flow submit intake'), '/sf-submit');
  assert.equal(copilotSkillForCommand('singularity-flow epic create-stories'), '/sf-epic-publish');
  assert.equal(copilotSkillForCommand('singularity-flow initiative evidence add check-1'), '/sf-initiative-evidence');
  assert.equal(copilotSkillForCommand('singularity-flow gate --terminal'), '/sf-gate');
  assert.equal(copilotSkillForCommand('singularity-flow configuration show'), '/sf-configuration');
  assert.equal(copilotSkillForCommand('singularity-flow not-a-command'), '/sf-next');
});

test('rendered action guidance leads with the command, then the Copilot skill', () => {
  const action = copilotAction({ skill: '/sflow-phase', command: 'singularity-flow prepare intake' });
  assert.deepEqual(actionCommandLines(action), [
    'Run: singularity-flow prepare intake',
    'In Copilot: /sf-phase'
  ]);
});

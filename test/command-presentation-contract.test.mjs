import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { commandGuidanceForCommands, commandGuidanceLines, safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { renderDirectSkill } from '../src/direct-skills.mjs';
import { COMMAND_PRESENTATION_CONTRACT } from '../scripts/skill-policy.mjs';

test('command guidance distinguishes a Copilot journey from an exact phase operation', () => {
  const commands = { recover: 'singularity-flow recover ADD-1 --phase specification --json',
    recheck: 'singularity-flow phase prepublish specification --json',
    publish: null, unsafe: 'singularity-flow status; touch unexpected', unknown: 'singularity-flow unknown' };
  const guidance = commandGuidanceForCommands(commands);
  assert.equal(guidance.recover.copilotCommand, '/sf-recover');
  assert.equal(guidance.recheck.command, commands.recheck);
  assert.equal(guidance.recheck.copilotCommand, null);
  assert.match(commandGuidanceLines(guidance.recheck, 'Recheck').join('\n'),
    /Shell: singularity-flow phase prepublish specification --json\nCopilot: No dedicated Copilot equivalent/);
  assert.equal(guidance.publish, null);
  for (const key of ['unsafe', 'unknown']) {
    assert.equal(guidance[key].command, null);
    assert.equal(guidance[key].copilotStatus, 'unavailable');
  }
});

test('phase document display has a read-only Copilot route with the exact phase selector', () => {
  const guidance = safeCommandGuidance('singularity-flow phase show specification --show-artifact');
  assert.equal(guidance.skill, '/sf-phase-documents');
  assert.equal(guidance.copilotCommand, '/sf-phase-documents specification');
  assert.equal(commandGuidanceForCommands({ view: 'singularity-flow phase show specification --json' }).view.copilotCommand,
    '/sf-phase-documents specification');
  assert.equal(safeCommandGuidance({
    command: 'singularity-flow phase show specification --show-artifact', skill: '/sf-phase'
  }), null, 'the generative phase skill cannot stand in for a document read');
});

test('all bundled and direct Copilot skills require command pairs or an explicit absence', async () => {
  assert.match(COMMAND_PRESENTATION_CONTRACT, /available `modelFreeCommand` as "VS Code \(model-free\)"/);
  const root = new URL('../plugin/skills/', import.meta.url);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('sflow-')) continue;
    const source = await readFile(new URL(`${entry.name}/SKILL.md`, root), 'utf8');
    assert.ok(source.includes(COMMAND_PRESENTATION_CONTRACT), entry.name);
    assert.ok(renderDirectSkill(source, entry.name).includes(COMMAND_PRESENTATION_CONTRACT), entry.name);
  }
});

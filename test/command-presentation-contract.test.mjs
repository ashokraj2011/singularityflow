import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { commandGuidanceForCommands, commandGuidanceLines, safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { renderDirectSkill } from '../src/direct-skills.mjs';
import { COMMAND_PRESENTATION_CONTRACT } from '../scripts/skill-policy.mjs';
import { commandInlineCode, formatCommandRouteLines, withCommandPresentationProtocol } from '../src/model-free-commands.mjs';
import { mutationDenial } from '../src/phase-mutation-contract.mjs';

test('command guidance distinguishes a Copilot journey from an exact phase operation', () => {
  const commands = { recover: 'singularity-flow recover ADD-1 --phase specification --json',
    recheck: 'singularity-flow phase prepublish specification --json',
    publish: null, unsafe: 'singularity-flow status; touch unexpected', unknown: 'singularity-flow unknown' };
  const guidance = commandGuidanceForCommands(commands);
  assert.equal(guidance.recover.copilotCommand, '/sf-recover');
  assert.equal(guidance.recheck.command, commands.recheck);
  assert.equal(guidance.recheck.copilotCommand, null);
  // Every action reads Copilot, Shell, then the model-free VS Code route (2e600393).
  assert.deepEqual(commandGuidanceLines(guidance.recheck, 'Recheck'), [
    'Recheck:', '- Copilot: no verified equivalent',
    '- Shell: singularity-flow phase prepublish specification --json',
    '- VS Code (model-free): not available for this action'
  ]);
  assert.match(guidance.recheck.copilotReason, /No dedicated Copilot equivalent/);
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
  assert.match(COMMAND_PRESENTATION_CONTRACT, /three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code \(model-free\): `<modelFreeCommand>`"/);
  assert.match(COMMAND_PRESENTATION_CONTRACT, /never combine them on one line or in a table/);
  const root = new URL('../plugin/skills/', import.meta.url);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('sflow-')) continue;
    const source = await readFile(new URL(`${entry.name}/SKILL.md`, root), 'utf8');
    assert.ok(source.includes(COMMAND_PRESENTATION_CONTRACT), entry.name);
    assert.ok(renderDirectSkill(source, entry.name).includes(COMMAND_PRESENTATION_CONTRACT), entry.name);
  }
});

test('the same exact three command rows apply to seeded and custom phases', () => {
  for (const phase of ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release', 'custom-check']) {
    const command = `singularity-flow approve ${phase} --work-id fact-01 --fetch`;
    const guidance = safeCommandGuidance(command);
    const before = structuredClone(guidance);
    assert.deepEqual(formatCommandRouteLines(guidance, { markdown: true }), [
      `- Copilot: \`/sf-approve ${phase} --work-id fact-01\``,
      `- Shell: \`${command}\``,
      `- VS Code (model-free): \`@sflow /approve ${phase} --work-id fact-01\``
    ]);
    assert.deepEqual(guidance, before, 'layout must not change selectors, authority or metadata');
  }
  assert.deepEqual(formatCommandRouteLines(null), [
    '- Copilot: no verified equivalent', '- Shell: not available for this action',
    '- VS Code (model-free): not available for this action'
  ]);
});

test('literal backticks in commands cannot break the Markdown code span', () => {
  const command = 'singularity-flow decision scope fact-01 --item SRI-1 --as informative --reason "literal `code`"';
  assert.equal(commandInlineCode(command), '``' + command + '``');
  assert.equal(commandInlineCode('`quoted`'), '`` `quoted` ``');
  assert.equal(formatCommandRouteLines({ command }, { markdown: true })[1], '- Shell: ``' + command + '``');
});

test('old and custom prompt delivery receives one layout rule without rewriting its content', () => {
  const pinned = '# Existing custom skill\nKeep these original bytes and pinned instructions.\n';
  const delivered = withCommandPresentationProtocol(pinned);
  assert.ok(delivered.endsWith(pinned));
  assert.ok(delivered.startsWith('# Runtime command presentation\n\n'));
  assert.equal(delivered.split(COMMAND_PRESENTATION_CONTRACT).length, 2);
  assert.equal(withCommandPresentationProtocol(delivered), delivered);
});

test('multiple recovery actions each get a complete block without altering the structured routes', () => {
  const actions = [safeCommandGuidance('singularity-flow nextsteps --json'),
    safeCommandGuidance('singularity-flow phase prepublish verification --json')];
  const result = mutationDenial({ summary: 'Preserve the draft.', next: actions }, 'EXAMPLE_REFUSAL');
  assert.equal(result.next, actions);
  const blocks = result.permissionDecisionReason.split('\n\n').slice(1);
  assert.equal(blocks.length, 2);
  for (const [index, block] of blocks.entries()) {
    assert.equal(block, formatCommandRouteLines(actions[index]).join('\n'));
    assert.equal(block.split('\n').length, 3);
  }
});

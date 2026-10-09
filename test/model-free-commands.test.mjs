import test from 'node:test';
import assert from 'node:assert/strict';
import { modelFreeCommandForArgv, modelFreeCommandForCommand, parseModelFreeTarget } from '../src/model-free-commands.mjs';
import { safeCommandGuidance, commandGuidanceForCommands, commandGuidanceLines } from '../src/safe-command-guidance.mjs';

test('model-free presentation preserves supported phase and Story selectors', () => {
  assert.deepEqual(parseModelFreeTarget('custom-build --work-id PILOT-1'), { phase: 'custom-build', workId: 'PILOT-1' });
  for (const [argv, expected] of [
    [['nextsteps', '--json'], '@sflow /next'],
    [['instruction', 'list', '--json'], '@sflow /instructions'],
    [['submit', 'custom-build', '--json'], '@sflow /submit custom-build'],
    [['approve', 'custom-check', '--work-id', 'PILOT-1', '--fetch'], '@sflow /approve custom-check --work-id PILOT-1'],
    [['phase', 'publish', 'custom-build', '--authored', 'governed-agent', '--channel', 'copilot-host'], '@sflow /publish custom-build'],
    [['phase', 'publish', 'converge', '--authored', 'deterministic', '--channel', 'kernel-generator'], '@sflow /publish converge']
  ]) assert.equal(modelFreeCommandForArgv(argv), expected);
});

test('unsafe, unsupported, selector-dropping and authority-bearing alternatives are never advertised', () => {
  for (const argv of [
    ['next'], ['nextsteps', 'OTHER-STORY'], ['inputs', 'planning', '--dry-run'],
    ['instruction', 'show', 'web-guide', '--json'], ['instruction', 'list', '--unknown'],
    ['submit', 'build', '--skip-checks'], ['approve', 'phase', '--allow-dirty'],
    ['approve', 'phase', '--yes'], ['approve', 'Story-1', '--phase', 'build'],
    ['phase', 'publish', 'build', '--from', '/private/file'],
    ['phase', 'publish', 'build', '--authored', 'human', '--channel', 'manual-import'],
    ['phase', 'publish', 'build', '--authored', 'governed-agent', '--channel', 'kernel-generator'],
    ['phase', 'publish', 'build', '--channel', 'copilot-host'],
    ['phase', 'publish', '<PHASE>'], ['submit', 'build', '--decision', 'pass=yes']
  ]) assert.equal(modelFreeCommandForArgv(argv), null, argv.join(' '));
  for (const prompt of ['build --yes', 'build now', 'build --work-id OTHER --work-id THIRD', '$(whoami)', 'build; touch x']) {
    assert.throws(() => parseModelFreeTarget(prompt));
  }
  assert.equal(modelFreeCommandForCommand('singularity-flow submit build; touch x'), null);
});

test('CLI and Copilot guidance show derived @sflow options without trusting asserted routes', () => {
  const guidance = safeCommandGuidance({ command: 'singularity-flow approve build --work-id STORY-1 --fetch', modelFreeCommand: '@evil /approve' });
  assert.equal(guidance.modelFreeCommand, '@sflow /approve build --work-id STORY-1');
  const mapped = commandGuidanceForCommands({ publish: 'singularity-flow phase publish build --authored governed-agent --channel copilot-host' });
  assert.equal(mapped.publish.modelFreeCommand, '@sflow /publish build');
  assert.equal(mapped.publish.copilotStatus, 'unavailable', 'a model skill is not falsely claimed as an exact publish relay');
  assert.match(commandGuidanceLines(mapped.publish, 'Publish').join('\n'), /VS Code \(model-free\): @sflow \/publish build/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRequiredTestCommand } from '../src/code-delivery-tests.mjs';
import { projectTestExecutionCommand, testExecutionHandoff } from '../src/test-execution-handoff.mjs';

function normalized(argv = ['node', 'tests.mjs', '--token', 'private-positional-secret']) {
  return normalizeRequiredTestCommand({ id: 'private-command-name', kind: 'test', argv,
    workingDirectory: '.', affectedRoots: ['.'],
    result: { adapter: 'sflow-test-result-v1', path: '.sflow/results/tests.json' }
  }, 0);
}

test('a configured runner is ready even though its arguments and arbitrary id are withheld', () => {
  const command = projectTestExecutionCommand(normalized(), { configuredIndex: 2,
    testPolicy: { minimumDiscovered: 3, minimumPassed: 2 } });
  assert.equal(command.availability, 'ready');
  assert.equal(command.id, 'qualityCommands[2]');
  assert.equal(command.argv, null);
  assert.equal(command.argvWithheld, true);
  assert.equal(command.argvSource, 'approved-configuration');
  assert.equal(command.result.minimumDiscovered, 3);
  assert.equal(command.result.minimumPassed, 2);
  assert.doesNotMatch(JSON.stringify(command), /private-command-name|private-positional-secret/u);
  const handoff = testExecutionHandoff({ status: 'not-run', commands: [command] });
  assert.equal(handoff.runnerStatus, 'ready');
  assert.equal(handoff.configurationRequired, false);
  assert.equal(handoff.executionOwner, 'publication');
  assert.equal(handoff.command, null, 'runner availability alone cannot grant publication');
  assert.equal(handoff.onSuccess, 'continue-publication');
  assert.match(handoff.guidance, /hidden, not missing/u);
});

test('inferred runners expose their known arguments and continue the guarded operation', () => {
  const source = normalized(['npm', 'test']);
  const command = projectTestExecutionCommand(source);
  assert.deepEqual(command.argv, ['npm', 'test']);
  assert.equal(command.argvWithheld, false);
  assert.equal(command.argvSource, 'inferred');
  const plan = { status: 'not-run', commands: [command] };
  const publish = testExecutionHandoff(plan, { command: 'singularity-flow phase publish team-code' });
  assert.equal(publish.onSuccess, 'continue-publication');
  assert.equal(publish.command, 'singularity-flow phase publish team-code');
  const submit = testExecutionHandoff(plan, { published: true, command: 'singularity-flow submit team-code' });
  assert.equal(submit.onSuccess, 'continue-submission');
  assert.equal(submit.executionOwner, 'submission');
  assert.match(submit.guidance, /do not republish an unchanged generation/u);
  assert.match(submit.guidance, /required human approval/u);
});

test('missing, invalid, unverified or unavailable runner plans never gain an execution route', () => {
  const readyCommand = projectTestExecutionCommand(normalized(), { configuredIndex: 0 });
  for (const plan of [
    { status: 'unavailable', reason: 'CODE_DELIVERY_TEST_COMMAND_REQUIRED', commands: [] },
    { status: 'unavailable', reason: 'CODE_TEST_SUPPRESSED', commands: [readyCommand] },
    { status: 'not-run', commands: [] },
    { status: 'not-run', commands: [{ argv: null }] },
    { status: 'passed', commands: [readyCommand] }
  ]) {
    const handoff = testExecutionHandoff(plan, { command: 'singularity-flow phase publish team-code' });
    assert.equal(handoff.runnerStatus, 'unavailable');
    assert.equal(handoff.configurationRequired, null);
    assert.equal(handoff.command, null);
    assert.equal(handoff.onSuccess, null);
  }
});

test('document and sign-off phases without required tests do not invent a runner or configuration gate', () => {
  const handoff = testExecutionHandoff({ status: 'not-required', commands: [] });
  assert.equal(handoff.runnerStatus, 'not-required');
  assert.equal(handoff.configurationRequired, false);
  assert.equal(handoff.executionOwner, null);
  assert.equal(handoff.command, null);
});

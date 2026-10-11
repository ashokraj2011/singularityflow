import assert from 'node:assert/strict';
import test from 'node:test';
import { safeCommandGuidance, validateSafeSflowCommand, validateSflowExecutionCommand } from '../src/safe-command-guidance.mjs';
import { redactCommandArgv } from '../src/logging.mjs';

const receipt = '8232baec-10cb-4dd1-a8af-066d1fb06841';

test('a private approval receipt is executable syntax but never presentation guidance', () => {
  const command = `singularity-flow approve specification --work-id 1h-hex --fetch --selection-receipt ${receipt} --for-agent --json`;
  const checked = validateSflowExecutionCommand(command);
  assert.ok(checked?.copyable);
  assert.deepEqual(checked.argv, ['approve', 'specification', '--work-id', '1h-hex', '--fetch', '--selection-receipt', receipt, '--for-agent', '--json']);
  assert.equal(checked.command, undefined);
  assert.equal(checked.platformCommands, undefined, 'private capabilities are not offered as replay commands');
  assert.equal(validateSafeSflowCommand(command), null);
  assert.equal(safeCommandGuidance(command), null);
  assert.doesNotMatch(JSON.stringify(redactCommandArgv(checked.argv)), new RegExp(receipt));
  for (const option of ["--'selection-receipt'", '--sel"ection-receipt"']) {
    const splitQuoted = `singularity-flow approve specification ${option} ${receipt}`;
    assert.ok(validateSflowExecutionCommand(splitQuoted)?.copyable);
    assert.equal(validateSafeSflowCommand(splitQuoted), null);
    assert.equal(safeCommandGuidance(splitQuoted), null, 'quote fragments cannot leak receipt capabilities');
  }
});

test('only consuming CLI forms accept one exact UUID receipt in private execution', () => {
  for (const family of ['approve specification --work-id W1', 'reject planning --work-id W1 --to specification --reason fix',
    'start W1 --title Example', 'initiative start I1', 'initiative approve planning', 'epic review approve W1', 'epic review reject W1 --reason fix']) {
    for (const option of [`--selection-receipt ${receipt}`, `--selection-receipt=${receipt}`]) {
      assert.ok(validateSflowExecutionCommand(`singularity-flow ${family} ${option}`)?.copyable, family);
    }
  }
  for (const tail of ['--selection-receipt', '--selection-receipt=', '--selection-receipt wrong',
    `--selection-receipt ${receipt} --selection-receipt ${receipt}`,
    `--selection-receipt=${receipt} --selection-receipt=${receipt}`,
    `--selection-receipt ${receipt} --selection_receipt ${receipt}`,
    `-- --selection-receipt ${receipt}`,
    `--selection-receipt ${receipt.toUpperCase()}`]) {
    assert.equal(validateSflowExecutionCommand(`singularity-flow approve specification ${tail}`), null, tail);
  }
  for (const family of ['status', 'phase publish specification', 'review-source submit specification', 'hook preToolUse', 'initiative status', 'epic review status']) {
    assert.equal(validateSflowExecutionCommand(`singularity-flow ${family} --selection-receipt ${receipt}`), null, family);
  }
});

test('receipt handling cannot admit shell execution or other credentials', () => {
  const command = `singularity-flow approve specification --selection-receipt ${receipt}`;
  for (const unsafe of [`${command} && npm test`, `${command} > output.json`, `${command} | cat`,
    `${command}; echo done`, `${command}\nwhoami`, `bash -c '${command}'`,
    `${command} --reason "$(touch unsafe)"`, `${command} --reason "\`touch unsafe\`"`,
    `${command} --token hidden`, `${command} --'token' hidden`, `${command} --password hidden`, `${command} --authorization hidden`,
    `${command} --reason https://user:password@example.test`,
    `${command} --reason '--secret hidden'`]) {
    assert.equal(validateSflowExecutionCommand(unsafe), null, unsafe);
  }
  assert.ok(validateSflowExecutionCommand(`sflow 'approve' 'specification' '--selection-receipt' '${receipt}' '--json'`)?.copyable);
  assert.ok(validateSflowExecutionCommand(`singularity-flow 'approve' 'specification' '--selection-receipt' '${receipt}' '--json'`, { shell: 'powershell' })?.copyable);
  assert.equal(validateSflowExecutionCommand(`${command} --reason '<REASON>'`)?.copyable, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { modelFreeCommandForArgv, modelFreeCommandForCommand, parseModelFreeTarget } from '../src/model-free-commands.mjs';
import { safeCommandGuidance, commandGuidanceForCommands, commandGuidanceLines } from '../src/safe-command-guidance.mjs';

test('model-free presentation preserves supported phase and Story selectors', () => {
  assert.deepEqual(parseModelFreeTarget('custom-build --work-id PILOT-1'), { phase: 'custom-build', workId: 'PILOT-1' });
  for (const [argv, expected] of [
    [['nextsteps', '--json'], '@sflow /next'],
    [['check', '--json'], '@sflow /check'],
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
  assert.equal(safeCommandGuidance({ command: 'singularity-flow check --json' }).copilotCommand, '/sf-check');
  const guidance = safeCommandGuidance({ command: 'singularity-flow approve build --work-id STORY-1 --fetch', modelFreeCommand: '@evil /approve' });
  assert.equal(guidance.modelFreeCommand, '@sflow /approve build --work-id STORY-1');
  const mapped = commandGuidanceForCommands({ publish: 'singularity-flow phase publish build --authored governed-agent --channel copilot-host' });
  assert.equal(mapped.publish.modelFreeCommand, '@sflow /publish build');
  assert.equal(mapped.publish.copilotStatus, 'available');
  assert.equal(mapped.publish.copilotCommand, '/sf-publish build', 'the publish-only journey never re-enters the phase author');
  assert.match(commandGuidanceLines(mapped.publish, 'Publish').join('\n'), /VS Code \(model-free\): @sflow \/publish build/);
});

test('every decision the Decide card records has the card as its routes, never "no verified equivalent" or "not available" beside it [paid run, 2026-11-14]', async () => {
  const { VSCODE_DECIDE_CARD, VSCODE_WITNESS_REVIEW, commandRouteRows } = await import('../src/model-free-commands.mjs');
  const routes = (command) => commandRouteRows(safeCommandGuidance(command)).map((row) => row.command ?? null);
  // A person's own step the card records as the same decision: its Shell line stays theirs, and Copilot and VS Code open the card.
  for (const [command, copilot] of [
    ['singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001 --work-id PAY-1', '/sf-decide PAY-1'],
    ['singularity-flow story intent-amendment decide AMD-001 --decision reject --confirm AMD-001', '/sf-decide'],
    ['singularity-flow story intent-amendment acknowledge AMD-001 --work-id PAY-1', '/sf-decide PAY-1'],
    ['singularity-flow decisions undo PAY-1 --settled STL-001', '/sf-decide PAY-1']
  ]) {
    assert.deepEqual(routes(command), [copilot, command, VSCODE_DECIDE_CARD], command);
    const guidance = safeCommandGuidance(command);
    assert.equal(guidance.skill, '/sf-decide', command);
    // Its own card route asserted is the same route; any other skill still contradicts it.
    assert.equal(safeCommandGuidance({ command, skill: '/sf-decide' })?.copilotCommand, copilot, command);
    assert.equal(safeCommandGuidance({ command, copilotCommand: copilot })?.copilotCommand, copilot, command);
    for (const other of ['/sf-reject', '/sf-amend']) assert.equal(safeCommandGuidance({ command, skill: other }), null, `${command} ${other}`);
  }
  // A decision the card records, whether a /sf-decide turn records it on the card's behalf or only the person may (an
  // accepted risk: its Copilot route stays none, a person's own step): the card is its VS Code route.
  for (const command of ['singularity-flow decision scope PAY-1 --fetch --item SRI-0123456789ab --as excluded --reason "Out of scope."',
    'singularity-flow decision risk PAY-1 --obligation OBL-001 --category evidence --expires 2099-01-01 --reason "Accepted until the lab returns."',
    'singularity-flow decision test-risk PAY-1 --phase build --cause "No browser here." --expires 2099-01-01 --reason "Decided by the approver."',
    'singularity-flow decision test-command PAY-1 --accept TCD-001',
    'singularity-flow story adjudicate CF-1 --disposition dismissed --reason "Not a defect."',
    'singularity-flow decision plan PAY-1 --add-location PAY-1:AC-001=src/a.mjs --reason "The helper implements it."',
    'singularity-flow upstream-issue decide UPI-001 --work-id PAY-1 --outcome return --reason "The design must change first."',
    'singularity-flow upstream-issue revalidate fix-design --work-id PAY-1 --amendment AMD-001 --outcome unchanged --reason "The design holds as written."'
  ]) assert.deepEqual(routes(command).slice(1), [command, VSCODE_DECIDE_CARD], command);
  // A sign-off is the evidence review page's.
  const witness = 'singularity-flow decision witness PAY-1 --criterion PAY-1:AC-001 --slot screen --file e.png --confirm states-the-outcome --reason "Looked."';
  assert.deepEqual(routes(witness), [null, witness, VSCODE_WITNESS_REVIEW]);
  // What the card does not record keeps its routes: correcting a plan's rows in a live terminal, raising an issue,
  // revoking a test command, a finding's risk and an appeal's decision.
  for (const command of ['singularity-flow decision plan PAY-1 --add-row PAY-1:AC-003 --reason "A new clause needs its row."',
    'singularity-flow upstream-issue raise --phase fix-design --about AC-001 --problem "The design names the wrong cause."',
    'singularity-flow decision test-command PAY-1 --revoke TCD-001 --reason "The repository configures this runner now."',
    'singularity-flow decision finding-risk PAY-1 --phase build --finding F-0123456789abcdef --expires 2099-01-01 --reason "The nested branches mirror the table."',
    'singularity-flow story adjudicate --answers /tmp/answers.json'
  ]) assert.equal(routes(command)[2], null, command);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { commandClass } from '../apps/vscode/src/cli/client.ts';
import { canActivateGoal, goalCreateArgs, repairPlanArgs, resetExecuteArgs, resetPlanFingerprint, resetPreviewArgs, SCHEMA_REMEDIES, schemaRecordRemedy, verificationArgv } from '../apps/vscode/src/views/surface-contracts.ts';
import { publicFaultText, publicVerificationArgv } from '../apps/vscode/src/views/surface-adapters.ts';

test('the five parity commands are public VS Code interfaces', async () => {
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  const commands = new Set(manifest.contributes.commands.map((entry) => entry.command));
  for (const command of ['openGoals', 'openFaultRepairs', 'openJournal', 'openDiagnostics', 'openLocalReset']) {
    assert.ok(commands.has(`singularityFlow.${command}`), command);
  }
  assert.ok(commands.has('singularityFlow.returnToWork'), 'returnToWork');
});

test('Goal creation requires observable success and carries an explicit work selection', () => {
  assert.deepEqual(goalCreateArgs({ statement: 'Faster checkout', success: ['p95 < 2s', 'zero regressions'], workId: 'WRK-7', kind: 'story' }),
    ['goal', 'create', 'Faster checkout', '--success', 'p95 < 2s', '--success', 'zero regressions', '--work-id', 'WRK-7', '--kind', 'story', '--json']);
  assert.deepEqual(goalCreateArgs({ statement: 'Explore', success: ['decision recorded'], workId: '', kind: 'none' }),
    ['goal', 'create', 'Explore', '--success', 'decision recorded', '--json']);
  assert.equal(canActivateGoal({ id: 'GOAL-2', status: 'active' }, 'GOAL-1'), true);
  assert.equal(canActivateGoal({ id: 'GOAL-1', status: 'active' }, 'GOAL-1'), false);
  assert.equal(canActivateGoal({ id: 'GOAL-3', status: 'achieved' }, 'GOAL-1'), false);
});

test('repair verification remains structured argv and is never shell-parsed', () => {
  assert.deepEqual(verificationArgv('["npm","test","--","a b"]'), ['npm', 'test', '--', 'a b']);
  assert.equal(verificationArgv('npm test'), null);
  assert.equal(verificationArgv('["npm",7]'), null);
  assert.equal(verificationArgv('["npm","--token","secret-value"]'), null);
  const args = repairPlanArgs({ faultId: 'FLT-1', paths: ['src/'], verification: [['npm', 'test']], maxAttempts: 2, persist: false });
  assert.deepEqual(args, ['fix', 'FLT-1', '--plan-only', '--max-attempts', '2', '--allow-path', 'src/', '--verify-argv', '["npm","test"]', '--json']);
});

test('fault rendering boundary removes host paths', () => {
  assert.equal(publicFaultText('failed at /Users/ashok/secret/file.txt'), 'failed at [local path]');
  assert.equal(publicFaultText('C:\\Users\\ashok\\secret.txt failed'), '[local path] failed');
  assert.equal(publicVerificationArgv(['/opt/homebrew/bin/node', '/Users/ashok/project/test.mjs']), '["node","[local path]"]');
});

test('schema health exposes exact future and archive remedies', () => {
  assert.match(SCHEMA_REMEDIES.future, /upgrade to read it/);
  assert.match(SCHEMA_REMEDIES.older, /archival reader/);
  assert.match(SCHEMA_REMEDIES.older, /governed republication/);
  assert.equal(schemaRecordRemedy(99, 1, 2), SCHEMA_REMEDIES.future);
  assert.equal(schemaRecordRemedy(0, 1, 2), SCHEMA_REMEDIES.older);
});

test('reset modes have different argv and confirmations and no mode is preselected', () => {
  assert.deepEqual(resetPreviewArgs('forget-only'), ['local-reset', '--forget-only', '--dry-run', '--json']);
  assert.deepEqual(resetExecuteArgs('forget-only', 'FORGET LOCAL'), ['local-reset', '--forget-only', '--confirm', 'FORGET LOCAL', '--json']);
  assert.deepEqual(resetExecuteArgs('delete-workspaces', 'RESET LOCAL'), ['local-reset', '--confirm', 'RESET LOCAL', '--json']);
  const preview = { mode: 'forget-only', confirmation: 'FORGET LOCAL', machineTargets: [{ path: '/tmp/state' }], vscodeReset: { marker: '/tmp/reset', reset: ['favorites'] } };
  assert.notEqual(resetPlanFingerprint(preview), resetPlanFingerprint({ ...preview, machineTargets: [{ path: '/tmp/new-state' }] }));
});

test('new CLI reads are classified as reads and mutations remain mutations', () => {
  assert.equal(commandClass(['goal', 'list']), 'read');
  assert.equal(commandClass(['goal', 'create']), 'mutation');
  assert.equal(commandClass(['fix', 'FLT-1', '--plan-only']), 'read');
  assert.equal(commandClass(['repair', 'authorize']), 'mutation');
  assert.equal(commandClass(['journal', 'export', '--dry-run']), 'read');
  assert.equal(commandClass(['local-reset', '--forget-only', '--dry-run']), 'read');
  assert.equal(commandClass(['return', 'WRK-7', '--json']), 'read');
  assert.equal(commandClass(['return', 'WRK-7', '--apply', '--confirm', 'WRK-7', '--json']), 'mutation');
  assert.equal(commandClass(['recover', 'WRK-7', '--phase', 'implementation', '--json']), 'read');
  assert.equal(commandClass(['recover', 'WRK-7', '--apply', '--confirm', 'sha256:plan']), 'mutation');
  assert.equal(commandClass(['wm', 'ast', 'doctor']), 'read');
  assert.equal(commandClass(['wm', 'ast', 'context', '--paths', 'src']), 'read');
  assert.equal(commandClass(['wm', 'ast', 'build', '--paths', 'src']), 'mutation');
  assert.equal(commandClass(['wm', 'ast', 'cache', 'status']), 'read');
  assert.equal(commandClass(['wm', 'ast', 'cache', 'clear']), 'mutation');
  assert.equal(commandClass(['wm', 'ast', 'preference', 'show']), 'read');
  assert.equal(commandClass(['wm', 'ast', 'preference', 'set', 'off']), 'mutation');
  assert.equal(commandClass(['process', 'replay', 'PROC-123456', '--from', 'sha256:checkpoint']), 'mutation');
  assert.equal(commandClass(['process', 'replay', 'PROC-123456', '--confirm', 'sha256:plan']), 'mutation');
  assert.equal(commandClass(['candidate', 'publish', 'CAN-123456']), 'mutation');
  assert.equal(commandClass(['candidate', 'publish', 'CAN-123456', '--confirm', 'sha256:plan']), 'mutation');
  assert.equal(commandClass(['device', 'revoke', 'sha256:manifest']), 'read');
  assert.equal(commandClass(['authority-store', 'recover']), 'read');
  assert.equal(commandClass(['authority-store', 'recover', '--confirm', 'sha256:plan']), 'mutation');
  assert.equal(commandClass(['authority-store', 'inspect', 'authority.json']), 'read');
  assert.equal(commandClass(['authority-store', 'import', 'authority.json']), 'read');
  assert.equal(commandClass(['authority-store', 'import', 'authority.json', '--confirm', 'sha256:plan']), 'mutation');
  assert.equal(commandClass(['authority-store', 'rollback', '--receipt', 'sha256:receipt']), 'read');
  assert.equal(commandClass(['authority-store', 'rollback', '--receipt', 'sha256:receipt', '--confirm', 'sha256:plan']), 'mutation');
  assert.equal(commandClass(['authority-store', 'export', '--out', 'authority.json']), 'mutation');
});

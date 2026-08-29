import assert from 'node:assert/strict';
import test from 'node:test';

import { createProcessBinding, validateProcessBinding } from '../src/sgos/contracts.mjs';
import {
  canonicalizeSgosAbsolutePath,
  resolveSgosLocalAbsolutePath,
  sgosContractPathFromLocal,
  sgosContractPathToLocal
} from '../src/sgos/paths.mjs';

const repositoryIdentity = `sha256:${'1'.repeat(64)}`;

function binding(paths) {
  return createProcessBinding({
    processId: 'PROC-windows-path',
    subjectId: 'PATH-STORY',
    subjectAuthority: null,
    configurationAuthority: null,
    repositoryIdentity,
    ...paths,
    branch: 'feature/windows-path',
    baselineRevision: '0123456789abcdef',
    expectedProcessRevision: 0
  });
}

test('Windows drive paths round-trip through canonical SGOS contract form on every host', () => {
  assert.equal(
    sgosContractPathFromLocal('c:\\Users\\Developer\\repo\\.git', { platform: 'win32' }),
    'C:/Users/Developer/repo/.git'
  );
  assert.equal(
    resolveSgosLocalAbsolutePath('c:\\Users\\Developer\\repo\\feature', { platform: 'win32' }),
    'C:/Users/Developer/repo/feature'
  );
  assert.equal(
    sgosContractPathToLocal('C:/Users/Developer/repo/.git', { platform: 'win32' }),
    'C:\\Users\\Developer\\repo\\.git'
  );
  assert.equal(canonicalizeSgosAbsolutePath('c:/'), 'C:/');

  const record = binding({
    gitCommonDirectory: 'C:/Users/Developer/repo/.git',
    worktreeGitDirectory: 'C:/Users/Developer/repo/.git/worktrees/feature',
    canonicalWorktreeRoot: 'C:/Users/Developer/repo/feature'
  });
  assert.deepEqual(validateProcessBinding(record), record);
  assert.throws(() => binding({
    gitCommonDirectory: 'C:\\Users\\Developer\\repo\\.git',
    worktreeGitDirectory: 'C:/Users/Developer/repo/.git/worktrees/feature',
    canonicalWorktreeRoot: 'C:/Users/Developer/repo/feature'
  }), /canonical absolute path/);
});

test('UNC paths round-trip without losing the server or share boundary', () => {
  const canonical = sgosContractPathFromLocal('\\\\build-server\\worktrees\\payments\\repo', { platform: 'win32' });
  assert.equal(canonical, '//build-server/worktrees/payments/repo');
  assert.equal(
    sgosContractPathFromLocal('\\\\?\\UNC\\build-server\\worktrees\\payments\\repo', { platform: 'win32' }),
    canonical
  );
  assert.equal(
    sgosContractPathToLocal(canonical, { platform: 'win32' }),
    '\\\\build-server\\worktrees\\payments\\repo'
  );
  assert.throws(
    () => sgosContractPathToLocal('//build-server/worktrees/payments/repo', { platform: 'linux' }),
    (error) => error.code === 'SGOS_PATH_PLATFORM_MISMATCH'
  );
});

test('POSIX paths remain canonical and platform mismatches or traversal fail closed', () => {
  assert.equal(sgosContractPathFromLocal('/workspace/repository/.git', { platform: 'darwin' }), '/workspace/repository/.git');
  assert.equal(sgosContractPathToLocal('/workspace/repository/.git', { platform: 'linux' }), '/workspace/repository/.git');
  assert.throws(
    () => sgosContractPathToLocal('/workspace/repository/.git', { platform: 'win32' }),
    (error) => error.code === 'SGOS_PATH_PLATFORM_MISMATCH'
  );
  assert.throws(() => canonicalizeSgosAbsolutePath('C:/repo/../escape'), /traversal/);
  assert.throws(() => canonicalizeSgosAbsolutePath('C:/repo/NUL/report.json'), /unsafe component/);
  assert.throws(() => canonicalizeSgosAbsolutePath('C:/repo/result.json:alternate-stream'), /unsafe component/);
  assert.equal(
    sgosContractPathFromLocal('\\\\?\\C:\\repo\\feature', { platform: 'win32' }),
    'C:/repo/feature'
  );
  assert.throws(() => canonicalizeSgosAbsolutePath('//./C:/repo'), /unsafe component/);
  assert.throws(() => sgosContractPathToLocal('C:\\repo\\.git', { platform: 'win32' }), /canonical/);
  assert.throws(() => sgosContractPathFromLocal('/workspace/repo\\literal-name', { platform: 'linux' }), /backslash/);
  assert.throws(() => resolveSgosLocalAbsolutePath('relative/repository', { platform: 'linux' }), /absolute/);
});

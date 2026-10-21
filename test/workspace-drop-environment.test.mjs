import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { workspaceDropGitEnvironment } from '../src/workspace.mjs';
import { frozenRemoteTransport } from '../src/git-remote-diagnostics.mjs';
import { remoteGitEnvironment } from '../src/git-enterprise-environment.mjs';

test('drop safety overrides remain attested across frozen remote transport without accepting ambient selectors', () => {
  const isolated = workspaceDropGitEnvironment({ ...process.env,
    GIT_DIR: path.join(os.tmpdir(), 'untrusted-git-selector'),
    GIT_INDEX_FILE: path.join(os.tmpdir(), 'untrusted-index-selector'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'untrusted-monitor'
  });
  assert.equal(isolated.GIT_DIR, undefined);
  assert.equal(isolated.GIT_INDEX_FILE, undefined);
  assert.equal(workspaceDropGitEnvironment(isolated), isolated);
  const frozen = frozenRemoteTransport('https://example.invalid/repository.git', { env: isolated });
  assert.equal(remoteGitEnvironment(frozen.env), frozen.env, 'a remote boundary must retain the internal attestation');
  const entries = new Map(Array.from({ length: Number(frozen.env.GIT_CONFIG_COUNT) }, (_, index) =>
    [frozen.env[`GIT_CONFIG_KEY_${index}`], frozen.env[`GIT_CONFIG_VALUE_${index}`]]));
  assert.equal(entries.get('core.fsmonitor'), 'false');
  assert.equal(entries.get('core.untrackedCache'), 'false');
  assert.equal(entries.get('core.ignorecase'), 'false');
  assert.equal(entries.get('http.sslVerify'), 'true');
  assert.equal([...entries.values()].includes('untrusted-monitor'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { releaseChannelManifest } from '../src/release-channel.mjs';

test('the release channel binds runtime compatibility and every artifact byte stream', () => {
  const channel = releaseChannelManifest({
    version: '0.9.0', commit: 'a'.repeat(40), minNode: '>=20', minVSCode: '^1.90.0',
    artifacts: [
      { name: 'sflow.vsix', kind: 'vscode-extension', sha256: '2'.repeat(64) },
      { name: 'sflow.tgz', kind: 'cli-and-copilot-plugin', sha256: '1'.repeat(64) }
    ],
    builtWithNode: 'v22.14.0'
  });
  assert.equal(channel.kind, 'singularity-flow-release-channel');
  assert.deepEqual(channel.compatibility, { node: '>=20', vscode: '^1.90.0' });
  assert.deepEqual(channel.artifacts.map((entry) => entry.name), ['sflow.tgz', 'sflow.vsix']);
  assert.throws(() => releaseChannelManifest({
    version: '0.9.0', commit: 'a'.repeat(40), minNode: '>=20', minVSCode: '^1.90.0',
    artifacts: [{ name: 'broken.vsix', kind: 'vscode-extension', sha256: 'not-a-hash' }]
  }), /SHA-256/);
});

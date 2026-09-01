import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('malformed UTF-8 becomes typed unavailable analysis instead of replacement-character facts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-invalid-utf8-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'tests@example.invalid');
  git(root, 'config', 'user.name', 'WMB Tests');
  await mkdir(path.join(root, 'src'), { recursive: true });
  // This truncated four-byte sequence re-encodes to the same byte length after replacement, so a
  // byte-length round trip cannot detect it. A fatal UTF-8 decoder must.
  await writeFile(path.join(root, 'src', 'invalid.mjs'), Buffer.from([0xf0, 0x90, 0x80]));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'invalid utf8 fixture');

  const registration = runDeterministicRegistration({
    root,
    scopeManifest: createScopeManifest({
      capabilityId: 'invalid-utf8', allowedPaths: ['src/**'],
      allowedSubjects: ['file']
    })
  });
  const unavailable = registration.factLedger.facts.filter((fact) => (
    fact.status === 'unavailable' && fact.subject.id === 'src/invalid.mjs'
  ));
  assert.deepEqual(unavailable.map((fact) => fact.reason.code), ['INVALID_UTF8', 'INVALID_UTF8']);
  assert.ok(registration.factLedger.facts.every((fact) => (
    fact.status === 'unavailable' || !String(fact.claim).includes('\ufffd')
  )));
});

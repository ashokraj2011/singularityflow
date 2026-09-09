import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFile, mkdir, mkdtemp, open, readFile, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeLocArchive, inspectLocArchive } from '../src/local-mode/archive.mjs';
import { canonicalJcs, parseCanonicalJcs } from '../src/local-mode/jcs.mjs';
import {
  auditLocalBundle, createLocalSigner, exportLocalTrustKey, publishLocalBundle,
  reviewLocalCandidate
} from '../src/local-mode/service.mjs';
import {
  createLocalStory, freezeLocalCandidate, openLocalStory, verifyLocalCandidate
} from '../src/local-mode/store.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-mode-'));
  const state = path.join(root, 'state');
  const exports = path.join(root, 'exports');
  const trust = path.join(root, 'trust');
  const input = path.join(root, 'input');
  await Promise.all([
    mkdir(exports, { mode: 0o700 }), mkdir(trust, { mode: 0o700 }),
    mkdir(input, { mode: 0o700 })
  ]);
  await writeFile(path.join(input, 'query.sql'), 'select 1;\n');
  const options = {
    env: {
      ...process.env,
      SINGULARITY_FLOW_LOCAL_MODE_ROOT: state,
      SINGULARITY_FLOW_LOCAL_EXPORT_ROOT: exports
    },
    home: root
  };
  return { root, state, exports, trust, input, options };
}

test('JCS produces stable UTF-8 bytes and refuses non-canonical or invalid values', () => {
  assert.equal(canonicalJcs({ z: 1, a: ['é', true] }), '{"a":["é",true],"z":1}');
  assert.deepEqual(parseCanonicalJcs(Buffer.from('{"a":1,"b":2}')), { a: 1, b: 2 });
  assert.throws(() => parseCanonicalJcs(Buffer.from('{ "a": 1 }')), {
    code: 'LOCAL_RECORD_INVALID'
  });
  assert.throws(() => canonicalJcs({ value: Number.NaN }), {
    code: 'LOCAL_RECORD_INVALID'
  });
  assert.throws(() => canonicalJcs({ value: '\ud800' }), {
    code: 'LOCAL_RECORD_INVALID'
  });
});

test('the registered ZIP STORE writer is deterministic and inspected without extraction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-zip-'));
  const first = path.join(root, 'first.zip');
  const second = path.join(root, 'second.zip');
  const entries = [
    { path: 'outputs/run.sh', mode: '0755', bytes: Buffer.from('#!/bin/sh\n') },
    { path: 'manifest.json', mode: '0644', bytes: Buffer.from('{}') },
    { path: 'manifest.dsse.json', mode: '0644', bytes: Buffer.from('{}') }
  ];
  await writeLocArchive(first, entries);
  await writeLocArchive(second, [...entries].reverse());
  assert.deepEqual(await readFile(first), await readFile(second));
  const inspected = await inspectLocArchive(first);
  assert.equal(inspected.entries.get('outputs/run.sh').mode, '0755');
  assert.equal((await inspected.read('outputs/run.sh')).toString(), '#!/bin/sh\n');
  await inspected.close();
});

test('local L1 creates, reviews, recovers, publishes, and audits outside a product repository', async () => {
  const env = await fixture();
  const started = await createLocalStory({
    name: 'SQL conversion',
    intent: 'Convert the selected SQL into a reviewed output.',
    inputs: [env.input],
    classification: 'internal',
    env: env.options.env,
    home: env.root
  });
  assert.match(started.storyId, /^LOC-[0-9A-F]{32}$/);
  await writeFile(path.join(started.outputDirectory, 'result.sql'), 'select 2;\n');
  const frozen = await freezeLocalCandidate(started.storyId, [], env.options);
  const verified = await verifyLocalCandidate(
    started.storyId, frozen.candidateDigest, env.options
  );
  assert.equal(verified.status, 'verified');
  const signer = await createLocalSigner(started.storyId, 'local-owner', env.options);
  assert.equal(signer.trustScope, 'standalone');
  const trustKey = path.join(env.trust, 'local-owner.pem');
  const exportedTrust = await exportLocalTrustKey(
    started.storyId, 'local-owner', trustKey, env.options
  );
  assert.equal(exportedTrust.created, true);
  const repeatedTrust = await exportLocalTrustKey(
    started.storyId, 'local-owner', trustKey, env.options
  );
  assert.equal(repeatedTrust.idempotent, true);
  const reviewed = await reviewLocalCandidate(
    started.storyId, frozen.candidateDigest, 'local-owner', env.options
  );
  assert.equal(reviewed.status, 'reviewed');
  const published = await publishLocalBundle(
    started.storyId, frozen.candidateDigest, 'local-owner', env.exports, env.options
  );
  assert.equal(published.created, true);
  const repeated = await publishLocalBundle(
    started.storyId, frozen.candidateDigest, 'local-owner', env.exports, env.options
  );
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.archiveSha256, published.archiveSha256);
  const audit = await auditLocalBundle(published.artifact, trustKey, 'local-owner');
  assert.equal(audit.integrity.state, 'passed');
  assert.equal(audit.signatureTrust.state, 'passed');
  assert.equal(audit.evidenceBinding.semanticCorrectness, 'not-claimed');
  assert.equal(audit.historicalPolicy.currentPermission, 'not-evaluated-offline');
  assert.equal(audit.completeness.rerun, 'not_requested');
  assert.equal(audit.completeForProfile, true);
  const opened = await openLocalStory(started.storyId, env.options);
  assert.equal(opened.state.status, 'published');
  assert.equal(opened.state.operations[0].status, 'completed');
  assert.equal(opened.state.deliveries.length, 1);

  const tampered = path.join(env.root, 'tampered.zip');
  await copyFile(published.artifact, tampered);
  const handle = await open(tampered, 'r+');
  try {
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, 40);
    byte[0] ^= 0xff;
    await handle.write(byte, 0, 1, 40);
  } finally { await handle.close(); }
  await assert.rejects(
    auditLocalBundle(tampered, trustKey, 'local-owner'),
    (error) => ['BUNDLE_INTEGRITY_INVALID', 'LOCAL_PATH_INVALID'].includes(error.code)
  );

  const unrelated = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki', format: 'pem'
  });
  const wrongTrust = path.join(env.trust, 'wrong.pem');
  await writeFile(wrongTrust, unrelated);
  await assert.rejects(
    auditLocalBundle(published.artifact, wrongTrust, 'local-owner'),
    { code: 'BUNDLE_INTEGRITY_INVALID' }
  );
});

test('local input capture refuses symbolic links and does not create a Story', {
  skip: process.platform === 'win32' ? 'Windows symlink privileges vary' : false
}, async () => {
  const env = await fixture();
  await symlink(path.join(env.input, 'query.sql'), path.join(env.input, 'alias.sql'));
  await assert.rejects(createLocalStory({
    name: 'unsafe input',
    intent: 'Capture only ordinary input files.',
    inputs: [env.input],
    classification: 'internal',
    env: env.options.env,
    home: env.root
  }), { code: 'LOCAL_PATH_INVALID' });
});

test('local CLI starts outside Git without workspace, model, or remote discovery', async () => {
  const env = await fixture();
  const result = spawnSync(process.execPath, [
    path.join(repository, 'bin', 'singularity-flow.mjs'),
    '--no-model', 'local', 'start', 'standalone',
    '--intent', 'Create a private standalone output.',
    '--input', env.input,
    '--classification', 'confidential', '--json'
  ], {
    cwd: env.root,
    env: env.options.env,
    encoding: 'utf8',
    timeout: 20_000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.status, 'building');
  assert.match(value.storyId, /^LOC-/);
});

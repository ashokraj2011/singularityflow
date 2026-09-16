import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  DISTRIBUTION_OPERATOR_SCRIPTS, inspectDistributionBundle
} from '../src/distribution-bundle.mjs';
import { distributionFixture, fileSha256 } from './helpers/distribution-artifacts.mjs';

async function fixture(t, options) {
  const value = await distributionFixture(options);
  t.after(() => Promise.all([
    rm(value.directory, { recursive: true, force: true }),
    rm(value.keyDirectory, { recursive: true, force: true })
  ]));
  return value;
}

test('promoted distribution admits the exact product pair and canonical operator scripts', async (t) => {
  const item = await fixture(t);
  const bundle = await inspectDistributionBundle(item.directory, {
    trustedPublicKeyPem: await readFile(item.publicKeyPath)
  });
  assert.equal(bundle.version, item.version);
  assert.equal(path.basename(bundle.tarball.path), item.tarballName);
  assert.equal(path.basename(bundle.vsix.path), item.vsixName);
  assert.deepEqual(bundle.operatorScripts.map(({ name }) => name), DISTRIBUTION_OPERATOR_SCRIPTS);
  assert.match(bundle.releaseSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.match(bundle.sumsSha256, /^sha256:[a-f0-9]{64}$/u);
});

test('distribution refuses artifact drift before installation', async (t) => {
  const item = await fixture(t);
  await writeFile(path.join(item.directory, item.tarballName), 'changed');
  const trustedPublicKeyPem = await readFile(item.publicKeyPath);
  await assert.rejects(() => inspectDistributionBundle(item.directory, {
    trustedPublicKeyPem
  }), /digest does not match SHA256SUMS/u);
});

test('distribution refuses a replaced wrapper even when its unsigned checksum is recomputed', async (t) => {
  const item = await fixture(t);
  const name = 'install.sh';
  const replacement = Buffer.from('#!/usr/bin/env bash\necho replaced\n');
  await writeFile(path.join(item.directory, name), replacement);
  const sumsFile = path.join(item.directory, 'SHA256SUMS');
  const sums = (await readFile(sumsFile, 'utf8')).split('\n').map((line) => (
    line.endsWith(`  ${name}`) ? `${fileSha256(replacement)}  ${name}` : line
  )).join('\n');
  await writeFile(sumsFile, sums);
  await assert.rejects(
    () => readFile(item.publicKeyPath).then((trustedPublicKeyPem) => inspectDistributionBundle(
      item.directory, { trustedPublicKeyPem }
    )),
    /does not match the copy embedded in the signed npm package/u
  );
});

test('distribution requires the complete cross-platform operator script set', async (t) => {
  const item = await fixture(t);
  const releaseFile = path.join(item.directory, 'RELEASE.json');
  const release = JSON.parse(await readFile(releaseFile, 'utf8'));
  release.operatorScripts = release.operatorScripts.filter((name) => name !== 'uninstall.ps1');
  await writeFile(releaseFile, `${JSON.stringify(release)}\n`);
  await assert.rejects(() => readFile(item.publicKeyPath).then((trustedPublicKeyPem) => (
    inspectDistributionBundle(item.directory, { trustedPublicKeyPem })
  )), /exact operator script set/u);
});

test('distribution refuses version skew and linked artifact files', async (t) => {
  const skewed = await fixture(t, { vsixVersion: '9.8.6' });
  await assert.rejects(() => readFile(skewed.publicKeyPath).then((trustedPublicKeyPem) => (
    inspectDistributionBundle(skewed.directory, { trustedPublicKeyPem })
  )), /artifact version mismatch/u);

  const linked = await fixture(t);
  const target = path.join(linked.directory, linked.tarballName);
  const moved = `${target}.real`;
  await import('node:fs/promises').then(({ rename }) => rename(target, moved));
  await symlink(moved, target);
  await assert.rejects(() => readFile(linked.publicKeyPath).then((trustedPublicKeyPem) => (
    inspectDistributionBundle(linked.directory, { trustedPublicKeyPem })
  )), /ordinary file|non-symlink/u);
});

test('distribution trust is external and a different builder key is refused', async (t) => {
  const item = await fixture(t);
  const other = await fixture(t);
  const otherPublicKey = await readFile(other.publicKeyPath);
  await assert.rejects(() => inspectDistributionBundle(item.directory, {
    trustedPublicKeyPem: otherPublicKey
  }), /trusted|signer|signature/u);

  const insideKey = path.join(item.directory, 'attacker-selected-public.pem');
  await writeFile(insideKey, await readFile(item.publicKeyPath), { mode: 0o600 });
  const bootstrap = spawnSync(process.execPath, [
    path.join(item.directory, 'bootstrap.mjs'), 'install', '--artifact-key', insideKey, '--dry-run'
  ], { cwd: item.directory, encoding: 'utf8' });
  assert.notEqual(bootstrap.status, 0);
  assert.match(bootstrap.stderr, /public key must remain outside the release directory/u);
});

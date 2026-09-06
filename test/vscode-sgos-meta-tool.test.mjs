import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  metaToolArguments, metaToolPlanReview
} from '../apps/vscode/src/sgos-meta-tool-review-model.ts';

const H = (character) => `sha256:${character.repeat(64)}`;
const common = {
  store: 'repository-platform',
  traceTrust: 'authority/trace-public-keys.json',
  evaluatorTrust: 'authority/evaluator-public-keys.json'
};

test('native Meta-tool review creates the same preview and confirmed activation CLI request', () => {
  const selection = {
    ...common,
    action: 'activate',
    candidateSha256: H('a'),
    evaluationSha256: H('b'),
    promotionSha256: H('c'),
    domain: 'finance',
    operation: 'finance.inspect',
    maximumObservations: 100,
    maximumEvidenceRefs: 8,
    acceptedOutcomes: ['succeeded', 'failed', 'succeeded']
  };
  const preview = metaToolArguments(selection);
  assert.deepEqual(preview, [
    'meta-tool', 'activate', '--store', 'repository-platform',
    '--trace-trust', 'authority/trace-public-keys.json',
    '--evaluator-trust', 'authority/evaluator-public-keys.json',
    '--candidate-sha256', H('a'), '--evaluation-sha256', H('b'),
    '--promotion-sha256', H('c'), '--target-kind', 'pack-operation', '--domain', 'finance',
    '--operation', 'finance.inspect', '--maximum-observations', '100',
    '--maximum-evidence-refs', '8', '--accepted-outcomes', 'failed,succeeded', '--json'
  ]);
  const confirmed = metaToolArguments(selection, H('d'));
  assert.deepEqual(confirmed.slice(0, -3), preview.slice(0, -1));
  assert.deepEqual(confirmed.slice(-3), ['--confirm', H('d'), '--json']);
  assert.equal(confirmed.some((value) => /approval|manifest|authority-sha256/.test(value)), false);

  const device = metaToolArguments({
    ...selection, targetKind: 'device-operation', device: 'filesystem-read',
    operation: 'read-file'
  });
  assert.deepEqual(device.slice(device.indexOf('--target-kind'), device.indexOf('--maximum-observations')), [
    '--target-kind', 'device-operation', '--domain', 'finance',
    '--device', 'filesystem-read', '--operation', 'read-file'
  ]);
  assert.throws(() => metaToolArguments({
    ...selection, targetKind: 'device-operation', operation: 'read-file'
  }), /Device ID is required/);
});

test('native Meta-tool review creates bounded observe, revoke, and rollback requests', () => {
  assert.deepEqual(metaToolArguments({
    ...common, action: 'observe', activationSha256: H('a'), outcome: 'degraded',
    evidenceRefs: [H('c'), H('b'), H('c')]
  }).slice(-5), ['--outcome', 'degraded', '--evidence-refs', `${H('b')},${H('c')}`, '--json']);
  assert.deepEqual(metaToolArguments({
    ...common, action: 'revoke', activationSha256: H('a'), reason: 'withdraw authority'
  }).slice(-5), ['--activation-sha256', H('a'), '--reason', 'withdraw authority', '--json']);
  assert.deepEqual(metaToolArguments({
    ...common, action: 'rollback', operation: 'finance.inspect',
    targetActivationSha256: H('a'), reason: 'regression observed'
  }).slice(-7), [
    '--operation', 'finance.inspect', '--target-activation-sha256', H('a'),
    '--reason', 'regression observed', '--json'
  ]);
  assert.throws(() => metaToolArguments({
    ...common, action: 'observe', activationSha256: H('a'), outcome: 'succeeded',
    evidenceRefs: ['not-a-digest']
  }), /exact SHA-256 digest/);
});

test('native Meta-tool review renders exact plan authority without dumping trust inputs', () => {
  const review = metaToolPlanReview({
    operation: 'meta-tool.activate', actorId: 'principal-123', expectedRevision: 7,
    expectedStateSha256: H('a'), confirmationSha256: H('b'),
    input: { target: {
      kind: 'pack-operation',
      operationId: 'finance.inspect', version: '1.0.0', manifestSha256: H('c'),
      approvalSha256: H('d')
    } }
  });
  assert.match(review, /Authority Store revision: 7/);
  assert.match(review, /Target: pack-operation \/ finance\.inspect/);
  assert.match(review, new RegExp(H('b')));
  assert.doesNotMatch(review, /BEGIN PUBLIC KEY|traceTrust|evaluatorTrust/);
});

test('VS Code contributes and lazily registers the Meta-tool review wizard', async () => {
  const [manifestText, extension] = await Promise.all([
    readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'),
    readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8')
  ]);
  const manifest = JSON.parse(manifestText);
  assert.ok(manifest.contributes.commands.some((entry) =>
    entry.command === 'singularityFlow.reviewSgosMetaTool'));
  assert.match(extension, /'singularityFlow\.reviewSgosMetaTool': async/);
  assert.match(extension, /const \{ showSgosMetaToolReview \} = lazyPanels\(\)/);
});

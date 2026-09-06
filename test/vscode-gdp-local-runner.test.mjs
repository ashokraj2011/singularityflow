import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  localRunnerOptionsArguments, localRunnerPlanArguments, localRunnerPlanReview,
  localRunnerRunArguments, localRunnerSignerArguments, localRunnerVerifyArguments
} from '../apps/vscode/src/gdp-local-runner-review-model.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (character) => `sha256:${character.repeat(64)}`;

const command = {
  phaseId: 'implementation', commandId: 'module-tests', kind: 'test',
  requirement: 'required', modelPolicy: 'never', timeoutMs: 120_000
};
const options = {
  kind: 'gdp-local-runner-options', assurance: 'developer-local-signed',
  authority: 'developer-local', gateEligible: false, consumedByLifecycle: false,
  identity: {
    workId: 'WRK-9', status: 'ready', candidateSha256: digest('a'),
    proofSubjectSha256: digest('b')
  },
  commands: [command], excluded: [], gaps: [], defaultSigner: 'developer-local'
};

test('local runner UI derives plan identities from the engine projection', () => {
  assert.deepEqual(localRunnerOptionsArguments('WRK-9'), [
    'delivery', 'local-runner-options', '--work-id', 'WRK-9', '--json'
  ]);
  assert.deepEqual(localRunnerPlanArguments(options, command, 'developer-local'), [
    'delivery', 'local-runner-plan', '--signer', 'developer-local',
    '--work-id', 'WRK-9', '--phase', 'implementation', '--command', 'module-tests',
    '--proof-subject', digest('b'), '--candidate', digest('a'), '--json'
  ]);
  assert.throws(() => localRunnerPlanArguments(
    { ...options, identity: { ...options.identity, candidateSha256: null } },
    command, 'developer-local'
  ), /no exact Candidate/);
  assert.throws(() => localRunnerPlanArguments(
    options, { ...command, commandId: 'caller-command' }, 'developer-local'
  ), /not in the engine-projected/);
});

test('local runner execution and verification remain structured and path-bounded', () => {
  assert.deepEqual(localRunnerSignerArguments('create', 'developer-local'), [
    'delivery', 'local-runner-create', '--signer', 'developer-local', '--json'
  ]);
  assert.deepEqual(localRunnerRunArguments(options, command, 'developer-local', digest('c')), [
    'delivery', 'local-runner-run', '--signer', 'developer-local',
    '--work-id', 'WRK-9', '--phase', 'implementation', '--command', 'module-tests',
    '--proof-subject', digest('b'), '--candidate', digest('a'),
    '--confirm-plan', digest('c'), '--json'
  ]);
  assert.deepEqual(localRunnerVerifyArguments(
    'singularity/work-items/WRK-9/gdp/evidence/local-runner-attestation/receipt.json',
    'developer-local'
  ), [
    'delivery', 'local-runner-verify', '--attestation-file',
    'singularity/work-items/WRK-9/gdp/evidence/local-runner-attestation/receipt.json',
    '--signer', 'developer-local', '--json'
  ]);
  assert.throws(() => localRunnerVerifyArguments('../receipt.json', 'developer-local'),
    /canonical repository-relative/);
});

test('local runner modal renders exact authority facts and permanent non-gating limits', () => {
  const review = localRunnerPlanReview({
    kind: 'gdp-local-runner-plan', workId: 'WRK-9', phaseId: 'implementation',
    commandId: 'module-tests', signerId: 'developer-local',
    proofSubjectSha256: digest('b'), candidateSha256: digest('a'),
    repositoryHead: '1'.repeat(40), repositoryTree: '2'.repeat(40),
    command: { argv: ['npm', 'test'], timeoutMs: 120_000, modelPolicy: 'never' },
    commandSha256: digest('d'), signerKeySha256: digest('e'), planSha256: digest('f')
  });
  assert.match(review, /developer-local-signed \(never a lifecycle gate\)/);
  assert.match(review, /Command: \["npm","test"\]/);
  assert.match(review, new RegExp(digest('a')));
  assert.match(review, new RegExp(digest('b')));
  assert.match(review, /cannot provide independent approval/);
});

test('VS Code contributes and lazily registers the local runner journey', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'apps/vscode/package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) =>
    entry.command === 'singularityFlow.reviewLocalRunner'));
  const extension = await readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8');
  assert.match(extension, /'singularityFlow\.reviewLocalRunner': async/);
  assert.match(extension, /const \{ showGdpLocalRunnerReview \} = lazyPanels\(\)/);
  const review = await readFile(path.join(root, 'apps/vscode/src/gdp-local-runner-review.ts'), 'utf8');
  assert.doesNotMatch(review, /writeFile|unlink|randomUUID/,
    'the native journey must not stage a crash-leaking plan in the working tree');
  assert.doesNotMatch(review, /shell:\s*true|exec\(|spawn\(/);
});

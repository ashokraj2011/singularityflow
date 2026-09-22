import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { autoEnvironmentRequirements } from '../src/auto/auto-plan.mjs';
import { buildAutoPlanPacket } from '../src/auto/auto-plan-packet.mjs';
import {
  bindEnvironment, environmentBindingStatus, resolveEnvironmentBinding
} from '../src/environment-bindings.mjs';
import {
  environmentWorldModelExcludedRoots, loadEnvironmentDeclarationSync,
  parseEnvironmentDeclaration
} from '../src/environment-declaration.mjs';
import { normalizeExternalCommand } from '../src/external-command-policy.mjs';
import { environmentQualityCommandBlock } from '../src/state.mjs';
import {
  assembleWmbV4Prompt
} from '../src/world-model/compose/pinned-core.mjs';
import { renderDeterministicCandidate } from '../src/world-model/compose/candidate.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import {
  createWorldModelConsumerProfile, createWorldModelOutputBudget,
  createWorldModelViewOutputBudget
} from '../src/world-model/plan.mjs';
import { resolveBuiltInViewContract } from '../src/world-model/registry/views.mjs';
import { configuredWorldModelV4ScopeOptions } from '../src/world-model/scope/configuration.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t, declaration) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-env-packet-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'environment-packet@example.invalid');
  git(root, 'config', 'user.name', 'Environment Packet');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'environments.yml'), declaration);
  return root;
}

const DECLARATION = `schemaVersion: 1
environments:
  qa:
    requires:
      - name: API_BASE_URL
        kind: endpoint
        value: https://qa.shared.example.test
      - name: API_TOKEN
        kind: secret
      - name: FEATURE_SWITCH
        kind: flag
    localFiles:
      - config/qa.local.yml
checks:
  integration-tests:
    environment: qa
neverCommit:
  - .env.*
`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('Auto Plan packet lists only names-only environment prerequisites', () => {
  const declaration = parseEnvironmentDeclaration(Buffer.from(DECLARATION));
  const requiredEnvironments = autoEnvironmentRequirements([
    {
      phase: 'implementation',
      commands: [{
        id: 'integration-tests', kind: 'test', argv: ['npm', 'test'], modelPolicy: 'never'
      }]
    },
    {
      phase: 'verification',
      commands: [{
        id: 'browser-tests', kind: 'test', argv: ['npm', 'run', 'test:e2e'],
        modelPolicy: 'never', environment: 'qa'
      }]
    }
  ], declaration);
  assert.deepEqual(requiredEnvironments, [{
    name: 'qa',
    declarationSha256: declaration.declarationSha256,
    phaseIds: ['implementation', 'verification'],
    commandIds: ['browser-tests', 'integration-tests'],
    requiredBindings: [
      { name: 'API_BASE_URL', kind: 'endpoint' },
      { name: 'API_TOKEN', kind: 'secret' },
      { name: 'FEATURE_SWITCH', kind: 'flag' }
    ]
  }]);

  const plan = {
    planId: `APL-${'A'.repeat(26)}`,
    planSha256: `sha256:${'a'.repeat(64)}`,
    requirement: {}, proposal: {}, story: { phaseRail: ['implementation', 'verification'] },
    execution: {
      profile: { resolved: 'story' }, pace: {}, until: {},
      repair: { policy: 'ask', maximumAttempts: 0 }, requiredEnvironments
    },
    executionHost: { id: 'copilot-cli' }, scope: {}, humanBoundaries: {}
  };
  const packet = buildAutoPlanPacket(plan, { validationSha256: `sha256:${'b'.repeat(64)}` });
  assert.deepEqual(packet.execution.requiredEnvironments, requiredEnvironments);
  const serialized = JSON.stringify(packet);
  assert.doesNotMatch(serialized, /qa\.shared\.example\.test|vault:\/\/|bindingRevision|fingerprintSha256|value|reference/u);

  const legacy = structuredClone(plan);
  delete legacy.execution.requiredEnvironments;
  assert.equal(Object.hasOwn(buildAutoPlanPacket(
    legacy, { validationSha256: `sha256:${'b'.repeat(64)}` }
  ).execution, 'requiredEnvironments'), false, 'historical packet identities remain unchanged');
});

test('registered-v4 composition packets and rendered candidates exclude environment-local bytes', async (t) => {
  const root = await repository(t, DECLARATION);
  const secret = 'packet-local-secret-value';
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'src', 'service.mjs'), [
    'export function total(left, right) {',
    '  return left + right;',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(root, '.env.qa'), `API_TOKEN=${secret}\n`);
  await writeFile(path.join(root, 'config', 'qa.local.yml'), `token: ${secret}\n`);
  // Raw Git represents a legacy repository which tracked these files before ENV admission existed.
  git(root, 'add', '-f', '.');
  git(root, 'commit', '-qm', 'legacy environment-local fixture');
  await writeFile(path.join(root, 'src', 'service.mjs'), [
    'export function total(left, right) {',
    '  return Number(left) + Number(right);',
    '}',
    ''
  ].join('\n'));
  git(root, 'add', 'src/service.mjs');
  git(root, 'commit', '-qm', 'change application source');

  const scopeManifest = createScopeManifest(configuredWorldModelV4ScopeOptions(root, {
    definition: { worldModel: {
      excludedRoots: environmentWorldModelExcludedRoots(
        loadEnvironmentDeclarationSync(root, { optional: true })
      )
    } },
    repositoryCapability: { id: 'packet-safety' }
  }));
  const registration = runDeterministicRegistration({
    root, scopeManifest, requestedViews: ['dev.impact@4']
  });
  const contract = resolveBuiltInViewContract('dev.impact@4');
  const outputBudget = createWorldModelViewOutputBudget(
    createWorldModelOutputBudget([contract]), contract
  );
  const assembled = await assembleWmbV4Prompt({
    viewContract: contract,
    scopeManifest,
    viewFactLedger: registration.viewFactLedgers[0],
    evidenceCatalog: registration.evidenceCatalog,
    consumerProfile: createWorldModelConsumerProfile(),
    outputBudget
  });
  const factPacket = assembled.regions.find((region) => region.id === 'composition-fact-packet');
  assert.ok(factPacket, 'composition must expose one bounded Fact packet');
  const candidate = renderDeterministicCandidate(contract, registration.viewFactLedgers[0]);
  const serialized = JSON.stringify({
    packet: factPacket.text,
    contextManifest: assembled.contextManifest,
    evidence: assembled.regions.find((region) => region.id === 'evidence-catalog')?.text,
    candidate,
    registrationFacts: registration.viewFactLedgers[0]
  });
  for (const forbidden of [
    '.env.qa', 'config/qa.local.yml', secret, sha256(secret)
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden.replaceAll('.', '\\.')));
  assert.doesNotMatch(assembled.prompt, new RegExp(secret));
  assert.match(
    assembled.regions.find((region) => region.id === 'scope-manifest')?.text ?? '',
    /config\/qa\.local\.yml/,
    'the model sees the exclusion rule, never bytes or evidence from the excluded file'
  );
  assert.match(serialized, /src\/service\.mjs/);
});

test('public environment projections and quality receipts omit values, hashes, and references', async (t) => {
  const root = await repository(t, DECLARATION);
  const endpoint = 'https://qa.private.example.test';
  const secret = 'private-runtime-token-value';
  const reference = 'vault://teams/payments/feature-switch';
  await bindEnvironment(root, 'qa', {
    bindings: {
      API_BASE_URL: { source: 'local', value: endpoint },
      API_TOKEN: { source: 'local', value: secret },
      FEATURE_SWITCH: { source: 'reference', reference }
    }
  });
  const resolution = await resolveEnvironmentBinding(root, 'qa');
  const status = await environmentBindingStatus(root);
  const policy = normalizeExternalCommand({
    id: 'integration-tests', kind: 'test', argv: ['npm', 'test'],
    modelPolicy: 'never', environment: 'qa'
  });
  const check = await environmentQualityCommandBlock(root, policy, {
    sourceCommit: 'a'.repeat(40),
    sourceTreeSha256: `sha256:${'c'.repeat(64)}`,
    startedAt: '2026-09-22T00:00:00.000Z'
  });
  assert.equal(resolution.status, 'unavailable', 'opaque references remain unresolved in this release');
  assert.equal(check.status, 'blocked');
  assert.deepEqual(check.environment.boundNames, [
    'API_BASE_URL', 'API_TOKEN', 'FEATURE_SWITCH'
  ]);
  assert.deepEqual(check.environment.secretsPresent, ['API_TOKEN']);
  assert.match(check.environment.endpointsSha256, /^sha256:[a-f0-9]{64}$/);
  const serialized = JSON.stringify({ resolution, status, check });
  for (const forbidden of [
    endpoint, secret, reference, sha256(endpoint), sha256(secret), sha256(reference)
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden.replaceAll('.', '\\.')));
  assert.doesNotMatch(serialized, /"(?:value|reference|bindings)"/u);
});

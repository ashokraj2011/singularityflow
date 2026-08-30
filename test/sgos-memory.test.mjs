import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/records.mjs';
import { sha256 } from '../src/sgos/contracts.mjs';
import {
  composeSgosRuntimeWorkingSet,
  composeSgosWorkingSet,
  createSgosMemoryRef,
  MAXIMUM_SGOS_WORKING_SET_BYTES,
  SGOS_WORKING_SET_PRIORITIES,
  validateSgosMemoryRef,
  validateSgosWorkingSet
} from '../src/sgos/memory.mjs';
import {
  createSecretBrokerAttestation,
  createSecretBrokerRegistry,
  createSecretHandle,
  platformSha256,
  signPlatformRecord
} from '../src/sgos/platform/index.mjs';

const H = (value) => sha256(`memory-test:${value}`);

function ref(id, payload, {
  memoryClass = 'input', authority = 'immutable-input', sensitivity = 'internal'
} = {}) {
  const bytes = Buffer.from(typeof payload === 'string' ? payload : canonicalJson(payload));
  return createSgosMemoryRef({
    address: `sfref:v1:test:${id}`,
    memoryClass,
    object: { schema: 'test', revision: 1, sha256: sha256(bytes), bytes: bytes.length },
    authority,
    sensitivity,
    storage: { storeId: 'test-store' },
    dependencies: [],
    expansionHandle: `sfref:v1:test:${id}:expand`
  });
}

function source(id, payload, options = {}) {
  const memoryRef = ref(id, payload, options);
  return { ref: memoryRef, payload, expansionHandle: memoryRef.expansionHandle };
}

function compose(sources, maximumBytes = 64 * 1024) {
  return composeSgosWorkingSet({
    processId: 'PROC-MEMORY-1', taskInstanceId: 'TSK-MEMORY-1',
    checkpointSha256: H('checkpoint'), programSha256: H('program'),
    policySnapshotSha256: H('policy'), taskContractSha256: H('task-contract'),
    sources, maximumBytes
  });
}

test('working-set composition is deterministic, priority ordered, bounded, and omission-complete', () => {
  const sources = {
    'approved-guidance': [source('guidance', 'approved guidance', {
      memoryClass: 'approved-guidance', authority: 'approved-guidance'
    })],
    'active-human-instruction': [source('human', 'current instruction', {
      memoryClass: 'process', authority: 'process-boundary'
    })],
    'historical-context': [source('history', 'h'.repeat(10_000), {
      memoryClass: 'external', authority: 'external-observation'
    })]
  };
  const first = compose(sources, 4096);
  const second = compose({
    'historical-context': [...sources['historical-context']],
    'active-human-instruction': [...sources['active-human-instruction']],
    'approved-guidance': [...sources['approved-guidance']]
  }, 4096);
  assert.deepEqual(first, second);
  assert.equal(first.entries[0].priority, 'active-human-instruction');
  assert.equal(first.omissions.length, 1);
  assert.deepEqual(Object.keys(first.omissions[0]).sort(), [
    'expansionHandle', 'priority', 'reason', 'size', 'sourceIdentity'
  ]);
  assert.equal(first.omissions[0].reason, 'budget-exceeded');
  assert.ok(Buffer.byteLength(canonicalJson(first)) <= first.maximumBytes);
  assert.deepEqual(validateSgosWorkingSet(JSON.parse(JSON.stringify(first)), {
    checkpointSha256: H('checkpoint')
  }), first);
});

test('working sets reject tampering, stale checkpoints, oversize budgets, and secret-shaped payloads', () => {
  const workingSet = compose({
    'direct-source-context': [source('source', { path: 'src/a.mjs' })]
  });
  const changed = structuredClone(workingSet);
  changed.entries[0].payload.path = 'src/b.mjs';
  assert.throws(() => validateSgosWorkingSet(changed), (error) => [
    'SGOS_MEMORY_PAYLOAD_MISMATCH', 'SGOS_WORKING_SET_TAMPERED'
  ].includes(error.code));
  assert.throws(() => validateSgosWorkingSet(workingSet, { checkpointSha256: H('later') }),
    (error) => error.code === 'SGOS_WORKING_SET_CHECKPOINT_STALE');
  assert.throws(() => composeSgosWorkingSet({
    processId: 'PROC-MEMORY-1', taskInstanceId: 'TSK-MEMORY-1',
    checkpointSha256: H('checkpoint'), programSha256: H('program'),
    policySnapshotSha256: H('policy'), taskContractSha256: H('task-contract'),
    sources: {}, maximumBytes: MAXIMUM_SGOS_WORKING_SET_BYTES + 1
  }), (error) => error.code === 'SGOS_WORKING_SET_BUDGET_INVALID');
  const secretPayload = { credential: 'must-not-enter-a-prompt' };
  assert.throws(() => compose({
    'direct-source-context': [source('unsafe', secretPayload)]
  }), (error) => error.code === 'SGOS_WORKING_SET_SECRET_REFUSED');
  const providerToken = ['ghp', 'A'.repeat(36)].join('_');
  assert.throws(() => compose({
    'direct-source-context': [source('unsafe-value', {
      note: `Use this value for the request: ${providerToken}`
    })]
  }), (error) => error.code === 'SGOS_WORKING_SET_SECRET_REFUSED'
    && !error.message.includes(providerToken));
  const forgedSource = source('forged-secret-value', providerToken);
  const forgedWorkingSet = structuredClone(workingSet);
  forgedWorkingSet.entries[0] = {
    priority: 'direct-source-context', ref: forgedSource.ref, payload: providerToken
  };
  forgedWorkingSet.payloadBytes = Buffer.byteLength(providerToken);
  forgedWorkingSet.workingSetSha256 = sha256({
    ...forgedWorkingSet, workingSetSha256: null
  });
  assert.throws(() => validateSgosWorkingSet(forgedWorkingSet),
    (error) => error.code === 'SGOS_WORKING_SET_SECRET_REFUSED'
      && !error.message.includes(providerToken));
  const privateKey = ['-----BEGIN PRIVATE KEY-----', 'invented-material',
    '-----END PRIVATE KEY-----'].join('\n');
  assert.throws(() => compose({
    'direct-source-context': [source('unsafe-nested-value', {
      connection: { material: privateKey }
    })]
  }), (error) => error.code === 'SGOS_WORKING_SET_SECRET_REFUSED'
    && !error.message.includes('invented-material'));
  const benignPayload = {
    guidance: 'Never include secrets, passwords, or credentials in a prompt.',
    reference: 'https://user:example-password@example.com/documentation',
    placeholder: '${APP_TOKEN}'
  };
  const benign = compose({
    'direct-source-context': [source('benign-security-guidance', benignPayload)]
  });
  assert.deepEqual(benign.entries[0].payload, benignPayload);
  const expansion = source('expansion', 'bounded');
  assert.throws(() => compose({
    'direct-source-context': [{ ...expansion, expansionHandle: 'sfref:v1:other:expand' }]
  }), (error) => error.code === 'SGOS_MEMORY_EXPANSION_HANDLE_MISMATCH');
  const emptyWithWrongDigest = createSgosMemoryRef({
    address: 'sfref:v1:test:empty-wrong-digest', memoryClass: 'input',
    object: { schema: 'test', revision: 1, sha256: H('not-empty'), bytes: 0 },
    authority: 'immutable-input', sensitivity: 'internal', storage: { storeId: 'test-store' },
    dependencies: [], expansionHandle: 'sfref:v1:test:empty-wrong-digest:expand'
  });
  assert.throws(() => compose({
    'direct-source-context': [{
      ref: emptyWithWrongDigest, payload: null,
      expansionHandle: emptyWithWrongDigest.expansionHandle
    }]
  }), (error) => error.code === 'SGOS_MEMORY_PAYLOAD_MISMATCH');
});

test('opaque secret handles are immutable references but are always omitted from ordinary working sets', () => {
  const secret = createSgosMemoryRef({
    address: `sfref:v1:secret-handle:${H('handle')}`,
    memoryClass: 'secret-handle',
    object: { schema: 'secret-handle', revision: 1, sha256: H('opaque'), bytes: 0 },
    authority: 'secret-broker', sensitivity: 'restricted',
    storage: { storeId: 'secret-broker' }, dependencies: [],
    expansionHandle: 'secret-broker:resolve'
  });
  assert.deepEqual(validateSgosMemoryRef(secret), secret);
  const workingSet = compose({
    'direct-source-context': [{
      ref: secret, payload: null, expansionHandle: secret.expansionHandle
    }]
  });
  assert.equal(workingSet.entries.length, 0);
  assert.equal(workingSet.omissions[0].reason, 'secret-isolated');
  assert.doesNotMatch(JSON.stringify(workingSet), /must-not-enter-a-prompt/);
});

test('runtime composition binds the current checkpoint and incorporates exact dependency and guidance refs', () => {
  const checkpoint = {
    kind: 'gvm-checkpoint', checkpointSha256: H('checkpoint'), processId: 'PROC-MEMORY-1',
    programSha256: H('program'), policySnapshotSha256: H('policy')
  };
  const predecessorId = 'TSK-PREDECESSOR';
  const task = {
    taskInstanceId: 'TSK-CURRENT', predecessorTaskInstanceIds: [predecessorId],
    inputRefs: ['legacy-symbolic-input', H('source')]
  };
  const process = {
    processId: checkpoint.processId, currentCheckpointSha256: checkpoint.checkpointSha256,
    programSha256: checkpoint.programSha256, policySnapshotSha256: checkpoint.policySnapshotSha256,
    taskContractSha256: H('task-contract'),
    taskInstances: {
      [predecessorId]: { state: 'succeeded', outputRefs: [H('dependency')] },
      [task.taskInstanceId]: task
    }
  };
  const template = {
    taskTemplateId: 'current', operation: 'test.current', intentClauseIds: ['AC-1'],
    metadata: { parameters: { objective: 'Verify memory' }, memory: {
      approvedGuidanceRefs: [H('guidance')], derivedRefs: [H('derived')]
    } }
  };
  const workingSet = composeSgosRuntimeWorkingSet({
    process, checkpoint, task, template, program: { budgets: {} }
  });
  assert.equal(workingSet.checkpointSha256, checkpoint.checkpointSha256);
  assert.deepEqual(workingSet.entries.map((entry) => entry.priority), [
    'task-contract', 'pinned-law', 'objective-acceptance', 'direct-source-context',
    'dependency-output', 'derived-memory', 'approved-guidance'
  ]);
  assert.match(JSON.stringify(workingSet), new RegExp(H('dependency').replace(':', '\\:')));
  assert.match(JSON.stringify(workingSet), new RegExp(H('guidance').replace(':', '\\:')));
  assert.doesNotMatch(JSON.stringify(workingSet), /legacy-symbolic-input/);
  assert.deepEqual(SGOS_WORKING_SET_PRIORITIES.slice(0, 4), [
    'active-human-instruction', 'task-contract', 'pinned-law', 'objective-acceptance'
  ]);
});

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

function secretFixture({ resolver, authorized = true } = {}) {
  const issuer = keys();
  const attestation = createSecretBrokerAttestation({
    brokerId: 'broker-local', purposes: ['database-read'], audiences: ['task-runner'],
    validFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z',
    issuerKeyId: 'broker-issuer'
  });
  const signedAttestation = signPlatformRecord(attestation, {
    privateKeyPem: issuer.privateKeyPem, keyId: 'broker-issuer'
  });
  const manifestSha256 = platformSha256('secret-aware-adapter');
  const registry = createSecretBrokerRegistry({
    trustedIssuers: { 'broker-issuer': issuer.publicKeyPem },
    resolvers: resolver ? { 'broker-local': resolver } : {},
    authorizedAdapters: authorized ? {
      'database-device': {
        manifestSha256, brokerIds: ['broker-local'], purposes: ['database-read'],
        audiences: ['task-runner']
      }
    } : {}
  });
  registry.registerBroker(signedAttestation);
  const handleRecord = createSecretHandle({
    handleId: 'handle-production-database', brokerId: 'broker-local',
    brokerAttestationSha256: attestation.recordSha256,
    opaqueReferenceSha256: platformSha256('vault-internal-reference'),
    purpose: 'database-read', audience: 'task-runner',
    expiresAt: '2029-01-01T00:00:00.000Z', attestedAt: '2026-01-02T00:00:00.000Z'
  });
  const signedHandle = signPlatformRecord(handleRecord, {
    privateKeyPem: issuer.privateKeyPem, keyId: 'broker-issuer'
  });
  const handle = registry.registerHandle(signedHandle);
  return { registry, handle, manifestSha256 };
}

test('Secret Broker releases mutable bytes only to an exact authorized adapter and scrubs both buffers', async () => {
  const resolverBuffers = [];
  const callbackBuffers = [];
  const { registry, handle, manifestSha256 } = secretFixture({
    resolver() {
      const value = Buffer.from('database-password-value');
      resolverBuffers.push(value);
      return value;
    }
  });
  const release = (suffix) => registry.withEphemeralSecret(handle.recordSha256, {
    purpose: 'database-read', audience: 'task-runner', adapterId: 'database-device',
    adapterManifestSha256: manifestSha256
  }, async (secret, authority) => {
    callbackBuffers.push(secret);
    assert.equal(secret.toString(), 'database-password-value');
    assert.match(authority.authorizationSha256, /^sha256:/);
    await new Promise((resolve) => setImmediate(resolve));
    return { rows: 1, request: suffix };
  });
  const [left, right] = await Promise.all([release('left'), release('right')]);
  assert.deepEqual([left.result.request, right.result.request].sort(), ['left', 'right']);
  assert.notEqual(callbackBuffers[0], callbackBuffers[1]);
  for (const buffer of [...resolverBuffers, ...callbackBuffers]) {
    assert.ok(buffer.every((byte) => byte === 0), 'ephemeral secret bytes must be overwritten');
  }
  const serialized = JSON.stringify({ left, right, snapshot: registry.snapshot() });
  assert.doesNotMatch(serialized, /database-password-value|ZGF0YWJhc2UtcGFzc3dvcmQtdmFsdWU=/);
  assert.equal(left.release.secretBytes, null);
});

test('Secret Broker fails closed for missing/stale authority and adapter result leakage', async () => {
  const unavailable = secretFixture();
  await assert.rejects(() => unavailable.registry.withEphemeralSecret(
    unavailable.handle.recordSha256,
    { purpose: 'database-read', audience: 'task-runner', adapterId: 'database-device',
      adapterManifestSha256: unavailable.manifestSha256 }, async () => ({ ok: true })
  ), (error) => error.code === 'SGOS_SECRET_RELEASE_UNAVAILABLE');

  const unauthorized = secretFixture({ resolver: () => Buffer.from('credential-value'), authorized: false });
  await assert.rejects(() => unauthorized.registry.withEphemeralSecret(
    unauthorized.handle.recordSha256,
    { purpose: 'database-read', audience: 'task-runner', adapterId: 'database-device',
      adapterManifestSha256: unauthorized.manifestSha256 }, async () => ({ ok: true })
  ), (error) => error.code === 'SGOS_SECRET_ADAPTER_UNAUTHORIZED');

  const leaking = secretFixture({ resolver: () => Buffer.from('credential-value') });
  await assert.rejects(() => leaking.registry.withEphemeralSecret(
    leaking.handle.recordSha256,
    { purpose: 'database-read', audience: 'task-runner', adapterId: 'database-device',
      adapterManifestSha256: leaking.manifestSha256 },
    async (secret) => ({ diagnostic: secret.toString() })
  ), (error) => error.code === 'SGOS_SECRET_RESULT_LEAK');
  leaking.registry.revokeHandle(leaking.handle.recordSha256);
  await assert.rejects(() => leaking.registry.withEphemeralSecret(
    leaking.handle.recordSha256,
    { purpose: 'database-read', audience: 'task-runner', adapterId: 'database-device',
      adapterManifestSha256: leaking.manifestSha256 }, async () => ({ ok: true })
  ), (error) => error.code === 'SGOS_SECRET_HANDLE_REVOKED');
});

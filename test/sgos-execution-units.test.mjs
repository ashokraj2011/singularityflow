import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertModelInvocationAllowed } from '../src/operation-context.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import {
  MAXIMUM_AGENT_PROPOSAL_OUTPUT_BYTES, sha256
} from '../src/sgos/contracts.mjs';
import {
  createAgentTaskContract,
  createCopilotExecutionUnit,
  createDeterministicTranslatorExecutionUnit,
  createExecutionUnitManifest,
  createGenericProcessExecutionUnit,
  validateExecutionUnitManifest
} from '../src/sgos/execution-units.mjs';

function contract(manifest, overrides = {}) {
  return createAgentTaskContract({
    taskId: 'task-1', processId: 'PROC-123456', instructionId: 'instruction-1',
    objective: 'Produce a bounded candidate.', acceptanceClauses: ['AC-1'],
    policySnapshotSha256: sha256('policy'), programSha256: sha256('program'),
    inputs: [], readScope: [], writeScope: [], forbiddenScope: ['.git'], allowedDevices: [],
    environmentManifestSha256: sha256('environment'), candidatePolicy: 'immutable-snapshot',
    outputSchema: { type: 'object' }, requiredEvidence: ['candidate-snapshot'],
    budgets: { activeMinutes: 1, modelInvocations: 1, touchedResources: 2 },
    stopConditions: ['scope-expansion'], humanRequestPolicy: {}, subagentPolicy: {},
    rawEvidencePolicy: {}, executionUnitManifestSha256: manifest.manifestSha256,
    ...overrides
  });
}

test('Execution Unit manifests and Agent Task Contracts are exact and tamper-evident', () => {
  const manifest = createExecutionUnitManifest({
    id: 'fixture-unit', version: '1.0.0', publisher: 'fixture', provider: 'local', models: [],
    capabilities: {}, sandbox: {}, network: {}, toolPolicy: {}, risk: {},
    tests: { conformanceReceiptSha256: sha256('conformance') }
  });
  assert.equal(validateExecutionUnitManifest(manifest).manifestSha256, manifest.manifestSha256);
  assert.throws(() => validateExecutionUnitManifest({ ...manifest, provider: 'forged' }),
    (error) => error.code === 'SGOS_GEU_MANIFEST_MISMATCH');
  const task = contract(manifest);
  assert.match(task.contractSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(task.acceptanceClauses), true);
  assert.equal(Object.isFrozen(manifest.capabilities), true);
  assert.throws(() => contract(manifest, { candidatePolicy: 'mutable-worktree' }),
    (error) => error.code === 'SGOS_AGENT_TASK_CONTRACT_INVALID');
});

test('deterministic GEU exposes ordered evidence, quiescence, and a candidate-only result', async () => {
  const unit = createDeterministicTranslatorExecutionUnit();
  const manifest = unit.descriptor();
  const handle = await unit.start(contract(manifest));
  const events = [];
  for await (const entry of unit.observe(handle)) events.push(entry);
  const quiescence = await unit.quiesce(handle);
  const result = await unit.collect(handle);
  assert.deepEqual(events.map((entry) => entry.type), ['started', 'completed']);
  assert.equal(events[0].priorEventSha256, null);
  assert.equal(events[1].priorEventSha256, events[0].eventSha256,
    'the event head must cryptographically bind the ordered history');
  assert.equal(quiescence.quiescent, true);
  assert.equal(result.executionUnitManifestSha256, manifest.manifestSha256);
  assert.equal(result.output.objective, 'Produce a bounded candidate.');
  assert.deepEqual(result.usage, { modelInvocations: 0, assurance: 'deterministic' });
  assert.equal(Object.hasOwn(result, 'verification'), false,
    'an Execution Unit candidate cannot declare task completion authority');
  await assert.rejects(unit.collect({ handleSha256: handle.handleSha256 }),
    (error) => error.code === 'SGOS_GEU_HANDLE_STALE',
    'a digest alone is not an exact adapter handle');
  const lateStop = await unit.requestStop(handle, { reason: 'already complete' });
  assert.equal(lateStop.acknowledged, false);
  assert.deepEqual(await unit.requestStop(handle, { reason: 'already complete' }), lateStop,
    'stop retries must return the exact first receipt');
  await assert.rejects(unit.requestStop(handle, { reason: 'different decision' }),
    (error) => error.code === 'SGOS_GEU_STOP_CONFLICT');
  assert.deepEqual(await unit.quiesce(handle), quiescence,
    'quiescence retries must return the exact first receipt');
  const afterStop = [];
  for await (const entry of unit.observe(handle)) afterStop.push(entry.type);
  assert.deepEqual(afterStop, ['started', 'completed'],
    'a late stop cannot append an event after the terminal event');
});

test('Copilot GEU delegates through the one model runner boundary and cannot mint verification', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-geu-copilot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const unit = createCopilotExecutionUnit({
    root,
    definition: { models: { defaultProvider: 'copilot-cli', providers: { 'copilot-cli': {} } } },
    async invoke(request) {
      calls.push(request);
      return {
        invocationId: 'invocation-1', provider: 'copilot-cli', status: 'completed',
        output: 'candidate prose', outputBytes: 15,
        outputSha256: createHash('sha256').update('candidate prose').digest('hex'),
        usage: { totalTokens: 4 }, toolObservation: null
      };
    }
  });
  const proposalContract = contract(unit.descriptor(), {
    outputSchema: { type: 'string' },
    budgets: { activeMinutes: 1, modelInvocations: 1, touchedResources: 0 }
  });
  const handle = await unit.start(proposalContract);
  const result = await unit.collect(handle);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'sgos-geu-copilot-cli');
  assert.equal(calls[0].task, 'code');
  assert.equal(Object.hasOwn(calls[0], 'model'), false,
    'model selection must remain inside the task-routing chokepoint');
  assert.deepEqual(calls[0].tools, {
    mode: 'none', names: [], requireSuccessful: true, rejectTruncated: true
  });
  assert.equal(calls[0].limits.outputBytes, MAXIMUM_AGENT_PROPOSAL_OUTPUT_BYTES);
  assert.equal(result.output, 'candidate prose');
  assert.equal(result.candidate.kind, 'model-proposal');
  assert.equal(result.candidate.authority, 'none');
  assert.equal(result.candidate.providerInvocationId, 'invocation-1');
  assert.equal(result.candidate.providerAuditRef, 'model-invocation:invocation-1');
  assert.equal(Object.hasOwn(result, 'verification'), false);
});

test('Copilot GEU stop cancels the provider and reaches exact quiescence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-geu-copilot-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let launched;
  const started = new Promise((resolve) => { launched = resolve; });
  const unit = createCopilotExecutionUnit({
    root,
    definition: { models: { defaultProvider: 'copilot-cli', providers: { 'copilot-cli': {} } } },
    invoke(request) {
      launched();
      return new Promise((resolve, reject) => request.signal.addEventListener(
        'abort', () => reject(request.signal.reason), { once: true }
      ));
    }
  });
  const handle = await unit.start(contract(unit.descriptor(), {
    outputSchema: { type: 'string' },
    budgets: { activeMinutes: 1, modelInvocations: 1, touchedResources: 0 }
  }));
  await started;
  const stop = await unit.requestStop(handle, { reason: 'bounded stop' });
  assert.equal(stop.acknowledged, true);
  assert.equal((await unit.quiesce(handle)).quiescent, true);
  await assert.rejects(unit.collect(handle),
    (error) => error.code === 'SGOS_GEU_STOP_REQUESTED');
});

test('Copilot GEU rejects output and tool/provider escalation before proposal admission', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-geu-copilot-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = (unit) => contract(unit.descriptor(), {
    outputSchema: { type: 'string' },
    budgets: { activeMinutes: 1, modelInvocations: 1, touchedResources: 0 }
  });
  const definition = {
    models: { defaultProvider: 'copilot-cli', providers: { 'copilot-cli': {} } }
  };
  const oversized = createCopilotExecutionUnit({
    root, definition,
    async invoke() {
      return {
        invocationId: 'oversized', output: 'x'.repeat(MAXIMUM_AGENT_PROPOSAL_OUTPUT_BYTES + 1)
      };
    }
  });
  await assert.rejects(oversized.collect(await oversized.start(task(oversized))),
    (error) => error.code === 'SGOS_GEU_OUTPUT_LIMIT');

  const tools = createCopilotExecutionUnit({
    root, definition,
    async invoke() {
      return {
        invocationId: 'tool-escalation', output: 'proposal',
        toolObservation: { totalCalls: 1 }
      };
    }
  });
  await assert.rejects(tools.collect(await tools.start(task(tools))),
    (error) => error.code === 'SGOS_GEU_TOOL_ESCALATION');

  const provider = createCopilotExecutionUnit({
    root, definition,
    async invoke() {
      return { invocationId: 'provider-escalation', provider: 'other', output: 'proposal' };
    }
  });
  await assert.rejects(provider.collect(await provider.start(task(provider))),
    (error) => error.code === 'SGOS_GEU_PROVIDER_ESCALATION');
});

test('Copilot provider launch obeys the explicit operation model context', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-geu-copilot-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let launches = 0;
  const unit = createCopilotExecutionUnit({
    root,
    definition: { models: { defaultProvider: 'copilot-cli', providers: { 'copilot-cli': {} } } },
    async invoke() {
      assertModelInvocationAllowed();
      launches += 1;
      return { invocationId: `policy-${launches}`, output: 'same logical proposal' };
    }
  });
  const task = contract(unit.descriptor(), {
    objective: 'Represent the same logical task.', outputSchema: { type: 'string' },
    budgets: { activeMinutes: 1, modelInvocations: 1, touchedResources: 0 }
  });
  await assert.rejects(() => withOperationContext({
    operation: { id: 'process.step', modelPolicy: 'never' },
    modelMode: { enabled: true }, root
  }, async () => unit.collect(await unit.start(task))),
  (error) => error.code === 'MODEL_FORBIDDEN');
  assert.equal(launches, 0);

  const result = await withOperationContext({
    operation: { id: 'process.step.model', modelPolicy: 'required' },
    modelMode: { enabled: true }, root
  }, async () => unit.collect(await unit.start(task)));
  assert.equal(launches, 1);
  assert.equal(result.output, 'same logical proposal');

  const translator = createDeterministicTranslatorExecutionUnit();
  const deterministic = await translator.collect(await translator.start(contract(
    translator.descriptor(), {
      objective: 'Represent the same logical task.',
      budgets: { activeMinutes: 1, modelInvocations: 0, touchedResources: 0 }
    }
  )));
  assert.equal(deterministic.output.objective, 'Represent the same logical task.');
  assert.equal(result.candidate.kind, 'model-proposal');
});

test('generic-process GEU requires exact registry authorization and uses fixed argv with bounded JSON stdio', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-geu-generic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executableSha256 = `sha256:${createHash('sha256')
    .update(await readFile(process.execPath)).digest('hex')}`;
  const manifest = createExecutionUnitManifest({
    id: 'generic-fixture', version: '1.0.0', publisher: 'fixture', provider: 'local', models: [],
    capabilities: { shell: false },
    sandbox: {
      kind: 'process', enforcement: 'external-attested',
      attestationSha256: sha256('generic-sandbox-attestation')
    },
    network: { mode: 'deny' },
    toolPolicy: { mode: 'none' }, risk: { class: 'low' },
    tests: { conformanceReceiptSha256: sha256('generic-conformance') },
    command: {
      executable: process.execPath,
      executableSha256,
      arguments: ['-e', "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({received:JSON.parse(s).taskId})))"],
      environmentAllowlist: []
    }
  });
  assert.throws(() => createGenericProcessExecutionUnit(manifest, { root }),
    (error) => error.code === 'SGOS_GEU_AUTHORITY_REQUIRED');
  const unit = createGenericProcessExecutionUnit(manifest, {
    root,
    authorizeManifest: (candidate) => candidate.manifestSha256
  });
  const result = await unit.collect(await unit.start(contract(manifest)));
  assert.deepEqual(result.output, { received: 'task-1' });
  await assert.rejects(
    unit.collect(await unit.start(contract(manifest, { readScope: ['src'] }))),
    (error) => error.code === 'SGOS_GEU_SANDBOX_SCOPE_UNSUPPORTED'
  );
});

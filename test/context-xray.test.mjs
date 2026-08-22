import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  contextPacketTelemetryRecords, recordContextExpansionRequest,
  recordContextPacketTelemetry
} from '../src/context-packet-telemetry.mjs';
import { contextXray } from '../src/context-xray.mjs';
import { gitCommonDir } from '../src/git.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-context-xray-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Context X-Ray Tester');
  git(root, 'config', 'user.email', 'context-xray@example.test');
  return root;
}

function packet() {
  return {
    packetId: 'ctx-0123456789abcdefabcd',
    binding: {
      workId: 'CXR-1', flightPlanId: 'flight-1', phase: 'implementation',
      generation: 2, sourceRevision: 'a'.repeat(40)
    },
    budget: {
      includedContentBytes: 800, estimatedInputTokens: 200,
      estimationMethod: 'utf8-bytes-divided-by-four'
    },
    omissions: [
      { count: 3, omissionClasses: { budget: 3 } },
      { count: 2, omissionClasses: { policy: 2 } }
    ],
    unavailable: [{ code: 'EPC_AST_UNAVAILABLE' }],
    observation: { rawBytes: 1600, includedBytes: 800 },
    contextManifest: { cacheKey: 'safe-cache-key', itemDigests: ['b'.repeat(64)] }
  };
}

function workflow() {
  return {
    workItem: { id: 'CXR-1', title: 'Context accounting', workType: 'story' },
    status: 'active', currentPhase: 'implementation',
    phaseOrder: ['requirements', 'implementation'],
    phases: {
      requirements: {
        id: 'requirements', generation: 1, usage: [{
          status: 'exact', source: 'copilot-otel', provider: 'github',
          requestedModel: 'auto', resolvedModel: 'model-alpha-1',
          resolvedModelAssurance: 'provider-reported',
          inputTokens: 100, outputTokens: 25, cachedInputTokens: 20,
          cacheWriteInputTokens: null, providerCost: null
        }]
      },
      implementation: {
        id: 'implementation', generation: 2, usage: [{
          status: 'exact', source: 'copilot-otel', provider: 'github',
          requestedModel: 'auto', resolvedModel: 'model-alpha-2',
          resolvedModelAssurance: 'provider-reported',
          inputTokens: 1000, outputTokens: 250, cachedInputTokens: null,
          cacheWriteInputTokens: null, providerCost: null,
          observations: {
            inputTokens: { value: 1000, status: 'exact', assurance: 'provider-reported' },
            outputTokens: { value: 250, status: 'exact', assurance: 'provider-reported' },
            cachedInputTokens: { value: null, status: 'unavailable', assurance: 'unavailable' },
            cacheWriteInputTokens: { value: null, status: 'unavailable', assurance: 'unavailable' },
            providerCost: { value: null, status: 'unavailable', assurance: 'unavailable' }
          }
        }]
      }
    }
  };
}

test('Context X-Ray projects content-free packet, expansion, model, and metric provenance without writing', async () => {
  const root = await repository();
  const recorded = await recordContextPacketTelemetry(root, packet());
  assert.equal(recorded.schemaVersion, 2);
  assert.equal(recorded.omittedItems, 5);
  assert.deepEqual(recorded.omissionClasses, { budget: 3, policy: 2 });
  await recordContextExpansionRequest(root, recorded.packetId, {
    handleKind: 'repository-symbol', itemId: 'secret/internal-symbol',
    includedBytes: 120, estimatedTokens: 30,
    expandedAt: '2026-08-22T10:00:00.000Z'
  });

  const telemetryFile = path.join(
    gitCommonDir(root), 'singularity-flow', 'evidence-packets', 'telemetry', `${recorded.packetId}.json`
  );
  const before = await readFile(telemetryFile);
  const statusBefore = git(root, 'status', '--porcelain');
  const xray = await contextXray(root, workflow());
  const after = await readFile(telemetryFile);

  assert.deepEqual(after, before);
  assert.equal(git(root, 'status', '--porcelain'), statusBefore);
  assert.equal(xray.work.phase, 'implementation');
  assert.equal(xray.ledger.models[0].requested, 'auto');
  assert.equal(xray.ledger.models[0].resolved, 'model-alpha-2');
  assert.equal(xray.ledger.models[0].cachedInputTokens.status, 'unavailable');
  assert.equal(xray.ledger.models[0].uncachedInputTokens.status, 'unavailable');
  assert.equal(xray.ledger.packets[0].expandedBytes.value, 120);
  assert.equal(xray.ledger.packets[0].expansions[0].subjectDigest.length, 64);
  assert.equal(xray.ledger.packets[0].observation.ratio.value, 2);
  assert.doesNotMatch(JSON.stringify(xray), /secret\/internal-symbol/);
});

test('Token Ledger can project the whole work while Context X-Ray defaults to the current phase', async () => {
  const root = await repository();
  await recordContextPacketTelemetry(root, packet());
  const current = await contextXray(root, workflow());
  const wholeWork = await contextXray(root, workflow(), { defaultToCurrentPhase: false });

  assert.equal(current.ledger.models.length, 1);
  assert.equal(current.ledger.totals.inputTokens.value, 1000);
  assert.equal(wholeWork.work.phase, null);
  assert.equal(wholeWork.ledger.models.length, 2);
  assert.equal(wholeWork.ledger.totals.inputTokens.value, 1100);
  assert.equal((await contextPacketTelemetryRecords(root, { workId: 'CXR-1' })).length, 1);
});

test('Token Ledger retains an exact provider total when the provider omits its input/output split', async () => {
  const root = await repository();
  const totalOnly = workflow();
  totalOnly.phases.implementation.usage = [{
    status: 'exact', source: 'usage-json', provider: 'other', model: 'model-total-only',
    inputTokens: null, outputTokens: null, cachedInputTokens: null,
    totalTokens: 777, providerCost: null
  }];
  const xray = await contextXray(root, totalOnly);
  assert.equal(xray.ledger.models[0].totalProviderTokens.value, 777);
  assert.equal(xray.ledger.models[0].totalProviderTokens.status, 'exact');
  assert.equal(xray.ledger.models[0].totalProviderTokens.assurance, 'self-reported');
  assert.equal(xray.ledger.totals.totalProviderTokens.value, 777);
  assert.equal(xray.ledger.totals.inputTokens.status, 'unavailable');
});

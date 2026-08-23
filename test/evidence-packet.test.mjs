import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

import {
  compileEvidencePacket, expandEvidencePacketHandle
} from '../src/evidence-packet.mjs';
import {
  previewChangeFlightPlan, startChangeFlightPlan
} from '../src/change-flight-plan.mjs';
import { compileContextManifest } from '../src/context-manifest.mjs';
import { gatewayOperation } from '../src/gateway/operations.mjs';
import { contextBrief } from '../src/gateway/planners/context-brief.mjs';
import { SFLOW_TOOLS } from '../src/gateway/tools.mjs';
import { compileObservation } from '../src/observation-compiler.mjs';
import { rankContextCandidates } from '../src/context-ranking.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Evidence Packet Tester' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-epc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Evidence Packet Tester'], root);
  run('git', ['config', 'user.email', 'evidence-packet@example.invalid'], root);
  run(process.execPath, [cli, 'init'], root);
  const definitionFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionFile, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionFile, YAML.stringify(definition));
  await mkdir(path.join(root, 'src/payment'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'src/payment/notifier.mjs'), [
    'export class PaymentNotifier {',
    '  send(paymentId) {',
    '    return `sent:${paymentId}`;',
    '  }',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'src/payment/checkout.mjs'), [
    'import { PaymentNotifier } from "./notifier.mjs";',
    'new PaymentNotifier().send("payment-1");',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'test/notifier.test.mjs'), [
    'import { PaymentNotifier } from "../src/payment/notifier.mjs";',
    'new PaymentNotifier().send("test-payment");',
    ''
  ].join('\n'));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize Evidence Packet fixture'], root);
  const remote = `${root}.git`;
  t.after(() => rm(remote, { recursive: true, force: true }));
  run('git', ['init', '--bare', '-q', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-q', '-u', 'origin', 'main'], root);
  return root;
}

test('ranking is deterministic and never promotes inferred context', () => {
  const values = rankContextCandidates([
    {
      kind: 'reference', subject: 'inferred', classification: 'inferred', representation: 'L0', content: 'i',
      reason: { code: 'flight-plan.inferred-impact' }, source: { type: 'plan', reference: 'b' }
    },
    {
      kind: 'reference', subject: 'proven', classification: 'proven', representation: 'L0', content: 'p',
      reason: { code: 'flight-plan.proven-impact' }, source: { type: 'plan', reference: 'a' }
    },
    {
      kind: 'reference', subject: 'target', classification: 'unknown', representation: 'L0', content: 't',
      reason: { code: 'flight-plan.direct-target' }, source: { type: 'human', reference: 'target' }
    }
  ]);
  assert.deepEqual(values.map((item) => item.subject), ['target', 'proven', 'inferred']);
  assert.equal(values.at(-1).classification, 'inferred');
  assert.deepEqual(rankContextCandidates(values), values);
});

test('a preview packet is byte-bounded, stable, source-labeled, and expands one exact symbol', async (t) => {
  const root = await repository(t);
  const plan = await previewChangeFlightPlan(root, {
    intent: 'Replace synchronous payment notification with an event',
    symbol: 'PaymentNotifier', ast: false
  });
  const request = {
    flightPlanId: plan.planId,
    requestedSlices: ['impact', 'ast'],
    maxOutputBytes: 32 * 1024
  };
  const first = await compileEvidencePacket(root, request);
  const second = await compileEvidencePacket(root, request);
  assert.equal(first.binding.mode, 'preview');
  assert.equal(first.binding.flightPlanId, plan.planId);
  assert.equal(first.packetId, second.packetId);
  assert.deepEqual(first.items, second.items);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= first.budget.maximumOutputBytes);
  assert.equal(first.modelInvoked, false);
  assert.equal(first.guidanceOnly, true);
  assert.ok(first.items.every((item) => ['untrusted-source', 'governed-guidance'].includes(item.material)));
  const symbol = first.items.find((item) => item.kind === 'symbol-signature');
  assert.ok(symbol, `L1 structural context is available without injecting the whole file: ${JSON.stringify(first.unavailable)}`);
  assert.equal(symbol.reason.code, 'flight-plan.direct-target');
  assert.ok(!first.items.some((item) => item.representation === 'complete-file'));
  const tiny = await compileEvidencePacket(root, { ...request, maxOutputBytes: 4096 });
  assert.ok(Buffer.byteLength(JSON.stringify(tiny)) <= 4096);
  assert.equal(tiny.status, 'partial');
  assert.ok(tiny.omissions[0]?.count > 0);
  assert.ok(tiny.omissions[0]?.expandHandle);
  const omittedPage = await expandEvidencePacketHandle(root, tiny.omissions[0].expandHandle);
  assert.equal(omittedPage.representation, 'bounded-omission-page');
  assert.ok(omittedPage.content.length > 0);
  const expansion = await expandEvidencePacketHandle(root, symbol.expandHandle);
  assert.equal(expansion.representation, 'L3-symbol-body');
  assert.match(expansion.content, /class PaymentNotifier/);
  assert.match(expansion.content, /sent:/);
  await assert.rejects(
    () => expandEvidencePacketHandle(root, 'ctx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    (error) => error.code === 'EPC_EXPANSION_INVALID'
  );

  await writeFile(path.join(root, 'src/payment/notifier.mjs'), 'export class PaymentNotifier {}\n');
  run('git', ['add', 'src/payment/notifier.mjs'], root);
  run('git', ['commit', '-m', 'move source revision'], root);
  await assert.rejects(
    () => expandEvidencePacketHandle(root, symbol.expandHandle),
    (error) => error.code === 'EPC_EXPANSION_STALE'
  );
});

test('accepted Flight Plan binding controls packet selection and detects tampering', async (t) => {
  const root = await repository(t);
  const plan = await previewChangeFlightPlan(root, { symbol: 'PaymentNotifier', ast: false });
  const worktree = `${root}-worktree`;
  t.after(() => rm(worktree, { recursive: true, force: true }));
  await startChangeFlightPlan(root, plan.planId, {
    confirm: plan.planId, workId: 'PAY-EPC-1', workType: 'feature', worktree
  });
  const packet = await compileEvidencePacket(worktree, {
    workId: 'PAY-EPC-1', flightPlanId: plan.planId,
    requestedSlices: ['impact', 'ast', 'evidence'], maxOutputBytes: 24 * 1024
  });
  assert.equal(packet.binding.mode, 'accepted-flight-plan');
  assert.equal(packet.binding.workId, 'PAY-EPC-1');
  assert.equal(packet.binding.intentSha256, plan.intent.digest);
  assert.equal(packet.compilerVersion, 2);
  assert.equal(packet.correlation.storyId, 'PAY-EPC-1');
  assert.equal(packet.correlation.workType, 'feature');
  assert.equal(packet.tokenEconomy.mode, 'observe');
  assert.equal(packet.tokenEconomy.profile, 'standard');
  assert.equal(packet.outcome.completed, false);
  assert.ok(packet.items.some((item) => item.kind === 'governance-policy-binding' && item.mandatory));
  assert.ok(packet.items.some((item) => item.reason.findingIds.length));
  const gateway = await contextBrief({
    root: worktree, operation: gatewayOperation('context.brief'),
    arguments: {
      workId: 'PAY-EPC-1', flightPlanId: plan.planId, slice: 'impact', maxOutputBytes: 24 * 1024
    }
  });
  assert.deepEqual(
    gateway.data.context.items.map((item) => item.itemId),
    (await compileEvidencePacket(worktree, {
      workId: 'PAY-EPC-1', flightPlanId: plan.planId,
      requestedSlices: ['impact'], maxOutputBytes: 24 * 1024
    })).items.map((item) => item.itemId)
  );
  const cliResult = run(process.execPath, [
    cli, 'session', 'context', '--work-id', 'PAY-EPC-1', '--flight-plan', plan.planId,
    '--slice', 'impact', '--max-output-bytes', String(24 * 1024), '--json'
  ], worktree);
  assert.deepEqual(JSON.parse(cliResult.stdout).items.map((item) => item.itemId),
    gateway.data.context.items.map((item) => item.itemId));
  assert.equal(SFLOW_TOOLS.length, 5, 'Evidence Packets stay behind the existing model-facing tools');

  const acceptedFile = path.join(worktree, 'singularity/work-items/PAY-EPC-1/context/change-flight-plan/accepted-plan.json');
  const tampered = JSON.parse(await readFile(acceptedFile, 'utf8'));
  tampered.intent.text = 'model supplied replacement intent';
  await writeFile(acceptedFile, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(
    () => compileEvidencePacket(worktree, {
      workId: 'PAY-EPC-1', flightPlanId: plan.planId, requestedSlices: ['impact']
    }),
    (error) => error.code === 'EPC_FLIGHT_PLAN_STALE'
  );
});

test('the Observation Firewall preserves failures, compresses repetition, and keeps raw bytes recoverable', async (t) => {
  const root = await repository(t);
  const raw = Buffer.from([
    'TAP version 13',
    'not ok 1 - payment sends event',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '  + actual - expected',
    '  + "sent"',
    '  - "queued"',
    '    at payment.test.mjs:18:3',
    ...Array.from({ length: 80 }, (_, index) => `ok ${index + 2} - passing payment case ${index + 2}`),
    '# tests 431',
    '# pass 428',
    '# fail 3',
    '# skipped 0',
    ''
  ].join('\n'));
  const observation = await compileObservation(root, {
    kind: 'test-result', raw, commandClass: 'configured-test', exitCode: 1,
    maximumIncludedBytes: 4096
  });
  assert.equal(observation.summary.tests, 431);
  assert.equal(observation.summary.passed, 428);
  assert.equal(observation.summary.failed, 3);
  assert.match(observation.included[0].content, /payment sends event/);
  assert.match(observation.included[0].content, /Expected values/);
  assert.ok(observation.includedBytes < observation.rawBytes);
  assert.equal(observation.modelInvoked, false);
  assert.deepEqual(observation.compiler, {
    id: 'test-result-observation', version: '2.0.0', profile: { maximumIncludedBytes: 4096 }
  });
  assert.equal(observation.correlation.packetId, null);

  const packet = await compileEvidencePacket(root, {
    requestedSlices: ['observation'], observation, maxOutputBytes: 12 * 1024
  });
  const item = packet.items.find((entry) => entry.kind === 'test-result-summary');
  assert.ok(item?.expandHandle);
  const expanded = await expandEvidencePacketHandle(root, item.expandHandle);
  assert.equal(expanded.content, raw.toString('utf8'));
  assert.equal(expanded.material, 'untrusted-source');

  const stack = await compileObservation(root, {
    kind: 'stack-trace',
    raw: 'Error: boom\n    at app (src/app.mjs:10:2)\n    at app (src/app.mjs:10:2)\n',
    exitCode: 1
  });
  assert.equal(stack.omitted.repeatedStackFrames, 1);
  const unknown = await compileObservation(root, { kind: 'search-result', raw: 'unrecognized output', exitCode: 0 });
  assert.equal(unknown.parsing.status, 'unparsed');
  assert.equal(unknown.status, 'unparsed');

  const credential = `ghp_${'A'.repeat(36)}`;
  const protectedObservation = await compileObservation(root, {
    kind: 'build-output', raw: `Build failed with token ${credential}\n`, exitCode: 1
  });
  assert.deepEqual(protectedObservation.redaction, {
    status: 'applied', applied: true, occurrences: 1, facts: [{ rule: 'github-token', count: 1 }]
  });
  assert.doesNotMatch(JSON.stringify(protectedObservation), new RegExp(credential));
  const protectedRaw = await expandEvidencePacketHandle(root, protectedObservation.expansion[0].handle);
  assert.match(protectedRaw.content, /\[redacted-secret:github-token\]/);
  assert.doesNotMatch(protectedRaw.content, new RegExp(credential));
});

test('manifest cache identity excludes mutable state and telemetry remains content-free', async (t) => {
  const stable = { workflow: 'v1' };
  const first = compileContextManifest({ definition: stable, flightPlan: { id: 'one' } });
  const second = compileContextManifest({ definition: stable, flightPlan: { id: 'two' }, observation: { id: 'now' } });
  assert.equal(first.cacheKey, second.cacheKey);
  assert.notDeepEqual(first.mutableTail, second.mutableTail);
  assert.deepEqual(first.providerCache, { status: 'unavailable', cachedInputTokens: null });

  const root = await repository(t);
  const observation = await compileObservation(root, {
    kind: 'build-output', raw: 'error TS2345 at src/app.ts:4:2 SECRET_SOURCE_TEXT', exitCode: 1
  });
  const packet = await compileEvidencePacket(root, {
    requestedSlices: ['observation'], observation, maxOutputBytes: 12 * 1024
  });
  const telemetry = JSON.parse(await readFile(path.join(
    path.resolve(root, run('git', ['rev-parse', '--git-common-dir'], root).stdout.trim()),
    'singularity-flow/evidence-packets/telemetry', `${packet.packetId}.json`
  ), 'utf8'));
  assert.doesNotMatch(JSON.stringify(telemetry), /SECRET_SOURCE_TEXT|src\/app\.ts|TS2345/);
  assert.equal(telemetry.providerInputTokens, null);
  assert.equal(telemetry.providerCachedInputTokens, null);
});

test('history uses exact same-repository overlap and expands only the governed receipt', async (t) => {
  const root = await repository(t);
  const historicalRoot = path.join(root, 'singularity/work-items/PAY-OLD');
  await mkdir(path.join(historicalRoot, 'context/change-flight-plan'), { recursive: true });
  await writeFile(path.join(historicalRoot, 'workflow.json'), `${JSON.stringify({
    schemaVersion: 2, status: 'completed', workItem: { id: 'PAY-OLD' }
  }, null, 2)}\n`);
  await writeFile(path.join(historicalRoot, 'context/change-flight-plan/receipt.json'), `${JSON.stringify({
    schemaVersion: 1,
    acceptedImpact: [{ kind: 'code-file', subject: 'src/payment/checkout.mjs' }],
    actualImpact: { actualPaths: ['src/payment/checkout.mjs', 'test/notifier.test.mjs'] }
  }, null, 2)}\n`);
  run('git', ['add', 'singularity/work-items/PAY-OLD'], root);
  run('git', ['commit', '-m', 'add completed governed analogue'], root);
  const plan = await previewChangeFlightPlan(root, {
    intent: 'change payment notification', symbol: 'PaymentNotifier', ast: false
  });
  const packet = await compileEvidencePacket(root, {
    flightPlanId: plan.planId, requestedSlices: ['history'], maxOutputBytes: 12 * 1024
  });
  const analogue = packet.items.find((item) => item.kind === 'historical-analogue');
  assert.equal(analogue?.subject, 'PAY-OLD');
  assert.match(analogue.content, /src\/payment\/checkout\.mjs/);
  const receipt = await expandEvidencePacketHandle(root, analogue.expandHandle);
  assert.equal(receipt.representation, 'history-receipt');
  assert.match(receipt.content, /"schemaVersion": 1/);
  assert.doesNotMatch(receipt.content, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

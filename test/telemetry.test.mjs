import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  beginTelemetryCapture, captureTelemetryCursorsForWorkItem, collectCopilotUsage,
  groupedUsage, parseCopilotTelemetry, phaseTelemetrySummary, recordPhaseTelemetry,
  restoreTelemetryCursorsForWorkItem, verifyPhaseTelemetry
} from '../src/telemetry.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { run } from '../src/util.mjs';

async function telemetryRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-tel-cursors-'));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

test('Copilot telemetry parser accepts direct and OTLP attribute encodings', () => {
  const direct = {
    name: 'chat model-alpha-1',
    startTime: '2026-07-22T10:00:00.000Z',
    endTime: '2026-07-22T10:00:02.000Z',
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'github',
      'gen_ai.request.model': 'auto',
      'gen_ai.response.model': 'model-alpha-1',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 300,
      'gen_ai.usage.cache_read.input_tokens': 200,
      'github.copilot.cost': 0.0123,
      'gen_ai.conversation.id': 'must-not-be-copied-to-work-item-records'
    }
  };
  const otlp = {
    resourceSpans: [{ scopeSpans: [{ spans: [{
      name: 'chat gpt-5.4',
      startTimeUnixNano: '1784714400000000000',
      endTimeUnixNano: '1784714402000000000',
      attributes: [
        { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
        { key: 'gen_ai.provider.name', value: { stringValue: 'github' } },
        { key: 'gen_ai.response.model', value: { stringValue: 'gpt-5.4' } },
        { key: 'gen_ai.usage.input_tokens', value: { intValue: '800' } },
        { key: 'gen_ai.usage.output_tokens', value: { intValue: '200' } },
        { key: 'github.copilot.cost', value: { doubleValue: 0.01 } }
      ]
    }] }] }]
  };

  const parsed = parseCopilotTelemetry(`${JSON.stringify(direct)}\n${JSON.stringify(otlp)}\n`);
  assert.equal(parsed.warnings.length, 0);
  assert.deepEqual(parsed.privacyDiagnostics, ['dropped disallowed telemetry attributes at line 1']);
  assert.equal(parsed.spans.length, 2);
  assert.deepEqual(parsed.spans[0], {
    provider: 'github', model: 'model-alpha-1', requestedModel: 'auto',
    resolvedModel: 'model-alpha-1', resolvedModelAssurance: 'provider-reported',
    inputTokens: 1200, outputTokens: 300,
    cachedInputTokens: 200, cacheWriteInputTokens: null, providerCost: 0.0123,
    startedAt: '2026-07-22T10:00:00.000Z', completedAt: '2026-07-22T10:00:02.000Z'
  });
  assert.equal(parsed.spans[1].model, 'gpt-5.4');
  assert.equal(parsed.spans[1].requestedModel, null);
  assert.equal(parsed.spans[1].resolvedModel, 'gpt-5.4');
  assert.equal(parsed.spans[1].inputTokens, 800);
  assert.equal(parsed.spans[1].providerCost, 0.01);
  assert.doesNotMatch(JSON.stringify(parsed), /must-not-be-copied/);
});

test('usage grouping preserves unavailable fields and requested/resolved model identity', () => {
  const usage = groupedUsage([{
    provider: 'github', model: 'model-alpha-1', requestedModel: 'auto',
    resolvedModel: 'model-alpha-1', resolvedModelAssurance: 'provider-reported',
    inputTokens: 1200, outputTokens: 300, cachedInputTokens: null,
    cacheWriteInputTokens: null, providerCost: null,
    startedAt: '2026-07-22T10:00:00.000Z', completedAt: '2026-07-22T10:00:02.000Z'
  }])[0];

  assert.equal(usage.status, 'exact');
  assert.equal(usage.requestedModel, 'auto');
  assert.equal(usage.resolvedModel, 'model-alpha-1');
  assert.equal(usage.totalTokens, 1500);
  assert.equal(usage.cachedInputTokens, null);
  assert.deepEqual(usage.observations.cachedInputTokens, {
    value: null, status: 'unavailable', assurance: 'unavailable'
  });
});

test('usage grouping labels incomplete provider arithmetic partial instead of adding a missing field as zero', () => {
  const usage = groupedUsage([{
    provider: 'github', model: 'model-alpha-1', requestedModel: null,
    resolvedModel: 'model-alpha-1', resolvedModelAssurance: 'provider-reported',
    inputTokens: 1200, outputTokens: null, cachedInputTokens: 200,
    cacheWriteInputTokens: null, providerCost: null, startedAt: null, completedAt: null
  }])[0];

  assert.equal(usage.status, 'partial');
  assert.equal(usage.totalTokens, 1200);
  assert.equal(usage.observations.outputTokens.status, 'unavailable');
});

test('Copilot telemetry parser ignores tool spans and quarantines malformed interior records', () => {
  const tool = { name: 'execute_tool shell', attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.request.model': 'ignored' } };
  const parsed = parseCopilotTelemetry(`${JSON.stringify(tool)}\nnot-json\n`);
  assert.equal(parsed.spans.length, 0);
  assert.deepEqual(parsed.warnings, ['quarantined malformed telemetry record at line 2']);
});

test('Copilot telemetry parser retries a truncated final record without retaining content', () => {
  const parsed = parseCopilotTelemetry('{"attributes":{"gen_ai.input.messages":"secret prompt"}}\n{"incomplete":');
  assert.deepEqual(parsed.spans, []);
  assert.deepEqual(parsed.privacyDiagnostics, ['dropped disallowed telemetry attributes at line 1']);
  assert.deepEqual(parsed.warnings, ['ignored incomplete telemetry tail; it will be retried at the next boundary']);
  assert.doesNotMatch(JSON.stringify(parsed), /secret prompt/);
});

test('mixed captured and unavailable launches cannot produce an exact phase receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-tel-mixed-'));
  const itemDirectory = path.join(root, 'singularity', 'work-items', 'WRK-1');
  await mkdir(itemDirectory, { recursive: true });
  const result = await recordPhaseTelemetry(
    root,
    { workItem: { id: 'WRK-1', workType: 'story' } },
    { id: 'implementation', generation: 1 },
    [{ status: 'exact', model: 'model-alpha', providerCost: null }],
    {
      source: 'copilot-otel', pending: false, spans: 1,
      launches: [
        { launchId: 'one', captureStatus: 'captured' },
        { launchId: 'two', captureStatus: 'conflict' }
      ]
    },
    { itemDirectory, itemRelative: 'singularity/work-items/WRK-1' }
  );
  assert.equal(result.status, 'partial');
});

test('corrupt optional cursor state never blocks phase capture or usage collection', async () => {
  const root = await telemetryRepository();
  const cursorFile = path.join(root, '.git', 'singularity-flow', 'telemetry-cursors.json');
  await mkdir(path.dirname(cursorFile), { recursive: true });
  await writeFile(cursorFile, '{not-json\n');
  const workflow = { workItem: { id: 'WRK-CURSOR' } };
  const phase = { id: 'planning', generation: 0 };

  const cursor = await beginTelemetryCapture(root, workflow, phase);
  assert.equal(cursor.workId, 'WRK-CURSOR');
  assert.equal(cursor.persistence, 'unavailable');

  const usage = await collectCopilotUsage(root, workflow, phase, { generation: 1 });
  assert.match(usage.warnings.join('\n'), /cursor state was unreadable/i);
  assert.equal(usage.spans, 0);
});

test('one Story cursor rollback preserves cursor updates for other Stories', async () => {
  const root = await telemetryRepository();
  const phase = { id: 'planning', generation: 0 };
  const originalA = await captureTelemetryCursorsForWorkItem(root, 'WORK-A');
  assert.deepEqual(originalA, {});

  await Promise.all([
    beginTelemetryCapture(root, { workItem: { id: 'WORK-A' } }, phase),
    beginTelemetryCapture(root, { workItem: { id: 'WORK-B' } }, phase)
  ]);
  const restored = await restoreTelemetryCursorsForWorkItem(root, 'WORK-A', originalA);
  assert.equal(restored.restored, true);

  const record = JSON.parse(await readFile(
    path.join(root, '.git', 'singularity-flow', 'telemetry-cursors.json'), 'utf8'
  ));
  assert.equal(record.cursors['WORK-A:planning:1'], undefined);
  assert.equal(record.cursors['WORK-B:planning:1'].workId, 'WORK-B');
});

test('request, model-call and tool spans become content-free activity, including OTLP status and span times', () => {
  const lines = [
    { traceId: 'trace-1', name: 'invoke_agent copilot', startTime: [1790000000, 0], endTime: [1790000060, 500_000_000],
      attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.request.model': 'model-alpha-1.5', 'copilot_chat.turn_count': 2,
        'gen_ai.conversation.id': 'conversation-must-not-leak', 'gen_ai.input.messages': 'prompt-must-not-leak' } },
    { traceId: 'trace-1', name: 'chat model-alpha-1.5', endTime: '2026-10-01T10:00:01Z',
      attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'model-alpha-1.5', 'gen_ai.response.model': 'gpt-4.1',
        'copilot_chat.request.max_prompt_tokens': 64000 } },
    { traceId: 'trace-1', name: 'chat model-alpha-1.5', status: { code: 2, message: 'quota message must not leak' },
      attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'model-alpha-1.5' } },
    { traceId: 'trace-1', name: 'execute_tool run_in_terminal',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.call.arguments': 'arguments-must-not-leak',
        'error.type': 'command failed: cat secret-must-not-leak' } },
    { name: 'create_agent copilot', attributes: { 'gen_ai.operation.name': 'create_agent' } }
  ];
  const parsed = parseCopilotTelemetry(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  assert.deepEqual(parsed.activities.map(({ operation, failed, errorType }) => ({ operation, failed, errorType })), [
    { operation: 'invoke_agent', failed: false, errorType: null },
    { operation: 'chat', failed: false, errorType: null },
    { operation: 'chat', failed: true, errorType: 'error' },
    { operation: 'execute_tool', failed: true, errorType: 'error' }
  ], 'other operations are not activity, and a free-text error class is reduced to "error"');
  assert.equal(parsed.activities[0].at, new Date(1_790_000_060_500).toISOString(), 'OpenTelemetry JS [seconds, nanoseconds] times are read');
  assert.equal(parsed.activities[0].turns, 2);
  assert.equal(parsed.activities[1].resolvedModel, 'gpt-4.1');
  assert.equal(parsed.activities[1].maxPromptTokens, 64000);
  assert.equal(parsed.activities[2].resolvedModel, null, 'a span name carries the requested model, never the answer');
  assert.equal(parsed.spans.length, 2, 'usage still comes from chat spans only');
  assert.doesNotMatch(JSON.stringify(parsed), /must-not-leak/);
});

async function telemetryItem(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const itemDirectory = path.join(root, 'singularity', 'work-items', 'WRK-9');
  await mkdir(path.join(itemDirectory, 'context', 'prompts'), { recursive: true });
  return { root, itemDirectory, itemRelative: 'singularity/work-items/WRK-9' };
}

// The shape a composition writes: the budget's limits sit under `policy`.
async function composedPrompt(itemDirectory, { phase = 'design', generation = 2, bytes = 4100, budget = {
  policy: { mode: 'assist', profile: 'standard', maximumBytes: 4000, maximumEstimatedPromptTokens: 1000 },
  originalBytes: 9000, finalBytes: 4100, omitted: [{ id: 'a' }, { id: 'b' }]
} } = {}) {
  await writeFile(path.join(itemDirectory, 'context', `${phase}-gen${generation}.json`), JSON.stringify({
    schemaVersion: currentSchemaVersion('prompt-injection'), workId: 'WRK-9', phase, generation, promptBudget: budget
  }));
  await writeFile(path.join(itemDirectory, 'context', 'prompts', `${phase}-gen${generation}.md`), 'x'.repeat(bytes));
}

const capturedActivity = {
  source: 'copilot-otel', requests: 2, turns: 7, turnsCounted: 2, turnsAssurance: 'provider-reported',
  modelCalls: 7, toolCalls: 11, failedRequests: 0, failedModelCalls: 1, failedToolCalls: 2,
  requestsByModel: [{ model: 'model-alpha-1.5', requests: 2 }], promptLimits: [], events: [], omittedEvents: 0
};

test('a generation\'s telemetry records its activity and the size of the prompt sflow composed for it', async () => {
  const { root, itemDirectory, itemRelative } = await telemetryItem('sflow-tel-activity-');
  await composedPrompt(itemDirectory);
  const workflow = { workItem: { id: 'WRK-9', workType: 'story' } };
  const phase = { id: 'design', generation: 2 };
  const result = await recordPhaseTelemetry(root, workflow, phase, [], {
    source: 'copilot-otel', pending: false, spans: 7, activity: capturedActivity
  }, { itemDirectory, itemRelative });
  assert.deepEqual(result.prompt, {
    source: 'sflow-composition', bytes: 4100, estimatedTokens: 1025,
    estimation: 'UTF-8 bytes divided by four, rounded up',
    maximumBytes: 4000, maximumEstimatedTokens: 1000, budgetMode: 'assist', originalBytes: 9000, omittedSections: 2
  });
  assert.deepEqual(result.activity, capturedActivity);
  const record = JSON.parse(await readFile(path.join(root, result.path), 'utf8'));
  assert.deepEqual(record.activity, capturedActivity);
  assert.equal(record.prompt.bytes, 4100);
  const summary = phaseTelemetrySummary(result);
  assert.deepEqual(summary.activity, capturedActivity);
  assert.equal(summary.prompt.bytes, 4100);

  // A flat budget summary still states its limits.
  await composedPrompt(itemDirectory, { generation: 4, bytes: 10, budget: { mode: 'observe', maximumBytes: 72000, maximumEstimatedPromptTokens: 18000, originalBytes: 10, omitted: [] } });
  const flat = await recordPhaseTelemetry(root, workflow, { id: 'design', generation: 4 }, [], { source: 'copilot-otel', pending: true, spans: 0 }, { itemDirectory, itemRelative });
  assert.deepEqual([flat.prompt.maximumBytes, flat.prompt.maximumEstimatedTokens, flat.prompt.budgetMode], [72000, 18000, 'observe']);

  const published = { ...phase, telemetry: [summary], usage: [] };
  assert.deepEqual((await verifyPhaseTelemetry(root, workflow, published, 2)).errors, []);
  const altered = { ...published, telemetry: [{ ...summary, activity: { ...capturedActivity, requests: 1 } }] };
  assert.deepEqual((await verifyPhaseTelemetry(root, workflow, altered, 2)).errors,
    [`telemetry activity differs from workflow state: ${result.path}`]);
});

test('a generation authored without a model, or composed for another generation, records no prompt size', async () => {
  const { root, itemDirectory, itemRelative } = await telemetryItem('sflow-tel-noprompt-');
  await composedPrompt(itemDirectory, { generation: 1 });
  const workflow = { workItem: { id: 'WRK-9', workType: 'story' } };
  const manual = await recordPhaseTelemetry(root, workflow, { id: 'design', generation: 1 }, [], {
    source: 'not-invoked', pending: false, spans: 0
  }, { itemDirectory, itemRelative });
  assert.equal(manual.prompt, null, 'nothing was sent to a model');
  assert.equal(manual.activity, null);
  const summary = phaseTelemetrySummary(manual);
  assert.equal('activity' in summary || 'prompt' in summary, false, 'the state summary keeps its old shape');

  const later = await recordPhaseTelemetry(root, workflow, { id: 'design', generation: 3 }, [], {
    source: 'copilot-otel', pending: true, spans: 0
  }, { itemDirectory, itemRelative });
  assert.equal(later.prompt, null, 'generation 1\'s prompt is not generation 3\'s');
});

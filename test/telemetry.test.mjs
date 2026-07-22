import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCopilotTelemetry } from '../src/telemetry.mjs';

test('Copilot telemetry parser accepts direct and OTLP attribute encodings', () => {
  const direct = {
    name: 'chat claude-sonnet-4.6',
    startTime: '2026-07-22T10:00:00.000Z',
    endTime: '2026-07-22T10:00:02.000Z',
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'github',
      'gen_ai.request.model': 'auto',
      'gen_ai.response.model': 'claude-sonnet-4.6',
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
  assert.equal(parsed.spans.length, 2);
  assert.deepEqual(parsed.spans[0], {
    provider: 'github', model: 'claude-sonnet-4.6', inputTokens: 1200, outputTokens: 300,
    cachedInputTokens: 200, cacheWriteInputTokens: null, providerCost: 0.0123,
    startedAt: '2026-07-22T10:00:00.000Z', completedAt: '2026-07-22T10:00:02.000Z'
  });
  assert.equal(parsed.spans[1].model, 'gpt-5.4');
  assert.equal(parsed.spans[1].inputTokens, 800);
  assert.equal(parsed.spans[1].providerCost, 0.01);
  assert.doesNotMatch(JSON.stringify(parsed), /must-not-be-copied/);
});

test('Copilot telemetry parser ignores tool spans and reports malformed lines', () => {
  const tool = { name: 'execute_tool shell', attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.request.model': 'ignored' } };
  const parsed = parseCopilotTelemetry(`${JSON.stringify(tool)}\nnot-json\n`);
  assert.equal(parsed.spans.length, 0);
  assert.deepEqual(parsed.warnings, ['ignored malformed telemetry line 2']);
});

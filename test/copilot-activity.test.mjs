/**
 * Copilot activity is what a report can chart when Copilot leaves token counts off its spans:
 * requests, turns, model and tool calls, quota events and an estimate of premium requests. Every
 * count says whether it was reported, derived or missing; none is converted to zero.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedErrorType, copilotModelKey, estimatePremiumRequests, isAutoModel, modelSubstituted,
  premiumMultiplierFor, quotaEventKind, sameCopilotModel, summarizeCopilotActivity
} from '../src/copilot-activity.mjs';

const request = (fields = {}) => ({ operation: 'invoke_agent', traceId: null, requestedModel: null, resolvedModel: null, turns: null, maxPromptTokens: null, failed: false, errorType: null, at: null, ...fields });
const call = (fields = {}) => ({ ...request(fields), operation: 'chat', ...fields });
const tool = (fields = {}) => ({ ...request(fields), operation: 'execute_tool', ...fields });

test('a dated or preview build is the same model; a sibling model is not', () => {
  assert.equal(copilotModelKey('OpenAI/GPT-4.1'), 'gpt-4-1');
  assert.ok(sameCopilotModel('model-alpha-1.5', 'model-alpha-1-5-20250929'));
  assert.ok(sameCopilotModel('gpt-4.1', 'gpt-4.1-2025-04-14'));
  assert.ok(sameCopilotModel('gpt-4', 'gpt-4-0613'));
  assert.ok(sameCopilotModel('gemini-2.5-pro', 'gemini-2.5-pro-preview-05-06'));
  assert.ok(sameCopilotModel('openai/gpt-5', 'GPT-5'));
  assert.equal(sameCopilotModel('gpt-5', 'gpt-5-mini'), false, 'mini is a different model with a different rate');
  assert.equal(sameCopilotModel('model-alpha-1', 'model-alpha-1.5'), false, 'a version number names another model');
  assert.equal(sameCopilotModel('', 'gpt-5'), false);
});

test('only a concrete request answered by another model is a substitution', () => {
  assert.equal(modelSubstituted('model-premium-2', 'gpt-4.1'), true);
  assert.equal(modelSubstituted('model-alpha-1.5', 'model-alpha-1-5-20250929'), false);
  assert.equal(modelSubstituted('auto', 'gpt-5-mini'), false, 'auto asks Copilot to choose');
  assert.ok(isAutoModel('Copilot-Auto'));
  assert.equal(modelSubstituted('gpt-5', null), false, 'an unreported answer proves nothing');
  assert.equal(modelSubstituted(null, 'gpt-5'), false);
});

test('error classes are kept only when they look like classes, and quota errors are named', () => {
  assert.equal(boundedErrorType('429'), '429');
  assert.equal(boundedErrorType('RateLimitError'), 'RateLimitError');
  assert.equal(boundedErrorType('command failed: cat /etc/secret'), 'error', 'a message could carry content');
  assert.equal(boundedErrorType(''), null);
  assert.equal(quotaEventKind('429'), 'rate-limited');
  assert.equal(quotaEventKind('rate_limited'), 'rate-limited');
  assert.equal(quotaEventKind('premium_quota_exceeded'), 'quota-exceeded');
  assert.equal(quotaEventKind('402'), 'quota-exceeded');
  assert.equal(quotaEventKind('TimeoutError'), null);
});

test('requests, turns, model and tool calls are counted from request, chat and tool spans', () => {
  const summary = summarizeCopilotActivity([
    request({ traceId: 'a', requestedModel: 'model-alpha-1.5', turns: 3 }),
    call({ traceId: 'a', requestedModel: 'model-alpha-1.5', resolvedModel: 'model-alpha-1-5-20250929', maxPromptTokens: 128000 }),
    call({ traceId: 'a', requestedModel: 'model-alpha-1.5', resolvedModel: 'model-alpha-1-5-20250929', maxPromptTokens: 128000 }),
    tool({ traceId: 'a' }),
    tool({ traceId: 'a', failed: true, errorType: 'error' }),
    // No turn count reported: the model calls under the request's own trace are its turns.
    request({ traceId: 'b', requestedModel: 'auto' }),
    call({ traceId: 'b', requestedModel: 'auto', resolvedModel: 'gpt-5-mini' }),
    call({ traceId: 'b', requestedModel: 'auto', resolvedModel: 'gpt-5-mini' })
  ]);
  assert.equal(summary.requests, 2);
  assert.equal(summary.turns, 5);
  assert.equal(summary.turnsCounted, 2);
  assert.equal(summary.turnsAssurance, 'derived-from-model-calls');
  assert.equal(summary.modelCalls, 4);
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.failedToolCalls, 1);
  assert.deepEqual(summary.events, [], 'a failed tool call is an ordinary agent step, not an event');
  // An auto request is billed at the model that answered it.
  assert.deepEqual(summary.requestsByModel, [
    { model: 'gpt-5-mini', requests: 1 },
    { model: 'model-alpha-1.5', requests: 1 }
  ]);
  assert.deepEqual(summary.promptLimits, [{ model: 'model-alpha-1-5-20250929', maxPromptTokens: 128000 }]);
  assert.doesNotMatch(JSON.stringify(summary), /"traceId"/, 'trace IDs only join spans in memory');
});

test('turns stay unknown when a trace holds several requests or no request spans exist', () => {
  const shared = summarizeCopilotActivity([
    request({ traceId: 'x' }), request({ traceId: 'x' }), call({ traceId: 'x' }), call({ traceId: 'x' })
  ]);
  assert.equal(shared.requests, 2);
  assert.equal(shared.turns, null, 'two requests in one trace cannot split its model calls');
  assert.equal(shared.turnsAssurance, 'unavailable');
  const callsOnly = summarizeCopilotActivity([call({ requestedModel: 'gpt-5' })]);
  assert.equal(callsOnly.requests, null, 'requests are never inferred from model calls');
  assert.equal(callsOnly.modelCalls, 1);
  assert.equal(summarizeCopilotActivity([]), null);
});

test('substitutions, rate limits, exhausted allowances and failed calls become grouped events', () => {
  const summary = summarizeCopilotActivity([
    request({ traceId: 'q', requestedModel: 'model-premium-2', failed: true, errorType: 'quota_exceeded', at: '2026-10-01T10:00:09.000Z' }),
    call({ traceId: 'q', requestedModel: 'model-premium-2', resolvedModel: 'gpt-4.1', at: '2026-10-01T10:00:02.000Z' }),
    call({ traceId: 'q', requestedModel: 'model-premium-2', resolvedModel: 'gpt-4.1', at: '2026-10-01T10:00:01.000Z' }),
    call({ traceId: 'q', requestedModel: 'model-premium-2', failed: true, errorType: '429', at: '2026-10-01T10:00:05.000Z' }),
    call({ traceId: 'q', requestedModel: 'model-premium-2', failed: true, errorType: 'TimeoutError', at: '2026-10-01T10:00:07.000Z' })
  ]);
  assert.deepEqual(summary.events.map(({ kind, operation, count, firstAt, lastAt }) => ({ kind, operation, count, firstAt, lastAt })), [
    { kind: 'model-substituted', operation: 'chat', count: 2, firstAt: '2026-10-01T10:00:01.000Z', lastAt: '2026-10-01T10:00:02.000Z' },
    { kind: 'rate-limited', operation: 'chat', count: 1, firstAt: '2026-10-01T10:00:05.000Z', lastAt: '2026-10-01T10:00:05.000Z' },
    { kind: 'failed', operation: 'chat', count: 1, firstAt: '2026-10-01T10:00:07.000Z', lastAt: '2026-10-01T10:00:07.000Z' },
    { kind: 'quota-exceeded', operation: 'invoke_agent', count: 1, firstAt: '2026-10-01T10:00:09.000Z', lastAt: '2026-10-01T10:00:09.000Z' }
  ]);
  assert.equal(summary.events[0].resolvedModel, 'gpt-4.1');
  assert.equal(summary.failedRequests, 1);
  assert.equal(summary.failedModelCalls, 2);
  assert.equal(summary.omittedEvents, 0);
});

test('events are bounded and the rest are counted, never silently dropped', () => {
  const entries = Array.from({ length: 25 }, (_, index) => call({ requestedModel: `model-${index}`, failed: true, errorType: `E${index}` }));
  const summary = summarizeCopilotActivity(entries);
  assert.equal(summary.events.length, 20);
  assert.equal(summary.omittedEvents, 5);
});

test('premium requests are requests times the serving model\'s configured multiplier', () => {
  const multipliers = { 'model-alpha-1.5': 1, 'model-premium-2': 3, 'gpt-5-mini': 0, gpt: 9 };
  assert.equal(premiumMultiplierFor(multipliers, 'model-alpha-1-5-20250929'), 1, 'a dated build uses its model\'s rate');
  assert.equal(premiumMultiplierFor(multipliers, 'gpt-5'), null, 'a prefix that names another model does not match');
  assert.equal(premiumMultiplierFor(null, 'gpt-5'), null);
  assert.deepEqual(estimatePremiumRequests([
    { model: 'model-alpha-1.5', requests: 4 },
    { model: 'model-premium-2', requests: 2 },
    { model: 'gpt-5-mini', requests: 7 }
  ], multipliers), { value: 10, status: 'estimated', missingModels: [] });
  assert.deepEqual(estimatePremiumRequests([
    { model: 'model-alpha-1.5', requests: 3 },
    { model: 'mystery-model', requests: 1 }
  ], { 'model-alpha-1.5': 0.33 }), { value: 0.99, status: 'partial', missingModels: ['mystery-model'] });
  assert.deepEqual(estimatePremiumRequests([{ model: 'gpt-5', requests: 2 }], {}), {
    value: null, status: 'unavailable', missingModels: ['gpt-5']
  });
  assert.deepEqual(estimatePremiumRequests([], multipliers), { value: null, status: 'unavailable', missingModels: [] });
});

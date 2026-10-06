/**
 * Lifecycle Analytics shows what Copilot did per phase when Copilot leaves token counts off its
 * spans: requests, turns, calls, an estimate of premium requests, quota events and prompt size.
 * The numbers come from the engine's report, fed through here exactly as the CLI produces it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveReport } from '../src/report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = (name) => path.join(root, 'apps/vscode/src/views', name);
const {
  buildLifecycleAnalytics, copilotCountLabel, copilotEventSentence, premiumLabel, promptSizeNote
} = await import(views('dashboard-model.ts'));
const { copilotActivityHtml } = await import(views('dashboard-copilot.ts'));

const at = (minutes) => new Date(Date.parse('2026-07-01T09:00:00.000Z') + minutes * 60_000).toISOString();

function workflow() {
  const activity = (fields) => ({
    source: 'copilot-otel', requests: 1, turns: 3, turnsCounted: 1, turnsAssurance: 'provider-reported',
    modelCalls: 3, toolCalls: 4, failedRequests: 0, failedModelCalls: 0, failedToolCalls: 0,
    requestsByModel: [], promptLimits: [], events: [], omittedEvents: 0, ...fields
  });
  const prompt = (bytes) => ({
    source: 'sflow-composition', bytes, estimatedTokens: Math.ceil(bytes / 4),
    estimation: 'UTF-8 bytes divided by four, rounded up', maximumBytes: 65536,
    maximumEstimatedTokens: 16384, budgetMode: 'observe', originalBytes: bytes, omittedSections: 0
  });
  return {
    status: 'in_progress', currentPhase: 'design',
    workItem: { id: 'ENG-9', title: 'Metered', workType: 'feature', branch: 'ENG-9' },
    phaseOrder: ['requirements', 'design'],
    phases: {
      requirements: {
        id: 'requirements', label: 'Requirements', status: 'approved', startedAt: at(0), approvedAt: at(30), generation: 1,
        usage: [], approvals: [], checks: [],
        telemetry: [{ generation: 1, status: 'unavailable', models: [], activity: activity({
          requests: 2, turns: 6, turnsCounted: 2, requestsByModel: [{ model: 'model-alpha-1.5', requests: 2 }]
        }), prompt: prompt(20480) }]
      },
      design: {
        id: 'design', label: 'Design <b>', status: 'in_progress', startedAt: at(30), generation: 1,
        usage: [], approvals: [], checks: [],
        telemetry: [{ generation: 1, status: 'unavailable', models: [], activity: activity({
          turnsAssurance: 'derived-from-model-calls', failedToolCalls: 1,
          requestsByModel: [{ model: '<script>x</script>', requests: 1 }],
          events: [{ kind: 'model-substituted', operation: 'chat', requestedModel: 'model-premium-2', resolvedModel: 'gpt-4.1', errorType: null, count: 2, firstAt: null, lastAt: null }]
        }), prompt: prompt(80000) }]
      }
    },
    usage: { totalTokens: 0, records: 0, exactRecords: 0, unavailableRecords: 0, byPhase: {}, byAgent: {} },
    sequenceOverrides: [],
    history: [{ at: at(40), actor: 'bob', agent: 'architect', event: 'phase_rejected', phase: 'design', detail: 'CR-001 returned to requirements: unclear scope' }]
  };
}

test('the dashboard lays out the engine\'s Copilot activity, premium estimate, quota events and prompt size', () => {
  const report = deriveReport(workflow(), { premiumMultipliers: { 'model-alpha-1.5': 1 }, now: at(60) });
  const analytics = buildLifecycleAnalytics(report);
  assert.equal(analytics.sentBack, 1);
  assert.equal(analytics.copilot, report.copilot, 'the dashboard never recalculates the report');

  const html = copilotActivityHtml(analytics);
  assert.match(html, /Copilot activity/);
  assert.match(html, /<strong>3<\/strong><span>Requests you sent<\/span>/);
  assert.match(html, /<strong>~2 \(partial\)<\/strong><span>Premium requests · Estimated; some models have no multiplier<\/span>/);
  assert.match(html, /Agent turns · some counted from model calls/);
  assert.match(html, /78\.1 KB of 64\.0 KB budget · ~20,000 tokens · <span class="warning-text">over budget<\/span>/);
  assert.match(html, /20\.0 KB of 64\.0 KB budget · ~5,120 tokens/);
  assert.match(html, /class="prompt-over"/, 'an over-budget prompt is drawn in the warning colour');
  assert.match(html, /class="prompt-budget"/, 'the budget is marked on the bar');
  assert.match(html, /Copilot answered 2 model calls for model-premium-2 with gpt-4\.1\. The premium allowance may have run out\./);
  assert.match(html, /\(1 failed\)/);
  assert.match(html, /Design &lt;b&gt;/);
  assert.doesNotMatch(html, /<script>|<b>/, 'labels and model names are escaped');
  assert.match(html, /GitHub's billing is authoritative/);
});

test('labels never show a missing count as zero, and an older CLI\'s report shows no Copilot section', () => {
  assert.equal(copilotCountLabel({ value: null, status: 'none' }), '—');
  assert.equal(copilotCountLabel({ value: null, status: 'unavailable' }), 'Unavailable');
  assert.equal(copilotCountLabel({ value: 0, status: 'observed' }), '0');
  assert.equal(copilotCountLabel({ value: 1200, status: 'partial' }), '1,200 (partial)');
  assert.equal(premiumLabel({ value: 2.5, status: 'estimated', missingModels: [] }), '~2.50');
  assert.equal(premiumLabel({ value: null, status: 'unavailable', missingModels: ['gpt-5'] }), 'Unavailable');
  assert.equal(promptSizeNote({ bytes: 10, estimatedTokens: 3, maximumBytes: 100, overBudget: false, omittedSections: 2, limitShare: null }),
    '2 sections left out to fit');
  assert.equal(copilotEventSentence({ phase: 'design', generation: 2, kind: 'rate-limited', operation: 'chat', count: 1, errorType: '429' }),
    'design generation 2: 1 model call was rate limited (429).');

  const older = deriveReport(workflow(), { now: at(60) });
  delete older.copilot;
  delete older.sentBack;
  for (const phase of older.phases) { delete phase.copilot; delete phase.sentBack; }
  const analytics = buildLifecycleAnalytics(older);
  assert.equal(analytics.copilot, null);
  assert.equal(analytics.sentBack, 0);
  assert.equal(copilotActivityHtml(analytics), '');
});

test('a Story Copilot sent nothing for shows why, not zero events, and blames the missing requests first', () => {
  const unmetered = workflow();
  for (const phase of Object.values(unmetered.phases)) {
    phase.telemetry = phase.telemetry.map(({ activity, ...entry }) => ({ ...entry, status: 'pending', captureGap: 'no-metered-session' }));
  }
  const html = copilotActivityHtml(buildLifecycleAnalytics(deriveReport(unmetered, { now: at(60) })));
  assert.match(html, /<strong>Unavailable<\/strong><span>Quota and model events<\/span>/, 'nothing captured is not zero events');
  assert.doesNotMatch(html, /<strong>0<\/strong><span>Quota and model events/);
  assert.match(html, /Premium requests · Requests were not captured/);
  assert.match(html, /2 generations ran without a metered Copilot session/);
  assert.match(html, /started with <code>singularity-flow copilot<\/code>/, 'commands read as code');
  assert.match(html, /20\.0 KB of 64\.0 KB budget/, 'the prompt sflow composed is still measured');
});

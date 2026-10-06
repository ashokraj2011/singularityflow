import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveReport, humanizeDuration, renderHtml, renderMarkdown } from '../src/report.mjs';

const at = (offsetMinutes) => new Date(Date.parse('2026-07-01T09:00:00.000Z') + offsetMinutes * 60_000).toISOString();

function fixtureWorkflow() {
  const usageRecord = (overrides = {}) => ({
    status: 'exact',
    source: 'provider',
    provider: 'test',
    model: 'test-model',
    inputTokens: 4000,
    outputTokens: 1000,
    cachedInputTokens: null,
    totalTokens: 5000,
    startedAt: at(0),
    completedAt: at(10),
    agent: 'developer',
    ...overrides
  });
  return {
    schemaVersion: 2,
    status: 'closed',
    currentPhase: null,
    workItem: { id: 'ENG-1', title: 'Demo feature', workType: 'feature', branch: 'ENG-1' },
    phaseOrder: ['requirements', 'design'],
    phases: {
      requirements: {
        id: 'requirements', label: 'Requirements', status: 'approved', startedAt: at(0), approvedAt: at(120),
        generation: 1, usage: [usageRecord({ agent: 'product-owner' })], checks: [],
        approvals: [{ decision: 'approved', at: at(120), actor: { name: 'Alice' }, agent: 'product-owner', selfApproval: false }]
      },
      design: {
        id: 'design', label: 'Design', status: 'approved', startedAt: at(120), approvedAt: at(480), generation: 2,
        usage: [usageRecord(), usageRecord({ status: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null })],
        checks: [{ command: 'npm test', startedAt: at(395), completedAt: at(398), status: 'passed' }],
        approvals: [
          { decision: 'rejected', at: at(200), actor: { name: 'Bob' }, agent: 'architect' },
          { decision: 'approved', at: at(480), actor: { name: 'Bob' }, agent: 'architect', selfApproval: false }
        ]
      }
    },
    usage: {
      totalTokens: 10000, records: 3, exactRecords: 2, unavailableRecords: 1,
      byPhase: {},
      byAgent: {
        'product-owner': { records: 1, exactRecords: 1, unavailableRecords: 0, totalTokens: 5000 },
        developer: { records: 2, exactRecords: 1, unavailableRecords: 1, totalTokens: 5000 }
      }
    },
    sequenceOverrides: [{
      gate: 'phaseStatus', action: 'approve', requestedPhase: 'requirements',
      reason: 'Approval was requested before submission.', at: at(110),
      actor: { name: 'Alice' }, agent: 'product-owner', before: { currentPhase: 'requirements' }
    }],
    history: [
      { at: at(480), actor: 'bob@example.com', agent: 'architect', event: 'phase_approved', phase: 'design', detail: 'complete' },
      { at: at(0), actor: 'alice@example.com', agent: 'product-owner', event: 'phase_generated', phase: 'requirements' },
      { at: at(60), actor: 'alice@example.com', agent: 'product-owner', event: 'phase_submitted', phase: 'requirements' },
      { at: at(120), actor: 'alice@example.com', agent: 'product-owner', event: 'phase_approved', phase: 'requirements' },
      { at: at(180), actor: 'bob@example.com', agent: 'developer', event: 'phase_submitted', phase: 'design' },
      { at: at(200), actor: 'bob@example.com', agent: 'architect', event: 'phase_rejected', phase: 'design', detail: 'missing diagram' },
      { at: at(400), actor: 'bob@example.com', agent: 'developer', event: 'phase_submitted', phase: 'design' }
    ]
  };
}

test('deriveReport computes phase waiting, active time, rework, tokens, and bottleneck from unordered history', () => {
  const report = deriveReport(fixtureWorkflow(), { now: at(480) });
  assert.equal(report.workItem.id, 'ENG-1');
  assert.equal(report.completedAt, at(480));
  assert.equal(report.elapsedMs, 480 * 60_000);
  assert.equal(report.phases[0].waitingMs, 60 * 60_000);
  assert.equal(report.phases[0].activeMs, 60 * 60_000);
  assert.equal(report.phases[1].waitingMs, 100 * 60_000);
  assert.equal(report.phases[1].rejections.length, 1);
  assert.equal(report.reworkCycles, 1);
  assert.equal(report.tokens.total, 10000);
  assert.deepEqual(report.tokens.byModel, [{
    provider: 'test', model: 'test-model', records: 3, exactRecords: 2, unavailableRecords: 1, totalTokens: 10000,
    inputTokens: 8000, outputTokens: 2000, cachedInputTokens: null,
    inputTokenRecords: 2, outputTokenRecords: 2, cachedInputTokenRecords: 0,
    cost: null, pricedRecords: 0, fullyPricedRecords: 0, providerCostRecords: 0, configuredPriceRecords: 0, costStatus: 'unavailable'
  }]);
  assert.deepEqual(report.costCoverage, {
    usageRecords: 3, exactUsageRecords: 2, pendingRecords: 0, pricedRecords: 0, fullyPricedRecords: 0,
    providerCostRecords: 0, configuredPriceRecords: 0, missingModels: ['test/test-model']
  });
  assert.equal(report.phases[1].tokenStatus, 'partial');
  assert.equal(report.bottleneck.phase, 'design');
});

test('deriveReport prices only exact usage with configured per-million model prices', () => {
  const report = deriveReport(fixtureWorkflow(), { now: at(480), pricing: { 'test-model': { input: 3, output: 15 } } });
  assert.ok(Math.abs(report.cost - 0.054) < 1e-9);
  assert.ok(Math.abs(report.phases[0].cost - 0.027) < 1e-9);
  assert.equal(report.phases[1].costStatus, 'partial');
  assert.equal(report.costStatus, 'partial');
  assert.equal(report.tokens.byModel[0].cost, 0.054);
  assert.equal(report.tokens.byModel[0].pricedRecords, 2);
  assert.equal(report.tokens.byModel[0].configuredPriceRecords, 2);
  assert.equal(report.costCoverage.pricedRecords, 2);
});

test('deriveReport prefers exact provider cost captured from Copilot telemetry', () => {
  const workflow = fixtureWorkflow();
  workflow.phases.requirements.usage[0].providerCost = 0.031;
  workflow.phases.requirements.usage[0].costStatus = 'exact';
  workflow.phases.design.usage = [];
  const report = deriveReport(workflow, { now: at(480) });
  assert.equal(report.cost, 0.031);
  assert.equal(report.costStatus, 'exact');
  assert.equal(report.phases[0].cost, 0.031);
  assert.equal(report.tokens.byModel[0].providerCostRecords, 1);
  assert.equal(report.tokens.byModel[0].costStatus, 'exact');
});

test('deriveReport does not invent a zero cost when only total tokens are available', () => {
  const workflow = fixtureWorkflow();
  workflow.phases.requirements.usage = [{
    status: 'exact', model: 'test-model', inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: 5000, agent: 'product-owner'
  }];
  workflow.phases.design.usage = [];
  const report = deriveReport(workflow, { now: at(480), pricing: { 'test-model': { input: 3, output: 15 } } });
  assert.equal(report.cost, null);
  assert.equal(report.phases[0].costStatus, 'unavailable');
});

test('deriveReport includes an open approval wait through report generation time', () => {
  const workflow = fixtureWorkflow();
  workflow.status = 'in_progress';
  workflow.currentPhase = 'design';
  workflow.phases.design.status = 'awaiting_approval';
  workflow.phases.design.approvedAt = null;
  workflow.history = workflow.history.filter((event) => !(event.phase === 'design' && event.event === 'phase_approved'));
  const report = deriveReport(workflow, { now: at(500) });
  assert.equal(report.completedAt, null);
  assert.equal(report.phases[1].openSubmission, at(400));
  assert.equal(report.phases[1].waitingMs, 120 * 60_000);
});

test('policy waivers are reported distinctly and never count as human approval waiting', () => {
  const workflow = fixtureWorkflow();
  workflow.phases.requirements.approvalDisposition = 'policy_waived';
  workflow.phases.requirements.approvals = [];
  workflow.history = workflow.history
    .filter((event) => !(event.phase === 'requirements' && event.event === 'phase_approved'))
    .concat({ at: at(120), actor: 'engine', agent: 'developer', event: 'phase-approval-waived', phase: 'requirements' });
  const report = deriveReport(workflow, { now: at(480) });
  assert.equal(report.phases[0].approvalDisposition, 'policy_waived');
  assert.equal(report.phases[0].approvals, 0);
  assert.equal(report.phases[0].waitingMs, 0);
  assert.match(renderMarkdown(report), /policy waived/);
  assert.match(renderHtml(report), /policy waived/);
});

test('a waiver left by an earlier round does not relabel a phase people approved, or one in progress', () => {
  // Older builds kept the record when the phase was reopened.
  const workflow = fixtureWorkflow();
  workflow.phases.requirements.approvalDisposition = 'policy_waived';
  workflow.phases.requirements.approvalWaiver = { policyId: 'quick-fix-low-risk-v1' };
  workflow.phases.design.approvalDisposition = 'policy_waived';
  workflow.phases.design.status = 'in_progress';
  workflow.phases.design.approvals = [];
  const report = deriveReport(workflow, { now: at(480) });
  assert.equal(report.phases[0].approvalDisposition, 'human_approved');
  assert.equal(report.phases[0].waitingMs, 60 * 60_000, 'the human review wait is still measured');
  assert.equal(report.phases[1].approvalDisposition, null);
  assert.doesNotMatch(renderMarkdown(report), /policy waived/);
});

test('markdown and HTML render escaped, script-free report summaries and limitations', () => {
  const report = deriveReport(fixtureWorkflow(), { now: at(480) });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /# ENG-1 — Demo feature \(feature\)/);
  assert.match(markdown, /1 rework cycle/);
  assert.match(markdown, /10,000 exact tokens/);
  assert.match(markdown, /Provider \/ model/);
  assert.match(markdown, /Token usage by model/);
  assert.match(markdown, /test-model/);
  assert.match(markdown, /Bottleneck/);
  assert.match(markdown, /Soft sequence overrides/);
  assert.match(markdown, /phaseStatus/);
  assert.match(markdown, /wall-clock/);
  const html = renderHtml(report);
  assert.match(html, /<svg/);
  assert.match(html, /ENG-1/);
  assert.match(html, /Token usage by model/);
  assert.match(html, /test-model/);
  assert.match(html, /Soft sequence overrides/);
  assert.doesNotMatch(html, /<script/);
});

test('humanizeDuration chooses seconds, minutes, hours, and days', () => {
  assert.equal(humanizeDuration(45000), '45s');
  assert.equal(humanizeDuration(30 * 60000), '30m');
  assert.equal(humanizeDuration(5 * 3600000), '5.0h');
  assert.equal(humanizeDuration(3 * 86400000), '3.0d');
  assert.equal(humanizeDuration(null), '—');
});

function copilotWorkflow() {
  const activity = (fields) => ({
    source: 'copilot-otel', requests: 1, turns: null, turnsCounted: 0, turnsAssurance: 'unavailable',
    modelCalls: null, toolCalls: 0, failedRequests: 0, failedModelCalls: 0, failedToolCalls: 0,
    requestsByModel: [], promptLimits: [], events: [], omittedEvents: 0, ...fields
  });
  const prompt = (bytes, maximumBytes = 65536, fields = {}) => ({
    source: 'sflow-composition', bytes, estimatedTokens: Math.ceil(bytes / 4),
    estimation: 'UTF-8 bytes divided by four, rounded up', maximumBytes, maximumEstimatedTokens: maximumBytes / 4,
    budgetMode: 'observe', originalBytes: bytes, omittedSections: 0, ...fields
  });
  const event = (kind, fields) => ({
    kind, operation: 'chat', requestedModel: 'model-premium-2', resolvedModel: null, errorType: null,
    count: 1, firstAt: '2026-07-01T12:00:00.000Z', lastAt: '2026-07-01T12:00:00.000Z', ...fields
  });
  return {
    schemaVersion: 2, status: 'in_progress', currentPhase: 'implementation',
    workItem: { id: 'ENG-7', title: 'Copilot metered', workType: 'feature', branch: 'ENG-7' },
    phaseOrder: ['requirements', 'design', 'implementation'],
    phases: {
      requirements: {
        id: 'requirements', label: 'Requirements', status: 'approved', startedAt: at(0), approvedAt: at(60), generation: 1,
        usage: [{ status: 'unavailable', generation: 1, spans: 5, model: 'model-alpha-1.5', provider: 'github' }],
        telemetry: [{ generation: 1, status: 'unavailable', models: ['model-alpha-1.5'], activity: activity({
          requests: 2, turns: 5, turnsCounted: 2, turnsAssurance: 'provider-reported', modelCalls: 5, toolCalls: 8, failedToolCalls: 1,
          requestsByModel: [{ model: 'model-alpha-1.5', requests: 2 }],
          promptLimits: [{ model: 'model-alpha-1.5', maxPromptTokens: 100000 }]
        }), prompt: prompt(20480) }],
        approvals: [], checks: []
      },
      design: {
        id: 'design', label: 'Design', status: 'approved', startedAt: at(60), approvedAt: at(300), generation: 2,
        // Generation 1 predates activity counting: only its chat-span count is known.
        usage: [{ status: 'unavailable', generation: 1, spans: 3, model: 'model-premium-2', provider: 'github' }],
        telemetry: [
          { generation: 1, status: 'unavailable', models: ['model-premium-2'] },
          { generation: 2, status: 'unavailable', models: ['model-premium-2'], activity: activity({
            requests: 1, turns: 4, turnsCounted: 1, turnsAssurance: 'derived-from-model-calls', modelCalls: 4, toolCalls: 2,
            requestsByModel: [{ model: 'model-premium-2', requests: 1 }],
            events: [
              event('model-substituted', { resolvedModel: 'gpt-4.1', count: 2 }),
              event('rate-limited', { errorType: '429', firstAt: '2026-07-01T12:05:00.000Z', lastAt: '2026-07-01T12:05:00.000Z' })
            ]
          }), prompt: prompt(80000) }
        ],
        approvals: [], checks: []
      },
      implementation: {
        id: 'implementation', label: 'Implementation', status: 'in_progress', startedAt: at(300), generation: 1,
        usage: [], telemetry: [{ generation: 1, status: 'not-invoked', models: [] }], approvals: [], checks: []
      }
    },
    usage: { totalTokens: 0, records: 2, exactRecords: 0, unavailableRecords: 2, byPhase: {}, byAgent: {} },
    sequenceOverrides: [],
    history: [
      { at: at(200), actor: 'bob@example.com', agent: 'architect', event: 'phase_rejected', phase: 'implementation', detail: 'CR-001 returned to design: the diagram is missing' }
    ]
  };
}

test('the report counts Copilot requests, turns, calls, premium requests and prompt size per phase without inventing values', () => {
  const report = deriveReport(copilotWorkflow(), { premiumMultipliers: { 'model-alpha-1.5': 1 }, now: at(360) });
  const [requirements, design, implementation] = report.phases;

  assert.equal(requirements.copilot.status, 'observed');
  assert.deepEqual(requirements.copilot.requests, { value: 2, status: 'observed' });
  assert.deepEqual(requirements.copilot.turns, { value: 5, status: 'observed' });
  assert.deepEqual(requirements.copilot.toolCalls, { value: 8, status: 'observed' });
  assert.deepEqual(requirements.copilot.failedToolCalls, { value: 1, status: 'observed' });
  assert.deepEqual(requirements.copilot.premiumRequests, { value: 2, status: 'estimated', missingModels: [] });
  assert.equal(requirements.copilot.prompt.bytes, 20480);
  assert.equal(requirements.copilot.prompt.limitTokens, 100000);
  assert.equal(requirements.copilot.prompt.limitShare, 5);
  assert.equal(requirements.copilot.prompt.overBudget, false);

  assert.equal(design.copilot.status, 'partial', 'generation 1 was not captured');
  assert.deepEqual(design.copilot.requests, { value: 1, status: 'partial' });
  assert.deepEqual(design.copilot.turns, { value: 4, status: 'partial' });
  assert.equal(design.copilot.turnsDerived, true);
  assert.deepEqual(design.copilot.modelCalls, { value: 7, status: 'observed' }, 'chat-span counts fill in for older records');
  assert.deepEqual(design.copilot.premiumRequests, { value: null, status: 'unavailable', missingModels: ['model-premium-2'] });
  assert.deepEqual(design.copilot.events.map((entry) => [entry.generation, entry.kind]), [[2, 'model-substituted'], [2, 'rate-limited']]);
  assert.equal(design.copilot.prompt.overBudget, true);
  assert.equal(design.sentBack, 1, 'implementation\'s reviewer sent the work back to design');

  assert.equal(implementation.copilot.status, 'none', 'a manual generation sent nothing to Copilot');
  assert.deepEqual(implementation.copilot.requests, { value: null, status: 'none' });
  assert.equal(implementation.copilot.prompt, null);
  assert.equal(implementation.rejections[0].returnedTo, 'design');

  assert.deepEqual(report.copilot.requests, { value: 3, status: 'partial' });
  assert.deepEqual(report.copilot.premiumRequests, { value: 2, status: 'partial', missingModels: ['model-premium-2'] });
  assert.equal(report.copilot.premiumMultipliersConfigured, true);
  assert.deepEqual(report.copilot.events.map((entry) => entry.phase), ['design', 'design']);
  assert.deepEqual(report.copilot.largestPrompt, { phase: 'design', bytes: 80000, estimatedTokens: 20000 });
  assert.deepEqual(report.copilot.promptsOverBudget, ['design']);
  assert.equal(report.sentBack, 1);

  const markdown = renderMarkdown(report);
  assert.match(markdown, /tokens unavailable \(the provider did not report them\)/, 'no exact usage is not zero tokens');
  assert.match(markdown, /1 rework cycle · 1 send-back · tokens unavailable/);
  assert.match(markdown, /\| github \| model-alpha-1\.5 \| 1 \| 0 \| 1 \| unavailable \|/);
  assert.match(markdown, /## Copilot activity by phase/);
  assert.match(markdown, /\| Design \(`design`\) \| 2 \| 1 \| 1\* \| 4\* \| 7 \| 2\* \| unavailable \| 78\.1 KB \(~20,000 tokens\), over its 64\.0 KB budget \|/);
  assert.match(markdown, /\| Requirements \(`requirements`\) \| 1 \| 0 \| 2 \| 5 \| 5 \| 8 \(1 failed\) \| ~2 \| 20\.0 KB \(~5,120 tokens\), 5% of the model's prompt limit \|/);
  assert.match(markdown, /\| Implementation \(`implementation`\) \| 1 \| 0 \| — \| — \| — \| — \| — \| — \|/);
  assert.match(markdown, /Copilot answered 2 model calls for model-premium-2 with gpt-4\.1/);
  assert.match(markdown, /design generation 2, from 2026-07-01T12:05:00\.000Z: 1 model call was rate limited \(429\)\./);
  assert.match(markdown, /3 quota or model events/, 'two substituted calls and one rate-limited call');
  assert.equal(design.copilot.eventCount, 3);
  assert.match(markdown, /Premium requests are partial: no `tokens\.premiumMultipliers` entry for model-premium-2/);
  assert.match(markdown, /GitHub's billing is authoritative/);

  const html = renderHtml(report);
  assert.match(html, /<h2>Copilot activity by phase<\/h2>/);
  assert.match(html, /Estimated premium requests/);
  assert.match(html, /stroke-dasharray="4 3"/, 'the prompt budget is drawn');
  assert.match(html, /⚠ 3 quota\/model events/);
  assert.match(html, /no model-assisted generation/);
  assert.match(html, /unavailable: the provider did not report tokens/, 'tokens Copilot did not report are not drawn as zero');
  assert.match(html, /of 64\.0 KB budget, over it/);
  assert.match(html, /<code>singularity-flow copilot<\/code>/);
  assert.doesNotMatch(html, /<script/);
});

test('without multipliers premium requests stay unavailable, and a Story with no Copilot data gets no section', () => {
  const report = deriveReport(copilotWorkflow(), { now: at(360) });
  assert.deepEqual(report.copilot.premiumRequests, {
    value: null, status: 'unavailable', missingModels: ['model-alpha-1.5', 'model-premium-2']
  });
  assert.equal(report.copilot.premiumMultipliersConfigured, false);
  assert.match(renderMarkdown(report), /Premium requests are unavailable: no `tokens\.premiumMultipliers` entry/);

  const plain = deriveReport(fixtureWorkflow());
  assert.equal(plain.copilot.status, 'none');
  assert.equal(plain.phases[1].rejections[0].returnedTo, null, 'an older rejection detail names no target');
  assert.doesNotMatch(renderMarkdown(plain), /Copilot activity/);
  assert.doesNotMatch(renderHtml(plain), /Copilot activity/);
});

test('a generation Copilot sent nothing for says why, with what to do, and never claims zero events', () => {
  const generation = (number, status, extra = {}) => ({ generation: number, status, models: [], ...extra });
  const phase = (id, telemetry) => ({
    id, label: id, status: 'approved', startedAt: at(0), approvedAt: at(10), generation: telemetry.length,
    usage: [], approvals: [], checks: [], telemetry
  });
  const workflow = {
    status: 'in_progress', currentPhase: 'specification',
    workItem: { id: 'ENG-8', title: 'Unmetered', workType: 'spec-driven', branch: 'ENG-8' },
    phaseOrder: ['specification', 'planning', 'release'],
    phases: {
      // Composed and published from native chat: a prompt, but no spans.
      specification: phase('specification', [generation(1, 'pending', {
        captureGap: 'no-metered-session',
        prompt: { source: 'sflow-composition', bytes: 21600, estimatedTokens: 5400, maximumBytes: 72000, omittedSections: 0 }
      })]),
      // Publication with no spans is always pending; the recorded gap says why. The last two
      // predate the gap: one wrote usage before activity counting, one cannot say.
      planning: phase('planning', [
        generation(1, 'pending', { captureGap: 'awaiting-export' }), generation(2, 'pending', { captureGap: 'disabled' }),
        generation(3, 'pending', { captureGap: 'conflict' }), generation(4, 'exact'), generation(5, 'pending')
      ]),
      release: phase('release', [generation(1, 'not-invoked')])
    },
    usage: { byAgent: {}, byPhase: {} }, sequenceOverrides: [], history: []
  };
  const report = deriveReport(workflow, { now: at(60) });
  assert.deepEqual(report.phases[0].copilot.uncaptured, { 'not-metered': 1 });
  assert.deepEqual(report.phases[1].copilot.uncaptured, { pending: 1, disabled: 1, conflict: 1, 'older-record': 1, unconfirmed: 1 });
  assert.deepEqual(report.phases[2].copilot.uncaptured, {}, 'a manual generation sent nothing, and needs no reason');
  assert.equal(report.copilot.status, 'unavailable');
  assert.deepEqual(report.copilot.captureNotes, [
    '1 generation is waiting for Copilot to export the finished turn; the next submit reconciles it.',
    '1 generation has no Copilot activity. Work in a session started with `singularity-flow copilot` is reconciled on the next submit; native Copilot Chat sends SFlow nothing, so those counts stay unavailable.',
    '1 generation ran with local capture turned off; run `singularity-flow telemetry enable` to accept it.',
    '1 generation found an OpenTelemetry setup SFlow would not override; see `singularity-flow telemetry probe`.',
    '1 generation ran without a metered Copilot session. Copilot reports requests, turns and calls to SFlow only for sessions started with `singularity-flow copilot` (in VS Code, Continue with Copilot CLI) after `singularity-flow telemetry enable`; native Copilot Chat sends SFlow nothing.',
    '1 generation was published before SFlow counted Copilot activity.'
  ]);

  const markdown = renderMarkdown(report);
  assert.match(markdown, /\*\*Why some counts are unavailable:\*\*\n\n- 1 generation is waiting/);
  assert.doesNotMatch(markdown, /\b0 quota or model events/, 'nothing captured is not zero events');
  const html = renderHtml(report);
  assert.match(html, /<h3>Why some counts are unavailable<\/h3>/);
  assert.match(html, /started with <code>singularity-flow copilot<\/code>/);
});

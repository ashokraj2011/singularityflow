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
    persona: 'developer',
    ...overrides
  });
  return {
    schemaVersion: 2,
    status: 'complete',
    currentPhase: null,
    workItem: { id: 'ENG-1', title: 'Demo feature', workType: 'feature', branch: 'ENG-1' },
    phaseOrder: ['requirements', 'design'],
    phases: {
      requirements: {
        id: 'requirements', label: 'Requirements', status: 'approved', startedAt: at(0), approvedAt: at(120),
        generation: 1, usage: [usageRecord({ persona: 'product-owner' })], checks: [],
        approvals: [{ decision: 'approved', at: at(120), actor: { name: 'Alice' }, persona: 'product-owner', selfApproval: false }]
      },
      design: {
        id: 'design', label: 'Design', status: 'approved', startedAt: at(120), approvedAt: at(480), generation: 2,
        usage: [usageRecord(), usageRecord({ status: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null })],
        checks: [{ command: 'npm test', startedAt: at(395), completedAt: at(398), status: 'passed' }],
        approvals: [
          { decision: 'rejected', at: at(200), actor: { name: 'Bob' }, persona: 'architect' },
          { decision: 'approved', at: at(480), actor: { name: 'Bob' }, persona: 'architect', selfApproval: false }
        ]
      }
    },
    usage: {
      totalTokens: 10000, records: 3, exactRecords: 2, unavailableRecords: 1,
      byPhase: {},
      byPersona: {
        'product-owner': { records: 1, exactRecords: 1, unavailableRecords: 0, totalTokens: 5000 },
        developer: { records: 2, exactRecords: 1, unavailableRecords: 1, totalTokens: 5000 }
      }
    },
    sequenceOverrides: [{
      gate: 'phaseStatus', action: 'approve', requestedPhase: 'requirements',
      reason: 'Approval was requested before submission.', at: at(110),
      actor: { name: 'Alice' }, persona: 'product-owner', before: { currentPhase: 'requirements' }
    }],
    history: [
      { at: at(480), actor: 'bob@example.com', persona: 'architect', event: 'phase_approved', phase: 'design', detail: 'complete' },
      { at: at(0), actor: 'alice@example.com', persona: 'product-owner', event: 'phase_generated', phase: 'requirements' },
      { at: at(60), actor: 'alice@example.com', persona: 'product-owner', event: 'phase_submitted', phase: 'requirements' },
      { at: at(120), actor: 'alice@example.com', persona: 'product-owner', event: 'phase_approved', phase: 'requirements' },
      { at: at(180), actor: 'bob@example.com', persona: 'developer', event: 'phase_submitted', phase: 'design' },
      { at: at(200), actor: 'bob@example.com', persona: 'architect', event: 'phase_rejected', phase: 'design', detail: 'missing diagram' },
      { at: at(400), actor: 'bob@example.com', persona: 'developer', event: 'phase_submitted', phase: 'design' }
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
    provider: 'test', model: 'test-model', records: 3, exactRecords: 2, unavailableRecords: 1, totalTokens: 10000
  }]);
  assert.equal(report.phases[1].tokenStatus, 'partial');
  assert.equal(report.bottleneck.phase, 'design');
});

test('deriveReport prices only exact usage with configured per-million model prices', () => {
  const report = deriveReport(fixtureWorkflow(), { now: at(480), pricing: { 'test-model': { input: 3, output: 15 } } });
  assert.ok(Math.abs(report.cost - 0.054) < 1e-9);
  assert.ok(Math.abs(report.phases[0].cost - 0.027) < 1e-9);
  assert.equal(report.phases[1].costStatus, 'partial');
  assert.equal(report.costStatus, 'partial');
});

test('deriveReport does not invent a zero cost when only total tokens are available', () => {
  const workflow = fixtureWorkflow();
  workflow.phases.requirements.usage = [{
    status: 'exact', model: 'test-model', inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: 5000, persona: 'product-owner'
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

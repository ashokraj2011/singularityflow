import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildDashboard, buildLifecycleAnalytics } from '../apps/vscode/src/views/dashboard-model.ts';
import { phaseDetailId, storyPhaseFlowHtml, STORY_PHASE_FLOW_STYLE } from '../apps/vscode/src/views/dashboard-phase-flow.ts';
import { deriveReport } from '../src/report.mjs';

function report(statuses = ['approved', 'in_progress', 'not_started']) {
  const ids = statuses.map((_, index) => `custom-phase-${index}`);
  return deriveReport({
    workItem: { id: 'STORY-42', title: 'Custom workflow', workType: 'custom', branch: 'feature/custom' },
    status: 'in_progress', phaseOrder: ids, currentPhase: ids[1] ?? ids[0],
    phases: Object.fromEntries(ids.map((id, index) => [id, {
      id, label: `Custom phase ${index + 1}`, status: statuses[index], generation: 0,
      usage: [], telemetry: [], approvals: [], checks: []
    }])),
    history: [], sequenceOverrides: []
  });
}

test('Analytics draws every report phase in order with one arrow per connection and timing links', () => {
  const analytics = buildLifecycleAnalytics(report());
  const before = JSON.stringify(analytics);
  const html = storyPhaseFlowHtml(analytics);
  assert.match(html, /<ol aria-label="Story workflow phases">/u);
  assert.equal((html.match(/class="story-phase-card"/gu) ?? []).length, 3);
  assert.equal((html.match(/class="story-phase-arrow"/gu) ?? []).length, 2);
  for (let index = 0; index < 3; index++) {
    assert.ok(html.includes(`href="#${phaseDetailId(index)}"`));
    assert.ok(html.indexOf(`Custom phase ${index + 1}`) > html.indexOf(`Custom phase ${index}`));
  }
  assert.equal((html.match(/aria-current="step"/gu) ?? []).length, 1);
  assert.match(html, /done[\s\S]*Approved/u);
  assert.match(html, /current[\s\S]*Current phase · In progress/u);
  assert.match(html, /Not started/u);
  assert.match(html, /phase order, not executed decision or repair routes/u);
  assert.equal(JSON.stringify(analytics), before, 'rendering does not alter lifecycle state');
});

test('waiting, rejected, stale and skipped phases keep their actual status rather than implying approval', () => {
  const html = storyPhaseFlowHtml(buildLifecycleAnalytics(report([
    'awaiting_approval', 'rejected', 'stale', 'skipped', 'not_started'
  ])));
  assert.match(html, /story-phase-node waiting current/u);
  assert.match(html, /Current phase · Awaiting approval/u);
  assert.match(html, /story-phase-node attention[\s\S]*Rejected/u);
  assert.match(html, /story-phase-node attention[\s\S]*Stale/u);
  assert.match(html, /story-phase-node skipped[\s\S]*Skipped/u);
  assert.doesNotMatch(html, /story-phase-node done/u);
});

test('single, empty and completed reports render without dangling arrows or an invented current phase', () => {
  const single = storyPhaseFlowHtml(buildLifecycleAnalytics(report(['approved'])));
  assert.equal((single.match(/class="story-phase-card"/gu) ?? []).length, 1);
  assert.doesNotMatch(single, /story-phase-arrow|aria-current/u);
  assert.match(storyPhaseFlowHtml({ phases: [], currentPhase: null }), /No workflow phases are recorded/u);
  const completed = storyPhaseFlowHtml(buildLifecycleAnalytics(report(['approved', 'approved'])));
  assert.doesNotMatch(completed, /aria-current/u);
});

test('labels and statuses are escaped; repository IDs cannot become link destinations or executable markup', () => {
  const analytics = buildLifecycleAnalytics(report(['in_progress']));
  analytics.phases[0].id = '" onclick="alert(1)';
  analytics.phases[0].label = '<script>bad()</script> & "QA"';
  analytics.phases[0].status = '<img src=x onerror=alert(1)>';
  const html = storyPhaseFlowHtml(analytics);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt; &amp; &quot;QA&quot;/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(html, /href="#story-phase-detail-0"/u);
  assert.doesNotMatch(html, /<script>|<img|onclick="|href="javascript:/u);
});

test('the selected Story workflow supplies current phase even while an approved phase waits for a decision', () => {
  const data = report(['approved', 'not_started', 'not_started']);
  const snapshot = { report: data, workflow: { workItem: { id: 'STORY-42' }, currentPhase: 'custom-phase-0' } };
  const analytics = buildDashboard(snapshot).analytics;
  assert.equal(analytics.currentPhase, 'custom-phase-0');
  assert.match(storyPhaseFlowHtml(analytics), /Current phase · Approved/u);
  snapshot.workflow.currentPhase = null;
  assert.equal(buildDashboard(snapshot).analytics.currentPhase, null);
  snapshot.workflow.workItem.id = 'ANOTHER-STORY';
  snapshot.workflow.currentPhase = 'custom-phase-0';
  assert.equal(buildDashboard(snapshot).analytics.currentPhase, null, 'never join a different Story binding');
  assert.equal(buildLifecycleAnalytics(data, 'missing-phase').currentPhase, null);
  for (const status of ['closed', 'cancelled']) {
    data.workItem.status = status;
    snapshot.workflow.workItem.id = 'STORY-42';
    assert.equal(buildDashboard(snapshot).analytics.currentPhase, null, 'terminal Stories have no active phase');
  }
});

test('large custom workflows retain every phase and do not hard-code a seeded six-phase journey', () => {
  const data = report(Array.from({ length: 30 }, (_, index) => index < 12 ? 'approved' : 'not_started'));
  data.phases[12].status = 'in_progress';
  data.phases[29].label = 'A custom final phase with a very long name';
  const html = storyPhaseFlowHtml(buildLifecycleAnalytics(data));
  assert.equal((html.match(/class="story-phase-card"/gu) ?? []).length, 30);
  assert.equal((html.match(/class="story-phase-arrow"/gu) ?? []).length, 29);
  assert.match(html, /A custom final phase with a very long name/u);
  assert.match(html, /href="#story-phase-detail-12" aria-current="step"/u);
});

test('Analytics wires the diagram and matching timing targets into its existing CSP-protected page', async () => {
  const dashboard = await readFile(new URL('../apps/vscode/src/views/dashboard.ts', import.meta.url), 'utf8');
  assert.match(dashboard, /\$\{storyPhaseFlowHtml\(analytics\)\}/u);
  assert.match(dashboard, /<tr id="\$\{phaseDetailId\(index\)\}" class="story-phase-detail" tabindex="-1">/u);
  assert.match(dashboard, /styles: STORY_PHASE_FLOW_STYLE/u);
  assert.match(dashboard, /contentSecurityPolicy\(this\.panel\.webview, token\)/u);
  assert.match(STORY_PHASE_FLOW_STYLE, /@media \(max-width: 600px\)/u);
  assert.match(STORY_PHASE_FLOW_STYLE, /transform: rotate\(90deg\)/u);
  assert.match(STORY_PHASE_FLOW_STYLE, /:focus-visible/u);
  assert.match(STORY_PHASE_FLOW_STYLE, /forced-colors: active/u);
});

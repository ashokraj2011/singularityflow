import assert from 'node:assert/strict';
import test from 'node:test';
import { sharedWorkflowDraftsHtml } from '../apps/vscode/src/views/workflow-drafts-page.ts';

function view(preview) {
  return { repository: '/exact/repository', authority: '/exact/authority.git', drafts: [], listHead: null,
    editor: null, busy: false, dirty: false, error: null, notice: null, show: null, preview,
    operationId: null, stage: 1, autosave: false, durability: 'shared',
    recovery: { status: 'none', checkpoint: null, candidate: null, candidateAvailable: false, restoreAllowed: false } };
}
function preview() {
  return { planSha256: `sha256:${'a'.repeat(64)}`, readiness: { authoring: 'valid',
    simulation: 'complete-for-profile', host: 'discovery-unverified', execution: 'not-run' }, findings: [],
    simulation: { profile: 'story-structural-lifecycle/v1', status: 'complete-for-profile', workflows: [{
      workflowId: 'team-notes', status: 'complete-for-profile', sourceDefinitionSha256: `sha256:${'b'.repeat(64)}`,
      coverage: { phaseCount: 3, eventCount: 12, excluded: ['human-availability', 'native-host-enforcement'] },
      scenarios: [{ id: 'human-wait:team-note', phaseId: 'team-note', expected: 'wait-not-deadlock', outcome: 'expected-wait' }]
    }] } };
}

test('saved package shows structural scenario table and explicit non-execution boundaries', () => {
  const html = sharedWorkflowDraftsHtml(view(preview()));
  assert.match(html, /Structural lifecycle simulation · complete-for-profile/u);
  assert.match(html, /human-wait:team-note/u); assert.match(html, /wait-not-deadlock/u);
  assert.match(html, /Projected outcome/u); assert.match(html, /human-availability, native-host-enforcement/u);
  assert.match(html, /no tests, models, human decisions or external operations were executed/u);
  assert.match(html, /Exact saved-revision Preview JSON/u);
  assert.doesNotMatch(html, /data-draft-action="(?:simulate-execute|activate|approve)"/u);
});

test('missing or incomplete simulation never masquerades as complete; untrusted scenario strings remain literal', () => {
  const historical = preview(); delete historical.simulation;
  assert.match(sharedWorkflowDraftsHtml(view(historical)), /simulation was not reported/u);
  const current = preview(); current.simulation.status = 'incomplete';
  current.simulation.workflows[0].workflowId = '<script>untrusted</script>';
  current.simulation.workflows[0].scenarios[0].outcome = '</td><img src=x onerror=alert(1)>';
  const html = sharedWorkflowDraftsHtml(view(current));
  assert.match(html, /Structural lifecycle simulation · incomplete/u);
  assert.match(html, /&lt;script&gt;untrusted&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script>untrusted|<img src=x/u);
});

test('large bounded report discloses summary truncation without truncating the exact saved report', () => {
  const value = preview(); value.simulation.workflows[0].scenarios = Array.from({ length: 65 }, (_, index) => ({
    id: `case-${index}`, phaseId: 'team-note', expected: 'expected', outcome: 'expected-wait'
  }));
  const html = sharedWorkflowDraftsHtml(view(value));
  assert.match(html, /first 64 of 65/u);
  assert.match(html, /case-64/u, 'the exact JSON includes every bounded scenario');
  assert.equal((html.match(/<tr><td>case-/gu) ?? []).length, 64);
});

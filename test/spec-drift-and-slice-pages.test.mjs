/**
 * The last two terminal-only steps on a page [owner, 2026-11-28]: Spec Studio lists each clause a finished Story delivered that
 * drifted from its code, accepted or fixed through a Story in progress with one press and a reason; the Story's intake details
 * drop a sliced clause from the Story or bring it back, with what dropping does beside it. Each runs the person's own command.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { driftDecisionArgv, driftFrom } from '../apps/vscode/src/views/spec-studio-model.ts';
import { driftHtml } from '../apps/vscode/src/views/spec-studio-page.ts';
import { droppedSliceClauses, SLICE_DROP_WORDS, storyIntakeBody } from '../apps/vscode/src/views/story-intake-page.ts';
import { OWN_STEP_ROUTES } from '../src/person-step-routes.mjs';

const REASON = 'The louder greeting is what the product wants now.';
const read = { data: { drift: { stories: [{ workId: 'TOY-001', title: 'Greeting', clauses: [
  { clauseId: 'TOY-001:AC-001', status: 'drifted', findings: [{ message: 'src/greet.js changed since approval.' }] },
  { clauseId: 'TOY-001:AC-002', status: 'in-sync', findings: [] },
  { clauseId: 'TOY-001:AC-003', status: 'accepted', findings: [] }] }] }, openStories: [{ workId: 'FIX-7', title: 'Fix the greeting' }, { workId: 'bad id' }] } };

test('Spec Studio lists each drifted clause; Accept or Fix records it with the person\'s reason, one press each', () => {
  const drift = driftFrom(read);
  assert.deepEqual(drift, { rows: [{ workId: 'TOY-001', title: 'Greeting', clauseId: 'TOY-001:AC-001', status: 'drifted', findings: ['src/greet.js changed since approval.'] }],
    openStories: [{ workId: 'FIX-7', title: 'Fix the greeting' }] }, 'only what waits for a decision, and only real Work IDs');
  const html = driftHtml(drift);
  assert.match(html, /These clauses no longer match the code and tests their finished Story delivered\. Accept the difference, or fix it in a Story in progress/u);
  assert.match(html, /data-form="spec\.drift"[\s\S]*name="reason"[\s\S]*value="accept">Accept the difference[\s\S]*<option value="FIX-7">FIX-7 · Fix the greeting[\s\S]*value="fix" class="secondary">Fix it in that Story/u);
  assert.deepEqual(driftDecisionArgv(drift, { clause: 'TOY-001:AC-001', outcome: 'accept', reason: REASON }),
    { argv: ['spec', 'drift', 'decide', 'TOY-001:AC-001', '--accept', '--reason', REASON, '--json'] });
  assert.deepEqual(driftDecisionArgv(drift, { clause: 'TOY-001:AC-001', outcome: 'fix', reason: REASON, story: 'FIX-7', direction: 'restore' }),
    { argv: ['spec', 'drift', 'decide', 'TOY-001:AC-001', '--restore', '--story', 'FIX-7', '--reason', REASON, '--json'] });
  // Nothing the list did not show runs: another clause, a short reason, a Story not in progress, an unknown direction.
  for (const given of [{ clause: 'TOY-001:AC-002', outcome: 'accept', reason: REASON }, { clause: 'TOY-001:AC-001', outcome: 'accept', reason: 'Too short.' },
    { clause: 'TOY-001:AC-001', outcome: 'fix', reason: REASON, story: 'OTHER-1', direction: 'restore' },
    { clause: 'TOY-001:AC-001', outcome: 'fix', reason: REASON, story: 'FIX-7', direction: 'rewrite' }]) {
    assert.ok('problem' in driftDecisionArgv(drift, given), JSON.stringify(given));
  }
  // With no Story in progress, Fix says how it becomes possible instead of a dead button.
  assert.match(driftHtml({ ...drift, openStories: [] }), /To fix it instead, start a Story that changes it: it is offered here then\./u);
  assert.equal(driftHtml({ rows: [], openStories: [] }), '', 'no drift, no list');
  assert.equal(OWN_STEP_ROUTES['spec-drift-decision'].page, 'singularityFlow.openSpecStudio');
});

test('the Story\'s specification slice drops a clause or brings it back, saying what dropping does', () => {
  const scope = { data: { scope: { items: [{ field: 'specification', text: '[SPEC-CHK-004:REQ-001] Totals above 5000 qualify.', disposition: 'unresolved' },
    { field: 'specification', text: '[SPEC-CHK-004:AC-001] A total of 5000.01 qualifies.', disposition: 'excluded' }, { field: 'goal', text: '[X:AC-9] Other.', disposition: 'excluded' }] } } };
  const dropped = droppedSliceClauses(scope);
  assert.deepEqual([...dropped], ['SPEC-CHK-004:AC-001']);
  assert.equal(droppedSliceClauses(null), null);
  const workflow = { workItem: { id: 'S-1' }, currentPhase: null, phaseOrder: [], phases: {}, resolution: {} };
  const source = { specification: [{ revision: 'SPEC-CHK-004@1', clauses: [{ anchor: '[SPEC-CHK-004:REQ-001]' }, { anchor: '[SPEC-CHK-004:AC-001]' }] }] };
  const html = storyIntakeBody(workflow, { record: { id: 'SYS-SOURCE', path: 'source.json' }, content: JSON.stringify(source) }, [], dropped);
  assert.match(html, /<code>SPEC-CHK-004:REQ-001<\/code>[\s\S]*data-slice-reason="SPEC-CHK-004:REQ-001"[\s\S]*data-back="no">Drop from this Story/u);
  assert.match(html, /<code>SPEC-CHK-004:AC-001<\/code> <span class="pill">Dropped<\/span>[\s\S]*data-back="yes">Bring it back/u);
  assert.ok(html.includes(SLICE_DROP_WORDS.replaceAll("'", '&#39;')) || html.includes(SLICE_DROP_WORDS), 'what dropping does, and its undo');
  // Before the scope read comes, the clauses are listed and nothing offers to change them.
  assert.doesNotMatch(storyIntakeBody(workflow, { record: { id: 'SYS-SOURCE', path: 'source.json' }, content: JSON.stringify(source) }, [], null), /data-action="slice-change"/u);
  assert.equal(OWN_STEP_ROUTES['spec-slice-change'].page, 'singularityFlow.openStoryIntake');
});

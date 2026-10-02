import assert from 'node:assert/strict';
import test from 'node:test';

import { completionRecoveryActions, finalCheckRefusalMessage, printCompletionVerdict } from '../src/completion-verdict.mjs';
import { MESSAGES } from '../src/narration/messages.mjs';

test('a Story that runs out of steps is called complete only when the final check passed', () => {
  const approve = MESSAGES['approve.succeeded'].headline;
  assert.equal(approve({ phase: 'release', next: 'verification' }), 'Approved release. The Story is now at verification.');
  assert.equal(approve({ phase: 'intake', next: 'intake', reached: false }),
    'Recorded an approval for intake; it still needs more approvals before the Story moves on.',
    'a vote below the threshold never claims the Story moved');
  assert.match(approve({ phase: 'release', next: null, finalCheck: 'passed' }), /final governance check passed: the Story is complete\.$/);
  const failed = approve({ phase: 'release', next: null, finalCheck: 'failed' });
  assert.match(failed, /not complete until the final governance check passes/);
  assert.doesNotMatch(failed, /the Story is complete/);
  assert.doesNotMatch(approve({ phase: 'release', next: null }), /complete/, 'no verdict, no completion claim');

  const decided = MESSAGES['decision.choose.succeeded'].headline({ decision: 'stop', route: 'finish', kind: 'branch', target: null, finalCheck: 'failed' });
  assert.match(decided, /^Decision stop chose finish\. Every step is decided, but the Story is not complete/);
  const submitted = MESSAGES['submit.completed'].headline({ phase: 'release', documents: 1, finalCheck: 'passed' });
  assert.match(submitted, /required no review\. Every step is decided and the final governance check passed/);
  assert.doesNotMatch(MESSAGES['submit.completed'].headline({ phase: 'design', documents: 1 }), /complete:|Story is complete/);
});

test('a failed final check names its recoveries and never rests complete', () => {
  assert.deepEqual(completionRecoveryActions({ verified: true, errors: [], warnings: [], findings: [] }), []);
  const actions = completionRecoveryActions({
    verified: false, errors: ['terminal: phase code is not approved'], warnings: [],
    findings: [{ recovery: { command: 'singularity-flow recover W-1' } }, { recovery: { command: 'singularity-flow recover W-1' } }, {}]
  });
  assert.deepEqual(actions.map((entry) => entry.command), ['singularity-flow recover W-1', 'singularity-flow gate --terminal']);
  assert.ok(actions.every((entry) => entry.kind === 'remediation'));

  assert.equal(finalCheckRefusalMessage('W-1', {
    verified: false, errors: ['terminal: phase code is not approved'], warnings: [],
    findings: [{ recovery: { command: 'singularity-flow recover W-1' } }]
  }), [
    'Story W-1 cannot be finalized: the final governance check failed:',
    '- terminal: phase code is not approved',
    'Recover:',
    '  singularity-flow recover W-1',
    '  singularity-flow gate --terminal'
  ].join('\n'), 'finalize offers the same recoveries as the completing transition');

  const lines = [];
  printCompletionVerdict({ verified: false, errors: ['terminal: phase code is not approved'], warnings: [], findings: [] },
    { write: (line) => lines.push(line), warn: (line) => lines.push(line) });
  assert.deepEqual(lines, ['Final governance check failed, so the Story is not complete yet:', '  - terminal: phase code is not approved']);
});

test('a passing final check still states the assurance behind delivered code', () => {
  const lines = [];
  const sink = { write: (line) => lines.push(line), warn: (line) => lines.push(line) };
  printCompletionVerdict({ verified: true, assurance: 'module-observed', errors: [], warnings: [], findings: [] }, sink);
  assert.deepEqual(lines, [
    'Final governance check passed.',
    'Assurance: acceptance criteria are linked to tests by tags and the module test commands passed; no test-case result is joined to a criterion yet.'
  ]);
  lines.length = 0;
  printCompletionVerdict({ verified: true, assurance: null, errors: [], warnings: [], findings: [] }, sink);
  assert.deepEqual(lines, ['Final governance check passed.'], 'a Story that delivered no code makes no test claim');
});

/**
 * The return briefing, and the reconciliation it finally consumes.
 *
 * `src/work-intervals.mjs` computed all of this and no planner imported it — the reconciliation
 * existed only behind `sflow story interval reconcile`, so the shell had nothing to render. These
 * cover the composition and the three states it has to distinguish.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { reconciliationFor, returnChecklist, workReturnResult } from '../src/gateway/planners/work-return.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';
import { RETURN_CODES } from '../src/gateway/catalog.mjs';
import { RESULT_MESSAGES } from '../src/gateway/messages.mjs';
import { codeOnly } from './source-text.mjs';

const item = (over = {}) => ({
  id: 'PAY-1187', kind: 'story', phase: 'implement', generation: 2, group: 'active', blockers: [],
  nextAction: { operation: 'work.continue', reasonCode: 'work.resume-phase' }, lastMaterialEvent: null,
  ...over
});

const report = (over = {}) => ({
  reconciliationSha256: 'a'.repeat(64),
  reconciledAt: '2026-08-16T00:00:00.000Z',
  baseline: { sourceBaseCommit: 'b'.repeat(40) },
  worktree: { cleanApplicationTree: true, uncommittedApplicationPaths: [] },
  findings: [],
  summary: { changedPaths: 4, planned: 4, unplanned: 0, protected: 0 },
  decision: { status: 'clear', summaryStatus: 'clear', eligibleForSubmission: true, reasons: [] },
  ...over
});

test('the briefing is a valid result and declares no effects', () => {
  // A read that persists anything is not a read; `reconcileWorkInterval` writes unless told not to.
  const result = workReturnResult(item(), { report: report() });
  validateSflowResult(result);
  assert.equal(result.operation.classification, 'read');
  assert.ok(Object.values(result.effects).every((value) => value === false));
  assert.equal(result.preserved[0].scope, 'all');
});

test('the planner never lets the reconciliation write', async () => {
  /**
   * The one line that matters most in this file. `reconcileWorkInterval` defaults to
   * `writeLocal: true` and drops JSON into `.git/singularity-flow/reconciliations/`, which is right
   * for the command and would make this planner declare `filesChanged: false` while changing files.
   */
  const { readFile } = await import('node:fs/promises');
  // `codeOnly`: the planner's docblock quotes the default it is overriding. Sixth time in this
  // change that a grep has tripped on documentation of the very thing it checks.
  const source = codeOnly(await readFile(new URL('../src/gateway/planners/work-return.mjs', import.meta.url), 'utf8'));
  assert.match(source, /writeLocal: false/);
  assert.ok(!/writeLocal: true/.test(source));
});

test('"since you were here" is only said when there is a when', () => {
  /**
   * `[DHR:REQ-024]`. A reader told "since you were here" reads the list as a delta, and acts on the
   * assumption that anything absent from it did not change. Without a last-acknowledged time that
   * assumption is unfounded, so the heading is the current state instead.
   */
  const withoutTime = workReturnResult(item(), { report: report() });
  assert.equal(withoutTime.why[0].code, 'return.current-state');
  assert.equal(withoutTime.why[0].reference, null);

  const withTime = workReturnResult(item(), { report: report(), acknowledgedAt: '2026-08-15T09:00:00.000Z' });
  assert.equal(withTime.why[0].code, 'return.since-you-were-here');
  assert.equal(withTime.why[0].reference, '2026-08-15T09:00:00.000Z');
});

test('no open interval is an answer, not a failure', () => {
  /**
   * `[DHR:REQ-046]`. The developer has local work that is not attached to a governed interval —
   * ordinary, and the underlying function throws for it because that is right for a command.
   */
  const result = workReturnResult(item(), { report: null, localChanges: { dirty: true, files: 2, worktreeHash: 'c'.repeat(64), paths: ['a', 'b'] } });
  validateSflowResult(result);
  assert.equal(result.outcome.status, 'succeeded');
  assert.ok(result.why.some((entry) => entry.code === 'return.no-open-interval'));
  assert.deepEqual(result.checklist, [], 'an empty checklist beats one that implies gates were checked');
  assert.ok(result.warnings.some((entry) => entry.code === 'return.reconciliation-unavailable'));
  // And it does not end blank.
  assert.equal(result.restState, 'informational');
});

test('malformed configuration is not reported as a successful no-interval return', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-return-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'workTypes: [unterminated\n');

  await assert.rejects(
    () => reconciliationFor(root, item(), {}),
    /configuration|YAML|flow collection|unexpected end/i
  );
});

test('unplanned changes make the briefing lead with reconciling', () => {
  const blocked = workReturnResult(item(), {
    report: report({
      summary: { changedPaths: 7, planned: 4, unplanned: 3, protected: 1 },
      decision: { status: 'attention', summaryStatus: 'attention', eligibleForSubmission: false, reasons: ['unplanned'] }
    })
  });
  assert.equal(blocked.next.length, 1);
  assert.equal(blocked.next[0].id, 'return:reconcile');
  assert.equal(blocked.next[0].emphasis, 'primary');
  assert.equal(blocked.restState, null, 'there is something to do, so this is not a rest state');

  const clear = workReturnResult(item(), { report: report() });
  assert.deepEqual(clear.next, []);
  assert.equal(clear.restState, 'informational', 'you are where you left off is an answer');
});

test('the checklist reports planned, protected and worktree separately', () => {
  const rows = returnChecklist(report({
    summary: { changedPaths: 7, planned: 4, unplanned: 3, protected: 2 },
    worktree: { cleanApplicationTree: false, uncommittedApplicationPaths: ['x.ts'] }
  }));
  assert.deepEqual(rows.map((row) => [row.id, row.state]),
    [['planned', 'unmet'], ['protected', 'unmet'], ['worktree', 'unmet']]);

  // "Some of it was planned" is not a gate anyone passes.
  const partly = returnChecklist(report({ summary: { changedPaths: 7, planned: 6, unplanned: 1, protected: 0 } }));
  assert.equal(partly.find((row) => row.id === 'planned').state, 'unmet');
  assert.equal(partly.find((row) => row.id === 'protected').state, 'met');
});

test('the commit slot holds the baseline commit, not the worktree hash', () => {
  // The defect fixed in `work.continue`, not reintroduced here.
  const result = workReturnResult(item(), {
    report: report(),
    localChanges: { dirty: true, files: 1, worktreeHash: 'd'.repeat(64), paths: ['x'] }
  });
  assert.equal(result.subject.revision.sourceCommit, 'b'.repeat(40));
  assert.equal(result.subject.revision.worktreeHash, 'd'.repeat(64));
});

test('unread local changes are disclosed rather than counted as zero', () => {
  const result = workReturnResult(item(), { report: report(), localChanges: null });
  assert.ok(result.warnings.some((entry) => entry.code === 'return.local-changes-unread'));
});

test('every return code has a sentence', () => {
  const missing = RETURN_CODES.filter((code) => !RESULT_MESSAGES[code]);
  assert.deepEqual(missing, []);
});

test('story return composes the planner rather than a second implementation', async () => {
  /**
   * The command rendered `developerReturn` alone — a rich projection of where the Story stands, and
   * no comparison of local work against the plan. The one question its name asks was the one thing
   * it did not answer, because the reconciliation lived behind `story interval reconcile`.
   *
   * A source check because the composition is the point: this asserts the command reaches the
   * kernel, not that a particular sentence renders.
   */
  const { readFile } = await import('node:fs/promises');
  const source = codeOnly(await readFile(new URL('../src/commands/story.mjs', import.meta.url), 'utf8'));
  assert.match(source, /kernel\.resolve\(\{ utterance: 'what changed while I was away'/);
  assert.match(source, /kernel\.read\(\{ resolutionId/);
  // And it renders the planner's reasons through the shared catalog, not its own wording.
  assert.match(source, /message\(entry\.code, entry\.slots\)/);
});

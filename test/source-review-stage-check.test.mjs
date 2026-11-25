/**
 * `review-source stage` is the reviewer's check [owner, 2026-11-25]. In 66 real reviews, 23 ran `review-source check`
 * more than once (check, fix, check) and took 124 s against 71 s, beside a `stage` call that only refused. Stage now
 * checks the file the reviewer wrote at stagingPath and returns the check's exact findings and repairs, all of them at
 * once: a format error no longer hides the citation slips beside it (the lines SFlow sets itself are named, and set by
 * the next stage once the format is right), and a missing value names what it must be. The route is stage, repair, stage, submit; `review-source check` still works.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { agentAct, completeAgentResult } from '../src/agent-output.mjs';
import { validateSourceReviewReport } from '../src/source-review-contract.mjs';
import { publishedSpecificationStory, reviewReport } from './helpers/source-review-fixture.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const executable = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin/singularity-flow.mjs');

function cli(root, ...args) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: root, encoding: 'utf8', timeout: childTimeout(60_000),
    env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/test-workspace-registry.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/test-active-workspace.json') }
  });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return completeAgentResult(result.stdout.trim());
}

const slips = (result) => result.findings.map((entry) => `${entry.code} ${entry.field ?? ''}`.trim()).sort();

test('stage checks the staged report and returns every repair at once; the route is stage, repair, stage, submit', async (t) => {
  const { root, phaseId } = await publishedSpecificationStory(t);
  const packet = cli(root, 'review-source', 'context', phaseId, '--for-agent', '--json');
  const stage = `singularity-flow review-source stage ${phaseId} --for-agent --json`;
  assert.equal(packet.stagingProtocol.check.command, stage, 'the check the review is given is stage');
  assert.match(packet.reviewGuide.next, /no separate review-source check/u);

  // Three slips in three rows: a format error, a quote that is on no line, and a line one off.
  const good = reviewReport(packet);
  const off = good.rows[2].line;
  const slipped = { ...good, rows: good.rows.map((row, index) => (index === 0 ? { ...row, outcome: 'supported' }
    : index === 1 ? { ...row, quote: `${row.quote} (paraphrased)` } : { ...row, line: row.line + 1 })) };
  await mkdir(path.dirname(packet.stagingPath), { recursive: true });
  await writeFile(packet.stagingPath, `${JSON.stringify(slipped, null, 2)}\n`);
  const staged = cli(root, 'review-source', 'stage', phaseId, '--for-agent', '--json');
  assert.equal(staged.resultType, 'source-review-check');
  assert.equal(staged.retentionReady, false);
  // The format error and the citation slips beside it, in one result: before, they came only after a second check.
  assert.deepEqual(slips(staged), ['citation-quote-invalid rows[1]', 'citation-quote-invalid rows[2]', 'review-format-invalid rows[0].outcome']);
  assert.deepEqual(staged.repair.repairs.map((entry) => [entry.field, entry.allowed]), [['rows[0].outcome', ['covered', 'excluded', 'question']]]);
  // The line one off is named too, as SFlow's to set: a format error is repaired first, then the next stage sets it.
  assert.deepEqual(staged.repair.citations.map((entry) => [entry.field, entry.sflowCorrects ?? false]), [['rows[1]', false], ['rows[2]', true]]);
  assert.equal(staged.corrected, undefined);
  // The way on is to repair the file and stage again, never a separate check.
  assert.equal(staged.continuation.nextAction.command, stage);
  assert.equal(agentAct(staged).state, 'correct');
  assert.match(agentAct(staged).said, /run stagingProtocol\.check \(review-source stage\) on the changed packet/u);

  // `review-source check` still works, and says the same of the same file.
  const checked = cli(root, 'review-source', 'check', phaseId, '--for-agent', '--json');
  assert.deepEqual(slips(checked), slips(staged));
  assert.deepEqual(checked.repair.repairs, staged.repair.repairs);

  // One repair of everything listed, one stage, then submit.
  const repaired = JSON.parse(await readFile(packet.stagingPath, 'utf8'));
  repaired.rows[0].outcome = 'covered';
  repaired.rows[1].quote = good.rows[1].quote;
  await writeFile(packet.stagingPath, `${JSON.stringify(repaired, null, 2)}\n`);
  const ready = cli(root, 'review-source', 'stage', phaseId, '--for-agent', '--json');
  assert.equal(ready.retentionReady, true, JSON.stringify(ready.findings));
  assert.deepEqual(ready.corrected, [{ field: 'rows[2].line', from: off + 1, to: off }]);
  assert.equal(JSON.parse(await readFile(packet.stagingPath, 'utf8')).rows[2].line, off);
  assert.equal(ready.continuation.nextAction.command, `singularity-flow review-source submit ${phaseId} --for-agent --json`);
  assert.equal(agentAct(ready).state, 'retain');
  const retained = cli(root, 'review-source', 'submit', phaseId, '--for-agent', '--json');
  assert.ok(retained.reportSha256, JSON.stringify(retained).slice(0, 600));
});

test('a value left out names what it must be: the choices the packet knows, or what the field is for', () => {
  const report = (rows) => ({ schemaVersion: 1, resultType: 'source-grounded-review', kind: 'specification', binding: 'from-context',
    reviewer: { agentId: 'reviewer', readOnly: true }, sourcesReviewed: ['story'], rows, findings: [] });
  const known = () => [{ field: /^rows\[\d+\]\.scenarioId$/u, values: ['S1', 'S2'], what: 'a scenario ID of the specification' }];
  const missingScenario = validateSourceReviewReport(report([{ id: 'r1', sourceId: 'story', line: 1, quote: 'Save.', outcome: 'covered',
    clauseIds: ['W:REQ-001'] }]), 'specification', { known });
  assert.deepEqual(missingScenario.findings.map(({ field, message, allowed }) => ({ field, message, allowed })), [{ field: 'rows[0].scenarioId',
    message: 'rows[0].scenarioId is missing; it must be a scenario ID of the specification: S1, S2.', allowed: ['S1', 'S2'] }]);
  const missingReason = validateSourceReviewReport(report([{ id: 'r1', sourceId: 'story', line: 1, quote: 'Save.', outcome: 'excluded' }]),
    'specification', { known });
  assert.equal(missingReason.findings[0].field, 'rows[0].reason');
  assert.match(missingReason.findings[0].message, /^rows\[0\]\.reason is missing; it must be a string: The concrete reason this request is left out/u);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildOutcomeReview } from '../src/outcome-review.mjs';
import { publishedSpecificationStory } from './helpers/source-review-fixture.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/singularity-flow.mjs');

test('the outcome shows each criterion\'s tests and checks, and the sign-off a person runs', () => {
  // graph-plot, 2026-10-26: the plan asked a person to compare the running screen with DOC-001, and no
  // step showed the app, the screenshot or the sign-off; a later step reported the criterion partial.
  const workflow = { workItem: { id: 'OUT-1', title: 'Plot' }, currentPhase: 'implementation',
    phases: { implementation: { status: 'in_progress', generation: 1 } } };
  const graph = { records: { indexes: [{ clauses: [{ id: 'OUT-1:AC-001',
    body: 'The screen shows the plot. [scope:SRI-0123456789ab] *(S1)*', verification: { methods: ['test', 'visual'] } }] }] } };
  const evaluation = {
    lifecycle: { words: 'In progress at Implementation' }, completion: { label: 'Incomplete' },
    findings: [{ code: 'EVIDENCE_VISUAL_MISSING', message: 'OUT-1:AC-001 needs visual evidence.', blocking: true },
      { code: 'ADVISORY_ONLY', message: 'Not blocking.', blocking: false }],
    rows: [
      { id: 'OUT-1:REQ-001', type: 'REQ', result: 'satisfied' },
      { id: 'OUT-1:AC-001', type: 'AC', result: 'missing', findings: [{ code: 'EVIDENCE_VISUAL_MISSING', message: 'OUT-1:AC-001 needs visual evidence.' }],
        verification: { witnesses: [{ test: 'plots sin(x)', testSource: 'src/plot.test.js', outcome: 'passed', status: 'met' }],
          contract: { slots: [{ slot: 'screen', method: 'visual', role: 'primary', status: 'missing' },
            { slot: 'unit', method: 'test', role: 'primary', status: 'met' }] } } }
    ]
  };
  const owed = { status: 'owed', more: { witnesses: 0, scopeItems: 0 },
    witnesses: [{ clauseId: 'OUT-1:AC-001', slot: 'screen', method: 'visual', status: 'missing', files: [],
      command: "singularity-flow decision witness --work-id OUT-1 --criterion OUT-1:AC-001 --slot screen --file '<EVIDENCE-PATH>' --reason '<review-reason>' --json" }],
    scopeItems: [{ id: 'DOC-001', text: 'could not be read', command: 'singularity-flow decision scope OUT-1 --item DOC-001' }] };
  const contracts = new Map([['OUT-1:AC-001', { slots: [{ slot: 'screen', method: 'visual', witness: { target: 'DOC-001' } },
    { slot: 'unit', method: 'test', witness: { testSource: 'src/plot.test.js' } }] }]]);
  const review = buildOutcomeReview({ workflow, graph, evaluation, owed, contracts, application: { status: 'none-declared' } });

  assert.equal(review.optional, true);
  assert.deepEqual(review.step, { id: 'implementation', status: 'in_progress', generation: 1 });
  assert.deepEqual(review.criteria.map((criterion) => criterion.id), ['OUT-1:AC-001'], 'acceptance criteria only');
  const [criterion] = review.criteria;
  assert.equal(criterion.text, 'The screen shows the plot.', 'engine markers are not for the reader');
  assert.deepEqual(criterion.methods, ['test', 'visual']);
  assert.deepEqual(criterion.tests, [{ test: 'plots sin(x)', file: 'src/plot.test.js', outcome: 'passed', status: 'met' }]);
  const [visual, unit] = criterion.checks;
  assert.equal(visual.reference, 'DOC-001');
  assert.equal(visual.suggestedFile, 'singularity/work-items/OUT-1/evidence/ac-001-screen.png');
  assert.match(visual.signOff, / --file singularity\/work-items\/OUT-1\/evidence\/ac-001-screen\.png /u);
  assert.equal(unit.reference, null, 'a test check is compared with nothing');
  assert.equal(unit.signOff, undefined);
  assert.equal(review.open.signOffs[0].command, visual.signOff);
  assert.deepEqual(review.open.scopeItems.map((item) => item.id), ['DOC-001']);
  assert.deepEqual(review.open.blocking.map((finding) => finding.code), ['EVIDENCE_VISUAL_MISSING']);
  assert.equal(review.routes.tests.command, 'singularity-flow tests run --work-id OUT-1');
  assert.equal(review.routes.tests.copilotCommand, '/sf-test');
});

test('outcome is an optional read: it names no next action and changes nothing', async (t) => {
  const { root } = await publishedSpecificationStory(t);
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1' };
  const run = (...args) => spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: root, encoding: 'utf8', env });
  const status = () => spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
  const before = status();

  const json = run('outcome', 'REVIEW-1', '--json');
  assert.equal(json.status, 0, json.stderr);
  const result = JSON.parse(json.stdout);
  assert.equal(result.operation.id, 'outcome.review');
  assert.equal(result.data.outcome.workId, 'REVIEW-1');
  assert.equal(result.data.outcome.optional, true);
  assert.deepEqual(result.next ?? [], [], 'no agent acts on it unasked');

  const text = run('outcome', 'REVIEW-1');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Try it:/u);
  assert.match(text.stdout, /This review is optional: it records nothing and no step waits for it/u);
  assert.equal(status(), before, 'reading the outcome changed nothing in the checkout');

  const refused = run('outcome', '--row', 'x');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /outcome does not accept --row/u);
});

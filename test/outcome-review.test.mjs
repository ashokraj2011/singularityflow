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
    phases: { implementation: { status: 'in_progress', generation: 1, generationPolicy: { task: 'code' } } } };
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
  assert.equal(review.routes.tests.command, 'singularity-flow tests run --work-id OUT-1 --phase implementation');
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
  assert.match(text.stdout, /Opening this review records no acceptance or approval/u);
  assert.match(text.stdout, /Request repair \/ inspect the legal owner route/u);
  assert.match(text.stdout, /Continue with the current workflow actions/u);
  assert.equal(status(), before, 'reading the outcome changed nothing in the checkout');

  const refused = run('outcome', '--row', 'x');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /outcome does not accept --row/u);
});

test('the validation question is available for legacy and custom code deliveries without enabling acceptance policy', () => {
  for (const id of ['implementation', 'repair-api', 'custom-angular', 'future-step']) {
    const phase = { id, generation: 2, status: 'in_progress', generationPolicy: { task: 'code' } };
    const workflow = { workItem: { id: 'TRY-1' }, phaseOrder: [id], currentPhase: id, phases: { [id]: phase } };
    if (id === 'implementation') { delete phase.generationPolicy; phase.requiredArtifact = { kind: 'implementation-summary' }; }
    const before = structuredClone(workflow);
    const review = buildOutcomeReview({ workflow, application: { status: 'none-declared', capability: 'api' } });
    const guide = review.validation;
    assert.deepEqual(guide.binding, { workId: 'TRY-1', phase: id, generation: 2 });
    assert.equal(guide.tests.phase, id);
    assert.equal(guide.tests.status, 'not-recorded');
    assert.equal(guide.steps.find(step => step.id === 'application').status, 'setup-available');
    assert.equal(guide.choices.find(choice => choice.id === 'configure').route.copilotCommand, '/sf-run-app');
    assert.ok(!guide.choices.some(choice => /^(start|open):/.test(choice.id)), 'no guessed start command or web screen');
    assert.ok(guide.choices.some(choice => choice.id === 'continue'), 'setup is not a new gate');
    assert.match(guide.instruction, /Ask this question now/);
    assert.equal(guide.recordsAcceptance, false);
    assert.deepEqual(workflow, before);
  }
});

test('validation summarizes only the bound delivery and never promotes diagnostic or incomplete tests', () => {
  const workflow = { workItem: { id: 'TRY-2' }, phaseOrder: ['code', 'verification'], currentPhase: 'verification',
    phases: { code: { id: 'code', generation: 2, generationPolicy: { task: 'code' } }, verification: { id: 'verification', generation: 1 } } };
  const run = (patch = {}) => ({ commandId: 'unit', kind: 'test-execution', record: { status: 'passed', exitCode: 0, tests: { passed: 15, failed: 0, skipped: 0 }, ...patch } });
  const guide = (executions, preflight = []) => buildOutcomeReview({ workflow, graph: { deliveries: [
    { phaseId: 'code', generation: 1, executions: [run()] }, { phaseId: 'code', generation: 2, executions, preflight }
  ] } }).validation;
  assert.equal(guide([]).tests.status, 'not-recorded', 'an earlier implementation run cannot verify this generation');
  assert.deepEqual(buildOutcomeReview({ workflow }).routes.tests.argv, ['tests', 'run', '--work-id', 'TRY-2', '--phase', 'code'],
    'a later document phase still targets the code step that owns the runner');
  const diagnostic = guide([], [{ commandId: 'unit', record: run().record }]);
  assert.equal(diagnostic.tests.status, 'not-recorded');
  assert.equal(diagnostic.tests.diagnosticRuns[0].status, 'passed');
  // The publish check's passing run is named as what submission reuses, never as "no test ran" [CQF:REQ-016].
  const named = diagnostic.steps.find(step => step.id === 'tests').detail;
  assert.match(named, /^The publish check ran unit on this code: 15 passed, 0 failed\. It becomes the step's recorded run at submission, which reuses it while the code is unchanged/u);
  assert.doesNotMatch(named, /No retained test execution/u);
  const failedCheck = guide([], [{ commandId: 'unit', record: run({ status: 'failed', exitCode: 1, tests: { passed: 14, failed: 1 } }).record }]);
  assert.match(failedCheck.steps.find(step => step.id === 'tests').detail, /No retained test execution is recorded/u, 'a failed check is never named as reusable');
  assert.equal(guide([run()]).tests.status, 'passed');
  assert.match(guide([run()]).steps.find(step => step.id === 'tests').detail, /15 passed, 0 failed, 0 skipped/);
  for (const patch of [{ countsForStep: false }, { terminal: false }, { status: 'passed', exitCode: null }, { tests: { passed: 14, skipped: 1 } }]) {
    assert.equal(guide([run(patch)]).tests.status, 'incomplete', JSON.stringify(patch));
  }
  assert.equal(guide([run({ status: 'failed', exitCode: 1 })]).tests.status, 'failed');
  assert.equal(guide([run({ timedOut: true })]).tests.status, 'failed');
  assert.equal(guide([{ commandId: 'unit', record: null }]).tests.status, 'incomplete');
  assert.equal(guide([{ commandId: 'unit', kind: 'phase-validation-observation', record: null }]).tests.status, 'not-recorded');
});

test('a Story without a code step offers no impossible test action or invented runner', () => {
  const review = buildOutcomeReview({ workflow: { workItem: { id: 'DOC-1' }, currentPhase: 'specification',
    phases: { specification: { id: 'specification', generation: 1, generationPolicy: { task: 'document' } } } } });
  assert.equal(review.routes.tests, null);
  assert.equal(review.validation.tests.status, 'not-applicable');
  assert.ok(!review.validation.choices.some(choice => choice.id === 'tests'));
  assert.ok(review.validation.choices.some(choice => choice.id === 'continue'));
});

test('validation chooses only ready local apps or free declared launch entries and preserves actual failures', () => {
  const workflow = { workItem: { id: 'TRY-3' }, currentPhase: 'code', phases: { code: { id: 'code', generation: 1, generationPolicy: { task: 'code' } } } };
  const entries = [
    { id: 'web', name: 'Web', started: true, ready: true, url: 'http://localhost:5173' },
    { id: 'api', name: 'API', started: false, ready: false, start: { command: 'singularity-flow app start api' } },
    { id: 'occupied', name: 'Occupied', started: false, portTaken: true, start: { command: 'singularity-flow app start occupied' } },
    { id: 'starting', name: 'Starting', started: true, ready: false }
  ];
  const guide = buildOutcomeReview({ workflow, application: { status: 'declared', entries } }).validation;
  assert.deepEqual(guide.choices.filter(choice => choice.entryId).map(choice => choice.id), ['open:web', 'start:api']);
  // `app start` stays attached until the application exits: a Start says to run it in the background, then poll
  // status, never in the foreground where the host's timeout stopped it (agent-text audit, 2026-11-11).
  const start = guide.choices.find(choice => choice.id === 'start:api');
  assert.equal(start.runMode, 'background');
  assert.match(start.how, /background \(async\) mode so it keeps running, then run singularity-flow app status --json until this entry is ready/u);
  assert.match(guide.instruction, /a start in the background as its how says/u);
  const failure = buildOutcomeReview({ workflow, application: { status: 'unavailable', code: 'EACCES', message: 'EACCES: cannot read local profile' } });
  assert.equal(failure.validation.steps.find(step => step.id === 'application').detail, 'EACCES: cannot read local profile');
  assert.ok(!failure.validation.choices.some(choice => choice.id === 'configure'), 'a permission failure is not presented as absent configuration');
  assert.ok(failure.validation.choices.some(choice => choice.id === 'repair'));
});

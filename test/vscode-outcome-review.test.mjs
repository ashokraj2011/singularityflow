import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildOutcomeReview } from '../src/outcome-review.mjs';

const { outcomeView, documentReference, signOffArgs, signOffQuestions } = await import('../apps/vscode/src/views/outcome-review-model.ts');
const { outcomeReviewHtml, OUTCOME_REVIEW_SCRIPT } = await import('../apps/vscode/src/views/outcome-review-page.ts');

// What `singularity-flow outcome --json` carries, built by the engine itself so the page and the CLI
// can never disagree about the shape.
function result() {
  const outcome = buildOutcomeReview({
    workflow: { workItem: { id: 'OUT-2', title: 'Plot <b>' }, currentPhase: 'verification', phases: { verification: { status: 'in_progress', generation: 1 } } },
    graph: { records: { indexes: [{ clauses: [{ id: 'OUT-2:AC-001', body: 'Shows <script>alert(1)</script> the plot.', verification: { methods: ['test', 'visual'] } }] }] } },
    evaluation: {
      lifecycle: { words: 'In progress at Verification' }, completion: { label: 'Incomplete' },
      findings: [{ code: 'SCOPE_ITEMS_UNRESOLVED', message: '1 statement has no disposition.', blocking: true }],
      rows: [{ id: 'OUT-2:AC-001', type: 'AC', result: 'missing', findings: [],
        verification: { witnesses: [{ test: 'plots sin(x)', testSource: 'src/plot.test.js', outcome: 'passed', status: 'met' }],
          contract: { slots: [{ slot: 'screen', method: 'visual', role: 'primary', status: 'missing' }] } } }]
    },
    owed: { status: 'owed', more: { witnesses: 0, scopeItems: 0 },
      witnesses: [{ clauseId: 'OUT-2:AC-001', slot: 'screen', method: 'visual', status: 'missing', files: [],
        command: "singularity-flow decision witness --work-id OUT-2 --criterion OUT-2:AC-001 --slot screen --file '<EVIDENCE-PATH>' --json" }],
      scopeItems: [{ id: 'DOC-001', text: 'could not be read', command: 'singularity-flow decision scope OUT-2 --item DOC-001' }] },
    contracts: new Map([['OUT-2:AC-001', { slots: [{ slot: 'screen', method: 'visual', witness: { target: 'DOC-001' } }] }]]),
    application: { status: 'declared', capability: 'web', entries: [{ id: 'dev', name: 'npm dev', url: 'http://localhost:5173/', started: false, ready: false, pid: null, portTaken: true }] }
  });
  return { schemaVersion: 2, resultType: 'command-result', data: { outcome } };
}

test('the outcome page shows the app, each check with its reference, and only existing routes', () => {
  const view = outcomeView(result());
  assert.ok(view, 'the panel reads what the engine emits');
  assert.equal(view.criteria.length, 1);
  assert.equal(view.testsCommand, 'singularity-flow tests run --work-id OUT-2');
  const html = outcomeReviewHtml(view, null);
  for (const words of ['Check the outcome', 'Optional: nothing here is recorded and no step waits for it',
    'Another process already listens at that address', 'Start the application', 'compared with <code>DOC-001</code>',
    'Open DOC-001', 'Copy the sign-off command', 'singularity/work-items/OUT-2/evidence/ac-001-screen.png',
    'Attach a screenshot…', 'Sign off…', 'Run the tests', 'Open the Evidence Matrix', 'Copy the scope command', 'Open the decisions',
    'A screenshot or a passing test is not a sign-off']) {
    assert.ok(html.includes(words), words);
  }
  assert.ok(!html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;'), 'engine text is escaped');
  assert.ok(!html.includes('Plot <b>'), 'the title is escaped');
  // The page posts only an action name and indexes into what the panel loaded, never a command.
  assert.match(OUTCOME_REVIEW_SCRIPT, /type: 'action', action: d\.outcome/u);
  assert.doesNotMatch(OUTCOME_REVIEW_SCRIPT, /command/u);
});

test('the outcome page refuses another result shape and says when nothing was read', () => {
  assert.equal(outcomeView({ data: { matrix: {} } }), null);
  assert.equal(outcomeView({ data: { outcome: { resultType: 'sflow-outcome-review', workId: 'X', criteria: [{ id: 1 }], application: { status: 'declared' } } } }), null);
  assert.match(outcomeReviewHtml(null, 'Open a Story to check its outcome.'), /Open a Story to check its outcome\./u);
  assert.equal(documentReference('DOC-001'), true);
  assert.equal(documentReference('screens/home.png'), false);
  assert.equal(documentReference(null), false);
});

test('the page\'s sign-off asks the three checklist items in plain words and runs decision witness exactly', () => {
  const questions = signOffQuestions({ id: 'OUT-2:AC-001', text: 'Shows the plot.' });
  assert.deepEqual(questions.map(([item]) => item), ['states-the-outcome', 'matches-the-criterion', 'current-for-this-change'],
    'the order and names decision witness checks');
  assert.match(questions[1][1], /as written: "Shows the plot\."/u);
  // The same form test/scope-inventory.test.mjs runs against the real CLI.
  assert.deepEqual(signOffArgs('OUT-2', 'OUT-2:AC-001', 'screen', 'singularity/work-items/OUT-2/evidence/ac-001-screen.png',
    [['states-the-outcome', true], ['matches-the-criterion', false], ['current-for-this-change', true]], '  Looked at the plot.  '),
  ['decision', 'witness', 'OUT-2', '--criterion', 'OUT-2:AC-001', '--slot', 'screen', '--file', 'singularity/work-items/OUT-2/evidence/ac-001-screen.png',
    '--confirm', 'states-the-outcome', '--deny', 'matches-the-criterion', '--confirm', 'current-for-this-change', '--reason', 'Looked at the plot.', '--json']);
});

test('the outcome suggestion is a personal VS Code setting that is off unless turned on', () => {
  const manifest = JSON.parse(readFileSync(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  const setting = manifest.contributes.configuration.properties['singularityFlow.outcomeReview.suggest'];
  assert.equal(setting.type, 'boolean');
  assert.equal(setting.default, false, 'nothing is offered until a person turns it on');
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.openOutcomeReview'));
});

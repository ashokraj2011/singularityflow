import assert from 'node:assert/strict';
import test from 'node:test';

const { evidenceView, evidenceCell, evidenceTone } = await import('../apps/vscode/src/views/evidence-matrix-model.ts');
const { evidenceMatrixHtml, EVIDENCE_MATRIX_SCRIPT } = await import('../apps/vscode/src/views/evidence-matrix-page.ts');

const facets = { coverage: 'linked', execution: 'passed', assurance: 'module-observed', review: 'approved', freshness: 'current', exception: 'none' };
// The shape `singularity-flow evidence matrix --json` returns: the overview carries no rows; the
// page does.
const result = {
  schemaVersion: 2,
  resultType: 'command-result',
  data: {
    matrix: {
      evaluation: {
        workId: 'EV-1', title: 'Change the value',
        lifecycle: { status: 'in_progress', words: 'In progress at Testing' },
        requiredAssurance: { level: 'module-observed' },
        findings: [{ category: 'records', message: 'claim map binding mismatch' }],
        summary: { rows: 2, results: { satisfied: 1, inconclusive: 1, failed: 0 }, assuranceFloor: 'module-observed' },
        decision: { gate: 'block' },
        completion: { label: 'Incomplete — verification pending or insufficient', kind: 'incomplete', reasons: ['1 inconclusive'] }
      },
      page: {
        total: 2, page: 1, pages: 1,
        rows: [
          {
            id: 'EV-1:AC-001', type: 'AC', source: 'intake.md:5', result: 'satisfied', assurance: 'module-observed',
            obligations: [
              { id: 'OBL:EV-1:verify:AC-001', responsibility: 'verify', status: 'met', owningSteps: ['implementation'], facets },
              { id: 'OBL:EV-1:plan:AC-001', responsibility: 'plan', status: 'met', owningSteps: ['intake'], facets }
            ],
            findings: [], actions: [{ kind: 'explain', command: 'singularity-flow explain --subject clause --id EV-1:AC-001' }]
          },
          {
            id: 'EV-1:AC-002', type: 'AC', source: 'intake.md:6', result: 'inconclusive', assurance: 'declared',
            obligations: [{ id: 'OBL:EV-1:verify:AC-002', responsibility: 'verify', status: 'inconclusive', owningSteps: ['implementation'], facets: { ...facets, execution: 'passed-with-skips' } }],
            findings: [{ message: 'EV-1:AC-002 passed with 1 skipped test.' }], actions: []
          }
        ]
      }
    }
  }
};

test('the evidence matrix panel shows the rows and labels the engine returned, and nothing it did not', () => {
  const view = evidenceView(result);
  assert.equal(view.workId, 'EV-1');
  assert.equal(view.completion, 'Incomplete — verification pending or insufficient');
  assert.deepEqual(view.counts, [{ result: 'satisfied', count: 1 }, { result: 'inconclusive', count: 1 }], 'zero counts are left out');
  assert.deepEqual(view.rows.map((row) => row.id), ['EV-1:AC-001', 'EV-1:AC-002']);
  assert.deepEqual(view.rows[0].obligations.map((entry) => entry.responsibility), ['plan', 'verify'], 'obligations read in lifecycle order');
  assert.equal(evidenceCell(view.rows[0], 'implement'), '—', 'a row that owes nothing for a responsibility shows nothing for it');
  assert.equal(evidenceTone('satisfied'), 'ok');
  assert.equal(evidenceTone('failed'), 'bad');
  assert.equal(evidenceTone('pending'), 'wait');
  assert.deepEqual(view.unreadable, ['claim map binding mismatch']);
  assert.equal(evidenceView({ data: { matrix: { evaluation: {} } } }), null, 'a shape it does not know is not guessed at');

  const html = evidenceMatrixHtml(view, 'EV-1:AC-002', null, 'n0nce');
  assert.match(html, /<style nonce="n0nce">/);
  assert.match(html, /Incomplete — verification pending or insufficient/);
  assert.match(html, /In progress at Testing/);
  assert.match(html, /data-entry="EV-1:AC-001"/);
  assert.match(html, /<tr class="entry selected" tabindex="0" data-entry="EV-1:AC-002">/);
  assert.match(html, /EV-1:AC-002 passed with 1 skipped test\./, 'the selected row opens what needs attention');
  assert.match(html, /claim map binding mismatch/);
  assert.match(html, /no test-case result is joined to a criterion yet/);
  assert.doesNotMatch(html, /\bstory is complete\b|all tests passed/i);
  assert.match(evidenceMatrixHtml(null, null, 'Open a Story to see its evidence matrix.', 'n'), /Open a Story to see its evidence matrix\./);

  // A responsibility the route omits shows why it does not apply, and who said so once decided.
  const omitted = (satisfied) => evidenceView({ data: { matrix: { evaluation: result.data.matrix.evaluation, page: { total: 1, rows: [{
    id: 'story:scope', type: 'STORY', result: satisfied ? 'not-applicable' : 'pending', assurance: 'not-applicable',
    obligations: [{ id: 'OBL:EV-1:scope:story', responsibility: 'scope', status: satisfied ? 'not-applicable' : 'pending', owningSteps: [], facets }],
    findings: [], actions: [],
    applicability: { responsibility: 'scope', authority: 'quality-reviewers', declaredReason: 'The proof defines no requirement clauses.', satisfied,
      decision: satisfied ? { reason: 'One local change with nothing to specify.', actor: 'reviewer@example.com', at: '2026-10-03T00:00:00.000Z' } : null }
  }] } } } });
  const decidedHtml = evidenceMatrixHtml(omitted(true), 'story:scope', null, 'n');
  assert.match(decidedHtml, /Why this does not apply/);
  assert.match(decidedHtml, /The proof defines no requirement clauses\./);
  assert.match(decidedHtml, /reviewer@example\.com · quality-reviewers · 2026-10-03T00:00:00\.000Z/);
  assert.match(decidedHtml, /One local change with nothing to specify\./);
  assert.match(evidenceMatrixHtml(omitted(false), 'story:scope', null, 'n'), /Waiting for quality-reviewers to record why it does not apply\./);

  // The selection script parses and only ever asks the panel to look a row up.
  assert.doesNotThrow(() => new Function(EVIDENCE_MATRIX_SCRIPT));
  assert.match(EVIDENCE_MATRIX_SCRIPT, /postMessage\(\{ type: 'select', id: row\.dataset\.entry \}\)/);
});

test('a scope inventory row shows its statement and disposition as the engine read them', () => {
  const scoped = structuredClone(result);
  scoped.data.matrix.page.rows = [{
    id: 'SRI-0123456789ab', type: 'SCOPE', source: 'story', result: 'pending', assurance: 'not-applicable',
    obligations: [{ id: 'OBL:EV-1:scope:SRI-0123456789ab', responsibility: 'scope', status: 'pending', owningSteps: ['intake'], facets }],
    findings: [], actions: [{ kind: 'decide', command: 'singularity-flow decision scope --item SRI-0123456789ab --as <included|existing|excluded|deferred|informative|duplicate|superseded> --reason "<why>"' }],
    scope: { kind: 'statement', text: 'The public API must stay stable.', disposition: 'unresolved', clauseIds: [], coveredBy: null }
  }];
  const view = evidenceView(scoped);
  assert.deepEqual(view.rows[0].statement, { text: 'The public API must stay stable.', disposition: 'unresolved', coveredBy: null });
  const html = evidenceMatrixHtml(view, 'SRI-0123456789ab', null, 'n');
  assert.match(html, /<dt>Statement<\/dt><dd>The public API must stay stable\.<\/dd>/);
  assert.match(html, /<dt>Disposition<\/dt><dd>unresolved<\/dd>/);
  assert.match(html, /decision scope --item SRI-0123456789ab/);
  assert.equal(evidenceView(result).rows[0].statement, null, 'a clause row has no statement of its own');
  assert.equal(evidenceView(result).scope, null, 'a matrix without a scope summary shows no scope card');
});

test('the scope card shows structural completeness and the completeness review apart, in the words the engine chose', () => {
  const reviewed = structuredClone(result);
  reviewed.data.matrix.evaluation.summary.scope = {
    structurallyComplete: true, completenessReviewed: true, correctness: 'never-claimed',
    words: { structure: 'structurally complete (3 statements)', review: 'completeness reviewed by po@example.test (product-approvers)', correctness: 'correctness is never claimed' }
  };
  const view = evidenceView(reviewed);
  assert.deepEqual([view.scope.structurallyComplete, view.scope.completenessReviewed], [true, true]);
  const html = evidenceMatrixHtml(view, null, null, 'n');
  assert.match(html, /<span class="eyebrow">Scope<\/span><strong>structurally complete \(3 statements\)<\/strong>/);
  assert.match(html, /completeness reviewed by po@example\.test \(product-approvers\); correctness is never claimed/);
  assert.doesNotMatch(html, /scope is correct|guarantee/i);
});

/**
 * The repository brief a phase prompt receives (World Model v5, M0): registered views read without
 * their hashes, JSON and boilerplate, and one ranked, cited, budgeted brief per phase.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { phaseBriefProfile, renderPhaseBrief } from '../src/knowledge/phase-brief.mjs';
import { projectRegisteredView, VIEW_BRIEF_RENDERER, viewProjectionDigest } from '../src/knowledge/view-brief.mjs';

const fact = (id, status, extra = {}) => ({ id, status, factType: extra.factType ?? 'signature', ...extra });

/** A published view file in the shape the kernel writes: header, sections with citations, facts JSON, stamp. */
function viewFile(view, sections, facts) {
  return [
    '<!--', 'SFlow World-Model View', 'source: repository-root@0123', `view: ${view}@4`, 'fact-ledger-sha256: sha256:00', '-->', '',
    `# Title {#${view}}`, '', '**TL;DR** something. [F:FACT-1]', '',
    ...Object.entries(sections).flatMap(([title, lines]) => [`## ${title} {#${view}.${title.toLowerCase().replace(/\W+/gu, '-')}}`, '', ...lines, '']),
    `## Facts {#${view}.facts}`, '', '```json', JSON.stringify({ facts }, null, 2), '```', '',
    '---', 'generated-at: 2026-10-10', '---', ''
  ].join('\n');
}

test('a contracts view folds declarations per type, accessors together, and keeps file and line', () => {
  const markdown = viewFile('arch.contracts', {
    'Public contracts': [
      '- src/model/Order.java declares public class Order at line 9. [F:FACT-1]',
      '- src/model/Order.java declares public BigDecimal getTotal() at line 20. [F:FACT-2]',
      '- src/model/Order.java declares public void setStatus(OrderStatus status) at line 23. [F:FACT-3]',
      '- src/web/OrderController.java declares public Order place(@RequestBody Order order) at line 21. [F:FACT-4]',
      '- OrderRepository is explicitly declared as an interface contract in src/repo/OrderRepository.java at line 6. [F:FACT-5]'
    ],
    'Unavailable runtime guarantees': [
      '- No registered deterministic producer supplied runtime-guarantee for arch.contracts@4 within the pinned scope. [F:FACT-9]'
    ]
  }, [
    fact('FACT-1', 'available'), fact('FACT-2', 'available'), fact('FACT-3', 'available'), fact('FACT-4', 'available'), fact('FACT-5', 'available'),
    fact('FACT-9', 'unavailable', { factType: 'runtime-guarantee', reason: { code: 'NO_REGISTERED_PRODUCER', detail: 'No registered deterministic producer supplied runtime-guarantee for arch.contracts@4 within the pinned scope.' } })
  ]);
  const projection = projectRegisteredView(markdown);
  assert.deepEqual([projection.view, projection.version, projection.section], ['arch.contracts', 4, 'contracts']);
  assert.deepEqual(projection.lines.map((line) => [line.text, line.source?.path, line.source?.line]), [
    ['interface OrderRepository', 'src/repo/OrderRepository.java', 6],
    ['Order: class Order; accessors for total, status', 'src/model/Order.java', 9],
    ['OrderController: method place(Order)', 'src/web/OrderController.java', 21]
  ]);
  assert.deepEqual(projection.notKnown, ['runtime-guarantee']);
  assert.deepEqual(projection.renderer, VIEW_BRIEF_RENDERER);
});

test('an impact view folds imports per file, leaves out lexical guesses and states one baseline gap', () => {
  const markdown = viewFile('dev.impact', {
    'Dependency impact': [
      '- src/OrderService.java imports the in-scope module src/model/Order.java. [F:FACT-1]',
      '- src/OrderService.java imports the in-scope module src/model/OrderStatus.java. [F:FACT-2]',
      '- src/test/OrderServiceTest.java line 9 contains a lexical call candidate to same-file declaration rejects at line 8; semantic resolution is unavailable. [F:FACT-3]'
    ],
    'Unavailable analysis': [
      '- The pinned source revision has no exact first-parent baseline; changed-symbol extraction is unavailable. [F:FACT-4]',
      '- The pinned source revision has no exact first-parent baseline; test-impact extraction is unavailable. [F:FACT-5]'
    ]
  }, [
    fact('FACT-1', 'available'), fact('FACT-2', 'available'), fact('FACT-3', 'available'),
    fact('FACT-4', 'unavailable', { reason: { code: 'BASELINE_UNAVAILABLE' } }), fact('FACT-5', 'unavailable', { reason: { code: 'BASELINE_UNAVAILABLE' } })
  ]);
  const projection = projectRegisteredView(markdown);
  assert.deepEqual(projection.lines.map((line) => line.text), ['OrderService uses Order, OrderStatus']);
  assert.deepEqual(projection.notKnown, ['no first-parent baseline for change analysis', 'calls are matched by name']);
  // Deterministic, so a receipt can bind it and a verifier can recompute it from the same bytes.
  assert.deepEqual(viewProjectionDigest(projectRegisteredView(markdown)), viewProjectionDigest(projection));
  assert.notEqual(viewProjectionDigest(projectRegisteredView(markdown.replace('OrderStatus.java', 'Customer.java'))).sha256, viewProjectionDigest(projection).sha256);
});

test('a brief is ranked by the Story, ordered for the phase, cited, and fits the phase budget with one Not known line', () => {
  const template = {
    views: {
      overview: [{ text: 'shop: 12 code files in java', sources: [] }],
      rules: Array.from({ length: 12 }, (_, index) => ({
        text: `Rule ${index}: refuses "message number ${index}" with a fairly long explanation of the condition and outcome`,
        sources: [{ path: `src/rules/Rule${index}.java`, line: 10 + index, label: `src/rules/Rule${index}.java:${10 + index}` }]
      })),
      contracts: [{ text: 'POST /orders handled by OrderController.place', sources: [{ path: 'src/web/OrderController.java', line: 21, label: 'x' }] }],
      flows: [], impact: [], risks: [],
      questions: [{ text: 'Should cancelled orders be refunded?', sources: [] }]
    }
  };
  const registered = [{
    view: 'arch.contracts', section: 'contracts', notKnown: ['runtime-guarantee', 'schema-contract'],
    lines: [{ text: 'OrderController: method place(Order)', source: { path: 'src/web/OrderController.java', line: 13 } },
      { text: 'Refund: class Refund', source: { path: 'src/model/Refund.java', line: 3 } }]
  }];
  const profile = phaseBriefProfile('intake');
  assert.deepEqual([profile.id, profile.reader, profile.budget], ['intake', 'product', 2048]);
  const brief = renderPhaseBrief({
    repository: 'shop', commit: '0123456789abcdef', profile, focus: 'Refund cancelled orders', template, registered,
    notKnown: ['no runtime or incident data', 'runtime-guarantee', 'schema-contract'], modelCommit: 'fedcba9876543210', phase: 'intake'
  });
  assert.ok(Buffer.byteLength(brief.text) <= 2048, `${Buffer.byteLength(brief.text)} bytes`);
  assert.match(brief.text, /^# Repository brief: shop at 0123456789ab \(for intake, focused on this Story\)$/mu);
  assert.ok(brief.text.indexOf('## What exists') < brief.text.indexOf('## Rules that apply'));
  assert.ok(brief.text.indexOf('## Rules that apply') < brief.text.indexOf('## Questions for the product owner'), 'intake gets the product owner\'s questions');
  assert.match(brief.text, /## Contracts\n- POST \/orders handled by OrderController\.place \(OrderController\.java:21\)/u);
  assert.match(brief.text, /- Refund: class Refund \(Refund\.java:3\)/u, 'a registered line the knowledge lacks is added');
  assert.doesNotMatch(brief.text, /OrderController: method place/u, 'a registered line naming a type knowledge already shows is left out');
  assert.match(brief.text, /- … \d+ more: singularity-flow wm brief --phase intake/u, 'what did not fit is counted, with where to read it');
  assert.equal(brief.text.match(/^Not known: /gmu)?.length, 1);
  assert.match(brief.text, /Not known: no registered producer for runtime-guarantee, schema-contract; no runtime or incident data\./u);
  assert.match(brief.text, /registered World Model at fedcba987654/u);
  const implementation = renderPhaseBrief({ repository: 'shop', profile: phaseBriefProfile('implementation'), template, registered: [] });
  assert.doesNotMatch(implementation.text, /Questions for the product owner/u, 'only the product reader gets questions');
  assert.equal(phaseBriefProfile('verification').budget, 3072);
  assert.equal(phaseBriefProfile('implementation-spec').budget, 4096);
  assert.equal(phaseBriefProfile('fix-design').id, 'implementation-spec');
  assert.equal(phaseBriefProfile('intake', { maxBytes: 5000 }).budget, 5000, 'worldModel.knowledge.maxBytes replaces the default');
});

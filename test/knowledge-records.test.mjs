/**
 * Rule records (World Model v5, M1): docs statements, code rules and tests linked by anchors, each
 * rule with a status (agreed, documented only, enforced only, conflict) and whether a test reaches it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeEndpoint, statusNumber, textAnchors, textBounds } from '../src/knowledge/records/anchors.mjs';
import { buildRuleRecords, codeRuleBound, ruleQuestions, ruleStatusWords } from '../src/knowledge/records/rules.mjs';

test('docs anchors: bounds read as what is allowed, statuses in context, endpoints, percentages, messages of words', () => {
  assert.deepEqual(textBounds('An order needs at least one line.'), [{ op: '>=', value: 1 }]);
  assert.deepEqual(textBounds('Orders under 10.00 are not accepted.'), [{ op: '>=', value: 10 }], 'a refused range states the allowed one');
  assert.deepEqual(textBounds('An order can have at most 20 lines'), [{ op: '<=', value: 20 }]);
  assert.deepEqual(textBounds('Quantity must be >= 2'), [{ op: '>=', value: 2 }]);
  const anchors = textAnchors('Returns 422 Unprocessable Entity when `rule` is null; POST /orders/{id}/cancel refuses "Only placed orders can be cancelled". VIP gets 5%.');
  assert.deepEqual([...anchors.statuses], [422]);
  assert.deepEqual([...anchors.endpoints], ['POST /orders/{}/cancel']);
  assert.deepEqual([...anchors.messages], ['only placed orders can be cancelled']);
  assert.deepEqual([...anchors.identifiers], ['rule']);
  assert.ok(anchors.numbers.has(0.05), '5% is also read as 0.05');
  assert.equal(textAnchors('Condition: { "field": "a.b.c", "op": "gte" }').messages.size, 0, 'quoted example keys are not messages');
  assert.deepEqual([...textAnchors('The service listens on port 8080 and returns 404 for unknown paths').statuses], [404], '404 counts; 8080 is not a status');
  assert.equal(textAnchors('Version 2 ships 200 icons').statuses.size, 0, 'a number without status wording is not a status');
  assert.equal(statusNumber('BAD_REQUEST'), 400);
  assert.equal(normalizeEndpoint('get', '/users/:id/'), 'GET /users/{}');
});

test('code rule bounds: a refusal states what is allowed', () => {
  const limit = (name, value) => ({ name, value });
  assert.deepEqual(codeRuleBound({ when: ['order.getLines().size() > MAX_ITEMS'], then: { kind: 'refuses' }, values: { constants: [limit('MAX_ITEMS', '20')] } }), { op: '<=', value: 20 });
  assert.deepEqual(codeRuleBound({ when: ['order.getLines().isEmpty()'], then: { kind: 'refuses' } }), { op: '>=', value: 1 });
  assert.deepEqual(codeRuleBound({ when: ['total.compareTo(MINIMUM_ORDER_TOTAL) < 0'], then: { kind: 'refuses' }, values: { constants: [limit('MINIMUM_ORDER_TOTAL', 'new BigDecimal("10.00")')] } }), { op: '>=', value: 10 });
  assert.deepEqual(codeRuleBound({ when: ['amount > 100'], then: { kind: 'computes' } }), { op: '>', value: 100 }, 'any other rule states when it applies');
  assert.equal(codeRuleBound({ when: ['user.isAdmin()'], then: { kind: 'refuses' } }), null);
});

function rule(id, symbol, when, then, extra = {}) {
  return {
    id, kind: 'rule', subject: { symbol, path: 'src/OrderService.java' }, citations: [{ path: 'src/OrderService.java', lines: [extra.line ?? 10, extra.line ?? 10] }],
    statement: { kind: extra.kind ?? 'refusal', when, then, values: { constants: extra.constants ?? [] } },
    relations: extra.tested ? [{ type: 'tested-by', to: 'K-test', label: 'rejects large orders' }] : []
  };
}

test('records link docs and code by anchors and report agreement, conflicts and gaps', () => {
  const knowledge = {
    items: [
      rule('K-1', 'OrderService.place', ['order.getLines().size() > MAX_ITEMS'], { kind: 'refuses', text: 'An order can have at most 20 lines' }, { constants: [{ name: 'MAX_ITEMS', value: '20' }], tested: true }),
      rule('K-2', 'OrderService.place', ['order.getLines().isEmpty()'], { kind: 'refuses', text: 'An order needs at least one line' }, { tested: true, line: 20 }),
      rule('K-3', 'OrderService.cancel', ['order.getStatus() != OrderStatus.PLACED'], { kind: 'refuses', text: 'Only placed orders can be cancelled' }, { line: 40 }),
      { id: 'K-e1', kind: 'error-path', statement: { message: 'Only placed orders can be cancelled', status: 'CONFLICT' } },
      { id: 'K-e2', kind: 'error-path', statement: { message: 'An order needs at least one line', status: 'BAD_REQUEST' } }
    ]
  };
  const documentation = {
    statements: [
      { path: 'README.md', line: 5, heading: 'Business rules', text: 'An order can have at most 30 lines.' },
      { path: 'README.md', line: 6, heading: 'Business rules', text: 'Every order needs at least one line.' },
      { path: 'README.md', line: 7, heading: 'Business rules', text: 'Discount codes must be ten characters long.' },
      { path: 'README.md', line: 12, heading: 'Errors', text: '422 when the order fails validation' }
    ]
  };
  const records = buildRuleRecords(knowledge, documentation);
  const byText = (pattern) => records.find((record) => pattern.test(record.text));
  const bound = byText(/at most 20 lines/u);
  assert.equal(bound.status, 'conflict');
  assert.equal(bound.conflict, 'the docs say at most 30; the code allows at most 20');
  const lines = byText(/needs at least one line/u);
  assert.deepEqual([lines.status, lines.documented, lines.enforced, lines.tested], ['agreed', true, true, true]);
  assert.equal(ruleStatusWords(lines), 'Documented, enforced, tested.');
  assert.deepEqual(lines.sources.docs, [{ path: 'README.md', line: 6, heading: 'Business rules' }]);
  const cancel = byText(/placed orders/u);
  assert.equal(cancel.status, 'enforced-only');
  assert.match(cancel.text, /\(HTTP 409\)$/u, 'the status comes from the exception mapping');
  assert.equal(ruleStatusWords(cancel), 'Not documented, enforced, no test reaches it.');
  assert.equal(byText(/Discount codes/u).status, 'documented-only');
  const statusConflict = byText(/^422/u);
  assert.equal(statusConflict.status, 'conflict');
  assert.match(statusConflict.conflict, /the docs promise HTTP 422; the code's refusals return HTTP 400, 409/u);
  assert.deepEqual(records.slice(0, 2).map((record) => record.status), ['conflict', 'conflict'], 'conflicts come first');
  const questions = ruleQuestions(records).map((question) => question.text);
  assert.ok(questions.some((text) => /Docs and code disagree on "An order can have at most 20 lines"/u.test(text)));
  assert.ok(questions.some((text) => /The code refuses "Only placed orders can be cancelled", but the docs do not state it and no test reaches it/u.test(text)));
  const focused = buildRuleRecords(knowledge, documentation, { focus: 'cancel placed orders' });
  assert.match(focused[0].text, /placed orders/u, 'the Story\'s words rank first');
});

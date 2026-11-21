/**
 * Baseline acceptance criteria by kind of software (step intents §12.2): what the step that defines a Story's scope is
 * given to add, for the kinds a person confirmed; nothing when no kind is confirmed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { BASELINE_CRITERIA, baselineCriteriaFor, baselineCriteriaSection } from '../src/software-kind-baselines.mjs';
import { SOFTWARE_KINDS } from '../src/software-kinds.mjs';

test('every kind of software has its baseline criteria, and only confirmed kinds add any', () => {
  assert.deepEqual(Object.keys(BASELINE_CRITERIA).sort(), [...SOFTWARE_KINDS].sort());
  assert.equal(baselineCriteriaSection([]), '');
  assert.equal(baselineCriteriaSection([{ id: 'x', kind: 'unknown' }]), '');
  const kinds = baselineCriteriaFor([{ id: 'orders', name: 'orders-service', kind: 'backend' }, { id: 'web', name: 'shop-web', kind: 'web' }, { id: 'admin', name: 'admin-web', kind: 'web' }]);
  assert.deepEqual(kinds.map((entry) => [entry.kind, entry.projects]), [['web', ['shop-web', 'admin-web']], ['backend', ['orders-service']]]);
  const section = baselineCriteriaSection([{ id: 'web', name: 'shop-web', kind: 'web' }, { id: 'orders', name: 'orders-service', kind: 'backend' }]);
  assert.match(section, /^## Baseline acceptance criteria for this kind of software\n\nA person confirmed what kind of software this repository is: shop-web is a web app; orders-service is a backend \(API or service\)\./u);
  assert.match(section, /\nFor a web app:\n- No layout jump or resize while typing, clicking or scrolling\.\n/u);
  assert.match(section, /\nFor a backend \(API or service\):\n- Bad input gets a 4xx response with a clear message, never a 500\.\n/u);
  assert.match(section, /A person may drop any of them, with a reason\./u);
});

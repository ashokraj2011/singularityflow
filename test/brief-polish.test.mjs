/**
 * Model phrasing of a phase's repository brief (World Model v5, M4): the model sees only the selected
 * lines, every sentence is checked against the records it cites, a failing sentence leaves its
 * records in their fixed wording, and without a model the brief is the same bytes as before.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { polishPrompt, validatePolish } from '../src/knowledge/brief-polish.mjs';
import { phaseBriefProfile, renderPhaseBrief } from '../src/knowledge/phase-brief.mjs';
import { repositoryBriefPrompt } from '../src/knowledge/prompt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rule = (id, text, status, extra = {}) => ({
  id, kind: 'rule', origin: 'code', text, status, documented: status === 'agreed', enforced: true, tested: true, conflict: null,
  parts: {}, sources: { code: [{ path: 'src/OrderService.java', line: extra.line ?? 20, symbol: 'OrderService.place' }], docs: [], tests: [] },
  quotes: extra.quotes ?? [], ...extra
});

const records = () => ({
  rules: [
    rule('R-000000000001', 'OrderService.place: when `order.getLines().isEmpty()` → refuses "An order needs at least one line" (HTTP 400)', 'agreed',
      { line: 23, quotes: ['An order needs at least one line.'] }),
    rule('R-000000000002', 'OrderService.place: when `order.getLines().size() > MAX_ITEMS` → refuses "An order can have at most 20 lines" (HTTP 400)', 'agreed', { line: 26 }),
    rule('R-000000000003', 'OrderService.cancel: when `order.getStatus() != OrderStatus.PLACED` → refuses "Only placed orders can be cancelled" (HTTP 409)', 'enforced-only',
      { line: 43, documented: false, tested: false })
  ],
  contracts: [{ id: 'C-000000000001', kind: 'contract', category: 'endpoint', text: 'POST /orders takes Order and returns it; refuses with 400 (3 checks)', tested: true,
    sources: { code: [{ path: 'src/OrderController.java', line: 21 }] } }]
});

function selectionOf(brief) {
  return new Map(brief.selection.map((entry) => [entry.id, entry]));
}

test('a phrasing sentence is kept only when what it names is in the records it cites', () => {
  const profile = phaseBriefProfile('implementation');
  const brief = renderPhaseBrief({ repository: 'orders', profile, ...records() });
  assert.deepEqual(brief.records, ['R-000000000001', 'R-000000000002', 'R-000000000003', 'C-000000000001']);
  const prompt = polishPrompt(brief.selection, { repository: 'orders', profile: profile.id });
  assert.deepEqual(prompt.records, brief.records, 'the receipt names the records sent');
  assert.match(prompt.text, /^R-000000000001 \[rules\] OrderService\.place: .*\(HTTP 400\)\. \| the docs say: An order needs at least one line\.$/mu,
    'a rule is shown without its status, which the brief adds');
  const sentences = [
    { text: 'An order must have between one and 20 lines, so empty and oversized orders are refused with HTTP 400.', cites: ['R-000000000001', 'R-000000000002'] },
    // Changes a value: 30 is in no cited record.
    { text: 'Only orders with at most 30 lines are accepted.', cites: ['R-000000000002'] },
    // Adds a name and a route.
    { text: 'A cancel request on POST /orders/refund goes through Stripe.', cites: ['R-000000000003'] },
    { text: 'Cancelling is allowed only while the status is `OrderStatus.PLACED`; otherwise it refuses "Only placed orders can be cancelled".', cites: ['R-000000000003'] },
    { text: 'The order endpoint is well designed.', cites: ['C-000000000001'] },
    { text: 'Orders arrive at POST /orders.', cites: ['C-000000000001', 'R-000000000001'] },
    { text: 'Orders arrive at POST /orders and invalid ones are refused with 400.', cites: [] },
    { text: 'Orders arrive at POST /orders.', cites: ['C-999999999999'] },
    { text: 'A placed order is refused when empty.', cites: ['R-000000000003', 'R-000000000001'] }
  ];
  const checked = validatePolish(JSON.stringify({ sentences }), brief.selection);
  assert.deepEqual(checked.accepted.map((entry) => entry.cites), [['R-000000000001', 'R-000000000002'], ['R-000000000003']]);
  assert.deepEqual(checked.rejected.map((entry) => entry.reason), [
    'cites a record another sentence already covers: R-000000000002',
    'names what its records do not contain: /orders/refund, POST, Stripe',
    'judges instead of describing',
    'merges records from different sections',
    'cites nothing',
    'cites records the brief did not select: C-999999999999',
    'merges rules with different statuses'
  ]);
  const value = validatePolish({ sentences: [{ text: 'Only orders with at most 30 lines are accepted.', cites: ['R-000000000002'] }] }, brief.selection);
  assert.deepEqual(value.rejected.map((entry) => entry.reason), ['names what its records do not contain: 30'], 'a changed value is refused');
  const open = validatePolish({ sentences: [{ text: 'Empty orders are refused when `order.getLines().isEmpty() holds.', cites: ['R-000000000001'] }] }, brief.selection);
  assert.deepEqual(open.rejected.map((entry) => entry.reason), ['leaves a code span or a quotation open']);
  assert.throws(() => validatePolish('not json', brief.selection), { code: 'KNOWLEDGE_BRIEF_INVALID' });
  assert.ok(selectionOf(brief).get('R-000000000001').status.startsWith('Documented'), 'a rule\'s status travels beside its line, not inside the model\'s text');
});

test('a phrased brief keeps each rule\'s status, cites what it merged, says a model phrased it, and leaves the rest as it was', () => {
  const profile = phaseBriefProfile('implementation');
  const inputs = { repository: 'orders', commit: '0123456789abcdef', profile, ...records() };
  const fixed = renderPhaseBrief(inputs);
  assert.equal(renderPhaseBrief(inputs).text, fixed.text, 'without a phrasing the brief is reproducible byte for byte');
  assert.doesNotMatch(fixed.text, /phrased by/u);
  const phrased = renderPhaseBrief({ ...inputs, phrasing: { model: 'test-model', sentences: [
    { text: 'An order must have between one and 20 lines.', cites: ['R-000000000001', 'R-000000000002'], section: 'rules' }
  ] } });
  assert.match(phrased.text, /^# Repository brief: orders at 0123456789ab \(for implementation; phrased by a model\)$/mu);
  assert.match(phrased.text, /^- An order must have between one and 20 lines\. Documented, enforced, tested\. \(OrderService\.java:23; OrderService\.java:26\)$/mu,
    'the brief adds the status the model may not change');
  assert.match(phrased.text, /^- OrderService\.cancel: when `order\.getStatus\(\) != OrderStatus\.PLACED` → refuses/mu, 'a line no sentence covers keeps its fixed wording');
  assert.match(phrased.text, /1 line was phrased by test-model, each checked against the records it cites\./u);
  assert.equal(phrased.phrased, 1);
  assert.deepEqual(phrased.records, ['R-000000000001', 'R-000000000002', 'R-000000000003', 'C-000000000001']);
  assert.deepEqual(phrased.selection.map((entry) => entry.id), ['R-000000000003', 'C-000000000001'], 'a phrased line is not offered again');
});

async function ordersRepository(t) {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-polish-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', 'orders-spring'), repository, { recursive: true });
  await writeFile(path.join(repository, 'README.md'), '# Orders\n\n## Business rules\n\n- An order needs at least one line.\n- Orders under 10.00 are not accepted.\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Fixture']]) {
    assert.equal(spawnSync('git', args, { cwd: repository, encoding: 'utf8' }).status, 0);
  }
  return repository;
}

/** Model use on, or off, for the duration of `run`, whatever the suite's environment says. */
async function withModelUse(run, on = true) {
  const before = process.env.SINGULARITY_FLOW_NO_MODEL;
  if (on) delete process.env.SINGULARITY_FLOW_NO_MODEL; else process.env.SINGULARITY_FLOW_NO_MODEL = '1';
  try { return await run(); } finally { if (before === undefined) delete process.env.SINGULARITY_FLOW_NO_MODEL; else process.env.SINGULARITY_FLOW_NO_MODEL = before; }
}

test('composing reuses a phrasing saved for exactly these records while model use is on, and never calls a model', async (t) => {
  const repository = await ordersRepository(t);
  const options = { definition: null, phase: 'implementation', workflow: { workItem: { title: 'Cancel placed orders' } } };
  const fixed = await repositoryBriefPrompt(repository, { ...options, polish: 'off' });
  assert.equal(fixed.receipt.phrasing.by, 'template');
  assert.ok(fixed.receipt.records.length > 3);
  const sent = [];
  const ask = async (text) => {
    sent.push(text);
    const id = text.match(/^(R-[0-9a-f]{12}) \[rules\] OrderService\.cancel/mu)[1];
    return { model: 'recorded', output: JSON.stringify({ sentences: [
      { text: 'Only an order whose status is `OrderStatus.PLACED` can be cancelled; any other is refused with "Only placed orders can be cancelled".', cites: [id] },
      { text: 'Refunds go through Stripe.', cites: [id] }
    ] }) };
  };
  const written = await withModelUse(() => repositoryBriefPrompt(repository, { ...options, polish: 'write', ask }));
  assert.equal(sent.length, 1);
  const listed = sent[0].split('\n').slice(sent[0].split('\n').findIndex((line) => line.startsWith('Records ')) + 1).filter(Boolean);
  assert.deepEqual(listed.map((line) => line.split(' ')[0]), written.polish.sent, 'the model sees the selected lines and nothing else');
  assert.equal(written.receipt.phrasing.by, 'model');
  assert.equal(written.receipt.phrasing.model, 'recorded');
  const cancel = written.polish.sent.find((id) => sent[0].includes(`${id} [rules] OrderService.cancel`));
  assert.ok(written.receipt.records.includes(cancel), 'the receipt names the phrased record');
  assert.equal(written.polish.accepted, 1);
  assert.deepEqual(written.polish.rejected.map((entry) => entry.reason), [`cites a record another sentence already covers: ${cancel}`]);
  assert.match(written.text, /^- Only an order whose status is `OrderStatus\.PLACED` can be cancelled; .*\. Not documented, enforced, no test reaches it\. \(OrderService\.java:43\)$/mu);
  assert.match(written.text, /phrased by a model\)$/mu);

  const again = await withModelUse(() => repositoryBriefPrompt(repository, { ...options, ask: async () => { throw new Error('a compose must not call a model'); } }));
  assert.equal(again.text, written.text, 'a compose reuses the saved phrasing');
  assert.equal(again.polish.cached, true);
  const off = await withModelUse(() => repositoryBriefPrompt(repository, { ...options }), false);
  assert.equal(off.text, fixed.text, 'with model use off the fixed wording stands, byte for byte');
  assert.equal(off.receipt.phrasing.by, 'template');

  const otherStory = await withModelUse(() => repositoryBriefPrompt(repository, { ...options, workflow: { workItem: { title: 'Limit order lines' } } }));
  assert.equal(otherStory.receipt.phrasing.by, 'template', 'another selection has no saved phrasing');
  const failing = await withModelUse(() => repositoryBriefPrompt(repository, { ...options, polish: 'write', refresh: true, ask: async () => { throw new Error('model unavailable'); } }));
  assert.equal(failing.text, fixed.text, 'a failing model leaves the fixed wording');
  assert.match(failing.warnings.join('\n'), /keeps its fixed wording: the model could not phrase it \(model unavailable\)/u);
});

test('a claim is checked where it is made, and a name at the start of a sentence must be in the records too', () => {
  const brief = renderPhaseBrief({ repository: 'orders', profile: phaseBriefProfile('implementation'), ...records() });
  const cancel = 'R-000000000003';
  const reasons = (text, cites = [cancel]) => validatePolish({ sentences: [{ text, cites }] }, brief.selection).rejected.map((entry) => entry.reason);
  // A "no" elsewhere in the sentence does not license a claim the record contradicts.
  assert.deepEqual(reasons('An order with no placed status is refused; this is tested.'), ['says the opposite of what its records say']);
  assert.deepEqual(reasons('Only placed orders can be cancelled, and no test reaches this refusal.'), [], 'a claim kept negative where it is made stands');
  // A claim the records do not make at all is not a fact the sentence may add.
  assert.deepEqual(reasons('POST /orders is documented.', ['C-000000000001']), ['states a test, docs or enforcement fact its records do not']);
  // The first word of a sentence, and the first after a full stop or a colon, is checked like any other name.
  assert.deepEqual(reasons('Stripe refunds the payment when an order is not placed.'), ['names what its records do not contain: Stripe']);
  assert.deepEqual(reasons('Cancelling needs a placed order. Billing refunds it.'), ['names what its records do not contain: Billing']);
  assert.deepEqual(reasons('Cancelling is refused with "Only placed orders can be cancelled" unless the status is `OrderStatus.PLACED`.'), [],
    'an ordinary word the records use (cancelled) may start a sentence');
});

test('a person\'s confirmed meaning is never offered to the model, and a phrasing the budget cut does not count', () => {
  const profile = phaseBriefProfile('implementation');
  const confirmed = records();
  confirmed.rules[0] = { ...confirmed.rules[0], meaning: { condition: 'an order has no lines', outcome: 'it is refused', intent: null, current: true } };
  const brief = renderPhaseBrief({ repository: 'orders', profile, ...confirmed });
  assert.match(brief.text, /^- When an order has no lines: it is refused\. Meaning confirmed by a person\. Documented, enforced, tested\./mu);
  assert.ok(!brief.selection.some((entry) => entry.id === 'R-000000000001'), 'the person\'s words are not the model\'s to rephrase');
  assert.ok(brief.records.includes('R-000000000001'), 'the receipt still names the record');
  const rephrased = renderPhaseBrief({ repository: 'orders', profile, ...confirmed, phrasing: { model: 'recorded', sentences: [
    { text: 'An order with no lines is refused.', cites: ['R-000000000001'], section: 'rules' }
  ] } });
  assert.equal(rephrased.text, brief.text, 'a saved phrasing of a confirmed line is not applied');
  assert.equal(rephrased.phrased, 0);

  // A phrased line too long for the budget is left out: the brief does not claim a model phrased it.
  const tight = phaseBriefProfile('implementation', { maxBytes: 700 });
  const long = 'Cancelling is refused with "Only placed orders can be cancelled" (HTTP 409) unless the order status is `OrderStatus.PLACED`, so an order that is paid, shipped or cancelled stays as it is.';
  const cut = renderPhaseBrief({ repository: 'orders', profile: tight, ...records(), phrasing: { model: 'recorded', sentences: [
    { text: long, cites: ['R-000000000003'], section: 'rules' }
  ] } });
  assert.doesNotMatch(cut.text, /Cancelling is refused/u, 'the phrased line did not fit');
  assert.equal(cut.phrased, 0);
  assert.doesNotMatch(cut.text, /phrased by/u);
  assert.match(cut.text, /Read without a model from the committed source\./u);
});

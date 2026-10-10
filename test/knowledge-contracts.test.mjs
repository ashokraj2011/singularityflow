/**
 * Contract records (World Model v5, M1c): what an endpoint takes, returns and refuses, which
 * repositories store which entities, which classes implement which interfaces, and the data shapes,
 * calls and configuration around them.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { handlerSignature, repositoryInterfaces, typeRelations, unwrapType } from '../src/knowledge/contracts.mjs';
import { knowledgeCommand } from '../src/knowledge/command.mjs';
import { buildContractRecords, renderContractRecords } from '../src/knowledge/records/contracts.mjs';
import { buildKnowledge } from '../src/knowledge/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = (relative, language, text) => ({ path: relative, language, lines: text.split('\n') });

async function fixtureRepository(t, name) {
  const repository = await mkdtemp(path.join(os.tmpdir(), `sflow-contracts-${name}-`));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', name), repository, { recursive: true });
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Fixture']]) {
    assert.equal(spawnSync('git', args, { cwd: repository, encoding: 'utf8' }).status, 0);
  }
  return repository;
}

async function quiet(fn) {
  const log = console.log;
  const lines = [];
  console.log = (value) => lines.push(String(value));
  try { await fn(); } finally { console.log = log; }
  return lines.join('\n');
}

test('handler signatures: request body, path/query parameters and the unwrapped response, across frameworks', () => {
  assert.deepEqual(handlerSignature(file('A.java', 'java', [
    '@PostMapping("/{id}/cancel")',
    'public ResponseEntity<Order> cancel(@PathVariable("id") Long id,',
    '    @RequestParam(name = "reason", required = false) String reason,',
    '    @Valid @RequestBody CancelRequest body) {', '  return null;', '}'
  ].join('\n')), 'cancel', 1), {
    request: { type: 'CancelRequest', name: 'body' }, response: 'Order',
    params: [{ in: 'path', name: 'id', type: 'Long' }, { in: 'query', name: 'reason', type: 'String' }]
  });
  assert.equal(handlerSignature(file('B.java', 'java', '@GetMapping public List<Order> all() { return null; }'), 'all', 1).response, 'list of Order');
  assert.deepEqual(handlerSignature(file('C.kt', 'kotlin', '@PostMapping\nfun place(@RequestBody order: Order): Mono<Order> = service.place(order)'), 'place', 1).request, { type: 'Order', name: 'order' });
  const nest = handlerSignature(file('D.ts', 'typescript', "@Post(':id')\nasync create(@Body() dto: CreateUserDto, @Param('id') id: string): Promise<User> {"), 'create', 1);
  assert.deepEqual([nest.request.type, nest.response, nest.params], ['CreateUserDto', 'User', [{ in: 'path', name: 'id', type: 'string' }]]);
  const fastapi = handlerSignature(file('e.py', 'python', '@app.post("/orders", response_model=OrderOut)\ndef create_order(order: OrderIn, limit: int = Query(10)) -> OrderOut:\n    return order'), 'create_order', 2);
  assert.deepEqual([fastapi.request.type, fastapi.response, fastapi.params], ['OrderIn', 'OrderOut', [{ in: 'query', name: 'limit', type: 'int' }]]);
  assert.deepEqual([unwrapType('ResponseEntity<List<Order>>'), unwrapType('Mono<Void>'), unwrapType('Order[]')], ['list of Order', null, 'list of Order']);
});

test('repositories and seams are read from interface declarations', () => {
  assert.deepEqual(repositoryInterfaces(file('R.java', 'java', 'public interface OrderRepository extends JpaRepository<Order, Long> {\n    List<Order> findByCustomerId(String id);\n    boolean existsByStatus(OrderStatus status);\n}')), [
    { name: 'OrderRepository', base: 'JpaRepository', entity: 'Order', id: 'Long', methods: ['findByCustomerId', 'existsByStatus'], line: 1 }
  ]);
  const relations = typeRelations(file('S.java', 'java', 'public interface PaymentGateway { void charge(); }\npublic class StripeGateway implements PaymentGateway, AutoCloseable {}'));
  assert.deepEqual(relations.interfaces.map((entry) => entry.name), ['PaymentGateway']);
  assert.deepEqual(relations.classes, [{ name: 'StripeGateway', supertypes: ['PaymentGateway', 'AutoCloseable'], line: 2 }]);
  assert.deepEqual(typeRelations(file('S.kt', 'kotlin', 'interface Notifier\nclass EmailNotifier(private val mail: Mail) : Notifier, Closeable')).classes[0].supertypes, ['Notifier', 'Closeable']);
});

test('contract records describe endpoints with their input, output, refusals and test reach, plus storage, seams, shapes and configuration', async (t) => {
  const orders = await fixtureRepository(t, 'orders-spring');
  const knowledge = (await buildKnowledge(orders, {})).knowledge;
  const place = knowledge.items.find((item) => item.kind === 'entry-point' && item.statement.label === 'POST /orders');
  assert.deepEqual([place.statement.request, place.statement.response, place.statement.params], [{ type: 'Order', name: 'order' }, 'Order', []]);
  const records = buildContractRecords(knowledge);
  const text = (pattern) => records.find((record) => pattern.test(record.text));
  assert.match(text(/^POST \/orders takes/u).text, /^POST \/orders takes Order \{id: Long; customerId: String; .+\} and returns it; refuses with 400 \(3 checks\)$/u);
  assert.equal(text(/^POST \/orders takes/u).tested, true, 'a service test on the endpoint\'s flow reaches it');
  assert.equal(text(/^POST \/orders\/\{id\}\/cancel/u).text, 'POST /orders/{id}/cancel takes path id and returns Order; refuses with 409 (1 check)');
  assert.equal(text(/^OrderRepository/u).text, 'OrderRepository stores Order (id Long)');
  assert.equal(text(/^enum OrderStatus/u).text, 'enum OrderStatus: PLACED, PAID, SHIPPED, CANCELLED');
  assert.ok(text(/^Configuration orders\.max-items = 20$/u));
  const mix = await fixtureRepository(t, 'validation-mix');
  const mixed = buildContractRecords((await buildKnowledge(mix, {})).knowledge, { focus: 'refund a payment' });
  assert.match(mixed.find((record) => record.text.startsWith('POST /orders')).text, /takes OrderRequest \{lines: List<String> \(required, at least 1 long, at most 20 long\); total: BigDecimal \(at least 10\); email: String \(an email address\)\}/u);
  assert.equal(mixed.find((record) => record.category === 'seam').text, 'PaymentGateway (interface) is implemented by StripeGateway');
  assert.match(mixed[0].text, /refund/iu, 'the Story\'s words rank first');
  const shown = await quiet(() => knowledgeCommand(orders, ['show', 'contracts'], {}));
  assert.match(shown, /## Contracts\n\n### Exposed\n\n- POST \/orders takes Order/u);
  assert.match(shown, /### Storage\n\n- OrderRepository stores Order \(id Long\)/u);
  assert.equal(renderContractRecords([]), '');
});

/**
 * Flow, impact and risk records (World Model v5, M2): what happens when someone uses a feature,
 * what a Story's own changed or planned files touch, and where a change is risky and why.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { knowledgeCommand } from '../src/knowledge/command.mjs';
import { repositoryBriefPrompt } from '../src/knowledge/prompt.mjs';
import { buildFlowRecords, mainChain, renderFlowRecords, stepsText } from '../src/knowledge/records/flows.mjs';
import { buildImpactRecords, changedRangesFromPreview, impactSymbols, knowledgePaths, readChange } from '../src/knowledge/records/impact.mjs';
import { buildRiskRecords } from '../src/knowledge/records/risks.mjs';
import { buildKnowledge } from '../src/knowledge/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = 'src/main/java/com/acme/orders/service/OrderService.java';
const ORDER = 'src/main/java/com/acme/orders/model/Order.java';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** orders-spring with a history: one person makes three of four later changes, two of them fixes. */
async function ordersWithHistory(t) {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-change-records-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', 'orders-spring'), repository, { recursive: true });
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'add', '-A');
  git(repository, '-c', 'user.name=Ana', '-c', 'user.email=ana@example.com', 'commit', '-qm', 'Fixture');
  const commits = [['ana@example.com', 'Fix minimum order total'], ['Ana@Example.com', 'Add VIP note'], ['ana@example.com', 'Hotfix: cancel message'], ['bo@example.com', 'Tidy imports']];
  for (const [email, subject] of commits) {
    const file = path.join(repository, SERVICE);
    await writeFile(file, `${await readFile(file, 'utf8')}// ${subject}\n`);
    git(repository, 'add', '-A');
    git(repository, '-c', `user.name=${email}`, '-c', `user.email=${email}`, 'commit', '-qm', subject);
  }
  return repository;
}

/** Change one line inside OrderService.cancel, leaving place and totalOf as they are. */
async function changeCancel(repository) {
  const file = path.join(repository, SERVICE);
  await writeFile(file, (await readFile(file, 'utf8')).replace('Only placed orders can be cancelled', 'Only placed orders may be cancelled'));
}

async function quiet(fn) {
  const log = console.log;
  const lines = [];
  console.log = (value) => lines.push(String(value));
  try { await fn(); } finally { console.log = log; }
  return lines.join('\n');
}

test('a flow shows the call chain to its weightiest step, not everything it reaches', () => {
  const steps = ['Api.evaluate', 'Service.evaluate', 'Service.group', 'Service.condition', 'Service.textOf', 'Service.compare'];
  const calls = [
    ['Api.evaluate', 'Service.evaluate'], ['Service.evaluate', 'Service.group'], ['Service.group', 'Service.condition'],
    ['Service.condition', 'Service.textOf'], ['Service.condition', 'Service.compare'], ['Other.x', 'Service.compare']
  ];
  const rules = { 'Service.condition': 10, 'Service.compare': 6 };
  const { chain, helpers } = mainChain(steps, calls, (symbol) => rules[symbol] ?? 0);
  assert.deepEqual(chain, ['Api.evaluate', 'Service.evaluate', 'Service.group', 'Service.condition']);
  assert.deepEqual(helpers, ['Service.textOf', 'Service.compare']);
  assert.equal(stepsText(chain), 'Api.evaluate → Service.evaluate → group → condition', 'a step in the class before it drops the class');
  // With no rules anywhere, the deepest step ends the chain.
  assert.deepEqual(mainChain(steps, calls).chain.at(-1), 'Service.textOf');
});

test('changed line ranges come from a zero-context diff; a pure deletion touches the line before it', () => {
  const ranges = changedRangesFromPreview({ status: 'available', files: [
    { pathAfter: 'a.java', hunks: [{ afterStart: 10, afterLines: 3 }, { afterStart: 40, afterLines: 0 }] },
    { pathAfter: null, hunks: [{ afterStart: 1, afterLines: 0 }] }
  ] });
  assert.deepEqual([...ranges], [['a.java', [[10, 12], [40, 40]]]]);
  assert.equal(changedRangesFromPreview({ status: 'unavailable' }).size, 0);
});

test('flows: each endpoint with its chain, refusals and statuses, effects and response', async (t) => {
  const repository = await ordersWithHistory(t);
  const { knowledge } = await buildKnowledge(repository);
  const flows = buildFlowRecords(knowledge, { focus: 'cancel an order' });
  assert.equal(flows.length, 2);
  assert.equal(flows[0].parts.trigger, 'POST /orders/{id}/cancel', 'the Story\'s words rank its flow first');
  assert.match(flows[0].text, /^POST \/orders\/\{id\}\/cancel → OrderController\.cancel → OrderService\.cancel; refuses 1 way \(HTTP 409\); 1 rule on the way; writes the database; returns Order$/u);
  const place = flows.find((record) => record.parts.trigger === 'POST /orders');
  assert.match(place.text, /OrderController\.place → OrderService\.place \(and 1 helper: totalOf\); refuses 3 ways \(HTTP 400\)/u);
  assert.doesNotMatch(place.text, /responds with|writes logs/u, 'every endpoint responds; that says nothing about this one');
  assert.match(renderFlowRecords(flows), /^## Flows\n\n- POST \/orders\/\{id\}\/cancel/u);
});

test('risks: history is a file fact, ownership ignores address case, and function risk says why', async (t) => {
  const repository = await ordersWithHistory(t);
  const { knowledge } = await buildKnowledge(repository);
  const hotspot = knowledge.items.find((item) => item.kind === 'hotspot' && item.subject.path === SERVICE);
  assert.deepEqual([hotspot.statement.fixes, hotspot.statement.authors, hotspot.statement.topAuthorShare], [2, 2, 0.8]);
  const risks = buildRiskRecords(knowledge);
  const file = risks.find((record) => record.scope === 'file' && record.parts.path === SERVICE);
  assert.equal(file.text, `${SERVICE}: changed 5 times in 12 months, 2 fix commits; mostly changed by one person`);
  const cancel = risks.find((record) => record.parts.symbol === 'OrderService.cancel');
  assert.equal(cancel.text, 'OrderService.cancel: reached by 1 entry point, no test reaches it');
  assert.doesNotMatch(cancel.text, /changed \d+ times/u, 'its file\'s record already says how often it changes');
  const risk = knowledge.items.find((item) => item.kind === 'risk' && item.subject.symbol === 'OrderService.place');
  assert.deepEqual([risk.statement.rules, risk.statement.tested, risk.statement.fixes], [5, true, 2]);
});

test('impact: a Story\'s changed lines name the functions they fall in; a planned file is read whole', async (t) => {
  const repository = await ordersWithHistory(t);
  const base = git(repository, 'rev-parse', 'HEAD');
  await changeCancel(repository);
  const { knowledge } = await buildKnowledge(repository);
  const { changedPaths, changedRanges } = await readChange(repository, base);
  assert.deepEqual(changedPaths, [SERVICE]);
  const impact = buildImpactRecords(knowledge, { changedPaths, changedRanges, plannedPaths: [ORDER, 'docs/not-code.md'] });
  assert.deepEqual(impact.map((record) => record.text), [
    'OrderService.cancel (changed): called by OrderController.cancel; on POST /orders/{id}/cancel; 1 rule; no test reaches it',
    `${ORDER} (planned): declares Order, used by POST /orders, POST /orders/{id}/cancel; imported by 2 files`
  ]);
  assert.deepEqual(impactSymbols(impact), ['OrderService.cancel']);
  // Without changed lines (no base), the changed file is read whole.
  const whole = buildImpactRecords(knowledge, { changedPaths, changedRanges: (await readChange(repository, null, { paths: changedPaths })).changedRanges });
  assert.equal(whole.length, 1);
  assert.equal(whole[0].text, `${SERVICE} (changed): on POST /orders, POST /orders/{id}/cancel; imported by 1 file; 7 rules; tested by OrderServiceTest.java`);
  // Risks mark only the functions the change falls in as changed; the rest of the file ranks next.
  const risks = buildRiskRecords(knowledge, { changedPaths, changedSymbols: impactSymbols(impact) });
  assert.deepEqual(risks.filter((record) => record.change === 2).map((record) => record.parts.symbol ?? record.parts.path), [SERVICE, 'OrderService.cancel']);
  assert.equal(risks.find((record) => record.parts.symbol === 'OrderService.place').change, 1);
});

test('impact: a large non-code change beside the code change does not hide the changed lines', async (t) => {
  const repository = await ordersWithHistory(t);
  const notes = path.join(repository, 'notes.txt');
  await writeFile(notes, `${'a line of notes\n'.repeat(16000)}`);
  git(repository, 'add', '-A');
  git(repository, '-c', 'user.name=Ana', '-c', 'user.email=ana@example.com', 'commit', '-qm', 'Notes');
  const base = git(repository, 'rev-parse', 'HEAD');
  await writeFile(notes, `${'another line\n'.repeat(16000)}`);
  await changeCancel(repository);
  const { knowledge } = await buildKnowledge(repository);
  const everything = await readChange(repository, base);
  assert.deepEqual(everything.changedPaths, ['notes.txt', SERVICE]);
  assert.equal(everything.changedRanges.size, 0, 'the whole patch is over the preview limit');
  const known = knowledgePaths(knowledge);
  const code = await readChange(repository, base, { keep: (file) => known.has(file) });
  assert.deepEqual(impactSymbols(buildImpactRecords(knowledge, code)), ['OrderService.cancel']);
});

test('the phase brief reads the Story\'s change and plan; wm knowledge show change and journeys show the records', async (t) => {
  const repository = await ordersWithHistory(t);
  const base = git(repository, 'rev-parse', 'HEAD');
  await changeCancel(repository);
  const brief = await repositoryBriefPrompt(repository, {
    definition: {}, phase: 'implementation', changedPaths: [SERVICE], plannedPaths: [ORDER],
    workflow: { workItem: { title: 'Cancel message wording', baseCommit: base } }
  });
  assert.match(brief.text, /## What a change touches\n- OrderService\.cancel \(changed\): called by OrderController\.cancel; on POST \/orders\/\{id\}\/cancel; 1 rule; no test reaches it \(OrderService\.java:41\)\n- src\/main\/java\/com\/acme\/orders\/model\/Order\.java \(planned\): declares Order/u);
  // Both are changed; the Story's words rank the function first.
  assert.match(brief.text, /## Risks\n- \(changed by this Story\) OrderService\.cancel: reached by 1 entry point, no test reaches it \(OrderService\.java:41\)\n- \(changed by this Story\) src\/main\/java\/com\/acme\/orders\/service\/OrderService\.java: changed 5 times in 12 months, 2 fix commits; mostly changed by one person\n/u);
  assert.ok(Buffer.byteLength(brief.text) <= brief.budget, 'the brief keeps to the phase budget');
  const design = await repositoryBriefPrompt(repository, { definition: {}, phase: 'design', workflow: { workItem: { title: 'Cancel message wording' } } });
  assert.match(design.text, /## Flows\n- POST \/orders\/\{id\}\/cancel → OrderController\.cancel → OrderService\.cancel/u);

  const previous = process.cwd();
  const change = await quiet(() => knowledgeCommand(repository, ['show', 'change'], { json: true }));
  const shown = JSON.parse(change);
  assert.match(shown.markdown, /## What this change touches\n\n- OrderService\.cancel \(changed\)/u);
  assert.match(shown.markdown, /## Risky places\n\n- \(changed\) src\/main\/java\/com\/acme\/orders\/service\/OrderService\.java/u);
  assert.ok(shown.records.some((record) => record.kind === 'impact') && shown.records.some((record) => record.kind === 'risk'));
  const committed = JSON.parse(await quiet(() => knowledgeCommand(repository, ['show', 'change'], { json: true, base: git(repository, 'rev-parse', 'HEAD~1') })));
  assert.match(committed.markdown, /OrderService\.cancel \(changed\)/u, '--base reads committed changes too');
  const journeys = await quiet(() => knowledgeCommand(repository, ['show', 'journeys'], {}));
  assert.match(journeys, /## Flows\n\n- POST \/orders/u);
  assert.equal(process.cwd(), previous);
  assert.equal(git(repository, 'status', '--porcelain'), `M ${SERVICE}`, 'reading the change writes nothing');
});

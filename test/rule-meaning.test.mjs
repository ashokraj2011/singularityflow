/**
 * What business rules mean (World Model v5, M4): `wm rules propose` drafts a condition, an outcome and
 * an intent (a model's draft is checked against the rule's own evidence), the draft stays advisory on
 * this machine, `wm rules confirm` is a person's act bound to the cited lines, and the meaning goes out
 * of date when they change.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { meaningText, draftMeaning, meaningCurrent, meaningPrompt, RULE_MEANINGS_PATH, validateMeanings, writeProposals } from '../src/knowledge/rule-meaning.mjs';
import { repositoryBriefPrompt } from '../src/knowledge/prompt.mjs';
import { rulesCommand } from '../src/knowledge/rules-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function ordersRepository(t) {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-rules-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', 'orders-spring'), repository, { recursive: true });
  await writeFile(path.join(repository, 'README.md'), '# Orders\n\n## Business rules\n\n- An order needs at least one line.\n- Discount codes must be ten characters long.\n');
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'config', 'user.name', 'Rule Reviewer');
  git(repository, 'config', 'user.email', 'rules@example.invalid');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'Fixture');
  return repository;
}

/** Run the command quietly and return what it returned. */
async function quietly(run) {
  const log = console.log;
  console.log = () => {};
  try { return await run(); } finally { console.log = log; }
}

const record = {
  id: 'R-000000000001', origin: 'code', status: 'agreed', text: 'OrderService.place: when `order.getLines().isEmpty()` → refuses "An order needs at least one line" (HTTP 400)',
  parts: { condition: ['order.getLines().isEmpty()'], outcome: { kind: 'refuses', text: 'An order needs at least one line' }, status: 400 },
  quotes: ['An order needs at least one line.'], conflict: null,
  sources: { code: [{ path: 'src/OrderService.java', line: 2 }], docs: [] },
  anchors: [{ path: 'src/OrderService.java', line: 2, sha256: 'sha256:aa' }, { path: 'README.md', line: 5, sha256: 'bb' }]
};

test('a draft meaning is the rule\'s own condition and outcome, and a model\'s is kept only when its rule contains what it names', () => {
  assert.deepEqual(draftMeaning(record), {
    condition: '`order.getLines().isEmpty()`', outcome: 'refuses "An order needs at least one line" (HTTP 400)', intent: null
  });
  assert.deepEqual(draftMeaning({ origin: 'validation', text: 'EvaluateRequest.rule: required (HTTP 400 when invalid)', parts: { type: 'EvaluateRequest', field: 'rule', constraints: [{ kind: 'required' }] } }),
    { condition: '`EvaluateRequest.rule` is missing', outcome: 'the request is refused (HTTP 400)', intent: null });
  const files = new Map([['src/OrderService.java', { lines: ['class OrderService {', '  if (order.getLines().isEmpty()) throw new IllegalArgumentException("An order needs at least one line");', '}'] }]]);
  const prompt = meaningPrompt([record], files);
  assert.deepEqual(prompt.records, ['R-000000000001']);
  assert.match(prompt.text, /^## R-000000000001 \(agreed\)\n.*\ndocs: An order needs at least one line\.\ncode at src\/OrderService\.java:2:\n```\n {2}if \(order\.getLines\(\)\.isEmpty\(\)\)/mu);
  const checked = validateMeanings(JSON.stringify({ rules: [
    { rule: 'R-000000000001', condition: 'an order has no lines', outcome: 'it is refused with "An order needs at least one line" (HTTP 400)', intent: 'every order has something to ship' },
    { rule: 'R-000000000001', condition: 'again', outcome: 'again' },
    { rule: 'R-000000000002', condition: 'an order has no lines', outcome: 'it is refused' },
    { rule: 'R-000000000003', condition: 'x', outcome: 'y' }
  ] }), prompt.evidence);
  assert.deepEqual(checked.accepted.map((entry) => entry.intent), ['every order has something to ship']);
  assert.deepEqual(checked.rejected.map((entry) => entry.reason), ['states a rule twice', 'names a rule that was not sent', 'names a rule that was not sent']);
  for (const [meaning, reason] of [
    [{ condition: 'an order has more than 50 lines', outcome: 'it is refused' }, 'names what its rule does not contain: 50'],
    [{ condition: 'an order has no lines', outcome: 'Billing refuses it' }, 'names what its rule does not contain: Billing'],
    [{ condition: 'an order has no lines', outcome: 'it is refused', intent: 'keeps the API secure' }, 'judges instead of describing'],
    [{ condition: 'an order has no lines', outcome: '' }, 'has no condition or no outcome']
  ]) {
    assert.deepEqual(validateMeanings({ rules: [{ rule: 'R-000000000001', ...meaning }] }, prompt.evidence).rejected.map((entry) => entry.reason), [reason]);
  }
  assert.equal(meaningCurrent(record, [{ path: 'src/OrderService.java', sha256: 'sha256:aa' }]), true);
  assert.equal(meaningCurrent(record, [{ path: 'src/OrderService.java', sha256: 'sha256:cc' }]), false, 'a changed line puts the meaning out of date');
  assert.equal(meaningCurrent(record, []), false);
});

test('a person confirms a rule\'s meaning, briefs use it while its lines are unchanged, and it goes out of date when they change', async (t) => {
  const repository = await ordersRepository(t);
  const listed = await quietly(() => rulesCommand(repository, ['list'], {}));
  const rule = listed.rules.find((entry) => /An order needs at least one line/u.test(entry.text) && entry.origin === 'code');
  assert.equal(rule.status, 'agreed');
  assert.equal(rule.meaning, undefined);
  const proposed = await quietly(() => rulesCommand(repository, ['propose'], { json: true }));
  assert.equal(proposed.mode, 'template', 'without a model each draft is the rule\'s own condition and outcome');
  assert.equal(proposed.advisory, true);
  assert.ok(proposed.proposals.some((entry) => entry.rule === rule.id && entry.by === 'template'));
  assert.equal(git(repository, 'status', '--porcelain'), '', 'a proposal is not written to the repository');
  const docsOnly = listed.rules.find((entry) => entry.origin === 'docs');
  await assert.rejects(() => quietly(() => rulesCommand(repository, ['confirm', docsOnly.id], {})), { code: 'KNOWLEDGE_RULE_MEANING_REQUIRED' });
  await assert.rejects(() => quietly(() => rulesCommand(repository, ['confirm', 'R-ffffffffffff'], {})), { code: 'KNOWLEDGE_RULE_UNKNOWN' });

  const confirmed = await quietly(() => rulesCommand(repository, ['confirm', rule.id], {
    condition: 'an order has no lines', outcome: 'it is refused with "An order needs at least one line"', intent: 'every order has something to ship'
  }));
  assert.equal(confirmed.file, RULE_MEANINGS_PATH);
  assert.deepEqual(confirmed.entry.anchors.map((anchor) => anchor.path).sort(), ['README.md', 'src/main/java/com/acme/orders/service/OrderService.java',
    'src/main/java/com/acme/orders/web/GlobalExceptionHandler.java'], 'the refusal, its HTTP status mapping and the docs statement');
  assert.equal(confirmed.entry.by, 'rules@example.invalid');
  assert.equal(confirmed.entry.proposedBy, 'person');
  assert.match(await readFile(path.join(repository, RULE_MEANINGS_PATH), 'utf8'), /Commit this file with the code it describes/u);
  const meant = (await quietly(() => rulesCommand(repository, ['list'], {}))).rules.find((entry) => entry.id === rule.id);
  assert.equal(meant.meaning.current, true);
  const options = { definition: null, phase: 'implementation', workflow: { workItem: { title: 'Orders need at least one line' } }, polish: 'off' };
  const brief = await repositoryBriefPrompt(repository, options);
  assert.match(brief.text, /^- When an order has no lines: it is refused with "An order needs at least one line" \(every order has something to ship\)\. Meaning confirmed by a person\. Documented, enforced, tested\./mu);

  // The cited line changes: the meaning no longer describes it.
  const file = path.join(repository, confirmed.entry.anchors.find((anchor) => anchor.path.endsWith('.java')).path);
  await writeFile(file, (await readFile(file, 'utf8')).replace('An order needs at least one line', 'An order needs one line or more'));
  git(repository, 'commit', '-qam', 'Reword the empty-order refusal');
  const changed = (await quietly(() => rulesCommand(repository, ['list'], {}))).rules.find((entry) => entry.id === rule.id);
  assert.equal(changed?.meaning?.current, false, 'the meaning is out of date');
  const after = await repositoryBriefPrompt(repository, options);
  assert.doesNotMatch(after.text, /Meaning confirmed/u, 'a brief goes back to the code\'s own wording');
});

// A Copilot CLI stand-in over ACP stdio: it drafts one grounded meaning and one that adds a name.
const FAKE_COPILOT = `#!/usr/bin/env node
import readline from 'node:readline';
if (process.argv.includes('--help')) { console.log('Usage: copilot --acp'); process.exit(0); }
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'rules', configOptions: [] } });
  else if (message.method === 'session/prompt') {
    const prompt = message.params.prompt[0].text;
    const empty = prompt.match(/^## (R-[0-9a-f]{12}) \\(agreed\\)\\nOrderService\\.place: when \`order\\.getLines\\(\\)\\.isEmpty\\(\\)\`/mu)[1];
    const cancel = prompt.match(/^## (R-[0-9a-f]{12}) [^\\n]*\\nOrderService\\.cancel/mu)[1];
    const text = JSON.stringify({ rules: [
      { rule: empty, condition: 'an order has no lines', outcome: 'it is refused with "An order needs at least one line"', intent: 'every order has something to ship' },
      { rule: cancel, condition: 'the order is not placed', outcome: 'Stripe refunds it' }
    ] });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'rules', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text } } } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  }
}
`;

test('with a model, wm rules propose keeps the drafts grounded in their rule and leaves the rest to a person', async (t) => {
  const repository = await ordersRepository(t);
  const bin = await mkdtemp(path.join(os.tmpdir(), 'sflow-rules-bin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(bin, 'copilot'), FAKE_COPILOT, { mode: 0o755 });
  await symlink(process.execPath, path.join(bin, 'node'));
  await symlink(await realpath(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()), path.join(bin, 'git'));
  const PATH = `${bin}:/usr/bin:/bin`;
  assert.equal(spawnSync('sh', ['-c', 'command -v copilot'], { encoding: 'utf8', env: { PATH } }).stdout.trim(), path.join(bin, 'copilot'));
  const env = { ...process.env, PATH };
  delete env.SINGULARITY_FLOW_NO_MODEL;
  const run = spawnSync(process.execPath, [path.join(root, 'bin', 'singularity-flow.mjs'), 'wm', 'rules', 'propose', '--json'], { cwd: repository, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.mode, 'model', result.reason);
  const byModel = result.proposals.filter((entry) => entry.by === 'model');
  assert.deepEqual(byModel.map((entry) => entry.intent), ['every order has something to ship']);
  assert.deepEqual(result.rejected.map((entry) => entry.reason), ['names what its rule does not contain: Stripe']);
  assert.ok(result.proposals.some((entry) => entry.by === 'template' && /OrderService\.cancel/u.test(entry.text)), 'a rule the model could not state keeps its own draft');
  assert.equal(git(repository, 'status', '--porcelain'), '', 'proposing writes nothing to the repository');
  const off = spawnSync(process.execPath, [path.join(root, 'bin', 'singularity-flow.mjs'), '--no-model', 'wm', 'rules', 'list', '--json'], { cwd: repository, env, encoding: 'utf8' });
  const listed = JSON.parse(off.stdout).rules.find((entry) => entry.id === byModel[0].rule);
  assert.equal(listed.proposal.by, 'model', 'the model draft stays as a proposal until a person confirms it');
  assert.equal(listed.meaning, undefined);
});

test('a meaning that names an HTTP status goes out of date when the handler maps the exception to another one', async () => {
  const { buildRuleRecords } = await import('../src/knowledge/records/rules.mjs');
  const knowledge = (status) => ({ items: [
    { id: 'K-1', kind: 'rule', subject: { symbol: 'OrderService.place', path: 'src/OrderService.java' }, citations: [{ path: 'src/OrderService.java', lines: [23, 23], spanSha256: 'sha256:a' }],
      statement: { kind: 'refusal', when: ['order.getLines().isEmpty()'], then: { kind: 'refuses', text: 'An order needs at least one line' }, values: { constants: [] } }, relations: [] },
    { id: 'K-e1', kind: 'error-path', subject: { symbol: 'OrderService.place', path: 'src/OrderService.java' }, citations: [{ path: 'src/OrderService.java', lines: [24, 24], spanSha256: 'sha256:b' }],
      statement: { exception: 'IllegalArgumentException', message: 'An order needs at least one line', status, handler: 'src/web/GlobalExceptionHandler.java' } }
  ] });
  const [before] = buildRuleRecords(knowledge('BAD_REQUEST'), null);
  assert.match(before.text, /\(HTTP 400\)$/u);
  assert.deepEqual(draftMeaning(before).outcome, 'refuses "An order needs at least one line" (HTTP 400)');
  const [after] = buildRuleRecords(knowledge('UNPROCESSABLE_ENTITY'), null);
  assert.equal(after.id, before.id, 'the same rule');
  assert.equal(meaningCurrent(after, before.anchors), false, 'the status it was confirmed with changed');
  assert.equal(meaningCurrent(buildRuleRecords(knowledge('BAD_REQUEST'), null)[0], before.anchors), true);
});

test('a meaning whose rule is gone is listed as out of date, a line added above keeps a docs rule, and a bad entry is ignored with a warning', async (t) => {
  const repository = await ordersRepository(t);
  const listed = await quietly(() => rulesCommand(repository, ['list'], {}));
  const docsRule = listed.rules.find((entry) => entry.origin === 'docs' && /Discount codes/u.test(entry.text));
  await quietly(() => rulesCommand(repository, ['confirm', docsRule.id], { condition: 'a discount code is entered', outcome: 'it must be ten characters long' }));
  // A line added above the statement moves it, and the rule keeps its ID and its meaning.
  const readme = path.join(repository, 'README.md');
  await writeFile(readme, (await readFile(readme, 'utf8')).replace('## Business rules\n', '## Business rules\n\nRules for every order.\n'));
  git(repository, 'commit', '-qam', 'Introduce the rules');
  const moved = (await quietly(() => rulesCommand(repository, ['list'], { json: true }))).rules.find((entry) => entry.id === docsRule.id);
  assert.equal(moved?.meaning?.current, true, 'moving a statement down a line keeps its confirmed meaning');
  // The statement is reworded: no rule has that ID any more, and the meaning is listed as out of date.
  await writeFile(readme, (await readFile(readme, 'utf8')).replace('Discount codes must be ten characters long.', 'Discount codes must be twelve characters long.'));
  git(repository, 'commit', '-qam', 'Longer codes');
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  let after;
  try { after = await rulesCommand(repository, ['list'], {}); } finally { console.log = log; }
  assert.deepEqual(after.orphaned.map((entry) => entry.rule), [docsRule.id]);
  assert.match(lines.join('\n'), new RegExp(`${docsRule.id}.*no rule has this ID any more.*docs/knowledge/rule-meanings\\.yml`, 'su'));

  // A hand-edited entry of the wrong shape, for a rule whose lines are unchanged, is ignored with a
  // warning; it never breaks a brief.
  const file = path.join(repository, RULE_MEANINGS_PATH);
  const coded = after.rules.find((entry) => entry.origin === 'code' && /An order needs at least one line/u.test(entry.text));
  const anchors = coded.anchors.map((anchor) => `      - path: ${anchor.path}\n        sha256: "${anchor.sha256}"\n`).join('');
  await writeFile(file, `${await readFile(file, 'utf8')}  - rule: ${coded.id}\n    condition: an order has no lines\n    outcome: it is refused\n    intent: 42\n    anchors:\n${anchors}`);
  const brief = await repositoryBriefPrompt(repository, { definition: null, phase: 'intake', workflow: { workItem: { title: 'Discount codes' } }, polish: 'off' });
  assert.match(brief.warnings.join('\n'), /rule-meanings\.yml: 1 entry is not a confirmed meaning and was ignored/u);
  const kept = await quietly(() => rulesCommand(repository, ['list'], { json: true }));
  assert.equal(kept.orphaned.length, 1, 'the ignored entry is not listed as a meaning');
});

test('a person who types only some fields is recorded for those, and the draft\'s model for the rest', async (t) => {
  const repository = await ordersRepository(t);
  const listed = await quietly(() => rulesCommand(repository, ['list'], {}));
  const rule = listed.rules.find((entry) => /An order needs at least one line/u.test(entry.text) && entry.origin === 'code');
  await writeProposals(repository, { [rule.id]: { condition: 'an order has no lines', outcome: 'it is refused with "An order needs at least one line"', intent: null,
    by: 'model', model: 'recorded-model', anchors: rule.anchors, createdAt: '2026-10-24T00:00:00.000Z' } });
  const partly = await quietly(() => rulesCommand(repository, ['confirm', rule.id], { intent: 'every order has something to ship' }));
  assert.deepEqual([partly.entry.proposedBy, partly.entry.model, partly.entry.typedByPerson], ['model', 'recorded-model', ['intent']]);
  assert.equal(partly.entry.condition, 'an order has no lines');
  const wholly = await quietly(() => rulesCommand(repository, ['confirm', rule.id], { condition: 'no lines', outcome: 'refused', intent: 'something to ship' }));
  assert.deepEqual([wholly.entry.proposedBy, wholly.entry.model ?? null, wholly.entry.typedByPerson ?? null], ['person', null, null]);
});

test('a drafted condition that ends with a full stop reads as one sentence', () => {
  assert.equal(meaningText({ condition: 'When `order.getStatus() != OrderStatus.PLACED`.', outcome: 'Refuses with "Only placed orders can be cancelled" (HTTP 409).' }),
    'When `order.getStatus() != OrderStatus.PLACED`: Refuses with "Only placed orders can be cancelled" (HTTP 409)');
});

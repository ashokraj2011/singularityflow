import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ownTerminalStep } from '../src/command-skills.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

// SPEC-SPA v1.3 S1: the specification library, model-free. Every command runs as a child CLI with
// models disabled, so a model call anywhere in the flow fails the test (SPA:AC-025).

const engine = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(engine, 'bin', 'singularity-flow.mjs');
const SPEC = 'SPEC-CHK-004';

const PRICING = `// Cart pricing. All amounts are integers in paise (INR minor units).

export const DISCOUNT_RATE = 0.10;
export const DISCOUNT_THRESHOLD = 500000; // INR 5000.00

export function subtotal(lines) {
  return lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
}

/** The order discount in paise for a cart. */
export function orderDiscount(cart) {
  const total = subtotal(cart.lines);
  if (cart.currency !== 'INR') return 0;
  if (total >= DISCOUNT_THRESHOLD) return Math.round(total * DISCOUNT_RATE);
  return 0;
}

export function orderSummary(cart) {
  const total = subtotal(cart.lines);
  const discount = orderDiscount(cart);
  return { subtotal: total, discount, payable: total - discount };
}
`;

const PRICING_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { orderDiscount } from '../src/pricing.mjs';

const cart = (amount) => ({ currency: 'INR', lines: [{ unitPrice: amount, quantity: 1 }] });

test('ten percent discount from INR 5000.00', () => {
  assert.equal(orderDiscount(cart(500000)), 50000);
});
`;

/** A finished specification: every section, two clauses, GAP-001 stated, no placeholder. */
function finishedSpec(decisions = '- GAP-001: only totals strictly above INR 5000.00 qualify.') {
  return `# Order discount threshold

## Outcome

The 10 percent order discount applies only to orders strictly above INR 5000.00.

## Actors

- Shopper: places INR orders.

## User scenarios

1. A shopper with an INR 6000.00 cart sees a 10 percent discount.

## Scope

In scope: the order discount rule. Out of scope: tax and shipping.

## Requirements

WHEN an INR order total is strictly greater than INR 5000.00, the cart SHALL apply a 10 percent order discount. [${SPEC}:REQ-001]

## Acceptance

An INR 5000.01 cart gets INR 500.00 off, and an INR 5000.00 cart gets nothing. [${SPEC}:AC-001]

## Decisions and open questions

${decisions}
`;
}

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

function sf(cwd, args, { env = {}, fail = false } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd, encoding: 'utf8', timeout: childTimeout(120_000), maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1', ...env }
  });
  if (fail) assert.notEqual(result.status, 0, `${args.join(' ')} was expected to be refused:\n${result.stdout}`);
  else assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const json = (cwd, args, options) => JSON.parse(sf(cwd, [...args, '--json'], options).stdout);
const refused = (cwd, args, options = {}) => JSON.parse(sf(cwd, [...args, '--json'], { ...options, fail: true }).stdout).error;

function assertCrash(child, message) {
  assert.equal(child.error, undefined, child.error?.message);
  if (process.platform === 'win32') {
    assert.equal(child.status, 1, message);
    assert.equal(child.signal, null, 'Windows TerminateProcess does not return a POSIX signal');
  } else assert.equal(child.signal, 'SIGKILL', message);
}

async function repository(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-library-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const remote = path.join(directory, 'remote.git');
  const root = path.join(directory, 'app');
  git(directory, 'init', '-q', '--bare', '-b', 'main', remote);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{ "name": "storefront", "type": "module" }\n');
  await writeFile(path.join(root, 'src', 'pricing.mjs'), PRICING);
  await writeFile(path.join(root, 'test', 'pricing.test.mjs'), PRICING_TEST);
  git(directory, 'init', '-q', '-b', 'main', root);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Storefront');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  return { directory, root, remote };
}

async function clone(directory, remote, name) {
  const root = path.join(directory, name);
  git(directory, 'clone', '-q', remote, root);
  return root;
}

/** Draft, research, a decided code-disagrees gap and settled checklist: ready to publish as reviewed. */
async function readySpec(root, directory) {
  sf(root, ['spec', 'author', 'new', SPEC, '--title', 'Order discount threshold', '--area', 'src/pricing.mjs']);
  const file = path.join(directory, `spec-${path.basename(root)}.md`);
  await writeFile(file, finishedSpec());
  sf(root, ['spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', '1']);
  return file;
}

test('a new draft from the template has literal unique clauses; escaped anchors and an empty file are reported (SPA:AC-001)', async (t) => {
  const { root, directory } = await repository(t);
  json(root, ['spec', 'author', 'new', SPEC, '--title', 'Order discount threshold']);
  const { report } = json(root, ['spec', 'author', 'check', SPEC]);
  assert.deepEqual(report.analyzer.clauseIds, [`${SPEC}:REQ-001`, `${SPEC}:AC-001`]);
  assert.ok(report.blocking.some((finding) => finding.code === 'spec.placeholder'), 'the template\'s TODOs block a reviewed publication');

  const escaped = path.join(directory, 'escaped.md');
  await writeFile(escaped, finishedSpec().replaceAll(`[${SPEC}:`, `\\[${SPEC}:`));
  json(root, ['spec', 'author', 'edit', SPEC, '--file', escaped, '--expected-seq', '1']);
  assert.ok(json(root, ['spec', 'author', 'check', SPEC]).report.blocking.some((finding) => finding.code === 'spec.anchor-escaped'));

  const empty = path.join(directory, 'empty.md');
  await writeFile(empty, '# Nothing yet\n');
  json(root, ['spec', 'author', 'edit', SPEC, '--file', empty, '--expected-seq', '2']);
  const codes = json(root, ['spec', 'author', 'check', SPEC]).report.blocking.map((finding) => finding.code);
  assert.ok(codes.includes('spec.no-clauses'), codes.join(', '));
  assert.ok(codes.includes('spec.section-missing'), codes.join(', '));
});

test('the template gives no example decision; a draft still carrying the old one is blocked, and it does not state GAP-001 (S4 live run)', async (t) => {
  const { root, directory } = await repository(t);
  json(root, ['spec', 'author', 'new', SPEC, '--title', 'Order discount threshold']);
  const { spec } = json(root, ['spec', 'author', 'status', SPEC]);
  const decisions = spec.slice(spec.indexOf('## Decisions and open questions'));
  assert.doesNotMatch(spec, /GAP-\d{3}|INR/u, 'nothing in the template reads as a decision');
  assert.match(decisions, /TODO/u, 'the section is a placeholder the person replaces');
  const fresh = json(root, ['spec', 'author', 'check', SPEC]).report.blocking;
  assert.ok(fresh.some((finding) => finding.code === 'spec.placeholder' && finding.message.includes(String(spec.split('\n').findIndex((line) => line.includes('TODO: state each')) + 1))));
  assert.ok(!fresh.some((finding) => finding.code === 'spec.template-example'));

  // A draft started from the old template keeps its example, which named GAP-001.
  json(root, ['spec', 'author', 'gap', SPEC, '--kind', 'open-question', '--question', 'Strictly above?']);
  json(root, ['spec', 'author', 'decide', SPEC, 'GAP-001', '--choice', 'Strictly above INR 5000.00.', '--reason', 'Agreed.']);
  const old = path.join(directory, 'old-template.md');
  await writeFile(old, finishedSpec('Every decided or deferred gap is stated here by its ID, for example "GAP-001: exactly INR 5000.00 gets no discount."'));
  json(root, ['spec', 'author', 'edit', SPEC, '--file', old, '--expected-seq', String(json(root, ['spec', 'author', 'status', SPEC]).sequence)]);
  const blocking = json(root, ['spec', 'author', 'check', SPEC]).report.blocking;
  assert.ok(blocking.some((finding) => finding.code === 'spec.template-example'), blocking.map((finding) => finding.code).join(', '));
  assert.ok(blocking.some((finding) => finding.code === 'spec.decision-unstated' && finding.gap === 'GAP-001'), 'the example does not state GAP-001');
  assert.equal(refused(root, ['spec', 'author', 'publish', SPEC, '--reviewed']).code, 'SPEC_LIBRARY_REVIEW_INCOMPLETE');

  const stated = path.join(directory, 'stated.md');
  await writeFile(stated, finishedSpec());
  json(root, ['spec', 'author', 'edit', SPEC, '--file', stated, '--expected-seq', String(json(root, ['spec', 'author', 'status', SPEC]).sequence)]);
  const after = json(root, ['spec', 'author', 'check', SPEC]).report.blocking.map((finding) => finding.code);
  assert.ok(!after.includes('spec.template-example') && !after.includes('spec.decision-unstated'), after.join(', '));
});

test('a save is whole or absent after a crash, a retried save is the same snapshot, a stale save is refused (SPA:AC-002)', async (t) => {
  const { root, directory } = await repository(t);
  json(root, ['spec', 'author', 'new', SPEC, '--title', 'Order discount threshold']);
  const file = path.join(directory, 'spec.md');
  await writeFile(file, finishedSpec());

  const crashed = spawnSync(process.execPath, [bin, 'spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', '1'], {
    cwd: root, encoding: 'utf8', timeout: childTimeout(60_000),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_CRASH_AT: 'spec-draft-publish' }
  });
  assertCrash(crashed, 'the save died between its temporary file and its link');
  const store = path.join(root, '.git', 'singularity-flow', 'spec-drafts', SPEC);
  const temporary = (await readdir(store)).filter((name) => name.endsWith('.tmp'));
  assert.equal(temporary.length, 1, 'abrupt termination leaves the synced, unpublished file');
  const pending = JSON.parse(await readFile(path.join(store, temporary[0]), 'utf8'));
  assert.equal(pending.sequence, 2);
  assert.equal(pending.draft.spec, finishedSpec(), 'the process reached the requested crash boundary');
  assert.deepEqual((await readdir(store)).filter((name) => !name.startsWith('.')), ['000001.json'], 'only the complete first snapshot is visible');
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).sequence, 1);

  const saved = json(root, ['spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', '1', '--operation-id', 'edit-1']);
  assert.equal(saved.sequence, 2);
  assert.deepEqual(await readdir(store), ['000001.json', '000002.json'], 'the next save swept the orphaned temporary file');
  const again = json(root, ['spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', '1', '--operation-id', 'edit-1']);
  assert.deepEqual([again.sequence, again.replayed], [2, true], 'the same operation returns the snapshot it saved');

  await writeFile(file, finishedSpec('- GAP-001: changed.'));
  assert.equal(refused(root, ['spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', '2', '--operation-id', 'edit-1']).code, 'SPEC_DRAFT_OPERATION_REUSED');
  assert.equal(refused(root, ['spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', '1']).code, 'SPEC_DRAFT_STALE');
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).sequence, 2, 'neither refusal saved anything');
});

test('research cites code that verifies; a changed span is stale and blocks a reviewed publication; option impact needs no model (SPA:AC-003, AC-004, AC-005)', async (t) => {
  const { root, directory } = await repository(t);
  await readySpec(root, directory);
  const { items } = json(root, ['spec', 'author', 'research', SPEC]);
  const rule = items.find((item) => item.kind === 'rule' && /total >= DISCOUNT_THRESHOLD/u.test(item.summary));
  assert.ok(rule, items.map((item) => item.summary).join('\n'));
  assert.match(rule.citation.spanSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(items.some((item) => item.kind === 'test-case'), 'the test that exercises the rule is a research item too');

  const options = path.join(directory, 'options.json');
  await writeFile(options, JSON.stringify([
    { wording: 'WHEN an order total is greater than INR 5000.00, the cart SHALL apply a 10 percent discount.', changesCode: true },
    { wording: 'WHEN an order total is INR 5000.00 or more, the cart SHALL apply a 10 percent discount.', changesCode: false }]));
  json(root, ['spec', 'author', 'gap', SPEC, '--kind', 'code-disagrees', '--question', 'Strictly above, or at and above?', '--research', rule.id, '--options', options]);
  const [gap] = json(root, ['spec', 'author', 'gaps', SPEC, 'GAP-001']).gaps;
  const [changes, keeps] = gap.impact.options;
  const text = changes.records.map((record) => record.text).join('\n');
  assert.match(text, /orderDiscount/u);
  assert.match(text, /called by orderSummary/u);
  assert.match(text, /pricing\.test\.mjs/u);
  assert.deepEqual(keeps.records, [], 'an option that keeps the code touches nothing');

  json(root, ['spec', 'author', 'decide', SPEC, 'GAP-001', '--option', 'O1', '--reason', 'Strictly above, as agreed.']);
  json(root, ['spec', 'author', 'settle', SPEC, '--all-articles', 'satisfied']);
  assert.equal(json(root, ['spec', 'author', 'check', SPEC]).report.reviewReady, true);

  await writeFile(path.join(root, 'src', 'pricing.mjs'), PRICING.replace('total >= DISCOUNT_THRESHOLD', 'total > DISCOUNT_THRESHOLD'));
  git(root, 'commit', '-qam', 'Strictly above');
  const report = json(root, ['spec', 'author', 'check', SPEC]).report;
  assert.ok(report.blocking.some((finding) => finding.code === 'spec.research-stale' && finding.item === rule.id));
  const blocked = refused(root, ['spec', 'author', 'publish', SPEC, '--reviewed']);
  assert.equal(blocked.code, 'SPEC_LIBRARY_REVIEW_INCOMPLETE');
  assert.match(blocked.message, new RegExp(`${rule.id} is stale`, 'u'));

  json(root, ['spec', 'author', 'research', SPEC]);
  assert.equal(json(root, ['spec', 'author', 'check', SPEC]).report.reviewReady, true, 'refreshing research brings the cited span up to date');
});

test('deciding, settling, publishing and discarding are the person\'s own steps; opening a gap is not (SPA:AC-006)', () => {
  for (const command of [`spec author decide ${SPEC} GAP-001 --option O1 --reason Agreed.`, `spec author settle ${SPEC} --all-articles satisfied`,
    `spec author publish ${SPEC} --reviewed`, `spec author discard ${SPEC}`]) {
    assert.equal(ownTerminalStep(`singularity-flow ${command}`), 'spec-library-decision', command);
  }
  for (const command of [`spec author gap ${SPEC} --kind open-question --question Why?`, `spec author new ${SPEC} --title T`, `spec author status ${SPEC}`]) {
    assert.equal(ownTerminalStep(`singularity-flow ${command}`), null, command);
  }
  const read = resolveOperation({ requestedCommand: 'spec', positionals: ['spec', 'author', 'status', SPEC], options: {} });
  const write = resolveOperation({ requestedCommand: 'spec', positionals: ['spec', 'author', 'publish', SPEC], options: { reviewed: true } });
  assert.deepEqual([read.id, read.classification, read.modelPolicy], ['spec.author.status', 'read', 'never']);
  assert.deepEqual([write.id, write.classification, write.modelPolicy], ['spec.author.publish', 'mutation', 'never']);
});

test('a decided gap must be stated; a reviewed publication names everything open; a draft revision can still be published (SPA:AC-007, AC-008)', async (t) => {
  const { root, directory } = await repository(t);
  await readySpec(root, directory);
  json(root, ['spec', 'author', 'gap', SPEC, '--kind', 'open-question', '--question', 'Does tax count toward the total?']);
  json(root, ['spec', 'author', 'gap', SPEC, '--kind', 'vague-term', '--question', 'What is "the total"?']);
  json(root, ['spec', 'author', 'decide', SPEC, 'GAP-002', '--choice', 'The line subtotal before tax and shipping.', '--reason', 'Finance.']);

  const report = json(root, ['spec', 'author', 'check', SPEC]).report;
  assert.ok(report.blocking.some((finding) => finding.code === 'spec.decision-unstated' && finding.gap === 'GAP-002'));
  const blocked = refused(root, ['spec', 'author', 'publish', SPEC, '--reviewed']);
  assert.equal(blocked.code, 'SPEC_LIBRARY_REVIEW_INCOMPLETE');
  for (const expected of ['GAP-001 is open', 'GAP-002 is decided but its outcome is not stated', "checklist article 'completeness' has no decision"]) {
    assert.ok(blocked.message.includes(expected), `${expected}\n${blocked.message}`);
  }

  const published = json(root, ['spec', 'author', 'publish', SPEC, '--draft']);
  assert.deepEqual([published.revision, published.reviewState], [1, 'draft']);
  assert.equal(refused(root, ['spec', 'author', 'show', SPEC]).code, 'SPEC_LIBRARY_NOT_REVIEWED', 'a draft revision is never taken for a reviewed one');
  assert.equal(json(root, ['spec', 'author', 'show', `${SPEC}@1`]).manifest.reviewState, 'draft');
  assert.equal(json(root, ['spec', 'author', 'publish', SPEC, '--draft']).unchanged, true, 'publishing the same draft again publishes nothing');
});

test('a revision is one commit holding only its directory; a fresh clone reads @1 unchanged after @2; a damaged file is never shown (SPA:AC-009)', async (t) => {
  const { root, directory, remote } = await repository(t);
  const file = await readySpec(root, directory);
  json(root, ['spec', 'author', 'settle', SPEC, '--all-articles', 'satisfied']);
  await writeFile(file, finishedSpec('Nothing is open.'));
  json(root, ['spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', '3']);
  const first = json(root, ['spec', 'author', 'publish', SPEC, '--reviewed']);
  assert.equal(first.revision, 1);
  const changed = git(root, 'show', '--name-only', '--format=', `${first.commit}`).split('\n').sort();
  assert.deepEqual(changed, ['gaps.json', 'manifest.json', 'quality.json', 'research.json', 'spec.md'].map((name) => `singularity/specifications/${SPEC}/000001/${name}`));
  const firstBytes = git(root, 'show', `${first.commit}:singularity/specifications/${SPEC}/000001/spec.md`);

  await writeFile(file, finishedSpec('Nothing is open. Revised wording.'));
  json(root, ['spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', String(json(root, ['spec', 'author', 'status', SPEC]).sequence)]);
  assert.equal(json(root, ['spec', 'author', 'publish', SPEC, '--reviewed']).revision, 2);

  const fresh = await clone(directory, remote, 'fresh');
  const shown = json(fresh, ['spec', 'author', 'show', `${SPEC}@1`]);
  assert.equal(shown.spec, `${firstBytes}\n`);
  assert.equal(json(fresh, ['spec', 'author', 'show', SPEC]).revision, 2, 'without @N the highest reviewed revision');
  const listed = json(fresh, ['spec', 'author', 'list']);
  assert.deepEqual(listed.specs.map((entry) => [entry.specId, entry.revisions]), [[SPEC, [1, 2]]]);

  // Someone rewrites a published file on the state branch: the revision is refused whole.
  const work = path.join(directory, 'tamper');
  git(directory, 'clone', '-q', '--branch', 'state', remote, work);
  await writeFile(path.join(work, 'singularity', 'specifications', SPEC, '000001', 'spec.md'), 'Rewritten.\n');
  git(work, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'Rewrite a revision');
  git(work, 'push', '-q', 'origin', 'state');
  assert.equal(refused(fresh, ['spec', 'author', 'show', `${SPEC}@1`]).code, 'SPEC_LIBRARY_REVISION_INVALID');
});

test('two clones: the same specification conflicts, different ones both land, a lost acknowledgement is not a second revision, an unreachable branch is not empty (SPA:AC-010)', async (t) => {
  const { root, directory, remote } = await repository(t);
  const other = await clone(directory, remote, 'other');
  for (const checkout of [root, other]) {
    await readySpec(checkout, directory);
    json(checkout, ['spec', 'author', 'settle', SPEC, '--all-articles', 'satisfied']);
  }
  assert.equal(json(root, ['spec', 'author', 'publish', SPEC, '--reviewed']).revision, 1);
  const conflict = refused(other, ['spec', 'author', 'publish', SPEC, '--reviewed']);
  assert.equal(conflict.code, 'SPEC_LIBRARY_REVISION_CONFLICT');
  assert.equal(json(other, ['spec', 'author', 'status', SPEC]).sequence, 3, 'the loser keeps its draft as it was');

  // A different specification published from the other clone lands on top of the first.
  json(other, ['spec', 'author', 'new', 'SPEC-UI-001', '--title', 'Continue button']);
  json(other, ['spec', 'author', 'publish', 'SPEC-UI-001', '--draft']);
  assert.deepEqual(json(root, ['spec', 'author', 'list']).specs.map((entry) => entry.specId), [SPEC, 'SPEC-UI-001']);

  // The process dies after the remote accepted revision 2 and before this clone recorded it.
  const file = path.join(directory, 'second.md');
  await writeFile(file, finishedSpec('Nothing is open. Second revision.'));
  json(root, ['spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', String(json(root, ['spec', 'author', 'status', SPEC]).sequence)]);
  const command = ['spec', 'author', 'publish', SPEC, '--reviewed', '--operation-id', 'publish-second'];
  const crashed = spawnSync(process.execPath, [bin, ...command], { cwd: root, encoding: 'utf8', timeout: childTimeout(60_000),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_CRASH_AT: 'spec-library-published' } });
  assertCrash(crashed, 'the process died after publication, before recording its acknowledgement');
  const retried = json(root, command);
  assert.deepEqual([retried.revision, retried.replayed], [2, true], 'the retry finds its own revision');
  assert.deepEqual(json(root, ['spec', 'author', 'list']).specs.find((entry) => entry.specId === SPEC).revisions, [1, 2]);

  git(root, 'remote', 'set-url', 'origin', path.join(directory, 'missing.git'));
  assert.equal(refused(root, ['spec', 'author', 'list']).code, 'SPEC_LIBRARY_UNAVAILABLE');
});

test('a backup carries specification drafts; restore puts back a missing one and keeps a different local one (v1.2 REQ-009)', async (t) => {
  const { root, directory } = await repository(t);
  await readySpec(root, directory);
  const before = json(root, ['spec', 'author', 'status', SPEC]).sequence;
  const out = path.join(directory, 'backup');
  assert.equal(json(root, ['backup', 'create', '--out', out]).specDrafts, 1);
  sf(root, ['spec', 'author', 'discard', SPEC]);
  assert.equal(refused(root, ['spec', 'author', 'status', SPEC]).code, 'SPEC_DRAFT_MISSING');
  const restored = json(root, ['backup', 'restore', out]);
  assert.deepEqual(restored.specDrafts.map((item) => [item.specId, item.status]), [[SPEC, 'restored']]);
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).sequence, before);
  assert.equal(json(root, ['backup', 'restore', out]).specDrafts[0].status, 'already-saved', 'restoring again changes nothing');
  json(root, ['spec', 'author', 'gap', SPEC, '--kind', 'open-question', '--question', 'Later work?']);
  assert.equal(json(root, ['backup', 'restore', out]).specDrafts[0].status, 'kept-local');
});

test('every linked worktree of the clone shares its specification drafts (v1.2 AC-020)', async (t) => {
  const { root, directory } = await repository(t);
  json(root, ['spec', 'author', 'new', SPEC, '--title', 'Order discount threshold']);
  const linked = path.join(directory, 'linked');
  git(root, 'worktree', 'add', '-q', '-b', 'side', linked);
  assert.equal(json(linked, ['spec', 'author', 'status', SPEC]).title, 'Order discount threshold');
  const listed = json(linked, ['spec', 'author', 'list']);
  assert.deepEqual(listed.drafts.map((entry) => entry.specId), [SPEC]);
  assert.equal(await readFile(path.join(root, '.git', 'singularity-flow', 'spec-drafts', SPEC, '000001.json'), 'utf8').then(() => true), true);
});

test('new specifications receive retry-stable IDs and seed their outcome without allocating a network counter', async (t) => {
  const { root } = await repository(t);
  const request = ['spec', 'author', 'new', '--title', 'Checkout reliability', '--intent', 'Shoppers can complete an order.', '--operation-id', 'auto-create-1'];
  const first = json(root, request);
  assert.match(first.specId, /^SPEC-[A-F0-9]{24}$/u);
  assert.equal(first.sequence, 1);
  const draft = json(root, ['spec', 'author', 'status', first.specId]);
  assert.match(draft.spec, /## Outcome\n\nShoppers can complete an order\./u);
  assert.ok(draft.spec.includes(`[${first.specId}:REQ-001]`));
  const again = json(root, request);
  assert.equal(again.specId, first.specId);
  assert.equal(again.replayed, true);
  assert.equal(again.sequence, 1);
  assert.equal(refused(root, [...request.slice(0, -2), '--operation-id', 'auto-create-1', '--area', 'src']).code, 'SPEC_DRAFT_OPERATION_REUSED');
  const second = json(root, [...request.slice(0, -2), '--operation-id', 'auto-create-2']);
  assert.notEqual(second.specId, first.specId, 'identical titles are separate specifications');
  assert.equal(refused(root, ['spec', 'author', 'new', '--revise']).code, 'SPEC_ID_INVALID');
  assert.equal(refused(root, ['spec', 'author', 'new', '--title', 'Import', '--from', 'missing.md', '--intent', 'Do not discard this']).code, 'SPEC_NEW_INPUT_CONFLICT');
  assert.equal(json(root, ['spec', 'author', 'new', 'SPEC-MANUAL-001', '--title', 'Legacy integration']).specId, 'SPEC-MANUAL-001');
});

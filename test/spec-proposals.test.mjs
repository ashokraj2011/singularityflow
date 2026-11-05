import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { environment } from './helpers/run-and-test-fixture.mjs';

import { ownTerminalStep, skillForCommandLine } from '../src/command-skills.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

// SPEC-SPA v1.3 S4: Copilot's proposals and assisted findings, staged model-free. Every command runs
// as a child CLI with models disabled; the proposal files stand in for what Copilot writes.

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
    env: { ...environment(path.join(path.dirname(cwd), 'context-' + path.basename(cwd))), SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1', ...env }
  });
  if (fail) assert.notEqual(result.status, 0, `${args.join(' ')} was expected to be refused:\n${result.stdout}`);
  else assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const json = (cwd, args, options) => JSON.parse(sf(cwd, [...args, '--json'], options).stdout);
const refused = (cwd, args, options = {}) => JSON.parse(sf(cwd, [...args, '--json'], { ...options, fail: true }).stdout).error;

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
  sf(root, ['spec', 'author', 'new', SPEC, '--kind', 'business', '--title', 'Order discount threshold', '--area', 'src/pricing.mjs']);
  const file = path.join(directory, `spec-${path.basename(root)}.md`);
  await writeFile(file, finishedSpec());
  sf(root, ['spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', '1']);
  return file;
}

/** Write a proposal file and stage it; returns the parsed result. */
async function propose(root, directory, payload, name = 'proposal.json', options) {
  const file = path.join(directory, name);
  await writeFile(file, JSON.stringify(payload));
  return options?.fail ? refused(root, ['spec', 'author', 'propose', SPEC, '--file', file]) : json(root, ['spec', 'author', 'propose', SPEC, '--file', file]);
}
const status = (root) => json(root, ['spec', 'author', 'status', SPEC]);

test('an edit proposal changes nothing until the person accepts it; one made against older prose is refused unless they merge it (SPA:AC-022)', async (t) => {
  const { root, directory } = await repository(t);
  await readySpec(root, directory);
  const before = status(root);
  const prose = finishedSpec().replace('a 10 percent order discount', 'a ten percent order discount');
  const staged = await propose(root, directory, { proposals: [{ kind: 'edit', summary: 'Spell out the rate.', spec: prose }] });
  assert.deepEqual(staged.staged, ['P-001']);
  const waiting = status(root);
  assert.equal(waiting.spec, before.spec, 'nothing is in the draft until it is accepted');
  assert.deepEqual(waiting.proposals.map(({ id, kind, stale }) => [id, kind, stale]), [['P-001', 'edit', false]]);
  assert.match(waiting.proposalPath, /spec-proposals[\\/][a-f0-9]{16}[\\/]SPEC-CHK-004\.proposal\.json$/u);
  assert.equal((await propose(root, directory, { proposals: [{ kind: 'edit', summary: 'Spell out the rate.', spec: prose }] })).replayed, true, 'the same file staged again is the same operation');

  json(root, ['spec', 'author', 'accept', SPEC, 'P-001']);
  const accepted = status(root);
  assert.equal(accepted.spec, prose);
  assert.deepEqual(accepted.proposals, []);
  assert.equal(refused(root, ['spec', 'author', 'accept', SPEC, 'P-001']).code, 'SPEC_PROPOSAL_DECIDED');

  await propose(root, directory, { proposals: [{ kind: 'edit', spec: prose.replace('Shopper', 'Buyer') }] }, 'second.json');
  const mine = path.join(directory, 'mine.md');
  await writeFile(mine, prose.replace('Out of scope: tax and shipping.', 'Out of scope: tax, shipping and gift cards.'));
  sf(root, ['spec', 'author', 'edit', SPEC, '--file', mine, '--expected-seq', String(status(root).sequence)]);
  const stale = refused(root, ['spec', 'author', 'accept', SPEC, 'P-002']);
  assert.equal(stale.code, 'SPEC_PROPOSAL_STALE');
  assert.match(stale.message, /--edit FILE/u);
  const merged = path.join(directory, 'merged.md');
  await writeFile(merged, (await readFile(mine, 'utf8')).replace('Shopper', 'Buyer'));
  json(root, ['spec', 'author', 'accept', SPEC, 'P-002', '--edit', merged]);
  assert.match(status(root).spec, /Buyer: places INR orders[\s\S]*gift cards/u);

  await propose(root, directory, { proposals: [{ kind: 'edit', spec: '# Something else\n' }] }, 'third.json');
  assert.equal(refused(root, ['spec', 'author', 'reject', SPEC, 'P-003']).code, 'SPEC_DECISION_REASON_MISSING');
  json(root, ['spec', 'author', 'reject', SPEC, 'P-003', '--reason', 'Not this one.']);
  assert.deepEqual(status(root).proposals, []);
});

test('a cited fact is verified when staged and again when accepted; an uncited one stays unverified and supports no gap; a bad span is refused (SPA:AC-023)', async (t) => {
  const { root, directory } = await repository(t);
  await readySpec(root, directory);
  for (const [citation, reason] of [[{ path: 'src/pricing.mjs', lines: [11, 999] }, /has \d+ lines/u], [{ path: 'src/missing.mjs', lines: [1, 2] }, /not in HEAD/u],
    [{ path: 'src/pricing.mjs', lines: [11, 16], quote: 'total > DISCOUNT_THRESHOLD' }, /does not contain the quoted text/u], [{ path: '../outside.mjs', lines: [1, 1] }, /inside the repository/u]]) {
    const error = await propose(root, directory, { proposals: [{ kind: 'research', summary: 'The threshold rule.', citation }] }, 'bad.json', { fail: true });
    assert.equal(error.code, 'SPEC_PROPOSAL_INVALID');
    assert.equal(error.details.findings[0].code, 'SPEC_PROPOSAL_SPAN_INVALID');
    assert.match(error.details.findings[0].message, reason);
  }
  assert.deepEqual(status(root).proposals, [], 'a refused file stages nothing');

  const staged = await propose(root, directory, { proposals: [
    { kind: 'research', summary: 'orderDiscount gives 10 percent from the threshold up.', citation: { path: 'src/pricing.mjs', lines: [11, 16], quote: 'total >= DISCOUNT_THRESHOLD' } },
    { kind: 'research', summary: 'Finance says gift cards never count.' }] });
  assert.deepEqual(staged.staged, ['P-001', 'P-002']);
  assert.ok(staged.notes.some((note) => /unverified/u.test(note)));
  assert.deepEqual(status(root).proposals.map(({ id, verified }) => [id, verified]), [['P-001', true], ['P-002', false]]);
  const { results } = json(root, ['spec', 'author', 'accept', SPEC, 'P-001,P-002']);
  const [cited, uncited] = [results['P-001'], results['P-002']];
  const items = status(root).researchItems;
  assert.equal(items.find((item) => item.id === cited).standing, 'current');
  assert.equal(items.find((item) => item.id === uncited).standing, 'uncited');
  const report = json(root, ['spec', 'author', 'check', SPEC]).report;
  assert.ok(report.blocking.some((finding) => finding.code === 'spec.citation-unverified' && finding.item === uncited), 'an unverified fact blocks a reviewed publication');
  assert.equal(refused(root, ['spec', 'author', 'gap', SPEC, '--kind', 'open-question', '--question', 'Gift cards?', '--research', uncited]).code, 'SPEC_GAP_EVIDENCE_UNVERIFIED');
  const asGap = await propose(root, directory, { proposals: [{ kind: 'gap', gapKind: 'open-question', question: 'Gift cards?', evidence: [uncited] }] }, 'gap.json', { fail: true });
  assert.equal(asGap.details.findings[0].code, 'SPEC_GAP_EVIDENCE_UNVERIFIED');

  await propose(root, directory, { proposals: [{ kind: 'gap', gapKind: 'code-disagrees', question: 'Strictly above, or at and above?', evidence: [cited],
    options: [{ wording: 'Strictly above INR 5000.00.', changesCode: true }, { wording: 'At INR 5000.00 and above.', changesCode: false }] }] }, 'good-gap.json');
  assert.equal(json(root, ['spec', 'author', 'accept', SPEC, 'P-003']).results['P-003'], 'GAP-001');
  const [gap] = json(root, ['spec', 'author', 'gaps', SPEC, 'GAP-001']).gaps;
  assert.match(gap.impact.options[0].records.map((record) => record.text).join('\n'), /orderDiscount/u, 'a proposed gap gets its impact from the code like any other');

  await propose(root, directory, { proposals: [{ kind: 'research', summary: 'The rule again.', citation: { path: 'src/pricing.mjs', lines: [14, 14] } }] }, 'later.json');
  await writeFile(path.join(root, 'src', 'pricing.mjs'), PRICING.replace('total >= DISCOUNT_THRESHOLD', 'total > DISCOUNT_THRESHOLD'));
  git(root, 'commit', '-qam', 'Strictly above');
  assert.equal(refused(root, ['spec', 'author', 'accept', SPEC, 'P-004']).code, 'SPEC_PROPOSAL_STALE', 'a span that changed since it was proposed is not accepted');
});

test('assisted findings are pending as soon as Copilot stages them, block a reviewed publication, and are settled only by the person (SPA:AC-024, AC-006)', async (t) => {
  const { root, directory } = await repository(t);
  await readySpec(root, directory);
  json(root, ['spec', 'author', 'settle', SPEC, '--all-articles', 'satisfied']);
  json(root, ['spec', 'author', 'gap', SPEC, '--kind', 'open-question', '--question', 'Placeholder?']);
  json(root, ['spec', 'author', 'decide', SPEC, 'GAP-001', '--choice', 'None.', '--reason', 'Checked.']);
  const stated = path.join(directory, 'stated.md');
  await writeFile(stated, finishedSpec('- GAP-001: none.'));
  sf(root, ['spec', 'author', 'edit', SPEC, '--file', stated, '--expected-seq', String(status(root).sequence)]);
  assert.equal(json(root, ['spec', 'author', 'check', SPEC]).report.counts.a.status, 'not-run');

  const staged = await propose(root, directory, { assistedCheck: true, proposals: [
    { kind: 'finding', article: 'ambiguity', message: '"order total" could include shipping.', clauses: ['REQ-001'] },
    { kind: 'finding', article: 'boundary-conditions', message: 'Nothing says what happens at exactly INR 5000.00.' },
    { kind: 'finding', article: 'non-functional', message: 'No latency is stated.' }] });
  assert.deepEqual(staged.staged, ['A-001', 'A-002', 'A-003']);
  const report = json(root, ['spec', 'author', 'check', SPEC]).report;
  assert.deepEqual([report.counts.a.status, report.counts.a.pending], ['run', 3]);
  const blocked = refused(root, ['spec', 'author', 'publish', SPEC, '--reviewed']);
  assert.equal(blocked.code, 'SPEC_LIBRARY_REVIEW_INCOMPLETE');
  assert.match(blocked.message, /assisted finding A-001 is not settled/u);

  assert.equal(refused(root, ['spec', 'author', 'settle', SPEC, '--finding', 'A-003=dismissed']).code, 'SPEC_DECISION_REASON_MISSING');
  assert.equal(refused(root, ['spec', 'author', 'settle', SPEC, '--finding', 'A-002=fixed']).code, 'SPEC_FINDING_NOT_FIXED');
  const settled = json(root, ['spec', 'author', 'settle', SPEC, '--finding', 'A-001=gap', '--finding', 'A-003=dismissed', '--reason', 'Batch job; no latency target.']);
  assert.deepEqual(settled.opened, { 'A-001': 'GAP-002' });
  const [gap] = json(root, ['spec', 'author', 'gaps', SPEC, 'GAP-002']).gaps;
  assert.deepEqual([gap.kind, gap.question, gap.clauses], ['vague-term', '"order total" could include shipping.', ['REQ-001']]);
  const edited = path.join(directory, 'boundary.md');
  await writeFile(edited, finishedSpec('- GAP-001: none.\n- GAP-002: the order total is the line subtotal; exactly INR 5000.00 gets nothing.'));
  sf(root, ['spec', 'author', 'edit', SPEC, '--file', edited, '--expected-seq', String(status(root).sequence)]);
  json(root, ['spec', 'author', 'settle', SPEC, '--finding', 'A-002=fixed']);
  json(root, ['spec', 'author', 'decide', SPEC, 'GAP-002', '--choice', 'The line subtotal.', '--reason', 'Finance.']);
  const ready = json(root, ['spec', 'author', 'check', SPEC]).report;
  assert.deepEqual([ready.reviewReady, ready.counts.a.pending], [true, 0], ready.blocking.map((finding) => finding.message).join('\n'));
  const published = json(root, ['spec', 'author', 'publish', SPEC, '--reviewed']);
  const quality = json(root, ['spec', 'author', 'show', `${SPEC}@${published.revision}`]).quality;
  assert.deepEqual([quality.assisted.status, quality.assisted.settled.map((finding) => finding.outcome)], ['run', ['gap', 'fixed', 'dismissed']]);

  for (const command of [`spec author accept ${SPEC} P-001`, `spec author reject ${SPEC} P-001 --reason No.`, `spec author settle ${SPEC} --finding A-001=dismissed --reason No.`]) {
    assert.equal(ownTerminalStep(`singularity-flow ${command}`), 'spec-library-decision', command);
    assert.equal(skillForCommandLine(`singularity-flow ${command}`), null, `${command} has no Copilot route`);
  }
  assert.equal(ownTerminalStep(`singularity-flow spec author propose ${SPEC} --file p.json`), null);
  assert.equal(skillForCommandLine(`singularity-flow spec author propose ${SPEC} --file p.json`), 'sf-spec-author');
  const operation = resolveOperation({ requestedCommand: 'spec', positionals: ['spec', 'author', 'propose', SPEC], options: { file: 'p.json' } });
  assert.deepEqual([operation.classification, operation.modelPolicy], ['mutation', 'never']);
});

test('a proposal file that does not check stages nothing and says which field is wrong', async (t) => {
  const { root, directory } = await repository(t);
  await readySpec(root, directory);
  const error = await propose(root, directory, { proposals: [{ kind: 'rewrite' }, { kind: 'edit', spec: status(root).spec }, { kind: 'finding', article: 'style', message: 'x' },
    { kind: 'gap', gapKind: 'open-question', question: 'Why?', options: [{ wording: '' }] }], extra: 1 }, 'bad.json', { fail: true });
  assert.deepEqual(error.details.findings.map(({ field, code }) => [field, code]), [
    ['extra', 'SPEC_PROPOSAL_INVALID'], ['proposals[0].kind', 'SPEC_PROPOSAL_KIND_UNKNOWN'], ['proposals[1].spec', 'SPEC_PROPOSAL_EDIT_UNCHANGED'],
    ['proposals[2].article', 'SPEC_ARTICLE_UNKNOWN'], ['proposals[3].options', 'SPEC_GAP_OPTIONS_INVALID']]);
  assert.deepEqual(status(root).proposals, []);
  assert.equal((await propose(root, directory, { proposals: [] }, 'empty.json', { fail: true })).code, 'SPEC_PROPOSAL_INVALID');
});

test('the issued proposal file has its folder before Copilot writes it, and propose uses the file up; a refused one is kept (S4 live run)', async (t) => {
  const { root, directory } = await repository(t);
  await readySpec(root, directory);
  const env = { SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: path.join(directory, 'build-state') };
  const issued = json(root, ['spec', 'author', 'status', SPEC], { env }).proposalPath;
  assert.ok(issued.startsWith(path.join(directory, 'build-state', 'spec-proposals')), issued);
  const folder = await stat(path.dirname(issued));
  assert.ok(folder.isDirectory(), 'a host create tool makes no parent folder, and the turn may not run mkdir');
  if (process.platform !== 'win32') assert.equal(folder.mode & 0o777, 0o700);
  await assert.rejects(access(issued), { code: 'ENOENT' }, 'only the folder is made, never the file');

  const research = JSON.stringify({ proposals: [{ kind: 'research', summary: 'orderDiscount gives 10 percent from the threshold up.',
    citation: { path: 'src/pricing.mjs', lines: [11, 16], quote: 'total >= DISCOUNT_THRESHOLD' } }] });
  await writeFile(issued, research, { flag: 'wx' });
  const staged = json(root, ['spec', 'author', 'propose', SPEC, '--file', issued], { env });
  assert.deepEqual([staged.staged, staged.proposalFile], [['P-001'], 'removed']);
  await assert.rejects(access(issued), { code: 'ENOENT' }, 'the staged file is used up');

  // The next turn creates the file afresh; a refused one is left for the repair.
  await writeFile(issued, JSON.stringify({ proposals: [{ kind: 'rewrite' }] }), { flag: 'wx' });
  const error = refused(root, ['spec', 'author', 'propose', SPEC, '--file', issued], { env });
  assert.equal(error.code, 'SPEC_PROPOSAL_INVALID');
  assert.match(error.message, /kept for the repair/u);
  assert.match(await readFile(issued, 'utf8'), /rewrite/u);

  // The same proposals again are the same operation: nothing is staged twice, and the file goes.
  await writeFile(issued, research);
  const again = json(root, ['spec', 'author', 'propose', SPEC, '--file', issued], { env });
  assert.deepEqual([again.replayed, again.proposalFile], [true, 'removed']);
  assert.deepEqual(json(root, ['spec', 'author', 'status', SPEC], { env }).proposals.map(({ id }) => id), ['P-001']);
  await assert.rejects(access(issued), { code: 'ENOENT' });
  assert.match(refused(root, ['spec', 'author', 'propose', SPEC, '--file', issued], { env }).message, /removes the proposal file once it has staged it/u);

  // A person's own file is theirs to keep.
  const mine = path.join(directory, 'mine.json');
  await writeFile(mine, JSON.stringify({ proposals: [{ kind: 'research', summary: 'Finance says gift cards never count.' }] }));
  assert.equal(json(root, ['spec', 'author', 'propose', SPEC, '--file', mine], { env }).proposalFile, 'kept');
  await access(mine);
});

test('a value given without its flag is refused and changes nothing; repeated flags and a comma list settle each one (S4 live run)', async (t) => {
  const { root, directory } = await repository(t);
  await readySpec(root, directory);
  await propose(root, directory, { assistedCheck: true, proposals: [
    { kind: 'finding', article: 'ambiguity', message: '"order total" could include shipping.', clauses: ['REQ-001'] },
    { kind: 'finding', article: 'boundary-conditions', message: 'Nothing says what happens at exactly INR 5000.00.' },
    { kind: 'finding', article: 'non-functional', message: 'No latency is stated.' }] });
  const before = status(root);
  const stray = refused(root, ['spec', 'author', 'settle', SPEC, '--finding', 'A-001=gap', 'A-002=gap', 'A-003=gap']);
  assert.equal(stray.code, 'SPEC_AUTHOR_ARGUMENT_UNEXPECTED');
  assert.match(stray.message, /'A-002=gap', 'A-003=gap'/u);
  assert.equal(refused(root, ['spec', 'author', 'settle', SPEC, '--article', 'completeness=satisfied', 'ambiguity=satisfied']).code, 'SPEC_AUTHOR_ARGUMENT_UNEXPECTED');
  const unchanged = status(root);
  assert.equal(unchanged.sequence, before.sequence, 'nothing was settled');
  assert.ok(unchanged.findings.every((finding) => finding.status === 'pending'));

  const settled = json(root, ['spec', 'author', 'settle', SPEC, '--finding', 'A-001=gap', '--finding', 'A-002=gap,A-003=gap', '--article', 'completeness=satisfied,ambiguity=satisfied']);
  assert.deepEqual(settled.opened, { 'A-001': 'GAP-001', 'A-002': 'GAP-002', 'A-003': 'GAP-003' });
  assert.deepEqual(settled.articles.filter(({ decision }) => decision).map(({ article }) => article).sort(), ['ambiguity', 'completeness']);

  for (const args of [['research', SPEC, '--remove', 'R-001', 'R-002'], ['new', 'SPEC-CHK-005', '--title', 'Two', 'words'], ['list', 'SPEC-CHK-004'], ['gaps', SPEC, 'GAP-001', 'GAP-002']]) {
    assert.equal(refused(root, ['spec', 'author', ...args]).code, 'SPEC_AUTHOR_ARGUMENT_UNEXPECTED', args.join(' '));
  }
  assert.equal(refused(root, ['spec', 'split', `${SPEC}@1`, '--propose', '--file', 'plan.json', 'extra']).code, 'SPEC_AUTHOR_ARGUMENT_UNEXPECTED');
  assert.notEqual(refused(root, ['spec', 'author', 'accept', SPEC, 'P-008', 'P-009']).code, 'SPEC_AUTHOR_ARGUMENT_UNEXPECTED', 'accept reads every ID it is given');
});

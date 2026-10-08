/**
 * Repository knowledge: what a build reads, what it finds, how it is scored and what a phase
 * prompt receives. The two fixtures are small real applications (a React shop and a Spring
 * orders service) with hand-written expectations, so a regression shows up as a lower score with
 * the missed items named, not as a vague "less useful".
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODE_INTELLIGENCE_SOURCES, transpileCodeIntelligence } from '../scripts/build-code-intelligence.mjs';
import { parseKnowledgeExpectations, scoreKnowledge } from '../src/knowledge/benchmark.mjs';
import { invalidCitations, knowledgeItem } from '../src/knowledge/items.mjs';
import { renderKnowledgeSlice, renderKnowledgeView, roleForPhase } from '../src/knowledge/render.mjs';
import { readKnowledgeSource } from '../src/knowledge/source.mjs';
import { buildKnowledge } from '../src/knowledge/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures', 'knowledge');
const bin = path.join(root, 'bin', 'singularity-flow.mjs');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

/** A committed copy of a fixture in its own repository. */
async function fixtureRepository(t, name, extra = async () => {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-knowledge-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repository = path.join(base, name);
  await cp(path.join(fixtures, name), repository, { recursive: true });
  await extra(repository);
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'add', '-A');
  git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Fixture');
  return repository;
}

async function expectations(name) {
  return parseKnowledgeExpectations(await readFile(path.join(fixtures, `${name}.expected.yml`), 'utf8'));
}

test('the CLI copy of the analysis engine is generated from its TypeScript source', async () => {
  for (const { from, to } of CODE_INTELLIGENCE_SOURCES) {
    const expected = transpileCodeIntelligence(await readFile(path.join(root, from), 'utf8'), from);
    assert.equal(await readFile(path.join(root, to), 'utf8'), expected, `${to} is stale: run node scripts/build-code-intelligence.mjs`);
  }
});

test('the React shop: rules, limits, journeys, tests, an untested handler and a test/code disagreement', async (t) => {
  const repository = await fixtureRepository(t, 'shop');
  const { knowledge, cache } = await buildKnowledge(repository, { history: false });
  assert.equal(cache, 'miss');
  const score = scoreKnowledge(knowledge, await expectations('shop'));
  assert.ok(score.recall >= 0.9, `shop recall ${score.recall}: ${JSON.stringify(Object.values(score.categories).flatMap((value) => value.missed))}`);
  assert.equal(score.citationValidity, 1);
  for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) assert.equal(knowledge.levels[level].status, 'ready', `${level}: ${knowledge.levels[level].reason}`);
  const rule = knowledge.items.find((item) => item.kind === 'rule' && /SAVE10/u.test(item.statement.when.join(' ')));
  assert.deepEqual(rule.citations[0].lines, [20, 20]);
  assert.equal(rule.citations[0].path, 'src/rules/pricing.ts');
  assert.ok(rule.relations.some((relation) => relation.type === 'tested-by' && relation.label === 'SAVE10 needs more than $30'));
  const drift = knowledge.items.find((item) => item.kind === 'drift');
  assert.match(drift.statement.detail, /"more than" \(strict\), the code uses >=/u);
  assert.equal(knowledge.items.filter((item) => item.kind === 'untested-rule').map((item) => item.subject.symbol).join(), 'handleSubmit');
  const limit = knowledge.items.find((item) => item.kind === 'limit' && item.statement.name === 'MAX_QUANTITY_PER_LINE');
  assert.equal(limit.statement.value, '10');
  assert.ok(limit.statement.usedIn.some((use) => use.symbol === 'cartReducer'), 'a limit says where it is applied');
  // The JSX apostrophe that hides code from the v4 scanners hides nothing here.
  assert.ok(knowledge.items.some((item) => item.kind === 'entity' && item.subject.path === 'src/components/ProductList.tsx'));
});

test('the Spring service: endpoints to the database, refusals to HTTP statuses, an untested cancellation', async (t) => {
  const repository = await fixtureRepository(t, 'orders-spring');
  const { knowledge } = await buildKnowledge(repository, { history: false });
  const score = scoreKnowledge(knowledge, await expectations('orders-spring'));
  assert.equal(score.recall, 1, JSON.stringify(Object.values(score.categories).flatMap((value) => value.missed)));
  const conflict = knowledge.items.find((item) => item.kind === 'error-path' && item.statement.message === 'Only placed orders can be cancelled');
  assert.equal(conflict.statement.status, 'CONFLICT');
  const journey = knowledge.items.find((item) => item.kind === 'journey' && item.statement.trigger === 'POST /orders');
  assert.deepEqual(journey.statement.steps, ['OrderController.place', 'OrderService.place', 'OrderService.totalOf']);
  assert.ok(journey.statement.effects.some((effect) => /database/u.test(effect)));
  assert.equal(knowledge.items.find((item) => item.kind === 'entity' && item.statement.name === 'OrderStatus').statement.values.join(),
    'PLACED,PAID,SHIPPED,CANCELLED');
  assert.ok(knowledge.items.some((item) => item.kind === 'rule' && item.subject.symbol === 'OrderService.totalOf'),
    'a package-private Java method is read too');
  assert.deepEqual(knowledge.items.filter((item) => item.kind === 'untested-rule').map((item) => item.subject.symbol), ['OrderService.cancel']);
  assert.ok(knowledge.items.some((item) => item.kind === 'configuration' && item.statement.key === 'orders.max-items' && item.statement.value === '20'));
});

test('a build reads the committed tree only, never Singularity Flow records or build output', async (t) => {
  const repository = await fixtureRepository(t, 'shop', async (directory) => {
    await cp(path.join(directory, 'src'), path.join(directory, 'singularity', 'work-items', 'X-1', 'src'), { recursive: true });
    await cp(path.join(directory, 'src'), path.join(directory, 'dist', 'src'), { recursive: true });
  });
  await writeFile(path.join(repository, 'src', 'Uncommitted.ts'), 'export const LATE = 1;\n');
  const source = await readKnowledgeSource(repository);
  assert.equal(source.status, 'ok');
  assert.ok(source.files.every((file) => !file.path.startsWith('singularity/') && !file.path.startsWith('dist/')));
  assert.ok(!source.files.some((file) => file.path === 'src/Uncommitted.ts'), 'working files are not the committed source');
  const tooMany = await readKnowledgeSource(repository, { limits: { maximumCodeFiles: 3, maximumFileBytes: 512 * 1024, maximumTotalBytes: 1 << 24 } });
  assert.equal(tooMany.status, 'insufficient');
  assert.equal(tooMany.reason, 'too-many-files');
  assert.ok(tooMany.areas.length >= 1, 'an over-budget repository names the areas to build instead');
  const area = await readKnowledgeSource(repository, { area: 'src/rules' });
  assert.deepEqual(area.files.map((file) => file.path), ['src/rules/pricing.ts']);
});

test('the cache is keyed by content: a second build is a hit, a new commit is a miss', async (t) => {
  const repository = await fixtureRepository(t, 'shop');
  assert.equal((await buildKnowledge(repository, { history: false })).cache, 'miss');
  assert.equal((await buildKnowledge(repository, { history: false })).cache, 'hit');
  await writeFile(path.join(repository, 'src', 'rules', 'extra.ts'), 'export const MAX_COUPONS = 3;\n');
  git(repository, 'add', '-A');
  git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'More');
  const rebuilt = await buildKnowledge(repository, { history: false });
  assert.equal(rebuilt.cache, 'miss');
  assert.ok(rebuilt.knowledge.items.some((item) => item.kind === 'limit' && item.statement.name === 'MAX_COUPONS'));
});

test('a citation stays valid only while its exact lines are unchanged', () => {
  const file = { path: 'a.ts', lines: ['const A = 1;', 'if (x > A) return 0;'] };
  const item = knowledgeItem({ kind: 'rule', key: 'k', citations: [{ path: 'a.ts', lines: [2, 2], spanSha256: null }], producer: 'test' });
  const valid = knowledgeItem({ kind: 'rule', key: 'k2', producer: 'test',
    citations: [{ path: 'a.ts', lines: [2, 2], spanSha256: `sha256:${createHashHex('if (x > A) return 0;')}` }] });
  assert.equal(invalidCitations([valid], new Map([['a.ts', file]])).length, 0);
  assert.equal(invalidCitations([item], new Map([['a.ts', file]])).length, 1);
  assert.equal(invalidCitations([valid], new Map([['a.ts', { ...file, lines: ['const A = 1;', 'if (x >= A) return 0;'] }]])).length, 1);
  assert.throws(() => knowledgeItem({ kind: 'rule', key: 'k3', producer: 'test' }), /needs a citation/u, 'an observed item without a citation is refused');
});

function createHashHex(text) {
  return createHash('sha256').update(text).digest('hex');
}

test('a phase slice opens with what a newcomer gets wrong, follows the Story focus and keeps to its budget', async (t) => {
  const repository = await fixtureRepository(t, 'shop');
  const { knowledge } = await buildKnowledge(repository, { history: false });
  assert.equal(roleForPhase('intake'), 'product');
  assert.equal(roleForPhase('design'), 'architect');
  assert.equal(roleForPhase('implementation'), 'developer');
  assert.equal(roleForPhase('verification'), 'tester');
  const slice = renderKnowledgeSlice(knowledge, { role: 'tester', focus: 'coupon discount', maximumBytes: 3000 });
  assert.ok(Buffer.byteLength(slice) <= 3000, `slice is ${Buffer.byteLength(slice)} bytes`);
  assert.ok(slice.indexOf('## Things a newcomer would get wrong') < slice.indexOf('## Business rules and decisions'));
  assert.match(slice, /focused on this Story/u);
  assert.match(slice, /couponDiscount/u);
  assert.doesNotMatch(slice, /cartReducer chooses by/u, 'unrelated decisions are left out of a focused slice');
  const overview = renderKnowledgeView(knowledge, 'overview');
  for (const heading of ['Things a newcomer would get wrong', 'Areas', 'Entry points and journeys', 'Business rules and decisions', 'Data shapes', 'Tests']) {
    assert.match(overview, new RegExp(`## ${heading}`, 'u'));
  }
  const rules = renderKnowledgeView(knowledge, 'rules');
  for (const line of rules.split('\n').filter((entry) => /^\s+- (?:when|computes|caps)/u.test(entry))) {
    assert.match(line, /— `[^`]+:\d+`(?: · no test)?$/u, `every rule line ends with where it was read: ${line}`);
  }
  assert.throws(() => renderKnowledgeView(knowledge, 'everything'), /Unknown knowledge view/u);
});

test('expectations are a closed vocabulary, and the score names every miss', async (t) => {
  assert.throws(() => parseKnowledgeExpectations('rule: []\n'), /Unknown expectation category 'rule'/u);
  assert.throws(() => parseKnowledgeExpectations('rules: x\n'), /must be a list/u);
  const repository = await fixtureRepository(t, 'shop');
  const { knowledge } = await buildKnowledge(repository, { history: false });
  const score = scoreKnowledge(knowledge, parseKnowledgeExpectations('rules:\n  - { path: src/rules/pricing.ts, line: 20, contains: SAVE10 }\n  - { path: src/nowhere.ts, line: 1 }\n'));
  assert.equal(score.found, 1);
  assert.deepEqual(score.categories.rules.missed, [{ path: 'src/nowhere.ts', line: 1 }]);
});

test('wm knowledge works from the command line, read-only for the repository', async (t) => {
  const repository = await fixtureRepository(t, 'orders-spring');
  const run = (...args) => spawnSync(process.execPath, [bin, 'wm', 'knowledge', ...args], {
    cwd: repository, encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
  });
  const built = run('build', '--json');
  assert.equal(built.status, 0, built.stderr);
  const summary = JSON.parse(built.stdout);
  assert.equal(summary.metrics.invalidCitations, 0);
  assert.ok(summary.metrics.byKind.rule >= 5);
  const slice = run('slice', '--phase', 'testing', '--max-bytes', '4000');
  assert.equal(slice.status, 0, slice.stderr);
  assert.match(slice.stdout, /knowledge for the tester/u);
  assert.match(slice.stdout, /Only placed orders can be cancelled/u);
  const scored = run('eval', '--expected', path.join(fixtures, 'orders-spring.expected.yml'), '--json');
  assert.equal(scored.status, 0, scored.stderr);
  assert.equal(JSON.parse(scored.stdout).recall, 1);
  assert.equal(git(repository, 'status', '--porcelain'), '', 'the working tree is untouched');
  const unknown = run('explode');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Available: build, eval, items, show, slice, status/u);
});

test('phase prompts receive one slice for the phase reader, focused on the Story, unless turned off', async (t) => {
  const { repositoryKnowledgePrompt, knowledgePromptPolicy } = await import('../src/knowledge/prompt.mjs');
  const repository = await fixtureRepository(t, 'orders-spring');
  const workflow = { workItem: { title: 'Allow cancelling paid orders', description: 'A paid order can be cancelled with a refund.' } };
  const testing = await repositoryKnowledgePrompt(repository, { definition: {}, phase: 'testing', workflow });
  assert.equal(testing.status, 'ok');
  assert.equal(testing.role, 'tester');
  assert.match(testing.text, /knowledge for the tester \(focused on this Story\)/u);
  assert.match(testing.text, /Only placed orders can be cancelled/u);
  assert.match(testing.text, /Open the cited lines before relying on a detail\.$/u);
  const design = await repositoryKnowledgePrompt(repository, { definition: { worldModel: { knowledge: { maxBytes: 2048 } } }, phase: 'design', workflow });
  assert.equal(design.role, 'architect');
  assert.ok(Buffer.byteLength(design.text) < 2048 + 200, 'the configured budget holds');
  assert.deepEqual(await repositoryKnowledgePrompt(repository, { definition: { worldModel: { knowledge: { prompt: 'off' } } }, phase: 'testing', workflow }),
    { text: '', warnings: [], status: 'off' });
  assert.deepEqual(knowledgePromptPolicy({ worldModel: { knowledge: { maxBytes: 999999 } } }), { prompt: 'slice', maxBytes: 32768 });
  const missing = await repositoryKnowledgePrompt(path.join(repository, 'not-a-repository'), { definition: {}, phase: 'testing', workflow });
  assert.equal(missing.text, '');
  assert.match(missing.warnings[0], /Repository knowledge was not added/u, 'a failure never blocks the prompt');
  // The slice rides the registered capability section, so prompt budgets and token-reduction contracts need no new owner.
  const compose = await readFile(path.join(root, 'src', 'worldmodel.mjs'), 'utf8');
  assert.match(compose, /id: 'capability-world-model', text: \[capability\.text, repositoryKnowledge\.text\]\.filter\(Boolean\)\.join/u);
  assert.match(compose, /const KNOWLEDGE_PROMPT_MODULE = '\.\/knowledge\/prompt\.mjs';/u);
});

test('worldModel.knowledge accepts only its two settings, in the validator and the schema', async () => {
  const { validateDefinition } = await import('../src/config.mjs');
  const YAML = (await import('yaml')).default;
  const template = YAML.parse(await readFile(path.join(root, 'templates', 'workflow.yml'), 'utf8'));
  const withKnowledge = (knowledge) => {
    const definition = structuredClone(template);
    definition.worldModel.knowledge = knowledge;
    return definition;
  };
  assert.doesNotThrow(() => validateDefinition(withKnowledge({ prompt: 'off', maxBytes: 4096 })));
  assert.throws(() => validateDefinition(withKnowledge({ prompt: 'always' })), /worldModel\.knowledge\.prompt must be 'slice' or 'off'\./u);
  assert.throws(() => validateDefinition(withKnowledge({ maxBytes: 100 })), /maxBytes must be an integer from 2048 through 32768/u);
  assert.throws(() => validateDefinition(withKnowledge({ budget: 1 })), /worldModel\.knowledge\.budget is not supported/u);
  const schema = JSON.parse(await readFile(path.join(root, 'schemas', 'workflow-definition.schema.json'), 'utf8'));
  const knowledge = schema.properties.worldModel.properties.knowledge;
  assert.deepEqual(knowledge.properties.prompt.enum, ['slice', 'off']);
  assert.equal(knowledge.additionalProperties, false);
});

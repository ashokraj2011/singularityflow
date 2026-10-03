import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acceptanceIds, discoverAcceptanceWitnesses } from '../src/delivery-evidence.mjs';
import {
  classifyTestCommand, discoverDeclarations, joinWitness, profileForCommand, profileIsExact
} from '../src/verification/adapters.mjs';
import { scanJavaScriptDeclarations } from '../src/verification/javascript-declarations.mjs';
import { joinDeclaration } from '../src/verification/join.mjs';

const scan = (source, framework = 'jest') => scanJavaScriptDeclarations(source, { sourcePath: 'test/pay.test.js', framework });
const occurrence = (name, outcome = 'passed', extra = {}) => ({ name, ancestorTitles: [], outcome, ...extra });

test('a JavaScript declaration is its file, describe path and literal title, and its revision is the whole call', () => {
  const source = [
    "import { add } from '../src/add.js';",
    '',
    "describe('payments', () => {",
    "  describe(\"refunds\", () => {",
    '    // Refunds return the balance.',
    '    // @ac:PAY:AC-001',
    "    it('returns the balance', async () => {",
    '      expect(add(1, 2)).toBe(3)',
    '    })',
    '  })',
    '})',
    ''
  ].join('\n');
  const [declaration] = scan(source).declarations;
  assert.deepEqual(declaration.suitePath, ['payments', 'refunds']);
  assert.equal(declaration.name, 'returns the balance');
  assert.deepEqual(declaration.clauseIds, ['PAY:AC-001']);
  assert.deepEqual(declaration.gaps, []);
  assert.equal(source.slice(declaration.span.start, declaration.span.end), source.slice(source.indexOf("it('returns"), source.indexOf('    })\n  })') + 6));
  // Weakening the assertion under the same title is a new revision; the identity is unchanged.
  const weakened = scan(source.replace('expect(add(1, 2)).toBe(3)', 'expect(true).toBe(true)')).declarations[0];
  assert.notEqual(weakened.declarationSha256, declaration.declarationSha256);
  assert.equal(weakened.logicalTestId, declaration.logicalTestId);
});

test('tags that sit on nothing and declarations that cannot be pinned down are reported, never guessed', () => {
  const header = scan("// @ac:PAY:AC-003\nimport { a } from './a.js';\n\ntest('unrelated passing test', () => {});\ntest.skip('the real AC test', () => {});\n");
  assert.deepEqual(header.declarations.map((entry) => [entry.name, entry.clauseIds, entry.skipped]), [
    ['unrelated passing test', [], false], ['the real AC test', [], true]
  ]);
  assert.deepEqual(header.unattachedTags.map((entry) => [entry.line, entry.clauseIds, entry.code]), [[1, ['PAY:AC-003'], 'AC_TAG_NOT_ATTACHED']]);
  const gapsOf = (source) => scan(source).declarations.flatMap((entry) => entry.gaps.map((item) => item.code));
  assert.deepEqual(gapsOf("// @ac:PAY:AC-001\ntest(`returns ${kind}`, () => {});\n"), ['DYNAMIC_TITLE']);
  assert.deepEqual(gapsOf("if (enabled)\n// @ac:PAY:AC-001\ntest('x', () => {});\n"), ['DECLARATION_IN_DYNAMIC_CONTEXT']);
  assert.deepEqual(gapsOf("for (const c of cases) {\n  // @ac:PAY:AC-001\n  test('x', () => {});\n}\n"), ['DECLARATION_IN_DYNAMIC_CONTEXT']);
  assert.deepEqual(gapsOf("describe.each([1])('n=%i', () => {\n  // @ac:PAY:AC-001\n  test('x', () => {});\n});\n"), ['DYNAMIC_SUITE']);
  assert.deepEqual(gapsOf("// @ac:PAY:AC-001\ntest.failing('x', () => {});\n"), ['INVERTED_TEST']);
  assert.deepEqual(gapsOf("// @ac:PAY:AC-001\ntest.each(cases)('adds %s', () => {});\n"), ['DYNAMIC_PARAMETER_SET']);
  assert.deepEqual(gapsOf("// @ac:PAY:AC-001\ntest('same', () => {});\n// @ac:PAY:AC-002\ntest('same', () => {});\n"), ['DUPLICATE_DECLARATION', 'DUPLICATE_DECLARATION']);
  assert.equal(scan("// @ac:PAY:AC-001\n\ntest('x', () => {});\n").unattachedTags[0].code, 'AC_TAG_NOT_ATTACHED');
  assert.equal(scan("// @ac:PAY:AC-001\ndescribe('g', () => { test('x', () => {}); });\n").unattachedTags[0].code, 'AC_TAG_ON_SUITE');
  // A file the lexer cannot read as data reports every tag in it as unattached, with the reason.
  const unreadable = scan("// @ac:PAY:AC-001\ntest('renders', () => {\n  render(<p>Don't</p>);\n});\n");
  assert.equal(unreadable.declarations.length, 0);
  assert.equal(unreadable.fileGaps[0].code, 'JAVASCRIPT_SOURCE_UNREADABLE');
  assert.equal(unreadable.unattachedTags[0].code, 'JAVASCRIPT_SOURCE_UNREADABLE');
  // The retired spelling binds nothing.
  assert.deepEqual(scan("// @sflow-ac:PAY:AC-001\ntest('x', () => {});\n").declarations[0].clauseIds, []);
});

test('a literal .each table is a declaration-level identity with a known instance count', () => {
  const [each] = scan("// @ac:PAY:AC-004\ntest.each([[1, 1, 2], [2, 2, 4]])('adds %i + %i', (a, b, c) => {\n  expect(a + b).toBe(c);\n});\n").declarations;
  assert.deepEqual(each.parameters, { kind: 'static', count: 2, titlePattern: '^adds .*? \\+ .*?$' });
  const table = "// @ac:PAY:AC-005\ntest.each`\n  a | b | expected\n  ${1} | ${1} | ${2}\n  ${2} | ${1} | ${3}\n`('returns $expected for $a + $b', ({ a, b, expected }) => {\n  expect(a + b).toBe(expected);\n});\n";
  assert.equal(scan(table).declarations[0].parameters.count, 2);
  const run = { completed: true, succeeded: true };
  assert.equal(joinDeclaration(each, [occurrence('adds 1 + 1'), occurrence('adds 2 + 2')], { language: 'javascript', run }).outcome, 'passed');
  assert.equal(joinDeclaration(each, [occurrence('adds 1 + 1')], { language: 'javascript', run }).outcome, 'missing');
  assert.equal(joinDeclaration(each, [occurrence('adds 1 + 1'), occurrence('adds 2 + 2', 'failed')], { language: 'javascript', run }).outcome, 'failed');
});

test('a declaration passes only through exactly one passing occurrence of its own identity', () => {
  const [declaration] = scan("// @ac:PAY:AC-001\ntest('returns the balance', () => {\n  expect(1).toBe(1);\n});\n").declarations;
  const join = (occurrences, run = { completed: true, succeeded: true }) => joinDeclaration(declaration, occurrences, { language: 'javascript', run }).outcome;
  assert.equal(join([occurrence('returns the balance')]), 'passed');
  // §12 #7: an unrelated passing test in the same run never stands in for the criterion's test.
  assert.equal(join([occurrence('an unrelated passing test')]), 'missing');
  // §12 #8: skipped, missing and duplicate stay unverified.
  assert.equal(join([occurrence('returns the balance', 'skipped'), occurrence('an unrelated passing test')]), 'unverified-skipped');
  assert.equal(join([]), 'missing');
  assert.equal(join([occurrence('returns the balance'), occurrence('returns the balance')]), 'ambiguous');
  assert.equal(join([occurrence('returns the balance', 'passed', { flaky: true })]), 'flaky');
  // A pass inside a run that failed or did not finish is not a pass.
  assert.equal(join([occurrence('returns the balance')], { completed: true, succeeded: false }), 'failed');
  assert.equal(join([occurrence('returns the balance')], { completed: false, succeeded: false }), 'inconclusive');
  // The same title in another describe path is another test.
  assert.equal(join([{ ...occurrence('returns the balance'), ancestorTitles: ['refunds'] }]), 'missing');
  // A report that names files keeps a same-titled test in another file out.
  assert.equal(join([{ ...occurrence('returns the balance'), file: '/repo/test/pay.test.js' }, { ...occurrence('returns the balance'), file: '/repo/test/other.test.js' }]), 'passed');
});

test('test commands map to one closed adapter profile with an honest ceiling', () => {
  const command = (adapter, argv) => ({ id: 'unit', kind: 'test', argv, workingDirectory: '.', affectedRoots: ['.'], result: { adapter, path: 'r' } });
  assert.equal(profileForCommand(command('jest-json', ['npm', 'test'])), 'jest-static-v2');
  assert.equal(profileForCommand(command('vitest-json', ['pnpm', 'test'])), 'vitest-static-v2');
  assert.equal(profileForCommand(command('junit-xml', ['./mvnw', 'test'])), 'junit5-surefire-v2');
  assert.equal(profileForCommand(command('junit-xml', ['./gradlew', 'test'])), 'junit5-gradle-v2');
  // node --test, pytest, Go, Karma, TRX and Playwright only count tests today.
  for (const [adapter, argv] of [['junit-xml', ['node', '--test']], ['junit-xml', ['python3', '-m', 'pytest']], ['node-tap', ['npm', 'test']], ['go-test-json', ['go', 'test']], ['playwright-json', ['npx', 'playwright', 'test']]]) {
    assert.equal(profileForCommand(command(adapter, argv)), 'module-counts-v1', adapter);
  }
  assert.equal(profileIsExact('jest-static-v2'), true);
  assert.equal(profileIsExact('module-counts-v1'), false);
  assert.deepEqual(classifyTestCommand('jest-static-v2', command('jest-json', ['npm', 'test', '--', '-t', 'balance'])).selection, 'filtered');
  assert.deepEqual(classifyTestCommand('junit5-surefire-v2', command('junit-xml', ['mvn', 'test'])), { selection: 'complete', gaps: [] });
});

test('the JDK reader allows lifecycle hooks, reads nested and parameterized tests, and ties @ac comments to methods', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-verification-junit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const relative = 'src/test/java/example/OrderTest.java';
  await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
  const source = [
    'package example;',
    'import org.junit.jupiter.api.*;',
    'import org.junit.jupiter.params.ParameterizedTest;',
    'import org.junit.jupiter.params.provider.MethodSource;',
    'import org.junit.jupiter.params.provider.ValueSource;',
    'class OrderTest {',
    '  @BeforeEach void setUp() {}',
    '  // @ac:WRK-1:AC-001',
    '  @Test',
    '  void calculatesInterest() { Assertions.assertEquals(2, 1 + 1); }',
    '  // @ac:WRK-1:AC-002',
    '  @ParameterizedTest',
    '  @ValueSource(ints = {1, 2, 3})',
    '  void positive(int value) {}',
    '  // @ac:WRK-1:AC-003',
    '  @ParameterizedTest',
    '  @MethodSource("cases")',
    '  void dynamic(int value) {}',
    '  // @ac:WRK-1:AC-004',
    '  @Disabled @Test void off() {}',
    '  @Nested class WhenEmpty {',
    '    // @ac:WRK-1:AC-005',
    '    @Test void hasNoTotal() {}',
    '  }',
    '  @Test @Tag("sflow-ac:WRK-1:AC-006") void legacyTag() {}',
    '}',
    '// @ac:WRK-1:AC-007',
    ''
  ].join('\n');
  await writeFile(path.join(root, relative), source);
  const found = await discoverDeclarations(root, 'junit5-surefire-v2', [relative]);
  const byMethod = Object.fromEntries(found.declarations.map((entry) => [entry.methodName, entry]));
  assert.deepEqual(byMethod.calculatesInterest.clauseIds, ['WRK-1:AC-001']);
  assert.deepEqual(byMethod.calculatesInterest.gaps, []);
  assert.match(byMethod.calculatesInterest.supportSha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(byMethod.positive.parameters, { kind: 'static', count: 3 });
  assert.deepEqual(byMethod.dynamic.gaps.map((entry) => entry.code), ['DYNAMIC_PARAMETER_SET']);
  assert.equal(byMethod.off.skipped, true);
  assert.equal(byMethod.hasNoTotal.className, 'example.OrderTest$WhenEmpty');
  assert.deepEqual(byMethod.legacyTag.clauseIds, []);
  assert.deepEqual(found.unattachedTags.map((entry) => entry.clauseIds), [['WRK-1:AC-007']]);
  // A change to the lifecycle hook changes the support digest of the tests it wraps.
  await writeFile(path.join(root, relative), source.replace('@BeforeEach void setUp() {}', '@BeforeEach void setUp() { System.gc(); }'));
  const changed = await discoverDeclarations(root, 'junit5-surefire-v2', [relative]);
  const after = changed.declarations.find((entry) => entry.methodName === 'calculatesInterest');
  assert.notEqual(after.supportSha256, byMethod.calculatesInterest.supportSha256);
  assert.equal(after.declarationSha256, byMethod.calculatesInterest.declarationSha256);

  const run = { completed: true, succeeded: true };
  const occurrences = [
    { className: 'example.OrderTest', name: 'calculatesInterest', outcome: 'passed' },
    { className: 'example.OrderTest', name: 'positive(int)[1]', outcome: 'passed' },
    { className: 'example.OrderTest', name: 'positive(int)[2]', outcome: 'passed' },
    { className: 'example.OrderTest', name: 'off', outcome: 'skipped' },
    { className: 'example.OrderTest$WhenEmpty', name: 'hasNoTotal()', outcome: 'passed' }
  ];
  const outcome = (method) => joinWitness('junit5-surefire-v2', byMethod[method], occurrences, run).outcome;
  assert.equal(outcome('calculatesInterest'), 'passed');
  assert.equal(outcome('positive'), 'missing', 'two of three parameterized instances is not the declaration');
  assert.equal(outcome('dynamic'), 'inconclusive');
  assert.equal(outcome('off'), 'unverified-skipped');
  assert.equal(outcome('hasNoTotal'), 'passed');
  assert.equal(joinWitness('junit5-gradle-v2', byMethod.positive, occurrences, run).outcome, 'inconclusive');
});

test('publication finds the test each tag sits on, refuses a tag on nothing in an exact module, and keeps file tags elsewhere', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-verification-witnesses-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'web', 'test'), { recursive: true });
  await mkdir(path.join(root, 'tools', 'test'), { recursive: true });
  await writeFile(path.join(root, 'web', 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  await writeFile(path.join(root, 'tools', 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'web', 'test', 'pay.test.js'), [
    '// @ac:PAY-1:AC-001', "test('pays the balance', () => { expect(1).toBe(1); });", '',
    '// @ac:PAY-1:AC-002', '', "test('unrelated', () => {});", ''
  ].join('\n'));
  await writeFile(path.join(root, 'tools', 'test', 'tool.test.mjs'), "// @ac:PAY-1:AC-003\nimport test from 'node:test';\ntest('t', () => {});\n");
  const phase = { id: 'implementation', generationPolicy: { task: 'code' }, writeScope: 'source-and-artifact', qualityCommands: [] };
  const bindings = [
    { clauseId: 'PAY-1:AC-001', testSource: 'web/test/pay.test.js' },
    { clauseId: 'PAY-1:AC-002', testSource: 'web/test/pay.test.js' },
    { clauseId: 'PAY-1:AC-003', testSource: 'tools/test/tool.test.mjs' }
  ];
  const result = await discoverAcceptanceWitnesses(root, phase, {
    testPaths: ['tools/test/tool.test.mjs', 'web/test/pay.test.js'], sourcePaths: [],
    requiredAcIds: ['PAY-1:AC-001', 'PAY-1:AC-002', 'PAY-1:AC-003'], bindings
  });
  const exact = result.witnesses.find((entry) => entry.clauseId === 'PAY-1:AC-001');
  assert.equal(exact.profile, 'jest-static-v2');
  assert.deepEqual(exact.identity, { framework: 'jest', suitePath: [], name: 'pays the balance' });
  assert.equal(exact.exact, true);
  const counted = result.witnesses.find((entry) => entry.clauseId === 'PAY-1:AC-003');
  assert.equal(counted.profile, 'module-counts-v1');
  assert.deepEqual(counted.gaps, ['ADAPTER_COUNTS_ONLY']);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /@ac:PAY-1:AC-002 is not on a test: web\/test\/pay\.test\.js:4/);
  assert.deepEqual(result.profiles.map((entry) => [entry.testSource, entry.profile, entry.ceiling]).sort(), [
    ['tools/test/tool.test.mjs', 'module-counts-v1', 'module-observed'],
    ['web/test/pay.test.js', 'jest-static-v2', 'exact-local-observed']
  ]);
});

test('a code step owes only the criteria the plan allocates to it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-verification-allocation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const item = path.join(root, 'singularity/work-items/PAY-1');
  await mkdir(path.join(item, 'context', 'spec-indexes'), { recursive: true });
  await mkdir(path.join(item, 'context', 'claims'), { recursive: true });
  const workflow = {
    workItem: { id: 'PAY-1' },
    phaseOrder: ['plan', 'backend', 'frontend'],
    resolution: {},
    phases: {
      plan: { id: 'plan', generation: 1, requiredArtifact: { kind: 'implementation-spec', path: 'artifacts/plan/plan.md' } },
      backend: { id: 'backend', generation: 0, generationPolicy: { task: 'code' } },
      frontend: { id: 'frontend', generation: 0, generationPolicy: { task: 'code' } }
    }
  };
  const clause = (id) => ({ id, type: 'AC', body: id, bodySha256: 'a'.repeat(64), source: { path: 'plan.md', line: 1 } });
  await writeFile(path.join(item, 'context', 'spec-indexes', 'plan-gen1.json'), JSON.stringify({
    schemaVersion: 1, kind: 'specification-index', workId: 'PAY-1', phase: 'plan', generation: 1,
    clauses: [clause('PAY-1:AC-001'), clause('PAY-1:AC-002'), clause('PAY-1:AC-003')]
  }));
  await writeFile(path.join(item, 'context', 'claims', 'plan-gen1-planned.json'), JSON.stringify({
    schemaVersion: 2, kind: 'planned', workId: 'PAY-1', phase: 'plan', generation: 1,
    claims: {
      'PAY-1:AC-001': { expectedPaths: ['src/a.js'], tests: ['test/a.test.js'], testDisposition: 'applicable', testReason: null, deviation: null, steps: ['backend'] },
      'PAY-1:AC-002': { expectedPaths: ['src/b.js'], tests: ['test/b.test.js'], testDisposition: 'applicable', testReason: null, deviation: null, steps: ['frontend'] },
      'PAY-1:AC-003': { expectedPaths: ['src/c.js'], tests: ['test/c.test.js'], testDisposition: 'applicable', testReason: null, deviation: null }
    }
  }));
  const config = { governance: { requireAcceptanceCriteriaTags: true }, workItemRoot: 'singularity/work-items' };
  assert.deepEqual(await acceptanceIds(root, config, workflow, workflow.phases.backend), ['PAY-1:AC-001', 'PAY-1:AC-003']);
  assert.deepEqual(await acceptanceIds(root, config, workflow, workflow.phases.frontend), ['PAY-1:AC-002', 'PAY-1:AC-003']);
});

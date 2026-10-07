import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acceptanceIds, inferRepositoryTestCommands, isTestQualityCommand, phaseRequiresCodeDelivery,
  resolveDeliveryQualityCommands, specificationCriteria, taggedAcceptanceIds, unknownCriterionTags
} from '../src/delivery-evidence.mjs';
import { blockingConformanceVerdicts } from '../src/conformance-verdicts.mjs';

test('explicit and legacy implementation phases require delivery evidence', () => {
  assert.equal(phaseRequiresCodeDelivery({
    writeScope: 'source-and-artifact', requiredArtifact: { kind: 'implementation-summary' }
  }), true);
  assert.equal(phaseRequiresCodeDelivery({
    writeScope: 'artifact-only', requiredArtifact: { kind: 'implementation-summary' }
  }), true, 'an unsafe legacy phase must fail closed at its scope check');
  assert.equal(phaseRequiresCodeDelivery({
    writeScope: 'source-and-artifact', generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'file' }
  }), true);
  assert.equal(phaseRequiresCodeDelivery({
    writeScope: 'source-and-artifact', generationPolicy: { task: 'analyze' }, requiredArtifact: { kind: 'implementation-summary' }
  }), false, 'an explicit non-code task is the compatibility opt-out');
  assert.equal(phaseRequiresCodeDelivery({
    writeScope: 'source-and-artifact', generationPolicy: { task: 'analyze' }, requiredArtifact: { kind: 'test-evidence' }
  }), false);
});

test('code validation distinguishes executable tests from lint and compile-only checks', () => {
  for (const command of [
    { id: 'maven-tests', argv: ['mvn', '-q', 'test'] },
    { id: 'acceptance-tests', argv: ['npm', 'run', 'acceptance'] },
    { id: 'playwright', argv: ['npx', 'playwright', 'test'] },
    { id: 'verification', argv: ['./mvnw', 'verify'] },
    ['go', 'test', './...'],
    { id: 'shell-tests', argv: ['bash', 'scripts/acceptance-tests.sh'] }
  ]) assert.equal(isTestQualityCommand(command), true, JSON.stringify(command));

  for (const command of [
    { id: 'git-diff-check', argv: ['git', 'diff', '--check'] },
    { id: 'typescript-compile', argv: ['npx', 'tsc', '--noEmit'] },
    'npm run lint',
    ['echo', 'test'],
    ['cat', 'src/test/example.test.js']
  ]) assert.equal(isTestQualityCommand(command), false, JSON.stringify(command));
});

test('repository-native Maven and Node tests are inferred without a model', async () => {
  const maven = await mkdtemp(path.join(os.tmpdir(), 'sflow-maven-quality-'));
  await writeFile(path.join(maven, 'pom.xml'), '<project/>\n');
  assert.deepEqual(await inferRepositoryTestCommands(maven), [
    {
      id: 'maven-tests', kind: 'test', argv: ['mvn', 'test'], workingDirectory: '.',
      affectedRoots: ['.'], modelPolicy: 'never',
      result: { adapter: 'junit-xml', path: 'target/surefire-reports', minimumDiscovered: 1 }
    }
  ]);

  const node = await mkdtemp(path.join(os.tmpdir(), 'sflow-node-quality-'));
  await writeFile(path.join(node, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.deepEqual(await inferRepositoryTestCommands(node), [
    {
      id: 'node-tests', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.',
      affectedRoots: ['.'], modelPolicy: 'never',
      result: { adapter: 'node-tap', path: '.sflow/results/node-tests.tap', minimumDiscovered: 1 }
    }
  ]);

  const angular = await mkdtemp(path.join(os.tmpdir(), 'sflow-angular-quality-'));
  await writeFile(path.join(angular, 'package.json'), JSON.stringify({
    scripts: { test: 'ng test' },
    devDependencies: { '@angular-devkit/build-angular': '^17.0.0', karma: '^6.0.0' }
  }));
  assert.deepEqual(await inferRepositoryTestCommands(angular), [
    {
      id: 'node-tests', kind: 'test',
      argv: ['npm', 'test', '--', '--watch=false', '--browsers=ChromeHeadless', '--no-progress'],
      workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
      result: { adapter: 'karma-text', path: '.sflow/results/node-tests.karma.txt', minimumDiscovered: 1 }
    }
  ]);
});

test('full readiness and code delivery discover direct Playwright alongside Node unit tests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-playwright-quality-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'node --test', 'test:e2e': 'playwright test' },
    devDependencies: { '@playwright/test': '^1.0.0' }
  }));
  const full = await inferRepositoryTestCommands(root);
  assert.deepEqual(full.map((entry) => [entry.id, entry.result.adapter]), [
    ['node-tests', 'node-tap'], ['playwright-tests', 'playwright-json']
  ]);
  assert.deepEqual((await inferRepositoryTestCommands(root, { unitOnly: true }))
    .map((entry) => entry.result.adapter), ['node-tap']);
  const phase = {
    writeScope: 'source-and-artifact', generationPolicy: { task: 'code' },
    requiredArtifact: { kind: 'implementation-summary' }, qualityCommands: [],
    deliveryEvidence: {
      sourcePaths: ['src/web.ts'], testPaths: ['tests/web.spec.ts']
    }
  };
  assert.deepEqual((await resolveDeliveryQualityCommands(root, phase))
    .map((entry) => entry.result.adapter), ['node-tap', 'playwright-json']);
});

test('an unsupported nested test module cannot borrow unrelated root Maven evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-nested-runner-quality-'));
  await writeFile(path.join(root, 'pom.xml'), '<project/>\n');
  await mkdir(path.join(root, 'web'), { recursive: true });
  await writeFile(path.join(root, 'web', 'package.json'), JSON.stringify({
    scripts: { test: 'npx playwright test' },
    devDependencies: { '@playwright/test': '^1.0.0' }
  }));
  const commands = await resolveDeliveryQualityCommands(root, {
    writeScope: 'source-and-artifact', generationPolicy: { task: 'code' },
    requiredArtifact: { kind: 'implementation-summary' }, qualityCommands: [],
    deliveryEvidence: { sourcePaths: ['web/src/ui.ts'], testPaths: ['web/tests/ui.spec.ts'] }
  });
  assert.deepEqual(commands, []);
});

test('configured structured tests suppress duplicate inference for their covered module', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-angular-configured-quality-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'ng test' }, devDependencies: { karma: '^6.4.0' }
  }));
  const configured = {
    id: 'approved-angular-tests', kind: 'test', argv: ['node', 'scripts/run-tests.mjs'],
    workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
    result: { adapter: 'sflow-test-result-v1', path: '.sflow/results/approved.json' }
  };
  assert.deepEqual(await resolveDeliveryQualityCommands(root, {
    writeScope: 'source-and-artifact',
    generationPolicy: { task: 'code' },
    requiredArtifact: { kind: 'implementation-summary' },
    qualityCommands: [configured],
    deliveryEvidence: {
      sourcePaths: ['src/app/filter.component.ts'],
      testPaths: ['src/app/filter.component.spec.ts']
    }
  }), [configured]);
});

test('explicit all-configured scope includes the repository suite without dropping identical argv in an affected module', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-intake-test-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  for (const module of ['web']) {
    await mkdir(path.join(root, module), { recursive: true });
    await writeFile(path.join(root, module, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  }
  const phase = { writeScope: 'source-and-artifact', generationPolicy: { task: 'code' },
    requiredArtifact: { kind: 'implementation-summary' }, qualityCommands: [],
    deliveryEvidence: { sourcePaths: ['web/src/app.mjs'], testPaths: ['web/test/app.test.mjs'] } };
  assert.deepEqual((await resolveDeliveryQualityCommands(root, phase)).map(command => command.workingDirectory), ['web']);
  const full = await resolveDeliveryQualityCommands(root, phase, { executionMode: 'all-configured' });
  assert.deepEqual(full.map(command => command.workingDirectory).sort(), ['.', 'web']);
  assert.equal(new Set(full.map(command => command.id)).size, full.length);
});

test('acceptance tags are required from every predecessor artifact kind', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cross-workflow-acceptance-'));
  const relative = 'singularity/work-items/POC-1/artifacts/poc-intake/intake.md';
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), '# POC intake\n\nAcceptance criterion: AC-017\n');
  const workflow = {
    workItem: { id: 'POC-1' },
    phaseOrder: ['poc-intake', 'poc-test-generation'],
    phases: {
      'poc-intake': { requiredArtifact: { path: 'artifacts/poc-intake/intake.md', kind: 'poc-intake' } },
      'poc-test-generation': { id: 'poc-test-generation' }
    }
  };
  assert.deepEqual(
    await acceptanceIds(root, {
      governance: { requireAcceptanceCriteriaTags: true }, workItemRoot: 'singularity/work-items'
    }, workflow, workflow.phases['poc-test-generation']),
    ['AC-017']
  );
});

const indexedClause = (id) => ({
  id, type: id.split(':').at(-1).split('-')[0], body: `${id} statement`, bodySha256: 'a'.repeat(64),
  source: { path: 'spec.md', line: 1 }
});
const exactTest = (name) => ({ identity: { framework: 'node:test', suitePath: [], name }, gaps: [] });

test('publication refuses a test tag naming a criterion the specification does not hold', () => {
  const criteria = specificationCriteria({ indexes: [{ clauses: [indexedClause('E2E:REQ-001'), indexedClause('E2E:AC-002')] }] },
    { workItem: { id: 'WORK-1' } });
  assert.deepEqual([...criteria.held].sort(), ['E2E:AC-002', 'E2E:REQ-001']);
  assert.deepEqual([...criteria.namespaces].sort(), ['E2E', 'WORK-1'], 'the Work ID and every namespace the specification uses');
  const findings = unknownCriterionTags(criteria, {
    locations: [
      { clauseId: 'E2E:AC-001', testSource: 'tests/retry.test.mjs', line: 4 },
      { clauseId: 'E2E:AC-002', testSource: 'tests/retry.test.mjs', line: 9 },
      { clauseId: 'OLD-7:AC-003', testSource: 'tests/legacy.test.js', line: 2 },
      { clauseId: 'OLD-7:AC-004', testSource: 'tests/exact.test.mjs', line: 5 }
    ],
    witnesses: [
      { clauseId: 'E2E:AC-001', testSource: 'tests/retry.test.mjs', line: 5, identity: null, gaps: ['ADAPTER_COUNTS_ONLY'] },
      { clauseId: 'OLD-7:AC-003', testSource: 'tests/legacy.test.js', line: null, identity: null, gaps: ['ADAPTER_COUNTS_ONLY'] },
      { clauseId: 'OLD-7:AC-004', testSource: 'tests/exact.test.mjs', line: 6, ...exactTest('pays') },
      // A tag only the module's adapter read still became a witness, so its test's line is named.
      { clauseId: 'E2E:AC-009', testSource: 'tests/adapter.test.mjs', line: 12, ...exactTest('retries') }
    ],
    unattachedTags: [{ testSource: 'tests/stray.test.mjs', line: 3, clauseIds: ['WORK-1:AC-005'] }]
  });
  // The Story's own namespaces are refused wherever the tag sits; another Story's tag only once it
  // sits on an exact test, which submission would refuse. A counted tag of another Story stays.
  assert.deepEqual(findings.map((finding) => [finding.path, finding.line, finding.clauseId]), [
    ['tests/adapter.test.mjs', 12, 'E2E:AC-009'],
    ['tests/exact.test.mjs', 5, 'OLD-7:AC-004'],
    ['tests/retry.test.mjs', 4, 'E2E:AC-001'],
    ['tests/stray.test.mjs', 3, 'WORK-1:AC-005']
  ]);
  assert.ok(findings.every((finding) => finding.code === 'EVIDENCE_CRITERION_UNKNOWN'));
  assert.equal(findings[2].message, '@ac:E2E:AC-001 at tests/retry.test.mjs:4 names a criterion the active specification does not hold.');
});

test('in a namespace other Stories share, a test tag the files already carried is not the Story\'s to correct', () => {
  const criteria = specificationCriteria({ indexes: [{ clauses: [indexedClause('ORDER:REQ-001'), indexedClause('ORDER:AC-001')] }] },
    { workItem: { id: 'WORK-1' }, resolution: { spec: { namespace: 'ORDER' } } });
  assert.deepEqual([...criteria.namespaces].sort(), ['ORDER', 'WORK-1']);
  assert.deepEqual([...criteria.sharedNamespaces], ['ORDER'], 'every Story of the work type uses the configured namespace');
  const asked = [];
  const carried = (occurrences) => {
    asked.push(occurrences);
    return new Set(['ORDER:AC-003', 'ORDER:AC-005', 'WORK-1:AC-004']);
  };
  const findings = unknownCriterionTags(criteria, {
    locations: [
      { clauseId: 'ORDER:AC-003', testSource: 'tests/order.test.js', line: 2 },
      { clauseId: 'ORDER:AC-009', testSource: 'tests/order.test.js', line: 6 },
      { clauseId: 'WORK-1:AC-004', testSource: 'tests/order.test.js', line: 9 },
      { clauseId: 'ORDER:AC-005', testSource: 'tests/exact.test.mjs', line: 3 }
    ],
    witnesses: [{ clauseId: 'ORDER:AC-005', testSource: 'tests/exact.test.mjs', line: 4, ...exactTest('refunds') }],
    carried
  });
  // An earlier Story's carried tag stays where its runner only counts tests. One the generation
  // added, one in the Work ID and one on an exact test are refused, carried or not.
  assert.deepEqual(findings.map((finding) => [finding.path, finding.line, finding.clauseId]), [
    ['tests/exact.test.mjs', 3, 'ORDER:AC-005'],
    ['tests/order.test.js', 6, 'ORDER:AC-009'],
    ['tests/order.test.js', 9, 'WORK-1:AC-004']
  ]);
  assert.equal(asked.length, 1, 'what the files carried is read once');
  assert.deepEqual(asked[0].map((occurrence) => [occurrence.path, occurrence.clauseId]), [
    ['tests/order.test.js', 'ORDER:AC-003'], ['tests/order.test.js', 'ORDER:AC-009'],
    ['tests/order.test.js', 'WORK-1:AC-004'], ['tests/exact.test.mjs', 'ORDER:AC-005']
  ]);
  // Nothing in a shared namespace to decide, so nothing is read.
  assert.deepEqual(unknownCriterionTags(criteria, {
    locations: [{ clauseId: 'WORK-1:AC-007', testSource: 'tests/order.test.js', line: 12 }],
    carried: () => assert.fail('a Work ID tag needs no baseline')
  }).map((finding) => finding.clauseId), ['WORK-1:AC-007']);
});

test('a Story without a specification index refuses only the tags its submission would refuse', () => {
  assert.equal(specificationCriteria({ indexes: [] }, { workItem: { id: 'LITE-1' } }), null);
  assert.equal(specificationCriteria({}, { workItem: { id: 'LITE-1' } }), null);
  const tags = {
    locations: [
      { clauseId: 'LITE-1:AC-001', testSource: 'tests/example.test.mjs', line: 4 },
      { clauseId: 'LITE-1:AC-002', testSource: 'tests/counted.test.js', line: 1 },
      { clauseId: 'LITE-1:AC-003', testSource: 'tests/duplicate.test.mjs', line: 2 }
    ],
    witnesses: [
      { clauseId: 'LITE-1:AC-001', testSource: 'tests/example.test.mjs', line: 5, ...exactTest('exact value') },
      { clauseId: 'LITE-1:AC-002', testSource: 'tests/counted.test.js', line: null, identity: null, gaps: ['ADAPTER_COUNTS_ONLY'] },
      { clauseId: 'LITE-1:AC-003', testSource: 'tests/duplicate.test.mjs', line: 3,
        identity: { framework: 'node:test', suitePath: [], name: 'same' }, gaps: ['DUPLICATE_DECLARATION'] }
    ]
  };
  const findings = unknownCriterionTags(null, tags);
  // Submission reviews only an identified test with no gaps; that is the one refused here too.
  assert.deepEqual(findings.map((finding) => [finding.path, finding.line, finding.clauseId]),
    [['tests/example.test.mjs', 4, 'LITE-1:AC-001']]);
  assert.match(findings[0].message, /this Story has no specification index, so no test can witness one/);
  // A criterion an earlier artifact's text makes the step owe cannot be repaired by removing its tag.
  const [owed] = unknownCriterionTags(null, { ...tags, owed: ['LITE-1:AC-001'] });
  assert.match(owed.message, /names a criterion this step owes, but this Story has no specification index, so submission cannot review the test that witnesses it/);
});

test('an indexed Story owes only the criteria its specification defines, never ones its prose names', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-indexed-acceptance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const item = path.join(root, 'singularity/work-items/SPEC-1');
  await mkdir(path.join(item, 'artifacts/specification'), { recursive: true });
  await mkdir(path.join(item, 'context/spec-indexes'), { recursive: true });
  await writeFile(path.join(item, 'artifacts/specification/spec.md'),
    '# Specification\n\n- Retries start a new attempt. [SPEC-1:REQ-001]\n\nA reviewer once called this SPEC-1:AC-001.\n');
  const index = path.join(item, 'context/spec-indexes/specification-gen1.json');
  await writeFile(index, JSON.stringify({
    schemaVersion: 1, kind: 'specification-index', workId: 'SPEC-1', phase: 'specification', generation: 1,
    clauses: [indexedClause('SPEC-1:REQ-001')]
  }));
  const workflow = {
    workItem: { id: 'SPEC-1' }, phaseOrder: ['specification', 'implementation'], resolution: {},
    phases: {
      specification: { id: 'specification', generation: 1, requiredArtifact: { path: 'artifacts/specification/spec.md', kind: 'requirements' } },
      implementation: { id: 'implementation', generation: 0, generationPolicy: { task: 'code' } }
    }
  };
  const config = { governance: { requireAcceptanceCriteriaTags: true }, workItemRoot: 'singularity/work-items' };
  assert.deepEqual(await acceptanceIds(root, config, workflow, workflow.phases.implementation), [],
    'a criterion named only in prose is not one the step owes');
  // A Story without an index keeps the legacy reading of its earlier artifacts.
  await rm(index);
  assert.deepEqual(await acceptanceIds(root, config, workflow, workflow.phases.implementation), ['SPEC-1:AC-001']);
});

test('each criterion tag keeps its own line for a refusal to name', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-tag-locations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'tests', 'pay.test.mjs'),
    "import test from 'node:test';\n// @ac:PAY-1:AC-002\ntest('a', () => {});\n\n// @ac:PAY-1:AC-001\ntest('b', () => {});\n");
  const tags = await taggedAcceptanceIds(root, ['tests/pay.test.mjs']);
  assert.deepEqual(tags.locations, [
    { clauseId: 'PAY-1:AC-002', testSource: 'tests/pay.test.mjs', line: 2 },
    { clauseId: 'PAY-1:AC-001', testSource: 'tests/pay.test.mjs', line: 5 }
  ]);
});

test('publication recognizes every acceptance marker on one real test comment, not literal copies', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-multitag-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tests'));
  const testSource = 'tests/hex.test.jsx';
  await writeFile(path.join(root, testSource), [
    'const fake = "// @ac:A-HEX:AC-009";',
    '// @ac:A-HEX:AC-001 @ac:a-hex:AC-005 @ac:A-HEX:AC-006',
    'it("converts the displayed result", () => { expect(convert("255")).toBe("0xFF"); });'
  ].join('\n'));
  const found = await taggedAcceptanceIds(root, [testSource]);
  assert.deepEqual(found.ids, ['A-HEX:AC-001', 'A-HEX:AC-005', 'A-HEX:AC-006']);
  assert.deepEqual(found.locations.map(({ clauseId, line }) => [clauseId, line]),
    found.ids.map(id => [id, 2]));
  assert.ok(found.bindings.every(entry => entry.testSource === testSource));
});

test('blocking conformance verdicts are parsed from comparison table rows only', () => {
  const report = [
    'The prose may discuss missing context without declaring a verdict.',
    '| Clause ID | Requirement | Code | Tests | Verdict | Deviation |',
    '|---|---|---|---|---|---|',
    '| `APP:AC-001` | x | y | z | `matched` | |',
    '| `APP:AC-002` | x | y | z | `partial` | needs work |',
    '| `APP:AC-003` | x | y | z | `missing` | absent |'
  ].join('\n');
  assert.deepEqual(blockingConformanceVerdicts(report), [
    { clauseId: 'APP:AC-002', verdict: 'partial' },
    { clauseId: 'APP:AC-003', verdict: 'missing' }
  ]);
});

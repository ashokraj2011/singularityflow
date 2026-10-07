import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildSpecIndex,
  changedRepositoryPaths,
  deriveObservedClaimMap,
  derivePlannedClaimMap,
  evaluateSpecAcceptance,
  evaluateSpecCoverage,
  extractClauses,
  isSpecificationDefinitionPhase,
  canonicalJson,
  loadBoundActiveSpecRecords,
  mergeObservedClaimRecords,
  mergePlannedClaimRecords,
  normalizeClaimMap,
  normalizeSpecPolicy,
  plannedProductSourcePaths,
  renderClauseContext,
  runSpecAcceptance, selectActiveSpecRecords, specificationSourceTreeHash,
  selectClauseContext, traceClause
} from '../src/specifications.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { run } from '../src/util.mjs';

const markdown = `# Governed specification

[APP:REQ-001]
The service accepts a rule request.

[APP:AC-001]
Depends on APP:REQ-001. A valid request returns a result.
`;

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('specification clauses are stable, typed, and dependency checked', () => {
  const clauses = extractClauses(markdown, { sourcePath: 'spec.md', namespace: 'APP' });
  assert.deepEqual(clauses.map((clause) => clause.id), ['APP:REQ-001', 'APP:AC-001']);
  assert.deepEqual(clauses[1].dependsOn, ['APP:REQ-001']);
  assert.equal(clauses[0].source.line, 3);
  assert.throws(() => extractClauses(`${markdown}\n[APP:REQ-001]\nduplicate`), /duplicated/);
  assert.throws(() => extractClauses('[APP:AC-001]\nDepends on APP:REQ-999.'), /missing dependency/);
  assert.equal(extractClauses('[APP:AC-001]\nDepends on APP:REQ-999.', {
    externalClauseIds: ['APP:REQ-999']
  })[0].dependsOn[0], 'APP:REQ-999');
  assert.equal(extractClauses('`[APP:REQ-001]` and not a governed clause').length, 0);
  assert.throws(() => extractClauses('[APP:REQ-001]\nAPP:REQ-002\n\n[APP:REQ-002]\nAPP:REQ-001'), /dependency cycle/);
  assert.equal(extractClauses('[app:ac-001]\nImplemented.')[0].id, 'APP:AC-001');
  assert.throws(() => extractClauses('[APP:AC-002]\nDepends on APP:REQ-001.', {
    externalClauses: [{ id: 'APP:REQ-001', dependsOn: ['APP:AC-002'] }]
  }), /dependency cycle/);
});

test('a clause body is the statement its anchor identifies, wherever the anchor sits', () => {
  const trailing = [
    '## Requirements', '',
    '- Export the results as CSV. *(S1)* [W-1:REQ-001]',
    '- Import a workbook. *(S1, S2)* [W-1:REQ-002]', '',
    '- A file downloads. *(S1)* [W-1:AC-001]', '',
    '## Out of scope', '', 'PDF export.', ''
  ].join('\n');
  const clauses = extractClauses(trailing);
  assert.deepEqual(clauses.map((clause) => clause.body), [
    'Export the results as CSV. *(S1)*', 'Import a workbook. *(S1, S2)*', 'A file downloads. *(S1)*'
  ]);
  // Editing one requirement changes that requirement's hash and no other.
  const edited = extractClauses(trailing.replace('Import a workbook.', 'Import a workbook or CSV.'));
  assert.equal(edited[0].bodySha256, clauses[0].bodySha256);
  assert.notEqual(edited[1].bodySha256, clauses[1].bodySha256);
  assert.equal(edited[2].bodySha256, clauses[2].bodySha256);

  const table = extractClauses('| ID | Outcome | Measure |\n|---|---|---|\n| [W:AC-001] | Login works | 200 OK |\n| [W:AC-002] | Logout works | session cleared |\n');
  assert.deepEqual(table.map((clause) => clause.body), ['Login works | 200 OK', 'Logout works | session cleared']);

  const ownLine = extractClauses('[W:REQ-001]\n\nThe system exports CSV.\n\n[W:REQ-002]\nThe system imports XLSX.\n');
  assert.deepEqual(ownLine.map((clause) => clause.body), ['The system exports CSV.', 'The system imports XLSX.']);

  const heading = extractClauses('## [W:REQ-001] Export\n\nUsers export a CSV of results.\n\n- Must download within 2 s [W:AC-001]\n\n## Next\n\nOther.\n');
  assert.deepEqual(heading.map((clause) => clause.body), ['Export\nUsers export a CSV of results.', 'Must download within 2 s']);

  const shared = extractClauses('Do X now [W:REQ-001]. Do Y later [W:REQ-002].\n');
  assert.deepEqual(shared.map((clause) => clause.body), ['Do X now', 'Do Y later']);
  assert.equal(extractClauses('Users can log in [W:REQ-001] using SSO.\n')[0].body, 'Users can log in using SSO.');

  // A guidance paragraph with an example citation is not part of any clause, so it is no dependency.
  const guided = extractClauses('- Real requirement. [W-1:REQ-001]\n\nUse anchors here too (for example `[W-1:REQ-003]`).\n');
  assert.deepEqual(guided[0].dependsOn, []);
});

test('clause references normalize mixed case without matching another identity suffix', () => {
  const clauses = extractClauses('[Hex-Last:req-001] Convert signed integers.\n\n[hex-last:ac-001] Depends on HeX-LaSt:rEq-001. Ignore OTHER:REQ-001-extra.\n');
  assert.deepEqual(clauses.map(clause => clause.id), ['HEX-LAST:REQ-001', 'HEX-LAST:AC-001']);
  assert.deepEqual(clauses[1].dependsOn, ['HEX-LAST:REQ-001']);
  assert.throws(() => extractClauses('[Hex-Last:REQ-001] First.\n[hex-last:req-001] Duplicate.\n'), /duplicated/);
  assert.throws(() => extractClauses('[hex-last:ac-001] Depends on hex-last:req-999.\n'), /missing dependency/);
});

test('approved source/test overlaps project exact test roles without rewriting the plan', () => {
  const id = 'APP:AC-001';
  const map = { claims: { [id]: { expectedPaths: ['src/app.mjs', 'test/app.test.mjs'],
    tests: ['test/app.test.mjs'], fulfillment: 'new' } } };
  const original = structuredClone(map);
  const delivery = { sourcePaths: ['src/app.mjs'], testPaths: ['test/app.test.mjs'], traceability: {
    sourceBindings: [{ clauseId: 'app:ac-001', sourcePath: 'src/app.mjs' }],
    bindings: [{ clauseId: 'App:ac-001', testSource: 'test/app.test.mjs' }]
  } };
  const observed = deriveObservedClaimMap(map, delivery, { requireSourceBindings: true });
  assert.equal(observed.claims[id].verdict, 'matched');
  assert.deepEqual(observed.claims[id].observedPaths, ['src/app.mjs']);
  assert.equal(mergeObservedClaimRecords([observed], map.claims)[id].verdict, 'matched');
  assert.deepEqual(map, original, 'approved bytes/identity are not rewritten');
  const noTests = deriveObservedClaimMap(map, { ...delivery, testPaths: [] }, { requireSourceBindings: true });
  assert.equal(noTests.claims[id].verdict, 'partial', 'product source is not test execution or even test presence');
  const noSource = deriveObservedClaimMap(map, { ...delivery, sourcePaths: [] }, { requireSourceBindings: true });
  assert.equal(noSource.claims[id].verdict, 'partial');
  assert.equal(mergeObservedClaimRecords([noSource], map.claims)[id].verdict, 'partial');
  const testsOnly = { claims: { [id]: { expectedPaths: ['test/app.test.mjs'],
    tests: ['test/app.test.mjs'], fulfillment: 'new' } } };
  const invalid = deriveObservedClaimMap(testsOnly, delivery, { requireSourceBindings: true });
  assert.equal(invalid.claims[id].verdict, 'partial', 'new delivery cannot become test-only implicitly');
  assert.equal(mergeObservedClaimRecords([invalid], testsOnly.claims)[id].verdict, 'partial');
  assert.deepEqual(plannedProductSourcePaths({ expectedPaths: ['src/app.mjs'], tests: ['src/app.mjs'] }), ['src/app.mjs'],
    'declaring product code a test cannot erase its source obligation');
});

test('new planning tables reject role collisions before any code generation', () => {
  const table = paths => '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |\n'
    + '|---|---|---|---|---|\n'
    + `| app:req-001 | ${paths} | \`test/app.test.mjs\` | new | Conversion works |\n`;
  assert.throws(() => derivePlannedClaimMap(table('`src/app.mjs`, `test/app.test.mjs`'), {
    clauseIds: ['APP:REQ-001']
  }), error => error.code === 'SPEC_PLANNED_PATH_ROLE_INVALID');
  assert.throws(() => derivePlannedClaimMap(table('`test/helper.mjs`'), {
    clauseIds: ['APP:REQ-001']
  }), error => error.code === 'SPEC_PLANNED_PATH_ROLE_INVALID');
  const { claimMap: map } = derivePlannedClaimMap(table('`src/app.mjs`'), { clauseIds: ['APP:REQ-001'] });
  assert.deepEqual(map.claims['APP:REQ-001'].expectedPaths, ['src/app.mjs']);
  const { claimMap: testOnly } = derivePlannedClaimMap(table('-').replace('| new |', '| test-only |'), { clauseIds: ['APP:REQ-001'] });
  assert.equal(testOnly.claims['APP:REQ-001'].fulfillment, 'test-only');
});

test('a later phase cannot redefine a clause an earlier phase defined', () => {
  const earlier = extractClauses('[W-1:REQ-001] Export CSV.\n', { sourcePath: 'requirements.md' });
  assert.throws(
    () => extractClauses('[W-1:REQ-001] Export XLSX instead.\n', { sourcePath: 'implementation-spec.md', externalClauses: earlier }),
    (error) => error.code === 'SPEC_CLAUSE_REDEFINED' && /requirements\.md line 1/.test(error.message)
  );
  const citing = extractClauses('[W-1:IFC-001] The exporter implements W-1:REQ-001.\n', { externalClauses: earlier });
  assert.deepEqual(citing[0].dependsOn, ['W-1:REQ-001']);
});

test('specification clauses never absorb kernel-managed approved inputs', () => {
  const [clause] = extractClauses([
    '# Requirements', '', '[APP:AC-001]', 'Producer-owned acceptance.', '',
    '<!-- singularity-flow:inputs:start -->', '[APP:REQ-999] Prior governed input.',
    '<!-- singularity-flow:inputs:end -->'
  ].join('\n'), { sourcePath: 'requirements.md', namespace: 'APP' });
  assert.equal(clause.body, 'Producer-owned acceptance.');
  assert.deepEqual(clause.dependsOn, []);
});

test('a specification index binds clauses to the exact source bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-index-'));
  await mkdir(path.join(root, 'artifacts'));
  await writeFile(path.join(root, 'artifacts', 'requirements.md'), markdown);
  const index = await buildSpecIndex(root, 'artifacts/requirements.md', {
    workId: 'WORK-1', phase: 'requirements', generation: 1,
    outputPath: 'context/spec-indexes/requirements-gen1.json',
    policy: { mode: 'record', namespace: 'APP' }
  });
  assert.equal(index.clauses.length, 2);
  assert.match(index.indexSha256, /^[0-9a-f]{64}$/);
  const stored = JSON.parse(await readFile(path.join(root, 'context/spec-indexes/requirements-gen1.json'), 'utf8'));
  assert.equal(stored.source.sha256, index.source.sha256);
});

test('spec index can inspect a standalone repository file before a Story exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-standalone-spec-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  await writeFile(path.join(root, 'candidate.md'), markdown);
  const result = spawnSync(process.execPath, [cli, 'spec', 'index', 'candidate.md'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.active-workspace.json'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.workspaces.json')
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Indexed 2 standalone clause/);
  const stored = JSON.parse(await readFile(path.join(root, '.git', 'singularity-flow', 'spec-indexes', 'candidate.md.json'), 'utf8'));
  assert.equal(stored.workId, null);
  assert.equal(stored.phase, null);
  assert.equal(stored.clauses.length, 2);
});

test('claim maps, coverage, and clause-scoped context preserve traceability', () => {
  const index = { clauses: extractClauses(markdown, { sourcePath: 'spec.md' }) };
  const planned = normalizeClaimMap({
    'APP:REQ-001': { expectedPaths: ['src/app.mjs'], tests: ['test/app.test.mjs'] },
    'APP:AC-001': { expectedPaths: ['src/app.mjs'], tests: ['test/app.test.mjs'] }
  }, { kind: 'planned', clauseIds: index.clauses.map((clause) => clause.id), policy: { mode: 'record' } });
  const observed = normalizeClaimMap({
    'APP:REQ-001': { observedPaths: ['src/app.mjs'], testResults: ['test/app.test.mjs'], verdict: 'matched' },
    'APP:AC-001': { observedPaths: ['src/app.mjs'], testResults: ['test/app.test.mjs'], verdict: 'matched' }
  }, { kind: 'observed', clauseIds: index.clauses.map((clause) => clause.id), policy: { mode: 'record' } });
  const coverage = evaluateSpecCoverage({ indexes: [index], planned: [planned], observed: [observed] }, ['src/app.mjs'], { coverage: 'enforce' });
  assert.equal(coverage.complete, true);
  const selected = selectClauseContext([index], ['APP:AC-001'], { includeDependencies: true });
  assert.deepEqual(selected.map((clause) => clause.id), ['APP:AC-001', 'APP:REQ-001']);
  assert.match(renderClauseContext(selected), /Selected specification clauses/);
  assert.throws(() => normalizeClaimMap({
    'APP:AC-001': { verdict: 'matched', observedPaths: [] }
  }, { kind: 'observed', clauseIds: ['APP:AC-001'], policy: { mode: 'record' } }), /source evidence/);
  assert.ok(normalizeClaimMap({
    'app:ac-001': { verdict: 'matched', observedPaths: ['src/app.mjs'] }
  }, { kind: 'observed', clauseIds: ['APP:AC-001'], policy: { mode: 'record' } }).claims['APP:AC-001']);
});

test('a justified test not-applicable still requires exact implemented source paths', () => {
  const id = 'APP:REQ-001';
  const planned = normalizeClaimMap({ claims: {
    [id]: {
      expectedPaths: ['src/implementation.mjs'], tests: [],
      testDisposition: 'not-applicable', testReason: 'Compile-time type contract has no runtime test.'
    }
  } }, { kind: 'planned', clauseIds: [id] });
  const missing = deriveObservedClaimMap(planned, { sourcePaths: [] }, { clauseIds: [id] });
  assert.deepEqual(Object.keys(missing.claims), []);
  assert.deepEqual(evaluateSpecCoverage({
    indexes: [{ clauses: [{ id }] }], planned: [planned], observed: [missing]
  }, [], { coverage: 'enforce' }).unimplemented, [id]);

  const observed = deriveObservedClaimMap(planned, {
    sourcePaths: ['src/implementation.mjs'],
    traceability: { sourceBindings: [{ clauseId: id, sourcePath: 'src/implementation.mjs' }] }
  }, { clauseIds: [id], requireSourceBindings: true });
  assert.deepEqual(observed.claims[id].observedPaths, ['src/implementation.mjs']);
  assert.equal(observed.claims[id].verdict, 'matched');
  assert.equal(evaluateSpecCoverage({
    indexes: [{ clauses: [{ id }] }], planned: [planned], observed: [observed]
  }, ['src/implementation.mjs'], { coverage: 'enforce' }).complete, true);
});

test('live governance ignores historical specification generations', () => {
  const workflow = {
    workItem: { id: 'WORK-1' },
    phases: { requirements: { generation: 2, requiredArtifact: { kind: 'requirements' } } }
  };
  const current = { workId: 'WORK-1', phase: 'requirements', generation: 2, clauses: [{ id: 'APP:REQ-002' }] };
  const selected = selectActiveSpecRecords({
    indexes: [
      { workId: 'WORK-1', phase: 'requirements', generation: 1, clauses: [{ id: 'APP:REQ-001' }] },
      current,
      { workId: 'OTHER', phase: 'requirements', generation: 2, clauses: [{ id: 'APP:REQ-999' }] }
    ]
  }, workflow);
  assert.deepEqual(selected.indexes, [current]);
});

test('reference-only phase indexes are preserved but excluded from active specification arithmetic', () => {
  const workflow = {
    workItem: { id: 'WORK-1' },
    phases: {
      specification: { generation: 1, requiredArtifact: { kind: 'requirements' } },
      implementation: { generation: 1, requiredArtifact: { kind: 'implementation-spec' } },
      release: { generation: 1, requiredArtifact: { kind: 'conformance-report' } }
    }
  };
  const specification = { workId: 'WORK-1', phase: 'specification', generation: 1, clauses: [{ id: 'APP:REQ-001' }] };
  const implementation = { workId: 'WORK-1', phase: 'implementation', generation: 1, clauses: [{ id: 'APP:AC-001' }] };
  const legacyRelease = { workId: 'WORK-1', phase: 'release', generation: 1, clauses: [{ id: 'APP:CON-044' }] };
  const selected = selectActiveSpecRecords({ indexes: [legacyRelease, specification, implementation] }, workflow);
  assert.deepEqual(selected.indexes, [implementation, specification].sort((a, b) => a.phase.localeCompare(b.phase)));
  assert.equal(isSpecificationDefinitionPhase(workflow.phases.specification), true);
  assert.equal(isSpecificationDefinitionPhase(workflow.phases.implementation), true);
  assert.equal(isSpecificationDefinitionPhase(workflow.phases.release), false);
  assert.equal(selected.indexes.includes(legacyRelease), false);
});

test('pinned planned-claim topology selects only its validated authoritative clause phases', () => {
  const workflow = {
    workItem: { id: 'WORK-1' },
    resolution: {
      plannedClaims: { mode: 'required', clausePhases: ['intake', 'release'], owners: { implementation: 'design' } }
    },
    phases: {
      intake: { generation: 1, requiredArtifact: { kind: 'requirements' } },
      laterSpec: { generation: 1, requiredArtifact: { kind: 'implementation-spec' } },
      release: { generation: 1, requiredArtifact: { kind: 'conformance-report' } }
    }
  };
  const intake = { workId: 'WORK-1', phase: 'intake', generation: 1, clauses: [{ id: 'APP:AC-001' }] };
  const unselected = { workId: 'WORK-1', phase: 'laterSpec', generation: 1, clauses: [{ id: 'APP:REQ-002' }] };
  const malformedPinnedReport = { workId: 'WORK-1', phase: 'release', generation: 1, clauses: [{ id: 'APP:REQ-999' }] };
  const selected = selectActiveSpecRecords({ indexes: [intake, unselected, malformedPinnedReport] }, workflow);
  assert.deepEqual(selected.indexes, [intake]);
});

async function boundClaimFixture({ testOnly = false, planPhase = 'planning', codePhase = 'implementation' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-bound-claims-'));
  const itemDirectory = path.join(root, 'singularity/work-items/BOUND-1');
  const claimsDirectory = path.join(itemDirectory, 'context/claims');
  await mkdir(claimsDirectory, { recursive: true });
  const planned = {
    schemaVersion: currentSchemaVersion('specification-claim-map'),
    kind: 'planned', recordedAt: '2026-08-31T00:00:00.000Z',
    workId: 'BOUND-1', phase: planPhase, generation: 1,
    claims: { 'APP:REQ-001': {
      expectedPaths: testOnly ? [] : ['src/app.mjs'], tests: ['test/app.test.mjs'],
      ...(testOnly ? { fulfillment: 'test-only' } : {}),
      testDisposition: 'applicable', testReason: null, deviation: null
    } }
  };
  const observed = {
    schemaVersion: currentSchemaVersion('specification-claim-map'),
    kind: 'observed', recordedAt: '2026-08-31T00:01:00.000Z',
    workId: 'BOUND-1', phase: codePhase, generation: 1,
    claims: { 'APP:REQ-001': {
      observedPaths: testOnly ? [] : ['src/app.mjs'], testResults: ['test/app.test.mjs'],
      commits: ['a'.repeat(40)], verdict: 'matched', deviation: null
    } }
  };
  const plannedPath = `singularity/work-items/BOUND-1/context/claims/${planPhase}-gen1-planned.json`;
  const observedPath = `singularity/work-items/BOUND-1/context/claims/${codePhase}-gen1-observed.json`;
  await writeFile(path.join(root, plannedPath), canonicalJson(planned));
  await writeFile(path.join(root, observedPath), canonicalJson(observed));
  const digest = (record) => createHash('sha256').update(canonicalJson(record)).digest('hex');
  const workflow = {
    workItem: { id: 'BOUND-1' },
    resolution: {
      plannedClaims: {
        mode: 'required', clausePhases: ['requirements'], owners: { [codePhase]: planPhase }
      }
    },
    phases: {
      requirements: { id: 'requirements', generation: 0, requiredArtifact: { kind: 'requirements' } },
      [planPhase]: {
        id: planPhase, generation: 1,
        claimMaps: { planned: { generation: 1, path: plannedPath, sha256: digest(planned) } }
      },
      [codePhase]: {
        id: codePhase, generation: 1,
        claimMaps: { observed: { generation: 1, path: observedPath, sha256: digest(observed) } }
      }
    }
  };
  return { root, itemDirectory, planned, plannedPath, workflow };
}

test('test-only requirements reload in workflows with custom plan and code phase identities', async (t) => {
  const fixture = await boundClaimFixture({ testOnly: true, planPhase: 'custom-test-plan', codePhase: 'custom-test-authoring' });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const records = await loadBoundActiveSpecRecords(fixture.root, fixture.itemDirectory, fixture.workflow,
    { mode: 'enforce', acceptance: 'presence' });
  assert.equal(records.planned[0].phase, 'custom-test-plan');
  assert.equal(records.observed[0].phase, 'custom-test-authoring');
  assert.equal(records.observed[0].claims['APP:REQ-001'].verdict, 'matched');
});

test('planned-only draft inspection needs no first-generation observed map but retains plan integrity', async (t) => {
  const fixture = await boundClaimFixture({ planPhase: 'my-plan', codePhase: 'my-build' });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  fixture.workflow.phases['my-build'].generation = 0;
  delete fixture.workflow.phases['my-build'].claimMaps;
  const load = options => loadBoundActiveSpecRecords(fixture.root, fixture.itemDirectory, fixture.workflow,
    { mode: 'enforce' }, options);
  await assert.rejects(load(), error => error.code === 'SPECIFICATION_CLAIM_MAP_BINDING_REQUIRED');
  const records = await load({ plannedOnly: true });
  assert.equal(records.planned[0].phase, 'my-plan');
  assert.deepEqual(records.observed, []);
  await assert.rejects(load({ plannedOnly: true, requireCommitted: true }),
    error => error.code === 'SPECIFICATION_CLAIM_MAP_BINDING_REQUIRED');
  fixture.workflow.phases['my-plan'].claimMaps.planned.sha256 = 'f'.repeat(64);
  await assert.rejects(load({ plannedOnly: true }), error => error.code === 'SPECIFICATION_CLAIM_MAP_BINDING_STALE');
});

test('bound claim readers honor only the observed phase owner, not a stray test-only plan', async (t) => {
  const fixture = await boundClaimFixture({ testOnly: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const load = () => loadBoundActiveSpecRecords(fixture.root, fixture.itemDirectory, fixture.workflow,
    { mode: 'enforce', acceptance: 'presence' });
  const records = await load();
  assert.equal(records.observed[0].claims['APP:REQ-001'].verdict, 'matched');
  assert.deepEqual(records.observed[0].claims['APP:REQ-001'].observedPaths, []);
  const other = structuredClone(fixture.planned);
  other.phase = 'other-plan';
  other.claims['APP:REQ-001'].expectedPaths = ['src/app.mjs'];
  other.claims['APP:REQ-001'].fulfillment = 'modified';
  const relative = 'singularity/work-items/BOUND-1/context/claims/other-plan-gen1-planned.json';
  await writeFile(path.join(fixture.root, relative), canonicalJson(other));
  fixture.workflow.phases['other-plan'] = { id: 'other-plan', generation: 1,
    claimMaps: { planned: { generation: 1, path: relative,
      sha256: createHash('sha256').update(canonicalJson(other)).digest('hex') } } };
  fixture.workflow.resolution.plannedClaims.owners.implementation = 'other-plan';
  await assert.rejects(load, /must identify source evidence/,
    'the old test-only map still on disk cannot waive the new owner\'s source obligation');
});

test('bound terminal claim loading ignores unbound directory injection and rejects a missing pointer', async () => {
  const fixture = await boundClaimFixture();
  const injected = {
    ...fixture.planned,
    recordedAt: '2026-08-31T00:02:00.000Z',
    claims: { 'APP:REQ-001': {
      expectedPaths: ['src/injected.mjs'], tests: ['test/injected.test.mjs'],
      testDisposition: 'applicable', testReason: null, deviation: null
    } }
  };
  await writeFile(
    path.join(fixture.itemDirectory, 'context/claims/unbound-injected.json'),
    canonicalJson(injected)
  );
  const records = await loadBoundActiveSpecRecords(
    fixture.root, fixture.itemDirectory, fixture.workflow, { mode: 'enforce', acceptance: 'presence' }
  );
  assert.equal(records.planned.length, 1);
  assert.deepEqual(records.planned[0].claims['APP:REQ-001'].tests, ['test/app.test.mjs']);

  const historical = structuredClone(fixture.workflow);
  delete historical.resolution.plannedClaims;
  const historicalRecords = await loadBoundActiveSpecRecords(
    fixture.root, fixture.itemDirectory, historical, { mode: 'enforce', acceptance: 'presence' }
  );
  assert.equal(historicalRecords.planned.length, 2,
    'a historical snapshot without plannedClaims lost its directory compatibility path');

  delete fixture.workflow.phases.planning.claimMaps.planned;
  await assert.rejects(
    () => loadBoundActiveSpecRecords(
      fixture.root, fixture.itemDirectory, fixture.workflow, { mode: 'enforce', acceptance: 'presence' }
    ),
    /no authoritative planned claim-map binding/
  );
});

test('bound terminal claim loading rejects bytes changed after their workflow digest was pinned', async () => {
  const fixture = await boundClaimFixture();
  const tampered = structuredClone(fixture.planned);
  tampered.claims['APP:REQ-001'].tests = ['test/tampered.test.mjs'];
  await writeFile(path.join(fixture.root, fixture.plannedPath), canonicalJson(tampered));
  await assert.rejects(
    () => loadBoundActiveSpecRecords(
      fixture.root, fixture.itemDirectory, fixture.workflow, { mode: 'enforce', acceptance: 'presence' }
    ),
    /planned claim map changed after publication/
  );
});

test('an approved no-change route does not require observed claim maps from its skipped repair phase', async () => {
  const fixture = await boundClaimFixture();
  fixture.workflow.phases.implementation.status = 'skipped';
  delete fixture.workflow.phases.implementation.claimMaps.observed;
  const records = await loadBoundActiveSpecRecords(fixture.root, fixture.itemDirectory, fixture.workflow);
  assert.equal(records.planned.length, 1, 'the approved conditional plan remains bound');
  assert.deepEqual(records.observed, [], 'a repair that never ran must not manufacture observations');
  fixture.workflow.phases.implementation.status = 'approved';
  await assert.rejects(() => loadBoundActiveSpecRecords(fixture.root, fixture.itemDirectory, fixture.workflow),
    /no authoritative observed claim-map binding/, 'executed repair still requires its bound map');
});

test('planned claims are derived only from an exact structured Markdown table', () => {
  const source = `# Plan

| Clause | Expected paths | Planned tests |
| --- | --- | --- |
| [APP:REQ-001] | \`src/app.mjs\` | \`test/app.test.mjs\` |
| APP:AC-001 | \`src/app.mjs\`, \`src/validation.mjs\` | not-applicable: verified by a compile-time invariant |
`;
  const { claimMap, missingClauseIds, missingTestClauseIds } = derivePlannedClaimMap(source, {
    clauseIds: ['APP:REQ-001', 'APP:AC-001'], policy: { mode: 'enforce' }
  });
  assert.deepEqual(missingClauseIds, []);
  assert.deepEqual(missingTestClauseIds, []);
  assert.deepEqual(claimMap.claims['APP:REQ-001'].tests, ['test/app.test.mjs']);
  assert.equal(claimMap.claims['APP:REQ-001'].testDisposition, 'applicable');
  assert.deepEqual(claimMap.claims['APP:AC-001'].expectedPaths, ['src/app.mjs', 'src/validation.mjs']);
  assert.equal(claimMap.claims['APP:AC-001'].testDisposition, 'not-applicable');
  assert.match(claimMap.claims['APP:AC-001'].testReason, /compile-time invariant/);
  assert.equal(evaluateSpecAcceptance({
    indexes: [{ clauses: extractClauses(markdown) }], planned: [claimMap]
  }, { acceptance: 'presence' }).complete, true);
});

test('planned claim derivation ignores fenced, commented, and kernel-managed tables', () => {
  const hidden = `| Clause | Expected paths | Planned tests |
| --- | --- | --- |
| APP:REQ-999 | src/not-backticked.mjs | \`test/*.mjs\` |`;
  const source = `# Plan

\`\`\`markdown
${hidden}
\`\`\`

<!--
${hidden}
-->

| Clause | Expected paths | Planned tests |
| --- | --- | --- |
| APP:REQ-001 | \`src/app.mjs\` | \`test/app.test.mjs\` |

<!-- singularity-flow:inputs:start -->
${hidden}
<!-- singularity-flow:inputs:end -->
`;
  const result = derivePlannedClaimMap(source, { clauseIds: ['APP:REQ-001'] });
  assert.deepEqual(Object.keys(result.claimMap.claims), ['APP:REQ-001']);
  assert.deepEqual(result.missingTestClauseIds, []);
});

test('planned claim derivation reports rows that did not bind a test obligation', () => {
  const result = derivePlannedClaimMap(`
| Clause | Expected paths | Planned tests |
| --- | --- | --- |
| APP:REQ-001 | \`src/app.mjs\` | - |
`, { clauseIds: ['APP:REQ-001', 'APP:AC-001'] });
  assert.deepEqual(result.missingClauseIds, ['APP:AC-001']);
  assert.deepEqual(result.missingTestClauseIds, ['APP:AC-001', 'APP:REQ-001']);
});

test('planned claim parsing rejects duplicates, unknown clauses, and non-exact paths', () => {
  const table = (row) => `| Clause | Expected paths | Planned tests |\n| --- | --- | --- |\n${row}\n`;
  assert.throws(() => derivePlannedClaimMap(table('| APP:REQ-999 | `src/app.mjs` | `test/app.test.mjs` |'), {
    clauseIds: ['APP:REQ-001']
  }), /unknown clause APP:REQ-999/);
  assert.throws(() => derivePlannedClaimMap(table('| APP:REQ-001 | src/app.mjs | `test/app.test.mjs` |'), {
    clauseIds: ['APP:REQ-001']
  }), /must list each exact/);
  assert.throws(() => derivePlannedClaimMap(table('| APP:REQ-001 | `src/*.mjs` | `test/app.test.mjs` |'), {
    clauseIds: ['APP:REQ-001']
  }), /without traversal, globs, placeholders/);
  assert.throws(() => derivePlannedClaimMap(table('| APP:REQ-001 | `../src/app.mjs` | `test/app.test.mjs` |'), {
    clauseIds: ['APP:REQ-001']
  }), /without traversal, globs, placeholders/);
  assert.throws(() => derivePlannedClaimMap(`${table('| APP:REQ-001 | `src/app.mjs` | `test/app.test.mjs` |')}\n${table('| APP:REQ-001 | `src/app.mjs` | `test/app.test.mjs` |')}`, {
    clauseIds: ['APP:REQ-001']
  }), /more than once/);
});

test('observed claims use exact changed and tested paths without proximity inference', () => {
  const { claimMap: planned } = derivePlannedClaimMap(`
| Clause | Expected paths | Planned tests |
| --- | --- | --- |
| APP:REQ-001 | \`src/app.mjs\` | \`test/app.test.mjs\` |
| APP:AC-001 | \`src/other.mjs\` | \`test/other.test.mjs\` |
`, { clauseIds: ['APP:REQ-001', 'APP:AC-001'] });
  const observed = deriveObservedClaimMap(planned, {
    changeSet: {
      sourcePaths: ['src/app.mjs', 'src/unplanned-neighbor.mjs'],
      executableTestPaths: ['test/app.test.mjs']
    },
    traceability: { bindings: [{ clauseId: 'APP:REQ-001', testSource: 'test/app.test.mjs' }] }
  }, {
    clauseIds: ['APP:REQ-001', 'APP:AC-001'],
    generationCommit: 'a'.repeat(40)
  });
  assert.deepEqual(Object.keys(observed.claims), ['APP:REQ-001']);
  assert.deepEqual(observed.claims['APP:REQ-001'], {
    observedPaths: ['src/app.mjs'],
    testResults: ['test/app.test.mjs'],
    commits: ['a'.repeat(40)],
    verdict: 'matched',
    deviation: null
  });
});

test('new observed claims require exact source and AC test bindings instead of path overlap', () => {
  const planned = normalizeClaimMap({ claims: {
    'APP:REQ-001': { expectedPaths: ['src/app.mjs'], tests: ['test/app.test.mjs'] },
    'APP:AC-001': { expectedPaths: ['src/app.mjs'], tests: ['test/app.test.mjs', 'test/extra.test.mjs'] }
  } }, { kind: 'planned', clauseIds: ['APP:REQ-001', 'APP:AC-001'] });
  const observed = deriveObservedClaimMap(planned, {
    sourcePaths: ['src/app.mjs'],
    testPaths: ['test/app.test.mjs', 'test/extra.test.mjs'],
    traceability: {
      sourceBindings: [{ clauseId: 'APP:REQ-001', sourcePath: 'src/app.mjs', line: 1, tag: 'clause' }],
      bindings: [{ clauseId: 'APP:AC-001', testSource: 'test/app.test.mjs' }]
    }
  }, { clauseIds: ['APP:REQ-001', 'APP:AC-001'], requireSourceBindings: true });
  assert.deepEqual(observed.claims['APP:REQ-001'].observedPaths, ['src/app.mjs']);
  assert.equal(observed.claims['APP:REQ-001'].verdict, 'matched');
  assert.deepEqual(observed.claims['APP:AC-001'].observedPaths, []);
  assert.deepEqual(observed.claims['APP:AC-001'].testResults, ['test/app.test.mjs']);
  assert.equal(observed.claims['APP:AC-001'].verdict, 'partial');
});

test('new definitions default to qualified conformance while explicit legacy remains available', () => {
  assert.equal(normalizeSpecPolicy().conformanceRows, 'qualified');
  assert.equal(normalizeSpecPolicy({ conformanceRows: 'qualified' }).conformanceRows, 'qualified');
  assert.equal(normalizeSpecPolicy({ conformanceRows: 'legacy' }).conformanceRows, 'legacy');
  assert.throws(() => normalizeSpecPolicy({ conformanceRows: 'guess' }), /spec.conformanceRows/);
});

test('acceptance clauses may carry exact test-only evidence without a fabricated source path', () => {
  const planned = normalizeClaimMap({ claims: {
    'APP:AC-001': { expectedPaths: [], tests: ['test/app.test.mjs'] },
    'APP:REQ-001': { expectedPaths: [], tests: ['test/app.test.mjs'] }
  } }, { kind: 'planned', clauseIds: ['APP:AC-001', 'APP:REQ-001'] });
  const observed = deriveObservedClaimMap(planned, {
    changeSet: { executableTestPaths: ['test/app.test.mjs'] },
    traceability: { bindings: [{ clauseId: 'APP:AC-001', testSource: 'test/app.test.mjs' }] }
  }, { clauseIds: ['APP:AC-001', 'APP:REQ-001'] });
  assert.equal(observed.claims['APP:AC-001'].verdict, 'matched');
  assert.deepEqual(observed.claims['APP:AC-001'].observedPaths, []);
  assert.equal(observed.claims['APP:REQ-001'], undefined,
    'a binding for one AC must not be inferred as evidence for another clause');
  assert.throws(() => normalizeClaimMap({ claims: {
    'APP:REQ-001': { observedPaths: [], testResults: ['test/app.test.mjs'], verdict: 'matched' }
  } }, { kind: 'observed', clauseIds: ['APP:REQ-001'] }), /must identify source evidence/);
});

test('an AC planned as test-only is covered by its delivered tests; one planned with source paths is not', () => {
  const index = { clauses: extractClauses('[APP:AC-001]\nThe rendered primary background is blue.') };
  const plannedRow = (expectedPaths) => normalizeClaimMap({ claims: {
    'APP:AC-001': { expectedPaths, tests: ['test/primary-background.spec.ts'] }
  } }, { kind: 'planned', clauseIds: ['APP:AC-001'] });
  const planned = plannedRow([]);
  const observed = normalizeClaimMap({ claims: {
    'APP:AC-001': {
      observedPaths: [],
      testResults: ['test/primary-background.spec.ts'],
      verdict: 'partial'
    }
  } }, { kind: 'observed', clauseIds: ['APP:AC-001'] });
  const coverage = evaluateSpecCoverage(
    { indexes: [index], planned: [planned], observed: [observed] },
    ['test/primary-background.spec.ts'],
    { coverage: 'enforce' }
  );
  assert.equal(coverage.complete, true);
  assert.deepEqual(coverage.unimplemented, []);
  assert.deepEqual(coverage.testPresenceOnly, ['APP:AC-001'], 'reported as covered by test presence alone');
  assert.deepEqual(coverage.unclaimedChangedPaths, []);
  assert.deepEqual(coverage.invalidEvidence, []);

  // The plan said the stylesheet changes. Delivering only the test is not the implementation.
  const withSource = evaluateSpecCoverage(
    { indexes: [index], planned: [plannedRow(['src/app.component.css'])], observed: [observed] },
    ['test/primary-background.spec.ts'],
    { coverage: 'enforce' }
  );
  assert.equal(withSource.complete, false);
  assert.deepEqual(withSource.unimplemented, ['APP:AC-001']);
  assert.deepEqual(withSource.testPresenceOnly, []);
});

test('explicit test-only requirements are valid without invented product paths, but only against their exact plan', () => {
  const id = 'HEX-HEX:REQ-007';
  const plan = normalizeClaimMap({ claims: {
    [id]: { expectedPaths: [], tests: ['src/App.test.jsx', 'src/hex.test.jsx'], fulfillment: 'test-only' }
  } }, { kind: 'planned', clauseIds: [id] });
  const observed = deriveObservedClaimMap(plan, { testPaths: ['src/App.test.jsx', 'src/hex.test.jsx'] }, { clauseIds: [id] });
  assert.equal(observed.claims[id].verdict, 'matched');
  assert.deepEqual(observed.claims[id].observedPaths, []);
  assert.deepEqual(normalizeClaimMap(observed, { kind: 'observed', clauseIds: [id], plannedClaims: plan.claims }).claims,
    observed.claims, 're-reading the map uses the same reviewed fulfillment');
  const partial = deriveObservedClaimMap(plan, { testPaths: ['src/App.test.jsx'] }, { clauseIds: [id] });
  assert.equal(partial.claims[id].verdict, 'partial');
  const index = { clauses: [{ id, type: 'REQ' }] };
  const coverage = evaluateSpecCoverage({ indexes: [index], planned: [plan], observed: [observed] },
    ['src/App.test.jsx', 'src/hex.test.jsx'], { coverage: 'enforce' });
  assert.equal(coverage.complete, true);
  assert.deepEqual(coverage.testPresenceOnly, [id], 'test file delivery is not described as passing tests');
  assert.equal(evaluateSpecCoverage({ indexes: [index], planned: [plan], observed: [partial] },
    ['src/App.test.jsx'], { coverage: 'enforce' }).complete, false);
  const later = deriveObservedClaimMap(plan, { testPaths: ['src/hex.test.jsx'] }, { clauseIds: [id] });
  assert.equal(evaluateSpecCoverage({ indexes: [index], planned: [plan], observed: [partial, later] },
    ['src/App.test.jsx', 'src/hex.test.jsx'], { coverage: 'enforce' }).complete, true,
  'exact evidence from multiple code intervals accumulates for test-only requirements');
  // A forged fulfillment in an observed record is not an authority to drop source evidence.
  assert.throws(() => normalizeClaimMap({ claims: { [id]: { ...observed.claims[id], fulfillment: 'test-only' } } },
    { kind: 'observed', clauseIds: [id] }), /must identify source evidence/);
  for (const bad of [
    { ...observed.claims[id], testResults: ['src/Other.test.jsx'] },
    { ...observed.claims[id], testResults: ['src/App.test.jsx'] },
    { ...observed.claims[id], testResults: [] },
    { ...observed.claims[id], observedPaths: ['src/App.jsx'] }
  ]) {
    assert.throws(() => normalizeClaimMap({ claims: { [id]: bad } },
      { kind: 'observed', clauseIds: [id], plannedClaims: plan.claims }),
    { code: 'SPEC_OBSERVED_TEST_ONLY_EVIDENCE_INVALID' });
    const badCoverage = evaluateSpecCoverage({ indexes: [index], planned: [plan], observed: [{ claims: { [id]: bad } }] },
      [], { coverage: 'enforce' });
    assert.equal(badCoverage.complete, false);
  }
});

test('test evidence never substitutes for non-AC source evidence', () => {
  const index = { clauses: extractClauses('[APP:REQ-001]\nThe application stores the selected background.') };
  const planned = normalizeClaimMap({ claims: {
    'APP:REQ-001': { expectedPaths: ['src/app.mjs'], tests: ['test/app.test.mjs'] }
  } }, { kind: 'planned', clauseIds: ['APP:REQ-001'] });
  const observed = normalizeClaimMap({ claims: {
    'APP:REQ-001': {
      observedPaths: [], testResults: ['test/app.test.mjs'], verdict: 'missing'
    }
  } }, { kind: 'observed', clauseIds: ['APP:REQ-001'] });
  const coverage = evaluateSpecCoverage(
    { indexes: [index], planned: [planned], observed: [observed] },
    ['test/app.test.mjs'],
    { coverage: 'enforce' }
  );
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.unimplemented, ['APP:REQ-001']);
  assert.deepEqual(coverage.unclaimedChangedPaths, [],
    'the exact planned test is owned even though it cannot prove the requirement alone');
});

test('terminal coverage accepts an exact changed deletion path but not unrelated missing source', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-deletion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const index = { clauses: extractClauses('[APP:REQ-001]\nThe obsolete behavior is removed.') };
  const planned = normalizeClaimMap({ claims: {
    'APP:REQ-001': { expectedPaths: ['src/obsolete.mjs'], tests: ['test/obsolete.test.mjs'] }
  } }, { kind: 'planned', clauseIds: ['APP:REQ-001'] });
  const observed = normalizeClaimMap({ claims: {
    'APP:REQ-001': {
      observedPaths: ['src/obsolete.mjs'], testResults: [], verdict: 'matched'
    }
  } }, { kind: 'observed', clauseIds: ['APP:REQ-001'] });
  const records = { indexes: [index], planned: [planned], observed: [observed] };
  const deleted = evaluateSpecCoverage(records, ['src/obsolete.mjs'], { coverage: 'enforce' }, { root });
  assert.deepEqual(deleted.invalidEvidence, []);
  const absentWithoutChange = evaluateSpecCoverage(records, [], { coverage: 'enforce' }, { root });
  assert.match(absentWithoutChange.invalidEvidence.join(' '), /missing source evidence/);
});

test('partial or unplanned AC test evidence remains terminally incomplete', () => {
  const index = { clauses: extractClauses('[APP:AC-001]\nBoth browser variants render blue.') };
  const planned = normalizeClaimMap({ claims: {
    'APP:AC-001': {
      expectedPaths: [],
      tests: ['test/chrome.spec.ts', 'test/firefox.spec.ts']
    }
  } }, { kind: 'planned', clauseIds: ['APP:AC-001'] });
  const observed = normalizeClaimMap({ claims: {
    'APP:AC-001': {
      observedPaths: [], testResults: ['test/chrome.spec.ts', 'test/unplanned.spec.ts'], verdict: 'partial'
    }
  } }, { kind: 'observed', clauseIds: ['APP:AC-001'] });
  const coverage = evaluateSpecCoverage(
    { indexes: [index], planned: [planned], observed: [observed] },
    ['test/chrome.spec.ts', 'test/unplanned.spec.ts'],
    { coverage: 'enforce' }
  );
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.unimplemented, ['APP:AC-001']);
  assert.deepEqual(coverage.unclaimedChangedPaths, ['test/unplanned.spec.ts']);
  assert.match(coverage.invalidEvidence.join(' '), /without source-path evidence/);
});

test('claim evidence accumulates across code phases instead of using the last record only', () => {
  const id = 'APP:REQ-001';
  const planned = [
    { phase: 'plan-a', generation: 1, claims: { [id]: {
      expectedPaths: ['src/a.mjs'], tests: ['test/a.test.mjs'], testDisposition: 'applicable', testReason: null
    } } },
    { phase: 'plan-b', generation: 1, claims: { [id]: {
      expectedPaths: ['src/b.mjs'], tests: ['test/b.test.mjs'], testDisposition: 'applicable', testReason: null
    } } }
  ];
  const mergedPlan = mergePlannedClaimRecords(planned);
  assert.deepEqual(mergedPlan[id].expectedPaths, ['src/a.mjs', 'src/b.mjs']);
  assert.deepEqual(mergedPlan[id].tests, ['test/a.test.mjs', 'test/b.test.mjs']);

  const observed = [
    { phase: 'code-a', generation: 1, claims: { [id]: {
      observedPaths: ['src/a.mjs'], testResults: ['test/a.test.mjs'], commits: ['a'.repeat(40)], verdict: 'partial'
    } } },
    { phase: 'code-b', generation: 1, claims: { [id]: {
      observedPaths: ['src/b.mjs'], testResults: ['test/b.test.mjs'], commits: ['b'.repeat(40)], verdict: 'partial'
    } } }
  ];
  const mergedObserved = mergeObservedClaimRecords(observed, mergedPlan);
  assert.equal(mergedObserved[id].verdict, 'matched');
  assert.deepEqual(mergedObserved[id].observedPaths, ['src/a.mjs', 'src/b.mjs']);

  const index = { clauses: [{ id }] };
  assert.equal(evaluateSpecCoverage(
    { indexes: [index], planned, observed },
    ['src/a.mjs', 'src/b.mjs'],
    { coverage: 'enforce' }
  ).complete, true);

  const laterEmpty = { phase: 'code-b', generation: 2, claims: { [id]: {
    observedPaths: [], testResults: [], commits: [], verdict: 'missing'
  } } };
  const onePlan = mergePlannedClaimRecords([planned[0]]);
  assert.equal(mergeObservedClaimRecords([{
    phase: 'code-a', generation: 1, claims: { [id]: {
      observedPaths: ['src/a.mjs'], testResults: ['test/a.test.mjs'], commits: [], verdict: 'matched'
    } }
  }, laterEmpty], onePlan)[id].verdict, 'matched', 'a later empty interval erased earlier exact evidence');
});

test('acceptance policy distinguishes planned evidence from verified execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-acceptance-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Spec Tester'], { cwd: root });
  run('git', ['config', 'user.email', 'spec@example.com'], { cwd: root });
  await writeFile(path.join(root, 'source.mjs'), 'export const value = 1;\n');
  run('git', ['add', 'source.mjs'], { cwd: root });
  run('git', ['commit', '-m', 'source'], { cwd: root });
  const index = { clauses: extractClauses(markdown) };
  const planned = { claims: Object.fromEntries(index.clauses.map((clause) => [clause.id, { tests: ['test/spec.test.mjs'] }])) };
  const observed = { claims: Object.fromEntries(index.clauses.map((clause) => [clause.id, { testResults: ['test/spec.test.mjs'] }])) };
  const policy = {
    mode: 'enforce', acceptance: 'verify',
    testCommands: { passing: [process.execPath, '-e', 'process.exit(0)'] }
  };
  assert.equal(evaluateSpecAcceptance({ indexes: [index], planned: [planned], observed: [observed], acceptance: [] }, policy).missingRun, true);
  const acceptanceRun = await runSpecAcceptance(root, policy, {
    workId: 'WORK-1', phase: 'verification', generation: 1,
    outputPath: 'singularity/context/acceptance/verification-gen1.json'
  });
  assert.equal(acceptanceRun.status, 'passed');
  const expected = {
    workId: 'WORK-1', phase: 'verification', generation: 1,
    sourceTreeSha256: await specificationSourceTreeHash(root),
    commandSetSha256: acceptanceRun.commandSetSha256
  };
  assert.equal(evaluateSpecAcceptance({ indexes: [index], planned: [planned], observed: [observed], acceptance: [acceptanceRun] }, policy, expected).complete, true);
  await writeFile(path.join(root, 'source.mjs'), 'export const value = 2;\n');
  const stale = evaluateSpecAcceptance({ indexes: [index], planned: [planned], observed: [observed], acceptance: [acceptanceRun] }, policy, {
    ...expected, sourceTreeSha256: await specificationSourceTreeHash(root)
  });
  assert.equal(stale.complete, false);
  assert.match(stale.staleRunReasons.join(' '), /source tree changed/);
});

test('changed-path discovery fails closed when the Git comparison is invalid', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-diff-'));
  assert.throws(() => changedRepositoryPaths(root, { base: 'missing', target: 'HEAD' }), /Unable to calculate changed repository paths/);
});

test('specification coverage includes source deletions and excludes every governed root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-ownership-'));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Spec Tester'], { cwd: root });
  run('git', ['config', 'user.email', 'spec@example.com'], { cwd: root });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await writeFile(path.join(root, 'src/obsolete.mjs'), 'export const obsolete = true;\n');
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: 2\n');
  await writeFile(path.join(root, '.github/agents/developer.agent.md'), '# Developer\n');
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-qm', 'baseline'], { cwd: root });
  const base = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  const sourceHash = await specificationSourceTreeHash(root);

  await rm(path.join(root, 'src/obsolete.mjs'));
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: 3\n');
  await writeFile(path.join(root, '.github/agents/developer.agent.md'), '# Changed agent\n');
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-qm', 'delete source and refresh governance'], { cwd: root });
  assert.deepEqual(changedRepositoryPaths(root, { base, target: 'HEAD' }), ['src/obsolete.mjs']);
  assert.notEqual(await specificationSourceTreeHash(root), sourceHash,
    'deleting application source changes the acceptance fingerprint');

  const afterDeletion = await specificationSourceTreeHash(root);
  await writeFile(path.join(root, '.github/agents/developer.agent.md'), '# Another agent edit\n');
  assert.equal(await specificationSourceTreeHash(root), afterDeletion,
    'agent projection never makes application acceptance evidence stale');
});

test('a plan lists supporting files that may change without a clause, and coverage accepts exactly those', () => {
  const plan = `# Plan

| Clause | Expected paths | Planned tests |
| --- | --- | --- |
| APP:REQ-001 | \`src/app.mjs\` | \`test/app.test.mjs\` |

## Supporting files

<!-- - \`ignored/example.json\` — an example inside a comment is not an entry -->
- \`package.json\` — adds the ledger client
- \`package-lock.json\` — pins the ledger client
`;
  const derived = derivePlannedClaimMap(plan, { clauseIds: ['APP:REQ-001'], policy: { mode: 'enforce' } });
  assert.deepEqual(derived.supportingFiles, ['package-lock.json', 'package.json']);
  assert.deepEqual(derived.claimMap.supportingFiles, ['package-lock.json', 'package.json']);
  assert.deepEqual(derived.claimMap.supportingFileDetails, [
    { path: 'package-lock.json', class: 'dependency-lock', reason: 'pins the ledger client' },
    { path: 'package.json', class: 'build-configuration', reason: 'adds the ledger client' }
  ]);
  const refused = (entry, pattern) => assert.throws(
    () => derivePlannedClaimMap(plan.replace('- `package-lock.json` — pins the ledger client', entry), { clauseIds: ['APP:REQ-001'] }),
    (error) => error.code === 'SPEC_SUPPORTING_FILE_INVALID' && pattern.test(error.message));
  refused('- `src/payment/Charge.java` — small helper', /it is application source/);
  refused('- `test/charge.test.mjs` — covers the helper', /it is test source/);
  refused('- `db/migrate/001_add.sql` — adds a column', /it is migration/);
  refused('- `package-lock.json`', /needs its reason after the path/);
  refused('- `package.json` — again', /listed twice/);
  const plain = derivePlannedClaimMap(plan.slice(0, plan.indexOf('## Supporting files')), { clauseIds: ['APP:REQ-001'] });
  assert.equal(Object.hasOwn(plain.claimMap, 'supportingFiles'), false, 'a plan without the section records what it always did');
  assert.throws(() => derivePlannedClaimMap(`${plan}- package.json without backticks\n`, { clauseIds: ['APP:REQ-001'] }),
    /must start with one backticked repository path/);
  assert.throws(() => derivePlannedClaimMap(plan.replace('`package-lock.json` — pins the ledger client', '`config/*.yml` — config'), { clauseIds: ['APP:REQ-001'] }),
    /exact repository-relative path without traversal, globs/);

  const index = { clauses: [{ id: 'APP:REQ-001', type: 'REQ' }] };
  const observed = normalizeClaimMap({
    'APP:REQ-001': { observedPaths: ['src/app.mjs'], testResults: ['test/app.test.mjs'], verdict: 'matched' }
  }, { kind: 'observed', clauseIds: ['APP:REQ-001'], policy: { mode: 'record' } });
  const coverage = evaluateSpecCoverage({ indexes: [index], planned: [derived.claimMap], observed: [observed] },
    ['src/app.mjs', 'package.json', 'Makefile'], { coverage: 'enforce' });
  assert.deepEqual(coverage.supportingChangedPaths, ['package.json']);
  assert.deepEqual(coverage.unclaimedChangedPaths, ['Makefile'], 'only a listed file is excused');
  assert.equal(coverage.complete, false);

  // A map written before the classes existed, or by hand, cannot excuse application source.
  const { supportingFileDetails, ...legacy } = derived.claimMap;
  assert.ok(supportingFileDetails.length);
  const legacyCoverage = evaluateSpecCoverage(
    { indexes: [index], planned: [{ ...legacy, supportingFiles: ['package.json', 'src/payment/Charge.java'] }], observed: [observed] },
    ['src/app.mjs', 'package.json', 'src/payment/Charge.java'], { coverage: 'enforce' });
  assert.deepEqual(legacyCoverage.supportingChangedPaths, ['package.json']);
  assert.deepEqual(legacyCoverage.unclaimedChangedPaths, ['src/payment/Charge.java']);
});

test('the clause trace merges every code phase the way the gate does', () => {
  const index = { clauses: extractClauses('[APP:REQ-001]\nThe service exports and imports.') };
  const planned = normalizeClaimMap({ claims: { 'APP:REQ-001': { expectedPaths: ['src/export.mjs', 'src/import.mjs'], tests: [] } } },
    { kind: 'planned', clauseIds: ['APP:REQ-001'] });
  const first = { ...normalizeClaimMap({ claims: { 'APP:REQ-001': { observedPaths: ['src/export.mjs'], verdict: 'partial' } } },
    { kind: 'observed', clauseIds: ['APP:REQ-001'] }), phase: 'code-a', generation: 1 };
  const second = { ...normalizeClaimMap({ claims: { 'APP:REQ-001': { observedPaths: ['src/import.mjs'], verdict: 'partial' } } },
    { kind: 'observed', clauseIds: ['APP:REQ-001'] }), phase: 'code-b', generation: 1 };
  const [row] = traceClause({ indexes: [index], planned: [planned], observed: [first, second] });
  assert.equal(row.verdict, 'matched', 'two code phases together implemented the clause');
  assert.deepEqual(row.observed.observedPaths, ['src/export.mjs', 'src/import.mjs']);
});

test('under enforced source bindings a not-applicable row is observed by its exact path; others still need a binding', () => {
  const planned = normalizeClaimMap({ claims: {
    'APP:REQ-001': { expectedPaths: ['src/a.js'], tests: ['test/a.test.js'] },
    'APP:REQ-002': { expectedPaths: ['config/app.json'], tests: [], testDisposition: 'not-applicable', testReason: 'validated by schema load at boot' }
  } }, { kind: 'planned', clauseIds: ['APP:REQ-001', 'APP:REQ-002'] });
  const observed = deriveObservedClaimMap(planned, {
    sourcePaths: ['src/a.js', 'config/app.json'], testPaths: ['test/a.test.js'],
    traceability: { bindings: [], sourceBindings: [] }
  }, { clauseIds: ['APP:REQ-001', 'APP:REQ-002'], requireSourceBindings: true });
  assert.deepEqual(observed.claims['APP:REQ-002'].observedPaths, ['config/app.json']);
  assert.deepEqual(observed.claims['APP:REQ-001']?.observedPaths ?? [], [], 'a taggable source still needs its clause comment');
});

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
  renderClauseContext,
  runSpecAcceptance, selectActiveSpecRecords, specificationSourceTreeHash,
  selectClauseContext
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

async function boundClaimFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-bound-claims-'));
  const itemDirectory = path.join(root, 'singularity/work-items/BOUND-1');
  const claimsDirectory = path.join(itemDirectory, 'context/claims');
  await mkdir(claimsDirectory, { recursive: true });
  const planned = {
    schemaVersion: currentSchemaVersion('specification-claim-map'),
    kind: 'planned', recordedAt: '2026-08-31T00:00:00.000Z',
    workId: 'BOUND-1', phase: 'planning', generation: 1,
    claims: { 'APP:REQ-001': {
      expectedPaths: ['src/app.mjs'], tests: ['test/app.test.mjs'],
      testDisposition: 'applicable', testReason: null, deviation: null
    } }
  };
  const observed = {
    schemaVersion: currentSchemaVersion('specification-claim-map'),
    kind: 'observed', recordedAt: '2026-08-31T00:01:00.000Z',
    workId: 'BOUND-1', phase: 'implementation', generation: 1,
    claims: { 'APP:REQ-001': {
      observedPaths: ['src/app.mjs'], testResults: ['test/app.test.mjs'],
      commits: ['a'.repeat(40)], verdict: 'matched', deviation: null
    } }
  };
  const plannedPath = 'singularity/work-items/BOUND-1/context/claims/planning-gen1-planned.json';
  const observedPath = 'singularity/work-items/BOUND-1/context/claims/implementation-gen1-observed.json';
  await writeFile(path.join(root, plannedPath), canonicalJson(planned));
  await writeFile(path.join(root, observedPath), canonicalJson(observed));
  const digest = (record) => createHash('sha256').update(canonicalJson(record)).digest('hex');
  const workflow = {
    workItem: { id: 'BOUND-1' },
    resolution: {
      plannedClaims: {
        mode: 'required', clausePhases: ['requirements'], owners: { implementation: 'planning' }
      }
    },
    phases: {
      requirements: { id: 'requirements', generation: 0, requiredArtifact: { kind: 'requirements' } },
      planning: {
        id: 'planning', generation: 1,
        claimMaps: { planned: { generation: 1, path: plannedPath, sha256: digest(planned) } }
      },
      implementation: {
        id: 'implementation', generation: 1,
        claimMaps: { observed: { generation: 1, path: observedPath, sha256: digest(observed) } }
      }
    }
  };
  return { root, itemDirectory, planned, plannedPath, workflow };
}

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

test('terminal coverage accepts complete AC test-only evidence and claims its exact test path', () => {
  const index = { clauses: extractClauses('[APP:AC-001]\nThe rendered primary background is blue.') };
  const planned = normalizeClaimMap({ claims: {
    'APP:AC-001': {
      expectedPaths: ['src/app.component.css'],
      tests: ['test/primary-background.spec.ts']
    }
  } }, { kind: 'planned', clauseIds: ['APP:AC-001'] });
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
  assert.deepEqual(coverage.unclaimedChangedPaths, []);
  assert.deepEqual(coverage.invalidEvidence, []);
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

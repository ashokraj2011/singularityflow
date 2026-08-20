import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import {
  astAdapterManifestSha256, astAdapterRequest, executeAstAdapter, validateAstAdapterManifest,
  validateAstAdapterResponse
} from '../src/ast-adapter-contract.mjs';
import { initializeDefinition } from '../src/config.mjs';
import {
  astCacheStatus, astCommand, effectiveAstMode, readAstPreference, setAstPreference,
  validateAstResultEnvelope
} from '../src/ast-intelligence.mjs';
import { normalizeAstPolicy } from '../src/ast-policy.mjs';
import { familyForStoredPath, readRecord } from '../src/schema-migrations.mjs';
import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { astQueryPlanner } from '../src/gateway/planners/ast-intelligence.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function adapterManifestValue(overrides = {}) {
  const implementation = {
    artifactSha256: 'a'.repeat(64),
    manifestSha256: '',
    runtime: { id: 'node', version: process.versions.node, platform: `${process.platform}-${process.arch}` },
    grammars: [],
    dependencies: { lockSha256: null, bundleSha256: null },
    ...(overrides.implementation ?? {})
  };
  const value = {
    protocolVersion: 2,
    id: 'syntax-fixture',
    languages: ['typescript'],
    assurance: 'syntax',
    argv: ['node', '/opt/adapter.mjs'],
    extractorVersion: '1.0.0',
    capabilities: ['skeleton'],
    ...overrides,
    implementation
  };
  value.implementation.manifestSha256 = astAdapterManifestSha256(value);
  return value;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'AST Test']);
  git(root, ['config', 'user.email', 'ast@example.com']);
  await writeFile(path.join(root, 'one.ts'), 'export function one() { return 1; }\n');
  await writeFile(path.join(root, 'two.ts'), "import { one } from './one.js';\nexport const two = one();\n");
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

async function withPreferenceFile(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-preference-'));
  const before = process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
  process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = path.join(directory, 'preference.json');
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
    else process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = before;
  }
}

test('AST policy is closed, bounded, and cannot disable a required predicate', () => {
  const value = normalizeAstPolicy({ mode: 'auto', budgets: { maxFiles: 7 } });
  assert.equal(value.budgets.maxFiles, 7);
  assert.equal(value.budgets.maxFileBytes, 2 * 1024 * 1024);
  assert.throws(() => normalizeAstPolicy({ mode: 'off', predicates: [{ id: 'must', mode: 'required', type: 'path-exists', path: 'src' }] }), /cannot be combined/);
  assert.throws(() => normalizeAstPolicy({ surprise: true }), /unknown field/);
});

test('v1 AST results migrate with truthful current accounting and legacy resume jobs fail intentionally', () => {
  const result = validateAstResultEnvelope({
    schemaVersion: 1, operation: 'context',
    scope: { kind: 'paths', paths: ['one.ts'], definitionSha256: 'a'.repeat(64), repositoryRevision: 'b'.repeat(40), worktreeFingerprint: 'c'.repeat(64) },
    assurance: 'text', status: 'complete',
    coverage: { selected: 1, processed: 1, skipped: 0, bytes: 10, facts: 1, byLanguage: { typescript: 1 } },
    facts: [{ kind: 'file', path: 'one.ts', language: 'typescript', bytes: 10, sha256: 'd'.repeat(64) }],
    diagnostics: [], degradation: [], resumeHandle: null,
    provenance: { engine: 'singularity-flow-ast-broker', engineVersion: 1, adapters: [], effectiveMode: 'auto', modeSources: {} }
  });
  assert.equal(result.schemaVersion, 4);
  assert.equal(result.coverage.factsExamined, 1);
  assert.equal(result.facts[0].generated, false);
  assert.equal(result.facts[0].assurance, 'text');
  assert.equal(result.facts[0].extractor.id, 'legacy-unknown');
  assert.equal(result.nextCursor, null);
  assert.equal(result.page.returned, 1);
  assert.equal(readRecord('ast-resume-job', { schemaVersion: 1, cursor: 'one.ts' }).record.legacyV1, true);
  assert.equal(familyForStoredPath('$git/ast/v1/snapshots/legacy.json')?.id, 'ast-result');
  assert.equal(familyForStoredPath(`$git/ast/v2/manifests/${'a'.repeat(64)}.json`)?.id, 'ast-cone-manifest');

  const legacyGate = readRecord('ast-result', {
    schemaVersion: 2, operation: 'gate', facts: [{
      id: 'legacy-required', mode: 'required', requiredAssurance: 'text', outcome: 'pass'
    }], coverage: { facts: 1 }, provenance: {}
  }).record;
  assert.equal(legacyGate.schemaVersion, 4);
  assert.deepEqual(legacyGate.facts[0].extractors, []);
  assert.equal(legacyGate.page.available, 1);
});

test('the most restrictive preference wins and show has no write side effect', async () => withPreferenceFile(async () => {
  const shown = await readAstPreference();
  assert.equal(shown.mode, 'auto');
  assert.equal(shown.exists, false);
  await setAstPreference('off');
  const effective = await effectiveAstMode(normalizeAstPolicy({ mode: 'auto' }));
  assert.equal(effective.mode, 'off');
  assert.equal((await readAstPreference()).exists, true);
}));

test('off returns a valid disabled envelope and creates no AST store', async () => withPreferenceFile(async () => {
  const root = await repository();
  await setAstPreference('off');
  const result = await astCommand(root, ['context'], { all: true });
  assert.equal(validateAstResultEnvelope(result).status, 'disabled');
  assert.equal(result.coverage.processed, 0);
  assert.equal(result.scope.worktreeFingerprint, null);
  assert.equal((await astCacheStatus(root)).exists, false);
}));

test('off returns before repository census or worktree fingerprinting', async () => withPreferenceFile(async () => {
  const root = await repository();
  await setAstPreference('off');
  const before = process.env.SINGULARITY_FLOW_SUBPROCESS_PROBE;
  process.env.SINGULARITY_FLOW_SUBPROCESS_PROBE = '1';
  try {
    const result = await astCommand(root, ['context'], { all: true });
    assert.equal(result.status, 'disabled');
    assert.equal(result.coverage.selected, 0);
  } finally {
    if (before === undefined) delete process.env.SINGULARITY_FLOW_SUBPROCESS_PROBE;
    else process.env.SINGULARITY_FLOW_SUBPROCESS_PROBE = before;
  }
}));

test('default scope never expands empty roots to the repository and explicit all is bounded', async () => withPreferenceFile(async () => {
  const root = await repository();
  const quiet = await astCommand(root, ['context'], { json: false });
  assert.equal(quiet.scope.kind, 'changed');
  assert.equal(quiet.coverage.selected, 0);
  const result = await astCommand(root, ['context'], { all: true, 'max-files': '1' });
  assert.equal(result.scope.kind, 'all');
  assert.equal(result.coverage.selected, 2);
  assert.equal(result.coverage.processed, 1);
  assert.equal(result.status, 'partial');
}));

test('text facts contain references and hashes but never source bodies', async () => withPreferenceFile(async () => {
  const root = await repository();
  const result = await astCommand(root, ['context'], { all: true });
  assert.equal(result.assurance, 'text');
  assert.ok(result.facts.some((fact) => fact.kind === 'symbol' && fact.name === 'one'));
  assert.ok(result.facts.some((fact) => fact.kind === 'import' && fact.target === './one.js'));
  assert.doesNotMatch(JSON.stringify(result), /return 1/);
}));

test('durable evidence rejects dirty in-cone bytes but ignores dirty paths outside the cone', async () => withPreferenceFile(async () => {
  const root = await repository();
  await initializeDefinition(root);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'configure AST evidence']);

  await writeFile(path.join(root, 'two.ts'), 'export const outside = true;\n');
  const outside = await astCommand(root, ['context'], {
    paths: 'one.ts', 'evidence-class': 'recorded-context'
  });
  assert.equal(outside.evidenceClass, 'recorded-context');
  assert.deepEqual(outside.provenance.evidence.inputs.files.map((entry) => entry.path), ['one.ts']);

  await writeFile(path.join(root, 'one.ts'), 'export const dirty = true;\n');
  await assert.rejects(
    () => astCommand(root, ['context'], { paths: 'one.ts', 'evidence-class': 'recorded-context' }),
    (error) => error?.code === 'AST_EVIDENCE_INPUT_NOT_COMMITTED'
      && /one\.ts/.test(error.message)
      && /Commit the relevant bytes/.test(error.message)
  );
  await writeFile(path.join(root, 'new.ts'), 'export const untracked = true;\n');
  await assert.rejects(
    () => astCommand(root, ['context'], { paths: 'new.ts', 'evidence-class': 'recorded-context' }),
    (error) => error?.code === 'AST_EVIDENCE_INPUT_NOT_COMMITTED' && /untracked/.test(error.message)
  );
}));

test('a clean sparse file is indexed from its immutable Git blob without materializing it', async () => withPreferenceFile(async () => {
  const root = await repository();
  git(root, ['update-index', '--skip-worktree', 'one.ts']);
  await unlink(path.join(root, 'one.ts'));
  const result = await astCommand(root, ['context'], { paths: 'one.ts' });
  assert.equal(result.status, 'complete');
  assert.equal(result.coverage.processed, 1);
  assert.ok(result.facts.some((fact) => fact.kind === 'symbol' && fact.name === 'one'));
}));

test('a bounded Git blob larger than Node spawnSync default output is read in one batch', async () => withPreferenceFile(async () => {
  const root = await repository();
  await writeFile(path.join(root, 'large.ts'), `${'// bounded filler\n'.repeat(70_000)}export const largeSymbol = true;\n`);
  git(root, ['add', 'large.ts']);
  git(root, ['commit', '-qm', 'large bounded source']);
  const result = await astCommand(root, ['context'], {
    paths: 'large.ts', 'max-bytes': String(2 * 1024 * 1024), 'max-file-bytes': String(2 * 1024 * 1024)
  });
  assert.equal(result.status, 'complete');
  assert.ok(result.coverage.bytes > 1024 * 1024);
  assert.ok(result.facts.some((fact) => fact.kind === 'symbol' && fact.name === 'largeSymbol'));
}));

test('query accounting distinguishes examined facts from returned matches', async () => withPreferenceFile(async () => {
  const root = await repository();
  const result = await astCommand(root, ['query'], { all: true, predicate: 'symbol', value: 'absent-symbol' });
  assert.equal(result.facts.length, 0);
  assert.ok(result.coverage.factsExamined > 0);
  assert.equal(result.coverage.factsMatched, 0);
  assert.equal(result.coverage.factsReturned, 0);
  assert.equal(result.coverage.facts, 0);
}));

test('gateway and Copilot hosts receive bounded AST reads without gaining cache or lifecycle writes', async () => withPreferenceFile(async () => {
  const root = await repository();
  const binding = {
    workspaceId: 'ast-test', repository: root, branch: 'main', subjectKind: 'repository', subjectId: 'ast-test',
    sourceCommit: git(root, ['rev-parse', 'HEAD']), worktreeHash: null, worktreeAlgorithm: 'sflow-worktree-v2',
    lifecycleRevision: null, policyHash: 'sha256:policy', registryHash: 'sha256:registry',
    actorId: 'ast@example.com', hostSessionId: 'ast-gateway'
  };
  const kernel = createGatewayKernel({ root, binding, planners: gatewayPlanners() });
  const resolved = kernel.resolve({ utterance: 'show bounded structural context' });
  const context = await kernel.read({ resolutionId: resolved.next[0].handle });
  validateSflowResult(context);
  assert.equal(context.operation.id, 'wm.ast.context');
  assert.equal(context.data.ast.scope.kind, 'changed');
  assert.equal((await astCacheStatus(root)).exists, false);

  const queried = await astQueryPlanner({
    root, subject: null,
    arguments: { predicate: 'symbol', value: 'one', all: true, maxFiles: 10 }
  });
  validateSflowResult(queried);
  assert.ok(queried.data.ast.facts.some((fact) => fact.name === 'one'));
  assert.equal(queried.effects.stateChanged, false);
  assert.equal((await astCacheStatus(root)).exists, false);
}));

test('a lexical symbol match never satisfies a required symbol gate', async () => withPreferenceFile(async () => {
  const root = await repository();
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const template = await readFile(workflowPath, 'utf8');
  await writeFile(workflowPath, template.replace(
    '  fallback: host-and-text\n',
    '  fallback: host-and-text\n  predicates:\n    - id: one-exists\n      mode: required\n      type: symbol-exists\n      symbol: one\n'
  ));
  const result = await astCommand(root, ['gate'], { paths: 'one.ts,two.ts', 'max-files': '1' });
  assert.equal(result.status, 'partial');
  assert.equal(result.facts.find((item) => item.id === 'one-exists')?.outcome, 'unknown');
  assert.equal(result.facts.find((item) => item.id === 'one-exists')?.requiredAssurance, 'syntax');
  assert.deepEqual(result.facts.find((item) => item.id === 'one-exists')?.extractors, [
    { id: 'builtin-text', version: 1, assurance: 'text', protocolVersion: 2 }
  ]);
  assert.equal(result.provenance.gate.allowed, false);
}));

test('commented-out declarations remain advisory and cannot pass a required lifecycle predicate', async () => withPreferenceFile(async () => {
  const root = await repository();
  await writeFile(path.join(root, 'ghost.ts'), '/*\nexport function Ghost() {}\n*/\n');
  git(root, ['add', 'ghost.ts']);
  git(root, ['commit', '-qm', 'comment fixture']);
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const template = await readFile(workflowPath, 'utf8');
  await writeFile(workflowPath, template.replace(
    '  fallback: host-and-text\n',
    '  fallback: host-and-text\n  predicates:\n    - id: ghost-exists\n      mode: required\n      type: symbol-exists\n      symbol: Ghost\n      minimumAssurance: text\n'
  ));
  const result = await astCommand(root, ['gate'], { paths: 'ghost.ts' });
  const predicate = result.facts.find((item) => item.id === 'ghost-exists');
  assert.equal(predicate.outcome, 'unknown');
  assert.equal(predicate.requiredAssurance, 'syntax');
  assert.equal(result.provenance.gate.allowed, false);
}));

test('context output is fact- and byte-bounded and continues through a cone-bound opaque cursor', async () => withPreferenceFile(async () => {
  const root = await repository();
  await writeFile(path.join(root, 'many.ts'), Array.from({ length: 80 }, (_, index) => `export const symbol${index} = ${index};`).join('\n'));
  git(root, ['add', 'many.ts']);
  git(root, ['commit', '-qm', 'many symbols']);
  const first = await astCommand(root, ['context'], {
    paths: 'many.ts', 'max-facts': '7', 'max-output-bytes': '16384'
  });
  assert.equal(first.facts.length, 7);
  assert.equal(first.page.offset, 0);
  assert.equal(first.page.available, 81);
  assert.equal(first.page.hasMore, true);
  assert.match(first.nextCursor, /^astp_/);
  assert.ok(Buffer.byteLength(JSON.stringify(first, null, 2)) <= 16_384);
  assert.equal((await astCacheStatus(root)).exists, false, 'stateless read paging does not populate the AST cache');

  const second = await astCommand(root, ['context'], { cursor: first.nextCursor });
  assert.equal(second.page.offset, 7);
  assert.equal(second.facts.length, 7);
  assert.notDeepEqual(second.facts, first.facts);

  await writeFile(path.join(root, 'many.ts'), `${await readFile(path.join(root, 'many.ts'), 'utf8')}\nexport const changed = true;\n`);
  await assert.rejects(
    () => astCommand(root, ['context'], { cursor: first.nextCursor }),
    (error) => error.code === 'AST_READ_CURSOR_STALE'
  );
}));

test('build writes only to the git-common cache and cache clear is confirmation-bound', async () => withPreferenceFile(async () => {
  const root = await repository();
  await astCommand(root, ['build'], { all: true });
  const status = await astCacheStatus(root);
  assert.equal(status.exists, true);
  assert.match(status.root, /\.git\/singularity-flow\/ast\/v2$/);
  await assert.rejects(() => astCommand(root, ['cache', 'clear'], {}), /CLEAR AST CACHE/);
  await astCommand(root, ['cache', 'clear'], { confirm: 'CLEAR AST CACHE' });
  assert.equal((await astCacheStatus(root)).exists, false);
}));

test('budgeted builds resume through an opaque handle bound to exact worktree bytes', async () => withPreferenceFile(async () => {
  const root = await repository();
  const first = await astCommand(root, ['build'], { all: true, 'max-files': '1' });
  assert.match(first.resumeHandle, /^ast_[0-9a-f-]{36}_[A-Za-z0-9_-]+$/);
  const second = await astCommand(root, ['build', first.resumeHandle], { resume: true, 'max-files': '1' });
  assert.equal(second.coverage.processed, 2);
  assert.equal(second.resumeHandle, null);
  await assert.rejects(
    () => astCommand(root, ['build', first.resumeHandle], { resume: true, 'max-files': '1' }),
    /unknown or already consumed/
  );
}));

test('a zero-progress page remains resumable and recommends a sufficient byte budget', async () => withPreferenceFile(async () => {
  const root = await repository();
  const first = await astCommand(root, ['build'], { all: true, 'max-bytes': '1' });
  assert.equal(first.status, 'partial');
  assert.equal(first.coverage.processed, 0);
  assert.match(first.resumeHandle, /^ast_/);
  assert.match(first.diagnostics.find((item) => item.code === 'AST_BUDGET_NO_PROGRESS')?.message ?? '', /at least \d+/);
  const resumed = await astCommand(root, ['build', first.resumeHandle], {
    resume: true, 'max-bytes': '10000', 'max-files': '10'
  });
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.coverage.processed, 2);
  assert.equal(resumed.resumeHandle, null);
}));

test('context and query reuse built blob skeletons without re-extracting unchanged files', async () => withPreferenceFile(async () => {
  const root = await repository();
  const built = await astCommand(root, ['build'], { all: true });
  assert.equal(built.provenance.cache.misses, 2);
  const context = await astCommand(root, ['context'], { all: true });
  assert.equal(context.provenance.cache.hits, 2);
  assert.equal(context.provenance.cache.misses, 0);
  const query = await astCommand(root, ['query'], { all: true, predicate: 'symbol', value: 'one' });
  assert.equal(query.provenance.cache.hits, 2);
  assert.ok(query.facts.some((item) => item.name === 'one'));
}));

test('a damaged local skeleton is never trusted and is rebuilt in memory by a read', async () => withPreferenceFile(async () => {
  const root = await repository();
  await astCommand(root, ['build'], { paths: 'one.ts' });
  const blobs = path.join(root, '.git', 'singularity-flow', 'ast', 'v2', 'blobs');
  const target = path.join(blobs, (await readdir(blobs))[0]);
  const damaged = JSON.parse(await readFile(target, 'utf8'));
  damaged.facts.push({ kind: 'symbol', name: 'Injected', declarationKind: 'class', line: 1, assurance: 'text' });
  await writeFile(target, JSON.stringify(damaged));
  const result = await astCommand(root, ['context'], { paths: 'one.ts' });
  assert.equal(result.provenance.cache.misses, 1);
  assert.equal(result.facts.some((fact) => fact.name === 'Injected'), false);
  assert.ok(result.facts.some((fact) => fact.name === 'one'));
}));

test('an out-of-cone edit does not invalidate or miss the selected cone cache', async () => withPreferenceFile(async () => {
  const root = await repository();
  await astCommand(root, ['build'], { paths: 'one.ts' });
  await writeFile(path.join(root, 'two.ts'), 'export const changedOutsideCone = true;\n');
  const result = await astCommand(root, ['context'], { paths: 'one.ts' });
  assert.equal(result.status, 'complete');
  assert.equal(result.provenance.cache.hits, 1);
  assert.equal(result.provenance.cache.misses, 0);
}));

test('generated roots are tagged and higher-assurance policy retains honest L0 facts', async () => withPreferenceFile(async () => {
  const root = await repository();
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const source = await readFile(workflowPath, 'utf8');
  await writeFile(workflowPath, source.replace(
    '  fallback: host-and-text\n',
    '  fallback: text-only\n  generatedRoots: [one.ts]\n  languages:\n    typescript:\n      mode: auto\n      minimumAssurance: syntax\n'
  ));
  const result = await astCommand(root, ['context'], { paths: 'one.ts' });
  assert.equal(result.status, 'partial');
  assert.ok(result.facts.some((item) => item.kind === 'symbol' && item.name === 'one'));
  assert.ok(result.facts.every((item) => item.generated === true));
  assert.ok(result.degradation.some((item) => item.reason === 'assurance-unavailable' && item.required === 'syntax'));
}));

test('resume refuses a handle after worktree bytes change', async () => withPreferenceFile(async () => {
  const root = await repository();
  const first = await astCommand(root, ['build'], { all: true, 'max-files': '1' });
  await writeFile(path.join(root, 'one.ts'), 'export function one() { return 2; }\n');
  await assert.rejects(
    () => astCommand(root, ['build', first.resumeHandle], { resume: true, 'max-files': '1' }),
    /relevant scope or file bytes changed/
  );
}));

test('turning AST off before resume performs no additional indexing and keeps the handle usable', async () => withPreferenceFile(async () => {
  const root = await repository();
  const first = await astCommand(root, ['build'], { all: true, 'max-files': '1' });
  const before = await astCacheStatus(root);
  await setAstPreference('off');
  await assert.rejects(() => astCommand(root, ['build', first.resumeHandle], {
    resume: true, 'max-files': '10'
  }), (error) => error.code === 'AST_DISABLED');
  assert.equal((await astCacheStatus(root)).files, before.files);
  await setAstPreference('auto');
  const resumed = await astCommand(root, ['build', first.resumeHandle], { resume: true, 'max-files': '10' });
  assert.equal(resumed.status, 'complete');
}));

test('cache prune previews and removes only stale derived records after exact confirmation', async () => withPreferenceFile(async () => {
  const root = await repository();
  await astCommand(root, ['build'], { all: true });
  await writeFile(path.join(root, 'one.ts'), 'export function one() { return 3; }\n');
  const preview = await astCommand(root, ['cache', 'prune'], { 'dry-run': true });
  assert.ok(preview.candidates >= 1);
  assert.equal(preview.removed, 0);
  await assert.rejects(() => astCommand(root, ['cache', 'prune'], {}), /PRUNE AST CACHE/);
  const applied = await astCommand(root, ['cache', 'prune'], { confirm: 'PRUNE AST CACHE' });
  assert.equal(applied.removed, preview.candidates);
}));

test('adapter manifests are versioned structured argv contracts', () => {
  const adapter = validateAstAdapterManifest(adapterManifestValue({
    id: 'typescript-reference',
    languages: ['typescript', 'javascript'],
    assurance: 'syntax',
    argv: ['node', '/opt/adapter.mjs'],
    extractorVersion: '1.0.0',
    capabilities: ['skeleton', 'query']
  }));
  assert.deepEqual(adapter.argv, ['node', '/opt/adapter.mjs']);
  assert.throws(() => validateAstAdapterManifest({ ...adapter, protocolVersion: 1 }), /protocolVersion/);
  assert.throws(() => validateAstAdapterManifest({ ...adapter, capabilities: 'skeleton' }), /capabilities/);
  assert.throws(() => validateAstAdapterManifest({ ...adapter, capabilities: ['execute-anything'] }), /capabilities/);
});

test('an explicit adapter executes through bounded structured JSON without a shell', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-adapter-'));
  const executable = path.join(root, 'adapter.mjs');
  await writeFile(executable, `
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    process.stdout.write(JSON.stringify({
      protocolVersion: 2, adapterId: 'syntax-fixture', extractorVersion: '1.0.0', assurance: 'syntax',
      derivationIdentity: request.derivationIdentity,
      artifactSha256: request.implementation.artifactSha256,
      manifestSha256: request.implementation.manifestSha256,
      files: request.files.map((file) => ({ path: file.path, sha256: file.sha256, facts: [
        { kind: 'symbol', name: 'ParsedSymbol', declarationKind: 'class', line: 1, assurance: 'syntax' }
      ] }))
    }));
  `);
  const manifest = validateAstAdapterManifest(adapterManifestValue({
    argv: [process.execPath, executable],
    implementation: { artifactSha256: digest(await readFile(executable)) }
  }));
  const request = astAdapterRequest({
    operation: 'skeleton', scope: { kind: 'paths' },
    files: [{ path: 'one.ts', sha256: 'a'.repeat(64), language: 'typescript' }],
    budget: { maxFiles: 1, maxBytes: 1000 }, implementation: manifest.implementation
  });
  const response = await executeAstAdapter(manifest, request, { root });
  assert.equal(response.files[0].facts[0].name, 'ParsedSymbol');
  assert.equal(response.files[0].facts[0].assurance, 'syntax');
  assert.throws(() => validateAstAdapterResponse({
    ...response,
    files: [{ path: 'one.ts', sha256: 'a'.repeat(64), facts: [{ kind: 'symbol', name: 'Leak', line: 1, sourceBody: 'secret' }] }]
  }, manifest, request), /must not contain source bytes/);
  const diagnostic = validateAstAdapterResponse({
    ...response,
    diagnostics: [{ code: 'PARSE_WARNING', message: 'token=secret /Users/private/source.ts' }]
  }, manifest, request);
  assert.deepEqual(diagnostic.diagnostics, [{
    code: 'PARSE_WARNING', message: "AST adapter 'syntax-fixture' reported diagnostic PARSE_WARNING."
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|Users\/private/);
  assert.throws(() => validateAstAdapterResponse({
    ...response, derivationIdentity: 'f'.repeat(64)
  }, manifest, request), /identity or assurance/);
  await writeFile(executable, '// changed without changing extractorVersion\n');
  await assert.rejects(
    () => executeAstAdapter(manifest, request, { root }),
    (error) => error?.code === 'AST_ADAPTER_ARTIFACT_MISMATCH'
  );
});

test('host-and-text executes and caches an approved adapter while text-only never launches it', async () => withPreferenceFile(async () => {
  const root = await repository();
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  definition.ast.fallback = 'host-and-text';
  definition.ast.languages = { typescript: { mode: 'auto', minimumAssurance: 'syntax' } };
  await writeFile(workflowPath, YAML.stringify(definition));

  const adapter = path.join(root, 'syntax-adapter.mjs');
  const counter = path.join(root, '.adapter-runs');
  await writeFile(adapter, `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(counter)}, 'run\\n');
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    process.stdout.write(JSON.stringify({
      protocolVersion: 2, adapterId: 'syntax-fixture', extractorVersion: '1.0.0', assurance: 'syntax',
      derivationIdentity: request.derivationIdentity,
      artifactSha256: request.implementation.artifactSha256,
      manifestSha256: request.implementation.manifestSha256,
      files: request.files.map((file) => ({ path: file.path, sha256: file.sha256,
        facts: [{ kind: 'symbol', name: 'CompilerParsed', declarationKind: 'class', line: 1 }] }))
    }));
  `);
  const manifestPath = path.join(root, 'adapter.json');
  await writeFile(manifestPath, JSON.stringify(adapterManifestValue({
    argv: [process.execPath, adapter],
    implementation: { artifactSha256: digest(await readFile(adapter)) }
  })));
  const before = process.env.SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS;
  process.env.SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS = manifestPath;
  try {
    const doctor = await astCommand(root, ['doctor'], {});
    assert.deepEqual(doctor.assuranceAvailable, ['text', 'syntax']);
    const built = await astCommand(root, ['build'], { paths: 'one.ts' });
    assert.equal(built.status, 'complete');
    assert.equal(built.assurance, 'syntax');
    assert.ok(built.facts.some((item) => item.name === 'CompilerParsed' && item.assurance === 'syntax'));
    assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 1);

    const cached = await astCommand(root, ['context'], { paths: 'one.ts' });
    assert.equal(cached.provenance.adapters[0].status, 'cache-hit');
    assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 1);

    await writeFile(path.join(root, 'data.json'), '{"fixture":true}\n');
    const mixed = await astCommand(root, ['context'], { paths: 'one.ts,data.json' });
    assert.equal(mixed.status, 'complete');
    assert.equal(mixed.assurance, 'text', 'aggregate assurance is the weakest assurance in the cone');

    const textOnly = YAML.parse(await readFile(workflowPath, 'utf8'));
    textOnly.ast.fallback = 'text-only';
    await writeFile(workflowPath, YAML.stringify(textOnly));
    const degraded = await astCommand(root, ['context'], { paths: 'one.ts' });
    assert.equal(degraded.status, 'partial');
    assert.equal(degraded.assurance, 'text');
    assert.equal(degraded.provenance.adapters.length, 0);
    assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 1);
  } finally {
    if (before === undefined) delete process.env.SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS;
    else process.env.SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS = before;
  }
}));

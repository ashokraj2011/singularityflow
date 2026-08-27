import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import YAML from 'yaml';

import {
  astAdapterManifestSha256, astAdapterRequest, executeAstAdapter, validateAstAdapterManifest,
  validateAstAdapterResponse
} from '../src/ast-adapter-contract.mjs';
import { initializeDefinition } from '../src/config.mjs';
import {
  astCacheStatus, astCommand, astDoctor, effectiveAstMode, readAstPreference, setAstPreference,
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

test('AST policy is closed and bounded while off can suspend a required predicate', () => {
  const value = normalizeAstPolicy({ mode: 'auto', budgets: { maxFiles: 7 } });
  assert.equal(value.budgets.maxFiles, 7);
  assert.equal(value.budgets.maxFileBytes, 2 * 1024 * 1024);
  assert.deepEqual(value.warmOnStoryStart, { mode: 'background', scope: 'configured-roots' });
  const disabled = normalizeAstPolicy({
    mode: 'off', evidence: { mode: 'identified' },
    predicates: [{ id: 'must', mode: 'required', type: 'path-exists', path: 'src' }]
  });
  assert.equal(disabled.mode, 'off');
  assert.equal(disabled.predicates[0].mode, 'required');
  assert.throws(() => normalizeAstPolicy({ surprise: true }), /unknown field/);
  assert.throws(() => normalizeAstPolicy({ warmOnStoryStart: { mode: 'required' } }), /background/);
  assert.throws(() => normalizeAstPolicy({ warmOnStoryStart: { scope: 'home' } }), /configured-roots/);
  assert.throws(() => normalizeAstPolicy({ predicates: [{
    id: 'boundary', mode: 'required', type: 'import-boundary', path: 'src', target: 'internal'
  }] }), /applicable languages/);
  const rich = normalizeAstPolicy({ predicates: [{
    id: 'boundary', mode: 'required', type: 'import-boundary', path: 'src', target: 'internal',
    languages: ['java'], profiles: ['*'], minimumAssurance: 'syntax'
  }] });
  assert.deepEqual(rich.predicates[0].languages, ['java']);
});

test('rich structural predicates are applicability-bound and fail closed on text-only previews', async () => withPreferenceFile(async () => {
  const root = await repository();
  await initializeDefinition(root);
  await execFileSync('mkdir', ['-p', path.join(root, 'src')]);
  await writeFile(path.join(root, 'src', 'Child.java'), [
    'package fixture;',
    'import forbidden.internal.Secret;',
    '@Deprecated public class Child extends Parent implements Contract {}',
    ''
  ].join('\n'));
  const definitionPath = path.join(root, 'singularity', 'workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.worldModel.sourceRoots = ['src'];
  definition.ast.predicates = [
    { id: 'annotation', mode: 'required', type: 'annotation-present', symbol: 'Child', annotation: 'Deprecated', languages: ['java'], profiles: ['*'], minimumAssurance: 'syntax' },
    { id: 'inherits', mode: 'required', type: 'inherits-from', symbol: 'Child', target: 'Parent', languages: ['java'], profiles: ['*'], minimumAssurance: 'syntax' },
    { id: 'boundary', mode: 'required', type: 'import-boundary', path: 'src', target: 'forbidden.internal', languages: ['java'], profiles: ['*'], minimumAssurance: 'syntax' },
    { id: 'semantic-conformance', mode: 'required', type: 'conforms-to', symbol: 'Child', target: 'Contract', languages: ['java'], profiles: ['*'], minimumAssurance: 'semantic' }
  ];
  await writeFile(definitionPath, YAML.stringify(definition));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'rich predicate fixture']);
  const result = await astCommand(root, ['gate'], { paths: 'src' });
  assert.equal(result.facts.find((item) => item.id === 'annotation').outcome, 'unknown');
  assert.equal(result.facts.find((item) => item.id === 'inherits').outcome, 'unknown');
  assert.equal(result.facts.find((item) => item.id === 'boundary').outcome, 'unknown');
  assert.equal(result.facts.find((item) => item.id === 'semantic-conformance').outcome, 'unknown');
  assert.ok(result.diagnostics.some((item) => item.code === 'AST_STRUCTURAL_PREVIEW_ONLY'));
  assert.equal(result.provenance.gate.allowed, false);
}));

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
  const root = await repository();
  const shown = await readAstPreference();
  assert.equal(shown.mode, 'auto');
  assert.equal(shown.exists, false);
  const changed = await astCommand(root, ['preference', 'set', 'off'], { json: false });
  assert.equal(changed.mode, 'off');
  const effective = await effectiveAstMode(normalizeAstPolicy({ mode: 'auto' }));
  assert.equal(effective.mode, 'off');
  const current = await astCommand(root, ['preference', 'show'], { json: false });
  assert.equal(current.exists, true);
  assert.equal(current.mode, 'off');
}));

test('off returns a valid disabled envelope and creates no AST store', async () => withPreferenceFile(async () => {
  const root = await repository();
  await writeFile(path.join(root, 'engine.cpp'), 'int main() { return 0; }\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'add source outside the AST catalog']);
  await setAstPreference('off');
  const result = await astCommand(root, ['context'], { all: true });
  assert.equal(validateAstResultEnvelope(result).status, 'disabled');
  assert.equal(result.coverage.processed, 0);
  assert.equal(result.scope.worktreeFingerprint, null);
  assert.equal((await astCacheStatus(root)).exists, false);
  const diagnosis = await astDoctor(root);
  assert.equal(diagnosis.healthy, true);
  assert.ok(diagnosis.diagnostics.some((entry) => entry.code === 'AST_DISABLED'));
  assert.ok(!diagnosis.diagnostics.some((entry) => entry.code === 'AST_LANGUAGE_UNSUPPORTED'));
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

test('an explicit AST operation skips an unknown programming language while documentation remains valid input', async () => withPreferenceFile(async () => {
  const root = await repository();
  await writeFile(path.join(root, 'engine.cpp'), 'int main() { return 0; }\n');
  await writeFile(path.join(root, 'notes.md'), '# Repository notes\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'add unsupported source and documentation']);

  const unsupported = await astCommand(root, ['context'], { paths: 'engine.cpp' });
  assert.equal(unsupported.status, 'partial');
  assert.equal(unsupported.coverage.processed, 0);
  assert.ok(unsupported.degradation.some((entry) => entry.path === 'engine.cpp'
    && entry.reason === 'language-unsupported'));
  assert.ok(unsupported.diagnostics.some((entry) => entry.code === 'AST_LANGUAGE_UNSUPPORTED'
    && entry.severity === 'warn'));

  const diagnosis = await astDoctor(root);
  assert.equal(diagnosis.healthy, true);
  assert.equal(diagnosis.degraded, true);
  assert.ok(diagnosis.diagnostics.some((entry) => entry.code === 'AST_LANGUAGE_UNSUPPORTED'
    && entry.severity === 'warn' && entry.paths.includes('engine.cpp')));

  const documentation = await astCommand(root, ['context'], { paths: 'notes.md' });
  assert.equal(documentation.status, 'complete');
  assert.equal(documentation.facts.find((fact) => fact.path === 'notes.md')?.language, 'unknown');
}));

test('durable evidence degrades for dirty in-cone bytes but ignores dirty paths outside the cone', async () => withPreferenceFile(async () => {
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
  const dirty = await astCommand(root, ['context'], { paths: 'one.ts', 'evidence-class': 'recorded-context' });
  assert.equal(dirty.status, 'partial');
  assert.equal(dirty.provenance.evidence, undefined);
  assert.ok(dirty.diagnostics.some((entry) => entry.code === 'AST_EVIDENCE_INPUT_NOT_COMMITTED'));
  await writeFile(path.join(root, 'new.ts'), 'export const untracked = true;\n');
  const untracked = await astCommand(root, ['context'], { paths: 'new.ts', 'evidence-class': 'recorded-context' });
  assert.equal(untracked.status, 'partial');
  assert.ok(untracked.diagnostics.some((entry) => entry.code === 'AST_EVIDENCE_INPUT_NOT_COMMITTED'));
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
  const context = await astCommand(root, ['context'], { all: true });
  const result = await astCommand(root, ['query'], { all: true, predicate: 'symbol', value: 'absent-symbol' });
  assert.equal(result.facts.length, 0);
  assert.equal(result.coverage.factsExamined, context.facts.filter((fact) => fact.kind === 'symbol').length);
  assert.ok(result.coverage.factsExamined < context.page.available,
    'the symbol index scanned the full mixed-kind fact collection');
  assert.equal(result.coverage.factsMatched, 0);
  assert.equal(result.coverage.factsReturned, 0);
  assert.equal(result.coverage.facts, 0);
}));

test('gateway and Copilot reads warm only derived cache without gaining lifecycle writes', async () => withPreferenceFile(async () => {
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
  assert.equal((await astCacheStatus(root)).exists, true,
    'a successful committed-source read did not warm the disposable local AST cache');
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
  assert.equal((await astCacheStatus(root)).exists, true,
    'the first page did not warm immutable skeletons for its continuation');

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

test('a first context automatically warms blob skeletons and later reads reuse them', async () => withPreferenceFile(async () => {
  const root = await repository();
  const context = await astCommand(root, ['context'], { all: true });
  assert.equal(context.provenance.cache.misses, 2);
  assert.equal((await astCacheStatus(root)).exists, true);
  const query = await astCommand(root, ['query'], { all: true, predicate: 'symbol', value: 'one' });
  assert.equal(query.provenance.cache.hits, 2);
  assert.equal(query.provenance.cache.misses, 0);
  assert.ok(query.facts.some((item) => item.name === 'one'));
}));

test('automatic warming is best-effort and never turns optional AST into a blocker', async () => withPreferenceFile(async () => {
  const root = await repository();
  await writeFile(path.join(root, '.git', 'singularity-flow'), 'cache path intentionally unavailable\n');
  const result = await astCommand(root, ['context'], { all: true });
  assert.equal(result.status, 'complete');
  assert.ok(result.facts.some((fact) => fact.kind === 'symbol' && fact.name === 'one'));
  assert.ok(result.diagnostics.some((item) => item.code === 'AST_CACHE_WARM_FAILED'));
  assert.equal(await readFile(path.join(root, '.git', 'singularity-flow'), 'utf8'),
    'cache path intentionally unavailable\n');
}));

test('path, source-id, and target indexes preserve query results while reducing candidates', async () => withPreferenceFile(async () => {
  const root = await repository();
  await writeFile(path.join(root, 'Hierarchy.java'), [
    'package fixture;',
    'public class Child extends Parent implements Contract {}',
    ''
  ].join('\n'));
  git(root, ['add', 'Hierarchy.java']);
  git(root, ['commit', '-qm', 'hierarchy fixture']);

  const context = await astCommand(root, ['context'], { all: true, 'max-facts': 1000 });
  const relationship = context.facts.find((fact) => fact.kind === 'relationship' && fact.type === 'extends');
  assert.ok(relationship?.sourceId, 'the structural preview did not produce a source-bound hierarchy fact');

  const bySource = await astCommand(root, ['query'], {
    all: true, predicate: 'hierarchy', value: relationship.sourceId, 'max-facts': 1000
  });
  assert.ok(bySource.facts.some((fact) => fact.sourceId === relationship.sourceId));
  assert.ok(bySource.coverage.factsExamined < context.page.available);

  const byTarget = await astCommand(root, ['query'], {
    all: true, predicate: 'hierarchy', value: 'Parent', 'max-facts': 1000
  });
  assert.ok(byTarget.facts.some((fact) => fact.target === 'Parent'));
  assert.ok(byTarget.coverage.factsExamined < context.page.available);

  const byPath = await astCommand(root, ['query'], {
    all: true, predicate: 'path', value: 'Hierarchy.java', 'max-facts': 1000
  });
  assert.deepEqual(byPath.facts.map((fact) => fact.path), ['Hierarchy.java']);
  assert.equal(byPath.coverage.factsExamined, 1);
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
  const disabled = await astCommand(root, ['build', first.resumeHandle], {
    resume: true, 'max-files': '10'
  });
  assert.equal(disabled.status, 'disabled');
  assert.ok(disabled.diagnostics.some((entry) => entry.code === 'AST_DISABLED'));
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
  const advertised = adapterManifestValue({
    id: 'typescript-reference',
    languages: ['typescript', 'javascript'],
    assurance: 'syntax',
    argv: ['node', '/opt/adapter.mjs'],
    extractorVersion: '1.0.0',
    capabilities: ['skeleton', 'query']
  });
  const adapter = validateAstAdapterManifest(advertised);
  assert.deepEqual(adapter.argv, ['node', '/opt/adapter.mjs']);
  assert.throws(() => validateAstAdapterManifest({ ...advertised, protocolVersion: 3 }), /protocolVersion/);
  assert.throws(() => validateAstAdapterManifest({ ...advertised, capabilities: 'skeleton' }), /capabilities/);
  assert.throws(() => validateAstAdapterManifest({ ...advertised, capabilities: ['execute-anything'] }), /capabilities/);
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
  const rejected = validateAstAdapterResponse({
    ...response,
    files: [{ path: 'one.ts', sha256: 'a'.repeat(64), facts: [{ kind: 'symbol', name: 'Leak', line: 1, sourceBody: 'secret' }] }]
  }, manifest, request);
  assert.equal(rejected.files.length, 0);
  assert.deepEqual(rejected.rejectedFiles, [{ path: 'one.ts', code: 'AST_ADAPTER_FILE_RESULT_INVALID' }]);
  assert.doesNotMatch(JSON.stringify(rejected), /secret/);
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

test('adapter timeout and cancellation terminate descendants instead of leaving a resident process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-process-tree-'));
  const marker = path.join(root, 'descendant-survived');
  const executable = path.join(root, 'adapter.mjs');
  await writeFile(executable, `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 700)`) }], { stdio: 'ignore' });
    child.unref();
    setInterval(() => {}, 1000);
  `);
  const manifest = validateAstAdapterManifest(adapterManifestValue({
    argv: [process.execPath, executable],
    implementation: { artifactSha256: digest(await readFile(executable)), files: [{ path: executable, sha256: digest(await readFile(executable)) }] }
  }));
  const request = astAdapterRequest({
    operation: 'skeleton', scope: { kind: 'paths' },
    files: [{ path: 'one.ts', sha256: 'a'.repeat(64), language: 'typescript' }],
    budget: { maxFiles: 1, maxBytes: 1000 }, implementation: manifest.implementation
  });
  await assert.rejects(() => executeAstAdapter(manifest, request, { root, timeoutMs: 75 }), (error) => error?.code === 'AST_ADAPTER_TIMEOUT');
  await delay(900);
  await assert.rejects(access(marker), (error) => error?.code === 'ENOENT');

  const controller = new AbortController();
  const cancelled = executeAstAdapter(manifest, request, { root, timeoutMs: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 75);
  await assert.rejects(() => cancelled, (error) => error?.code === 'AST_ADAPTER_CANCELLED');
  await delay(900);
  await assert.rejects(access(marker), (error) => error?.code === 'ENOENT');
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

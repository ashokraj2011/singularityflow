import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { commandDefinition } from '../src/command-registry.mjs';
import { commandModuleFiles } from './helpers/command-source.mjs';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const parsed = new Map();
async function graph(relative) {
  const files = new Set(), pending = [path.resolve(sourceRoot, relative)];
  let bytes = 0;
  while (pending.length) {
    const file = pending.pop(); if (files.has(file)) continue; files.add(file);
    let entry = parsed.get(file);
    if (!entry) {
      const text = await readFile(file, 'utf8');
      const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
      const imports = ast.statements.filter(statement => (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier))
        .map(statement => statement.moduleSpecifier.text).filter(name => name.startsWith('.'))
        .map(name => path.resolve(path.dirname(file), name));
      entry = { bytes: Buffer.byteLength(text), imports }; parsed.set(file, entry);
    }
    bytes += entry.bytes; pending.push(...entry.imports);
  }
  return { files, bytes };
}

test('frequent lifecycle handlers do not reach the legacy dispatcher and stay under their eager budget', async () => {
  for (const name of ['start', 'session', 'choices', 'inputs', 'prepare', 'review-source', 'submit', 'approve', 'phase']) {
    assert.notEqual(commandDefinition(name).modulePath, './commands/legacy.mjs', name);
  }
  for (const file of ['commands/start.mjs', 'commands/session.mjs', 'commands/choices.mjs', 'commands/inputs.mjs',
    'commands/prepare.mjs', 'commands/review-source.mjs', 'commands/submit.mjs', 'commands/approve.mjs', 'commands/phase-lifecycle.mjs']) {
    const closure = await graph(file);
    assert.equal(closure.files.has(path.join(sourceRoot, 'cli.mjs')), false, `${file} re-imported the monolith`);
    if (['commands/approve.mjs', 'commands/phase-lifecycle.mjs'].includes(file)) {
      assert.equal(closure.files.has(path.join(sourceRoot, 'commands/shared/phase-review.mjs')), false,
        `${file} eagerly loads optional full-document rendering for the compact agent route`);
    }
    // 455: phase-lifecycle.mjs reached 455 with the source-review batching (f79ec1fa, 5a25abe8, d18afdc6): the
    // clarification-paths, phase-input-policy and phase-inspection-generation helpers split out of modules it already
    // loaded, plus the source-review snapshot cache.
    // 456: submit.mjs reached 456 on main 97805fde without a recorded raise: creation-context.mjs (0b0dc559, shared Story
    // creation captures), verification/incremental-verification-graph.mjs (4838febb) and workspace-clone-claim.mjs
    // (6e6824f3) joined its graph while clarification-paths.mjs and grounding.mjs left it.
    // 457: phase-staging-paths.mjs, the one derivation of a step's own staging files that phase entry, source review
    // and the Copilot guard share (docs/SPEC-STAGING-PERMISSIONS-v1.md), joined submit.mjs's graph through clarifications.mjs.
    assert.ok(closure.files.size <= 457, `${file} loads ${closure.files.size} local files (budget 457; retired graph 597)`);
    // 9,005,000 (next 5,000 boundary): phase-lifecycle.mjs grew from 8,993,692 (main 4a8e6c42) to 9,004,129 with the
    // capability application block's per-environment arguments and debug validation in capabilities.mjs and the
    // launcher rules it reads (RUN amendment), together with 2ca46d6d's conformance issue ownership; no new file.
    // 9,030,000 (next 5,000 boundary): 2fbfc887 was already 9,020,367, over 9,005,000, before this work (not bisected);
    // environment files (docs/SPEC-ENVIRONMENT-FILES-v1.md) add 6,974 to 9,027,341: the registry policy and the
    // scoped-commit check in git.mjs, document intake's link-aware path check, the exact-path matcher, the operation
    // classes and the gate's file placement call. The engine itself is lazy; no new file.
    assert.ok(closure.bytes <= 9_030_000, `${file} exceeds the 9 MB eager-source budget`);
  }
});

test('root dispatch stays small and orchestration entrypoints load their handlers lazily', async () => {
  const root = await graph('cli-entry.mjs');
  // 39: cli-entry.mjs parses --context-root for every command through execution-context-scope.mjs (f62c3107).
  // 40: creation-context.mjs (0b0dc559, shared Story creation captures) joined root dispatch; main 97805fde was already at 40.
  assert.ok(root.files.size <= 40, `root dispatch loads ${root.files.size} local files`);
  // 770,000 (next 5,000 boundary): 747,457 at 3fd3db0b grew to 768,310 across utility-entry.mjs (7e50d127, decided
  // before repository discovery), execution-context-scope.mjs (f62c3107) and small additions to cli-entry and Git transport.
  // 775,000: 769,967 grew to 772,758 with the source-review batching (f79ec1fa, 5a25abe8, d18afdc6): git-fact-cache.mjs
  // +1,810, util.mjs +713, utility-entry.mjs +268; no new file.
  // 780,000: 774,999 at main 4a8e6c42 grew to 775,081 with the --debug boolean flag (util.mjs) and the app suggest
  // and --application-file registry entries (command-registry.mjs); no new file.
  // 785,000: 779,760 at 2fbfc887 grew to 780,496 with the env files operation classes (command-registry.mjs, read or
  // mutation per action) and the --personal, --from-template and --clear boolean flags (util.mjs); no new file.
  // 790,000: main 97805fde was already 788,225, over 785,000 without a recorded raise. From 780,506 at 322e75e3:
  // creation-context.mjs +3,297 (new, 0b0dc559), git-execution.mjs +808 (8827f9fe, 0b0dc559), work-id.mjs +738,
  // utility-entry.mjs +401 and configuration-assets.mjs +232 (94173271), util.mjs +619 (4838febb), cli-entry.mjs +528,
  // read-scope.mjs +464 (94f42a8c), authoring-skills.mjs +450 (5c6df7fa) and smaller. The per-turn entry rule in
  // copilot-mode.mjs (docs/SPEC-STAGING-PERMISSIONS-v1.md) adds 231 to 788,456.
  assert.ok(root.bytes <= 790_000, `root dispatch loads ${root.bytes} source bytes`);
  assert.equal(root.files.has(path.join(sourceRoot, 'git.mjs')), false);
  assert.equal(root.files.has(path.join(sourceRoot, 'config.mjs')), false);
  for (const entry of ['commands/session-entry.mjs', 'commands/choices-entry.mjs']) {
    assert.equal((await graph(entry)).files.size, 1, `${entry} eagerly imported an implementation`);
  }
});

test('the common session projection does not import attach, state stores or publication writers', async () => {
  const current = await graph('commands/session-current.mjs');
  for (const file of ['commands/session.mjs', 'state-stores.mjs', 'state.mjs', 'workspace.mjs', 'story-publication-service.mjs']) {
    assert.equal(current.files.has(path.join(sourceRoot, file)), false, `session current eagerly loads ${file}`);
  }
  assert.ok(current.files.size <= 220, `session current reaches ${current.files.size} files; old session handler reached 429`);
  assert.ok(current.bytes <= 3_900_000, `session current loads ${current.bytes} source bytes`);
});

test('early phase and grounding-path entries exclude the deferred authoring and review graphs', async () => {
  assert.equal((await graph('phase-entry.mjs')).files.has(path.join(sourceRoot, 'phase-entry-authoring.mjs')), false);
  const leaf = await graph('phase-generation.mjs');
  for (const file of ['grounding.mjs', 'source-review-lifecycle.mjs', 'inputs.mjs', 'worldmodel.mjs']) {
    assert.equal(leaf.files.has(path.join(sourceRoot, file)), false, file);
  }
});

test('a product requirement verdict does not eagerly load the release installer', async () => {
  const closure = await graph('product-requirement.mjs');
  for (const file of ['reinstall.mjs', '../scripts/install-staged-artifacts.mjs']) {
    assert.equal(closure.files.has(path.resolve(sourceRoot, file)), false, file);
  }
});

test('extracted legacy helpers remain part of the development build identity', async () => {
  const identity = await readFile(path.join(sourceRoot, 'build-identity.mjs'), 'utf8');
  const helpers = (await commandModuleFiles()).map(file => file.split(path.sep).join('/'))
    .filter(file => file.startsWith('commands/shared/'));
  assert.ok(helpers.length > 0);
  for (const helper of helpers) {
    assert.ok(identity.includes(`'${helper}'`), `${helper} no longer invalidates a pre-extraction build receipt`);
  }
});

test('moving handlers never leaves unbound command-layer identifiers', async () => {
  const files = ['cli.mjs', ...await commandModuleFiles()].map(file => path.join(sourceRoot, file));
  const program = ts.createProgram(files, { allowJs: true, checkJs: true, noResolve: true,
    types: [], target: ts.ScriptTarget.ESNext });
  // noResolve keeps the check bounded to the command layer. Node globals come from the host;
  // imported names remain declared even when their domain modules are not type-checked here.
  const missing = program.getSemanticDiagnostics().filter(diagnostic => diagnostic.code === 2304
    && !/Cannot find name '(?:process|Buffer|NodeJS)'/.test(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')))
    .map(diagnostic => `${path.relative(sourceRoot, diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  assert.deepEqual(missing, [], 'A handler/helper moved without all of its bindings.');
});

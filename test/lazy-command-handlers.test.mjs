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
    // 458: submit.mjs reached 458 on main 97054d4b without a recorded raise: workspace-story-location-scope.mjs
    // (858465d6, lightweight intake and direct Story worktrees) joined its graph through capability-start.mjs.
    // 459: story-configuration-objects.mjs (b25d3e72, bounded configuration trees) joined submit.mjs's graph through
    // configuration-branch.mjs on main 810418a6 without a recorded raise.
    assert.ok(closure.files.size <= 459, `${file} loads ${closure.files.size} local files (budget 459; retired graph 597)`);
    // 9,005,000 (next 5,000 boundary): phase-lifecycle.mjs grew from 8,993,692 (main 4a8e6c42) to 9,004,129 with the
    // capability application block's per-environment arguments and debug validation in capabilities.mjs and the
    // launcher rules it reads (RUN amendment), together with 2ca46d6d's conformance issue ownership; no new file.
    // 9,030,000 (next 5,000 boundary): 2fbfc887 was already 9,020,367, over 9,005,000, before this work (not bisected);
    // environment files (docs/SPEC-ENVIRONMENT-FILES-v1.md) add 6,974 to 9,027,341: the registry policy and the
    // scoped-commit check in git.mjs, document intake's link-aware path check, the exact-path matcher, the operation
    // classes and the gate's file placement call. The engine itself is lazy; no new file.
    // 9,035,000 (next 5,000 boundary): start.mjs was 9,028,819 on main a4aa046f; c2ac5250 (a decision input reuses the
    // value an earlier decision recorded, so branches come back together) added 4,037 bytes to workflow-decisions.mjs,
    // which every Story transition reads, and the build/import-team export actions 257 to command-registry.mjs: 9,033,113.
    // No new file.
    // 9,040,000 (next 5,000 boundary): the workflow-audit leftovers (50d5a5ce: approval's --yes remediation route,
    // the gate's re-check of a human generation's clarification record, the after-start origin in the MCP tool policy)
    // added 765 and verification steps that run the repository's tests (cfcbd295: the repositoryTests setting in
    // config.mjs and state.mjs) 1,871, together 9,035,749. The test runner itself is lazy; no new file.
    // 9,045,000 (next 5,000 boundary): the packaged sample user-defined agent (careful-change) adds its
    // agent, starter template, folder and manifest digests to packaged-asset-history.mjs and its work type
    // and step to packaged-workflow-history.mjs, which every Story start reads: 9,041,169. No new file.
    // 9,050,000 (next 5,000 boundary): start.mjs was 9,044,104 on main 507ade77; the read operations of Jira,
    // Initiative, Epic, knowledge, harness, regression and init --check, so a read-only Copilot turn may run them
    // (command-registry.mjs, +4,101), give 9,048,205. No new file.
    // 9,055,000 (next 5,000 boundary): the office enrollment blocker and its routes (29d5e906, 946f9716) add
    // 12,014 to 9,053,183: transport-intents.mjs +4,923 (a push's reason, retry and missing-checkout helpers),
    // commands/start.mjs +1,069 and configuration-people.mjs +989 (start carries on with a pending enrollment
    // from the main checkout), publication-unit-of-work.mjs +701, state.mjs +632, refusal-remediation.mjs +558,
    // sequence.mjs +501, util.mjs +388 (a missing working folder) and smaller. No new file.
    // 9,060,000 (next 5,000 boundary): both of the above together, merged at main 24466a14 + work-turns: 9,058,321.
    // 9,065,000 (next 5,000 boundary): Nx Playwright inference and the test command proposal add 1,867 to
    // main ed71e5e6's 9,059,694: code-delivery-tests.mjs +1,160 (an Nx project as a module and its lazy loader),
    // narration/messages.mjs +399 and command-registry.mjs +308. nx-test-targets.mjs and test-setup-proposal.mjs
    // load lazily. No new file.
    // 9,070,000 (next 5,000 boundary): the 2026-10-24 round (World Model v5 M4-M5, XPL2 M2-M4, INT P1-P4, SPEC-OUT
    // REQ-014, their review fixes and the free-text option parser) adds 3,729 to main 4a72b80f's 9,063,836:
    // command-registry.mjs +1,958 (wm rules, wm brief --polish, explain --narrate and the gateway command), git.mjs +897
    // (XPL2's lineCommitAt), util.mjs +623 (free-text options, commentary and polish flags), inject.mjs +192. No new file.
    // 9,075,000 (next 5,000 boundary): a Story branch carries only its own workflow's configuration closure, adding
    // 7,737 to main 1ecccc54's 9,065,911: configuration-branch.mjs +5,679 (closure materialization and its re-derived
    // check), commands/start.mjs +1,114 (closure inputs and the whole-copy fallback notice), config.mjs +956 (the
    // pinned initialization status doctor now shares). story-configuration-closure.mjs loads lazily. No new file.
    // 9,080,000 (next 5,000 boundary): SPEC-OAP M0 adds 1,385 to main 445e65b7's 9,073,648: specification-gate.mjs
    // +873 (approvalChecklistPrompt, the checklist articles phase show and the refusal name so Copilot can approve a
    // checklist phase) and state.mjs +512 (APPROVAL_CHECKLIST_INCOMPLETE with the unanswered articles): 9,075,033.
    // No new file.
    assert.ok(closure.bytes <= 9_080_000, `${file} exceeds the 9 MB eager-source budget (${closure.bytes} bytes)`);
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
  // 795,000: main 810418a6 was 790,885, over 790,000 without a recorded raise: creation-context.mjs +875,
  // git-remote-diagnostics.mjs +622 and cli-entry.mjs +56 (b3c8bf7f..810418a6, cold Story creation and configuration
  // reuse); no new file.
  // 800,000: main 507ade77 was 794,526; the read operations of Jira, Initiative, Epic, knowledge, harness, regression
  // and init --check, so a read-only Copilot turn may run them (command-registry.mjs, +4,101), give 798,627. No new file.
  // 800,000: the enrollment blocker fix and its routes (29d5e906, 946f9716) take 795,000 to 795,379:
  // cli-entry.mjs +465 (routes for an unavailable workspace) and util.mjs +388 (Git started in a missing folder
  // names it); no new file. Both together at the merge (main 24466a14 + work-turns): 799,406.
  // 805,000: the 2026-10-24 round takes main 4a72b80f's 799,730 to 802,311: command-registry.mjs +1,958 (the new wm,
  // explain and gateway entries) and util.mjs +623 (free-text options and new flags); no new file.
  assert.ok(root.bytes <= 805_000, `root dispatch loads ${root.bytes} source bytes`);
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

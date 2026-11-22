/**
 * A copy slip of a path SFlow returned is corrected, never a dead end [owner, 2026-11-20].
 *
 * The owner's Story (VS Code, /sf-code implementation): phase entry returned the checkout
 * `…/story-worktrees/.w-36c01dbdd0dd64e8addaee8d`; the model read a file under `….w-36c01dbdd0dd64e8addaee8e8dd`, three
 * characters off, and stopped on "real missing-file errors keep their path", offering /sf-recover. Now the failure
 * hook names the exact returned path. Nothing is searched or guessed: only one mistyped name of a returned path, and
 * only when the corrected file is there.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pathSlipAnswer, pathSlipOf } from '../src/path-slip.mjs';
import { publishedSpecificationStory } from './helpers/source-review-fixture.mjs';
import { recordRepositoryBoundaryTurn, repositoryToolFailure } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';

const FOLDER = '.w-36c01dbdd0dd64e8addaee8d';
const TYPED = '.w-36c01dbdd0dd64e8addaee8e8dd';

async function checkout(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-path-slip-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'raj-calc', '.singularity-flow', 'story-worktrees', FOLDER);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'calc.mjs'), 'export const add = (a, b) => a + b;\n');
  return { base, root };
}

test('the owner\'s mistyped worktree folder is corrected to the returned checkout; other paths never are', async (t) => {
  const { base, root } = await checkout(t);
  const typed = path.join(base, 'raj-calc', '.singularity-flow', 'story-worktrees', TYPED, 'src', 'calc.mjs');
  assert.equal(pathSlipOf(typed, [root]), path.join(root, 'src', 'calc.mjs'));
  // A missing file under the returned checkout is a real missing file: no correction, its own rule applies.
  assert.equal(pathSlipOf(path.join(root, 'src', 'gone.mjs'), [root]), null);
  // A different folder, two names off, or a file the corrected checkout does not hold: never guessed.
  assert.equal(pathSlipOf(path.join(base, 'raj-calc', '.singularity-flow', 'story-worktrees', '.w-ffffffffffffffffffffffff', 'src', 'calc.mjs'), [root]), null);
  assert.equal(pathSlipOf(path.join(base, 'raj-calk', '.singularity-flow', 'story-worktrees', TYPED, 'src', 'calc.mjs'), [root]), null);
  assert.equal(pathSlipOf(path.join(base, 'raj-calc', '.singularity-flow', 'story-worktrees', TYPED, 'src', 'other.mjs'), [root]), null);
  // An edit that creates a file gets the returned folder when that folder is there.
  assert.equal(pathSlipOf(path.join(path.dirname(typed), 'new.mjs'), [root], { write: true }), path.join(root, 'src', 'new.mjs'));
  // A relative path resolves against the call's own folder first.
  const answer = pathSlipAnswer([{ paths: ['src/calc.mjs'], cwd: path.dirname(path.dirname(typed)) }], [root]);
  assert.deepEqual(answer.pathCorrections, [{ attemptedPath: 'src/calc.mjs', issuedPath: path.join(root, 'src', 'calc.mjs'), operation: 'read' }]);
  assert.match(answer.additionalContext, /is not a path SFlow returned: it is a copy slip of .*This is not a missing file and not a blocker\./u);
});

test('a relative .sflow/out result path resolved against another folder (a VS Code workspace on the main clone) gets the checkout\'s file', async (t) => {
  const { base, root } = await checkout(t);
  await mkdir(path.join(root, '.sflow', 'out'), { recursive: true });
  await writeFile(path.join(root, '.sflow', 'out', 'phase-enter-1.json'), '{}\n');
  const main = path.join(base, 'raj-calc');
  assert.equal(pathSlipOf(path.join(main, '.sflow', 'out', 'phase-enter-1.json'), [root]), path.join(root, '.sflow', 'out', 'phase-enter-1.json'));
  assert.equal(pathSlipOf(path.join(main, '.sflow', 'out', 'other.json'), [root]), null, 'only a result the checkout holds');
  assert.equal(pathSlipOf(path.join(main, 'src', 'calc.mjs'), [root]), null, 'never a repository file under another folder');
  const answer = pathSlipAnswer([{ paths: ['.sflow/out/phase-enter-1.json'] }], [root], { cwd: main });
  assert.equal(answer.pathCorrections[0].issuedPath, path.join(root, '.sflow', 'out', 'phase-enter-1.json'));
});

test('an issued private file whose path the agent rebuilt from another start gets the issued path back', async (t) => {
  // The owner's verification review, 2026-11-22: two folders dropped from the front of the issued report path.
  const { base } = await checkout(t);
  const git = path.join(base, 'raj-calc', 'repos', 'myc', '.git', 'worktrees', '-w-3d5c930cb04673dd6c161852');
  const issued = path.join(git, 'singularity-flow', 'source-reviews', 'd-story-verification-gen11.json');
  await mkdir(path.dirname(issued), { recursive: true });
  await writeFile(issued, '{}\n');
  const rebuilt = path.join(base, 'raj-calc', '.git', 'worktrees', '-w-3d5c930cb04673dd6c161852', 'singularity-flow', 'source-reviews', 'd-story-verification-gen11.json');
  assert.equal(pathSlipOf(rebuilt, [issued]), issued);
  assert.equal(pathSlipOf(path.join(base, 'elsewhere', 'singularity-flow', 'source-reviews', 'd-story-verification-gen11.json'), [issued]), issued, 'any front');
  // Another step's or generation's file, a file outside SFlow's private folder, or an issued file not there: never.
  assert.equal(pathSlipOf(rebuilt.replace('gen11', 'gen10'), [issued]), null);
  assert.equal(pathSlipOf(path.join(base, 'raj-calc', 'source-reviews', 'd-story-verification-gen11.json'), [issued]), null);
  assert.equal(pathSlipOf(rebuilt, [issued.replace('gen11', 'gen12')]), null);
  // Two issued files with the same tail (two checkouts) name no single file: no correction.
  const twin = path.join(base, 'other', '.git', 'singularity-flow', 'source-reviews', 'd-story-verification-gen11.json');
  await mkdir(path.dirname(twin), { recursive: true });
  await writeFile(twin, '{}\n');
  assert.equal(pathSlipOf(rebuilt, [issued, twin]), null);
  const answer = pathSlipAnswer([{ paths: [rebuilt] }], [issued]);
  assert.deepEqual(answer.pathCorrections, [{ attemptedPath: rebuilt, issuedPath: issued, operation: 'read' }]);
});

test('the failure hook hands the exact returned path back for a mistyped review staging path, instead of a blocker', async (t) => {
  const item = await publishedSpecificationStory(t);
  const root = await realpath(item.root);
  const prior = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(root, '.git', 'path-slip-hooks', 'mode.json');
  t.after(() => { if (prior === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE; else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = prior; });
  const hook = { sessionId: 'path-slip', cwd: root, prompt: `/sf-review-source ${item.phaseId}` };
  await recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, record) => captureMutationTurn(payload, record, { resolveRoot: async () => root }) });
  // The reviewer's context writes the report skeleton at its staging path and issues it to this turn.
  const { loadAcceptedStoryExecution } = await import('../src/accepted-story-execution.mjs');
  const { sourceReviewContext } = await import('../src/source-review-lifecycle.mjs');
  const { sourceReviewStagingPath } = await import('../src/phase-staging-paths.mjs');
  const { gitDir } = await import('../src/git-execution.mjs');
  const { config, workflow } = await loadAcceptedStoryExecution(root);
  const staging = sourceReviewStagingPath(gitDir(root), workflow, workflow.phases[item.phaseId]);
  await sourceReviewContext(root, config, workflow, item.phaseId, staging);
  const typed = staging.replace(/-gen(\d+)\.json$/u, '-gne$1.json');
  // Before the read runs, the guard hands the returned path back instead of a failed read.
  const before = await mutationToolGuard({ ...hook, toolName: 'view', toolArgs: { path: typed } });
  assert.equal(before.permissionDecision, 'deny');
  assert.deepEqual(before.pathCorrections, [{ attemptedPath: typed, issuedPath: staging, operation: 'read' }]);
  assert.match(before.permissionDecisionReason, /^CLI_ISSUED_PATH_MISMATCH: .* is not a path SFlow returned: it is a copy slip of /u);
  assert.deepEqual(await mutationToolGuard({ ...hook, toolName: 'view', toolArgs: { path: staging } }), {}, 'the returned path reads as before');
  // The staging path rebuilt from another folder, its front dropped (the owner's verification review, 2026-11-22).
  const rebuilt = path.join(path.dirname(root), 'elsewhere', staging.slice(staging.lastIndexOf(`${path.sep}singularity-flow${path.sep}`) + 1));
  const front = await mutationToolGuard({ ...hook, toolName: 'view', toolArgs: { path: rebuilt } });
  assert.equal(front.permissionDecision, 'deny');
  assert.deepEqual(front.pathCorrections, [{ attemptedPath: rebuilt, issuedPath: staging, operation: 'read' }]);
  const answer = await repositoryToolFailure({ ...hook, toolName: 'view', toolArgs: { path: typed }, error: `ENOENT: no such file or directory, open '${typed}'` });
  assert.match(answer.additionalContext ?? JSON.stringify(answer), new RegExp(`it is a copy slip of ${staging.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
  assert.doesNotMatch(answer.additionalContext, /explicit blocker/u);
  // A path SFlow never returned and that is no slip of one keeps the existing failure route.
  const other = await repositoryToolFailure({ ...hook, toolName: 'view', toolArgs: { path: path.join(root, 'nowhere', 'file.md') }, error: 'ENOENT: no such file or directory' });
  assert.doesNotMatch(other.additionalContext ?? '', /copy slip/u);
});

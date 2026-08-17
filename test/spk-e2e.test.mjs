/**
 * The end-to-end fixture. `[SPK:AC-008]`
 *
 * One Story, from a fresh clone, through specification, planning, implementation, deterministic
 * convergence, a human-selected rework, a second convergence iteration, verification, conformance
 * and release. Every command is the real binary against a real git repository.
 *
 * The reason a fixture this long earns its runtime is that nothing else in the suite can catch a
 * *sequencing* defect. Each unit test builds exactly the state its subject needs; only a full run
 * discovers that one phase leaves state the next cannot use, or that a gate someone added at
 * publication makes a later phase unreachable. Both of those have happened in this pack, and both
 * were found by driving rather than by testing.
 *
 * The Story is deliberately small — two requirements and a handful of files. Length here buys
 * nothing; the value is in the transitions between phases, not the size of the artifacts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const WORK = 'E2E-1';

function shell(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_LOG_CONSOLE: 'error' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\nexit ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

const git = (cwd, ...args) => shell('git', args, cwd).stdout.trim();
const sflow = (cwd, args, options) => shell(process.execPath, [CLI, ...args], cwd, options);

async function write(root, relative, contents) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), contents);
}

const workflowOf = async (root) =>
  JSON.parse(await readFile(path.join(root, `singularity/work-items/${WORK}/workflow.json`), 'utf8'));

/**
 * Commit and push anything the publication transaction left behind.
 *
 * Under `git.publish: required` the transaction commits and pushes for itself, so there is usually
 * nothing here — but source files written outside a governed generation are the caller's, and a
 * commit that finds nothing is a normal outcome rather than a failure.
 */
function settle(root, message) {
  if (!git(root, 'status', '--porcelain')) return;
  git(root, 'add', '-A');
  git(root, 'commit', '-m', message);
  shell('git', ['push', '-q', 'origin', WORK], root, { allowFailure: true });
}

/** Publish, commit, submit and approve one phase the way a person would. */
async function completePhase(root, phase, { articles = [] } = {}) {
  sflow(root, ['artifact', 'scan', '--phase', phase]);
  sflow(root, ['phase', 'publish', phase, '--authored', 'human', '--channel', 'manual-in-place']);
  settle(root, `[${WORK}][phase:${phase}] settle`);
  sflow(root, ['submit', phase, '--skip-checks']);
  const approval = ['approve', phase, '--yes', ...articles.flatMap((article) => ['--article', article])];
  const result = sflow(root, approval, { allowFailure: true });
  if (result.status !== 0 && !/already approved|not awaiting/.test(result.output)) {
    throw new Error(`approve ${phase}\n${result.output}`);
  }
  return result;
}

const SATISFIED = [
  'completeness=satisfied', 'ambiguity=satisfied', 'consistency=satisfied',
  'verifiability=satisfied', 'boundary-conditions=satisfied', 'non-functional=satisfied'
];

test('a Story runs specification through release from a fresh clone', async (t) => {
  t.diagnostic('AC-008 drives the real binary through every phase; it is slow on purpose.');

  // ---- a fresh clone, with a remote, exactly as a team would have -------------------------------
  const origin = await mkdtemp(path.join(os.tmpdir(), 'sflow-e2e-origin-'));
  // -b main: a bare repository's HEAD otherwise points at this git's default branch name, and a
  // clone of it checks out a branch that does not exist — an empty tree that fails much later.
  shell('git', ['init', '-q', '--bare', '-b', 'main', '.'], origin);
  const seed = await mkdtemp(path.join(os.tmpdir(), 'sflow-e2e-seed-'));
  git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', 'End To End');
  git(seed, 'config', 'user.email', 'e2e@example.invalid');
  await write(seed, 'README.md', '# Payments\n');
  await write(seed, 'src/payments/attempts.ts', 'export const attempts = [];\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  // `init` writes the governed definition on a Work-ID branch and leaves it uncommitted, so the
  // base branch is never touched by accident. Seeding `main` means committing it there deliberately.
  sflow(seed, ['init', '--work-id', 'SEED', '--base', 'main']);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'governance');
  git(seed, 'checkout', '-q', 'main');
  git(seed, 'checkout', '-q', 'SEED', '--', 'singularity', '.github');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'governance');
  git(seed, 'push', '-q', 'origin', 'main');

  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-e2e-clone-'));
  shell('git', ['clone', '-q', '-b', 'main', origin, '.'], root);
  git(root, 'config', 'user.name', 'End To End');
  git(root, 'config', 'user.email', 'e2e@example.invalid');

  sflow(root, ['start', WORK, '--from-branch', 'main', '--work-type', 'spec-driven-standard',
    '--title', 'Retry a failed payment', '--description', 'Let an operator retry a payment that failed at the provider.']);
  assert.equal((await workflowOf(root)).currentPhase, 'specification');

  /**
   * `[SPK:REQ-019]`: a fast-path action is resumable and idempotent at the same binding.
   *
   * The Story is at the first checkpoint, which is where a person actually repeats a verb — they
   * run `specify`, read that an agent has to author the artifact, and run it again to see where
   * they are. Twice must be exactly once: same answer, no commit, no state, no dirty tree. A verb
   * that half-advanced here would do it before anyone had authored anything to advance.
   */
  const head = git(root, 'rev-parse', 'HEAD');
  const firstSpecify = sflow(root, ['specify']).output;
  const secondSpecify = sflow(root, ['specify']).output;
  assert.equal(secondSpecify, firstSpecify, 'a repeated fast-path verb answered differently');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head, 'a fast-path checkpoint created a commit');
  assert.equal(git(root, 'status', '--porcelain'), '', 'a fast-path checkpoint left the tree dirty');
  assert.match(firstSpecify, /No governed state, files, publications or external systems were changed/);
  assert.deepEqual((await workflowOf(root)).phases.specification.artifacts, [],
    'a fast-path checkpoint registered an artifact nobody authored');

  // ---- specification ---------------------------------------------------------------------------
  await write(root, `singularity/work-items/${WORK}/artifacts/specification/spec.md`, [
    '# Specification — Retry a failed payment', '',
    '## Actors', '', 'An operator holding the payments role.', '',
    '## User scenarios', '',
    '- **Given** a payment that failed at the provider',
    '  **When** an operator retries it',
    '  **Then** a new attempt is created and the original is preserved.', '',
    '## Requirements', '',
    '- The system creates a new attempt when an operator retries a failed payment. [E2E:REQ-001]',
    '- The system preserves the original failed attempt and its provider response. [E2E:REQ-002]', ''
  ].join('\n'));
  await completePhase(root, 'specification', { articles: SATISFIED });
  assert.equal((await workflowOf(root)).phases.specification.status, 'approved');

  // The specification's artifact set was catalogued and the approval bound the whole bundle.
  const afterSpecification = await workflowOf(root);
  assert.equal(afterSpecification.phases.specification.artifactSet.setId, 'spec-driven-specification');
  assert.match(afterSpecification.phases.specification.approvals.at(-1).bundleSha256, /^[0-9a-f]{64}$/);
  assert.equal(afterSpecification.phases.specification.approvals.at(-1).checklist.length, 6);

  // ---- planning, with the advisory task map derived from the approved specification -------------
  sflow(root, ['spec', 'tasks']);
  const tasks = await readFile(path.join(root, `singularity/work-items/${WORK}/artifacts/planning/tasks.md`), 'utf8');
  assert.match(tasks, /E2E:REQ-001/);
  assert.match(tasks, /not evidence/, 'the derived task map does not declare itself advisory');

  await write(root, `singularity/work-items/${WORK}/artifacts/planning/plan.md`, [
    '# Implementation plan — Retry a failed payment', '',
    '## Approach', '', 'Append a new attempt row rather than mutating the failed one.', '',
    '## Affected surfaces', '',
    '| Surface | Change | Serves |', '|---|---|---|',
    '| `src/payments/retry.ts` | new retry handler | E2E:REQ-001 |',
    '| `src/payments/attempts.ts` | append-only attempts | E2E:REQ-002 |', '',
    '## Verification', '',
    '| Clause | Proof |', '|---|---|', '| E2E:REQ-001 | retry creates an attempt |', ''
  ].join('\n'));
  await completePhase(root, 'planning');
  assert.equal((await workflowOf(root)).phases.planning.status, 'approved');

  // ---- implementation: source and artifact, one requirement deliberately unclaimed --------------
  await write(root, 'src/payments/retry.ts', 'export function retry() { return { attempt: 1 }; }\n');
  await write(root, `singularity/work-items/${WORK}/artifacts/implementation/implementation-summary.md`, [
    '# Implementation summary', '',
    'Added the retry handler. The append-only change to attempts is not done yet, so this generation',
    'deliberately claims only one of the two requirements — the convergence iteration below is what',
    'that omission is for.', '',
    '## Changes', '', '- `src/payments/retry.ts`: new retry handler serving E2E:REQ-001.', ''
  ].join('\n'));
  sflow(root, ['prepare', 'implementation'], { allowFailure: true });
  await completePhase(root, 'implementation');
  assert.equal((await workflowOf(root)).phases.implementation.status, 'approved');

  // ---- convergence, iteration one ---------------------------------------------------------------
  const first = sflow(root, ['story', 'converge', '--json']);
  const iteration = JSON.parse(first.stdout);
  assert.equal(iteration.iteration, 1);
  assert.ok(iteration.facts.length > 0, 'convergence found nothing on a Story with an unclaimed requirement');
  assert.deepEqual(iteration.allowedNext, ['adjudicate'], 'undisposed facts allowed something other than adjudication');
  assert.deepEqual(iteration.findings, [], 'a fact became a finding without a human');

  // Every fact describes the record, never the implementation `[SPK:CON-033]`.
  for (const fact of iteration.facts) {
    for (const match of fact.detail.matchAll(/\b(unimplemented|unplanned)\b/g)) {
      assert.match(fact.detail.slice(0, match.index), /\bnot\b[^.]*$/, `a fact overstates: ${fact.detail}`);
    }
  }

  // A human disposes of each one; the REQ-002 absence becomes rework.
  const absent = iteration.facts.find((fact) => fact.kind === 'absent-observed-claim' && fact.clauseIds.includes('E2E:REQ-002'))
    ?? iteration.facts.find((fact) => fact.kind === 'absent-observed-claim');
  assert.ok(absent, 'no absent-claim fact to adjudicate');
  sflow(root, ['story', 'adjudicate', absent.id, '--disposition', 'rework', '--clause', 'E2E:REQ-002']);
  for (const fact of iteration.facts.filter((entry) => entry.id !== absent.id)) {
    sflow(root, ['story', 'adjudicate', fact.id, '--disposition', 'dismissed', '--reason', 'Refactor noise; no requirement claims it.']);
  }

  const blocked = JSON.parse(sflow(root, ['story', 'converge', '--json']).stdout);
  assert.ok(blocked.unresolvedBlockers.length, 'rework produced no blocker');
  assert.deepEqual(blocked.allowedNext, ['create-rework']);
  // `[SPK:REQ-183]`: advancement fails while a blocker remains.
  const refused = sflow(root, ['story', 'advance', '--confirm'], { allowFailure: true });
  assert.notEqual(refused.status, 0, 'advancement succeeded with an unresolved blocker');
  assert.match(refused.output, /cannot advance to verification/i);

  // ---- human-selected rework, through the existing governed change request `[SPK:AC-003]` -------
  // `story rework`, the one caller allowed to return an unsubmitted convergence phase, and only
  // because the projection it names carries a blocking rework finding.
  const preview = sflow(root, ['story', 'rework']);
  assert.match(preview.output, /would return E2E-1 to implementation/i);
  sflow(root, ['story', 'rework', '--confirm',
    '--reason', 'REQ-002 has no observed claim; append-only attempts are still missing.']);
  const reopened = await workflowOf(root);
  assert.equal(reopened.currentPhase, 'implementation');
  assert.equal(reopened.changeRequests.at(-1).targetPhase, 'implementation');
  assert.deepEqual(reopened.changeRequests.at(-1).clauseIds, ['E2E:REQ-002']);
  // `[SPK:REQ-082]`: the prior convergence record survives the rework.
  await readFile(path.join(root, `singularity/work-items/${WORK}/context/convergence/iteration-1.json`), 'utf8');

  // ---- implementation, generation two ------------------------------------------------------------
  await write(root, 'src/payments/attempts.ts', 'export const attempts = [];\nexport function append(attempt) { return [...attempts, attempt]; }\n');
  await write(root, `singularity/work-items/${WORK}/artifacts/implementation/implementation-summary.md`, [
    '# Implementation summary', '',
    'Second generation. Attempts are now append-only, so the original failed attempt and its provider',
    'response are preserved alongside the new one.', '',
    '## Changes', '',
    '- `src/payments/retry.ts`: retry handler serving E2E:REQ-001.',
    '- `src/payments/attempts.ts`: append-only attempts serving E2E:REQ-002.', ''
  ].join('\n'));
  await completePhase(root, 'implementation');

  // ---- convergence, iteration two `[SPK:REQ-083]` ------------------------------------------------
  const second = JSON.parse(sflow(root, ['story', 'converge', '--json']).stdout);
  assert.equal(second.iteration, 2, 'the new implementation generation did not open a new iteration');
  assert.notEqual(second.bindings.reconciliation.sha256, iteration.bindings.reconciliation.sha256,
    'the second iteration bound the first iteration\'s reconciliation');

  for (const fact of second.facts) {
    sflow(root, ['story', 'adjudicate', fact.id, '--disposition', 'accepted-deviation',
      '--reason', 'Trace evidence is recorded in the implementation summary and reviewed.']);
  }
  const resolved = JSON.parse(sflow(root, ['story', 'converge', '--json']).stdout);
  assert.deepEqual(resolved.unresolvedBlockers, []);
  assert.deepEqual(resolved.allowedNext, ['advance-to-verification']);

  // ---- advancement, verification and release -----------------------------------------------------
  await write(root, `singularity/work-items/${WORK}/artifacts/convergence/convergence.md`, [
    '# Convergence — iteration 2', '',
    'Every deterministic fact carries a recorded human disposition. Two iterations were needed: the',
    'first returned the Story to implementation because E2E:REQ-002 had no observed claim, and the',
    'second found the append-only attempts change recorded against it.', '',
    '## Dispositions', '',
    'All remaining facts were accepted as deviations, each with a reason on the record. No blocking',
    'finding remains, so advancement to verification is a decision a human can now take.', ''
  ].join('\n'));
  sflow(root, ['artifact', 'scan', '--phase', 'convergence']);
  // Convergence pins `producer: deterministic` — the artifact is derived from the projection, not
  // authored — so publishing it as human authorship is correctly refused.
  sflow(root, ['phase', 'publish', 'convergence', '--authored', 'deterministic', '--channel', 'kernel-generator']);
  settle(root, `[${WORK}][phase:convergence] settle`);
  sflow(root, ['story', 'advance', '--confirm']);
  assert.equal((await workflowOf(root)).phases.convergence.status, 'awaiting_approval');
  sflow(root, ['approve', 'convergence', '--yes']);
  assert.equal((await workflowOf(root)).currentPhase, 'verification');

  await write(root, `singularity/work-items/${WORK}/artifacts/verification/test-evidence.md`, [
    '# Test evidence', '',
    'Both requirements are covered by executed checks against the second implementation generation.', '',
    '## Results', '',
    '- E2E:REQ-001 — retry creates a new attempt: passed.',
    '- E2E:REQ-002 — the original failed attempt is preserved: passed.', '',
    '## Environment', '', 'Local Node test runner against the Story branch head.', ''
  ].join('\n'));
  await completePhase(root, 'verification');
  assert.equal((await workflowOf(root)).currentPhase, 'release');

  // Release carries the conformance report `[SPK:AC-008]`.
  await write(root, `singularity/work-items/${WORK}/artifacts/release/conformance.md`, [
    '# Conformance — Retry a failed payment', '',
    'Approved intent traces to executed evidence for both requirements, through two convergence',
    'iterations and one governed rework.', '',
    '## Clause coverage', '',
    '- E2E:REQ-001 — implemented in `src/payments/retry.ts`, verified.',
    '- E2E:REQ-002 — implemented in `src/payments/attempts.ts`, verified.', '',
    '## Deviations', '', 'None outstanding.', ''
  ].join('\n'));
  await completePhase(root, 'release');

  const complete = await workflowOf(root);
  assert.equal(complete.status, 'complete', `the Story did not complete: ${complete.status} at ${complete.currentPhase}`);
  assert.equal(complete.currentPhase, null);
  for (const phase of ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release']) {
    assert.equal(complete.phases[phase].status, 'approved', `${phase} is ${complete.phases[phase].status}`);
  }
  // Two implementation generations, because a human sent it back once.
  assert.equal(complete.phases.implementation.generation, 2);
  assert.equal(complete.changeRequests.length, 1);
  assert.equal(complete.changeRequests[0].status, 'resolved', 'the change request was never resolved by the rework');
});

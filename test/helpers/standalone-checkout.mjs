/**
 * A checkout no workspace registers, and the reads that name a repository in their results.
 *
 * Without a workspace a host has no registered repository ID, and the checkout's absolute path used
 * to stand in for one: it reached result cards, logs and model context through every planner that
 * echoes the repository. The editor session and the CLI host each run this corpus.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { childTimeout } from './child-timeout.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: childTimeout(60_000) });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** One Story, a postal check on main, and a branch that changes it. */
export async function standaloneCheckout(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-standalone-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'dev@example.test');
  git(root, 'config', 'user.name', 'Dev');
  await mkdir(path.join(root, 'singularity', 'work-items', 'WRK-1'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'work-items', 'WRK-1', 'workflow.json'), JSON.stringify({
    workItem: { id: 'WRK-1', title: 'Postal check', workType: 'feature', branch: 'main' },
    phaseOrder: ['design'], currentPhase: 'design', phases: { design: { status: 'in_progress', generation: 1 } },
    history: [{ event: 'work_started', phase: 'design', actor: { email: 'dev@example.test' }, at: '2026-10-20T10:00:00.000Z' }]
  }));
  await writeFile(path.join(root, 'checkout.mjs'), 'export function postal() { return true; }\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'postal check');
  git(root, 'checkout', '-q', '-b', 'feature-postal');
  await writeFile(path.join(root, 'checkout.mjs'), 'export function postal(code) { return Boolean(code); }\n');
  git(root, 'commit', '-q', '-am', 'postal needs a code');
  git(root, 'checkout', '-q', 'main');
  return root;
}

/** Every read planner that names the repository it read, given the ID a result calls it by. */
export const repositoryReads = (repositoryId) => [
  { operation: 'home.overview', request: { utterance: 'home' } },
  { operation: 'developer.next', request: { utterance: 'what should I do next' } },
  { operation: 'work.list', request: { utterance: 'my work' } },
  { operation: 'problem.investigate', request: { utterance: 'investigate this bug', arguments: { symptom: 'postal check fails at checkout' } } },
  { operation: 'repository.query', request: { utterance: 'show repository history', arguments: { query: 'log', max: 5 } } },
  { operation: 'repository.query', request: { utterance: 'search this repository', arguments: { query: 'search', text: 'postal' } } },
  { operation: 'repository.query', request: { utterance: 'show repository history', arguments: { query: 'repositories' } } },
  { operation: 'compare', request: { utterance: 'compare these', arguments: { subjectKind: 'branch', left: 'main', right: 'feature-postal' } } },
  { operation: 'impact.quick', request: { utterance: 'quick impact analysis', arguments: { baseRef: 'main', targetRef: 'feature-postal' } } },
  // The ID a result gives the repository is one it accepts back as an argument.
  { operation: 'repository.explore', request: { utterance: 'explore this repository', arguments: { repositoryId } } },
  { operation: 'intent.trace', request: { utterance: 'why does this code exist', arguments: { repositoryId, path: 'checkout.mjs' } } }
];

/** Resolve and read each request through `kernel`; every result it answered, keyed by its read. */
export async function readEach(kernel, reads) {
  const answered = [];
  for (const { operation, request } of reads) {
    const resolved = await kernel.resolve(request);
    const handle = resolved.kind === 'read' && resolved.next.length === 1 ? resolved.next[0].handle : null;
    const result = handle ? await kernel.read({ resolutionId: handle }) : resolved;
    assert.equal(result.operation?.id, operation, `${request.utterance}: ${JSON.stringify(result.why)}`);
    assert.notEqual(result.kind, 'refusal', `${request.utterance}: ${JSON.stringify(result.why)}`);
    answered.push(resolved, result);
  }
  return answered;
}

/** No string anywhere in any result names the checkout by its path, in either spelling of a temp path. */
export function assertNoCheckoutPath(results, root) {
  // macOS reaches its temp directory through /var, a link to /private/var; the shorter spelling
  // is inside the longer, so one search finds both. JSON escapes a Windows path's backslashes.
  const needle = JSON.stringify(root.replace(/^\/private(?=\/)/u, '')).slice(1, -1);
  for (const result of results) {
    assert.equal(JSON.stringify(result).includes(needle), false,
      `${result.operation?.id ?? result.kind} carried the checkout path`);
  }
}

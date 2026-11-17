/**
 * Settling an opening as the same operation, without loops (review of the opening flow, 2026-11-17):
 *   - finding 1: a writer takeover whose push did not land. `session takeover` moves the version's writer fence with its own
 *     operation; when its push is not answered, that operation's checkpoint stays pending, and the step's view holds the
 *     version on it, naming `phase opening <step> --reconcile`. Reconciling settled only the original opening's operation, so
 *     it said "accepted" and the view named the same reconcile again, forever. Now the reconcile settles the operation the
 *     view reads: the takeover's, when the writer was taken over [OSA:REQ-033, REQ-034];
 */
import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { approvedSpecificationStory, implementationPlan, CLI } from './helpers/submitted-planning-story.mjs';
import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { gitDirectories, readCheckpoint } from '../src/story-version-acceptance.mjs';
import { takeOverWriter } from '../src/story-version-opening.mjs';

const json = (result) => JSON.parse(result.stdout);

/** A Story whose code step `implementation` published version 1, its branch pushed (as test/osa-stage2-opening.test.mjs). */
async function publishedCode(t, WORK) {
  const story = await approvedSpecificationStory(t, WORK);
  const { root, cli, item } = story;
  const write = async (relative, text) => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), text); };
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks'); cli('approve', 'planning', '--yes');
  cli('prepare', 'implementation');
  const clauses = [`${WORK}:AC-001`, `${WORK}:REQ-002`];
  await write('src/value.mjs', `${clauses.map((clause) => `// @clause:${clause} returns the approved value to its callers\n`).join('')}export const value = 1;\n`);
  await write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n${clauses.map((clause) => `// @ac:${clause}\n`).join('')}test('value', () => assert.ok(value >= 1));\n`);
  await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), ['# Implementation summary', '', '## Agent brief', '',
    'Added the value module; both clauses have one focused test that reads the approved value.', '', '## Changed components and decisions', '',
    '- `src/value.mjs` exports the approved value.', '', '## Tests and operational notes', '', '`test/value.test.mjs` verifies the value.', ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/implementation/operator-notes.md'), ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  return { ...story, remote: path.join(story.directory, 'origin.git'), branch: story.git('branch', '--show-current') };
}

test('a takeover whose push did not land is settled by the reconcile its view names, which then names the writing, not itself again', async (t) => {
  const story = await publishedCode(t, 'OSA-TKR');
  const { directory, run } = story;
  const preview = json(story.cli('phase', 'rollover', 'implementation', '--reason', 'Return the value with its unit', '--json'));
  json(run(process.execPath, [CLI, '--no-model', ...preview.argv, '--json']));
  // A second checkout of the same remote takes the version over while the remote does not answer.
  const other = path.join(directory, 'second');
  run('git', ['clone', '-q', story.remote, other], { cwd: directory });
  run('git', ['-C', other, 'checkout', '-q', story.branch], { cwd: directory });
  run('git', ['-C', other, 'config', 'user.name', 'History Tester'], { cwd: directory });
  run('git', ['-C', other, 'config', 'user.email', 'history@example.test'], { cwd: directory });
  const at = (...args) => run(process.execPath, [CLI, '--no-model', ...args], { cwd: other, allowFailure: true });
  const { loadAcceptedStoryExecution } = await import('../src/accepted-story-execution.mjs');
  const accepted = await loadAcceptedStoryExecution(other, 'OSA-TKR');
  await rename(story.remote, `${story.remote}.away`);
  let taken = null;
  try { taken = await takeOverWriter(other, accepted.definition ?? accepted.config, accepted.workflow, accepted.workflow.phases.implementation, { principal: { name: 'History Tester' } }); }
  catch { taken = null; }
  const pointer = (await loadAcceptedStoryExecution(other, 'OSA-TKR')).workflow.phases.implementation.versionOpening;
  const takeover = pointer.writer.operationId;
  assert.notEqual(takeover, pointer.operationId, `the takeover has its own operation: ${JSON.stringify(taken)}`);
  assert.notEqual(readCheckpoint(gitDirectories(other).commonDir, 'OSA-TKR', takeover)?.state, 'shared-confirmed', 'its push did not land');
  // The view holds the version on the takeover's acceptance and names the reconcile.
  const hook = { cwd: other, sessionId: 'osa-tkr', prompt: '/sf-code implementation' };
  const refresh = () => recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, value) => captureMutationTurn(payload, value, { resolveRoot: async () => other }) });
  await refresh();
  const held = await mutationToolGuard({ ...hook, toolName: 'edit', toolArgs: { path: path.join(other, 'src/value.mjs') } });
  assert.equal(held.permissionDecision, 'deny');
  assert.match(JSON.stringify(held.next), /phase opening implementation --reconcile/u);
  // With the remote back, the reconcile it names settles the takeover itself, and the writer writes.
  await rename(`${story.remote}.away`, story.remote);
  const settled = at('phase', 'opening', 'implementation', '--reconcile', '--json');
  assert.equal(settled.status, 0, settled.stdout + settled.stderr);
  assert.equal(json(settled).outcome.operationId, takeover, JSON.stringify(json(settled)).slice(0, 1500));
  assert.equal(readCheckpoint(gitDirectories(other).commonDir, 'OSA-TKR', takeover).state, 'shared-confirmed');
  assert.doesNotMatch(JSON.stringify(json(settled).next ?? null), /--reconcile/u, 'the reconcile does not name itself again');
  await refresh();
  assert.deepEqual(await mutationToolGuard({ ...hook, toolName: 'edit', toolArgs: { path: path.join(other, 'src/value.mjs') } }), {}, 'the new writer writes');
});


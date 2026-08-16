/**
 * The return briefing's "when", from the host that has it. `[DHR:REQ-024]`
 *
 * `work.return` chooses between `return.since-you-were-here` and `return.current-state` on whether
 * it was given an acknowledgement time, because a reader shown a delta reads everything absent from
 * it as unchanged. `int-work-return.test.mjs` covers both branches — by calling
 * `workReturnResult(item, { acknowledgedAt })` directly.
 *
 * That test was green while the feature was dead. The field was declared on the planner, defaulted
 * to null, and threaded the whole way through `plannerContext`, and **no caller anywhere supplied
 * it**: the CLI passes a context without it and the editor host passed no context at all. So the
 * briefing could only ever take the second branch — correctly, permanently, and invisibly.
 *
 * These tests cover the seam rather than the function: that a value put into `plannerContext`
 * reaches the planner, and that the host actually puts one there. A contract exercised from one
 * side cannot show the two sides disagreeing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHostGateway } from '../src/gateway/host.mjs';
import { run } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function repository() {
  const directory = await mkdtemp(path.join(tmpdir(), 'sflow-ack-'));
  run('git', ['init', '-q', '-b', 'main'], { cwd: directory });
  run('git', ['config', 'user.email', 'dev@example.test'], { cwd: directory });
  run('git', ['config', 'user.name', 'Dev'], { cwd: directory });
  await writeFile(path.join(directory, 'README.md'), '# fixture\n');
  run('git', ['add', '-A'], { cwd: directory });
  run('git', ['commit', '-q', '-m', 'first'], { cwd: directory });
  return directory;
}

/** A planner that answers nothing and records what it was handed. */
function capturingPlanner(seen) {
  return async ({ context }) => {
    seen.push(context);
    return {
      schemaVersion: 2,
      resultType: 'sflow-result',
      kind: 'read',
      operation: { id: 'home.overview', classification: 'read' },
      outcome: { status: 'succeeded', messageId: 'gateway.home', slots: {} },
      effects: {
        contextChanged: false, stateChanged: false, filesChanged: false,
        gitRefsChanged: false, publicationCreated: false, externalSystemsChanged: false
      },
      why: [], warnings: [], preserved: [], checklist: [], next: [],
      restState: 'informational', data: {}
    };
  };
}

test('a value the host puts in plannerContext reaches the planner', async (t) => {
  const directory = await repository();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const seen = [];
  const { kernel } = createHostGateway({
    root: directory,
    hostSessionId: 'ack-1',
    planners: new Map([['home-overview', capturingPlanner(seen)]]),
    plannerContext: () => ({ acknowledgedAt: '2026-08-16T09:00:00.000Z' })
  });

  const resolution = await kernel.resolve({ utterance: 'home' });
  await kernel.read({ resolutionId: resolution.next[0].handle });

  assert.equal(seen.length, 1, 'the planner ran');
  assert.equal(seen[0].acknowledgedAt, '2026-08-16T09:00:00.000Z',
    'the supplied context reaches the planner rather than being replaced by the host defaults');
  // The host's own facts survive alongside it; supplying one key must not drop the rest.
  assert.equal(seen[0].repositoryId, directory);
  assert.ok(seen[0].workspace, 'the host still supplies its own context');
});

test('a thunk is re-read per call, so a later acknowledgement is the one used', async (t) => {
  const directory = await repository();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const seen = [];
  let acknowledged = null;
  const { kernel } = createHostGateway({
    root: directory,
    hostSessionId: 'ack-2',
    planners: new Map([['home-overview', capturingPlanner(seen)]]),
    plannerContext: () => ({ acknowledgedAt: acknowledged })
  });

  const readOnce = async () => {
    const resolution = await kernel.resolve({ utterance: 'home' });
    return kernel.read({ resolutionId: resolution.next[0].handle });
  };

  await readOnce();
  acknowledged = '2026-08-16T10:30:00.000Z';
  await readOnce();

  /**
   * The reason the host passes a function.
   *
   * An editor session outlives any particular acknowledgement — the reader presses "Mark as
   * checked" and the very next briefing must use the new time. A captured value would keep
   * answering with whatever was current when the repository was opened, which is the same
   * stale-snapshot failure the binding thunk exists to prevent one layer down.
   */
  assert.equal(seen[0].acknowledgedAt, null, 'nothing acknowledged yet');
  assert.equal(seen[1].acknowledgedAt, '2026-08-16T10:30:00.000Z', 'the second read sees the new time');
});

test('the editor host actually supplies an acknowledgement, and from its own store', async () => {
  /**
   * The half that makes the seam load-bearing.
   *
   * A working `plannerContext` with nobody passing anything through it is the state this was in
   * for as long as the field has existed. Asserting the wiring at the source is crude and is the
   * only thing that distinguishes "the mechanism works" from "the mechanism is used".
   */
  const session = await readFile(path.join(root, 'apps', 'vscode', 'src', 'gateway-session.ts'), 'utf8');
  assert.match(session, /plannerContext:\s*\(\)\s*=>\s*\(\{\s*acknowledgedAt/,
    'the editor session passes acknowledgedAt into plannerContext as a thunk');

  const extension = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');
  assert.match(extension, /provideAcknowledgedAt\(/,
    'the extension registers a provider for it');
  assert.match(extension, /globalState\.get<HomeAcknowledgement>\(lastHome\.key\)\?\.at/,
    'and the value comes from the acknowledgement the card stored, not a second source');
});

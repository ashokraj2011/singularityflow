import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createWarmReadFixture, bindPhaseReadFixture } from '../scripts/warm-read-fixture.mjs';

for (const storyMode of ['legacy', 'pinned', 'amended']) {
  test(`bound ${storyMode} phase entry composes context and worker guidance observes the same binding`, { timeout: 180_000 }, async t => {
    const f = await createWarmReadFixture({ storyMode, phaseReady: true, artifacts: 8 });
    const adapter = await import(pathToFileURL(path.join(f.engine, 'src/read-worker-client.mjs')).href);
    t.after(async () => { adapter.disposeReadWorkers(); await f.cleanup(); });
    f.env.SINGULARITY_FLOW_AGENT_OUTPUT = 'raw';
    await bindPhaseReadFixture(f);
    const before = f.git(['rev-parse', 'HEAD']);
    const order = structuredClone(f.state.phaseOrder);
    for (const compose of [false, true, true]) {
      const value = f.cold(['phase', 'enter', f.phaseId, '--work-id', f.workId,
        ...(compose ? ['--compose'] : []), '--for-agent', '--json']);
      assert.equal(value.ready, true); assert.equal(value.activeAgent, 'developer');
      assert.equal(value.phaseAgent.valid, true); assert.equal(value.workId, f.workId);
      assert.equal(value.contextAdmission.allowed, true);
      if (compose) {
        assert.ok(value.context?.text.length > 100);
        assert.equal(value.context.generation, 1);
        assert.ok(value.context.file?.path);
      }
      assert.equal(value.effects.testsRun, false); assert.equal(value.effects.storyAdvanced, false);
      assert.equal(value.effects.committed, false); assert.equal(value.effects.pushed, false);
    }
    const args = ['nextsteps', f.workId, '--for-agent', '--json'];
    const read = () => adapter.readWithWorker({ executable: process.execPath, cli: f.cli,
      repository: f.repository, env: f.env, args });
    const cold = f.cold(args), worker = await read();
    assert.equal(worker?.kind, 'value'); assert.equal(worker.value.ready, true);
    assert.equal(worker.value.workId, cold.workId);
    assert.deepEqual(worker.value.actions, cold.actions);
    assert.deepEqual(worker.value.mutationContract, cold.mutationContract);
    assert.equal((await read()).transport, 'warm-worker');
    const privateGit = f.git(['rev-parse', '--absolute-git-dir']);
    const sessionPath = path.join(privateGit, 'singularity-flow/session.json');
    const original = await readFile(sessionPath, 'utf8'), stale = JSON.parse(original);
    stale.phaseId = 'not-current';
    await writeFile(sessionPath, JSON.stringify(stale));
    assert.equal((await read()).value.ready, false, 'a warm worker must not retain an author binding');
    await writeFile(sessionPath, original);
    assert.equal((await read()).value.ready, true);
    assert.equal(f.git(['rev-parse', 'HEAD']), before);
    assert.deepEqual(JSON.parse(await readFile(f.statePath, 'utf8')).phaseOrder, order);
    assert.equal(f.state.phases[f.phaseId].approvals.length, 0);
  });
}

/**
 * The staged engine can actually serve a topic.
 *
 * `CLI_PAYLOAD` omitted `docs`, and the result was the worst possible shape of failure. The topic
 * *index* lives in `src/docs-manifest.json` and was staged, so the VS Code Help view listed all 32
 * topics and looked entirely healthy — while the topic *bodies* live in `docs/topics/` and were
 * not, so every single one failed on click with a bare `ENOENT: scandir`. A missing index would at
 * least have shown an empty list and been obviously broken.
 *
 * Asserting the payload list is not enough: the point is not that a string appears in an array, it
 * is that a reader clicking a topic in an installed extension gets prose. So this stages the engine
 * the way packaging does and runs the real command against it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a packaged install serves the topics its index advertises', async () => {
  const { CLI_PAYLOAD, stageCli } = await import('../scripts/vscode-dev.mjs');

  // Staged somewhere disposable: the real location is inside apps/vscode and a test must not
  // depend on, or disturb, whatever a developer has there.
  const extensionDir = await mkdtemp(path.join(os.tmpdir(), 'sflow-stage-'));
  const staged = await stageCli({ extensionDir });

  const manifest = JSON.parse(
    await import('node:fs/promises').then((fs) => fs.readFile(path.join(staged, 'src/docs-manifest.json'), 'utf8'))
  );
  const advertised = manifest.topics ?? [];
  assert.ok(advertised.length >= 10, `the staged index advertises only ${advertised.length} topics`);

  // Every advertised topic must have a body beside it, because the index is what the Help view
  // renders and clicking any row runs `explain <id>`.
  const bodies = (await readdir(path.join(staged, 'docs/topics')).catch(() => []))
    .filter((name) => name.endsWith('.md'));
  assert.equal(bodies.length, advertised.length,
    `the staged engine advertises ${advertised.length} topics and ships ${bodies.length} bodies`);

  // And the command a reader actually triggers returns prose, not a filesystem error.
  const cli = path.join(staged, 'bin/singularity-flow.mjs');
  for (const topic of [advertised[0].id, advertised.at(-1).id]) {
    const result = spawnSync(process.execPath, [cli, 'explain', topic, '--json'], { encoding: 'utf8', cwd: root });
    assert.equal(result.status, 0, `explain ${topic} failed from the staged engine: ${result.stderr.trim()}`);
    const served = JSON.parse(result.stdout).data?.served?.text ?? '';
    assert.ok(served.length > 100, `explain ${topic} served ${served.length} bytes from the staged engine`);
  }

  // The payload names `docs` explicitly, so a future edit to the list has to decide about it rather
  // than drop it by omission.
  assert.ok(CLI_PAYLOAD.includes('docs'), 'CLI_PAYLOAD no longer stages the topic bodies');
});

test('a build with no topic tree says so, instead of reporting a scandir error', async () => {
  /**
   * The condition has one cause and one fix, and the reader is not at fault for either. It used to
   * surface as `ENOENT: no such file or directory, scandir '<path>/docs/topics'`, which names a
   * path nobody recognises and offers nothing to do.
   */
  const { loadTopics } = await import('../src/docs-topics.mjs');
  const empty = await mkdtemp(path.join(os.tmpdir(), 'sflow-nodocs-'));
  await assert.rejects(() => loadTopics(path.join(empty, 'docs/topics')), (error) => {
    assert.equal(error.code, 'DOCS_TOPICS_MISSING');
    assert.match(error.message, /shipped without its topic tree/);
    assert.match(error.message, /Reinstall Singularity Flow/);
    return true;
  });
});

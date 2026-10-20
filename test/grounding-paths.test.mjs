import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { groundingRecordRelative } from '../src/grounding-paths.mjs';
import { groundingRecordRelative as compatibilityPath } from '../src/grounding.mjs';

test('read-only grounding paths preserve the exact writer path and generation watermark', () => {
  for (const workItemRoot of [undefined, 'custom/story-records']) {
    for (const phase of [{ id: 'intake', generation: 0 },
      { id: 'repair', generation: 1, generationHighWatermark: 4 }]) {
      const definition = { workItemRoot };
      const workflow = { workItem: { id: 'PATH-001' } };
      const next = phase.generationHighWatermark ? 5 : 1;
      assert.equal(groundingRecordRelative(definition, workflow, phase),
        `${workItemRoot ?? 'singularity/work-items'}/PATH-001/context/${phase.id}-gen${next}.json`);
      assert.equal(groundingRecordRelative(definition, workflow, phase), compatibilityPath(definition, workflow, phase));
      assert.equal(groundingRecordRelative(definition, workflow, phase, 7),
        compatibilityPath(definition, workflow, phase, 7));
    }
  }
});

test('a read-only path lookup cannot pull composition, lifecycle review or input writers into its closure', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = await build({ absWorkingDir: root, entryPoints: ['src/grounding-paths.mjs'],
    bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent' });
  const inputs = Object.keys(result.metafile.inputs).map(file => file.split(path.sep).join('/'));
  for (const owner of ['grounding.mjs', 'inputs.mjs', 'source-review-lifecycle.mjs', 'state.mjs']) {
    assert.equal(inputs.some(file => file.endsWith(`/${owner}`)), false, owner);
  }
  const command = await readFile(new URL('../src/commands/nextsteps.mjs', import.meta.url), 'utf8');
  assert.match(command, /import \{ groundingRecordRelative \} from '\.\.\/grounding-paths\.mjs'/u);
  assert.doesNotMatch(command, /const \{ groundingRecordRelative \} = await import/u);
  assert.match(command, /requiresProspectivePhaseInspection \} from '\.\.\/phase-inspection-generation\.mjs'/u);
});

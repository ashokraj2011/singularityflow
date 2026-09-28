/** XPL2 capture identity: a subject view never mixes two repository moments. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadComprehensionIdeSlice } from '../src/comprehension/ide-slice.mjs';
import { createChangeRepository } from './helpers/xpl2-fixture.mjs';

const lines = (count, render) => `${Array.from({ length: count }, (_, index) => render(index + 1)).join('\n')}\n`;

test('XPL2-AC-020 Code and evidence cannot race: a moving tree gives one snapshot or a refusal', async (t) => {
  const files = Array.from({ length: 6 }, (_, index) => `src/moving-${index}.ts`);
  const baseline = Object.fromEntries(files.map((file) => [file, lines(20, (line) => `export const v${line} = ${line};`)]));
  const change = Object.fromEntries(files.map((file) => [file, lines(20, (line) => line === 3 ? 'export const v3 = 30;' : `export const v${line} = ${line};`)]));
  const { root } = await createChangeRepository(t, { baseline, change });

  // A writer keeps editing the tree while captures run. Every capture must either describe one
  // coherent moment end to end or refuse with the owner's snapshot-changed code; the invariant is
  // checked on every outcome, so a quiet run cannot pass by accident and a busy one cannot flake.
  let writing = true;
  let revision = 0;
  const writer = (async () => {
    while (writing) {
      revision += 1;
      const file = files[revision % files.length];
      await writeFile(path.join(root, file), lines(20, (line) => line === 3 ? `export const v3 = ${revision};` : `export const v${line} = ${line};`));
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  })();
  const outcomes = { coherent: 0, refused: 0 };
  try {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      let slice;
      try {
        slice = await loadComprehensionIdeSlice(root, { includeExplanationInputs: true });
      } catch (error) {
        assert.equal(error.code, 'CMP_SNAPSHOT_CHANGED', `an unexpected refusal: ${error.message}`);
        outcomes.refused += 1;
        continue;
      }
      outcomes.coherent += 1;
      const view = slice.explanationView;
      assert.ok(view, slice.explanationViewUnavailableReason);
      // One manifest binds the diff, the code explanation and the subject view.
      assert.equal(view.snapshot.manifestSha256, slice.manifest.manifestSha256);
      assert.equal(view.snapshot.changeSetSha256, slice.manifest.changeSetSha256);
      assert.equal(slice.diff.changeSetSha256, slice.manifest.changeSetSha256);
      assert.equal(view.snapshot.codeExplanationSetSha256, slice.codeExplanation.explanationSetSha256);
      assert.deepEqual(view.inventory.units.map((unit) => unit.regionSha256).sort(),
        slice.codeExplanation.units.map((unit) => unit.regionSha256).sort());
      for (const reference of slice.sourceReferences) {
        assert.ok(slice.manifest.regions.some((region) => region.regionSha256 === reference.regionSha256), 'every source reference names this manifest');
      }
    }
  } finally {
    writing = false;
    await writer;
  }
  assert.equal(outcomes.coherent + outcomes.refused, 12);
});

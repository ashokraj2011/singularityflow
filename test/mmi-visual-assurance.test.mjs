import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decodePngRgba8, encodePngRgba8 } from '../src/png-rgba8.mjs';
import { compareVisualArtifacts } from '../src/visual-compare.mjs';
import { evaluateVisualCoverage } from '../src/visual-coverage.mjs';

function workflow(root) {
  return { workItem: { id: 'VIS-1' }, resolution: { workItemRoot: 'singularity/work-items', verification: { coverage: 'enforce', profiles: [{ id: 'phone', width: 2, height: 1, deviceScaleFactor: 1 }], comparison: { mode: 'enforce', channelTolerance: 0, maxDifferingPixelRatio: 0, maxDifferingPixels: 0, maxPixels: 100 } } }, phases: { 'visual-verification': { id: 'visual-verification', generation: 1 } } };
}

test('RGBA8 PNG codec and deterministic visual comparison', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-visual-'));
  const item = path.join(root, 'singularity/work-items/VIS-1');
  await mkdir(path.join(item, 'input'), { recursive: true });
  const a = encodePngRgba8({ width: 2, height: 1, data: Buffer.from([0,0,0,255, 255,255,255,255]) });
  const b = encodePngRgba8({ width: 2, height: 1, data: Buffer.from([1,0,0,255, 255,255,255,255]) });
  assert.deepEqual(decodePngRgba8(a).data, Buffer.from([0,0,0,255, 255,255,255,255]));
  await writeFile(path.join(root, 'a.png'), a); await writeFile(path.join(root, 'b.png'), b);
  const result = await compareVisualArtifacts(root, workflow(root), { expected: 'a.png', actual: 'b.png', profileId: 'phone' });
  assert.equal(result.status, 'fail'); assert.equal(result.differingPixels, 1); assert.equal(result.regions.length, 1);
});

test('enforced visual coverage reports a missing configured profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-coverage-'));
  await mkdir(path.join(root, 'singularity/work-items/VIS-1'), { recursive: true });
  const result = await evaluateVisualCoverage(root, workflow(root));
  assert.equal(result.status, 'fail'); assert.deepEqual(result.uncovered, ['phone']);
});

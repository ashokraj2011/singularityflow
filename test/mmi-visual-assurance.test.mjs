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

test('PNG decoding rejects malformed, corrupt, and over-budget inputs', () => {
  assert.throws(() => decodePngRgba8(Buffer.from('not a png')), /not a PNG/);
  const valid = encodePngRgba8({ width: 2, height: 1, data: Buffer.alloc(8, 255) });
  const corrupt = Buffer.from(valid);
  corrupt[20] ^= 0xff;
  assert.throws(() => decodePngRgba8(corrupt), /CRC is invalid/);
  assert.throws(() => decodePngRgba8(valid, { maxPixels: 1 }), /pixel limit/);
});

test('visual comparison reports dimension mismatch without producing a misleading pixel diff', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-visual-dimensions-'));
  await mkdir(path.join(root, 'singularity/work-items/VIS-1'), { recursive: true });
  await writeFile(path.join(root, 'expected.png'), encodePngRgba8({ width: 2, height: 1, data: Buffer.alloc(8, 255) }));
  await writeFile(path.join(root, 'actual.png'), encodePngRgba8({ width: 1, height: 1, data: Buffer.alloc(4, 255) }));

  const result = await compareVisualArtifacts(root, workflow(root), {
    expected: 'expected.png', actual: 'actual.png', profileId: 'phone'
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.disposition, 'dimension-mismatch');
  assert.deepEqual(result.dimensions, {
    expected: { width: 2, height: 1 }, actual: { width: 1, height: 1 }
  });
  assert.equal(result.diffImage, null);
});

test('comparison enforce without a threshold is refused, because it could never fail', async () => {
  // With both thresholds null, thresholdStatus can never mark a comparison as exceeded, so every
  // comparison returned pass however different the images were and the enforce branch was
  // unreachable for pixel differences. A team writing `mode: enforce` believes visual regressions
  // block the gate; they did not. `coverage: enforce` already applies this rule to profiles.
  const { normalizeVerificationPolicy } = await import('../src/config.mjs');
  assert.throws(
    () => normalizeVerificationPolicy({ coverage: 'warn', comparison: { mode: 'enforce', channelTolerance: 8 } }),
    /enforce requires maxDifferingPixels or maxDifferingPixelRatio/
  );
  // A threshold of zero is a threshold: any differing pixel fails.
  assert.equal(
    normalizeVerificationPolicy({ coverage: 'warn', comparison: { mode: 'enforce', maxDifferingPixels: 0 } }).comparison.maxDifferingPixels,
    0
  );
  // warn is unaffected: it never claimed to block anything.
  assert.equal(normalizeVerificationPolicy({ coverage: 'warn', comparison: { mode: 'warn' } }).comparison.mode, 'warn');
});

test('visual evidence that will not parse fails the gate instead of vanishing', async () => {
  // This module is the only reader, writer and validator of the evidence tree, so a swallowed parse
  // error meant a comparison recorded as `fail` could be truncated or edited into invalid JSON and
  // simply disappear: the gate counted zero failures and passed.
  const { listVisualComparisons } = await import('../src/visual-compare.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-visual-evidence-'));
  const item = path.join(root, 'singularity/work-items/VIS-1');
  const evidence = path.join(item, 'artifacts/visual-verification/evidence');
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'good.json'),
    `${JSON.stringify({ kind: 'visual-comparison', id: 'cmp-1', status: 'pass' })}\n`);
  await writeFile(path.join(evidence, 'damaged.json'), '{"kind":"visual-comparison","id":"cmp-2","stat');

  const results = await listVisualComparisons(root, workflow(root), { itemDirectory: item });
  const damaged = results.find((entry) => entry.unreadable);
  assert.ok(damaged, 'the damaged record is reported rather than discarded');
  assert.equal(damaged.status, 'fail');
  assert.match(damaged.path, /damaged\.json$/);
  assert.equal(results.filter((entry) => !entry.unreadable).length, 1, 'and the readable one still loads');
});

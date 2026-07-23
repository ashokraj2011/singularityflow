import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyVisualEvidence,
  extractVisualDifference,
  isPreviewImage
} from '../apps/desktop/src/visual-evidence.mjs';

test('visual evidence classifies pinned designs, build captures, and diff highlights', () => {
  const records = [
    { id: 'DOC-001', type: 'file', phase: 'design-intake', label: 'Checkout.png', kind: 'figma-export', mimeType: 'image/png' },
    { id: 'ART-VISUAL-01', type: 'artifact', phase: 'visual-verification', label: 'checkout-actual.png', path: 'artifacts/visual-verification/evidence/checkout-actual.png', mimeType: 'image/png' },
    { id: 'ART-VISUAL-02', type: 'artifact', phase: 'visual-verification', label: 'checkout-pixelmatch-diff.png', path: 'artifacts/visual-verification/evidence/checkout-pixelmatch-diff.png', mimeType: 'image/png' },
    { id: 'DOC-002', type: 'file', phase: 'design-intake', label: 'Specification.pdf', mimeType: 'application/pdf' }
  ];
  const result = classifyVisualEvidence(records);
  assert.deepEqual(result.pinnedDesigns.map((item) => item.id), ['DOC-001']);
  assert.deepEqual(result.builds.map((item) => item.id), ['ART-VISUAL-01']);
  assert.deepEqual(result.diffs.map((item) => item.id), ['ART-VISUAL-02']);
  assert.equal(isPreviewImage(records[3]), false);
});

test('visual difference extraction preserves the reported metric and verdict', () => {
  assert.deepEqual(extractVisualDifference('Pixel diff: 1.8% — matched within threshold.'), { percent: 1.8, verdict: 'matched' });
  assert.deepEqual(extractVisualDifference('| checkout | 2.4% visual difference | deviated |'), { percent: 2.4, verdict: 'reported' });
  assert.equal(extractVisualDifference('No numeric comparison was recorded.'), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeCaptureScale } from '../src/visual-coverage.mjs';

const phone = { id: 'phone-390x844', width: 390, height: 844, deviceScaleFactor: 1 };

test('a native capture fits its profile at the declared size or a whole-number multiple of it, never another shape', () => {
  assert.equal(nativeCaptureScale(phone, { width: 390, height: 844 }), 1);
  // An iPhone Simulator screenshot of the same 390×844 point screen is taken at 3x.
  assert.equal(nativeCaptureScale(phone, { width: 1170, height: 2532 }), 3);
  assert.equal(nativeCaptureScale(phone, { width: 780, height: 1688 }), 2);
  assert.equal(nativeCaptureScale(phone, { width: 1179, height: 2556 }), null, 'a 393×852 screen is another profile');
  assert.equal(nativeCaptureScale(phone, { width: 1950, height: 4220 }), null, 'no more than 4x');
  assert.equal(nativeCaptureScale(phone, { width: 844, height: 390 }), null, 'landscape is another shape');
  assert.equal(nativeCaptureScale({ ...phone, deviceScaleFactor: 2 }, { width: 780, height: 1688 }), 2);
});

test('a profile that declares a density is never met below it', () => {
  const retina = { id: 'phone-390x844-3x', width: 390, height: 844, deviceScaleFactor: 3 };
  assert.equal(nativeCaptureScale(retina, { width: 1170, height: 2532 }), 3);
  assert.equal(nativeCaptureScale(retina, { width: 390, height: 844 }), null);
  assert.equal(nativeCaptureScale(retina, { width: 780, height: 1688 }), null);
});

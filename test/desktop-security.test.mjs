import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTrustedRendererUrl,
  safeExternalUrl
} from '../apps/desktop/electron/desktop-security.mjs';

test('desktop renderer trust matches the configured origin without prefix confusion', () => {
  const expected = 'http://127.0.0.1:5173';
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173/', expected), true);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173/workflow', expected), true);
  assert.equal(isTrustedRendererUrl('http://localhost:5173/', expected), false);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173@evil.example/', expected), false);
  assert.equal(isTrustedRendererUrl('not a URL', expected), false);
});

test('packaged renderer trust requires the exact application file', () => {
  const expected = 'file:///Applications/Singularity.app/Contents/Resources/app/dist/index.html';
  assert.equal(isTrustedRendererUrl(expected, expected, { packaged: true }), true);
  assert.equal(isTrustedRendererUrl(`${expected}#injected`, expected, { packaged: true }), false);
  assert.equal(isTrustedRendererUrl('file:///tmp/index.html', expected, { packaged: true }), false);
});

test('desktop opens only credential-free HTTPS links externally', () => {
  assert.equal(safeExternalUrl('https://docs.example.com/guide'), 'https://docs.example.com/guide');
  assert.equal(safeExternalUrl('http://docs.example.com/guide'), null);
  assert.equal(safeExternalUrl('https://user:secret@docs.example.com/guide'), null);
  assert.equal(safeExternalUrl('file:///tmp/secret'), null);
  assert.equal(safeExternalUrl('not a URL'), null);
});

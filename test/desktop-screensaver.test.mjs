import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = path.join(root, 'apps', 'desktop', 'src', 'App.jsx');
const screensaverRoot = path.join(root, 'apps', 'desktop', 'public', 'screensaver');

const expectedSlides = [
  'poster-05-epic-to-stories.png',
  'poster-06-who-approved.png',
  'poster-07-one-workspace.png',
  'poster-08-maturity.png',
  'poster-09-grounding.png',
  'poster-10-trust.png'
];

test('desktop screensaver is reachable and all bundled posters exist', async () => {
  const source = await readFile(appSource, 'utf8');
  assert.match(source, /\['screensaver', 'Screensaver'\]/);
  assert.match(source, /function Screensaver/);
  for (const slide of expectedSlides) {
    assert.match(source, new RegExp(`screensaver/${slide}`));
    await access(path.join(screensaverRoot, slide));
  }
});

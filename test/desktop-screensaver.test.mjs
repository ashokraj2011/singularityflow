import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = path.join(root, 'apps', 'desktop', 'src', 'App.jsx');
const appStyles = path.join(root, 'apps', 'desktop', 'src', 'styles.css');
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
  assert.match(source, /setInterval\(\(\) => go\(1\), 2600\)/);
  assert.doesNotMatch(source, /screensaver-filmstrip/);
  assert.doesNotMatch(source, /screensaver-controls/);
  for (const slide of expectedSlides) {
    assert.match(source, new RegExp(`screensaver/${slide}`));
    await access(path.join(screensaverRoot, slide));
  }
});

test('desktop screensaver presents bright full-screen posters with captions only', async () => {
  const styles = await readFile(appStyles, 'utf8');
  assert.match(styles, /\.screensaver-image[^{]+{[^}]*object-fit: contain/);
  assert.match(styles, /\.screensaver-image[^{]+{[^}]*brightness\(1\.09\)/);
  assert.match(styles, /\.screensaver-caption/);
  assert.doesNotMatch(styles, /\.screensaver-filmstrip/);
  assert.doesNotMatch(styles, /\.screensaver-controls/);
});

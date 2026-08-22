import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const boundary = 'Search only within the working repository; governed artifacts are under singularity/work-items/<WORK-ID>/.';

test('every packaged and template agent carries the repository search boundary', async () => {
  const directories = [path.join(root, 'plugin', 'agents'), path.join(root, 'templates', 'agents')];
  for (const directory of directories) {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.md'));
    assert.ok(names.length > 0);
    for (const name of names) {
      const content = await readFile(path.join(directory, name), 'utf8');
      assert.match(content, new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), name);
    }
  }
});

test('the two broadest skill reads state their governed base and repository fence', async () => {
  const epicStories = await readFile(path.join(root, 'plugin', 'skills', 'sflow-epic-stories', 'SKILL.md'), 'utf8');
  const implement = await readFile(path.join(root, 'plugin', 'skills', 'sflow-implement', 'SKILL.md'), 'utf8');
  assert.match(epicStories, /singularity\/initiatives\/<EPIC-ID>\/artifacts\/epic-planning\/story-plan\.yml/);
  assert.match(implement, /Inspect further files only as the implementation requires within this repository\./);
});

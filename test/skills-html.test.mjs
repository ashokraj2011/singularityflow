import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

test('the shareable HTML catalog contains every packaged skill and no external dependency', async () => {
  const skills = (await readdir(path.join(root, 'plugin', 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const html = await readFile(path.join(root, 'docs', 'SINGULARITY-FLOW-SKILLS.html'), 'utf8');

  assert.match(html, new RegExp(`<strong>${skills.length}</strong> skills`));
  assert.equal((html.match(/class="skill-card"/g) ?? []).length, skills.length);
  for (const skill of skills) {
    const source = await readFile(path.join(root, 'plugin', 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(html, new RegExp(`id="${skill}"`), `${skill} is absent from the HTML catalog`);
    assert.match(html, new RegExp(`plugin/skills/${skill}/SKILL\\.md`));
    assert.ok(html.includes(escapeHtml(source)), `${skill} does not include its complete source`);
  }
  assert.doesNotMatch(html, /<(?:script|link|img)\b[^>]+(?:src|href)=["']https?:/i);
  assert.match(html, /data-source="sflow-start"/);
  assert.match(html, /Complete skill instructions/);
});

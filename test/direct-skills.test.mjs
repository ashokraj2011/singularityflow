import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copilotSkillsDirectory,
  directSkillName,
  installDirectSkills,
  isManagedDirectSkill,
  renderDirectSkill,
  uninstallDirectSkills
} from '../src/direct-skills.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'plugin', 'skills');

test('direct skill names shorten sflow-* to sf-*', () => {
  assert.equal(directSkillName('sflow-submit'), 'sf-submit');
  assert.throws(() => directSkillName('submit'), /Expected sflow-<action>/);
});

test('direct skill rendering preserves the full contract while changing slash references', () => {
  const source = `---\nname: sflow-submit\ndescription: Submit\n---\n\n# Submit\nUse /sflow-approve after publishing.\n`;
  const rendered = renderDirectSkill(source, 'sflow-submit');
  assert.match(rendered, /^name: sf-submit$/m);
  assert.match(rendered, /Use \/sf-approve after publishing/);
  assert.ok(isManagedDirectSkill(rendered));
  assert.doesNotMatch(rendered, /name: sflow-submit/);
  assert.equal(
    rendered
      .replace(/^name: sf-submit$/m, 'name: sflow-submit')
      .replaceAll('/sf-', '/sflow-')
      .replace('<!-- managed-by: singularity-flow direct-skill-alias -->\n', ''),
    source
  );
});

test('direct skill rendering accepts Windows CRLF and a UTF-8 BOM', () => {
  const source = `\uFEFF---\r\nname: sflow-submit\r\ndescription: Submit\r\n---\r\n\r\n# Submit\r\nUse /sflow-approve.\r\n`;
  const rendered = renderDirectSkill(source, 'sflow-submit');
  assert.match(rendered, /^\uFEFF---\r\nname: sf-submit\r$/m);
  assert.match(rendered, /Use \/sf-approve\./);
  assert.match(rendered, /---\r\n<!-- managed-by: singularity-flow direct-skill-alias -->\r\n/);
  assert.ok(isManagedDirectSkill(rendered));
});

test('direct skills install as personal bare-command aliases and update only managed copies', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sflow-direct-skills-'));
  const targetRoot = path.join(fixture, 'skills');
  const result = installDirectSkills({ sourceRoot, targetRoot });
  const sourceEntries = (await readdir(sourceRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith('sflow-'));
  assert.equal(result.installed.length, sourceEntries.length);
  assert.ok(result.installed.includes('sf-submit'));
  for (const entry of sourceEntries) {
    const directName = entry.name.replace(/^sflow-/, 'sf-');
    const source = await readFile(path.join(sourceRoot, entry.name, 'SKILL.md'), 'utf8');
    const direct = await readFile(path.join(targetRoot, directName, 'SKILL.md'), 'utf8');
    assert.equal(direct, renderDirectSkill(source, entry.name), `${directName} must preserve the complete source contract`);
  }
  const directSubmit = await readFile(path.join(targetRoot, 'sf-submit', 'SKILL.md'), 'utf8');
  const sourceSubmit = await readFile(path.join(sourceRoot, 'sflow-submit', 'SKILL.md'), 'utf8');
  assert.match(directSubmit, /^name: sf-submit$/m);
  assert.match(directSubmit, /every generated current-phase document/);
  assert.equal(directSubmit, renderDirectSkill(sourceSubmit, 'sflow-submit'));

  await writeFile(path.join(targetRoot, 'sf-submit', 'SKILL.md'), directSubmit.replace('Validate and submit', 'OLD Validate and submit'));
  installDirectSkills({ sourceRoot, targetRoot });
  assert.doesNotMatch(await readFile(path.join(targetRoot, 'sf-submit', 'SKILL.md'), 'utf8'), /OLD Validate/);

  await mkdir(path.join(targetRoot, 'sf-retired'), { recursive: true });
  await writeFile(path.join(targetRoot, 'sf-retired', 'SKILL.md'), '---\nname: sf-retired\n---\n<!-- managed-by: singularity-flow direct-skill-alias -->\n');
  const refreshed = installDirectSkills({ sourceRoot, targetRoot });
  assert.deepEqual(refreshed.removed, ['sf-retired']);
});

test('direct skill installation refuses to overwrite an unrelated personal skill', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sflow-direct-collision-'));
  const targetRoot = path.join(fixture, 'skills');
  await mkdir(path.join(targetRoot, 'sf-submit'), { recursive: true });
  await writeFile(path.join(targetRoot, 'sf-submit', 'SKILL.md'), '---\nname: sf-submit\n---\nPersonal instructions.\n');
  assert.throws(
    () => installDirectSkills({ sourceRoot, targetRoot }),
    /would overwrite personal skill.*sf-submit/
  );
  assert.match(await readFile(path.join(targetRoot, 'sf-submit', 'SKILL.md'), 'utf8'), /Personal instructions/);
});

test('direct skill uninstall removes only Singularity-managed aliases', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sflow-direct-uninstall-'));
  const targetRoot = path.join(fixture, 'skills');
  installDirectSkills({ sourceRoot, targetRoot });
  await mkdir(path.join(targetRoot, 'sf-personal'), { recursive: true });
  await writeFile(path.join(targetRoot, 'sf-personal', 'SKILL.md'), '---\nname: sf-personal\n---\nPersonal.\n');
  const result = uninstallDirectSkills({ targetRoot });
  assert.ok(result.removed.includes('sf-submit'));
  assert.equal(await readFile(path.join(targetRoot, 'sf-personal', 'SKILL.md'), 'utf8'), '---\nname: sf-personal\n---\nPersonal.\n');
});

test('Copilot skill directory supports an explicit corporate location', () => {
  assert.equal(
    copilotSkillsDirectory({ env: { SINGULARITY_FLOW_COPILOT_SKILLS_DIR: '/company/copilot/skills' }, homeDirectory: '/users/test' }),
    '/company/copilot/skills'
  );
  assert.equal(copilotSkillsDirectory({ env: { COPILOT_HOME: '/company/copilot' }, homeDirectory: '/users/test' }), '/company/copilot/skills');
  assert.equal(copilotSkillsDirectory({ env: {}, homeDirectory: '/users/test' }), '/users/test/.copilot/skills');
});

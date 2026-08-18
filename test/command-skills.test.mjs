import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMMAND_REGISTRY } from '../src/command-registry.mjs';
import {
  COMMAND_SKILLS, primarySkillForCommand, renderCommandSkillTable, skillsForCommand
} from '../src/command-skills.mjs';
import { loadHelpDocument } from '../src/help.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every registered command maps to at least one packaged direct Copilot skill', async () => {
  const registered = COMMAND_REGISTRY.map((entry) => entry.name);
  assert.deepEqual(Object.keys(COMMAND_SKILLS).sort(), [...registered].sort());
  for (const command of registered) {
    const skills = skillsForCommand(command);
    assert.ok(skills.length > 0, `${command} has no Copilot route`);
    assert.equal(primarySkillForCommand(command), skills[0]);
    assert.equal(new Set(skills).size, skills.length, `${command} repeats a skill`);
    for (const skill of skills) {
      assert.match(skill, /^sf-[a-z0-9]+(?:-[a-z0-9]+)*$/);
      const file = path.join(root, 'plugin', 'skills', skill.replace(/^sf-/, 'sflow-'), 'SKILL.md');
      assert.equal(await stat(file).then(() => true).catch(() => false), true,
        `${command} maps to missing /${skill}`);
      const source = await readFile(file, 'utf8');
      assert.match(source, new RegExp(`^name: ${skill.replace(/^sf-/, 'sflow-')}$`, 'm'));
    }
  }
});

test('the Help Center crosswalk is generated from the checked catalog', async () => {
  const help = await loadHelpDocument('cli-to-copilot-skill-mapping');
  assert.match(help.content, /\| Terminal command \| Copilot skill \|/);
  assert.doesNotMatch(help.content, /command-skill-map/);
  for (const { name } of COMMAND_REGISTRY) {
    assert.ok(help.content.includes(`| \`singularity-flow ${name}\` |`), name);
    for (const skill of skillsForCommand(name)) assert.ok(help.content.includes(`\`/${skill}\``), skill);
  }
  assert.equal(renderCommandSkillTable().split('\n').length, COMMAND_REGISTRY.length + 2);
});

test('journey mappings keep low-level plumbing behind the guided skill', () => {
  assert.equal(primarySkillForCommand('prepare'), 'sf-phase');
  assert.ok(skillsForCommand('prepare').includes('sf-converge'));
  assert.equal(primarySkillForCommand('artifact'), 'sf-phase');
  assert.deepEqual(skillsForCommand('choices'), ['sf-start', 'sf-approve']);
  assert.equal(primarySkillForCommand('converge'), 'sf-converge');
  assert.equal(primarySkillForCommand('cockpit'), 'sf-home');
});

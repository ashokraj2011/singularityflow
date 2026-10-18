import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { bundledSkillDirectory, installDirectSkills } from '../src/direct-skills.mjs';
import { installPlugin } from '../src/plugin.mjs';

/**
 * Every shipped skill must be one Copilot registers after a normal install. Copilot lists a skill
 * only when its directory holds a regular SKILL.md whose frontmatter `name` equals the directory
 * name; anything else is silently absent from `/` and from `copilot skill list`.
 *
 * A Copilot session reported "/sf-session ... was unavailable in the registered skill list". It was
 * registered: the host had already injected it. User-invoked skills are hidden from the model's
 * `skill` tool by design, which answers "Skill not found", so the skill says it is already loaded.
 */
const pluginRoot = fileURLToPath(new URL('../plugin/', import.meta.url));
const skillRoot = bundledSkillDirectory();
const shipped = readdirSync(skillRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('sflow-')).map((entry) => entry.name).sort();

function frontmatter(file) {
  const text = readFileSync(file, 'utf8');
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  assert.ok(match, `${file} has YAML frontmatter`);
  return YAML.parse(match[1]);
}

/** What Copilot's inventory reports for a skill directory: present only when it is well formed. */
function inventoryEntries(root, source) {
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
    const file = path.join(root, entry.name, 'SKILL.md');
    let stat;
    try { stat = lstatSync(file); } catch { return []; }
    if (!stat.isFile()) return [];
    const declared = frontmatter(file);
    if (declared?.name !== entry.name || typeof declared.description !== 'string' || !declared.description.trim()) return [];
    return [{ name: entry.name, source, path: path.join(root, entry.name), enabled: true }];
  });
}

test('every shipped skill has one registry entry and a name Copilot accepts', () => {
  const registry = YAML.parse(readFileSync(path.join(skillRoot, 'registry.yml'), 'utf8'));
  assert.deepEqual(Object.keys(registry.skills).sort(), shipped, 'registry.yml and plugin/skills list the same skills');
  assert.equal(JSON.parse(readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8')).skills, 'skills/');
  for (const name of shipped) {
    const declared = frontmatter(path.join(skillRoot, name, 'SKILL.md'));
    assert.equal(declared.name, name, `${name}: frontmatter name matches its directory`);
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(`sf-${name.slice('sflow-'.length)}`.length <= 64, `${name}: its alias fits Copilot's 64-character limit`);
    assert.ok(declared.description.length > 0 && declared.description.length <= 1024, `${name}: description length`);
  }
});

test('a normal install registers every shipped skill under both its packaged and direct names', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-skill-registration-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const targetRoot = path.join(home, 'skills');
  const installedPlugin = path.join(home, 'installed-plugins', '_direct', 'plugin', 'skills');
  const calls = [];
  const execute = (command, args) => {
    calls.push([command, ...args].join(' '));
    assert.equal(command, 'copilot', 'only the Copilot CLI is asked');
    if (args.join(' ').startsWith('plugin install')) return { status: 0, stdout: '', stderr: '' };
    if (args.join(' ').startsWith('plugin uninstall')) return { status: 0, stdout: '', stderr: '' };
    if (args.join(' ') === 'plugin list') return { status: 0, stdout: '', stderr: '' };
    if (args.join(' ') === 'plugin list --json') {
      return { status: 0, stdout: JSON.stringify([{ name: 'singularity-flow', marketplace: '', version: '0.9.0', enabled: true }]), stderr: '' };
    }
    if (args.join(' ') === 'skill list --json') {
      return { status: 0, stdout: JSON.stringify([...inventoryEntries(targetRoot, 'personal-copilot'), ...inventoryEntries(installedPlugin, 'plugin')]), stderr: '' };
    }
    throw new Error(`unexpected Copilot call: ${command} ${args.join(' ')}`);
  };
  // Copilot copies the plugin directory as it is; the direct aliases are written by SFlow.
  await cp(skillRoot, installedPlugin, { recursive: true });
  const logged = [];
  installPlugin({
    execute, exists: () => true, developmentSource: null, marketplaceSource: '',
    installAliases: () => installDirectSkills({ targetRoot }), log: (line) => logged.push(line)
  });
  assert.ok(calls.includes('copilot skill list --json'), 'the install checked what Copilot registered');
  assert.match(logged.at(-1), new RegExp(`${shipped.length} enabled packaged skills, and ${shipped.length} enabled direct skills`));
  const registered = new Set(JSON.parse(execute('copilot', ['skill', 'list', '--json']).stdout).map((entry) => entry.name));
  for (const name of shipped) {
    assert.ok(registered.has(name), `${name} is registered from the plugin`);
    assert.ok(registered.has(`sf-${name.slice('sflow-'.length)}`), `sf-${name.slice('sflow-'.length)} is registered as a direct skill`);
  }
});

test('/sf-session is user-invoked and tells the model it is already loaded', () => {
  const declared = frontmatter(path.join(skillRoot, 'sflow-session', 'SKILL.md'));
  assert.equal(declared['disable-model-invocation'], true, 'Story selection stays the person’s decision');
  const body = readFileSync(path.join(skillRoot, 'sflow-session', 'SKILL.md'), 'utf8');
  assert.match(body, /Already loaded: never call the `skill` tool for it \("Skill not found" is expected\)/);
  assert.match(body, /Managed local open fast-forwards \(`remoteSync`; `unavailable` = opened as-is, maybe behind\)/);
  assert.match(body, /Wait for each command to exit/);
});

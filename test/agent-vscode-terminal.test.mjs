import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import {
  AGENT_ROLES, agentFilesWithoutVsCodeTerminal, renderAgentFile, splitAgentText, terminalMissingInVsCode, withVsCodeTerminal
} from '../src/agent-file.mjs';
import { renderDirectSkill } from '../src/direct-skills.mjs';
import { AGENTS_BEFORE_VSCODE_TERMINAL, isCurrentPackagedAssetHash, isKnownPackagedAssetHash, packagedAssetSha256 } from '../src/packaged-asset-history.mjs';

/**
 * VS Code gives an agent a terminal only for `execute` or `shell` (its tool set's own aliases,
 * 1.145 getToolSetAliases), or a terminal tool by name. It has no `bash`, so an agent listing only
 * that has read and edit tools and no terminal, and every SFlow skill it is asked to run stops at its
 * first command: "this session has no terminal/CLI tool". Copilot CLI reads both.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const toolsOf = (text, label) => splitAgentText(text, label).document.get('tools')?.toJSON?.();

test('which tools lists have a terminal only Copilot CLI can use', () => {
  for (const tools of [['bash'], ['read', 'search', 'edit', 'bash', 'ask_user'], ['bash', 'read_bash', 'view']]) {
    assert.equal(terminalMissingInVsCode(tools), true, tools.join());
  }
  for (const tools of [
    ['execute', 'bash'], ['shell', 'bash'], ['bash', 'execute/runInTerminal'], ['bash', 'runInTerminal'], ['bash', 'runCommands'],
    ['read', 'search', 'edit'], [], null, undefined, 'bash'
  ]) assert.equal(terminalMissingInVsCode(tools), false, String(tools));
});

test('every agent SFlow ships or starts from has its terminal on both hosts', async () => {
  for (const folder of ['templates/agents', 'plugin/agents']) {
    const names = (await readdir(path.join(ROOT, folder))).filter((name) => name.endsWith('.agent.md'));
    assert.ok(names.length >= 3, folder);
    for (const name of names) {
      const tools = toolsOf(await readFile(path.join(ROOT, folder, name), 'utf8'), name);
      assert.ok(tools.includes('execute'), `${folder}/${name} has no terminal in VS Code`);
      assert.ok(tools.includes('bash'), `${folder}/${name} keeps the name Copilot CLI has always read`);
    }
  }
  for (const role of AGENT_ROLES) assert.equal(terminalMissingInVsCode(role.tools), false, role.id);
});

test('an agent file is written with its terminal on both hosts, by whichever route', () => {
  assert.deepEqual(withVsCodeTerminal(['read', 'bash', 'ask_user']), ['read', 'execute', 'bash', 'ask_user']);
  const unchanged = ['read', 'search'];
  assert.equal(withVsCodeTerminal(unchanged), unchanged, 'an agent without a terminal is not given one');
  assert.equal(withVsCodeTerminal(null), null);
  const entry = { label: 'Agent', phases: ['implement'], defaultFor: [], instructions: 'Do the work.' };
  const written = renderAgentFile({ ...entry, id: 'made-here', description: 'Made here.', tools: ['read', 'bash'] });
  assert.deepEqual(toolsOf(written, 'made-here'), ['read', 'execute', 'bash']);
  const edited = renderAgentFile({ ...entry, id: 'older', description: 'Older.', tools: ['read', 'bash'],
    text: '---\nname: older\ndescription: Older.\ntools: [read, bash]\n---\nBody.\n' });
  assert.deepEqual(toolsOf(edited, 'older'), ['read', 'execute', 'bash'], 'an edit brings an older agent up to date');
  const reader = renderAgentFile({ ...entry, id: 'reader', description: 'Reads.', tools: ['read', 'search'] });
  assert.deepEqual(toolsOf(reader, 'reader'), ['read', 'search']);
});

test('an upgrade recognises each packaged agent it replaces, and the new bytes are current', async () => {
  const folder = path.join(ROOT, 'templates/agents');
  for (const name of (await readdir(folder)).filter((entry) => entry.endsWith('.agent.md'))) {
    const relative = `.github/agents/${name}`;
    const bytes = await readFile(path.join(folder, name));
    assert.ok(isCurrentPackagedAssetHash(relative, packagedAssetSha256(bytes)), `${relative} current`);
    const earlier = Buffer.from(bytes.toString('utf8').replace('tools: [read, search, edit, execute, bash, ', 'tools: [read, search, edit, bash, '));
    assert.notDeepEqual(earlier, bytes);
    // Once an agent's own words change after that, the file an upgrade finds is the one recorded then:
    // these bytes without `execute` never shipped.
    const digest = isKnownPackagedAssetHash(relative, packagedAssetSha256(earlier))
      ? packagedAssetSha256(earlier) : AGENTS_BEFORE_VSCODE_TERMINAL[relative];
    assert.ok(isKnownPackagedAssetHash(relative, digest), `${relative}: the file an upgrade finds is a known revision`);
    assert.ok(!isCurrentPackagedAssetHash(relative, digest), `${relative}: and not the current one`);
  }
});

test('every skill a person types moves a new VS Code chat to Agent, and says nothing more for it', async () => {
  // /clear opens a new chat, and VS Code chooses its agent from a saved draft or
  // chat.newSession.defaultMode. Checked in VS Code 1.145: a typed skill with this header took a chat on
  // a read-only agent to Agent, and a skill without it stayed there.
  const skills = path.join(ROOT, 'plugin/skills');
  const names = (await readdir(skills, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(names.length > 100);
  for (const name of names) {
    const text = await readFile(path.join(skills, name, 'SKILL.md'), 'utf8');
    const header = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1];
    assert.equal(YAML.parse(header).agent, 'agent', name);
    assert.match(renderDirectSkill(text, name), /^agent: agent$/mu, `the ${name} alias a person types carries it`);
    assert.doesNotMatch(text.slice(header.length), /no terminal|terminal access|session with/iu, `${name} gained no reason to stop`);
  }
});

test('doctor\'s reader names a repository\'s agents with a terminal only Copilot CLI can use, and no others', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await agentFilesWithoutVsCodeTerminal(root), [], 'a repository with no agents');
  const folder = path.join(root, '.github/agents');
  await mkdir(folder, { recursive: true });
  const agent = (tools) => `---\nname: x\ndescription: x\n${tools ? `tools: ${tools}\n` : ''}---\nBody.\n`;
  await writeFile(path.join(folder, 'old.agent.md'), agent('[read, search, edit, bash, ask_user]'));
  await writeFile(path.join(folder, 'block.agent.md'), `---\nname: x\n${YAML.stringify({ tools: ['bash', 'view'] })}---\nBody.\n`);
  await writeFile(path.join(folder, 'both.agent.md'), agent('[read, execute, bash]'));
  await writeFile(path.join(folder, 'shell.agent.md'), agent('[shell, bash]'));
  await writeFile(path.join(folder, 'reader.agent.md'), agent('[read, search]'));
  await writeFile(path.join(folder, 'everything.agent.md'), agent(null));
  await writeFile(path.join(folder, 'broken.agent.md'), 'no frontmatter');
  await writeFile(path.join(folder, 'notes.md'), agent('[bash]'));
  assert.deepEqual(await agentFilesWithoutVsCodeTerminal(root), ['.github/agents/block.agent.md', '.github/agents/old.agent.md']);
});

import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMMAND_REGISTRY } from '../src/command-registry.mjs';
import { loadTopics } from '../src/docs-topics.mjs';
import { allCommands, documentedCommands, renderCommandHelp } from '../src/help-pages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredSections = [
  'Purpose and prerequisites', 'Use it from each surface', 'Guided workflow',
  'State and safety', 'Troubleshooting', 'Related topics'
];

async function markdownFiles(directory, depth = 0) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && depth < 2) found.push(...await markdownFiles(target, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(target);
  }
  return found;
}

test('every registered command has a served topic and complete command page', async () => {
  const topics = await loadTopics();
  const mapped = new Set(topics.flatMap((topic) => topic.commands));
  assert.deepEqual(COMMAND_REGISTRY.map((entry) => entry.name).filter((name) => !mapped.has(name)), []);
  assert.deepEqual(documentedCommands().sort(), allCommands().sort());
  for (const command of allCommands()) {
    const page = renderCommandHelp(command);
    for (const section of ['NAME', 'SYNOPSIS', 'DESCRIPTION', 'OPTIONS', 'EXAMPLES', 'SEE ALSO']) {
      assert.match(page, new RegExp(`(?:^|\\n)${section}\\n`), `${command} lacks ${section}`);
    }
  }
});

test('every served topic is a surface-aware tutorial', async () => {
  const topics = await loadTopics();
  assert.equal(topics.length, 51);
  for (const topic of topics) {
    for (const section of requiredSections) {
      assert.match(topic.body, new RegExp(`^## ${section}$`, 'm'), `${topic.file} lacks ${section}`);
    }
    assert.match(topic.body, /\*\*Shell:\*\*/);
    assert.match(topic.body, /\*\*Copilot:\*\*/);
    assert.match(topic.body, /\*\*VS Code:\*\*/);
  }
});

test('every Copilot skill named by a topic is packaged', async () => {
  const topics = await loadTopics();
  for (const topic of topics) {
    for (const [, skill] of topic.body.matchAll(/`\/(sf-[a-z0-9-]+)(?:\s[^`]*)?`/g)) {
      const source = path.join(root, 'plugin', 'skills', skill.replace(/^sf-/, 'sflow-'), 'SKILL.md');
      assert.equal(await stat(source).then(() => true).catch(() => false), true,
        `${topic.file} names missing /${skill}`);
    }
  }
});

test('current documentation has no obsolete visible home or command syntax', async () => {
  const files = (await markdownFiles(root)).filter((file) => !file.includes(`${path.sep}plugin${path.sep}skills${path.sep}`));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /\/singularity-flow:sflow-/, path.relative(root, file));
    assert.doesNotMatch(source, /`sflow cockpit`/, path.relative(root, file));
    for (const match of source.matchAll(/Talk to SFlow/gi)) {
      const context = source.slice(Math.max(0, match.index - 120), match.index + 180);
      assert.match(context, /hidden|compatib/i, `${path.relative(root, file)} presents Talk to SFlow as current navigation`);
    }
  }
});

test('relative Markdown links in current manuals resolve', async () => {
  const files = await markdownFiles(root);
  const missing = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [, raw] of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const link = raw.trim().replace(/^<|>$/g, '');
      if (!link || link.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
      const targetText = link.split('#')[0];
      if (!targetText) continue;
      const target = path.resolve(path.dirname(file), decodeURIComponent(targetText));
      if (!await stat(target).then(() => true).catch(() => false)) {
        missing.push(`${path.relative(root, file)} -> ${link}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

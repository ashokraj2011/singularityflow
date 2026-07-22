import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPlugin, uninstallPlugin } from '../src/plugin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(root, 'plugin');

test('plugin manifest is a skills-only Copilot plugin', async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'singularity-flow');
  assert.equal(manifest.skills, 'skills/');
  assert.equal(manifest.mcpServers, undefined);
  assert.equal(manifest.extensions, undefined);
  assert.equal(manifest.hooks, undefined);
});

test('official marketplace publishes the versioned plugin from the repository plugin directory', async () => {
  const marketplace = JSON.parse(await readFile(path.join(root, '.github/plugin/marketplace.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  const entry = marketplace.plugins.find((item) => item.name === 'singularity-flow');
  assert.equal(marketplace.name, 'singularity-flow');
  assert.equal(marketplace.metadata.version, manifest.version);
  assert.equal(entry.version, manifest.version);
  assert.equal(entry.source, './plugin');
});

test('every skill has valid matching frontmatter', async () => {
  const skillRoot = path.join(pluginRoot, 'skills');
  const entries = (await readdir(skillRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.ok(entries.length >= 10);
  for (const entry of entries) {
    const content = await readFile(path.join(skillRoot, entry.name, 'SKILL.md'), 'utf8');
    const name = content.match(/^---\n[\s\S]*?^name:\s*([^\n]+)$/m)?.[1]?.trim();
    const description = content.match(/^---\n[\s\S]*?^description:\s*([^\n]+)$/m)?.[1]?.trim();
    assert.equal(name, entry.name, `${entry.name} name mismatch`);
    assert.match(name, /^sflow-/, `${entry.name} must use the collision-safe sflow- prefix`);
    assert.ok(description, `${entry.name} missing description`);
    assert.match(name, /^[a-z0-9-]+$/);
  }
});

test('approval skill is explicitly user-invoked', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-approve', 'SKILL.md'), 'utf8');
  assert.match(content, /disable-model-invocation:\s*true/);
  assert.match(content, /singularity-flow approve <WORK-ID> --fetch/);
});

test('help skill is read-only and delegates to the workflow guide', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-help', 'SKILL.md'), 'utf8');
  assert.match(content, /singularity-flow help <topic>/);
  assert.match(content, /singularity-flow guide <WORK-ID>/);
  assert.match(content, /HELP\.md.*canonical product manual/);
  assert.match(content, /Do not generate, submit, approve, reject, upload, commit, or push anything/);
});

test('report skill is read-only and preserves unavailable usage disclosure', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-report', 'SKILL.md'), 'utf8');
  assert.match(content, /singularity-flow report <arguments>/);
  assert.match(content, /partial.*unavailable/);
  assert.match(content, /Do not change workflow state/);
  assert.match(content, /disable-model-invocation:\s*true/);
});

test('nextsteps skill delegates to the read-only deterministic action planner', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-nextsteps', 'SKILL.md'), 'utf8');
  assert.match(content, /singularity-flow nextsteps <arguments>/);
  assert.match(content, /NOW.*THEN.*ALTERNATIVE/s);
  assert.match(content, /Keep this operation read-only/);
});

test('plugin install replaces direct and marketplace copies before installing one marketplace copy', () => {
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    const isMarketplaceAdd = args.join(' ') === 'plugin marketplace add ashokraj2011/singularityflow';
    return { status: isMarketplaceAdd ? 1 : 0, stdout: '', stderr: '' };
  };

  installPlugin({ execute, exists: () => true, developmentSource: undefined });

  assert.deepEqual(calls.map((call) => call.args), [
    ['plugin', 'uninstall', 'singularity-flow'],
    ['plugin', 'uninstall', 'singularity-flow@singularity-flow'],
    ['plugin', 'marketplace', 'add', 'ashokraj2011/singularityflow'],
    ['plugin', 'marketplace', 'update', 'singularity-flow'],
    ['plugin', 'install', 'singularity-flow@singularity-flow']
  ]);
  assert.equal(calls.at(-1).options.stdio, 'inherit');
});

test('plugin uninstall removes both known Copilot identities', () => {
  const calls = [];
  uninstallPlugin({
    exists: () => true,
    execute: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '', stderr: '' };
    }
  });
  assert.deepEqual(calls.map((call) => call.args), [
    ['plugin', 'uninstall', 'singularity-flow'],
    ['plugin', 'uninstall', 'singularity-flow@singularity-flow']
  ]);
});

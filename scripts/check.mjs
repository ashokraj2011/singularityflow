import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { validateDefinition } from '../src/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checked = [];

function fail(message) {
  failures.push(message);
}

function repositoryFiles() {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`Unable to enumerate repository files: ${result.stderr.trim() || `git exited ${result.status}`}`);
    return [];
  }
  return result.stdout.split('\0').filter(Boolean).map((file) => path.join(root, file)).filter(existsSync);
}

function parseFrontmatter(text, file) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    fail(`${file}: missing YAML frontmatter`);
    return {};
  }
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([a-z][a-z0-9-]*):\s*(.*)$/);
    if (!pair) continue;
    values[pair[1]] = pair[2].trim();
  }
  return values;
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const pluginJson = JSON.parse(await readFile(path.join(root, 'plugin', 'plugin.json'), 'utf8'));
const marketplaceJson = JSON.parse(await readFile(path.join(root, '.github', 'plugin', 'marketplace.json'), 'utf8'));
checked.push('package.json', 'plugin/plugin.json', '.github/plugin/marketplace.json');

if (packageJson.version !== pluginJson.version) fail(`Version mismatch: package ${packageJson.version}, plugin ${pluginJson.version}`);
if (pluginJson.name !== 'singularity-flow') fail('plugin.json name must be singularity-flow');
for (const forbidden of ['extensions', 'mcpServers', 'hooks', 'agents']) {
  if (Object.hasOwn(pluginJson, forbidden)) fail(`plugin.json must remain skills-only; remove ${forbidden}`);
}
if (pluginJson.skills !== 'skills/') fail('plugin.json skills path must be skills/');
const marketplacePlugin = marketplaceJson.plugins?.find((item) => item.name === pluginJson.name);
if (marketplaceJson.name !== 'singularity-flow') fail('marketplace.json name must be singularity-flow');
if (!marketplacePlugin || marketplacePlugin.source !== './plugin') fail('marketplace must publish singularity-flow from ./plugin');
if (marketplaceJson.metadata?.version !== pluginJson.version || marketplacePlugin?.version !== pluginJson.version) fail('marketplace and plugin versions must match');

const allFiles = repositoryFiles();
for (const file of allFiles.filter((candidate) => candidate.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) fail(`${path.relative(root, file)}: JavaScript syntax check failed\n${result.stderr}`);
  checked.push(path.relative(root, file));
}

const skillRoot = path.join(root, 'plugin', 'skills');
const skillDirs = (await readdir(skillRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
for (const entry of skillDirs) {
  const file = path.join(skillRoot, entry.name, 'SKILL.md');
  const text = await readFile(file, 'utf8');
  const frontmatter = parseFrontmatter(text, path.relative(root, file));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) fail(`${entry.name}: directory name is not kebab-case`);
  if (frontmatter.name !== entry.name) fail(`${entry.name}: frontmatter name must match directory`);
  if (!frontmatter.description) fail(`${entry.name}: description is required`);
  if (!entry.name.startsWith('sflow-')) fail(`${entry.name}: every public skill must use the collision-safe sflow- prefix`);
  if (entry.name === 'sflow-approve' && frontmatter['disable-model-invocation'] !== 'true') {
    fail('sflow-approve: disable-model-invocation must be true');
  }
  checked.push(path.relative(root, file));
}

for (const schemaFile of ['schemas/config.schema.json', 'schemas/workflow.schema.json', 'schemas/workflow-definition.schema.json']) {
  JSON.parse(await readFile(path.join(root, schemaFile), 'utf8'));
  checked.push(schemaFile);
}

const qualityExample = validateDefinition(YAML.parse(await readFile(path.join(root, 'examples', 'workflow-with-quality-gates.yml'), 'utf8')));
if (!qualityExample.workTypes?.feature || qualityExample.phases?.implementation?.qualityCommands?.length < 2) fail('quality-gate YAML example is incomplete');
checked.push('examples/workflow-with-quality-gates.yml');

const workflowTemplate = validateDefinition(YAML.parse(await readFile(path.join(root, 'templates', 'workflow.yml'), 'utf8')));
if (!workflowTemplate.workTypes?.feature || !workflowTemplate.workTypes?.bugfix) fail('workflow template must include feature and bugfix profiles');
if (!workflowTemplate.personas?.developer || !workflowTemplate.personas?.architect) fail('workflow template must include configurable personas');
checked.push('templates/workflow.yml');

const help = spawnSync(process.execPath, [path.join(root, 'bin', 'singularity-flow.mjs'), '--help'], { encoding: 'utf8' });
if (help.status !== 0 || !help.stdout.includes('singularity-flow approve')) fail('CLI help smoke test failed');
checked.push('CLI help smoke test');

const pythonFiles = allFiles.filter((file) => file.endsWith('.py'));
if (pythonFiles.length) fail(`Python files are not allowed: ${pythonFiles.map((file) => path.relative(root, file)).join(', ')}`);
const forbiddenFiles = allFiles.filter((file) => ['.mcp.json', 'mcp.json', 'hooks.json'].includes(path.basename(file)));
if (forbiddenFiles.length) fail(`Unexpected MCP/hook files: ${forbiddenFiles.map((file) => path.relative(root, file)).join(', ')}`);

if (failures.length) {
  console.error(`Singularity Flow check failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):`);
  failures.forEach((message) => console.error(`- ${message}`));
  process.exitCode = 1;
} else {
  console.log(`Singularity Flow check passed: ${checked.length} checks across ${skillDirs.length} skills; skills-only plugin, no Python, no MCP.`);
}

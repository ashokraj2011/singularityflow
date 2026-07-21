import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checked = [];

function fail(message) {
  failures.push(message);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(candidate));
    else files.push(candidate);
  }
  return files;
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
checked.push('package.json', 'plugin/plugin.json');

if (packageJson.version !== pluginJson.version) fail(`Version mismatch: package ${packageJson.version}, plugin ${pluginJson.version}`);
if (pluginJson.name !== 'singularity-flow') fail('plugin.json name must be singularity-flow');
for (const forbidden of ['extensions', 'mcpServers', 'hooks', 'agents']) {
  if (Object.hasOwn(pluginJson, forbidden)) fail(`plugin.json must remain skills-only; remove ${forbidden}`);
}
if (pluginJson.skills !== 'skills/') fail('plugin.json skills path must be skills/');

const allFiles = await walk(root);
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
  if (entry.name === 'approve' && frontmatter['disable-model-invocation'] !== 'true') {
    fail('approve: disable-model-invocation must be true');
  }
  checked.push(path.relative(root, file));
}

for (const schemaFile of ['schemas/config.schema.json', 'schemas/workflow.schema.json', 'examples/config-with-quality-gates.json']) {
  JSON.parse(await readFile(path.join(root, schemaFile), 'utf8'));
  checked.push(schemaFile);
}

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

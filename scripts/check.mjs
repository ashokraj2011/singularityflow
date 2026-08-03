import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { validateDefinition } from '../src/config.mjs';
import { discoverAgents, validateAgentCatalog } from '../src/agents.mjs';
import { validatePortfolio, validatePortfolioWorldModelViews } from '../src/initiative-config.mjs';

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
const vscodeJson = JSON.parse(await readFile(path.join(root, 'apps', 'vscode', 'package.json'), 'utf8'));
const pluginJson = JSON.parse(await readFile(path.join(root, 'plugin', 'plugin.json'), 'utf8'));
const marketplaceJson = JSON.parse(await readFile(path.join(root, '.github', 'plugin', 'marketplace.json'), 'utf8'));
const lockJson = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
checked.push('package.json', 'apps/vscode/package.json', 'plugin/plugin.json', '.github/plugin/marketplace.json', 'package-lock.json');

if (packageJson.version !== pluginJson.version) fail(`Version mismatch: package ${packageJson.version}, plugin ${pluginJson.version}`);
for (const [name, version] of Object.entries({
  vscode: vscodeJson.version,
  lockPackage: lockJson.packages?.['']?.version,
  lockVscode: lockJson.packages?.['apps/vscode']?.version
})) {
  if (version !== packageJson.version) fail(`Version mismatch: package ${packageJson.version}, ${name} ${version ?? 'missing'}`);
}
if (pluginJson.name !== 'singularity-flow') fail('plugin.json name must be singularity-flow');
for (const forbidden of ['mcpServers']) {
  if (Object.hasOwn(pluginJson, forbidden)) fail(`plugin.json contains unsupported component ${forbidden}`);
}
if (pluginJson.hooks !== 'hooks.json') fail('plugin.json hooks path must be hooks.json');
const hooksJson = JSON.parse(await readFile(path.join(root, 'plugin', 'hooks.json'), 'utf8'));
if (hooksJson.version !== 1 || !Array.isArray(hooksJson.hooks?.sessionStart)) fail('plugin/hooks.json must define version 1 sessionStart hooks');
if (hooksJson.hooks?.preToolUse != null) fail('plugin/hooks.json must not define a blocking preToolUse guard');
const agentStartHooks = hooksJson.hooks?.subagentStart;
if (!Array.isArray(agentStartHooks) || agentStartHooks.length !== 1) fail('plugin/hooks.json must define one nonblocking subagentStart mapping hook');
if (agentStartHooks?.[0]?.type !== 'command'
  || agentStartHooks[0].bash !== 'singularity-flow hook agent-start'
  || agentStartHooks[0].powershell !== 'singularity-flow hook agent-start') {
  fail('plugin/hooks.json subagentStart must map Copilot agents through singularity-flow hook agent-start');
}
const unexpectedCommandHook = Object.entries(hooksJson.hooks ?? {}).some(([event, entries]) =>
  event !== 'subagentStart' && Array.isArray(entries) && entries.some((entry) => entry.type === 'command'));
if (unexpectedCommandHook) fail('plugin/hooks.json command hooks are allowed only for the nonblocking subagentStart agent mapping');
checked.push('plugin/hooks.json');
if (pluginJson.skills !== 'skills/') fail('plugin.json skills path must be skills/');
if (pluginJson.agents !== 'agents/') fail('plugin.json agents path must be agents/');
if (pluginJson.extensions !== 'extensions/') fail('plugin.json extensions path must be extensions/');
const marketplacePlugin = marketplaceJson.plugins?.find((item) => item.name === pluginJson.name);
if (marketplaceJson.name !== 'singularity-flow') fail('marketplace.json name must be singularity-flow');
if (!marketplacePlugin || marketplacePlugin.source !== './plugin') fail('marketplace must publish singularity-flow from ./plugin');
if (marketplaceJson.metadata?.version !== pluginJson.version || marketplacePlugin?.version !== pluginJson.version) fail('marketplace and plugin versions must match');
if (!packageJson.files?.includes('DISTRIBUTION.md') || !existsSync(path.join(root, 'DISTRIBUTION.md'))) fail('distribution guide must ship in the npm package');
for (const initiativeDocument of ['INITIATIVE-ORCHESTRATION.md', 'RELEASE-INITIATIVE-ORCHESTRATION.md']) {
  if (!packageJson.files?.includes(initiativeDocument) || !existsSync(path.join(root, initiativeDocument))) fail(`${initiativeDocument} must ship in the npm package`);
}
if (!packageJson.files?.includes('RELEASE-EPIC-STORY-LINEAGE.md') || !existsSync(path.join(root, 'RELEASE-EPIC-STORY-LINEAGE.md'))) {
  fail('Epic-to-Story lineage release notes must ship in the npm package');
}
checked.push('DISTRIBUTION.md', 'INITIATIVE-ORCHESTRATION.md', 'RELEASE-INITIATIVE-ORCHESTRATION.md');

const allFiles = repositoryFiles();
const codeowners = spawnSync(process.execPath, ['scripts/generate-codeowners.mjs'], { cwd: root, encoding: 'utf8' });
if (codeowners.status !== 0) fail(codeowners.stderr.trim() || 'Generated CODEOWNERS check failed');
checked.push('.github/CODEOWNERS', 'scripts/generate-codeowners.mjs');
const legacyModelReferences = [['clau', 'de'].join(''), ['anthro', 'pic'].join(''), ['calu', 'de'].join('')].join('|');
const legacyReferenceCheck = spawnSync('git', ['grep', '-n', '-i', '-E', legacyModelReferences, '--', '.'], {
  cwd: root,
  encoding: 'utf8'
});
if (legacyReferenceCheck.status === 0) fail(`Legacy model/vendor references remain:\n${legacyReferenceCheck.stdout.trim()}`);
else if (legacyReferenceCheck.status !== 1) fail(`Unable to scan legacy model/vendor references: ${legacyReferenceCheck.stderr.trim() || `git exited ${legacyReferenceCheck.status}`}`);
const personalSourceReference = ['ashok', 'raj2011'].join('');
const personalSourceCheck = spawnSync('git', ['grep', '-n', '-i', '-F', personalSourceReference, '--', '.'], {
  cwd: root,
  encoding: 'utf8'
});
if (personalSourceCheck.status === 0) fail(`Personal source repository references remain:\n${personalSourceCheck.stdout.trim()}`);
else if (personalSourceCheck.status !== 1) fail(`Unable to scan personal source repository references: ${personalSourceCheck.stderr.trim() || `git exited ${personalSourceCheck.status}`}`);
const hostedAutomationRoot = ['.github', 'workflows'].join('/');
if (allFiles.some((file) => path.relative(root, file).startsWith(`${hostedAutomationRoot}/`))) {
  fail(`${hostedAutomationRoot}/ must remain absent; use the local release and verification scripts.`);
}
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

const agentRoot = path.join(root, 'plugin', 'agents');
const agentFiles = (await readdir(agentRoot, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.agent.md'));
if (!agentFiles.length) fail('plugin must contain at least one bundled agent');
for (const entry of agentFiles) {
  const file = path.join(agentRoot, entry.name); const text = await readFile(file, 'utf8'); const frontmatter = parseFrontmatter(text, path.relative(root, file));
  if (!frontmatter.name || !frontmatter.description || !frontmatter.tools) fail(`${entry.name}: agent frontmatter requires name, description, and tools`);
  checked.push(path.relative(root, file));
}

const extensionRoot = path.join(root, 'plugin', 'extensions');
const extensionDirs = (await readdir(extensionRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
if (!extensionDirs.length) fail('plugin must contain at least one bundled extension');
for (const entry of extensionDirs) {
  const file = path.join(extensionRoot, entry.name, 'extension.mjs');
  if (!existsSync(file)) fail(`${entry.name}: extension.mjs is required`);
  else checked.push(path.relative(root, file));
}

for (const schemaFile of ['schemas/config.schema.json', 'schemas/workflow.schema.json', 'schemas/workflow-definition.schema.json', 'schemas/agents-lock.schema.json', 'schemas/agent-mappings.schema.json', 'schemas/portfolio.schema.json', 'schemas/capabilities.schema.json']) {
  JSON.parse(await readFile(path.join(root, schemaFile), 'utf8'));
  checked.push(schemaFile);
}

const qualityExample = validateDefinition(YAML.parse(await readFile(path.join(root, 'examples', 'workflow-with-quality-gates.yml'), 'utf8')));
if (!qualityExample.workTypes?.feature || qualityExample.phases?.implementation?.qualityCommands?.length < 2) fail('quality-gate YAML example is incomplete');
checked.push('examples/workflow-with-quality-gates.yml');

const workflowTemplate = validateDefinition(YAML.parse(await readFile(path.join(root, 'templates', 'workflow.yml'), 'utf8')));
if (!workflowTemplate.workTypes?.feature || !workflowTemplate.workTypes?.bugfix) fail('workflow template must include feature and bugfix profiles');
if (workflowTemplate.workItemRoot !== 'singularity/work-items') fail('workflow template must use the visible singularity/work-items root');
if (workflowTemplate.templatesRoot !== 'singularity/templates') fail('workflow template must keep editable artifact templates in the visible singularity folder');
const governedAgents = await discoverAgents(root);
validateAgentCatalog(governedAgents, workflowTemplate);
for (const id of ['product-owner', 'architect', 'developer', 'qa']) {
  if (!governedAgents.some((agent) => agent.id === id)) fail(`governed Agent Markdown catalog must include '${id}'`);
}
checked.push('templates/agents');
if (workflowTemplate.ledger?.enabled !== false || workflowTemplate.ledger?.branch !== 'state') fail('workflow template must ship the opt-in orphan capability-ledger configuration.');
if (workflowTemplate.ledger?.publication !== 'warn') fail('workflow template must ship warning-only state publication by default.');
checked.push('templates/workflow.yml');

const portfolioTemplate = validatePortfolio(YAML.parse(await readFile(path.join(root, 'templates', 'portfolio.yml'), 'utf8')));
validatePortfolioWorldModelViews(portfolioTemplate, workflowTemplate);
if (!portfolioTemplate.initiativeProfiles?.['initiative-lite'] || !portfolioTemplate.initiativeProfiles?.['enterprise-delivery']) fail('portfolio template must include initiative-lite and enterprise-delivery profiles');
if (!portfolioTemplate.initiativeProfiles?.['epic-planning']) fail('portfolio template must include the epic-planning profile');
if (portfolioTemplate.initiativeProfiles['initiative-lite'].phases.length !== 4) fail('initiative-lite must contain four phases');
if (portfolioTemplate.initiativeProfiles['enterprise-delivery'].phases.length !== 7) fail('enterprise-delivery must contain seven phases');
if (portfolioTemplate.initiativeRoot !== 'singularity/initiatives') fail('portfolio template must use the visible singularity/initiatives root');
const portfolioSource = await readFile(path.join(root, 'templates', 'portfolio.yml'), 'utf8');
if (/brokerage/i.test(portfolioSource)) fail('portfolio template contains organization-specific terminology');
checked.push('templates/portfolio.yml');

const help = spawnSync(process.execPath, [path.join(root, 'bin', 'singularity-flow.mjs'), '--help'], { encoding: 'utf8' });
if (help.status !== 0 || !help.stdout.includes('singularity-flow approve')) fail('CLI help smoke test failed');
checked.push('CLI help smoke test');

const pythonFiles = allFiles.filter((file) => file.endsWith('.py'));
if (pythonFiles.length) fail(`Python files are not allowed: ${pythonFiles.map((file) => path.relative(root, file)).join(', ')}`);
const forbiddenFiles = allFiles.filter((file) => ['.mcp.json', 'mcp.json'].includes(path.basename(file)));
if (forbiddenFiles.length) fail(`Unexpected MCP/hook files: ${forbiddenFiles.map((file) => path.relative(root, file)).join(', ')}`);

if (failures.length) {
  console.error(`Singularity Flow check failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):`);
  failures.forEach((message) => console.error(`- ${message}`));
  process.exitCode = 1;
} else {
  console.log(`Singularity Flow check passed: ${checked.length} checks across ${skillDirs.length} skills, ${agentFiles.length} agent(s), and ${extensionDirs.length} extension(s); no Python, no MCP.`);
}

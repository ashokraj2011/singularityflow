import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { validateDefinition } from '../src/config.mjs';
import { discoverAgents, validateAgentCatalog } from '../src/agents.mjs';
import { allCommands, documentedCommands, overviewCommands, synopsisFor } from '../src/help-pages.mjs';
import { canonicalCommand } from '../src/command-registry.mjs';
import { BOOLEAN_OPTIONS } from '../src/util.mjs';
import { validatePortfolio, validatePortfolioWorldModelViews } from '../src/initiative-config.mjs';
import { auditSkillPolicy } from './skill-policy.mjs';
import { validateNarrationMigrationStatus } from '../src/narration/migration-status.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checked = [];

try {
  validateNarrationMigrationStatus();
  checked.push('src/narration/migration-status.mjs');
} catch (error) {
  fail(error.message);
}

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
if (hooksJson.version !== 1) fail('plugin/hooks.json version must be 1');
if (hooksJson.hooks?.sessionStart != null) fail('plugin/hooks.json must not inject a model prompt at every session start');
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
for (const [script, label] of [
  ['scripts/audit-model-boundary.mjs', 'Model-boundary audit'],
  ['scripts/generate-operation-catalog.mjs', 'Operation model-policy catalog']
]) {
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) fail(result.stderr.trim() || `${label} failed`);
  checked.push(script);
}
const legacyModelReferences = [['clau', 'de'].join(''), ['anthro', 'pic'].join(''), ['calu', 'de'].join('')].join('|');
const legacyReferenceCheck = spawnSync('git', ['grep', '-n', '-i', '-E', legacyModelReferences, '--', '.'], {
  cwd: root,
  encoding: 'utf8'
});
if (legacyReferenceCheck.status === 0) fail(`Legacy model/vendor references remain:\n${legacyReferenceCheck.stdout.trim()}`);
else if (legacyReferenceCheck.status !== 1) fail(`Unable to scan legacy model/vendor references: ${legacyReferenceCheck.stderr.trim() || `git exited ${legacyReferenceCheck.status}`}`);
const personalSourceReferences = [
  ['ashok', 'raj2011'].join(''),
  ['ashok', '2011'].join(''),
  ['ashok', 'raj'].join(''),
  ['ashok', ' ', 'raj'].join(''),
  ['a672', '090'].join('')
];
const personalSourcePattern = personalSourceReferences
  .map((reference) => reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const personalSourceCheck = spawnSync('git', ['grep', '-n', '-i', '-E', personalSourcePattern, '--', '.'], {
  cwd: root,
  encoding: 'utf8'
});
if (personalSourceCheck.status === 0) fail(`Personal source repository references remain:\n${personalSourceCheck.stdout.trim()}`);
else if (personalSourceCheck.status !== 1) fail(`Unable to scan personal source repository references: ${personalSourceCheck.stderr.trim() || `git exited ${personalSourceCheck.status}`}`);
const publicSourceReferences = [
  ['github', 'com'].join('\\.'),
  ['singularity', 'flow', 'contributors'].join('[[:space:]]+')
];
const publicSourceCheck = spawnSync('git', ['grep', '-n', '-i', '-E', publicSourceReferences.join('|'), '--', '.'], {
  cwd: root,
  encoding: 'utf8'
});
if (publicSourceCheck.status === 0) fail(`Public sample repository or collective-authorship references remain:\n${publicSourceCheck.stdout.trim()}`);
else if (publicSourceCheck.status !== 1) fail(`Unable to scan public repository references: ${publicSourceCheck.stderr.trim() || `git exited ${publicSourceCheck.status}`}`);
if (existsSync(path.join(root, 'examples', 'singularity-flow-approve.yml'))) {
  fail('Hosted approval workflow example must remain absent; use the local Git publication path.');
}
// Every command the CLI dispatches must publish a synopsis, and every authored help page must name
// a command that exists. Both directions matter: `cockpit`, `logs` and `hook` all dispatched while
// absent from the overview, and `HELP.md` advertised six subcommand families that did not.
{
  const commands = allCommands();
  const missing = commands.filter((name) => synopsisFor(name).length === 0);
  if (missing.length) fail(`Commands dispatch but publish no usage synopsis: ${missing.join(', ')}`);
  const unknown = documentedCommands().filter((name) => {
    try { return !commands.includes(canonicalCommand(name)); } catch { return true; }
  });
  if (unknown.length) fail(`Help pages describe commands that do not exist: ${unknown.join(', ')}`);
}

const hostedAutomationRoot = ['.github', 'workflows'].join('/');
if (allFiles.some((file) => path.relative(root, file).startsWith(`${hostedAutomationRoot}/`))) {
  fail(`${hostedAutomationRoot}/ must remain absent; use the local release and verification scripts.`);
}
for (const file of allFiles.filter((candidate) => candidate.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) fail(`${path.relative(root, file)}: JavaScript syntax check failed\n${result.stderr}`);
  checked.push(path.relative(root, file));
}

// The boolean-flag declaration must keep matching how the code actually reads each flag. A flag that
// is declared boolean but read for a value would silently stop accepting its argument; one that is
// read as a boolean but left undeclared goes back to swallowing the token after it. Both are silent,
// so re-derive the truth from the source and compare.
{
  const sources = allFiles.filter((file) => /\.(mjs|ts)$/.test(file) && !/[/\\](test|node_modules)[/\\]/.test(file));
  const readAsBoolean = new Set();
  const readAsValue = new Set();
  for (const file of sources) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/optionBoolean\(\s*options\s*,\s*'([a-z0-9-]+)'/g)) readAsBoolean.add(match[1]);
    for (const match of text.matchAll(/option(?:String|Strings|Number|Integer)\(\s*options\s*,\s*'([a-z0-9-]+)'/g)) readAsValue.add(match[1]);
  }
  // Flags read both ways cannot be classified, so they stay greedy — guessing wrong would swallow a
  // real value, which is the worse failure. They are excluded rather than reported.
  const shouldDeclare = [...readAsBoolean].filter((flag) => !readAsValue.has(flag)).sort();
  const missing = shouldDeclare.filter((flag) => !BOOLEAN_OPTIONS.has(flag));
  const contradicted = [...BOOLEAN_OPTIONS].filter((flag) => readAsValue.has(flag)).sort();
  if (missing.length) fail(`BOOLEAN_OPTIONS is missing flags that are only ever read as booleans: ${missing.join(', ')}`);
  if (contradicted.length) fail(`BOOLEAN_OPTIONS declares flags that are read for a value: ${contradicted.join(', ')}`);
  checked.push('boolean option declaration');
}

/**
 * Vocabulary drift, reported but not yet fatal.
 *
 * The glossary now names one canonical word per concept. Enforcing that as an error today would fail
 * the build on 300-odd historical uses across 11,740 lines of Markdown, which is a migration and not
 * a gate. So this counts the non-canonical uses in user-facing help and prints them. Turn it into a
 * `fail` once the count reaches zero — the point of a ratchet is that it can only tighten.
 */
{
  const canonical = [
    { prefer: 'Initiative', avoid: /\bEpics?\b/g, allow: /--epic|epic-[a-z]|sflow-epic|epicBranch|epicId/ },
    { prefer: 'Story', avoid: /\bwork items?\b/gi, allow: /work-items|--work-id|workItem/ },
    { prefer: 'workflow', avoid: /\bprofiles?\b/gi, allow: /portfolio|--profile|profiles\.|userProfile/ }
  ];
  // docs/GLOSSARY.md is the dictionary: it has to name the words it is resolving. Blockquotes are
  // excluded for the same reason — that is where a page states which older name still appears where.
  const surfaces = ['HELP.md', 'README.md', 'INITIATIVE-ORCHESTRATION.md'];
  const drift = [];
  for (const relative of surfaces) {
    const file = path.join(root, relative);
    if (!existsSync(file)) continue;
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n').filter((line) => !line.trimStart().startsWith('>'));
    for (const { prefer, avoid, allow } of canonical) {
      const hits = lines.filter((line) => {
        avoid.lastIndex = 0;
        return avoid.test(line) && !allow.test(line);
      }).length;
      if (hits) drift.push(`${relative}: ${hits} line(s) using a non-canonical word for '${prefer}'`);
    }
  }
  if (drift.length) {
    console.warn(`Vocabulary drift (advisory, see docs/GLOSSARY.md):\n${drift.map((line) => `  - ${line}`).join('\n')}`);
  }
  checked.push('glossary vocabulary');
}

// The `--help` overview is curated by hand — the value is the ordering and the omission — so it can
// drift into naming commands that no longer dispatch. Every name it shows must be a real command.
{
  const unknown = overviewCommands().filter((name) => {
    try { canonicalCommand(name); return false; } catch { return true; }
  });
  if (unknown.length) fail(`The --help overview names commands that do not dispatch: ${unknown.join(', ')}`);
  checked.push('--help overview commands');
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
const skillAudit = await auditSkillPolicy(root);
for (const error of skillAudit.errors) fail(`skill policy: ${error}`);
checked.push('plugin/skills/registry.yml', 'scripts/skill-policy.mjs');

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

for (const schemaFile of [
  'schemas/config.schema.json',
  'schemas/workflow.schema.json',
  'schemas/workflow-definition.schema.json',
  'schemas/agents-lock.schema.json',
  'schemas/agent-mappings.schema.json',
  'schemas/portfolio.schema.json',
  'schemas/capabilities.schema.json',
  'schemas/mcp-evidence-record.schema.json',
  'schemas/design-source-set.schema.json',
  'schemas/visual-coverage.schema.json',
  'schemas/visual-comparison.schema.json',
  'schemas/design-inventory.schema.json',
  'schemas/design-source-provenance.schema.json',
  'schemas/mcp-readiness-attestation.schema.json',
  'schemas/mcp-preflight.schema.json',
  'schemas/reference-envelope.schema.json',
  'schemas/reference-record.schema.json',
  'schemas/harness-event.schema.json',
  'schemas/harness-checker-result.schema.json',
  'schemas/knowledge-record.schema.json',
  'schemas/operation-definition.schema.json',
  'schemas/model-invocation-request.schema.json',
  'schemas/model-invocation-event.schema.json',
  'schemas/generation-authorship.schema.json',
  'schemas/artifact-validation.schema.json'
]) {
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

/**
 * The documentation mapping, held closed in both directions `[DOC:REQ-003]` `[DOC:AC-001]`.
 *
 * Documentation drifts from software silently — that is its defining failure mode, and no amount of
 * care at authoring time fixes it. The supplied topic set is the proof: it referenced `sflow me`, a
 * command that has never existed, and `telemetry report`, which is spelled `reconcile`. Both read
 * perfectly well. Both would have been relayed to a user, with a citation, as fact.
 *
 * So: every user-facing command must be documented by at least one topic, and no topic may name a
 * command or subcommand the CLI does not have.
 */
{
  const { loadTopics, aliasTable } = await import('../src/docs-topics.mjs');
  const { COMMAND_REGISTRY } = await import('../src/command-registry.mjs');
  const { HELP } = await import('../src/help-text.mjs');

  let topics = [];
  try {
    topics = await loadTopics();
  } catch (error) {
    fail(`Documentation topics do not compile: ${error.message}`);
  }

  if (topics.length) {
    const commandNames = new Set();
    for (const entry of COMMAND_REGISTRY) {
      commandNames.add(entry.name);
      for (const alias of entry.aliases) commandNames.add(alias);
    }

    // Subcommands come from the synopsis, which is already the single source of usage truth. A
    // `<PLACEHOLDER>` or `[optional]` token is an argument, not a subcommand, so neither counts.
    const subcommands = new Map();
    for (const line of HELP.split('\n')) {
      const match = /^\s{2}(?:singularity-flow|sflow|sf-[a-z-]+)\s+([a-z][a-z-]*)\s+([a-z][a-z-]*)/.exec(line);
      if (!match) continue;
      if (!commandNames.has(match[1])) continue;
      if (!subcommands.has(match[1])) subcommands.set(match[1], new Set());
      subcommands.get(match[1]).add(match[2]);
    }

    // Direction one: no topic invents a command.
    const invented = [];
    for (const topic of topics) {
      for (const name of topic.commands) {
        if (!commandNames.has(name)) invented.push(`${topic.file} declares command '${name}'`);
      }
      // Inline `sflow <command> <subcommand>` spans in the body are claims too, and they are the
      // ones a reader will actually type.
      for (const [, command, rest] of topic.body.matchAll(/`(?:sflow|singularity-flow)\s+([a-z][a-z-]*)((?:\s+[a-z][a-z/-]*)*)`/g)) {
        if (!commandNames.has(command)) {
          invented.push(`${topic.file} shows \`sflow ${command}\``);
          continue;
        }
        const known = subcommands.get(command);
        if (!known) continue;
        // Only the first level. The synopsis is parsed one subcommand deep, so `story interval
        // reconcile` can be checked as far as `story interval` and no further — and a check that
        // pretended to verify the third token would reject correct documentation, which is a worse
        // failure than checking less. `status/report` in a code span means "either of these".
        const [first = ''] = rest.trim().split(/\s+/).filter(Boolean);
        for (const candidate of first.split('/').filter(Boolean)) {
          if (!known.has(candidate)) invented.push(`${topic.file} shows \`sflow ${command} ${candidate}\`, which is not in the synopsis`);
        }
      }
      for (const related of topic.related) {
        if (!topics.some((entry) => entry.id === related)) invented.push(`${topic.file} relates to unknown topic '${related}'`);
      }
    }
    if (invented.length) fail(`Documentation topics reference things that do not exist:\n    ${invented.join('\n    ')}`);

    // Direction two: no user-facing command is undocumented. Internal reset/install plumbing is not
    // something a person asks a question about, and pretending otherwise would pad the topic set
    // with pages nobody reads.
    const notUserFacing = new Set([
      'about', 'help', 'explain', 'show', 'harness', 'init', 'factory-reset', 'reset-all', 'local-reset',
      'fresh-install', 'reinstall', 'refresh-branch', 'hook', 'plugin', 'session', 'state', 'watch',
      'cockpit', 'run', 'assign', 'stack', 'prompt-log', 'logs', 'snapshot', 'choices', 'action',
      'agent', 'agents', 'workflow', 'workspace', 'capability', 'capabilities', 'configuration',
      'initiative', 'jira', 'knowledge', 'prepare', 'progress', 'quickstart', 'regression', 'resume',
      'wm', 'bootstrap', 'next', 'inputs', 'artifact', 'pr', 'stack'
    ]);
    const documented = new Set(topics.flatMap((topic) => topic.commands));
    const undocumented = [...commandNames]
      .filter((name) => !notUserFacing.has(name) && !documented.has(name))
      .filter((name) => COMMAND_REGISTRY.some((entry) => entry.name === name))
      .sort();
    if (undocumented.length) {
      fail(`User-facing commands no topic documents: ${undocumented.join(', ')}. Document them, or add them to the not-user-facing list in scripts/check.mjs with a reason.`);
    }

    // The manifest must describe the topics that are actually on disk `[DOC:REQ-004]`, or `doctor`
    // reports a version that means nothing and a citation points at bytes nobody shipped.
    const { buildManifest } = await import('../src/docs-topics.mjs');
    const { docsManifest } = await import('../src/docs-manifest.mjs');
    const manifest = docsManifest();
    if (!manifest) fail('No docs manifest is stamped. Run: node scripts/build-docs-manifest.mjs');
    else if (manifest.contentSha256 !== buildManifest(topics).contentSha256) {
      fail('The docs manifest does not match docs/topics. Run: node scripts/build-docs-manifest.mjs');
    }

    /**
     * Versions bump with content `[DOC:REQ-001]`.
     *
     * Without this the version is decoration: a topic's words change, its version does not, and a
     * reader who was told "approvals v1" last month and "approvals v1" today has no way to know the
     * answer moved. Compared against the manifest in HEAD, so the question asked is exactly "did
     * this commit change a topic without saying so?".
     */
    const previous = spawnSync('git', ['show', 'HEAD:src/docs-manifest.json'], { cwd: root, encoding: 'utf8' });
    if (previous.status === 0) {
      let baseline = null;
      try { baseline = JSON.parse(previous.stdout); } catch { baseline = null; }
      const before = new Map((baseline?.topics ?? []).map((entry) => [entry.id, entry]));
      const unbumped = topics
        .filter((topic) => {
          const prior = before.get(topic.id);
          return prior && prior.sha256 !== topic.sha256 && prior.version === topic.version;
        })
        .map((topic) => `${topic.file} (still v${topic.version})`);
      if (unbumped.length) {
        fail(`Topic content changed without a version bump: ${unbumped.join(', ')}. Raise 'version:' in the frontmatter, then rebuild the manifest.`);
      }
    }

    // An alias that shadows nothing is dead weight; one that collides is a silent misdirection.
    // `loadTopics` throws on collisions, so reaching here means only the count is worth recording.
    checked.push(`docs/topics (${topics.length} topics, ${aliasTable(topics).size} aliases)`);
  }
}

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
  console.log(`Singularity Flow check passed: ${checked.length} checks across ${skillDirs.length} skills, ${agentFiles.length} agent(s), and ${extensionDirs.length} extension(s); no Python or embedded MCP transport.`);
}

/**
 * `singularity-flow apm marketplace init` and `singularity-flow apm publish` [APM A4, 2026-10-30]:
 * the organisation's own catalog of agents, as APM's monorepo-hybrid marketplace, changed only
 * through pull requests.
 *
 * A marketplace is a Git repository whose apm.yml has a `marketplace:` block. Each package SFlow
 * publishes lives in `plugins/<name>/` (its own apm.yml and `.apm/` folder) and is listed there as
 * a local-path entry; `apm pack` compiles the Copilot index `.github/plugin/marketplace.json` that
 * `apm marketplace add` reads, and `apm install <name>@<marketplace>` installs from it. SFlow writes
 * the package and its entry, APM compiles the index, and each change is one commit on an `apm/`
 * branch of the marketplace's checkout. Nothing is pushed. The marketplace's own Actions workflow
 * runs APM's gates on every pull request.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { APM_MANIFEST } from './apm-lock.mjs';
import { APM_ACTION, CHECKOUT_ACTION, recordPin, requireApmCli, runApm, storyOnBranch } from './apm-install.mjs';
import { add, changedPaths, checkedOutBranch, checkout, commit, head, refExists, remoteUrl, repoRoot } from './git.mjs';
import { SingularityFlowError } from './util.mjs';
import { renderPreservingFormatting } from './yaml-formatting.mjs';

export const APM_MARKETPLACE_INIT_RESULT = 'sflow-apm-marketplace-init';
export const APM_PUBLISH_RESULT = 'sflow-apm-publish';
export const PLUGINS_ROOT = 'plugins';
export const MARKETPLACE_WORKFLOW = '.github/workflows/apm-marketplace.yml';
// The Copilot index `apm pack` compiles for the `copilot` output, which `apm marketplace add` reads.
export const COPILOT_INDEX = '.github/plugin/marketplace.json';
// This repository's choice of steps for an agent: a consumer binds it in its own workflow.yml.
const STEP_METADATA = Object.freeze(['sflow-phases', 'sflow-default-for']);
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const MAX_DESCRIPTION = 1024;

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const posix = (value) => value.split(path.sep).join('/');

/** `host/owner/repo` of a remote URL, without credentials or `.git`; null when there is none. */
export function remoteRepository(url) {
  const value = String(url ?? '').trim();
  if (!value) return null;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/u.exec(value);
  let host;
  let pathname;
  if (scp) [, host, pathname] = scp;
  else {
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'file:') return null;
      host = parsed.hostname;
      pathname = parsed.pathname;
    } catch { return null; }
  }
  const repository = pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '');
  return host && repository ? `${host}/${repository}` : null;
}

function checkName(value, what) {
  if (!NAME.test(String(value ?? '')) || String(value).length > 64) {
    fail(`${what} must be lower-case kebab-case, at most 64 characters: '${value ?? ''}'.`, 'APM_NAME_INVALID', { value });
  }
  return String(value);
}

function oneLine(value, what, max = MAX_DESCRIPTION) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!text) fail(`${what} must not be empty.`, 'APM_TEXT_INVALID');
  if (text.length > max) fail(`${what} is longer than ${max} characters.`, 'APM_TEXT_INVALID');
  return text;
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

async function readYamlDocument(file) {
  const text = await readFile(file, 'utf8').catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
  if (text == null) return null;
  const document = YAML.parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) fail(`${file} is not valid YAML: ${document.errors[0].message.split('\n')[0]}`, 'APM_MANIFEST_INVALID');
  return Object.assign(document, { originalText: text });
}

/** Write an edited apm.yml, keeping every line the edit did not touch as APM wrote it. */
async function writeYamlDocument(file, document) {
  await writeFile(file, renderPreservingFormatting(document.originalText, document));
}

/** The branch this change is committed on: the checked-out `apm/` branch, or a new unique one. */
export function targetBranch(root, current, base) {
  if (current.startsWith('apm/')) return current;
  for (let index = 1; index < 100; index += 1) {
    const name = index === 1 ? base : `${base}-${index}`;
    if (!refExists(root, `refs/heads/${name}`)) return name;
  }
  return fail(`Every branch name from ${base} to ${base}-99 is taken; delete the old ones first.`, 'APM_BRANCH_TAKEN');
}

/**
 * A marketplace checkout ready for one reviewed change: on a branch, with commits, and nothing
 * uncommitted, so the commit holds exactly what SFlow and `apm pack` wrote, whichever indexes the
 * marketplace compiles.
 */
export function requireCleanBranch(root, label) {
  const current = checkedOutBranch(root);
  if (!current) fail(`Check out a branch in ${label} first; the change is committed on a branch for review.`, 'APM_DETACHED');
  try { head(root); } catch { fail(`${label} has no commit yet; commit something first (a README is enough).`, 'APM_NO_COMMIT'); }
  const dirty = changedPaths(root, ['.']);
  if (dirty.length) {
    fail(`Commit or stash these in ${label} first, so the commit holds only this change: ${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', …' : ''}.`,
      'APM_DIRTY', { paths: dirty });
  }
  return current;
}

async function readIndex(root, relative) {
  const text = await readFile(path.join(root, relative), 'utf8').catch(() => null);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** The GitHub Actions workflow that runs APM's gates on every pull request to the marketplace. */
export function marketplaceWorkflowText({ apmVersion, branch }) {
  return [
    '# APM gates for this marketplace, written by singularity-flow apm marketplace init.',
    '# Every pull request: the compiled index matches apm.yml, every listed package resolves, and',
    '# no package file hides characters. apm-version is the version apm.yml pins (x-sflow.apm-cli);',
    '# change both together.',
    'name: APM marketplace',
    'on:',
    '  pull_request:',
    '  push:',
    `    branches: [${JSON.stringify(branch)}]`,
    'permissions:',
    '  contents: read',
    'jobs:',
    '  gates:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: ${CHECKOUT_ACTION}`,
    `      - uses: ${APM_ACTION}`,
    '        with:',
    '          setup-only: true',
    `          apm-version: '${apmVersion}'`,
    '      - name: The index matches apm.yml',
    '        run: apm pack --check-clean --offline',
    '      - name: Every listed package resolves',
    '        run: apm marketplace check --offline',
    '      - name: No hidden characters in package files',
    `        run: if [ -d ${PLUGINS_ROOT} ]; then find ${PLUGINS_ROOT} -type f -print0 | xargs -0 -r -n 1 apm audit --file; fi`,
    ''
  ].join('\n');
}

/**
 * Make the repository at `root` a marketplace: APM's own `apm marketplace init`, set to compile the
 * Copilot index with no example package, the pinned APM CLI, the gates workflow, and the first
 * index from `apm pack`, committed on `apm/marketplace-init`.
 */
export async function initApmMarketplace(root, { name, owner, description = null, dryRun = false, apm = runApm, cliVersion = undefined } = {}) {
  const marketplaceName = checkName(name, 'The marketplace name');
  const ownerName = oneLine(owner, 'The owner (--owner)', 200);
  const summary = description == null ? null : oneLine(description, 'The description');
  const existing = await readYamlDocument(path.join(root, APM_MANIFEST));
  if (existing?.has('marketplace')) {
    fail(`${APM_MANIFEST} already has a marketplace block (${existing.get('name') ?? 'unnamed'}); publish packages to it with singularity-flow apm publish.`,
      'APM_MARKETPLACE_EXISTS');
  }
  const { found } = await requireApmCli(root, cliVersion);
  const writesWorkflow = !(await lstat(path.join(root, MARKETPLACE_WORKFLOW)).catch(() => null));
  const current = requireCleanBranch(root, 'this checkout');
  const branch = targetBranch(root, current, 'apm/marketplace-init');
  const planned = [APM_MANIFEST, COPILOT_INDEX, ...(writesWorkflow ? [MARKETPLACE_WORKFLOW] : [])];
  const repository = remoteRepository(remoteUrl(root));
  const base = {
    schemaVersion: 1, resultType: APM_MARKETPLACE_INIT_RESULT, name: marketplaceName, owner: ownerName, apmVersion: found,
    repository, branch, from: current
  };
  if (dryRun) return { ...base, dryRun: true, committed: false, files: planned, workflowWritten: writesWorkflow };

  const exit = apm(root, ['marketplace', 'init', '--name', marketplaceName, '--owner', ownerName]);
  if (exit !== 0) fail(`apm marketplace init exited with status ${exit}. Nothing was committed; git status shows anything it wrote.`, 'APM_MARKETPLACE_INIT_FAILED', { status: exit });
  const document = await readYamlDocument(path.join(root, APM_MANIFEST));
  if (!document?.has('marketplace')) fail(`apm marketplace init wrote no marketplace block to ${APM_MANIFEST}. Nothing was committed.`, 'APM_MARKETPLACE_INIT_FAILED');
  // APM's scaffold says "A short description of what this repo offers"; the index shows it.
  document.set('description', summary ?? `Agents and skills ${ownerName} approves.`);
  // Copilot's index is the one `apm marketplace add` reads; APM's example package is not ours.
  document.setIn(['marketplace', 'outputs'], document.createNode({ copilot: {} }));
  const outputsKey = document.get('marketplace', true).items.find((pair) => pair.key?.value === 'outputs')?.key;
  if (outputsKey) outputsKey.commentBefore = ` Output targets: copilot compiles ${COPILOT_INDEX}, which apm marketplace add reads.`;
  document.setIn(['marketplace', 'packages'], document.createNode([]));
  const packagesKey = document.get('marketplace', true).items.find((pair) => pair.key?.value === 'packages')?.key;
  if (packagesKey) packagesKey.commentBefore = ` Packages: singularity-flow apm publish adds each one from ${PLUGINS_ROOT}/<name>/ in its own pull request.`;
  const url = document.getIn(['marketplace', 'owner', 'url']);
  if (url != null && !/^https:\/\/\S+$/u.test(String(url))) document.deleteIn(['marketplace', 'owner', 'url']);
  await writeYamlDocument(path.join(root, APM_MANIFEST), document);
  await recordPin(root, found);
  if (writesWorkflow) {
    await mkdir(path.join(root, path.dirname(MARKETPLACE_WORKFLOW)), { recursive: true });
    // The branch the pull request merges into: the one init started from, unless that was an apm/ branch.
    await writeFile(path.join(root, MARKETPLACE_WORKFLOW), marketplaceWorkflowText({ apmVersion: found, branch: current.startsWith('apm/') ? 'main' : current }));
  }
  const packed = apm(root, ['pack', '--offline']);
  if (packed !== 0) fail(`apm pack exited with status ${packed}. Nothing was committed; git status shows what was written.`, 'APM_PACK_FAILED', { status: packed });
  const index = await readIndex(root, COPILOT_INDEX);
  if (index?.name !== marketplaceName) fail(`apm pack did not write ${COPILOT_INDEX} for ${marketplaceName}. Nothing was committed.`, 'APM_PACK_FAILED');

  const changed = changedPaths(root, ['.']);
  if (branch !== current) await checkout(root, branch, { base: current });
  add(root, changed);
  const sha = commit(root, [
    `Start the ${marketplaceName} APM marketplace`,
    '',
    `apm marketplace init --name ${marketplaceName} (apm ${found}), set to compile ${COPILOT_INDEX}.`,
    ...(writesWorkflow ? [`${MARKETPLACE_WORKFLOW} runs apm pack --check-clean, apm marketplace check and apm audit on every pull request.`] : [])
  ].join('\n'), changed);
  return {
    ...base, dryRun: false, committed: true, commit: sha, createdBranch: branch !== current, changed, workflowWritten: writesWorkflow,
    nextActions: [
      { command: `git push -u origin ${branch}`, why: 'Send the branch.' },
      { command: 'gh pr create --fill', why: 'Open the pull request that starts the marketplace.' },
      { command: `apm marketplace add ${repository ?? '<owner>/<repository>'} --name ${marketplaceName}`, why: 'Once it is merged, each machine registers the marketplace once.' }
    ]
  };
}

/**
 * The agent's text as a package carries it: without this repository's step choices
 * (`sflow-phases`, `sflow-default-for`) and its `## Attached skills` table, since its skills travel
 * as the package's own. Every other line exactly as written.
 */
export async function packagedAgentText(agent) {
  const { withoutAttachedSkills } = await import('./skill-library.mjs');
  const { parseAgentDependencies } = await import('./agent-document-parser.mjs');
  let text = withoutAttachedSkills(agent.text);
  const front = /^(\uFEFF?---\r?\n)([\s\S]*?\r?\n)(---(?:\r?\n|$))/u.exec(text);
  const kept = { ...agent.metadata };
  for (const key of STEP_METADATA) delete kept[key];
  if (front && STEP_METADATA.some((key) => agent.metadata?.[key] != null)) {
    // Each value is a one-line string (the agent parser requires strings), so its line goes; an
    // emptied `metadata:` goes too. The result must parse to the same metadata without those keys.
    const lines = front[2].split(/(?<=\n)/u).filter((line) => !new RegExp(`^\\s+(?:${STEP_METADATA.join('|')})\\s*:`, 'u').test(line));
    const at = lines.findIndex((line) => /^metadata\s*:\s*\r?\n$/u.test(line));
    if (at >= 0 && !Object.keys(kept).length && !/^\s/u.test(lines[at + 1] ?? '')) lines.splice(at, 1);
    text = `${front[1]}${lines.join('')}${front[3]}${text.slice(front[0].length)}`;
  }
  const parsed = parseAgentDependencies(text, { source: `.apm/agents/${agent.id}.agent.md`, agentId: agent.id });
  const expected = { ...agent.frontmatter, metadata: kept };
  if (!Object.keys(kept).length && agent.frontmatter?.metadata == null) delete expected.metadata;
  if (!Object.keys(kept).length && parsed.frontmatter.metadata == null) delete expected.metadata;
  if (JSON.stringify(parsed.frontmatter) !== JSON.stringify(expected)) {
    fail(`${agent.id}'s sflow-phases or sflow-default-for metadata spans several lines; write each on one line, then publish again.`, 'APM_PUBLISH_UNSUPPORTED', { agent: agent.id });
  }
  return text;
}

/** Every file under `directory`, as `{ relative: bytes }`; an empty map when it is absent. */
async function filesUnder(directory, prefix = '') {
  const files = new Map();
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [key, value] of await filesUnder(path.join(directory, entry.name), relative)) files.set(key, value);
    else files.set(relative, await readFile(path.join(directory, entry.name)));
  }
  return files;
}

/** What the agents and skills named here publish: checked agents, their skills, and refusals. */
async function publishedAssets(root, agentIds, skillIds) {
  const [{ loadDefinition }, { effectiveLibrarySkills, loadSkillLibrary, librarySkillPath, SKILL_ATTACHMENTS_PATH }, { USER_DEFINED_METADATA }] = await Promise.all([
    import('./config.mjs'), import('./skill-library.mjs'), import('./user-defined-agent-identity.mjs')
  ]);
  const definition = await loadDefinition(root);
  const library = (await loadSkillLibrary(root)).skills;
  const agents = [];
  const skills = new Map();
  for (const id of agentIds) {
    const agent = definition.agents?.[id];
    if (!agent) fail(`There is no agent '${id}'. singularity-flow agents list shows this repository's agents.`, 'APM_PUBLISH_AGENT_UNKNOWN', { agent: id });
    if (agent.apm) fail(`${id} was installed by APM (${agent.apm.package}); publish it from its own package.`, 'APM_PUBLISH_NOT_OURS', { agent: id });
    if (agent.scope !== 'repository' || !agent.file) fail(`${id} ships with SFlow (${agent.scope}); only an agent written in this repository is published.`, 'APM_PUBLISH_NOT_OURS', { agent: id });
    if (agent.metadata?.[USER_DEFINED_METADATA]) fail(`${id} is a user-defined agent whose folder SFlow reads at each step; its folder does not travel in an APM package yet.`, 'APM_PUBLISH_UNSUPPORTED', { agent: id });
    if (agent.dependencies?.length) {
      fail(`${id} names remote resources (${agent.dependencies.map((entry) => entry.id).join(', ')}); a package carries only its own files, so attach them as skills first.`,
        'APM_PUBLISH_UNSUPPORTED', { agent: id });
    }
    agents.push(agent);
    for (const attachment of effectiveLibrarySkills(agent)) skills.set(attachment.id, { id: attachment.id, by: id });
  }
  for (const id of skillIds) if (!skills.has(id)) skills.set(id, { id, by: null });
  const packaged = [];
  for (const { id, by } of skills.values()) {
    const skill = library.get(id);
    if (!skill) fail(`${by ? `${by} attaches skill '${id}', but it` : `Skill '${id}'`} is not in the skill master (${librarySkillPath(id)}).`, 'APM_PUBLISH_SKILL_UNKNOWN', { skill: id });
    if (skill.instructionRefs.length) {
      fail(`Skill '${id}' uses SFlow instructions (${skill.instructionRefs.join(', ')}), which do not travel in an APM package yet.`, 'APM_PUBLISH_UNSUPPORTED', { skill: id });
    }
    packaged.push(skill);
  }
  const sources = [...agents.map((agent) => posix(path.relative(root, agent.file))), ...packaged.map((skill) => skill.path)];
  const uncommitted = changedPaths(root, [...sources, SKILL_ATTACHMENTS_PATH]);
  if (uncommitted.length) {
    fail(`Commit these first, so the package is what a reviewer saw here: ${uncommitted.join(', ')}.`, 'APM_PUBLISH_UNCOMMITTED', { paths: uncommitted });
  }
  return { agents, skills: packaged, sources };
}

function nextVersion(current, requested) {
  if (requested != null && !VERSION.test(requested)) fail(`--version must be MAJOR.MINOR.PATCH, for example 1.2.0: '${requested}'.`, 'APM_VERSION_INVALID');
  if (current == null) return requested ?? '1.0.0';
  if (requested == null) {
    const [major, minor, patch] = current.split('.').map(Number);
    return `${major}.${minor}.${patch + 1}`;
  }
  if (compareVersions(requested, current) <= 0) fail(`The marketplace has this package at ${current}; publish a later version than that.`, 'APM_VERSION_NOT_LATER', { current, requested });
  return requested;
}

/**
 * Publish this repository's agents (and the skills they attach) as one package in the marketplace
 * checked out at `marketplaceRoot`: `plugins/<name>/`, its entry in apm.yml, and the index from
 * `apm pack`, committed on `apm/publish-<name>-<version>` there for review.
 */
export async function publishApmPackage(root, {
  agents: agentIds = [], skills: skillIds = [], marketplace, packageName = null, version = null, description = null,
  dryRun = false, apm = runApm, cliVersion = undefined
} = {}) {
  if (!agentIds.length) fail('Name the agents to publish: singularity-flow apm publish <AGENT>... --marketplace <CHECKOUT>.', 'APM_PUBLISH_INVALID');
  if (!marketplace) fail('Name the marketplace\'s checkout: --marketplace <CHECKOUT>.', 'APM_PUBLISH_INVALID');
  if (agentIds.length > 1 && !packageName) fail('Several agents publish as one package; name it with --package.', 'APM_PUBLISH_INVALID');
  const name = checkName(packageName ?? agentIds[0], 'The package name');
  const resolved = await realpath(path.resolve(root, marketplace)).catch(() => null);
  let marketplaceRoot = null;
  try { marketplaceRoot = resolved && repoRoot(resolved); } catch { marketplaceRoot = null; }
  if (!marketplaceRoot || await realpath(marketplaceRoot).catch(() => null) !== resolved) {
    fail(`${marketplace} is not the top of a Git checkout.`, 'APM_MARKETPLACE_MISSING', { marketplace });
  }
  const manifest = await readYamlDocument(path.join(marketplaceRoot, APM_MANIFEST));
  if (!manifest?.has('marketplace')) {
    fail(`${marketplace} is not an APM marketplace (its ${APM_MANIFEST} has no marketplace block). Run singularity-flow apm marketplace init there first.`, 'APM_MARKETPLACE_MISSING', { marketplace });
  }
  const story = await storyOnBranch(root, checkedOutBranch(root) ?? '');
  if (story) fail(`This checkout is Story ${story}'s. Publish from the base branch's checkout once the agents' changes are merged.`, 'APM_PUBLISH_STORY_CHECKOUT', { workId: story });
  const { agents, skills, sources } = await publishedAssets(root, [...new Set(agentIds)], [...new Set(skillIds)]);

  const files = new Map();
  for (const agent of agents) files.set(`.apm/agents/${agent.id}.agent.md`, Buffer.from(await packagedAgentText(agent), 'utf8'));
  for (const skill of skills) files.set(`.apm/skills/${skill.id}/SKILL.md`, Buffer.from(skill.text, 'utf8'));
  const { scanText } = await import('./secrets.mjs');
  const findings = [...files].flatMap(([relative, bytes]) => scanText(bytes.toString('utf8'), { path: relative }).filter((entry) => !entry.waived));
  if (findings.length) {
    fail(`These look like secrets and would be published: ${findings.slice(0, 5).map((entry) => `${entry.path}:${entry.line} (${entry.label})`).join(', ')}.`,
      'APM_PUBLISH_SECRET', { findings: findings.map(({ path: file, line, rule }) => ({ path: file, line, rule })) });
  }

  const pluginDirectory = `${PLUGINS_ROOT}/${name}`;
  const entries = manifest.getIn(['marketplace', 'packages']);
  const listed = YAML.isSeq(entries) ? entries.items.findIndex((item) => YAML.isMap(item) && item.get('name') === name) : -1;
  if (listed >= 0 && String(entries.items[listed].get('source') ?? '').replace(/^\.\//u, '') !== pluginDirectory) {
    fail(`The marketplace already lists ${name} from ${entries.items[listed].get('source')}; choose another --package name.`, 'APM_PUBLISH_NAME_TAKEN', { name });
  }
  const existing = await readYamlDocument(path.join(marketplaceRoot, pluginDirectory, APM_MANIFEST));
  if (existing && existing.getIn(['x-sflow', 'published-from']) == null) {
    fail(`${pluginDirectory} was not published by SFlow; change it in its own pull request.`, 'APM_PUBLISH_NOT_OURS', { name });
  }
  // The entry's version counts too: a folder deleted by hand never makes the next publish go back.
  const listedVersion = listed >= 0 ? String(entries.items[listed].get('version') ?? '') : '';
  const versions = [existing ? String(existing.get('version') ?? '0.0.0') : null, VERSION.test(listedVersion) ? listedVersion : null].filter(Boolean);
  const currentVersion = versions.sort(compareVersions).at(-1) ?? null;
  const summary = oneLine(description ?? existing?.get('description') ?? (agents.length === 1 ? agents[0].description : `Agents ${agents.map((agent) => agent.id).join(', ')}`), 'The description');
  const previous = existing ? await filesUnder(path.join(marketplaceRoot, pluginDirectory)) : new Map();
  previous.delete(APM_MANIFEST);
  const unchanged = existing && summary === String(existing.get('description') ?? '') && previous.size === files.size
    && [...files].every(([relative, bytes]) => previous.get(relative)?.equals(bytes));
  const marketplaceName = String(manifest.get('name') ?? path.basename(marketplaceRoot));
  const listing = {
    schemaVersion: 1, resultType: APM_PUBLISH_RESULT, marketplace: marketplaceName, package: name, directory: pluginDirectory,
    agents: agents.map((agent) => agent.id), skills: skills.map((skill) => skill.id),
    stepsKeptHere: agents.filter((agent) => agent.phases.length || agent.defaultFor.length)
      .map((agent) => ({ agent: agent.id, steps: [...new Set([...agent.defaultFor, ...agent.phases])] })),
    skillsMoved: agents.filter((agent) => agent.librarySkills?.length).map((agent) => agent.id)
  };
  if (unchanged) return { ...listing, dryRun, version: currentVersion, unchanged: true, committed: false };
  const nextPackageVersion = nextVersion(currentVersion, version);
  const { found } = await requireApmCli(marketplaceRoot, cliVersion);
  const current = requireCleanBranch(marketplaceRoot, marketplace);
  const branch = targetBranch(marketplaceRoot, current, `apm/publish-${name}-${nextPackageVersion}`);
  const sourceCommit = head(root);
  const repository = remoteRepository(remoteUrl(root));
  const packageManifest = {
    name, version: nextPackageVersion, description: summary,
    ...(manifest.get('license') ? { license: String(manifest.get('license')) } : {}),
    'x-sflow': { 'published-from': { ...(repository ? { repository } : {}), commit: sourceCommit, agents: listing.agents, ...(listing.skills.length ? { skills: listing.skills } : {}) } }
  };
  files.set(APM_MANIFEST, Buffer.from(YAML.stringify(packageManifest, { lineWidth: 0 }), 'utf8'));
  const planned = [...files.keys()].sort().map((relative) => ({ path: `${pluginDirectory}/${relative}`, bytes: files.get(relative).length, sha256: sha256(files.get(relative)) }));
  const base = { ...listing, version: nextPackageVersion, previousVersion: currentVersion, apmVersion: found, branch, from: current, files: planned, sources };
  if (dryRun) return { ...base, dryRun: true, unchanged: false, committed: false };

  if (branch !== current) await checkout(marketplaceRoot, branch, { base: current });
  // SFlow published this folder, so it is replaced whole: nothing an earlier version had lingers.
  await rm(path.join(marketplaceRoot, pluginDirectory), { recursive: true, force: true });
  for (const [relative, bytes] of files) {
    const target = path.join(marketplaceRoot, pluginDirectory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const entry = { name, source: `./${pluginDirectory}`, description: summary, version: nextPackageVersion };
  if (listed >= 0) for (const [key, value] of Object.entries(entry)) entries.items[listed].set(key, value);
  else if (YAML.isSeq(entries)) {
    // marketplace init leaves `packages: []`; a listed package reads as a block like APM's own.
    entries.flow = false;
    entries.items.push(manifest.createNode(entry));
  }
  else manifest.setIn(['marketplace', 'packages'], manifest.createNode([entry]));
  await writeYamlDocument(path.join(marketplaceRoot, APM_MANIFEST), manifest);
  const packed = apm(marketplaceRoot, ['pack', '--offline']);
  if (packed !== 0) {
    fail(`apm pack exited with status ${packed}. Nothing was committed; git status in ${marketplace} shows what was written on ${branch}.`, 'APM_PACK_FAILED', { status: packed, branch });
  }
  // Every index apm pack compiled (the checkout was clean, so each changed one is its) lists it.
  const changed = changedPaths(marketplaceRoot, ['.']);
  const indexes = changed.filter((relative) => path.posix.basename(relative) === 'marketplace.json');
  const indexed = [];
  for (const relative of indexes) {
    const plugin = (await readIndex(marketplaceRoot, relative))?.plugins?.find?.((item) => item?.name === name);
    if (plugin?.version === nextPackageVersion) indexed.push(relative);
  }
  if (!indexed.length || indexed.length !== indexes.length) {
    fail(`apm pack did not list ${name} ${nextPackageVersion} in ${indexes.length ? indexes.join(', ') : 'any index'}. Nothing was committed.`, 'APM_PACK_FAILED', { branch });
  }

  add(marketplaceRoot, changed);
  const sha = commit(marketplaceRoot, [
    `Publish ${name} ${nextPackageVersion} to ${marketplaceName}`,
    '',
    `From ${repository ?? 'this repository'} @ ${sourceCommit.slice(0, 12)}: agent${agents.length === 1 ? '' : 's'} ${listing.agents.join(', ')}${listing.skills.length ? `; skill${listing.skills.length === 1 ? '' : 's'} ${listing.skills.join(', ')}` : ''}.`,
    `Index compiled by apm pack (apm ${found}): ${indexed.join(', ')}.`
  ].join('\n'), changed);
  const where = /^[\w./~-]+$/u.test(marketplace) ? marketplace : `'${String(marketplace).replaceAll("'", "'\\''")}'`;
  return {
    ...base, dryRun: false, unchanged: false, committed: true, commit: sha, createdBranch: branch !== current, changed, indexed,
    nextActions: [
      { command: `git -C ${where} push -u origin ${branch}`, why: 'Send the branch.' },
      { command: `cd ${where} && gh pr create --fill`, why: 'Open the pull request the marketplace\'s reviewers approve.' },
      { command: `singularity-flow apm install ${name}@${marketplaceName}`, why: 'Once it is merged, a repository installs it (after apm marketplace update).' }
    ]
  };
}

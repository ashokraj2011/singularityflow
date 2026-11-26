/**
 * What the team already has, read for a task before any marketplace [ITW:REQ-020, docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md]
 * (owner, 2026-11-26: "sf-task also can pick up locally available skills and agents ...and of course scan marketplace
 * also").
 *
 * - Its own workflows, as a task's plan: every workflow in the repository's configuration that SFlow does not ship (one
 *   made in Workflow Studio, one made from an agent with `workflow from-agent`, one imported), but one a task composed,
 *   one archived and one a marketplace agent's import recorded (REQ-011 offers that one by the agent's name). Each step
 *   is read with its intent, who approves it, and the tasks of the library skills attached to it, so a workflow whose
 *   code steps only write tests covers a tests task. A yes runs the workflow exactly as it is.
 * - Its agents, as a task's plan once their workflow is here: each agent in .github/agents (a `<name>.agent.md`, or a
 *   folder holding agent.md) and each agent folder of a package APM installed (apm_modules, with its apm.yml), read and
 *   converted exactly as `workflow from-agent <PATH>` reads and converts it (agent-folder.mjs, agent-workflow.mjs). An
 *   agent with no numbered stages is not a workflow agent and is left out quietly. One whose workflow is already here is
 *   that workflow; one naming a workflow SFlow ships is never offered.
 * - Its skills, beside the skill library: each SKILL.md in .github/skills/<id>/ (the repository's own) and
 *   .agents/skills/<id>/ (where APM puts the skills it installs). apm.lock.yaml says which APM installed, and one changed
 *   since is not used; APM's own copy of the package says what each one is for (its apm.yml) when it is on this computer.
 *   A skill the library has is the library's. A skill that cannot be read is named in a note with what fixes it, and the
 *   task goes on without it: it never stops a task that does not use it.
 *
 * Reads only, and only plain files: a symbolic link is never followed. Nothing here fetches or writes.
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { LEGACY_AGENTS_ROOT } from './configuration-assets.mjs';

/** Where a repository's skills are, besides the library: Copilot's folder first, then the one APM installs into. */
export const LOCAL_SKILL_ROOTS = Object.freeze(['.github/skills', '.agents/skills']);
/** Where a repository's agents are, and where APM installs an agent. */
export const LOCAL_AGENTS_ROOT = LEGACY_AGENTS_ROOT;
/** Where APM keeps the packages it installed, each with its apm.yml; not committed. */
export const APM_MODULES = 'apm_modules';
const LIMITS = Object.freeze({ depth: 6, folders: 2000, skillBytes: 256 * 1024 });
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const firstLine = (error) => String(error?.message ?? error).split('\n')[0].replace(/\.$/u, '');

async function entryOf(file) {
  try {
    const stat = await lstat(file);
    return { kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'folder' : stat.isFile() ? 'file' : 'other', size: stat.size };
  } catch { return null; }
}

async function namesIn(folder) {
  try { return (await readdir(folder)).sort(); } catch { return []; }
}

/**
 * What apm.lock.yaml says APM put in this repository: each path with its package and hash, the locked packages, and the
 * lock's reader (apm-lock.mjs); nothing, and nothing loaded, with no lock.
 */
async function apmDeployed(root) {
  if ((await entryOf(path.join(root, 'apm.lock.yaml')))?.kind !== 'file') return { index: new Map(), packages: [], lock: null };
  const lock = await import('./apm-lock.mjs');
  const read = await lock.readApmDocument(root, lock.APM_LOCKFILE, 'lock').catch(() => ({ present: false }));
  return { index: (read.present && !read.problem ? lock.apmDeployedIndex(read.value) : null) ?? new Map(),
    packages: read.present && !read.problem && Array.isArray(read.value?.dependencies) ? read.value.dependencies : [], lock };
}

/**
 * The folders of the packages APM installed on this computer (apm_modules): each agent folder (agent.md or one
 * `*.agent.md`, with apm.yml) and each skill folder (SKILL.md with apm.yml), by path. Bounded; links are not followed.
 */
async function apmModules(root) {
  const found = { agents: [], skills: [] };
  let folders = 0;
  const walk = async (relative, depth) => {
    if (depth > LIMITS.depth || folders >= LIMITS.folders) return;
    folders += 1;
    const names = await namesIn(path.join(root, relative));
    if (names.includes('apm.yml')) {
      if (names.includes('SKILL.md')) found.skills.push(relative);
      else if (names.includes('agent.md') || names.filter((name) => name.endsWith('.agent.md')).length === 1) found.agents.push(relative);
    }
    for (const name of names) {
      if (!name.startsWith('.') && (await entryOf(path.join(root, relative, name)))?.kind === 'folder') await walk(`${relative}/${name}`, depth + 1);
    }
  };
  if ((await entryOf(path.join(root, APM_MODULES)))?.kind === 'folder') await walk(APM_MODULES, 0);
  return found;
}

/** The package an apm_modules folder belongs to, as apm.lock.yaml names it, or null. */
function packageOf(folder, packages, packageLabel) {
  const owner = packages.filter((entry) => entry && typeof entry === 'object' && entry.repo_url).map((entry) => ({ entry,
    at: [APM_MODULES, String(entry.repo_url).replace(/^[a-z+]+:\/\//u, '').replace(/\.git$/u, ''), ...(entry.virtual_path ? [String(entry.virtual_path).replace(/^\/+/u, '')] : [])].join('/') }))
    .filter(({ at }) => folder === at || folder.startsWith(`${at}/`)).sort((left, right) => right.at.length - left.at.length)[0];
  return owner ? packageLabel(owner.entry) : null;
}

/**
 * The repository's own skills beside the library [ITW:REQ-020]: `{ skills, notes }`, each skill
 * `{ skill, path, apm, own }` (`skill` as parseLibrarySkill reads it; `apm` the package that installed it; `own` what that
 * package's apm.yml says of it). `libraryIds` are the library's skills, which come first; of two folders with one ID the
 * first is used. Each note names a skill that is not used, why, and what fixes it.
 */
export async function localSkills(root, { libraryIds = new Set() } = {}) {
  const { parseLibrarySkill } = await import('./skill-library.mjs');
  const deployed = await apmDeployed(root);
  let modules = null;
  const skills = []; const notes = [];
  const seen = new Set(libraryIds);
  for (const base of LOCAL_SKILL_ROOTS) {
    for (const name of await namesIn(path.join(root, base))) {
      if ((await entryOf(path.join(root, base, name)))?.kind !== 'folder') continue;
      const relative = `${base}/${name}/SKILL.md`;
      const entry = await entryOf(path.join(root, relative));
      if (!entry || seen.has(name)) continue;
      const owner = deployed.index.get(relative) ?? null;
      const broken = (why) => notes.push(`Skill ${name} (${relative}) is not used: ${why}. To use it, ${owner ? 'run apm install, which puts it back as APM installed it' : `correct ${relative}`}.`);
      if (!ID.test(name)) { broken('its folder\'s name is not a skill ID (lower-case words joined by hyphens)'); continue; }
      if (entry.kind !== 'file') { broken(entry.kind === 'link' ? 'it is a symbolic link' : 'it is not a plain file'); continue; }
      if (entry.size > LIMITS.skillBytes) { broken(`it is larger than ${LIMITS.skillBytes / 1024} KiB`); continue; }
      const bytes = await readFile(path.join(root, relative)).catch(() => null);
      if (!bytes) { broken('it could not be read'); continue; }
      if (owner?.sha256 && !deployed.lock.bytesMatch(bytes, owner.sha256)) { broken('it changed since APM installed it'); continue; }
      let skill;
      try { skill = parseLibrarySkill(bytes.toString('utf8'), { id: name, source: relative }); } catch (error) { broken(firstLine(error)); continue; }
      seen.add(name);
      let own = null;
      if (owner) {
        modules ??= await apmModules(root);
        own = await moduleSkillFacts(root, modules.skills, name, bytes.toString('utf8'));
      }
      skills.push({ skill, path: relative, apm: owner?.package ?? null, own });
    }
  }
  return { skills, notes };
}

/** What APM's copy of a skill's package says of it, when that copy holds the same SKILL.md text; else null. */
async function moduleSkillFacts(root, folders, name, text) {
  const same = (other) => other.replace(/\r\n/gu, '\n') === text.replace(/\r\n/gu, '\n');
  for (const folder of folders.filter((entry) => path.posix.basename(entry) === name)) {
    const plain = async (file) => ((await entryOf(path.join(root, folder, file)))?.kind === 'file' ? readFile(path.join(root, folder, file), 'utf8').catch(() => null) : null);
    const [skillText, manifest] = await Promise.all([plain('SKILL.md'), plain('apm.yml')]);
    if (manifest == null || skillText == null || !same(skillText)) continue;
    try {
      const { parsePackageManifest } = await import('./marketplace-repository.mjs');
      const own = parsePackageManifest(manifest, { source: folder });
      return { tags: own.tags ?? [], pdlcTasks: own.pdlcTasks ?? [], lifecycleState: own.lifecycleState ?? null };
    } catch { return null; }
  }
  return null;
}

const approvalOf = (phase) => (phase.approval?.mode === 'none' ? 'none' : phase.approval?.automatic === 'when-ready' ? 'sflow' : 'person');

/**
 * A workflow of the team's own as a task's plan reads it [ITW:REQ-020]: `{ id, source: 'workflow', workflow, label, steps,
 * ready, lifecycle, kinds }`, each step `{ id, intent, label, tasks, approvedBy }`. `approvals` and `tasks` map a step to
 * who approves it and the tasks of the skills attached to it; `from` is the agent of this repository it was made from.
 */
export function localWorkflowCandidate(definition, id, { approvals = {}, tasks = {}, from = null } = {}) {
  const own = definition.workTypes[id];
  return {
    id, source: 'workflow', workflow: id, label: own.label ?? id, agent: null, marketplace: null, version: null, state: null, owner: null,
    lifecycle: 'ready', kinds: [], ready: true, imported: { workflow: id },
    steps: own.phases.map((step) => ({ id: step, intent: definition.phases?.[step]?.intent ?? null, label: definition.phases?.[step]?.label ?? step,
      tasks: [...new Set(tasks[step] ?? [])].sort(), approvedBy: approvals[step] ?? 'person' })),
    ...(from ? { from } : {})
  };
}

/**
 * An agent of this repository's as a task's plan reads it [ITW:REQ-020], from `read` (readAgentFolder's) and its
 * `conversion` (convertAgent's): `{ id, source: 'local-agent', workflow, agent, path, installed, apm, … }`, `id` the
 * workflow it becomes, `path` what `workflow from-agent` names.
 */
export async function localAgentCandidate({ read, conversion, path: where, installed = false, apm = null, kindsOf = () => [] }) {
  const { lifecycleReadiness } = await import('./marketplace-lifecycle.mjs');
  const tasksOf = new Map(read.skills.map((skill) => [skill.name, skill.pdlcTasks ?? []]));
  const state = read.agent.lifecycleState ? String(read.agent.lifecycleState).toLowerCase() : null;
  return {
    id: conversion.workflow.id, source: 'local-agent', workflow: conversion.workflow.id, label: conversion.workflow.label, agent: read.agent.name,
    path: where, installed, apm, marketplace: null, version: read.agent.version ?? null, state, owner: null,
    lifecycle: lifecycleReadiness(state, { unmarked: 'ready' }), kinds: kindsOf(read.agent), ready: conversion.ready,
    steps: conversion.steps.map((step) => ({ id: step.id, intent: step.intent, label: step.label,
      tasks: [...new Set(step.skills.flatMap((use) => tasksOf.get(use.skill) ?? []))].sort() }))
  };
}

/**
 * Each agent this repository has, converted: APM's copies first (they keep apm.yml), then .github/agents. The reader and
 * the conversion are loaded only when there is one.
 */
async function localAgents(root, { kindsOf, notes }) {
  const deployed = await apmDeployed(root);
  const targets = (await apmModules(root)).agents.map((folder) => ({ path: folder, installed: true,
    apm: deployed.lock ? packageOf(folder, deployed.packages, deployed.lock.packageLabel) : null }));
  const here = (await namesIn(path.join(root, LOCAL_AGENTS_ROOT))).map((name) => ({ name, relative: `${LOCAL_AGENTS_ROOT}/${name}` }));
  if (!targets.length && !here.length) return [];
  const [{ isAgentFolder, readAgentFolder }, { convertAgent }] = await Promise.all([import('./agent-folder.mjs'), import('./agent-workflow.mjs')]);
  for (const { name, relative } of here) {
    const kind = (await entryOf(path.join(root, relative)))?.kind;
    if ((kind === 'file' && name.endsWith('.agent.md')) || (kind === 'folder' && await isAgentFolder(path.join(root, relative)))) {
      const owner = deployed.index.get(kind === 'file' ? relative : `${relative}/agent.md`) ?? null;
      targets.push({ path: relative, installed: Boolean(owner), apm: owner?.package ?? null });
    }
  }
  const agents = [];
  for (const target of targets) {
    let read; let conversion;
    try { read = await readAgentFolder(path.join(root, target.path)); } catch (error) {
      notes.push(`Agent ${target.path} is not offered: ${firstLine(error)}.`);
      continue;
    }
    try { conversion = convertAgent({ marketplace: null, folder: read.folder, agent: read.agent, skills: read.skills, answers: {} }); } catch (error) {
      // An agent with no numbered stages is a chat agent, not a workflow's: nothing to say about it.
      if (error?.code !== 'AGENT_WORKFLOW_NO_STAGES') notes.push(`Agent ${target.path} is not offered: ${firstLine(error)}.`);
      continue;
    }
    agents.push(await localAgentCandidate({ read, conversion, path: target.path, installed: target.installed, apm: target.apm, kindsOf }));
  }
  // One agent per workflow: one SFlow can convert first, then APM's copy, then the repository's.
  const byWorkflow = new Map();
  for (const agent of [...agents.filter((entry) => entry.ready), ...agents.filter((entry) => !entry.ready)]) if (!byWorkflow.has(agent.workflow)) byWorkflow.set(agent.workflow, agent);
  return agents.filter((agent) => byWorkflow.get(agent.workflow) === agent);
}

/** The workflows SFlow ships (its starter workflow.yml), which a task's plan never offers as the team's own. */
async function packagedWorkflowIds() {
  const [{ PACKAGE_ROOT }, { default: YAML }] = await Promise.all([import('./package-root.mjs'), import('yaml')]);
  return new Set(Object.keys(YAML.parse(await readFile(path.join(PACKAGE_ROOT, 'templates', 'workflow.yml'), 'utf8'))?.workTypes ?? {}));
}

const sameSteps = (steps, phases) => steps.length === phases.length && steps.every((step, index) => step.id === phases[index]);

/**
 * The team's own plan candidates for a task in `root` with `definition` [ITW:REQ-020]: `{ candidates, notes }`, its
 * workflows (localWorkflowCandidate) and the agents whose workflow is not here yet (localAgentCandidate). `kindsOf` names
 * the kinds of software an agent's tags are for. Reads only.
 */
export async function localPlanCandidates(root, definition, { kindsOf = () => [] } = {}) {
  const notes = [];
  const [{ configurationReadRoot }, { loadImportsLedger }, { loadSkillLibrary, readSkillAttachments }, { resolveWorkType }, { isTaskWorkType },
    { librarySkillCandidate }] = await Promise.all([import('./configuration-read-scope.mjs'), import('./imports-ledger.mjs'), import('./skill-library.mjs'),
    import('./config.mjs'), import('./task-composition.mjs'), import('./task-skills.mjs')]);
  const configRoot = configurationReadRoot(root);
  // The archive's reader is loaded only when the repository has archived a workflow.
  const archived = (await entryOf(path.join(configRoot, 'singularity', 'workflow-archive.yml')))?.kind === 'file'
    ? await (await import('./workflow-archive.mjs')).readWorkflowArchive(root).catch(() => null) : null;
  const [ledger, library, attachments, packaged] = await Promise.all([loadImportsLedger(configRoot).catch(() => ({ imports: {} })),
    loadSkillLibrary(configRoot).catch(() => ({ skills: new Map() })), readSkillAttachments(configRoot).catch(() => []), packagedWorkflowIds()]);
  // A marketplace agent's imported workflow is offered by the agent's name (REQ-011), never twice.
  const fromMarketplace = new Set(Object.values(ledger.imports ?? {}).filter((entry) => entry?.kind === 'workflow' && entry.source?.kind === 'marketplace-agent')
    .map((entry) => entry.workflow));
  const tasksOfSkill = (id) => (library.skills.has(id) ? librarySkillCandidate(library.skills.get(id), ledger.imports?.[`library-skill:${id}`] ?? null).tasks : []);
  const agents = await localAgents(root, { kindsOf, notes });
  const candidates = [];
  const ids = Object.keys(definition.workTypes ?? {}).filter((id) => !packaged.has(id) && !isTaskWorkType(id) && !definition.workTypes[id]?.composedTask
    && !fromMarketplace.has(id) && !Object.hasOwn(archived?.story ?? {}, id) && Array.isArray(definition.workTypes[id]?.phases) && definition.workTypes[id].phases.length).sort();
  for (const id of ids) {
    const own = definition.workTypes[id];
    let approvals;
    try { approvals = Object.fromEntries(resolveWorkType(definition, id).phases.map((phase) => [phase.id, approvalOf(phase)])); } catch (error) {
      notes.push(`Your team's workflow ${own.label ?? id} is not offered: it cannot start as it is (${firstLine(error)}).`);
      continue;
    }
    const tasks = Object.fromEntries(own.phases.map((step) => [step, attachments
      .filter((entry) => (entry.workflow === id && (!entry.phases.length || entry.phases.includes(step))) || (entry.agent && entry.phases.includes(step)))
      .flatMap((entry) => tasksOfSkill(entry.id))]));
    // Made from an agent this repository still has: what its conversion says each step's skills do counts too.
    const made = agents.find((agent) => agent.workflow === id && sameSteps(agent.steps, own.phases)) ?? null;
    for (const step of made?.steps ?? []) tasks[step.id] = [...tasks[step.id], ...step.tasks];
    candidates.push(localWorkflowCandidate(definition, id, { approvals, tasks, from: made ? { agent: made.agent, path: made.path } : null }));
  }
  for (const agent of agents) {
    if (packaged.has(agent.workflow)) {
      notes.push(`Agent ${agent.agent} (${agent.path}) is not offered: its workflow would be named ${agent.workflow}, as one of SFlow's own is.`);
      continue;
    }
    // Its workflow is here already: offered as that workflow, or not at all when that one is not offered.
    if (!definition.workTypes?.[agent.workflow]) candidates.push(agent);
  }
  return { candidates, notes };
}

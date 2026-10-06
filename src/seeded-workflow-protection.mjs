/** Authoring must never silently customize framework workflows or their shared dependencies. */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { PACKAGE_ROOT } from './package-root.mjs';
import { SingularityFlowError } from './util.mjs';
import { librarySkillPath } from './skill-library.mjs';

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
let seeds;
export async function seededWorkflowCatalogs() {
  seeds ??= Promise.all(['workflow.yml', 'portfolio.yml'].map(async (file) => YAML.parse(
    await readFile(path.join(PACKAGE_ROOT, 'templates', file), 'utf8'))));
  const [story, initiative] = await seeds;
  return { story, initiative };
}

export async function seededWorkflowProtection(story, initiative = {}, agents = []) {
  const packaged = await seededWorkflowCatalogs();
  const workflows = Object.keys(packaged.story.workTypes ?? {}).filter((id) => story.workTypes?.[id]);
  const epics = Object.keys(packaged.initiative.initiativeProfiles ?? {}).filter((id) => initiative?.initiativeProfiles?.[id]);
  const phases = new Set(workflows.flatMap((id) => story.workTypes[id].phases ?? []));
  const epicPhases = new Set(epics.flatMap((id) => initiative.initiativeProfiles[id].phases ?? []));
  const agentIds = new Set(agents.filter((agent) => agent.defaultFor?.some((id) => phases.has(id))).map((agent) => agent.id));
  const artifactSets = new Set(); const templates = new Set(); const templateFiles = new Set(); const integrationTargets = new Set();
  const inspect = (value, templateRoot) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'artifactSet' && typeof entry === 'string') artifactSets.add(entry);
      if (key === 'reviewerAgent' && typeof entry === 'string') agentIds.add(entry);
      if (key === 'agents' && Array.isArray(entry)) entry.forEach((id) => agentIds.add(id));
      if (key === 'target' && value.on && value.send) integrationTargets.add(entry);
      if (typeof entry === 'string' && (key === 'template' || key === 'defaultTemplate' || key === 'templateOverrides')) {
        if (entry.startsWith('agent:')) agentIds.add(entry.slice(6).split('/')[0]);
        else if (entry.startsWith('template:')) templates.add(entry.slice(9));
        else templateFiles.add(entry.startsWith(`${templateRoot}/`) ? entry : `${templateRoot}/${entry}`);
      }
      if (key === 'templateOverrides' && entry && typeof entry === 'object') Object.values(entry).forEach((item) => inspect({ template: item }, templateRoot));
      inspect(entry, templateRoot);
    }
  };
  const root = story.templatesRoot ?? 'singularity/templates';
  workflows.forEach((id) => inspect(story.workTypes[id], root));
  phases.forEach((id) => inspect(story.phases?.[id], root));
  epics.forEach((id) => inspect(initiative.initiativeProfiles[id], initiative.templatesRoot ?? root));
  epicPhases.forEach((id) => inspect(initiative.initiativePhases?.[id], initiative.templatesRoot ?? root));
  artifactSets.forEach((id) => inspect(story.artifactSets?.[id], root));
  templates.forEach((id) => { const file = story.templates?.[id]?.path; if (file) templateFiles.add(`${root}/${file}`); });
  const skills = agents.filter((agent) => agentIds.has(agent.id)).flatMap((agent) => (agent.librarySkills ?? []).map((skill) => skill.id));
  return { workflows, epics, phases: [...phases], epicPhases: [...epicPhases], agents: [...agentIds], skills: [...new Set(skills)],
    artifactSets: [...artifactSets], templates: [...templates], templateFiles: [...templateFiles], integrationTargets: [...integrationTargets] };
}

export function assertSeededWorkflowsUnchanged(protectedIds, before, after, { beforeAgents = [], afterAgents = [], files = [] } = {}) {
  const refuse = (subject) => { throw new SingularityFlowError(`Seeded ${subject} is read-only. Duplicate the workflow and edit its independent copy.`, { code: 'SEEDED_WORKFLOW_READ_ONLY' }); };
  for (const [side, catalog, ids] of [
    ['story', 'workTypes', protectedIds.workflows], ['story', 'phases', protectedIds.phases],
    ['story', 'artifactSets', protectedIds.artifactSets], ['story', 'templates', protectedIds.templates],
    ['initiative', 'initiativeProfiles', protectedIds.epics], ['initiative', 'initiativePhases', protectedIds.epicPhases]
  ]) for (const id of ids) if (!same(before[side]?.[catalog]?.[id], after[side]?.[catalog]?.[id])) refuse(`${catalog}:${id}`);
  for (const id of protectedIds.integrationTargets) if (!same(before.story.integrations?.targets?.[id], after.story.integrations?.targets?.[id])) refuse(`integration target '${id}'`);
  const signature = (agent) => agent && ({ name: agent.displayName, label: agent.label, prompt: agent.prompt, tools: agent.tools,
    views: agent.worldModelViews, dependencies: agent.dependencies, skills: agent.librarySkills,
    defaults: agent.defaultFor?.filter((id) => protectedIds.phases.includes(id) || protectedIds.epicPhases.includes(id)), phases: agent.phases?.filter((id) => protectedIds.phases.includes(id) || protectedIds.epicPhases.includes(id)) });
  for (const id of protectedIds.agents) if (!same(signature(beforeAgents.find((agent) => agent.id === id)), signature(afterAgents.find((agent) => agent.id === id)))) refuse(`agent '${id}'`);
  const paths = new Set([...protectedIds.templateFiles, ...protectedIds.skills.map(librarySkillPath)]);
  for (const file of files) if (paths.has(file.path) && (file.before == null || file.after == null
    ? file.before !== file.after : !Buffer.from(file.before).equals(Buffer.from(file.after)))) refuse(`dependency '${file.path}'`);
}

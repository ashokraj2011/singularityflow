import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { add, branch, changedFiles, commit, identity, pushBranch } from './git.mjs';
import { loadDefinition, validateDefinition, worldModelPromptViewReferences, WORKFLOW_PATH } from './config.mjs';
import { documentCatalog } from './documents.mjs';
import { progressSnapshot } from './progress.mjs';
import { loadSession, setPersonaSession } from './session.mjs';
import { loadWorkflow } from './state.mjs';
import { exists, posix, readJson, repoRelative, run, SingularityFlowError, writeText } from './util.mjs';
import { AGENT_LOCK_PATH, agentStatus, discoverAgents } from './agents.mjs';
import { structuredWorldModelViewReferences, worldModelViewCatalog } from './world-model-views.mjs';
import { createReviewBundle, reviewMarkdown } from './review.mjs';
import { doctorSnapshot } from './doctor.mjs';
import { simulateWorkflow } from './workflow-catalog.mjs';
import { deriveReport } from './report.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPOSITORY_SKILLS_ROOT = '.github/skills';
const DEFAULT_WORLD_MODEL_PROMPT = '.singularity/prompts/worldmodel-builder.md';
const TEXT_FILE_LIMIT = 10 * 1024 * 1024;

async function textFiles(root, relativeRoot, { extensions = null } = {}) {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!(await exists(absoluteRoot))) return [];
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        if (extensions && !extensions.includes(path.extname(entry.name).toLowerCase())) continue;
        const content = await readFile(absolute);
        if (content.length > TEXT_FILE_LIMIT) continue;
        output.push({
          path: posix(path.relative(root, absolute)),
          name: posix(path.relative(absoluteRoot, absolute)),
          content: content.toString('utf8'),
          bytes: content.length
        });
      }
    }
  }
  await visit(absoluteRoot);
  return output.sort((left, right) => left.name.localeCompare(right.name));
}

async function worldModelPrompt(root, definition) {
  const configured = definition.worldModel?.promptSource ?? DEFAULT_WORLD_MODEL_PROMPT;
  const builtin = configured === 'builtin';
  const relative = builtin ? DEFAULT_WORLD_MODEL_PROMPT : posix(configured);
  const absolute = path.join(root, relative);
  if (!builtin && await exists(absolute)) return { path: relative, name: path.posix.basename(relative), content: await readFile(absolute, 'utf8'), missing: false, builtin };
  const fallback = path.join(packageRoot, 'templates/worldmodel-builder.md');
  return { path: relative, name: path.posix.basename(relative), content: await readFile(fallback, 'utf8'), missing: true, builtin };
}

async function workItems(root, definition) {
  const base = path.join(root, definition.workItemRoot ?? '.singularity/work-items');
  if (!(await exists(base))) return [];
  const results = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(base, entry.name, 'workflow.json');
    if (!(await exists(statePath))) continue;
    try {
      const state = await readJson(statePath);
      results.push({
        id: state.workItem?.id ?? entry.name,
        title: state.workItem?.title ?? entry.name,
        workType: state.workItem?.workType ?? 'legacy',
        status: state.status ?? 'unknown',
        currentPhase: state.currentPhase ?? null,
        branch: state.workItem?.branch ?? entry.name,
        updatedAt: state.history?.at(-1)?.at ?? state.workItem?.createdAt ?? null
      });
    } catch (error) {
      results.push({ id: entry.name, title: entry.name, status: 'invalid', error: error.message });
    }
  }
  return results.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
}

function configurationChangeScope(definition, changes) {
  const configurationChanges = changes.filter((file) => allowedConfigurationPath(definition, file));
  const unrelatedChanges = changes.filter((file) => !configurationChanges.includes(file));
  return {
    configurationChanges,
    unrelatedChanges,
    publishReady: configurationChanges.length > 0 && unrelatedChanges.length === 0
  };
}

export async function desktopSnapshot(root, requestedWorkId = null) {
  const definition = await loadDefinition(root);
  const items = await workItems(root, definition);
  const currentBranch = branch(root);
  const changes = changedFiles(root);
  const changeScope = configurationChangeScope(definition, changes);
  const selectedId = requestedWorkId ?? items.find((item) => item.branch === currentBranch)?.id ?? null;
  let workflow = null;
  let progress = null;
  let documents = [];
  let review = null;
  let report = null;
  if (selectedId) {
    workflow = await loadWorkflow(root, definition, selectedId);
    progress = progressSnapshot(workflow);
    report = deriveReport(workflow, { pricing: definition.tokens?.pricing ?? null });
    documents = await documentCatalog(root, definition, workflow);
    review = await createReviewBundle(root, definition, workflow);
    review.markdown = reviewMarkdown(review);
  }
  const agents = await discoverAgents(root);
  const lockExists = await exists(path.join(root, AGENT_LOCK_PATH));
  const modelRoot = posix(definition.worldModel?.outputDir ?? '.singularity/world-model');
  const builderPrompt = await worldModelPrompt(root, definition);
  const promptViewReferences = await worldModelPromptViewReferences(root, definition);
  const structuredViewReferences = structuredWorldModelViewReferences(definition);
  const viewCatalog = worldModelViewCatalog(definition, promptViewReferences.keys());
  return {
    schemaVersion: 1,
    repository: { root, branch: currentBranch, changes, ...changeScope },
    definition,
    definitionPath: WORKFLOW_PATH,
    definitionText: await readFile(path.join(root, WORKFLOW_PATH), 'utf8'),
    templates: await textFiles(root, definition.templatesRoot),
    personaPrompts: await textFiles(root, definition.personaPromptsRoot),
    repositorySkills: await textFiles(root, REPOSITORY_SKILLS_ROOT, { extensions: ['.md'] }),
    worldModelPrompt: builderPrompt,
    worldModel: {
      root: modelRoot,
      repositoryOwned: true,
      views: viewCatalog.map((id) => ({
        id,
        structuredReferences: structuredViewReferences.get(id) ?? [],
        promptReferences: promptViewReferences.get(id) ?? [],
        references: [
          ...(structuredViewReferences.get(id) ?? []),
          ...(promptViewReferences.get(id) ?? []).map((file) => `Markdown '${file}'`)
        ]
      })),
      files: await textFiles(root, modelRoot, { extensions: ['.md', '.json', '.jsonl', '.yml', '.yaml'] })
    },
    agents: agents.map((agent) => ({ id: agent.id, scope: agent.scope, path: agent.source, content: agent.text, sha256: agent.sha256, editable: agent.scope === 'repository' && !agent.source.startsWith('..'), remoteResources: agent.dependencies.length })),
    agentStatus: await agentStatus(root),
    agentsLock: { path: AGENT_LOCK_PATH, exists: lockExists, content: lockExists ? await readFile(path.join(root, AGENT_LOCK_PATH), 'utf8') : '# No remote agents are trusted yet.\n' },
    workItems: items,
    approvalInbox: { remote: definition.git?.remote ?? 'origin', fetched: false, generatedAt: null, count: 0, items: [] },
    selectedWorkId: selectedId,
    workflow,
    progress,
    report,
    documents,
    review,
    diagnostics: await doctorSnapshot(root, { workId: selectedId, offline: true }),
    workflowSimulations: await simulateWorkflow(root),
    session: await loadSession(root, { required: false })
  };
}

function allowedConfigurationPath(definition, relative) {
  const promptSource = definition.worldModel?.promptSource;
  return relative === WORKFLOW_PATH
    || relative.startsWith(`${posix(definition.templatesRoot).replace(/\/$/, '')}/`)
    || relative.startsWith(`${posix(definition.personaPromptsRoot).replace(/\/$/, '')}/`)
    || relative.startsWith(`${REPOSITORY_SKILLS_ROOT}/`)
    || relative === DEFAULT_WORLD_MODEL_PROMPT
    || (promptSource && promptSource !== 'builtin' && relative === posix(promptSource))
    || relative.startsWith('.github/agents/')
    || relative.startsWith('.claude/agents/');
}

function exportablePath(definition, relative) {
  const modelRoot = posix(definition.worldModel?.outputDir ?? '.singularity/world-model').replace(/\/$/, '');
  const workRoot = posix(definition.workItemRoot ?? '.singularity/work-items').replace(/\/$/, '');
  return allowedConfigurationPath(definition, relative)
    || relative === AGENT_LOCK_PATH
    || relative.startsWith(`${modelRoot}/`)
    || relative.startsWith(`${workRoot}/`);
}

export async function saveDesktopFile(root, requestedPath, content) {
  const definition = await loadDefinition(root);
  const relative = repoRelative(root, requestedPath);
  if (!allowedConfigurationPath(definition, relative)) throw new SingularityFlowError(`Desktop editing is restricted to ${WORKFLOW_PATH}, templates, persona prompts, repository skills, world-model builder prompts, and repository agent Markdown. Generated world-model files and agent locks are read-only.`);
  if (relative === WORKFLOW_PATH) {
    try { validateDefinition(YAML.parse(content)); }
    catch (error) { throw new SingularityFlowError(`Change was not saved because configuration validation failed: ${error.message}`); }
  }
  const absolute = path.join(root, relative);
  const existed = await exists(absolute);
  const previous = existed ? await readFile(absolute, 'utf8') : null;
  await writeText(absolute, content);
  try {
    await loadDefinition(root);
    await discoverAgents(root);
  } catch (error) {
    if (existed) await writeText(absolute, previous);
    else await unlink(absolute);
    throw new SingularityFlowError(`Change was not saved because configuration validation failed: ${error.message}`);
  }
  return { path: relative, changed: changedFiles(root).includes(relative) };
}

export async function deleteDesktopTemplate(root, requestedPath) {
  return deleteDesktopFile(root, requestedPath);
}

export async function deleteDesktopFile(root, requestedPath) {
  const definition = await loadDefinition(root);
  const relative = repoRelative(root, requestedPath);
  const templatesRoot = posix(definition.templatesRoot).replace(/\/$/, '');
  const promptsRoot = posix(definition.personaPromptsRoot).replace(/\/$/, '');
  const deletable = relative.startsWith(`${templatesRoot}/`)
    || relative.startsWith(`${promptsRoot}/`)
    || relative.startsWith(`${REPOSITORY_SKILLS_ROOT}/`)
    || relative.startsWith('.github/agents/')
    || relative.startsWith('.claude/agents/');
  if (!deletable) throw new SingularityFlowError('Desktop deletion is restricted to artifact templates, unreferenced persona prompts, repository skills, and repository agents.');
  const references = [];
  if (relative.startsWith(`${templatesRoot}/`)) {
    const template = relative.slice(templatesRoot.length + 1);
    for (const [phaseId, phase] of Object.entries(definition.phases)) if (phase.defaultTemplate === template) references.push(`phase ${phaseId}`);
    for (const [workTypeId, profile] of Object.entries(definition.workTypes)) {
      for (const [phaseId, value] of Object.entries(profile.templateOverrides ?? {})) if (value === template) references.push(`workflow ${workTypeId}/${phaseId}`);
    }
  }
  if (relative.startsWith(`${promptsRoot}/`)) {
    const prompt = relative.slice(promptsRoot.length + 1);
    for (const [personaId, persona] of Object.entries(definition.personas)) if (persona.prompt === prompt) references.push(`persona ${personaId}`);
  }
  if (references.length) throw new SingularityFlowError(`File '${relative}' is still referenced by ${references.join(', ')}. Select a replacement before deleting it.`);
  const absolute = path.join(root, relative);
  if (!(await exists(absolute))) throw new SingularityFlowError(`Configuration file does not exist: ${relative}`);
  await unlink(absolute);
  return { path: relative, deleted: true, changed: changedFiles(root).includes(relative) };
}

export async function readDesktopFile(root, requestedPath) {
  const definition = await loadDefinition(root);
  const relative = repoRelative(root, requestedPath);
  if (!exportablePath(definition, relative)) throw new SingularityFlowError(`File is not an exportable Singularity Flow configuration, world-model, or work-item file: ${relative}`);
  const absolute = path.join(root, relative);
  if (!(await exists(absolute))) throw new SingularityFlowError(`File does not exist: ${relative}`);
  const content = await readFile(absolute);
  if (content.length > TEXT_FILE_LIMIT) throw new SingularityFlowError(`File exceeds the ${TEXT_FILE_LIMIT}-byte desktop export limit: ${relative}`);
  return { path: relative, name: path.posix.basename(relative), content: content.toString('utf8'), contentBase64: content.toString('base64'), bytes: content.length };
}

export async function desktopExportBundle(root) {
  const definition = await loadDefinition(root);
  const agents = (await discoverAgents(root)).filter((agent) => agent.scope === 'repository' && !agent.source.startsWith('..'));
  const modelRoot = posix(definition.worldModel?.outputDir ?? '.singularity/world-model');
  const prompt = await worldModelPrompt(root, definition);
  const groups = [
    [{ path: WORKFLOW_PATH, content: await readFile(path.join(root, WORKFLOW_PATH), 'utf8') }],
    await textFiles(root, definition.templatesRoot),
    await textFiles(root, definition.personaPromptsRoot),
    await textFiles(root, REPOSITORY_SKILLS_ROOT, { extensions: ['.md'] }),
    agents.map((agent) => ({ path: agent.source, content: agent.text })),
    await exists(path.join(root, AGENT_LOCK_PATH)) ? [{ path: AGENT_LOCK_PATH, content: await readFile(path.join(root, AGENT_LOCK_PATH), 'utf8') }] : [],
    prompt.missing ? [] : [prompt],
    await textFiles(root, modelRoot, { extensions: ['.md', '.json', '.jsonl', '.yml', '.yaml'] })
  ];
  const files = [...new Map(groups.flat().map((file) => [file.path, { path: file.path, content: file.content }])).values()].sort((left, right) => left.path.localeCompare(right.path));
  return { files, repository: path.basename(root), exportedAt: new Date().toISOString(), worldModelRepositoryOwned: true };
}

export async function validateDesktopConfiguration(root) {
  const definition = await loadDefinition(root);
  const agents = await discoverAgents(root);
  return {
    valid: true,
    workTypes: Object.keys(definition.workTypes).length,
    personas: Object.keys(definition.personas).length,
    phases: Object.keys(definition.phases).length,
    agents: agents.length
  };
}

export async function publishDesktopConfiguration(root, message = 'Configure Singularity Flow desktop workflow') {
  const definition = await loadDefinition(root);
  const changed = changedFiles(root);
  const configurationChanges = changed.filter((file) => allowedConfigurationPath(definition, file));
  if (!configurationChanges.length) throw new SingularityFlowError('No workflow, template, persona, prompt, skill, or agent changes are ready to publish.');
  const unrelated = changed.filter((file) => !configurationChanges.includes(file));
  if (unrelated.length) throw new SingularityFlowError(`Publish is blocked by unrelated working-tree changes: ${unrelated.join(', ')}`);
  const staged = run('git', ['diff', '--name-only', '--cached'], { cwd: root }).stdout.trim().split('\n').filter(Boolean);
  if (staged.some((file) => !configurationChanges.includes(file))) throw new SingularityFlowError('Publish is blocked because unrelated files are already staged.');
  add(root, configurationChanges);
  const sha = commit(root, message.trim() || 'Configure Singularity Flow desktop workflow');
  if ((definition.git?.publish ?? 'required') === 'off') return { sha, pushed: false, files: configurationChanges };
  const remote = definition.git?.remote ?? 'origin';
  const result = pushBranch(root, remote, branch(root));
  if (result.status !== 0) throw new SingularityFlowError(`Commit ${sha.slice(0, 8)} was created but push failed: ${(result.stderr || result.stdout).trim()}`);
  return { sha, pushed: true, remote, files: configurationChanges };
}

export async function selectDesktopPersona(root, workId, persona) {
  const definition = await loadDefinition(root);
  if (workId) {
    const workflow = await loadWorkflow(root, definition, workId);
    if (branch(root) !== workflow.workItem.branch) throw new SingularityFlowError(`Current branch is ${branch(root)}; resume ${workflow.workItem.branch} before selecting a work-item persona.`);
  }
  return setPersonaSession(root, definition, identity(root), persona, workId || null);
}

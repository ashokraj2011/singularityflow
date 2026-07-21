import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { add, branch, changedFiles, commit, identity, pushBranch } from './git.mjs';
import { loadDefinition, validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { documentCatalog } from './documents.mjs';
import { progressSnapshot } from './progress.mjs';
import { loadSession, setPersonaSession } from './session.mjs';
import { loadWorkflow } from './state.mjs';
import { exists, posix, readJson, repoRelative, run, SingularityFlowError, writeText } from './util.mjs';

async function textFiles(root, relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!(await exists(absoluteRoot))) return [];
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push({
        path: posix(path.relative(root, absolute)),
        name: posix(path.relative(absoluteRoot, absolute)),
        content: await readFile(absolute, 'utf8')
      });
    }
  }
  await visit(absoluteRoot);
  return output.sort((left, right) => left.name.localeCompare(right.name));
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

export async function desktopSnapshot(root, requestedWorkId = null) {
  const definition = await loadDefinition(root);
  const items = await workItems(root, definition);
  const currentBranch = branch(root);
  const selectedId = requestedWorkId ?? items.find((item) => item.branch === currentBranch)?.id ?? null;
  let workflow = null;
  let progress = null;
  let documents = [];
  if (selectedId) {
    workflow = await loadWorkflow(root, definition, selectedId);
    progress = progressSnapshot(workflow);
    documents = await documentCatalog(root, definition, workflow);
  }
  return {
    schemaVersion: 1,
    repository: { root, branch: currentBranch, changes: changedFiles(root) },
    definition,
    definitionPath: WORKFLOW_PATH,
    definitionText: await readFile(path.join(root, WORKFLOW_PATH), 'utf8'),
    templates: await textFiles(root, definition.templatesRoot),
    personaPrompts: await textFiles(root, definition.personaPromptsRoot),
    workItems: items,
    selectedWorkId: selectedId,
    workflow,
    progress,
    documents,
    session: await loadSession(root, { required: false })
  };
}

function allowedConfigurationPath(definition, relative) {
  return relative === WORKFLOW_PATH
    || relative.startsWith(`${posix(definition.templatesRoot).replace(/\/$/, '')}/`)
    || relative.startsWith(`${posix(definition.personaPromptsRoot).replace(/\/$/, '')}/`);
}

export async function saveDesktopFile(root, requestedPath, content) {
  const definition = await loadDefinition(root);
  const relative = repoRelative(root, requestedPath);
  if (!allowedConfigurationPath(definition, relative)) throw new SingularityFlowError(`Desktop editing is restricted to ${WORKFLOW_PATH}, ${definition.templatesRoot}, and ${definition.personaPromptsRoot}.`);
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
  } catch (error) {
    if (existed) await writeText(absolute, previous);
    else await unlink(absolute);
    throw new SingularityFlowError(`Change was not saved because configuration validation failed: ${error.message}`);
  }
  return { path: relative, changed: changedFiles(root).includes(relative) };
}

export async function validateDesktopConfiguration(root) {
  const definition = await loadDefinition(root);
  return {
    valid: true,
    workTypes: Object.keys(definition.workTypes).length,
    personas: Object.keys(definition.personas).length,
    phases: Object.keys(definition.phases).length
  };
}

export async function publishDesktopConfiguration(root, message = 'Configure Singularity Flow desktop workflow') {
  const definition = await loadDefinition(root);
  const changed = changedFiles(root);
  const configurationChanges = changed.filter((file) => allowedConfigurationPath(definition, file));
  if (!configurationChanges.length) throw new SingularityFlowError('No workflow, template, or persona changes are ready to publish.');
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

import { readFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { add, branch, changedFiles, commit, identity, pushBranch } from './git.mjs';
import {
  DEFAULT_PLANNING_PROMPT,
  loadDefinition,
  normalizePlanning,
  validateDefinition,
  worldModelPromptViewReferences,
  WORKFLOW_PATH
} from './config.mjs';
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
import { copilotTelemetryStatus } from './telemetry.mjs';
import {
  loadPortfolio, PORTFOLIO_PATH, validatePortfolio,
  validatePortfolioWorldModelViews
} from './initiative-config.mjs';
import {
  initiativeDir, initiativeProgress, listInitiatives, loadInitiative
} from './initiative-state.mjs';
import { evaluateInitiativePhase } from './initiative-evidence.mjs';
import { interfaceContractStatus } from './initiative-contracts.mjs';
import { deriveInitiativeReport, initiativeNextActions } from './initiative-report.mjs';
import { initiativeBreakdownReview, loadInitiativeBreakdown } from './initiative-repositories.mjs';
import { planningTargetCatalog } from './planning.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPOSITORY_SKILLS_ROOT = '.github/skills';
const DEFAULT_WORLD_MODEL_PROMPT = 'singularity/prompts/worldmodel-builder.md';
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

async function planningPrompt(root, definition) {
  const configured = normalizePlanning(definition.planning ?? {});
  const relative = configured.promptSource;
  const absolute = path.join(root, relative);
  if (await exists(absolute)) {
    return { path: relative, name: path.posix.basename(relative), content: await readFile(absolute, 'utf8'), missing: false, builtin: false };
  }
  const fallback = path.join(packageRoot, 'templates/copilot-planning.md');
  return { path: relative, name: path.posix.basename(relative), content: await readFile(fallback, 'utf8'), missing: true, builtin: true };
}

async function workItems(root, definition) {
  const base = path.join(root, definition.workItemRoot ?? 'singularity/work-items');
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

function configurationChangeScope(root, definition, portfolio, changes) {
  const configurationChanges = changes.filter((file) => allowedConfigurationPath(definition, file, portfolio, root));
  const unrelatedChanges = changes.filter((file) => !configurationChanges.includes(file));
  return {
    configurationChanges,
    unrelatedChanges,
    publishReady: configurationChanges.length > 0 && unrelatedChanges.length === 0
  };
}

async function initiativeDesktopSnapshot(root, portfolio, initiativeId) {
  if (!portfolio || !initiativeId) return null;
  const { initiative } = await loadInitiative(root, initiativeId, portfolio);
  const phaseId = initiative.currentPhase ?? initiative.phaseOrder.at(-1);
  const phaseGate = phaseId ? await evaluateInitiativePhase(root, portfolio, initiative, phaseId) : null;
  const directory = initiativeDir(root, portfolio, initiativeId);
  const documents = [];
  for (const currentPhase of initiative.phaseOrder) {
    for (const output of Object.values(initiative.phases[currentPhase].outputs)) {
      const absolute = path.join(directory, output.path);
      const renderable = ['markdown', 'yaml', 'interface-contract'].includes(output.kind);
      documents.push({
        ...output,
        phase: currentPhase,
        repositoryPath: posix(path.relative(root, absolute)),
        content: renderable && await exists(absolute) ? await readFile(absolute, 'utf8') : null
      });
    }
  }
  return {
    state: initiative,
    progress: initiativeProgress(initiative),
    breakdown: await loadInitiativeBreakdown(root, portfolio, initiativeId),
    materialization: await initiativeBreakdownReview(root, initiativeId),
    report: await deriveInitiativeReport(root, initiativeId),
    phaseGate,
    contracts: await interfaceContractStatus(root, initiativeId),
    nextActions: await initiativeNextActions(root, initiativeId),
    documents
  };
}

export async function desktopSnapshot(root, requestedWorkId = null, requestedInitiativeId = null) {
  const definition = await loadDefinition(root);
  const portfolio = await loadPortfolio(root, { required: false });
  const items = await workItems(root, definition);
  const initiatives = portfolio ? await listInitiatives(root, portfolio) : [];
  const currentBranch = branch(root);
  const changes = changedFiles(root);
  const changeScope = configurationChangeScope(root, definition, portfolio, changes);
  const selectedId = requestedWorkId ?? items.find((item) => item.branch === currentBranch)?.id ?? null;
  const selectedInitiativeId = requestedInitiativeId ?? initiatives.find((item) => item.branch === currentBranch)?.id ?? null;
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
  const telemetry = await copilotTelemetryStatus(root);
  const lockExists = await exists(path.join(root, AGENT_LOCK_PATH));
  const modelRoot = posix(definition.worldModel?.outputDir ?? 'singularity/world-model');
  const builderPrompt = await worldModelPrompt(root, definition);
  const plannerPrompt = await planningPrompt(root, definition);
  const promptViewReferences = await worldModelPromptViewReferences(root, definition);
  const structuredViewReferences = structuredWorldModelViewReferences(definition);
  const viewCatalog = worldModelViewCatalog(definition, promptViewReferences.keys());
  const portfolioText = portfolio ? await readFile(path.join(root, PORTFOLIO_PATH), 'utf8') : null;
  return {
    schemaVersion: 1,
    repository: { root, branch: currentBranch, controlRoot: 'singularity', changes, ...changeScope },
    telemetry,
    definition,
    definitionPath: WORKFLOW_PATH,
    definitionText: await readFile(path.join(root, WORKFLOW_PATH), 'utf8'),
    portfolio,
    portfolioPath: PORTFOLIO_PATH,
    portfolioText,
    templates: await textFiles(root, definition.templatesRoot),
    personaPrompts: await textFiles(root, definition.personaPromptsRoot),
    repositorySkills: await textFiles(root, REPOSITORY_SKILLS_ROOT, { extensions: ['.md'] }),
    planning: {
      ...await planningTargetCatalog(root, { workId: selectedId, initiativeId: selectedInitiativeId }),
      config: normalizePlanning(definition.planning ?? {}),
      prompt: plannerPrompt
    },
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
    initiatives,
    selectedInitiativeId,
    initiative: await initiativeDesktopSnapshot(root, portfolio, selectedInitiativeId),
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

export async function bootstrapDesktopPortfolio(root, {
  approvalName = null,
  approvalEmail = null,
  repository = null,
  jira = {}
} = {}) {
  const target = path.join(root, PORTFOLIO_PATH);
  if (await exists(target)) throw new SingularityFlowError(`${PORTFOLIO_PATH} already exists. Edit it through Portfolio designer instead of replacing it.`);
  const definition = await loadDefinition(root);
  const starter = YAML.parse(await readFile(path.join(packageRoot, 'templates', 'portfolio.yml'), 'utf8'));
  const gitActor = identity(root);
  const email = String(approvalEmail ?? gitActor.email ?? '').trim().toLowerCase();
  const name = String(approvalName ?? gitActor.name ?? email).trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new SingularityFlowError('Portfolio setup requires an approval email. Configure Git user.email or enter an approver identity.');
  for (const authority of Object.values(starter.approvalAuthorities)) {
    authority.members = [{ name: name || email, email }];
  }
  if (repository?.id || repository?.url) {
    if (!repository.id || !repository.url) throw new SingularityFlowError('A participating repository requires both an ID and URL.');
    starter.repositories = {
      [repository.id]: {
        url: repository.url,
        defaultBranch: repository.defaultBranch || definition.defaultBaseBranch || 'main',
        required: repository.required !== false,
        metadata: repository.metadata ?? {}
      }
    };
  }
  if (jira.enabled) {
    let hostname;
    try {
      const parsed = new URL(jira.baseUrl);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
      hostname = parsed.hostname.toLowerCase();
    } catch {
      throw new SingularityFlowError('Jira setup requires an HTTPS URL without embedded credentials.');
    }
    const deployment = jira.deployment ?? 'cloud';
    const projectKey = String(jira.projectKey ?? '').trim().toUpperCase();
    starter.jira = {
      ...starter.jira,
      enabled: true,
      connection: jira.connection || 'corporate-jira',
      deployment,
      allowedHosts: [hostname],
      allowedProjects: projectKey ? [projectKey] : [],
      authentication: {
        permitted: deployment === 'data-center' ? ['pat'] : ['user-token', 'service-account'],
        tokenExpiryWarningDays: 14
      },
      write: jira.writeMode === 'approved',
      writeMode: jira.writeMode ?? 'off',
      projectKey
    };
  }
  const portfolio = validatePortfolio(starter);
  validatePortfolioWorldModelViews(portfolio, definition);
  await writeText(target, YAML.stringify(starter));
  return {
    path: PORTFOLIO_PATH,
    portfolio,
    approver: { name: name || email, email },
    repositoryConfigured: Object.keys(portfolio.repositories).length > 0,
    jiraConfigured: portfolio.jira.enabled,
    changed: changedFiles(root).includes(PORTFOLIO_PATH)
  };
}

function allowedConfigurationPath(definition, relative, portfolio = null, root = null) {
  const promptSource = definition.worldModel?.promptSource;
  const planningPromptSource = normalizePlanning(definition.planning ?? {}).promptSource;
  const removedLegacyControlFile = root && ['.singularity', '.sdlc'].some(
    (legacyRoot) => relative.startsWith(`${legacyRoot}/`) && !existsSync(path.join(root, legacyRoot))
  );
  return relative === WORKFLOW_PATH
    || relative === PORTFOLIO_PATH
    || relative.startsWith(`${posix(definition.templatesRoot).replace(/\/$/, '')}/`)
    || (portfolio && relative.startsWith(`${posix(portfolio.templatesRoot).replace(/\/$/, '')}/`))
    || relative.startsWith(`${posix(definition.personaPromptsRoot).replace(/\/$/, '')}/`)
    || relative.startsWith(`${REPOSITORY_SKILLS_ROOT}/`)
    || relative === DEFAULT_WORLD_MODEL_PROMPT
    || (promptSource && promptSource !== 'builtin' && relative === posix(promptSource))
    || relative === DEFAULT_PLANNING_PROMPT
    || relative === posix(planningPromptSource)
    || relative.startsWith('.github/agents/')
    || relative.startsWith('.claude/agents/')
    || removedLegacyControlFile;
}

function exportablePath(definition, relative, portfolio = null) {
  const modelRoot = posix(definition.worldModel?.outputDir ?? 'singularity/world-model').replace(/\/$/, '');
  const workRoot = posix(definition.workItemRoot ?? 'singularity/work-items').replace(/\/$/, '');
  const initiativeRoot = posix(portfolio?.initiativeRoot ?? 'singularity/initiatives').replace(/\/$/, '');
  return allowedConfigurationPath(definition, relative, portfolio)
    || relative === AGENT_LOCK_PATH
    || relative.startsWith(`${modelRoot}/`)
    || relative.startsWith(`${workRoot}/`)
    || (portfolio && relative.startsWith(`${initiativeRoot}/`));
}

export async function saveDesktopFile(root, requestedPath, content) {
  const definition = await loadDefinition(root);
  const portfolio = await loadPortfolio(root, { required: false });
  const relative = repoRelative(root, requestedPath);
  if (!allowedConfigurationPath(definition, relative, portfolio)) throw new SingularityFlowError(`Desktop editing is restricted to workflow and portfolio YAML, templates, persona prompts, repository skills, world-model builder prompts, and repository agent Markdown. Generated world-model files, initiative state, and agent locks are read-only.`);
  if (relative === WORKFLOW_PATH) {
    try { validateDefinition(YAML.parse(content)); }
    catch (error) { throw new SingularityFlowError(`Change was not saved because configuration validation failed: ${error.message}`); }
  }
  if (relative === PORTFOLIO_PATH) {
    try { validatePortfolio(YAML.parse(content)); }
    catch (error) { throw new SingularityFlowError(`Change was not saved because portfolio validation failed: ${error.message}`); }
  }
  const absolute = path.join(root, relative);
  const existed = await exists(absolute);
  const previous = existed ? await readFile(absolute, 'utf8') : null;
  await writeText(absolute, content);
  try {
    const updatedDefinition = await loadDefinition(root);
    const updatedPortfolio = await loadPortfolio(root, { required: false });
    if (updatedPortfolio) validatePortfolioWorldModelViews(updatedPortfolio, updatedDefinition);
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
  const portfolio = await loadPortfolio(root, { required: false });
  const relative = repoRelative(root, requestedPath);
  const templatesRoot = posix(definition.templatesRoot).replace(/\/$/, '');
  const initiativeTemplatesRoot = posix(portfolio?.templatesRoot ?? templatesRoot).replace(/\/$/, '');
  const promptsRoot = posix(definition.personaPromptsRoot).replace(/\/$/, '');
  const deletable = relative.startsWith(`${templatesRoot}/`)
    || relative.startsWith(`${initiativeTemplatesRoot}/`)
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
  if (portfolio && relative.startsWith(`${initiativeTemplatesRoot}/`)) {
    const initiativeTemplate = relative.slice(initiativeTemplatesRoot.length + 1);
    for (const [phaseId, phase] of Object.entries(portfolio.initiativePhases)) {
      for (const output of phase.outputs) if (output.template === initiativeTemplate) references.push(`initiative ${phaseId}/${output.id}`);
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
  const portfolio = await loadPortfolio(root, { required: false });
  const relative = repoRelative(root, requestedPath);
  if (!exportablePath(definition, relative, portfolio)) throw new SingularityFlowError(`File is not an exportable Singularity Flow configuration, world-model, work-item, or initiative file: ${relative}`);
  const absolute = path.join(root, relative);
  if (!(await exists(absolute))) throw new SingularityFlowError(`File does not exist: ${relative}`);
  const content = await readFile(absolute);
  if (content.length > TEXT_FILE_LIMIT) throw new SingularityFlowError(`File exceeds the ${TEXT_FILE_LIMIT}-byte desktop export limit: ${relative}`);
  return { path: relative, name: path.posix.basename(relative), content: content.toString('utf8'), contentBase64: content.toString('base64'), bytes: content.length };
}

export async function desktopExportBundle(root) {
  const definition = await loadDefinition(root);
  const portfolio = await loadPortfolio(root, { required: false });
  const agents = (await discoverAgents(root)).filter((agent) => agent.scope === 'repository' && !agent.source.startsWith('..'));
  const modelRoot = posix(definition.worldModel?.outputDir ?? 'singularity/world-model');
  const prompt = await worldModelPrompt(root, definition);
  const planner = await planningPrompt(root, definition);
  const groups = [
    [{ path: WORKFLOW_PATH, content: await readFile(path.join(root, WORKFLOW_PATH), 'utf8') }],
    portfolio ? [{ path: PORTFOLIO_PATH, content: await readFile(path.join(root, PORTFOLIO_PATH), 'utf8') }] : [],
    await textFiles(root, definition.templatesRoot),
    await textFiles(root, definition.personaPromptsRoot),
    await textFiles(root, REPOSITORY_SKILLS_ROOT, { extensions: ['.md'] }),
    agents.map((agent) => ({ path: agent.source, content: agent.text })),
    await exists(path.join(root, AGENT_LOCK_PATH)) ? [{ path: AGENT_LOCK_PATH, content: await readFile(path.join(root, AGENT_LOCK_PATH), 'utf8') }] : [],
    prompt.missing ? [] : [prompt],
    planner.missing ? [] : [planner],
    await textFiles(root, modelRoot, { extensions: ['.md', '.json', '.jsonl', '.yml', '.yaml'] })
  ];
  const files = [...new Map(groups.flat().map((file) => [file.path, { path: file.path, content: file.content }])).values()].sort((left, right) => left.path.localeCompare(right.path));
  return { files, repository: path.basename(root), exportedAt: new Date().toISOString(), worldModelRepositoryOwned: true };
}

export async function validateDesktopConfiguration(root) {
  const definition = await loadDefinition(root);
  const portfolio = await loadPortfolio(root, { required: false });
  if (portfolio) validatePortfolioWorldModelViews(portfolio, definition);
  const agents = await discoverAgents(root);
  return {
    valid: true,
    workTypes: Object.keys(definition.workTypes).length,
    personas: Object.keys(definition.personas).length,
    phases: Object.keys(definition.phases).length,
    agents: agents.length,
    initiativeProfiles: Object.keys(portfolio?.initiativeProfiles ?? {}).length,
    initiativePhases: Object.keys(portfolio?.initiativePhases ?? {}).length,
    repositories: Object.keys(portfolio?.repositories ?? {}).length
  };
}

export async function publishDesktopConfiguration(root, message = 'Configure Singularity Flow desktop workflow') {
  const definition = await loadDefinition(root);
  const portfolio = await loadPortfolio(root, { required: false });
  const changed = changedFiles(root);
  const configurationChanges = changed.filter((file) => allowedConfigurationPath(definition, file, portfolio, root));
  if (!configurationChanges.length) throw new SingularityFlowError('No workflow, portfolio, template, persona, prompt, skill, or agent changes are ready to publish.');
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

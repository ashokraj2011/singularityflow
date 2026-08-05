import { readFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  add, branch, changedFiles, commit, head, identity, localBranches, pushBranch, remoteBranches
} from './git.mjs';
import {
  DEFAULT_PLANNING_PROMPT,
  ensureRepositoryTemplates,
  ensureRepositoryWorldModelViews,
  loadDefinition,
  normalizePlanning,
  validateDefinition,
  worldModelPromptViewReferences,
  WORKFLOW_PATH
} from './config.mjs';
import { documentCatalog } from './documents.mjs';
import { CAPABILITIES_PATH, capabilityTree, loadCapabilities, validateCapabilities } from './capabilities.mjs';
import { worldModelRebuildReason } from './grounding.mjs';
import { progressSnapshot } from './progress.mjs';
import { loadSession, setAgentSession } from './session.mjs';
import {
  exists,
  posix,
  readJson,
  repoRelative,
  run,
  secureRepositoryPath,
  SingularityFlowError,
  writeText
} from './util.mjs';
import {
  AGENT_LOCK_PATH,
  AGENT_MAPPING_PATH,
  agentMappingStatus,
  agentStatus,
  discoverAgents,
  loadAgentMappings,
  validateAgentMappings
} from './agents.mjs';
import { structuredWorldModelViewReferences, worldModelViewCatalog } from './world-model-views.mjs';
import { createReviewBundle, reviewMarkdown } from './review.mjs';
import { doctorSnapshot } from './doctor.mjs';
import { simulateWorkflow } from './workflow-catalog.mjs';
import { deriveReport } from './report.mjs';
import { copilotTelemetryStatus } from './telemetry.mjs';
import {
  loadPortfolio, PORTFOLIO_PATH, validatePortfolio,
  validatePortfolioWorldModelViews,
  portfolioWorldModelViews
} from './initiative-config.mjs';
import {
  initiativeProgress, listInitiatives, secureInitiativePath
} from './state-stores.mjs';
import { loadInitiativeAggregate, loadStoryAggregate } from './state-stores.mjs';
import { evaluateInitiativePhase } from './initiative-evidence.mjs';
import { interfaceContractStatus } from './initiative-contracts.mjs';
import { deriveInitiativeReport, initiativeNextActions } from './initiative-report.mjs';
import { epicJourney, initiativePhaseWork } from './initiative-next.mjs';
import { availableInitiativeOutputs } from './state-stores.mjs';
import { initiativeOutputRequired } from './initiative-policy.mjs';
import { initiativeBreakdownReview, loadInitiativeBreakdown } from './initiative-repositories.mjs';
import { planningTargetCatalog } from './planning.mjs';
import { jiraSnapshotSource, listEpicSources } from './epic-sources.mjs';
import { epicDeliveryReadiness } from './epic-completion.mjs';
import { ledgerStatus } from './ledger.mjs';
import {
  buildRepositorySubjectIndex, buildRepositorySubjectIndexFromRefs, resolveContext
} from './repository-subject-index.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPOSITORY_SKILLS_ROOT = '.github/skills';
const DEFAULT_WORLD_MODEL_PROMPT = 'singularity/prompts/worldmodel-builder.md';
const PROMPTS_ROOT = 'singularity/prompts';
const TEXT_FILE_LIMIT = 10 * 1024 * 1024;

async function textFiles(root, relativeRoot, { extensions = null } = {}) {
  const boundary = await secureRepositoryPath(root, relativeRoot, {
    label: `Configuration content directory '${relativeRoot}'`,
    type: 'directory'
  });
  if (!boundary.exists) return [];
  const absoluteRoot = boundary.absolute;
  const canonicalRoot = boundary.root;
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new SingularityFlowError(`Configuration content cannot include a symbolic link: ${posix(path.relative(canonicalRoot, absolute))}`);
      }
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        if (extensions && !extensions.includes(path.extname(entry.name).toLowerCase())) continue;
        const content = await readFile(absolute);
        if (content.length > TEXT_FILE_LIMIT) continue;
        output.push({
          path: posix(path.relative(canonicalRoot, absolute)),
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

function skillFrontmatter(content, fallbackId) {
  const match = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { name: fallbackId, description: '', argumentHint: null };
  try {
    const metadata = YAML.parse(match[1]) ?? {};
    return {
      name: String(metadata.name ?? fallbackId),
      description: String(metadata.description ?? ''),
      argumentHint: metadata['argument-hint'] == null ? null : String(metadata['argument-hint'])
    };
  } catch {
    return { name: fallbackId, description: '', argumentHint: null };
  }
}

async function bundledFlowSkills() {
  const skillsRoot = path.join(packageRoot, 'plugin', 'skills');
  const entries = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('sflow-'));
  const output = await Promise.all(entries.map(async (entry) => {
    const skillPath = path.join(skillsRoot, entry.name, 'SKILL.md');
    const content = await readFile(skillPath, 'utf8');
    const metadata = skillFrontmatter(content, entry.name);
    return {
      id: metadata.name,
      name: metadata.name,
      description: metadata.description,
      argumentHint: metadata.argumentHint,
      command: `/${metadata.name}`,
      path: `plugin/skills/${entry.name}/SKILL.md`,
      packagePath: `plugin/skills/${entry.name}/SKILL.md`,
      repositoryPath: `${REPOSITORY_SKILLS_ROOT}/${metadata.name}/SKILL.md`,
      content,
      bytes: Buffer.byteLength(content),
      scope: 'flow',
      readOnly: true
    };
  }));
  return output.sort((left, right) => left.id.localeCompare(right.id));
}

async function worldModelPrompt(root, definition) {
  const configured = definition.worldModel?.promptSource ?? DEFAULT_WORLD_MODEL_PROMPT;
  const builtin = configured === 'builtin';
  const relative = builtin ? DEFAULT_WORLD_MODEL_PROMPT : posix(configured);
  const prompt = await secureRepositoryPath(root, relative, {
    label: 'World-model builder prompt',
    type: 'file'
  });
  if (!builtin && prompt.exists) return { path: relative, name: path.posix.basename(relative), content: await readFile(prompt.absolute, 'utf8'), missing: false, builtin };
  const fallback = path.join(packageRoot, 'templates/worldmodel-builder.md');
  return { path: relative, name: path.posix.basename(relative), content: await readFile(fallback, 'utf8'), missing: true, builtin };
}

async function planningPrompt(root, definition) {
  const configured = normalizePlanning(definition.planning ?? {});
  const relative = configured.promptSource;
  const prompt = await secureRepositoryPath(root, relative, {
    label: 'Copilot planning prompt',
    type: 'file'
  });
  if (prompt.exists) {
    return { path: relative, name: path.posix.basename(relative), content: await readFile(prompt.absolute, 'utf8'), missing: false, builtin: false };
  }
  const fallback = path.join(packageRoot, 'templates/copilot-planning.md');
  return { path: relative, name: path.posix.basename(relative), content: await readFile(fallback, 'utf8'), missing: true, builtin: true };
}

async function workItems(root, definition) {
  const base = path.join(root, definition.workItemRoot ?? 'singularity/work-items');
  const results = new Map();
  const summarize = (state, fallbackId, source) => ({
    id: state.workItem?.id ?? fallbackId,
    title: state.workItem?.title ?? fallbackId,
    workType: state.workItem?.workType ?? 'legacy',
    status: state.status ?? 'unknown',
    currentPhase: state.currentPhase ?? null,
    branch: state.lineage?.canonicalBranch ?? state.workItem?.branch ?? fallbackId,
    updatedAt: state.history?.at(-1)?.at ?? state.workItem?.createdAt ?? null,
    source
  });

  // Completed Stories normally live on sibling branches, not in the currently checked-out tree.
  // Enumerate the refs already present locally; a read-model refresh must never perform network I/O.
  const remote = definition.git?.remote ?? 'origin';
  const refs = [
    ...remoteBranches(root, remote).map((name) => ({ branch: name, ref: `${remote}/${name}` })),
    ...localBranches(root).map((name) => ({ branch: name, ref: name }))
  ];
  const refIndex = await buildRepositorySubjectIndexFromRefs(root, { definition, refs });
  for (const subject of refIndex.list('story')) {
    results.set(subject.id, summarize(
      subject.state,
      subject.id,
      subject.location.ref ?? subject.location.branch ?? 'git-ref'
    ));
  }

  // The working tree wins for the checked-out Story, including governed edits not yet committed.
  if (await exists(base)) {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const statePath = path.join(base, entry.name, 'workflow.json');
      if (!(await exists(statePath))) continue;
      try {
        const state = await readJson(statePath);
        const item = summarize(state, entry.name, 'working-tree');
        results.set(item.id, item);
      } catch (error) {
        results.set(entry.name, { id: entry.name, title: entry.name, status: 'invalid', error: error.message });
      }
    }
  }
  return [...results.values()].sort((left, right) =>
    String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
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

async function initiativeEditorSnapshot(root, portfolio, initiativeId) {
  if (!portfolio || !initiativeId) return null;
  const { initiative } = await loadInitiativeAggregate(root, initiativeId, portfolio);
  const phaseId = initiative.currentPhase ?? initiative.phaseOrder.at(-1);
  const phaseGate = phaseId ? await evaluateInitiativePhase(root, portfolio, initiative, phaseId) : null;
  const documents = [];
  for (const currentPhase of initiative.phaseOrder) {
    for (const output of Object.values(initiative.phases[currentPhase].outputs)) {
      const target = await secureInitiativePath(root, portfolio, initiativeId, output.path, {
        label: `Initiative document '${currentPhase}/${output.id}'`,
        type: 'file'
      });
      const extension = path.extname(output.path).toLowerCase();
      const renderable = ['markdown', 'yaml', 'json', 'text', 'interface-contract'].includes(output.kind)
        || ['.md', '.markdown', '.json', '.jsonl', '.yml', '.yaml', '.txt'].includes(extension);
      const content = renderable && target.exists ? await readFile(target.absolute, 'utf8') : null;
      documents.push({
        ...output,
        phase: currentPhase,
        repositoryPath: target.relative,
        content,
        bytes: content == null ? null : Buffer.byteLength(content)
      });
    }
  }
  const deliveryReport = initiative.delivery?.completion?.reportPath;
  if (deliveryReport) {
    const target = await secureRepositoryPath(root, deliveryReport, {
      label: `Epic '${initiativeId}' completion report`,
      type: 'file'
    });
    documents.push({
      id: 'spec-to-code-completion',
      label: 'Epic spec-to-code completion',
      kind: 'markdown',
      path: deliveryReport,
      repositoryPath: deliveryReport,
      phase: 'delivery',
      status: 'approved',
      generation: 1,
      sha256: initiative.delivery.completion.sha256,
      content: target.exists ? await readFile(target.absolute, 'utf8') : null
    });
  }
  // Reported for every profile, not just epic-planning. Nothing gates `epic sources add` by profile,
  // so an enterprise-delivery Epic can pin sources perfectly well — they were simply invisible to
  // every surface, which reads as "nothing is pinned" when the opposite is true. An Epic with no
  // sources directory yields an empty manifest rather than an error.
  let sources = { version: 1, initiativeId, sources: [] };
  try { sources = (await listEpicSources(root, initiativeId)).manifest; }
  catch { /* No manifest yet is the same as nothing pinned. */ }
  // The imported Jira Epic is a hashed, citable source that verifyEpicTraceability accepts, but it
  // is not in the uploaded manifest — so a surface counting only uploads reported "nothing pinned"
  // while the contract was telling Copilot to cite this exact id. Derived here, once, by the same
  // function the traceability check uses.
  const snapshotSource = jiraSnapshotSource(initiative);
  if (snapshotSource) {
    sources.jiraSnapshot = {
      sourceId: snapshotSource.sourceId,
      name: snapshotSource.name,
      sha256: snapshotSource.sha256,
      bytes: snapshotSource.bytes
    };
  }
  const nextActions = await initiativeNextActions(root, initiativeId);
  return {
    state: initiative,
    progress: initiativeProgress(initiative),
    breakdown: await loadInitiativeBreakdown(root, portfolio, initiativeId),
    materialization: await initiativeBreakdownReview(root, initiativeId),
    report: await deriveInitiativeReport(root, initiativeId),
    phaseGate,
    contracts: await interfaceContractStatus(root, initiativeId),
    nextActions,
    // Every profile gets a journey. Withholding it from the others is what left the delivery
    // workspace with no statement of where the work stood or what to do next.
    journey: epicJourney(initiative, nextActions),
    // The ordered account of what is left in this phase. nextActions answers "what is the single
    // next command", which told someone already standing in the workspace to open the workspace.
    phaseWork: initiativePhaseWork(initiative),
    // Every output every phase could produce, with what this Epic has chosen, keyed by phase.
    // Offering the choice only for the current phase meant the decision had to be made in the one
    // moment the phase was open — a phase you have not reached yet is exactly when knowing you do
    // not need a document is most useful, and an approved one is the only place it is too late.
    outputChoicesByPhase: Object.fromEntries(initiative.phaseOrder.map((id) => [id, {
      editable: initiative.phases[id]?.status !== 'approved',
      choices: availableInitiativeOutputs(portfolio, initiative, id).map((output) => ({
        id: output.id,
        label: output.label,
        kind: output.kind,
        required: output.required !== false,
        pinned: output.pinned === true,
        included: initiativeOutputRequired(initiative, id, output),
        authored: Boolean(initiative.phases?.[id]?.outputs?.[output.id]?.sha256)
      }))
    }])),
    sources,
    jiraDrift: initiative.jiraDrift ?? null,
    delivery: initiative.resolution.profile === 'epic-planning'
      ? await epicDeliveryReadiness(root, initiativeId)
      : null,
    documents
  };
}

async function fullRepositorySnapshot(root, requestedWorkId = null, requestedInitiativeId = null) {
  const definition = await loadDefinition(root);
  const portfolio = await loadPortfolio(root, { required: false });
  const items = await workItems(root, definition);
  const initiatives = portfolio ? await listInitiatives(root, portfolio) : [];
  const currentBranch = branch(root);
  const subjectIndex = await buildRepositorySubjectIndex(root, { definition, portfolio });
  const changes = changedFiles(root);
  const changeScope = configurationChangeScope(root, definition, portfolio, changes);
  const selectedStory = resolveContext(subjectIndex, {
    reference: requestedWorkId ?? currentBranch,
    kind: 'story',
    required: Boolean(requestedWorkId)
  });
  const selectedInitiative = resolveContext(subjectIndex, {
    reference: requestedInitiativeId ?? currentBranch,
    kind: 'initiative',
    required: Boolean(requestedInitiativeId)
  });
  const selectedId = selectedStory?.id ?? null;
  const selectedInitiativeId = selectedInitiative?.id ?? null;
  let workflow = null;
  let progress = null;
  let documents = [];
  let review = null;
  let report = null;
  if (selectedId) {
    workflow = await loadStoryAggregate(root, definition, selectedId);
    progress = progressSnapshot(workflow);
    report = deriveReport(workflow, { pricing: definition.tokens?.pricing ?? null });
    documents = await documentCatalog(root, definition, workflow);
    review = await createReviewBundle(root, definition, workflow);
    review.markdown = reviewMarkdown(review);
  }
  const agents = await discoverAgents(root);
  const mappingStatus = await agentMappingStatus(root);
  const telemetry = await copilotTelemetryStatus(root);
  let ledger;
  try {
    // Navigation is a local Git read. A remote ledger outage must not empty Lifecycle or make the
    // extension appear frozen; explicit refresh/reconcile commands own network verification.
    ledger = await ledgerStatus(root, workflow?.resolution?.ledger ?? definition.ledger ?? {}, { offline: true });
  } catch (error) {
    ledger = {
      enabled: Boolean(workflow?.resolution?.ledger?.enabled ?? definition.ledger?.enabled),
      available: false,
      error: error?.message ?? String(error)
    };
  }
  const agentLock = await secureRepositoryPath(root, AGENT_LOCK_PATH, {
    label: 'Remote agent lock file',
    type: 'file'
  });
  const lockExists = agentLock.exists;
  const agentMappings = await secureRepositoryPath(root, AGENT_MAPPING_PATH, {
    label: 'Copilot agent mapping file',
    type: 'file'
  });
  const modelRoot = posix(definition.worldModel?.outputDir ?? 'singularity/world-model');
  let worldModelManifest = null;
  try { worldModelManifest = await readJson(path.join(root, modelRoot, 'manifest.json')); } catch { /* A missing model is represented by rebuildReason below. */ }
  const builderPrompt = await worldModelPrompt(root, definition);
  const plannerPrompt = await planningPrompt(root, definition);
  let github = null;
  try {
    const status = run('gh', ['auth', 'status', '--json', 'hosts'], { cwd: root, allowFailure: true });
    if (status.status === 0) {
      const hosts = JSON.parse(status.stdout).hosts ?? {};
      const account = Object.values(hosts).flat().find((entry) => entry.active) ?? Object.values(hosts).flat()[0];
      github = account?.login ?? null;
    }
  } catch { /* Identity disclosure stays unavailable when gh is absent or signed out. */ }
  const promptViewReferences = await worldModelPromptViewReferences(root, definition);
  const structuredViewReferences = structuredWorldModelViewReferences(definition);
  const viewCatalog = worldModelViewCatalog(definition, promptViewReferences.keys());
  const portfolioText = portfolio ? await readFile(path.join(root, PORTFOLIO_PATH), 'utf8') : null;
  return {
    schemaVersion: 1,
    // HEAD is carried so a surface can tell that a planning context was built against a different
    // commit. Promotion refuses a stale pack, and without this the only way to discover that was to
    // have the promotion fail after the work was done.
    repository: { root, branch: currentBranch, head: head(root), controlRoot: 'singularity', changes, ...changeScope },
    identities: {
      git: identity(root),
      github,
      assurance: {
        git: 'configured-local',
        github: github ? 'gh-authenticated' : 'unavailable',
        jira: 'vscode-secret-storage'
      }
    },
    telemetry,
    ledger,
    definition,
    definitionPath: WORKFLOW_PATH,
    definitionText: await readFile(path.join(root, WORKFLOW_PATH), 'utf8'),
    portfolio,
    portfolioPath: PORTFOLIO_PATH,
    // What this organisation builds, as opposed to how its code is stored. Nested here because the
    // stored form is a flat map with parent pointers and every reader wants the hierarchy. Absent
    // until the lead repository describes itself, which is a normal state rather than a fault.
    capabilityMap: await (async () => {
      const definition = await loadCapabilities(root);
      if (!definition) return null;
      try {
        validateCapabilities(definition, portfolio);
        return { capabilities: capabilityTree(definition) };
      } catch (error) {
        return { error: error.message };
      }
    })(),
    capabilityMapPath: CAPABILITIES_PATH,
    portfolioText,
    templates: await textFiles(root, definition.templatesRoot),
    agentPrompts: await textFiles(root, definition.agentPromptsRoot),
    prompts: await textFiles(root, PROMPTS_ROOT, { extensions: ['.md'] }),
    repositorySkills: await textFiles(root, REPOSITORY_SKILLS_ROOT, { extensions: ['.md'] }),
    flowSkills: await bundledFlowSkills(),
    planning: {
      ...await planningTargetCatalog(root, { workId: selectedId, initiativeId: selectedInitiativeId }),
      config: normalizePlanning(definition.planning ?? {}),
      prompt: plannerPrompt
    },
    worldModelPrompt: builderPrompt,
    worldModel: {
      root: modelRoot,
      repositoryOwned: true,
      timing: 'story-intake',
      generatedAt: worldModelManifest?.generated_at ?? null,
      // Main and Epic branches stay quiet. Grounding is requested only after Story intake has
      // created and checked out the canonical Story branch that will own the generated model.
      rebuildReason: selectedStory?.branches.includes(currentBranch)
        ? await worldModelRebuildReason(root, definition)
        : null,
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
    agents: agents.map((agent) => ({
      id: agent.id,
      scope: agent.scope,
      path: agent.source,
      packagePath: agent.scope === 'repository' ? null : posix(path.relative(packageRoot, agent.file)),
      content: agent.text,
      sha256: agent.sha256,
      editable: agent.scope === 'repository' && !agent.source.startsWith('..'),
      remoteResources: agent.dependencies.length
    })),
    agentStatus: await agentStatus(root),
    agentMappings: {
      path: AGENT_MAPPING_PATH,
      exists: agentMappings.exists,
      content: agentMappings.exists
        ? await readFile(agentMappings.absolute, 'utf8')
        : await readFile(path.join(packageRoot, 'templates', 'agent-mappings.yml'), 'utf8'),
      rows: mappingStatus.rows
    },
    agentsLock: { path: AGENT_LOCK_PATH, exists: lockExists, content: lockExists ? await readFile(agentLock.absolute, 'utf8') : '# No remote agents are trusted yet.\n' },
    workItems: items,
    initiatives,
    selectedInitiativeId,
    initiative: await initiativeEditorSnapshot(root, portfolio, selectedInitiativeId),
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

const SNAPSHOT_SLICES = new Set([
  'repository',
  'lifecycle',
  'configuration',
  'capabilities',
  'integrations',
  'diagnostics'
]);

async function repositorySlice(root) {
  const definition = await loadDefinition(root);
  const portfolio = await loadPortfolio(root, { required: false });
  const currentBranch = branch(root);
  const changes = changedFiles(root);
  return {
    root,
    branch: currentBranch,
    head: head(root),
    controlRoot: 'singularity',
    changes,
    ...configurationChangeScope(root, definition, portfolio, changes),
    identities: { git: identity(root) }
  };
}

async function lifecycleSlice(root, requestedWorkId, requestedInitiativeId) {
  const definition = await loadDefinition(root);
  const portfolio = await loadPortfolio(root, { required: false });
  const currentBranch = branch(root);
  const subjectIndex = await buildRepositorySubjectIndex(root, { definition, portfolio });
  const selectedStory = resolveContext(subjectIndex, {
    reference: requestedWorkId ?? currentBranch,
    kind: 'story',
    required: Boolean(requestedWorkId)
  });
  const selectedInitiative = resolveContext(subjectIndex, {
    reference: requestedInitiativeId ?? currentBranch,
    kind: 'initiative',
    required: Boolean(requestedInitiativeId)
  });
  const selectedWorkId = selectedStory?.id ?? null;
  const selectedInitiativeId = selectedInitiative?.id ?? null;
  let workflow = null;
  let progress = null;
  let documents = [];
  let review = null;
  let report = null;
  if (selectedWorkId) {
    workflow = await loadStoryAggregate(root, definition, selectedWorkId);
    progress = progressSnapshot(workflow);
    report = deriveReport(workflow, { pricing: definition.tokens?.pricing ?? null });
    documents = await documentCatalog(root, definition, workflow);
    review = await createReviewBundle(root, definition, workflow);
    review.markdown = reviewMarkdown(review);
  }
  return {
    workItems: await workItems(root, definition),
    initiatives: portfolio ? await listInitiatives(root, portfolio) : [],
    selectedWorkId,
    selectedInitiativeId,
    workflow,
    progress,
    report,
    documents,
    review,
    initiative: await initiativeEditorSnapshot(root, portfolio, selectedInitiativeId),
    approvalInbox: {
      remote: definition.git?.remote ?? 'origin',
      fetched: false,
      generatedAt: null,
      count: 0,
      items: []
    },
    planning: await planningTargetCatalog(root, { workId: selectedWorkId, initiativeId: selectedInitiativeId }),
    session: await loadSession(root, { required: false })
  };
}

async function configurationSlice(root) {
  const errors = [];
  const workflowFile = await secureRepositoryPath(root, WORKFLOW_PATH, {
    label: 'Workflow configuration',
    type: 'file'
  });
  const definitionText = workflowFile.exists ? await readFile(workflowFile.absolute, 'utf8') : '';
  let definition = {};
  if (definitionText) {
    try { definition = YAML.parse(definitionText) ?? {}; }
    catch (error) { errors.push(`Workflow configuration cannot be parsed: ${error.message}`); }
  } else errors.push(`Missing ${WORKFLOW_PATH}.`);
  try { definition = await loadDefinition(root); }
  catch (error) { errors.push(error.message); }

  const portfolioFile = await secureRepositoryPath(root, PORTFOLIO_PATH, {
    label: 'Portfolio configuration',
    type: 'file'
  });
  const portfolioText = portfolioFile.exists ? await readFile(portfolioFile.absolute, 'utf8') : null;
  let portfolio = null;
  if (portfolioText) {
    try { portfolio = YAML.parse(portfolioText); }
    catch (error) { errors.push(`Portfolio configuration cannot be parsed: ${error.message}`); }
    try { portfolio = await loadPortfolio(root, { required: false }); }
    catch (error) { errors.push(error.message); }
  }
  const agentMappings = await secureRepositoryPath(root, AGENT_MAPPING_PATH, {
    label: 'Copilot agent mapping file',
    type: 'file'
  });
  const agentLock = await secureRepositoryPath(root, AGENT_LOCK_PATH, {
    label: 'Remote agent lock file',
    type: 'file'
  });
  const agents = await discoverAgents(root);
  const mappingStatus = await agentMappingStatus(root);
  const templatesRoot = typeof definition.templatesRoot === 'string'
    ? definition.templatesRoot
    : 'singularity/templates';
  const agentPromptsRoot = typeof definition.agentPromptsRoot === 'string'
    ? definition.agentPromptsRoot
    : typeof definition.personaPromptsRoot === 'string'
      ? definition.personaPromptsRoot
      : '.github/agents';
  return {
    configurationValid: errors.length === 0,
    configurationError: errors.length ? [...new Set(errors)].join(' ') : null,
    definition,
    definitionPath: WORKFLOW_PATH,
    definitionText,
    portfolio,
    portfolioPath: PORTFOLIO_PATH,
    portfolioText,
    templates: await textFiles(root, templatesRoot),
    agentPrompts: await textFiles(root, agentPromptsRoot, { extensions: ['.md'] }),
    prompts: await textFiles(root, PROMPTS_ROOT, { extensions: ['.md'] }),
    repositorySkills: await textFiles(root, REPOSITORY_SKILLS_ROOT, { extensions: ['.md'] }),
    flowSkills: await bundledFlowSkills(),
    agents: agents.map((agent) => ({
      id: agent.id,
      scope: agent.scope,
      path: agent.source,
      packagePath: agent.scope === 'repository' ? null : posix(path.relative(packageRoot, agent.file)),
      content: agent.text,
      sha256: agent.sha256,
      editable: agent.scope === 'repository' && !agent.source.startsWith('..'),
      remoteResources: agent.dependencies.length
    })),
    agentStatus: await agentStatus(root),
    agentMappings: {
      path: AGENT_MAPPING_PATH,
      exists: agentMappings.exists,
      content: agentMappings.exists
        ? await readFile(agentMappings.absolute, 'utf8')
        : await readFile(path.join(packageRoot, 'templates', 'agent-mappings.yml'), 'utf8'),
      rows: mappingStatus.rows
    },
    agentsLock: {
      path: AGENT_LOCK_PATH,
      exists: agentLock.exists,
      content: agentLock.exists
        ? await readFile(agentLock.absolute, 'utf8')
        : '# No remote agents are trusted yet.\n'
    }
  };
}

async function capabilitySlice(root) {
  const portfolio = await loadPortfolio(root, { required: false });
  const definition = await loadCapabilities(root);
  if (!definition) return { path: CAPABILITIES_PATH, capabilities: null };
  try {
    validateCapabilities(definition, portfolio);
    return { path: CAPABILITIES_PATH, capabilities: capabilityTree(definition) };
  } catch (error) {
    return { path: CAPABILITIES_PATH, capabilities: null, error: error.message };
  }
}

async function integrationSlice(root) {
  const definition = await loadDefinition(root);
  let ledger;
  try { ledger = await ledgerStatus(root, definition.ledger ?? {}); }
  catch (error) {
    ledger = {
      enabled: Boolean(definition.ledger?.enabled),
      available: false,
      error: error?.message ?? String(error)
    };
  }
  let github = null;
  try {
    const status = run('gh', ['auth', 'status', '--json', 'hosts'], { cwd: root, allowFailure: true });
    if (status.status === 0) {
      const hosts = JSON.parse(status.stdout).hosts ?? {};
      const account = Object.values(hosts).flat().find((entry) => entry.active) ?? Object.values(hosts).flat()[0];
      github = account?.login ?? null;
    }
  } catch { /* The integration remains unavailable when gh is absent or signed out. */ }
  return {
    telemetry: await copilotTelemetryStatus(root),
    ledger,
    github,
    notifications: definition.notifications ?? { channels: ['terminal'] }
  };
}

/**
 * Build either the compatibility snapshot consumed by the extension, or explicit schema-v2
 * slices for callers that request them. Scoped calls do not construct unrelated read models.
 */
export async function repositorySnapshot(root, requestedWorkId = null, requestedInitiativeId = null, { included = null } = {}) {
  if (!included?.length) return fullRepositorySnapshot(root, requestedWorkId, requestedInitiativeId);
  const requested = [...new Set(included)];
  const unknown = requested.filter((slice) => !SNAPSHOT_SLICES.has(slice));
  if (unknown.length) {
    throw new SingularityFlowError(`Unknown snapshot slice(s): ${unknown.join(', ')}. Choose from ${[...SNAPSHOT_SLICES].join(', ')}.`);
  }
  const result = {};
  for (const slice of requested) {
    if (slice === 'repository') result.repository = await repositorySlice(root);
    else if (slice === 'lifecycle') result.lifecycle = await lifecycleSlice(root, requestedWorkId, requestedInitiativeId);
    else if (slice === 'configuration') result.configuration = await configurationSlice(root);
    else if (slice === 'capabilities') result.capabilities = await capabilitySlice(root);
    else if (slice === 'integrations') result.integrations = await integrationSlice(root);
    else if (slice === 'diagnostics') result.diagnostics = await doctorSnapshot(root, { workId: requestedWorkId, offline: true });
  }
  return result;
}

export async function bootstrapWorkspacePortfolio(root, {
  approvalName = null,
  approvalEmail = null,
  repository = null,
  repositories = null,
  jira = {},
  replaceEmptyStarter = false
} = {}) {
  const target = path.join(root, PORTFOLIO_PATH);
  // Repositories initialized before Agent Markdown owned world-model views can temporarily have
  // no worldModel block. Repair the repository-level agent and phase requirements before using
  // the strict loader; portfolio-specific views are merged below once the profile is known.
  await ensureRepositoryWorldModelViews(root);
  const definition = await loadDefinition(root);
  const targetExists = await exists(target);
  let repairedEmptyStarter = false;
  let starter;
  if (targetExists) {
    if (!replaceEmptyStarter) {
      throw new SingularityFlowError(`${PORTFOLIO_PATH} already exists. Edit it through Portfolio designer instead of replacing it.`);
    }
    starter = YAML.parse(await readFile(target, 'utf8'));
    const authorities = Object.values(starter.approvalAuthorities ?? {});
    repairedEmptyStarter = authorities.some((authority) => !(authority?.members ?? []).length);
  } else {
    starter = YAML.parse(await readFile(path.join(packageRoot, 'templates', 'portfolio.yml'), 'utf8'));
  }
  const gitActor = identity(root);
  const email = String(approvalEmail ?? gitActor.email ?? '').trim().toLowerCase();
  const name = String(approvalName ?? gitActor.name ?? email).trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new SingularityFlowError('Portfolio setup requires an approval email. Configure Git user.email or enter an approver identity.');
  for (const authority of Object.values(starter.approvalAuthorities)) {
    // Workspace bootstrap is deliberately idempotent. Existing authority membership is
    // governance data, so preserve it and fill only groups left blank by the starter.
    if (!(authority.members ?? []).length) authority.members = [{ name: name || email, email }];
  }
  if (repositories) {
    if (typeof repositories !== 'object' || Array.isArray(repositories) || !Object.keys(repositories).length) {
      throw new SingularityFlowError('Workspace portfolio setup requires at least one repository.');
    }
    starter.repositories = structuredClone(repositories);
  } else if (repository?.id || repository?.url) {
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
    const allowedProjects = [...new Set([
      ...(Array.isArray(jira.allowedProjects) ? jira.allowedProjects : []),
      projectKey
    ].map((value) => String(value ?? '').trim().toUpperCase()).filter(Boolean))];
    starter.jira = {
      ...starter.jira,
      enabled: true,
      connection: jira.connection || 'corporate-jira',
      deployment,
      allowedHosts: [hostname],
      allowedProjects,
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
  // Self-heal: install any packaged templates the portfolio's phases reference (the initiatives/
  // subtree is absent from repositories initialized before it shipped), then declare the
  // world-model views the portfolio needs so validation cannot fail on a fresh onboarding.
  await ensureRepositoryTemplates(root, definition, { templatesRoot: portfolio.templatesRoot });
  const declaredViews = await ensureRepositoryWorldModelViews(root, portfolioWorldModelViews(portfolio));
  const validatedDefinition = declaredViews ? await loadDefinition(root) : definition;
  validatePortfolioWorldModelViews(portfolio, validatedDefinition);
  await writeText(target, YAML.stringify(starter));
  return {
    path: PORTFOLIO_PATH,
    portfolio,
    approver: { name: name || email, email },
    repositoryConfigured: Object.keys(portfolio.repositories).length > 0,
    jiraConfigured: portfolio.jira.enabled,
    repairedEmptyStarter,
    updatedExisting: targetExists,
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
    || relative === CAPABILITIES_PATH
    || relative === AGENT_MAPPING_PATH
    || relative.startsWith(`${posix(definition.templatesRoot).replace(/\/$/, '')}/`)
    || (portfolio && relative.startsWith(`${posix(portfolio.templatesRoot).replace(/\/$/, '')}/`))
    || relative.startsWith(`${posix(definition.agentPromptsRoot).replace(/\/$/, '')}/`)
    || relative.startsWith(`${REPOSITORY_SKILLS_ROOT}/`)
    || relative.startsWith(`${PROMPTS_ROOT}/`)
    || relative === DEFAULT_WORLD_MODEL_PROMPT
    || (promptSource && promptSource !== 'builtin' && relative === posix(promptSource))
    || relative === DEFAULT_PLANNING_PROMPT
    || relative === posix(planningPromptSource)
    || relative.startsWith('.github/agents/')
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

export async function saveConfigurationFile(root, requestedPath, content) {
  const definition = await loadDefinition(root);
  const portfolio = await loadPortfolio(root, { required: false });
  const relative = repoRelative(root, requestedPath);
  if (!allowedConfigurationPath(definition, relative, portfolio)) throw new SingularityFlowError(`Editor editing is restricted to workflow and portfolio YAML, templates, governed-agent prompts, repository skills, world-model builder prompts, and repository agent Markdown. Generated world-model files, initiative state, and agent locks are read-only.`);
  if (relative === WORKFLOW_PATH) {
    try { validateDefinition(YAML.parse(content)); }
    catch (error) { throw new SingularityFlowError(`Change was not saved because configuration validation failed: ${error.message}`); }
  }
  if (relative === PORTFOLIO_PATH) {
    try { validatePortfolio(YAML.parse(content)); }
    catch (error) { throw new SingularityFlowError(`Change was not saved because portfolio validation failed: ${error.message}`); }
  }
  if (relative === CAPABILITIES_PATH) {
    // Validated here rather than only on the next read. A capability map that names an unknown
    // repository, has two roots, or declares a parent cycle is refused at the point of saving, so
    // the editor that produced it is the thing that reports it.
    try { validateCapabilities(YAML.parse(content), portfolio); }
    catch (error) { throw new SingularityFlowError(`Change was not saved because capability map validation failed: ${error.message}`); }
  }
  if (relative === AGENT_MAPPING_PATH) {
    try {
      const agents = await discoverAgents(root);
      validateAgentMappings(YAML.parse(content), { agentIds: agents.map((agent) => agent.id) });
    } catch (error) { throw new SingularityFlowError(`Change was not saved because agent mapping validation failed: ${error.message}`); }
  }
  const target = await secureRepositoryPath(root, relative, {
    label: 'Editor configuration target',
    type: 'file'
  });
  const existed = target.exists;
  const previous = existed ? await readFile(target.absolute, 'utf8') : null;
  await writeText(target.absolute, content);
  try {
    const updatedDefinition = await loadDefinition(root);
    const updatedPortfolio = await loadPortfolio(root, { required: false });
    if (updatedPortfolio) validatePortfolioWorldModelViews(updatedPortfolio, updatedDefinition);
    await discoverAgents(root);
    await loadAgentMappings(root);
  } catch (error) {
    if (existed) await writeText(target.absolute, previous);
    else await unlink(target.absolute);
    throw new SingularityFlowError(`Change was not saved because configuration validation failed: ${error.message}`);
  }
  return { path: relative, changed: changedFiles(root).includes(relative) };
}

export async function deleteConfigurationTemplate(root, requestedPath) {
  return deleteConfigurationFile(root, requestedPath);
}

export async function deleteConfigurationFile(root, requestedPath) {
  const definition = await loadDefinition(root);
  const portfolio = await loadPortfolio(root, { required: false });
  const relative = repoRelative(root, requestedPath);
  const templatesRoot = posix(definition.templatesRoot).replace(/\/$/, '');
  const initiativeTemplatesRoot = posix(portfolio?.templatesRoot ?? templatesRoot).replace(/\/$/, '');
  const promptsRoot = posix(definition.agentPromptsRoot).replace(/\/$/, '');
  const deletable = relative.startsWith(`${templatesRoot}/`)
    || relative.startsWith(`${initiativeTemplatesRoot}/`)
    || relative.startsWith(`${promptsRoot}/`)
    || relative.startsWith(`${REPOSITORY_SKILLS_ROOT}/`)
    || relative.startsWith(`${PROMPTS_ROOT}/`)
    || relative.startsWith('.github/agents/');
  if (!deletable) throw new SingularityFlowError('Editor deletion is restricted to artifact templates, unreferenced governed-agent prompts, repository skills, and repository agents.');
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
    for (const [agentId, agent] of Object.entries(definition.agents)) if (agent.source === relative) references.push(`agent ${agentId}`);
  }
  if (relative.startsWith('.github/agents/')) {
    const agents = await discoverAgents(root);
    const deletedAgent = agents.find((agent) => agent.scope === 'repository' && agent.source === relative);
    if (deletedAgent) {
      const mapping = await loadAgentMappings(root, { agents });
      for (const [copilotAgent, mappedAgent] of Object.entries(mapping.mappings)) {
        if (mappedAgent === deletedAgent.id) references.push(`Copilot agent mapping ${copilotAgent}`);
      }
    }
  }
  if (references.length) throw new SingularityFlowError(`File '${relative}' is still referenced by ${references.join(', ')}. Select a replacement before deleting it.`);
  const target = await secureRepositoryPath(root, relative, {
    label: 'Editor configuration file',
    mustExist: true,
    type: 'file'
  });
  await unlink(target.absolute);
  return { path: relative, deleted: true, changed: changedFiles(root).includes(relative) };
}

export async function readConfigurationFile(root, requestedPath) {
  const definition = await loadDefinition(root);
  const portfolio = await loadPortfolio(root, { required: false });
  const relative = repoRelative(root, requestedPath);
  if (!exportablePath(definition, relative, portfolio)) throw new SingularityFlowError(`File is not an exportable Singularity Flow configuration, world-model, work-item, or initiative file: ${relative}`);
  const target = await secureRepositoryPath(root, relative, {
    label: 'Editor export file',
    mustExist: true,
    type: 'file'
  });
  const content = await readFile(target.absolute);
  if (content.length > TEXT_FILE_LIMIT) throw new SingularityFlowError(`File exceeds the ${TEXT_FILE_LIMIT}-byte editor export limit: ${relative}`);
  return { path: relative, name: path.posix.basename(relative), content: content.toString('utf8'), contentBase64: content.toString('base64'), bytes: content.length };
}

export async function exportConfigurationBundle(root) {
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
    await textFiles(root, definition.agentPromptsRoot),
    await textFiles(root, PROMPTS_ROOT, { extensions: ['.md'] }),
    await textFiles(root, REPOSITORY_SKILLS_ROOT, { extensions: ['.md'] }),
    agents.map((agent) => ({ path: agent.source, content: agent.text })),
    await exists(path.join(root, AGENT_MAPPING_PATH)) ? [{ path: AGENT_MAPPING_PATH, content: await readFile(path.join(root, AGENT_MAPPING_PATH), 'utf8') }] : [],
    await exists(path.join(root, AGENT_LOCK_PATH)) ? [{ path: AGENT_LOCK_PATH, content: await readFile(path.join(root, AGENT_LOCK_PATH), 'utf8') }] : [],
    prompt.missing ? [] : [prompt],
    planner.missing ? [] : [planner],
    await textFiles(root, modelRoot, { extensions: ['.md', '.json', '.jsonl', '.yml', '.yaml'] })
  ];
  const files = [...new Map(groups.flat().map((file) => [file.path, { path: file.path, content: file.content }])).values()].sort((left, right) => left.path.localeCompare(right.path));
  return { files, repository: path.basename(root), exportedAt: new Date().toISOString(), worldModelRepositoryOwned: true };
}

export async function validateEditorConfiguration(root) {
  const definition = await loadDefinition(root);
  const portfolio = await loadPortfolio(root, { required: false });
  if (portfolio) validatePortfolioWorldModelViews(portfolio, definition);
  const agents = await discoverAgents(root);
  await loadAgentMappings(root, { agents });
  return {
    valid: true,
    workTypes: Object.keys(definition.workTypes).length,
    agents: Object.keys(definition.agents).length,
    phases: Object.keys(definition.phases).length,
    agents: agents.length,
    initiativeProfiles: Object.keys(portfolio?.initiativeProfiles ?? {}).length,
    initiativePhases: Object.keys(portfolio?.initiativePhases ?? {}).length,
    repositories: Object.keys(portfolio?.repositories ?? {}).length
  };
}

export async function publishEditorConfiguration(root, message = 'Configure Singularity Flow workflow') {
  const definition = await loadDefinition(root);
  const portfolio = await loadPortfolio(root, { required: false });
  const changed = changedFiles(root);
  const configurationChanges = changed.filter((file) => allowedConfigurationPath(definition, file, portfolio, root));
  if (!configurationChanges.length) throw new SingularityFlowError('No workflow, portfolio, template, agent, prompt, skill, or agent changes are ready to publish.');
  const unrelated = changed.filter((file) => !configurationChanges.includes(file));
  if (unrelated.length) throw new SingularityFlowError(`Publish is blocked by unrelated working-tree changes: ${unrelated.join(', ')}`);
  const staged = run('git', ['diff', '--name-only', '--cached'], { cwd: root }).stdout.trim().split('\n').filter(Boolean);
  if (staged.some((file) => !configurationChanges.includes(file))) throw new SingularityFlowError('Publish is blocked because unrelated files are already staged.');
  add(root, configurationChanges);
  // Bounded by the same set the guards above checked, so the commit cannot exceed what was approved
  // even if those guards are ever loosened.
  const sha = commit(root, message.trim() || 'Configure Singularity Flow workflow', configurationChanges);
  if ((definition.git?.publish ?? 'required') === 'off') return { sha, pushed: false, files: configurationChanges };
  const remote = definition.git?.remote ?? 'origin';
  const result = pushBranch(root, remote, branch(root));
  if (result.status !== 0) throw new SingularityFlowError(`Commit ${sha.slice(0, 8)} was created but push failed: ${(result.stderr || result.stdout).trim()}`);
  return { sha, pushed: true, remote, files: configurationChanges };
}

export async function selectEditorAgent(root, workId, agent) {
  const definition = await loadDefinition(root);
  if (workId) {
    const workflow = await loadStoryAggregate(root, definition, workId);
    if (branch(root) !== workflow.workItem.branch) throw new SingularityFlowError(`Current branch is ${branch(root)}; resume ${workflow.workItem.branch} before overriding its phase agent.`);
  }
  return setAgentSession(root, definition, identity(root), agent, workId || null);
}

import { cp, mkdir, mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  add, assertNotDefaultBranch, branch, changedFiles, commit, GITHUB_LOOKUP, head, identity, localBranches,
  pushBranch, remoteBranches
} from './git.mjs';
import {
  DEFAULT_PLANNING_PROMPT,
  ensureRepositoryTemplates,
  ensureRepositoryWorldModelViews,
  loadDefinition,
  normalizePlanning,
  resolveWorkType,
  validateDefinition,
  withDefinitionCache,
  worldModelPromptViewReferences,
  WORKFLOW_PATH
} from './config.mjs';
import { MODEL_TASKS } from './model-tasks.mjs';
import { templateReferences } from './template-catalog.mjs';
import { loadModelTiers, MODEL_TIERS_PATH, tierLadder } from './model-tiers.mjs';
import { documentCatalog, evidenceIsActive } from './documents.mjs';
import {
  CAPABILITIES_PATH, capabilityMapMode, capabilityTree, IMPLICIT_CAPABILITY_ID,
  loadCapabilities, validateCapabilities
} from './capabilities.mjs';
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
import { readConfigurationSource } from './configuration-branch.mjs';
import { configuredRemoteIdentity } from './git-remote-diagnostics.mjs';
import {
  structuredWorldModelViewReferences, worldModelViewCatalog, worldModelWorkflowViewUsage
} from './world-model-views.mjs';
import { worldModelStateAuthority } from './world-model/authority-config.mjs';
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
  resolveWorldModelSource, validateWorldModelDirectory, worldModelSourceSnapshot
} from './grounding.mjs';
import {
  buildRepositorySubjectIndex, buildRepositorySubjectIndexFromRefs, resolveContext
} from './repository-subject-index.mjs';
import {
  FAST_PATH_VERBS, fastPathProfile, nextVerb, planFastPath, verbForPhase
} from './fast-path.mjs';
import { mcpStatus } from './mcp.mjs';
import { mcpDoctor } from './mcp-readiness.mjs';
import { approvedDesignSourceBinding, verifyDesignSourceLifecycle } from './design-sources.mjs';
import { readDesignInventory } from './design-inventory.mjs';
import { evaluateVisualCoverage } from './visual-coverage.mjs';
import { listVisualComparisons } from './visual-compare.mjs';
import { verifyMcpEvidence } from './mcp-evidence.mjs';
import { IMPACT_CONFIG_PATH, loadImpactDefinition, normalizeImpactDefinition } from './impact-config.mjs';
import { modelFreedomSnapshot } from './model-freedom.mjs';
import { operationContext } from './operation-context.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { withApprovedConfigurationRead } from './approved-configuration-reader.mjs';
import { loadSgosCommandCenter } from './sgos/command-center.mjs';

export const REPOSITORY_SKILLS_ROOT = '.github/skills';
const DEFAULT_WORLD_MODEL_PROMPT = 'singularity/prompts/worldmodel-builder.md';
const PROMPTS_ROOT = 'singularity/prompts';
const TEXT_FILE_LIMIT = 10 * 1024 * 1024;

async function mcpConfigurationStatus(root, definition) {
  const [status, readiness] = await Promise.all([
    mcpStatus(root, definition),
    mcpDoctor(root, definition)
  ]);
  const readinessById = new Map(readiness.servers.map((server) => [server.id, server]));
  return {
    ...status,
    overallReadiness: readiness.overallReadiness,
    networkChecked: false,
    servers: status.servers.map((server) => ({
      ...server,
      readiness: readinessById.get(server.id)?.readiness ?? 'needs-host-setup',
      readinessReasons: readinessById.get(server.id)?.reasons ?? []
    }))
  };
}

/**
 * One local, read-only Visual Assurance projection for every editor surface.
 *
 * The projection deliberately does not warm an MCP server or perform a network doctor. Opening a
 * dashboard must never contact a design system. It joins the governed files already committed to
 * the Story and preserves the engine's own errors and warnings instead of translating them into a
 * second policy vocabulary in VS Code.
 */
async function visualAssuranceSnapshot(root, definition, workflow) {
  if (!workflow) return null;
  const itemDirectoryRelative = posix(path.join(
    workflow.resolution?.workItemRoot ?? definition.workItemRoot ?? 'singularity/work-items',
    workflow.workItem.id
  ));
  const itemDirectory = path.join(root, itemDirectoryRelative);
  const errors = [], warnings = [], passes = [];

  let evidence = { errors: [], warnings: [], passes: [], records: [] };
  try { evidence = await verifyMcpEvidence(root, workflow, { itemDirectory }); }
  catch (error) { errors.push(`MCP evidence could not be read: ${error.message}`); }
  errors.push(...evidence.errors); warnings.push(...evidence.warnings); passes.push(...evidence.passes);

  let designSources = { errors: [], warnings: [], passes: [], candidates: [], stale: [] };
  try { designSources = await verifyDesignSourceLifecycle(root, workflow, { itemDirectory }); }
  catch (error) { errors.push(`Design-source lifecycle could not be read: ${error.message}`); }
  errors.push(...designSources.errors); warnings.push(...designSources.warnings); passes.push(...designSources.passes);

  const approvedSet = approvedDesignSourceBinding(workflow);
  let inventory = null;
  if (approvedSet) {
    try { inventory = await readDesignInventory(root, workflow, approvedSet, { itemDirectory }); }
    catch (error) { errors.push(`Design inventory could not be read: ${error.message}`); }
  }

  let coverage = null;
  try { coverage = await evaluateVisualCoverage(root, workflow, { itemDirectory }); }
  catch (error) { errors.push(`Visual coverage could not be evaluated: ${error.message}`); }
  if (coverage) {
    errors.push(...coverage.errors); warnings.push(...coverage.warnings);
    if (coverage.status === 'pass') passes.push(`visual coverage: ${coverage.covered.length}/${coverage.profiles.length} profile(s)`);
  }

  let comparisons = [];
  try { comparisons = await listVisualComparisons(root, workflow, { itemDirectory }); }
  catch (error) { errors.push(`Visual comparisons could not be read: ${error.message}`); }
  for (const comparison of comparisons) {
    const message = `visual comparison ${comparison.id}: ${comparison.status}`;
    if (comparison.status === 'fail') errors.push(message);
    else if (comparison.status === 'warn') warnings.push(message);
    else passes.push(message);
  }

  const configured = Boolean(
    workflow.resolution?.designSources
    || workflow.resolution?.verification?.profiles?.length
    || (workflow.resolution?.verification?.comparison?.mode
      && workflow.resolution.verification.comparison.mode !== 'off')
    || evidence.records.length
  );
  return {
    schemaVersion: 1,
    configured,
    workId: workflow.workItem.id,
    phase: workflow.currentPhase,
    itemDirectory: itemDirectoryRelative,
    policy: {
      designSources: workflow.resolution?.designSources ?? null,
      verification: workflow.resolution?.verification ?? null
    },
    designSources: {
      approvedSet,
      candidates: designSources.candidates ?? [],
      stale: designSources.stale ?? [],
      errors: designSources.errors ?? [],
      warnings: designSources.warnings ?? [],
      passes: designSources.passes ?? []
    },
    inventory,
    evidence: {
      records: evidence.records,
      errors: evidence.errors,
      warnings: evidence.warnings,
      passes: evidence.passes
    },
    coverage,
    comparisons,
    readiness: {
      status: !configured ? 'not-configured' : errors.length ? 'blocked' : warnings.length ? 'attention' : 'ready',
      errors: [...new Set(errors)],
      warnings: [...new Set(warnings)],
      passes: [...new Set(passes)]
    }
  };
}

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

async function editorWorldModelStatus(root, definition, modelRoot) {
  try {
    const state = worldModelStateAuthority(definition);
    const source = await worldModelSourceSnapshot(root, definition);
    const located = await resolveWorldModelSource(root, {
      outputDir: modelRoot,
      stateBranch: state.branch,
      ledger: definition.ledger,
      remote: state.remote,
      definition
    }, { refreshRemote: false, sourceTreeSha256: source.sha256 });
    const manifestPath = path.join(located.directory, 'manifest.json');
    if (!existsSync(manifestPath)) return {
      manifest: null,
      located,
      readiness: {
        status: 'missing', ready: false, source: null, historical: false,
        command: 'singularity-flow wm ensure --depth standard'
      },
      reason: 'No governed repository world model has been built.'
    };
    const validated = await validateWorldModelDirectory(located.directory, {
      integrity: 'full',
      sourceLabel: located.source === 'state-branch'
        ? 'governed state-branch world model'
        : 'working-tree world model'
    });
    const manifest = validated.normalizedManifest;
    const exact = manifest.source_tree_sha256 === source.sha256;
    return {
      manifest,
      located,
      readiness: {
        status: exact ? 'ready' : 'stale',
        ready: exact,
        source: located.source,
        historical: located.historical === true,
        command: exact ? null : 'singularity-flow wm ensure --depth standard'
      },
      reason: exact
        ? null
        : 'A governed world model exists for another source snapshot. It was preserved; refresh is explicit.'
    };
  } catch (error) {
    return {
      manifest: null,
      located: null,
      readiness: {
        status: 'invalid', ready: false, source: null, historical: false,
        command: 'singularity-flow wm status --json'
      },
      reason: `The governed repository world model could not be verified: ${error.message}`
    };
  }
}

/** Read explorer files from the resolved immutable model, not whichever projection is checked out. */
async function editorWorldModelFiles(root, modelRoot, located, inspected = null) {
  const extensions = ['.md', '.json', '.jsonl', '.yml', '.yaml'];
  if (inspected?.format === 'registered-v4' && inspected.resolved) {
    return inspected.resolved.selected.map((file) => ({
      path: posix(path.join(modelRoot, file.relative)),
      name: file.relative,
      content: file.body,
      bytes: file.size
    })).sort((left, right) => left.name.localeCompare(right.name));
  }
  if (located?.source !== 'state-branch') return textFiles(root, modelRoot, { extensions });
  if (!located.directory) return [];
  const files = await textFiles(located.directory, '.', { extensions });
  return files.map((file) => ({
    ...file,
    path: posix(path.join(modelRoot, file.path))
  }));
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
  const skillsRoot = path.join(PACKAGE_ROOT, 'plugin', 'skills');
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
  const fallback = path.join(PACKAGE_ROOT, 'templates/worldmodel-builder.md');
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
  const fallback = path.join(PACKAGE_ROOT, 'templates/copilot-planning.md');
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
  for (const diagnostic of [...refIndex.unreadable, ...(refIndex.conflicts ?? [])]) {
    if (!diagnostic.claimedId) continue;
    results.set(diagnostic.claimedId, {
      id: diagnostic.claimedId,
      title: diagnostic.claimedId,
      status: 'invalid',
      source: diagnostic.ref ?? diagnostic.branch ?? 'git-ref',
      code: diagnostic.code,
      error: diagnostic.reason
    });
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
  let detachedSources = [];
  try {
    const completeSourceCatalog = (await listEpicSources(root, initiativeId, { includeDetached: true })).manifest;
    sources = {
      ...completeSourceCatalog,
      sources: completeSourceCatalog.sources.filter((source) => source?.status == null || ['active', 'pinned'].includes(source.status))
    };
    detachedSources = completeSourceCatalog.sources.filter((source) => source?.status === 'detached');
  }
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
    detachedSources,
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
  const workflowFile = await secureRepositoryPath(root, WORKFLOW_PATH, {
    label: 'Workflow configuration', type: 'file', mustExist: true
  });
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
  let detachedDocuments = [];
  let review = null;
  let report = null;
  if (selectedId) {
    workflow = await loadStoryAggregate(root, definition, selectedId);
    progress = progressSnapshot(workflow);
    report = deriveReport(workflow, { pricing: definition.tokens?.pricing ?? null });
    const completeDocumentCatalog = await documentCatalog(root, definition, workflow, { includeDetached: true });
    documents = completeDocumentCatalog.filter(evidenceIsActive);
    detachedDocuments = completeDocumentCatalog.filter((document) => document.status === 'detached');
    review = await createReviewBundle(root, definition, workflow);
    review.markdown = reviewMarkdown(review);
  }
  const activeSession = await loadSession(root, { required: false });
  let worldModelReadiness = null;
  if (workflow?.currentPhase && selectedStory?.branches.includes(currentBranch)) {
    try {
      const { inspectWorkflowGrounding } = await import('./worldmodel.mjs');
      worldModelReadiness = await inspectWorkflowGrounding(root, workflow, workflow.currentPhase, {
        agent: activeSession?.agent ?? null,
        // A navigation refresh is a local read. The cached state ref is enough to disclose
        // readiness; explicit world-model refresh/ensure operations own network reconciliation.
        refreshRemote: false
      });
    } catch (error) {
      worldModelReadiness = { reason: `The pinned phase grounding plan could not be inspected: ${error.message}` };
    }
  } else if (definition.worldModel?.format === 'registered-v4') {
    try {
      const {
        inspectConfiguredGrounding, loadWorldModelConfig
      } = await import('./worldmodel.mjs');
      worldModelReadiness = await inspectConfiguredGrounding(
        root,
        await loadWorldModelConfig(root),
        null,
        { refreshRemote: false }
      );
    } catch (error) {
      worldModelReadiness = {
        reason: `The registered repository World Model could not be inspected: ${error.message}`
      };
    }
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
  const repositoryWorldModel = worldModelReadiness?.availability
    ? null
    : await editorWorldModelStatus(root, definition, modelRoot);
  const locatedWorldModel = worldModelReadiness?.availability?.selected
    ?? repositoryWorldModel?.located
    ?? null;
  let worldModelManifest = worldModelReadiness?.availability?.selected?.manifest
    ?? repositoryWorldModel?.manifest
    ?? null;
  if (!worldModelManifest) {
    try { worldModelManifest = await readJson(path.join(root, modelRoot, 'manifest.json')); }
    catch { /* Missing state is represented by readiness below. */ }
  }
  const builderPrompt = await worldModelPrompt(root, definition);
  const plannerPrompt = await planningPrompt(root, definition);
  /**
   * The same login, from the call we already have to make.
   *
   * This used to be a second `gh auth status --json hosts`, alongside the `gh api user` inside
   * `identity(root)` below. Two ~440 ms subprocesses, both answering "who is signed in?", together
   * 876 ms of the 1.38 s this snapshot spent in subprocesses — for one username, fetched twice.
   * `identity()` already returns `login`, so the disclosure below is unchanged and simply reuses it.
   */
  const gitIdentity = identity(root, { offline: true });
  const github = gitIdentity.login;
  const promptViewReferences = await worldModelPromptViewReferences(root, definition);
  const structuredViewReferences = structuredWorldModelViewReferences(definition);
  const viewCatalog = worldModelViewCatalog(definition, promptViewReferences.keys());
  const portfolioFile = portfolio ? await secureRepositoryPath(root, PORTFOLIO_PATH, {
    label: 'Portfolio configuration', type: 'file', mustExist: true
  }) : null;
  const portfolioText = portfolioFile ? await readFile(portfolioFile.absolute, 'utf8') : null;
  return {
    schemaVersion: 1,
    // HEAD is carried so a surface can tell that a planning context was built against a different
    // commit. Promotion refuses a stale pack, and without this the only way to discover that was to
    // have the promotion fail after the work was done.
    repository: { root, branch: currentBranch, head: head(root), controlRoot: 'singularity', changes, ...changeScope },
    identities: {
      git: gitIdentity,
      github,
      assurance: {
        git: 'configured-local',
        /**
         * Three states, because there are three things that can be true.
         *
         * This was `github ? 'gh-authenticated' : 'unavailable'`, which reported a lookup nobody
         * performed as a lookup that came back empty — and a reviewer reading "unavailable" on the
         * identity panel concludes the actor is signed out.
         */
        github: gitIdentity.githubLookup === GITHUB_LOOKUP.RESOLVED ? 'gh-authenticated' : gitIdentity.githubLookup,
        jira: 'vscode-secret-storage'
      }
    },
    telemetry,
    ledger,
    modelFreedom: modelFreedomSnapshot({
      definition,
      workflow,
      modelMode: operationContext()?.modelMode ?? { enabled: true, source: 'default' }
    }),
    definition,
    definitionPath: WORKFLOW_PATH,
    definitionText: await readFile(workflowFile.absolute, 'utf8'),
    // Also in `configurationSlice`, and it has to be in both. The extension now loads that slice on
    // demand, while compatibility consumers may still request the full projection here.
    modelRouting: await modelRoutingProjection(root, definition),
    portfolio,
    portfolioPath: PORTFOLIO_PATH,
    // What this organisation builds, as opposed to how its code is stored. Nested here because the
    // stored form is a flat map with parent pointers and every reader wants the hierarchy. Absent
    // until the lead repository describes itself, which is a normal state rather than a fault.
    capabilityMap: await (async () => {
      const authorityRepository = await capabilityAuthorityRepository(root);
      const capabilityDefinition = await loadCapabilities(root);
      if (!capabilityDefinition) {
        const repositories = Object.keys(portfolio?.repositories ?? {});
        const repository = repositories.length === 1 ? repositories[0] : null;
        return {
          mode: 'implicit',
          authorityRepository,
          capabilities: [{
            id: IMPLICIT_CAPABILITY_ID,
            name: 'This repository',
            kind: 'delivery',
            delivery: true,
            repository,
            repositories: repository ? [repository] : [],
            sourceRoots: [], sharedRoots: [], teams: [], owns: [],
            policy: {}, effectivePolicy: {}, children: []
          }]
        };
      }
      try {
        validateCapabilities(capabilityDefinition, portfolio);
        return {
          mode: capabilityMapMode(capabilityDefinition),
          authorityRepository,
          capabilities: capabilityTree(capabilityDefinition)
        };
      } catch (error) {
        return { error: error.message };
      }
    })(),
    capabilityMapPath: CAPABILITIES_PATH,
    portfolioText,
    templates: withTemplateCatalog(await textFiles(root, definition.templatesRoot), definition, root),
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
      generatedAt: worldModelReadiness?.availability?.selected?.manifest?.generated_at
        ?? worldModelManifest?.generated_at
        ?? null,
      // Main and Epic branches stay quiet. Grounding is requested only after Story intake has
      // created and checked out the canonical Story branch that will own the generated model.
      // A stale snapshot under `warn` remains usable, but the UI must still disclose the pinned
      // staleness decision. `reason` is null for fresh and explicitly ignored snapshots.
      rebuildReason: worldModelReadiness?.reason
        ?? (workflow?.currentPhase ? repositoryWorldModel?.reason : null),
      readiness: worldModelReadiness?.availability ? {
        status: worldModelReadiness.availability.status,
        ready: worldModelReadiness.availability.ready,
        source: worldModelReadiness.availability.source,
        historical: worldModelReadiness.availability.selected?.historical === true,
        staleness: worldModelReadiness.availability.staleness,
        command: worldModelReadiness.command
      } : repositoryWorldModel?.readiness ?? null,
      views: viewCatalog.map((id) => ({
        id,
        structuredReferences: structuredViewReferences.get(id) ?? [],
        promptReferences: promptViewReferences.get(id) ?? [],
        references: [
          ...(structuredViewReferences.get(id) ?? []),
          ...(promptViewReferences.get(id) ?? []).map((file) => `Markdown '${file}'`)
        ]
      })),
      workflows: worldModelWorkflowViewUsage(definition),
      files: await editorWorldModelFiles(root, modelRoot, locatedWorldModel, worldModelReadiness)
    },
    agents: agents.map((agent) => ({
      id: agent.id,
      scope: agent.scope,
      path: agent.source,
      packagePath: agent.scope === 'repository' ? null : posix(path.relative(PACKAGE_ROOT, agent.file)),
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
        : await readFile(path.join(PACKAGE_ROOT, 'templates', 'agent-mappings.yml'), 'utf8'),
      rows: mappingStatus.rows
    },
    agentsLock: { path: AGENT_LOCK_PATH, exists: lockExists, content: lockExists ? await readFile(agentLock.absolute, 'utf8') : '# No remote agents are trusted yet.\n' },
    mcp: await mcpConfigurationStatus(root, definition),
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
    detachedDocuments,
    review,
    /**
     * The fast path, on the full snapshot too `[SPK:REQ-150]`.
     *
     * Kept in the full compatibility projection as well as `lifecycleSlice`: every public snapshot
     * shape that carries lifecycle must expose the same planned rail.
     */
    fastPath: fastPathProjection(definition, workflow),
    visualAssurance: await visualAssuranceSnapshot(root, definition, workflow),
    diagnostics: await doctorSnapshot(root, {
      workId: selectedId, offline: true, probeModelProvider: false
    }),
    workflowSimulations: await simulateWorkflow(root),
    session: activeSession
  };
}

const SNAPSHOT_SLICES = new Set([
  'repository',
  'lifecycle',
  'configuration',
  'capabilities',
  'integrations',
  'diagnostics',
  'sgos',
  'worldModel'
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
    identities: { git: identity(root, { offline: true }) }
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
  let detachedDocuments = [];
  let review = null;
  let report = null;
  if (selectedWorkId) {
    workflow = await loadStoryAggregate(root, definition, selectedWorkId);
    progress = progressSnapshot(workflow);
    report = deriveReport(workflow, { pricing: definition.tokens?.pricing ?? null });
    const completeDocumentCatalog = await documentCatalog(root, definition, workflow, { includeDetached: true });
    documents = completeDocumentCatalog.filter(evidenceIsActive);
    detachedDocuments = completeDocumentCatalog.filter((document) => document.status === 'detached');
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
    detachedDocuments,
    review,
    visualAssurance: await visualAssuranceSnapshot(root, definition, workflow),
    initiative: await initiativeEditorSnapshot(root, portfolio, selectedInitiativeId),
    approvalInbox: {
      remote: definition.git?.remote ?? 'origin',
      fetched: false,
      generatedAt: null,
      count: 0,
      items: []
    },
    planning: await planningTargetCatalog(root, { workId: selectedWorkId, initiativeId: selectedInitiativeId }),
    /**
     * The fast path, projected rather than re-derived. `[SPK:REQ-150]` `[SPK:REQ-151]`
     *
     * Every surface must show the same milestone and checkpoint as the CLI, and the only way that
     * stays true is for there to be one computation. `planFastPath` is the planner the `specify`,
     * `plan`, `implement`, `converge` and `verify` commands run; this is the same call, so the
     * journey rail cannot drift into a second opinion about where a Story stands.
     *
     * Null for a work type that declares no fast path — VS Code renders the phase rail it always
     * did, and nothing invents verbs for a profile that does not have them.
     */
    fastPath: fastPathProjection(definition, workflow),
    session: await loadSession(root, { required: false })
  };
}

/**
 * The five verbs for a Story, each with the milestone it proves and where it currently stands.
 *
 * `[SPK:REQ-151]` asks VS Code to present the verbs as the primary rail and let a reader expand into
 * the phases beneath. That expansion is why each verb carries its `phase`: the rail is a lens over
 * the lifecycle, never a replacement for it.
 */
function fastPathProjection(definition, workflow) {
  if (!workflow) return null;
  const profile = fastPathProfile(definition, workflow.workItem.workType);
  if (!profile) return null;
  const configured = FAST_PATH_VERBS.filter((verb) => profile.verbs[verb]);
  const verbs = configured.map((verb) => {
    const plan = planFastPath(workflow, definition, verb);
    return {
      verb,
      // The phases this verb routes, so the rail can expand into them `[SPK:REQ-151]`.
      phases: [...profile.verbs[verb].phases],
      milestone: plan.milestone,
      reached: plan.outcome === 'milestone-reached',
      // The same checkpoint the CLI prints, not a second reading of the same state `[SPK:REQ-150]`.
      checkpoint: plan.checkpoint ?? null,
      operations: [...(plan.underlyingOperations ?? [])],
      next: [...(plan.next ?? [])]
    };
  });
  const active = verbs.find((entry) => !entry.reached) ?? null;
  return {
    profile: profile.workType,
    verbs,
    // Which verb owns the phase the Story is actually standing in — the rail's "you are here".
    context: verbForPhase(workflow, profile, workflow.currentPhase ?? null),
    active: active?.verb ?? null,
    next: active ? nextVerb(profile, active.verb) : null
  };
}

/**
 * What each task routes to, and which phases route by it. `[ADP:REQ-020]` `[ADP:REQ-012]`
 *
 * The indirection that makes routing maintainable also makes it invisible: a reader looking at
 * `workflow.yml` sees `task: reason` and has no way to learn which model that is without opening a
 * second file and following an alias. This joins the two so a surface can show the answer.
 *
 * Derived here rather than in the extension for the reason the fast-path rail had to learn twice: a
 * view that recomputes a resolution is a second opinion about it, and when the two disagree a reader
 * has no way to tell which one the kernel will actually use.
 */
/**
 * Tell each template file what it is called and who uses it. `[templates: catalog]`
 *
 * The Configuration view already lists the files under `templatesRoot`, which is a list of
 * filenames and nothing else — a reader cannot tell which of eleven templates is the one the
 * specification phase renders, or whether deleting one would break four work types.
 *
 * The catalog answers both, so this joins it onto the file list rather than adding a second tree
 * beside it. A template's name and its usage are facts *about the file*; putting them anywhere else
 * would make a reader hold two lists in their head and match them up by path.
 *
 * Applied through one helper because the file list is produced in two places — `configurationSlice`
 * and `fullRepositorySnapshot` — and the extension reads whichever the caller asked for. Annotating
 * one and not the other is how a surface shows different truths depending on how it was opened.
 */
function withTemplateCatalog(files, definition, root) {
  const declared = definition?.templates ?? {};
  const byPath = new Map(Object.entries(declared).map(([id, entry]) => [entry.path, { id, ...entry }]));
  const templatesRoot = definition?.templatesRoot ?? 'singularity/templates';
  return files.map((file) => {
    // Catalog paths are relative to `templatesRoot`; the file list carries repository-relative ones.
    const relative = file.path.startsWith(`${templatesRoot}/`) ? file.path.slice(templatesRoot.length + 1) : file.path;
    const entry = byPath.get(relative) ?? null;
    const references = templateReferences(definition ?? {}, relative);
    return {
      ...file,
      catalogId: entry?.id ?? null,
      catalogLabel: entry?.label ?? null,
      catalogKind: entry?.kind ?? null,
      // Named separately from the count so a surface can say "used by nobody" without recomputing.
      usedBy: references
    };
  });
}

async function modelRoutingProjection(root, definition) {
  const mapping = await loadModelTiers(root).catch((error) => ({ error }));
  if (!mapping) return { configured: false, error: null, path: MODEL_TIERS_PATH, revision: null, tasks: [] };
  if (mapping.error) {
    return { configured: true, error: mapping.error.message, path: MODEL_TIERS_PATH, revision: null, tasks: [] };
  }
  // Which phases declare each task, so the mapping reads as policy in force rather than as a table.
  const phases = new Map();
  for (const [phaseId, phase] of Object.entries(definition?.phases ?? {})) {
    if (phase?.generation?.task) {
      const list = phases.get(phase.generation.task) ?? [];
      list.push(phaseId);
      phases.set(phase.generation.task, list);
    }
  }
  return {
    configured: true,
    error: null,
    path: MODEL_TIERS_PATH,
    revision: mapping.revision,
    tasks: MODEL_TASKS.map((task) => {
      const ladder = tierLadder(mapping, task);
      return {
        task,
        model: ladder.models[0],
        fallback: ladder.models.slice(1),
        aliasOf: ladder.aliasOf,
        params: ladder.params,
        phases: phases.get(task) ?? []
      };
    })
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
  const modelRoot = posix(definition.worldModel?.outputDir ?? 'singularity/world-model');
  // Registered v4 runtime data has its own on-demand leased slice. Loading the compatibility file
  // inventory here would make opening People, MCP, or Templates silently read and retain WMB.
  const registeredV4 = definition.worldModel?.format === 'registered-v4';
  const repositoryWorldModel = registeredV4
    ? null
    : await editorWorldModelStatus(root, definition, modelRoot);
  const worldModelManifest = repositoryWorldModel?.manifest ?? null;
  const promptViewReferences = registeredV4
    ? new Map()
    : await worldModelPromptViewReferences(root, definition);
  const structuredViewReferences = registeredV4
    ? new Map()
    : structuredWorldModelViewReferences(definition);
  const viewCatalog = registeredV4
    ? []
    : worldModelViewCatalog(definition, promptViewReferences.keys());
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
    modelRouting: await modelRoutingProjection(root, definition),
    portfolio,
    portfolioPath: PORTFOLIO_PATH,
    portfolioText,
    templates: withTemplateCatalog(await textFiles(root, templatesRoot), definition, root),
    agentPrompts: await textFiles(root, agentPromptsRoot, { extensions: ['.md'] }),
    prompts: await textFiles(root, PROMPTS_ROOT, { extensions: ['.md'] }),
    repositorySkills: await textFiles(root, REPOSITORY_SKILLS_ROOT, { extensions: ['.md'] }),
    flowSkills: await bundledFlowSkills(),
    agents: agents.map((agent) => ({
      id: agent.id,
      scope: agent.scope,
      path: agent.source,
      packagePath: agent.scope === 'repository' ? null : posix(path.relative(PACKAGE_ROOT, agent.file)),
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
        : await readFile(path.join(PACKAGE_ROOT, 'templates', 'agent-mappings.yml'), 'utf8'),
      rows: mappingStatus.rows
    },
    agentsLock: {
      path: AGENT_LOCK_PATH,
      exists: agentLock.exists,
      content: agentLock.exists
        ? await readFile(agentLock.absolute, 'utf8')
        : '# No remote agents are trusted yet.\n'
    },
    modelFreedom: modelFreedomSnapshot({
      definition,
      modelMode: operationContext()?.modelMode ?? { enabled: true, source: 'default' }
    }),
    ...(registeredV4 ? {} : { worldModel: {
      root: modelRoot,
      generatedAt: worldModelManifest?.generated_at ?? null,
      rebuildReason: repositoryWorldModel?.reason ?? null,
      readiness: repositoryWorldModel?.readiness ?? null,
      views: viewCatalog.map((id) => ({
        id,
        structuredReferences: structuredViewReferences.get(id) ?? [],
        promptReferences: promptViewReferences.get(id) ?? [],
        references: [
          ...(structuredViewReferences.get(id) ?? []),
          ...(promptViewReferences.get(id) ?? []).map((file) => `Markdown '${file}'`)
        ]
      })),
      workflows: worldModelWorkflowViewUsage(definition),
      files: await editorWorldModelFiles(root, modelRoot, repositoryWorldModel?.located ?? null)
    } }),
    mcp: await mcpConfigurationStatus(root, definition)
  };
}

async function capabilitySlice(root) {
  const portfolio = await loadPortfolio(root, { required: false });
  const definition = await loadCapabilities(root);
  const authorityRepository = await capabilityAuthorityRepository(root);
  if (!definition) return {
    path: CAPABILITIES_PATH, mode: 'implicit', authorityRepository, capabilities: null
  };
  try {
    validateCapabilities(definition, portfolio);
    return {
      path: CAPABILITIES_PATH,
      mode: capabilityMapMode(definition),
      authorityRepository,
      capabilities: capabilityTree(definition)
    };
  } catch (error) {
    return {
      path: CAPABILITIES_PATH, mode: capabilityMapMode(definition), authorityRepository,
      capabilities: null, error: error.message
    };
  }
}

/** Exact configuration provenance wins; a self-owned checkout falls back to its credential-free origin. */
async function capabilityAuthorityRepository(root) {
  try {
    const source = await readConfigurationSource(root);
    if (source?.repository) return source.repository;
  } catch {
    // Invalid provenance must not be guessed around. The editor will retain its explicit chooser.
    return null;
  }
  try { return configuredRemoteIdentity(root, 'origin').url ?? null; }
  catch { return null; }
}

async function integrationSlice(root) {
  const definition = await loadDefinition(root);
  let ledger;
  // Offline, like the sibling read in `fullRepositorySnapshot` above. A slice that renders an
  // availability badge must not dial out to produce it.
  try { ledger = await ledgerStatus(root, definition.ledger ?? {}, { offline: true }); }
  catch (error) {
    ledger = {
      enabled: Boolean(definition.ledger?.enabled),
      available: false,
      error: error?.message ?? String(error)
    };
  }
  // Same login, same single memoized lookup as `fullRepositorySnapshot` — see the note there.
  let github = null;
  try {
    github = identity(root, { offline: true }).login;
  } catch { /* The integration remains unavailable when gh is absent or signed out. */ }
  return {
    telemetry: await copilotTelemetryStatus(root),
    ledger,
    github,
    notifications: definition.notifications ?? { channels: ['terminal'] }
  };
}

/** SGOS operational state is a lazy, model-free read from the Git-common-dir sidecar. */
async function sgosSlice(root) {
  return loadSgosCommandCenter(root);
}

/**
 * WMB v4 is a dedicated heavy slice: the core snapshot never reads the state branch or retains
 * view prose. The projection contains bounded previews and content-addressed expansion handles,
 * while full Facts/Evidence/Derivations remain behind explicit reads.
 */
async function worldModelSlice(root) {
  const definition = await loadDefinition(root);
  const state = worldModelStateAuthority(definition);
  const outputDir = posix(definition.worldModel?.outputDir ?? 'singularity/world-model');
  if (definition.worldModel?.format !== 'registered-v4') {
    return {
      schemaVersion: 1,
      kind: 'world-model-ide-slice',
      format: definition.worldModel?.format ?? 'legacy-v3',
      status: 'unavailable',
      reason: 'WMB_V4_NOT_CONFIGURED',
      root: outputDir,
      generatedAt: null,
      rebuildReason: null,
      readiness: { status: 'not-configured', ready: false, source: null, command: null },
      summary: { views: 0, facts: 0, evidence: 0, derivations: 0, unavailable: 0, contradictions: 0, cacheHits: 0 },
      views: [],
      expansion: []
    };
  }
  const { loadWorldModelIdeSlice } = await import('./world-model/ide/slice.mjs');
  const slice = loadWorldModelIdeSlice(root, {
    outputDir,
    stateBranch: state.branch,
    remote: state.remote
  });
  return {
    ...slice,
    // Policy-to-phase usage is configuration metadata, not authority content. It joins only after
    // the dedicated slice is leased so other Configuration Center tabs never retain this payload.
    workflows: worldModelWorkflowViewUsage(definition)
  };
}

/**
 * Build either the compatibility snapshot consumed by the extension, or explicit schema-v2
 * slices for callers that request them. Scoped calls do not construct unrelated read models.
 */
/**
 * The read model, computed inside one read scope. `[UXH:REQ-120]` `[DHR:REQ-093]`
 *
 * A snapshot is the definition of a read-only operation — it is what the extension calls on every
 * refresh and it writes nothing — so this is the place the scope belongs. `withDefinitionCache` was
 * written for exactly this and had **no callers anywhere**: the memo existed, was correct, and was
 * never opened, so `loadDefinition` went on being parsed seven times and the ledger read three.
 * The same "declared, validated, never reaching a consumer" shape this codebase keeps producing,
 * this time in the fix rather than the feature.
 *
 * Wrapped here rather than at the CLI dispatch so the extension gets it too: it bundles this module
 * and calls `repositorySnapshot` in-process, and a cache that only the terminal opened would miss
 * the surface the latency budget is actually about.
 */
export async function repositorySnapshot(root, requestedWorkId = null, requestedInitiativeId = null, { included = null } = {}) {
  // Configuration Center edits the shared authority used by future work. An active Story carries
  // an intentionally immutable configuration copy, so using the ordinary lifecycle read scope for
  // the configuration slice made a successfully activated workflow remain invisible until the
  // user left that Story. Build this slice from current approved authority while every lifecycle
  // slice continues to read the Story's pinned contract.
  if (included?.includes('configuration')) {
    const other = [...new Set(included)].filter((slice) => slice !== 'configuration');
    const result = other.length
      ? await withApprovedConfigurationRead(root, () => withDefinitionCache(
          () => repositorySnapshotInScope(root, requestedWorkId, requestedInitiativeId, { included: other })
        ))
      : {};
    const configuration = await withApprovedConfigurationRead(root, () => withDefinitionCache(
      () => configurationSlice(root)
    ), { preferAuthority: true });
    return { ...result, configuration };
  }
  return withApprovedConfigurationRead(root, () => withDefinitionCache(
    () => repositorySnapshotInScope(root, requestedWorkId, requestedInitiativeId, { included })
  ));
}

async function repositorySnapshotInScope(root, requestedWorkId, requestedInitiativeId, { included }) {
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
    else if (slice === 'diagnostics') result.diagnostics = await doctorSnapshot(root, {
      workId: requestedWorkId, offline: true, probeModelProvider: false
    });
    else if (slice === 'sgos') result.sgos = await sgosSlice(root);
    else if (slice === 'worldModel') result.worldModel = await worldModelSlice(root);
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
    starter = YAML.parse(await readFile(path.join(PACKAGE_ROOT, 'templates', 'portfolio.yml'), 'utf8'));
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
    || relative === IMPACT_CONFIG_PATH
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

function contentSha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function plannedClaimsReadinessShape(resolved) {
  return {
    spec: resolved.spec,
    phases: resolved.phases.map((phase) => ({
      id: phase.id,
      artifactKind: phase.artifact?.kind ?? null,
      generationTask: phase.generation?.task ?? null
    }))
  };
}

/**
 * Keep old catalogs readable, but do not let an authoring boundary introduce or reshape an
 * unresolved planned-claim topology. Presentation-only edits remain possible while the legacy
 * workflow is being migrated; phase order, specification policy, and the artifact/task signals
 * that determine clause ownership are the material contract.
 */
export function assertWorkflowReadinessChanges(previousDefinition, candidateDefinition) {
  for (const workTypeId of Object.keys(candidateDefinition.workTypes)) {
    const candidate = resolveWorkType(candidateDefinition, workTypeId);
    if (candidate.plannedClaims.mode !== 'migration-required') continue;
    const previousWorkType = previousDefinition.workTypes?.[workTypeId];
    const previous = previousWorkType ? resolveWorkType(previousDefinition, workTypeId) : null;
    const unchangedLegacy = previous?.plannedClaims.mode === 'migration-required'
      && JSON.stringify(plannedClaimsReadinessShape(previous))
        === JSON.stringify(plannedClaimsReadinessShape(candidate));
    if (unchangedLegacy) continue;
    throw new SingularityFlowError(
      `Workflow '${workTypeId}' has a migration-required planned-claim contract and cannot be added or materially changed. `
      + 'Declare a resolvable required topology, or use an explicit reviewed opt-out with a concrete reason.',
      {
        code: 'WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED',
        details: { workType: workTypeId, reason: candidate.plannedClaims.reason ?? null }
      }
    );
  }
}

async function copyConfigurationSource(root, validationRoot, relative) {
  if (!relative || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative)) return;
  const source = path.join(root, relative);
  if (!existsSync(source)) return;
  const target = path.join(validationRoot, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

async function validateConfigurationCandidate(root, relative, content, definition, portfolio) {
  const validationRoot = await mkdtemp(path.join(tmpdir(), 'singularity-flow-configuration-'));
  try {
    const sources = new Set([
      WORKFLOW_PATH, PORTFOLIO_PATH, CAPABILITIES_PATH, IMPACT_CONFIG_PATH, AGENT_MAPPING_PATH,
      definition.templatesRoot, portfolio?.templatesRoot, definition.agentPromptsRoot,
      REPOSITORY_SKILLS_ROOT, PROMPTS_ROOT, '.github/agents'
    ].filter(Boolean).map(posix));
    if (relative === WORKFLOW_PATH || relative === PORTFOLIO_PATH) {
      try {
        const candidate = YAML.parse(content) ?? {};
        for (const location of [candidate.templatesRoot, candidate.agentPromptsRoot, candidate.personaPromptsRoot]) {
          if (typeof location === 'string') sources.add(posix(location));
        }
      } catch {
        // The focused schema validation below reports parse failures with the correct file label.
      }
    }
    for (const source of sources) await copyConfigurationSource(root, validationRoot, source);
    const candidatePath = path.join(validationRoot, relative);
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeText(candidatePath, content);

    const updatedDefinition = await loadDefinition(validationRoot);
    assertWorkflowReadinessChanges(definition, updatedDefinition);
    if (existsSync(path.join(validationRoot, IMPACT_CONFIG_PATH))) {
      await loadImpactDefinition(validationRoot, { required: true });
    }
    const updatedPortfolio = await loadPortfolio(validationRoot, { required: false });
    if (updatedPortfolio) validatePortfolioWorldModelViews(updatedPortfolio, updatedDefinition);
    await discoverAgents(validationRoot);
    await loadAgentMappings(validationRoot);
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
}

export async function saveConfigurationFile(root, requestedPath, content, { expectedSha256 = null } = {}) {
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
  if (relative === IMPACT_CONFIG_PATH) {
    try { normalizeImpactDefinition(YAML.parse(content)); }
    catch (error) { throw new SingularityFlowError(`Change was not saved because Flow Impact configuration validation failed: ${error.message}`); }
  }
  const target = await secureRepositoryPath(root, relative, {
    label: 'Editor configuration target',
    type: 'file'
  });
  const existed = target.exists;
  const previous = existed ? await readFile(target.absolute, 'utf8') : null;
  // The editor renders an absent optional configuration file as an empty draft.
  // Hash that same representation so first-time creation is revision-aware too:
  // a concurrent creator changes the hash and is rejected below.
  const currentSha256 = contentSha256(previous ?? '');
  if (expectedSha256 !== null && expectedSha256 !== currentSha256) {
    throw new SingularityFlowError(`Configuration changed since the editor loaded '${relative}'. Reload the Configuration Center, review the newer content, and apply the change again.`);
  }
  try {
    await validateConfigurationCandidate(root, relative, content, definition, portfolio);
  } catch (error) {
    throw new SingularityFlowError(`Change was not saved because configuration validation failed: ${error.message}`);
  }
  const latest = existsSync(target.absolute) ? await readFile(target.absolute, 'utf8') : null;
  const latestSha256 = contentSha256(latest ?? '');
  if (latestSha256 !== currentSha256) {
    throw new SingularityFlowError(`Configuration changed while '${relative}' was being validated. Reload the Configuration Center and apply the change to the latest version.`);
  }
  await writeText(target.absolute, content);
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
  const impact = await loadImpactDefinition(root) ?? { studies: [] };
  if (relative.startsWith(`${templatesRoot}/`)) {
    const template = relative.slice(templatesRoot.length + 1);
    /**
     * Both ways a template can be named. Comparing paths alone was correct while a path was the
     * only form; with the catalog, a phase saying `template:intake-standard` would have matched
     * nothing and the guard would have cheerfully deleted a template still in use.
     */
    references.push(...templateReferences(definition, template));
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
  for (const study of impact.studies.filter((candidate) =>
    candidate.kind === 'prompt-set-randomized' && candidate.status !== 'closed')) {
    for (const variant of study.variants) {
      for (const [phaseId, prompt] of Object.entries(variant.prompts)) {
        if (prompt.path === relative) references.push(`Flow Impact study ${study.studyRunId}/${variant.id}/${phaseId}`);
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

export async function validateEditorConfiguration(root, { baselineDefinition = null } = {}) {
  const definition = await loadDefinition(root);
  if (baselineDefinition) assertWorkflowReadinessChanges(baselineDefinition, definition);
  const portfolio = await loadPortfolio(root, { required: false });
  if (portfolio) validatePortfolioWorldModelViews(portfolio, definition);
  const agents = await discoverAgents(root);
  await loadAgentMappings(root, { agents });
  return {
    // `valid` is always true because this function signals failure by throwing; it is kept so the
    // JSON shape does not change under callers that read it.
    valid: true,
    workTypes: Object.keys(definition.workTypes).length,
    phases: Object.keys(definition.phases).length,
    // Two keys named `agents` used to sit in this literal, so the declared count was silently
    // overwritten by the discovered one and never reported at all. Both are useful; name them.
    declaredAgents: Object.keys(definition.agents).length,
    agents: agents.length,
    initiativeProfiles: Object.keys(portfolio?.initiativeProfiles ?? {}).length,
    initiativePhases: Object.keys(portfolio?.initiativePhases ?? {}).length,
    repositories: Object.keys(portfolio?.repositories ?? {}).length
  };
}

export async function publishEditorConfiguration(root, message = 'Configure Singularity Flow workflow') {
  const definition = await loadDefinition(root);
  const publishing = (definition.git?.publish ?? 'required') !== 'off';
  if (publishing) assertNotDefaultBranch(root, definition, 'Configuration publication');
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
  if (!publishing) return { sha, pushed: false, files: configurationChanges };
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

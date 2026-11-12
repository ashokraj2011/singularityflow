/**
 * Archiving and deleting workflows (docs/SPEC-WORKFLOW-RETIREMENT-v1.md).
 *
 * Archive keeps a workflow and everything it uses, and only stops new Stories from choosing it; the
 * list lives in its own file so an engine that does not know it keeps working. Delete removes the
 * workflow and each dependency no other workflow, archived or not, still uses, using the same closure
 * export uses. Both run as reviewed configuration proposals through the caller's `author`.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import YAML from 'yaml';
import { SingularityFlowError } from './util.mjs';
import { renderPreservingFormatting } from './yaml-formatting.mjs';
import { withConfigurationReadRoot } from './configuration-read-scope.mjs';
import { executeGitQuery } from './git-query.mjs';
import { workflowRetirementSupport as support } from './workflow-transfer.mjs';
import { seededWorkflowProtection } from './seeded-workflow-protection.mjs';
import { discoverAgents, AGENT_LOCK_PATH } from './agents.mjs';
import { SKILL_ATTACHMENTS_PATH, readSkillAttachments, skillAttachmentsText } from './skill-library.mjs';
import { IMPORTS_LOCK_PATH, parseImportsLedger, renderImportsLedger } from './imports-ledger.mjs';
import { EPIC_PHASES } from './initiative-phase-roles.mjs';
import { compiledSkillStep } from './code-delivery-policy.mjs';
import { WORKFLOW_ARCHIVE_PATH, parseWorkflowArchive, workflowArchived } from './workflow-archive.mjs';

export { WORKFLOW_ARCHIVE_PATH, parseWorkflowArchive, readWorkflowArchive, workflowArchived } from './workflow-archive.mjs';

const IMPACT_PATH = 'singularity/impact.yml';
const DEFAULT_CONSTITUTION = 'singularity/constitution.md';
const ARCHIVE_STORE = Object.freeze({ file: WORKFLOW_ARCHIVE_PATH });
const IMPACT_STORE = Object.freeze({ file: IMPACT_PATH });
const AGENT_LOCK_STORE = Object.freeze({ file: AGENT_LOCK_PATH });
const TERMINAL_STORY_STATUSES = new Set(['closed', 'cancelled', 'canceled', 'completed', 'done']);
const RETIREMENT_PLANS = new WeakMap();

function fail(message, code, details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function digest(value) { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`; }

// The archive file ------------------------------------------------------------------------------

function archiveText(previous, archive) {
  const document = previous?.document?.clone?.() ?? new YAML.Document({ version: 1, archived: {} });
  const shape = { version: 1, archived: Object.fromEntries(['story', 'initiative']
    .filter((governs) => Object.keys(archive[governs]).length)
    .map((governs) => [governs, Object.fromEntries(Object.entries(archive[governs]).sort(([a], [b]) => a.localeCompare(b))
      .map(([id, entry]) => [id, entry.reason ? { reason: entry.reason } : {}]))])) };
  document.contents = document.createNode(shape);
  return previous ? renderPreservingFormatting(previous.text, document) : document.toString();
}

async function writeText(root, relative, content) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const file = await support.assertSafeTarget(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return relative;
}

function defaultWorkflowOf(story) {
  return story?.delivery?.defaultWorkflowProfile ?? story?.delivery?.workflowProfile ?? 'feature';
}

/** A live replacement default, or a refusal that names `--new-default`. */
function replacementDefault(story, removing, newDefault, archive) {
  if (defaultWorkflowOf(story) !== removing) return null;
  const live = Object.keys(story.workTypes ?? {}).filter((id) => id !== removing && !workflowArchived(archive, 'story', id));
  if (!newDefault) fail(`Workflow '${removing}' is the repository's default workflow. Pass --new-default <ID> with one of: ${live.join(', ') || 'none'}.`,
    'WORKFLOW_DEFAULT_REPLACEMENT_REQUIRED', { live });
  if (!live.includes(newDefault)) fail(`--new-default '${newDefault}' is not a live Story workflow. Choose one of: ${live.join(', ')}.`,
    'WORKFLOW_DEFAULT_REPLACEMENT_INVALID', { live });
  return newDefault;
}

function setDefault(storyDocument, newDefault) {
  const document = storyDocument.document.clone();
  document.setIn(['delivery', 'defaultWorkflowProfile'], newDefault);
  return renderPreservingFormatting(storyDocument.text, document);
}

/**
 * Archive or restore a workflow in `target` (the working tree, or a proposal's scratch checkout).
 * Returns the changed files. Archiving the last live Story workflow, or the default without a live
 * replacement, is refused.
 */
export async function archiveWorkflowIn(target, { selector, reason = null, newDefault = null, restore = false }) {
  const located = await support.locateWorkflow(target, selector);
  const root = located.root;
  const archiveDocument = await support.readYamlDocument(root, ARCHIVE_STORE, { optional: true });
  const archive = archiveDocument ? parseWorkflowArchive(archiveDocument.text) : { story: {}, initiative: {} };
  const archived = workflowArchived(archive, located.governs, located.id);
  if (restore ? !archived : archived) {
    return { schemaVersion: 1, resultType: restore ? 'workflow-restore' : 'workflow-archive',
      status: restore ? 'not-archived' : 'already-archived', workflowId: located.id, governs: located.governs, changed: false, files: [] };
  }
  const files = [];
  if (restore) delete archive[located.governs][located.id];
  else {
    if (reason != null && (typeof reason !== 'string' || !reason.trim() || reason.length > 500)) {
      fail('--reason must be 1 to 500 characters.', 'WORKFLOW_ARCHIVE_REASON_INVALID');
    }
    if (located.governs === 'story') {
      const story = located.documents.story.value;
      const live = Object.keys(story.workTypes ?? {}).filter((id) => id !== located.id && !workflowArchived(archive, 'story', id));
      if (!live.length) fail(`Workflow '${located.id}' is the last live Story workflow; archiving it would leave none for new Stories.`,
        'WORKFLOW_ARCHIVE_LAST_REFUSED');
      const replacement = replacementDefault(story, located.id, newDefault, archive);
      if (replacement) files.push(await writeText(root, support.STORE.story.file, setDefault(located.documents.story, replacement)));
    }
    archive[located.governs][located.id] = reason ? { reason: reason.trim() } : {};
  }
  files.push(await writeText(root, WORKFLOW_ARCHIVE_PATH, archiveText(archiveDocument, archive)));
  return { schemaVersion: 1, resultType: restore ? 'workflow-restore' : 'workflow-archive',
    status: restore ? 'restored' : 'archived', workflowId: located.id, governs: located.governs, changed: true, files };
}

// Delete -----------------------------------------------------------------------------------------

function selectorsOf(documents) {
  return Object.entries(support.STORE).flatMap(([governs, store]) =>
    Object.keys(documents[governs]?.value?.[store.workflows] ?? {}).map((id) => `${governs}:${id}`));
}

function usageIndex() {
  const index = new Map();
  return {
    add(key, selector) { if (!index.has(key)) index.set(key, new Set()); index.get(key).add(selector); },
    of(key) { return [...(index.get(key) ?? [])].sort(); }
  };
}

const sectionKey = (governs, section, id) => `${governs}:${section}:${id}`;
const assetKey = (asset) => asset.kind === 'agent' ? `agent:${asset.id}`
  : asset.kind === 'vendored' ? `vendored:${asset.path}` : `${asset.kind}:${asset.path}`;

function recordUsage(index, selector, bundle) {
  for (const { governs, section, values } of support.configSections(bundle)) {
    for (const id of Object.keys(values)) index.add(sectionKey(governs, section, id), selector);
  }
  for (const asset of bundle.assets) index.add(assetKey(asset), selector);
}

function isRemovableSection(section) {
  // Approval groups are governance identities shared with roles and permissions: never removed here.
  return !['approvalAuthorities'].includes(section);
}

function protectionReason(protectedIds, governs, section, id, objects) {
  if (governs === 'story' && section === 'phases') {
    if (protectedIds.phases.includes(id)) return 'seeded';
    if (compiledSkillStep(objects.story.phases?.[id])) return 'compiled-skill-step';
  }
  if (governs === 'initiative' && section === 'initiativePhases') {
    if (protectedIds.epicPhases.includes(id)) return 'seeded';
    if (Object.values(EPIC_PHASES).includes(id)) return 'canonical-epic-step';
  }
  if (section === 'artifactSets' && protectedIds.artifactSets.includes(id)) return 'seeded';
  if (section === 'templates' && protectedIds.templates.includes(id)) return 'seeded';
  if (section === 'integrations.targets' && protectedIds.integrationTargets.includes(id)) return 'seeded';
  return null;
}

/** Copy `values` without the keys in `removed` (a Set), or the same object when nothing goes. */
function without(values, removed) {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([key]) => !removed.has(key)));
}

/**
 * Plan deleting `selector` from the configuration read at `root`. The plan names every removed,
 * kept and trimmed object and the references cleaned, and binds them in `planSha256`. Stories are
 * checked separately (`workflowDeleteStories`): a proposal's scratch checkout has no Story state.
 */
export async function planWorkflowDelete(root, { selector, newDefault = null } = {}) {
  // The approved destination this plan was read from, bound into its digest as transfer plans are.
  const destination = support.captureTransferDestination(root);
  const located = await support.locateWorkflow(root, selector);
  const sourceRoot = located.root;
  const story = located.documents.story?.value ?? {};
  const initiative = located.documents.initiative?.value ?? {};
  const agents = await discoverAgents(root);
  const protectedIds = await seededWorkflowProtection(story, initiative, agents);
  const ownSection = support.STORE[located.governs].workflows;
  if ((located.governs === 'story' ? protectedIds.workflows : protectedIds.epics).includes(located.id)) {
    fail(`Workflow '${located.id}' is seeded and read-only, so it cannot be deleted. Archive it instead: `
      + `singularity-flow workflow archive ${located.selector} --propose.`, 'SEEDED_WORKFLOW_READ_ONLY', {
      nextAction: { command: `singularity-flow workflow archive ${located.selector} --propose --json` }
    });
  }
  if (located.governs === 'story' && Object.keys(story.workTypes ?? {}).length === 1) {
    fail(`Workflow '${located.id}' is the last Story workflow; a repository needs at least one.`, 'WORKFLOW_DELETE_LAST_REFUSED');
  }
  const archiveDocument = await support.readYamlDocument(sourceRoot, ARCHIVE_STORE, { optional: true });
  const archive = archiveDocument ? parseWorkflowArchive(archiveDocument.text) : { story: {}, initiative: {} };
  const replacement = located.governs === 'story' ? replacementDefault(story, located.id, newDefault, archive) : null;

  const target = await support.buildBundle(root, [located.selector]);
  const index = usageIndex();
  const unreadable = [];
  for (const other of selectorsOf(located.documents).filter((entry) => entry !== located.selector)) {
    try { recordUsage(index, other, await support.buildBundle(root, [other])); }
    catch (error) { unreadable.push({ workflow: other, code: error.code ?? null, message: error.message }); }
  }
  const keepAll = unreadable.length > 0;
  const keptBecause = (key, reason = null) => {
    const usedBy = index.of(key);
    if (usedBy.length) return { usedBy };
    if (reason) return { reason };
    return keepAll ? { reason: 'another-workflow-unreadable' } : null;
  };

  const removed = [];
  const kept = [];
  const removedSections = {};
  for (const { governs, section, values } of support.configSections(target)) {
    for (const id of Object.keys(values).sort()) {
      if (governs === located.governs && section === ownSection) {
        if (id === located.id) { removed.push({ kind: `${governs}.workflow`, id }); (removedSections[`${governs}:${section}`] ??= new Set()).add(id); }
        continue;
      }
      const kind = `${governs}.${section}`;
      const because = keptBecause(sectionKey(governs, section, id),
        !isRemovableSection(section) ? 'approval-group' : protectionReason(protectedIds, governs, section, id, target.objects));
      if (because) { kept.push({ kind, id, ...because }); continue; }
      removed.push({ kind, id });
      (removedSections[`${governs}:${section}`] ??= new Set()).add(id);
    }
  }
  const removedSteps = new Set([...(removedSections['story:phases'] ?? []), ...(removedSections['initiative:initiativePhases'] ?? [])]);
  const repositoryAgents = new Map(agents.filter((agent) => agent.scope === 'repository').map((agent) => [agent.id, agent]));
  const removedFiles = [];
  const removedAgents = new Set();
  for (const asset of target.assets) {
    const key = assetKey(asset);
    if (asset.kind === 'agent') {
      const agent = repositoryAgents.get(asset.id);
      const because = keptBecause(key, !agent ? 'built-in-agent' : protectedIds.agents.includes(asset.id) ? 'seeded' : null);
      if (because) { kept.push({ kind: 'agent', id: asset.id, ...because }); continue; }
      removedAgents.add(asset.id);
      removed.push({ kind: 'agent', id: asset.id, path: agent.source });
      removedFiles.push(agent.source);
      continue;
    }
    if (asset.kind === 'vendored') {
      const ownerGone = asset.owner?.kind === 'agent' ? removedAgents.has(asset.owner.id)
        : asset.owner?.kind === 'mcp-server' ? removedSections['story:mcpServers']?.has(asset.owner.id) : false;
      if (!ownerGone || index.of(key).length) { kept.push({ kind: 'vendored', path: asset.path, ...(keptBecause(key) ?? { reason: 'owner-kept' }) }); continue; }
      removed.push({ kind: 'vendored', path: asset.path }); removedFiles.push(asset.path); continue;
    }
    if (asset.kind === 'skill' || asset.kind === 'instruction') {
      const id = path.posix.basename(path.posix.dirname(asset.path));
      const seeded = (asset.kind === 'skill' ? protectedIds.skills : protectedIds.instructions).includes(id);
      const because = keptBecause(key, seeded ? 'seeded' : null);
      if (because) { kept.push({ kind: asset.kind, id, path: asset.path, ...because }); continue; }
      removed.push({ kind: asset.kind, id, path: path.posix.dirname(asset.path) });
      removedFiles.push(path.posix.dirname(asset.path));
      continue;
    }
    if (asset.kind === 'template') {
      const because = keptBecause(key, protectedIds.templateFiles.includes(asset.path) ? 'seeded' : null);
      if (because) { kept.push({ kind: 'template-file', path: asset.path, ...because }); continue; }
      removed.push({ kind: 'template-file', path: asset.path }); removedFiles.push(asset.path); continue;
    }
    if (asset.kind === 'constitution') {
      const because = keptBecause(key, asset.path === DEFAULT_CONSTITUTION ? 'shared-default' : null);
      if (because) { kept.push({ kind: 'constitution', path: asset.path, ...because }); continue; }
      removed.push({ kind: 'constitution', path: asset.path }); removedFiles.push(asset.path); continue;
    }
    kept.push({ kind: asset.kind, path: asset.path, reason: 'not-removed-by-delete' });
  }

  // Agents that stay lose only the removed steps, with the logic export uses to scope an agent.
  const trimmed = [];
  for (const agent of repositoryAgents.values()) {
    if (removedAgents.has(agent.id) || !removedSteps.size) continue;
    const text = await readFile(path.join(sourceRoot, agent.source), 'utf8').catch(() => null);
    if (text == null) continue;
    const scoped = support.phaseScopedAgentText(text, { has: (id) => !removedSteps.has(id) });
    if (scoped !== text) trimmed.push({ kind: 'agent', id: agent.id, path: agent.source, steps: [...removedSteps].filter((id) => text.includes(id)).sort() });
  }

  const cleanups = [];
  if (located.governs === 'story' || removedSteps.size) {
    for (const [serverId, server] of Object.entries(story.mcpServers ?? {})) {
      if (removedSections['story:mcpServers']?.has(serverId)) continue;
      const gone = (server?.phases ?? []).filter((id) => removedSteps.has(id));
      if (gone.length) cleanups.push({ kind: 'mcp-server-steps', id: serverId, steps: gone });
    }
    const allowed = (story.documents?.allowedPhases ?? []).filter((id) => removedSteps.has(id));
    if (allowed.length) cleanups.push({ kind: 'document-allowed-steps', steps: allowed });
    const overrides = Object.keys(story.contextPolicy?.phaseOverrides ?? {}).filter((id) => removedSteps.has(id));
    if (overrides.length) cleanups.push({ kind: 'context-step-overrides', steps: overrides });
  }
  const attachments = await readSkillAttachments(sourceRoot).catch(() => []);
  const removedSkills = new Set(removed.filter((entry) => entry.kind === 'skill').map((entry) => entry.id));
  // An attachment row goes with the workflow or skill it names; one that also covers kept steps loses
  // only the removed ones, and goes only when none is left.
  const attachmentRows = attachments.filter((entry) => (located.governs === 'story' && entry.workflow === located.id)
    || removedSkills.has(entry.id) || (entry.phases ?? []).some((id) => removedSteps.has(id)));
  if (attachmentRows.length) cleanups.push({ kind: 'skill-attachments', rows: attachmentRows.length });
  const impact = await support.readYamlDocument(sourceRoot, IMPACT_STORE, { optional: true });
  const studies = located.governs === 'story' ? impactStudiesNaming(impact, located.id) : [];
  if (studies.length) cleanups.push({ kind: 'impact-eligibility', workflow: located.id, studies: studies.map(({ id }) => id) });
  if (workflowArchived(archive, located.governs, located.id)) cleanups.push({ kind: 'archive-entry', workflow: located.id });
  if (replacement) cleanups.push({ kind: 'default-workflow', from: located.id, to: replacement });
  const agentLock = await support.readAgentLock(sourceRoot).catch(() => null);
  const lockRows = [...removedAgents].filter((id) => Object.hasOwn(agentLock?.value?.agents ?? {}, id));
  if (lockRows.length) cleanups.push({ kind: 'agent-lock', agents: lockRows });
  const importsText = await readFile(path.join(sourceRoot, IMPORTS_LOCK_PATH), 'utf8').catch(() => null);
  const ledger = importsText ? parseImportsLedger(importsText) : null;
  const removedPaths = new Set(removedFiles);
  const importRows = Object.entries(ledger?.imports ?? {}).filter(([, record]) =>
    (record.kind === 'agent' && removedAgents.has(record.target?.id)) || removedPaths.has(record.target?.path) || removedPaths.has(record.path))
    .map(([key]) => key).sort();
  if (importRows.length) cleanups.push({ kind: 'imports-lock', imports: importRows });

  const core = { schemaVersion: 1, resultType: 'workflow-delete-plan', workflowId: located.id, governs: located.governs,
    selector: located.selector, ...(destination ? { destinationAuthority: destination.identity } : {}), removed, kept, trimmed, cleanups, ...(replacement ? { newDefault: replacement } : {}),
    unreadableWorkflows: unreadable };
  const plan = { ...core, planSha256: digest(core) };
  RETIREMENT_PLANS.set(plan, { selector: located.selector, newDefault, destination, removedSections, removedSteps, removedFiles,
    removedAgents, trimmed, attachmentRows, lockRows, importRows, replacement, archived: workflowArchived(archive, located.governs, located.id) });
  return plan;
}

/** The impact studies whose eligibility names `workflowId`, with their index in `studies`. */
function impactStudiesNaming(impact, workflowId) {
  const studies = Array.isArray(impact?.value?.studies) ? impact.value.studies : [];
  return studies.flatMap((study, index) => (study?.eligibility?.workTypes ?? []).includes(workflowId)
    ? [{ id: study.id ?? String(index), index, workTypes: study.eligibility.workTypes }] : []);
}

function removeAt(document, keys) {
  if (document.hasIn(keys)) document.deleteIn(keys);
}

/**
 * Apply a delete plan in `target` after re-planning it there and checking the same digest, so the
 * proposal removes exactly what was previewed. Returns the changed files.
 */
export async function applyWorkflowDelete(target, { selector, newDefault = null, expectedPlanSha256 }) {
  const plan = await planWorkflowDelete(target, { selector, newDefault });
  if (!expectedPlanSha256 || plan.planSha256 !== expectedPlanSha256) {
    fail('The delete plan changed or was not confirmed. Nothing changed. Preview it again and confirm it by the code it gives.',
      'WORKFLOW_DELETE_PLAN_STALE', { expected: expectedPlanSha256 ?? null, actual: plan.planSha256 });
  }
  const retained = RETIREMENT_PLANS.get(plan);
  const located = await support.locateWorkflow(target, selector);
  const root = located.root;
  const files = [];
  for (const governs of ['story', 'initiative']) {
    const source = located.documents[governs];
    if (!source) continue;
    const store = support.STORE[governs];
    const document = source.document.clone();
    for (const [key, ids] of Object.entries(retained.removedSections)) {
      const [owner, section] = key.split(':');
      if (owner !== governs) continue;
      for (const id of ids) removeAt(document, [...section.split('.'), id]);
    }
    if (governs === 'story') {
      const story = source.value;
      for (const [serverId, server] of Object.entries(story.mcpServers ?? {})) {
        if (!document.hasIn(['mcpServers', serverId]) || !Array.isArray(server?.phases)) continue;
        const kept = server.phases.filter((id) => !retained.removedSteps.has(id));
        if (kept.length !== server.phases.length) document.setIn(['mcpServers', serverId, 'phases'], kept);
      }
      if (Array.isArray(story.documents?.allowedPhases)) {
        const kept = story.documents.allowedPhases.filter((id) => !retained.removedSteps.has(id));
        if (kept.length !== story.documents.allowedPhases.length) document.setIn(['documents', 'allowedPhases'], kept);
      }
      for (const id of Object.keys(story.contextPolicy?.phaseOverrides ?? {})) {
        if (retained.removedSteps.has(id)) removeAt(document, ['contextPolicy', 'phaseOverrides', id]);
      }
      if (retained.replacement) document.setIn(['delivery', 'defaultWorkflowProfile'], retained.replacement);
    }
    const content = renderPreservingFormatting(source.text, document);
    if (content !== source.text) {
      store.validate?.(YAML.parse(content));
      files.push(await writeText(root, store.file, content));
    }
  }
  if (retained.attachmentRows.length) {
    const removedSkills = new Set(plan.removed.filter((entry) => entry.kind === 'skill').map((entry) => entry.id));
    const kept = (await readSkillAttachments(root)).flatMap((row) => {
      if ((located.governs === 'story' && row.workflow === located.id) || removedSkills.has(row.id)) return [];
      if (!(row.phases ?? []).some((id) => retained.removedSteps.has(id))) return [row];
      const phases = row.phases.filter((id) => !retained.removedSteps.has(id));
      return phases.length ? [{ ...row, phases }] : [];
    });
    const text = skillAttachmentsText(kept);
    if (text == null) await rm(await support.assertSafeTarget(root, SKILL_ATTACHMENTS_PATH), { force: true });
    else await writeText(root, SKILL_ATTACHMENTS_PATH, text);
    files.push(SKILL_ATTACHMENTS_PATH);
  }
  const impact = await support.readYamlDocument(root, IMPACT_STORE, { optional: true });
  const studies = located.governs === 'story' ? impactStudiesNaming(impact, located.id) : [];
  if (studies.length) {
    const document = impact.document.clone();
    for (const study of studies) document.setIn(['studies', study.index, 'eligibility', 'workTypes'], study.workTypes.filter((id) => id !== located.id));
    files.push(await writeText(root, IMPACT_PATH, renderPreservingFormatting(impact.text, document)));
  }
  if (retained.archived) {
    const archiveDocument = await support.readYamlDocument(root, ARCHIVE_STORE, { optional: true });
    const archive = parseWorkflowArchive(archiveDocument.text);
    delete archive[located.governs][located.id];
    files.push(await writeText(root, WORKFLOW_ARCHIVE_PATH, archiveText(archiveDocument, archive)));
  }
  if (retained.lockRows.length) {
    const lock = await support.readYamlDocument(root, AGENT_LOCK_STORE, { optional: true });
    if (lock) {
      const document = lock.document.clone();
      for (const id of retained.lockRows) removeAt(document, ['agents', id]);
      files.push(await writeText(root, AGENT_LOCK_PATH, renderPreservingFormatting(lock.text, document)));
    }
  }
  if (retained.importRows.length) {
    const text = await readFile(path.join(root, IMPORTS_LOCK_PATH), 'utf8');
    const ledger = parseImportsLedger(text);
    for (const key of retained.importRows) delete ledger.imports[key];
    files.push(await writeText(root, IMPORTS_LOCK_PATH, renderImportsLedger(ledger)));
  }
  for (const entry of retained.trimmed) {
    const file = await support.assertSafeTarget(root, entry.path);
    const text = await readFile(file, 'utf8');
    const scoped = support.phaseScopedAgentText(text, { has: (id) => !retained.removedSteps.has(id) });
    if (scoped !== text) files.push(await writeText(root, entry.path, scoped));
  }
  for (const relative of [...new Set(retained.removedFiles)].sort()) {
    const file = await support.assertSafeTarget(root, relative);
    await rm(file, { recursive: true, force: true });
    files.push(relative);
  }
  return { schemaVersion: 1, resultType: 'workflow-delete', status: 'deleted', workflowId: located.id,
    governs: located.governs, planSha256: plan.planSha256, removed: plan.removed.length, files: [...new Set(files)].sort(), changed: true };
}

// Stories ----------------------------------------------------------------------------------------

/**
 * The Stories that use a Story workflow, from the ledger's Story index: unfinished ones with a pinned
 * workflow copy keep running; an unfinished one without a copy runs from the live configuration and
 * blocks the delete. A Story whose copy cannot be read here is listed as unchecked, not blocking.
 */
export async function workflowDeleteStories(root, definition, workflowId, { ledgerStoryPointers = null } = {}) {
  let pointers;
  try {
    const read = ledgerStoryPointers ?? (await import('./ledger.mjs')).ledgerStoryPointers;
    pointers = await read(root, definition.ledger ?? {}, { offline: false })
      .catch(() => read(root, definition.ledger ?? {}, { offline: true }));
  } catch (error) {
    return { status: 'unavailable', reason: error.message, pinned: [], unpinned: [], unchecked: [] };
  }
  const workItemRoot = definition.workItemRoot ?? 'singularity/work-items';
  const result = { status: 'checked', pinned: [], unpinned: [], unchecked: [] };
  // Through git.mjs, the reviewed Git owner, not a new process site (scripts/git-bypass-audit.mjs).
  const { fileAtRef } = await import('./git.mjs');
  for (const story of pointers.items ?? []) {
    if (story.workType !== workflowId || TERMINAL_STORY_STATUSES.has(String(story.status).toLowerCase())) continue;
    const summary = { id: story.id, status: story.status, branch: story.branch };
    const shown = fileAtRef(root, story.commitOid, `${workItemRoot}/${story.id}/workflow.json`);
    if (shown == null) { result.unchecked.push(summary); continue; }
    let workflow = null;
    try { workflow = JSON.parse(shown); } catch { result.unchecked.push(summary); continue; }
    (workflow?.workflowSnapshot ? result.pinned : result.unpinned).push(summary);
  }
  return result;
}

/** The delete refuses while an unfinished Story without a pinned workflow copy uses the workflow. */
export function assertDeleteStoriesClear(stories, workflowId) {
  if (stories.unpinned?.length) {
    fail(`Workflow '${workflowId}' is used by ${stories.unpinned.length} unfinished Stor${stories.unpinned.length === 1 ? 'y' : 'ies'} `
      + `that run from the live configuration: ${stories.unpinned.map((story) => story.id).join(', ')}. Finish or cancel them, or archive the workflow instead.`,
    'WORKFLOW_DELETE_STORIES_UNPINNED', { stories: stories.unpinned,
      nextAction: { command: `singularity-flow workflow archive ${workflowId} --propose --json` } });
  }
}

/**
 * The proposal mutation for a confirmed plan, only from a plan this module captured. Like a workflow
 * transfer, it re-checks the approved destination the preview read, re-plans in the proposal's scratch
 * checkout under that same scope, refuses a different digest, and validates the result there.
 */
export function workflowDeleteProposal(plan, { expectedPlanSha256, requireApprovedDestination = false, validate = null } = {}) {
  const retained = RETIREMENT_PLANS.get(plan);
  if (!retained) fail('A workflow delete needs a freshly captured plan. Preview it again.', 'WORKFLOW_DELETE_PLAN_INVALID');
  if (!expectedPlanSha256 || plan.planSha256 !== expectedPlanSha256) {
    fail('The delete plan changed or was not confirmed. Nothing changed. Preview it again and confirm it by the code it gives.',
      'WORKFLOW_DELETE_PLAN_STALE', { expected: expectedPlanSha256 ?? null, actual: plan.planSha256 });
  }
  const { destination } = retained;
  if (requireApprovedDestination && !destination) {
    fail('No exact approved configuration is available to propose this delete against. Refresh configuration and preview again.',
      'WORKFLOW_DELETE_DESTINATION_UNAVAILABLE');
  }
  const input = { selector: retained.selector, newDefault: retained.newDefault, expectedPlanSha256 };
  const mutate = async (target) => {
    const apply = async () => {
      const applied = await applyWorkflowDelete(target, input);
      if (validate) await validate(target);
      return applied;
    };
    if (!destination) return apply();
    let actualCommit = null;
    try { actualCommit = executeGitQuery(target, 'repository.head'); } catch { /* A non-Git target cannot prove this base. */ }
    if (actualCommit !== destination.identity.sourceCommit) {
      fail('The approved configuration changed since the preview. Preview the delete again.', 'WORKFLOW_DELETE_DESTINATION_CHANGED', {
        expectedCommit: destination.identity.sourceCommit, actualCommit
      });
    }
    return withConfigurationReadRoot(target, target, destination.authority, apply, {
      assetPolicy: destination.assetPolicy, configurationSnapshot: destination.configurationSnapshot
    });
  };
  const expectedAuthority = destination ? { kind: destination.identity.kind, commit: destination.identity.commit,
    sourceCommit: destination.identity.sourceCommit, remoteFingerprint: destination.identity.remoteFingerprint } : null;
  return { expectedAuthority, mutate };
}

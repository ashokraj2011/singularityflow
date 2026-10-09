/**
 * `wm migrate-views`: rewrite retired legacy-v3 World Model view names to registered views.
 *
 * Loading already drops retired names, so nothing refuses a repository that still has them; it
 * just gets no World Model where only retired views were assigned. This command restores the World
 * Model there. It rewrites the governed configuration in the working tree, keeping each file's
 * formatting: `singularity/workflow.yml` (format, catalog, phase and workflow-override
 * assignments, injection includes), `singularity/portfolio.yml` (Initiative assignments) and the
 * `sflow-world-model-views` metadata of `.github/agents/*.md`. Each retired name becomes its
 * successor (LEGACY_WORLD_MODEL_VIEW_SUCCESSORS); `release` and `operations` have none and are
 * removed. The edit is then published like any configuration change (`config publish`).
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { discoverAgents } from './agents.mjs';
import { loadDefinition, WORKFLOW_PATH } from './config.mjs';
import { loadPortfolio, PORTFOLIO_PATH } from './initiative-config.mjs';
import { optionBoolean, optionString, SingularityFlowError } from './util.mjs';
import { BUILTIN_VIEW_IDS, normalizeBuiltInViewReference } from './world-model/registry/views.mjs';
import {
  isRetiredWorldModelView, LEGACY_WORLD_MODEL_VIEW_SUCCESSORS, retiredWorldModelReferences, worldModelAssignmentViews
} from './world-model-views.mjs';
import { WORLD_MODEL_FORMAT } from './world-model-format.mjs';
import { renderDataPreservingFormatting } from './yaml-formatting.mjs';

const AGENTS_ROOT = '.github/agents';
const AGENT_VIEWS = /^(\s*sflow-world-model-views:\s*)(["']?)([^"'\n]*)\2[ \t]*$/m;
const INJECTED_VIEW = /^views\/([a-z0-9]+(?:[.-][a-z0-9]+)*)\.md$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** An assignment with each retired name replaced by its successor, in order, without duplicates. */
function migrated(views, location, changes) {
  if (!Array.isArray(views) || !views.some(isRetiredWorldModelView)) return views;
  const result = [];
  for (const view of worldModelAssignmentViews(views)) {
    const next = isRetiredWorldModelView(view) ? LEGACY_WORLD_MODEL_VIEW_SUCCESSORS[view] : view;
    if (isRetiredWorldModelView(view)) changes.push({ location, from: view, to: next });
    if (next && !result.includes(next)) result.push(next);
  }
  return result;
}

async function readOptional(root, relative) {
  const absolute = path.join(root, relative);
  const info = await lstat(absolute).catch(() => null);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new SingularityFlowError(`${relative} must be a regular file to migrate it.`);
  return readFile(absolute, 'utf8');
}

function migrateWorkflow(data, changes) {
  const worldModel = data.worldModel && typeof data.worldModel === 'object' ? data.worldModel : null;
  if (worldModel?.format === 'legacy-v3') {
    changes.push({ location: 'worldModel.format', from: 'legacy-v3', to: WORLD_MODEL_FORMAT });
    worldModel.format = WORLD_MODEL_FORMAT;
  }
  if (worldModel?.v4?.legacyAssignments === 'inherit-configured') {
    changes.push({ location: 'worldModel.v4.legacyAssignments', from: 'inherit-configured', to: 'strict' });
    worldModel.v4.legacyAssignments = 'strict';
  }
  for (const [phaseId, phase] of Object.entries(data.phases ?? {})) {
    if (Array.isArray(phase?.worldModel?.views)) phase.worldModel.views = migrated(phase.worldModel.views, `phase '${phaseId}'`, changes);
  }
  for (const [workTypeId, workType] of Object.entries(data.workTypes ?? {})) {
    for (const [phaseId, override] of Object.entries(workType?.phaseOverrides ?? {})) {
      if (Array.isArray(override?.worldModel?.views)) {
        override.worldModel.views = migrated(override.worldModel.views, `workflow '${workTypeId}' phase '${phaseId}' override`, changes);
      }
    }
  }
  if (Array.isArray(worldModel?.injection?.rules)) {
    // A rule includes a view's rendered Markdown; a retired view has none to include any more.
    for (const [index, rule] of worldModel.injection.rules.entries()) {
      if (!Array.isArray(rule?.include)) continue;
      rule.include = rule.include.filter((entry) => {
        const view = String(entry).match(INJECTED_VIEW)?.[1]?.replace(/\.(?:brief|full)$/, '');
        if (!view || !isRetiredWorldModelView(view)) return true;
        changes.push({ location: `worldModel.injection.rules[${index}].include`, from: String(entry), to: null });
        return false;
      });
    }
    worldModel.injection.rules = worldModel.injection.rules.filter((rule) => !Array.isArray(rule?.include) || rule.include.length);
  }
}

/** Declare every view an assignment uses: the catalog is the repository's list of enabled views. */
function migrateCatalog(data, used, changes) {
  const worldModel = data.worldModel;
  if (!worldModel || typeof worldModel !== 'object' || !Array.isArray(worldModel.views)) return;
  const original = worldModel.views.map(String);
  // A catalog of retired names only enabled every legacy view, and loading it today enables every
  // registered one: keep that.
  if (original.every(isRetiredWorldModelView)) {
    worldModel.views = BUILTIN_VIEW_IDS.map((view) => normalizeBuiltInViewReference(view).reference);
    for (const view of original) {
      const successor = LEGACY_WORLD_MODEL_VIEW_SUCCESSORS[view];
      changes.push({ location: 'worldModel.views', from: view, to: successor ? normalizeBuiltInViewReference(successor).reference : null });
    }
    for (const reference of worldModel.views) {
      if (!original.some((view) => LEGACY_WORLD_MODEL_VIEW_SUCCESSORS[view] && normalizeBuiltInViewReference(LEGACY_WORLD_MODEL_VIEW_SUCCESSORS[view]).reference === reference)) {
        changes.push({ location: 'worldModel.views', from: null, to: reference });
      }
    }
    return;
  }
  const catalog = [];
  const ids = new Set();
  const add = (view) => {
    let normalized;
    // An unregistered view is left for the configuration validator to name; it is not migrated.
    try { normalized = normalizeBuiltInViewReference(view); } catch { if (!catalog.includes(view)) catalog.push(view); return; }
    if (ids.has(normalized.viewId)) return;
    ids.add(normalized.viewId);
    catalog.push(view === normalized.viewId ? normalized.reference : view);
  };
  for (const view of original) {
    if (!isRetiredWorldModelView(view)) { add(view); continue; }
    const successor = LEGACY_WORLD_MODEL_VIEW_SUCCESSORS[view];
    changes.push({ location: 'worldModel.views', from: view, to: successor ? normalizeBuiltInViewReference(successor).reference : null });
    if (successor) add(successor);
  }
  for (const view of [...used].sort()) {
    let reference;
    try { reference = normalizeBuiltInViewReference(view); } catch { continue; }
    if (ids.has(reference.viewId)) continue;
    add(view);
    changes.push({ location: 'worldModel.views', from: null, to: reference.reference });
  }
  // Only retired views were listed and nothing uses a registered one: enable them all.
  if (!catalog.length) for (const view of BUILTIN_VIEW_IDS) add(view);
  if (JSON.stringify(catalog) !== JSON.stringify(original)) worldModel.views = catalog;
}

/**
 * The migration of this checkout's configuration: each file's new text and its changes. Pure over
 * the files read; nothing is written.
 */
export async function planWorldModelViewMigration(root) {
  const files = [];
  const used = new Set();
  const workflowText = await readOptional(root, WORKFLOW_PATH);
  let workflow = null;
  if (workflowText != null) {
    const before = YAML.parse(workflowText) ?? {};
    const data = structuredClone(before);
    const changes = [];
    migrateWorkflow(data, changes);
    for (const phase of Object.values(data.phases ?? {})) for (const view of worldModelAssignmentViews(phase?.worldModel?.views)) used.add(view);
    for (const workType of Object.values(data.workTypes ?? {})) {
      for (const override of Object.values(workType?.phaseOverrides ?? {})) for (const view of worldModelAssignmentViews(override?.worldModel?.views)) used.add(view);
    }
    workflow = { before, data, changes };
  }
  const portfolioText = await readOptional(root, PORTFOLIO_PATH);
  if (portfolioText != null) {
    const before = YAML.parse(portfolioText) ?? {};
    const data = structuredClone(before);
    const changes = [];
    for (const [phaseId, phase] of Object.entries(data.initiativePhases ?? {})) {
      if (Array.isArray(phase?.worldModelViews)) phase.worldModelViews = migrated(phase.worldModelViews, `Initiative phase '${phaseId}'`, changes);
      for (const view of worldModelAssignmentViews(phase?.worldModelViews)) used.add(view);
    }
    for (const [profileId, profile] of Object.entries(data.initiativeProfiles ?? {})) {
      for (const [phaseId, override] of Object.entries(profile?.phaseOverrides ?? {})) {
        if (Array.isArray(override?.worldModelViews)) {
          override.worldModelViews = migrated(override.worldModelViews, `Initiative profile '${profileId}' phase '${phaseId}'`, changes);
        }
        for (const view of worldModelAssignmentViews(override?.worldModelViews)) used.add(view);
      }
    }
    if (changes.length) files.push({ path: PORTFOLIO_PATH, before: portfolioText, after: renderDataPreservingFormatting(portfolioText, data, { before }), changes });
  }
  const agentEntries = await readdir(path.join(root, AGENTS_ROOT), { withFileTypes: true }).catch(() => []);
  for (const entry of agentEntries.filter((item) => item.isFile() && item.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${AGENTS_ROOT}/${entry.name}`;
    const text = await readOptional(root, relative);
    const match = text?.match(AGENT_VIEWS);
    if (!match) continue;
    const changes = [];
    const views = migrated(match[3].split(',').map((view) => view.trim()).filter(Boolean), `agent ${entry.name}`, changes);
    for (const view of views) if (!isRetiredWorldModelView(view)) used.add(view);
    if (!changes.length) continue;
    const after = views.length
      ? text.replace(AGENT_VIEWS, `${match[1]}${match[2] || '"'}${views.join(',')}${match[2] || '"'}`)
      : text.replace(new RegExp(`${AGENT_VIEWS.source}\\n?`, 'm'), '');
    files.push({ path: relative, before: text, after, changes });
  }
  // Bundled agents count too: the catalog must declare every view any agent in use names.
  for (const agent of await discoverAgents(root).catch(() => [])) {
    for (const view of agent.worldModelViews ?? []) {
      const next = isRetiredWorldModelView(view) ? LEGACY_WORLD_MODEL_VIEW_SUCCESSORS[view] : view;
      if (next) used.add(next);
    }
  }
  if (workflow) {
    migrateCatalog(workflow.data, used, workflow.changes);
    if (workflow.changes.length) {
      files.unshift({ path: WORKFLOW_PATH, before: workflowText, after: renderDataPreservingFormatting(workflowText, workflow.data, { before: workflow.before }), changes: workflow.changes });
    }
  }
  const digest = sha256(JSON.stringify(files.map((file) => [file.path, sha256(file.before), sha256(file.after)])));
  return { files, digest, confirmation: `MIGRATE WORLD MODEL VIEWS ${digest.slice(0, 12)}` };
}

function summary(plan) {
  return plan.files.map((file) => ({ path: file.path, changes: file.changes }));
}

/**
 * Preview (`--dry-run`) or apply (`--confirm PHRASE`) the migration. Applying writes the files,
 * then loads the configuration again; if it no longer loads, every file is restored.
 */
export async function worldModelViewMigrationCommand(root, options = {}) {
  const plan = await planWorldModelViewMigration(root);
  const publish = 'singularity-flow config publish --message "Migrate World Model views to registered views"';
  const result = {
    operation: 'wm-migrate-views',
    files: summary(plan),
    changes: plan.files.reduce((count, file) => count + file.changes.length, 0)
  };
  if (!plan.files.length) {
    return report({ ...result, status: 'current', message: 'No retired legacy-v3 World Model view names are configured.' }, options);
  }
  if (optionBoolean(options, 'dry-run') || !optionString(options, 'confirm')) {
    return report({
      ...result, status: 'planned', dryRun: true, confirmation: plan.confirmation,
      next: `singularity-flow wm migrate-views --confirm "${plan.confirmation}"`
    }, options);
  }
  if (optionString(options, 'confirm') !== plan.confirmation) {
    throw new SingularityFlowError(`wm migrate-views requires --confirm "${plan.confirmation}" for the configuration as it is now.`, {
      code: 'WM_MIGRATE_VIEWS_CONFIRMATION_REQUIRED'
    });
  }
  for (const file of plan.files) await writeFile(path.join(root, file.path), file.after);
  try {
    const definition = await loadDefinition(root);
    await loadPortfolio(root, { required: false });
    const left = retiredWorldModelReferences(definition);
    if (left.length) throw new SingularityFlowError(`Retired view names remain: ${left.map((entry) => `${entry.source}=${entry.value}`).join('; ')}.`);
  } catch (error) {
    for (const file of plan.files) await writeFile(path.join(root, file.path), file.before);
    throw new SingularityFlowError(`The migrated configuration does not load, so every file was restored: ${error.message}`, {
      code: 'WM_MIGRATE_VIEWS_INVALID', cause: error
    });
  }
  return report({ ...result, status: 'migrated', applied: true, next: publish }, options);
}

function report(result, options) {
  if (optionBoolean(options, 'json')) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (result.status === 'current') {
    console.log(result.message);
    return result;
  }
  console.log(`${result.status === 'migrated' ? 'Migrated' : 'Would migrate'} ${result.changes} retired World Model view reference(s):`);
  for (const file of result.files) {
    console.log(`  ${file.path}`);
    for (const change of file.changes) console.log(`    ${change.location}: ${change.from ?? '(none)'} -> ${change.to ?? '(removed)'}`);
  }
  console.log(`Next: ${result.next}`);
  return result;
}

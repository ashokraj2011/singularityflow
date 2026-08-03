import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { loadDefinition, validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { exists, writeText } from './util.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const starterPath = path.join(packageRoot, 'templates', 'workflow.yml');

async function starterDefinition() { return validateDefinition(YAML.parse(await readFile(starterPath, 'utf8'))); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function stable(value) { return JSON.stringify(canonical(value), null, 2); }

/**
 * Every workflow this repository runs, plus the packaged ones it could install.
 *
 * It used to iterate only the packaged set, so a workflow somebody wrote themselves never appeared
 * — `workflow create quick-fix` reported success and `workflow list` then did not mention it. A
 * catalog that omits what you just made is not a catalog of what you have.
 */
export async function workflowCatalog(root) {
  const [installed, starter] = await Promise.all([loadDefinition(root), starterDefinition()]);
  const packaged = Object.entries(starter.workTypes).map(([id, profile]) => {
    const current = installed.workTypes[id];
    return { id, label: profile.label, phases: profile.phases, status: !current ? 'available' : stable(current) === stable(profile) ? 'current' : 'customized', installed: Boolean(current) };
  });
  // Anything defined here that no packaged workflow claims: written by this team, for this
  // repository, and every bit as real as the ones that shipped with the product.
  const local = Object.entries(installed.workTypes)
    .filter(([id]) => !starter.workTypes[id])
    .map(([id, profile]) => ({
      id, label: profile.label ?? id, phases: profile.phases ?? [], status: 'local', installed: true
    }));
  return [...packaged, ...local];
}

export async function simulateWorkflow(root, workType = null) {
  const definition = await loadDefinition(root);
  const ids = workType ? [workType] : Object.keys(definition.workTypes);
  return ids.map((id) => {
    const profile = definition.workTypes[id];
    if (!profile) throw new Error(`Unknown workflow '${id}'.`);
    const phases = profile.phases.map((phaseId, index) => {
      const base = definition.phases[phaseId]; const override = profile.phaseOverrides?.[phaseId] ?? {};
      const approval = override.approval ?? base.approval ?? {};
      return { order: index + 1, id: phaseId, label: base.label, template: profile.templateOverrides?.[phaseId] ?? base.defaultTemplate, inputs: (override.inputs ?? base.inputs ?? []).map((input) => typeof input === 'string' ? input : input.phase), authorities: approval.authorities ?? [], minimumApprovals: approval.minimum ?? 1, qualityCommands: override.qualityCommands ?? base.qualityCommands ?? [], worldModelViews: override.worldModel?.views ?? base.worldModel?.views ?? [] };
    });
    return { id, label: profile.label, inputsMode: definition.inputsMode ?? 'off', documents: profile.documents ?? definition.documents ?? {}, sequenceGates: { ...(definition.sequenceGates ?? {}), ...(profile.sequenceGates ?? {}) }, phases };
  });
}

export function simulationText(simulations) {
  const lines = [];
  for (const simulation of simulations) {
    lines.push(`${simulation.label} (${simulation.id})`, `Inputs: ${simulation.inputsMode}`, '');
    for (const phase of simulation.phases) lines.push(`${String(phase.order).padStart(2)}. ${phase.label} [${phase.id}]`, `    template=${phase.template} · inputs=${phase.inputs.join(', ') || 'none'} · approvals=${phase.minimumApprovals} (${phase.authorities.join(', ') || 'none'}) · world-model=${phase.worldModelViews.join(', ') || 'none'}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export async function installWorkflow(root, id, { replace = false, dryRun = false } = {}) {
  const installed = await loadDefinition(root); const starter = await starterDefinition(); const profile = starter.workTypes[id];
  if (!profile) throw new Error(`Workflow '${id}' is not in the bundled catalog.`);
  if (installed.workTypes[id] && !replace) throw new Error(`Workflow '${id}' already exists. Use workflow diff ${id}, or --replace after reviewing customizations.`);
  const next = structuredClone(installed); next.workTypes[id] = structuredClone(profile);
  const phaseIds = new Set(profile.phases);
  for (const phaseId of phaseIds) next.phases[phaseId] ??= structuredClone(starter.phases[phaseId]);
  const authorityIds = new Set();
  for (const phaseId of phaseIds) {
    for (const authority of starter.phases[phaseId].approval?.authorities ?? []) authorityIds.add(authority);
  }
  next.approvalAuthorities ??= {};
  for (const authority of authorityIds) {
    next.approvalAuthorities[authority] ??= structuredClone(starter.approvalAuthorities[authority]);
  }
  validateDefinition(next);
  const files = [];
  for (const phaseId of phaseIds) {
    const template = profile.templateOverrides?.[phaseId] ?? starter.phases[phaseId].defaultTemplate;
    if (!template?.startsWith('agent:')) files.push({ source: path.join(packageRoot, 'templates', 'artifacts', template), target: path.join(root, installed.templatesRoot, template) });
  }
  const copied = [];
  for (const file of files) if (replace || !(await exists(file.target))) copied.push(path.relative(root, file.target).replaceAll(path.sep, '/'));
  const changedFiles = [WORKFLOW_PATH, ...copied];
  if (!dryRun) {
    await writeText(path.join(root, WORKFLOW_PATH), YAML.stringify(next));
    for (const file of files) if (replace || !(await exists(file.target))) { await mkdir(path.dirname(file.target), { recursive: true }); await cp(file.source, file.target); }
  }
  return { id, dryRun, replace, files: changedFiles };
}

export async function workflowDiff(root, id) {
  const installed = await loadDefinition(root); const starter = await starterDefinition();
  if (!starter.workTypes[id]) throw new Error(`Workflow '${id}' is not in the bundled catalog.`);
  return { id, installed: installed.workTypes[id] ?? null, bundled: starter.workTypes[id], equal: stable(installed.workTypes[id]) === stable(starter.workTypes[id]) };
}

import path from 'node:path';
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import YAML from 'yaml';
import { parseAgentDependencies } from './agents.mjs';
import { loadDefinition, resolveWorkType, validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { exists, SingularityFlowError, writeText } from './util.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';

const starterPath = path.join(PACKAGE_ROOT, 'templates', 'workflow.yml');

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
  for (const phaseId of phaseIds) {
    // `--replace` is an explicit decision to take the bundled workflow contract. Replacing only
    // the work-type row while retaining stale shared phase policy made the command claim success
    // while generation, approval and evidence behavior remained on the old release.
    if (replace || !next.phases[phaseId]) next.phases[phaseId] = structuredClone(starter.phases[phaseId]);
  }
  const authorityIds = new Set();
  for (const phaseId of phaseIds) {
    for (const authority of starter.phases[phaseId].approval?.authorities ?? []) authorityIds.add(authority);
  }
  next.approvalAuthorities ??= {};
  for (const authority of authorityIds) {
    next.approvalAuthorities[authority] ??= structuredClone(starter.approvalAuthorities[authority]);
  }
  // A packaged workflow is not usable when its browser/tool policy remains stranded in the
  // starter definition. Merge only servers assigned to one of the installed phases, preserving
  // repository host/approval choices while adding the packaged phase, agent, tool, and evidence
  // contract. This is especially important for profiles added after a repository was initialized.
  next.mcpServers ??= {};
  for (const [serverId, packaged] of Object.entries(starter.mcpServers ?? {})) {
    if (!(packaged.phases ?? []).some((phase) => phaseIds.has(phase))) continue;
    const current = next.mcpServers[serverId];
    if (!current) {
      next.mcpServers[serverId] = structuredClone(packaged);
      continue;
    }
    next.mcpServers[serverId] = {
      ...current,
      agents: [...new Set([...(current.agents ?? []), ...(packaged.agents ?? [])])],
      phases: [...new Set([...(current.phases ?? []), ...(packaged.phases ?? []).filter((phase) => phaseIds.has(phase))])],
      tools: [...new Set([...(current.tools ?? []), ...(packaged.tools ?? [])])],
      evidence: {
        captureToolCalls: current.evidence?.captureToolCalls !== false || packaged.evidence?.captureToolCalls === true,
        captureResults: current.evidence?.captureResults === true || packaged.evidence?.captureResults === true
      }
    };
  }
  validateDefinition(next);
  const files = [];
  for (const phaseId of phaseIds) {
    const template = profile.templateOverrides?.[phaseId] ?? starter.phases[phaseId].defaultTemplate;
    if (!template?.startsWith('agent:')) files.push({ source: path.join(PACKAGE_ROOT, 'templates', 'artifacts', template), target: path.join(root, installed.templatesRoot, template), overwrite: replace });
  }
  // Copy the default packaged agent modules that make the new phases immediately selectable.
  // Existing repository agents always win discovery and are never overwritten by workflow install.
  for (const entry of await readdir(path.join(PACKAGE_ROOT, 'templates', 'agents'), { withFileTypes: true })) {
    if (!entry.isFile() || !/(?:\.agent)?\.md$/i.test(entry.name)) continue;
    const source = path.join(PACKAGE_ROOT, 'templates', 'agents', entry.name);
    const agent = parseAgentDependencies(await readFile(source, 'utf8'), { source });
    if (agent.defaultFor.some((phase) => phaseIds.has(phase))) {
      files.push({ source, target: path.join(root, '.github', 'agents', entry.name), overwrite: false });
    }
  }
  const copied = [];
  for (const file of files) if (file.overwrite || !(await exists(file.target))) copied.push(path.relative(root, file.target).replaceAll(path.sep, '/'));
  const changedFiles = [WORKFLOW_PATH, ...copied];
  if (!dryRun) {
    await writeText(path.join(root, WORKFLOW_PATH), YAML.stringify(next));
    for (const file of files) if (file.overwrite || !(await exists(file.target))) { await mkdir(path.dirname(file.target), { recursive: true }); await cp(file.source, file.target); }
  }
  return { id, dryRun, replace, files: changedFiles };
}

export async function workflowDiff(root, id) {
  const installed = await loadDefinition(root); const starter = await starterDefinition();
  if (!starter.workTypes[id]) throw new Error(`Workflow '${id}' is not in the bundled catalog.`);
  return { id, installed: installed.workTypes[id] ?? null, bundled: starter.workTypes[id], equal: stable(installed.workTypes[id]) === stable(starter.workTypes[id]) };
}

/**
 * Validate and explain the planned-claim contract for every Story workflow.
 *
 * `loadDefinition` performs structural validation first. A pre-contract custom workflow remains
 * readable as `migration-required` so it cannot hide every other workflow or strand historical
 * Stories; this report returns invalid and Story start refuses it. Current authored workflows fail
 * closed before write. The report makes the topology visible instead of reducing validation to a
 * silent exit code.
 */
export async function validateWorkflowCatalog(root, requestedId = null) {
  const definition = await loadDefinition(root);
  const ids = requestedId == null ? Object.keys(definition.workTypes) : [requestedId];
  for (const id of ids) if (!definition.workTypes[id]) throw new SingularityFlowError(`Unknown workflow '${id}'.`);
  const workflows = ids.map((id) => {
    const resolved = resolveWorkType(definition, id);
    const plannedClaims = resolved.plannedClaims;
    return {
      id,
      label: resolved.label,
      status: plannedClaims.mode === 'required'
        ? 'protected'
        : plannedClaims.mode === 'legacy-opt-out'
          ? 'legacy-compatibility'
          : plannedClaims.mode === 'migration-required'
            ? 'migration-required'
            : plannedClaims.mode === 'opt-out'
              ? 'explicit-opt-out'
              : 'not-applicable',
      clausePhases: plannedClaims.clausePhases,
      owners: plannedClaims.owners,
      reason: plannedClaims.reason ?? plannedClaims.disabledBecause ?? null
    };
  });
  return {
    valid: workflows.every((workflow) => workflow.status !== 'migration-required'),
    workflows
  };
}

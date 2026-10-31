/**
 * `workflow validate`: is each workflow correct as the platform judges it, why not, and how to fix it?
 *
 * One answer from two engines that used to disagree. The planned-claims and obligation report
 * (validateWorkflowCatalog: which steps define the clauses, which plan each code step, which
 * responsibilities every route guarantees) is kept field for field; `workflow check`'s located
 * findings (src/workflow-check.mjs, the same ones Workflow Studio and the workflow builder show,
 * templates included) are added per workflow. A workflow is valid only when the old report says so
 * and no finding is a `problem`; a configuration that does not load is a result with its located
 * findings, never a bare refusal.
 *
 * Read-only. The fixes are drafted elsewhere: Copilot's /sf-fix-workflow turns the findings into one
 * Workflow Studio change set at `fixDraft.changeSetPath` and proposes it for review.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { loadDefinition } from './config.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { STUDIO_CHANGE_SET_SCHEMA } from './workflow-studio.mjs';
import { checkWorkflowConfiguration } from './workflow-check.mjs';
import { validateWorkflowCatalog } from './workflow-catalog.mjs';
import { workflowBuildStateRoot } from './workflow-build/store.mjs';

const SEVERITIES = ['problem', 'warning', 'note'];
const countsOf = (findings) => Object.fromEntries(SEVERITIES.map((severity) => [severity, findings.filter((entry) => entry.severity === severity).length]));
const uniqueById = (findings) => [...new Map(findings.map((entry) => [entry.id, entry])).values()];

/** The private file a fix draft for this repository (and workflow) goes in: outside the repository, never created here. */
export function workflowFixDraftPath(root, workflowId = null, { env = process.env } = {}) {
  let resolved = path.resolve(root);
  try { resolved = realpathSync.native(resolved); } catch { /* the path as given */ }
  const repository = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  return path.join(workflowBuildStateRoot(env), 'workflow-fixes', repository, `${workflowId ?? 'all-workflows'}.change-set.json`);
}

/** What each step holds, and whether it defines the clause anchors, plans claims, or carries the code's tags. */
function stepRoles(entry, explanation) {
  const labels = new Map((explanation?.steps ?? []).map((step) => [step.id, step.label]));
  const codeSteps = new Set(Object.keys(entry.owners ?? {}));
  return (entry.obligations?.steps ?? []).map((step) => ({
    id: step.id, label: labels.get(step.id) ?? step.id, responsibilities: step.responsibilities,
    definesClauses: (entry.clausePhases ?? []).includes(step.id),
    plansClaimsFor: Object.entries(entry.owners ?? {}).filter(([, owner]) => owner === step.id).map(([code]) => code),
    // Its code carries @clause:<WORK>:REQ-001 comments and its tests @ac:<WORK>:AC-001 tags.
    carriesTags: entry.status === 'protected' && codeSteps.has(step.id)
  }));
}

/** The route to the fixes: Copilot drafts them, Workflow Studio shows them, the Shell lists them again. */
function fixAction(workflowId) {
  const command = `singularity-flow workflow validate${workflowId ? ` ${workflowId}` : ''}`;
  const commandGuidance = safeCommandGuidance({ command, skill: '/sf-fix-workflow' });
  return {
    label: 'Fix the workflow',
    command,
    skill: '/sf-fix-workflow',
    copilotCommand: commandGuidance?.copilotCommand ?? `/sf-fix-workflow${workflowId ? ` ${workflowId}` : ''}`,
    commandGuidance,
    workflowStudio: 'In VS Code, open Workflow Studio (Singularity Flow: Workflow Studio), choose the workflow and press Check.',
    reviewed: 'Copilot drafts every fix as one configuration proposal; nothing changes until it is reviewed and activated.'
  };
}

/**
 * Validate the workflows at `root` (all, or `workflow`). Throws only for an unknown workflow
 * (WORKFLOW_UNKNOWN, naming the workflows there).
 */
export async function validateWorkflows(root, { workflow = null, env = process.env } = {}) {
  const check = await checkWorkflowConfiguration(root, workflow ? { workflows: [workflow] } : {});
  // Checked without agents when only a step's agent stops the configuration from loading.
  const definition = check.configuration.valid ? await loadDefinition(root)
    : check.workflows.length ? await loadDefinition(root, { storyBootstrap: true }).catch(() => null) : null;
  const catalog = definition ? await validateWorkflowCatalog(root, workflow, { definition }) : { valid: false, workflows: [] };
  const checked = new Map(check.workflows.map((entry) => [entry.id, entry]));
  const repositoryFindings = check.repository.findings;
  const workflows = catalog.workflows.map((entry) => {
    const own = checked.get(entry.id);
    // A finding about the repository (a step no agent drafts) belongs to every workflow that uses the step.
    const findings = uniqueById([...(own?.findings ?? []),
      ...repositoryFindings.filter((finding) => (finding.subject?.workflows ?? []).includes(entry.id))]);
    const counts = countsOf(findings);
    return {
      ...entry,
      valid: entry.status !== 'migration-required' && entry.obligations.startable && counts.problem === 0,
      counts, findings,
      roles: stepRoles(entry, own?.explanation)
    };
  });
  const all = uniqueById([...workflows.flatMap((entry) => entry.findings), ...repositoryFindings]);
  const counts = countsOf(all);
  const valid = check.configuration.valid && catalog.valid && counts.problem === 0;
  const invalid = workflows.filter((entry) => !entry.valid).map((entry) => entry.id);
  const target = workflow ?? (invalid.length === 1 ? invalid[0] : null);
  return {
    schemaVersion: 1, resultType: 'workflow-validation',
    valid,
    configuration: check.configuration,
    counts,
    blocksStart: all.some((entry) => entry.blocksStart && entry.severity === 'problem'),
    workflows,
    repository: { counts: countsOf(repositoryFindings), findings: repositoryFindings },
    ...(valid ? {} : {
      nextAction: fixAction(target),
      fixDraft: { workflow: target, schema: STUDIO_CHANGE_SET_SCHEMA, changeSetPath: workflowFixDraftPath(root, target, { env }) }
    })
  };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const where = (location) => (location ? `  (${location.file}${location.line ? `:${location.line}` : ''})` : '');
const indented = (text, indent) => String(text).split('\n').join(`\n${indent}`);

/** Where a problem stops a Story: at its start, or at one step. */
function stopsText(entry, labelOf, start) {
  if (entry.blocksStart) return start;
  const step = entry.stopsAt?.step ? labelOf(entry.stopsAt.step) : null;
  if (!step) return null;
  return { publication: `A Story stops when ${step} is published.`, entry: `A Story stops when it enters ${step}.`,
    rejection: `A Story stops when ${step} is rejected.` }[entry.stopsAt.when] ?? null;
}

/** Problems and warnings in full; notes are counted (`workflow check` lists them). */
function findingLines(findings, labelOf, { indent = '  ', start = 'Story start refuses this workflow.' } = {}) {
  const lines = [];
  for (const entry of findings.filter((finding) => finding.severity !== 'note')) {
    lines.push(`${indent}${entry.severity.padEnd(8)} ${entry.title}${where(entry.location)}`);
    const detail = entry.detail && entry.detail !== entry.title ? entry.detail : null;
    // A detail that already says where the Story stops is not told twice.
    const stops = entry.severity === 'problem' && !/\bstops when\b/iu.test(detail ?? '') ? stopsText(entry, labelOf, start) : null;
    const why = [detail, stops].filter(Boolean).join(' ');
    if (why) lines.push(`${indent}         Why: ${indented(why, `${indent}              `)}`);
    if (entry.fix?.text) lines.push(`${indent}         Fix: ${indented(entry.fix.text, `${indent}              `)}`);
  }
  return lines;
}

/** The text `workflow validate` prints after its table. */
export function validationFindingLines(result) {
  const lines = [];
  for (const workflow of result.workflows) {
    const labelOf = (id) => workflow.roles.find((step) => step.id === id)?.label ?? id;
    const shown = findingLines(workflow.findings, labelOf);
    const notes = workflow.counts.note;
    if (!shown.length && !notes) continue;
    lines.push('', `${workflow.label} (${workflow.id}): ${workflow.valid ? 'valid' : 'not valid'}; ${plural(workflow.counts.problem, 'problem')}, ${plural(workflow.counts.warning, 'warning')}, ${plural(notes, 'note')}.`);
    lines.push(...shown);
    if (notes) lines.push(`  ${plural(notes, 'note')}: singularity-flow workflow check ${workflow.id} lists ${notes === 1 ? 'it' : 'them'}.`);
  }
  const attributed = new Set(result.workflows.flatMap((workflow) => workflow.findings.map((entry) => entry.id)));
  const own = result.repository.findings.filter((entry) => !attributed.has(entry.id) && entry.severity !== 'note');
  const blocking = own.filter((entry) => entry.blocksStart);
  const rest = own.filter((entry) => !entry.blocksStart);
  if (blocking.length) {
    lines.push('', 'The workflow configuration cannot be read until these are fixed:',
      ...findingLines(blocking, (id) => id, { start: 'No command can read the configuration, so no Story can start.' }));
  }
  if (rest.length) lines.push('', 'Agents, skills and instructions:', ...findingLines(rest, (id) => id));
  return lines;
}

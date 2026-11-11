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
 * Workflow Studio change set at `fixDraft.changeSetPath` and proposes it for review. A workflow the
 * platform sees could be simpler carries `simplify`: what it found, and the route that builds a
 * simpler copy (`workflow build start --simplify ID`).
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

/** The private file a fix draft for this repository (and workflow) goes in: outside the repository; `workflow validate` makes only its folder. */
export function workflowFixDraftPath(root, workflowId = null, { env = process.env } = {}) {
  let resolved = path.resolve(root);
  try { resolved = realpathSync.native(resolved); } catch { /* the path as given */ }
  const repository = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  return path.join(workflowBuildStateRoot(env), 'workflow-fixes', repository, `${workflowId ?? 'all-workflows'}.change-set.json`);
}

/**
 * What each step holds, and whether it defines the clause anchors, plans claims, or carries the code's
 * tags; `people` is who drafts, asks, reviews and approves it, and where (src/workflow-step-people.mjs).
 */
function stepRoles(entry, explanation) {
  const explained = new Map((explanation?.steps ?? []).map((step) => [step.id, step]));
  const codeSteps = new Set(Object.keys(entry.owners ?? {}));
  return (entry.obligations?.steps ?? []).map((step) => ({
    id: step.id, label: explained.get(step.id)?.label ?? step.id, responsibilities: step.responsibilities,
    definesClauses: (entry.clausePhases ?? []).includes(step.id),
    plansClaimsFor: Object.entries(entry.owners ?? {}).filter(([, owner]) => owner === step.id).map(([code]) => code),
    // Its code carries @clause:<WORK>:REQ-001 comments and its tests @ac:<WORK>:AC-001 tags.
    carriesTags: entry.status === 'protected' && codeSteps.has(step.id),
    ...(explained.get(step.id)?.people ? { people: explained.get(step.id).people } : {})
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
    // Every finding as a drafted change or a question only a person can answer (src/workflow-fix/index.mjs).
    draftCommand: `singularity-flow workflow fix${workflowId ? ` ${workflowId}` : ''} --write`,
    reviewed: 'Copilot drafts every fix as one configuration proposal; nothing changes until it is reviewed and activated.'
  };
}

/**
 * What would make a workflow simpler, as the platform sees it (src/workflow-build/simplify.mjs), and
 * the route that builds a simpler copy from it: each candidate checked and offered there, the person
 * accepting each one, and the original never changed. Null when nothing is found. Only what is in the
 * workflow itself counts here: an agent nothing uses is the repository's, so it makes no workflow
 * heavy (a simplify build still offers to leave it out).
 */
async function simplifyHint(workflowId, { model, findings, definition, packaged }) {
  const workflow = model?.workflows.find((entry) => entry.id === workflowId);
  if (!workflow) return null;
  const { simplificationCandidates } = await import('./workflow-build/simplify.mjs');
  const candidates = simplificationCandidates({ model, workflow, findings, definition, packaged });
  if (!candidates.length) return null;
  const command = `singularity-flow workflow build start --simplify ${workflowId}`;
  // The skill takes the same option (its argument-hint): the route is the skill with it, as an explicit route.
  const { copilotCommandForCommand } = await import('./copilot-guidance.mjs');
  const copilotCommand = safeCommandGuidance({ command, skill: '/sf-build-workflow' }) ? copilotCommandForCommand(command, `/sf-build-workflow --simplify ${workflowId}`) : null;
  return {
    candidates: candidates.length,
    found: candidates.map((entry) => ({ kind: entry.kind, title: entry.title, location: entry.location })),
    nextAction: {
      label: 'Build a simpler copy', command, skill: '/sf-build-workflow', copilotCommand, modelFreeCommand: null,
      reviewed: 'Each change is checked before it is offered and you accept or decline it; the result is a new workflow in one reviewed proposal. The original is never changed.'
    }
  };
}

/**
 * `workflow fix` drafts each finding's exact change, or the one question a person must answer, where
 * this SFlow has the command: feature-detected in the command registry (operation `workflow.fix`), so
 * /sf-fix-workflow runs it only when it exists and otherwise drafts the fixes itself. The skill reads
 * from its JSON only each fix's `change` (Studio change set ops, put into the draft as given, asking
 * nothing) and `question` (asked one at a time); the command must be a read for the fix turn to run it.
 */
async function fixDrafter(workflowId) {
  const { operationById } = await import('./command-registry.mjs');
  return operationById('workflow.fix') ? { fixCommand: `singularity-flow workflow fix${workflowId ? ` ${workflowId}` : ''} --json` } : {};
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
  const hints = new Map();
  const packaged = await (await import('./workflow-build/simplify.mjs')).packagedPhaseIds();
  for (const entry of catalog.workflows) {
    hints.set(entry.id, await simplifyHint(entry.id, { model: check.studioModel, findings: checked.get(entry.id)?.findings ?? [], definition, packaged }).catch(() => null));
  }
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
      roles: stepRoles(entry, own?.explanation),
      ...(hints.get(entry.id) ? { simplify: hints.get(entry.id) } : {})
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
      fixDraft: { workflow: target, schema: STUDIO_CHANGE_SET_SCHEMA, changeSetPath: workflowFixDraftPath(root, target, { env }), ...await fixDrafter(target) }
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

/**
 * Who does what, where, in each step of one workflow, one line per item under the step: what
 * `workflow check WORKFLOW` and `workflow validate WORKFLOW` print.
 */
export function stepPeopleLines(steps, { indent = '  ' } = {}) {
  const lines = [];
  for (const [index, step] of steps.entries()) {
    if (!step.people) continue;
    lines.push(`${indent}${index + 1}. ${step.label}`);
    for (const line of step.people.lines) lines.push(`${indent}   ${line}`);
  }
  return lines;
}

/** The text `workflow validate` prints after its table; with one workflow named, who does what in each step too. */
export function validationFindingLines(result, { people = false } = {}) {
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
  if (people) {
    for (const workflow of result.workflows.filter((entry) => entry.roles.some((step) => step.people))) {
      lines.push('', `Who does what, where, in ${workflow.label} (${workflow.id}):`, ...stepPeopleLines(workflow.roles));
    }
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

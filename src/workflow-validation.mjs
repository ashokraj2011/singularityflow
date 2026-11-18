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
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDefinition, WORKFLOW_PATH } from './config.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { SingularityFlowError } from './util.mjs';
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
function fixAction(workflowId, draftCommand = null) {
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
    ...(draftCommand ? { draftCommand } : {}),
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
 * `workflow fix <WORKFLOW> --write` drafts each finding's exact change into the fix draft file, and
 * returns the questions only a person can answer, where this SFlow has the command: feature-detected
 * in the command registry (operation `workflow.fix`). One command for every reader: the next action's
 * `draftCommand` names it, and the fix draft's `fixCommand` is the same command with --json, which
 * /sf-fix-workflow runs (a read, so its turn may). Without the command neither is given and the skill
 * drafts the fixes itself. Fields the skill reads from its JSON: `questions[]` (`id`, `ask`, `why`,
 * `choices[]`) and `draft.written`.
 */
async function fixDraftCommand(workflowId) {
  const { operationById } = await import('./command-registry.mjs');
  return operationById('workflow.fix') ? `singularity-flow workflow fix${workflowId ? ` ${workflowId}` : ''} --write` : null;
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
    ...(valid ? {} : await (async () => {
      const draftCommand = await fixDraftCommand(target);
      return {
        nextAction: fixAction(target, draftCommand),
        fixDraft: { workflow: target, schema: STUDIO_CHANGE_SET_SCHEMA, changeSetPath: workflowFixDraftPath(root, target, { env }),
          ...(draftCommand ? { fixCommand: `${draftCommand} --json` } : {}) }
      };
    })())
  };
}

const ROUTE_DROPS = 'OBLIGATION_ROUTE_DROPS_RESPONSIBILITY';

/**
 * A problem as a change compares it: its workflow, code and the subject it names (and the file it is in), never its line.
 * A finding's `id` carries its line, so an edit that only moved lines named an old problem as a new one.
 */
function problemKey(workflowId, finding) {
  // A route that drops responsibilities is one problem per route, whichever step it ends after and whatever it still
  // misses: appending a step after its last one, or fixing part of it, is not a new problem (review 11-17, finding 3).
  if (finding.code === ROUTE_DROPS) {
    return JSON.stringify([workflowId, ROUTE_DROPS, finding.subject?.decision ?? null, finding.subject?.route ?? null, finding.location?.file ?? null]);
  }
  const subject = finding.subject && typeof finding.subject === 'object'
    ? Object.fromEntries(Object.entries(finding.subject).sort(([a], [b]) => a.localeCompare(b))) : finding.subject ?? null;
  return JSON.stringify([workflowId, finding.code ?? finding.title, subject, finding.location?.file ?? null]);
}

/**
 * Each problem `workflow validate` finds in `ids`, read in `checkout` [finding ER-F7]: keyed by workflow, code and
 * subject (problemKey), so the problems a change adds are the ones its result has and the configuration before it had not.
 * `findings`, when given, collects every finding of those workflows with its key, for a repair to act on
 * (src/workflow-autofix.mjs).
 */
export async function workflowProblems(checkout, ids, { findings = null } = {}) {
  const problems = new Map();
  for (const id of ids) {
    let result;
    try { result = await validateWorkflows(checkout, { workflow: id }); }
    catch (error) { if (error?.code === 'WORKFLOW_UNKNOWN') continue; throw error; }
    for (const workflow of result.workflows ?? []) {
      if (findings) for (const finding of workflow.findings ?? []) findings.push({ workflow: workflow.id, key: problemKey(workflow.id, finding), finding });
      for (const finding of (workflow.findings ?? []).filter((entry) => entry.severity === 'problem')) {
        const key = problemKey(workflow.id, finding);
        // What a route misses, joined over its ends, so a change adds a problem only where something is newly missing.
        const missing = finding.code === ROUTE_DROPS
          ? [...new Set([...(problems.get(key)?.missing ?? []), ...(finding.subject?.missing ?? [])])] : null;
        problems.set(key, { workflow: workflow.id, title: finding.title, code: finding.code ?? null,
          ...(finding.fix?.text ? { fix: finding.fix.text } : {}), ...(missing ? { missing } : {}),
          ...(finding.code === ROUTE_DROPS && finding.subject?.decision ? { decision: finding.subject.decision } : {}) });
      }
      if (workflow.obligations && workflow.obligations.startable === false && !(workflow.findings ?? []).some((entry) => entry.severity === 'problem')) {
        problems.set(JSON.stringify([workflow.id, 'WORKFLOW_NOT_STARTABLE']), { workflow: workflow.id, title: workflow.reason ?? 'A Story cannot start it.', code: 'WORKFLOW_NOT_STARTABLE' });
      }
    }
  }
  return problems;
}

/**
 * The problems `after` has that `before` had not (both from workflowProblems): a new problem, or a route that now misses
 * a responsibility it did not miss before. Approval and `workflow edit` compare the same way [ER-F7].
 */
export function addedProblems(before, after) {
  const added = addedProblemKeys(before, after);
  return [...after].filter(([key]) => added.has(key)).map(([, problem]) => problem);
}

/** The keys of the problems addedProblems returns. */
export function addedProblemKeys(before, after) {
  return new Set([...after].filter(([key, problem]) => {
    const was = before.get(key);
    return !was || (problem.missing ?? []).some((name) => !(was.missing ?? []).includes(name));
  }).map(([key]) => key));
}

/**
 * Problems `workflow create` and `workflow edit` can change with their own options (--phases, --planned-claims,
 * --clause-phases, --claim-owners, --loop): the step list, its plan owners and its rework loops. A route ending after
 * the last step gains steps with --phases; one out of a decision is the decision's. Anything else (an agent file, omits,
 * a step's own settings or template) is changed where those live (review 11-17, finding 5).
 */
const OPTION_FIXES = new Set([ROUTE_DROPS, 'OBLIGATION_IMPLEMENT_WITHOUT_PLAN', 'CHECK_PLANNED_CLAIMS', 'CHECK_PLAN_SHARED_BY_CODE_STEPS',
  'CHECK_TEMPLATE_PLANNED_TABLE']);
const optionFixes = (problem) => OPTION_FIXES.has(problem.code) && !(problem.code === ROUTE_DROPS && problem.decision);

/**
 * Runs `change` in `checkout`, then the check approval runs (ER-F7): a problem `workflow validate` finds that `before` did
 * not have makes a proposal nobody can approve. On one, workflow.yml is put back and the change refused, naming each new
 * problem and its fix, and the same command to run again. `verb` is the command's own word: create or edit.
 */
async function withoutAddedProblems(checkout, id, change, { verb, options, before = new Map() }) {
  const file = path.join(checkout, WORKFLOW_PATH), saved = await readFile(file).catch(() => null);
  const restore = async () => { if (saved) await writeFile(file, saved); };
  const result = await change();
  // The one check every way of making a workflow runs (src/workflow-autofix.mjs): what only needs placeholders
  // in a step's template is added there, and the rest is refused here with its fix [owner, 2026-11-18].
  let outcome = { repairs: [], problems: [], restore: async () => {} };
  try {
    if (result?.governs === 'story') outcome = await (await import('./workflow-autofix.mjs')).repairCheckout(checkout, [id], { before });
  } catch (error) { await restore(); throw error; }
  const added = outcome.problems;
  if (!added.length) return outcome.repairs.length ? { ...result, repairs: outcome.repairs } : result;
  await outcome.restore();
  await restore();
  // The same command, to run again once each problem is changed.
  const argv = ['workflow', verb, id, ...Object.entries(options).flatMap(([name, value]) => value === true ? [`--${name}`]
    : typeof value === 'string' ? [`--${name}`, value] : Array.isArray(value) ? value.flatMap((entry) => [`--${name}`, String(entry)]) : [])];
  const listed = added.map((entry) => `- ${entry.title}${entry.fix ? `\n  Fix: ${entry.fix}` : ''}`).join('\n');
  const again = `Change what each problem names, then ${verb} it again`;
  const same = { label: again, executable: 'singularity-flow', argv };
  // When a fix is not one of this command's options, the same command alone is no way out: Copilot's build, or Workflow
  // Studio, changes the agent, omits or step settings with the workflow, and the same command stays the second route.
  const elsewhere = !added.every(optionFixes);
  const build = { label: `${verb === 'create' ? 'Build' : 'Change'} ${id} with Copilot or in Workflow Studio`,
  command: `singularity-flow workflow build start${verb === 'create' ? '' : ` --change ${id}`}`, skill: '/sf-build-workflow',
  workflowStudio: 'In VS Code, open Workflow Studio (Singularity Flow: Workflow Studio) and make the change there.' };
  const then = elsewhere
    ? `Not every fix is an option of workflow ${verb}: agents, omits and step settings change with Copilot (/sf-build-workflow) or in Workflow Studio, or by hand, then ${verb} it again`
    : again;
  throw new SingularityFlowError(verb === 'create'
    ? `Workflow ${id} was not created: \`workflow validate\` would refuse it, so nobody could approve it. Nothing was proposed.\n${listed}\n${then}.`
    : `Workflow ${id} was not changed: the edit adds ${added.length === 1 ? 'a problem' : `${added.length} problems`} \`workflow validate\` would refuse, so nobody `
      + `could approve it. Nothing was written or proposed.\n${listed}\n${then}.`,
  { code: verb === 'create' ? 'WORKFLOW_CREATE_PROBLEMS' : 'WORKFLOW_EDIT_PROBLEMS',
    details: { workflow: id, problems: added, nextAction: elsewhere ? build : same, actions: [elsewhere ? same : build] } });
}

/**
 * `workflow create` makes only a workflow `workflow validate` passes: approval refuses one with a problem the
 * configuration before it did not have (ER-F7), so a proposal of it is one nobody can approve. Runs `create` in
 * `checkout`; on a problem the workflow is taken out again and refused, naming each problem and its fix.
 */
export const createdWithoutProblems = (checkout, id, create, options = {}) => withoutAddedProblems(checkout, id, create, { verb: 'create', options });

/**
 * `workflow edit` likewise never leaves a workflow with a problem approval would refuse. Only a problem the edit adds is
 * refused: one the workflow already had is the same finding wherever its line moved (problemKey), so it never stops an edit.
 */
export async function editedWithoutNewProblems(checkout, id, edit, options = {}) {
  return withoutAddedProblems(checkout, id, edit, { verb: 'edit', options, before: await workflowProblems(checkout, [id]) });
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

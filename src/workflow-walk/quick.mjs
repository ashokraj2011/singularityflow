/**
 * `workflow walk --quick`: the walk that runs on every change to a workflow (step intents spec §9.5, Stage 6). Workflow
 * create and edit, a Workflow Studio save, a configuration save, an import, a workflow build's finish and
 * `workflow from-agent` all run it through the one check (src/workflow-check.mjs), so a workflow that would loop or come
 * to a stop shows a plain explanation and a filled fix before anyone approves it.
 *
 * The Story walk (walk.mjs) drives a throwaway Story with the CLI and takes 40 to 70 seconds a workflow. This walk runs
 * in this process in milliseconds: no Story, no Git, no child process, no model. It takes every path a Story of the
 * workflow can take (the route simulation's scenarios: a passing run, each decision route, a decision that keeps going
 * back until its rounds run out, and each send-back of a person's approval), and at each step it renders, with the
 * kernel's own action-to-command map (src/action-command-map.mjs, src/step-decision.mjs), the route SFlow hands the
 * agent or the person at each stage: entry, publication, review, submission, approval, a decision, and a limit's exit.
 * Each route is checked on both hosts, Copilot CLI and VS Code's chat. It stops on what the hardening tracks check:
 *
 *   loop        the same route comes round with nothing changed: a decision that goes back on values its round never
 *               records again, or a route that repeats without a bound;
 *   limit       a limit that leaves only the same command, or nothing: rounds that run out to a group nobody is in;
 *   host-route  a route that does not exist on a host: no command for the stage, or a skill, page tool or Command
 *               Palette entry the host does not have;
 *   copy-value  a route that leaves the agent a value SFlow knows to copy in (a Story, a step, a version); the values a
 *               step's own decision reads at its submission are its author's to give, never a copy.
 *
 * Bounded: by `seconds` (QUICK_WALK_SECONDS) and by the simulation's own step guard. A walk that runs out of time is a
 * note, never a stop. The result is schemaVersion 1, resultType `workflow-walk`, mode `quick`:
 *   { ok, mode, budget: { seconds }, counts: { workflows, stops, paths, routes }, workflows: [{ id, label, outcome:
 *     completed|stopped|not-judged|not-walked, reason?, paths, routes, stops: [{ class, code, step?, decision?, host?,
 *     path?, title, detail, fix: { text, move?, changes? }, alsoChecked? }], notes: [string] }] }
 * `alsoChecked` names the `workflow check` finding that already reports the same stop, so the check does not show it twice.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { codePublicationRoute, submitRoute } from '../action-command-map.mjs';
import { approvesAutomatically } from '../approval-authority.mjs';
import { phaseKernelOwned, phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { VSCODE_DECIDE_CARD, VSCODE_SELECT_STORY, VSCODE_WITNESS_REVIEW } from '../model-free-commands.mjs';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { safeCommandGuidance } from '../safe-command-guidance.mjs';
import { sourceReviewRequired } from '../source-review-policy.mjs';
import { actionRoute } from '../step-decision.mjs';
import { routeReach } from '../workflow-decisions.mjs';
import { simulateWorkflowRoutes } from '../workflow-route-simulation.mjs';

export const QUICK_WALK_SECONDS = 5;
export const QUICK_WALK_CLASSES = Object.freeze(['loop', 'limit', 'host-route', 'copy-value']);
export const QUICK_WALK_HOSTS = Object.freeze({ 'copilot-cli': 'Copilot CLI', vscode: "VS Code's chat" });
/** The stop codes, each a `workflow check` problem (src/workflow-check.mjs). */
export const QUICK_WALK_CODES = Object.freeze({
  sameRoute: 'WALK_SAME_ROUTE_UNCHANGED', repeats: 'WALK_ROUTE_REPEATS', noExit: 'WALK_NO_WAY_ON',
  missing: 'WALK_ROUTE_MISSING', notOnHost: 'WALK_ROUTE_NOT_ON_HOST', copy: 'WALK_VALUE_TO_COPY', outOfTime: 'WALK_OUT_OF_TIME'
});
const WORK_ID = 'WALK-1';

// The person's own words a route leaves for them to type: never a value SFlow knows.
const PERSON_WORDS = /^<(?:REASON|reason|why[^>]*|what to change|answer|question|AUTHORIZED-URL)>$/u;
// VS Code's chat takes these skills by the extension's own page tools (test/helpers/vscode-host.mjs, hardening C).
const VSCODE_CARD_TOOLS = Object.freeze({ '/sf-approve': '#sflowDecide', '/sf-decide': '#sflowDecide' });
// Command Palette entries the engine names as a model-free route: VS Code's own commands.
const KNOWN_PALETTE = Object.freeze([VSCODE_DECIDE_CARD, VSCODE_SELECT_STORY, VSCODE_WITNESS_REVIEW]);

const skillName = (value) => {
  const word = String(value ?? '').trim().split(/\s+/u)[0];
  return /^\/(?:sf|sflow)-[a-z0-9-]+$/u.test(word) ? word.replace(/^\/sflow-/u, '/sf-') : null;
};

let hostsCache = null;

/**
 * What each host has, read from this SFlow's own files: the plugin's skills (both hosts run them), and in a checkout
 * that has the VS Code extension's manifest, its page tools and Command Palette titles. An installed SFlow carries no
 * manifest, so VS Code's tools and palette are the ones the engine names (null: not read).
 */
export function walkHosts({ root = PACKAGE_ROOT } = {}) {
  if (root === PACKAGE_ROOT && hostsCache) return hostsCache;
  const skillsRoot = path.join(root, 'plugin', 'skills');
  let skills = new Set();
  try {
    skills = new Set(readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('sflow-') && existsSync(path.join(skillsRoot, entry.name, 'SKILL.md')))
      .map((entry) => `/sf-${entry.name.slice('sflow-'.length)}`));
  } catch { /* no skills folder: every skill route is reported */ }
  let tools = null;
  let palette = null;
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'apps', 'vscode', 'package.json'), 'utf8'));
    tools = new Set((manifest.contributes?.languageModelTools ?? []).map((tool) => `#${tool.toolReferenceName ?? tool.name}`));
    palette = new Set((manifest.contributes?.commands ?? []).map((command) => `Command Palette: ${command.category ? `${command.category}: ` : ''}${command.title}`));
  } catch { /* an installed SFlow: the engine's own names stand */ }
  const hosts = { 'copilot-cli': { skills }, vscode: { skills, tools, palette } };
  if (root === PACKAGE_ROOT) hostsCache = hosts;
  return hosts;
}

/** Why `route` is not one `host` has, or null when it is. */
function missingOnHost(route, host, hosts) {
  const table = hosts[host];
  const skill = skillName(route.copilotCommand ?? route.skill);
  if (skill && !table.skills.has(skill)) return `${QUICK_WALK_HOSTS[host]} has no ${skill}`;
  if (host !== 'vscode') return null;
  const tool = skill ? VSCODE_CARD_TOOLS[skill] : null;
  if (tool && table.tools && !table.tools.has(tool)) return `${skill} runs on VS Code's page tool ${tool}, which this VS Code extension does not contribute`;
  const palette = /^Command Palette: /u.test(route.modelFreeCommand ?? '') ? route.modelFreeCommand : null;
  if (palette && !(table.palette ?? new Set(KNOWN_PALETTE)).has(palette)) return `VS Code has no ${palette.replace(/^Command Palette: /u, '')} command`;
  return null;
}

/** A value SFlow knows that `route` leaves for the agent to copy in: an unfilled `<…>` that is not the person's words. */
export function valuesToCopy(route) {
  return [...String(route.command ?? '').matchAll(/<[A-Za-z][A-Za-z0-9_ |-]*>/gu)].map((match) => match[0])
    .filter((word) => !PERSON_WORDS.test(word));
}

/** A resolved step as the routes read it: a Story's record of the workflow, with nothing run yet. */
function storyOf(resolved) {
  return { workItem: { id: WORK_ID }, resolution: resolved, phaseOrder: resolved.phases.map((phase) => phase.id),
    phases: Object.fromEntries(resolved.phases.map((phase) => [phase.id, phase])), currentPhase: resolved.phases[0]?.id ?? null };
}

const fromCommand = (command, detail, skill) => {
  const guidance = command ? safeCommandGuidance({ command, ...(skill ? { skill } : {}) }) : null;
  return guidance ? { detail, ...guidance } : null;
};

/**
 * The routes a visit of `phase` hands out, stage by stage, from the kernel's map: what a Story's agent or person is
 * given at each. `visit` > 1 is a step the Story returns to: its next version opens on the person's yes.
 */
function stepRoutes(story, phase, { visit, decision }) {
  const step = phase.id;
  const render = (operation, form, detail) => actionRoute(operation, form, { step, workId: WORK_ID, detail });
  const code = phaseRequiresCodeDelivery(phase);
  const kernel = phaseKernelOwned(phase);
  const stages = [];
  const add = (stage, route, words) => stages.push({ stage, route, words });
  if (visit > 1) add('next version', render(kernel ? 'build-version' : 'open-version', 'preview', `Start version ${visit} of ${step}?`), `the person's yes to its version ${visit}`);
  add('entry', code ? render('open-version', 'begin', 'Open the code generation.') : render(kernel ? 'build-version' : 'author-version', 'prepare', 'Write the step.'),
    code ? 'its code generation' : kernel ? 'what SFlow builds' : 'its draft');
  if (code) {
    const published = codePublicationRoute(story, phase);
    add('publication', fromCommand(published.command, 'Check and publish the code.', published.skill), 'its publication');
  } else add('publication', render('publish-version', 'prepublish', 'Check and publish the draft.'), 'its publication');
  if (sourceReviewRequired(story, step)) add('review', render('start-review', 'context', 'Review the published version.'), 'its independent review');
  const submit = submitRoute(story, phase);
  add('submission', fromCommand(submit.command, submit.reason, submit.skill), 'its submission');
  const mode = phase.approval?.mode ?? 'required';
  if (mode !== 'none' && !approvesAutomatically(phase.approval)) add('approval', render('approve-step', 'approve', 'Approve the step.'), "a person's approval");
  if (decision?.mode === 'ask') add('decision', render('decide', 'story', 'A person chooses what happens next.'), `"${decision.label}", which a person chooses`);
  return stages;
}

const stopKey = (stop) => JSON.stringify([stop.code, stop.step ?? null, stop.decision ?? null, stop.host ?? null, stop.stage ?? null]);
const words = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

/**
 * The inputs a decision's choice reads that its round never records again: each value it reuses from a decision whose
 * step lies before where its route back returns. Null when the choice reads any value a round records (its own step's).
 */
function unchangingReads(decision, target, order) {
  const reads = new Set([...(decision.routes ?? []).flatMap((route) => Object.keys(route.when ?? {})), ...Object.keys(decision.goal ?? {})]);
  if (!reads.size) return null;
  const own = new Set((decision.inputs ?? []).map((input) => input.name));
  const reused = new Map((decision.reuses ?? []).map((input) => [input.name, input]));
  const fixed = [];
  for (const name of reads) {
    if (own.has(name)) return null;
    const input = reused.get(name);
    if (!input) return null;
    fixed.push(input);
  }
  return { fixed, target };
}

/**
 * Walk one resolved workflow (`resolveWorkType`). `groups` maps an approval group to its status as Workflow Studio
 * shows it (`people`, `anyone`, `teams`, `auto` or `blocked`) and its label; `hosts` is walkHosts(); `deadline` a time.
 */
export function quickWalkResolved(resolved, { approvalAuthorities = null, groups = new Map(), hosts = walkHosts(), deadline = Date.now() + QUICK_WALK_SECONDS * 1000, labels = null,
  simulation: simulated = null } = {}) {
  const started = Date.now();
  const order = resolved.phases.map((phase) => phase.id);
  const byId = new Map(resolved.phases.map((phase) => [phase.id, phase]));
  const label = (id) => labels?.get?.(id) ?? byId.get(id)?.label ?? id;
  const decisions = resolved.decisions ?? [];
  const decisionAfter = new Map(decisions.map((decision) => [decision.after, decision]));
  const story = storyOf(resolved);
  const stops = new Map();
  const notes = [];
  const stop = (entry) => { if (!stops.has(stopKey(entry))) stops.set(stopKey(entry), entry); };
  let simulation = simulated;
  try { simulation ??= simulateWorkflowRoutes(resolved, { approvalAuthorities }); }
  catch (error) {
    return { outcome: 'not-judged', reason: `Its routes cannot be followed: ${error.message}`, paths: 0, routes: 0, stops: [], notes, seconds: 0, hosts: Object.values(QUICK_WALK_HOSTS) };
  }
  let outOfTime = false;
  let routes = 0;
  const walked = new Set();

  // Every path a Story can take, and each step on it with the routes it hands out on both hosts.
  for (const scenario of simulation.scenarios ?? []) {
    if (Date.now() >= deadline) { outOfTime = true; break; }
    if (scenario.outcome === 'unbounded') {
      const decision = decisions.find((entry) => (scenario.choices ?? []).some((choice) => choice.decision === entry.id)) ?? null;
      stop({ class: 'loop', code: QUICK_WALK_CODES.repeats, decision: decision?.id ?? null, path: scenario.id, alsoChecked: 'WORKFLOW_ROUTE_UNBOUNDED',
        title: `A route ${decision ? `out of "${decision.label}" ` : ''}comes round without end`,
        detail: `On the path "${scenario.id}", the Story goes back again and again with nothing to stop it, so the same steps repeat with nothing changed.`,
        fix: { text: decision ? `Give "${decision.label}" a limit: maxRounds (1 to 20) and by, the group that decides when the rounds run out.` : 'Give the decision that goes back a limit: maxRounds and by.' } });
      continue;
    }
    const visits = new Map();
    for (const entry of scenario.path ?? []) {
      if (Date.now() >= deadline) { outOfTime = true; break; }
      const id = String(entry);
      if (!byId.has(id)) continue;
      const visit = (visits.get(id) ?? 0) + 1;
      visits.set(id, visit);
      const key = `${id}\0${Math.min(visit, 2)}`;
      if (walked.has(key)) continue;
      walked.add(key);
      for (const stage of stepRoutes(story, byId.get(id), { visit, decision: decisionAfter.get(id) })) {
        routes += 1;
        if (!stage.route) {
          stop({ class: 'host-route', code: QUICK_WALK_CODES.missing, step: id, stage: stage.stage,
            title: `${label(id)} has no route for ${stage.words}`,
            detail: `When a Story reaches ${stage.words} in ${label(id)}, SFlow has no command to hand the agent or the person, so the Story stops there on both hosts.`,
            fix: { text: `Check ${label(id)}'s settings in singularity/workflow.yml against what it does (its intent): \`singularity-flow workflow check ${resolved.id} --settings\` shows each one and where it comes from.` } });
          continue;
        }
        for (const host of Object.keys(QUICK_WALK_HOSTS)) {
          const missing = missingOnHost(stage.route, host, hosts);
          if (missing) {
            stop({ class: 'host-route', code: QUICK_WALK_CODES.notOnHost, step: id, stage: stage.stage, host,
              title: `${label(id)}'s route for ${stage.words} does not exist on ${QUICK_WALK_HOSTS[host]}`,
              detail: `SFlow hands ${stage.route.copilotCommand ?? stage.route.command} there, but ${missing}, so a Story on ${QUICK_WALK_HOSTS[host]} stops at it.`,
              fix: { text: 'Update SFlow on this machine, whose plugin carries every skill a route names, then save the workflow again: singularity-flow update.' } });
          }
        }
        const copied = valuesToCopy(stage.route);
        // A step's own decision values are its author's to give (the decision's inputs); any other value is SFlow's.
        const fedBy = decisionAfter.get(id);
        const own = new Set((fedBy?.mode === 'auto' ? fedBy.inputs : []).map((input) => `<${input.name}>`));
        const sflows = copied.filter((word) => !own.has(word));
        if (sflows.length) {
          stop({ class: 'copy-value', code: QUICK_WALK_CODES.copy, step: id, stage: stage.stage,
            title: `${label(id)}'s route for ${stage.words} leaves the agent ${words(sflows)} to fill in`,
            detail: `SFlow knows ${sflows.length === 1 ? 'that value' : 'those values'}, but the route it hands out (${stage.route.command}) leaves ${sflows.length === 1 ? 'it' : 'them'} for the agent to copy in.`,
            fix: { text: 'SFlow fills that value, not the workflow: update SFlow on this machine, then save the workflow again: singularity-flow update.' } });
        }
      }
    }
  }

  // A decision that goes back on values its round never records again: the same route, round after round.
  for (const decision of decisions.filter((entry) => entry.mode === 'auto')) {
    for (const route of decision.routes ?? []) {
      const reach = routeReach(order, decision.after, route.to);
      if (reach.kind !== 'backward') continue;
      const reads = unchangingReads(decision, reach.target, order);
      if (!reads) continue;
      const outside = reads.fixed.filter((input) => {
        const source = decisions.find((entry) => entry.id === input.from);
        return !source || order.indexOf(source.after) < order.indexOf(reach.target);
      });
      if (outside.length !== reads.fixed.length) continue;
      const sources = [...new Set(outside.map((input) => decisions.find((entry) => entry.id === input.from)?.label ?? input.from))];
      stop({ class: 'loop', code: QUICK_WALK_CODES.sameRoute, decision: decision.id, step: decision.after,
        title: `"${decision.label}" goes back to ${label(reach.target)} on values that never change`,
        detail: `It chooses its route from ${words(outside.map((input) => input.name))}, which ${words(sources)} recorded before ${label(reach.target)}. Going back to ${label(reach.target)} records nothing new for it, so once it takes "${route.label ?? route.id}" it takes it again every round, with nothing changed, until its ${decision.maxRounds} round${decision.maxRounds === 1 ? '' : 's'} run out.`,
        fix: { text: `Have ${label(decision.after)} record the value each round: in singularity/workflow.yml give "${decision.label}" (after: ${decision.after}) ${outside.length === 1 ? 'an input' : 'inputs'} of its own, `
          + `${outside.map((input) => `{ name: ${input.name}, values: [${(input.values ?? []).join(', ')}] }`).join(', ')}, in place of the one${outside.length === 1 ? '' : 's'} reused from ${words(sources)}; or make it a decision a person makes (kind: ask, with by).` } });
    }
  }

  // A limit's way on: when a decision's rounds run out, the Story waits for its by group. Nobody in it, no way on.
  for (const scenario of (simulation.scenarios ?? []).filter((entry) => entry.kind === 'exhausted')) {
    const decision = decisions.find((entry) => entry.id === scenario.decision);
    if (!decision) continue;
    const by = scenario.pausedFor ?? decision.by ?? [];
    const blocked = by.filter((group) => groups.get(group)?.status === 'blocked');
    if (!by.length || blocked.length === by.length) {
      const names = by.map((group) => groups.get(group)?.label ?? group);
      stop({ class: 'limit', code: QUICK_WALK_CODES.noExit, decision: decision.id, step: decision.after, path: scenario.id,
        ...(by.length ? {} : { alsoChecked: 'WORKFLOW_ROUTE_PAUSE_UNOWNED' }),
        title: `When "${decision.label}" runs out of rounds, nobody can say how to go on`,
        detail: by.length
          ? `After ${decision.maxRounds} round${decision.maxRounds === 1 ? '' : 's'} back, the Story waits for ${words(names)} to decide, but nobody is in ${names.length === 1 ? 'it' : 'them'} and new people are not added to ${names.length === 1 ? 'it' : 'them'} automatically. The only route left is the same decision, which nobody can answer.`
          : `After ${decision.maxRounds} round${decision.maxRounds === 1 ? '' : 's'} back, the Story waits for a person to decide, but the decision names no group to ask.`,
        fix: by.length ? { text: `Add people to ${words(names)} in Workflow Studio's People, or name a group with people in "${decision.label}"'s by.` } : { text: `Name the group that decides when its rounds run out: by: [${[...new Set(Object.keys(approvalAuthorities ?? {}))].slice(0, 1).join('') || 'GROUP'}].` } });
    }
  }
  if (outOfTime) notes.push(`The quick walk stopped at its time limit (${Math.max(1, Math.round((deadline - started) / 1000))} s) before it walked every path; what it walked is above.`);
  const list = [...stops.values()];
  return { outcome: list.length ? 'stopped' : outOfTime ? 'not-judged' : 'completed', paths: (simulation.scenarios ?? []).length, routes, stops: list, notes,
    seconds: Math.round((Date.now() - started) / 10) / 100, hosts: Object.values(QUICK_WALK_HOSTS) };
}

/**
 * The quick walk of the workflows in `root`'s configuration (or `configurationRoot`, a staged copy), all of them or
 * `workflow`. Reads only. Bounded by `seconds` in all.
 */
export async function quickWalkWorkflows(root, { workflow = null, configurationRoot = null, seconds = QUICK_WALK_SECONDS } = {}) {
  const deadline = Date.now() + seconds * 1000;
  const [{ loadDefinition, resolveWorkType }, { buildStudioModel }] = await Promise.all([import('../config.mjs'), import('../workflow-studio.mjs')]);
  const from = configurationRoot ?? root;
  const definition = await loadDefinition(from);
  const model = await buildStudioModel(from).catch(() => null);
  const groups = new Map((model?.groups ?? []).map((group) => [group.id, group]));
  const ids = Object.entries(definition.workTypes ?? {}).filter(([id, type]) => (type.governs ?? 'story') === 'story' && (!workflow || id === workflow)).map(([id]) => id);
  if (workflow && !ids.length) {
    const { SingularityFlowError } = await import('../util.mjs');
    throw new SingularityFlowError(`There is no workflow '${workflow}' to walk. Known: ${Object.keys(definition.workTypes ?? {}).join(', ') || 'none'}.`, { code: 'WORKFLOW_WALK_UNKNOWN_WORKFLOW' });
  }
  const workflows = [];
  for (const id of ids) {
    const type = definition.workTypes[id];
    if (Date.now() >= deadline) { workflows.push({ id, label: type.label ?? id, outcome: 'not-walked', reason: 'The quick walk ran out of its time before this workflow.', paths: 0, routes: 0, stops: [], notes: [] }); continue; }
    let resolved;
    try { resolved = resolveWorkType(definition, id); }
    catch (error) { workflows.push({ id, label: type.label ?? id, outcome: 'not-walked', reason: `It does not resolve: ${error.message}`, paths: 0, routes: 0, stops: [], notes: [] }); continue; }
    workflows.push({ id, label: type.label ?? id, ...quickWalkResolved(resolved, { approvalAuthorities: definition.approvalAuthorities, groups, deadline }) });
  }
  const counts = { workflows: workflows.length, stops: workflows.reduce((sum, entry) => sum + entry.stops.length, 0),
    paths: workflows.reduce((sum, entry) => sum + entry.paths, 0), routes: workflows.reduce((sum, entry) => sum + entry.routes, 0),
    notJudged: workflows.filter((entry) => ['not-judged', 'not-walked'].includes(entry.outcome)).length };
  return { schemaVersion: 1, resultType: 'workflow-walk', mode: 'quick', ok: counts.stops === 0 && counts.notJudged === 0, modelUsed: false,
    hosts: Object.values(QUICK_WALK_HOSTS), budget: { seconds }, counts, workflows };
}

/**
 * `workflow walk --quick`: this repository's workflows as `workflow check` reads them, or with `shipped` the shipped
 * ones, laid out by `init` in a temporary folder that is removed afterwards.
 */
export async function quickWalkShippedOr(root, { shipped = false, workflow = null, seconds = QUICK_WALK_SECONDS } = {}) {
  if (!shipped) return { ...await quickWalkWorkflows(root, { workflow, seconds }), source: { kind: 'checkout' } };
  const [{ mkdtemp, rm }, os, { initializeDefinition }] = await Promise.all([import('node:fs/promises'), import('node:os'), import('../config.mjs')]);
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sflow-quick-walk-'));
  try {
    await initializeDefinition(folder);
    return { ...await quickWalkWorkflows(folder, { workflow, seconds }), source: { kind: 'shipped' } };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** The quick walk in plain text: per workflow, what it walked and each stop with its fix. */
export function quickWalkLines(result) {
  const lines = [`Quick walk: ${result.counts.workflows} workflow(s), ${result.counts.paths} path(s) and ${result.counts.routes} route(s) on Copilot CLI and VS Code, with no model and no Story.`];
  for (const workflow of result.workflows) {
    lines.push('', `${workflow.label} (${workflow.id}): ${workflow.outcome}${workflow.reason ? `: ${workflow.reason}` : ''}`);
    for (const entry of workflow.stops) {
      lines.push(`  STOP (${entry.class}) ${entry.title}`, `    Why: ${entry.detail}`, `    Fix: ${entry.fix.text}`);
    }
    for (const note of workflow.notes ?? []) lines.push(`  note: ${note}`);
  }
  lines.push('', result.counts.stops
    ? `${result.counts.stops} stop(s): each is a place a Story of the workflow would loop or come to a stop. Make the fix each one names, then save the workflow again.`
    : 'No stop: no loop, no limit without a way on, every route exists on both hosts, and none leaves the agent a value to copy. The full Story walk: singularity-flow workflow walk.');
  return lines;
}

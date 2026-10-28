/**
 * Does a workflow make sense? `workflow check` explains each workflow in plain words and lists what
 * is wrong with it, each finding located (the step, decision, agent or file and line) and said the
 * way a person would say it. Everything here is deterministic: no model decides a finding.
 *
 * The checks reuse the engine's own rules wherever they exist (route simulation, the obligation
 * graph, phase topology, planned claims) and add the ones nothing checked before: code that reaches
 * the end without a sign-off, groups nobody can sign off with, agents, skills and instructions
 * nothing uses, broken links, API calls nothing in the workflow makes, and rules in a step's
 * guidance that may contradict each other.
 *
 * Severities: `problem` (a Story would stop or misbehave), `warning` (works, but probably not as
 * meant) and `note` (worth a look). Findings never block anything; Story start keeps its own gates.
 * `blocksStart` says which findings those gates refuse (assertWorkTypeStartable, and a configuration
 * that does not load); a problem that lets a Story start says where it would stop in `stopsAt`.
 * Each step's template is judged by the kernel's own readers (src/workflow-template-conformance.mjs).
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { loadDefinition, resolveWorkType, WORKFLOW_PATH } from './config.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { guidanceConflicts, scanGuidanceText } from './guidance-scan.mjs';
import { mcpServerSetupCommands, mcpTargetOriginNeed, mcpTargetOriginSteps } from './mcp-target.mjs';
import { phaseTopologyFindings } from './phase-semantics.mjs';
import { SKILL_ATTACHMENTS_PATH } from './skill-library.mjs';
import { explainWorkflow } from './workflow-explanation.mjs';
import { simulateWorkflowRoutes } from './workflow-route-simulation.mjs';
import { buildStudioModel } from './workflow-studio.mjs';
import { templateConformanceFindings, templateReader } from './workflow-template-conformance.mjs';

export const CHECK_SEVERITIES = Object.freeze(['problem', 'warning', 'note']);
export const CHECK_AREAS = Object.freeze(['flow', 'ownership', 'assets', 'guidance', 'clarity']);
/** A step that no agent drafts makes the whole configuration refuse to load (src/agents.mjs). */
export const AGENT_MAPPING_CODES = Object.freeze(['AGENT_PHASE_UNMAPPED', 'AGENT_PHASE_DEFAULT_MISSING', 'AGENT_PHASE_DEFAULT_AMBIGUOUS']);
const END = '\0end';

const firstSentence = (text) => String(text ?? '').split(/(?<=[.!?])\s+/u)[0].trim();
const countsOf = (findings) => Object.fromEntries(CHECK_SEVERITIES.map((severity) => [severity, findings.filter((entry) => entry.severity === severity).length]));

/** `fix` is its text, or `{ text, move?, changes? }`: the builder's move and Workflow Studio's change set ops that make it. */
function finding({ code, area, severity, title, detail = null, subject = {}, location = null, related = [], fix = null, blocksStart = false, stopsAt = null }) {
  const key = JSON.stringify([code, subject, location?.file ?? null, location?.line ?? null, related.map((entry) => `${entry.file}:${entry.line}`)]);
  return {
    id: `f-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`,
    code, area, severity, title, detail, subject,
    ...(location ? { location } : {}),
    ...(related.length ? { related } : {}),
    ...(fix ? { fix: typeof fix === 'string' ? { text: fix } : fix } : {}),
    blocksStart: Boolean(blocksStart),
    ...(stopsAt ? { stopsAt } : {})
  };
}

/** How a step comes to hold each responsibility; the obligation graph reads it from structure, never names. */
const ROLE_HOW = Object.freeze({
  scope: 'requirements: a step whose document type (artifact kind) is requirements or implementation-spec, so its document defines the clauses ([<WORK>:REQ-001], [<WORK>:AC-001])',
  plan: 'a plan: the step just before the code step, or the step plannedClaims.owners names for it, whose document holds the planned-claims table',
  implement: 'the change itself: a code step',
  verify: "verification: the code step's own tests, or a step whose document type is test-evidence",
  review: "a person's review: a person's approval on a step every route passes"
});
const OMITS_HOW = 'Only if one truly does not apply to this route, declare omits on it instead, naming the responsibility, a reason of at least 20 characters and the approval group that records that decision.';

/** The fix for an obligation finding, saying how a step holds what is missing. */
function obligationFix(entry) {
  switch (entry.code) {
    case 'OBLIGATION_ROUTE_DROPS_RESPONSIBILITY':
      return `Add to this route ${(entry.subject?.missing ?? []).map((name) => ROLE_HOW[name] ?? name).join('; ')}. ${OMITS_HOW}`;
    case 'OBLIGATION_IMPLEMENT_WITHOUT_PLAN':
      return 'Put a step that plans before it on every route: the step just before a code step plans its claims, or name one in plannedClaims.owners. Its document holds the planned-claims table.';
    case 'OBLIGATION_VERIFY_WITHOUT_REVIEW':
      return "Ask for a person's approval on that step, or on a later step every route from it passes.";
    case 'OBLIGATION_REVIEW_POLICY_ONLY':
      return "Ask for a person's approval, not only an automatic policy approval, on a step every route to this end passes.";
    case 'OBLIGATION_OMIT_INVALID':
      return 'Each omits entry names the responsibility (scope, plan, implement, verify or review), a reason of at least 20 characters, and an approval group that exists.';
    default: return entry.resolvingAction ?? null;
  }
}

/**
 * A send-back target the workflow does not have before its step, with what repoints it: the step's
 * sign-off as this workflow runs it, sent back to the targets that still fit, or to the step itself
 * when none does. `move` is the workflow builder's; `changes` is the Workflow Studio change set op.
 */
function sendBackFix(workflow, stepId) {
  const step = workflow.steps.find((entry) => entry.id === stepId);
  if (!step || step.approval?.mode === 'none') return null;
  const before = workflow.phases.slice(0, workflow.phases.indexOf(step.id) + 1);
  const kept = (step.sendBackTo ?? []).filter((id) => before.includes(id));
  const signOff = { groups: [...(step.approval?.authorities ?? [])], minimum: step.approval?.minimum, sendBackTo: kept.length ? kept : [step.id] };
  const names = signOff.sendBackTo.map((id) => workflow.steps.find((entry) => entry.id === id)?.label ?? id);
  return {
    text: `Send rejected work back to ${names.join(' or ')} instead: change the step's send-back targets (approval rejectTo) for this workflow.`,
    move: { move: 'step.change', id: step.id, signOff },
    changes: [{ op: 'phase.update', id: step.id, workflow: workflow.id, approval: { groups: signOff.groups, minimum: signOff.minimum, rejectTo: signOff.sendBackTo } }]
  };
}

/** Line numbers inside a YAML file for a path of keys and list indexes; the deepest one found wins. */
export function yamlLocator(text, file) {
  let document;
  const lineCounter = new YAML.LineCounter();
  try { document = YAML.parseDocument(String(text ?? ''), { lineCounter }); } catch { return () => null; }
  return (keys) => {
    let node = document.contents;
    let line = null;
    for (const key of keys) {
      if (YAML.isMap(node)) {
        const pair = node.items.find((item) => (YAML.isScalar(item.key) ? item.key.value : item.key) === key);
        if (!pair) break;
        if (pair.key?.range) line = lineCounter.linePos(pair.key.range[0]).line;
        node = pair.value;
      } else if (YAML.isSeq(node) && Number.isInteger(key) && node.items[key]) {
        node = node.items[key];
        if (node?.range) line = lineCounter.linePos(node.range[0]).line;
      } else break;
    }
    return line ? { file, line } : null;
  };
}

/** Steps a run can go to from `id`: its decision's routes, or the next step; END is the end. */
function successors(workflow, id) {
  const order = workflow.phases;
  const next = order[order.indexOf(id) + 1] ?? END;
  const decision = (workflow.decisions ?? []).find((entry) => entry.after === id);
  if (!decision) return [next];
  if (decision.kind === 'loop') return [next, decision.back].filter(Boolean);
  return (decision.routes ?? []).map((route) => (route.to === 'end' ? END : route.to === 'next' ? next : route.to));
}

/** Whether a run can get from `start` to the end without passing a step in `blocked`. */
function reachesEndAvoiding(workflow, start, blocked) {
  const seen = new Set();
  const queue = successors(workflow, start);
  while (queue.length) {
    const id = queue.shift();
    if (id === END) return true;
    if (seen.has(id) || blocked.has(id)) continue;
    seen.add(id);
    queue.push(...successors(workflow, id));
  }
  return false;
}

async function exists(file) {
  return Boolean(await lstat(file).catch(() => null));
}

/**
 * Guidance a step's agent reads that the repository owns: the agent file, its skills for that step
 * and the instructions those skills place. Packaged guidance is the product's, so it is not judged here.
 */
class GuidanceReader {
  constructor(configRoot, model) {
    this.configRoot = configRoot;
    this.agents = new Map(model.agents.map((agent) => [agent.id, agent]));
    this.skills = new Map((model.skills ?? []).map((skill) => [skill.id, skill]));
    this.instructions = new Map((model.instructions ?? []).map((item) => [item.id, item]));
    this.scans = new Map();
  }

  async scan(file) {
    if (!this.scans.has(file)) {
      this.scans.set(file, readFile(path.join(this.configRoot, file), 'utf8')
        .then((text) => ({ file, text, scan: scanGuidanceText(text) }), () => null));
    }
    return this.scans.get(file);
  }

  async forStep(step) {
    const files = [];
    const agent = step.agent ? this.agents.get(step.agent) : null;
    if (agent?.scope === 'repository' && agent.path) files.push(agent.path);
    for (const entry of step.skills ?? []) {
      const skill = this.skills.get(entry.id);
      if (!skill) continue;
      files.push(skill.path);
      for (const id of skill.instructionRefs ?? []) if (this.instructions.has(id)) files.push(this.instructions.get(id).path);
    }
    return (await Promise.all([...new Set(files)].map((file) => this.scan(file)))).filter(Boolean);
  }
}

const ROUTE_TITLES = Object.freeze({
  WORKFLOW_PHASE_UNREACHABLE: ({ step }) => `Nobody can reach ${step}`,
  WORKFLOW_ROUTE_NO_END: ({ decision, step }) => decision ? `A route of "${decision}" never reaches the end` : step ? `After rejecting ${step}, the run never reaches the end` : 'A passing run never reaches the end',
  WORKFLOW_ROUTE_UNBOUNDED: () => 'A route repeats without a limit',
  WORKFLOW_ROUTE_EXHAUSTION: ({ decision }) => `"${decision}" keeps going back without pausing for a person`,
  WORKFLOW_ROUTE_UNREACHABLE: ({ decision }) => `A route of "${decision}" can never be taken`,
  WORKFLOW_ROUTE_PAUSE_UNOWNED: ({ decision }) => `Nobody decides what happens when "${decision}" runs out of rounds`,
  WORKFLOW_AUTHORITY_UNKNOWN: ({ decision, step }) => `${decision ? `"${decision}"` : step} names an approval group that does not exist`,
  WORKFLOW_REJECTION_TARGET: ({ step }) => `Rejecting ${step} sends work to a step that does not come before it`
});
const RESPONSIBILITY_WORDS = Object.freeze({ scope: 'requirements', plan: 'a plan', implement: 'the change itself', verify: 'verification', review: "a person's review" });
const OBLIGATION_TITLES = Object.freeze({
  OBLIGATION_ROUTE_DROPS_RESPONSIBILITY: ({ step, missing }) => `A route that ends after ${step} skips ${missing.map((name) => RESPONSIBILITY_WORDS[name] ?? name).join(', ')}`,
  OBLIGATION_OMIT_UNNECESSARY: ({ step }) => `A route after ${step} leaves out work it already does`,
  OBLIGATION_REVIEW_POLICY_ONLY: ({ step }) => `No person reviews the Story on the route that ends after ${step}`,
  OBLIGATION_IMPLEMENT_WITHOUT_PLAN: ({ step }) => `${step} can change code before anything is planned`,
  OBLIGATION_VERIFY_WITHOUT_REVIEW: ({ step }) => `What ${step} produces can reach the end without a review`,
  OBLIGATION_GRAPH_EMPTY: () => 'The workflow has no steps',
  OBLIGATION_OPT_OUT_RETIRED: () => 'The workflow opts out of planned claims, which is no longer allowed',
  OBLIGATION_OMIT_INVALID: () => 'A declared omission is incomplete'
});
const REVIEW_GAPS = new Set(['OBLIGATION_VERIFY_WITHOUT_REVIEW', 'OBLIGATION_REVIEW_POLICY_ONLY']);
const ROUTE_FIXES = Object.freeze({
  WORKFLOW_PHASE_UNREACHABLE: 'Route a decision to the step, or remove it from the workflow.',
  WORKFLOW_ROUTE_UNREACHABLE: 'Reorder the routes or change the earlier rule, so each route has a case of its own.',
  WORKFLOW_ROUTE_PAUSE_UNOWNED: 'Name the group that decides when the rounds run out.',
  WORKFLOW_AUTHORITY_UNKNOWN: 'Choose an existing approval group, or create the group first.',
  WORKFLOW_REJECTION_TARGET: "Send rejected work back only to the step itself or an earlier step: change the step's send-back targets (approval rejectTo)."
});

/** Check one workflow of the model; returns its findings. */
async function checkWorkflow(workflow, { definition, model, locate, guidance, groups, templates, unmapped = new Set() }) {
  const findings = [];
  const stepLabel = (id) => workflow.steps.find((step) => step.id === id)?.label ?? id;
  const decisionOf = (id) => (workflow.decisions ?? []).find((entry) => entry.id === id);
  const at = (subject) => {
    if (subject.decision) {
      const index = (workflow.decisions ?? []).findIndex((entry) => entry.id === subject.decision);
      if (index >= 0) return locate(['workTypes', workflow.id, 'decisions', index]);
    }
    if (subject.step) {
      const index = workflow.phases.indexOf(subject.step);
      return locate(index >= 0 ? ['workTypes', workflow.id, 'phases', index] : ['phases', subject.step]);
    }
    return locate(['workTypes', workflow.id]);
  };
  const add = (entry) => {
    const subject = { workflow: workflow.id, ...entry.subject };
    findings.push(finding({ ...entry, subject, location: entry.location === undefined ? at(subject) : entry.location }));
  };

  let resolved = null;
  // Steps the engine already says can reach the end unreviewed; the sign-off check does not repeat it.
  const reviewGaps = new Set();
  const unreachable = new Set();
  try { resolved = resolveWorkType(definition, workflow.id); }
  catch (error) {
    add({ code: 'CHECK_WORKFLOW_UNREADABLE', area: 'flow', severity: 'problem', title: 'Stories cannot start from this workflow',
      detail: error.message, subject: {}, blocksStart: true });
  }

  // Flow: the engine's own rules.
  if (resolved) {
    for (const entry of resolved.obligationGraph?.findings ?? []) {
      const step = entry.subject?.phase ?? null;
      if (step && (REVIEW_GAPS.has(entry.code) || entry.subject?.missing?.includes('review'))) reviewGaps.add(step);
      const detail = String(entry.message).replace(/^Work type '[^']*':\s*/u, '');
      const title = OBLIGATION_TITLES[entry.code]?.({ step: step ? stepLabel(step) : 'this step', missing: entry.subject?.missing ?? [] }) ?? firstSentence(detail);
      add({ code: entry.code, area: 'flow', severity: entry.severity === 'error' ? 'problem' : 'warning',
        title, detail: detail.charAt(0).toUpperCase() + detail.slice(1), fix: obligationFix(entry),
        subject: { ...(entry.subject?.phase ? { step: entry.subject.phase } : {}), ...(entry.subject?.decision ? { decision: entry.subject.decision } : {}) },
        // Story start refuses every route that drops a responsibility (assertWorkTypeStartable).
        blocksStart: entry.severity === 'error' });
    }
    for (const entry of phaseTopologyFindings(resolved)) {
      add({ code: entry.code, area: 'flow', severity: 'problem', title: firstSentence(entry.message), detail: entry.message,
        subject: { step: entry.phaseId }, blocksStart: true });
    }
    if (['migration-required', 'retired-opt-out'].includes(resolved.plannedClaims?.mode)) {
      add({ code: 'CHECK_PLANNED_CLAIMS', area: 'flow', severity: 'problem',
        title: 'A code step has no requirements step before it',
        detail: String(resolved.plannedClaims.reason ?? 'Story start refuses a code step without an earlier step that defines requirement clauses.'),
        fix: 'Add a step whose document type (artifact kind) is requirements or implementation-spec before the code step, so its document defines the clauses, and plan the code step in the step just before it (or name its planner in plannedClaims.owners). '
          + 'If this workflow defines no requirements at all, declare omits for scope with a reason of at least 20 characters and the approval group that decides.',
        subject: {}, blocksStart: true });
    }
    let simulation = null;
    try { simulation = simulateWorkflowRoutes(resolved, { approvalAuthorities: definition.approvalAuthorities }); }
    catch (error) {
      add({ code: 'CHECK_ROUTES_UNREADABLE', area: 'flow', severity: 'problem', title: 'The routes of this workflow cannot be followed', detail: error.message, subject: {} });
    }
    for (const entry of simulation?.findings ?? []) {
      if (entry.code === 'WORKFLOW_PHASE_UNREACHABLE' && entry.phase) unreachable.add(entry.phase);
      const words = { decision: entry.decision ? decisionOf(entry.decision)?.label ?? entry.decision : null, step: entry.phase ? stepLabel(entry.phase) : null };
      const sendBack = entry.code === 'WORKFLOW_REJECTION_TARGET' && entry.phase ? sendBackFix(workflow, entry.phase) : null;
      add({ code: entry.code, area: 'flow', severity: entry.code === 'WORKFLOW_ROUTE_UNREACHABLE' ? 'warning' : 'problem',
        title: (ROUTE_TITLES[entry.code] ?? (() => firstSentence(entry.message)))(words), detail: entry.message, fix: sendBack ?? ROUTE_FIXES[entry.code] ?? null,
        subject: { ...(entry.phase ? { step: entry.phase } : {}), ...(entry.decision ? { decision: entry.decision } : {}) },
        ...(entry.code === 'WORKFLOW_REJECTION_TARGET' && entry.phase ? { stopsAt: { step: entry.phase, when: 'rejection' } } : {}) });
    }
    // A step that smoke-checks a browser needs the Story's authorized origin, given at start or pinned later, and
    // machine setup before it can be prepared, published or submitted. Nothing is wrong with that, but
    // nobody should first hear of it from a refusal after earlier sign-offs.
    const browserSteps = mcpTargetOriginSteps(resolved.phases);
    if (browserSteps.length) {
      const commands = [...new Set(browserSteps.flatMap((step) => step.servers)
        .flatMap((serverId) => mcpServerSetupCommands(serverId, definition.mcpServers?.[serverId])))];
      add({ code: 'CHECK_BROWSER_TARGET_REQUIRED', area: 'flow', severity: 'note',
        title: `${browserSteps.map((step) => stepLabel(step.phase)).join(', ')} ${browserSteps.length === 1 ? 'checks' : 'check'} a live browser against the Story's authorized target`,
        detail: `Story start pins its origin from --target-url <AUTHORIZED-URL>: ${mcpTargetOriginNeed(browserSteps)}. `
          + `Before ${browserSteps[0].phase} can be prepared, published or submitted, the machine that runs it needs: ${commands.join('; ')} (a smoke receipt is valid for 24 hours). `
          + 'A Story started without the origin can have it pinned by a person who approves that step: singularity-flow story target-origin <WORK-ID> --url <AUTHORIZED-URL>.',
        subject: { step: browserSteps[0].phase } });
    }
    // What each step's template gives its author, judged by the readers that later judge the document.
    for (const entry of await templateConformanceFindings(resolved, { read: templates, label: stepLabel })) {
      const { step, template, kernelCode, ...rest } = entry;
      add({ ...rest, area: 'guidance', subject: { step, template, file: entry.location?.file ?? null } });
    }
  }

  // Who owns each step: an agent to draft it, people to sign it off.
  const signedOff = new Set(workflow.steps.filter((step) => step.approval?.mode !== 'none').map((step) => step.id));
  let codeUnsigned = false;
  for (const step of workflow.steps) {
    // A step no agent drafts is reported once, where its agent files are (agentMappingFindings).
    if (!step.agent && !unmapped.has(step.id)) {
      add({ code: 'CHECK_STEP_NO_AGENT', area: 'ownership', severity: 'problem', title: `Nobody drafts ${step.label}`,
        detail: `No agent is the default for ${step.label}, so a Story cannot enter it.`, fix: 'Choose the agent that drafts the step.', subject: { step: step.id } });
    }
    if (step.output === 'code' && !signedOff.has(step.id) && !reviewGaps.has(step.id) && reachesEndAvoiding(workflow, step.id, signedOff)) {
      codeUnsigned = true;
      add({ code: 'CHECK_CODE_WITHOUT_SIGNOFF', area: 'ownership', severity: 'warning', title: `Code from ${step.label} can reach the end without a sign-off`,
        detail: `${step.label} changes code, and at least one route from it reaches the end without a step anyone signs off.`,
        fix: `Ask for a sign-off on ${step.label}, or on a later step every route passes.`, subject: { step: step.id } });
    }
    for (const id of step.approval?.mode === 'none' ? [] : step.approval?.authorities ?? []) {
      if (groups.get(id)?.status === 'blocked') {
        add({ code: 'CHECK_GROUP_BLOCKED', area: 'ownership', severity: 'warning', title: `Nobody can sign off ${step.label}`,
          detail: `Group ${groups.get(id).label} has no people and no teams, and new people are not added to it automatically.`,
          fix: `Add people to ${groups.get(id).label} in Workflow Studio's People.`, subject: { step: step.id, group: id } });
      }
    }
  }
  for (const decision of workflow.decisions ?? []) {
    for (const id of decision.by ?? []) {
      if (groups.get(id)?.status === 'blocked') {
        add({ code: 'CHECK_GROUP_BLOCKED', area: 'ownership', severity: 'warning', title: `Nobody can decide "${decision.label ?? decision.id}"`,
          detail: `Group ${groups.get(id).label} has no people and no teams, and new people are not added to it automatically.`,
          fix: `Add people to ${groups.get(id).label} in Workflow Studio's People.`, subject: { decision: decision.id, group: id } });
      }
    }
  }
  // Who decides that a responsibility an end leaves out does not apply: a group with nobody in it left
  // a Story that ended there unable to finish (2026-10-28 unhappy-paths audit).
  const omissionsChecked = new Set();
  for (const endpoint of resolved?.obligationGraph?.endpoints ?? []) {
    for (const entry of endpoint.omits ?? []) {
      const group = groups.get(entry.authority);
      const key = `${entry.authority}\0${entry.responsibility}`;
      if (group?.status !== 'blocked' || omissionsChecked.has(key)) continue;
      omissionsChecked.add(key);
      add({ code: 'CHECK_GROUP_BLOCKED', area: 'ownership', severity: 'warning', title: `Nobody can decide that ${entry.responsibility} does not apply`,
        detail: `An end of this workflow leaves ${entry.responsibility} out, and group ${group.label} decides that it does not apply. It has no people and no teams, and new people are not added to it automatically, so a Story that ends there can never finish.`,
        fix: `Add people to ${group.label} in Workflow Studio's People.`,
        subject: { ...(endpoint.decision ? { decision: endpoint.decision } : {}), group: entry.authority } });
    }
  }
  const last = workflow.steps.at(-1);
  if (last && workflow.steps.length > 1 && !codeUnsigned && !reviewGaps.has(last.id) && !unreachable.has(last.id) && !signedOff.has(last.id)) {
    add({ code: 'CHECK_LAST_STEP_NO_SIGNOFF', area: 'ownership', severity: 'note', title: `The last step, ${last.label}, needs no sign-off`,
      detail: 'The workflow ends as soon as the last step is submitted.', subject: { step: last.id } });
  }

  // Guidance each step's agent reads.
  const explanationGuidance = new Map();
  const conflicts = new Map();
  const webLinks = new Set();
  for (const step of workflow.steps) {
    const sources = await guidance.forStep(step);
    const links = sources.flatMap((source) => source.scan.links.filter((link) => link.kind !== 'relative').map((link) => ({ ...link, file: source.file })));
    const apiCalls = sources.flatMap((source) => source.scan.apiCalls.map((call) => ({ ...call, file: source.file })));
    explanationGuidance.set(step.id, { links, apiCalls });
    links.forEach((link) => webLinks.add(link.url));
    const actionHosts = new Set((step.afterStep ?? []).map((action) => model.integrations.targets.find((target) => target.id === action.target))
      .flatMap((target) => [target?.url, target?.repository].filter(Boolean)).map((url) => { try { return new URL(url).host; } catch { return null; } }).filter(Boolean));
    for (const call of apiCalls) {
      if (call.host && actionHosts.has(call.host)) continue;
      add({ code: 'CHECK_API_UNPROVIDED', area: 'guidance', severity: 'warning', title: `${step.label} calls an API nothing in the workflow makes`,
        detail: `${call.method} ${call.target} (${call.file} line ${call.line}). The agent needs its own access to it, or the call can become an action after the step.`,
        fix: call.host ? `Add an action after ${step.label} that tells ${call.host}, or make sure the agent can reach it.` : 'Make sure the agent can reach this API, or move the call into an action after the step.',
        subject: { step: step.id }, location: { file: call.file, line: call.line } });
    }
    for (const conflict of guidanceConflicts(sources.map((source) => ({ file: source.file, scan: source.scan })))) {
      const key = `${conflict.first.file}:${conflict.first.line}\0${conflict.second.file}:${conflict.second.line}`;
      if (!conflicts.has(key)) conflicts.set(key, { conflict, steps: [] });
      conflicts.get(key).steps.push(step);
    }
  }
  for (const { conflict, steps } of conflicts.values()) {
    add({ code: 'CHECK_GUIDANCE_CONFLICT', area: 'guidance', severity: 'note',
      title: `Possible conflict in what ${steps.map((step) => step.label).join(', ')} ${steps.length === 1 ? 'is' : 'are'} told`,
      detail: `"${conflict.first.text}" (${conflict.first.file} line ${conflict.first.line}) and "${conflict.second.text}" (${conflict.second.file} line ${conflict.second.line}).`,
      fix: 'Keep one of the two rules, or say when each applies.', subject: { step: steps[0].id },
      location: { file: conflict.first.file, line: conflict.first.line }, related: [{ file: conflict.second.file, line: conflict.second.line }] });
  }
  if (webLinks.size) {
    add({ code: 'CHECK_LINKS_EXTERNAL', area: 'guidance', severity: 'note', title: `The guidance links to ${webLinks.size} web ${webLinks.size === 1 ? 'page' : 'pages'}`,
      detail: 'Agents see these links as text; nothing fetches them. Copy what matters into a skill or instruction, or import it as a pinned copy.', subject: {} });
  }

  // Clarity.
  const byLabel = new Map();
  for (const step of workflow.steps) {
    const key = step.label.trim().toLowerCase();
    byLabel.set(key, [...(byLabel.get(key) ?? []), step]);
  }
  for (const steps of byLabel.values()) {
    if (steps.length > 1) {
      add({ code: 'CHECK_STEP_LABEL_DUPLICATE', area: 'clarity', severity: 'note', title: `${steps.length} steps are called ${steps[0].label}`,
        detail: `Steps ${steps.map((step) => step.id).join(', ')} share a name, so people cannot tell them apart.`, fix: 'Rename one of them.', subject: { step: steps[1].id } });
    }
  }
  // A seeded step cannot take a description here, so it is not asked for one.
  const protectedSteps = new Set(model.protection?.phases ?? []);
  const undescribed = workflow.steps.filter((step) => !step.description && !protectedSteps.has(step.id));
  if (!workflow.readOnly && undescribed.length) {
    add({ code: 'CHECK_STEPS_UNDESCRIBED', area: 'clarity', severity: 'note',
      title: undescribed.length === 1 ? `${undescribed[0].label} does not say what it is for` : `${undescribed.length} steps do not say what they are for`,
      detail: `Without a description: ${undescribed.map((step) => step.label).join(', ')}.`, fix: "Add a description in the step's properties in Workflow Studio.", subject: {} });
  }
  return { findings, resolved, explanationGuidance };
}

/** Findings about the repository's own agents, skills, instructions and links, not one workflow. */
async function checkAssets({ model, definition, guidance, configRoot, attachmentsText }) {
  const findings = [];
  const add = (entry) => findings.push(finding(entry));
  const stepsUsed = new Set(model.workflows.flatMap((workflow) => workflow.phases));
  const drafting = new Set(model.workflows.flatMap((workflow) => workflow.steps.map((step) => step.agent)).filter(Boolean));
  const reviewers = new Set(Object.values(definition.workTypes ?? {}).map((type) => type?.sourceReview?.reviewerAgent).filter(Boolean));
  for (const agent of model.agents.filter((entry) => entry.scope === 'repository')) {
    // An agent that drafts nothing by default can still be picked by hand for the steps it lists.
    if (drafting.has(agent.id) || reviewers.has(agent.id) || !agent.phases.length || agent.phases.some((phase) => stepsUsed.has(phase))) continue;
    add({ code: 'CHECK_AGENT_UNUSED', area: 'assets', severity: 'note', title: `Agent ${agent.label} can run no step of any workflow`,
      detail: `It drafts no step by default, reviews nothing, and the steps it lists (${agent.phases.join(', ')}) are in no workflow.`,
      fix: 'Make it the default for a step, or remove it.', subject: { agent: agent.id }, location: agent.path ? { file: agent.path, line: 1 } : null });
  }
  for (const skill of model.skills ?? []) {
    if ((skill.usedBy ?? []).length) continue;
    add({ code: 'CHECK_SKILL_UNUSED', area: 'assets', severity: 'note', title: `Skill ${skill.label} is attached to nothing`,
      detail: 'No agent or workflow uses it, so no step ever reads it.', fix: 'Attach it to an agent or a workflow, or remove it.',
      subject: { skill: skill.id }, location: { file: skill.path, line: 1 } });
  }
  for (const item of model.instructions ?? []) {
    if ((item.usedBy ?? []).length) continue;
    add({ code: 'CHECK_INSTRUCTION_UNUSED', area: 'assets', severity: 'note', title: `Instruction ${item.label} is placed in no skill`,
      detail: 'Instructions reach an agent only through a skill that places them.', fix: `Place it in a skill with <instruction>${item.id}</instruction>, or remove it.`,
      subject: { instruction: item.id }, location: { file: item.path, line: 1 } });
  }
  const texts = new Map();
  for (const item of model.instructions ?? []) {
    const key = String(item.instructions ?? '').replace(/\s+/gu, ' ').trim().toLowerCase();
    if (key) texts.set(key, [...(texts.get(key) ?? []), item]);
  }
  for (const items of texts.values()) {
    if (items.length < 2) continue;
    add({ code: 'CHECK_INSTRUCTION_DUPLICATE', area: 'assets', severity: 'note', title: `${items.length} instructions say the same thing`,
      detail: `${items.map((item) => item.label).join(', ')} have the same text.`, fix: 'Keep one and place it wherever the others are used.',
      subject: { instruction: items[1].id }, location: { file: items[1].path, line: 1 }, related: [{ file: items[0].path, line: 1 }] });
  }
  const locateAttachment = yamlLocator(attachmentsText ?? '', SKILL_ATTACHMENTS_PATH);
  const attachments = (() => { try { return YAML.parse(attachmentsText ?? '')?.attachments ?? []; } catch { return []; } })();
  for (const agent of model.agents) {
    for (const entry of agent.skills ?? []) {
      const strays = (entry.phases ?? []).filter((phase) => !agent.defaultFor.includes(phase) && stepsUsed.has(phase));
      if (!strays.length) continue;
      const index = attachments.findIndex((item) => item?.agent === agent.id && item?.skill === entry.id);
      add({ code: 'CHECK_SKILL_STEP_UNUSED', area: 'assets', severity: 'warning',
        title: `Skill ${entry.id} is attached to ${agent.label} for steps it does not draft`,
        detail: `${agent.label} is not the default agent for ${strays.join(', ')}, so the skill is read there only if someone picks ${agent.label} by hand.`,
        fix: 'Attach the skill to the agent that drafts those steps, or to the workflow.', subject: { agent: agent.id, skill: entry.id },
        location: entry.origin === 'attachments' && index >= 0 ? locateAttachment(['attachments', index]) : agent.path ? { file: agent.path, line: 1 } : null });
    }
  }
  for (const pending of guidance.scans.values()) {
    const source = await pending;
    if (!source) continue;
    for (const link of source.scan.links.filter((entry) => entry.kind === 'relative' && entry.target)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(source.file), link.target));
      // Links that leave the configuration point at application files this configuration copy does not hold.
      if (target.startsWith('../') || path.posix.isAbsolute(target)) continue;
      if (await exists(path.join(configRoot, target))) continue;
      add({ code: 'CHECK_LINK_BROKEN', area: 'guidance', severity: 'warning', title: `A link in ${source.file} points at a file that does not exist`,
        detail: `${link.target} (line ${link.line}) does not exist, so the agent cannot follow it.`, fix: 'Fix the path, or remove the link.',
        subject: { file: source.file }, location: { file: source.file, line: link.line } });
    }
  }
  return findings;
}

/**
 * The located findings for steps no agent drafts (src/agents.mjs agentMappingProblems), on the agent
 * files that would fix them. A step takes its agent from `sflow-phases` (may draft it) and
 * `sflow-default-for` (drafts it) in exactly one agent file; the move and change set op are given
 * only when exactly one agent sensibly fits, and choosing it stays the person's decision.
 */
async function agentMappingFindings(problems, { model, definition, locate, configRoot }) {
  const agents = new Map(model.agents.map((agent) => [agent.id, agent]));
  const lines = new Map();
  const defaultLine = async (agent) => {
    if (!agent?.path) return null;
    if (!lines.has(agent.path)) {
      lines.set(agent.path, readFile(path.join(configRoot, agent.path), 'utf8').then((text) => {
        const index = text.split('\n').findIndex((line) => /^\s*sflow-default-for\s*:/u.test(line));
        return index >= 0 ? index + 1 : 1;
      }, () => 1));
    }
    return { file: agent.path, line: await lines.get(agent.path) };
  };
  const findings = [];
  for (const problem of problems) {
    const id = problem.phaseId;
    const label = model.phases.find((phase) => phase.id === id)?.label ?? id;
    const usedBy = model.workflows.filter((workflow) => workflow.phases.includes(id));
    let candidates = (problem.code === 'AGENT_PHASE_DEFAULT_AMBIGUOUS' ? problem.defaults : problem.compatible).map((entry) => agents.get(entry.id) ?? entry);
    if (!candidates.length) {
      // No agent lists the step: the agents that draft steps writing the same kind of document,
      // else this workflow's other steps with the same output.
      const output = model.phases.find((phase) => phase.id === id)?.output ?? null;
      const kind = definition.phases?.[id]?.artifact?.kind ?? null;
      const draftedBy = (steps) => [...new Set(steps.filter((step) => step.id !== id && step.agent && step.output === output).map((step) => step.agent))]
        .map((agentId) => agents.get(agentId)).filter(Boolean);
      candidates = kind ? draftedBy(model.phases.filter((phase) => definition.phases?.[phase.id]?.artifact?.kind === kind)) : [];
      if (!candidates.length) candidates = draftedBy(usedBy.flatMap((workflow) => workflow.steps));
    }
    const where = (agent) => agent.path ?? 'a packaged agent; Workflow Studio copies it into .github/agents';
    const named = candidates.map((agent) => `${agent.label ?? agent.id} (${where(agent)})`);
    const others = model.agents.filter((agent) => agent.scope === 'repository' && agent.path).slice(0, 6).map((agent) => agent.path);
    const one = problem.code !== 'AGENT_PHASE_DEFAULT_AMBIGUOUS' && candidates.length === 1 ? candidates[0] : null;
    const title = problem.code === 'AGENT_PHASE_UNMAPPED' ? `No agent can draft ${label}`
      : problem.code === 'AGENT_PHASE_DEFAULT_MISSING' ? `No agent drafts ${label}` : `${problem.defaults.length} agents each claim to draft ${label}`;
    const text = problem.code === 'AGENT_PHASE_DEFAULT_AMBIGUOUS'
      ? `Keep '${id}' in sflow-default-for of exactly one of ${named.join(', ')}, and remove it from the others; or choose the step's agent in Workflow Studio.`
      : candidates.length
        ? `Add '${id}' to sflow-phases and sflow-default-for in ${named.join(' or ')}; or choose the step's agent in Workflow Studio.`
        : `Add '${id}' to sflow-phases and sflow-default-for in the agent file that should draft it${others.length ? ` (agents here: ${others.join(', ')})` : ''}; or choose the step's agent in Workflow Studio.`;
    const location = (one ? await defaultLine(one) : null) ?? locate(['phases', id]) ?? (candidates[0] ? await defaultLine(candidates[0]) : null);
    const related = (await Promise.all(candidates.filter((agent) => agent !== one).map(defaultLine))).filter(Boolean);
    findings.push(finding({
      code: problem.code, area: 'ownership', severity: 'problem', title,
      detail: `${problem.message} No command can read the workflow configuration until exactly one agent file lists '${id}' in sflow-phases and sflow-default-for`
        + `${usedBy.length ? `; ${usedBy.map((workflow) => workflow.label).join(', ')} ${usedBy.length === 1 ? 'uses' : 'use'} the step.` : ', even though no workflow uses the step.'}`,
      subject: { step: id, workflows: usedBy.map((workflow) => workflow.id), agents: candidates.map((agent) => agent.id) },
      location, related,
      fix: one ? { text, move: { move: 'step.change', id, agent: one.id }, changes: [{ op: 'phase.agent', phase: id, agent: one.id }] } : text,
      blocksStart: true
    }));
  }
  return findings;
}

/** A configuration that does not load: every located problem, each refusing every Story. */
function unreadableConfiguration(base, error) {
  const located = error?.details?.configurationProblems ?? [];
  const findings = located.length
    ? located.map((problem) => finding({ code: problem.code ?? error.code ?? 'CONFIGURATION_INVALID', area: 'flow', severity: 'problem',
      title: firstSentence(problem.message), detail: problem.message, fix: problem.fix ?? null, subject: { file: problem.file ?? WORKFLOW_PATH },
      location: problem.line ? { file: problem.file ?? WORKFLOW_PATH, line: problem.line } : null, blocksStart: true }))
    : [finding({ code: error?.code ?? 'CONFIGURATION_INVALID', area: 'flow', severity: 'problem', title: 'The workflow configuration cannot be read',
      detail: error.message, subject: { file: WORKFLOW_PATH }, blocksStart: true })];
  return { ...base, configuration: { valid: false }, counts: countsOf(findings), workflows: [], repository: { counts: countsOf(findings), findings } };
}

/**
 * Explain and check the workflows at `root` (the approved configuration when the caller reads in its
 * scope). `workflows` limits the result to those IDs; repository findings are always included.
 *
 * A configuration that does not load is reported as its located problems. When only a step without
 * an agent stops it, the workflows are still read without agents and checked, so the person sees the
 * agent files to fix and everything else at once; `configuration.valid` stays false.
 */
export async function checkWorkflowConfiguration(root, { workflows: only = null } = {}) {
  const configRoot = configurationReadRoot(root);
  const text = await readFile(path.join(configRoot, WORKFLOW_PATH), 'utf8').catch(() => null);
  const base = { schemaVersion: 1, resultType: 'workflow-check' };
  let definition;
  let unmappedRefusal = null;
  try { definition = await loadDefinition(root); }
  catch (error) {
    if (!AGENT_MAPPING_CODES.includes(error?.code) || !Array.isArray(error.details?.problems)) return unreadableConfiguration(base, error);
    // Agents are what refused; the workflows themselves load (agents are read after them).
    definition = await loadDefinition(root, { storyBootstrap: true }).catch(() => null);
    if (!definition) return unreadableConfiguration(base, error);
    unmappedRefusal = error;
  }
  const model = await buildStudioModel(root);
  if (only) {
    const unknown = only.filter((id) => !model.workflows.some((workflow) => workflow.id === id));
    if (unknown.length) {
      const { SingularityFlowError } = await import('./util.mjs');
      throw new SingularityFlowError(`There is no workflow '${unknown[0]}'. Workflows here: ${model.workflows.map((workflow) => workflow.id).join(', ')}.`,
        { code: 'WORKFLOW_UNKNOWN', details: { workflow: unknown[0], workflows: model.workflows.map((workflow) => workflow.id) } });
    }
  }
  const locate = yamlLocator(text, WORKFLOW_PATH);
  const groups = new Map(model.groups.map((group) => [group.id, group]));
  const guidance = new GuidanceReader(configRoot, model);
  const templates = templateReader(configRoot, definition.templatesRoot ?? model.templatesRoot);
  const mapping = unmappedRefusal ? await agentMappingFindings(unmappedRefusal.details.problems, { model, definition, locate, configRoot }) : [];
  const unmapped = new Set(mapping.map((entry) => entry.subject.step));
  const results = [];
  for (const workflow of model.workflows) {
    if (only && !only.includes(workflow.id)) continue;
    const { findings, resolved, explanationGuidance } = await checkWorkflow(workflow, { definition, model, locate, guidance, groups, templates, unmapped });
    results.push({
      id: workflow.id, label: workflow.label, readOnly: Boolean(workflow.readOnly),
      explanation: explainWorkflow(model, workflow.id, { resolved, guidance: explanationGuidance }),
      counts: countsOf(findings), findings
    });
  }
  // Every repository-owned file is scanned, so assets judge links in guidance no step reads too.
  for (const agent of model.agents.filter((entry) => entry.scope === 'repository' && entry.path)) await guidance.scan(agent.path);
  for (const skill of model.skills ?? []) await guidance.scan(skill.path);
  for (const item of model.instructions ?? []) await guidance.scan(item.path);
  const attachmentsText = await readFile(path.join(configRoot, SKILL_ATTACHMENTS_PATH), 'utf8').catch(() => null);
  const repository = [...mapping, ...await checkAssets({ model, definition, guidance, configRoot, attachmentsText })];
  const all = [...results.flatMap((entry) => entry.findings), ...repository];
  return {
    ...base,
    authority: model.authority,
    configuration: unmappedRefusal ? { valid: false, code: unmappedRefusal.code, checked: 'without-agents' } : { valid: true },
    counts: countsOf(all),
    workflows: results,
    repository: { counts: countsOf(repository), findings: repository }
  };
}

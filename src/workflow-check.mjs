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
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { loadDefinition, resolveWorkType, WORKFLOW_PATH } from './config.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { guidanceConflicts, scanGuidanceText } from './guidance-scan.mjs';
import { phaseTopologyFindings } from './phase-semantics.mjs';
import { SKILL_ATTACHMENTS_PATH } from './skill-library.mjs';
import { explainWorkflow } from './workflow-explanation.mjs';
import { simulateWorkflowRoutes } from './workflow-route-simulation.mjs';
import { buildStudioModel } from './workflow-studio.mjs';

export const CHECK_SEVERITIES = Object.freeze(['problem', 'warning', 'note']);
export const CHECK_AREAS = Object.freeze(['flow', 'ownership', 'assets', 'guidance', 'clarity']);
const END = '\0end';

const firstSentence = (text) => String(text ?? '').split(/(?<=[.!?])\s+/u)[0].trim();
const countsOf = (findings) => Object.fromEntries(CHECK_SEVERITIES.map((severity) => [severity, findings.filter((entry) => entry.severity === severity).length]));

function finding({ code, area, severity, title, detail = null, subject = {}, location = null, related = [], fix = null }) {
  const key = JSON.stringify([code, subject, location?.file ?? null, location?.line ?? null, related.map((entry) => `${entry.file}:${entry.line}`)]);
  return {
    id: `f-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`,
    code, area, severity, title, detail, subject,
    ...(location ? { location } : {}),
    ...(related.length ? { related } : {}),
    ...(fix ? { fix: { text: fix } } : {})
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
  WORKFLOW_REJECTION_TARGET: ({ step }) => `Rejecting ${step} sends work forward instead of back`
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
  WORKFLOW_AUTHORITY_UNKNOWN: 'Choose an existing approval group, or create the group first.'
});

/** Check one workflow of the model; returns its findings. */
async function checkWorkflow(workflow, { definition, model, locate, guidance, groups }) {
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
      detail: error.message, subject: {} });
  }

  // Flow: the engine's own rules.
  if (resolved) {
    for (const entry of resolved.obligationGraph?.findings ?? []) {
      const step = entry.subject?.phase ?? null;
      if (step && (REVIEW_GAPS.has(entry.code) || entry.subject?.missing?.includes('review'))) reviewGaps.add(step);
      const detail = String(entry.message).replace(/^Work type '[^']*':\s*/u, '');
      const title = OBLIGATION_TITLES[entry.code]?.({ step: step ? stepLabel(step) : 'this step', missing: entry.subject?.missing ?? [] }) ?? firstSentence(detail);
      add({ code: entry.code, area: 'flow', severity: entry.severity === 'error' ? 'problem' : 'warning',
        title, detail: detail.charAt(0).toUpperCase() + detail.slice(1), fix: entry.resolvingAction ?? null,
        subject: { ...(entry.subject?.phase ? { step: entry.subject.phase } : {}), ...(entry.subject?.decision ? { decision: entry.subject.decision } : {}) } });
    }
    for (const entry of phaseTopologyFindings(resolved)) {
      add({ code: entry.code, area: 'flow', severity: 'problem', title: firstSentence(entry.message), detail: entry.message,
        subject: { step: entry.phaseId } });
    }
    if (['migration-required', 'retired-opt-out'].includes(resolved.plannedClaims?.mode)) {
      add({ code: 'CHECK_PLANNED_CLAIMS', area: 'flow', severity: 'problem',
        title: 'A code step has no requirements step before it',
        detail: String(resolved.plannedClaims.reason ?? 'Story start refuses a code step without an earlier step that defines requirement clauses.'),
        fix: 'Add a requirements or implementation-spec step before the code step, or declare why scope does not apply.', subject: {} });
    }
    let simulation = null;
    try { simulation = simulateWorkflowRoutes(resolved, { approvalAuthorities: definition.approvalAuthorities }); }
    catch (error) {
      add({ code: 'CHECK_ROUTES_UNREADABLE', area: 'flow', severity: 'problem', title: 'The routes of this workflow cannot be followed', detail: error.message, subject: {} });
    }
    for (const entry of simulation?.findings ?? []) {
      if (entry.code === 'WORKFLOW_PHASE_UNREACHABLE' && entry.phase) unreachable.add(entry.phase);
      const words = { decision: entry.decision ? decisionOf(entry.decision)?.label ?? entry.decision : null, step: entry.phase ? stepLabel(entry.phase) : null };
      add({ code: entry.code, area: 'flow', severity: entry.code === 'WORKFLOW_ROUTE_UNREACHABLE' ? 'warning' : 'problem',
        title: (ROUTE_TITLES[entry.code] ?? (() => firstSentence(entry.message)))(words), detail: entry.message, fix: ROUTE_FIXES[entry.code] ?? null,
        subject: { ...(entry.phase ? { step: entry.phase } : {}), ...(entry.decision ? { decision: entry.decision } : {}) } });
    }
  }

  // Who owns each step: an agent to draft it, people to sign it off.
  const signedOff = new Set(workflow.steps.filter((step) => step.approval?.mode !== 'none').map((step) => step.id));
  let codeUnsigned = false;
  for (const step of workflow.steps) {
    if (!step.agent) {
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
 * Explain and check the workflows at `root` (the approved configuration when the caller reads in its
 * scope). `workflows` limits the result to those IDs; repository findings are always included.
 */
export async function checkWorkflowConfiguration(root, { workflows: only = null } = {}) {
  const configRoot = configurationReadRoot(root);
  const text = await readFile(path.join(configRoot, WORKFLOW_PATH), 'utf8').catch(() => null);
  const base = { schemaVersion: 1, resultType: 'workflow-check' };
  let definition;
  try { definition = await loadDefinition(root); }
  catch (error) {
    const located = error?.details?.configurationProblems ?? [];
    const findings = located.length
      ? located.map((problem) => finding({ code: problem.code ?? error.code ?? 'CONFIGURATION_INVALID', area: 'flow', severity: 'problem',
        title: firstSentence(problem.message), detail: problem.message, fix: problem.fix ?? null, subject: { file: problem.file ?? WORKFLOW_PATH },
        location: problem.line ? { file: problem.file ?? WORKFLOW_PATH, line: problem.line } : null }))
      : [finding({ code: error?.code ?? 'CONFIGURATION_INVALID', area: 'flow', severity: 'problem', title: 'The workflow configuration cannot be read',
        detail: error.message, subject: { file: WORKFLOW_PATH } })];
    return { ...base, configuration: { valid: false }, counts: countsOf(findings), workflows: [], repository: { counts: countsOf(findings), findings } };
  }
  const model = await buildStudioModel(root);
  if (only) {
    const unknown = only.filter((id) => !model.workflows.some((workflow) => workflow.id === id));
    if (unknown.length) {
      const { SingularityFlowError } = await import('./util.mjs');
      throw new SingularityFlowError(`There is no workflow '${unknown[0]}'. Workflows here: ${model.workflows.map((workflow) => workflow.id).join(', ')}.`, { code: 'WORKFLOW_UNKNOWN' });
    }
  }
  const locate = yamlLocator(text, WORKFLOW_PATH);
  const groups = new Map(model.groups.map((group) => [group.id, group]));
  const guidance = new GuidanceReader(configRoot, model);
  const results = [];
  for (const workflow of model.workflows) {
    if (only && !only.includes(workflow.id)) continue;
    const { findings, resolved, explanationGuidance } = await checkWorkflow(workflow, { definition, model, locate, guidance, groups });
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
  const repository = await checkAssets({ model, definition, guidance, configRoot, attachmentsText });
  const all = [...results.flatMap((entry) => entry.findings), ...repository];
  return {
    ...base,
    authority: model.authority,
    configuration: { valid: true },
    counts: countsOf(all),
    workflows: results,
    repository: { counts: countsOf(repository), findings: repository }
  };
}

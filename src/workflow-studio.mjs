/**
 * Workflow Studio: shape a workflow, its steps, the agent that drafts each step and the people who
 * sign it off, and publish all of it as one governed change.
 *
 * Why a change set rather than more single commands: a Story phase gets its agent from the agent's
 * own Markdown (`sflow-default-for`), every phase needs exactly one default, and a configuration
 * save is one file. So "add a step with a new agent" or "move a step to another agent" had no valid
 * single-file route: each file alone fails the whole-catalog check. Here every edit is a typed
 * operation applied to a candidate copy of the configuration, the whole candidate is validated
 * the way a Configuration Center save validates one file, and only then are the changed files
 * written — in one review proposal, or in a local authority's working tree.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { loadDefinition, resolveWorkType, validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { discoverAgents, parseAgentDependencies } from './agents.mjs';
import { normalizeApprovalSecurity } from './approval-authority.mjs';
import { workflowCodeGeneration } from './code-delivery-policy.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { loadPortfolio } from './initiative-config.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { SingularityFlowError, YAML_OUTPUT, posix } from './util.mjs';
import { STORES, pinAuthoredStoryPlannedClaims } from './workflow-authoring.mjs';

export const STUDIO_CHANGE_SET_SCHEMA = 'sflow-studio-change-set@1';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CHANGES = 200;
const MAX_DIFF_LINES = 400;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** What a step makes, in the words the Studio shows; each maps to the engine's generation contract. */
export const STEP_OUTPUTS = Object.freeze([
  Object.freeze({ id: 'document', label: 'A document' }),
  Object.freeze({ id: 'analysis', label: 'An analysis' }),
  Object.freeze({ id: 'code', label: 'Code changes and a summary' }),
  Object.freeze({ id: 'none', label: 'Nothing (sign-off only)' })
]);

export const CLARIFICATION_MODES = Object.freeze([
  Object.freeze({ id: 'off', label: 'Never' }),
  Object.freeze({ id: 'when-needed', label: 'When something is unclear' }),
  Object.freeze({ id: 'required', label: 'Always, before drafting' })
]);

/** Tool IDs an agent may declare, with the plain words a person picks them by. */
const TOOL_LABELS = Object.freeze({
  read: 'Read files', search: 'Search the repository', edit: "Edit the step's document",
  bash: 'Run commands', execute: 'Run tests and tasks', ask_user: 'Ask you questions',
  web: 'Search the web', 'playwright/*': 'Use a browser', 'figma/*': 'Read Figma designs'
});

/** Every bundled agent opens and closes with the same operating rules; a new agent does too. */
const AGENT_PREAMBLE = 'Resolve the active Story checkout with `singularity-flow session current --json`; require `ready`, bind `workId`, and use its absolute `repositoryPath` as cwd for every shell and file tool. Otherwise use `git rev-parse --show-toplevel`; if neither resolves, stop. Never search `$HOME`, a parent directory, or outside that repository. Governed artifacts are under `singularity/work-items/<WORK-ID>/`.';
const AGENT_CLARIFICATION = "Obey the composed phase prompt's pinned clarification mode before this agent guidance. For `off`, never ask or record phase clarification. For `when-needed`, ask and record only when material ambiguity remains; otherwise continue without a record. For `required`, use `ask_user` and wait before authoring; if evidence appears complete, ask the contributor to confirm the interpreted outcome, boundaries, and acceptance criteria, then record the accepted batch with `singularity-flow clarification record <phase> --response-file <json>`. Do not silently replace required clarification with an Open questions section.";

/** Starting points for a new agent: tools, knowledge views and instructions a person then edits. */
export const AGENT_ROLES = Object.freeze([
  Object.freeze({ id: 'analyst', label: 'Analyst', hint: 'Compares options and writes analyses', tools: ['read', 'search', 'edit', 'ask_user'], views: ['business'], instructions: 'Read only the approved inputs named in the composed phase prompt. Compare the options against the stated criteria in one table, give the evidence for every judgement, and list open questions instead of guessing. Stop for human review when the analysis is written.' }),
  Object.freeze({ id: 'product-owner', label: 'Product owner', hint: 'Intake, requirements, outcomes', tools: ['read', 'search', 'edit', 'bash', 'ask_user'], views: ['business'], instructions: 'Restate the request as measurable outcomes and acceptance criteria. Keep scope explicit: what is in, what is out, and what is assumed. Cite the evidence each requirement rests on.' }),
  Object.freeze({ id: 'architect', label: 'Architect', hint: 'Designs and specifications', tools: ['read', 'search', 'edit', 'bash', 'ask_user'], views: ['architecture', 'security'], instructions: 'Define boundaries, contracts, data flow and risks for the approved requirements. Prefer the smallest design that follows existing repository patterns, and record every decision with its alternatives.' }),
  Object.freeze({ id: 'developer', label: 'Developer', hint: 'Changes code and tests', tools: ['read', 'search', 'edit', 'bash', 'ask_user'], views: ['development', 'testing'], instructions: 'Implement the approved specification with the smallest coherent change that follows existing conventions, error handling and tests. Record changed files, commands actually run, and residual risk.' }),
  Object.freeze({ id: 'tester', label: 'Tester', hint: 'Verifies against the spec', tools: ['read', 'search', 'edit', 'bash', 'ask_user'], views: ['testing'], instructions: 'Verify behaviour against the approved specification. Record each check, the command or steps used, the observed result and the evidence, and report gaps rather than passing them.' }),
  Object.freeze({ id: 'designer', label: 'Designer', hint: 'Works from designs', tools: ['read', 'search', 'edit', 'ask_user'], views: ['business'], instructions: 'Work from the approved design sources. Name each screen and component you rely on, note gaps between the design and the request, and keep visual decisions traceable to the source.' }),
  Object.freeze({ id: 'reviewer', label: 'Reviewer', hint: "Checks others' work", tools: ['read', 'search', 'edit', 'ask_user'], views: [], instructions: "Review the approved inputs and the step's draft against the stated criteria. List each finding with its evidence and severity, and separate blocking issues from suggestions." }),
  Object.freeze({ id: 'blank', label: 'Blank', hint: 'Write it yourself', tools: ['read', 'search', 'edit'], views: [], instructions: 'Describe what this agent should do in each step it drafts.' })
]);

// ---------------------------------------------------------------------------------------------
// Reading

async function packagedDefinition() {
  const text = await readFile(path.join(PACKAGE_ROOT, 'templates', 'workflow.yml'), 'utf8');
  // Two copies: the validated one answers questions, the raw one is what gets copied, so an
  // installed blueprint reads like the packaged file rather than like its normalised form.
  return Object.assign(validateDefinition(YAML.parse(text)), { raw: YAML.parse(text) });
}

function outputOf(phase = {}) {
  if (phase.generation?.requirement === 'none' || phase.generation === 'none') return 'none';
  const task = typeof phase.generation === 'string' ? phase.generation : phase.generation?.task;
  if (task === 'code' || phase.writeScope === 'source-and-artifact') return 'code';
  if (task === 'analyze') return 'analysis';
  return 'document';
}

function approvalSummary(approval) {
  if (approval === 'none' || approval?.mode === 'none') return { mode: 'none', authorities: [], minimum: 0 };
  return {
    mode: approval?.mode ?? 'required',
    authorities: Array.isArray(approval?.authorities) ? [...approval.authorities] : [],
    minimum: Number.isSafeInteger(approval?.minimum) ? approval.minimum : 1
  };
}

function inputIds(inputs) {
  return (Array.isArray(inputs) ? inputs : []).map((input) => (typeof input === 'string' ? input : input?.phase)).filter(Boolean);
}

/** Whether people can actually sign off with this group, in the terms the Studio shows. */
function groupStatus(group, security) {
  if ((group.members ?? []).length) return 'people';
  if (group.allowAnyGitIdentity ?? security.allowAnyGitIdentity) return 'anyone';
  if ((group.githubTeams ?? []).length) return 'teams';
  return security.autoEnrollNewIdentities ? 'auto' : 'blocked';
}

function agentView(agent) {
  return {
    id: agent.id, label: agent.label ?? agent.id, description: agent.description ?? '',
    scope: agent.scope, phases: [...(agent.phases ?? [])], defaultFor: [...(agent.defaultFor ?? [])],
    tools: [...(agent.tools ?? [])], views: [...(agent.worldModelViews ?? [])],
    path: agent.scope === 'repository' ? agent.source : null,
    instructions: agent.prompt ?? ''
  };
}

/**
 * Everything the Studio shows, from the effective configuration: workflows with the agent that
 * actually drafts each step, the step catalog, agents, approval groups, and installable blueprints.
 */
export async function buildStudioModel(root, { authority = null } = {}) {
  const configRoot = configurationReadRoot(root);
  const definitionText = await readFile(path.join(configRoot, WORKFLOW_PATH), 'utf8');
  const raw = YAML.parse(definitionText) ?? {};
  const problems = [];
  let definition = null;
  try { definition = await loadDefinition(root); }
  catch (error) { problems.push({ code: error?.code ?? 'CONFIGURATION_INVALID', message: error.message }); }
  const discovered = (await discoverAgents(root)).filter((agent) => agent.scope !== 'plugin');
  const security = normalizeApprovalSecurity(raw.approvalSecurity ?? {});
  const starter = await packagedDefinition();
  const bundled = await bundledAgents();
  const workTypes = raw.workTypes ?? {};
  const phases = raw.phases ?? {};
  const defaultAgentOf = (phaseId) => discovered.find((agent) => agent.defaultFor.includes(phaseId))?.id ?? null;
  const usedBy = (phaseId) => Object.entries(workTypes).filter(([, type]) => (type.phases ?? []).includes(phaseId)).map(([id]) => id);

  const workflows = Object.entries(workTypes).map(([id, type]) => {
    let resolved = null;
    try { resolved = definition ? resolveWorkType(definition, id) : null; } catch { resolved = null; }
    const packaged = starter.workTypes[id];
    return {
      id, label: type.label ?? id, description: type.description ?? '', phases: [...(type.phases ?? [])],
      status: !packaged ? 'local' : JSON.stringify(packaged) === JSON.stringify(definition?.workTypes?.[id] ?? type) ? 'packaged' : 'customized',
      generatesCode: resolved ? Boolean(workflowCodeGeneration(resolved).generatesCode) : (type.phases ?? []).some((phase) => outputOf(phases[phase]) === 'code'),
      // Kept whole: a send-back rule's reset phase is part of its repair budget, and a decision is
      // edited in the shape it is written in.
      reworkLoops: (type.reworkLoops ?? []).map((loop) => ({
        from: loop.from, to: loop.to, maxAttempts: loop.maxAttempts,
        ...(loop.resetOnPhase ? { resetOnPhase: loop.resetOnPhase } : {})
      })),
      decisions: structuredClone(type.decisions ?? []),
      steps: (resolved?.phases ?? (type.phases ?? []).map((phaseId) => ({ id: phaseId, ...phases[phaseId] }))).map((phase) => ({
        id: phase.id, label: phase.label ?? phase.id, output: outputOf(phase),
        agent: phase.defaultAgent ?? defaultAgentOf(phase.id),
        approval: approvalSummary(phase.approval), inputs: inputIds(phase.inputs),
        overridden: Boolean(type.phaseOverrides?.[phase.id])
      }))
    };
  });

  return {
    schemaVersion: 1,
    resultType: 'workflow-studio',
    authority: authority ? {
      kind: authority.kind ?? 'working-tree', ref: authority.ref ?? null, commit: authority.commit ?? null,
      remoteFingerprint: authority.remoteFingerprint ?? null, sourceCommit: authority.sourceCommit ?? null
    } : { kind: 'working-tree', ref: null, commit: null, remoteFingerprint: null, sourceCommit: null },
    base: {
      workflowSha256: sha256(definitionText),
      agentsSha256: sha256(discovered.filter((agent) => agent.scope === 'repository').map((agent) => `${agent.id}:${agent.sha256}`).join('\n'))
    },
    problems,
    workflows,
    phases: Object.entries(phases).map(([id, phase]) => ({
      id, label: phase.label ?? id, output: outputOf(phase),
      approval: approvalSummary(phase.approval), inputs: inputIds(phase.inputs),
      views: [...(phase.worldModel?.views ?? [])], clarification: phase.clarification?.mode ?? 'off',
      template: phase.defaultTemplate ?? null, artifact: phase.artifact?.path ?? null,
      usedBy: usedBy(id), agent: defaultAgentOf(id),
      eligibleAgents: discovered.filter((agent) => !agent.phases.length || agent.phases.includes(id)).map((agent) => agent.id)
    })),
    agents: discovered.map(agentView),
    groups: Object.entries(raw.approvalAuthorities ?? {}).map(([id, group]) => ({
      id, label: group?.label ?? id,
      members: (group?.members ?? []).map((member) => ({ name: member?.name ?? null, email: member?.email ?? null, githubLogin: member?.githubLogin ?? null })),
      githubTeams: [...(group?.githubTeams ?? [])],
      status: groupStatus(group ?? {}, security),
      approves: Object.entries(phases).filter(([, phase]) => approvalSummary(phase.approval).authorities.includes(id)).map(([phaseId]) => phaseId)
    })),
    security: { profile: security.profile, autoEnrollNewIdentities: security.autoEnrollNewIdentities },
    blueprintPhases: Object.fromEntries(Object.entries(starter.phases).filter(([id]) => !phases[id]).map(([id, phase]) => {
      const approval = approvalSummary(phase.approval);
      return [id, {
        label: phase.label ?? id, output: outputOf(phase),
        agent: bundled.find((agent) => agent.defaultFor.includes(id))?.id ?? null,
        approval: approval.mode === 'none' ? { group: null, minimum: 1 } : { group: approval.authorities[0] ?? null, minimum: approval.minimum },
        inputs: inputIds(phase.inputs)
      }];
    })),
    blueprints: Object.entries(starter.workTypes).map(([id, type]) => ({
      id, label: type.label ?? id, description: type.description ?? '', phases: [...type.phases],
      installed: Boolean(workTypes[id]),
      generatesCode: type.phases.some((phase) => outputOf(starter.phases[phase]) === 'code')
    })),
    choices: {
      outputs: STEP_OUTPUTS,
      clarification: CLARIFICATION_MODES,
      views: (raw.worldModel?.views ?? definition?.worldModel?.views ?? []).map((view) => String(view).replace(/@[1-9][0-9]*$/, '')),
      tools: [...new Set([...Object.keys(TOOL_LABELS), ...discovered.flatMap((agent) => agent.tools ?? [])])]
        .map((id) => ({ id, label: TOOL_LABELS[id] ?? id })),
      roles: AGENT_ROLES
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Agent files

function splitAgentText(text, label) {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const opening = /^---\r?\n/.exec(normalized);
  if (!opening) throw new SingularityFlowError(`Agent ${label} has no frontmatter.`);
  const remainder = normalized.slice(opening[0].length);
  const closing = /\r?\n---(?:\r?\n|$)/.exec(remainder);
  if (!closing) throw new SingularityFlowError(`Agent ${label} frontmatter is not closed.`);
  return { document: YAML.parseDocument(remainder.slice(0, closing.index)), body: remainder.slice(closing.index + closing[0].length) };
}

function quoted(document, value) {
  const node = document.createNode(value);
  node.type = 'QUOTE_DOUBLE';
  return node;
}

function renderAgent(entry) {
  const base = entry.text ?? `---\nname: ${entry.id}\ndescription: ""\n---\n`;
  const { document, body } = splitAgentText(base, entry.id);
  if (!entry.text) document.set('name', entry.id);
  document.set('description', entry.description);
  document.set('tools', document.createNode([...entry.tools], { flow: true }));
  const metadata = document.get('metadata') ?? document.createNode({});
  if (!document.has('metadata')) document.set('metadata', metadata);
  for (const [key, value] of [
    ['sflow-label', entry.label], ['sflow-phases', entry.phases.join(',')],
    ['sflow-default-for', entry.defaultFor.join(',')], ['sflow-world-model-views', entry.views.join(',')]
  ]) document.setIn(['metadata', key], quoted(document, value));
  const text = entry.body != null ? `\n${entry.body.trim()}\n` : body;
  return `---\n${document.toString(YAML_OUTPUT)}---\n${text}`;
}

function newAgentBody(label, instructions) {
  return [`# ${label} agent`, '', AGENT_PREAMBLE, '', String(instructions ?? '').trim() || 'Describe what this agent should do in each step it drafts.', '', AGENT_CLARIFICATION].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Diffs

/**
 * Line operations turning `a` into `b`: `[' ', i]` keeps a[i], `['-', i]` drops a[i], `['+', j]`
 * adds b[j]. The common head and tail are matched first, so the table only covers the edited
 * region; a region too large for the table becomes one replacement.
 */
function lineOperations(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length; let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const operations = [];
  for (let index = 0; index < start; index += 1) operations.push([' ', index]);
  const lengthA = endA - start; const lengthB = endB - start;
  const cols = lengthB + 1;
  if ((lengthA + 1) * cols <= 4_000_000) {
    const table = new Uint32Array((lengthA + 1) * cols);
    for (let i = lengthA - 1; i >= 0; i -= 1) {
      for (let j = lengthB - 1; j >= 0; j -= 1) {
        table[i * cols + j] = a[start + i] === b[start + j] ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
      }
    }
    let i = 0; let j = 0;
    while (i < lengthA || j < lengthB) {
      if (i < lengthA && j < lengthB && a[start + i] === b[start + j]) { operations.push([' ', start + i]); i += 1; j += 1; }
      else if (j < lengthB && (i >= lengthA || table[i * cols + j + 1] >= table[(i + 1) * cols + j])) { operations.push(['+', start + j]); j += 1; }
      else { operations.push(['-', start + i]); i += 1; }
    }
  } else {
    for (let i = start; i < endA; i += 1) operations.push(['-', i]);
    for (let j = start; j < endB; j += 1) operations.push(['+', j]);
  }
  for (let index = endA; index < a.length; index += 1) operations.push([' ', index]);
  return operations;
}

/**
 * Keep a YAML file's own formatting on every line an edit did not touch.
 *
 * The YAML library re-renders a whole document: flow maps lose their padding and comments move to
 * the indentation of the next key, so an edit to one workflow showed up as a diff across the file.
 * Rendering the unedited document the same way gives a baseline whose lines correspond to the
 * original's; the baseline-to-edited line diff is exactly the edit, so it is replayed onto the
 * original text instead. When the line correspondence or the parsed result is not exact, the
 * library's own rendering is used unchanged.
 */
export function preserveYamlFormatting(original, edited, options = YAML_OUTPUT) {
  const baseline = YAML.parseDocument(original).toString(options);
  const source = original.split('\n'); const before = baseline.split('\n'); const after = edited.split('\n');
  if (source.length !== before.length) return edited;
  const merged = lineOperations(before, after)
    .filter(([kind]) => kind !== '-')
    .map(([kind, index]) => (kind === ' ' ? source[index] : after[index]))
    .join('\n');
  try {
    return JSON.stringify(YAML.parse(merged)) === JSON.stringify(YAML.parse(edited)) ? merged : edited;
  } catch {
    return edited;
  }
}

/** A unified diff of two texts, trimmed to the changed region with three lines of context. */
export function unifiedDiff(before, after, file) {
  const a = before ? before.split('\n') : [];
  const b = after.split('\n');
  const operations = lineOperations(a, b);
  const first = operations.findIndex(([kind]) => kind !== ' ');
  if (first < 0) return '';
  let last = operations.length - 1;
  while (last > first && operations[last][0] === ' ') last -= 1;
  const from = Math.max(0, first - 3); const to = Math.min(operations.length - 1, last + 3);
  const lines = [`--- ${before == null ? '/dev/null' : `a/${file}`}`, `+++ b/${file}`, '@@',
    ...operations.slice(from, to + 1).map(([kind, index]) => `${kind}${kind === '+' ? b[index] : a[index]}`)];
  return lines.length > MAX_DIFF_LINES ? [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more lines`].join('\n') : lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// The candidate

const RANK = Object.freeze({
  'group.create': 0, 'group.update': 1, 'agent.create': 2, 'workflow.install': 3, 'phase.create': 4,
  'phase.update': 5, 'workflow.create': 6, 'workflow.update': 7, 'phase.agent': 8, 'agent.update': 9
});

function requireId(value, label) {
  const id = String(value ?? '').trim();
  if (!ID.test(id)) throw new SingularityFlowError(`${label} must be lower-case kebab-case, like vendor-analysis.`, { code: 'STUDIO_ID_INVALID' });
  return id;
}

function requireLabel(value, label) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 120) throw new SingularityFlowError(`${label} needs a name of 1 to 120 characters.`, { code: 'STUDIO_LABEL_INVALID' });
  return text;
}

function starterTemplate(id, label) {
  return [`# ${label}`, '', `A starter for the ${id} step. Replace this with what the step actually has to answer;`,
    'the engine checks that the artifact is at least a couple of hundred bytes, not that it is good.', '',
    '## What this step decides', '', '## Evidence', '', '## Open questions', ''].join('\n');
}

class StudioCandidate {
  constructor(sources) {
    this.sources = sources;
    this.document = YAML.parseDocument(sources.definitionText);
    this.agents = new Map(sources.agents.map((agent) => [agent.id, {
      id: agent.id, scope: agent.scope, text: agent.text, relative: agent.scope === 'repository' ? agent.source : null,
      fileName: path.basename(agent.file ?? `${agent.id}.agent.md`),
      label: agent.label ?? agent.id, description: agent.description ?? '', tools: [...(agent.tools ?? [])],
      views: [...(agent.worldModelViews ?? [])], phases: [...(agent.phases ?? [])], defaultFor: [...(agent.defaultFor ?? [])],
      body: null, touched: false, created: false
    }]));
    this.templates = new Map();
    this.summary = [];
    this.workflows = new Map();
  }

  get content() { return this.document.toJS() ?? {}; }
  phase(id) { return this.content.phases?.[id] ?? null; }
  phaseLabel(id) { return this.phase(id)?.label ?? id; }
  agentLabel(id) { return this.agents.get(id)?.label ?? id; }
  usedBy(phaseId) {
    return Object.entries(this.content.workTypes ?? {}).filter(([, type]) => (type.phases ?? []).includes(phaseId)).map(([id]) => id);
  }

  requirePhase(id) {
    if (!this.phase(id)) throw new SingularityFlowError(`There is no step '${id}'.`, { code: 'STUDIO_PHASE_UNKNOWN' });
    return id;
  }

  requireAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) throw new SingularityFlowError(`There is no agent '${id}'.`, { code: 'STUDIO_AGENT_UNKNOWN' });
    return agent;
  }

  requireGroup(id) {
    if (!this.content.approvalAuthorities?.[id]) throw new SingularityFlowError(`There is no approval group '${id}'.`, { code: 'STUDIO_GROUP_UNKNOWN' });
    return id;
  }

  touch(agent) {
    // A bundled agent becomes a repository copy the moment it is changed: repository agents win
    // discovery by ID, so the copy replaces it everywhere, and the change lands in this repository.
    agent.touched = true;
    if (!agent.relative) agent.relative = posix(path.join('.github', 'agents', agent.fileName));
    return agent;
  }

  setDefaultAgent(phaseId, agentId) {
    const target = this.requireAgent(agentId);
    const previous = [...this.agents.values()].filter((agent) => agent.defaultFor.includes(phaseId));
    if (previous.length === 1 && previous[0].id === agentId) return null;
    for (const agent of previous) {
      if (agent.id === agentId) continue;
      this.touch(agent).defaultFor = agent.defaultFor.filter((phase) => phase !== phaseId);
    }
    this.touch(target);
    if (!target.defaultFor.includes(phaseId)) target.defaultFor = [...target.defaultFor, phaseId];
    // An agent made here is eligible for exactly the steps it drafts; an existing one keeps its own list.
    if ((target.created || target.phases.length) && !target.phases.includes(phaseId)) target.phases = [...target.phases, phaseId];
    return previous.find((agent) => agent.id !== agentId)?.id ?? null;
  }

  approvalNode(approval, existing = null) {
    if (approval == null) return undefined;
    if (approval === 'none') return 'none';
    const group = this.requireGroup(requireId(approval.group, 'An approval group'));
    const minimum = approval.minimum == null ? 1 : Number(approval.minimum);
    if (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > 20) {
      throw new SingularityFlowError('Approvals needed must be a whole number from 1 to 20.', { code: 'STUDIO_APPROVAL_INVALID' });
    }
    const base = existing && typeof existing === 'object' ? { ...existing } : {};
    return { ...base, authorities: [group], minimum };
  }

  setOutput(id, output) {
    if (!STEP_OUTPUTS.some((entry) => entry.id === output)) {
      throw new SingularityFlowError(`A step produces one of: ${STEP_OUTPUTS.map((entry) => entry.id).join(', ')}.`, { code: 'STUDIO_OUTPUT_INVALID' });
    }
    // Only the task and requirement change; any other generation setting the step has stays.
    const current = this.phase(id)?.generation;
    const generation = current && typeof current === 'object' ? { ...current } : {};
    delete generation.task;
    if (generation.requirement === 'none') delete generation.requirement;
    if (output === 'none') generation.requirement = 'none';
    if (output === 'code') generation.task = 'code';
    if (output === 'analysis') generation.task = 'analyze';
    if (Object.keys(generation).length) this.document.setIn(['phases', id, 'generation'], this.document.createNode(generation));
    else this.document.deleteIn(['phases', id, 'generation']);
    this.document.setIn(['phases', id, 'writeScope'], output === 'code' ? 'source-and-artifact' : 'artifact-only');
  }

  writeTemplateIfMissing(relativeTemplate, id, label) {
    const relative = posix(path.join(this.sources.templatesRoot, relativeTemplate));
    if (existsSync(path.join(this.sources.configRoot, relative)) || this.templates.has(relative)) return;
    this.templates.set(relative, starterTemplate(id, label));
  }

  apply(change) {
    switch (change.op) {
      case 'group.create': return this.createGroup(change);
      case 'group.update': return this.updateGroup(change);
      case 'agent.create': return this.createAgent(change);
      case 'agent.update': return this.updateAgent(change);
      case 'workflow.install': return this.installBlueprint(change);
      case 'phase.create': return this.createPhase(change);
      case 'phase.update': return this.updatePhase(change);
      case 'phase.agent': return this.assignAgent(change);
      case 'workflow.create': return this.createWorkflow(change);
      case 'workflow.update': return this.updateWorkflow(change);
      default: throw new SingularityFlowError(`Unknown Studio change '${change?.op}'.`, { code: 'STUDIO_CHANGE_UNKNOWN' });
    }
  }

  members(list) {
    if (!Array.isArray(list)) throw new SingularityFlowError('Group members must be a list.', { code: 'STUDIO_GROUP_INVALID' });
    return list.map((member) => {
      const email = String(member?.email ?? '').trim().toLowerCase();
      const githubLogin = String(member?.githubLogin ?? '').trim().toLowerCase();
      if (!email.includes('@') && !githubLogin) {
        throw new SingularityFlowError(`Each person needs an email address or a GitHub login${member?.name ? ` (${member.name})` : ''}.`, { code: 'STUDIO_GROUP_INVALID' });
      }
      return { name: String(member?.name ?? '').trim() || null, email: email || null, githubLogin: githubLogin || null };
    });
  }

  createGroup({ id, label, members = [] }) {
    const groupId = requireId(id, 'An approval group ID');
    if (this.content.approvalAuthorities?.[groupId]) throw new SingularityFlowError(`An approval group '${groupId}' already exists.`, { code: 'STUDIO_GROUP_EXISTS' });
    const name = requireLabel(label, 'The approval group');
    this.document.setIn(['approvalAuthorities', groupId], this.document.createNode({ label: name, allowAnyGitIdentity: false, members: this.members(members) }));
    this.summary.push(`New approval group ${name} with ${members.length} ${members.length === 1 ? 'person' : 'people'}.`);
  }

  updateGroup({ id, label, members }) {
    const groupId = this.requireGroup(requireId(id, 'An approval group ID'));
    const name = label != null ? requireLabel(label, 'The approval group') : this.content.approvalAuthorities[groupId].label ?? groupId;
    if (label != null) this.document.setIn(['approvalAuthorities', groupId, 'label'], name);
    if (members != null) {
      const before = this.content.approvalAuthorities[groupId].members ?? [];
      this.document.setIn(['approvalAuthorities', groupId, 'members'], this.document.createNode(this.members(members)));
      this.summary.push(`${name} now has ${members.length} ${members.length === 1 ? 'person' : 'people'} (was ${before.length}).`);
    } else this.summary.push(`Approval group renamed to ${name}.`);
  }

  createAgent({ id, label, description, role = 'blank', tools, views, instructions }) {
    const agentId = requireId(id, 'An agent ID');
    if (this.agents.has(agentId)) throw new SingularityFlowError(`An agent called '${agentId}' already exists.`, { code: 'STUDIO_AGENT_EXISTS' });
    const preset = AGENT_ROLES.find((entry) => entry.id === role) ?? AGENT_ROLES.at(-1);
    const name = requireLabel(label, 'The agent');
    const what = String(description ?? '').replace(/\s+/g, ' ').trim();
    if (!what) throw new SingularityFlowError(`Say what ${name} does in one sentence.`, { code: 'STUDIO_AGENT_INVALID' });
    const toolList = [...new Set((tools ?? preset.tools).map((tool) => String(tool).trim()).filter(Boolean))];
    this.agents.set(agentId, {
      id: agentId, scope: 'repository', text: null, relative: posix(path.join('.github', 'agents', `${agentId}.agent.md`)),
      fileName: `${agentId}.agent.md`, label: name, description: what, tools: toolList,
      views: [...new Set((views ?? preset.views).map(String))], phases: [], defaultFor: [],
      body: newAgentBody(name, instructions ?? preset.instructions), touched: true, created: true
    });
    this.summary.push(`New agent ${name}: ${toolList.map((tool) => TOOL_LABELS[tool] ?? tool).join(', ').toLowerCase() || 'no tools'}.`);
  }

  updateAgent({ id, label, description, tools, views, instructions }) {
    const agent = this.touch(this.requireAgent(requireId(id, 'An agent ID')));
    if (label != null) agent.label = requireLabel(label, 'The agent');
    if (description != null) agent.description = String(description).replace(/\s+/g, ' ').trim() || agent.description;
    if (tools != null) agent.tools = [...new Set(tools.map(String).filter(Boolean))];
    if (views != null) agent.views = [...new Set(views.map(String).filter(Boolean))];
    if (instructions != null) {
      const body = String(instructions).trim();
      if (!body) throw new SingularityFlowError(`${agent.label} needs instructions.`, { code: 'STUDIO_AGENT_INVALID' });
      agent.body = body;
    }
    this.summary.push(`Agent ${agent.label} updated.`);
  }

  installBlueprint({ id }) {
    const workflowId = requireId(id, 'A blueprint');
    const starter = this.sources.starter;
    const profile = starter.workTypes[workflowId];
    if (!profile) throw new SingularityFlowError(`'${workflowId}' is not a packaged blueprint.`, { code: 'STUDIO_BLUEPRINT_UNKNOWN' });
    if (this.content.workTypes?.[workflowId]) return;
    const raw = starter.raw;
    this.document.setIn(['workTypes', workflowId], this.document.createNode(structuredClone(raw.workTypes[workflowId])));
    const installedPhases = new Set(profile.phases);
    for (const phaseId of profile.phases) {
      if (this.phase(phaseId)) continue;
      const packaged = structuredClone(raw.phases[phaseId]);
      this.document.setIn(['phases', phaseId], this.document.createNode(packaged));
      for (const authority of approvalSummary(packaged.approval).authorities) {
        if (!this.content.approvalAuthorities?.[authority] && raw.approvalAuthorities?.[authority]) {
          this.document.setIn(['approvalAuthorities', authority], this.document.createNode(structuredClone(raw.approvalAuthorities[authority])));
        }
      }
      const template = profile.templateOverrides?.[phaseId] ?? packaged.defaultTemplate;
      if (template && !template.startsWith('agent:') && !template.startsWith('template:')) {
        const relative = posix(path.join(this.sources.templatesRoot, template));
        const source = path.join(PACKAGE_ROOT, 'templates', 'artifacts', template);
        if (!existsSync(path.join(this.sources.configRoot, relative)) && existsSync(source)) this.templates.set(relative, { copyFrom: source });
      }
      // The packaged default agent for this phase, kept as the default even when the repository
      // carries a trimmed copy of that agent which no longer lists the phase.
      const packagedDefault = this.sources.bundledAgents.find((agent) => agent.defaultFor.includes(phaseId));
      if (packagedDefault && !this.agents.get(packagedDefault.id)?.defaultFor.includes(phaseId)) {
        if (!this.agents.has(packagedDefault.id)) {
          this.agents.set(packagedDefault.id, {
            id: packagedDefault.id, scope: 'bundled', text: packagedDefault.text, relative: null,
            fileName: path.basename(packagedDefault.file), label: packagedDefault.label, description: packagedDefault.description,
            tools: [...packagedDefault.tools], views: [...packagedDefault.worldModelViews], phases: [...packagedDefault.phases],
            defaultFor: [...packagedDefault.defaultFor], body: null, touched: false, created: false
          });
        }
        this.setDefaultAgent(phaseId, packagedDefault.id);
      }
    }
    // Tool servers assigned to the installed steps come too, merged into any the repository already
    // configures, exactly as `workflow install` merges them.
    for (const [serverId, packaged] of Object.entries(raw.mcpServers ?? {})) {
      if (!(packaged.phases ?? []).some((phase) => installedPhases.has(phase))) continue;
      const current = this.content.mcpServers?.[serverId];
      const merged = !current ? structuredClone(packaged) : {
        ...current,
        agents: [...new Set([...(current.agents ?? []), ...(packaged.agents ?? [])])],
        phases: [...new Set([...(current.phases ?? []), ...(packaged.phases ?? []).filter((phase) => installedPhases.has(phase))])],
        tools: [...new Set([...(current.tools ?? []), ...(packaged.tools ?? [])])]
      };
      this.document.setIn(['mcpServers', serverId], this.document.createNode(merged));
    }
    this.workflows.set(workflowId, { newlyCreated: true });
    this.summary.push(`Installed blueprint ${profile.label ?? workflowId}: ${profile.phases.map((phase) => this.phaseLabel(phase)).join(' → ')}.`);
  }

  createPhase({ id, label, output = 'document', inputs = [], approval, views = [], agent, copyOf }) {
    const phaseId = requireId(id, 'A step ID');
    if (this.phase(phaseId)) throw new SingularityFlowError(`A step called '${phaseId}' already exists.`, { code: 'STUDIO_PHASE_EXISTS' });
    const name = requireLabel(label, 'The step');
    let node;
    if (copyOf) {
      const source = this.requirePhase(requireId(copyOf, 'The step to copy'));
      node = structuredClone(this.phase(source));
      node.label = name;
      node.artifact = { ...(node.artifact ?? {}), path: `artifacts/${phaseId}/${phaseId}.md` };
      delete node.agents;
    } else {
      const firstGroup = Object.keys(this.content.approvalAuthorities ?? {})[0];
      node = {
        label: name,
        artifact: { path: `artifacts/${phaseId}/${phaseId}.md`, kind: phaseId, minimumBytes: 200 },
        defaultTemplate: `common/${phaseId}.md`,
        writeScope: 'artifact-only',
        approval: approval === 'none' ? 'none' : this.approvalNode(approval ?? { group: firstGroup })
      };
    }
    this.document.setIn(['phases', phaseId], this.document.createNode(node));
    if (!copyOf) {
      this.setOutput(phaseId, output);
      this.writeTemplateIfMissing(`common/${phaseId}.md`, phaseId, name);
    }
    if (inputs?.length) this.document.setIn(['phases', phaseId, 'inputs'], this.document.createNode(inputs.map((input) => this.requirePhase(requireId(input, 'An input step')))));
    if (views?.length) this.document.setIn(['phases', phaseId, 'worldModel'], this.document.createNode({ views: [...views], depth: 'quick' }));
    if (copyOf && approval != null) this.document.setIn(['phases', phaseId, 'approval'], this.document.createNode(this.approvalNode(approval, node.approval)));
    const agentId = agent ?? (copyOf ? [...this.agents.values()].find((entry) => entry.defaultFor.includes(copyOf))?.id : null);
    if (!agentId) throw new SingularityFlowError(`Choose the agent that drafts ${name}.`, { code: 'STUDIO_PHASE_AGENT_REQUIRED' });
    this.setDefaultAgent(phaseId, requireId(agentId, 'An agent ID'));
    this.summary.push(copyOf
      ? `New step ${name}, a copy of ${this.phaseLabel(copyOf)}, drafted by ${this.agentLabel(agentId)}.`
      : `New step ${name}: drafted by ${this.agentLabel(agentId)}, ${node.approval === 'none' ? 'no sign-off' : `signed off by ${this.content.approvalAuthorities?.[approvalSummary(node.approval).authorities[0]]?.label ?? 'its group'}`}.`);
  }

  updatePhase({ id, workflow, label, output, inputs, approval, views, clarification }) {
    const phaseId = this.requirePhase(requireId(id, 'A step ID'));
    const name = this.phaseLabel(phaseId);
    const shared = this.usedBy(phaseId).length > 1;
    // Approval and inputs are per-workflow when the step is shared and a workflow is named; every
    // other setting is the step's own and applies wherever the step is used.
    // A workflow that already overrides a field keeps owning it: writing the step's own value would
    // be shadowed by that override and change nothing.
    const override = workflow ? ['workTypes', requireId(workflow, 'A workflow ID'), 'phaseOverrides', phaseId] : null;
    const scopeFor = (field) => (override && (shared || this.document.getIn([...override, field]) !== undefined) ? override : ['phases', phaseId]);
    const valueAt = (scope, field) => {
      const node = this.document.getIn([...scope, field]);
      return node?.toJSON?.() ?? node;
    };
    const changed = [];
    if (label != null) { this.document.setIn(['phases', phaseId, 'label'], requireLabel(label, 'The step')); changed.push('name'); }
    if (output != null) { this.setOutput(phaseId, output); changed.push('output'); }
    if (inputs != null) {
      const scope = scopeFor('inputs');
      const ids = inputs.map((input) => this.requirePhase(requireId(input, 'An input step')));
      // An input entry that stays keeps its own settings (selector, projection, preserved headings).
      const current = valueAt(scope, 'inputs') ?? this.phase(phaseId).inputs ?? [];
      const entries = ids.map((id) => (Array.isArray(current) ? current : []).find((entry) => (typeof entry === 'string' ? entry : entry?.phase) === id) ?? id);
      if (entries.length) this.document.setIn([...scope, 'inputs'], this.document.createNode(entries));
      else this.document.deleteIn([...scope, 'inputs']);
      changed.push('inputs');
    }
    if (approval != null) {
      const scope = scopeFor('approval');
      const existing = valueAt(scope, 'approval') ?? this.phase(phaseId).approval;
      this.document.setIn([...scope, 'approval'], this.document.createNode(this.approvalNode(approval, existing === 'none' ? null : existing)));
      changed.push('sign-off');
    }
    if (views != null) {
      if (views.length) this.document.setIn(['phases', phaseId, 'worldModel', 'views'], this.document.createNode([...views]));
      else this.document.deleteIn(['phases', phaseId, 'worldModel', 'views']);
      changed.push('knowledge');
    }
    if (clarification != null) {
      if (!CLARIFICATION_MODES.some((mode) => mode.id === clarification)) throw new SingularityFlowError('Clarifying questions are off, when-needed or required.', { code: 'STUDIO_CLARIFICATION_INVALID' });
      if (clarification === 'off') this.document.deleteIn(['phases', phaseId, 'clarification']);
      else this.document.setIn(['phases', phaseId, 'clarification'], this.document.createNode({ mode: clarification }));
      changed.push('questions');
    }
    if (changed.length) this.summary.push(`${label ?? name}: ${changed.join(', ')} changed${shared && workflow && (inputs != null || approval != null) ? ` for ${this.content.workTypes?.[workflow]?.label ?? workflow} only` : ''}.`);
  }

  assignAgent({ phase, agent }) {
    const phaseId = this.requirePhase(requireId(phase, 'A step ID'));
    const agentId = requireId(agent, 'An agent ID');
    const previous = this.setDefaultAgent(phaseId, agentId);
    const users = this.usedBy(phaseId);
    this.summary.push(`${this.phaseLabel(phaseId)} is now drafted by ${this.agentLabel(agentId)}${previous ? ` (was ${this.agentLabel(previous)})` : ''}${users.length > 1 ? `, in all ${users.length} workflows that use it` : ''}.`);
  }

  createWorkflow({ id, label, description, phases }) {
    const workflowId = requireId(id, 'A workflow ID');
    if (this.content.workTypes?.[workflowId]) throw new SingularityFlowError(`A workflow called '${workflowId}' already exists.`, { code: 'STUDIO_WORKFLOW_EXISTS' });
    const name = requireLabel(label, 'The workflow');
    const ids = (phases ?? []).map((phase) => this.requirePhase(requireId(phase, 'A step ID')));
    if (!ids.length) throw new SingularityFlowError(`${name} needs at least one step.`, { code: 'STUDIO_WORKFLOW_EMPTY' });
    if (new Set(ids).size !== ids.length) throw new SingularityFlowError(`${name} lists a step more than once.`, { code: 'STUDIO_WORKFLOW_DUPLICATE' });
    this.document.setIn(['workTypes', workflowId], this.document.createNode({
      label: name, ...(description ? { description: String(description).trim() } : {}), phases: ids
    }));
    this.workflows.set(workflowId, { newlyCreated: true });
    this.summary.push(`New workflow ${name}: ${ids.map((phase) => this.phaseLabel(phase)).join(' → ')}.`);
  }

  updateWorkflow({ id, label, description, phases, reworkLoops, decisions }) {
    const workflowId = requireId(id, 'A workflow ID');
    const current = this.content.workTypes?.[workflowId];
    if (!current) throw new SingularityFlowError(`There is no workflow '${workflowId}'.`, { code: 'STUDIO_WORKFLOW_UNKNOWN' });
    const name = label != null ? requireLabel(label, 'The workflow') : current.label ?? workflowId;
    const changed = [];
    if (label != null) { this.document.setIn(['workTypes', workflowId, 'label'], name); changed.push('name'); }
    if (description != null) {
      if (String(description).trim()) this.document.setIn(['workTypes', workflowId, 'description'], String(description).trim());
      else this.document.deleteIn(['workTypes', workflowId, 'description']);
      changed.push('description');
    }
    if (phases != null) {
      const ids = phases.map((phase) => this.requirePhase(requireId(phase, 'A step ID')));
      if (!ids.length) throw new SingularityFlowError(`${name} needs at least one step.`, { code: 'STUDIO_WORKFLOW_EMPTY' });
      if (new Set(ids).size !== ids.length) throw new SingularityFlowError(`${name} lists a step more than once.`, { code: 'STUDIO_WORKFLOW_DUPLICATE' });
      this.document.setIn(['workTypes', workflowId, 'phases'], this.document.createNode(ids));
      // A per-workflow override for a step that left the workflow would refuse to load.
      for (const overridden of Object.keys(current.phaseOverrides ?? {})) {
        if (!ids.includes(overridden)) this.document.deleteIn(['workTypes', workflowId, 'phaseOverrides', overridden]);
      }
      for (const overridden of Object.keys(current.templateOverrides ?? {})) {
        if (!ids.includes(overridden)) this.document.deleteIn(['workTypes', workflowId, 'templateOverrides', overridden]);
      }
      changed.push(`steps (${ids.map((phase) => this.phaseLabel(phase)).join(' → ')})`);
    }
    if (reworkLoops != null) {
      const loops = reworkLoops.map((loop) => ({
        from: this.requirePhase(requireId(loop.from, 'A loop step')),
        to: this.requirePhase(requireId(loop.to, 'A loop step')),
        maxAttempts: Number(loop.maxAttempts ?? 3),
        ...(loop.resetOnPhase ? { resetOnPhase: this.requirePhase(requireId(loop.resetOnPhase, 'A loop reset step')) } : {})
      }));
      if (loops.length) this.document.setIn(['workTypes', workflowId, 'reworkLoops'], this.document.createNode(loops));
      else this.document.deleteIn(['workTypes', workflowId, 'reworkLoops']);
      changed.push('send-back rules');
    }
    if (decisions != null) {
      // Written as authored; the whole candidate is validated afterwards, so a rule naming a missing
      // step or skipping one a later step reads is refused with the engine's own message.
      if (!Array.isArray(decisions) || decisions.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
        throw new SingularityFlowError(`${name} decisions must be a list of decisions.`, { code: 'STUDIO_DECISIONS_INVALID' });
      }
      if (decisions.length) this.document.setIn(['workTypes', workflowId, 'decisions'], this.document.createNode(structuredClone(decisions)));
      else this.document.deleteIn(['workTypes', workflowId, 'decisions']);
      changed.push('decisions');
    }
    this.workflows.set(workflowId, { newlyCreated: this.workflows.get(workflowId)?.newlyCreated ?? false });
    if (changed.length) this.summary.push(`${name}: ${changed.join(', ')} changed.`);
  }

  /** Pin planned claims, trim agents to existing steps, and check every step has one agent. */
  finalize(problems) {
    for (const [workflowId, { newlyCreated }] of this.workflows) {
      try { pinAuthoredStoryPlannedClaims(this.document, STORES.story, workflowId, { newlyCreated }); }
      catch (error) { problems.push({ code: error?.code ?? 'STUDIO_PLANNED_CLAIMS', message: error.message, subject: { kind: 'workflow', id: workflowId } }); }
    }
    const phaseIds = new Set(Object.keys(this.content.phases ?? {}));
    for (const agent of this.agents.values()) {
      if (!agent.touched) continue;
      // An edited agent is strict: every step it names must exist in this repository.
      if (agent.phases.length) agent.phases = agent.phases.filter((phase) => phaseIds.has(phase));
      agent.defaultFor = agent.defaultFor.filter((phase) => phaseIds.has(phase));
      if (agent.phases.length) for (const phase of agent.defaultFor) if (!agent.phases.includes(phase)) agent.phases.push(phase);
    }
    for (const phaseId of phaseIds) {
      const defaults = [...this.agents.values()].filter((agent) => agent.defaultFor.includes(phaseId));
      if (defaults.length === 1) continue;
      problems.push(defaults.length
        ? { code: 'STUDIO_PHASE_AGENT_CONFLICT', message: `${this.phaseLabel(phaseId)} has ${defaults.length} default agents (${defaults.map((agent) => agent.label).join(', ')}); choose one.`, subject: { kind: 'phase', id: phaseId } }
        : { code: 'STUDIO_PHASE_AGENT_REQUIRED', message: `Choose the agent that drafts ${this.phaseLabel(phaseId)}.`, subject: { kind: 'phase', id: phaseId } });
    }
  }

  async files() {
    const files = [];
    const workflow = preserveYamlFormatting(this.sources.definitionText, this.document.toString(YAML_OUTPUT));
    if (workflow !== this.sources.definitionText) files.push({ path: WORKFLOW_PATH, before: this.sources.definitionText, after: workflow });
    for (const agent of this.agents.values()) {
      if (!agent.touched) continue;
      const before = agent.scope === 'repository' && agent.text && !agent.created ? agent.text : null;
      files.push({ path: agent.relative, before, after: renderAgent(agent) });
    }
    for (const [relative, content] of this.templates) {
      files.push({ path: relative, before: null, after: typeof content === 'string' ? content : await readFile(content.copyFrom, 'utf8') });
    }
    return files.filter((file) => file.before !== file.after);
  }

  warnings() {
    const content = this.content;
    const security = normalizeApprovalSecurity(content.approvalSecurity ?? {});
    const touchedWorkflows = new Set(this.workflows.keys());
    const warnings = [];
    for (const [groupId, group] of Object.entries(content.approvalAuthorities ?? {})) {
      if (groupStatus(group ?? {}, security) !== 'blocked') continue;
      const steps = Object.entries(content.phases ?? {})
        .filter(([phaseId, phase]) => approvalSummary(phase.approval).authorities.includes(groupId)
          && (!touchedWorkflows.size || [...touchedWorkflows].some((id) => (content.workTypes?.[id]?.phases ?? []).includes(phaseId))))
        .map(([, phase]) => phase.label);
      if (steps.length) warnings.push({ code: 'STUDIO_GROUP_EMPTY', message: `Nobody can sign off ${steps.join(', ')} yet: add people to ${group?.label ?? groupId}.`, subject: { kind: 'group', id: groupId } });
    }
    return warnings;
  }
}

function orderChanges(changes) {
  if (!Array.isArray(changes)) throw new SingularityFlowError('A Studio change set lists its changes in a "changes" array.', { code: 'STUDIO_CHANGE_SET_INVALID' });
  if (changes.length > MAX_CHANGES) throw new SingularityFlowError(`A Studio change set may hold at most ${MAX_CHANGES} changes.`, { code: 'STUDIO_CHANGE_SET_INVALID' });
  return changes.map((change, index) => ({ change, index }))
    .sort((left, right) => (RANK[left.change?.op] ?? 99) - (RANK[right.change?.op] ?? 99) || left.index - right.index)
    .map(({ change }) => change);
}

async function bundledAgents() {
  const directory = path.join(PACKAGE_ROOT, 'templates', 'agents');
  const agents = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/(?:\.agent)?\.md$/i.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const text = await readFile(file, 'utf8');
    agents.push({ ...parseAgentDependencies(text, { source: file }), file, text });
  }
  return agents;
}

async function loadSources(root) {
  const configRoot = configurationReadRoot(root);
  const definitionText = await readFile(path.join(configRoot, WORKFLOW_PATH), 'utf8');
  const raw = YAML.parse(definitionText) ?? {};
  let definition = null;
  try { definition = await loadDefinition(root); } catch { definition = null; }
  const agents = (await discoverAgents(root)).filter((agent) => agent.scope !== 'plugin');
  return {
    root, configRoot, definitionText, raw, definition, agents, bundledAgents: await bundledAgents(),
    templatesRoot: posix(raw.templatesRoot ?? definition?.templatesRoot ?? 'singularity/templates'),
    starter: await packagedDefinition(),
    portfolio: await loadPortfolio(root, { required: false }).catch(() => null)
  };
}

/**
 * Apply a change set to a candidate copy and validate it whole. With `write`, the changed files are
 * written to `root` — call that only where the configuration really lives: a proposal clone, or a
 * local authority's working tree. Without it nothing is written.
 */
export async function planStudioChangeSet(root, changeSet, { write = false } = {}) {
  if (!changeSet || typeof changeSet !== 'object' || changeSet.schema !== STUDIO_CHANGE_SET_SCHEMA) {
    throw new SingularityFlowError(`A Studio change set must declare schema '${STUDIO_CHANGE_SET_SCHEMA}'.`, { code: 'STUDIO_CHANGE_SET_INVALID' });
  }
  const sources = await loadSources(root);
  const expected = changeSet.base?.workflowSha256;
  if (expected && expected !== sha256(sources.definitionText)) {
    throw new SingularityFlowError('The workflow configuration changed since Workflow Studio loaded it. Reload the Studio, review the newer configuration, and apply your changes again.', {
      code: 'STUDIO_BASE_CHANGED', details: { expected, actual: sha256(sources.definitionText) }
    });
  }
  const candidate = new StudioCandidate(sources);
  const problems = [];
  for (const change of orderChanges(changeSet.changes)) {
    try { candidate.apply(change); }
    catch (error) {
      const subjectId = change?.id ?? change?.phase ?? null;
      problems.push({ code: error?.code ?? 'STUDIO_CHANGE_INVALID', message: error.message, change: change?.op ?? null, ...(subjectId ? { subject: { kind: String(change?.op ?? '').split('.')[0], id: subjectId } } : {}) });
    }
  }
  if (!problems.length) candidate.finalize(problems);
  const files = problems.length ? [] : await candidate.files();
  if (!problems.length && files.length) {
    try {
      await validateStudioCandidate(sources, files);
    } catch (error) {
      problems.push({ code: error?.code ?? 'CONFIGURATION_INVALID', message: String(error.message).replace(/^Change was not saved because configuration validation failed: /, '') });
    }
  }
  const plan = {
    schemaVersion: 1,
    resultType: 'workflow-studio-plan',
    valid: problems.length === 0,
    changed: files.length > 0,
    problems,
    warnings: problems.length ? [] : candidate.warnings(),
    summary: candidate.summary,
    files: files.map((file) => ({ path: file.path, action: file.before == null ? 'create' : 'update', diff: unifiedDiff(file.before, file.after, file.path) }))
  };
  if (!write) return plan;
  if (!plan.valid) {
    throw new SingularityFlowError(`Workflow Studio changes were not applied: ${problems[0].message}`, { code: 'STUDIO_CHANGES_INVALID', details: { problems } });
  }
  for (const file of files) {
    const target = path.join(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.after, 'utf8');
  }
  return { ...plan, path: WORKFLOW_PATH, written: files.map((file) => file.path) };
}

async function validateStudioCandidate(sources, files) {
  const { validateConfigurationCandidates } = await import('./editor.mjs');
  const definition = sources.definition ?? { templatesRoot: sources.templatesRoot };
  await validateConfigurationCandidates(sources.configRoot, files.map((file) => ({ path: file.path, content: file.after })), definition, sources.portfolio);
}

export function readStudioChangeSet(text) {
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new SingularityFlowError(`The Studio change set is not valid JSON: ${error.message}`, { code: 'STUDIO_CHANGE_SET_INVALID' }); }
  return value;
}

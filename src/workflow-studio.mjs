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
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { loadDefinition, mergePhaseOverride, resolveWorkType, validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { AGENT_LOCK_PATH, discoverAgents, parseAgentDependencies } from './agents.mjs';
import { AGENT_CLARIFICATION_GUIDANCE, REPOSITORY_AGENT_BOUNDARY } from './agent-guidance.mjs';
import {
  IMPORTS_LOCK_PATH, importLedgerKey, importedTemplateRelative, inspectImportContent, ledgerEntry,
  loadImportsLedger, removeAgentTableRow, renderImportsLedger, requireSha256, resolveChangeSetImports,
  textOf, upsertAgentTableRow, validateGeneratedSource, vendoredAgentResourcePath
} from './asset-import.mjs';
import { normalizeMarketplaces } from './marketplace.mjs';
import { mcpDescriptorPath, parseMcpServerDescriptor } from './mcp-descriptor.mjs';
import { DEFAULT_REMOTE_MAX_BYTES, HARD_REMOTE_MAX_BYTES } from './remote-fetch.mjs';
import { importsStatus } from './asset-import.mjs';
import { importableMcpServers } from './mcp-import.mjs';
import { templateReferences } from './template-catalog.mjs';
import { normalizeApprovalSecurity } from './approval-authority.mjs';
import {
  authoringRoute, compiledSkillStep, deterministicOnlyGeneration, stepOutputKind, workflowCodeGeneration
} from './code-delivery-policy.mjs';
import { AUTHORING_SKILL_ID, authoringSkillCatalog, authoringSkillEntry } from './authoring-skills.mjs';
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
const agentsSha256 = (agents) => sha256(agents.filter((agent) => agent.scope === 'repository')
  .map((agent) => `${agent.id}:${agent.sha256}`).join('\n'));

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

/**
 * What a step produces, by the engine's own classification. Studio once inferred code from a
 * source-and-artifact write scope, which showed verification and testing steps as code; one rule
 * now serves the model, the picker, validation and routing.
 */
function outputOf(phase = {}) {
  return stepOutputKind(phase);
}

/** The skills a step may choose to draft it, with each skill's own one-line description. */
async function authoringSkillChoices() {
  return Promise.all(authoringSkillCatalog().map(async (entry) => {
    let description = null;
    try {
      const text = await readFile(path.join(PACKAGE_ROOT, 'plugin', 'skills', entry.sourceId, 'SKILL.md'), 'utf8');
      description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
    } catch { description = null; }
    return { id: entry.id, label: `/${entry.id}`, produces: [...entry.produces], legacyPhases: [...entry.legacyPhases], description };
  }));
}

/**
 * A list a change carries, such as a step's inputs or knowledge views. Absent or null leaves the list
 * as it is, as for every other field of a change; anything else must be a list.
 */
function changeList(value, label, code) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new SingularityFlowError(`${label} must be a list.`, { code });
  return value;
}

/** A drafting skill as a change set names it; the candidate configuration checks the rest. */
function requireAuthoringSkill(value) {
  if (typeof value !== 'string' || !AUTHORING_SKILL_ID.test(value)) {
    throw new SingularityFlowError(`A drafting skill is a direct skill id such as 'sf-design', not '${value}'.`, { code: 'STUDIO_AUTHORING_SKILL_INVALID' });
  }
  return value;
}

function approvalSummary(approval) {
  if (approval === 'none' || approval?.mode === 'none') return { mode: 'none', authorities: [], minimum: 0 };
  return {
    mode: approval?.mode ?? 'required',
    authorities: Array.isArray(approval?.authorities) ? [...approval.authorities] : [],
    minimum: Number.isSafeInteger(approval?.minimum) ? approval.minimum : 1
  };
}

const inputPhase = (input) => (typeof input === 'string' ? input : input?.phase);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function inputIds(inputs) {
  return (Array.isArray(inputs) ? inputs : []).map(inputPhase).filter(Boolean);
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
    instructions: agent.prompt ?? '',
    // Skills, templates and generated sources the agent's tables name, for the Library and its card.
    resources: (agent.dependencies ?? []).map((dependency) => ({
      id: dependency.id, type: dependency.type, url: dependency.url, optional: dependency.optional === true,
      ...(dependency.type === 'generated' ? { phase: dependency.phase, target: dependency.target } : { phases: [...(dependency.phases ?? [])] })
    }))
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
      steps: (resolved?.phases ?? (type.phases ?? []).map((phaseId) => ({ id: phaseId, ...phases[phaseId] }))).map((phase) => {
        const route = authoringRoute(phase);
        return {
          id: phase.id, label: phase.label ?? phase.id, output: outputOf(phase),
          agent: phase.defaultAgent ?? defaultAgentOf(phase.id),
          approval: approvalSummary(phase.approval), inputs: inputIds(phase.inputs),
          views: [...(phase.worldModel?.views ?? [])], clarification: phase.clarification?.mode ?? 'off',
          overridden: Boolean(type.phaseOverrides?.[phase.id]),
          authoringSkill: route.authoringSkill,
          authoringSkillSetByWorkflow: Boolean(type.phaseOverrides?.[phase.id] && Object.hasOwn(type.phaseOverrides[phase.id], 'authoringSkill')),
          effectiveAuthoringSkill: route.effectiveAuthoringSkill,
          authoringSkillSource: route.authoringSkillSource,
          // Steps the engine generates, and compiled skill steps, cannot choose a drafting skill.
          generatedByEngine: phase.id === 'convergence' || deterministicOnlyGeneration(phase),
          compiledSkill: compiledSkillStep(phase)
        };
      })
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
      agentsSha256: agentsSha256(discovered)
    },
    problems,
    workflows,
    phases: Object.entries(phases).map(([id, phase]) => ({
      id, label: phase.label ?? id, output: outputOf(phase),
      approval: approvalSummary(phase.approval), inputs: inputIds(phase.inputs),
      authoringSkill: typeof phase.authoringSkill === 'string' ? phase.authoringSkill : null,
      generatedByEngine: id === 'convergence' || deterministicOnlyGeneration(phase),
      compiledSkill: compiledSkillStep(phase),
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
    marketplaces: Object.values(safeMarketplaces(raw.marketplaces, problems)).map((marketplace) => ({ ...marketplace, allowedOrigins: [...marketplace.allowedOrigins] })),
    imports: await importsStatus(root).catch((error) => { problems.push({ code: error?.code ?? 'IMPORTS_LOCK_INVALID', message: error.message }); return []; }),
    mcpSources: await importableMcpServers(root).catch(() => []),
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
      authoringSkills: await authoringSkillChoices(),
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
  return [`# ${label} agent`, '', REPOSITORY_AGENT_BOUNDARY, '', String(instructions ?? '').trim() || 'Describe what this agent should do in each step it drafts.', '', AGENT_CLARIFICATION_GUIDANCE].join('\n');
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

/**
 * A unified diff of two texts: each changed region with three lines of context, in a hunk of its
 * own, so edits far apart in one file (a new step, the workflow using it) all show.
 */
export function unifiedDiff(before, after, file) {
  const a = before ? before.split('\n') : [];
  const b = after == null ? [] : after.split('\n');
  const operations = lineOperations(a, b);
  const hunks = [];
  operations.forEach(([kind], index) => {
    if (kind === ' ') return;
    const from = Math.max(0, index - 3); const to = Math.min(operations.length - 1, index + 3);
    const last = hunks.at(-1);
    if (last && from <= last[1] + 1) last[1] = to; else hunks.push([from, to]);
  });
  if (!hunks.length) return '';
  const lines = [`--- ${before == null ? '/dev/null' : `a/${file}`}`, `+++ ${after == null ? '/dev/null' : `b/${file}`}`,
    ...hunks.flatMap(([from, to]) => ['@@', ...operations.slice(from, to + 1).map(([kind, index]) => `${kind}${kind === '+' ? b[index] : a[index]}`)])];
  return lines.length > MAX_DIFF_LINES ? [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more lines`].join('\n') : lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// The candidate

// Imported agents exist before the steps that use them; imported templates before the steps that
// name them; a new workflow exists before the per-workflow settings of its steps (a duplicated
// workflow carries its source's step settings, and they must land on the copy, not on the shared
// step); skills and generated sources are added to an agent's final instructions, after any edit to
// them; removals see everything else first. Step settings come before workflows change their step
// lists, so who owns a per-workflow setting is decided by the lists the change set ends with
// (finalWorkflowPhases), not by the lists at that moment.
const RANK = Object.freeze({
  'marketplace.add': 0, 'marketplace.remove': 0, 'group.create': 0, 'group.update': 1, 'agent.create': 2, 'import.agent': 2.5, 'workflow.install': 3,
  'import.template': 3.5, 'phase.create': 4, 'workflow.create': 4.5, 'phase.update': 5, 'workflow.update': 7,
  'phase.agent': 8, 'agent.update': 9, 'import.skill': 10, 'import.generated': 10, 'import.mcpServer': 10.5, 'import.remove': 11
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
  constructor(sources, finalPhases = null) {
    this.sources = sources;
    // The steps each workflow lists once the whole change set is applied (finalWorkflowPhases).
    this.finalPhases = finalPhases;
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
    // Imports: exact staged bytes by SHA-256, files to vendor (null removes one), the provenance
    // ledger and the agent lock entries each changed agent needs.
    this.staged = sources.imports ?? new Map();
    this.vendored = new Map();
    this.ledger = structuredClone(sources.ledger);
    this.ledgerChanged = false;
    this.lock = structuredClone(sources.agentLock);
    this.lockChanged = false;
    this.trusted = new Map();
    this.untrusted = new Map();
    this.removedAgents = new Set();
    this.rendered = new Map();
    // Steps the change set creates, and the step each copy among them copies (copy ID -> step ID).
    this.pendingPhases = new Set();
    this.copies = new Map();
    // Which steps a fast-path verb owns; set by the planner, which loads it only to apply changes.
    this.fastPathProfile = null;
  }

  /**
   * Note the steps the change set creates before any change is applied: one copy may read another
   * made with it, in either order.
   */
  expect(changes) {
    for (const change of changes) {
      if (change?.op !== 'phase.create' || typeof change.id !== 'string') continue;
      this.pendingPhases.add(change.id);
      if (typeof change.copyOf === 'string') this.copies.set(change.id, change.copyOf);
    }
  }

  get content() { return this.document.toJS() ?? {}; }
  phase(id) { return this.content.phases?.[id] ?? null; }
  phaseLabel(id) { return this.phase(id)?.label ?? id; }
  agentLabel(id) { return this.agents.get(id)?.label ?? id; }
  usedBy(phaseId) {
    return Object.entries(this.content.workTypes ?? {}).filter(([, type]) => (type.phases ?? []).includes(phaseId)).map(([id]) => id);
  }
  /** The workflows that use a step once the whole change set is applied. */
  usedByAtEnd(phaseId) {
    if (!this.finalPhases) return this.usedBy(phaseId);
    return [...this.finalPhases].filter(([, phases]) => phases.includes(phaseId)).map(([id]) => id);
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
    const wasCode = outputOf(this.phase(id) ?? {}) === 'code';
    if (Object.keys(generation).length) this.document.setIn(['phases', id, 'generation'], this.document.createNode(generation));
    else this.document.deleteIn(['phases', id, 'generation']);
    // Write scope follows code delivery only when a step moves to or from code: a verification or
    // testing step that writes against source keeps its scope when its output is named.
    if (output === 'code') this.document.setIn(['phases', id, 'writeScope'], 'source-and-artifact');
    else if (wasCode) this.document.setIn(['phases', id, 'writeScope'], 'artifact-only');
    // A skill the step names that cannot draft what it now produces goes back to automatic here,
    // rather than staying behind for configuration to refuse, or for each workflow to hide with an
    // explicit automatic of its own. Returns the skill it dropped.
    const skill = this.phase(id)?.authoringSkill;
    const entry = typeof skill === 'string' ? authoringSkillEntry(skill) : null;
    if (!entry || entry.produces.includes(outputOf(this.phase(id)))) return null;
    this.document.deleteIn(['phases', id, 'authoringSkill']);
    return skill;
  }

  /** The summary line for a skill setOutput dropped, when the step still names none at the end. */
  droppedSkillLine(id, name, dropped) {
    if (!dropped || typeof this.phase(id)?.authoringSkill === 'string') return null;
    const output = outputOf(this.phase(id));
    return output === 'none'
      ? `${name} now drafts nothing, so it no longer names /${dropped}.`
      : `${name} now produces ${{ document: 'a document', analysis: 'an analysis', code: 'code' }[output]}, which /${dropped} cannot draft, so its drafting skill is automatic again.`;
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
      case 'marketplace.add': return this.addMarketplace(change);
      case 'marketplace.remove': return this.removeMarketplace(change);
      case 'import.skill': return this.importSkill(change);
      case 'import.template': return this.importTemplate(change);
      case 'import.agent': return this.importAgent(change);
      case 'import.generated': return this.importGenerated(change);
      case 'import.mcpServer': return this.importMcpServer(change);
      case 'import.remove': return this.removeImport(change);
      default: throw new SingularityFlowError(`Unknown Studio change '${change?.op}'.`, { code: 'STUDIO_CHANGE_UNKNOWN' });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Imports

  /** Previewed bytes for an import operation, checked again for the use it is added as. */
  stagedContent(sha256, kind, { id = null, label } = {}) {
    const staged = this.staged.get(requireSha256(sha256));
    if (!staged) throw new SingularityFlowError('This import is no longer staged on this machine. Preview it again, then add it.', { code: 'STUDIO_IMPORT_NOT_STAGED' });
    const text = textOf(staged.bytes);
    const inspection = inspectImportContent(kind, text, { id, label: label ?? `The ${kind} from ${sourceText(staged.source)}` });
    return { ...staged, text, inspection };
  }

  requirePhases(list, label = 'A step') {
    if (list == null) return [];
    if (!Array.isArray(list)) throw new SingularityFlowError(`${label} list must be a list of step IDs.`, { code: 'STUDIO_PHASE_UNKNOWN' });
    return [...new Set(list.map((phase) => this.requirePhase(requireId(phase, label))))];
  }

  agentBody(agent) {
    return agent.body != null ? agent.body : splitAgentText(agent.text ?? '---\n---\n', agent.id).body;
  }

  recordImport(kind, key, staged, target, extra = {}) {
    this.ledger.imports[importLedgerKey(kind, key)] = ledgerEntry(kind, staged, target, extra);
    this.ledgerChanged = true;
  }

  forgetImport(key) {
    if (!this.ledger.imports[key]) return;
    delete this.ledger.imports[key];
    this.ledgerChanged = true;
  }

  trust(agentId, dependency) {
    if (!this.trusted.has(agentId)) this.trusted.set(agentId, new Map());
    this.trusted.get(agentId).set(`${dependency.type}:${dependency.id}`, dependency);
  }

  distrust(agentId, type, id) {
    if (!this.untrusted.has(agentId)) this.untrusted.set(agentId, new Set());
    this.untrusted.get(agentId).add(`${type}:${id}`);
    this.trusted.get(agentId)?.delete(`${type}:${id}`);
  }

  importSkill({ agent: agentId, id, sha256, phases = [], optional = false, replace = false }) {
    const agent = this.touch(this.requireAgent(requireId(agentId, 'An agent ID')));
    const skillId = requireId(id, 'A skill ID');
    const staged = this.stagedContent(sha256, 'skill', { id: skillId });
    const url = sourceUrl(staged.source);
    const steps = this.requirePhases(phases);
    const maxBytes = Math.max(DEFAULT_REMOTE_MAX_BYTES, staged.size);
    agent.body = upsertAgentTableRow(this.agentBody(agent), 'skill',
      [skillId, url, steps.join(', ') || '*', optional ? 'yes' : 'no', String(maxBytes)], { replace });
    const vendored = vendoredAgentResourcePath(agent.id, 'skill', skillId);
    this.vendored.set(vendored, staged.bytes);
    this.trust(agent.id, {
      id: skillId, type: 'skill', url, optional: optional === true, maxBytes, phases: steps,
      sha256: staged.sha256, size: staged.size, resolvedUrl: staged.source.resolvedUrl ?? url, vendored
    });
    this.recordImport('skill', { agent: agent.id, id: skillId }, staged, { agent: agent.id, id: skillId, phases: steps, path: vendored });
    this.summary.push(`${agent.label} uses skill ${skillId} from ${sourceText(staged.source)}${steps.length ? ` in ${steps.map((step) => this.phaseLabel(step)).join(', ')}` : ' in every step it drafts'}.`);
  }

  importTemplate({ id, label, description, sha256, phases = [], replace = false }) {
    const templateId = requireId(id, 'A template ID');
    const staged = this.stagedContent(sha256, 'template', { id: templateId });
    const key = importLedgerKey('template', { id: templateId });
    if (this.content.templates?.[templateId]) {
      if (!replace) throw new SingularityFlowError(`A template called '${templateId}' already exists. Replace it deliberately, or choose another ID.`, { code: 'STUDIO_TEMPLATE_EXISTS' });
      if (!this.ledger.imports[key]) throw new SingularityFlowError(`Template '${templateId}' was written in this repository, not imported; import under another ID.`, { code: 'STUDIO_TEMPLATE_EXISTS' });
    }
    const name = label != null ? requireLabel(label, 'The template') : templateLabel(staged.inspection.details.headings[0], templateId);
    const relative = importedTemplateRelative(templateId);
    const file = posix(path.join(this.sources.templatesRoot, relative));
    this.vendored.set(file, staged.bytes);
    const entry = { path: relative, label: name };
    const what = String(description ?? '').replace(/\s+/g, ' ').trim();
    if (what) entry.description = what;
    this.document.setIn(['templates', templateId], this.document.createNode(entry));
    const steps = this.requirePhases(phases);
    for (const step of steps) this.document.setIn(['phases', step, 'defaultTemplate'], `template:${templateId}`);
    this.recordImport('template', { id: templateId }, staged, { id: templateId, path: file, phases: steps });
    this.summary.push(`Template ${name} from ${sourceText(staged.source)}${steps.length ? `, used by ${steps.map((step) => this.phaseLabel(step)).join(', ')}` : ''}.`);
  }

  importAgent({ sha256, id = null, withoutDefaults = false, replace = false }) {
    const staged = this.stagedContent(sha256, 'agent', { id: id == null ? null : requireId(id, 'An agent ID') });
    const agentId = staged.inspection.id;
    const key = importLedgerKey('agent', { id: agentId });
    const existing = this.agents.get(agentId);
    if (existing) {
      if (!replace) throw new SingularityFlowError(`An agent called '${agentId}' already exists. Replace it deliberately, or import another agent.`, { code: 'STUDIO_AGENT_EXISTS' });
      if (!this.ledger.imports[key]) throw new SingularityFlowError(`Agent '${agentId}' was written in this repository, not imported, so an import cannot replace it.`, { code: 'STUDIO_AGENT_EXISTS' });
    }
    let text = staged.text;
    if (withoutDefaults) {
      const { document, body } = splitAgentText(text, agentId);
      document.deleteIn(['metadata', 'sflow-default-for']);
      text = `---\n${document.toString(YAML_OUTPUT)}---\n${body}`;
    }
    const relative = existing?.relative ?? posix(path.join('.github', 'agents', `${agentId}.agent.md`));
    const parsed = parseAgentDependencies(text, { source: relative });
    this.agents.set(agentId, {
      id: agentId, scope: 'repository', text, relative, fileName: path.basename(relative),
      label: parsed.label, description: parsed.description, tools: [...parsed.tools], views: [...parsed.worldModelViews],
      phases: [...parsed.phases], defaultFor: [...parsed.defaultFor], body: null, touched: false,
      created: !existing, imported: true, previousText: existing?.text ?? null
    });
    const bytes = Buffer.from(text, 'utf8');
    this.recordImport('agent', { id: agentId }, staged, { id: agentId, path: relative },
      withoutDefaults ? { transforms: ['without-defaults'], fileSha256: sha256Of(bytes) } : {});
    this.summary.push(`${existing ? 'Updated' : 'New'} agent ${parsed.label} from ${sourceText(staged.source)}${parsed.defaultFor.length ? `, drafting ${parsed.defaultFor.map((step) => this.phaseLabel(step)).join(', ')}` : ''}.`);
  }

  addMarketplace({ id, label, index, allowedOrigins = [] }) {
    const marketplaceId = requireId(id, 'A marketplace ID');
    if (this.content.marketplaces?.[marketplaceId]) {
      throw new SingularityFlowError(`This repository already trusts a marketplace called '${marketplaceId}'.`, { code: 'STUDIO_MARKETPLACE_EXISTS' });
    }
    const marketplace = normalizeMarketplaces({ [marketplaceId]: { label: label ?? undefined, index, allowedOrigins } })[marketplaceId];
    this.document.setIn(['marketplaces', marketplaceId], this.document.createNode({
      label: marketplace.label, index: marketplace.index,
      ...(marketplace.allowedOrigins.length ? { allowedOrigins: [...marketplace.allowedOrigins] } : {})
    }));
    this.summary.push(`This repository trusts marketplace ${marketplace.label} (${marketplace.index}).`);
  }

  removeMarketplace({ id }) {
    const marketplaceId = requireId(id, 'A marketplace ID');
    const existing = this.content.marketplaces?.[marketplaceId];
    if (!existing) throw new SingularityFlowError(`This repository does not trust a marketplace called '${marketplaceId}'.`, { code: 'STUDIO_MARKETPLACE_UNKNOWN' });
    this.document.deleteIn(['marketplaces', marketplaceId]);
    if (!Object.keys(this.content.marketplaces ?? {}).length) this.document.deleteIn(['marketplaces']);
    // Imports already taken from it stay: they are vendored, and the ledger still says where from.
    this.summary.push(`Marketplace ${existing.label ?? marketplaceId} is no longer trusted; what was imported from it stays.`);
  }

  importGenerated({ agent: agentId, id, urlTemplate, phase, target, optional = false, maxBytes = DEFAULT_REMOTE_MAX_BYTES, replace = false, origin = null }) {
    const agent = this.touch(this.requireAgent(requireId(agentId, 'An agent ID')));
    const resourceId = requireId(id, 'A generated artifact ID');
    const source = validateGeneratedSource({ urlTemplate, phase, target });
    this.requirePhase(source.phase);
    if (agent.phases.length && !agent.phases.includes(source.phase)) {
      throw new SingularityFlowError(`${agent.label} does not draft ${this.phaseLabel(source.phase)}, so it would never fetch this artifact.`, { code: 'STUDIO_IMPORT_INVALID' });
    }
    const limit = Number(maxBytes);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > HARD_REMOTE_MAX_BYTES) {
      throw new SingularityFlowError(`A generated artifact may be at most ${HARD_REMOTE_MAX_BYTES} bytes.`, { code: 'STUDIO_IMPORT_INVALID' });
    }
    agent.body = upsertAgentTableRow(this.agentBody(agent), 'generated',
      [resourceId, source.urlTemplate, source.phase, source.target, optional ? 'yes' : 'no', String(limit)], { replace });
    this.trust(agent.id, {
      id: resourceId, type: 'generated', urlTemplate: source.urlTemplate, optional: optional === true, maxBytes: limit,
      phase: source.phase, target: source.target, dynamic: true, sha256: null, size: null, resolvedUrl: null
    });
    const provenance = origin && typeof origin === 'object' && origin.marketplace
      ? { kind: 'marketplace', marketplace: String(origin.marketplace), index: String(origin.index ?? ''), entry: String(origin.entry ?? resourceId), version: String(origin.version ?? ''), urlTemplate: source.urlTemplate }
      : { kind: 'url', urlTemplate: source.urlTemplate };
    this.recordImport('generated', { agent: agent.id, id: resourceId },
      { source: provenance, sha256: null, size: null, fetchedAt: null },
      { agent: agent.id, id: resourceId, phase: source.phase, path: source.target });
    this.summary.push(`${agent.label} fetches ${source.target} for ${this.phaseLabel(source.phase)} from ${source.urlTemplate}.`);
  }

  importMcpServer({ sha256, id = null, agents = [], phases = [], replace = false }) {
    const staged = this.stagedContent(sha256, 'mcp-server', { id: id == null ? null : requireId(id, 'An MCP server ID') });
    const descriptor = parseMcpServerDescriptor(staged.text, { id: staged.inspection.id });
    const serverId = descriptor.id;
    const key = importLedgerKey('mcp-server', { id: serverId });
    if (this.content.mcpServers?.[serverId]) {
      if (!replace) throw new SingularityFlowError(`An MCP server called '${serverId}' is already governed here. Replace it deliberately, or import it under another ID.`, { code: 'STUDIO_MCP_SERVER_EXISTS' });
      if (!this.ledger.imports[key]) throw new SingularityFlowError(`MCP server '${serverId}' was configured in this repository, not imported, so an import cannot replace it.`, { code: 'STUDIO_MCP_SERVER_EXISTS' });
    }
    if (!Array.isArray(agents)) throw new SingularityFlowError('The agents that may use an MCP server must be a list.', { code: 'STUDIO_IMPORT_INVALID' });
    const assigned = [...new Set(agents.map((agentId) => this.requireAgent(requireId(agentId, 'An agent ID')).id))];
    const steps = this.requirePhases(phases);
    const sources = descriptor.policy.sources ?? null;
    if (!assigned.length && !sources) {
      throw new SingularityFlowError(`Choose the agents that may use ${descriptor.label}.`, { code: 'STUDIO_IMPORT_INVALID' });
    }
    if (!assigned.length && descriptor.policy.tools.length) {
      throw new SingularityFlowError(`${descriptor.label} offers tools; choose the agents that may use them, or import it for its content only.`, { code: 'STUDIO_IMPORT_INVALID' });
    }
    const node = {
      label: descriptor.label, hostReference: serverId,
      ...(assigned.length ? { agents: assigned } : {}), ...(steps.length ? { phases: steps } : {}),
      ...(assigned.length && descriptor.policy.tools.length ? { tools: descriptor.policy.tools } : {}),
      approval: descriptor.policy.approval, evidence: descriptor.policy.evidence,
      ...(sources ? { sources } : {})
    };
    this.document.setIn(['mcpServers', serverId], this.document.createNode(node));
    // An agent may use only the MCP tools its own file declares; grant exactly what was chosen.
    const granted = descriptor.policy.tools.length ? descriptor.policy.tools.map((tool) => `${serverId}/${tool}`) : [`${serverId}/*`];
    for (const agentId of assigned) {
      const agent = this.touch(this.requireAgent(agentId));
      for (const tool of granted) if (!agent.tools.includes(tool)) agent.tools = [...agent.tools, tool];
    }
    this.vendored.set(mcpDescriptorPath(serverId), staged.bytes);
    this.recordImport('mcp-server', { id: serverId }, staged, { id: serverId, path: mcpDescriptorPath(serverId), agents: assigned, phases: steps, tools: granted });
    this.summary.push(`MCP server ${descriptor.label} from ${sourceText(staged.source)}${assigned.length ? ` for ${assigned.map((agentId) => this.agentLabel(agentId)).join(', ')}` : ', for imports only'}. Add its host entry with singularity-flow mcp host add ${serverId}.`);
  }

  removeImport({ key }) {
    const entry = this.ledger.imports[String(key ?? '')];
    if (!entry) throw new SingularityFlowError(`Nothing was imported as '${key}'. List imports with singularity-flow imports.`, { code: 'STUDIO_IMPORT_UNKNOWN' });
    const target = entry.target ?? {};
    if (entry.kind === 'skill' || entry.kind === 'generated') {
      const agent = this.agents.get(target.agent);
      if (agent) {
        this.touch(agent);
        const body = removeAgentTableRow(this.agentBody(agent), entry.kind, target.id);
        if (body != null) agent.body = body;
        this.distrust(agent.id, entry.kind, target.id);
      }
      if (entry.kind === 'skill' && target.path) this.vendored.set(target.path, null);
      this.summary.push(`${agent?.label ?? target.agent} no longer uses ${entry.kind === 'skill' ? 'skill' : 'generated artifact'} ${target.id}.`);
    } else if (entry.kind === 'template') {
      const relative = importedTemplateRelative(target.id);
      const references = templateReferences(this.content, relative);
      if (references.length) {
        throw new SingularityFlowError(`Template ${target.id} is still used by ${references.join(', ')}; choose other templates there first.`, { code: 'STUDIO_TEMPLATE_IN_USE' });
      }
      this.document.deleteIn(['templates', target.id]);
      if (target.path) this.vendored.set(target.path, null);
      this.summary.push(`Template ${target.id} removed.`);
    } else if (entry.kind === 'agent') {
      const agent = this.agents.get(target.id);
      if (agent?.defaultFor.length) {
        throw new SingularityFlowError(`${agent.label} still drafts ${agent.defaultFor.map((step) => this.phaseLabel(step)).join(', ')}; choose other agents for those steps first.`, { code: 'STUDIO_AGENT_IN_USE' });
      }
      const servers = Object.entries(this.content.mcpServers ?? {}).filter(([, server]) => (server?.agents ?? []).includes(target.id)).map(([serverId]) => serverId);
      if (servers.length) {
        throw new SingularityFlowError(`${agent?.label ?? target.id} is still assigned MCP server(s) ${servers.join(', ')}; unassign them first.`, { code: 'STUDIO_AGENT_IN_USE' });
      }
      if (agent) {
        this.agents.delete(agent.id);
        this.removedAgents.add(agent.relative);
        if (this.lock.agents?.[agent.id]) { delete this.lock.agents[agent.id]; this.lockChanged = true; }
      }
      this.summary.push(`Agent ${agent?.label ?? target.id} removed.`);
    } else if (entry.kind === 'mcp-server') {
      const required = Object.entries(this.content.phases ?? {}).filter(([, phase]) => (phase?.mcp?.requiredServers ?? []).includes(target.id)).map(([phaseId]) => this.phaseLabel(phaseId));
      if (required.length) throw new SingularityFlowError(`${required.join(', ')} require MCP server ${target.id}; change those steps first.`, { code: 'STUDIO_MCP_SERVER_IN_USE' });
      this.document.deleteIn(['mcpServers', target.id]);
      if (!Object.keys(this.content.mcpServers ?? {}).length) this.document.deleteIn(['mcpServers']);
      for (const agentId of target.agents ?? []) {
        const agent = this.agents.get(agentId);
        if (!agent) continue;
        this.touch(agent).tools = agent.tools.filter((tool) => !tool.startsWith(`${target.id}/`));
      }
      if (target.path) this.vendored.set(target.path, null);
      this.summary.push(`MCP server ${target.id} removed; remove its host entry from .vscode/mcp.json yourself if it is no longer used.`);
    } else {
      throw new SingularityFlowError(`Imports of kind '${entry.kind}' cannot be removed here.`, { code: 'STUDIO_IMPORT_UNKNOWN' });
    }
    this.forgetImport(String(key));
  }

  /**
   * Agent lock entries for every agent whose file changes. A changed file keeps working only when
   * every remote resource it names is trusted: imported ones by the hash a person previewed, the
   * rest by a current lock entry whose declaration is unchanged. An agent edited without imports
   * and without a current lock keeps the old behaviour: its lock goes stale until someone locks it.
   */
  finalizeImports(problems) {
    for (const agent of this.agents.values()) {
      if (!agent.touched && !agent.imported) continue;
      const text = agent.touched ? renderAgent(agent) : agent.text;
      this.rendered.set(agent.id, text);
      let parsed;
      try { parsed = parseAgentDependencies(text, { source: agent.relative }); }
      catch (error) {
        problems.push({ code: error?.code ?? 'STUDIO_AGENT_INVALID', message: `${agent.label}: ${error.message}`, subject: { kind: 'agent', id: agent.id } });
        continue;
      }
      const existing = this.lock.agents?.[agent.id] ?? null;
      const current = existing && existing.sourceSha256 === this.sources.agentShas.get(agent.id) ? existing : null;
      const trusted = this.trusted.get(agent.id) ?? new Map();
      const changedTrust = trusted.size > 0 || (this.untrusted.get(agent.id)?.size ?? 0) > 0;
      if (!parsed.dependencies.length) {
        if (existing) { delete this.lock.agents[agent.id]; this.lockChanged = true; }
        continue;
      }
      const dependencies = [];
      const unresolved = [];
      for (const dependency of parsed.dependencies) {
        const imported = trusted.get(`${dependency.type}:${dependency.id}`);
        if (imported) { dependencies.push(imported); continue; }
        const locked = current?.dependencies?.find((entry) => entry.id === dependency.id && entry.type === dependency.type);
        if (locked && sameDeclaration(locked, dependency)) { dependencies.push(locked); continue; }
        unresolved.push(`${dependency.type} ${dependency.id}`);
      }
      if (unresolved.length) {
        if (changedTrust) {
          problems.push({
            code: 'STUDIO_AGENT_LOCK_REQUIRED',
            message: `${agent.label} also names remote ${unresolved.join(', ')}, which nobody has trusted yet. Run singularity-flow agents lock ${agent.id} first, then add the import.`,
            subject: { kind: 'agent', id: agent.id }
          });
        }
        continue;
      }
      this.lock.agents ??= {};
      this.lock.agents[agent.id] = { source: agent.relative, sourceSha256: sha256(text), lockedAt: new Date().toISOString(), dependencies };
      this.lockChanged = true;
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

  createPhase({ id, label, output, inputs, approval, views, agent, copyOf, copyFromWorkflow, authoringSkill, clarification }) {
    const phaseId = requireId(id, 'A step ID');
    if (this.phase(phaseId)) throw new SingularityFlowError(`A step called '${phaseId}' already exists.`, { code: 'STUDIO_PHASE_EXISTS' });
    const name = requireLabel(label, 'The step');
    let node;
    if (copyOf) {
      const source = this.requirePhase(requireId(copyOf, 'The step to copy'));
      node = structuredClone(this.phase(source));
      if (copyFromWorkflow != null) {
        const workflowId = requireId(copyFromWorkflow, 'The workflow to copy the step from');
        const workflow = this.content.workTypes?.[workflowId];
        if (!workflow?.phases?.includes(source)) {
          throw new SingularityFlowError(`Workflow '${workflowId}' does not use step '${source}'.`, { code: 'STUDIO_PHASE_UNKNOWN' });
        }
        // The step as that workflow runs it: the workflow's override folded in by the rule resolution
        // uses, so settings the Studio does not show (input selectors and summaries, write scope, tool
        // evidence, send-back targets) come along.
        node = foldOverride(node, workflow.phaseOverrides?.[source]);
        if (workflow.templateOverrides?.[source] != null) node.defaultTemplate = workflow.templateOverrides[source];
        // A workflow may say automatic (null) over the step's own drafting skill; a copy only one
        // workflow uses says the same by leaving it out.
        if (node.authoringSkill === null) delete node.authoringSkill;
      }
      node.label = name;
      // A member of an artifact set keeps the file name the set expects as its primary member.
      const fileName = node.artifactSet !== undefined ? path.posix.basename(posix(String(node.artifact?.path ?? ''))) : `${phaseId}.md`;
      node.artifact = { ...(node.artifact ?? {}), path: `artifacts/${phaseId}/${fileName}` };
      delete node.agents;
      // A step that may be sent back to itself may be sent back to its copy, not to the step it copies.
      if (Array.isArray(node.approval?.rejectTo)) node.approval.rejectTo = node.approval.rejectTo.map((target) => (target === source ? phaseId : target));
      if (node.repairBudget?.resetOnPhase === source) node.repairBudget.resetOnPhase = phaseId;
      this.copies.set(phaseId, source);
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
    // A copy's own skill that cannot draft its new output is dropped; one the change names decides.
    const dropped = !copyOf || (output !== undefined && output !== outputOf(node)) ? this.setOutput(phaseId, output ?? 'document') : null;
    if (!copyOf) this.writeTemplateIfMissing(`common/${phaseId}.md`, phaseId, name);
    // Absent or null leaves a list as it is, as in phase.update: a new step has none, a copy keeps its source's.
    const inputList = changeList(inputs, `The inputs of ${name}`, 'STUDIO_PHASE_UNKNOWN');
    if (inputList) this.document.setIn(['phases', phaseId, 'inputs'], this.document.createNode(this.inputEntries(inputList, node.inputs ?? [])));
    const viewList = changeList(views, `The knowledge views of ${name}`, 'STUDIO_VIEWS_INVALID');
    if (viewList) this.document.setIn(['phases', phaseId, 'worldModel'], this.document.createNode({ depth: 'quick', ...(node.worldModel ?? {}), views: [...viewList] }));
    if (copyOf && approval != null) {
      const current = approvalSummary(node.approval);
      const unchanged = approval === 'none' ? current.mode === 'none'
        : current.mode !== 'none' && approval.group === current.authorities[0] && Number(approval.minimum ?? 1) === current.minimum;
      if (!unchanged) this.document.setIn(['phases', phaseId, 'approval'], this.document.createNode(this.approvalNode(approval, node.approval)));
    }
    if (authoringSkill !== undefined) {
      if (authoringSkill === null) this.document.deleteIn(['phases', phaseId, 'authoringSkill']);
      else this.document.setIn(['phases', phaseId, 'authoringSkill'], requireAuthoringSkill(authoringSkill));
    }
    if (clarification !== undefined) {
      if (!CLARIFICATION_MODES.some((mode) => mode.id === clarification)) throw new SingularityFlowError('Clarifying questions are off, when-needed or required.', { code: 'STUDIO_CLARIFICATION_INVALID' });
      if (clarification === 'off') this.document.deleteIn(['phases', phaseId, 'clarification']);
      else this.document.setIn(['phases', phaseId, 'clarification'], this.document.createNode({ ...(node.clarification ?? {}), mode: clarification }));
    }
    const agentId = agent ?? (copyOf ? [...this.agents.values()].find((entry) => entry.defaultFor.includes(copyOf))?.id : null);
    if (!agentId) throw new SingularityFlowError(`Choose the agent that drafts ${name}.`, { code: 'STUDIO_PHASE_AGENT_REQUIRED' });
    this.setDefaultAgent(phaseId, requireId(agentId, 'An agent ID'));
    this.summary.push(copyOf
      ? `New step ${name}, a copy of ${this.phaseLabel(copyOf)}, drafted by ${this.agentLabel(agentId)}.`
      : `New step ${name}: drafted by ${this.agentLabel(agentId)}, ${node.approval === 'none' ? 'no sign-off' : `signed off by ${this.content.approvalAuthorities?.[approvalSummary(node.approval).authorities[0]]?.label ?? 'its group'}`}.`);
    const droppedLine = authoringSkill === undefined ? this.droppedSkillLine(phaseId, name, dropped) : null;
    if (droppedLine) this.summary.push(droppedLine);
  }

  /**
   * Input entries for a list of step IDs, each keeping the settings it has (optional, clause
   * selector, summary projection, preserved headings, size limit): an ID that stays keeps its own
   * entry, and a copy made in this change set keeps the entry of the step it copies.
   */
  inputEntries(ids, current) {
    if (!Array.isArray(ids)) throw new SingularityFlowError('Inputs must be a list of step IDs.', { code: 'STUDIO_PHASE_UNKNOWN' });
    const entries = Array.isArray(current) ? current : [];
    const entryFor = (id) => entries.find((entry) => inputPhase(entry) === id);
    return ids.map((input) => {
      const id = requireId(input, 'An input step');
      if (!this.pendingPhases.has(id)) this.requirePhase(id);
      const own = entryFor(id);
      if (own !== undefined) return structuredClone(own);
      const replaced = this.copies.has(id) ? entryFor(this.copies.get(id)) : undefined;
      return isObject(replaced) ? { ...structuredClone(replaced), phase: id } : id;
    });
  }

  updatePhase({ id, workflow, label, output, inputs, approval, views, clarification, authoringSkill }) {
    const phaseId = this.requirePhase(requireId(id, 'A step ID'));
    const name = this.phaseLabel(phaseId);
    // Shared once the change set is applied: a step this change set also adds to another workflow
    // is shared already, so a setting for that workflow does not leak into the first one.
    const users = this.usedByAtEnd(phaseId);
    const shared = users.length > 1;
    // Approval and inputs are per-workflow when the step is shared and a workflow is named; every
    // other setting is the step's own and applies wherever the step is used.
    // A workflow that already overrides a field keeps owning it: writing the step's own value would
    // be shadowed by that override and change nothing.
    // A named workflow must exist: setting a path under a missing one would silently create a stub.
    if (workflow && !this.content.workTypes?.[requireId(workflow, 'A workflow ID')]) {
      throw new SingularityFlowError(`There is no workflow '${workflow}' to change ${name} in.`, { code: 'STUDIO_WORKFLOW_UNKNOWN' });
    }
    // And it must use the step: its setting would otherwise land on the step itself and change
    // every workflow that does.
    if (workflow && !users.includes(requireId(workflow, 'A workflow ID'))) {
      throw new SingularityFlowError(`Workflow '${workflow}' does not use ${name}, so it has no settings of its own for it.`, { code: 'STUDIO_PHASE_UNKNOWN' });
    }
    const override = workflow ? ['workTypes', requireId(workflow, 'A workflow ID'), 'phaseOverrides', phaseId] : null;
    const scopeFor = (field) => (override && (shared || this.document.getIn([...override, field]) !== undefined) ? override : ['phases', phaseId]);
    const valueAt = (scope, field) => {
      const node = this.document.getIn([...scope, field]);
      return node?.toJSON?.() ?? node;
    };
    const changed = [];
    let dropped = null;
    if (label != null) { this.document.setIn(['phases', phaseId, 'label'], requireLabel(label, 'The step')); changed.push('name'); }
    if (output != null) { dropped = this.setOutput(phaseId, output); changed.push('output'); }
    const inputList = changeList(inputs, `The inputs of ${name}`, 'STUDIO_PHASE_UNKNOWN');
    if (inputList) {
      const scope = scopeFor('inputs');
      // An input entry that stays keeps its own settings (selector, projection, preserved headings),
      // and so does one for a step this workflow now uses a copy of.
      const current = valueAt(scope, 'inputs') ?? this.phase(phaseId).inputs ?? [];
      const entries = this.inputEntries(inputList, current);
      if (entries.length || scope === override) this.setKeepingStyle([...scope, 'inputs'], entries);
      else this.document.deleteIn([...scope, 'inputs']);
      changed.push('inputs');
    }
    if (approval != null) {
      const scope = scopeFor('approval');
      const existing = valueAt(scope, 'approval') ?? this.phase(phaseId).approval;
      this.document.setIn([...scope, 'approval'], this.document.createNode(this.approvalNode(approval, existing === 'none' ? null : existing)));
      changed.push('sign-off');
    }
    const viewList = changeList(views, `The knowledge views of ${name}`, 'STUDIO_VIEWS_INVALID');
    if (viewList) {
      if (viewList.length) this.document.setIn(['phases', phaseId, 'worldModel', 'views'], this.document.createNode([...viewList]));
      else if (this.document.hasIn(['phases', phaseId, 'worldModel', 'views'])) this.document.deleteIn(['phases', phaseId, 'worldModel', 'views']);
      changed.push('knowledge');
    }
    if (authoringSkill !== undefined) {
      // The drafting skill is per workflow on a shared step, like sign-off and inputs.
      const scope = scopeFor('authoringSkill');
      if (authoringSkill === null) {
        // Automatic: drop the setting, or, where this workflow overrides a step that names a skill
        // of its own, say automatic explicitly so the step's own value does not show through.
        if (scope !== override || typeof this.phase(phaseId)?.authoringSkill !== 'string') {
          if (this.document.hasIn([...scope, 'authoringSkill'])) this.document.deleteIn([...scope, 'authoringSkill']);
        }
        else this.document.setIn([...scope, 'authoringSkill'], null);
      } else this.document.setIn([...scope, 'authoringSkill'], requireAuthoringSkill(authoringSkill));
      changed.push('drafting skill');
    }
    if (clarification != null) {
      if (!CLARIFICATION_MODES.some((mode) => mode.id === clarification)) throw new SingularityFlowError('Clarifying questions are off, when-needed or required.', { code: 'STUDIO_CLARIFICATION_INVALID' });
      if (clarification === 'off') this.document.deleteIn(['phases', phaseId, 'clarification']);
      else this.document.setIn(['phases', phaseId, 'clarification'], this.document.createNode({ mode: clarification }));
      changed.push('questions');
    }
    if (changed.length) this.summary.push(`${label ?? name}: ${changed.join(', ')} changed${shared && workflow && (inputs != null || approval != null || authoringSkill !== undefined) ? ` for ${this.content.workTypes?.[workflow]?.label ?? workflow} only` : ''}.`);
    const droppedLine = this.droppedSkillLine(phaseId, label ?? name, dropped);
    if (droppedLine) this.summary.push(droppedLine);
  }

  assignAgent({ phase, agent }) {
    const phaseId = this.requirePhase(requireId(phase, 'A step ID'));
    const agentId = requireId(agent, 'An agent ID');
    const previous = this.setDefaultAgent(phaseId, agentId);
    const users = this.usedBy(phaseId);
    this.summary.push(`${this.phaseLabel(phaseId)} is now drafted by ${this.agentLabel(agentId)}${previous ? ` (was ${this.agentLabel(previous)})` : ''}${users.length > 1 ? `, in all ${users.length} workflows that use it` : ''}.`);
  }

  createWorkflow({ id, label, description, phases, copyOf = null }) {
    const workflowId = requireId(id, 'A workflow ID');
    if (this.content.workTypes?.[workflowId]) throw new SingularityFlowError(`A workflow called '${workflowId}' already exists.`, { code: 'STUDIO_WORKFLOW_EXISTS' });
    const name = requireLabel(label, 'The workflow');
    const ids = (phases ?? []).map((phase) => this.requirePhase(requireId(phase, 'A step ID')));
    if (!ids.length) throw new SingularityFlowError(`${name} needs at least one step.`, { code: 'STUDIO_WORKFLOW_EMPTY' });
    if (new Set(ids).size !== ids.length) throw new SingularityFlowError(`${name} lists a step more than once.`, { code: 'STUDIO_WORKFLOW_DUPLICATE' });
    let node = { label: name, ...(description ? { description: String(description).trim() } : {}), phases: ids };
    let copied = null;
    if (copyOf != null) {
      // A duplicate starts as the whole source workflow: per-step sign-off, inputs, templates,
      // send-back rules, decisions and claims, not only the parts the Studio shows.
      const sourceId = requireId(copyOf, 'The workflow to copy');
      const source = this.content.workTypes?.[sourceId];
      if (!source) throw new SingularityFlowError(`There is no workflow '${sourceId}' to copy.`, { code: 'STUDIO_WORKFLOW_UNKNOWN' });
      node = structuredClone(source);
      node.label = name;
      if (description) node.description = String(description).trim(); else delete node.description;
      node.phases = ids;
      for (const key of ['phaseOverrides', 'templateOverrides']) {
        if (!node[key] || typeof node[key] !== 'object') continue;
        for (const phaseId of Object.keys(node[key])) if (!ids.includes(phaseId)) delete node[key][phaseId];
        if (!Object.keys(node[key]).length) delete node[key];
      }
      copied = source.label ?? sourceId;
    }
    this.document.setIn(['workTypes', workflowId], this.document.createNode(node));
    this.workflows.set(workflowId, { newlyCreated: true });
    this.summary.push(`New workflow ${name}${copied ? `, a copy of ${copied}` : ''}: ${ids.map((phase) => this.phaseLabel(phase)).join(' → ')}.`);
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

  /** Replace a list or map, keeping how the one already there is written: `[a, b]` or one per line. */
  setKeepingStyle(keys, value) {
    this.document.setIn(keys, this.document.createNode(value, { flow: Boolean(this.document.getIn(keys, true)?.flow) }));
  }

  /**
   * A copy made for a workflow takes the place of the step it copies there. Once the workflow lists
   * the copy instead of the step, whatever in that workflow named the step names the copy: other
   * steps' inputs (each keeping its settings), send-back targets and test evidence, the workflow's
   * own rules, and the shared lists that allow the step something allow the copy the same.
   */
  rewireCopies() {
    for (const [copyId, source] of this.copies) {
      if (!this.phase(copyId)) continue;
      for (const workflowId of this.usedBy(copyId)) {
        const type = this.content.workTypes?.[workflowId];
        const order = type?.phases ?? [];
        if (!order.includes(copyId) || order.includes(source)) continue;
        const moved = new Set();
        for (const stepId of order) if (stepId !== copyId) this.renameStepReferences(workflowId, stepId, source, copyId, moved);
        this.renameWorkflowReferences(workflowId, source, copyId, moved);
        this.allowCopyLikeSource(workflowId, source, copyId, moved);
        if (!moved.size) continue;
        const words = [...moved];
        this.summary.push(`In ${type.label ?? workflowId}, ${this.phaseLabel(copyId)} takes the place of ${this.phaseLabel(source)} in ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]}.`);
      }
    }
  }

  /**
   * Point one step's references at the copy. A field the workflow's override already sets changes
   * there, and so does any field of a step other workflows share, so the change reaches only this
   * workflow; a step only this workflow uses changes its own definition.
   */
  renameStepReferences(workflowId, stepId, from, to, moved) {
    const override = this.content.workTypes[workflowId].phaseOverrides?.[stepId] ?? {};
    const base = this.phase(stepId) ?? {};
    const shared = this.usedBy(stepId).length > 1;
    const own = ['workTypes', workflowId, 'phaseOverrides', stepId];
    const scope = (field) => (Object.hasOwn(override, field) || shared ? own : ['phases', stepId]);
    const valueOf = (field) => (Object.hasOwn(override, field) ? override[field] : base[field]);
    const inputs = valueOf('inputs');
    if (Array.isArray(inputs) && inputs.some((entry) => inputPhase(entry) === from)) {
      this.setKeepingStyle([...scope('inputs'), 'inputs'], inputs.map((entry) => (
        inputPhase(entry) !== from ? entry : typeof entry === 'string' ? to : { ...entry, phase: to })));
      moved.add("the steps' inputs");
    }
    if (valueOf('testEvidenceFrom') === from) {
      this.document.setIn([...scope('testEvidenceFrom'), 'testEvidenceFrom'], to);
      moved.add('test evidence');
    }
    // An override's repair budget replaces the step's whole, so the whole budget is written.
    const budget = valueOf('repairBudget');
    if (isObject(budget) && budget.resetOnPhase === from) {
      this.setKeepingStyle([...scope('repairBudget'), 'repairBudget'], { ...budget, resetOnPhase: to });
      moved.add('send-back limits');
    }
    // An override's approval merges over the step's key by key, so only its targets are written there.
    const ownApproval = override.approval;
    const rejectTo = typeof ownApproval === 'string' ? null
      : isObject(ownApproval) && Object.hasOwn(ownApproval, 'rejectTo') ? ownApproval.rejectTo
        : isObject(base.approval) ? base.approval.rejectTo : null;
    if (Array.isArray(rejectTo) && rejectTo.includes(from)) {
      const where = isObject(ownApproval) || shared ? own : ['phases', stepId];
      this.setKeepingStyle([...where, 'approval', 'rejectTo'], rejectTo.map((target) => (target === from ? to : target)));
      moved.add('send-back targets');
    }
  }

  /** The workflow's own rules and policies that name the step. */
  renameWorkflowReferences(workflowId, from, to, moved) {
    const type = this.content.workTypes[workflowId];
    const swap = (id) => (id === from ? to : id);
    const set = (keys, value, words) => { this.setKeepingStyle(['workTypes', workflowId, ...keys], value); moved.add(words); };
    const named = (object, keys) => keys.some((key) => object?.[key] === from);
    const renamedFields = (object, keys) => ({ ...object, ...Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, swap(object[key])])) });
    const loops = type.reworkLoops ?? [];
    if (loops.some((loop) => named(loop, ['from', 'to', 'resetOnPhase']))) {
      set(['reworkLoops'], loops.map((loop) => renamedFields(loop, ['from', 'to', 'resetOnPhase'])), 'send-back rules');
    }
    const decisions = type.decisions ?? [];
    if (decisions.some((decision) => named(decision, ['after', 'back']) || (decision?.routes ?? []).some((route) => named(route, ['to'])))) {
      set(['decisions'], decisions.map((decision) => ({
        ...renamedFields(decision, ['after', 'back']),
        ...(Array.isArray(decision.routes) ? { routes: decision.routes.map((route) => renamedFields(route, ['to'])) } : {})
      })), 'decisions');
    }
    const claims = type.plannedClaims;
    if (Array.isArray(claims?.clausePhases) && claims.clausePhases.includes(from)) set(['plannedClaims', 'clausePhases'], claims.clausePhases.map(swap), 'planned claims');
    if (isObject(claims?.owners) && Object.entries(claims.owners).some(([code, owner]) => code === from || owner === from)) {
      set(['plannedClaims', 'owners'], Object.fromEntries(Object.entries(claims.owners).map(([code, owner]) => [swap(code), swap(owner)])), 'planned claims');
    }
    if (Array.isArray(type.documents?.allowedPhases) && type.documents.allowedPhases.includes(from)) set(['documents', 'allowedPhases'], type.documents.allowedPhases.map(swap), 'document uploads');
    const design = type.designSources;
    if (isObject(design)) {
      // Design sources are captured in design-intake unless the workflow names another step.
      if ((design.capturePhase ?? 'design-intake') === from) set(['designSources', 'capturePhase'], to, 'design sources');
      if (Array.isArray(design.consumeIn) && design.consumeIn.includes(from)) set(['designSources', 'consumeIn'], design.consumeIn.map(swap), 'design sources');
    }
    if (isObject(type.fastPath) && this.fastPathProfile) {
      const profile = this.fastPathProfile({ workTypes: { [workflowId]: type } }, workflowId);
      for (const [verb, entry] of Object.entries(profile?.verbs ?? {})) {
        if (!entry.phases.includes(from)) continue;
        // A verb without a list owns the step it is named for, so once that step is copied the list is spelled out.
        const configured = type.fastPath[verb];
        if (typeof configured === 'string') set(['fastPath', verb], { milestone: configured, phases: entry.phases.map(swap) }, 'the fast path');
        else set(['fastPath', verb, 'phases'], entry.phases.map(swap), 'the fast path');
      }
    }
  }

  /** Shared lists that allow the step something allow its copy the same. */
  allowCopyLikeSource(workflowId, from, to, moved) {
    const content = this.content;
    const add = (keys, list, words) => {
      if (!Array.isArray(list) || !list.includes(from) || list.includes(to)) return;
      const next = [...list];
      next.splice(next.indexOf(from) + 1, 0, to);
      this.setKeepingStyle(keys, next);
      moved.add(words);
    };
    for (const [serverId, server] of Object.entries(content.mcpServers ?? {})) add(['mcpServers', serverId, 'phases'], server?.phases, 'MCP servers');
    // A workflow that lists its own document steps does not read the shared list.
    if (!Array.isArray(content.workTypes?.[workflowId]?.documents?.allowedPhases)) add(['documents', 'allowedPhases'], content.documents?.allowedPhases, 'document uploads');
    for (const field of ['allowedPhases', 'blockRequiredUnfulfilledAt']) add(['architectureIntent', field], content.architectureIntent?.[field], 'architecture intent');
    const context = content.contextPolicy?.phaseOverrides;
    if (isObject(context) && Object.hasOwn(context, from) && !Object.hasOwn(context, to)) {
      this.document.setIn(['contextPolicy', 'phaseOverrides', to], this.document.createNode(structuredClone(context[from])));
      moved.add('context handling');
    }
  }

  /** Pin planned claims, trim agents to existing steps, and check every step has one agent. */
  finalize(problems) {
    this.rewireCopies();
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
    if (!problems.length) this.finalizeImports(problems);
  }

  async files() {
    const files = [];
    // Only a change in content rewrites workflow.yml: re-serializing an untouched document can still
    // re-wrap long lines, and a change set that only imports a skill must not touch the file at all.
    if (JSON.stringify(this.document.toJS() ?? {}) !== JSON.stringify(this.sources.raw ?? {})) {
      const workflow = preserveYamlFormatting(this.sources.definitionText, this.document.toString(YAML_OUTPUT));
      if (workflow !== this.sources.definitionText) files.push({ path: WORKFLOW_PATH, before: this.sources.definitionText, after: workflow });
    }
    for (const agent of this.agents.values()) {
      if (!agent.touched && !agent.imported) continue;
      const original = agent.imported ? agent.previousText : agent.text;
      const before = agent.scope === 'repository' && original && !agent.created ? original : null;
      files.push({ path: agent.relative, before, after: this.rendered.get(agent.id) ?? (agent.touched ? renderAgent(agent) : agent.text) });
    }
    for (const relative of this.removedAgents) {
      const before = await readFile(path.join(this.sources.configRoot, relative), 'utf8').catch(() => null);
      if (before != null) files.push({ path: relative, before, after: null });
    }
    for (const [relative, content] of this.templates) {
      files.push({ path: relative, before: null, after: typeof content === 'string' ? content : await readFile(content.copyFrom, 'utf8') });
    }
    for (const [relative, bytes] of this.vendored) {
      const before = await readFile(path.join(this.sources.configRoot, relative)).catch(() => null);
      if (bytes == null && before == null) continue;
      files.push({ path: relative, before, after: bytes });
    }
    if (this.ledgerChanged) {
      const after = Object.keys(this.ledger.imports).length ? renderImportsLedger(this.ledger) : null;
      files.push({ path: IMPORTS_LOCK_PATH, before: this.sources.ledgerText, after });
    }
    if (this.lockChanged) {
      const after = Object.keys(this.lock.agents ?? {}).length ? YAML.stringify(this.lock) : null;
      files.push({ path: AGENT_LOCK_PATH, before: this.sources.agentLockText, after });
    }
    return files.filter((file) => !sameContent(file.before, file.after));
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

/**
 * The steps each workflow lists once an ordered change set is applied: its current list, replaced by
 * the last create, install or update that gives it one. Step settings are applied before workflows
 * change their lists, and whether a step is shared decides whether a workflow's sign-off, inputs or
 * drafting skill land on that workflow or on the step itself; read from the list at that moment, a
 * step just added to a second workflow looked unshared, and the second workflow's setting silently
 * changed the first.
 */
function finalWorkflowPhases(sources, changes) {
  const listed = (phases) => (Array.isArray(phases) ? phases.map((phase) => String(phase ?? '').trim()) : []);
  const lists = new Map(Object.entries(sources.raw.workTypes ?? {}).map(([id, type]) => [id, listed(type?.phases)]));
  for (const change of changes) {
    const id = String(change?.id ?? '').trim();
    if (change?.op === 'workflow.install' && !lists.has(id)) lists.set(id, listed(sources.starter.raw.workTypes?.[id]?.phases));
    else if ((change?.op === 'workflow.create' || change?.op === 'workflow.update') && Array.isArray(change.phases)) lists.set(id, listed(change.phases));
  }
  return lists;
}

function safeMarketplaces(value, problems) {
  try { return normalizeMarketplaces(value ?? {}); }
  catch (error) { problems.push({ code: error?.code ?? 'MARKETPLACE_INVALID', message: error.message }); return {}; }
}

/** A step's shared definition with one workflow's override folded in, by the engine's own rule. */
function foldOverride(phase, override) {
  if (!isObject(override)) return phase;
  const merged = mergePhaseOverride(phase, structuredClone(override));
  // The merge spells out every object it combines; keep only what either side wrote.
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined || !(Object.hasOwn(phase, key) || Object.hasOwn(override, key))) delete merged[key];
  }
  return merged;
}

function sameContent(before, after) {
  if (before == null || after == null) return before == null && after == null;
  return Buffer.from(before).equals(Buffer.from(after));
}

function asText(content) { return content == null ? null : Buffer.isBuffer(content) ? content.toString('utf8') : content; }

function sha256Of(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** The link an import came from, as an agent table row names it. */
function sourceUrl(source) {
  const url = source?.url;
  if (typeof url !== 'string' || !(url.startsWith('https://') || (source.kind === 'mcp' && url.startsWith('mcp://')))) {
    throw new SingularityFlowError('This import has no source an agent table can name.', { code: 'STUDIO_IMPORT_INVALID' });
  }
  return url;
}

/** A readable name for an imported template: its first heading without per-Story values, or its ID. */
function templateLabel(heading, id) {
  const text = String(heading ?? '').replace(/^#+\s*/, '').replace(/\{\{[^{}]*\}\}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const words = text || id.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function sourceText(source) {
  if (source?.kind === 'marketplace') return `marketplace ${source.marketplace} (${source.entry} ${source.version})`;
  if (source?.kind === 'mcp') return `MCP server ${source.server} (${source.method} ${source.name})`;
  return source?.url ?? source?.urlTemplate ?? 'its source';
}

/** Whether a lock entry still describes the same declared resource. */
function sameDeclaration(locked, dependency) {
  const url = dependency.type === 'generated' ? locked.urlTemplate : locked.url;
  if (url !== dependency.url || Boolean(locked.optional) !== Boolean(dependency.optional) || locked.maxBytes !== dependency.maxBytes) return false;
  if (dependency.type === 'generated') return locked.phase === dependency.phase && locked.target === dependency.target;
  return JSON.stringify(locked.phases ?? []) === JSON.stringify(dependency.phases ?? []);
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

async function loadSources(root, options = {}) {
  const configRoot = configurationReadRoot(root);
  const definitionText = await readFile(path.join(configRoot, WORKFLOW_PATH), 'utf8');
  const raw = YAML.parse(definitionText) ?? {};
  let definition = null;
  try { definition = await loadDefinition(root); } catch { definition = null; }
  const agents = (await discoverAgents(root)).filter((agent) => agent.scope !== 'plugin');
  const ledgerText = await readFile(path.join(configRoot, IMPORTS_LOCK_PATH), 'utf8').catch(() => null);
  const agentLockText = await readFile(path.join(configRoot, AGENT_LOCK_PATH), 'utf8').catch(() => null);
  const agentLock = agentLockText ? YAML.parse(agentLockText) : { version: 1, agents: {} };
  if (agentLock?.version !== 1 || !agentLock.agents || typeof agentLock.agents !== 'object') {
    throw new SingularityFlowError(`${AGENT_LOCK_PATH} is invalid.`, { code: 'AGENT_LOCK_INVALID' });
  }
  return {
    root, configRoot, definitionText, raw, definition, agents, bundledAgents: await bundledAgents(),
    ledger: await loadImportsLedger(configRoot), ledgerText, agentLock, agentLockText,
    agentShas: new Map(agents.map((agent) => [agent.id, agent.sha256])),
    imports: options.imports ?? new Map(),
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
export async function planStudioChangeSet(root, changeSet, { write = false, imports = null, fetchImpl = globalThis.fetch } = {}) {
  if (!changeSet || typeof changeSet !== 'object' || changeSet.schema !== STUDIO_CHANGE_SET_SCHEMA) {
    throw new SingularityFlowError(`A Studio change set must declare schema '${STUDIO_CHANGE_SET_SCHEMA}'.`, { code: 'STUDIO_CHANGE_SET_INVALID' });
  }
  // Imported bytes come from the checkout where they were previewed. A caller applying in a
  // proposal clone resolves them first and passes them in.
  let staged = imports;
  if (!staged) {
    try { staged = await resolveChangeSetImports(root, changeSet, { fetchImpl }); }
    catch (error) {
      if (!(error instanceof SingularityFlowError)) throw error;
      return {
        schemaVersion: 1, resultType: 'workflow-studio-plan', valid: false, changed: false,
        problems: [{ code: error.code ?? 'STUDIO_IMPORT_INVALID', message: error.message }], warnings: [], summary: [], files: []
      };
    }
  }
  const sources = await loadSources(root, { imports: staged });
  const expected = changeSet.base?.workflowSha256;
  if (expected && expected !== sha256(sources.definitionText)) {
    throw new SingularityFlowError('The workflow configuration changed since Workflow Studio loaded it. Reload the Studio, review the newer configuration, and apply your changes again.', {
      code: 'STUDIO_BASE_CHANGED', details: { expected, actual: sha256(sources.definitionText) }
    });
  }
  const expectedAgents = changeSet.base?.agentsSha256;
  const actualAgents = agentsSha256(sources.agents);
  if (expectedAgents && expectedAgents !== actualAgents) {
    throw new SingularityFlowError('The agent configuration changed since Workflow Studio loaded it. Reload the Studio, review the newer agents, and apply your changes again.', {
      code: 'STUDIO_BASE_CHANGED', details: { expected: expectedAgents, actual: actualAgents }
    });
  }
  const changes = orderChanges(changeSet.changes);
  const candidate = new StudioCandidate(sources, finalWorkflowPhases(sources, changes));
  const problems = [];
  candidate.expect(changes);
  candidate.fastPathProfile = (await import('./fast-path.mjs')).fastPathProfile;
  for (const change of changes) {
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
  const obligationWarnings = problems.length ? [] : obligationFindings(files, [...candidate.workflows.keys()]);
  const plan = {
    schemaVersion: 1,
    resultType: 'workflow-studio-plan',
    valid: problems.length === 0,
    changed: files.length > 0,
    problems,
    warnings: problems.length ? [] : [...candidate.warnings(), ...obligationWarnings],
    summary: candidate.summary,
    files: files.map((file) => ({
      path: file.path,
      action: file.before == null ? 'create' : file.after == null ? 'delete' : 'update',
      diff: unifiedDiff(asText(file.before), asText(file.after), file.path)
    }))
  };
  if (!write) return plan;
  if (!plan.valid) {
    throw new SingularityFlowError(`Workflow Studio changes were not applied: ${problems[0].message}`, { code: 'STUDIO_CHANGES_INVALID', details: { problems } });
  }
  for (const file of files) {
    const target = path.join(root, file.path);
    if (file.after == null) { await rm(target, { force: true }); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.after);
  }
  return { ...plan, path: WORKFLOW_PATH, written: files.map((file) => file.path) };
}

/**
 * What every route of each edited workflow guarantees. A draft may be saved while its routes still
 * drop a responsibility, so the author can finish it later; Story start refuses it until then, and
 * the plan says so as a warning.
 */
function obligationFindings(files, touched) {
  const file = files.find((entry) => entry.path === WORKFLOW_PATH && entry.after != null);
  if (!file || !touched.length) return [];
  let definition;
  try { definition = validateDefinition(YAML.parse(asText(file.after))); } catch { return []; }
  const warnings = [];
  for (const id of touched) {
    if (!definition.workTypes?.[id]) continue;
    let compiled;
    try { compiled = resolveWorkType(definition, id).obligationGraph; } catch { continue; }
    for (const entry of compiled?.findings ?? []) {
      warnings.push({
        code: entry.code,
        message: entry.severity === 'error' ? `Stories cannot start from this workflow yet: ${entry.message}` : entry.message,
        resolvingAction: entry.resolvingAction, subject: { kind: 'workflow', id }
      });
    }
  }
  return warnings;
}

async function validateStudioCandidate(sources, files) {
  const { validateConfigurationCandidates } = await import('./editor.mjs');
  const definition = sources.definition ?? { templatesRoot: sources.templatesRoot };
  await validateConfigurationCandidates(sources.configRoot, files.filter((file) => file.after != null)
    .map((file) => ({ path: file.path, content: asText(file.after) })), definition, sources.portfolio);
}

export function readStudioChangeSet(text) {
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new SingularityFlowError(`The Studio change set is not valid JSON: ${error.message}`, { code: 'STUDIO_CHANGE_SET_INVALID' }); }
  return value;
}

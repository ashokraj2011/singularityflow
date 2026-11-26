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
import { automaticApprovalRefusal, BECAUSE_SETTINGS, declaresStepIntents, INTENTS_FILE_VERSION, isConvergencePhase, STEP_INTENTS, workTypeDerivesIntents } from './phase-roles.mjs';
import { usesEpicPlanningLifecycle } from './initiative-phase-roles.mjs';
import { phaseTopologyFindings } from './phase-semantics.mjs';
import path from 'node:path';
import { agentsRootOf, isAgentFilePath } from './configuration-assets.mjs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { parseYamlText } from './yaml-parse-cache.mjs';
import { loadDefinition, mergePhaseOverride, resolveWorkType, STEP_DESCRIPTION_LIMIT, validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { normalizeClarificationPolicy } from './clarifications.mjs';
import { AGENT_LOCK_PATH, discoverAgents, parseAgentDependencies, parseAttachedSkills } from './agents.mjs';
import {
  SKILL_ATTACHMENTS_PATH, librarySkillPath, librarySkillText, loadSkillLibrary, normalizeSkillUse,
  parseLibrarySkill, parseSkillAttachments, readSkillAttachments, skillAttachmentsText, withoutAttachedSkills
} from './skill-library.mjs';
import { approvedConfigurationIn } from './skill-library-problems.mjs';
import { instructionPath, instructionText, parseInstruction, loadInstructionLibrary } from './instruction-library.mjs';
import { skillUses, projectSkills, projectInstructions } from './asset-catalog-projection.mjs';
import { constitutionPolicy, parseConstitution } from './constitution.mjs';
import { constitutionStudioView, renderStudioConstitution, studioConstitutions } from './studio-constitution.mjs';
import { packagedWorkflowSkills } from './packaged-workflow-skills.mjs';

function instructionCatalogHash(catalog) {
  return sha256(JSON.stringify({ entries: [...catalog.instructions].map(([id, item]) => [id, item.sha256]), problems: catalog.problems }));
}
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
import { isTemplateReference, normalizeTemplateCatalog, parseTemplateReference, templateReferences } from './template-catalog.mjs';
import { normalizeArtifactSet } from './artifact-sets.mjs';
import { normalizeApprovalSecurity } from './approval-authority.mjs';
import {
  authoringRoute, compiledSkillStep, deterministicOnlyGeneration, legacyAuthoringSkill, stepOutputKind, workflowCodeGeneration
} from './code-delivery-policy.mjs';
import { AUTHORING_SKILL_ID, authoringSkillCatalog, authoringSkillEntry } from './authoring-skills.mjs';
import { configurationReadRoot, withoutConfigurationReadScope } from './configuration-read-scope.mjs';
import { knowledgePromptPolicy } from './knowledge/render.mjs';
import { briefLeftOutByDefault, briefProfileView, phaseBriefProfile, phaseBriefRules } from './knowledge/phase-brief.mjs';
import { INITIATIVE_OUTPUT_KINDS, PORTFOLIO_PATH, loadPortfolio } from './initiative-config.mjs';
import { WORKFLOW_ARCHIVE_PATH, parseWorkflowArchive, workflowArchived } from './workflow-archive.mjs';
import { STEP_INTENT_CHOICES, STEP_OUTPUTS, newStepContract, newStepTemplate, stepIntentChoice } from './step-outputs.mjs';
import { deriveWorkTypeSettings, intentProfile, kindFitsIntent } from './step-intent-settings.mjs';
import { normalizeExternalCommand, selectedRepositoryTests, testCommandLevel } from './external-command-policy.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { SingularityFlowError, nearestNames, posix, secureRepositoryPath } from './util.mjs';
import { lineOperations, preserveYamlFormatting, renderPreservingFormatting } from './yaml-formatting.mjs';

export { preserveYamlFormatting };
import {
  HTTP_LOG_FORMATS, INTEGRATION_TARGET_KINDS, STEP_ACTION_SENDS, STEP_ACTION_TRIGGERS, normalizeIntegrations
} from './step-actions.mjs';
import { STORES, pinAuthoredStoryPlannedClaims } from './workflow-authoring.mjs';
import { isSpecificationDefinitionPhase } from './specifications.mjs';
import { changeImpactSetting } from './change-impact-setting.mjs';
import { seededWorkflowProtection, assertSeededWorkflowsUnchanged } from './seeded-workflow-protection.mjs';
import { userDefinedAgentFiles, userDefinedAgentHeader } from './user-defined-agents.mjs';
import { userDefinedAgentWorkType } from './user-defined-agent-identity.mjs';
import { STUDIO_ID } from './agent-document-parser.mjs';
// One renderer for every route that makes an agent (src/agent-file.mjs).
import { AGENT_ROLES, newAgentBody, renderAgentFile as renderAgent, splitAgentText, starterInstructions } from './agent-file.mjs';

export { AGENT_ROLES, starterInstructions };

export const STUDIO_CHANGE_SET_SCHEMA = 'sflow-studio-change-set@1';

const ID = STUDIO_ID;
const MAX_CHANGES = 200;
const MAX_DIFF_LINES = 400;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const agentsSha256 = (agents) => sha256(agents.filter((agent) => agent.scope === 'repository')
  .map((agent) => `${agent.id}:${agent.sha256}`).join('\n'));

export { STEP_OUTPUTS };

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


/** Presets are authoring suggestions, never aliases or permission to add undeclared contracts. */
export function agentRolePresets() {
  return AGENT_ROLES.map((role) => ({ ...role, tools: [...role.tools] }));
}

// ---------------------------------------------------------------------------------------------
// Reading

async function packagedDefinition() {
  const text = await readFile(path.join(PACKAGE_ROOT, 'templates', 'workflow.yml'), 'utf8');
  // Two copies: the validated one answers questions, the raw one is what gets copied, so an
  // installed blueprint reads like the packaged file rather than like its normalised form.
  return Object.assign(validateDefinition(parseYamlText(text)), { raw: parseYamlText(text) });
}

/**
 * What a step produces, by the engine's own classification. Studio once inferred code from a
 * source-and-artifact write scope, which showed verification and testing steps as code; one rule
 * now serves the model, the picker, validation and routing.
 */
function outputOf(phase = {}) {
  return stepOutputKind(phase);
}

/** Whether a step may change the repository's files beyond its own document: a code step, or one allowed to write source. */
function changesCodeOf(phase = {}) {
  return outputOf(phase) === 'code' || phase.writeScope === 'source-and-artifact';
}

/** The bytes every step's brief gets when the repository sets one (`worldModel.knowledge.maxBytes`); null otherwise. */
function briefBudget(definition) {
  return Number.isInteger(definition?.worldModel?.knowledge?.maxBytes) ? knowledgePromptPolicy(definition).maxBytes : null;
}

/**
 * The Repository brief a step gets, read by the engine's own rule from what it declares [WMR:REQ-026]: its reader,
 * budget and sections, or none in a step it is left out of by default (REQ-011) unless the work type turns it on
 * everywhere or `worldModel.knowledge.prompt` names the step.
 */
function stepBrief(definition, phase = {}, workType = null) {
  const kind = phase.requiredArtifact?.kind ?? phase.artifact?.kind ?? null;
  const task = phase.generationPolicy?.task ?? phase.generation?.task ?? null;
  const intent = definition?.phases?.[phase.id]?.intent ?? phase.intent ?? null;
  const profile = phaseBriefProfile(phase.id, { maxBytes: briefBudget(definition), kind, task, intent });
  const named = knowledgePromptPolicy(definition).steps[phase.id] ?? null;
  const included = named ? named !== 'off' : ['on', 'required'].includes(workType?.intelligence?.worldModel) || !briefLeftOutByDefault(profile);
  return briefProfileView(profile, { included });
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
 * A list a change carries, such as a step's inputs. Absent or null leaves the list
 * as it is, as for every other field of a change; anything else must be a list.
 */
function changeList(value, label, code) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new SingularityFlowError(`${label} must be a list.`, { code });
  return value;
}

const listWords = (values) => (values.length < 2 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`);
// The ways on from a step intent refusal, on the screen the person changes it in.
const INTENT_ROUTE = Object.freeze({ label: 'Choose what the step does in Workflow Studio',
  workflowStudio: 'In VS Code, open Workflow Studio, select the step and choose what it does, one of the ten offered.' });
const COPY_ROUTE = Object.freeze({ label: 'Use a copy of the step in this workflow',
  workflowStudio: 'In Workflow Studio, select the step, choose Use a copy in this workflow, then give the copy what it does.' });
const REASON_ROUTE = Object.freeze({ label: 'Say why the step differs from its intent',
  workflowStudio: 'In Workflow Studio, select the step and say why under "Why this setting", in 20 to 1000 characters.' });

/** What a step does, as a change set names it: one of the ten step intents. */
function requireStepIntent(value, name) {
  if (!STEP_INTENTS.includes(value)) {
    throw new SingularityFlowError(`What ${name} does is one of: ${STEP_INTENT_CHOICES.map((entry) => `${entry.id} (${entry.label.toLowerCase()})`).join(', ')}; not '${value}'.`,
      { code: 'STUDIO_INTENT_INVALID', details: { intents: [...STEP_INTENTS], nextAction: INTENT_ROUTE } });
  }
  return value;
}

/**
 * An output or changes-code switch a change gives with an intent follows from the intent (spec §6.5): one that says
 * the opposite is refused with the two ways to fix it, never taken over the intent.
 */
function intentAgreesWithOutput(intent, { output, changesCode }, name) {
  const code = intent === 'code';
  if (code && ((output != null && output !== 'code') || changesCode === false)) {
    throw new SingularityFlowError(`${name} changes the code (intent code), so it delivers code changes; leave out its output and changes-code settings, or give it another intent if it changes no code.`,
      { code: 'STUDIO_INTENT_CONTRADICTION', details: { intent, output: output ?? null, changesCode: changesCode ?? null, nextAction: INTENT_ROUTE } });
  }
  if (!code && output === 'code') {
    throw new SingularityFlowError(`${name} is a ${intent} step, so it does not deliver code changes; give it intent code if it changes the code, or leave out its output.`,
      { code: 'STUDIO_INTENT_CONTRADICTION', details: { intent, output, nextAction: INTENT_ROUTE } });
  }
}

/**
 * A copy given an intent of its own: the settings of its source that say it is something else go (its output kind
 * when the engine reads it as another role, a code task, changing source files), so its intent decides them. Returns
 * what went, in words.
 */
function alignStepToIntent(node, intent) {
  const gone = [];
  node.intent = intent;
  const kind = node.artifact?.kind;
  if (typeof kind === 'string' && !kindFitsIntent(kind, intent)) { delete node.artifact.kind; gone.push(`its output kind ${kind}`); }
  const generation = isObject(node.generation) ? node.generation : null;
  if (intent === 'code') {
    node.generation = { ...(generation ?? {}), task: 'code' };
    node.writeScope = 'source-and-artifact';
  } else {
    if (generation?.task === 'code') { delete generation.task; gone.push('its code task'); if (!Object.keys(generation).length) delete node.generation; }
    if (node.writeScope === 'source-and-artifact') { node.writeScope = 'artifact-only'; gone.push('changing source files'); }
  }
  return gone;
}

/** A step's `because:` as a change gives it, merged over what it has: setting → reason, null takes one away. */
function stepBecause(value, name, current = null) {
  if (!isObject(value)) throw new SingularityFlowError(`Why ${name} sets a setting itself is a map from the setting to the reason, for example { writeScope: "..." }.`, { code: 'STUDIO_BECAUSE_INVALID', details: { nextAction: REASON_ROUTE } });
  const next = isObject(current) ? { ...current } : {};
  for (const [setting, reason] of Object.entries(value)) {
    if (!BECAUSE_SETTINGS.includes(setting)) {
      throw new SingularityFlowError(`${name} cannot say why for '${setting}': it is not a setting a step's intent gives. Use one of: ${BECAUSE_SETTINGS.join(', ')}.`, { code: 'STUDIO_BECAUSE_INVALID', details: { nextAction: REASON_ROUTE } });
    }
    if (reason == null) { delete next[setting]; continue; }
    if (typeof reason !== 'string' || reason.trim().length < 20 || reason.trim().length > 1000) {
      throw new SingularityFlowError(`Why ${name} sets ${setting} itself is said in 20 to 1000 characters, in plain words.`, { code: 'STUDIO_BECAUSE_INVALID', details: { nextAction: REASON_ROUTE } });
    }
    next[setting] = reason.trim();
  }
  return next;
}

/** A drafting skill as a change set names it; the candidate configuration checks the rest. */
function requireAuthoringSkill(value) {
  if (typeof value !== 'string' || !AUTHORING_SKILL_ID.test(value)) {
    throw new SingularityFlowError(`A drafting skill is a direct skill id such as 'sf-design', not '${value}'.`, { code: 'STUDIO_AUTHORING_SKILL_INVALID' });
  }
  return value;
}

/**
 * A workflow step's "Approve automatically when ready" switch: whether it is on, and whether this workflow may turn it
 * on, with why not in a developer's words. Read from the resolved workflow; unknown when it does not resolve.
 */
/** Why a step a person turned "Approve automatically when ready" off for in Workflow Studio is approved by a person. */
const AUTOMATIC_OFF_REASON = 'A person approves this step: automatic approval was turned off for it in Workflow Studio.';
/** Why the first step of a rework loop added in Workflow Studio, which its workflow approved automatically, is approved by a person. */
const LOOP_SOURCE_REASON = 'A person approves this step: it starts a rework loop, and a person decides whether the work goes back.';
/** Why a step whose questions a person turned off in Workflow Studio asks nothing. */
const QUESTIONS_OFF_REASON = 'This step asks no questions first: they were turned off for it in Workflow Studio.';

function automaticApprovalView(phase, type, resolvedPhases) {
  const approval = phase?.approval;
  const on = Boolean(approval && typeof approval === 'object' && approval.automatic);
  if (!resolvedPhases || approval === 'none' || approval?.mode === 'none') return { on, allowed: false, why: approval === 'none' || approval?.mode === 'none' ? 'nobody approves this step' : null };
  const why = automaticApprovalRefusal(phase, { workType: type, phases: resolvedPhases })
    ?? ((approval.minimum ?? 1) > 1 ? 'it needs more than one approver'
      : (approval.requiredAuthorities ?? []).length ? 'a named group must approve it'
        : approval.allowSelfApproval === false ? 'it must be approved by someone other than its author' : null);
  return { on, allowed: !why, why };
}

function approvalSummary(approval) {
  if (approval === 'none' || approval?.mode === 'none') return { mode: 'none', authorities: [], requiredAuthorities: [], minimum: 0 };
  return {
    mode: approval?.mode ?? 'required',
    authorities: Array.isArray(approval?.authorities) ? [...approval.authorities] : [],
    requiredAuthorities: Array.isArray(approval?.requiredAuthorities) ? [...approval.requiredAuthorities] : [],
    minimum: Number.isSafeInteger(approval?.minimum) ? approval.minimum : 1
  };
}

/**
 * Whether a step, as a workflow runs it, defines requirement clauses: an explicit requirements or
 * implementation-spec artifact, the same test configuration loading applies to planned claims.
 */
function definesClauses(phase) {
  return (phase?.requiredArtifact?.kind ?? phase?.artifact?.kind) != null && isSpecificationDefinitionPhase(phase);
}

/** A workflow's planned claims: what it declares, what the engine resolved, and why not if it could not. */
function plannedClaimsView(type, resolved, failure) {
  const declared = type?.plannedClaims && typeof type.plannedClaims === 'object' ? type.plannedClaims : null;
  const claims = resolved?.plannedClaims ?? null;
  return {
    declared: declared ? {
      mode: declared.mode ?? 'required',
      clausePhases: Array.isArray(declared.clausePhases) ? [...declared.clausePhases] : null,
      owners: declared.owners && typeof declared.owners === 'object' ? { ...declared.owners } : null
    } : null,
    mode: claims?.mode ?? null,
    clausePhases: [...(claims?.clausePhases ?? [])],
    owners: { ...(claims?.owners ?? {}) },
    problem: claims ? null : (failure ?? null)
  };
}

/** Whether new Stories or Epics may still choose a workflow (docs/SPEC-WORKFLOW-RETIREMENT-v1.md). */
function archiveView(archive, governs, id) {
  const archived = workflowArchived(archive, governs, id);
  return { archived, archiveReason: archived ? archive[governs][id].reason ?? null : null };
}

/**
 * Epic (Initiative) workflows as the Studio edits them, from portfolio.yml: each workflow's steps,
 * and each step's agents, lanes, sign-off and outputs. Review chains, packs and
 * checklists are shown as counts; they stay in the file.
 */
function epicModel(portfolio, templatesRoot, archive = null) {
  if (!portfolio) return null;
  const phases = portfolio.initiativePhases ?? {};
  const profiles = portfolio.initiativeProfiles ?? {};
  const lanes = new Set();
  const stepView = (id, phase) => {
      (phase?.lanes ?? []).forEach((lane) => lanes.add(lane));
      const approval = phase?.bundleApproval ?? {};
      return {
        id, label: phase?.label ?? id, agents: [...(phase?.agents ?? [])], lanes: [...(phase?.lanes ?? [])],
        approval: {
          mode: approval.mode ?? 'bundle', authorities: [...(approval.authorities ?? [])],
          minimum: Number.isSafeInteger(approval.minimum) ? approval.minimum : (approval.mode === 'none' ? 0 : 1), chain: Array.isArray(approval.chain)
        },
        outputs: (phase?.outputs ?? []).map((output) => ({
          id: output.id, label: output.label ?? output.id, kind: output.kind ?? 'markdown', path: output.path ?? null,
          template: output.template ?? null, generator: output.generator ?? null, required: output.required !== false,
          consumes: [...(output.consumes ?? [])], ownApproval: Boolean(output.approval)
        })),
        checklist: (phase?.checklist ?? []).length,
        usedBy: Object.entries(profiles).filter(([, profile]) => (profile?.phases ?? []).includes(id)).map(([profileId]) => profileId)
      };
  };
  return {
    templatesRoot: posix(portfolio.templatesRoot ?? templatesRoot),
    workflows: Object.entries(profiles).map(([id, profile]) => ({
      id, label: profile?.label ?? id, description: profile?.description ?? '', ...archiveView(archive, 'initiative', id),
      lifecycleMode: profile?.lifecycleMode ?? (usesEpicPlanningLifecycle({ phases: (profile?.phases ?? []).map((phaseId) => phases[phaseId]) }) ? 'planning-only' : 'full-delivery'),
      phases: [...(profile?.phases ?? [])], packs: (profile?.packs ?? []).length,
      localSteps: Object.fromEntries(Object.entries(profile?.phaseOverrides ?? {}).map(([phaseId, override]) => [phaseId, stepView(phaseId, {
        ...phases[phaseId], ...override,
        outputs: (phases[phaseId]?.outputs ?? []).map((output) => ({ ...output, ...override.outputs?.[output.id],
          template: profile.templateOverrides?.[`${phaseId}/${output.id}`] ?? override.outputs?.[output.id]?.template ?? output.template }))
      })]))
    })),
    steps: Object.entries(phases).map(([id, phase]) => stepView(id, phase)),
    groups: Object.entries(portfolio.approvalAuthorities ?? {}).map(([id, group]) => ({ id, label: group?.label ?? id })),
    lanes: [...lanes].sort(),
    outputKinds: [...INITIATIVE_OUTPUT_KINDS]
  };
}

/** The groups a sign-off change names: `groups` when it lists several, else its one `group`. */
function approvalGroups(approval) {
  return Array.isArray(approval?.groups) && approval.groups.length ? approval.groups : [approval?.group];
}

const inputPhase = (input) => (typeof input === 'string' ? input : input?.phase);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function inputIds(inputs) {
  return (Array.isArray(inputs) ? inputs : []).map(inputPhase).filter(Boolean);
}

/** The step IDs a step may read without: its input entries marked optional. */
function optionalInputIds(inputs) {
  return (Array.isArray(inputs) ? inputs : []).filter((entry) => isObject(entry) && entry.optional === true).map(inputPhase).filter(Boolean);
}

const TEMPLATE_CONTENT_LIMIT = 64 * 1024;
const TEMPLATE_WRITE_LIMIT = 256 * 1024;
const TEMPLATE_FILE_LIMIT = 400;
const PACKAGED_TEMPLATES = path.join(PACKAGE_ROOT, 'templates', 'artifacts');

/** A template the Studio may write: a relative .md path inside the templates folder, with no '..'. */
function safeTemplatePath(value) {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/.test(text) && !text.split('/').includes('..') ? text : null;
}

/** The file a step writes, as the Studio names it: a .md file name with no folders. */
const ARTIFACT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

async function markdownFiles(directory) {
  const found = [];
  async function walk(relative, depth) {
    if (found.length >= TEMPLATE_FILE_LIMIT || depth > 6) return;
    let entries;
    try { entries = await readdir(path.join(directory, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (found.length >= TEMPLATE_FILE_LIMIT) return;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(child);
    }
  }
  await walk('', 0);
  return found;
}

/** A template's text for the page, or null with tooLarge when it is past what the page edits. */
async function boundedTemplateText(file) {
  try {
    if ((await stat(file)).size > TEMPLATE_CONTENT_LIMIT) return { content: null, tooLarge: true };
    return { content: await readFile(file, 'utf8'), tooLarge: false };
  } catch { return { content: null, tooLarge: false }; }
}

/**
 * The templates the Studio shows: every template file in the repository, and each packaged
 * template a step or workflow uses that the repository does not carry, with its catalog entry and
 * the steps and workflows that use it.
 */
async function studioTemplates(configRoot, raw, definition) {
  const templatesRoot = posix(raw.templatesRoot ?? definition?.templatesRoot ?? 'singularity/templates');
  let catalog = {};
  try { catalog = normalizeTemplateCatalog(raw.templates ?? {}); } catch { catalog = {}; }
  const references = { phases: raw.phases ?? {}, workTypes: raw.workTypes ?? {}, templates: catalog };
  const repository = await markdownFiles(path.join(configRoot, templatesRoot));
  const named = [
    ...Object.values(raw.phases ?? {}).map((phase) => phase?.defaultTemplate),
    ...Object.values(raw.workTypes ?? {}).flatMap((type) => Object.values(type?.templateOverrides ?? {}))
  ].filter((value) => typeof value === 'string' && !value.startsWith('agent:'))
    .map((value) => (isTemplateReference(value) ? catalog[parseTemplateReference(value)]?.path : value)).filter(Boolean);
  const packaged = [...new Set(named)].filter((relative) => !repository.includes(relative) && existsSync(path.join(PACKAGED_TEMPLATES, relative)));
  const view = async (relative, scope) => {
    const entry = Object.entries(catalog).find(([, value]) => value.path === relative);
    const file = scope === 'repository' ? path.join(configRoot, templatesRoot, relative) : path.join(PACKAGED_TEMPLATES, relative);
    return {
      path: relative, scope, catalogId: entry?.[0] ?? null, label: entry?.[1]?.label ?? null,
      ...(await boundedTemplateText(file)), usedBy: templateReferences(references, relative)
    };
  };
  return [
    ...(await Promise.all(repository.map((relative) => view(relative, 'repository')))),
    ...(await Promise.all(packaged.map((relative) => view(relative, 'packaged'))))
  ];
}

/** Whether people can actually sign off with this group, in the terms the Studio shows. */
function groupStatus(group, security) {
  if ((group.members ?? []).length) return 'people';
  if (group.allowAnyGitIdentity ?? security.allowAnyGitIdentity) return 'anyone';
  if ((group.githubTeams ?? []).length) return 'teams';
  return security.autoEnrollNewIdentities ? 'auto' : 'blocked';
}

/**
 * The skills an agent uses, each with the steps it applies in, when to use it, and where it is
 * attached: `agent` (the agent's own table) or `attachments` (the attachments file).
 */

/** The skills the agent drafting a step uses in it. */
function stepSkills(agent, phaseId) {
  return agent ? skillUses(agent).filter((entry) => !entry.phases.length || entry.phases.includes(phaseId))
    .map(({ id, use, origin }) => ({ id, use, origin })) : [];
}

function agentView(agent) {
  return {
    id: agent.id, label: agent.label ?? agent.id, description: agent.description ?? '',
    scope: agent.scope, phases: [...(agent.phases ?? [])], defaultFor: [...(agent.defaultFor ?? [])],
    tools: [...(agent.tools ?? [])],
    path: agent.scope === 'repository' ? agent.source : null,
    // The skill master edits the Attached skills table, so the instructions shown leave it out.
    instructions: withoutAttachedSkills(agent.prompt ?? '').trim(),
    // What "start from this agent" copies into a new agent's instructions.
    starter: starterInstructions(agent.prompt ?? ''),
    // Retain the complete saved body for the read-only prompt viewer when the table was removed.
    ...((agent.prompt ?? '').trim() !== withoutAttachedSkills(agent.prompt ?? '').trim()
      ? { prompt: (agent.prompt ?? '').trim() } : {}),
    skills: skillUses(agent),
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
  const raw = parseYamlText(definitionText) ?? {};
  const portfolioText = await readFile(path.join(configRoot, PORTFOLIO_PATH), 'utf8').catch(() => null);
  const problems = [];
  let definition = null;
  try { definition = await loadDefinition(root); }
  catch (error) { problems.push({ code: error?.code ?? 'CONFIGURATION_INVALID', message: error.message }); }
  const current = structuredClone(raw);
  const discovered = (await discoverAgents(root)).filter((agent) => agent.scope !== 'plugin');
  const library = await loadSkillLibrary(configRoot);
  const instructionLibrary = await loadInstructionLibrary(configRoot);
  const attachmentsText = await readFile(path.join(configRoot, SKILL_ATTACHMENTS_PATH), 'utf8').catch(() => null);
  const workflowAttachments = (await readSkillAttachments(configRoot)).filter((entry) => entry.workflow);
  // Archived workflows stay editable here; only new Stories and Epics stop being offered them.
  const archiveText = await readFile(path.join(configRoot, WORKFLOW_ARCHIVE_PATH), 'utf8').catch(() => null);
  let archive = null;
  try { archive = archiveText == null ? null : parseWorkflowArchive(archiveText); }
  catch (error) { problems.push({ code: error?.code ?? 'WORKFLOW_ARCHIVE_INVALID', message: error.message }); }
  const security = normalizeApprovalSecurity(raw.approvalSecurity ?? {});
  const starter = await packagedDefinition();
  const bundled = await bundledAgents();
  const workTypes = raw.workTypes ?? {};
  const constitutions = await studioConstitutions(configRoot, raw);
  const protection = await seededWorkflowProtection(raw, portfolioText ? parseYamlText(portfolioText) : {}, discovered);
  const phases = raw.phases ?? {};
  const defaultAgentOf = (phaseId) => discovered.find((agent) => agent.defaultFor.includes(phaseId))?.id ?? null;
  const usedBy = (phaseId) => Object.entries(workTypes).filter(([, type]) => (type.phases ?? []).includes(phaseId)).map(([id]) => id);
  // A step set to `repositoryTests: run` runs the repository's own tests when it is submitted, as
  // verification-repository-tests decides: not for a code step (it runs its tests already), one that
  // names its own test command, or one that reviews a code step's test receipt.
  const asksForRepositoryTests = [...Object.values(phases), ...Object.values(workTypes).flatMap((type) => Object.values(type.phaseOverrides ?? {}))]
    .some((phase) => phase?.repositoryTests === 'run');
  const { isTestQualityCommand } = asksForRepositoryTests ? await import('./delivery-evidence.mjs') : {};
  // A step's checks as written: resolution adds the repository's tests to a step that runs tests, and
  // those are the repository's, not the step's [RTC:REQ-002].
  const writtenStep = (type, phaseId) => {
    const override = type.phaseOverrides?.[phaseId] ?? {};
    const step = phases[phaseId] ?? {};
    return { qualityCommands: Object.hasOwn(override, 'qualityCommands') ? override.qualityCommands ?? [] : step.qualityCommands ?? [],
      testLevels: override.testLevels ?? step.testLevels, testIds: override.testIds ?? step.testIds };
  };
  const runsRepositoryTests = (phase, written) => phase.repositoryTests === 'run' && outputOf(phase) !== 'code' && !phase.testEvidenceFrom
    && !(written.qualityCommands ?? []).some(isTestQualityCommand);
  // The repository's own test commands, which every step that runs tests uses unless it has its own [RTC:REQ-009].
  const repositoryTests = Array.isArray(raw.tests) ? raw.tests.filter((command) => command && typeof command === 'object') : [];
  const testsFrom = (phase, written) => {
    if (outputOf(phase) !== 'code' && (phase.repositoryTests !== 'run' || phase.testEvidenceFrom)) return null;
    const own = (written.qualityCommands ?? []).filter((command) => command && typeof command === 'object' && command.kind === 'test');
    if (own.length) return { source: 'step', ids: own.map((command) => String(command.id)) };
    if (!repositoryTests.length) return { source: 'inferred' };
    return { source: 'repository', ...(written.testLevels ? { levels: [...written.testLevels] } : {}), ...(written.testIds ? { ids: [...written.testIds] } : {}),
      runs: selectedRepositoryTests(written, repositoryTests).map((command) => String(command.id)) };
  };

  const workflows = Object.entries(workTypes).map(([id, type]) => {
    let resolved = null;
    let failure = null;
    try { resolved = definition ? resolveWorkType(definition, id) : null; } catch (error) { resolved = null; failure = error?.message ?? null; }
    const packaged = starter.workTypes[id];
    return {
      skills: workflowAttachments.filter((entry) => entry.workflow === id).map(({ id: skillId, phases, use }) => ({ id: skillId, phases: [...phases], use })),
      id, label: type.label ?? id, description: type.description ?? '', phases: [...(type.phases ?? [])], readOnly: protection.workflows.includes(id),
      ...archiveView(archive, 'story', id),
      worldModel: type.intelligence?.worldModel ?? 'inherit',
      // Its change impact and where it comes from: on by default, applied in code, never written for it (owner, 2026-11-15).
      changeImpact: changeImpactSetting(raw.spec, type.spec),
      status: !packaged ? 'local' : JSON.stringify(packaged) === JSON.stringify(definition?.workTypes?.[id] ?? type) ? 'packaged' : 'customized',
      generatesCode: resolved ? Boolean(workflowCodeGeneration(resolved).generatesCode) : (type.phases ?? []).some((phase) => outputOf(phases[phase]) === 'code'),
      // A person's own agent folder run as one step (`call add`); present only then.
      ...(definition && userDefinedAgentWorkType(definition, id) ? { userDefinedAgent: true } : {}),
      // Kept whole: a send-back rule's reset phase is part of its repair budget, and a decision is
      // edited in the shape it is written in.
      reworkLoops: (type.reworkLoops ?? []).map((loop) => ({
        from: loop.from, to: loop.to, maxAttempts: loop.maxAttempts,
        ...(loop.resetOnPhase ? { resetOnPhase: loop.resetOnPhase } : {})
      })),
      decisions: structuredClone(type.decisions ?? []),
      // What the workflow says it leaves out, each with its reason and the group that records it.
      omits: structuredClone(type.omits ?? []),
      plannedClaims: plannedClaimsView(type, resolved, failure),
      steps: (resolved?.phases ?? (type.phases ?? []).map((phaseId) => ({ id: phaseId, ...phases[phaseId] }))).map((phase) => {
        const route = authoringRoute(phase);
        const written = writtenStep(type, phase.id);
        const tests = testsFrom(phase, written);
        return {
          id: phase.id, label: phase.label ?? phase.id, output: outputOf(phase), changesCode: changesCodeOf(phase),
          // What the step says it is for (step intents), read from the step itself, or null.
          intent: STEP_INTENTS.includes(phases[phase.id]?.intent) ? phases[phase.id].intent : null,
          // Resolution leaves the description out of Story pins, so it is read from the step itself.
          description: typeof phases[phase.id]?.description === 'string' ? phases[phase.id].description : '',
          agent: phase.defaultAgent ?? defaultAgentOf(phase.id),
          approval: approvalSummary(phase.approval), inputs: inputIds(phase.inputs),
          // Approve twice: whether SFlow approves it when it is ready, and whether this workflow may let it.
          automaticApproval: automaticApprovalView(phase, type, resolved?.phases ?? null),
          // Where an approver may send rejected work back to, as this workflow runs the step.
          sendBackTo: approvalSummary(phase.approval).mode === 'none' ? [] : [...(phase.approval?.rejectTo ?? [phase.id])],
          optionalInputs: optionalInputIds(phase.inputs),
          // This workflow's own template for the step, when it sets one over the step's.
          template: typeof type.templateOverrides?.[phase.id] === 'string' ? type.templateOverrides[phase.id] : null,
          clarification: phase.clarification?.mode ?? 'off',
          // The Repository brief this step gets: its reader, budget and sections, as a Story would compose it [WMR:REQ-026].
          brief: stepBrief(definition ?? raw, phase, type),
          overridden: Boolean(type.phaseOverrides?.[phase.id]),
          definesClauses: definesClauses(phase),
          authoringSkill: route.authoringSkill,
          authoringSkillSetByWorkflow: Boolean(type.phaseOverrides?.[phase.id] && Object.hasOwn(type.phaseOverrides[phase.id], 'authoringSkill')),
          effectiveAuthoringSkill: route.effectiveAuthoringSkill,
          authoringSkillSource: route.authoringSkillSource,
          afterStep: (phase.afterStep ?? []).map((action) => ({ id: action.id, on: [...(action.on ?? [])], target: action.target, send: action.send ?? 'event', ...(action.required === true ? { required: true } : {}) })),
          skills: [...stepSkills(discovered.find((agent) => agent.id === (phase.defaultAgent ?? defaultAgentOf(phase.id))), phase.id)
            .map((entry) => ({ ...entry, scope: 'agent' })),
          ...workflowAttachments.filter((entry) => entry.workflow === id && (!entry.phases.length || entry.phases.includes(phase.id)))
            .map(({ id: skillId, use }) => ({ id: skillId, use, origin: 'attachments', scope: 'workflow' }))],
          afterStepSetByWorkflow: Boolean(type.phaseOverrides?.[phase.id] && Object.hasOwn(type.phaseOverrides[phase.id], 'afterStep')),
          // The checks sflow runs when the step is submitted, as written (a change adds to them).
          qualityCommands: structuredClone(written.qualityCommands),
          ...(asksForRepositoryTests && runsRepositoryTests(phase, written) ? { runsRepositoryTests: true } : {}),
          // Where its tests come from: this step's own, the repository's (all, or the levels or IDs it names), or found.
          ...(tests ? { testsFrom: tests } : {}),
          // Steps the engine generates, and compiled skill steps, cannot choose a drafting skill.
          generatedByEngine: isConvergencePhase(phase) || deterministicOnlyGeneration(phase),
          convergence: isConvergencePhase(phase),
          compiledSkill: compiledSkillStep(phase)
        };
      })
    };
  });

  return {
    schemaVersion: 1,
    resultType: 'workflow-studio',
    // What a new workflow here gets.
    changeImpact: changeImpactSetting(raw.spec),
    authority: authority ? {
      kind: authority.kind ?? 'working-tree', ref: authority.ref ?? null, commit: authority.commit ?? null,
      remoteFingerprint: authority.remoteFingerprint ?? null, sourceCommit: authority.sourceCommit ?? null
    } : { kind: 'working-tree', ref: null, commit: null, remoteFingerprint: null, sourceCommit: null },
    base: {
      workflowSha256: sha256(definitionText),
      agentsSha256: agentsSha256(discovered),
      attachmentsSha256: sha256(attachmentsText ?? ''),
      instructionsSha256: instructionCatalogHash(instructionLibrary),
      constitutionsSha256: constitutions.sha256,
      ...(portfolioText != null ? { portfolioSha256: sha256(portfolioText) } : {}),
      // Only when the file exists, so a saved draft's base stays the same in a repository without one.
      ...(archiveText != null ? { archiveSha256: sha256(archiveText) } : {})
    },
    problems,
    protection,
    workflows,
    // The repository's test commands, listed with their level and folders [RTC:REQ-009].
    tests: repositoryTests.map((command) => ({
      id: String(command.id), level: testCommandLevel(command), workingDirectory: command.workingDirectory ?? '.',
      affectedRoots: Array.isArray(command.affectedRoots) ? [...command.affectedRoots] : [],
      ...(command.environment ? { environment: command.environment } : {}),
      ...(command.env && typeof command.env === 'object' ? { env: Object.keys(command.env).sort() } : {})
    })),
    constitutions: constitutionStudioView(constitutions, definition ?? raw, protection.workflows),
    epics: epicModel(portfolioText == null ? null : parseYamlText(portfolioText) ?? {}, posix(raw.templatesRoot ?? definition?.templatesRoot ?? 'singularity/templates'), archive),
    integrations: {
      targets: Object.entries(raw.integrations?.targets ?? {}).map(([id, target]) => ({ id, ...structuredClone(target) }))
    },
    phases: Object.entries(phases).map(([id, phase]) => ({
      id, label: phase.label ?? id, output: outputOf(phase), changesCode: changesCodeOf(phase),
      // What the step says it is for (step intents), or null, and what its structure says (the Builder checks intents against it).
      intent: STEP_INTENTS.includes(phase.intent) ? phase.intent : null,
      kind: typeof phase.artifact?.kind === 'string' ? phase.artifact.kind : null,
      task: isObject(phase.generation) && typeof phase.generation.task === 'string' ? phase.generation.task : null,
      ...(typeof phase.testEvidenceFrom === 'string' ? { testEvidenceFrom: phase.testEvidenceFrom } : {}),
      ...(phase.repositoryTests === 'run' ? { repositoryTests: 'run' } : {}),
      description: typeof phase.description === 'string' ? phase.description : '',
      approval: approvalSummary(phase.approval), inputs: inputIds(phase.inputs),
      authoringSkill: typeof phase.authoringSkill === 'string' ? phase.authoringSkill : null,
      afterStep: (Array.isArray(phase.afterStep) ? phase.afterStep : []).map((action) => ({ id: action?.id, on: [...(action?.on ?? [])], target: action?.target, send: action?.send ?? 'event', ...(action?.required === true ? { required: true } : {}) })),
      generatedByEngine: isConvergencePhase(phase) || deterministicOnlyGeneration(phase),
      convergence: isConvergencePhase(phase),
      compiledSkill: compiledSkillStep(phase),
      clarification: phase.clarification?.mode ?? 'off',
      brief: stepBrief(definition ?? raw, { id, ...phase }),
      template: phase.defaultTemplate ?? null, artifact: phase.artifact?.path ?? null,
      artifactSet: typeof phase.artifactSet === 'string' ? phase.artifactSet : null,
      // Whether the step writes requirement clauses: a code step needs one before it (planned claims).
      definesClauses: definesClauses(phase),
      optionalInputs: optionalInputIds(phase.inputs),
      usedBy: usedBy(id), agent: defaultAgentOf(id),
      eligibleAgents: discovered.filter((agent) => !agent.phases.length || agent.phases.includes(id)).map((agent) => agent.id)
    })),
    agents: discovered.map(agentView),
    templatesRoot: posix(raw.templatesRoot ?? definition?.templatesRoot ?? 'singularity/templates'),
    templates: await studioTemplates(configRoot, raw, definition),
    artifactSets: Object.entries(raw.artifactSets ?? {}).map(([id, set]) => ({
      id, primary: String(set?.primary ?? ''),
      members: (Array.isArray(set?.members) ? set.members : []).map((member) => ({
        path: String(member?.path ?? ''), role: String(member?.role ?? ''), required: member?.required === true, authority: member?.authority ?? 'governed'
      })),
      usedBy: Object.entries(phases).filter(([, phase]) => phase?.artifactSet === id).map(([phaseId]) => phaseId)
    })),
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
    skills: projectSkills(library, discovered, workflowAttachments),
    skillProblems: library.problems,
    instructions: projectInstructions(library, instructionLibrary),
    instructionProblems: instructionLibrary.problems,
    skillAttachmentsPath: SKILL_ATTACHMENTS_PATH,
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
      // "What does this step do?": the ten step intents, in the words Studio asks with.
      intents: STEP_INTENT_CHOICES,
      authoringSkills: await authoringSkillChoices(),
      clarification: CLARIFICATION_MODES,
      // The brief each step gets is the engine's own profile (phaseBriefProfile) [WMR:REQ-026]: `maxBytes` is null unless
      // the repository sets one for every step, and the rules let the page profile a step it has not saved yet.
      knowledge: { prompt: knowledgePromptPolicy(definition ?? current).prompt, steps: knowledgePromptPolicy(definition ?? current).steps,
        maxBytes: briefBudget(definition ?? current), rules: phaseBriefRules() },
      tools: [...new Set([...Object.keys(TOOL_LABELS), ...discovered.flatMap((agent) => agent.tools ?? [])])]
        .map((id) => ({ id, label: TOOL_LABELS[id] ?? id })),
      roles: agentRolePresets(definition ?? current),
      integrationKinds: Object.entries(INTEGRATION_TARGET_KINDS).map(([id, entry]) => ({ id, label: entry.label, available: entry.available, sends: [...entry.sends] })),
      httpLogFormats: [...HTTP_LOG_FORMATS],
      actionTriggers: [...STEP_ACTION_TRIGGERS],
      actionSends: [...STEP_ACTION_SENDS]
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Agent files

/** Whether a Studio agent entry is the user-defined agent `name` (its metadata names its folder). */
function userDefinedAgentText(entry, name) {
  return new RegExp(`^ {2}sflow-user-defined: ${name}$`, 'mu').test(entry?.text ?? '');
}

// ---------------------------------------------------------------------------------------------
// Diffs

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
  'marketplace.add': 0, 'marketplace.remove': 0, 'integration.target.create': 0, 'integration.target.update': 0.5, 'group.create': 0, 'group.update': 1, 'agent.create': 2, 'import.agent': 2.5, 'userAgent.add': 2.6, 'userAgent.update': 2.6, 'workflow.install': 3,
  'import.template': 3.5, 'template.create': 3.6, 'template.update': 3.6, 'artifactSet.create': 3.7, 'artifactSet.update': 3.7,
  'phase.create': 4, 'workflow.create': 4.5, 'phase.update': 5, 'workflow.update': 7, 'workflow.intents': 7.1, 'artifactSet.remove': 11.6,
  'epicStep.create': 4.2, 'epicWorkflow.create': 4.7, 'epicStep.update': 5.2, 'epicOutput.set': 5.3, 'epicOutput.remove': 5.4, 'epicWorkflow.update': 7.2,
  'skill.create': 2.2, 'import.librarySkill': 2.3, 'skill.update': 2.4, 'skill.restore': 2.4,
  'instruction.create': 2.05, 'instruction.update': 2.1, 'instruction.remove': 11.2, 'presence.set': 0,
  // Last, so an agent another change touched is stamped beside that change, never over it.
  'agent.stamp': 12,
  'constitution.policy': 7.4, 'constitution.set': 7.5,
  'phase.agent': 8, 'agent.update': 9, 'skill.attach': 9.5, 'skill.detach': 9.5,
  'import.skill': 10, 'import.generated': 10, 'import.mcpServer': 10.5, 'import.remove': 11, 'skill.remove': 11.1,
  'integration.target.remove': 11.5, 'agent.remove': 11.05
});

/** A step's after-step actions as the page sends them: the written shape, checked for form only. */
function studioActions(value, name) {
  if (!Array.isArray(value)) throw new SingularityFlowError(`The actions after ${name} must be a list.`, { code: 'STUDIO_ACTIONS_INVALID' });
  return value.map((action, index) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)
        || Object.keys(action).some((key) => !['id', 'on', 'target', 'send', 'required'].includes(key))) {
      throw new SingularityFlowError(`Action ${index + 1} after ${name} must have only id, on, target, send and required.`, { code: 'STUDIO_ACTIONS_INVALID' });
    }
    // Defaults are not written: send event and required false are what an action means without them.
    // Any other required value is written as sent, so the engine's own check refuses it.
    return {
      id: action.id, on: Array.isArray(action.on) ? [...action.on] : action.on, target: action.target,
      ...(action.send && action.send !== 'event' ? { send: action.send } : {}),
      ...(action.required !== undefined && action.required !== false ? { required: action.required } : {})
    };
  });
}

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

/** What a step is for, in the person's words: one paragraph, or null to take it away. */
function stepDescription(value, name) {
  if (value === null) return null;
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length > STEP_DESCRIPTION_LIMIT) throw new SingularityFlowError(`The description of ${name} is longer than ${STEP_DESCRIPTION_LIMIT} characters.`, { code: 'STUDIO_DESCRIPTION_INVALID' });
  return text || null;
}

class StudioCandidate {
  constructor(sources, finalPhases = null) {
    this.sources = sources;
    // New agent files go in the root this configuration records [AGH:REQ-022].
    this.agentsRoot = agentsRootOf(sources.raw ?? {});
    // The steps each workflow lists once the whole change set is applied (finalWorkflowPhases).
    this.finalPhases = finalPhases;
    this.document = YAML.parseDocument(sources.definitionText);
    // Epic workflows live in portfolio.yml; changed only by the epic* operations.
    this.portfolioDocument = sources.portfolioText != null ? YAML.parseDocument(sources.portfolioText) : null;
    this.portfolioChanged = false;
    this.pendingEpicSteps = new Set();
    this.agents = new Map(sources.agents.map((agent) => [agent.id, {
      id: agent.id, scope: agent.scope, text: agent.text, relative: agent.scope === 'repository' ? agent.source : null,
      fileName: path.basename(agent.file ?? `${agent.id}.agent.md`),
      label: agent.label ?? agent.id, description: agent.description ?? '', tools: [...(agent.tools ?? [])],
      phases: [...(agent.phases ?? [])], defaultFor: [...(agent.defaultFor ?? [])],
      body: null, touched: false, created: false,
      // An agent APM deployed keeps its file; only the steps it drafts change, in workflow.yml `apm`.
      apm: agent.apm ?? null, yielded: [...(agent.apmYielded ?? [])],
      ...(agent.apm ? { authored: JSON.stringify([agent.label ?? agent.id, agent.description ?? '', agent.tools ?? []]) } : {})
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
    // The skill master: skills by ID, and the SKILL.md files this change set writes (null removes one).
    this.skills = new Map(sources.library?.skills ?? []);
    this.skillFiles = new Map();
    this.instructions = new Map(sources.instructions?.instructions ?? []);
    this.instructionFiles = new Map();
    this.constitutionChanges = new Map();
    this.constitutionPolicies = new Set();
    // SF Guard's policy chain, replaced whole by one signed extension (`presence.set`).
    this.presenceChange = null;
    // Skills attached in the attachments file, and the agents a framework workflow keeps read-only:
    // a skill attaches to those there, so the agent and its workflow stay as they shipped.
    this.attachments = [...(sources.attachments ?? [])];
    this.attachmentsChanged = false;
    this.protectedAgents = new Set(sources.protectedAgents ?? []);
    // Skills changed by this change set, by the index of their summary line (see finalize).
    this.updatedSkills = new Map();
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
      if (change?.op === 'epicStep.create' && typeof change.id === 'string') this.pendingEpicSteps.add(change.id);
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
    if (agent.apm) {
      this.apmAgentsChanged = true;
      agent.apmChanged = true;
      return agent;
    }
    // A bundled agent becomes a repository copy the moment it is changed: repository agents win
    // discovery by ID, so the copy replaces it everywhere, and the change lands in this repository.
    agent.touched = true;
    if (!agent.relative) agent.relative = posix(path.join(this.agentsRoot, agent.fileName));
    return agent;
  }

  /**
   * The steps APM-deployed agents draft, written to workflow.yml `apm.agents` [APM A3]. Anything
   * else changed on such an agent is refused: its file is APM's, changed in its package.
   */
  syncApmAgents(phaseIds, problems) {
    for (const agent of this.agents.values()) {
      // Only an APM agent changed here is written: a binding waiting for its agent is kept as it is.
      if (!agent.apm || !agent.apmChanged) continue;
      if (agent.body != null || agent.authored !== JSON.stringify([agent.label, agent.description, agent.tools])) {
        problems.push({ code: 'STUDIO_AGENT_APM_OWNED', subject: { kind: 'agent', id: agent.id },
          message: `${agent.label} was installed by APM (${agent.apm.package}); change it in its package and install it again. Here you choose only which steps it drafts.` });
        continue;
      }
      if (agent.phases.length) agent.phases = agent.phases.filter((phase) => phaseIds.has(phase));
      agent.defaultFor = agent.defaultFor.filter((phase) => phaseIds.has(phase));
      if (agent.phases.length) for (const phase of agent.defaultFor) if (!agent.phases.includes(phase)) agent.phases.push(phase);
      if (!agent.phases.length && !agent.defaultFor.length) {
        if (this.document.hasIn(['apm', 'agents', agent.id])) this.document.deleteIn(['apm', 'agents', agent.id]);
        continue;
      }
      if (agent.apm.state !== 'intact') {
        problems.push({ code: 'STUDIO_AGENT_APM_NOT_INTACT', subject: { kind: 'agent', id: agent.id },
          message: `${agent.label}'s file (${agent.apm.path}) is not the one apm install wrote; run apm install, then choose its steps.` });
        continue;
      }
      this.document.setIn(['apm', 'agents', agent.id], this.document.createNode({
        ...(agent.phases.length ? { steps: [...agent.phases] } : {}), defaultFor: [...agent.defaultFor]
      }));
    }
    const remaining = this.document.getIn(['apm', 'agents']);
    if (remaining != null && !Object.keys(remaining.toJSON?.() ?? {}).length) this.document.deleteIn(['apm']);
  }

  setDefaultAgent(phaseId, agentId) {
    const target = this.requireAgent(agentId);
    const previous = [...this.agents.values()].filter((agent) => agent.defaultFor.includes(phaseId));
    if (previous.length === 1 && previous[0].id === agentId) return null;
    for (const agent of previous) {
      if (agent.id === agentId) continue;
      if (target.apm && !agent.apm) {
        // It yields the step while the APM agent can be used; its file keeps the step [APM].
        agent.defaultFor = agent.defaultFor.filter((phase) => phase !== phaseId);
        agent.yielded = [...new Set([...(agent.yielded ?? []), phaseId])];
        continue;
      }
      this.touch(agent).defaultFor = agent.defaultFor.filter((phase) => phase !== phaseId);
    }
    if (!target.apm) {
      // The step leaves APM: an agent that only yielded it takes it back or gives it up for good.
      for (const agent of this.agents.values()) {
        if (!agent.yielded?.includes(phaseId)) continue;
        agent.yielded = agent.yielded.filter((phase) => phase !== phaseId);
        if (agent.id !== agentId) this.touch(agent);
      }
    }
    this.touch(target);
    if (!target.defaultFor.includes(phaseId)) target.defaultFor = [...target.defaultFor, phaseId];
    // An agent made here is eligible for exactly the steps it drafts; an existing one keeps its own list.
    if ((target.created || target.phases.length) && !target.phases.includes(phaseId)) target.phases = [...target.phases, phaseId];
    return previous.find((agent) => agent.id !== agentId)?.id ?? null;
  }

  /**
   * A sign-off as written: every group the change names, how many approvals it needs, and the groups
   * that must each approve. A group taken off the step is taken off the groups that must approve too;
   * every other setting the step's approval has (send-back targets, self-approval) stays, unless the
   * change names its send-back targets (`rejectTo`): then those replace the step's, each checked
   * against every workflow in `reaches` (see sendBackTargets).
   */
  approvalNode(approval, existing = null, { phaseId = null, name = null, reaches = [] } = {}) {
    if (approval == null) return undefined;
    if (approval === 'none') return 'none';
    const listed = approvalGroups(approval);
    if (!Array.isArray(listed) || !listed.length || listed.length > 10) {
      throw new SingularityFlowError('A step is signed off by 1 to 10 approval groups.', { code: 'STUDIO_APPROVAL_INVALID' });
    }
    const groups = [...new Set(listed.map((id) => this.requireGroup(requireId(id, 'An approval group'))))];
    const minimum = approval.minimum == null ? 1 : Number(approval.minimum);
    if (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > 20) {
      throw new SingularityFlowError('Approvals needed must be a whole number from 1 to 20.', { code: 'STUDIO_APPROVAL_INVALID' });
    }
    const base = existing && typeof existing === 'object' ? { ...existing } : {};
    const wanted = Array.isArray(approval.required) ? approval.required : (Array.isArray(base.requiredAuthorities) ? base.requiredAuthorities : []);
    const required = [...new Set(wanted)].filter((id) => groups.includes(id));
    if (minimum < required.length) {
      throw new SingularityFlowError(`Approvals needed must be at least ${required.length}, one for each group that must approve.`, { code: 'STUDIO_APPROVAL_INVALID' });
    }
    const node = { ...base, authorities: groups, minimum };
    if (required.length) node.requiredAuthorities = required; else delete node.requiredAuthorities;
    // Approve twice (owner, 2026-11-19): "Approve automatically when ready", on or off; configuration refuses it where
    // a person must approve (phase-roles.mjs), and the page offers it only where it may be on.
    if (approval.automatic === true) node.automatic = 'when-ready';
    else if (approval.automatic === false) {
      // In a version 4 file a step's intent may let SFlow approve it when the workflow says nothing, so "off" is
      // written there (the derivation reads it as a person's approval); elsewhere absent already says it.
      const intents = Number.isSafeInteger(this.content?.version) && this.content.version >= INTENTS_FILE_VERSION
        && phaseId && typeof this.phase(phaseId)?.intent === 'string';
      if (intents) node.automatic = 'off'; else delete node.automatic;
    }
    if (approval.rejectTo != null) node.rejectTo = this.sendBackTargets(approval.rejectTo, phaseId, reaches, name ?? this.phaseLabel(phaseId));
    return node;
  }

  /**
   * "Approve automatically when ready" turned off where the step's intent would let SFlow approve it writes
   * `automatic: off`, a setting that differs from the intent, so it says why: the person turned it off here (spec §7.3).
   * Turned on again, that reason goes with it; a reason the person wrote stays.
   */
  automaticOffReason(scope, signOff) {
    const at = [...scope, 'because', 'approval.automatic'];
    if (signOff && typeof signOff === 'object' && signOff.automatic === 'off') {
      if (!this.document.hasIn(at)) this.document.setIn(at, AUTOMATIC_OFF_REASON);
    } else this.dropStudioReason(scope, 'approval.automatic', AUTOMATIC_OFF_REASON);
  }

  /** A rework loop's first step, approved automatically in this workflow: its people approve it from now on. */
  loopSourceToPeople(workflowId, phaseId) {
    const scope = ['workTypes', workflowId, 'phaseOverrides', phaseId];
    const override = this.content.workTypes?.[workflowId]?.phaseOverrides?.[phaseId];
    const own = isObject(override?.approval) ? override.approval.automatic : undefined;
    const shared = isObject(this.phase(phaseId)?.approval) ? this.phase(phaseId).approval.automatic : undefined;
    if ((own ?? shared) !== 'when-ready') return;
    if (this.intentsDecide(phaseId)) {
      this.document.setIn([...scope, 'approval', 'automatic'], 'off');
      if (!this.document.hasIn([...scope, 'because', 'approval.automatic'])) this.document.setIn([...scope, 'because', 'approval.automatic'], LOOP_SOURCE_REASON);
    } else if (own === 'when-ready') this.document.deleteIn([...scope, 'approval', 'automatic']);
    else return;
    this.summary.push(`${this.phaseLabel(phaseId)}: a person approves it now, as the first step of a rework loop.`);
  }

  /** Whether a step's intent decides what it leaves unset: it has one, in a version 4 file. */
  intentsDecide(phaseId) {
    return Number.isSafeInteger(this.content?.version) && this.content.version >= INTENTS_FILE_VERSION
      && typeof this.phase(phaseId)?.intent === 'string';
  }

  /**
   * "Clarifying questions: off". Elsewhere absent says it; where the step's intent decides, absent would be the intent's
   * questions, so off is written with the rest of the step's question settings kept, and says why: the person turned
   * the questions off here (spec §7.3). A copy of a step that asks nothing keeps its source's settings and reason.
   */
  questionsOff(phaseId, base) {
    const at = ['phases', phaseId, 'clarification'];
    if (!this.intentsDecide(phaseId)) { this.document.deleteIn(at); return; }
    // Already off as written (a copy of convergence, which SFlow builds): nothing changes, so there is nothing to explain.
    if ((isObject(base) ? base.mode : base) === 'off') return;
    this.document.setIn(at, this.document.createNode({ ...(isObject(base) ? base : {}), mode: 'off' }));
    const reason = ['phases', phaseId, 'because', 'clarification.mode'];
    if (!this.document.hasIn(reason)) this.document.setIn(reason, QUESTIONS_OFF_REASON);
  }

  /** A reason Workflow Studio wrote for a setting, taken away with the setting it explained. */
  dropStudioReason(scope, setting, reason) {
    const at = [...scope, 'because', setting];
    if (this.document.getIn(at) !== reason) return;
    this.document.deleteIn(at);
    const rest = this.document.getIn([...scope, 'because']);
    if (rest && typeof rest.items !== 'undefined' && !rest.items.length) this.document.deleteIn([...scope, 'because']);
  }

  /**
   * The steps an approver may send a step's rejected work back to: 1 to 10 step IDs, each the step
   * itself or a step before it in every workflow the setting reaches, as the change set leaves their
   * lists. A target later in the workflow, or one it does not have, would send work forward or
   * nowhere (the check's WORKFLOW_REJECTION_TARGET), so it is refused here.
   */
  sendBackTargets(value, phaseId, reaches, name) {
    if (!Array.isArray(value) || !value.length || value.length > 10) {
      throw new SingularityFlowError(`${name} sends rejected work back to 1 to 10 steps.`, { code: 'STUDIO_SEND_BACK_INVALID' });
    }
    const targets = [...new Set(value.map((id) => requireId(id, 'A step to send rejected work back to')))];
    for (const target of targets) {
      if (target !== phaseId && !this.phase(target) && !this.pendingPhases.has(target)) {
        throw new SingularityFlowError(`There is no step '${target}' for ${name} to send rejected work back to.`, { code: 'STUDIO_SEND_BACK_INVALID' });
      }
      for (const workflowId of reaches) {
        const phases = this.finalPhases?.get(workflowId) ?? this.content.workTypes?.[workflowId]?.phases ?? [];
        const at = phases.indexOf(target);
        if (target !== phaseId && (at < 0 || at > phases.indexOf(phaseId))) {
          throw new SingularityFlowError(`${name} can send rejected work back only to itself or an earlier step; in ${this.content.workTypes?.[workflowId]?.label ?? workflowId}, '${target}' ${at < 0 ? 'is not a step' : 'comes after it'}.`, { code: 'STUDIO_SEND_BACK_INVALID' });
        }
      }
    }
    return targets;
  }

  /**
   * The workflows a step's own send-back targets reach once the change set is applied: each that
   * uses it, except one whose own sign-off for it is none or names targets of its own.
   */
  ownSendBackReach(phaseId) {
    return this.usedByAtEnd(phaseId).filter((workflowId) => {
      const own = this.content.workTypes?.[workflowId]?.phaseOverrides?.[phaseId]?.approval;
      return !(typeof own === 'string' || (isObject(own) && Object.hasOwn(own, 'rejectTo')));
    });
  }

  /**
   * Whether a step may change the repository's files beyond its own document (writeScope). A code step
   * always does; testing and verification may, to write tests. A workflow that only tests and reports
   * runs a copy that changes no code [owner, 2026-11-13].
   */
  setChangesCode(id, changesCode) {
    if (typeof changesCode !== 'boolean') throw new SingularityFlowError('changesCode is true or false.', { code: 'STUDIO_CHANGES_CODE_INVALID' });
    if (!changesCode && outputOf(this.phase(id) ?? {}) === 'code') {
      throw new SingularityFlowError(`${this.phaseLabel(id)} delivers code, so it changes code; give it another output first.`, { code: 'STUDIO_CHANGES_CODE_INVALID' });
    }
    this.document.setIn(['phases', id, 'writeScope'], changesCode ? 'source-and-artifact' : 'artifact-only');
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

  /**
   * SF Guard's chain may only grow: every event it had is kept and every new one verifies against a
   * key already pinned (src/presence/chain.mjs). Anything else is refused before a file is written.
   */
  async setPresence(change) {
    const { extendsPresenceChain, foldPresenceChain, parsePresenceChain, PRESENCE_CHAIN_PATH, presenceChainText } = await import('./presence/chain.mjs');
    if (Object.keys(change).some(key => !['op', 'chain'].includes(key)) || this.presenceChange) {
      throw new SingularityFlowError('SF Guard\'s policy is changed once per change set, with only its new chain.', { code: 'PSS_CHAIN_INVALID' });
    }
    const relative = PRESENCE_CHAIN_PATH;
    const before = await readFile(path.join(this.sources.configRoot, relative), 'utf8').catch(error => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
    const current = parsePresenceChain(before).chain;
    const folded = foldPresenceChain(change.chain);
    if (folded.problems.length) throw new SingularityFlowError(`SF Guard's policy was not changed: ${folded.problems[0].message}.`, { code: folded.problems[0].code });
    if (!extendsPresenceChain(current, change.chain)) {
      throw new SingularityFlowError('SF Guard\'s policy was not changed: the new chain drops or rewrites events the approved one has. It can only be extended.', { code: 'PSS_POLICY_REWRITTEN' });
    }
    const added = change.chain.events.length - (current?.events?.length ?? 0);
    if (added < 1) throw new SingularityFlowError('SF Guard\'s policy was not changed: the new chain adds no event.', { code: 'PSS_CHAIN_INVALID' });
    this.presenceChange = { path: relative, before, after: presenceChainText(change.chain) };
    this.summary.push(`SF Guard: ${change.chain.events.slice(-added).map(event => event.kind).join(', ')} recorded in ${relative}.`);
  }

  /**
   * SF Guard's stamping hook in a declared agent's file [SPEC-SFG-v1 D4]. A file with no hooks of its
   * own gets the exact stamp block before its closing `---` and no other byte changes, so a framework
   * agent stays as it shipped (packaged identity reads it without the block). A file with hooks of its
   * own gets the stamp beside them. Only agent files in this repository, and not APM's (its package
   * owns them); any other agent stays "agent unknown".
   */
  async stampAgent(change) {
    if (Object.keys(change).some(key => !['op', 'id'].includes(key))) {
      throw new SingularityFlowError('An SF Guard stamp names only the agent.', { code: 'STUDIO_AGENT_INVALID' });
    }
    const agent = this.requireAgent(requireId(change.id, 'An agent ID'));
    if (agent.scope !== 'repository' || agent.apm || typeof agent.text !== 'string') {
      this.summary.push(`Agent ${agent.label} is not a file this repository owns, so SF Guard does not stamp it; its work reads "agent unknown".`);
      return;
    }
    const [{ isSfGuardStamp, sfGuardStampingHooks }, { sfGuardStampBlockText, withSfGuardStampBlock }] = await Promise.all([
      import('./comprehension/xpl2/sf-guard-recorder.mjs'), import('./presence/stamp-block.mjs')]);
    const stamp = sfGuardStampingHooks(agent.id);
    const current = (agent.hooks !== undefined ? agent.hooks : splitAgentText(agent.text, agent.id).document.get('hooks')?.toJSON?.()) ?? null;
    const raw = !current && !agent.touched ? withSfGuardStampBlock(agent.text, sfGuardStampBlockText(stamp)) : null;
    if (raw) {
      this.touch(agent).rawText = raw;
    } else {
      const next = { ...(current ?? {}) };
      for (const [event, entries] of Object.entries(stamp)) {
        next[event] = [...(Array.isArray(next[event]) ? next[event] : []).filter(entry => !isSfGuardStamp(entry, agent.id)), ...entries];
      }
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      this.touch(agent).hooks = next;
    }
    this.summary.push(`Agent ${agent.label}: SF Guard's stamping hook written.`);
  }

  /** An agent file's text as this change set leaves it. */
  agentText(agent) {
    return agent.rawText ?? renderAgent(agent);
  }

  writeTemplateIfMissing(relativeTemplate, id, label, intent = null) {
    const relative = posix(path.join(this.sources.templatesRoot, relativeTemplate));
    if (existsSync(path.join(this.sources.configRoot, relative)) || this.templates.has(relative)) return;
    // A step that says what it is for starts from its intent's packaged template, as its own copy.
    const choice = intent ? stepIntentChoice(intent) : null;
    let starter = null;
    if (choice) { try { starter = readFileSync(path.join(PACKAGED_TEMPLATES, ...choice.template.split('/')), 'utf8'); } catch { starter = null; } }
    this.templates.set(relative, newStepTemplate(id, label, { starter }));
  }

  /**
   * Every step of a workflow says what it is for, as the person confirmed on one screen (step intents §6.4): each
   * step's `intent:` is written, and workflow.yml becomes version 4, so the workflow derives its settings from them.
   */
  confirmIntents({ id, steps }) {
    const workflowId = requireId(id, 'A workflow ID');
    const type = this.content.workTypes?.[workflowId];
    if (!type) throw new SingularityFlowError(`There is no workflow '${workflowId}' whose steps to confirm.`, { code: 'STUDIO_WORKFLOW_UNKNOWN' });
    if (!isObject(steps)) throw new SingularityFlowError('The confirmed intents are a map from each step to what it does.', { code: 'STUDIO_INTENT_INVALID', details: { nextAction: INTENT_ROUTE } });
    const phases = this.finalPhases?.get(workflowId) ?? type.phases ?? [];
    const missing = phases.filter((phaseId) => !Object.hasOwn(steps, phaseId) && this.phase(phaseId)?.kind !== 'skill');
    if (missing.length) {
      throw new SingularityFlowError(`Confirm what every step of ${type.label ?? workflowId} is for: ${listWords(missing.map((phaseId) => this.phaseLabel(phaseId)))} ${missing.length === 1 ? 'has' : 'have'} no intent in the confirmation.`,
        { code: 'STUDIO_INTENT_INVALID', details: { workflow: workflowId, missing, nextAction: INTENT_ROUTE } });
    }
    for (const [phaseId, value] of Object.entries(steps)) {
      if (!phases.includes(phaseId)) throw new SingularityFlowError(`${type.label ?? workflowId} has no step '${phaseId}'.`, { code: 'STUDIO_PHASE_UNKNOWN' });
      const name = this.phaseLabel(phaseId);
      const intentValue = requireStepIntent(value, name);
      const current = this.phase(phaseId)?.intent;
      const others = this.usedByAtEnd(phaseId).filter((entry) => entry !== workflowId);
      if (others.length && typeof current === 'string' && current !== intentValue) {
        throw new SingularityFlowError(`${name} is a ${current} step in ${listWords(others.map((entry) => this.content.workTypes?.[entry]?.label ?? entry))} too, and a step means one thing in every workflow. Copy ${name} for this workflow and give the copy intent ${intentValue}.`,
          { code: 'STUDIO_INTENT_SHARED', details: { step: phaseId, intent: current, workflows: others, nextAction: COPY_ROUTE } });
      }
      if (current !== intentValue) this.document.setIn(['phases', phaseId, 'intent'], intentValue);
    }
    const version = this.content.version;
    if (!(Number.isSafeInteger(version) && version >= INTENTS_FILE_VERSION)) this.document.setIn(['version'], INTENTS_FILE_VERSION);
    // Other workflows whose every step now has an intent derive from them too: named, never silent.
    const content = this.content;
    const alsoDerive = Object.entries(content.workTypes ?? {}).filter(([otherId, other]) => otherId !== workflowId && Array.isArray(other?.phases) && other.phases.length
      && other.phases.every((phaseId) => STEP_INTENTS.includes(content.phases?.[phaseId]?.intent))).map(([otherId, other]) => other.label ?? otherId);
    this.summary.push(`${type.label ?? workflowId}: every step says what it is for, confirmed on one screen; workflow.yml is version ${INTENTS_FILE_VERSION}, so its settings derive from its steps' intents.`
      + (alsoDerive.length ? ` ${listWords(alsoDerive)} ${alsoDerive.length === 1 ? 'uses' : 'use'} only steps with an intent too, so ${alsoDerive.length === 1 ? 'it derives' : 'they derive'} from them as well.` : ''));
  }

  apply(change) {
    switch (change.op) {
      case 'group.create': return this.createGroup(change);
      case 'group.update': return this.updateGroup(change);
      case 'agent.create': return this.createAgent(change);
      case 'agent.update': return this.updateAgent(change);
      case 'agent.remove': return this.removeAgent(change);
      case 'userAgent.add': return this.addUserDefinedAgent(change);
      case 'userAgent.update': return this.replaceUserDefinedAgent(change);
      case 'workflow.install': return this.installBlueprint(change);
      case 'phase.create': return this.createPhase(change);
      case 'phase.update': return this.updatePhase(change);
      case 'workflow.intents': return this.confirmIntents(change);
      case 'phase.agent': return this.assignAgent(change);
      case 'workflow.create': return this.createWorkflow(change);
      case 'workflow.update': return this.updateWorkflow(change);
      case 'marketplace.add': return this.addMarketplace(change);
      case 'marketplace.remove': return this.removeMarketplace(change);
      case 'integration.target.create': return this.createTarget(change);
      case 'integration.target.update': return this.updateTarget(change);
      case 'integration.target.remove': return this.removeTarget(change);
      case 'import.skill': return this.importSkill(change);
      case 'import.template': return this.importTemplate(change);
      case 'import.agent': return this.importAgent(change);
      case 'import.generated': return this.importGenerated(change);
      case 'import.mcpServer': return this.importMcpServer(change);
      case 'import.remove': return this.removeImport(change);
      case 'import.librarySkill': return this.importLibrarySkill(change);
      case 'skill.create': return this.createSkill(change);
      case 'instruction.create': return this.writeInstruction(change, true);
      case 'instruction.update': return this.writeInstruction(change, false);
      case 'instruction.remove': return this.removeInstruction(change);
      case 'presence.set': return this.setPresence(change);
      case 'agent.stamp': return this.stampAgent(change);
      case 'constitution.set': {
        if (Object.keys(change).some(key => !['op', 'path', 'articles'].includes(key)) || this.constitutionChanges.has(change.path)) {
          throw new SingularityFlowError('A constitution must be edited once per change set with only path and articles.', { code: 'STUDIO_CONSTITUTION_INVALID' });
        }
        this.constitutionChanges.set(change.path, change);
        this.summary.push(`Constitution ${change.path} updated; new Stories use it only in workflows whose constitution mode is enabled.`);
        return;
      }
      case 'constitution.policy': {
        if (Object.keys(change).some(key => !['op', 'id', 'mode'].includes(key)) || !['off', 'warn', 'enforce'].includes(change.mode)
            || this.constitutionPolicies.has(change.id)) throw new SingularityFlowError('Constitution applicability accepts one explicit Off, Warn or Enforce mode per workflow.', { code: 'STUDIO_CONSTITUTION_INVALID' });
        const id = requireId(change.id, 'A workflow ID');
        const workflow = this.content.workTypes?.[id];
        if (!workflow) throw new SingularityFlowError(`Unknown workflow '${id}'.`, { code: 'STUDIO_WORKFLOW_UNKNOWN' });
        const policy = constitutionPolicy({ ...constitutionPolicy(workflow.constitution), mode: change.mode });
        this.document.setIn(['workTypes', id, 'constitution'], this.document.createNode(policy));
        this.constitutionPolicies.add(id);
        this.summary.push(`Constitution mode for ${workflow.label || id}: ${policy.mode}. Existing Stories retain their pins.`);
        return;
      }
      case 'skill.update': return this.updateSkill(change);
      case 'skill.restore': return this.restoreSkill(change);
      case 'skill.remove': return this.removeSkill(change);
      case 'skill.attach': return this.attachSkill(change);
      case 'skill.detach': return this.detachSkill(change);
      case 'template.create': return this.createTemplate(change);
      case 'template.update': return this.updateTemplate(change);
      case 'artifactSet.create': return this.createArtifactSet(change);
      case 'artifactSet.update': return this.updateArtifactSet(change);
      case 'artifactSet.remove': return this.removeArtifactSet(change);
      case 'epicWorkflow.create': return this.createEpicWorkflow(change);
      case 'epicWorkflow.update': return this.updateEpicWorkflow(change);
      case 'epicStep.create': return this.createEpicStep(change);
      case 'epicStep.update': return this.updateEpicStep(change);
      case 'epicOutput.set': return this.setEpicOutput(change);
      case 'epicOutput.remove': return this.removeEpicOutput(change);
      default: throw new SingularityFlowError(`Unknown Studio change '${change?.op}'.`, { code: 'STUDIO_CHANGE_UNKNOWN' });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Skill master

  requireSkill(id) {
    const skillId = requireId(id, 'A skill ID');
    const skill = this.skills.get(skillId);
    if (!skill) throw new SingularityFlowError(`There is no skill '${skillId}' in the skill master.`, { code: 'STUDIO_SKILL_UNKNOWN' });
    return skill;
  }

  /** The skills an agent attaches now, from its table. */
  attachedSkills(agent) {
    return parseAttachedSkills(this.agentBody(agent), agent.relative ?? agent.id);
  }

  /** The attachments-file entry attaching a skill to an agent, or null. */
  fileAttachment(agentId, skillId) {
    return this.attachments.find((entry) => entry.agent === agentId && entry.id === skillId) ?? null;
  }

  usesSkill(agent, skillId) {
    return Boolean(this.fileAttachment(agent.id, skillId)) || this.attachedSkills(agent).some((entry) => entry.id === skillId);
  }

  /**
   * Whether a new attachment goes in the agent's own table: only for an agent the repository owns
   * outright. A framework agent, or one a framework workflow uses, is attached skills in the
   * attachments file, so it is never copied or changed.
   */
  attachesInTable(agent) {
    return agent.scope === 'repository' && !this.protectedAgents.has(agent.id);
  }

  setFileAttachments(entries) {
    // Unchanged attachments leave the file as it is: a rewrite would show a reviewer every
    // attachment removed and added again (a step list change filters them, usually to the same).
    if (JSON.stringify(entries) === JSON.stringify(this.attachments)) return;
    this.attachments = entries;
    this.attachmentsChanged = true;
  }

  writeSkill(skillId, { label, description, instructions, loading, instructionRefs, tags }) {
    const text = librarySkillText({ id: skillId, label, description, instructions, loading, instructionRefs, tags });
    const skill = parseLibrarySkill(text, { id: skillId });
    this.skills.set(skillId, skill);
    this.skillFiles.set(librarySkillPath(skillId), text);
    return skill;
  }

  createSkill({ id, label, description, instructions, loading, instructionRefs }) {
    const skillId = requireId(id, 'A skill ID');
    if (this.skills.has(skillId)) throw new SingularityFlowError(`The skill master already has a skill called '${skillId}'.`, { code: 'STUDIO_SKILL_EXISTS' });
    const skill = this.writeSkill(skillId, { label, description, instructions, loading, instructionRefs });
    this.summary.push(`New skill ${skill.label} in the skill master.`);
  }

  updateSkill({ id, label, description, instructions, loading, instructionRefs }) {
    const current = this.requireSkill(id);
    const skill = this.writeSkill(current.id, {
      label: label ?? current.label, description: description ?? current.description,
      instructions: instructions ?? current.instructions, loading: loading ?? current.loading,
      tags: current.tags,
      instructionRefs: instructionRefs ?? current.declaredInstructionRefs ?? current.instructionRefs
    });
    // The agents that use the new text are known once every change is applied.
    this.updatedSkills.set(skill.id, this.summary.push(`Skill ${skill.label} updated.`) - 1);
  }

  /**
   * A skill this build ships, written back as it ships (`skill restore`): the way out of one that is here but not a valid
   * skill, which a configuration refresh keeps because it may be an edit. Text here that SFlow never shipped is replaced
   * only with `discardEdits`, the person's yes; the seeded-workflow check accepts the packaged bytes unchanged.
   */
  async restoreSkill({ id, discardEdits = false }) {
    const skillId = requireId(id, 'A skill ID');
    const { packagedSkillState } = await import('./skill-library-problems.mjs');
    const state = await packagedSkillState(this.sources.configRoot, skillId);
    if (state.packaged == null) {
      throw new SingularityFlowError(`SFlow does not ship a skill called '${skillId}', so there is nothing to restore. See the skill master with singularity-flow skill list.`,
        { code: 'STUDIO_SKILL_NOT_PACKAGED', details: { nextAction: { command: 'singularity-flow skill list', label: 'See the skills in the skill master.' } } });
    }
    if (state.same) {
      throw new SingularityFlowError(`Skill '${skillId}' is already as SFlow ships it, so there is nothing to restore. See it with singularity-flow skill show ${skillId}.`,
        { code: 'STUDIO_SKILL_ALREADY_PACKAGED', details: { nextAction: { command: `singularity-flow skill show ${skillId}`, label: 'Show the skill and who uses it.' } } });
    }
    if (state.edited && discardEdits !== true) {
      const command = `singularity-flow skill restore ${skillId} --discard-edits`;
      throw new SingularityFlowError(`Skill '${skillId}' here was edited in this repository: restoring replaces that edit with SFlow's text. To replace it, run ${command}.`,
        { code: 'STUDIO_SKILL_RESTORE_EDITED', details: { skillId, nextAction: { command, label: 'Replace the edited text with SFlow\'s packaged skill.' } } });
    }
    const skill = parseLibrarySkill(state.packaged, { id: skillId });
    this.skills.set(skillId, skill);
    this.skillFiles.set(librarySkillPath(skillId), state.packaged);
    this.forgetImport(`library-skill:${skillId}`);
    this.summary.push(`Skill ${skill.label} restored as SFlow ships it${state.current == null ? '' : state.edited ? ', replacing the text edited here' : ', replacing an earlier packaged text'}.`);
  }

  removeSkill({ id }) {
    const skill = this.requireSkill(id);
    const detached = [];
    for (const agent of this.agents.values()) {
      if (!this.attachedSkills(agent).some((entry) => entry.id === skill.id)) continue;
      this.touch(agent);
      agent.body = this.withoutSkill(agent, skill.id);
      detached.push(agent.label);
    }
    const kept = this.attachments.filter((entry) => entry.id !== skill.id);
    if (kept.length !== this.attachments.length) {
      for (const entry of this.attachments) if (entry.id === skill.id) detached.push(entry.workflow ?? this.agentLabel(entry.agent));
      this.setFileAttachments(kept);
    }
    this.skills.delete(skill.id);
    this.skillFiles.set(librarySkillPath(skill.id), null);
    this.forgetImport(`library-skill:${skill.id}`);
    this.summary.push(`Skill ${skill.label} removed from the skill master${detached.length ? ` and from ${detached.join(', ')}` : ''}.`);
  }

  async writeInstruction(change, create) {
    const id = requireId(change.id, 'An instruction ID');
    const current = this.instructions.get(id);
    if (create === Boolean(current)) throw new SingularityFlowError(create
      ? `Instruction '${id}' already exists.` : `Instruction '${id}' does not exist.`, { code: 'STUDIO_INSTRUCTION_ID_INVALID' });
    const destination = await secureRepositoryPath(this.sources.configRoot, instructionPath(id), { label: `Instruction '${id}'`, type: 'file' });
    if (create && destination.exists) throw new SingularityFlowError(`Instruction '${id}' has an existing file that must be repaired, not overwritten as a new definition.`, { code: 'STUDIO_INSTRUCTION_ID_INVALID' });
    const text = instructionText({ ...current, ...change, id });
    const item = parseInstruction(text, { id });
    this.instructions.set(id, item); this.instructionFiles.set(instructionPath(id), text);
    this.summary.push(`${create ? 'New' : 'Updated'} reusable instruction ${item.label}; only referencing skills use it in new Stories.`);
  }

  removeInstruction({ id }) {
    if (!this.instructions.has(id)) throw new SingularityFlowError(`Instruction '${id}' does not exist.`, { code: 'STUDIO_INSTRUCTION_ID_INVALID' });
    // References are validated after all operations, allowing an explicit skill edit and removal
    // in one atomic change set. Never silently detach an instruction from its owners.
    this.instructions.delete(id); this.instructionFiles.set(instructionPath(id), null);
    this.summary.push(`Removed reusable instruction ${id}.`);
  }

  attachSkill({ skill: skillId, agent: agentId, workflow: workflowId, phases = [], use = '' }) {
    const skill = this.requireSkill(skillId);
    if (Boolean(agentId) === Boolean(workflowId)) throw new SingularityFlowError('Attach a skill to exactly one agent or workflow.', { code: 'STUDIO_SKILL_TARGET_INVALID' });
    if (workflowId) {
      const id = requireId(workflowId, 'A workflow ID');
      const type = this.content.workTypes?.[id];
      if (!type) throw new SingularityFlowError(`Unknown workflow '${id}'.`, { code: 'SKILL_ATTACHMENT_WORKFLOW_UNKNOWN' });
      const steps = this.requirePhases(phases);
      if (steps.some((step) => !type.phases.includes(step))) throw new SingularityFlowError(`Skill steps must belong to workflow '${id}'.`, { code: 'SKILL_ATTACHMENT_PHASE_UNKNOWN' });
      this.setFileAttachments([...this.attachments.filter((entry) => !(entry.workflow === id && entry.id === skill.id)),
        { workflow: id, id: skill.id, phases: steps, use: normalizeSkillUse(use) }]);
      this.summary.push(`Workflow ${id} uses skill ${skill.label}${steps.length ? ` in ${steps.join(', ')}` : ' in every step'}; other workflows are unchanged.`);
      return;
    }
    const agent = this.requireAgent(requireId(agentId, 'An agent ID'));
    const steps = this.requirePhases(phases);
    const when = normalizeSkillUse(use);
    const inFile = Boolean(this.fileAttachment(agent.id, skill.id));
    const inTable = this.attachedSkills(agent).some((entry) => entry.id === skill.id);
    if (inFile || (!inTable && !this.attachesInTable(agent))) {
      // Where it already is, or the attachments file for an agent the repository does not own.
      this.setFileAttachments([
        ...this.attachments.filter((entry) => !(entry.agent === agent.id && entry.id === skill.id)),
        Object.freeze({ agent: agent.id, id: skill.id, phases: Object.freeze(steps), use: when })
      ]);
    } else {
      this.touch(agent).body = upsertAgentTableRow(this.agentBody(agent), 'library',
        [skill.id, steps.join(', ') || '*', when || '-'], { replace: true });
    }
    this.summary.push(`${agent.label} uses skill ${skill.label}${steps.length ? ` in ${steps.map((step) => this.phaseLabel(step)).join(', ')}` : ' in every step it drafts'}${when ? `: ${when}` : ''}.`);
  }

  /** The agent's text without one attached skill; without the section once it attaches none. */
  withoutSkill(agent, skillId) {
    const body = removeAgentTableRow(this.agentBody(agent), 'library', skillId);
    if (body == null || parseAttachedSkills(body, agent.relative).length) return body;
    return `${withoutAttachedSkills(body).replace(/\s+$/, '')}\n`;
  }

  detachSkill({ skill: skillId, agent: agentId, workflow: workflowId }) {
    const id = requireId(skillId, 'A skill ID');
    if (Boolean(agentId) === Boolean(workflowId)) throw new SingularityFlowError('Detach from exactly one agent or workflow.', { code: 'STUDIO_SKILL_TARGET_INVALID' });
    if (workflowId) {
      if (!this.attachments.some((entry) => entry.workflow === workflowId && entry.id === id)) throw new SingularityFlowError(`Workflow '${workflowId}' does not use skill '${id}'.`, { code: 'STUDIO_SKILL_NOT_ATTACHED' });
      this.setFileAttachments(this.attachments.filter((entry) => !(entry.workflow === workflowId && entry.id === id)));
      this.summary.push(`Skill ${id} detached from workflow ${workflowId}.`);
      return;
    }
    const agent = this.requireAgent(requireId(agentId, 'An agent ID'));
    if (this.fileAttachment(agent.id, id)) {
      this.setFileAttachments(this.attachments.filter((entry) => !(entry.agent === agent.id && entry.id === id)));
      this.summary.push(`${agent.label} no longer uses skill ${this.skills.get(id)?.label ?? id}.`);
      return;
    }
    const body = this.withoutSkill(agent, id);
    if (body == null) throw new SingularityFlowError(`${agent.label} does not use skill '${id}'.`, { code: 'STUDIO_SKILL_NOT_ATTACHED' });
    this.touch(agent).body = body;
    this.summary.push(`${agent.label} no longer uses skill ${this.skills.get(id)?.label ?? id}.`);
  }

  /**
   * A skill from a link, a marketplace or an MCP server, into the skill master. A SKILL.md keeps its
   * exact bytes; plain Markdown becomes the instructions of a SKILL.md with the description given.
   */
  importLibrarySkill({ id, sha256, description = null, replace = false }) {
    const skillId = requireId(id, 'A skill ID');
    const staged = this.stagedContent(sha256, 'skill', { id: skillId });
    const key = `library-skill:${skillId}`;
    if (this.skills.has(skillId)) {
      if (!replace) throw new SingularityFlowError(`The skill master already has a skill called '${skillId}'. Replace it deliberately, or choose another ID.`, { code: 'STUDIO_SKILL_EXISTS' });
      if (!this.ledger.imports[key]) throw new SingularityFlowError(`Skill '${skillId}' was written in this repository, not imported; import under another ID.`, { code: 'STUDIO_SKILL_EXISTS' });
    }
    let text = staged.text; let extra = {};
    let skill;
    if (/^\ufeff?---\r?\n/.test(text)) {
      const { document, header, body } = splitAgentText(text, skillId);
      if (document.get('name') !== skillId) {
        document.set('name', skillId);
        text = `---\n${renderPreservingFormatting(header, document)}---\n${body}`;
        extra = { transforms: ['renamed'], fileSha256: sha256Of(Buffer.from(text, 'utf8')) };
      }
      skill = parseLibrarySkill(text, { id: skillId });
    }
    else {
      // An update of plain Markdown keeps the skill's name and description unless new ones are given.
      const current = replace ? this.skills.get(skillId) : null;
      const what = String(description ?? current?.description ?? '').replace(/\s+/g, ' ').trim();
      if (!what) throw new SingularityFlowError('This file is plain Markdown, so the skill needs a description of what it does and when to use it (--description on the command line).', { code: 'STUDIO_SKILL_INVALID' });
      text = librarySkillText({ id: skillId, label: current?.label ?? null, description: what, instructions: staged.text, loading: current?.loading, instructionRefs: current?.declaredInstructionRefs ?? current?.instructionRefs, tags: current?.tags });
      skill = parseLibrarySkill(text, { id: skillId });
      extra = { transforms: ['wrapped-as-skill'], fileSha256: sha256Of(Buffer.from(text, 'utf8')) };
    }
    const updated = this.skills.has(skillId);
    this.skills.set(skillId, skill);
    this.skillFiles.set(librarySkillPath(skillId), text);
    this.recordImport('library-skill', { id: skillId }, staged, { id: skillId, path: librarySkillPath(skillId) }, extra);
    this.summary.push(updated ? `Skill ${skill.label} updated from ${sourceText(staged.source)}.` : `Skill ${skill.label} from ${sourceText(staged.source)} in the skill master.`);
  }

  // -------------------------------------------------------------------------------------------
  // Templates and artifact sets

  /** The text a template change writes: a string of at most 256 KiB that says something. */
  templateText(content, name) {
    if (typeof content !== 'string' || !content.trim()) {
      throw new SingularityFlowError(`Template ${name} needs some content.`, { code: 'STUDIO_TEMPLATE_INVALID' });
    }
    if (Buffer.byteLength(content, 'utf8') > TEMPLATE_WRITE_LIMIT) {
      throw new SingularityFlowError(`Template ${name} is larger than 256 KiB.`, { code: 'STUDIO_TEMPLATE_INVALID' });
    }
    return content.endsWith('\n') ? content : `${content}\n`;
  }

  templateFile(relative) {
    const name = safeTemplatePath(relative);
    if (!name) {
      throw new SingularityFlowError('A template is a .md path inside the templates folder, without "..".', { code: 'STUDIO_TEMPLATE_INVALID' });
    }
    return { name, file: posix(path.join(this.sources.templatesRoot, name)) };
  }

  /** A new template file, or a repository copy of a packaged one so it can be changed. */
  createTemplate({ path: relative, content }) {
    const { name, file } = this.templateFile(relative);
    if (existsSync(path.join(this.sources.configRoot, file)) || this.templates.has(file)) {
      throw new SingularityFlowError(`Template ${name} already exists in this repository; change it instead.`, { code: 'STUDIO_TEMPLATE_EXISTS' });
    }
    this.templates.set(file, this.templateText(content, name));
    this.summary.push(existsSync(path.join(PACKAGED_TEMPLATES, name)) ? `Template ${name} copied into this repository and changed.` : `New template ${name}.`);
  }

  updateTemplate({ path: relative, content }) {
    const { name, file } = this.templateFile(relative);
    if (!existsSync(path.join(this.sources.configRoot, file))) {
      throw new SingularityFlowError(`Template ${name} is not in this repository. Copy it into the repository to change it.`, { code: 'STUDIO_TEMPLATE_UNKNOWN' });
    }
    this.templates.set(file, { content: this.templateText(content, name), replace: true });
    this.summary.push(`Template ${name} changed.`);
  }

  /** A template value a step or workflow may name: a catalog entry, or a template file that exists. */
  templateValue(value, name) {
    if (typeof value === 'string' && isTemplateReference(value)) {
      const id = parseTemplateReference(value, `The template of ${name}`);
      if (!Object.hasOwn(this.content.templates ?? {}, id)) {
        throw new SingularityFlowError(`The template catalog has no entry '${id}'.`, { code: 'STUDIO_TEMPLATE_UNKNOWN' });
      }
      return value;
    }
    const { name: relative, file } = this.templateFile(value);
    if (!existsSync(path.join(this.sources.configRoot, file)) && !this.templates.has(file) && !existsSync(path.join(PACKAGED_TEMPLATES, relative))) {
      throw new SingularityFlowError(`There is no template ${relative} for ${name}.`, { code: 'STUDIO_TEMPLATE_UNKNOWN' });
    }
    return relative;
  }

  /** An artifact set as written: checked by the same rules configuration loading applies. */
  artifactSetNode(id, primary, members) {
    const normalized = normalizeArtifactSet({ primary, members }, id);
    return {
      primary: normalized.primary,
      members: normalized.members.map((member) => ({
        path: member.path, role: member.role,
        ...(member.required ? { required: true } : {}),
        ...(member.authority !== 'governed' ? { authority: member.authority } : {})
      }))
    };
  }

  createArtifactSet({ id, primary, members }) {
    const setId = requireId(id, 'An artifact set ID');
    if (this.content.artifactSets?.[setId]) {
      throw new SingularityFlowError(`An artifact set called '${setId}' already exists.`, { code: 'STUDIO_ARTIFACT_SET_EXISTS' });
    }
    this.document.setIn(['artifactSets', setId], this.document.createNode(this.artifactSetNode(setId, primary, members)));
    this.summary.push(`New artifact set ${setId}: ${(members ?? []).length} member(s).`);
  }

  updateArtifactSet({ id, primary, members }) {
    const setId = requireId(id, 'An artifact set ID');
    const current = this.content.artifactSets?.[setId];
    if (!current) throw new SingularityFlowError(`There is no artifact set '${setId}'.`, { code: 'STUDIO_ARTIFACT_SET_UNKNOWN' });
    const node = this.artifactSetNode(setId, primary ?? current.primary, members ?? current.members);
    this.document.setIn(['artifactSets', setId], this.document.createNode(node));
    // A step in the set writes its primary member as its own file, so a new primary moves each of them.
    const users = Object.entries(this.content.phases ?? {}).filter(([, phase]) => phase?.artifactSet === setId).map(([phaseId]) => phaseId);
    if (node.primary !== posix(String(current.primary ?? ''))) for (const phaseId of users) this.alignArtifactFile(phaseId, setId);
    this.summary.push(`Artifact set ${setId} changed.`);
  }

  /**
   * A step in an artifact set writes the set's primary member as its own file, beside the other
   * members, as configuration loading requires; the step keeps its folder.
   */
  alignArtifactFile(phaseId, setId) {
    const primary = posix(String(this.content.artifactSets?.[setId]?.primary ?? ''));
    if (!ARTIFACT_FILE.test(primary)) {
      throw new SingularityFlowError(`${this.phaseLabel(phaseId)} would write ${primary}, the primary member of artifact set ${setId}; a step's own file is a .md file name without folders.`, { code: 'STUDIO_ARTIFACT_SET_INVALID' });
    }
    this.setArtifactFile(phaseId, primary);
  }

  setArtifactFile(phaseId, fileName) {
    const current = posix(String(this.phase(phaseId)?.artifact?.path ?? `artifacts/${phaseId}/${phaseId}.md`));
    const directory = path.posix.dirname(current);
    const next = directory === '.' ? fileName : `${directory}/${fileName}`;
    if (next !== current) this.document.setIn(['phases', phaseId, 'artifact', 'path'], next);
  }

  removeArtifactSet({ id }) {
    const setId = requireId(id, 'An artifact set ID');
    if (!this.content.artifactSets?.[setId]) throw new SingularityFlowError(`There is no artifact set '${setId}'.`, { code: 'STUDIO_ARTIFACT_SET_UNKNOWN' });
    const users = Object.entries(this.content.phases ?? {}).filter(([, phase]) => phase?.artifactSet === setId).map(([phaseId]) => this.phaseLabel(phaseId));
    if (users.length) {
      throw new SingularityFlowError(`Artifact set ${setId} is still used by ${users.join(', ')}.`, { code: 'STUDIO_ARTIFACT_SET_IN_USE' });
    }
    this.document.deleteIn(['artifactSets', setId]);
    if (!Object.keys(this.content.artifactSets ?? {}).length && this.document.hasIn(['artifactSets'])) this.document.deleteIn(['artifactSets']);
    this.summary.push(`Artifact set ${setId} removed.`);
  }

  // -------------------------------------------------------------------------------------------
  // Epic (Initiative) workflows, in portfolio.yml

  get portfolioContent() { return this.portfolioDocument?.toJS() ?? {}; }
  requirePortfolio() {
    if (!this.portfolioDocument) throw new SingularityFlowError('This repository has no portfolio.yml, so it has no Epic workflows to change.', { code: 'STUDIO_PORTFOLIO_MISSING' });
    return this.portfolioDocument;
  }
  epicStep(id) { return this.portfolioContent.initiativePhases?.[id] ?? null; }
  epicStepLabel(id) { return this.epicStep(id)?.label ?? id; }
  requireEpicStep(id) {
    if (!this.epicStep(id) && !this.pendingEpicSteps.has(id)) throw new SingularityFlowError(`There is no Epic step '${id}'.`, { code: 'STUDIO_EPIC_STEP_UNKNOWN' });
    return id;
  }
  epicStepList(phases, name) {
    if (!Array.isArray(phases)) throw new SingularityFlowError(`The steps of ${name} must be a list.`, { code: 'STUDIO_EPIC_WORKFLOW_INVALID' });
    const ids = phases.map((phase) => this.requireEpicStep(requireId(phase, 'An Epic step')));
    if (!ids.length) throw new SingularityFlowError(`${name} needs at least one step.`, { code: 'STUDIO_EPIC_WORKFLOW_EMPTY' });
    if (new Set(ids).size !== ids.length) throw new SingularityFlowError(`${name} lists a step more than once.`, { code: 'STUDIO_EPIC_WORKFLOW_INVALID' });
    return ids;
  }
  epicAgents(agents, name) {
    if (!Array.isArray(agents)) throw new SingularityFlowError(`The agents of ${name} must be a list.`, { code: 'STUDIO_EPIC_STEP_INVALID' });
    return [...new Set(agents.map((agent) => { const agentId = requireId(agent, 'An agent ID'); this.requireAgent(agentId); return agentId; }))];
  }
  epicList(values, name, what) {
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))) {
      throw new SingularityFlowError(`The ${what} of ${name} are a list of lower-case kebab-case names.`, { code: 'STUDIO_EPIC_STEP_INVALID' });
    }
    return [...new Set(values)];
  }
  /** A bundle sign-off: groups from portfolio.yml, how many approve; a review chain stays as written. */
  epicApprovalNode(approval, existing, name) {
    if (existing && Array.isArray(existing.chain)) {
      throw new SingularityFlowError(`${name} is signed off through a review chain; change it in portfolio.yml.`, { code: 'STUDIO_EPIC_APPROVAL_CHAIN' });
    }
    const base = existing && typeof existing === 'object' ? { ...existing } : {};
    if (approval === 'none') return { ...base, mode: 'none', authorities: [], minimum: 0, allowSelfApproval: base.allowSelfApproval ?? true };
    const listed = approvalGroups(approval);
    if (!Array.isArray(listed) || !listed.length || listed.length > 10) throw new SingularityFlowError(`${name} is signed off by 1 to 10 approval groups.`, { code: 'STUDIO_APPROVAL_INVALID' });
    const groups = [...new Set(listed.map((id) => requireId(id, 'An approval group')))];
    const unknown = groups.filter((id) => !this.portfolioContent.approvalAuthorities?.[id]);
    if (unknown.length) throw new SingularityFlowError(`portfolio.yml has no approval group '${unknown[0]}'.`, { code: 'STUDIO_GROUP_UNKNOWN' });
    const minimum = approval.minimum == null ? 1 : Number(approval.minimum);
    if (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > 20) throw new SingularityFlowError('Approvals needed must be a whole number from 1 to 20.', { code: 'STUDIO_APPROVAL_INVALID' });
    return { ...base, mode: base.mode && base.mode !== 'none' ? base.mode : 'bundle', authorities: groups, minimum, allowSelfApproval: base.allowSelfApproval ?? true };
  }
  /** An Epic output's template: under the portfolio templates folder, this change set's new files, or packaged. */
  epicTemplate(value, name) {
    const relative = String(value ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:md|ya?ml|json)$/.test(relative) || relative.split('/').includes('..')) {
      throw new SingularityFlowError(`The template of ${name} is a .md, .yml or .json path inside the templates folder, without "..".`, { code: 'STUDIO_TEMPLATE_INVALID' });
    }
    const file = posix(path.join(posix(this.portfolioContent.templatesRoot ?? this.sources.templatesRoot), relative));
    if (!existsSync(path.join(this.sources.configRoot, file)) && !this.templates.has(file) && !existsSync(path.join(PACKAGED_TEMPLATES, relative))) {
      throw new SingularityFlowError(`There is no template ${relative} for ${name}.`, { code: 'STUDIO_TEMPLATE_UNKNOWN' });
    }
    return relative;
  }

  createEpicWorkflow({ id, label, description, phases, copyOf }) {
    const document = this.requirePortfolio();
    const workflowId = requireId(id, 'An Epic workflow ID');
    if (this.portfolioContent.initiativeProfiles?.[workflowId]) throw new SingularityFlowError(`An Epic workflow called '${workflowId}' already exists.`, { code: 'STUDIO_EPIC_WORKFLOW_EXISTS' });
    const name = requireLabel(label, 'The Epic workflow');
    let node = { label: name, phases: [] };
    if (copyOf != null) {
      const sourceId = requireId(copyOf, 'The Epic workflow to copy');
      const source = this.portfolioContent.initiativeProfiles?.[sourceId];
      if (!source) throw new SingularityFlowError(`There is no Epic workflow '${sourceId}' to copy.`, { code: 'STUDIO_EPIC_WORKFLOW_UNKNOWN' });
      // A linked copy shares its source's steps and packs; changing a shared step changes both.
      node = { ...structuredClone(source), label: name };
    }
    if (description != null) { if (String(description).trim()) node.description = String(description).trim(); else delete node.description; }
    node.phases = phases != null ? this.epicStepList(phases, name) : this.epicStepList(node.phases ?? [], name);
    if (!document.hasIn(['initiativeProfiles'])) document.setIn(['initiativeProfiles'], document.createNode({}));
    document.setIn(['initiativeProfiles', workflowId], document.createNode(node));
    this.portfolioChanged = true;
    this.summary.push(copyOf != null ? `New Epic workflow ${name}, a linked copy of ${this.portfolioContent.initiativeProfiles?.[copyOf]?.label ?? copyOf}.` : `New Epic workflow ${name}: ${node.phases.map((phase) => this.epicStepLabel(phase)).join(' → ')}.`);
  }

  updateEpicWorkflow({ id, label, description, phases }) {
    const document = this.requirePortfolio();
    const workflowId = requireId(id, 'An Epic workflow ID');
    const current = this.portfolioContent.initiativeProfiles?.[workflowId];
    if (!current) throw new SingularityFlowError(`There is no Epic workflow '${workflowId}'.`, { code: 'STUDIO_EPIC_WORKFLOW_UNKNOWN' });
    const name = label != null ? requireLabel(label, 'The Epic workflow') : current.label ?? workflowId;
    const changed = [];
    if (label != null) { document.setIn(['initiativeProfiles', workflowId, 'label'], name); changed.push('name'); }
    if (description != null) {
      if (String(description).trim()) document.setIn(['initiativeProfiles', workflowId, 'description'], String(description).trim());
      else if (document.hasIn(['initiativeProfiles', workflowId, 'description'])) document.deleteIn(['initiativeProfiles', workflowId, 'description']);
      changed.push('description');
    }
    if (phases != null) {
      const ids = this.epicStepList(phases, name);
      this.setPortfolioKeepingStyle(['initiativeProfiles', workflowId, 'phases'], ids);
      changed.push(`steps (${ids.map((phase) => this.epicStepLabel(phase)).join(' → ')})`);
    }
    if (changed.length) { this.portfolioChanged = true; this.summary.push(`${name}: ${changed.join(', ')} changed.`); }
  }

  setPortfolioKeepingStyle(keys, value) {
    const document = this.portfolioDocument;
    document.setIn(keys, document.createNode(value, { flow: Boolean(document.getIn(keys, true)?.flow) }));
  }

  // A change from an older Studio may still carry `views`: Epic step World Model views were removed, so it is not read.
  createEpicStep({ id, label, agents = [], lanes = [], approval = 'none' }) {
    const document = this.requirePortfolio();
    const stepId = requireId(id, 'An Epic step ID');
    if (this.epicStep(stepId)) throw new SingularityFlowError(`An Epic step called '${stepId}' already exists.`, { code: 'STUDIO_EPIC_STEP_EXISTS' });
    const name = requireLabel(label, 'The Epic step');
    const node = {
      label: name,
      ...(lanes.length ? { lanes: this.epicList(lanes, name, 'lanes') } : {}),
      ...(agents.length ? { agents: this.epicAgents(agents, name) } : {}),
      outputs: [], checklist: [],
      bundleApproval: this.epicApprovalNode(approval, null, name)
    };
    if (!document.hasIn(['initiativePhases'])) document.setIn(['initiativePhases'], document.createNode({}));
    document.setIn(['initiativePhases', stepId], document.createNode(node));
    this.portfolioChanged = true;
    this.summary.push(`New Epic step ${name}.`);
  }

  updateEpicStep({ id, workflow = null, label, agents, lanes, approval }) {
    const document = this.requirePortfolio();
    const stepId = requireId(id, 'An Epic step ID');
    const base = this.epicStep(stepId);
    const profile = workflow ? this.portfolioContent.initiativeProfiles?.[requireId(workflow, 'An Epic workflow ID')] : null;
    if (workflow && !profile?.phases?.includes(stepId)) throw new SingularityFlowError(`Epic workflow '${workflow}' does not use '${stepId}'.`, { code: 'STUDIO_EPIC_STEP_UNKNOWN' });
    const current = profile ? { ...base, ...profile.phaseOverrides?.[stepId] } : base;
    if (!current) throw new SingularityFlowError(`There is no Epic step '${stepId}'.`, { code: 'STUDIO_EPIC_STEP_UNKNOWN' });
    const name = label != null ? requireLabel(label, 'The Epic step') : current.label ?? stepId;
    const changed = [];
    const keys = (field) => workflow ? ['initiativeProfiles', workflow, 'phaseOverrides', stepId, field] : ['initiativePhases', stepId, field];
    if (label != null) { document.setIn(keys('label'), name); changed.push('name'); }
    if (agents != null) {
      const list = this.epicAgents(agents, name);
      if (list.length || workflow) this.setPortfolioKeepingStyle(keys('agents'), list); else if (document.hasIn(keys('agents'))) document.deleteIn(keys('agents'));
      changed.push('agents');
    }
    if (lanes != null) {
      const list = this.epicList(lanes, name, 'lanes');
      if (list.length || workflow) this.setPortfolioKeepingStyle(keys('lanes'), list); else if (document.hasIn(keys('lanes'))) document.deleteIn(keys('lanes'));
      changed.push('lanes');
    }
    if (approval != null) { document.setIn(keys('bundleApproval'), document.createNode(this.epicApprovalNode(approval, current.bundleApproval, name), { flow: Boolean(document.getIn(keys('bundleApproval'), true)?.flow) })); changed.push('sign-off'); }
    if (changed.length) { this.portfolioChanged = true; this.summary.push(`${name}: ${changed.join(', ')} changed.`); }
  }

  /** Add an output to an Epic step, or change one: what it is, where it is written, its template, and what it reads. */
  setEpicOutput({ step, id, workflow = null, label, kind, path: outputPath, template, required, consumes }) {
    const document = this.requirePortfolio();
    const stepId = this.requireEpicStep(requireId(step, 'An Epic step ID'));
    const outputId = requireId(id, 'An output ID');
    const name = `${this.epicStepLabel(stepId)}/${outputId}`;
    const outputs = Array.isArray(this.epicStep(stepId)?.outputs) ? this.epicStep(stepId).outputs : [];
    const index = outputs.findIndex((entry) => entry?.id === outputId);
    const profile = workflow ? this.portfolioContent.initiativeProfiles?.[requireId(workflow, 'An Epic workflow ID')] : null;
    if (workflow && (!profile?.phases?.includes(stepId) || index < 0)) throw new SingularityFlowError('A workflow-local Epic output must already exist in its active step.', { code: 'STUDIO_EPIC_OUTPUT_UNKNOWN' });
    const previous = { ...(index >= 0 ? outputs[index] : {}), ...profile?.phaseOverrides?.[stepId]?.outputs?.[outputId] };
    if (workflow && template !== undefined && !template && outputs[index]?.template) {
      throw new SingularityFlowError('This workflow-local output inherits a template from its shared step. Choose a replacement template; clearing it would silently restore the shared original.', { code: 'STUDIO_EPIC_OUTPUT_INVALID' });
    }
    const outputKind = kind ?? previous.kind ?? 'markdown';
    if (!INITIATIVE_OUTPUT_KINDS.has(outputKind)) throw new SingularityFlowError(`An Epic output is one of: ${[...INITIATIVE_OUTPUT_KINDS].join(', ')}.`, { code: 'STUDIO_EPIC_OUTPUT_INVALID' });
    const file = String(outputPath ?? previous.path ?? `${outputId}.${outputKind === 'yaml' ? 'yml' : 'md'}`).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(file) || file.split('/').includes('..')) {
      throw new SingularityFlowError(`The file ${name} writes is a path inside the Epic's folder, without "..".`, { code: 'STUDIO_EPIC_OUTPUT_INVALID' });
    }
    if (consumes != null && (!Array.isArray(consumes) || consumes.some((entry) => typeof entry !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry)))) {
      throw new SingularityFlowError(`What ${name} reads is a list of step/output names.`, { code: 'STUDIO_EPIC_OUTPUT_INVALID' });
    }
    const next = {
      ...previous, id: outputId, label: label != null ? requireLabel(label, 'The output') : previous.label ?? outputId,
      kind: outputKind, path: file
    };
    if (template !== undefined) { if (template) next.template = this.epicTemplate(template, name); else delete next.template; }
    if (required !== undefined) { if (required === false) next.required = false; else delete next.required; }
    if (consumes != null) { if (consumes.length) next.consumes = [...new Set(consumes)]; else delete next.consumes; }
    if (workflow) {
      if (required === true) next.required = true;
      if (consumes != null) next.consumes = [...new Set(consumes)];
      document.setIn(['initiativeProfiles', workflow, 'phaseOverrides', stepId, 'outputs', outputId], document.createNode(next));
      // A profile's legacy templateOverrides have precedence over output overrides.
      const legacyTemplate = ['initiativeProfiles', workflow, 'templateOverrides', `${stepId}/${outputId}`];
      if (template !== undefined && document.hasIn(legacyTemplate)) document.deleteIn(legacyTemplate);
      this.portfolioChanged = true; this.summary.push(`Output ${name} changed only in ${workflow}.`); return;
    }
    // Only the edited output is rewritten, in the style the list already uses ({ ... } or block).
    const list = document.getIn(['initiativePhases', stepId, 'outputs'], true);
    if (YAML.isSeq(list)) {
      const flow = index >= 0 ? Boolean(list.items[index]?.flow) : list.items.length ? list.items.every((item) => item?.flow) : false;
      const node = document.createNode(next, { flow });
      if (index < 0) list.items.push(node); else list.items[index] = node;
    } else {
      document.setIn(['initiativePhases', stepId, 'outputs'], document.createNode([...outputs.filter((entry, at) => at !== index), next]));
    }
    this.portfolioChanged = true;
    this.summary.push(index < 0 ? `New output ${name}.` : `Output ${name} changed.`);
  }

  removeEpicOutput({ step, id }) {
    const document = this.requirePortfolio();
    const stepId = this.requireEpicStep(requireId(step, 'An Epic step ID'));
    const outputId = requireId(id, 'An output ID');
    const outputs = Array.isArray(this.epicStep(stepId)?.outputs) ? this.epicStep(stepId).outputs : [];
    if (!outputs.some((entry) => entry?.id === outputId)) throw new SingularityFlowError(`${this.epicStepLabel(stepId)} has no output '${outputId}'.`, { code: 'STUDIO_EPIC_OUTPUT_UNKNOWN' });
    const reference = `${stepId}/${outputId}`;
    const readers = Object.entries(this.portfolioContent.initiativePhases ?? {}).flatMap(([phaseId, phase]) => (phase?.outputs ?? [])
      .filter((output) => (output?.consumes ?? []).includes(reference)).map((output) => `${phase.label ?? phaseId}/${output.id}`));
    if (readers.length) throw new SingularityFlowError(`${reference} is read by ${readers.join(', ')}; take it off them first.`, { code: 'STUDIO_EPIC_OUTPUT_IN_USE' });
    const list = document.getIn(['initiativePhases', stepId, 'outputs'], true);
    if (YAML.isSeq(list)) list.items.splice(outputs.findIndex((entry) => entry?.id === outputId), 1);
    else document.setIn(['initiativePhases', stepId, 'outputs'], document.createNode(outputs.filter((entry) => entry?.id !== outputId)));
    this.portfolioChanged = true;
    this.summary.push(`Output ${reference} removed.`);
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
    const target = this.requireAgent(requireId(agentId, 'An agent ID'));
    if (this.protectedAgents.has(target.id)) {
      throw new SingularityFlowError(`${target.label} belongs to a seeded workflow, so its own skill tables are read-only. Add the skill to the skill master instead (an import without an agent) and attach it to ${target.label}; the attachment is kept in ${SKILL_ATTACHMENTS_PATH}.`, { code: 'SEEDED_WORKFLOW_READ_ONLY' });
    }
    const agent = this.touch(target);
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
    const { document: importedDocument, header: importedHeader, body: importedBody } = splitAgentText(text, agentId);
    const importedName = importedDocument.get('name');
    let renamed = false;
    if (id && importedName !== agentId) {
      importedDocument.set('name', ID.test(String(importedName)) ? agentId : `${importedName} (${agentId})`);
      const label = importedDocument.getIn(['metadata', 'sflow-label']);
      if (typeof label === 'string') importedDocument.setIn(['metadata', 'sflow-label'], `${label} (${agentId})`);
      text = `---\n${renderPreservingFormatting(importedHeader, importedDocument)}---\n${importedBody}`;
      renamed = true;
    }
    if (withoutDefaults) {
      const { document, header, body } = splitAgentText(text, agentId);
      document.deleteIn(['metadata', 'sflow-default-for']);
      text = `---\n${renderPreservingFormatting(header, document)}---\n${body}`;
    }
    const relative = existing?.relative ?? posix(path.join(this.agentsRoot, `${agentId}.agent.md`));
    const parsed = parseAgentDependencies(text, { source: relative });
    this.agents.set(agentId, {
      id: agentId, scope: 'repository', text, relative, fileName: path.basename(relative),
      label: parsed.label, description: parsed.description, tools: [...parsed.tools],
      phases: [...parsed.phases], defaultFor: [...parsed.defaultFor], body: null, touched: false,
      created: !existing, imported: true, previousText: existing?.text ?? null
    });
    const bytes = Buffer.from(text, 'utf8');
    this.recordImport('agent', { id: agentId }, staged, { id: agentId, path: relative },
      withoutDefaults || renamed ? { transforms: [...(withoutDefaults ? ['without-defaults'] : []), ...(renamed ? ['renamed'] : [])], fileSha256: sha256Of(bytes) } : {});
    this.summary.push(`${existing ? 'Updated' : 'New'} agent ${parsed.label} from ${sourceText(staged.source)}${parsed.defaultFor.length ? `, drafting ${parsed.defaultFor.map((step) => this.phaseLabel(step)).join(', ')}` : ''}.`);
  }

  addMarketplace({ id, label, index, allowedOrigins = [], repository, ref, commit, repin = false }) {
    const marketplaceId = requireId(id, 'A marketplace ID');
    const existing = this.content.marketplaces?.[marketplaceId];
    // Trusting a newer commit of the same repository marketplace moves its pin; nothing else is replaced.
    const moves = repin === true && repository !== undefined && existing?.repository === repository;
    if (existing && !moves) {
      throw new SingularityFlowError(`This repository already trusts a marketplace called '${marketplaceId}'.`, { code: 'STUDIO_MARKETPLACE_EXISTS' });
    }
    if (repository !== undefined) {
      // A Git repository with an APM manifest at its root, read at the commit `marketplace add --repo` pinned.
      const pinned = normalizeMarketplaces({ [marketplaceId]: { label: label ?? undefined, repository, ...(ref ? { ref } : {}), commit } })[marketplaceId];
      this.document.setIn(['marketplaces', marketplaceId], this.document.createNode({
        label: pinned.label, repository: pinned.repository, ...(pinned.ref ? { ref: pinned.ref } : {}), commit: pinned.commit
      }));
      this.summary.push(moves
        ? `Marketplace ${pinned.label} is now read at ${pinned.commit.slice(0, 12)} (it was ${String(existing.commit ?? '').slice(0, 12)}).`
        : `This repository trusts marketplace ${pinned.label} (${pinned.repository} at ${pinned.commit.slice(0, 12)}).`);
      return;
    }
    const marketplace = normalizeMarketplaces({ [marketplaceId]: { label: label ?? undefined, index, allowedOrigins } })[marketplaceId];
    this.document.setIn(['marketplaces', marketplaceId], this.document.createNode({
      label: marketplace.label, index: marketplace.index,
      ...(marketplace.allowedOrigins.length ? { allowedOrigins: [...marketplace.allowedOrigins] } : {})
    }));
    this.summary.push(`This repository trusts marketplace ${marketplace.label} (${marketplace.index}).`);
  }

  // -------------------------------------------------------------------------------------------
  // Integration targets: named connections after-step actions send to. Addresses and secret names
  // only; configuration never holds a secret value.

  targetNode(id, target) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new SingularityFlowError(`Integration target '${id}' needs its settings.`, { code: 'STUDIO_TARGET_INVALID' });
    }
    const { id: _ignored, ...fields } = target;
    // The configuration's own rules, so the page reports the same refusal the engine would.
    normalizeIntegrations({ targets: { [id]: fields } });
    return this.document.createNode(fields);
  }

  createTarget({ id, target }) {
    const targetId = requireId(id, 'An integration target ID');
    if (this.content.integrations?.targets?.[targetId]) {
      throw new SingularityFlowError(`There is already an integration target called '${targetId}'.`, { code: 'STUDIO_TARGET_EXISTS' });
    }
    this.document.setIn(['integrations', 'targets', targetId], this.targetNode(targetId, target));
    this.summary.push(`Integration target ${targetId} (${target.kind}) added.`);
  }

  updateTarget({ id, target }) {
    const targetId = requireId(id, 'An integration target ID');
    if (!this.content.integrations?.targets?.[targetId]) {
      throw new SingularityFlowError(`There is no integration target called '${targetId}'.`, { code: 'STUDIO_TARGET_UNKNOWN' });
    }
    this.document.setIn(['integrations', 'targets', targetId], this.targetNode(targetId, target));
    this.summary.push(`Integration target ${targetId} changed.`);
  }

  removeTarget({ id }) {
    const targetId = requireId(id, 'An integration target ID');
    const content = this.content;
    if (!content.integrations?.targets?.[targetId]) {
      throw new SingularityFlowError(`There is no integration target called '${targetId}'.`, { code: 'STUDIO_TARGET_UNKNOWN' });
    }
    const users = [
      ...Object.entries(content.phases ?? {}).filter(([, phase]) => (phase?.afterStep ?? []).some((action) => action?.target === targetId))
        .map(([phaseId]) => this.phaseLabel(phaseId)),
      ...Object.entries(content.workTypes ?? {}).flatMap(([workTypeId, type]) => Object.entries(type?.phaseOverrides ?? {})
        .filter(([, override]) => (override?.afterStep ?? []).some((action) => action?.target === targetId))
        .map(([phaseId]) => `${this.phaseLabel(phaseId)} in ${type?.label ?? workTypeId}`))
    ];
    if (users.length) {
      throw new SingularityFlowError(`Integration target ${targetId} is still used by ${users.join(', ')}. Remove those actions first.`, {
        code: 'STUDIO_TARGET_IN_USE', details: { target: targetId, users }
      });
    }
    this.document.deleteIn(['integrations', 'targets', targetId]);
    if (!Object.keys(this.content.integrations?.targets ?? {}).length) this.document.deleteIn(['integrations']);
    this.summary.push(`Integration target ${targetId} removed.`);
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
      if (!replace) throw new SingularityFlowError(`An MCP server called '${serverId}' is already declared here. Replace it deliberately, or import it under another ID.`, { code: 'STUDIO_MCP_SERVER_EXISTS' });
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
        if (this.attachments.some((attachment) => attachment.agent === agent.id)) {
          this.setFileAttachments(this.attachments.filter((attachment) => attachment.agent !== agent.id));
        }
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
      const text = agent.touched ? this.agentText(agent) : agent.text;
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

  createAgent({ id, label, description, role = 'blank', from = null, tools, instructions }) {
    const agentId = requireId(id, 'An agent ID');
    if (this.agents.has(agentId)) throw new SingularityFlowError(`An agent called '${agentId}' already exists.`, { code: 'STUDIO_AGENT_EXISTS' });
    const presets = agentRolePresets(this.content);
    const preset = presets.find((entry) => entry.id === role) ?? presets.at(-1);
    // Starting from an existing agent copies what makes it that role: its instructions, tools and
    // skills. Not the steps it drafts (a step has one default agent; the new one is assigned its own)
    // and not its remote resources, which a new agent locks itself.
    const source = from ? this.requireAgent(requireId(from, 'The agent to start from')) : null;
    const name = requireLabel(label, 'The agent');
    const what = String(description ?? '').replace(/\s+/g, ' ').trim();
    if (!what) throw new SingularityFlowError(`Say what ${name} does in one sentence.`, { code: 'STUDIO_AGENT_INVALID' });
    const toolList = [...new Set((tools ?? source?.tools ?? preset.tools).map((tool) => String(tool).trim()).filter(Boolean))];
    const starter = instructions != null ? (source ? starterInstructions(String(instructions)) : instructions)
      : source ? starterInstructions(this.agentBody(source)) : preset.instructions;
    this.agents.set(agentId, {
      id: agentId, scope: 'repository', text: null, relative: posix(path.join(this.agentsRoot, `${agentId}.agent.md`)),
      fileName: `${agentId}.agent.md`, label: name, description: what, tools: toolList, phases: [], defaultFor: [],
      body: newAgentBody(name, starter), touched: true, created: true
    });
    const skills = source ? [...this.attachedSkills(source), ...this.attachments.filter((entry) => entry.agent === source.id)]
      .filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index) : [];
    const summary = this.summary.length;
    for (const skill of skills) this.attachSkill({ skill: skill.id, agent: agentId, phases: skill.phases, use: skill.use });
    this.summary.splice(summary);
    this.summary.push(source
      ? `New agent ${name}, starting from ${source.label ?? source.id}: its instructions, ${toolList.map((tool) => TOOL_LABELS[tool] ?? tool).join(', ').toLowerCase() || 'no tools'}${skills.length ? ` and ${skills.length} skill${skills.length === 1 ? '' : 's'} (${skills.map((skill) => skill.id).join(', ')})` : ''}. It drafts no step until you choose one, and copies no remote resources.`
      : `New agent ${name}: ${toolList.map((tool) => TOOL_LABELS[tool] ?? tool).join(', ').toLowerCase() || 'no tools'}.`);
  }

  /**
   * A person's own agent folder (`call add`): the files copied unchanged under
   * singularity/user-defined/<name>/ with their manifest, and one agent whose instructions are the
   * main file's own. Its step and workflow are their own changes in the same set.
   */
  addUserDefinedAgent(change) {
    const { name, manifest, files, tools } = userDefinedAgentFiles(change);
    if (this.agents.has(name)) {
      throw new SingularityFlowError(userDefinedAgentText(this.agents.get(name), name)
        ? `A user-defined agent called '${name}' already exists; replace its folder with --replace, or add this one under another name with --name.`
        : `An agent called '${name}' already exists; add the folder under another name with --name.`, { code: 'STUDIO_AGENT_EXISTS' });
    }
    if (this.content.workTypes?.[name]) throw new SingularityFlowError(`A workflow called '${name}' already exists; add the folder under another name with --name.`, { code: 'STUDIO_WORKFLOW_EXISTS' });
    if (existsSync(path.join(this.sources.configRoot, manifest.path))) throw new SingularityFlowError(`A user-defined agent called '${name}' already exists.`, { code: 'STUDIO_AGENT_EXISTS' });
    const label = requireLabel(change.label, 'The agent');
    const description = String(change.description ?? '').replace(/\s+/g, ' ').trim();
    if (!description) throw new SingularityFlowError(`Say what ${label} does in one sentence.`, { code: 'STUDIO_AGENT_INVALID' });
    for (const file of files) this.vendored.set(file.path, file.bytes);
    this.vendored.set(manifest.path, manifest.bytes);
    this.agents.set(name, {
      id: name, scope: 'repository', relative: posix(path.join(this.agentsRoot, `${name}.agent.md`)), fileName: `${name}.agent.md`,
      text: userDefinedAgentHeader({ name, label, description, manifestSha256: change.manifestSha256 }),
      // The repository boundary every agent carries, then the main file's own instructions unchanged.
      label, description, tools, phases: [], defaultFor: [], touched: true, created: true,
      body: [REPOSITORY_AGENT_BOUNDARY, '', String(change.instructions ?? '').trim(), '', AGENT_CLARIFICATION_GUIDANCE].join('\n')
    });
    this.summary.push(`User-defined agent ${label}: its folder (${files.length} file${files.length === 1 ? '' : 's'}) copied unchanged to singularity/user-defined/${name}/; its main file's instructions are the agent's.`);
  }

  /**
   * A new copy of an existing user-defined agent's folder under the same name (`call add --replace`):
   * its files, manifest and pinned agent text; files the new folder no longer has are removed. Its
   * step and workflow are unchanged, so what the step makes cannot change here.
   */
  replaceUserDefinedAgent(change) {
    const { name, manifest, files, tools } = userDefinedAgentFiles(change);
    const agent = this.agents.get(name);
    if (!agent || !userDefinedAgentText(agent, name)) {
      throw new SingularityFlowError(`There is no user-defined agent called '${name}' to replace; add the folder without --replace.`, { code: 'STUDIO_AGENT_UNKNOWN' });
    }
    const step = this.phase(name);
    if (step && outputOf(step) !== change.output) {
      throw new SingularityFlowError(`${name}'s step makes ${outputOf(step) === 'code' ? 'code' : 'a document'}; a replaced folder keeps that. Add the folder under another name to change it.`, { code: 'STUDIO_AGENT_INVALID' });
    }
    const label = requireLabel(change.label, 'The agent');
    const description = String(change.description ?? '').replace(/\s+/g, ' ').trim();
    if (!description) throw new SingularityFlowError(`Say what ${label} does in one sentence.`, { code: 'STUDIO_AGENT_INVALID' });
    const previous = existsSync(path.join(this.sources.configRoot, manifest.path))
      ? JSON.parse(readFileSync(path.join(this.sources.configRoot, manifest.path), 'utf8')) : { files: [] };
    const kept = new Set(files.map((file) => file.path));
    for (const file of previous.files ?? []) {
      const relative = posix(path.join('singularity', 'user-defined', name, String(file.path)));
      if (!kept.has(relative)) this.vendored.set(relative, null);
    }
    for (const file of files) this.vendored.set(file.path, file.bytes);
    this.vendored.set(manifest.path, manifest.bytes);
    const entry = this.touch(agent);
    Object.assign(entry, {
      text: userDefinedAgentHeader({ name, label, description, manifestSha256: change.manifestSha256 }),
      label, description, tools,
      body: [REPOSITORY_AGENT_BOUNDARY, '', String(change.instructions ?? '').trim(), '', AGENT_CLARIFICATION_GUIDANCE].join('\n')
    });
    const removed = (previous.files ?? []).filter((file) => !kept.has(posix(path.join('singularity', 'user-defined', name, String(file.path))))).length;
    this.summary.push(`User-defined agent ${label}: its folder replaced (${files.length} file${files.length === 1 ? '' : 's'}${removed ? `, ${removed} removed` : ''}); its step and workflow are unchanged, and running Stories keep the folder they started with.`);
  }

  updateAgent({ id, label, description, tools, instructions, phases }) {
    const agent = this.touch(this.requireAgent(requireId(id, 'An agent ID')));
    if (label != null) agent.label = requireLabel(label, 'The agent');
    if (phases != null) {
      // The steps it may draft (sflow-phases); it stops drafting by default any step it no longer lists.
      if (!Array.isArray(phases) || !phases.length) throw new SingularityFlowError(`${agent.label} lists at least one step it may draft.`, { code: 'STUDIO_AGENT_INVALID' });
      agent.phases = [...new Set(phases.map((phase) => requireId(phase, 'A step ID')))];
      agent.defaultFor = agent.defaultFor.filter((phase) => agent.phases.includes(phase));
    }
    if (description != null) agent.description = String(description).replace(/\s+/g, ' ').trim() || agent.description;
    if (tools != null) agent.tools = [...new Set(tools.map(String).filter(Boolean))];
    if (instructions != null) {
      const body = String(instructions).trim();
      if (!body) throw new SingularityFlowError(`${agent.label} needs instructions.`, { code: 'STUDIO_AGENT_INVALID' });
      const attached = this.attachedSkills(agent);
      agent.body = body;
      // Instructions edited here leave the skills the agent attaches as they were.
      if (!parseAttachedSkills(body).length) {
        for (const entry of attached) {
          agent.body = upsertAgentTableRow(agent.body, 'library', [entry.id, entry.phases.join(', ') || '*', entry.use || '-'], { replace: true });
        }
      }
    }
    this.summary.push(`Agent ${agent.label} updated.`);
  }

  /**
   * An agent file this repository wrote, taken away. Refused while it drafts a step, reviews a
   * workflow, holds an MCP server, belongs to a framework workflow, or came from an import (taken
   * away with import.remove instead, so its ledger entry goes with it).
   */
  removeAgent({ id }) {
    const agent = this.requireAgent(requireId(id, 'An agent ID'));
    if (agent.scope !== 'repository' || agent.apm || this.protectedAgents.has(agent.id)) {
      throw new SingularityFlowError(`${agent.label} is not an agent file this repository owns, so it is not removed here.`, { code: 'STUDIO_AGENT_IN_USE' });
    }
    if (Object.values(this.ledger.imports ?? {}).some((entry) => entry.kind === 'agent' && entry.target?.id === agent.id)) {
      throw new SingularityFlowError(`${agent.label} was imported; remove it with its import (import.remove).`, { code: 'STUDIO_AGENT_IN_USE' });
    }
    if (agent.defaultFor.length) {
      throw new SingularityFlowError(`${agent.label} still drafts ${agent.defaultFor.map((step) => this.phaseLabel(step)).join(', ')}; choose other agents for those steps first.`, { code: 'STUDIO_AGENT_IN_USE' });
    }
    const reviews = Object.entries(this.content.workTypes ?? {}).filter(([, type]) => type?.sourceReview?.reviewerAgent === agent.id).map(([workflowId]) => workflowId);
    if (reviews.length) throw new SingularityFlowError(`${agent.label} reviews ${reviews.join(', ')}; name another reviewer there first.`, { code: 'STUDIO_AGENT_IN_USE' });
    const servers = Object.entries(this.content.mcpServers ?? {}).filter(([, server]) => (server?.agents ?? []).includes(agent.id)).map(([serverId]) => serverId);
    if (servers.length) throw new SingularityFlowError(`${agent.label} is still assigned MCP server(s) ${servers.join(', ')}; unassign them first.`, { code: 'STUDIO_AGENT_IN_USE' });
    this.agents.delete(agent.id);
    if (!agent.created) this.removedAgents.add(agent.relative);
    if (this.lock.agents?.[agent.id]) { delete this.lock.agents[agent.id]; this.lockChanged = true; }
    if (this.attachments.some((attachment) => attachment.agent === agent.id)) {
      this.setFileAttachments(this.attachments.filter((attachment) => attachment.agent !== agent.id));
    }
    this.summary.push(`Agent ${agent.label} removed.`);
  }

  async installBlueprint({ id }) {
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
      if (packagedDefault && !this.agents.get(packagedDefault.id)?.defaultFor.includes(phaseId)
          && !this.agents.get(packagedDefault.id)?.yielded?.includes(phaseId)) {
        if (!this.agents.has(packagedDefault.id)) {
          this.agents.set(packagedDefault.id, {
            id: packagedDefault.id, scope: 'bundled', text: packagedDefault.text, relative: null,
            fileName: path.basename(packagedDefault.file), label: packagedDefault.label, description: packagedDefault.description,
            tools: [...packagedDefault.tools], phases: [...packagedDefault.phases],
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
    // Canvas adoption carries the same dependency closure as CLI adoption, in the same atomic
    // candidate. Installing just phases/agents leaves the next Story without its skill master.
    const agentIds = new Set([...this.agents.values()]
      .filter((agent) => agent.defaultFor.some((phase) => installedPhases.has(phase))).map((agent) => agent.id));
    const agentSkills = [...agentIds].flatMap((id) => this.attachedSkills(this.agents.get(id)));
    const candidateFiles = new Map([...this.skillFiles, ...this.instructionFiles]);
    if (this.attachmentsChanged) candidateFiles.set(SKILL_ATTACHMENTS_PATH, skillAttachmentsText(this.attachments));
    for (const file of await packagedWorkflowSkills(this.sources.configRoot, workflowId, agentIds, agentSkills, { candidateFiles })) {
      if (file.path === SKILL_ATTACHMENTS_PATH) {
        const entries = parseSkillAttachments(file.text);
        const added = entries.filter((entry) => !this.attachments.some((current) => current.id === entry.id
          && current.agent === entry.agent && current.workflow === entry.workflow));
        if (added.length) this.setFileAttachments([...this.attachments, ...added]);
      } else if (file.path.startsWith('singularity/skill-library/')) {
        const id = file.path.split('/')[2];
        if (!this.skills.has(id)) {
          this.skills.set(id, parseLibrarySkill(file.text, { id })); this.skillFiles.set(file.path, file.text);
        }
      } else {
        const id = file.path.split('/')[2];
        if (!this.instructions.has(id)) {
          this.instructions.set(id, parseInstruction(file.text, { id })); this.instructionFiles.set(file.path, file.text);
        }
      }
    }
    this.workflows.set(workflowId, { newlyCreated: true });
    this.summary.push(`Installed blueprint ${profile.label ?? workflowId}: ${profile.phases.map((phase) => this.phaseLabel(phase)).join(' → ')}.`);
  }

  createPhase({ id, label, description, output, changesCode, inputs, approval, agent, copyOf, copyFromWorkflow, authoringSkill, clarification, afterStep, template, artifactSet, artifactFile, intent, because }) {
    const phaseId = requireId(id, 'A step ID');
    if (this.phase(phaseId)) throw new SingularityFlowError(`A step called '${phaseId}' already exists.`, { code: 'STUDIO_PHASE_EXISTS' });
    const name = requireLabel(label, 'The step');
    // What the step does (its intent, step intents Stage 3): a new step starts from it.
    const stepIntent = intent == null ? null : requireStepIntent(intent, name);
    if (stepIntent) intentAgreesWithOutput(stepIntent, { output, changesCode }, name);
    let node;
    let aligned = [];
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
      // A copy given what it is for takes that intent; settings of its source that say otherwise go, said in the summary.
      if (stepIntent) aligned = alignStepToIntent(node, stepIntent);
      this.copies.set(phaseId, source);
    } else {
      const groups = Object.keys(this.content.approvalAuthorities ?? {});
      // A step that says what it is for is signed off by its intent's group when this repository has one, else the first.
      const intentGroup = stepIntent ? intentProfile().intents[stepIntent].approvers : null;
      const group = intentGroup && groups.includes(intentGroup) ? intentGroup : groups[0];
      node = {
        ...newStepContract(phaseId, name, 'document', { intent: stepIntent }),
        approval: approval === 'none' ? 'none' : this.approvalNode(approval ?? { group }, null, { phaseId, name, reaches: this.ownSendBackReach(phaseId) })
      };
    }
    if (because != null) node.because = stepBecause(because, name, node.because);
    if (description !== undefined) {
      const text = stepDescription(description, name);
      if (text) node.description = text; else delete node.description;
    }
    this.document.setIn(['phases', phaseId], this.document.createNode(node));
    // A copy's own skill that cannot draft its new output is dropped; one the change names decides. A new step that says
    // what it is for takes its output from its intent, so only an output the change names is written.
    const dropped = stepIntent && !copyOf ? (output != null && output !== outputOf(node) ? this.setOutput(phaseId, output) : null)
      : !copyOf || (output !== undefined && output !== outputOf(node)) ? this.setOutput(phaseId, output ?? 'document') : null;
    if (changesCode != null) this.setChangesCode(phaseId, changesCode);
    if (template !== undefined && template !== null) this.document.setIn(['phases', phaseId, 'defaultTemplate'], this.templateValue(template, name));
    else if (!copyOf) this.writeTemplateIfMissing(`common/${phaseId}.md`, phaseId, name, stepIntent);
    if (artifactSet !== undefined && artifactSet !== null) {
      const setId = requireId(artifactSet, 'An artifact set ID');
      if (!this.content.artifactSets?.[setId]) throw new SingularityFlowError(`There is no artifact set '${setId}'.`, { code: 'STUDIO_ARTIFACT_SET_UNKNOWN' });
      this.document.setIn(['phases', phaseId, 'artifactSet'], setId);
      this.alignArtifactFile(phaseId, setId);
    }
    if (artifactFile !== undefined && artifactFile !== null) this.nameArtifactFile(phaseId, artifactFile, name);
    // Absent or null leaves a list as it is, as in phase.update: a new step has none, a copy keeps its source's.
    const inputList = changeList(inputs, `The inputs of ${name}`, 'STUDIO_PHASE_UNKNOWN');
    if (inputList) this.document.setIn(['phases', phaseId, 'inputs'], this.document.createNode(this.inputEntries(inputList, node.inputs ?? [])));
    // A change from an older Studio may still carry `views`: step World Model views were removed, so it is not read.
    if (copyOf && approval != null) {
      const current = approvalSummary(node.approval);
      const unchanged = approval === 'none' ? current.mode === 'none'
        : current.mode !== 'none' && JSON.stringify(approvalGroups(approval)) === JSON.stringify(current.authorities)
          && Number(approval.minimum ?? 1) === current.minimum
          && (!Array.isArray(approval.required) || JSON.stringify(approval.required) === JSON.stringify(current.requiredAuthorities))
          && (approval.rejectTo == null || JSON.stringify(approval.rejectTo) === JSON.stringify(node.approval?.rejectTo ?? null));
      if (!unchanged) {
        const signOff = this.approvalNode(approval, node.approval, { phaseId, name, reaches: this.ownSendBackReach(phaseId) });
        this.document.setIn(['phases', phaseId, 'approval'], this.document.createNode(signOff));
        this.automaticOffReason(['phases', phaseId], signOff);
      }
    }
    if (authoringSkill !== undefined) {
      if (authoringSkill === null) this.document.deleteIn(['phases', phaseId, 'authoringSkill']);
      else this.document.setIn(['phases', phaseId, 'authoringSkill'], requireAuthoringSkill(authoringSkill));
    }
    if (clarification !== undefined) {
      if (!CLARIFICATION_MODES.some((mode) => mode.id === clarification)) throw new SingularityFlowError('Clarifying questions are off, when-needed or required.', { code: 'STUDIO_CLARIFICATION_INVALID' });
      if (clarification === 'off') this.questionsOff(phaseId, node.clarification);
      else {
        this.document.setIn(['phases', phaseId, 'clarification'], this.document.createNode({ ...(node.clarification ?? {}), mode: clarification }));
        this.dropStudioReason(['phases', phaseId], 'clarification.mode', QUESTIONS_OFF_REASON);
      }
    }
    // What the new step sends after it: the list the change names, so a copy can also drop its source's.
    let actionCount = 0;
    if (afterStep !== undefined && afterStep !== null) {
      const actions = studioActions(afterStep, name);
      actionCount = actions.length;
      if (actions.length) this.document.setIn(['phases', phaseId, 'afterStep'], this.document.createNode(actions));
      else if (this.document.hasIn(['phases', phaseId, 'afterStep'])) this.document.deleteIn(['phases', phaseId, 'afterStep']);
    }
    const agentId = agent ?? (copyOf ? [...this.agents.values()].find((entry) => entry.defaultFor.includes(copyOf))?.id : null);
    if (!agentId) throw new SingularityFlowError(`Choose the agent that drafts ${name}.`, { code: 'STUDIO_PHASE_AGENT_REQUIRED' });
    this.setDefaultAgent(phaseId, requireId(agentId, 'An agent ID'));
    const forWhat = stepIntent ? ` It ${stepIntentChoice(stepIntent).label.toLowerCase()} (intent ${stepIntent}).` : '';
    this.summary.push(copyOf
      ? `New step ${name}, a copy of ${this.phaseLabel(copyOf)}, drafted by ${this.agentLabel(agentId)}.${forWhat}${aligned.length ? ` As a ${stepIntent} step it no longer keeps ${listWords(aligned)} from ${this.phaseLabel(copyOf)}.` : ''}`
      : `New step ${name}: drafted by ${this.agentLabel(agentId)}, ${node.approval === 'none' ? 'no sign-off' : `signed off by ${this.content.approvalAuthorities?.[approvalSummary(node.approval).authorities[0]]?.label ?? 'its group'}`}.${forWhat}`);
    if (actionCount) this.summary.push(`${name} sends ${actionCount} ${actionCount === 1 ? 'action' : 'actions'} after it.`);
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
      // { phase, optional } says whether the step can go without the input; a bare ID keeps what it has.
      const optional = isObject(input) && typeof input.optional === 'boolean' ? input.optional : null;
      const id = requireId(isObject(input) ? input.phase : input, 'An input step');
      if (!this.pendingPhases.has(id)) this.requirePhase(id);
      const own = entryFor(id);
      const replaced = own === undefined && this.copies.has(id) ? entryFor(this.copies.get(id)) : undefined;
      const entry = own !== undefined ? structuredClone(own) : isObject(replaced) ? { ...structuredClone(replaced), phase: id } : id;
      if (optional === null) return entry;
      const next = isObject(entry) ? { ...entry } : { phase: id };
      if (optional) next.optional = true; else delete next.optional;
      return Object.keys(next).length === 1 && next.phase === id ? id : next;
    });
  }

  updatePhase({ id, workflow, label, description, output, changesCode, inputs, approval, clarification, clarificationPolicy, authoringSkill, afterStep, qualityCommands, template, artifactSet, artifactFile, intent, because, reset }) {
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
    if (intent !== undefined) {
      // What the step is for lives on the step itself: a step means one thing in every workflow (spec §7.1).
      if (intent === null) {
        if (this.document.hasIn(['phases', phaseId, 'intent'])) this.document.deleteIn(['phases', phaseId, 'intent']);
      } else {
        const value = requireStepIntent(intent, name);
        const current = this.phase(phaseId)?.intent;
        if (shared && typeof current === 'string' && current !== value) {
          const others = users.filter((entry) => entry !== workflow).map((entry) => this.content.workTypes?.[entry]?.label ?? entry);
          throw new SingularityFlowError(`${name} is a ${current} step in ${listWords(others)} too, and a step means one thing in every workflow. Copy ${name} for this workflow and give the copy intent ${value}.`,
            { code: 'STUDIO_INTENT_SHARED', details: { step: phaseId, intent: current, workflows: users, nextAction: COPY_ROUTE } });
        }
        intentAgreesWithOutput(value, { output: output ?? outputOf(this.phase(phaseId)), changesCode: changesCode ?? (outputOf(this.phase(phaseId)) === 'code' ? true : undefined) }, name);
        this.document.setIn(['phases', phaseId, 'intent'], value);
      }
      changed.push('what it is for');
    }
    if (output != null) { dropped = this.setOutput(phaseId, output); changed.push('output'); }
    if (changesCode != null) { this.setChangesCode(phaseId, changesCode); changed.push('whether it changes code'); }
    if (description !== undefined) {
      // What the step is for is the step's own, wherever it is used.
      const text = stepDescription(description, name);
      if (text) this.document.setIn(['phases', phaseId, 'description'], text);
      else if (this.document.hasIn(['phases', phaseId, 'description'])) this.document.deleteIn(['phases', phaseId, 'description']);
      changed.push('description');
    }
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
      // Send-back targets set for one workflow are checked against that workflow; the step's own
      // against every workflow they reach.
      const reaches = scope === override ? [workflow] : this.ownSendBackReach(phaseId);
      const signOff = this.approvalNode(approval, existing === 'none' ? null : existing, { phaseId, reaches });
      this.document.setIn([...scope, 'approval'], this.document.createNode(signOff));
      this.automaticOffReason(scope, signOff);
      changed.push(approval !== 'none' && approval.rejectTo != null ? 'sign-off and send-back targets' : 'sign-off');
    }
    // A change from an older Studio may still carry `views`: step World Model views were removed, so it is not read.
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
    if (afterStep !== undefined) {
      // What the step sends after it is submitted, approved or rejected: per workflow on a shared
      // step, like sign-off. An empty list on a workflow's override stops the step's own actions there.
      const scope = scopeFor('afterStep');
      const actions = studioActions(afterStep, name);
      if (actions.length || scope === override) this.document.setIn([...scope, 'afterStep'], this.document.createNode(actions));
      else if (this.document.hasIn([...scope, 'afterStep'])) this.document.deleteIn([...scope, 'afterStep']);
      changed.push('actions after the step');
    }
    if (qualityCommands !== undefined) {
      // The checks sflow runs when the step is submitted: per workflow on a shared step, like sign-off.
      const scope = scopeFor('qualityCommands');
      if (!Array.isArray(qualityCommands) || qualityCommands.length > 20) {
        throw new SingularityFlowError(`The checks of ${name} are a list of at most 20 commands.`, { code: 'STUDIO_CHECKS_INVALID' });
      }
      const ids = new Set();
      qualityCommands.forEach((command, index) => {
        let normalized;
        try { normalized = normalizeExternalCommand(command, index); }
        catch (error) { throw new SingularityFlowError(`A check of ${name} is not valid: ${error.message}`, { code: 'STUDIO_CHECKS_INVALID' }); }
        if (ids.has(normalized.id)) throw new SingularityFlowError(`${name} has two checks called '${normalized.id}'.`, { code: 'STUDIO_CHECKS_INVALID' });
        ids.add(normalized.id);
      });
      if (qualityCommands.length || scope === override) this.document.setIn([...scope, 'qualityCommands'], this.document.createNode(structuredClone(qualityCommands)));
      else if (this.document.hasIn([...scope, 'qualityCommands'])) this.document.deleteIn([...scope, 'qualityCommands']);
      changed.push('checks');
    }
    // The whole clarification policy (mode, maxQuestions, topics, markers), as `clarificationPolicy` (the
    // builder's step.clarify) or as a `clarification` object (workflow fix), checked by the loader's own
    // rule. Like sign-off and inputs, a shared step gets it for the named workflow only, so the questions
    // another workflow asks at the same step stay as they are; an override replaces the step's own policy.
    const policy = clarificationPolicy ?? (isObject(clarification) ? clarification : null);
    if (policy != null) {
      if (typeof policy !== 'object' || Array.isArray(policy)) {
        throw new SingularityFlowError(`The clarifying questions of ${name} are { mode, maxQuestions, topics, markers }.`, { code: 'STUDIO_CLARIFICATION_INVALID' });
      }
      try { normalizeClarificationPolicy(policy); }
      catch (error) { throw new SingularityFlowError(`The clarifying questions of ${name}: ${error.message}`, { code: 'STUDIO_CLARIFICATION_INVALID' }); }
      const given = Object.fromEntries(['mode', 'maxQuestions', 'topics', 'markers'].filter((key) => policy[key] !== undefined).map((key) => [key, structuredClone(policy[key])]));
      this.document.setIn([...scopeFor('clarification'), 'clarification'], this.document.createNode(given));
      changed.push('questions');
    } else if (clarification != null) {
      if (!CLARIFICATION_MODES.some((mode) => mode.id === clarification)) throw new SingularityFlowError('Clarifying questions are off, when-needed or required.', { code: 'STUDIO_CLARIFICATION_INVALID' });
      if (clarification === 'off') this.questionsOff(phaseId, this.phase(phaseId)?.clarification);
      else {
        this.document.setIn(['phases', phaseId, 'clarification'], this.document.createNode({ mode: clarification }));
        this.dropStudioReason(['phases', phaseId], 'clarification.mode', QUESTIONS_OFF_REASON);
      }
      changed.push('questions');
    }
    if (reset != null) {
      // Settings given back to the step's intent (workflow assess): taken from this workflow's own settings for the step
      // where it has them, else from the step itself, which a step other workflows share cannot do.
      if (!Array.isArray(reset) || reset.some((setting) => !BECAUSE_SETTINGS.includes(setting))) {
        throw new SingularityFlowError(`What ${name} gives back to its intent is a list of its settings, from: ${BECAUSE_SETTINGS.join(', ')}.`, { code: 'STUDIO_RESET_INVALID', details: { nextAction: REASON_ROUTE } });
      }
      for (const setting of reset) {
        const keys = setting === 'clarification.mode' ? ['clarification', 'mode'] : setting.split('.');
        if (override && this.document.hasIn([...override, ...keys])) { this.document.deleteIn([...override, ...keys]); continue; }
        if (!this.document.hasIn(['phases', phaseId, ...keys])) continue;
        if (shared) {
          throw new SingularityFlowError(`${name} sets ${setting} itself, and other workflows use it too, so taking it away changes them. Copy ${name} for this workflow, or leave the setting.`, { code: 'STUDIO_INTENT_SHARED', details: { step: phaseId, nextAction: COPY_ROUTE } });
        }
        this.document.deleteIn(['phases', phaseId, ...keys]);
      }
      changed.push('settings given back to its intent');
    }
    if (because !== undefined) {
      // Why the step sets a setting its intent would give otherwise: per workflow on a shared step, like sign-off.
      const scope = scopeFor('because');
      const next = because === null ? {} : stepBecause(because, name, valueAt(scope, 'because'));
      if (Object.keys(next).length) this.document.setIn([...scope, 'because'], this.document.createNode(next));
      else if (this.document.hasIn([...scope, 'because'])) this.document.deleteIn([...scope, 'because']);
      changed.push('why it differs from its intent');
    }
    if (template !== undefined) {
      // A workflow's own template for a shared step lives in its templateOverrides; otherwise the
      // step's defaultTemplate changes wherever the step is used. null takes the setting away.
      const value = template === null ? null : this.templateValue(template, name);
      const overridePath = workflow ? ['workTypes', workflow, 'templateOverrides', phaseId] : null;
      const perWorkflow = overridePath && (shared || this.document.getIn(overridePath) !== undefined);
      const target = perWorkflow ? overridePath : ['phases', phaseId, 'defaultTemplate'];
      if (value === null) {
        if (this.document.hasIn(target)) this.document.deleteIn(target);
        if (perWorkflow && !Object.keys(this.content.workTypes?.[workflow]?.templateOverrides ?? {}).length
            && this.document.hasIn(['workTypes', workflow, 'templateOverrides'])) this.document.deleteIn(['workTypes', workflow, 'templateOverrides']);
      } else this.document.setIn(target, value);
      changed.push('template');
    }
    if (artifactSet !== undefined) {
      if (artifactSet === null) {
        if (this.document.hasIn(['phases', phaseId, 'artifactSet'])) this.document.deleteIn(['phases', phaseId, 'artifactSet']);
      } else {
        const setId = requireId(artifactSet, 'An artifact set ID');
        if (!this.content.artifactSets?.[setId]) throw new SingularityFlowError(`There is no artifact set '${setId}'.`, { code: 'STUDIO_ARTIFACT_SET_UNKNOWN' });
        this.document.setIn(['phases', phaseId, 'artifactSet'], setId);
        this.alignArtifactFile(phaseId, setId);
      }
      changed.push('artifact set');
    }
    if (artifactFile !== undefined && artifactFile !== null) { this.nameArtifactFile(phaseId, artifactFile, name); changed.push('file'); }
    if (changed.length) this.summary.push(`${label ?? name}: ${changed.join(', ')} changed${shared && workflow && (inputs != null || approval != null || clarificationPolicy != null || isObject(clarification) || authoringSkill !== undefined || afterStep !== undefined || template !== undefined) ? ` for ${this.content.workTypes?.[workflow]?.label ?? workflow} only` : ''}.`);
    const droppedLine = this.droppedSkillLine(phaseId, label ?? name, dropped);
    if (droppedLine) this.summary.push(droppedLine);
  }

  /** The file a step writes, renamed in its folder; a step in an artifact set writes the set's primary. */
  nameArtifactFile(phaseId, value, name) {
    const fileName = String(value ?? '').trim();
    if (!ARTIFACT_FILE.test(fileName)) {
      throw new SingularityFlowError(`The file ${name} writes is a .md file name without folders, like vendor-brief.md.`, { code: 'STUDIO_ARTIFACT_INVALID' });
    }
    const setId = this.phase(phaseId)?.artifactSet;
    if (setId !== undefined && posix(String(this.content.artifactSets?.[setId]?.primary ?? '')) !== fileName) {
      throw new SingularityFlowError(`${name} is in artifact set ${setId}, so the file it writes is the set's primary member.`, { code: 'STUDIO_ARTIFACT_INVALID' });
    }
    this.setArtifactFile(phaseId, fileName);
  }

  assignAgent({ phase, agent }) {
    const phaseId = this.requirePhase(requireId(phase, 'A step ID'));
    const agentId = requireId(agent, 'An agent ID');
    const previous = this.setDefaultAgent(phaseId, agentId);
    const users = this.usedBy(phaseId);
    this.summary.push(`${this.phaseLabel(phaseId)} is now drafted by ${this.agentLabel(agentId)}${previous ? ` (was ${this.agentLabel(previous)})` : ''}${users.length > 1 ? `, in all ${users.length} workflows that use it` : ''}.`);
  }

  createWorkflow({ id, label, description, phases, copyOf = null, omits = null }) {
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
    // A workflow that leaves a responsibility undone says so (a user-defined agent's one code step omits
    // scope); configuration validation checks each entry.
    if (Array.isArray(omits) && omits.length) {
      node.omits = omits.map((entry) => ({ responsibility: String(entry?.responsibility ?? ''), reason: String(entry?.reason ?? '').trim(), authority: String(entry?.authority ?? '') }));
    }
    this.document.setIn(['workTypes', workflowId], this.document.createNode(node));
    if (copyOf) {
      const copiedSkills = this.attachments.filter((entry) => entry.workflow === copyOf)
        .filter((entry) => !entry.phases.length || entry.phases.some((phase) => ids.includes(phase)))
        .map((entry) => ({ ...entry, workflow: workflowId, phases: entry.phases.filter((phase) => ids.includes(phase)) }));
      if (copiedSkills.length) this.setFileAttachments([...this.attachments, ...copiedSkills]);
    }
    this.workflows.set(workflowId, { newlyCreated: true });
    this.summary.push(`New workflow ${name}${copied ? `, a copy of ${copied}` : ''}: ${ids.map((phase) => this.phaseLabel(phase)).join(' → ')}.`);
  }

  updateWorkflow({ id, label, description, phases, reworkLoops, decisions, plannedClaims, sourceReview, omits }) {
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
      this.setFileAttachments(this.attachments.flatMap((entry) => {
        if (entry.workflow !== workflowId || !entry.phases.length) return [entry];
        const remaining = entry.phases.filter((id) => ids.includes(id));
        return remaining.length ? [{ ...entry, phases: remaining }] : [];
      }));
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
      // A loop's first step is a person's to approve (phase-roles.mjs): one its workflow approved automatically (a shipped
      // test step's, since step intents Stage 7) is given back to its people here, with the reason, so adding the loop
      // never leaves the workflow refused.
      for (const from of new Set(loops.map((loop) => loop.from))) this.loopSourceToPeople(workflowId, from);
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
    if (plannedClaims !== undefined && plannedClaims !== null) {
      // 'infer' takes the declaration away, so the engine works the claims out from the steps again
      // and pins what it found; an object names the clause steps and each code step's owner.
      if (plannedClaims === 'infer') {
        if (this.document.hasIn(['workTypes', workflowId, 'plannedClaims'])) this.document.deleteIn(['workTypes', workflowId, 'plannedClaims']);
      } else {
        if (!isObject(plannedClaims) || !Array.isArray(plannedClaims.clausePhases) || !plannedClaims.clausePhases.length
            || !isObject(plannedClaims.owners)) {
          throw new SingularityFlowError(`${name}'s planned claims name at least one step that defines clauses, and an owner for each code step.`, { code: 'STUDIO_PLANNED_CLAIMS_INVALID' });
        }
        const clausePhases = plannedClaims.clausePhases.map((phase) => this.requirePhase(requireId(phase, 'A clause step')));
        const owners = Object.fromEntries(Object.entries(plannedClaims.owners)
          .map(([code, owner]) => [this.requirePhase(requireId(code, 'A code step')), this.requirePhase(requireId(owner, 'A claim owner'))]));
        this.document.setIn(['workTypes', workflowId, 'plannedClaims'], this.document.createNode({ mode: 'required', clausePhases, owners }));
      }
      changed.push('planned claims');
    }
    // Written as authored, or taken away with null; the whole candidate is validated afterwards, so an
    // unknown field, step or reviewer is refused with the engine's own message.
    for (const [field, value, words] of [['sourceReview', sourceReview, 'review of each step'], ['omits', omits, 'responsibilities it leaves out']]) {
      if (value === undefined) continue;
      if (value === null || (Array.isArray(value) && !value.length)) {
        if (this.document.hasIn(['workTypes', workflowId, field])) this.document.deleteIn(['workTypes', workflowId, field]);
      } else if (field === 'sourceReview' ? isObject(value) : Array.isArray(value)) {
        this.document.setIn(['workTypes', workflowId, field], this.document.createNode(structuredClone(value)));
      } else {
        throw new SingularityFlowError(`${name}'s ${words} must be ${field === 'sourceReview' ? 'a map' : 'a list'}.`, { code: 'STUDIO_WORKFLOW_INVALID' });
      }
      changed.push(words);
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
    // Source review checks a step by what it does (it defines the scope or plans the claims), so
    // a copy, which does the same, is reviewed in its place.
    if (Array.isArray(type.sourceReview?.phases) && type.sourceReview.phases.includes(from)) set(['sourceReview', 'phases'], type.sourceReview.phases.map(swap), 'source review');
    // Auto may stop at the step, by its bare ID or after one of its milestones (published:<step>).
    const stop = typeof type.auto?.defaultUntil === 'string' ? /^(?:(published|submitted|phase-complete):)?(.+)$/.exec(type.auto.defaultUntil) : null;
    if (stop?.[2] === from) set(['auto', 'defaultUntil'], stop[1] ? `${stop[1]}:${to}` : to, 'where Auto stops');
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
    const context = content.contextPolicy?.phaseOverrides;
    if (isObject(context) && Object.hasOwn(context, from) && !Object.hasOwn(context, to)) {
      this.document.setIn(['contextPolicy', 'phaseOverrides', to], this.document.createNode(structuredClone(context[from])));
      moved.add('context handling');
    }
  }

  /** Pin planned claims, trim agents to existing steps, and check every step has one agent. */
  finalize(problems) {
    for (const skill of this.skills.values()) for (const id of skill.instructionRefs ?? []) {
      if (this.instructions.has(id)) continue;
      const near = nearestNames(id, [...this.instructions.keys()], { limit: 1 });
      problems.push({ code: 'INSTRUCTION_REFERENCE_MISSING', subject: { kind: 'skill', id: skill.id },
        message: `Skill '${skill.id}' uses instruction '${id}', which does not exist.${near.length ? ` Did you mean '${near[0]}'?` : ''} `
          + 'Fix the ID, remove its reference, or create the instruction in this change set.' });
    }
    this.rewireCopies();
    for (const [skillId, index] of this.updatedSkills) {
      const skill = this.skills.get(skillId);
      const users = skill ? [...this.agents.values()].filter((agent) => this.usesSkill(agent, skillId)).map((agent) => agent.label) : [];
      users.push(...this.attachments.filter((entry) => entry.workflow && entry.id === skillId).map((entry) => `workflow ${entry.workflow}`));
      if (users.length) this.summary[index] = `Skill ${skill.label} updated; ${users.join(', ')} use${users.length === 1 ? 's' : ''} the new text in Stories started from now on.`;
    }
    for (const [workflowId, { newlyCreated }] of this.workflows) {
      try { pinAuthoredStoryPlannedClaims(this.document, STORES.story, workflowId, { newlyCreated }); }
      catch (error) { problems.push({ code: error?.code ?? 'STUDIO_PLANNED_CLAIMS', message: error.message, subject: { kind: 'workflow', id: workflowId } }); }
    }
    const phaseIds = new Set(Object.keys(this.content.phases ?? {}));
    if (this.apmAgentsChanged) this.syncApmAgents(phaseIds, problems);
    for (const agent of this.agents.values()) {
      if (agent.yielded?.some((phase) => !phaseIds.has(phase))) {
        agent.yielded = agent.yielded.filter((phase) => phaseIds.has(phase));
        this.touch(agent);
      }
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
    if (this.presenceChange && this.presenceChange.after !== this.presenceChange.before) files.push({ ...this.presenceChange });
    for (const [relative, change] of this.constitutionChanges) {
      const after = renderStudioConstitution(change, this.sources.constitutions, this.content);
      const before = this.sources.constitutions.files.get(relative)?.text ?? null;
      if (after !== before) files.push({ path: relative, before, after });
    }
    for (const id of this.constitutionPolicies) {
      const policy = constitutionPolicy(this.content.workTypes[id].constitution);
      if (policy.mode === 'off') continue;
      const text = files.find(file => file.path === policy.path)?.after ?? this.sources.constitutions.files.get(policy.path)?.text;
      if (!text) throw new SingularityFlowError('Define the constitution before enabling it on this workflow.', { code: 'STUDIO_CONSTITUTION_INVALID' });
      const checked = parseConstitution(text, { resolution: resolveWorkType(validateDefinition(this.content), id), allowExample: false });
      if (checked.findings.length) throw new SingularityFlowError(checked.findings.map(item => item.message).join('; '), { code: 'STUDIO_CONSTITUTION_INVALID' });
    }
    if (this.portfolioChanged && this.portfolioDocument) {
      const portfolio = renderPreservingFormatting(this.sources.portfolioText, this.portfolioDocument);
      if (portfolio !== this.sources.portfolioText) files.push({ path: PORTFOLIO_PATH, before: this.sources.portfolioText, after: portfolio });
    }
    // Only a change in content rewrites workflow.yml: re-serializing an untouched document can still
    // re-wrap long lines, and a change set that only imports a skill must not touch the file at all.
    if (JSON.stringify(this.document.toJS() ?? {}) !== JSON.stringify(this.sources.raw ?? {})) {
      const workflow = renderPreservingFormatting(this.sources.definitionText, this.document);
      if (workflow !== this.sources.definitionText) files.push({ path: WORKFLOW_PATH, before: this.sources.definitionText, after: workflow });
    }
    for (const agent of this.agents.values()) {
      if (!agent.touched && !agent.imported) continue;
      const original = agent.imported ? agent.previousText : agent.text;
      const before = agent.scope === 'repository' && original && !agent.created ? original : null;
      files.push({ path: agent.relative, before, after: this.rendered.get(agent.id) ?? (agent.touched ? this.agentText(agent) : agent.text) });
    }
    for (const relative of this.removedAgents) {
      const before = await readFile(path.join(this.sources.configRoot, relative), 'utf8').catch(() => null);
      if (before != null) files.push({ path: relative, before, after: null });
    }
    for (const [relative, content] of this.templates) {
      const after = typeof content === 'string' ? content : content.copyFrom ? await readFile(content.copyFrom, 'utf8') : content.content;
      const before = content?.replace ? await readFile(path.join(this.sources.configRoot, relative), 'utf8').catch(() => null) : null;
      files.push({ path: relative, before, after });
    }
    for (const [relative, text] of [...this.skillFiles, ...this.instructionFiles]) {
      const before = await readFile(path.join(this.sources.configRoot, relative), 'utf8').catch(() => null);
      if (text == null && before == null) continue;
      files.push({ path: relative, before, after: text });
    }
    if (this.attachmentsChanged) {
      files.push({ path: SKILL_ATTACHMENTS_PATH, before: this.sources.attachmentsText, after: skillAttachmentsText(this.attachments) });
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
    return [...warnings, ...this.copyWarnings()];
  }

  /**
   * What a copy cannot take along, said at Check rather than lost at run time: the engine governs
   * a step by what it does, never by its name, but a specialised skill still picks up its built-in
   * step by name, and an agent's remote skills and templates name the steps they are for.
   */
  copyWarnings() {
    const warnings = [];
    for (const [copyId, source] of this.copies) {
      const node = this.phase(copyId);
      if (!node) continue;
      const copy = this.phaseLabel(copyId);
      const original = this.phaseLabel(source);
      // The skill that would take the copy were it still called by its step's name.
      const byName = node.authoringSkill == null ? legacyAuthoringSkill({ ...node, id: source }) : null;
      if (byName && !legacyAuthoringSkill({ ...node, id: copyId })) {
        warnings.push({
          code: 'STUDIO_COPY_SKILL_BY_NAME',
          message: `/${byName} takes ${original} by its name when the step names no drafting skill, but it does not take ${copy}. To draft ${copy} with /${byName}, choose it under Drafted with.`,
          subject: { kind: 'phase', id: copyId }
        });
      }
      const agent = [...this.agents.values()].find((entry) => entry.defaultFor.includes(copyId));
      if (!agent) continue;
      let parsed;
      try {
        const text = this.rendered.get(agent.id) ?? (agent.touched ? this.agentText(agent) : agent.text);
        parsed = parseAgentDependencies(text, { source: agent.relative ?? agent.fileName ?? `${agent.id}.agent.md`, agentId: agent.id });
      } catch { continue; }
      const scoped = [...parsed.skills, ...parsed.templates].filter((entry) => entry.phases.includes(source) && !entry.phases.includes(copyId))
        .concat(parsed.generated.filter((entry) => entry.phase === source));
      for (const entry of scoped) {
        warnings.push({
          code: 'STUDIO_COPY_AGENT_RESOURCE',
          message: `${agent.label} uses ${RESOURCE_WORDS[entry.type]} ${entry.id} only in ${original}, so ${copy} is drafted without it. To keep it, import it again with ${copy} among its steps.`,
          subject: { kind: 'agent', id: agent.id }
        });
      }
    }
    return warnings;
  }
}

const RESOURCE_WORDS = Object.freeze({ skill: 'skill', template: 'template', generated: 'generated artifact' });

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
  if (source?.kind === 'marketplace-skill') return `marketplace ${source.marketplace} (${source.entry}${source.version ? ` ${source.version}` : ''})`;
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
  const raw = parseYamlText(definitionText) ?? {};
  let definition = null;
  try { definition = await loadDefinition(root); } catch { definition = null; }
  const agents = (await discoverAgents(root)).filter((agent) => agent.scope !== 'plugin');
  const ledgerText = await readFile(path.join(configRoot, IMPORTS_LOCK_PATH), 'utf8').catch(() => null);
  const agentLockText = await readFile(path.join(configRoot, AGENT_LOCK_PATH), 'utf8').catch(() => null);
  const agentLock = agentLockText ? parseYamlText(agentLockText) : { version: 1, agents: {} };
  const portfolioText = await readFile(path.join(configRoot, PORTFOLIO_PATH), 'utf8').catch(() => null);
  if (agentLock?.version !== 1 || !agentLock.agents || typeof agentLock.agents !== 'object') {
    throw new SingularityFlowError(`${AGENT_LOCK_PATH} is invalid.`, { code: 'AGENT_LOCK_INVALID' });
  }
  return {
    root, configRoot, definitionText, raw, definition, agents, bundledAgents: await bundledAgents(),
    ledger: await loadImportsLedger(configRoot), ledgerText, agentLock, agentLockText,
    library: await loadSkillLibrary(configRoot),
    instructions: await loadInstructionLibrary(configRoot),
    constitutions: await studioConstitutions(configRoot, raw),
    agentShas: new Map(agents.map((agent) => [agent.id, agent.sha256])),
    imports: options.imports ?? new Map(),
    templatesRoot: posix(raw.templatesRoot ?? definition?.templatesRoot ?? 'singularity/templates'),
    starter: await packagedDefinition(),
    portfolio: await loadPortfolio(root, { required: false }).catch(() => null),
    portfolioText,
    attachments: await readSkillAttachments(root),
    attachmentsText: await readFile(path.join(configRoot, SKILL_ATTACHMENTS_PATH), 'utf8').catch(() => null),
    protectedAgents: (await seededWorkflowProtection(raw, portfolioText ? parseYamlText(portfolioText) ?? {} : {}, agents)).agents
  };
}

/**
 * Apply a change set to a candidate copy and validate it whole. With `write`, the changed files are
 * written to `root` — call that only where the configuration really lives: a proposal clone, or a
 * local authority's working tree. Without it nothing is written.
 */
export async function planStudioChangeSet(root, changeSet, { write = false, imports = null, fetchImpl = globalThis.fetch, inspect = null, check = true, proposing = false } = {}) {
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
  const expectedPortfolio = changeSet.base?.portfolioSha256;
  if (expectedPortfolio && sources.portfolioText != null && expectedPortfolio !== sha256(sources.portfolioText)) {
    throw new SingularityFlowError('The Epic workflow configuration changed since Workflow Studio loaded it. Reload the Studio, review the newer configuration, and apply your changes again.', {
      code: 'STUDIO_BASE_CHANGED', details: { expected: expectedPortfolio, actual: sha256(sources.portfolioText) }
    });
  }
  const expectedAgents = changeSet.base?.agentsSha256;
  const actualAgents = agentsSha256(sources.agents);
  if (expectedAgents && expectedAgents !== actualAgents) {
    throw new SingularityFlowError('The agent configuration changed since Workflow Studio loaded it. Reload the Studio, review the newer agents, and apply your changes again.', {
      code: 'STUDIO_BASE_CHANGED', details: { expected: expectedAgents, actual: actualAgents }
    });
  }
  const expectedAttachments = changeSet.base?.attachmentsSha256;
  const actualAttachments = sha256(sources.attachmentsText ?? '');
  if (expectedAttachments && expectedAttachments !== actualAttachments) {
    throw new SingularityFlowError('The skill attachments changed since Workflow Studio loaded them. Reload the Studio, review the newer attachments, and apply your changes again.', {
      code: 'STUDIO_BASE_CHANGED', details: { expected: expectedAttachments, actual: actualAttachments }
    });
  }
  if (changeSet.base?.instructionsSha256 && changeSet.base.instructionsSha256 !== instructionCatalogHash(sources.instructions)) {
    throw new SingularityFlowError('Reusable instructions changed since Studio loaded. Reload and review the newer definitions.', { code: 'STUDIO_BASE_CHANGED' });
  }
  if (changeSet.base?.constitutionsSha256 && changeSet.base.constitutionsSha256 !== sources.constitutions.sha256) {
    throw new SingularityFlowError('The constitution changed since Studio loaded. Reload and review the newer articles.', { code: 'STUDIO_BASE_CHANGED' });
  }
  const changes = orderChanges(changeSet.changes);
  const candidate = new StudioCandidate(sources, finalWorkflowPhases(sources, changes));
  const problems = [];
  candidate.expect(changes);
  candidate.fastPathProfile = (await import('./fast-path.mjs')).fastPathProfile;
  for (const change of changes) {
    try { await candidate.apply(change); }
    catch (error) {
      const subjectId = change?.id ?? change?.phase ?? null;
      problems.push({ code: error?.code ?? 'STUDIO_CHANGE_INVALID', message: error.message, change: change?.op ?? null, ...(subjectId ? { subject: { kind: String(change?.op ?? '').split('.')[0], id: subjectId } } : {}) });
    }
  }
  if (!problems.length) candidate.finalize(problems);
  let files = [];
  if (!problems.length) {
    try { files = await candidate.files(); }
    catch (error) { problems.push({ code: error?.code ?? 'STUDIO_CHANGE_INVALID', message: error.message }); }
  }
  // The one check every way of making a workflow runs (src/workflow-autofix.mjs): each workflow this change
  // set adds or changes is judged as approval will judge it; a step's template that lacks only placeholders
  // gets them in this change set, and any other problem it adds is shown here and refused when it is
  // proposed (`proposing`), never first at approval [owner, 2026-11-18]. A local edit with such a problem is
  // still written, as an unfinished draft is (obligationFindings): it reaches no approval, and the same
  // warning says why no Story can start from it yet.
  let checked = null;
  const workflowFile = !problems.length && check ? files.find((entry) => entry.path === WORKFLOW_PATH && entry.after != null) : null;
  const autofix = workflowFile ? await import('./workflow-autofix.mjs') : null;
  const changedWorkflows = autofix ? autofix.changedWorkflows(sources.raw, (() => { try { return parseYamlText(asText(workflowFile.after)) ?? {}; } catch { return {}; } })()) : [];
  if (changedWorkflows.length) {
    checked = await autofix.checkCandidate(sources.configRoot,
      files.map((file) => ({ path: file.path, content: file.after == null ? null : asText(file.after) })), { workflows: changedWorkflows });
    const byPath = new Map(checked.files.map((file) => [file.path, file]));
    files = files.map((file) => (byPath.get(file.path)?.content != null && checked.repairs.some((entry) => entry.path === file.path)
      ? { ...file, after: byPath.get(file.path).content } : file));
    for (const file of checked.files.filter((entry) => entry.repaired)) files.push({ path: file.path, before: file.before, after: file.content });
  }
  // A framework setting this change set gives a step, other than what the step's intent gives, says why (step intents
  // §7.5): refused here, with the two ways on. One written before intents, which the change set leaves as it was,
  // stays a warning in workflow check. Configuration's own refusal comes first: a reason would not let a plan step be
  // approved automatically, so that refusal, not the reason, is what to fix.
  const writtenWorkflow = problems.length ? null : files.find((entry) => entry.path === WORKFLOW_PATH && entry.after != null);
  let reasonProblems = [];
  if (writtenWorkflow) {
    let afterDefinition = null;
    try { afterDefinition = parseYamlText(asText(writtenWorkflow.after)) ?? {}; } catch { afterDefinition = null; }
    if (afterDefinition) reasonProblems = intentReasonProblems(sources.raw ?? {}, afterDefinition, changeSet.changes ?? []);
  }
  // `inspect` reads the configuration as it would be after the change set: the validated copy, or the
  // configuration itself when nothing would change.
  let inspection = null;
  const inspectCandidate = inspect ? async (candidateRoot) => { inspection = await inspect(candidateRoot); } : null;
  if (!problems.length && files.length) {
    try {
      await validateStudioCandidate(sources, files, inspectCandidate, { approved: proposing || approvedConfigurationIn(root) });
    } catch (error) {
      // The located problems say where in the changed file; the person fixes the draft from them.
      const located = error?.details?.configurationProblems;
      problems.push({ code: error?.code ?? 'CONFIGURATION_INVALID', message: String(error.message).replace(/^Change was not saved because configuration validation failed: /, ''),
        ...(Array.isArray(located) && located.length ? { located } : {}),
        // A refusal that names its way out keeps it (a skill the change would leave missing: skill-library-problems.mjs).
        ...(error?.details?.nextAction ? { nextAction: error.details.nextAction, recoveryCommands: error.details.recoveryCommands ?? [] } : {}) });
    }
  } else if (!problems.length && inspectCandidate) await inspectCandidate(root);
  if (!problems.length) problems.push(...reasonProblems);
  const obligationWarnings = problems.length ? [] : obligationFindings(files, [...candidate.workflows.keys()]);
  // What approval would refuse and SFlow cannot add itself: shown in a preview, refused when proposed.
  const refused = problems.length ? [] : (checked?.problems ?? []).map((problem) => ({ code: 'STUDIO_WORKFLOW_PROBLEM',
    message: `Approval would refuse ${problem.workflow}: ${problem.title}${problem.fix ? ` Fix: ${problem.fix}` : ''}`,
    subject: { kind: 'workflow', id: problem.workflow }, problem }));
  const plan = {
    schemaVersion: 1,
    resultType: 'workflow-studio-plan',
    valid: problems.length === 0,
    changed: files.length > 0,
    problems,
    warnings: problems.length ? [] : [...candidate.warnings(), ...obligationWarnings, ...refused],
    summary: [...candidate.summary, ...(problems.length ? [] : (checked?.repairs ?? []).map((entry) => entry.text))],
    ...(checked?.repairs?.length && !problems.length ? { repairs: checked.repairs } : {}),
    files: files.map((file) => ({
      path: file.path,
      action: file.before == null ? 'create' : file.after == null ? 'delete' : 'update',
      diff: unifiedDiff(asText(file.before), asText(file.after), file.path)
    })),
    ...(inspect ? { inspection } : {})
  };
  if (!write) return plan;
  if (!plan.valid) {
    throw new SingularityFlowError(`Workflow Studio changes were not applied: ${problems[0].message}`, { code: 'STUDIO_CHANGES_INVALID',
      details: { problems, ...(problems[0].nextAction ? { nextAction: problems[0].nextAction, recoveryCommands: problems[0].recoveryCommands } : {}) } });
  }
  if (refused.length && proposing) {
    const { problemLines } = await import('./workflow-autofix.mjs');
    const listed = refused.map((entry) => entry.problem);
    throw new SingularityFlowError(`Workflow Studio changes were not proposed: approval would refuse ${listed.length === 1 ? 'a problem' : `${listed.length} problems`} they add. Nothing was written or proposed.\n${problemLines(listed)}`, {
      code: 'STUDIO_WORKFLOW_PROBLEMS', details: { problems: listed, nextAction: { label: 'Change each in Workflow Studio, then propose again',
        workflowStudio: 'In VS Code, open Workflow Studio (Singularity Flow: Workflow Studio) and make the change there.', command: 'singularity-flow workflow studio apply --change-set <FILE> --dry-run' } } });
  }
  // A configuration proposal checkout may differ from the read-only authority mirror. Prove
  // every Constitution destination safe before any candidate file is written there too.
  for (const file of files.filter(file => candidate.constitutionChanges.has(file.path))) {
    await withoutConfigurationReadScope(() => secureRepositoryPath(root, file.path, { label: 'Constitution destination', type: 'file' }));
  }
  for (const file of files) {
    const target = path.join(root, file.path);
    if (file.after == null) { await rm(target, { force: true }); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.after);
  }
  return { ...plan, path: WORKFLOW_PATH, written: files.map((file) => file.path) };
}

/** Where a setting `because:` names lives in a step as written: the value the save rule compares before and after. */
function frameworkValue(node, setting) {
  if (!isObject(node)) return undefined;
  const generation = node.generation;
  switch (setting) {
    case 'approval.mode': return typeof node.approval === 'string' ? node.approval : node.approval?.mode;
    case 'generation.producer': return isObject(generation) ? [generation.producer, generation.defaultProducer, generation.allowedProducers] : undefined;
    case 'generation.requirement': return typeof generation === 'string' ? generation : isObject(generation) ? generation.requirement ?? generation.mode : undefined;
    case 'clarification.mode': return typeof node.clarification === 'string' ? node.clarification : node.clarification?.mode;
    default: return setting.split('.').reduce((value, key) => (isObject(value) ? value[key] : undefined), node);
  }
}

/**
 * The framework settings a change set gives a step of a workflow that derives from intents, which differ from what
 * the step's intent gives and say no reason (step intents §7.5): each refused, naming the reason or the removal.
 */
function intentReasonProblems(before, after, changes = []) {
  if (!declaresStepIntents(after)) return [];
  const problems = [];
  const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  // A copy keeps what its source step, or its source workflow, sets: a setting that is the same as there is not one
  // this change set gives (a copy of a shipped step brings its explicit settings into the workflow it now runs in).
  const stepCopies = new Map(changes.filter((change) => change?.op === 'phase.create' && typeof change.copyOf === 'string').map((change) => [change.id, change.copyOf]));
  const workflowCopies = new Map(changes.filter((change) => change?.op === 'workflow.create' && typeof change.copyOf === 'string').map((change) => [change.id, change.copyOf]));
  const inherited = (workflowId, step, setting) => {
    const sourceStep = stepCopies.get(step) ?? step;
    const sourceWorkflow = workflowCopies.get(workflowId) ?? workflowId;
    if (sourceStep === step && sourceWorkflow === workflowId) return false;
    const override = frameworkValue(after.workTypes?.[workflowId]?.phaseOverrides?.[step], setting);
    return same(frameworkValue(before.phases?.[sourceStep], setting), frameworkValue(after.phases?.[step], setting))
      && (override === undefined || same(frameworkValue(before.workTypes?.[sourceWorkflow]?.phaseOverrides?.[sourceStep], setting), override));
  };
  for (const [workflowId, type] of Object.entries(after.workTypes ?? {})) {
    if (!workTypeDerivesIntents(after, type)) continue;
    let derivation = null;
    try { derivation = deriveWorkTypeSettings(after, workflowId); } catch { continue; }
    for (const warning of derivation?.warnings ?? []) {
      if (warning.code !== 'CHECK_INTENT_OVERRIDE_WITHOUT_REASON') continue;
      const changed = warning.step
        ? !same(frameworkValue(before.phases?.[warning.step], warning.setting), frameworkValue(after.phases?.[warning.step], warning.setting))
          || !same(frameworkValue(before.workTypes?.[workflowId]?.phaseOverrides?.[warning.step], warning.setting),
            frameworkValue(after.workTypes?.[workflowId]?.phaseOverrides?.[warning.step], warning.setting))
        : !same(frameworkValue(before.workTypes?.[workflowId], warning.setting), frameworkValue(type, warning.setting));
      if (!changed || (warning.step && inherited(workflowId, warning.step, warning.setting))) continue;
      problems.push({ code: 'STUDIO_INTENT_REASON_REQUIRED', message: `${warning.title}. ${warning.fix}`, step: warning.step ?? null, setting: warning.setting,
        subject: warning.step ? { kind: 'phase', id: warning.step } : { kind: 'workflow', id: workflowId },
        nextAction: REASON_ROUTE });
    }
  }
  return problems;
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
  try { definition = validateDefinition(parseYamlText(asText(file.after))); } catch { return []; }
  const warnings = [];
  for (const id of touched) {
    if (!definition.workTypes?.[id]) continue;
    let resolved;
    try { resolved = resolveWorkType(definition, id); } catch { continue; }
    for (const entry of [...(resolved.obligationGraph?.findings ?? []), ...phaseTopologyFindings(resolved)]) {
      warnings.push({
        code: entry.code,
        message: entry.severity === 'error' ? `Stories cannot start from this workflow yet: ${entry.message}` : entry.message,
        resolvingAction: entry.resolvingAction, subject: { kind: 'workflow', id },
        // Where in the workflow: the Studio selects that step or decision.
        ...(entry.subject?.phase ?? entry.phaseId ? { step: entry.subject?.phase ?? entry.phaseId } : {}),
        ...(entry.subject?.decision ? { decision: entry.subject.decision } : {})
      });
    }
  }
  return warnings;
}

async function validateStudioCandidate(sources, files, inspect = null, { approved = null } = {}) {
  const readCandidate = (file, fallback) => {
    const changed = files.find((entry) => entry.path === file);
    return changed ? parseYamlText(asText(changed.after) ?? '') ?? {} : fallback;
  };
  const before = { story: sources.raw, initiative: sources.portfolioText ? parseYamlText(sources.portfolioText) : {} };
  const after = { story: readCandidate(WORKFLOW_PATH, before.story), initiative: readCandidate(PORTFOLIO_PATH, before.initiative) };
  const afterAgents = new Map(sources.agents.map((agent) => [agent.id, agent]));
  for (const file of files.filter((entry) => isAgentFilePath(entry.path))) {
    if (file.after == null) {
      for (const [id, agent] of afterAgents) if (agent.relative === file.path || agent.source === file.path) afterAgents.delete(id);
      continue;
    }
    const parsed = parseAgentDependencies(asText(file.after), { source: file.path });
    afterAgents.set(parsed.id, parsed);
  }
  assertSeededWorkflowsUnchanged(await seededWorkflowProtection(before.story, before.initiative, sources.agents), before, after,
    { beforeAgents: sources.agents, afterAgents: [...afterAgents.values()], files });
  const { validateConfigurationCandidates } = await import('./editor.mjs');
  const definition = sources.definition ?? { templatesRoot: sources.templatesRoot };
  // A removed file is removed from the copy validation reads (content null); the attachments file is checked empty.
  await validateConfigurationCandidates(sources.configRoot, files.map((file) => ({ path: file.path,
    content: file.after == null ? (file.path === SKILL_ATTACHMENTS_PATH ? 'attachments: []\n' : null) : asText(file.after) })), definition, sources.portfolio, { inspect, approved });
}

export function readStudioChangeSet(text) {
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new SingularityFlowError(`The Studio change set is not valid JSON: ${error.message}`, { code: 'STUDIO_CHANGE_SET_INVALID' }); }
  return value;
}

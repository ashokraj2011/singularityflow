/**
 * The skill master: named skills a repository keeps once and attaches to any number of agents.
 *
 * A skill lives at `singularity/skill-library/<id>/SKILL.md` in the open Agent Skills format:
 * front matter with its `name` (the ID, which is also its folder) and a `description` of what it
 * does and when to use it, then the instructions. A skill is attached to an agent in one of two
 * places, each saying the steps it applies in and when to use it:
 *
 * - the agent's own `## Attached skills` table, for an agent the repository owns; or
 * - `singularity/skill-library/attachments.yml`, which attaches any skill to any agent (a framework
 *   workflow's agents included) without changing the agent, so the framework workflow stays as it
 *   shipped and keeps its updates.
 *
 * Each attached skill's instructions are added to the prompt of every step it applies to, and a
 * Story keeps the skills and attachments it started with.
 *
 * These are not the compiled skill packages under `singularity/skills/`, which skill steps bind
 * and which never reach a prompt.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { parseYamlText } from './yaml-parse-cache.mjs';
import { scopedCatalogRead } from './catalog-read-scope.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { SingularityFlowError, secureRepositoryPath } from './util.mjs';
import { instructionReferences, guidanceTags } from './instruction-library.mjs';
import { inlineInstructionTags, instructionSlots, skillInstructionIds } from './skill-instruction-composition.mjs';

export const SKILL_LIBRARY_ROOT = 'singularity/skill-library';
export const SKILL_FILE = 'SKILL.md';
export const MAX_LIBRARY_SKILL_BYTES = 256 * 1024;
const MAX_DESCRIPTION = 1024;
const MAX_LABEL = 120;
const MAX_USE = 300;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * An agent's `## Attached skills` table: the skill's ID, the steps it applies in, and when to use
 * it. A distinct heading, because "Skills" is a common prose heading in agent files.
 */
export const LIBRARY_SKILL_TABLE = Object.freeze({
  heading: 'Attached skills', columns: Object.freeze(['Skill', 'Phases', 'When to use it'])
});

function fail(message, code = 'SKILL_LIBRARY_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

export function librarySkillPath(id) { return `${SKILL_LIBRARY_ROOT}/${id}/${SKILL_FILE}`; }

/** Skill attachments kept apart from the agents (see the module comment). */
export const SKILL_ATTACHMENTS_PATH = `${SKILL_LIBRARY_ROOT}/attachments.yml`;
const ATTACHMENT_KEYS = new Set(['skill', 'agent', 'workflow', 'steps', 'use']);

/** What a library skill dependency names as its source: never fetched, read from the library. */
export function librarySkillReference(id) { return `library:${id}`; }

export function defaultSkillLabel(id) {
  const words = id.split('-').join(' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

function splitFrontMatter(text, label) {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const opening = /^---\r?\n/.exec(source);
  if (!opening) fail(`${label} needs front matter with its name and description.`);
  const remainder = source.slice(opening[0].length);
  const closing = /\r?\n---(?:\r?\n|$)/.exec(remainder);
  if (!closing) fail(`${label} front matter is not closed.`);
  let value;
  try { value = parseYamlText(remainder.slice(0, closing.index)) ?? {}; }
  catch (error) { fail(`${label} front matter is not valid YAML: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} front matter must be a map.`);
  return { frontMatter: value, body: remainder.slice(closing.index + closing[0].length) };
}

/**
 * Read one skill's text. Its `name` must be its folder's ID, its `description` says what it does
 * and when to use it, and its instructions must not be empty.
 */
export function parseLibrarySkill(text, { id, source = librarySkillPath(id) } = {}) {
  if (typeof text !== 'string') fail(`${source} is not text.`);
  if (Buffer.byteLength(text, 'utf8') > MAX_LIBRARY_SKILL_BYTES) {
    fail(`${source} is larger than ${MAX_LIBRARY_SKILL_BYTES / 1024} KiB.`, 'SKILL_LIBRARY_LIMIT');
  }
  if (text.includes('\u0000')) fail(`${source} contains a NUL byte.`);
  const { frontMatter, body } = splitFrontMatter(text, source);
  const name = frontMatter.name;
  if (typeof name !== 'string' || !ID.test(name)) fail(`${source} must name its skill in lower-case kebab-case.`);
  if (id != null && name !== id) fail(`${source} names skill '${name}' but sits in the folder of '${id}'.`);
  const description = typeof frontMatter.description === 'string' ? frontMatter.description.replace(/\s+/g, ' ').trim() : '';
  if (!description) fail(`Skill '${name}' needs a description of what it does and when to use it.`);
  if (description.length > MAX_DESCRIPTION) fail(`Skill '${name}' has a description longer than ${MAX_DESCRIPTION} characters.`);
  const metadata = frontMatter.metadata ?? {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail(`Skill '${name}' metadata must be a map.`);
  const rawLabel = metadata['sflow-label'];
  const loading = metadata['sflow-loading'] ?? 'eager';
  const declaredInstructionRefs = instructionReferences(metadata['sflow-instructions']);
  const tags = guidanceTags(metadata['sflow-tags']);
  if (!['eager', 'on-demand'].includes(loading)) fail(`Skill '${name}' sflow-loading must be eager or on-demand.`);
  if (rawLabel != null && (typeof rawLabel !== 'string' || !rawLabel.trim() || rawLabel.length > MAX_LABEL)) {
    fail(`Skill '${name}' has an invalid sflow-label.`);
  }
  const instructions = body.trim();
  if (!instructions) fail(`Skill '${name}' has no instructions.`);
  // An inline <instruction> tag selects its instruction by itself; metadata lists the rest.
  const instructionRefs = instructionReferences(skillInstructionIds(declaredInstructionRefs, instructions));
  const instructionPlacements = instructionSlots(instructions, instructionRefs);
  const inlineInstructionPlacements = Object.freeze(inlineInstructionTags(instructions).map(tag => Object.freeze(tag)));
  return Object.freeze({
    id: name, label: rawLabel?.trim() ?? defaultSkillLabel(name), description, instructions, loading, instructionRefs, declaredInstructionRefs,
    instructionPlacements, inlineInstructionPlacements,
    path: librarySkillPath(name), sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8'), text, tags
  });
}

/** The SKILL.md text for a skill written in Workflow Studio or by `skill create`. */
export function librarySkillText({ id, label = null, description, instructions, loading = 'eager', instructionRefs = [], tags = [] }) {
  if (!ID.test(String(id ?? ''))) fail('A skill ID must be lower-case kebab-case.');
  const front = { name: id, description: String(description ?? '').replace(/\s+/g, ' ').trim() };
  const name = String(label ?? '').trim();
  if (name && name !== defaultSkillLabel(id)) front.metadata = { 'sflow-label': name };
  if (loading !== 'eager') front.metadata = { ...front.metadata, 'sflow-loading': loading };
  if (guidanceTags(tags).length) front.metadata = { ...front.metadata, 'sflow-tags': guidanceTags(tags) };
  // Tagged instructions select themselves, so only the untagged ones are written to metadata.
  const tagged = new Set(inlineInstructionTags(String(instructions ?? '')).map(tag => tag.id));
  const listed = instructionReferences(instructionRefs ?? []).filter(id => !tagged.has(id));
  if (listed.length) front.metadata = { ...front.metadata, 'sflow-instructions': listed };
  const text = `---\n${YAML.stringify(front, { lineWidth: 0 })}---\n\n${String(instructions ?? '').trim()}\n`;
  parseLibrarySkill(text, { id });
  return text;
}

/** One skill from the library at `configRoot`, or null when it is not there. */
export async function readLibrarySkill(configRoot, id) {
  if (!ID.test(String(id ?? ''))) fail(`'${id}' is not a skill ID.`);
  const secured = await secureRepositoryPath(configRoot, librarySkillPath(id), { label: `Skill '${id}'`, type: 'file' });
  if (!secured.exists) return null;
  return parseLibrarySkill(await readFile(secured.absolute, 'utf8'), { id });
}

/** Every skill in the library, by ID, and why any folder there is not a usable skill. */
export async function loadSkillLibrary(configRoot) {
  // The reads below follow an approved-configuration overlay, so the overlay is part of the identity,
  // as it is for agents: a working-tree read must never answer for the approved one.
  return scopedCatalogRead(JSON.stringify(['skills', path.resolve(configRoot), configurationReadRoot(configRoot)]),
    () => loadSkillLibrarySnapshot(configRoot));
}

async function loadSkillLibrarySnapshot(configRoot) {
  const skills = new Map();
  const problems = [];
  const directory = path.join(configRoot, SKILL_LIBRARY_ROOT);
  const info = await lstat(directory).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!info) return { skills, problems };
  if (!info.isDirectory() || info.isSymbolicLink()) {
    problems.push({ id: null, message: `${SKILL_LIBRARY_ROOT} must be a folder.` });
    return { skills, problems };
  }
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !ID.test(entry.name)) continue;
    try {
      const skill = await readLibrarySkill(configRoot, entry.name);
      if (skill) skills.set(skill.id, skill);
      else problems.push({ id: entry.name, message: `Skill folder '${entry.name}' has no ${SKILL_FILE}.` });
    } catch (error) {
      problems.push({ id: entry.name, message: error.message });
    }
  }
  return { skills, problems };
}

/**
 * A list of {skill, agent OR workflow, steps, use}. Agent skills follow the agent; workflow
 * skills are local to that workflow. Step membership is checked when configuration loads.
 */
export function parseSkillAttachments(text, source = SKILL_ATTACHMENTS_PATH) {
  let value;
  try { value = parseYamlText(String(text ?? '')) ?? {}; }
  catch (error) { fail(`${source} is not valid YAML: ${error.message}`, 'SKILL_ATTACHMENTS_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${source} must be a map holding an attachments list.`, 'SKILL_ATTACHMENTS_INVALID');
  const unknown = Object.keys(value).filter((key) => key !== 'attachments');
  if (unknown.length) fail(`${source} has unknown key(s) ${unknown.join(', ')}; it holds one list, attachments.`, 'SKILL_ATTACHMENTS_INVALID');
  const list = value.attachments ?? [];
  if (!Array.isArray(list)) fail(`${source} attachments must be a list.`, 'SKILL_ATTACHMENTS_INVALID');
  const seen = new Set();
  return Object.freeze(list.map((entry, index) => {
    const where = `${source} attachment ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${where} must be a map with skill, agent or workflow, steps and use.`, 'SKILL_ATTACHMENTS_INVALID');
    const extra = Object.keys(entry).filter((key) => !ATTACHMENT_KEYS.has(key));
    if (extra.length) fail(`${where} has unknown key(s) ${extra.join(', ')}.`, 'SKILL_ATTACHMENTS_INVALID');
    const skill = typeof entry.skill === 'string' ? entry.skill : '';
    const agent = typeof entry.agent === 'string' ? entry.agent : '';
    const workflow = typeof entry.workflow === 'string' ? entry.workflow : '';
    if (!ID.test(skill)) fail(`${where} needs the skill's lower-case kebab-case ID.`, 'SKILL_ATTACHMENTS_INVALID');
    if (Object.hasOwn(entry, 'agent') === Object.hasOwn(entry, 'workflow')
        || !ID.test(agent || workflow)) fail(`${where} needs exactly one agent or workflow lower-case kebab-case ID.`, 'SKILL_ATTACHMENTS_INVALID');
    const steps = entry.steps ?? [];
    if (!Array.isArray(steps) || steps.some((step) => typeof step !== 'string' || !ID.test(step))) {
      fail(`${where} steps must be a list of step IDs (none: every step of the target).`, 'SKILL_ATTACHMENTS_INVALID');
    }
    if (new Set(steps).size !== steps.length) fail(`${where} lists a step more than once.`, 'SKILL_ATTACHMENTS_INVALID');
    const target = agent ? `agent:${agent}` : `workflow:${workflow}`;
    if (seen.has(`${target}\0${skill}`)) fail(`${source} attaches skill '${skill}' to ${target} more than once.`, 'SKILL_ATTACHMENTS_INVALID');
    seen.add(`${target}\0${skill}`);
    return Object.freeze({ ...(agent ? { agent } : { workflow }), id: skill, phases: Object.freeze([...steps]), use: normalizeSkillUse(entry.use) });
  }));
}

/** The attachments at `configRoot`; none when the file is not there. */
export async function readSkillAttachments(configRoot) {
  const secured = await secureRepositoryPath(configRoot, SKILL_ATTACHMENTS_PATH, { label: 'Skill attachments', type: 'file' });
  if (!secured.exists) return Object.freeze([]);
  return parseSkillAttachments(await readFile(secured.absolute, 'utf8'));
}

/** The attachments file's text in a stable order, or null when nothing is attached (no file). */
export function skillAttachmentsText(entries) {
  if (!entries.length) return null;
  const target = (entry) => entry.agent ? `agent:${entry.agent}` : `workflow:${entry.workflow}`;
  const sorted = [...entries].sort((a, b) => target(a).localeCompare(target(b)) || a.id.localeCompare(b.id));
  const body = YAML.stringify({
    attachments: sorted.map((entry) => ({
      skill: entry.id, ...(entry.agent ? { agent: entry.agent } : { workflow: entry.workflow }),
      ...(entry.phases.length ? { steps: [...entry.phases] } : {}), ...(entry.use ? { use: entry.use } : {})
    }))
  }, { lineWidth: 0 });
  return [
    '# Attach skills to exactly one agent OR workflow. Agent skills follow the agent everywhere;',
    '# workflow skills apply only in that workflow, independently of its selected agent.',
    '# steps: restrict to these steps (omitted: all target steps). use: when to use it.',
    body
  ].join('\n');
}

/**
 * Every skill an agent uses, with the steps and when: those its own file attaches, then those the
 * attachments file attaches to it.
 */
export function effectiveLibrarySkills(agent) {
  const own = agent?.librarySkills ?? [];
  const ids = new Set(own.map((entry) => entry.id));
  return [...own, ...(agent?.attachedSkills ?? []).filter((entry) => !ids.has(entry.id))];
}

/**
 * Every agent the attachments file names is here, every workflow and step it names exists, and no
 * skill attached to an agent shares the ID of one of its remote resources (a Story keeps both under
 * that ID). Checked when configuration loads, from the attachments file alone: no skill is read.
 * Whether an attached skill is in the skill master is checked where that skill is used, when
 * configuration changes, and by doctor (skill-library-problems.mjs), so one missing skill never stops
 * a command, Story or step that does not use it.
 */
export async function assertAttachedLibrarySkills(configRoot, agents, definition = {}) {
  const known = new Map(agents.map((agent) => [agent.id, agent]));
  const attachments = await readSkillAttachments(configRoot);
  for (const attachment of attachments) {
    if (attachment.workflow) {
      const type = definition.workTypes?.[attachment.workflow];
      if (!type) fail(`Skill '${attachment.id}' names unknown workflow '${attachment.workflow}'.`, 'SKILL_ATTACHMENT_WORKFLOW_UNKNOWN');
      for (const phase of attachment.phases) {
        if (!type.phases.includes(phase)) fail(`Skill '${attachment.id}' names step '${phase}' outside workflow '${attachment.workflow}'.`, 'SKILL_ATTACHMENT_PHASE_UNKNOWN');
      }
      continue;
    }
    if (!known.has(attachment.agent)) {
      fail(`${SKILL_ATTACHMENTS_PATH} attaches skill '${attachment.id}' to agent '${attachment.agent}', which is not an agent here.`,
        'SKILL_ATTACHMENT_AGENT_UNKNOWN', { agentId: attachment.agent, skillId: attachment.id });
    }
    const remote = (known.get(attachment.agent).dependencies ?? []).find((entry) => entry.id === attachment.id);
    if (remote) {
      fail(`${SKILL_ATTACHMENTS_PATH} attaches skill '${attachment.id}' to agent '${attachment.agent}', which already has a remote ${remote.type} with that ID.`,
        'SKILL_ATTACHMENT_CONFLICT', { agentId: attachment.agent, skillId: attachment.id });
    }
  }
}

/**
 * An agent's text without its `## Attached skills` section (the heading, its table and the blank
 * lines before it), everything else exactly as written. The skill master edits that section, and
 * an agent that no longer attaches any skill goes back to its text without one.
 */
export function withoutAttachedSkills(text) {
  return withoutTableSection(text, LIBRARY_SKILL_TABLE.heading);
}

/** The text without one `## <heading>` section whose body is a Markdown table, and its blank lead. */
export function withoutTableSection(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${String(heading).toLowerCase()}`);
  if (start < 0) return String(text ?? '');
  let end = start + 1;
  while (end < lines.length && !lines[end].trim()) end += 1;
  while (end < lines.length && lines[end].trim().startsWith('|')) end += 1;
  let from = start;
  while (from > 0 && !lines[from - 1].trim()) from -= 1;
  return [...lines.slice(0, from), ...lines.slice(end)].join('\n');
}

/**
 * The Story value a "When to use it" names, or null: `when NAME is VALUE`, or several for one NAME joined by ` or `,
 * up to its first comma, as `workflow from-agent` writes a hard gate's answer ("when channel is web"). `{ name, values }`.
 */
export function storyValueCondition(use) {
  const head = String(use ?? '').split(',')[0].trim();
  const parts = head ? head.split(/\s+or\s+(?=when\s)/iu).map((part) => /^when\s+([A-Za-z][\w-]*)\s+is\s+(.+)$/iu.exec(part.trim())) : [null];
  if (parts.some((part) => !part) || new Set(parts.map((part) => part[1])).size !== 1) return null;
  return { name: parts[0][1], values: parts.map((part) => part[2].trim()) };
}

/** What the Story's steps recorded for its decisions this round (workflow-decisions.mjs recordedDecisionValues), by name. */
export function recordedStoryValues(workflow) {
  const values = {};
  for (const decision of workflow?.resolution?.decisions ?? []) {
    const recorded = workflow.phases?.[decision.after]?.decisionInputs;
    if (recorded?.decision === decision.id) Object.assign(values, recorded.values);
  }
  return values;
}

/** Whether a skill applies: one naming a Story value the Story recorded applies only for that value; any other as before. */
export function skillAppliesToStory(use, values = {}) {
  const condition = storyValueCondition(use);
  return !condition || values[condition.name] == null
    || condition.values.some((value) => value.toLowerCase() === String(values[condition.name]).toLowerCase());
}

/** The "When to use it" cell: one line of plain text, or empty for "whenever the step needs it". */
export function normalizeSkillUse(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text === '-' ) return '';
  if (text.length > MAX_USE) fail(`"When to use it" must be at most ${MAX_USE} characters.`);
  if (/[|]/.test(text)) fail('"When to use it" cannot contain "|".');
  return text;
}

/**
 * The prompt text for the library skills attached to an agent in a step: a short instruction to
 * read and apply them, then each skill with when to use it and its instructions.
 */
/** Where a retained procedure's file is and how to read it: its text is the procedure. */
function procedureFileWords(file) {
  const ranges = file.ranges ?? [];
  return `Read it from \`${file.path}\` with your file tool${ranges.length > 1 ? `, in ${ranges.length} ranges (lines ${ranges.map(([start, end]) => `${start}–${end}`).join(', ')})` : ''}; its text is the procedure;`;
}

export function renderLibrarySkills(agentId, entries, { expansions = new Map(), composition = null, files = new Map() } = {}) {
  if (!entries.length) return '';
  // Only the retrieval's own answer says a procedure is unavailable. A refusal of how a command was typed said nothing about
  // the procedure, yet "a retrieval refusal means unavailable" stopped an agent before drafting (test-sflow, 2026-11-23).
  const guidance = expansions.size
    ? `Apply eager instructions below. Optional procedures are catalogued${files.size ? ' with the file that holds each one and' : ' with'} an exact read-only retrieval command; load one only when its use condition applies. Never defer mandatory safety, correctness or policy instructions. Only the retrieval's own refusal (SKILL_RETAINED_BINDING_STALE) means a procedure is unavailable: then do not use live library bytes or invent it. A refusal of how a command was typed (PHASE_MUTATION_...) is not that: read the procedure's file, or run the command again on its own.`
    : entries.some((entry) => entry.scopes?.some((scope) => scope.startsWith('workflow ')))
      ? 'These skills apply to this workflow step. Read each one before you start this step.'
      : `These skills from the skill master are attached to ${agentId}. Read each one before you start this step.`;
  const blocks = entries.map((entry) => [
    `<!-- skill: ${entry.id} sha256=${String(entry.sha256).replace(/^sha256:/, '')} -->`,
    '',
    `### Skill: ${entry.label ?? defaultSkillLabel(entry.id)} (\`${entry.id}\`)`,
    '',
    entry.description ? `${entry.description}` : null,
    entry.scopes?.length ? `\nApplies through: ${entry.scopes.join('; ')}.` : null,
    entry.use ? `\nWhen to use it: ${entry.use}` : null,
    entry.instructionRefs?.length ? `\nReferenced instructions: ${entry.instructionRefs.join(', ')} (retained with this skill).` : null,
    '',
    expansions.has(entry.id)
      ? `Optional procedure; instructions retained, not loaded. ${files.get(entry.id) ? `${procedureFileWords(files.get(entry.id))} or retrieve it` : 'Retrieve it'} before applying; use skill.composedText from the response as the procedure:\n\n${expansions.get(entry.id)}`
      : (composition?.bodies.get(entry.id) ?? entry.instructions).trim()
  ].filter((line) => line != null).join('\n'));
  return [
    '## Attached skill instructions',
    '',
    guidance
      + ' When your instructions or a skill\'s "When to use it" call for it, carry the skill out as written,'
      + ' in that order, and say in your work which skills you applied.',
    '',
    blocks.join('\n\n')
  ].join('\n');
}

/**
 * The skill master: named skills a repository keeps once and attaches to any number of agents.
 *
 * A skill lives at `singularity/skill-library/<id>/SKILL.md` in the open Agent Skills format:
 * front matter with its `name` (the ID, which is also its folder) and a `description` of what it
 * does and when to use it, then the instructions. An agent attaches skills in its
 * `## Attached skills` table, which says when to use each one. That table is part of the agent's prompt, and each
 * attached skill's instructions are added to the prompt of every step it applies to.
 *
 * These are not the compiled skill packages under `singularity/skills/`, which skill steps bind
 * and which never reach a prompt.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { SingularityFlowError, secureRepositoryPath } from './util.mjs';

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
  try { value = YAML.parse(remainder.slice(0, closing.index)) ?? {}; }
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
  if (rawLabel != null && (typeof rawLabel !== 'string' || !rawLabel.trim() || rawLabel.length > MAX_LABEL)) {
    fail(`Skill '${name}' has an invalid sflow-label.`);
  }
  const instructions = body.trim();
  if (!instructions) fail(`Skill '${name}' has no instructions.`);
  return Object.freeze({
    id: name, label: rawLabel?.trim() ?? defaultSkillLabel(name), description, instructions,
    path: librarySkillPath(name), sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8'), text
  });
}

/** The SKILL.md text for a skill written in Workflow Studio or by `skill create`. */
export function librarySkillText({ id, label = null, description, instructions }) {
  if (!ID.test(String(id ?? ''))) fail('A skill ID must be lower-case kebab-case.');
  const front = { name: id, description: String(description ?? '').replace(/\s+/g, ' ').trim() };
  const name = String(label ?? '').trim();
  if (name && name !== defaultSkillLabel(id)) front.metadata = { 'sflow-label': name };
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

/** Every skill an agent attaches is in the skill master and readable; checked when configuration loads. */
export async function assertAttachedLibrarySkills(configRoot, agents) {
  const problems = new Map();
  for (const agent of agents) {
    for (const attachment of agent.librarySkills ?? []) {
      if (!problems.has(attachment.id)) {
        problems.set(attachment.id, await readLibrarySkill(configRoot, attachment.id)
          .then((skill) => (skill ? null : `it is not in the skill master (${librarySkillPath(attachment.id)})`), (error) => error.message));
      }
      const problem = problems.get(attachment.id);
      if (problem) {
        fail(`Agent '${agent.id}' attaches skill '${attachment.id}', but ${problem}.`, 'SKILL_LIBRARY_MISSING',
          { agentId: agent.id, skillId: attachment.id });
      }
    }
  }
}

/**
 * An agent's text without its `## Attached skills` section (the heading, its table and the blank
 * lines before it), everything else exactly as written. The skill master edits that section, and
 * an agent that no longer attaches any skill goes back to its text without one.
 */
export function withoutAttachedSkills(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${LIBRARY_SKILL_TABLE.heading.toLowerCase()}`);
  if (start < 0) return String(text ?? '');
  let end = start + 1;
  while (end < lines.length && !lines[end].trim()) end += 1;
  while (end < lines.length && lines[end].trim().startsWith('|')) end += 1;
  let from = start;
  while (from > 0 && !lines[from - 1].trim()) from -= 1;
  return [...lines.slice(0, from), ...lines.slice(end)].join('\n');
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
export function renderLibrarySkills(agentId, entries) {
  if (!entries.length) return '';
  const blocks = entries.map((entry) => [
    `<!-- skill: ${entry.id} sha256=${String(entry.sha256).replace(/^sha256:/, '')} -->`,
    '',
    `### Skill: ${entry.label ?? defaultSkillLabel(entry.id)} (\`${entry.id}\`)`,
    '',
    entry.description ? `${entry.description}` : null,
    entry.use ? `\nWhen to use it: ${entry.use}` : null,
    '',
    entry.instructions.trim()
  ].filter((line) => line != null).join('\n'));
  return [
    '## Attached skill instructions',
    '',
    `These skills from the skill master are attached to ${agentId}. Read each one before you start this step.`
      + ' When your instructions or a skill\'s "When to use it" call for it, carry the skill out as written,'
      + ' in that order, and say in your work which skills you applied.',
    '',
    blocks.join('\n\n')
  ].join('\n');
}

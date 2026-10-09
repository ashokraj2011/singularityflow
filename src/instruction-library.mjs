/** Reusable, inert instructions. Only explicit skill references put these bytes in a prompt. */
import { createHash } from 'node:crypto';
import { lstat, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';

export const INSTRUCTION_LIBRARY_ROOT = 'singularity/instruction-library';
export const MAX_INSTRUCTION_BYTES = 64 * 1024;
export const MAX_SKILL_INSTRUCTION_REFS = 32;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const fail = (message, code = 'INSTRUCTION_LIBRARY_INVALID') => {
  throw new SingularityFlowError(message, { code });
};
export const instructionPath = id => `${INSTRUCTION_LIBRARY_ROOT}/${id}/INSTRUCTIONS.md`;
const hash = text => createHash('sha256').update(text).digest('hex');
export function instructionUtf8(bytes, label = 'Instructions') {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail(`${label} must be valid UTF-8 text.`); }
}

export async function readInstructionText(file, label = 'Instructions') {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_INSTRUCTION_BYTES) fail(`${label} must be a regular non-symlink file of at most 64 KiB.`);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const start = await handle.stat();
    if (!start.isFile() || start.dev !== before.dev || start.ino !== before.ino || start.size !== before.size || start.mtimeMs !== before.mtimeMs) fail(`${label} changed while being opened.`);
    const bytes = await handle.readFile(); const end = await handle.stat(); const rebound = await lstat(file);
    if (end.size !== bytes.length || bytes.length > MAX_INSTRUCTION_BYTES || end.mtimeMs !== start.mtimeMs || rebound.isSymbolicLink() || rebound.dev !== start.dev || rebound.ino !== start.ino || rebound.size !== end.size || rebound.mtimeMs !== end.mtimeMs) fail(`${label} changed while being read.`);
    return instructionUtf8(bytes, label);
  } finally { await handle.close(); }
}

export function instructionReferences(value = []) {
  if (!Array.isArray(value) || value.length > MAX_SKILL_INSTRUCTION_REFS
      || value.some(id => typeof id !== 'string' || !ID.test(id))
      || new Set(value).size !== value.length) {
    fail('sflow-instructions must be a unique list of at most 32 lower-case instruction IDs, not paths or URLs.', 'INSTRUCTION_REFERENCES_INVALID');
  }
  return Object.freeze([...value]);
}

export function parseInstruction(text, { id, source = instructionPath(id) } = {}) {
  if (typeof text !== 'string' || text.includes('\u0000') || Buffer.byteLength(text) > MAX_INSTRUCTION_BYTES) {
    fail(`${source} must be UTF-8 text of at most 64 KiB without NUL bytes.`);
  }
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
  if (!match) fail(`${source} needs name and description front matter.`);
  let front;
  try { front = YAML.parse(match[1]); } catch (error) { fail(`${source}: ${error.message}`); }
  if (!front || typeof front !== 'object' || Array.isArray(front)
      || Object.keys(front).some(key => !['name', 'description', 'metadata'].includes(key))) fail(`${source} has invalid front matter.`);
  if (typeof front.name !== 'string' || !ID.test(front.name) || (id != null && front.name !== id)) fail(`${source} must name its own lower-case instruction ID.`);
  const description = typeof front.description === 'string' ? front.description.replace(/\s+/gu, ' ').trim() : '';
  const metadata = front.metadata ?? {};
  if (!description || description.length > 1024 || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || Object.keys(metadata).some(key => key !== 'sflow-label')) fail(`${source} needs a description; instruction references and loading policies belong to skills, not instructions.`);
  const label = metadata['sflow-label'] ?? front.name.split('-').join(' ').replace(/^./u, letter => letter.toUpperCase());
  if (typeof label !== 'string' || !label.trim() || label.length > 120 || !match[2].trim()) fail(`${source} needs a label and nonempty instruction body.`);
  return Object.freeze({ id: front.name, label: label.trim(), description, instructions: match[2].trim(),
    path: instructionPath(front.name), sha256: hash(text), bytes: Buffer.byteLength(text), text });
}

export function instructionText({ id, label, description, instructions }) {
  const front = { name: id, description, ...(label ? { metadata: { 'sflow-label': label } } : {}) };
  const text = `---\n${YAML.stringify(front, { lineWidth: 0 })}---\n\n${String(instructions ?? '').trim()}\n`;
  parseInstruction(text, { id });
  return text;
}

export async function readInstruction(root, id) {
  if (!ID.test(String(id ?? ''))) fail('Instruction IDs must be lower-case kebab-case.');
  const secured = await secureRepositoryPath(root, instructionPath(id), { label: `Instruction '${id}'`, type: 'file' });
  if (!secured.exists) return null;
  if (secured.entry.size > MAX_INSTRUCTION_BYTES) fail(`Instruction '${id}' exceeds 64 KiB.`, 'INSTRUCTION_LIBRARY_LIMIT');
  return parseInstruction(await readInstructionText(secured.absolute, `Instruction '${id}'`), { id });
}

export async function loadInstructionLibrary(root) {
  const instructions = new Map(); const problems = [];
  const directory = path.join(root, INSTRUCTION_LIBRARY_ROOT);
  const entry = await lstat(directory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!entry) return { instructions, problems };
  // Check every parent, not just the final folder, before enumeration.
  await secureRepositoryPath(root, INSTRUCTION_LIBRARY_ROOT, { label: 'Instruction library', type: 'directory' });
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail('The instruction library must be a regular directory.');
  for (const folder of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ID.test(folder.name) || (!folder.isDirectory() && !folder.isSymbolicLink())) continue;
    try {
      const item = await readInstruction(root, folder.name);
      if (!item) fail(`Instruction '${folder.name}' has no INSTRUCTIONS.md.`);
      instructions.set(item.id, item);
    } catch (error) { problems.push({ id: folder.name, code: error.code, message: error.message }); }
  }
  return { instructions, problems };
}

export async function resolveSkillInstructions(root, skill) {
  return Promise.all((skill.instructionRefs ?? []).map(async id => {
    const item = await readInstruction(root, id);
    if (!item) fail(`Skill '${skill.id}' references missing instruction '${id}'. Create it or remove the reference through configuration review.`, 'INSTRUCTION_REFERENCE_MISSING');
    return item;
  }));
}

/** Exact bytes are selected before rendering. Shared definitions appear once, never globally. */
export function renderReferencedInstructions(skills) {
  const selected = new Map();
  for (const skill of skills) for (const item of skill.referencedInstructions ?? []) {
    const prior = selected.get(item.id);
    if (prior && prior.item.sha256 !== item.sha256) fail(`Conflicting retained instruction '${item.id}'.`, 'INSTRUCTION_BINDING_CONFLICT');
    if (prior) prior.skills.add(skill.id);
    else selected.set(item.id, { item, skills: new Set([skill.id]) });
  }
  if (!selected.size) return '';
  return ['## Referenced instructions', '',
    'Apply these reusable instructions only through the named active skills and their use conditions. They do not override workflow policy, permissions, evidence gates or human approval.', '',
    ...[...selected.values()].map(({ item, skills: users }) => [
      `<!-- instruction: ${item.id} sha256=${item.sha256} -->`,
      `### Instruction: ${item.label} (\`${item.id}\`)`,
      `Used by skills: ${[...users].join(', ')}.`, item.instructions
    ].join('\n\n'))].join('\n\n');
}

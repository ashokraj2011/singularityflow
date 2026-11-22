/**
 * An agent folder on this computer, read for `workflow from-agent <FOLDER>` [owner, 2026-11-22: "When an agent
 * directory is imported it should create the needed phases and inject sflow things"]: the same agent a Git
 * repository marketplace lists (marketplace-repository.mjs), without adding a marketplace first.
 *
 * The folder holds `agent.md` (or one `*.agent.md`), and may hold `apm.yml` with the agent's name, version, pdlc-phases,
 * pdlc-tasks and `dependencies.apm` (the skill folders it uses, as `../../skills/x`). Each skill folder holds SKILL.md
 * and may hold its own apm.yml. With no apm.yml, the folder's name is the agent's, and each `skills/<name>/SKILL.md`
 * inside it is one of its skills. A path to the agent.md itself names its folder.
 *
 * Read only, and only plain files: a symbolic link, or a file larger than its limit, is refused. What the files say
 * is data. Nothing in the result names where on this computer the folder is, only the folder's own name.
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MARKETPLACE_MANIFEST, parsePackageManifest } from './marketplace-repository.mjs';
import { SingularityFlowError } from './util.mjs';

const LIMITS = Object.freeze({ manifestBytes: 256 * 1024, documentBytes: 1024 * 1024, skills: 64 });

function fail(message, code = 'AGENT_FOLDER_INVALID', details = undefined) {
  return new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

/** The entry at `file`: 'file', 'folder', 'link' or null when there is none. */
async function kindOf(file) {
  try {
    const stat = await lstat(file);
    return stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'folder' : stat.isFile() ? 'file' : 'other';
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** The text of the plain file `file`, or null when there is none; a link or a file over `limit` bytes is refused. */
async function readPlain(file, limit, shown) {
  const kind = await kindOf(file);
  if (kind == null) return null;
  if (kind !== 'file') throw fail(`${shown} is ${kind === 'link' ? 'a symbolic link' : 'not a plain file'}, so SFlow does not read it.`);
  const stat = await lstat(file);
  if (stat.size > limit) throw fail(`${shown} is larger than ${Math.round(limit / 1024)} KiB, so SFlow does not read it.`);
  const bytes = await readFile(file);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail(`${shown} is not UTF-8 text.`); }
}

/** The agent document in `folder`: agent.md, else its one *.agent.md; null when there is neither. */
async function agentDocument(folder) {
  const names = (await readdir(folder)).sort();
  if (names.includes('agent.md')) return 'agent.md';
  const own = names.filter((name) => name.endsWith('.agent.md'));
  return own.length === 1 ? own[0] : null;
}

/** Whether `target` is an agent folder (or an agent document) on this computer. */
export async function isAgentFolder(target, cwd = process.cwd()) {
  if (!target) return false;
  const at = path.resolve(cwd, target);
  const kind = await kindOf(at);
  if (kind === 'file') return /(?:^|[/\\])(?:agent\.md|[^/\\]+\.agent\.md)$/u.test(at);
  return kind === 'folder' && (await agentDocument(at)) != null;
}

/** SKILL.md's own `name:` and `description:` from its front matter, when it has them. */
function skillFrontMatter(text) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/u.exec(String(text));
  const field = (key) => match ? (new RegExp(`^${key}:\\s*(.+)$`, 'mu').exec(match[1])?.[1] ?? '').trim().replace(/^['"]|['"]$/gu, '') || null : null;
  return { name: field('name'), description: field('description') };
}

async function readSkill(folder, shown) {
  const text = await readPlain(path.join(folder, 'SKILL.md'), LIMITS.documentBytes, `${shown}/SKILL.md`);
  if (text == null) return null;
  const manifestText = await readPlain(path.join(folder, MARKETPLACE_MANIFEST), LIMITS.manifestBytes, `${shown}/${MARKETPLACE_MANIFEST}`);
  const own = manifestText == null ? null : parsePackageManifest(manifestText, { source: path.relative(path.parse(folder).root, folder), label: `${shown}/${MARKETPLACE_MANIFEST}` });
  const front = skillFrontMatter(text);
  const name = own?.name || front.name || path.basename(folder);
  return { name, kind: 'skill', type: own?.type || 'skill', version: own?.version ?? null, description: own?.description ?? front.description ?? name,
    pdlcTasks: own?.pdlcTasks ?? [], pdlcPhases: own?.pdlcPhases ?? [], document: `${shown}/SKILL.md`, text };
}

/**
 * Read the agent folder `target` (or the folder of the agent document it names): `{ folder, agent, skills, problems }`,
 * `agent` and `skills` in the shape convertAgent takes, `folder` the folder's own name.
 */
export async function readAgentFolder(target, cwd = process.cwd()) {
  let folder = path.resolve(cwd, String(target ?? ''));
  let documentName = null;
  if (await kindOf(folder) === 'file') { documentName = path.basename(folder); folder = path.dirname(folder); }
  const kind = await kindOf(folder);
  if (kind !== 'folder') {
    throw fail(`${target} is ${kind === 'link' ? 'a symbolic link' : 'not a folder on this computer'}. Name the agent's folder, the one that holds its agent.md.`, 'AGENT_FOLDER_NOT_FOUND');
  }
  const shown = path.basename(folder);
  documentName ??= await agentDocument(folder);
  if (!documentName) {
    throw fail(`${shown} holds no agent.md (or one *.agent.md), so there are no stages to turn into steps.`, 'AGENT_FOLDER_NO_DOCUMENT');
  }
  const text = await readPlain(path.join(folder, documentName), LIMITS.documentBytes, `${shown}/${documentName}`);
  const manifestText = await readPlain(path.join(folder, MARKETPLACE_MANIFEST), LIMITS.manifestBytes, `${shown}/${MARKETPLACE_MANIFEST}`);
  // Read as the marketplace reads it, from the file system's root, so a `../../skills/x` beside the folder is allowed.
  const own = manifestText == null ? null : parsePackageManifest(manifestText, { source: path.relative(path.parse(folder).root, folder), label: `${shown}/${MARKETPLACE_MANIFEST}` });
  const problems = [];
  if (own && own.kind !== 'agent' && own.type) problems.push(`${shown}/${MARKETPLACE_MANIFEST} says type ${own.type}; SFlow reads the folder as an agent because it holds ${documentName}.`);

  // Its skills: the folders apm.yml depends on, else each skills/<name>/ inside the agent's own folder.
  const skillFolders = [];
  if (own?.dependencies?.length) {
    for (const dependency of own.dependencies.slice(0, LIMITS.skills)) {
      if (!/^\.\.?\//u.test(dependency.reference)) { problems.push(`${shown} depends on ${dependency.reference}, which is not a folder beside it; it is left out.`); continue; }
      skillFolders.push({ at: path.resolve(folder, dependency.reference), shown: dependency.reference });
    }
  } else if (await kindOf(path.join(folder, 'skills')) === 'folder') {
    for (const name of (await readdir(path.join(folder, 'skills'))).sort().slice(0, LIMITS.skills)) {
      if (await kindOf(path.join(folder, 'skills', name)) === 'folder') skillFolders.push({ at: path.join(folder, 'skills', name), shown: `skills/${name}` });
    }
  }
  const skills = [];
  for (const entry of skillFolders) {
    const kindHere = await kindOf(entry.at);
    if (kindHere !== 'folder') { problems.push(`${shown} depends on ${entry.shown}, which is ${kindHere === 'link' ? 'a symbolic link' : 'not a folder'}; it is left out.`); continue; }
    const skill = await readSkill(entry.at, entry.shown);
    if (!skill) { problems.push(`${entry.shown} holds no SKILL.md; it is left out.`); continue; }
    if (skills.some((item) => item.name === skill.name)) { problems.push(`Two skills are called ${skill.name}; the first is used.`); continue; }
    skills.push(skill);
  }
  const name = own?.name || shown;
  const agent = {
    name, kind: 'agent', type: own?.type || 'agent', version: own?.version ?? null, description: own?.description ?? null,
    lifecycleState: own?.lifecycleState ?? null, pdlcPhases: own?.pdlcPhases ?? [], pdlcTasks: own?.pdlcTasks ?? [],
    tags: own?.tags ?? [], categories: own?.categories ?? [], source: shown, skills: skills.map((skill) => skill.name),
    document: `${shown}/${documentName}`, text
  };
  return { folder: shown, agent, skills, problems };
}

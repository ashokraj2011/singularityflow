import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SingularityFlowError } from './util.mjs';

const SOURCE_PREFIX = 'sflow-';
const DIRECT_PREFIX = 'sf-';
const MANAGED_MARKER = '<!-- managed-by: singularity-flow direct-skill-alias -->';

export function bundledSkillDirectory() {
  return path.resolve(fileURLToPath(new URL('../plugin/skills/', import.meta.url)));
}

export function copilotSkillsDirectory({ env = process.env, homeDirectory = os.homedir() } = {}) {
  const explicit = String(env.SINGULARITY_FLOW_COPILOT_SKILLS_DIR ?? '').trim();
  if (explicit) return path.resolve(explicit);
  const copilotHome = String(env.COPILOT_HOME ?? '').trim();
  return path.resolve(copilotHome || path.join(homeDirectory, '.copilot'), 'skills');
}

export function directSkillName(sourceName) {
  if (!sourceName.startsWith(SOURCE_PREFIX) || sourceName.length === SOURCE_PREFIX.length) {
    throw new SingularityFlowError(`Cannot create a direct skill alias for '${sourceName}'. Expected sflow-<action>.`);
  }
  return `${DIRECT_PREFIX}${sourceName.slice(SOURCE_PREFIX.length)}`;
}

export function renderDirectSkill(source, sourceName) {
  const directName = directSkillName(sourceName);
  const declaredName = source.match(/^name:\s*([^\n]+)$/m)?.[1]?.trim();
  if (declaredName !== sourceName) {
    throw new SingularityFlowError(`Skill ${sourceName} declares '${declaredName ?? '(missing)'}' instead of its directory name.`);
  }
  const renamed = source.replace(/^name:\s*[^\n]+$/m, `name: ${directName}`);
  const directCommands = renamed.replaceAll('/sflow-', '/sf-');
  const frontmatterEnd = directCommands.indexOf('\n---', 4);
  if (!directCommands.startsWith('---\n') || frontmatterEnd < 0) {
    throw new SingularityFlowError(`Skill ${sourceName} does not contain valid YAML frontmatter.`);
  }
  const insertAt = frontmatterEnd + 4;
  return `${directCommands.slice(0, insertAt)}\n${MANAGED_MARKER}${directCommands.slice(insertAt)}`;
}

function sourceSkills(sourceRoot) {
  if (!fs.existsSync(sourceRoot)) throw new SingularityFlowError(`Bundled Copilot skills were not found: ${sourceRoot}`);
  return fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(SOURCE_PREFIX))
    .map((entry) => {
      const sourceFile = path.join(sourceRoot, entry.name, 'SKILL.md');
      if (!fs.existsSync(sourceFile)) throw new SingularityFlowError(`Bundled skill is missing SKILL.md: ${sourceFile}`);
      const content = fs.readFileSync(sourceFile, 'utf8');
      return {
        sourceName: entry.name,
        directName: directSkillName(entry.name),
        content: renderDirectSkill(content, entry.name)
      };
    })
    .sort((left, right) => left.directName.localeCompare(right.directName));
}

function managedSkill(file) {
  try {
    return fs.readFileSync(file, 'utf8').includes(MANAGED_MARKER);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assertNoPersonalCollisions(skills, targetRoot) {
  const collisions = [];
  for (const skill of skills) {
    const targetDirectory = path.join(targetRoot, skill.directName);
    if (!fs.existsSync(targetDirectory)) continue;
    const targetFile = path.join(targetDirectory, 'SKILL.md');
    if (!managedSkill(targetFile)) collisions.push(skill.directName);
  }
  if (collisions.length) {
    throw new SingularityFlowError(
      `Direct Copilot skill installation would overwrite personal skill(s) not managed by Singularity Flow: ${collisions.join(', ')}. ` +
      `Move or rename those directories under ${targetRoot}, then retry.`
    );
  }
}

function atomicWrite(file, content) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.SKILL.md.sflow-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function removeObsoleteManagedSkills(targetRoot, activeNames) {
  if (!fs.existsSync(targetRoot)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(DIRECT_PREFIX) || activeNames.has(entry.name)) continue;
    const targetDirectory = path.join(targetRoot, entry.name);
    if (!managedSkill(path.join(targetDirectory, 'SKILL.md'))) continue;
    fs.rmSync(targetDirectory, { recursive: true });
    removed.push(entry.name);
  }
  return removed.sort();
}

export function installDirectSkills({
  sourceRoot = bundledSkillDirectory(),
  targetRoot = copilotSkillsDirectory()
} = {}) {
  const skills = sourceSkills(path.resolve(sourceRoot));
  if (!skills.length) throw new SingularityFlowError(`No bundled sflow-* skills were found under ${sourceRoot}.`);
  const resolvedTarget = path.resolve(targetRoot);
  assertNoPersonalCollisions(skills, resolvedTarget);
  fs.mkdirSync(resolvedTarget, { recursive: true, mode: 0o700 });
  for (const skill of skills) atomicWrite(path.join(resolvedTarget, skill.directName, 'SKILL.md'), skill.content);
  const removed = removeObsoleteManagedSkills(resolvedTarget, new Set(skills.map((skill) => skill.directName)));
  return {
    targetRoot: resolvedTarget,
    installed: skills.map((skill) => skill.directName),
    removed
  };
}

export function uninstallDirectSkills({ targetRoot = copilotSkillsDirectory() } = {}) {
  const resolvedTarget = path.resolve(targetRoot);
  if (!fs.existsSync(resolvedTarget)) return { targetRoot: resolvedTarget, removed: [] };
  const removed = [];
  for (const entry of fs.readdirSync(resolvedTarget, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(DIRECT_PREFIX)) continue;
    const directory = path.join(resolvedTarget, entry.name);
    if (!managedSkill(path.join(directory, 'SKILL.md'))) continue;
    fs.rmSync(directory, { recursive: true });
    removed.push(entry.name);
  }
  return { targetRoot: resolvedTarget, removed: removed.sort() };
}

export function isManagedDirectSkill(content) {
  return String(content).includes(MANAGED_MARKER);
}

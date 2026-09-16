import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
  const declaredName = source.match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim();
  if (declaredName !== sourceName) {
    throw new SingularityFlowError(`Skill ${sourceName} declares '${declaredName ?? '(missing)'}' instead of its directory name.`);
  }
  const renamed = source.replace(/^name:\s*[^\r\n]+/m, `name: ${directName}`);
  const directCommands = renamed.replaceAll('/sflow-', '/sf-');
  const opening = /^\uFEFF?---(\r?\n)/.exec(directCommands);
  const remainder = opening ? directCommands.slice(opening[0].length) : '';
  const closing = /\r?\n---(?=\r?\n|$)/.exec(remainder);
  if (!opening || !closing) {
    throw new SingularityFlowError(`Skill ${sourceName} does not contain valid YAML frontmatter.`);
  }
  const insertAt = opening[0].length + closing.index + closing[0].length;
  const newline = opening[1];
  return `${directCommands.slice(0, insertAt)}${newline}${MANAGED_MARKER}${directCommands.slice(insertAt)}`;
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

function contentSha256(content) {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

export function bundledDirectSkillNames({ sourceRoot = bundledSkillDirectory() } = {}) {
  return sourceSkills(path.resolve(sourceRoot)).map((skill) => skill.directName);
}

/**
 * Prove that every installed, managed `/sf-*` alias is byte-for-byte the alias rendered from the
 * currently running package. Copilot's inventory reports names and enabled state only; without
 * this check an older skill body can survive an upgrade and still look healthy.
 */
export function verifyDirectSkillContents({
  sourceRoot = bundledSkillDirectory(),
  targetRoot = copilotSkillsDirectory(),
  expectedNames = null
} = {}) {
  const sources = sourceSkills(path.resolve(sourceRoot));
  const byName = new Map(sources.map((skill) => [skill.directName, skill]));
  const selected = expectedNames == null ? sources : expectedNames.map((name) => {
    const skill = byName.get(name);
    if (!skill) {
      throw new SingularityFlowError(
        `Cannot verify unknown bundled direct Copilot skill '${name}'. Reinstall from one complete Singularity Flow package.`
      );
    }
    return skill;
  });
  const resolvedTarget = path.resolve(targetRoot);
  const missing = [];
  const stale = [];
  const invalid = [];
  const records = [];
  for (const skill of selected) {
    const file = path.join(resolvedTarget, skill.directName, 'SKILL.md');
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
      if (error?.code === 'ENOENT') { missing.push(skill.directName); continue; }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) { invalid.push(skill.directName); continue; }
    const actual = fs.readFileSync(file, 'utf8');
    const expectedSha256 = contentSha256(skill.content);
    const actualSha256 = contentSha256(actual);
    records.push(Object.freeze({ name: skill.directName, expectedSha256, actualSha256 }));
    if (actual !== skill.content) stale.push(skill.directName);
  }
  if (missing.length || stale.length || invalid.length) {
    const details = [
      ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
      ...(stale.length ? [`stale: ${stale.join(', ')}`] : []),
      ...(invalid.length ? [`not regular files: ${invalid.join(', ')}`] : [])
    ];
    throw new SingularityFlowError(
      `Installed direct Copilot skill content does not match this Singularity Flow build (${details.join(' | ')}). `
      + 'Run singularity-flow plugin install, then restart Copilot Chat or reload VS Code before retrying.'
    );
  }
  return Object.freeze({
    targetRoot: resolvedTarget,
    verified: selected.length,
    records: Object.freeze(records)
  });
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

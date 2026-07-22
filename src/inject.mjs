import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { exists, nowIso, posix, readJson, SingularityFlowError, snapshot, writeJson } from './util.mjs';

const DEFAULT_INJECTION = { placeholder: '{{WORLD_MODEL}}', mode: 'append', maxBytes: 32768, rules: [] };
const MODES = new Set(['replace', 'append', 'off']);

function values(value) { return Array.isArray(value) ? value : [value]; }

function assertStringValues(value, label) {
  if (value == null) return;
  if (values(value).some((item) => typeof item !== 'string' || !item.trim())) throw new SingularityFlowError(`${label} must contain non-empty strings.`);
}

export function injectionConfig(definition) {
  const configured = definition.worldModel?.injection ?? {};
  const merged = { ...DEFAULT_INJECTION, ...configured };
  if (!MODES.has(merged.mode)) throw new SingularityFlowError(`worldModel.injection.mode must be replace, append, or off; got '${merged.mode}'.`);
  if (typeof merged.placeholder !== 'string' || !merged.placeholder) throw new SingularityFlowError('worldModel.injection.placeholder must be a non-empty string.');
  if (!Number.isInteger(merged.maxBytes) || merged.maxBytes < 1) throw new SingularityFlowError('worldModel.injection.maxBytes must be a positive integer.');
  if (!Array.isArray(merged.rules)) throw new SingularityFlowError('worldModel.injection.rules must be an array.');
  return merged;
}

export function validateInjectionDefinition(definition) {
  const injection = injectionConfig(definition);
  injection.rules.forEach((rule, index) => {
    const label = `worldModel.injection.rules[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new SingularityFlowError(`${label} must be an object.`);
    if (!Array.isArray(rule.include) || !rule.include.length) throw new SingularityFlowError(`${label}.include must contain at least one world-model path or glob.`);
    assertStringValues(rule.include, `${label}.include`);
    for (const include of rule.include) {
      if (path.isAbsolute(include) || include.split(/[\\/]/).includes('..')) throw new SingularityFlowError(`${label}.include paths must stay inside the world-model directory.`);
    }
    const when = rule.when ?? {};
    if (typeof when !== 'object' || Array.isArray(when)) throw new SingularityFlowError(`${label}.when must be an object.`);
    for (const key of Object.keys(when)) if (!['persona', 'phase', 'workType', 'changedPaths', 'labels'].includes(key)) throw new SingularityFlowError(`${label}.when has unsupported signal '${key}'.`);
    for (const [key, source] of [['persona', definition.personas], ['phase', definition.phases], ['workType', definition.workTypes]]) {
      assertStringValues(when[key], `${label}.when.${key}`);
      for (const id of when[key] == null ? [] : values(when[key])) if (!source?.[id]) throw new SingularityFlowError(`${label}.when.${key} references unknown ${key} '${id}'.`);
    }
    assertStringValues(when.changedPaths, `${label}.when.changedPaths`);
    assertStringValues(when.labels, `${label}.when.labels`);
    if (rule.depth != null && !['quick', 'standard', 'deep'].includes(rule.depth)) throw new SingularityFlowError(`${label}.depth must be quick, standard, or deep.`);
    if (rule.evidence != null && typeof rule.evidence !== 'boolean') throw new SingularityFlowError(`${label}.evidence must be boolean.`);
  });
  return injection;
}

export function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replaceAll('**/', '\u0001')
    .replaceAll('**', '\u0002')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0001', '(?:.*/)?')
    .replaceAll('\u0002', '.*');
  return new RegExp(`^${pattern}$`);
}

function matchesAnyGlob(value, globs) {
  return globs.some((glob) => globToRegExp(glob).test(value));
}

export function ruleMatches(when = {}, signals = {}) {
  const equals = (condition, actual) => condition == null || (actual != null && values(condition).includes(actual));
  if (!equals(when.persona, signals.persona)) return false;
  if (!equals(when.phase, signals.phase)) return false;
  if (!equals(when.workType, signals.workType)) return false;
  if (when.changedPaths != null && !(signals.changedPaths ?? []).some((file) => matchesAnyGlob(posix(file), values(when.changedPaths)))) return false;
  if (when.labels != null) {
    const wanted = values(when.labels).map((label) => String(label).toLowerCase());
    const actual = (signals.labels ?? []).map((label) => String(label).toLowerCase());
    if (!wanted.some((label) => actual.includes(label))) return false;
  }
  return true;
}

export function resolveInjection(definition, signals = {}) {
  const injection = injectionConfig(definition);
  const matched = injection.rules.filter((rule) => ruleMatches(rule.when, signals));
  return {
    mode: injection.mode,
    placeholder: injection.placeholder,
    maxBytes: injection.maxBytes,
    matchedRules: matched.length,
    includes: [...new Set(matched.flatMap((rule) => rule.include ?? []))],
    evidence: matched.some((rule) => rule.evidence === true),
    depth: matched.map((rule) => rule.depth).filter(Boolean).at(-1) ?? 'standard'
  };
}

async function walkModel(directory, prefix = '') {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walkModel(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

export async function selectModelFiles(root, definition, includes) {
  const outputDir = definition.worldModel?.outputDir ?? '.singularity/world-model';
  const available = await walkModel(path.join(root, outputDir));
  return { outputDir, selected: available.filter((file) => matchesAnyGlob(file, includes)) };
}

function utf8Prefix(buffer, maxBytes) {
  if (buffer.length <= maxBytes) return buffer.toString('utf8');
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

export async function renderInjection(root, definition, signals = {}) {
  const resolution = resolveInjection(definition, signals);
  if (resolution.mode === 'off' || !resolution.includes.length) return { ...resolution, sections: [], text: '' };
  const includes = resolution.evidence ? [...new Set([...resolution.includes, 'evidence.md'])] : resolution.includes;
  const { outputDir, selected } = await selectModelFiles(root, definition, includes);
  const sections = [];
  let budget = resolution.maxBytes;
  for (const relative of selected) {
    if (budget <= 0) break;
    const absolute = path.join(root, outputDir, relative);
    const info = await snapshot(absolute);
    const raw = await readFile(absolute);
    const prefix = utf8Prefix(raw, budget);
    const injectedBytes = Buffer.byteLength(prefix, 'utf8');
    if (!injectedBytes && raw.length) break;
    const truncated = raw.length > injectedBytes;
    const body = `${prefix}${truncated ? '\n… truncated by injection budget …' : ''}`;
    budget -= injectedBytes;
    sections.push({ path: posix(path.join(outputDir, relative)), sha256: info.sha256, bytes: info.size, injectedBytes, truncated, body });
  }
  const manifestFile = path.join(root, outputDir, 'manifest.json');
  const manifest = await exists(manifestFile) ? await readJson(manifestFile) : null;
  const modelCommit = manifest?.repository_commit ?? manifest?.repository?.commit ?? null;
  const header = `<!-- world-model injection: rules=${resolution.matchedRules} files=${sections.length} commit=${modelCommit ? String(modelCommit).slice(0, 10) : 'unknown'} -->`;
  const text = [header, ...sections.map((section) => `\n## World model: ${section.path}\n\n${section.body.trim()}\n`)].join('\n');
  return { ...resolution, modelCommit, sections, text };
}

export async function injectPersonaPrompt(root, definition, personaId, signals = {}) {
  const persona = definition.personas?.[personaId];
  if (!persona) throw new SingularityFlowError(`Unknown persona '${personaId}'.`);
  const base = await readFile(path.join(root, definition.personaPromptsRoot, persona.prompt), 'utf8');
  const rendered = await renderInjection(root, definition, { ...signals, persona: personaId });
  if (rendered.mode === 'off' || !rendered.sections.length) return { text: base, injection: { ...rendered, applied: false } };
  const hasPlaceholder = base.includes(rendered.placeholder);
  const applied = hasPlaceholder || rendered.mode === 'append';
  const text = hasPlaceholder
    ? base.replaceAll(rendered.placeholder, rendered.text)
    : rendered.mode === 'append'
      ? `${base.trimEnd()}\n\n${rendered.text}\n`
      : base;
  return { text, injection: { ...rendered, applied } };
}

export async function recordInjection(root, workflow, phase, injection, { workDir }) {
  const record = {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    phase: phase.id,
    generation: phase.generation + 1,
    persona: injection.persona ?? null,
    modelCommit: injection.modelCommit ?? null,
    matchedRules: injection.matchedRules,
    mode: injection.mode,
    applied: injection.applied ?? false,
    depth: injection.depth,
    evidence: injection.evidence,
    files: injection.sections.map((section) => ({ path: section.path, sha256: section.sha256, bytes: section.bytes, injectedBytes: section.injectedBytes, truncated: section.truncated })),
    injectedAt: nowIso()
  };
  const file = path.join(workDir, 'context', `${phase.id}-gen${record.generation}.json`);
  await writeJson(file, record);
  return { record, file: posix(path.relative(root, file)) };
}

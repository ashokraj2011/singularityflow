import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  exists,
  nowIso,
  posix,
  readJson,
  secureRepositoryPath,
  SingularityFlowError,
  writeAtomicExclusive
} from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { canonicalJson } from './records.mjs';
import { withSubjectLock } from './subject-lock.mjs';

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
    for (const key of Object.keys(when)) if (!['agent', 'phase', 'workType', 'changedPaths', 'labels'].includes(key)) throw new SingularityFlowError(`${label}.when has unsupported signal '${key}'.`);
    for (const [key, source] of [['agent', definition.agents], ['phase', definition.phases], ['workType', definition.workTypes]]) {
      assertStringValues(when[key], `${label}.when.${key}`);
      for (const id of when[key] == null ? [] : values(when[key])) if (!source?.[id]) throw new SingularityFlowError(`${label}.when.${key} references unknown ${key} '${id}'.`);
    }
    assertStringValues(when.changedPaths, `${label}.when.changedPaths`);
    assertStringValues(when.labels, `${label}.when.labels`);
    if (rule.depth != null && !['light', 'quick', 'standard', 'deep'].includes(rule.depth)) throw new SingularityFlowError(`${label}.depth must be light, quick, standard, or deep.`);
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
  if (!equals(when.agent, signals.agent)) return false;
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

export async function selectModelFiles(root, definition, includes, { modelDirectory = null } = {}) {
  const outputDir = definition.worldModel?.outputDir ?? 'singularity/world-model';
  const available = await walkModel(modelDirectory ?? path.join(root, outputDir));
  return { outputDir, selected: available.filter((file) => matchesAnyGlob(file, includes)) };
}

function utf8Prefix(buffer, maxBytes) {
  if (buffer.length <= maxBytes) return buffer.toString('utf8');
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function durableGroundingAvailability(injection) {
  const supplied = injection.groundingAvailability;
  const status = supplied?.status ?? (injection.modelCommit ? 'available' : 'unavailable');
  if (!['available', 'unavailable'].includes(status)) {
    throw new SingularityFlowError(`Prompt grounding availability status '${String(status)}' cannot be recorded.`);
  }
  if (status === 'available') return { status, reasonCode: null };
  const reasonCode = supplied?.reasonCode ?? 'WORLD_MODEL_GROUNDING_UNAVAILABLE';
  if (typeof reasonCode !== 'string' || !/^[A-Z][A-Z0-9_.-]{0,95}$/.test(reasonCode)) {
    throw new SingularityFlowError('Prompt grounding unavailability must use a stable reason code.');
  }
  return { status, reasonCode };
}

export async function renderInjection(root, definition, signals = {}, {
  modelDirectory = null, validatedModelFiles = null, validatedManifest = null
} = {}) {
  const resolution = resolveInjection(definition, signals);
  if (resolution.mode === 'off' || !resolution.includes.length) return { ...resolution, sections: [], text: '' };
  const outputDir = definition.worldModel?.outputDir ?? 'singularity/world-model';
  const modelRoot = modelDirectory ?? path.join(root, outputDir);
  const manifestFile = path.join(modelRoot, 'manifest.json');
  // Once grounding validation supplies an immutable manifest/file snapshot, never reopen the
  // mutable manifest to decide which bytes enter the prompt. Callers without such a snapshot keep
  // the standalone rule-injection behavior for backwards compatibility.
  const manifest = validatedManifest
    ?? (validatedModelFiles == null && await exists(manifestFile) ? await readJson(manifestFile) : null);
  const includes = resolution.evidence && manifest?.evidence?.path
    ? [...new Set([...resolution.includes, manifest.evidence.path])]
    : resolution.includes;
  const validated = validatedModelFiles == null
    ? null
    : new Map(validatedModelFiles.map((entry) => [posix(entry.path), entry]));
  // A validated manifest snapshot is the selection authority. Walking the live directory again can
  // silently omit a file that disappears between validation and injection, turning an integrity or
  // availability event into a smaller, apparently valid prompt. Preserve every selected identity
  // from the snapshot and let the exact read below classify any subsequent change.
  const selected = validated
    ? [...validated.keys()].filter((relative) => matchesAnyGlob(relative, includes)).sort()
    : (await selectModelFiles(root, definition, includes, { modelDirectory: modelRoot })).selected;
  const sections = [];
  let budget = resolution.maxBytes;
  for (const relative of selected) {
    if (budget <= 0) break;
    const absolute = path.join(modelRoot, relative);
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new SingularityFlowError(
        `World-model injection source changed to a non-file after validation: ${relative}.`,
        { code: 'WORLD_MODEL_GROUNDING_INTEGRITY_FAILED', details: { path: posix(relative) } }
      );
    }
    const [resolvedRoot, resolvedFile] = await Promise.all([
      realpath(modelRoot), realpath(absolute)
    ]);
    if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new SingularityFlowError(
        `World-model injection source resolves outside the validated model: ${relative}.`,
        { code: 'WORLD_MODEL_GROUNDING_INTEGRITY_FAILED', details: { path: posix(relative) } }
      );
    }
    const raw = await readFile(absolute);
    const after = await lstat(absolute);
    const rawSha256 = createHash('sha256').update(raw).digest('hex');
    const expected = validated?.get(posix(relative));
    if (validated && (!expected || expected.sha256 !== rawSha256 || expected.size !== raw.length)) {
      throw new SingularityFlowError(
        `World-model injection source differs from the validated model snapshot: ${relative}.`,
        { code: 'WORLD_MODEL_GROUNDING_INTEGRITY_FAILED', details: { path: posix(relative) } }
      );
    }
    if (!after.isFile() || after.isSymbolicLink()
        || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || after.size !== raw.length) {
      throw new SingularityFlowError(
        `World-model injection source changed while it was being read: ${relative}.`,
        { code: 'WORLD_MODEL_GROUNDING_INTEGRITY_FAILED', details: { path: posix(relative) } }
      );
    }
    const prefix = utf8Prefix(raw, budget);
    const injectedBytes = Buffer.byteLength(prefix, 'utf8');
    if (!injectedBytes && raw.length) break;
    const truncated = raw.length > injectedBytes;
    const body = `${prefix}${truncated ? '\n… truncated by injection budget …' : ''}`;
    budget -= injectedBytes;
    sections.push({
      path: posix(path.join(outputDir, relative)), sha256: rawSha256, bytes: raw.length,
      injectedBytes, truncated, body
    });
  }
  const modelCommit = manifest?.repository_commit ?? manifest?.repository?.commit ?? null;
  const header = `<!-- world-model injection: rules=${resolution.matchedRules} files=${sections.length} commit=${modelCommit ? String(modelCommit).slice(0, 10) : 'unknown'} -->`;
  const text = [header, ...sections.map((section) => `\n## World model: ${section.path}\n\n${section.body.trim()}\n`)].join('\n');
  return { ...resolution, modelCommit, sections, text };
}

export async function injectAgentPrompt(root, definition, agentId, signals = {}, {
  promptOverride = null, disableWorldModelInjection = false, modelDirectory = null,
  validatedModelFiles = null, validatedManifest = null
} = {}) {
  const agent = definition.agents?.[agentId];
  if (!agent) throw new SingularityFlowError(`Unknown governed agent '${agentId}'.`);
  const base = promptOverride?.text ?? agent.prompt;
  if (disableWorldModelInjection) {
    const { placeholder } = injectionConfig(definition);
    return {
      text: base.replaceAll(placeholder, ''),
      injection: {
        mode: 'off', placeholder, applied: false, matchedRules: 0, sections: [], modelCommit: null,
        depth: 'standard', evidence: false, requiredViews: [], requiredSelections: [], promptOverride
      }
    };
  }
  const rendered = await renderInjection(
    root, definition, { ...signals, agent: agentId }, {
      modelDirectory, validatedModelFiles, validatedManifest
    }
  );
  if (rendered.mode === 'off' || !rendered.sections.length) return {
    text: base.replaceAll(rendered.placeholder, ''),
    injection: { ...rendered, applied: false, promptOverride }
  };
  const hasPlaceholder = base.includes(rendered.placeholder);
  const applied = hasPlaceholder || rendered.mode === 'append';
  const text = hasPlaceholder
    ? base.replaceAll(rendered.placeholder, rendered.text)
    : rendered.mode === 'append'
      ? `${base.trimEnd()}\n\n${rendered.text}\n`
      : base;
  return { text, injection: { ...rendered, applied, promptOverride } };
}

function promptGenerationLocation(root, workflow, phase, workDir) {
  const generation = phase.generation + 1;
  const promptFile = path.join(workDir, 'context', 'prompts', `${phase.id}-gen${generation}.md`);
  const recordFile = path.join(workDir, 'context', `${phase.id}-gen${generation}.json`);
  return {
    generation,
    promptFile,
    recordFile,
    promptPath: posix(path.relative(root, promptFile)),
    recordPath: posix(path.relative(root, recordFile)),
    label: `${workflow.workItem.id}/${phase.id}/generation ${generation}`
  };
}

function promptSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function promptGenerationFailure(message, code, details = {}) {
  return new SingularityFlowError(message, { code, details });
}

async function publishPromptHalfExclusively(file, value, location, half) {
  try {
    await writeAtomicExclusive(file, value);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    throw promptGenerationFailure(
      `Prompt generation ${location.label} changed while its ${half} was being published. `
      + 'The newly occupied path was preserved; retry to verify or repair the generation pair.',
      'PROMPT_SNAPSHOT_INTEGRITY_FAILED',
      { recordPath: location.recordPath, promptPath: location.promptPath, occupiedHalf: half }
    );
  }
}

function comparablePromptRecord(record) {
  const value = structuredClone(record);
  delete value.schemaVersion;
  delete value.injectedAt;
  // Cache-hit is an observation about this call, not part of a generation's durable identity.
  delete value.compositionCache;
  return value;
}

function assertExpectedPromptIdentity(record, workflow, phase, location, expected = {}) {
  const differences = [];
  if (record.workId !== workflow.workItem.id) differences.push(`workId=${record.workId ?? 'missing'}`);
  if (record.phase !== phase.id) differences.push(`phase=${record.phase ?? 'missing'}`);
  if (record.generation !== location.generation) differences.push(`generation=${record.generation ?? 'missing'}`);
  if (Object.hasOwn(expected, 'agent') && record.agent !== expected.agent) {
    differences.push(`agent=${record.agent ?? 'missing'}`);
  }
  if (Object.hasOwn(expected, 'task') && record.task !== expected.task) {
    differences.push(`task=${record.task ?? 'missing'}`);
  }
  if (differences.length) {
    throw promptGenerationFailure(
      `Prompt generation ${location.label} already belongs to a different composition (${differences.join(', ')}). `
      + 'Roll over the phase before composing different generation context.',
      'PROMPT_GENERATION_CONFLICT',
      { expected: { workId: workflow.workItem.id, phase: phase.id, generation: location.generation, ...expected }, differences }
    );
  }
  if (record.promptPath !== location.promptPath) {
    throw promptGenerationFailure(
      `Prompt generation ${location.label} names an unexpected prompt snapshot path.`,
      'PROMPT_SNAPSHOT_INTEGRITY_FAILED',
      { expectedPromptPath: location.promptPath, actualPromptPath: record.promptPath ?? null }
    );
  }
}

/**
 * Read a previously composed generation only after verifying its receipt and exact snapshot bytes.
 *
 * The returned text is the same in-memory value whose UTF-8 bytes were hashed; callers must not
 * re-read the mutable path after this check. A lone receipt or snapshot is an interrupted pair;
 * it is repairable only when a freshly composed candidate matches the surviving half exactly.
 */
export async function readPromptGeneration(root, workflow, phase, { workDir, ...expected } = {}) {
  const location = promptGenerationLocation(root, workflow, phase, workDir);
  const [recordTarget, promptTarget] = await Promise.all([
    secureRepositoryPath(root, location.recordPath, {
      label: 'Prompt generation receipt', type: 'file'
    }),
    secureRepositoryPath(root, location.promptPath, {
      label: 'Prompt generation snapshot', type: 'file'
    })
  ]);
  const hasRecord = recordTarget.exists;
  const hasPrompt = promptTarget.exists;
  if (!hasRecord && !hasPrompt) return null;
  if (!hasRecord || !hasPrompt) {
    throw promptGenerationFailure(
      `Prompt generation ${location.label} is incomplete: its ${hasRecord ? 'snapshot' : 'receipt'} is missing. `
      + 'Refusing to overwrite either half of the generation pair.',
      'PROMPT_SNAPSHOT_INTEGRITY_FAILED',
      { recordPath: location.recordPath, promptPath: location.promptPath, hasRecord, hasPrompt }
    );
  }

  let record;
  try {
    record = readRecord('prompt-injection', await readFile(recordTarget.absolute, 'utf8')).record;
  } catch (error) {
    throw promptGenerationFailure(
      `Prompt generation ${location.label} has an unreadable receipt: ${error.message}`,
      'PROMPT_SNAPSHOT_INTEGRITY_FAILED',
      { recordPath: location.recordPath }
    );
  }
  assertExpectedPromptIdentity(record, workflow, phase, location, expected);
  if (!/^[0-9a-f]{64}$/.test(record.renderedSha256 ?? '')) {
    throw promptGenerationFailure(
      `Prompt generation ${location.label} has an invalid recorded snapshot digest.`,
      'PROMPT_SNAPSHOT_INTEGRITY_FAILED',
      { recordPath: location.recordPath, renderedSha256: record.renderedSha256 ?? null }
    );
  }
  if (record.compositionCache != null
      && (!/^[0-9a-f]{64}$/.test(record.compositionCache.key ?? '')
        || record.compositionCache.promptSha256 !== record.renderedSha256)) {
    throw promptGenerationFailure(
      `Prompt generation ${location.label} has conflicting receipt and composition-cache digests.`,
      'PROMPT_SNAPSHOT_INTEGRITY_FAILED',
      { recordPath: location.recordPath }
    );
  }

  // Read once, hash once, and return these exact bytes. A later read would reopen a TOCTOU window.
  let text;
  try { text = await readFile(promptTarget.absolute, 'utf8'); }
  catch (error) {
    throw promptGenerationFailure(
      `Prompt generation ${location.label} snapshot could not be read after verification began: ${error.message}`,
      'PROMPT_SNAPSHOT_INTEGRITY_FAILED',
      { promptPath: location.promptPath }
    );
  }
  const actualSha256 = promptSha256(text);
  if (actualSha256 !== record.renderedSha256) {
    throw promptGenerationFailure(
      `Prompt generation ${location.label} snapshot digest differs from its receipt.`,
      'PROMPT_SNAPSHOT_INTEGRITY_FAILED',
      {
        promptPath: location.promptPath,
        expectedSha256: record.renderedSha256,
        actualSha256
      }
    );
  }
  return {
    record,
    file: location.recordPath,
    promptFile: location.promptPath,
    text,
    reused: true
  };
}

/**
 * Complete the one missing half of a generation pair only when the surviving bytes and the newly
 * composed candidate are exact matches. This is crash recovery, not overwrite authority: any
 * disagreement remains an integrity refusal.
 */
async function repairInterruptedPromptGeneration(
  root, workflow, phase, location, record, renderedText, workDir
) {
  const [recordTarget, promptTarget] = await Promise.all([
    secureRepositoryPath(root, location.recordPath, {
      label: 'Prompt generation receipt', type: 'file'
    }),
    secureRepositoryPath(root, location.promptPath, {
      label: 'Prompt generation snapshot', type: 'file'
    })
  ]);
  if (recordTarget.exists === promptTarget.exists) return null;

  if (promptTarget.exists) {
    const survivingText = await readFile(promptTarget.absolute, 'utf8');
    if (promptSha256(survivingText) !== record.renderedSha256
        || survivingText !== renderedText) {
      throw promptGenerationFailure(
        `Prompt generation ${location.label} has a snapshot without a receipt, but its bytes do not match the exact recovery candidate.`,
        'PROMPT_SNAPSHOT_INTEGRITY_FAILED',
        { recordPath: location.recordPath, promptPath: location.promptPath }
      );
    }
    await publishPromptHalfExclusively(
      location.recordFile, `${JSON.stringify(record, null, 2)}\n`, location, 'receipt'
    );
    const verified = await readPromptGeneration(root, workflow, phase, {
      workDir,
      agent: record.agent,
      task: record.task
    });
    return { ...verified, reused: false, recovered: true };
  }

  let survivingRecord;
  try {
    survivingRecord = readRecord(
      'prompt-injection', await readFile(recordTarget.absolute, 'utf8')
    ).record;
  } catch (error) {
    throw promptGenerationFailure(
      `Prompt generation ${location.label} has a receipt without a snapshot, and the receipt is unreadable: ${error.message}`,
      'PROMPT_SNAPSHOT_INTEGRITY_FAILED',
      { recordPath: location.recordPath, promptPath: location.promptPath }
    );
  }
  assertExpectedPromptIdentity(survivingRecord, workflow, phase, location, {
    agent: record.agent, task: record.task
  });
  if (survivingRecord.compositionCache != null
      && (!/^[0-9a-f]{64}$/.test(survivingRecord.compositionCache.key ?? '')
        || survivingRecord.compositionCache.promptSha256 !== survivingRecord.renderedSha256)) {
    throw promptGenerationFailure(
      `Prompt generation ${location.label} has a receipt without a snapshot, but its composition-cache digest is invalid.`,
      'PROMPT_SNAPSHOT_INTEGRITY_FAILED',
      { recordPath: location.recordPath, promptPath: location.promptPath }
    );
  }
  const sameRecord = canonicalJson(comparablePromptRecord(survivingRecord))
    === canonicalJson(comparablePromptRecord(record));
  const existingCacheKey = survivingRecord.compositionCache?.key ?? null;
  const candidateCacheKey = record.compositionCache?.key ?? null;
  if (survivingRecord.renderedSha256 !== record.renderedSha256
      || !sameRecord
      || (existingCacheKey != null && existingCacheKey !== candidateCacheKey)) {
    throw promptGenerationFailure(
      `Prompt generation ${location.label} has a receipt without a snapshot, but it does not match the exact recovery candidate.`,
      'PROMPT_SNAPSHOT_INTEGRITY_FAILED',
      { recordPath: location.recordPath, promptPath: location.promptPath }
    );
  }
  await publishPromptHalfExclusively(location.promptFile, renderedText, location, 'snapshot');
  const verified = await readPromptGeneration(root, workflow, phase, {
    workDir,
    agent: record.agent,
    task: record.task
  });
  return { ...verified, reused: false, recovered: true };
}

export async function recordInjection(root, workflow, phase, injection, {
  workDir, beforePersist = null
}) {
  const groundingAvailability = durableGroundingAvailability(injection);
  const location = promptGenerationLocation(root, workflow, phase, workDir);
  if (injection.renderedText == null) {
    throw promptGenerationFailure(
      `Prompt generation ${location.label} cannot be recorded without its exact rendered snapshot.`,
      'PROMPT_SNAPSHOT_REQUIRED',
      { recordPath: location.recordPath, promptPath: location.promptPath }
    );
  }
  const renderedText = String(injection.renderedText).endsWith('\n')
    ? String(injection.renderedText) : `${String(injection.renderedText)}\n`;
  const renderedSha256 = promptSha256(renderedText);
  if (injection.renderedSha256 != null && injection.renderedSha256 !== renderedSha256) {
    throw promptGenerationFailure(
      `Prompt generation ${location.label} rendered digest does not match the bytes to persist.`,
      'PROMPT_SNAPSHOT_INTEGRITY_FAILED',
      { expectedSha256: injection.renderedSha256, actualSha256: renderedSha256 }
    );
  }
  const record = {
    schemaVersion: currentSchemaVersion('prompt-injection'),
    workId: workflow.workItem.id,
    phase: phase.id,
    generation: location.generation,
    agent: injection.agent ?? null,
    modelCommit: injection.modelCommit ?? null,
    matchedRules: injection.matchedRules,
    mode: injection.mode,
    applied: injection.applied ?? false,
    depth: injection.depth,
    evidence: injection.evidence,
    groundingAvailability,
    requiredViews: injection.requiredViews ?? [],
    requiredSelections: injection.requiredSelections ?? [],
    task: injection.task ?? null,
    supportingEvidence: injection.supportingEvidence ?? [],
    references: injection.references ?? [],
    modelSourceTreeSha256: injection.modelSourceTreeSha256 ?? null,
    composedSourceTreeSha256: injection.composedSourceTreeSha256 ?? null,
    worldModelCommit: injection.modelCommit ?? null,
    manifestSha256: injection.manifestSha256 ?? null,
    fresh: injection.fresh ?? null,
    renderedSha256,
    promptStudy: injection.promptStudy ?? null,
    promptDefinition: injection.promptDefinition ?? null,
    structuralContext: structuredClone(injection.structuralContext ?? null),
    workSource: structuredClone(injection.workSource ?? null),
    promptBudget: structuredClone(injection.promptBudget ?? null),
    remoteSkills: structuredClone(injection.remoteSkills ?? []),
    compositionCache: injection.compositionCache?.key ? {
      key: injection.compositionCache.key,
      promptSha256: renderedSha256
    } : null,
    promptPath: location.promptPath,
    files: injection.sections.map((section) => ({
      path: section.path, sha256: section.sha256, bytes: section.bytes,
      injectedBytes: section.injectedBytes, truncated: section.truncated,
      category: section.category ?? 'rule', level: section.level ?? null, reason: section.reason ?? null,
      evidenceId: section.evidenceId ?? null, mimeType: section.mimeType ?? null,
      packageId: section.packageId ?? null, handle: section.handle ?? null,
      previewSha256: section.previewSha256 ?? null,
      previewBytes: section.previewBytes ?? null,
      renderer: section.renderer ?? null
    })),
    injectedAt: nowIso()
  };
  return withSubjectLock(root, { kind: 'story', id: workflow.workItem.id }, async () => {
    const repaired = await repairInterruptedPromptGeneration(
      root, workflow, phase, location, record, renderedText, workDir
    );
    if (repaired) return repaired;
    const existing = await readPromptGeneration(root, workflow, phase, {
      workDir,
      agent: record.agent,
      task: record.task
    });
    if (existing) {
      const samePrompt = existing.record.renderedSha256 === renderedSha256;
      const sameRecord = canonicalJson(comparablePromptRecord(existing.record))
        === canonicalJson(comparablePromptRecord(record));
      const existingCacheKey = existing.record.compositionCache?.key ?? null;
      const candidateCacheKey = record.compositionCache?.key ?? null;
      // Receipts written before composition-cache provenance was persisted remain reusable when
      // their complete durable projection and prompt bytes match. Once present, the key is binding.
      const sameCache = existingCacheKey == null || existingCacheKey === candidateCacheKey;
      if (!samePrompt || !sameRecord || !sameCache) {
        throw promptGenerationFailure(
          `Prompt generation ${location.label} is immutable and already records different context. `
          + 'Roll over the phase before composing a different prompt.',
          'PROMPT_GENERATION_CONFLICT',
          {
            recordPath: location.recordPath,
            promptPath: location.promptPath,
            existingSha256: existing.record.renderedSha256,
            candidateSha256: renderedSha256,
            existingCacheKey,
            candidateCacheKey
          }
        );
      }
      return existing;
    }

    // Re-resolve immediately before mutation so a pre-existing symlink cannot redirect either
    // atomic writer outside the repository.
    const finalTargets = await Promise.all([
      secureRepositoryPath(root, location.recordPath, {
        label: 'Prompt generation receipt', type: 'file'
      }),
      secureRepositoryPath(root, location.promptPath, {
        label: 'Prompt generation snapshot', type: 'file'
      })
    ]);
    if (finalTargets.some((target) => target.exists)) {
      const finalRepair = await repairInterruptedPromptGeneration(
        root, workflow, phase, location, record, renderedText, workDir
      );
      if (finalRepair) return finalRepair;
      const finalExisting = await readPromptGeneration(root, workflow, phase, {
        workDir,
        agent: record.agent,
        task: record.task
      });
      const samePrompt = finalExisting?.record.renderedSha256 === renderedSha256;
      const sameRecord = finalExisting != null
        && canonicalJson(comparablePromptRecord(finalExisting.record))
          === canonicalJson(comparablePromptRecord(record));
      const existingCacheKey = finalExisting?.record.compositionCache?.key ?? null;
      const candidateCacheKey = record.compositionCache?.key ?? null;
      if (!samePrompt || !sameRecord
          || (existingCacheKey != null && existingCacheKey !== candidateCacheKey)) {
        throw promptGenerationFailure(
          `Prompt generation ${location.label} became occupied by different context before publication.`,
          'PROMPT_GENERATION_CONFLICT',
          { recordPath: location.recordPath, promptPath: location.promptPath }
        );
      }
      return finalExisting;
    }
    if (beforePersist) await beforePersist({ ...location });
    await publishPromptHalfExclusively(location.promptFile, renderedText, location, 'snapshot');
    await publishPromptHalfExclusively(
      location.recordFile, `${JSON.stringify(record, null, 2)}\n`, location, 'receipt'
    );
    const verified = await readPromptGeneration(root, workflow, phase, {
      workDir,
      agent: record.agent,
      task: record.task
    });
    return { ...verified, reused: false };
  });
}

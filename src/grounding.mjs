import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { changedFiles, head } from './git.mjs';
import { exists, posix, run, SingularityFlowError, snapshot } from './util.mjs';

const GROUNDING_MODES = new Set(['off', 'warn', 'enforce']);

export function groundingMode(definition, workflow = null) {
  const mode = workflow ? workflow.resolution?.worldModelGrounding ?? 'off' : definition.worldModel?.grounding ?? 'off';
  if (!GROUNDING_MODES.has(mode)) throw new SingularityFlowError(`worldModel.grounding must be off, warn, or enforce; got '${mode}'.`);
  return mode;
}

function excludedSourcePath(file, definition = {}) {
  const outputDir = posix(definition.worldModel?.outputDir ?? definition.outputDir ?? 'singularity/world-model').replace(/\/$/, '');
  const workItemRoot = posix(definition.workItemRoot ?? 'singularity/work-items').replace(/\/$/, '');
  return file === outputDir || file.startsWith(`${outputDir}/`)
    || file === workItemRoot || file.startsWith(`${workItemRoot}/`)
    || file.startsWith('.git/') || file.startsWith('node_modules/');
}

export async function worldModelSourceSnapshot(root, definition = {}) {
  const tracked = run('git', ['ls-files', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean);
  const files = [...new Set([...tracked, ...changedFiles(root)])]
    .map(posix)
    .filter((file) => !excludedSourcePath(file, definition))
    .sort();
  const hash = createHash('sha256');
  const records = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) {
      hash.update(file).update('\0deleted\0');
      records.push({ path: file, status: 'deleted', size: 0, sha256: null });
      continue;
    }
    const info = await snapshot(absolute);
    if (!info.sha256) continue;
    hash.update(file).update('\0').update(info.sha256).update('\0');
    records.push({ path: file, status: 'present', size: info.size, sha256: info.sha256 });
  }
  return { sha256: `sha256:${hash.digest('hex')}`, files: records };
}

export async function repositoryContentSnapshot(root) {
  const tracked = run('git', ['ls-files', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean);
  const files = [...new Set([...tracked, ...changedFiles(root)])].map(posix).sort();
  const records = new Map();
  for (const file of files) {
    if (file.startsWith('.git/') || file.startsWith('node_modules/')) continue;
    const info = await snapshot(path.join(root, file));
    records.set(file, `${info.exists}:${info.size}:${info.sha256 ?? ''}`);
  }
  return records;
}

export function changedSnapshotPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

export function safeModelPath(directory, relative, label = 'World-model path') {
  if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new SingularityFlowError(`${label} must stay inside the world-model directory.`);
  }
  const root = path.resolve(directory);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new SingularityFlowError(`${label} escapes the world-model directory.`);
  return absolute;
}

async function modelFiles(directory, prefix = '') {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await modelFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) output.push(posix(relative));
    else throw new SingularityFlowError(`World-model output contains an unsupported filesystem entry: ${relative}`);
  }
  return output.sort();
}

async function requireModelFile(directory, relative, label, { json = false, jsonl = false } = {}) {
  const absolute = safeModelPath(directory, relative, label);
  const entry = await lstat(absolute).catch(() => null);
  if (!entry?.isFile() || entry.isSymbolicLink()) throw new SingularityFlowError(`${label} must be a regular file: ${relative}`);
  const resolvedRoot = await realpath(directory);
  const resolved = await realpath(absolute);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new SingularityFlowError(`${label} resolves outside the world-model directory: ${relative}`);
  const info = await snapshot(absolute);
  if (!info.exists || !info.sha256 || info.size < 1) throw new SingularityFlowError(`${label} is missing or empty: ${relative}`);
  const text = await readFile(absolute, 'utf8');
  if (json) {
    try { JSON.parse(text); } catch (error) { throw new SingularityFlowError(`${label} is invalid JSON: ${error.message}`); }
  }
  if (jsonl) {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) throw new SingularityFlowError(`${label} must contain at least one JSON record: ${relative}`);
    for (const [index, line] of lines.entries()) {
      try { JSON.parse(line); } catch (error) { throw new SingularityFlowError(`${label} line ${index + 1} is invalid JSON: ${error.message}`); }
    }
  }
  return { path: posix(relative), absolute, ...info };
}

export async function validateWorldModelDirectory(directory, { expectedCommit = null, expectedTask = null, requiredViews = [], requireEvidence = true } = {}) {
  const manifestFile = path.join(directory, 'manifest.json');
  if (!(await exists(manifestFile))) throw new SingularityFlowError('World-model builder did not create manifest.json.');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); }
  catch (error) { throw new SingularityFlowError(`World-model manifest is invalid JSON: ${error.message}`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new SingularityFlowError('World-model manifest must be a JSON object.');
  if (manifest.schema_version !== '1.0') throw new SingularityFlowError("World-model manifest schema_version must be '1.0'.");
  const repositoryCommit = manifest.repository_commit ?? manifest.repository?.commit;
  if (!/^[0-9a-f]{40}$/i.test(repositoryCommit ?? '')) throw new SingularityFlowError('World-model manifest requires a full repository_commit SHA.');
  if (expectedCommit && repositoryCommit !== expectedCommit) throw new SingularityFlowError(`World-model manifest inspected ${repositoryCommit}, expected ${expectedCommit}.`);
  if (manifest.source_tree_sha256 != null && !/^sha256:[0-9a-f]{64}$/.test(manifest.source_tree_sha256)) throw new SingularityFlowError('World-model manifest source_tree_sha256 is invalid.');

  const registered = new Set();
  const register = async (relative, label, options) => {
    const record = await requireModelFile(directory, relative, label, options);
    if (registered.has(record.path)) throw new SingularityFlowError(`World-model manifest declares the same file more than once: ${record.path}`);
    registered.add(record.path);
    return record;
  };
  const coreSummary = manifest.core?.summary ?? 'core/summary.md';
  const coreModel = manifest.core?.model ?? 'core/model.json';
  await register(coreSummary, 'World-model core summary');
  await register(coreModel, 'World-model core model', { json: true });

  if (!manifest.views || typeof manifest.views !== 'object' || Array.isArray(manifest.views)) throw new SingularityFlowError('World-model manifest views must be an object.');
  if (manifest.domains != null && !Array.isArray(manifest.domains)) throw new SingularityFlowError('World-model manifest domains must be an array.');
  if (manifest.task_guides != null && !Array.isArray(manifest.task_guides)) throw new SingularityFlowError('World-model manifest task_guides must be an array.');
  for (const [view, entry] of Object.entries(manifest.views)) {
    if (entry?.generated === false) continue;
    if (!entry?.path) throw new SingularityFlowError(`Generated world-model view '${view}' has no path.`);
    await register(entry.path, `World-model view '${view}'`);
  }
  for (const view of requiredViews) {
    const entry = manifest.views?.[view];
    if (!entry || entry.generated === false || !entry.path) throw new SingularityFlowError(`Required world-model view '${view}' was not generated.`);
  }
  for (const domain of manifest.domains ?? []) {
    if (!domain?.id || !domain?.path) throw new SingularityFlowError('Every world-model domain requires id and path.');
    await register(domain.path, `World-model domain '${domain.id}'`);
  }
  for (const guide of manifest.task_guides ?? []) {
    if (!guide?.id || !guide?.path || !guide?.task) throw new SingularityFlowError('Every world-model task guide requires id, path, and exact task text.');
    await register(guide.path, `World-model task guide '${guide.id}'`);
  }
  if (expectedTask && !(manifest.task_guides ?? []).some((guide) => normalizeTask(guide.task) === normalizeTask(expectedTask))) throw new SingularityFlowError(`World-model builder did not create a task guide for '${expectedTask}'.`);
  if (requireEvidence) {
    if (!manifest.evidence?.path) throw new SingularityFlowError('World-model manifest requires evidence.path.');
    await register(manifest.evidence.path, 'World-model evidence ledger', { jsonl: true });
  } else if (manifest.evidence?.path) await register(manifest.evidence.path, 'World-model evidence ledger', { jsonl: true });

  const actual = (await modelFiles(directory)).filter((file) => file !== 'manifest.json');
  const undeclared = actual.filter((file) => !registered.has(file));
  if (undeclared.length) throw new SingularityFlowError(`World-model files are missing from manifest.json: ${undeclared.join(', ')}`);
  return { manifest, repositoryCommit, registered: [...registered].sort() };
}

export async function worldModelFreshness(root, config, manifest) {
  const source = await worldModelSourceSnapshot(root, config);
  const recorded = manifest.source_tree_sha256 ?? null;
  if (recorded) return { built: recorded, current: source.sha256, fresh: recorded === source.sha256, source };
  const built = manifest.repository_commit ?? manifest.repository?.commit ?? null;
  return { built, current: head(root), fresh: built === head(root), source, legacy: true };
}

function normalizeTask(value) { return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' '); }

export async function resolveWorldModelContext(root, config, phase, { task = null, evidence = false, includePersonaPrompt = false } = {}) {
  const phaseConfig = config.phases?.[phase];
  if (!phaseConfig) throw new SingularityFlowError(`Unknown world-model phase: ${phase}`);
  const directory = path.join(root, config.outputDir);
  const { manifest } = await validateWorldModelDirectory(directory, { requiredViews: phaseConfig.views ?? [], requireEvidence: evidence || phaseConfig.evidence || config.context?.includeEvidence });
  const freshness = await worldModelFreshness(root, config, manifest);
  const selected = [];
  const add = async (relative, level, reason, required = true) => {
    if (!relative) {
      if (required) throw new SingularityFlowError(`Required world-model context is not declared: ${reason}.`);
      return;
    }
    const absolute = safeModelPath(directory, relative, `World-model context '${reason}'`);
    const info = await snapshot(absolute);
    if (!info.exists || !info.sha256 || info.size < 1) {
      if (required) throw new SingularityFlowError(`Required world-model context is missing: ${relative} (${reason}).`);
      return;
    }
    const relativePath = posix(relative);
    if (!selected.some((item) => item.relative === relativePath)) selected.push({ relative: relativePath, absolute, level, reason, ...info });
  };
  for (const relative of config.context?.always ?? ['core/summary.md']) await add(relative, 0, 'shared repository core');
  if (includePersonaPrompt && config.personaPrompt) {
    const info = await snapshot(path.join(root, config.personaPrompt));
    if (!info.exists) throw new SingularityFlowError(`Active persona prompt is missing: ${config.personaPrompt}`);
  }
  for (const view of phaseConfig.views ?? []) await add(manifest.views?.[view]?.path, 1, `${phase} view: ${view}`);
  if (config.context?.includeDomains !== 'none') {
    for (const domain of manifest.domains ?? []) {
      if (config.context.includeDomains === 'all' || (domain.relevant_views ?? []).some((view) => phaseConfig.views.includes(view))) await add(domain.path, 2, `domain: ${domain.id}`);
    }
  }
  if (task) {
    const normalized = normalizeTask(task);
    const exact = (manifest.task_guides ?? []).find((guide) => normalizeTask(guide.task) === normalized);
    if (!exact) throw new SingularityFlowError(`World model has no task guide for '${task}'. Rebuild it with the same --task value.`);
    await add(exact.path, 2, `task guide: ${exact.id}`);
  }
  if (evidence || phaseConfig.evidence || config.context?.includeEvidence) await add(manifest.evidence?.path, 3, 'evidence ledger');
  return { manifest, freshness, selected, directory };
}

export function worldModelCommit(root, outputDir) {
  return run('git', ['log', '-1', '--format=%H', '--', outputDir], { cwd: root, allowFailure: true }).stdout.trim() || null;
}

export function groundingRecordRelative(definition, workflow, phase, generation = phase.generation + 1) {
  return posix(path.join(definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', `${phase.id}-gen${generation}.json`));
}

function severityResult(mode, messages) {
  return mode === 'enforce' ? { errors: messages, warnings: [] } : { errors: [], warnings: messages };
}

export async function verifyGroundingRecord(root, definition, workflow, phase, { generation = phase.generation + 1, persona = null } = {}) {
  const mode = groundingMode(definition, workflow);
  if (mode === 'off') return { mode, errors: [], warnings: [], passes: [], record: null, path: null };
  const relative = groundingRecordRelative(definition, workflow, phase, generation);
  const absolute = path.join(root, relative);
  if (!(await exists(absolute))) {
    const severity = severityResult(mode, [`grounding composition is missing for ${phase.id} generation ${generation}; run singularity-flow wm compose --phase ${phase.id}`]);
    return { mode, ...severity, passes: [], record: null, path: relative };
  }
  let record;
  try { record = JSON.parse(await readFile(absolute, 'utf8')); }
  catch (error) {
    const severity = severityResult(mode, [`grounding composition is invalid JSON for ${phase.id} generation ${generation}: ${error.message}`]);
    return { mode, ...severity, passes: [], record: null, path: relative };
  }
  const problems = [];
  if (record.workId !== workflow.workItem.id || record.phase !== phase.id || record.generation !== generation) problems.push(`grounding composition identity mismatch: ${relative}`);
  if (!record.persona) problems.push(`grounding composition has no persona: ${relative}`);
  else if (!definition.personas?.[record.persona]) problems.push(`grounding composition uses unknown persona '${record.persona}': ${relative}`);
  if (persona && record.persona !== persona) problems.push(`grounding composition persona '${record.persona}' differs from active persona '${persona}'`);
  if (!/^[0-9a-f]{40}$/.test(record.worldModelCommit ?? '')) problems.push(`grounding composition has no committed world-model revision: ${relative}`);
  for (const field of ['manifestSha256', 'renderedSha256']) if (!/^[0-9a-f]{64}$/.test(record[field] ?? '')) problems.push(`grounding composition has invalid ${field}: ${relative}`);
  for (const field of ['modelSourceTreeSha256', 'composedSourceTreeSha256']) if (!/^sha256:[0-9a-f]{64}$/.test(record[field] ?? '')) problems.push(`grounding composition has invalid ${field}: ${relative}`);
  if (record.fresh !== true) problems.push(`grounding composition was created from a stale world model: ${relative}`);
  if (record.modelSourceTreeSha256 && record.composedSourceTreeSha256 && record.modelSourceTreeSha256 !== record.composedSourceTreeSha256) problems.push(`grounding composition source hash does not match its world model: ${relative}`);
  if (!Array.isArray(record.files) || !record.files.length) problems.push(`grounding composition contains no world-model files: ${relative}`);
  if (!record.promptPath) problems.push(`grounding composition has no committed prompt snapshot: ${relative}`);
  else {
    const promptRelative = posix(record.promptPath);
    const expectedRoot = `${posix(path.join(definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', 'prompts'))}/`;
    if (!promptRelative.startsWith(expectedRoot)) problems.push(`grounding prompt snapshot escapes the work-item context: ${promptRelative}`);
    else {
      const info = await snapshot(path.join(root, promptRelative));
      if (!info.exists || info.sha256 !== record.renderedSha256) problems.push(`grounding prompt snapshot hash differs: ${promptRelative}`);
    }
  }
  const requiredViews = [...new Set([
    ...(phase.worldModel?.views ?? []),
    ...(definition.personas?.[persona ?? record.persona]?.worldModelViews ?? [])
  ])];
  for (const view of requiredViews) if (!(record.requiredViews ?? []).includes(view)) problems.push(`grounding composition omitted required view '${view}' for ${phase.id}`);
  const seen = new Set();
  for (const file of record.files ?? []) {
    if (seen.has(file.path)) problems.push(`grounding composition repeats ${file.path}`);
    seen.add(file.path);
    if (!file.path?.startsWith(`${posix(definition.worldModel?.outputDir ?? 'singularity/world-model').replace(/\/$/, '')}/`)) problems.push(`grounding composition references a file outside the world model: ${file.path}`);
    if (!/^[0-9a-f]{64}$/.test(file.sha256 ?? '')) problems.push(`grounding composition has invalid hash for ${file.path}`);
    if (!['required', 'rule'].includes(file.category)) problems.push(`grounding composition has invalid category for ${file.path}`);
    if (!Number.isInteger(file.bytes) || file.bytes < 1 || !Number.isInteger(file.injectedBytes) || file.injectedBytes < 0 || file.injectedBytes > file.bytes) problems.push(`grounding composition has invalid byte accounting for ${file.path}`);
    if (file.category === 'required' && (file.truncated || file.injectedBytes !== file.bytes)) problems.push(`required grounding was truncated for ${file.path}`);
    if (record.worldModelCommit && file.path && file.sha256) {
      const content = run('git', ['show', `${record.worldModelCommit}:${file.path}`], { cwd: root, allowFailure: true });
      if (content.status !== 0) problems.push(`world-model commit ${record.worldModelCommit.slice(0, 8)} does not contain ${file.path}`);
      else if (createHash('sha256').update(content.stdout).digest('hex') !== file.sha256) problems.push(`world-model commit hash differs for ${file.path}`);
    }
  }
  let committedManifest = null;
  if (record.worldModelCommit && record.manifestSha256) {
    const manifestPath = posix(path.join(definition.worldModel?.outputDir ?? 'singularity/world-model', 'manifest.json'));
    const content = run('git', ['show', `${record.worldModelCommit}:${manifestPath}`], { cwd: root, allowFailure: true });
    if (content.status !== 0) problems.push(`world-model commit ${record.worldModelCommit.slice(0, 8)} does not contain manifest.json`);
    else {
      if (createHash('sha256').update(content.stdout).digest('hex') !== record.manifestSha256) problems.push('world-model manifest hash differs from the composition record');
      try { committedManifest = JSON.parse(content.stdout); }
      catch { problems.push('committed world-model manifest is invalid JSON'); }
    }
  }
  if (committedManifest) {
    if (committedManifest.source_tree_sha256 !== record.modelSourceTreeSha256) problems.push('world-model source hash differs from the composition record');
    for (const view of requiredViews) {
      const viewPath = committedManifest.views?.[view]?.path;
      const recordedPath = viewPath ? posix(path.join(definition.worldModel?.outputDir ?? 'singularity/world-model', viewPath)) : null;
      if (!recordedPath || !(record.files ?? []).some((file) => file.path === recordedPath)) problems.push(`grounding composition has no committed content for required view '${view}'`);
    }
    const requiredContextPaths = [committedManifest.core?.summary];
    if (record.task) {
      const guide = (committedManifest.task_guides ?? []).find((entry) => normalizeTask(entry.task) === normalizeTask(record.task));
      if (!guide) problems.push(`committed world model has no exact task guide for '${record.task}'`);
      else requiredContextPaths.push(guide.path);
    }
    if (phase.worldModel?.evidence) requiredContextPaths.push(committedManifest.evidence?.path);
    for (const contextPath of requiredContextPaths.filter(Boolean)) {
      const recordedPath = posix(path.join(definition.worldModel?.outputDir ?? 'singularity/world-model', contextPath));
      if (!(record.files ?? []).some((file) => file.path === recordedPath)) problems.push(`grounding composition omitted required context '${contextPath}'`);
    }
  }
  const severity = severityResult(mode, problems);
  return {
    mode, ...severity,
    passes: problems.length ? [] : [`grounding composition: ${phase.id} generation ${generation} (${record.files.length} files)`],
    record, path: relative
  };
}

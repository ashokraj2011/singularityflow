import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadDefinition } from '../config.mjs';
import { repoRoot } from '../git.mjs';
import { optionBoolean, optionString, requirePositional, SingularityFlowError } from '../util.mjs';
import { canonicalJson, sha256 } from '../world-model/canonicalize.mjs';
import { worldModelStateAuthority } from '../world-model/authority-config.mjs';
import {
  createArchitectureIntent,
  explainArchitectureElement, renderPlannedArchitecture, validateArchitectureIntent,
  validateCalmProjection, verifyArchitectureIntent
} from '../world-model/projections/calm/projection.mjs';
import { validateCalmWithOfficialToolchain } from '../world-model/projections/calm/validator.mjs';
import { resolvePublishedWorldModelV4 } from '../world-model/store.mjs';

const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function workId(value) {
  const normalized = String(value ?? '').trim();
  if (!WORK_ID.test(normalized)) fail('Architecture intent requires a safe Work ID.', 'WMC_INTENT_INVALID');
  return normalized;
}

function architectureDirectory(root, id) {
  return path.join(root, 'singularity', 'work-items', workId(id), 'context', 'architecture');
}

function safeOutput(root, value) {
  const supplied = String(value ?? '').trim().replaceAll('\\', '/');
  if (!supplied || path.posix.isAbsolute(supplied) || /^[A-Za-z]:\//.test(supplied)
      || supplied.split('/').includes('..') || supplied.startsWith('singularity/world-model/')) {
    fail('CALM export target must be a repository-relative path outside governed World-Model authority.',
      'WMC_EXPORT_TARGET_UNSAFE', { target: supplied || null });
  }
  return path.join(root, supplied);
}

async function baseProjection(root) {
  const definition = await loadDefinition(root);
  const authority = worldModelStateAuthority(definition, {});
  const store = resolvePublishedWorldModelV4(root, {
    outputDir: 'singularity/world-model', stateBranch: authority.branch, remote: authority.remote
  });
  const built = store.projections?.find((entry) => entry.projectionId === 'arch.calm');
  if (!built || built.status !== 'available') {
    fail('The reusable state authority does not contain an available arch.calm projection.',
      'WMC_PROJECTION_NOT_CONFIGURED', {
        nextAction: 'singularity-flow wm build --projections arch.calm'
      });
  }
  return { definition, store, built };
}

async function readIntent(root, id) {
  const target = path.join(architectureDirectory(root, id), 'architecture-intent.json');
  let parsed;
  try { parsed = JSON.parse(await readFile(target, 'utf8')); }
  catch (error) {
    fail(`Architecture intent for '${id}' is unavailable: ${error.message}`, 'WMC_INTENT_INVALID', { path: target });
  }
  return { target, intent: validateArchitectureIntent(parsed) };
}

async function selectedProjection(root, options) {
  const base = await baseProjection(root);
  if (!optionBoolean(options, 'planned')) return { ...base, selected: base.built, planned: false };
  const id = workId(optionString(options, 'work-id'));
  const { intent } = await readIntent(root, id);
  const selected = renderPlannedArchitecture({
    projection: base.built.projection,
    projectionSha256: base.built.projectionSha256,
    worldModelManifestSha256: base.store.manifest.manifestSha256,
    intent
  });
  return { ...base, selected, planned: true, workId: id, intent };
}

function summary(value) {
  const projection = value.selected.projection;
  const unavailable = value.built.factSet.unavailable.length;
  const contradictions = value.built.factSet.contradictions.length;
  return {
    schemaVersion: 1,
    kind: 'architecture-projection-summary',
    projection: value.planned ? 'arch.calm.planned' : 'arch.calm',
    projectionSha256: value.selected.projectionSha256,
    worldModelManifestSha256: value.store.manifest.manifestSha256,
    sourceManifestSha256: value.store.manifest.sourceManifestSha256,
    stateAuthorityCommit: value.store.commit,
    validation: 'passed',
    counts: {
      nodes: projection.nodes.length,
      relationships: projection.relationships.length,
      interfaces: projection.nodes.reduce((sum, node) => sum + (node.interfaces?.length ?? 0), 0),
      controls: Object.keys(projection.controls).length,
      flows: projection.flows.length,
      unavailable,
      contradictions
    },
    topLevel: projection.nodes
      .filter((node) => !projection.relationships.some((relationship) =>
        relationship['relationship-type']?.['composed-of']?.nodes?.includes(node['unique-id'])))
      .map((node) => ({ id: node['unique-id'], type: node['node-type'], name: node.name }))
  };
}

function printSummary(value) {
  console.log(`Architecture ${value.projection}: ${value.validation}`);
  console.log(`Projection: ${value.projectionSha256}`);
  console.log(`World model: ${value.worldModelManifestSha256}`);
  console.log(`Nodes ${value.counts.nodes} · relationships ${value.counts.relationships}`
    + ` · interfaces ${value.counts.interfaces} · controls ${value.counts.controls}`);
  console.log(`Contradictions ${value.counts.contradictions} · unavailable ${value.counts.unavailable}`);
  if (value.topLevel.length) {
    console.log('\nTop-level architecture');
    for (const item of value.topLevel) console.log(`  ${item.id} · ${item.type} · ${item.name}`);
  }
  console.log('\nExpand safely: singularity-flow architecture explain <ELEMENT-ID>');
}

async function intentCommand(root, positionals, options, json) {
  const action = positionals[2] ?? 'validate';
  const id = workId(optionString(options, 'work-id') ?? positionals[3]);
  if (action === 'init') {
    const from = optionString(options, 'from');
    if (!from) fail('Architecture intent init requires --from <reviewed-json-file>.', 'WMC_INTENT_INVALID');
    const source = safeOutput(root, from);
    let candidate;
    try { candidate = JSON.parse(await readFile(source, 'utf8')); }
    catch (error) { fail(`Cannot read architecture intent candidate: ${error.message}`, 'WMC_INTENT_INVALID'); }
    const base = await baseProjection(root);
    const intent = createArchitectureIntent({
      workId: id,
      phase: candidate.phase,
      generation: candidate.generation,
      base: {
        worldModelManifestSha256: base.store.manifest.manifestSha256,
        calmProjectionSha256: base.built.projectionSha256
      },
      clauses: candidate.clauses
    });
    const directory = architectureDirectory(root, id);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, 'architecture-intent.json');
    await writeFile(target, canonicalJson(intent), { flag: 'wx', mode: 0o600 });
    const result = { status: 'created', workId: id, path: path.relative(root, target), intentSha256: intent.intentSha256 };
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`Architecture intent created: ${result.path}\n${result.intentSha256}\nIt is not approved; publish it through the normal Story phase.`);
    return result;
  }
  const { target, intent } = await readIntent(root, id);
  if (action === 'validate') {
    const result = { status: 'valid', workId: id, path: path.relative(root, target), intentSha256: intent.intentSha256 };
    if (json) console.log(JSON.stringify(result, null, 2)); else console.log(`Architecture intent: valid\n${result.intentSha256}`);
    return result;
  }
  const base = await baseProjection(root);
  if (action === 'render') {
    const planned = renderPlannedArchitecture({
      projection: base.built.projection,
      projectionSha256: base.built.projectionSha256,
      worldModelManifestSha256: base.store.manifest.manifestSha256,
      intent
    });
    await validateCalmWithOfficialToolchain(planned.projection);
    const directory = architectureDirectory(root, id);
    await writeFile(path.join(directory, 'arch.calm.planned.json'), canonicalJson(planned.projection), { mode: 0o600 });
    await writeFile(path.join(directory, 'planned-projection-receipt.json'), canonicalJson(planned.receipt), { mode: 0o600 });
    const result = { status: 'rendered', workId: id, projectionSha256: planned.projectionSha256,
      paths: ['arch.calm.planned.json', 'planned-projection-receipt.json'].map((name) =>
        path.relative(root, path.join(directory, name))) };
    if (json) console.log(JSON.stringify(result, null, 2)); else console.log(`Planned architecture rendered: ${result.projectionSha256}`);
    return result;
  }
  if (action === 'verify') {
    const report = verifyArchitectureIntent({
      intent, baseAfter: base.built.projection, baseAfterSha256: base.built.projectionSha256
    });
    const directory = architectureDirectory(root, id);
    await writeFile(path.join(directory, 'intent-fulfilment.json'), canonicalJson(report), { mode: 0o600 });
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(`Architecture intent fulfilment: ${report.blocking ? 'blocking' : 'satisfied'}\n${report.reportSha256}`);
    return report;
  }
  fail(`Unknown architecture intent action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

export async function run(_argv, { positionals, options } = {}) {
  const root = repoRoot();
  const action = positionals[1] ?? 'show';
  const json = optionBoolean(options, 'json');
  if (action === 'intent') return intentCommand(root, positionals, options, json);
  if (action === 'show') {
    const value = await selectedProjection(root, options);
    if (json) console.log(JSON.stringify({ ...summary(value), document: value.selected.projection }, null, 2));
    else printSummary(summary(value));
    return value;
  }
  if (['explain', 'sources'].includes(action)) {
    const elementId = requirePositional(positionals, 2, 'architecture element ID');
    const value = await selectedProjection(root, options);
    const explained = explainArchitectureElement({
      projection: value.selected.projection, sourceMap: value.built.sourceMap, elementId,
      intent: value.intent ?? null,
      intentPath: value.workId
        ? path.posix.join('singularity', 'work-items', value.workId, 'context', 'architecture', 'architecture-intent.json')
        : null
    });
    if (json) console.log(JSON.stringify(explained, null, 2));
    else {
      console.log(`${explained.elementKind} ${explained.elementId} · ${explained.status}`);
      for (const source of explained.sources) console.log(`  ${source.sourceKind}: ${source.path ?? source.factId ?? source.recordId}`);
      if (explained.changeAt.length) console.log(`Change the authoritative source: ${explained.changeAt.join(', ')}`);
    }
    return explained;
  }
  if (action === 'validate') {
    const value = await selectedProjection(root, options);
    validateCalmProjection(value.selected.projection);
    const official = await validateCalmWithOfficialToolchain(value.selected.projection);
    const result = {
      status: official.status,
      projectionSha256: value.selected.projectionSha256,
      toolchainLockSha256: official.toolchainLock.lockSha256,
      normalizedResultSha256: official.normalizedResultSha256,
      diagnostics: official.normalizedResult
    };
    if (json) console.log(JSON.stringify(result, null, 2)); else console.log(`CALM validation: ${result.status}\n${result.projectionSha256}`);
    return result;
  }
  if (action === 'doctor') {
    try {
      const value = await baseProjection(root);
      const result = { status: 'ready', projectionSha256: value.built.projectionSha256,
        manifestSha256: value.store.manifest.manifestSha256, nextAction: 'singularity-flow architecture show' };
      if (json) console.log(JSON.stringify(result, null, 2)); else console.log(`Architecture projection: ready\n${result.nextAction}`);
      return result;
    } catch (error) {
      error.details = { ...(error.details ?? {}), nextAction: error.details?.nextAction ?? 'singularity-flow wm build --format registered-v4' };
      throw error;
    }
  }
  if (action === 'export') {
    const format = optionString(options, 'format', 'calm');
    if (format !== 'calm') fail("Initial WMC export supports only '--format calm'.", 'WMC_EXPORT_TARGET_UNSAFE');
    const target = safeOutput(root, optionString(options, 'out'));
    const value = await selectedProjection(root, options);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, canonicalJson(value.selected.projection), { flag: 'wx', mode: 0o600 });
    const result = { status: 'exported', path: path.relative(root, target),
      projectionSha256: value.selected.projectionSha256, stateChanged: false };
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`CALM exported without changing SFlow authority: ${result.path}\n${result.projectionSha256}`);
    return result;
  }
  if (action === 'diff') {
    const fromPath = safeOutput(root, optionString(options, 'from'));
    const toPath = safeOutput(root, optionString(options, 'to'));
    const [from, to] = await Promise.all([readFile(fromPath, 'utf8'), readFile(toPath, 'utf8')]);
    const result = { identical: from === to, fromSha256: sha256({ utf8: from }), toSha256: sha256({ utf8: to }) };
    if (json) console.log(JSON.stringify(result, null, 2)); else console.log(result.identical ? 'Architecture projections are byte-identical.' : `Architecture changed: ${result.fromSha256} -> ${result.toSha256}`);
    return result;
  }
  fail(`Unknown architecture action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

/** Fail-closed REV acceptance applicability and executable-witness inventory. */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readRecord } from '../schema-migrations.mjs';
import { revisionRuntimeCapabilities } from './runtime.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const TEST_FILE = /^test\/[a-zA-Z0-9][a-zA-Z0-9/_-]*\.test\.mjs$/;
const PROFILES = Object.freeze(['disabled', 'REV_POC_SINGLE_REPO', 'REV_FULL_DEFAULT']);

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function range(family, first, last) {
  return Array.from({ length: last - first + 1 }, (_, index) =>
    `REV:${family}-${String(first + index).padStart(3, '0')}`);
}

const ALL_CRITERIA = Object.freeze([
  ...range('AC', 1, 190), ...range('CODE-AC', 1, 8), ...range('UPLOAD-AC', 1, 10)
]);
const ALL_SET = new Set(ALL_CRITERIA);
const PILOT_CORE = Object.freeze([
  ...range('AC', 1, 60), ...range('AC', 62, 65), ...range('AC', 72, 80),
  ...range('AC', 84, 88), ...range('AC', 91, 91), ...range('AC', 93, 95),
  ...range('AC', 98, 98), ...range('AC', 101, 112), ...range('AC', 116, 116),
  ...range('AC', 125, 139), ...range('AC', 141, 142), ...range('AC', 148, 150),
  ...range('AC', 161, 168), ...range('AC', 189, 190), ...range('CODE-AC', 1, 8)
]);

/** Section 40.16's closed optional-capability map; the Code-result surface is pilot core. */
const OPTIONAL = Object.freeze({
  'shared-fresh-clone-chain': [...range('AC', 61, 61), ...range('AC', 140, 140)],
  'post-publication-reopen': range('AC', 66, 66),
  'auto-mode': range('AC', 67, 71),
  'copilot-vscode-mutation': range('AC', 81, 83),
  'amendment-artifact-mutation': [
    ...range('AC', 89, 90), ...range('AC', 92, 92), ...range('AC', 96, 97),
    ...range('AC', 99, 100), ...range('AC', 169, 180)
  ],
  'external-effects-sync': [...range('AC', 113, 115), ...range('AC', 181, 184)],
  'remote-shared-head': range('AC', 117, 124),
  'composite-repositories': range('AC', 143, 147),
  'collaborative-feedback-attachments': range('AC', 151, 160),
  'high-assurance-regulated-proof': range('AC', 185, 186),
  'advanced-retention-legal-hold': range('AC', 187, 188),
  'copilot-upload': range('UPLOAD-AC', 1, 10)
});
const OPTIONAL_OWNER = new Map(Object.entries(OPTIONAL)
  .flatMap(([capability, criteria]) => criteria.map((criterion) => [criterion, capability])));
const KNOWN_CAPABILITIES = new Set(['revision-loop', 'revision-code-results', ...Object.keys(OPTIONAL)]);

function exactKeys(value, keys) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function fail(message) {
  const error = new Error(`REV trace manifest: ${message}`);
  error.code = 'REV_TRACE_INCOMPLETE';
  throw error;
}

/** Ranges are compact on disk, but every AC is checked individually. */
export function expandRevisionCriterionIds(expression) {
  const match = /^REV:(AC|CODE-AC|UPLOAD-AC)-(\d{3})(?:\.\.(\d{3}))?$/.exec(expression ?? '');
  if (!match) fail(`invalid criterion expression '${expression}'`);
  const first = Number(match[2]);
  const last = match[3] == null ? first : Number(match[3]);
  if (first > last) fail(`descending criterion range '${expression}'`);
  const ids = range(match[1], first, last);
  if (ids.some((id) => !ALL_SET.has(id))) fail(`criterion range '${expression}' is outside the REV catalog`);
  return ids;
}

function expectedEnabled(profile, advertisedCapabilities) {
  if (profile === 'disabled') return new Set();
  const expected = new Set(PILOT_CORE);
  for (const capability of advertisedCapabilities) {
    for (const id of OPTIONAL[capability] ?? []) expected.add(id);
  }
  return expected;
}

function testCall(ts, node) {
  if (!ts.isCallExpression(node) || !node.arguments.length) return null;
  function parts(expression) {
    if (ts.isIdentifier(expression)) return [expression.text];
    if (ts.isPropertyAccessExpression(expression)) {
      const prefix = parts(expression.expression);
      return prefix ? [...prefix, expression.name.text] : null;
    }
    return null;
  }
  const names = parts(node.expression);
  if (!names || !['test', 'it', 'describe'].includes(names[0])) return null;
  const modifiers = names.slice(1);
  const suite = names[0] === 'describe' || modifiers.includes('describe');
  if (!suite && modifiers.some((name) => !['skip', 'todo', 'only'].includes(name))) return null;
  const title = node.arguments[0];
  if (!ts.isStringLiteral(title) && !ts.isNoSubstitutionTemplateLiteral(title)) return null;
  const controlled = node.arguments.some((argument) => ts.isObjectLiteralExpression(argument)
    && argument.properties.some((property) => ts.isPropertyAssignment(property)
      && ['skip', 'todo', 'only'].includes(ts.isIdentifier(property.name)
        || ts.isStringLiteral(property.name) ? property.name.text : null)
      && property.initializer.kind !== ts.SyntaxKind.FalseKeyword));
  return { title: title.text, kind: suite ? 'suite' : 'test',
    disabled: modifiers.some((name) => name !== 'describe') || controlled };
}

/** Only syntactically identified test callbacks count; comments and test names alone never witness an AC. */
export async function collectRevisionTestBodies(source, filename = 'test/witness.test.mjs') {
  let ts;
  try { ({ default: ts } = await import('typescript')); }
  catch { fail('the TypeScript parser needed to identify exact test bodies is unavailable'); }
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) fail(`test source '${filename}' has parser diagnostics`);
  const bodies = [];
  function visit(node, ancestors, inheritedDisabled = false) {
    const call = testCall(ts, node);
    const callback = call == null ? null : [...node.arguments].reverse().find((argument) =>
      ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
    if (call && callback) {
      const namePath = [...ancestors, call.title];
      const disabled = inheritedDisabled || call.disabled;
      if (call.kind === 'test') {
        bodies.push({ namePath, bodySha256: sha256(callback.body.getText(parsed)), disabled });
      }
      ts.forEachChild(callback.body, (child) => visit(child, namePath, disabled));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, ancestors, inheritedDisabled));
  }
  visit(parsed, []);
  return bodies;
}

async function checkWitness(id, row, repositoryRoot, cache) {
  if (!exactKeys(row, ['test', 'namePath', 'bodySha256', 'sourceSha256'])) {
    fail(`${id} witness fields must be test, namePath, bodySha256, and sourceSha256`);
  }
  if (!TEST_FILE.test(row.test) || !Array.isArray(row.namePath) || row.namePath.length === 0
      || row.namePath.some((name) => typeof name !== 'string' || !name.trim())
      || !HASH.test(row.bodySha256) || !HASH.test(row.sourceSha256)) {
    fail(`${id} has an invalid exact test identity or digest`);
  }
  if (row.namePath.at(-1) !== id && !row.namePath.at(-1).startsWith(`${id} `)) {
    fail(`${id} witness test name must identify that criterion`);
  }
  let source = cache.get(row.test);
  if (!source) {
    const testRoot = await realpath(path.resolve(repositoryRoot, 'test'));
    const absolute = path.resolve(repositoryRoot, row.test);
    let real;
    try { real = await realpath(absolute); }
    catch { fail(`${id} witness test '${row.test}' is missing`); }
    if (!real.startsWith(`${testRoot}${path.sep}`)) fail(`${id} witness resolves outside test/`);
    const bytes = await readFile(real);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    source = { sourceSha256: sha256(bytes), bodies: await collectRevisionTestBodies(decoded, row.test) };
    cache.set(row.test, source);
  }
  if (source.sourceSha256 !== row.sourceSha256) fail(`${id} witness source changed`);
  const matches = source.bodies.filter((body) =>
    JSON.stringify(body.namePath) === JSON.stringify(row.namePath));
  if (matches.length !== 1) fail(`${id} witness name path is missing or duplicated`);
  if (matches[0].disabled) fail(`${id} witness is skipped, todo, or focused`);
  if (matches[0].bodySha256 !== row.bodySha256) fail(`${id} witness body changed`);
}

/** Structural and source witness gate. Runtime activation is checked independently of claims. */
export async function validateRevisionTraceManifest(manifest, {
  repositoryRoot,
  runtimeCapabilities = revisionRuntimeCapabilities,
  witnessContext = null
} = {}) {
  try { readRecord('revision-trace-manifest', manifest); }
  catch { fail('top-level schema version is unreadable'); }
  if (!exactKeys(manifest, [
    'schemaVersion', 'kind', 'specificationVersion', 'activationProfile', 'decisionOwner', 'validatedBy',
    'advertisedCapabilities', 'enabledCriteria', 'deferredCriteria'
  ]) || manifest.kind !== 'revision-trace-manifest'
      || manifest.specificationVersion !== '0.6.0') {
    fail('top-level fields or version are invalid');
  }
  const profile = manifest.activationProfile;
  if (!PROFILES.includes(profile)) fail(`unknown activation profile '${profile}'`);
  if (runtimeCapabilities.activationProfile !== profile) fail('declared profile disagrees with installed runtime');
  if (runtimeCapabilities.codeRevisionExecutionAvailable !== (profile !== 'disabled')) {
    fail('declared profile disagrees with code-execution availability');
  }
  if (profile !== 'disabled') {
    for (const flag of [
      'publicRoutePreviewAvailable', 'publicPacketPlanningAvailable', 'manualCaptureAvailable',
      'candidateHeadCasAvailable', 'codeResultAvailable', 'publicationBridgeAvailable',
      'releaseWitnessExecutionAvailable'
    ]) {
      if (runtimeCapabilities[flag] !== true) fail(`active profile lacks runtime bridge '${flag}'`);
    }
  }
  if (profile !== 'disabled' && (!exactKeys(witnessContext, ['sourceCommit', 'platformProfile'])
      || !/^[a-f0-9]{40,64}$/.test(witnessContext.sourceCommit)
      || !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(witnessContext.platformProfile))) {
    fail('active witnesses require an exact source commit and supported platform profile');
  }
  const capabilities = manifest.advertisedCapabilities;
  if (!Array.isArray(capabilities) || capabilities.some((value) => !KNOWN_CAPABILITIES.has(value))
      || new Set(capabilities).size !== capabilities.length) fail('advertised capabilities are invalid or duplicated');
  const active = profile !== 'disabled';
  if (active !== capabilities.includes('revision-loop')
      || active !== capabilities.includes('revision-code-results')) {
    fail('core REV loop and Code-result capabilities must match activation');
  }
  if (!active && capabilities.length) fail('disabled REV cannot advertise optional capabilities');
  for (const capability of capabilities) {
    if (OPTIONAL[capability] && runtimeCapabilities.optionalCapabilities?.[capability] !== true) {
      fail(`advertised capability '${capability}' is not installed in the runtime`);
    }
  }
  if (profile === 'REV_FULL_DEFAULT' && (![manifest.decisionOwner, manifest.validatedBy]
    .every((value) => typeof value === 'string' && value.trim().length > 0))) {
    fail('default activation requires a decision owner and validator');
  }
  if (!exactKeys(manifest.enabledCriteria, Object.keys(manifest.enabledCriteria ?? {}))
      || !Array.isArray(manifest.deferredCriteria)) fail('criterion partitions are malformed');
  const enabled = new Set(Object.keys(manifest.enabledCriteria));
  const required = expectedEnabled(profile, capabilities);
  for (const id of enabled) if (!ALL_SET.has(id)) fail(`unknown enabled criterion '${id}'`);
  for (const id of required) if (!enabled.has(id)) fail(`enabled profile lacks ${id} witness`);
  for (const id of enabled) if (!required.has(id)) fail(`${id} is advertised without its capability`);

  const deferred = new Map();
  for (const row of manifest.deferredCriteria) {
    if (!exactKeys(row, ['ids', 'unavailableCapability', 'reason'])
        || typeof row.reason !== 'string' || !row.reason.trim()
        || typeof row.unavailableCapability !== 'string' || !row.unavailableCapability) {
      fail('deferred criterion row is malformed');
    }
    for (const id of expandRevisionCriterionIds(row.ids)) {
      if (deferred.has(id)) fail(`${id} has duplicate deferment`);
      if (enabled.has(id)) fail(`${id} is both advertised and deferred`);
      const owner = OPTIONAL_OWNER.get(id);
      const expectedCapability = active ? owner : id.startsWith('REV:UPLOAD-AC-') ? 'copilot-upload' : 'revision-loop';
      if (row.unavailableCapability !== expectedCapability) {
        fail(`${id} deferment names the wrong unavailable capability`);
      }
      deferred.set(id, row);
    }
  }
  for (const id of ALL_CRITERIA) {
    if (!enabled.has(id) && !deferred.has(id)) fail(`${id} lacks a witness or explicit deferment`);
  }
  const cache = new Map();
  if (enabled.size && !repositoryRoot) fail('repositoryRoot is required to verify enabled witnesses');
  for (const id of enabled) await checkWitness(id, manifest.enabledCriteria[id], repositoryRoot, cache);
  return Object.freeze({
    activationProfile: profile,
    advertisedCapabilities: Object.freeze([...capabilities]),
    enabledCriterionCount: enabled.size,
    deferredCriterionCount: deferred.size,
    manifestSha256: sha256(JSON.stringify(manifest)),
    sourceCommit: profile === 'disabled' ? null : witnessContext.sourceCommit,
    platformProfile: profile === 'disabled' ? null : witnessContext.platformProfile
  });
}

export const REV_ALL_CRITERIA = ALL_CRITERIA;
export const REV_PILOT_CORE_CRITERIA = PILOT_CORE;
export const REV_OPTIONAL_CRITERIA = OPTIONAL;

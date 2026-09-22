/** Private runtime bindings for names declared in singularity/environments.yml. */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import {
  ENVIRONMENT_IDENTIFIER, loadEnvironmentDeclaration
} from './environment-declaration.mjs';
import {
  readPrivateSidecar, safePrivateSidecarDirectory, writeMutablePrivateSidecar
} from './private-sidecar.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

const MAXIMUM_BINDING_BYTES = 256 * 1024;
const VARIABLE = /^[A-Z][A-Z0-9_]{0,127}$/;
const supportedBindingVersions = Object.freeze({ 1: true });
export const PUBLIC_ENVIRONMENT_BINDING_SOURCES = Object.freeze([
  'none', 'private-binding', 'private-binding+declaration-defaults', 'declaration-defaults'
]);

function fail(message, code = 'ENVIRONMENT_BINDING_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function bindingDirectory(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'environments', 'v1');
}

function bindingPath(root, environmentId) {
  return path.join(bindingDirectory(root), `${environmentId}.json`);
}

function exactKeys(value, allowed, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`${label} contains unsupported field(s): ${unknown.sort().join(', ')}.`);
}

function requiredEnvironment(declaration, environmentId) {
  if (typeof environmentId !== 'string' || !ENVIRONMENT_IDENTIFIER.test(environmentId)) {
    fail('Environment ID must be lower-kebab-case and at most 64 characters.');
  }
  const environment = declaration?.environments?.[environmentId];
  if (!environment) {
    fail(`Environment '${environmentId}' is not declared in singularity/environments.yml.`,
      'ENVIRONMENT_UNKNOWN', { environment: environmentId });
  }
  return environment;
}

function localValue(value, requirement) {
  if (typeof value !== 'string' || !value || value.length > 16_384 || /[\u0000]/u.test(value)) {
    fail(`Binding '${requirement.name}' must be a non-empty bounded string.`);
  }
  if (requirement.kind === 'endpoint') {
    let parsed;
    try { parsed = new URL(value); } catch {
      fail(`Endpoint binding '${requirement.name}' must be an absolute HTTP(S) URL.`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.search || parsed.hash) {
      fail(`Endpoint binding '${requirement.name}' must be an HTTP(S) URL without credentials, query, or fragment.`);
    }
  }
  if (requirement.kind === 'flag' && value.length > 256) {
    fail(`Flag binding '${requirement.name}' exceeds 256 characters.`);
  }
  return value;
}

function normalizeBindingInput(input, environment) {
  exactKeys(input, ['bindings'], 'Binding input');
  exactKeys(input.bindings, Object.keys(input.bindings ?? {}), 'bindings');
  const requirements = new Map(environment.requires.map((entry) => [entry.name, entry]));
  const bindings = {};
  for (const name of Object.keys(input.bindings).sort()) {
    if (!VARIABLE.test(name) || !requirements.has(name)) {
      fail(`Binding '${name}' is not required by the selected environment.`,
        'ENVIRONMENT_BINDING_NAME_UNKNOWN', { name });
    }
    const requirement = requirements.get(name);
    const entry = input.bindings[name];
    exactKeys(entry, entry?.source === 'local' ? ['source', 'value'] : ['source', 'reference'], `bindings.${name}`);
    if (entry.source === 'local') {
      bindings[name] = Object.freeze({ source: 'local', value: localValue(entry.value, requirement) });
    } else if (entry.source === 'reference') {
      if (typeof entry.reference !== 'string' || !entry.reference
          || entry.reference.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(entry.reference)) {
        fail(`Reference binding '${name}' must be a non-empty bounded opaque reference.`);
      }
      bindings[name] = Object.freeze({ source: 'reference', reference: entry.reference });
    } else fail(`bindings.${name}.source must be local or reference.`);
  }
  if (!Object.keys(bindings).length) fail('Binding input must contain at least one declared variable.');
  return Object.freeze(bindings);
}

function validateStoredRecord(record, environmentId, environment = null) {
  exactKeys(record, [
    'schemaVersion', 'kind', 'environment', 'declarationSha256', 'bindingRevision',
    'bindings', 'boundAt'
  ], 'Stored environment binding');
  if (supportedBindingVersions[record.schemaVersion] !== true || record.kind !== 'environment-binding'
      || record.environment !== environmentId
      || typeof record.declarationSha256 !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(record.declarationSha256)
      || typeof record.bindingRevision !== 'string'
      || !/^envb_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.bindingRevision)
      || typeof record.boundAt !== 'string' || Number.isNaN(Date.parse(record.boundAt))) {
    fail('Stored environment binding has invalid identity metadata.',
      'ENVIRONMENT_BINDING_CORRUPT');
  }
  exactKeys(record.bindings, Object.keys(record.bindings ?? {}), 'Stored environment bindings');
  const entries = Object.entries(record.bindings);
  if (!entries.length || entries.length > 128) {
    fail('Stored environment binding must contain between 1 and 128 variables.',
      'ENVIRONMENT_BINDING_CORRUPT');
  }
  const requirements = environment
    ? new Map(environment.requires.map((entry) => [entry.name, entry]))
    : null;
  for (const [name, entry] of entries) {
    if (!VARIABLE.test(name)) fail('Stored environment binding contains an invalid variable name.', 'ENVIRONMENT_BINDING_CORRUPT');
    const requirement = requirements?.get(name) ?? null;
    if (requirements && !requirement) {
      fail(`Stored environment binding contains undeclared variable '${name}'.`,
        'ENVIRONMENT_BINDING_CORRUPT');
    }
    exactKeys(entry, entry?.source === 'local' ? ['source', 'value'] : ['source', 'reference'], `Stored binding '${name}'`);
    if (entry.source === 'local') {
      if (typeof entry.value !== 'string' || !entry.value || entry.value.length > 16_384
          || /[\u0000]/u.test(entry.value)) {
        fail('Stored local environment binding is invalid.', 'ENVIRONMENT_BINDING_CORRUPT');
      }
      if (requirement) {
        try { localValue(entry.value, requirement); }
        catch {
          fail(`Stored local environment binding '${name}' violates its declared ${requirement.kind} contract.`,
            'ENVIRONMENT_BINDING_CORRUPT');
        }
      }
    } else if (entry.source === 'reference') {
      if (typeof entry.reference !== 'string' || !entry.reference
          || entry.reference.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(entry.reference)) {
        fail('Stored reference environment binding is invalid.', 'ENVIRONMENT_BINDING_CORRUPT');
      }
    } else fail('Stored environment binding has an unknown source.', 'ENVIRONMENT_BINDING_CORRUPT');
  }
  return record;
}

async function readRecord(root, environmentId, environment = null) {
  const bytes = await readPrivateSidecar(root, bindingPath(root, environmentId), {
    maximumBytes: MAXIMUM_BINDING_BYTES,
    optional: true,
    enforceWindowsAcl: true
  });
  if (!bytes) return null;
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('Stored environment binding is not valid UTF-8.', 'ENVIRONMENT_BINDING_CORRUPT');
  }
  let record;
  try { record = JSON.parse(source); }
  catch { fail('Stored environment binding is not valid JSON.', 'ENVIRONMENT_BINDING_CORRUPT'); }
  return validateStoredRecord(record, environmentId, environment);
}

function sourceFor(bindings, record) {
  const hasDefaults = Object.values(bindings).some((entry) => entry.source === 'declaration');
  if (record && hasDefaults) return 'private-binding+declaration-defaults';
  if (record) return 'private-binding';
  if (hasDefaults) return 'declaration-defaults';
  return 'none';
}

function declarationBindings(environment) {
  return Object.freeze(Object.fromEntries(environment.requires.flatMap((entry) => {
    if (entry.kind === 'endpoint' && entry.value != null) {
      return [[entry.name, Object.freeze({ source: 'declaration', value: entry.value })]];
    }
    if (entry.kind === 'flag' && entry.default != null) {
      return [[entry.name, Object.freeze({ source: 'declaration', value: entry.default })]];
    }
    return [];
  })));
}

function endpointFingerprint(requirements, bindings) {
  const endpoints = requirements
    .filter((entry) => entry.kind === 'endpoint'
      && ['local', 'declaration'].includes(bindings[entry.name]?.source))
    .map((entry) => ({ name: entry.name, value: bindings[entry.name].value }));
  return endpoints.length ? `sha256:${recordSha256(endpoints)}` : null;
}

function publicEnvironment(environmentId, declarationSha256, environment, record, effectiveBindings = null) {
  const bindings = effectiveBindings ?? record?.bindings ?? {};
  const boundNames = Object.keys(bindings).sort();
  const publicValue = {
    name: environmentId,
    declarationSha256: declarationSha256 ?? null,
    boundNames,
    endpointsSha256: environment ? endpointFingerprint(environment.requires, bindings) : null,
    secretsPresent: Object.freeze((environment?.requires ?? [])
      .filter((entry) => entry.kind === 'secret' && Object.hasOwn(bindings, entry.name))
      .map((entry) => entry.name).sort()),
    source: sourceFor(bindings, record),
    bindingRevision: record?.bindingRevision ?? null
  };
  const fingerprintCore = {
    ...publicValue,
    // Binding revision changes randomly for every update. Secret bytes and hashes never enter a
    // receipt, while a secret update still invalidates all earlier observations.
    requirementKinds: environment?.requires.map(({ name, kind }) => ({ name, kind })) ?? []
  };
  return Object.freeze({
    ...publicValue,
    fingerprintSha256: record || Object.keys(bindings).length
      ? `sha256:${recordSha256(fingerprintCore)}` : null
  });
}

/**
 * Resolve a private binding without disclosing values in the public environment projection.
 * This release returns metadata only. Runtime materialization belongs to a separately reviewed
 * runner boundary, so callers cannot accidentally serialize secret values from this API.
 */
export async function resolveEnvironmentBinding(root, environmentId, { commandId = null } = {}) {
  const declaration = await loadEnvironmentDeclaration(root, { optional: true });
  if (environmentId == null && commandId != null) {
    environmentId = declaration?.checks?.[commandId]?.environment ?? null;
  }
  if (environmentId == null) {
    return Object.freeze({ status: 'unbound', environment: null, missing: Object.freeze([]) });
  }
  const environment = declaration?.environments?.[environmentId] ?? null;
  const unavailable = (missing = []) => Object.freeze({
    status: 'unavailable',
    environment: publicEnvironment(
      environmentId, declaration?.declarationSha256 ?? null, environment, null
    ),
    missing: Object.freeze([...missing].sort())
  });
  if (!declaration || !environment) return unavailable(environment?.requires?.map((entry) => entry.name) ?? []);
  if (commandId && declaration.checks?.[commandId]
      && declaration.checks[commandId].environment !== environmentId) {
    return unavailable(environment.requires.map((entry) => entry.name));
  }
  let record;
  try { record = await readRecord(root, environmentId, environment); }
  catch (error) {
    if (error instanceof SingularityFlowError) return unavailable(environment.requires.map((entry) => entry.name));
    throw error;
  }
  const defaults = declarationBindings(environment);
  if (!record) {
    const missing = environment.requires.map((entry) => entry.name)
      .filter((name) => !Object.hasOwn(defaults, name)).sort();
    return Object.freeze({
      status: missing.length ? 'unbound' : 'bound',
      environment: publicEnvironment(
        environmentId, declaration.declarationSha256, environment, null, defaults
      ),
      missing: Object.freeze(missing)
    });
  }
  if (record.declarationSha256 !== declaration.declarationSha256) {
    return Object.freeze({
      status: 'unavailable',
      environment: publicEnvironment(environmentId, declaration.declarationSha256, environment, record),
      missing: Object.freeze(environment.requires.map((entry) => entry.name).sort())
    });
  }
  const effectiveBindings = Object.freeze({ ...defaults, ...record.bindings });
  const requiredNames = environment.requires.map((entry) => entry.name);
  const absent = requiredNames.filter((name) => !Object.hasOwn(effectiveBindings, name));
  const unresolved = requiredNames.filter((name) => record.bindings[name]?.source === 'reference');
  const missing = [...new Set([...absent, ...unresolved])].sort();
  const status = missing.length
    ? (absent.length ? 'partial' : 'unavailable')
    : 'bound';
  return Object.freeze({
    status,
    environment: publicEnvironment(
      environmentId, declaration.declarationSha256, environment, record, effectiveBindings
    ),
    missing: Object.freeze(missing)
  });
}

/** Merge a bounded stdin update into the current declaration-bound private record. */
export async function bindEnvironment(root, environmentId, input) {
  const declaration = await loadEnvironmentDeclaration(root, { optional: false });
  const environment = requiredEnvironment(declaration, environmentId);
  const updates = normalizeBindingInput(input, environment);
  // `env bind` is incremental: a user can supply only the missing names reported by `env status`
  // without deleting values that were already bound on this machine.  Reuse is allowed only after
  // the private record has passed the current declaration's closed validation and remains tied to
  // that exact declaration digest.  A declaration change deliberately starts a fresh binding so
  // old values are never silently reinterpreted under new authority.
  const current = await readRecord(root, environmentId, environment);
  const inherited = current?.declarationSha256 === declaration.declarationSha256
    ? current.bindings : {};
  const bindings = Object.freeze({ ...inherited, ...updates });
  const record = {
    schemaVersion: 1,
    kind: 'environment-binding',
    environment: environmentId,
    declarationSha256: declaration.declarationSha256,
    bindingRevision: `envb_${randomUUID()}`,
    bindings,
    boundAt: new Date().toISOString()
  };
  await writeMutablePrivateSidecar(root, bindingPath(root, environmentId), canonicalJson(record), {
    maximumBytes: MAXIMUM_BINDING_BYTES,
    enforceWindowsAcl: true
  });
  return resolveEnvironmentBinding(root, environmentId);
}

export async function unbindEnvironment(root, environmentId) {
  if (typeof environmentId !== 'string' || !ENVIRONMENT_IDENTIFIER.test(environmentId)) {
    fail('Environment ID must be lower-kebab-case and at most 64 characters.');
  }
  const directory = bindingDirectory(root);
  let existing = null;
  try {
    await safePrivateSidecarDirectory(root, directory, { enforceWindowsAcl: true });
    // Removal must remain a recovery path even when a private record is corrupt or belongs to an
    // obsolete declaration. Verify its private storage boundary, but do not require parsing secret
    // bytes merely to delete them.
    existing = await readPrivateSidecar(root, bindingPath(root, environmentId), {
      maximumBytes: MAXIMUM_BINDING_BYTES,
      optional: true,
      enforceWindowsAcl: true
    });
  } catch (error) {
    if (error?.code === 'ENOENT') existing = null;
    else throw error;
  }
  if (existing) await rm(bindingPath(root, environmentId), { force: true });
  return Object.freeze({ environment: environmentId, removed: Boolean(existing) });
}

/** Secret-free status for every declared environment. */
export async function environmentBindingStatus(root, environmentId = null) {
  const declaration = await loadEnvironmentDeclaration(root, { optional: true });
  if (!declaration) {
    return Object.freeze({
      schemaVersion: 1,
      storageAssurance: 'filesystem-private',
      declaration: Object.freeze({ status: 'missing', path: 'singularity/environments.yml', sha256: null }),
      environments: Object.freeze([])
    });
  }
  if (environmentId) requiredEnvironment(declaration, environmentId);
  const ids = environmentId ? [environmentId] : Object.keys(declaration.environments).sort();
  const environments = [];
  for (const id of ids) {
    const resolved = await resolveEnvironmentBinding(root, id);
    environments.push(Object.freeze({
      status: resolved.status,
      environment: resolved.environment,
      missing: resolved.missing
    }));
  }
  return Object.freeze({
    schemaVersion: 1,
    storageAssurance: 'filesystem-private',
    declaration: Object.freeze({
      status: 'ready', path: declaration.path, sha256: declaration.declarationSha256
    }),
    environments: Object.freeze(environments)
  });
}

/**
 * Privacy-preserving telemetry provisioning for processes Singularity Flow owns.
 *
 * This module is the only place that may turn provider telemetry on. Callers receive a new
 * environment object and a launch record; they never construct OTEL variables themselves. Native
 * IDE chat is deliberately represented in the capability table but is not treated as launch-owned.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { nowIso, SingularityFlowError, writeJson } from './util.mjs';

export const TELEMETRY_DISCLOSURE = 'Copilot usage for governed work will be recorded locally in the story receipt: model, tokens, timing and provider cost signals. Prompts and code are not captured. This does not affect approvals or your ability to work.';
export const TELEMETRY_DISCLOSURE_CONFIRMATION = 'ENABLE LOCAL USAGE';

// Copy edits to the sentence above do not change this digest. Change the policy object only when
// the collection boundary changes and every machine must disclose it again.
const DISCLOSURE_POLICY = Object.freeze({
  version: 1,
  destination: 'git-common-dir',
  fields: Object.freeze(['provider', 'runtime', 'model', 'tokens', 'timing', 'provider-cost', 'aggregate-tool-counts']),
  excludes: Object.freeze(['prompts', 'responses', 'instructions', 'source', 'file-content', 'tool-arguments', 'tool-results']),
  upload: false,
  governsWork: false
});

export const TELEMETRY_DISCLOSURE_DIGEST = createHash('sha256')
  .update(JSON.stringify(DISCLOSURE_POLICY))
  .digest('hex');

const PREFERENCE_SCHEMA = currentSchemaVersion('telemetry-preference');
const LAUNCH_SCHEMA = currentSchemaVersion('telemetry-launch');
const preparedLaunches = new WeakSet();

const CAPABILITIES = Object.freeze([
  ...['cli', 'vscode-terminal', 'intellij-terminal'].map((host) => Object.freeze({
    provider: 'github-copilot', runtime: 'copilot-cli', host,
    mode: 'launch-injection', contentCaptureControl: 'enforce-off', exporters: Object.freeze(['file']),
    probeVersion: 1, adapterVersion: 1
  })),
  Object.freeze({
    provider: 'github-copilot', runtime: 'copilot-native', host: 'vscode-native',
    mode: 'native-config', contentCaptureControl: 'supported-but-not-provisioned',
    exporters: Object.freeze(['file', 'otlp-http', 'otlp-grpc']), probeVersion: 1, adapterVersion: 1
  }),
  Object.freeze({
    provider: 'github-copilot', runtime: 'copilot-native', host: 'intellij-native',
    mode: 'external-only', contentCaptureControl: 'unknown', exporters: Object.freeze([]),
    probeVersion: 1, adapterVersion: 1
  })
]);

const TELEMETRY_ENVIRONMENT = Object.freeze([
  'COPILOT_OTEL_ENABLED', 'COPILOT_OTEL_EXPORTER_TYPE', 'COPILOT_OTEL_FILE_EXPORTER_PATH',
  'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL', 'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'COPILOT_OTEL_CAPTURE_CONTENT'
]);

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function preferenceFile(env = process.env, home = os.homedir()) {
  const configured = String(env.SINGULARITY_FLOW_TELEMETRY_PREFERENCES ?? '').trim();
  return configured ? path.resolve(configured) : path.join(home, '.singularity-flow', 'telemetry-preferences.json');
}

async function preferences({ env = process.env, home = os.homedir() } = {}) {
  const file = preferenceFile(env, home);
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text == null) return { file, record: { schemaVersion: PREFERENCE_SCHEMA, enabled: true, acceptedDisclosureDigests: [] } };
  try {
    const record = readRecord('telemetry-preference', text).record;
    if (typeof record.enabled !== 'boolean' || !Array.isArray(record.acceptedDisclosureDigests)) throw new Error('invalid shape');
    return { file, record };
  } catch {
    throw new SingularityFlowError('The machine-local telemetry preference is unreadable. Usage capture remains off until it is repaired.', {
      code: 'TELEMETRY_PREFERENCE_INVALID', details: { path: file }
    });
  }
}

export async function telemetryPreferenceStatus(options = {}) {
  const { record } = await preferences(options);
  return {
    schemaVersion: PREFERENCE_SCHEMA,
    enabled: record.enabled,
    disclosureDigest: TELEMETRY_DISCLOSURE_DIGEST,
    disclosureAccepted: record.acceptedDisclosureDigests.includes(TELEMETRY_DISCLOSURE_DIGEST)
  };
}

export async function setTelemetryCapture(enabled, { acceptDisclosure = false, ...options } = {}) {
  const { file, record } = await preferences(options);
  const accepted = new Set(record.acceptedDisclosureDigests);
  if (acceptDisclosure) accepted.add(TELEMETRY_DISCLOSURE_DIGEST);
  const next = {
    schemaVersion: PREFERENCE_SCHEMA,
    enabled: Boolean(enabled),
    acceptedDisclosureDigests: [...accepted].sort(),
    updatedAt: nowIso()
  };
  await writeJson(file, next);
  await chmod(file, 0o600).catch(() => {});
  return telemetryPreferenceStatus(options);
}

function capabilityFor(provider, runtime, host) {
  return CAPABILITIES.find((entry) => entry.provider === provider && entry.runtime === runtime && entry.host === host) ?? null;
}

function environmentConflicts(env) {
  const contentKeys = ['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'COPILOT_OTEL_CAPTURE_CONTENT'];
  const blocked = contentKeys.filter((key) => truthy(env[key]));
  const conflicts = TELEMETRY_ENVIRONMENT.filter((key) => {
    if (contentKeys.includes(key)) return false;
    return env[key] != null && String(env[key]).trim() !== '';
  });
  return { blocked, conflicts };
}

export async function probeTelemetry({
  root, provider = 'github-copilot', runtime = 'copilot-cli', host = 'cli',
  env = process.env, checkedAt = nowIso()
} = {}) {
  const capability = capabilityFor(provider, runtime, host);
  if (!capability) {
    return {
      schemaVersion: 1, provider, runtime, host, mode: 'none', available: false,
      reason: 'No documented local telemetry adapter is registered for this provider, runtime, and host.',
      conflicts: [], source: 'capability-registry', checkedAt, adapterVersion: 1
    };
  }
  const detected = environmentConflicts(env);
  const launchOwned = capability.mode === 'launch-injection';
  const available = launchOwned;
  const reason = launchOwned
    ? 'Singularity Flow owns this process launch and can enforce a metadata-only local file exporter.'
    : capability.mode === 'native-config'
      ? 'The host documents telemetry settings, but this build does not persistently provision native chat.'
      : 'The host may emit organization telemetry, but no documented local story-scoped stream is available.';
  return {
    schemaVersion: 1, provider, runtime, host, mode: capability.mode, available, reason,
    conflicts: [...detected.blocked, ...detected.conflicts].sort(), source: 'capability-registry',
    checkedAt, adapterVersion: capability.adapterVersion, probeVersion: capability.probeVersion,
    contentCaptureControl: capability.contentCaptureControl, exporters: [...capability.exporters],
    ...(root ? { repositoryBinding: sha256(path.resolve(root)) } : {})
  };
}

function storyIdentity(story) {
  if (story == null) return null;
  if (typeof story === 'string') return story;
  return story.id ?? story.workId ?? story.workItem?.id ?? null;
}

export function telemetryWorktreeId(root) {
  const common = gitCommonDir(root);
  return sha256(`${common}\0${path.resolve(root)}`);
}

export function telemetryRawPath(root, launch) {
  if (!launch || typeof launch.rawStream !== 'string' || !launch.rawStream.trim()
      || path.isAbsolute(launch.rawStream)) return null;
  const common = gitCommonDir(root);
  const rawRoot = path.join(common, 'singularity-flow', 'telemetry', 'raw');
  const candidate = path.resolve(common, launch.rawStream);
  return candidate.startsWith(`${rawRoot}${path.sep}`) ? candidate : null;
}

/**
 * Resolve a telemetry environment without mutating or trusting the caller's environment object.
 * A prepared result is branded by object identity so provider adapters cannot accept forged OTEL
 * variables through their ordinary request environment.
 */
export async function prepareTelemetryLaunch({
  root, story = null, phase = null, provider = 'github-copilot', runtime = 'copilot-cli',
  host = 'cli', surface = 'cli.copilot', baseEnv = process.env, startedAt = nowIso()
} = {}) {
  if (!root) throw new SingularityFlowError('Telemetry provisioning requires a repository root.', { code: 'TELEMETRY_ROOT_REQUIRED' });
  const common = gitCommonDir(root);
  const launchId = `tel_${randomUUID()}`;
  const providerDirectory = provider.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  const rawAbsolute = path.join(common, 'singularity-flow', 'telemetry', 'raw', providerDirectory, `${launchId}.jsonl`);
  const recordAbsolute = path.join(common, 'singularity-flow', 'telemetry', 'launches', `${launchId}.json`);
  const rawStream = path.relative(common, rawAbsolute).split(path.sep).join('/');
  const probe = await probeTelemetry({ root, provider, runtime, host, env: baseEnv, checkedAt: startedAt });
  let preference;
  try { preference = await telemetryPreferenceStatus({ env: baseEnv }); }
  catch (error) {
    preference = { enabled: false, disclosureAccepted: false, error: error.code ?? 'TELEMETRY_PREFERENCE_INVALID' };
  }
  const detected = environmentConflicts(baseEnv);
  let captureStatus = 'configured';
  if (!probe.available) captureStatus = 'unavailable';
  else if (!preference.enabled) captureStatus = 'disabled-by-user';
  else if (!preference.disclosureAccepted) captureStatus = 'disclosure-required';
  else if (detected.blocked.length) captureStatus = 'blocked-by-content-policy';
  else if (detected.conflicts.length) captureStatus = 'conflict';

  const environment = { ...baseEnv };
  const injectedEnvironment = {};
  if (captureStatus === 'configured') {
    Object.assign(injectedEnvironment, {
      COPILOT_OTEL_ENABLED: 'true',
      COPILOT_OTEL_EXPORTER_TYPE: 'file',
      COPILOT_OTEL_FILE_EXPORTER_PATH: rawAbsolute,
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
      COPILOT_OTEL_CAPTURE_CONTENT: 'false'
    });
    Object.assign(environment, injectedEnvironment);
  }
  // This is the only telemetry-shaped environment the provider allowlist may accept. It contains
  // SFlow's content-off exporter when configured, or the user's/organization's existing values
  // when composition is unsafe. Values are never copied into a launch record or diagnostic.
  const providerEnvironment = Object.fromEntries(TELEMETRY_ENVIRONMENT
    .filter((key) => environment[key] != null && String(environment[key]).trim() !== '')
    .map((key) => [key, String(environment[key])]));
  const configuration = captureStatus === 'configured'
    ? Object.fromEntries(TELEMETRY_ENVIRONMENT.filter((key) => environment[key] != null).map((key) => [key, key.includes('PATH') ? path.basename(environment[key]) : environment[key]]))
    : { captureStatus, conflicts: probe.conflicts };
  const launch = {
    schemaVersion: LAUNCH_SCHEMA, launchId, storyId: storyIdentity(story), phase,
    worktreeId: telemetryWorktreeId(root), provider, runtime, host, surface,
    startedAt, endedAt: null, captureStatus, provisioningMode: probe.mode,
    configurationDigest: sha256(configuration), rawStream,
    capabilityProbe: {
      mode: probe.mode, available: probe.available, reason: probe.reason, conflicts: probe.conflicts,
      source: probe.source, checkedAt: probe.checkedAt, adapterVersion: probe.adapterVersion
    }
  };
  const notices = [];
  if (captureStatus === 'disclosure-required') notices.push(TELEMETRY_DISCLOSURE);
  if (captureStatus === 'unavailable') notices.push('Usage unavailable for this session. Your work can continue.');
  if (captureStatus === 'disabled-by-user') notices.push('Local usage capture is disabled. Your work can continue.');
  if (captureStatus === 'conflict') notices.push(`Existing telemetry configuration was preserved (${probe.conflicts.join(', ')}). Local usage is unavailable for this session.`);
  if (captureStatus === 'blocked-by-content-policy') notices.push('Content capture is forced by existing policy, so Singularity Flow will not ingest this stream. Your work can continue.');
  const prepared = Object.freeze({
    env: Object.freeze(environment), injectedEnv: Object.freeze(injectedEnvironment),
    providerEnv: Object.freeze(providerEnvironment),
    launch: Object.freeze(launch), captureStatus,
    notices: Object.freeze(notices), rawAbsolute, recordAbsolute,
    repositoryRoot: path.resolve(root), commonDirectory: common
  });
  preparedLaunches.add(prepared);
  return prepared;
}

export function isPreparedTelemetryLaunch(value) {
  return Boolean(value && preparedLaunches.has(value));
}

export async function recordTelemetryLaunch(prepared, spawnResult = { state: 'started' }) {
  if (!isPreparedTelemetryLaunch(prepared)) {
    throw new SingularityFlowError('Telemetry launch record must come from trusted provisioning.', { code: 'TELEMETRY_LAUNCH_UNTRUSTED' });
  }
  await mkdir(path.dirname(prepared.recordAbsolute), { recursive: true, mode: 0o700 });
  if (prepared.captureStatus === 'configured') {
    await mkdir(path.dirname(prepared.rawAbsolute), { recursive: true, mode: 0o700 });
    const handle = await open(prepared.rawAbsolute, 'a', 0o600);
    await handle.close();
    await chmod(prepared.rawAbsolute, 0o600).catch(() => {});
  }
  const state = spawnResult.state ?? (spawnResult.endedAt ? 'finished' : 'started');
  const endedAt = state === 'started' ? null : (spawnResult.endedAt ?? nowIso());
  const record = {
    ...prepared.launch,
    endedAt,
    process: {
      state,
      exitCode: Number.isInteger(spawnResult.exitCode) ? spawnResult.exitCode : null,
      signal: typeof spawnResult.signal === 'string' ? spawnResult.signal : null,
      errorCode: typeof spawnResult.errorCode === 'string' ? spawnResult.errorCode : null
    }
  };
  await writeJson(prepared.recordAbsolute, record);
  await chmod(prepared.recordAbsolute, 0o600).catch(() => {});
  if (endedAt) await pruneTelemetryRaw(prepared.repositoryRoot).catch(() => {});
  return record;
}

export async function listTelemetryLaunches(root, { storyId = null, launchId = null } = {}) {
  const directory = path.join(gitCommonDir(root), 'singularity-flow', 'telemetry', 'launches');
  const names = await readdir(directory).catch(() => []);
  const launches = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    let record;
    try { record = readRecord('telemetry-launch', await readFile(file, 'utf8')).record; } catch { continue; }
    if (typeof record.launchId !== 'string'
        || telemetryRawPath(root, record) == null) continue;
    if (storyId && record.storyId !== storyId) continue;
    if (launchId && record.launchId !== launchId) continue;
    launches.push(record);
  }
  return launches.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

/** Delete only ended, launch-owned streams older than the local seven-day privacy window. */
export async function pruneTelemetryRaw(root, { now = Date.now(), retentionMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const removed = [];
  for (const launch of await listTelemetryLaunches(root)) {
    if (!launch.endedAt || !Number.isFinite(Date.parse(launch.endedAt))
        || now - Date.parse(launch.endedAt) < retentionMs) continue;
    const file = telemetryRawPath(root, launch);
    if (!file) continue;
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    await unlink(file).catch(() => {});
    if (await stat(file).catch(() => null) == null) removed.push(launch.launchId);
  }
  return { schemaVersion: 1, retentionMs, removed };
}

export async function explainTelemetryStatus({ root, story = null, launchId = null, env = process.env } = {}) {
  const preferenceRecord = await telemetryPreferenceStatus({ env }).catch(() => ({ enabled: false, disclosureAccepted: false }));
  const preference = {
    enabled: preferenceRecord.enabled,
    disclosureAccepted: preferenceRecord.disclosureAccepted,
    disclosureDigest: preferenceRecord.disclosureDigest ?? TELEMETRY_DISCLOSURE_DIGEST
  };
  const launches = await listTelemetryLaunches(root, { storyId: storyIdentity(story), launchId });
  const results = [];
  for (const launch of launches) {
    const raw = telemetryRawPath(root, launch);
    if (!raw) continue;
    const info = await stat(raw).catch(() => null);
    let validEvents = 0;
    if (info?.isFile() && info.size) {
      const { parseCopilotTelemetry } = await import('./telemetry.mjs');
      validEvents = parseCopilotTelemetry(await readFile(raw, 'utf8')).spans.length;
    }
    results.push({
      launchId: launch.launchId, storyId: launch.storyId, phase: launch.phase,
      provider: launch.provider, runtime: launch.runtime, host: launch.host, surface: launch.surface,
      provisioningMode: launch.provisioningMode,
      captureStatus: validEvents > 0 ? 'captured' : launch.captureStatus === 'configured' ? 'partial' : launch.captureStatus,
      startedAt: launch.startedAt, endedAt: launch.endedAt, observedEvents: validEvents
    });
  }
  const counts = Object.fromEntries(['captured', 'partial', 'unavailable', 'conflict', 'disabled-by-user', 'disclosure-required', 'blocked-by-content-policy']
    .map((status) => [status, results.filter((item) => item.captureStatus === status).length]));
  const overall = results.some((item) => item.captureStatus === 'captured')
    ? (results.every((item) => item.captureStatus === 'captured') ? 'captured' : 'partial')
    : results.at(-1)?.captureStatus ?? (preference.enabled ? 'unavailable' : 'disabled');
  return { schemaVersion: 1, status: overall, preference, counts, launches: results };
}

/**
 * Starting, observing and stopping a capability's declared application [RUN M1].
 *
 * A start entry runs shell-free from its repository-relative working directory, in its own process
 * group, with the chosen environment's values given to that process only. Readiness is a loopback
 * HTTP answer below 500 or a literal log line; a timeout stops the whole tree. A private run record
 * (pid, url, start time, command identity) under the Git common directory lets `app status` and
 * `app stop` find exactly the processes `app start` started, and nothing else.
 *
 * A typed entry (run-configurations.mjs) resolves per environment to argv, the variables it sets for
 * the application only, its before-launch steps and the private files it needs; the steps and the
 * application start through the one launch site below (launchProcess), with the same environment and
 * the same output redaction.
 */
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { repositoryWorktreeDirectory } from './git-worktree-directory.mjs';

import {
  appDebugPaths, assertDebugToolsAvailable, debugPortAccepts, jdwpListeningLine, resolveDebugLaunch
} from './application-debug.mjs';
import { loopbackApplicationUrl } from './capabilities.mjs';
import { gitCommonDir } from './git.mjs';
import { processStartIdentity } from './lease-liveness.mjs';
import { resolvePlatformProcess } from './platform-process.mjs';
import { readPrivateSidecar, writeMutablePrivateSidecar } from './private-sidecar.mjs';
import { terminateProcessTree, withoutHostSurfaceVariables } from './quality-command-runner.mjs';
import {
  resolveStartCommand, resolveStartDebugLaunch, runConfigurationPaths, shownResolution, startArgvFor, startEntryCommandSha256
} from './run-configurations.mjs';
import { environmentBindingRefusal, localIntegrationPolicyRefusal, selectRunEnvironment } from './run-environment.mjs';
import { gateTestEnvironmentModule } from './test-runtime.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';

export const APP_RUN_FORMAT = 'sflow-app-run/v1';
const MAXIMUM_RECORD_BYTES = 16 * 1024;
const POLL_MS = 500;
const STOP_GRACE_MS = 5_000;

/** What a start entry runs in one environment: its resolved argv, then that environment's arguments. */
export const startArgv = startArgvFor;

/** Confirmation covers the complete declared service graph, not just the final process. */
export function applicationCommandSha256(context, entry, chain = [], memo = new Map()) {
  if (memo.has(entry.id)) return memo.get(entry.id);
  const own = startEntryCommandSha256(entry);
  if (!entry.dependsOn?.length) { memo.set(entry.id, own); return own; }
  if (chain.includes(entry.id)) throw new SingularityFlowError('Application dependency cycle.', { code: 'APP_DEPENDENCY_CYCLE' });
  const dependencies = entry.dependsOn.map(id => {
    const required = context.application.start.find(item => item.id === id);
    if (!required) throw new SingularityFlowError(`Unknown dependency '${id}'.`, { code: 'APP_DEPENDENCY_UNKNOWN' });
    return [id, applicationCommandSha256(context, required, [...chain, entry.id], memo)];
  });
  const digest = `sha256:${createHash('sha256').update(JSON.stringify([own, dependencies])).digest('hex')}`;
  memo.set(entry.id, digest);
  return digest;
}

/** Refuse `--debug` for an entry without a debug block, before anything runs or is read. */
export function assertDebugDeclared(entry) {
  if (!entry.debug) resolveDebugLaunch(entry);
}

export function appRecordPath(root, capabilityId, startId) {
  const common = gitCommonDir(root);
  const own = repositoryWorktreeDirectory(root);
  if (!own) throw new SingularityFlowError('The application checkout is unavailable.', { code: 'APP_CHECKOUT_UNAVAILABLE' });
  const scope = path.resolve(own) === realpathSync.native(common) ? []
    : ['worktrees', createHash('sha256').update(path.resolve(own)).digest('hex').slice(0, 32)];
  return path.join(common, 'singularity-flow', 'app', ...scope, capabilityId, `${startId}.json`);
}

/** The private files a run of an entry writes beside its run record (a Gradle init script for VM options). */
export function appRunPaths(root, capabilityId, startId) {
  return runConfigurationPaths(path.dirname(appRecordPath(root, capabilityId, startId)), startId);
}

/** The process-start identity of a pid, so a recycled pid is never mistaken for a recorded process. */
export { processStartIdentity };

function pidAlive(pid, { group = false } = {}) {
  try { process.kill(group && process.platform !== 'win32' ? -pid : pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function validRecord(record, capabilityId, startId) {
  return record && record.format === APP_RUN_FORMAT && record.capability === capabilityId && record.id === startId
    && Number.isInteger(record.pid) && record.pid > 0 && typeof record.url === 'string'
    && typeof record.startedAt === 'string' && /^sha256:[a-f0-9]{64}$/u.test(String(record.commandSha256 ?? ''));
}

export async function readAppRecord(root, capabilityId, startId, { strict = false } = {}) {
  let bytes;
  try {
    bytes = await readPrivateSidecar(root, appRecordPath(root, capabilityId, startId), { maximumBytes: MAXIMUM_RECORD_BYTES, optional: true });
  } catch (error) { if (strict) throw error; return null; }
  if (!bytes) return null;
  try {
    const record = JSON.parse(bytes.toString('utf8'));
    if (!validRecord(record, capabilityId, startId)) throw new Error('Invalid app record');
    return record;
  } catch {
    if (strict) throw new SingularityFlowError('The saved application record is unreadable. Its bytes were preserved; inspect the original task before starting again.', { code: 'APP_RUN_RECORD_INVALID' });
    return null;
  }
}

async function writeAppRecord(root, record) {
  await writeMutablePrivateSidecar(root, appRecordPath(root, record.capability, record.id),
    `${JSON.stringify(record, null, 2)}\n`, { maximumBytes: MAXIMUM_RECORD_BYTES });
}

async function removeAppRecord(root, capabilityId, startId, expectedPid = null) {
  const current = await readAppRecord(root, capabilityId, startId);
  if (expectedPid != null && current && current.pid !== expectedPid) return;
  if (expectedPid != null && (pidAlive(expectedPid) || pidAlive(expectedPid, { group: true }))) return;
  const { rm } = await import('node:fs/promises');
  await rm(appRecordPath(root, capabilityId, startId), { force: true }).catch(() => {});
}

/** Whether a recorded process is still the one `app start` started. */
const processIdentities = new Map();
export function recordedProcessAlive(record, { fresh = false, requireIdentity = false } = {}) {
  if (!record) return false;
  if (!pidAlive(record.pid)) return !requireIdentity && pidAlive(record.pid, { group: true });
  if (!record.processStartedAt) return !requireIdentity;
  const cached = processIdentities.get(record.pid);
  const identity = !fresh && cached && Date.now() - cached.at < 5_000 ? cached.identity : processStartIdentity(record.pid);
  if (processIdentities.size > 1024) processIdentities.clear();
  processIdentities.set(record.pid, { identity, at: Date.now() });
  return identity == null ? !requireIdentity : identity === record.processStartedAt;
}

/** The loopback URL a readiness probe asks: the http ready path on the entry's origin, else the URL. */
export function readinessUrl(entry) {
  const base = loopbackApplicationUrl(entry.url, `Start entry '${entry.id}' url`);
  if (entry.ready?.http == null) return base;
  const target = new URL(entry.ready.http, base.origin);
  if (target.origin !== base.origin) {
    throw new SingularityFlowError(`Start entry '${entry.id}' ready.http leaves its loopback origin.`, { code: 'CAPABILITY_APPLICATION_INVALID' });
  }
  return target;
}

/** One loopback GET; any HTTP answer below 500 is ready. Never follows redirects or sends credentials. */
export function probeLoopback(url, { timeoutMs = 2_000 } = {}) {
  const target = loopbackApplicationUrl(url.href ?? String(url), 'Readiness URL');
  return new Promise((resolve) => {
    const client = target.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const request = client.request({
      method: 'GET', hostname: target.hostname.replace(/^\[|\]$/gu, ''), port: target.port || undefined,
      path: `${target.pathname}${target.search}`, timeout: timeoutMs, agent: false,
      headers: { connection: 'close' },
      // A local development server's own certificate; nothing private is sent to it.
      ...(target.protocol === 'https:' ? { rejectUnauthorized: false } : {})
    }, (response) => {
      response.resume();
      done({ responded: true, status: response.statusCode ?? 0, ready: (response.statusCode ?? 600) < 500 });
    });
    request.on('timeout', () => { request.destroy(); done({ responded: false, status: null, ready: false }); });
    request.on('error', () => done({ responded: false, status: null, ready: false }));
    request.end();
  });
}

/** The environments of a start entry with their binding status, the first marked default. */
export async function startEntryEnvironments(root, entry, declaration) {
  const { resolveEnvironmentBinding } = await import('./environment-bindings.mjs');
  const environments = [];
  for (const [index, name] of entry.environments.entries()) {
    const declared = Object.hasOwn(declaration?.environments ?? {}, name);
    const status = declared ? (await resolveEnvironmentBinding(root, name).catch(() => ({ status: 'unavailable' }))).status : 'undeclared';
    environments.push({ name, status, default: index === 0 });
  }
  return environments;
}

/**
 * The debug start of an entry in one environment as app plan shows it: the argv and the names of
 * the variables it adds, or the coded refusal app start --debug would give. Nothing is spawned.
 */
export function describeDebugStart(root, context, entry, environment = null) {
  try {
    const launch = resolveStartDebugLaunch(entry, environment, {
      paths: appRunPaths(root, context.capabilityId, entry.id), debugPaths: appDebugPaths(appRecordPath(root, context.capabilityId, entry.id))
    });
    return { launcher: launch.launcher, argv: [...launch.argv], environmentNames: [...launch.environmentNames], notes: [...launch.notes] };
  } catch (error) {
    if (!String(error?.code ?? '').startsWith('APP_DEBUG_')) throw error;
    return { refusal: { code: error.code, message: error.message } };
  }
}

export async function planStartEntry(root, context, entry, declaration, { includeDependencies = true } = {}) {
  const environments = await startEntryEnvironments(root, entry, declaration);
  const paths = appRunPaths(root, context.capabilityId, entry.id);
  const base = resolveStartCommand(entry, null, { paths });
  // A plain command entry (no typed-configuration field) is shown exactly as before.
  const configured = entry.configured === true;
  const plan = {
    capability: context.capabilityId,
    repository: entry.repository,
    id: entry.id,
    ...(entry.dependsOn?.length ? { dependsOn: [...entry.dependsOn] } : {}),
    ...(configured ? { name: entry.name ?? entry.id, type: entry.type ?? 'command' } : {}),
    argv: entry.type && entry.type !== 'command' ? [...base.argv] : [...entry.argv],
    workingDirectory: entry.workingDirectory,
    url: entry.url,
    ready: { ...entry.ready },
    environments,
    commandSha256: applicationCommandSha256(context, entry),
    // The base form, without an environment; each environment's own is environments[].resolved.
    ...(configured ? { resolved: shownResolution(base) } : {})
  };
  // The declared configuration, shown only when declared.
  if (entry.fields) plan.fields = structuredClone(entry.fields);
  if (entry.env) plan.env = { ...entry.env };
  if (entry.beforeLaunch) plan.beforeLaunch = shownResolution(base).beforeLaunch;
  if (entry.perEnvironment) plan.perEnvironment = structuredClone(entry.perEnvironment);
  if (entry.arguments) plan.arguments = Object.fromEntries(Object.entries(entry.arguments).map(([name, list]) => [name, [...list]]));
  for (const environment of environments) {
    const command = resolveStartCommand(entry, environment.name, { paths });
    if (entry.arguments || entry.extended) environment.argv = [...command.argv];
    if (configured) environment.resolved = shownResolution(command);
  }
  if (entry.debug) {
    for (const environment of environments) {
      const { launcher: _launcher, notes: _notes, ...shown } = describeDebugStart(root, context, entry, environment.name);
      environment.debug = shown;
    }
    const { runtime, port, suspend } = entry.debug;
    plan.debug = { runtime, port, suspend, address: port == null ? null : `127.0.0.1:${port}`,
      ...describeDebugStart(root, context, entry, entry.environments[0] ?? null) };
  }
  if (includeDependencies && entry.dependsOn?.length) {
    const { dependencyOrder } = await import('./application-dependencies.mjs');
    plan.dependencies = await Promise.all(dependencyOrder(context, entry).map(required => planStartEntry(root, context, required, declaration, { includeDependencies: false })));
  }
  return plan;
}

export function selectStartEntry(context, startId = null) {
  const entries = context.application.start;
  if (!entries.length) {
    throw new SingularityFlowError(
      // It read as a governed proposal, so an agent asked to start the app stopped instead of offering the
      // two-minute setup: suggest, confirm, save on this checkout only (Story anu-bin, 2026-11-11).
      `Capability '${context.capabilityId}' has no saved start entry yet. /sf-run-app detects one from the repository, asks you which to keep, saves it on this checkout only (nothing shared changes) and starts it; sharing it with the team is a capability proposal.`,
      { code: 'APP_START_NOT_DECLARED', details: { capabilityId: context.capabilityId,
        nextAction: { command: `singularity-flow app suggest --capability ${context.capabilityId} --json`,
          label: 'Run /sf-run-app: it detects the start command, asks you to confirm it, saves it on this checkout only and starts the app.' } } });
  }
  if (startId == null) {
    if (entries.length === 1) return entries[0];
    throw new SingularityFlowError(
      `Capability '${context.capabilityId}' declares ${entries.length} start entries; name one: ${entries.map((entry) => entry.id).join(', ')}.`,
      { code: 'APP_START_SELECTION_REQUIRED', details: { capabilityId: context.capabilityId, available: entries.map((entry) => entry.id) } });
  }
  const entry = entries.find((candidate) => candidate.id === startId);
  if (!entry) {
    throw new SingularityFlowError(`Capability '${context.capabilityId}' has no start entry '${startId}'. Declared: ${entries.map((candidate) => candidate.id).join(', ')}.`,
      { code: 'APP_START_UNKNOWN', details: { capabilityId: context.capabilityId, startId, available: entries.map((candidate) => candidate.id) } });
  }
  return entry;
}

function assertRepositoryHere(context, entry) {
  const here = context.repositoryId;
  const ambiguous = here == null && context.repositories.length > 1;
  if (ambiguous || (here != null && entry.repository !== here && context.repositories.length > 1)) {
    throw new SingularityFlowError(
      `Start entry '${entry.id}' runs in repository '${entry.repository}'. Run app start from a checkout of '${entry.repository}'.`,
      { code: 'APP_REPOSITORY_NOT_HERE', details: { capabilityId: context.capabilityId, startId: entry.id, repository: entry.repository, here } });
  }
}

/** Status of each start entry: declared, started (recorded pid alive), ready (URL answers below 500). */
export async function applicationStatus(root, context) {
  const entries = [];
  for (const entry of context.application.start) {
    const record = await readAppRecord(root, context.capabilityId, entry.id, { strict: true });
    const started = recordedProcessAlive(record);
    const probe = started ? await probeLoopback(readinessUrl(entry), { timeoutMs: 1_500 }) : { ready: false, responded: false, status: null };
    entries.push({
      id: entry.id, name: entry.name ?? entry.id, declared: true, started, ready: entry.ready.log ? Boolean(started && record.readyAt) : probe.ready, url: entry.url,
      pid: started ? record.pid : null, startedAt: started ? record.startedAt : null,
      environment: started ? record.environment ?? null : null,
      commandSha256: applicationCommandSha256(context, entry),
      recordedCommandSha256: started ? record.commandSha256 : null,
      ...(record && !started ? { staleRecord: true } : {}),
      ...(entry.debug || (started && record.debug) ? { debug: await debugStatus(entry, started ? record : null) } : {})
    });
  }
  return { resultType: 'sflow-app-status', capability: context.capabilityId, entries };
}

/**
 * `debug: { runtime, port, listening }` of one entry. Listening is true only for a run app start
 * --debug recorded. A JDWP port is not probed (each probe logs a failed handshake in the JVM's output):
 * the JVM's own listening line, recorded at start, and a live process answer for it. dotnet has no
 * listener, so its port and listening are null and the person attaches to the pid.
 */
async function debugStatus(entry, record) {
  const runtime = record?.debug?.runtime ?? entry.debug?.runtime ?? null;
  const port = record?.debug ? record.debug.port ?? null : entry.debug?.port ?? null;
  if (runtime === 'dotnet' || port == null) return { runtime, port: null, listening: null };
  if (!record?.debug) return { runtime, port, listening: false };
  const listening = runtime === 'java' ? Boolean(record.debug.listeningAt) : await debugPortAccepts(port);
  return { runtime, port, listening };
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid, { group: true }) && !pidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !pidAlive(pid, { group: true }) && !pidAlive(pid);
}

async function stopTree(pid) {
  terminateProcessTree(pid, 'SIGTERM');
  if (await waitForExit(pid, STOP_GRACE_MS)) return true;
  terminateProcessTree(pid, 'SIGKILL');
  return waitForExit(pid, 2_000);
}

/** Stop only a process tree `app start` recorded for this entry, then forget it. */
export async function stopApplication(root, context, entry) {
  const record = await readAppRecord(root, context.capabilityId, entry.id, { strict: true });
  if (!record) return { capability: context.capabilityId, id: entry.id, stopped: false, reason: 'not-recorded' };
  const live = pidAlive(record.pid), identity = live ? processStartIdentity(record.pid) : null;
  if ((live && (!record.processStartedAt || !identity)) || (!live && pidAlive(record.pid, { group: true }))) throw new SingularityFlowError('The saved process identity cannot be verified. Stop it from its original task terminal; the saved record was preserved.', { code: 'APP_PROCESS_IDENTITY_UNAVAILABLE' });
  if (!live || identity !== record.processStartedAt) {
    await removeAppRecord(root, context.capabilityId, entry.id, record.pid);
    return { capability: context.capabilityId, id: entry.id, stopped: false, reason: 'not-running' };
  }
  const stopped = await stopTree(record.pid);
  if (stopped) await removeAppRecord(root, context.capabilityId, entry.id, record.pid);
  return { capability: context.capabilityId, id: entry.id, stopped, pid: record.pid, reason: stopped ? 'stopped' : 'still-running' };
}

/**
 * The one reviewed launch site: a before-launch step or the application, shell-free through the
 * platform's process resolution, in its own process group (so its whole tree stops together), with
 * output piped for relaying and redaction. Resolves once the process exists.
 */
async function launchProcess(argv, { cwd, env, platform, subject, startId }) {
  const launch = resolvePlatformProcess(argv[0], argv.slice(1), { platform, environment: env, cwd });
  let child;
  try {
    child = spawn(launch.executable, launch.arguments, {
      cwd, env, ...launch.spawnOptions, detached: platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    throw new SingularityFlowError(`${subject} could not start: ${error.message}`, { code: 'APP_START_FAILED' });
  }
  const spawnError = await new Promise((resolve) => {
    child.once('spawn', () => resolve(null));
    child.once('error', (error) => resolve(error));
  });
  if (spawnError || !child.pid) {
    throw new SingularityFlowError(`${subject} could not start: ${spawnError?.message ?? 'no process'}.`, {
      code: 'APP_START_FAILED', details: { startId, executable: argv[0] } });
  }
  return child;
}

/** Relay a child's output, redacting every bound secret before it is shown; `onText` sees what was shown. */
function relayOutput(stream, target, materialized, onText = null) {
  const redactor = materialized?.redactsAnything ? materialized.streamRedactor() : null;
  const emit = (text) => {
    if (!text) return;
    target.write(text);
    onText?.(text);
  };
  stream.on('data', (chunk) => emit(redactor ? redactor.write(chunk) : chunk.toString('utf8')));
  stream.on('end', () => { if (redactor) emit(redactor.end()); });
}

/**
 * Run the entry's before-launch steps in order, like IntelliJ's "Before launch", with the
 * application's own environment and redaction. A step that fails or times out stops the start
 * (nothing else runs); a stop request ends the running step's tree. Resolves true when stopped.
 */
async function runBeforeLaunch(root, entry, steps, { env, platform, output, errorOutput, materialized, signals, signal }) {
  for (const [index, step] of steps.entries()) {
    if (signal?.aborted) return true;
    const subject = `Start entry '${entry.id}' before-launch step ${index + 1}`;
    const cwd = (await secureRepositoryPath(root, step.workingDirectory, { label: `${subject} working directory`, mustExist: true, type: 'directory' })).absolute;
    output.write(`Before launch (${index + 1}/${steps.length}): ${step.argv.join(' ')}${step.workingDirectory === entry.workingDirectory ? '' : ` (in ${step.workingDirectory})`}\n`);
    const child = await launchProcess(step.argv, { cwd, env, platform, subject, startId: entry.id });
    relayOutput(child.stdout, output, materialized);
    relayOutput(child.stderr, errorOutput, materialized);
    let stopRequested = null;
    const onSignal = (name) => { stopRequested ??= name; void stopTree(child.pid); };
    const onAbort = () => onSignal('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    for (const name of signals) process.on(name, onSignal);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void stopTree(child.pid); }, step.timeoutMs);
    try {
      const exit = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
      if (stopRequested) return true;
      if (timedOut) {
        throw new SingularityFlowError(`${subject} (${step.argv.join(' ')}) did not finish within ${step.timeoutMs} ms; its process tree was stopped and the application did not start.`,
          { code: 'APP_BEFORE_LAUNCH_TIMEOUT', details: { startId: entry.id, step: index + 1, timeoutMs: step.timeoutMs } });
      }
      if (exit.code !== 0) {
        throw new SingularityFlowError(`${subject} (${step.argv.join(' ')}) exited ${exit.code ?? exit.signal}; the application did not start.`,
          { code: 'APP_BEFORE_LAUNCH_FAILED', details: { startId: entry.id, step: index + 1, exitCode: exit.code, signal: exit.signal } });
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      for (const name of signals) process.off(name, onSignal);
      if (pidAlive(child.pid, { group: true })) await stopTree(child.pid);
    }
  }
  return false;
}

/** Each private file once; a debug start's version of a file replaces the run's own. */
function filesToWrite(runFiles, debugFiles = []) {
  const byPath = new Map(runFiles.map((file) => [file.path, file]));
  for (const file of debugFiles) byPath.set(file.path, file);
  return [...byPath.values()];
}

async function removeFiles(files) {
  if (!files.length) return;
  const { rm } = await import('node:fs/promises');
  for (const file of files) await rm(file, { force: true, recursive: true }).catch(() => {});
}

/**
 * Who listens on an application's port. Run records are kept per checkout, so another Story checkout's SFlow run was
 * not recognised, and the refusal named no process: the agent could neither stop the right one nor tell the person
 * what held the port (session mining N2, 2026-11-11). First an SFlow run of any checkout of this repository, then the
 * process the system names, by its short name only (a full command line can carry a secret). Best effort: null.
 */
async function portHolder(root, port, { platform = process.platform, spawnSyncCommand = spawnSync, host = null } = {}) {
  let base;
  try { base = path.join(gitCommonDir(root), 'singularity-flow', 'app'); } catch { base = null; }
  const files = [];
  const walk = async (directory, depth) => {
    if (depth > 4 || files.length >= 200) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(file);
    }
  };
  if (base) await walk(base, 0);
  for (const file of files) {
    let record;
    try {
      const text = await readFile(file, 'utf8');
      if (Buffer.byteLength(text) > MAXIMUM_RECORD_BYTES) continue;
      record = JSON.parse(text);
    } catch { continue; }
    if (record?.format !== APP_RUN_FORMAT || !Number.isInteger(record.pid) || record.pid <= 0 || typeof record.url !== 'string') continue;
    let url;
    try { url = loopbackApplicationUrl(record.url); } catch { continue; }
    if (Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== port || !recordedProcessAlive(record)) continue;
    return { pid: record.pid, command: null, sflowRun: { capability: record.capability, startId: record.id,
      checkout: typeof record.checkout === 'string' ? record.checkout : null } };
  }
  try {
    if (platform === 'win32') return windowsPortListener(port, { exec: spawnSyncCommand, host });
    const listed = spawnSyncCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8', timeout: 2_000 });
    const pid = Number(String(listed?.stdout ?? '').match(/^p(\d+)$/mu)?.[1]);
    return Number.isInteger(pid) && pid > 0 ? { pid, command: String(listed.stdout).match(/^c(.+)$/mu)?.[1] ?? null } : null;
  } catch { return null; }
}

/**
 * Who listens on a loopback port on Windows, by pid and image name, or null. `netstat -ano` lists IPv4 (`-p tcp`)
 * and IPv6 (`-p tcpv6`) separately, and a dual-stack listener on `[::]` shows in the IPv6 one only: both are read,
 * the application host's family first. A listening row is `LISTENING`, or, where Windows names states in another
 * language, one with no remote port (`0.0.0.0:0`, `[::]:0`); its pid is the last column. The name comes from
 * `tasklist /FI "PID eq <pid>" /FO CSV /NH` (`"node.exe","4242",...`). A missing command, a refusal (access
 * denied) or no match leaves the pid without a name, or no holder.
 */
export function windowsPortListener(port, { exec = spawnSync, host = null } = {}) {
  const printed = (command, args) => {
    try {
      const result = exec(command, args, { encoding: 'utf8', timeout: 2_000, windowsHide: true });
      return result?.error || result?.status ? '' : String(result?.stdout ?? '');
    } catch { return ''; }
  };
  const tables = [['tcp', ['0.0.0.0', '127.0.0.1']], ['tcpv6', ['[::]', '[::1]']]];
  if (String(host ?? '').includes(':')) tables.reverse();
  let pid = null;
  for (const [protocol, addresses] of tables) {
    for (const line of printed('netstat', ['-ano', '-p', protocol]).split(/\r?\n/u)) {
      const columns = line.trim().split(/\s+/u);
      const [proto, local = '', foreign = ''] = columns;
      const at = local.lastIndexOf(':');
      if (!/^TCP(?:v6)?$/iu.test(proto ?? '') || columns.length < 4 || at < 1 || local.slice(at + 1) !== String(port)
          || !addresses.includes(local.slice(0, at)) || !(columns.includes('LISTENING') || /:0$/u.test(foreign))) continue;
      const listed = Number(columns.at(-1));
      if (Number.isSafeInteger(listed) && listed > 0) { pid = listed; break; }
    }
    if (pid) break;
  }
  if (!pid) return null;
  const row = printed('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).split(/\r?\n/u)
    .map((line) => [...line.matchAll(/"([^"]*)"/gu)].map((match) => match[1])).find((fields) => fields[1] === String(pid));
  return { pid, command: row?.[0] || null };
}

/** The port refusal: who holds it, and the one route that frees it or gives this checkout its own port. */
function portInUse(root, context, entry, subject, applicationUrl, holder, platform = process.platform) {
  const ownPort = { command: `singularity-flow app suggest --capability ${context.capabilityId} --json`, copilotCommand: '/sf-run-app suggest',
    label: 'Give this checkout its own port: /sf-run-app suggest drafts the entry; change its port and save it on this checkout only (app config save-local).' };
  const run = holder?.sflowRun;
  // Windows paths compare without case, and its shell takes the quoted PowerShell form of a checkout path.
  const same = (a, b) => (platform === 'win32' ? path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  const elsewhere = run?.checkout && !same(run.checkout, root);
  const stop = run ? safeCommandGuidance({ argv: ['app', 'stop', run.startId, '--capability', run.capability, ...(elsewhere ? ['--context-root', run.checkout] : [])] }) : null;
  const stopLine = platform === 'win32' ? stop?.platformCommands?.win32 ?? stop?.command : stop?.command;
  // The person's own line for a process SFlow has no stop for; the agent never runs it.
  const personStop = holder && !stop ? (platform === 'win32' ? `taskkill /PID ${holder.pid}` : `kill ${holder.pid}`) : null;
  const who = run ? `SFlow's run of '${run.startId}'${elsewhere ? ` from the checkout ${run.checkout}` : ''} (pid ${holder.pid})`
    : holder ? `process ${holder.pid}${holder.command ? ` (${holder.command})` : ''}, which no SFlow run started,` : 'another process';
  const then = stop ? `Stop it with ${stopLine}, or give this checkout its own port (/sf-run-app suggest, saved on this checkout only).`
    : holder ? `${run ? 'A' : "It is not SFlow's to stop: a"} person who asked for it stops it in their own terminal (${personStop}). Or give this checkout its own port (/sf-run-app suggest, saved on this checkout only).`
      : 'Stop it, or give this checkout its own port (/sf-run-app suggest, saved on this checkout only).';
  return new SingularityFlowError(`${subject} cannot bind ${applicationUrl.origin}: ${who} already listens there. ${then} Nothing was started.`, {
    code: 'APP_PORT_IN_USE', details: { startId: entry.id, url: applicationUrl.origin, port: Number(applicationUrl.port || 0) || null,
      holder: holder ? { pid: holder.pid, command: holder.command ?? null, ...(run ? { sflowRun: run } : {}), ...(personStop ? { personStop } : {}) } : null,
      nextAction: stop ? { ...stop, label: `Stop SFlow's run of '${run.startId}' that holds the port.` } : ownPort } });
}

/**
 * Run one start entry in the foreground: run its before-launch steps, spawn, record, wait for
 * readiness, then stay attached until the application exits or this process is asked to stop.
 * Resolves with how it ended.
 */
async function runSingleApplication(root, context, entry, {
  requestedEnvironment = null, declaration = null, output = process.stdout, errorOutput = process.stderr,
  onReady = null, signals = ['SIGINT', 'SIGTERM', 'SIGHUP'], platform = process.platform, expectedCommandSha256 = null,
  debug = false, spawnSyncCommand = undefined, managedDependency = false, signal = null
} = {}) {
  if (expectedCommandSha256 && expectedCommandSha256 !== applicationCommandSha256(context, entry)) {
    throw new SingularityFlowError(
      `Start entry '${entry.id}' changed since it was confirmed; nothing ran. Read singularity-flow app plan ${entry.id} --json and confirm again.`,
      { code: 'APP_COMMAND_CHANGED', details: { startId: entry.id, expected: expectedCommandSha256, commandSha256: applicationCommandSha256(context, entry) } });
  }
  if (signal?.aborted) return { capability: context.capabilityId, id: entry.id, outcome: 'stopped', ready: false, exitCode: 0 };
  assertRepositoryHere(context, entry);
  const existing = await readAppRecord(root, context.capabilityId, entry.id, { strict: true });
  if (existing && recordedProcessAlive(existing)) {
    throw new SingularityFlowError(`Start entry '${entry.id}' is already running (pid ${existing.pid}) at ${existing.url}. Stop it with singularity-flow app stop ${entry.id}.`,
      { code: 'APP_ALREADY_RUNNING', details: { capabilityId: context.capabilityId, startId: entry.id, pid: existing.pid, url: existing.url } });
  }
  const subject = `Start entry '${entry.id}'`;
  // Refused before an environment's values are read: a debug start needs its runtime declared.
  if (debug) assertDebugDeclared(entry);
  const environment = selectRunEnvironment({ listed: entry.environments, requested: requestedEnvironment, declaration, subject });
  const runPaths = appRunPaths(root, context.capabilityId, entry.id);
  const command = resolveStartCommand(entry, environment, { paths: runPaths });
  let materialized = null;
  if (environment) {
    if (context.policy?.localIntegrationEvidence !== 'allowed') {
      throw localIntegrationPolicyRefusal({ capabilityId: context.capabilityId, environment, subject });
    }
    const { materializeEnvironmentBinding } = await import('./environment-bindings.mjs');
    // The environment's files are placed here first (in the capability's sourceRoots, else the entry's
    // working directory), or the start is refused naming the missing file [ENVF].
    materialized = await materializeEnvironmentBinding(root, environment, { files: {
      sourceRoots: context.capability?.sourceRoots ?? [], workingDirectory: entry.workingDirectory, platform } });
    if (materialized.status !== 'bound') {
      throw environmentBindingRefusal({ environment, status: materialized.status, missing: materialized.missing, subject });
    }
    const placedFiles = materialized.environmentFiles;
    if (placedFiles?.paths.length) output.write(`Environment files for ${environment}: ${placedFiles.paths.join(', ')}\n`);
    for (const note of placedFiles?.notes ?? []) output.write(`${note}\n`);
  }
  const cwd = (await secureRepositoryPath(root, entry.workingDirectory, {
    label: `${subject} working directory`, mustExist: true, type: 'directory'
  })).absolute;
  // The host's own variables (VS Code runs the CLI with ELECTRON_RUN_AS_NODE) never reach the application.
  // A before-launch build and the application get the Node the repository asks for [TCE:REQ-035].
  const base = (await (await gateTestEnvironmentModule()).withProjectNodeVersion(withoutHostSurfaceVariables(process.env), { cwd, root })).environment;
  delete base.NODE_TEST_CONTEXT;
  // The entry's literal variables, and those its type appends to an inherited value (MAVEN_OPTS for
  // exec:java). A value bound for the environment wins over a literal of the same name.
  const configured = { ...base, ...command.env };
  for (const [name, value] of Object.entries(command.appendEnv)) {
    const inherited = String(configured[name] ?? '').trim();
    configured[name] = inherited ? `${inherited} ${value}` : value;
  }
  const env = materialized ? materialized.childEnvironment(configured) : configured;
  const commandSha256 = applicationCommandSha256(context, entry);
  const debugPaths = appDebugPaths(appRecordPath(root, context.capabilityId, entry.id));
  let debugLaunch = null;
  if (debug) {
    debugLaunch = resolveStartDebugLaunch(entry, environment, { paths: runPaths, debugPaths, environment: env, platform });
    // The tool checks run without the environment's values: they are for the application only.
    assertDebugToolsAvailable(debugLaunch, { cwd, environment: base, platform, spawnSyncCommand: spawnSyncCommand ?? spawnSync });
    if (debugLaunch.port != null && await debugPortAccepts(debugLaunch.port)) {
      throw new SingularityFlowError(
        `${subject} debugs on ${debugLaunch.address}, and something already listens there. Stop it, or give the entry another debug.port. Nothing ran.`,
        { code: 'APP_DEBUG_PORT_IN_USE', details: { startId: entry.id, port: debugLaunch.port } });
    }
    output.write(`Debug start: ${debugLaunch.argv.join(' ')}${debugLaunch.environmentNames.length ? ` (with ${debugLaunch.environmentNames.join(', ')} set for the application only)` : ''}\n`);
    for (const note of debugLaunch.notes) output.write(`${note}\n`);
  }
  const applicationUrl = loopbackApplicationUrl(entry.url);
  const applicationPort = Number(applicationUrl.port || (applicationUrl.protocol === 'https:' ? 443 : 80));
  const applicationHost = applicationUrl.hostname.replace(/^\[|\]$/gu, '');
  if (await debugPortAccepts(applicationPort, { host: applicationHost, timeoutMs: 300 })) {
    throw portInUse(root, context, entry, subject, applicationUrl,
      await portHolder(root, applicationPort, { platform, spawnSyncCommand, host: applicationHost }), platform);
  }
  // Before-launch steps get the application's environment without the debugger's variables: a build
  // step must not start a JDWP agent or an inspector on the port the application will debug on.
  if (command.beforeLaunch.length && await runBeforeLaunch(root, entry, command.beforeLaunch, { env, platform, output, errorOutput, materialized, signals, signal })) {
    return { capability: context.capabilityId, id: entry.id, outcome: 'stopped', ready: false, exitCode: 0 };
  }
  if (debugLaunch) Object.assign(env, debugLaunch.environment);
  const files = filesToWrite(command.files, debugLaunch?.files);
  const written = [...files.map((file) => file.path), ...(debugLaunch ? [debugPaths.gradleInitScript, debugPaths.goBinary] : [])];
  const launchArgv = debugLaunch?.argv ?? command.argv;
  let child;
  try {
    for (const file of files) await writeMutablePrivateSidecar(root, file.path, file.content, { maximumBytes: MAXIMUM_RECORD_BYTES });
    child = await launchProcess(launchArgv, { cwd, env, platform, subject, startId: entry.id });
  } catch (error) {
    await removeFiles(written);
    throw error;
  }
  const record = {
    format: APP_RUN_FORMAT, capability: context.capabilityId, id: entry.id, pid: child.pid,
    runId: randomUUID(), checkout: path.resolve(root),
    ...(managedDependency ? { managedDependency: true } : {}),
    url: entry.url, startedAt: new Date().toISOString(), commandSha256,
    processStartedAt: processStartIdentity(child.pid, { platform }), environment, readyAt: null,
    // Paths only: another environment's run refuses to switch a shared file while this one runs.
    ...(materialized?.environmentFiles?.paths.length ? { environmentFiles: {
      checkout: materialized.environmentFiles.checkout, paths: [...materialized.environmentFiles.paths] } } : {}),
    ...(debugLaunch ? { debug: { runtime: debugLaunch.runtime, port: debugLaunch.port, listeningAt: null } } : {})
  };
  try { await writeAppRecord(root, record); } catch (error) { await stopTree(child.pid); await removeFiles(written); throw error; }
  if (debugLaunch && debugLaunch.port == null) output.write(`Attach a .NET debugger to process ${child.pid}; dotnet has no debugger listener.\n`);

  const logText = entry.ready.log ?? null;
  let recent = '';
  let logSeen = false;
  // A JVM says when its debugger listens; probing the port instead would log a failed handshake.
  const watchesJdwp = debugLaunch?.runtime === 'java' && debugLaunch.port != null;
  let jdwpRecent = '';
  let jdwpSeen = false;
  const watch = (text) => {
    if (logText && !logSeen) {
      recent = (recent + text).slice(-(logText.length + 4_096));
      if (recent.includes(logText)) logSeen = true;
    }
    if (watchesJdwp && !jdwpSeen) {
      jdwpRecent = (jdwpRecent + text).slice(-4_096);
      if (jdwpListeningLine(jdwpRecent, debugLaunch.port)) jdwpSeen = true;
    }
  };
  relayOutput(child.stdout, output, materialized, watch);
  relayOutput(child.stderr, errorOutput, materialized, watch);
  let exit = null;
  const exited = new Promise((resolve) => child.once('close', (code, signal) => { exit = { code, signal }; resolve(exit); }));
  let stopRequested = null;
  const onSignal = (name) => { stopRequested ??= name; void stopTree(child.pid); };
  const onAbort = () => onSignal('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  for (const name of signals) process.on(name, onSignal);
  let debugAnnounced = false;
  const announceDebugger = async () => {
    if (!debugLaunch || debugLaunch.port == null || debugAnnounced) return;
    if (!(watchesJdwp ? jdwpSeen : await debugPortAccepts(debugLaunch.port, { timeoutMs: 300 }))) return;
    debugAnnounced = true;
    output.write(`Debugger listening at ${debugLaunch.address}\n`);
    record.debug.listeningAt = new Date().toISOString();
    await writeAppRecord(root, record);
  };
  try {
    const deadline = Date.now() + entry.ready.timeoutMs;
    let ready = false;
    while (!exit && !stopRequested && Date.now() < deadline) {
      await announceDebugger();
      if (logText ? logSeen : (await probeLoopback(readinessUrl(entry), { timeoutMs: Math.min(2_000, POLL_MS * 4) })).ready) { ready = true; break; }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, POLL_MS))]);
      if (logText && logSeen) { ready = true; break; }
    }
    // Ready first is possible (a slow debugger, a fast server); give the listener a short while more.
    for (let wait = 0; ready && debugLaunch?.port != null && !debugAnnounced && !exit && wait < 20; wait += 1) {
      await announceDebugger();
      if (!debugAnnounced) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (ready && debugLaunch?.port != null && !debugAnnounced) {
      output.write(`The debugger did not start listening at ${debugLaunch.address}; the application runs without it.\n`);
    }
    if (!ready) {
      const earlyExit = exit;
      if (!exit) await stopTree(child.pid);
      await removeAppRecord(root, context.capabilityId, entry.id, child.pid);
      if (stopRequested) return { capability: context.capabilityId, id: entry.id, outcome: 'stopped', ready: false, exitCode: 0 };
      if (earlyExit) {
        throw new SingularityFlowError(`${subject} exited before it was ready (exit ${earlyExit.code ?? earlyExit.signal}).`, {
          code: 'APP_EXITED_BEFORE_READY', details: { startId: entry.id, exitCode: earlyExit.code, signal: earlyExit.signal } });
      }
      throw new SingularityFlowError(
        `${subject} was not ready within ${entry.ready.timeoutMs} ms (${logText ? `no '${logText}' in its output` : `${readinessUrl(entry).href} did not answer below 500`}). Its process tree was stopped.`,
        { code: 'APP_READY_TIMEOUT', details: { startId: entry.id, timeoutMs: entry.ready.timeoutMs, url: entry.url } });
    }
    record.readyAt = new Date().toISOString();
    await writeAppRecord(root, record);
    output.write(`Ready at ${entry.url}\n`);
    await onReady?.({ ...record });
    await exited;
    // `app stop` from elsewhere ends the tree with SIGTERM (then SIGKILL): that is a requested stop too.
    // A JVM (Spring Boot among them) answers SIGTERM by exiting 143 rather than dying of the signal.
    const stopped = Boolean(stopRequested) || ['SIGTERM', 'SIGINT', 'SIGKILL'].includes(exit?.signal) || [130, 137, 143].includes(exit?.code);
    return {
      capability: context.capabilityId, id: entry.id, outcome: stopped ? 'stopped' : 'exited', ready: true,
      exitCode: stopped ? 0 : exit?.code ?? 1, signal: exit?.signal ?? null
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    for (const name of signals) process.off(name, onSignal);
    // The leader may exit while descendants it started keep the group alive.
    if (!exit || pidAlive(child.pid, { group: true })) await stopTree(child.pid);
    await removeAppRecord(root, context.capabilityId, entry.id, child.pid);
    await removeFiles(written);
  }
}

/** Dependency orchestration loads only for an entry which declares services. */
export async function startApplication(root, context, entry, options = {}) {
  if (entry.dependsOn?.length) return (await import('./application-dependencies.mjs')).startWithDependencies(root, context, entry, options);
  return startSingleApplication(root, context, entry, options);
}

/** Fence simultaneous starts of the same entry without blocking other Story worktrees. */
export async function startSingleApplication(root, context, entry, options = {}) {
  const record = appRecordPath(root, context.capabilityId, entry.id);
  const existing = await readAppRecord(root, context.capabilityId, entry.id, { strict: true });
  if (existing && recordedProcessAlive(existing)) throw new SingularityFlowError(`Start entry '${entry.id}' is already running in this checkout.`, { code: 'APP_ALREADY_RUNNING' });
  const { safePrivateSidecarDirectory } = await import('./private-sidecar.mjs');
  await safePrivateSidecarDirectory(root, path.dirname(record), { create: true, enforceWindowsAcl: true });
  const { withRegistryFileLease } = await import('./file-lease.mjs');
  return withRegistryFileLease(record, () => runSingleApplication(root, context, entry, options), { timeoutMs: 2_000 });
}

/** Cleanup must preserve a checkout while its process or start lease is present. */
export async function applicationCheckoutInUse(root) {
  const directory = path.dirname(appRecordPath(root, 'runtime-check', 'probe'));
  const namespace = path.dirname(directory);
  const { listPrivateSidecar } = await import('./private-sidecar.mjs');
  const capabilities = await listPrivateSidecar(root, namespace, { optional: true });
  if (capabilities.length > 1024) return true;
  for (const capability of capabilities) {
    if (!capability.isDirectory() || capability.isSymbolicLink()) continue;
    const records = await listPrivateSidecar(root, path.join(namespace, capability.name), { optional: true });
    if (records.length > 1024) return true;
    for (const entry of records) {
      if (entry.name.endsWith('.lock')) return true;
      if (!entry.name.endsWith('.json')) continue;
      const record = await readAppRecord(root, capability.name, entry.name.slice(0, -5));
      if (!record || recordedProcessAlive(record)) return true;
    }
  }
  return false;
}

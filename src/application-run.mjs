/**
 * Starting, observing and stopping a capability's declared application [RUN M1].
 *
 * A start entry runs shell-free from its repository-relative working directory, in its own process
 * group, with the chosen environment's values given to that process only. Readiness is a loopback
 * HTTP answer below 500 or a literal log line; a timeout stops the whole tree. A private run record
 * (pid, url, start time, command identity) under the Git common directory lets `app status` and
 * `app stop` find exactly the processes `app start` started, and nothing else.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import {
  appDebugPaths, assertDebugToolsAvailable, debugPortAccepts, jdwpListeningLine, resolveDebugLaunch
} from './application-debug.mjs';
import { applicationStartArgv, applicationStartCommandSha256, loopbackApplicationUrl } from './capabilities.mjs';
import { gitCommonDir } from './git.mjs';
import { resolvePlatformProcess } from './platform-process.mjs';
import { readPrivateSidecar, writeMutablePrivateSidecar } from './private-sidecar.mjs';
import { terminateProcessTree, withoutHostSurfaceVariables } from './quality-command-runner.mjs';
import { environmentBindingRefusal, localIntegrationPolicyRefusal, selectRunEnvironment } from './run-environment.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';

export const APP_RUN_FORMAT = 'sflow-app-run/v1';
const MAXIMUM_RECORD_BYTES = 16 * 1024;
const POLL_MS = 500;
const STOP_GRACE_MS = 5_000;

/** What a start entry runs in one environment (argv, then that environment's arguments). */
export const startArgv = applicationStartArgv;

/** Refuse `--debug` for an entry without a debug block, before anything runs or is read. */
export function assertDebugDeclared(entry) {
  if (!entry.debug) resolveDebugLaunch(entry);
}

export function appRecordPath(root, capabilityId, startId) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'app', capabilityId, `${startId}.json`);
}

/** The process-start identity of a pid, so a recycled pid is never mistaken for a recorded process. */
export function processStartIdentity(pid, { platform = process.platform, spawnSyncCommand = spawnSync } = {}) {
  if (platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    // The system ps, never one a checkout or PATH entry could shadow.
    const result = spawnSyncCommand(existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
    const value = String(result.stdout ?? '').trim();
    return result.status === 0 && value ? value : null;
  } catch { return null; }
}

function pidAlive(pid, { group = false } = {}) {
  try { process.kill(group && process.platform !== 'win32' ? -pid : pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function validRecord(record, capabilityId, startId) {
  return record && record.format === APP_RUN_FORMAT && record.capability === capabilityId && record.id === startId
    && Number.isInteger(record.pid) && record.pid > 0 && typeof record.url === 'string'
    && typeof record.startedAt === 'string' && /^sha256:[a-f0-9]{64}$/u.test(String(record.commandSha256 ?? ''));
}

export async function readAppRecord(root, capabilityId, startId) {
  let bytes;
  try {
    bytes = await readPrivateSidecar(root, appRecordPath(root, capabilityId, startId), { maximumBytes: MAXIMUM_RECORD_BYTES, optional: true });
  } catch { return null; }
  if (!bytes) return null;
  try {
    const record = JSON.parse(bytes.toString('utf8'));
    return validRecord(record, capabilityId, startId) ? record : null;
  } catch { return null; }
}

async function writeAppRecord(root, record) {
  await writeMutablePrivateSidecar(root, appRecordPath(root, record.capability, record.id),
    `${JSON.stringify(record, null, 2)}\n`, { maximumBytes: MAXIMUM_RECORD_BYTES });
}

async function removeAppRecord(root, capabilityId, startId, expectedPid = null) {
  const current = await readAppRecord(root, capabilityId, startId);
  if (expectedPid != null && current && current.pid !== expectedPid) return;
  const { rm } = await import('node:fs/promises');
  await rm(appRecordPath(root, capabilityId, startId), { force: true }).catch(() => {});
}

/** Whether a recorded process is still the one `app start` started. */
export function recordedProcessAlive(record) {
  if (!record || !pidAlive(record.pid)) return false;
  if (!record.processStartedAt) return true;
  return processStartIdentity(record.pid) === record.processStartedAt;
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
    const launch = resolveDebugLaunch(entry, {
      argv: applicationStartArgv(entry, environment), environmentArguments: environment ? entry.arguments?.[environment] ?? [] : [],
      paths: appDebugPaths(appRecordPath(root, context.capabilityId, entry.id))
    });
    return { launcher: launch.launcher, argv: [...launch.argv], environmentNames: [...launch.environmentNames], notes: [...launch.notes] };
  } catch (error) {
    if (!String(error?.code ?? '').startsWith('APP_DEBUG_')) throw error;
    return { refusal: { code: error.code, message: error.message } };
  }
}

export async function planStartEntry(root, context, entry, declaration) {
  const environments = await startEntryEnvironments(root, entry, declaration);
  const plan = {
    capability: context.capabilityId,
    repository: entry.repository,
    id: entry.id,
    argv: [...entry.argv],
    workingDirectory: entry.workingDirectory,
    url: entry.url,
    ready: { ...entry.ready },
    environments,
    commandSha256: applicationStartCommandSha256(entry)
  };
  // Shown only when declared, so a plan of an entry without them reads exactly as before.
  if (entry.arguments) {
    plan.arguments = Object.fromEntries(Object.entries(entry.arguments).map(([name, list]) => [name, [...list]]));
    for (const environment of environments) environment.argv = applicationStartArgv(entry, environment.name);
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
  return plan;
}

export function selectStartEntry(context, startId = null) {
  const entries = context.application.start;
  if (!entries.length) {
    throw new SingularityFlowError(
      `Capability '${context.capabilityId}' declares no application start entry. Add application.start to singularity/capabilities.yml through a capability proposal.`,
      { code: 'APP_START_NOT_DECLARED', details: { capabilityId: context.capabilityId } });
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
    const record = await readAppRecord(root, context.capabilityId, entry.id);
    const started = recordedProcessAlive(record);
    const probe = await probeLoopback(readinessUrl(entry), { timeoutMs: 1_500 });
    entries.push({
      id: entry.id, declared: true, started, ready: probe.ready, url: entry.url,
      pid: started ? record.pid : null, startedAt: started ? record.startedAt : null,
      environment: started ? record.environment ?? null : null,
      commandSha256: applicationStartCommandSha256(entry),
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
  const record = await readAppRecord(root, context.capabilityId, entry.id);
  if (!record) return { capability: context.capabilityId, id: entry.id, stopped: false, reason: 'not-recorded' };
  if (!recordedProcessAlive(record)) {
    await removeAppRecord(root, context.capabilityId, entry.id, record.pid);
    return { capability: context.capabilityId, id: entry.id, stopped: false, reason: 'not-running' };
  }
  const stopped = await stopTree(record.pid);
  await removeAppRecord(root, context.capabilityId, entry.id, record.pid);
  return { capability: context.capabilityId, id: entry.id, stopped, pid: record.pid, reason: stopped ? 'stopped' : 'still-running' };
}

/**
 * Run one start entry in the foreground: spawn, record, wait for readiness, then stay attached
 * until the application exits or this process is asked to stop. Resolves with how it ended.
 */
export async function startApplication(root, context, entry, {
  requestedEnvironment = null, declaration = null, output = process.stdout, errorOutput = process.stderr,
  onReady = null, signals = ['SIGINT', 'SIGTERM', 'SIGHUP'], platform = process.platform, expectedCommandSha256 = null,
  debug = false, spawnSyncCommand = undefined
} = {}) {
  if (expectedCommandSha256 && expectedCommandSha256 !== applicationStartCommandSha256(entry)) {
    throw new SingularityFlowError(
      `Start entry '${entry.id}' changed since it was confirmed; nothing ran. Read singularity-flow app plan ${entry.id} --json and confirm again.`,
      { code: 'APP_COMMAND_CHANGED', details: { startId: entry.id, expected: expectedCommandSha256, commandSha256: applicationStartCommandSha256(entry) } });
  }
  assertRepositoryHere(context, entry);
  const existing = await readAppRecord(root, context.capabilityId, entry.id);
  if (existing && recordedProcessAlive(existing)) {
    throw new SingularityFlowError(`Start entry '${entry.id}' is already running (pid ${existing.pid}) at ${existing.url}. Stop it with singularity-flow app stop ${entry.id}.`,
      { code: 'APP_ALREADY_RUNNING', details: { capabilityId: context.capabilityId, startId: entry.id, pid: existing.pid, url: existing.url } });
  }
  const subject = `Start entry '${entry.id}'`;
  // Refused before an environment's values are read: a debug start needs its runtime declared.
  if (debug) assertDebugDeclared(entry);
  const environment = selectRunEnvironment({ listed: entry.environments, requested: requestedEnvironment, declaration, subject });
  const argv = applicationStartArgv(entry, environment);
  let materialized = null;
  if (environment) {
    if (context.policy?.localIntegrationEvidence !== 'allowed') {
      throw localIntegrationPolicyRefusal({ capabilityId: context.capabilityId, environment, subject });
    }
    const { materializeEnvironmentBinding } = await import('./environment-bindings.mjs');
    materialized = await materializeEnvironmentBinding(root, environment);
    if (materialized.status !== 'bound') {
      throw environmentBindingRefusal({ environment, status: materialized.status, missing: materialized.missing, subject });
    }
  }
  const cwd = (await secureRepositoryPath(root, entry.workingDirectory, {
    label: `${subject} working directory`, mustExist: true, type: 'directory'
  })).absolute;
  // The host's own variables (VS Code runs the CLI with ELECTRON_RUN_AS_NODE) never reach the application.
  const base = withoutHostSurfaceVariables(process.env);
  delete base.NODE_TEST_CONTEXT;
  const env = materialized ? materialized.childEnvironment(base) : base;
  const commandSha256 = applicationStartCommandSha256(entry);
  let debugLaunch = null;
  if (debug) {
    debugLaunch = resolveDebugLaunch(entry, {
      argv, environmentArguments: environment ? entry.arguments?.[environment] ?? [] : [], environment: env, platform,
      paths: appDebugPaths(appRecordPath(root, context.capabilityId, entry.id))
    });
    // The tool checks run without the environment's values: they are for the application only.
    assertDebugToolsAvailable(debugLaunch, { cwd, environment: base, platform, spawnSyncCommand: spawnSyncCommand ?? spawnSync });
    if (debugLaunch.port != null && await debugPortAccepts(debugLaunch.port)) {
      throw new SingularityFlowError(
        `${subject} debugs on ${debugLaunch.address}, and something already listens there. Stop it, or give the entry another debug.port. Nothing ran.`,
        { code: 'APP_DEBUG_PORT_IN_USE', details: { startId: entry.id, port: debugLaunch.port } });
    }
    for (const file of debugLaunch.files) await writeMutablePrivateSidecar(root, file.path, file.content, { maximumBytes: MAXIMUM_RECORD_BYTES });
    Object.assign(env, debugLaunch.environment);
    output.write(`Debug start: ${debugLaunch.argv.join(' ')}${debugLaunch.environmentNames.length ? ` (with ${debugLaunch.environmentNames.join(', ')} set for the application only)` : ''}\n`);
    for (const note of debugLaunch.notes) output.write(`${note}\n`);
  }
  const launchArgv = debugLaunch?.argv ?? argv;
  const launch = resolvePlatformProcess(launchArgv[0], launchArgv.slice(1), { platform, environment: env, cwd });
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
      code: 'APP_START_FAILED', details: { startId: entry.id, executable: launchArgv[0] } });
  }
  const record = {
    format: APP_RUN_FORMAT, capability: context.capabilityId, id: entry.id, pid: child.pid,
    url: entry.url, startedAt: new Date().toISOString(), commandSha256,
    processStartedAt: processStartIdentity(child.pid, { platform }), environment, readyAt: null,
    ...(debugLaunch ? { debug: { runtime: debugLaunch.runtime, port: debugLaunch.port, listeningAt: null } } : {})
  };
  await writeAppRecord(root, record);
  if (debugLaunch && debugLaunch.port == null) output.write(`Attach a .NET debugger to process ${child.pid}; dotnet has no debugger listener.\n`);

  const logText = entry.ready.log ?? null;
  let recent = '';
  let logSeen = false;
  // A JVM says when its debugger listens; probing the port instead would log a failed handshake.
  const watchesJdwp = debugLaunch?.runtime === 'java' && debugLaunch.port != null;
  let jdwpRecent = '';
  let jdwpSeen = false;
  const relay = (stream, target) => {
    const redactor = materialized?.redactsAnything ? materialized.streamRedactor() : null;
    const emit = (text) => {
      if (!text) return;
      target.write(text);
      if (logText && !logSeen) {
        recent = (recent + text).slice(-(logText.length + 4_096));
        if (recent.includes(logText)) logSeen = true;
      }
      if (watchesJdwp && !jdwpSeen) {
        jdwpRecent = (jdwpRecent + text).slice(-4_096);
        if (jdwpListeningLine(jdwpRecent, debugLaunch.port)) jdwpSeen = true;
      }
    };
    stream.on('data', (chunk) => emit(redactor ? redactor.write(chunk) : chunk.toString('utf8')));
    stream.on('end', () => { if (redactor) emit(redactor.end()); });
  };
  relay(child.stdout, output);
  relay(child.stderr, errorOutput);
  let exit = null;
  const exited = new Promise((resolve) => child.once('close', (code, signal) => { exit = { code, signal }; resolve(exit); }));
  let stopRequested = null;
  const onSignal = (name) => { stopRequested ??= name; void stopTree(child.pid); };
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
    for (const name of signals) process.off(name, onSignal);
    // The leader may exit while descendants it started keep the group alive.
    if (!exit || pidAlive(child.pid, { group: true })) await stopTree(child.pid);
    await removeAppRecord(root, context.capabilityId, entry.id, child.pid);
    if (debugLaunch) {
      const { rm } = await import('node:fs/promises');
      const paths = appDebugPaths(appRecordPath(root, context.capabilityId, entry.id));
      for (const file of [paths.gradleInitScript, paths.goBinary]) await rm(file, { force: true, recursive: true }).catch(() => {});
    }
  }
}

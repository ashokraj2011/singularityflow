import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { gitCommonDir } from '../src/git.mjs';
import {
  explainTelemetryStatus,
  listTelemetryLaunches,
  prepareTelemetryLaunch,
  probeTelemetry,
  recordTelemetryLaunch,
  setTelemetryCapture,
  TELEMETRY_DISCLOSURE_DIGEST
} from '../src/telemetry-provision.mjs';
import { run } from '../src/util.mjs';

async function repository(prefix = 'sflow-telemetry-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  run('git', ['init', '-q'], { cwd: root });
  run('git', ['config', 'user.name', 'Telemetry Test'], { cwd: root });
  run('git', ['config', 'user.email', 'telemetry@example.test'], { cwd: root });
  return root;
}

async function acceptedEnvironment(root) {
  const preference = path.join(root, 'machine', 'telemetry-preferences.json');
  const env = { PATH: process.env.PATH, SINGULARITY_FLOW_TELEMETRY_PREFERENCES: preference };
  await setTelemetryCapture(true, { acceptDisclosure: true, env });
  return env;
}

test('launch provisioning is per-process, content-off, and bound to the Git common directory', async () => {
  const root = await repository();
  const env = await acceptedEnvironment(root);
  const before = { ...env };
  const first = await prepareTelemetryLaunch({
    root, story: 'PAY-1187', phase: 'implementation', host: 'cli', surface: 'cli.copilot', baseEnv: env
  });
  const second = await prepareTelemetryLaunch({
    root, story: 'PAY-1187', phase: 'implementation', host: 'vscode-terminal', surface: 'vscode.continue', baseEnv: env
  });

  assert.deepEqual(env, before, 'the caller environment is never mutated');
  assert.equal(first.captureStatus, 'configured');
  assert.equal(first.injectedEnv.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT, 'false');
  assert.equal(first.injectedEnv.COPILOT_OTEL_CAPTURE_CONTENT, 'false');
  assert.notEqual(first.launch.launchId, second.launch.launchId);
  assert.notEqual(first.rawAbsolute, second.rawAbsolute);
  assert.ok(first.rawAbsolute.startsWith(path.join(gitCommonDir(root), 'singularity-flow', 'telemetry', 'raw')));

  await recordTelemetryLaunch(first, { state: 'started' });
  await recordTelemetryLaunch(first, { state: 'finished', exitCode: 0 });
  const launches = await listTelemetryLaunches(root, { storyId: 'PAY-1187' });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].surface, 'cli.copilot');
  assert.equal(launches[0].process.exitCode, 0);
  assert.equal(launches[0].configurationDigest.length, 64);
  assert.ok(!JSON.stringify(launches[0]).includes(root), 'launch records carry hashes and relative paths, not checkout paths');
});

test('existing exporter configuration and forced content capture are preserved and never disclosed', async () => {
  const root = await repository();
  const env = await acceptedEnvironment(root);
  const secretEndpoint = 'https://collector.example.test/token/example-secret-value';
  const conflict = await prepareTelemetryLaunch({
    root, baseEnv: { ...env, OTEL_EXPORTER_OTLP_ENDPOINT: secretEndpoint, OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=secret' }
  });
  assert.equal(conflict.captureStatus, 'conflict');
  assert.equal(conflict.env.OTEL_EXPORTER_OTLP_ENDPOINT, secretEndpoint);
  assert.equal(conflict.injectedEnv.COPILOT_OTEL_FILE_EXPORTER_PATH, undefined);
  assert.deepEqual(conflict.launch.capabilityProbe.conflicts, ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS']);
  assert.doesNotMatch(JSON.stringify(conflict.launch), /example-secret-value|Authorization=secret/);

  const blocked = await prepareTelemetryLaunch({
    root, baseEnv: { ...env, OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'true' }
  });
  assert.equal(blocked.captureStatus, 'blocked-by-content-policy');
  assert.equal(blocked.injectedEnv.COPILOT_OTEL_ENABLED, undefined);
});

test('capture requires current disclosure, disabling is non-governing, and native hosts stay honest', async () => {
  const root = await repository();
  const preference = path.join(root, 'machine', 'telemetry-preferences.json');
  const env = { PATH: process.env.PATH, SINGULARITY_FLOW_TELEMETRY_PREFERENCES: preference };

  const undisclosed = await prepareTelemetryLaunch({ root, baseEnv: env });
  assert.equal(undisclosed.captureStatus, 'disclosure-required');
  await setTelemetryCapture(false, { env });
  const disabled = await prepareTelemetryLaunch({ root, baseEnv: env });
  assert.equal(disabled.captureStatus, 'disabled-by-user');

  const nativeVsCode = await probeTelemetry({
    root, provider: 'github-copilot', runtime: 'copilot-native', host: 'vscode-native', env
  });
  const nativeIntellij = await probeTelemetry({
    root, provider: 'github-copilot', runtime: 'copilot-native', host: 'intellij-native', env
  });
  assert.equal(nativeVsCode.mode, 'native-config');
  assert.equal(nativeVsCode.available, false);
  assert.equal(nativeIntellij.mode, 'external-only');
  assert.equal(nativeIntellij.available, false);

  const status = await explainTelemetryStatus({ root, env });
  assert.equal(status.status, 'disabled');
  assert.equal(status.preference.disclosureDigest, TELEMETRY_DISCLOSURE_DIGEST);
  assert.equal(status.preference.path, undefined);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const stored = JSON.parse(await readFile(preference, 'utf8'));
  assert.equal(stored.enabled, false);
});

test('ended launch streams age out after the local seven-day privacy window', async () => {
  const root = await repository();
  const env = await acceptedEnvironment(root);
  const prepared = await prepareTelemetryLaunch({
    root, baseEnv: env, startedAt: '2026-07-01T00:00:00.000Z'
  });
  await recordTelemetryLaunch(prepared, { state: 'started' });
  await writeFile(prepared.rawAbsolute, '{"usage":"metadata-only"}\n');
  await recordTelemetryLaunch(prepared, {
    state: 'finished', exitCode: 0, endedAt: '2026-07-01T00:01:00.000Z'
  });
  assert.equal(await stat(prepared.rawAbsolute).catch(() => null), null);
  assert.equal((await listTelemetryLaunches(root)).length, 1, 'attribution remains after raw retention expires');
});

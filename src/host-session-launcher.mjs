import { spawnSync } from 'node:child_process';
import { assertModelInvocationAllowed } from './operation-context.mjs';
import {
  isPreparedTelemetryLaunch,
  prepareTelemetryLaunch,
  recordTelemetryLaunch
} from './telemetry-provision.mjs';
import { resolvePlatformProcess } from './platform-process.mjs';
import { SingularityFlowError } from './util.mjs';

// Interactive host sessions are intentionally separate from bounded kernel model calls.
export async function launchHostSession({
  cwd, args = [], dryRun = false, story = null, phase = null, host = 'cli',
  surface = 'cli.workspace-copilot', preparedTelemetry = null, execution = null
}) {
  // Permission belongs to the actual process boundary. A dry run only renders the launch plan;
  // every real launch is refused before telemetry preparation or any other side effect.
  if (!dryRun) assertModelInvocationAllowed();
  const telemetry = isPreparedTelemetryLaunch(preparedTelemetry)
    ? preparedTelemetry
    : await prepareTelemetryLaunch({ root: cwd, story, phase, host, surface, baseEnv: process.env });
  const launch = {
    command: 'copilot', args, cwd,
    telemetry: {
      launchId: telemetry.launch.launchId,
      captureStatus: telemetry.captureStatus,
      provisioningMode: telemetry.launch.provisioningMode,
      notices: [...telemetry.notices]
    }
  };
  if (dryRun) return launch;
  const recordLaunch = execution?.recordTelemetryLaunch ?? recordTelemetryLaunch;
  const spawnHost = execution?.spawnSync ?? spawnSync;
  let launchEnvironment = telemetry.env;
  let attributionRecorded = false;
  // Launch receipts are best-effort metadata, never an availability dependency for Copilot.
  try {
    await recordLaunch(telemetry, { state: 'started' });
    attributionRecorded = true;
  } catch {
    if (telemetry.captureStatus === 'configured') {
      const notice = 'Usage capture is unavailable because the durable launch attribution record could not be created. Your Copilot session can continue.';
      launch.telemetry = {
        ...launch.telemetry,
        captureStatus: 'unavailable-recording-failure',
        notices: [...launch.telemetry.notices, notice]
      };
      // Do not create an unattributed raw stream. Remove only values that Singularity Flow injected;
      // unrelated user or organization telemetry configuration is preserved byte-for-byte.
      launchEnvironment = { ...telemetry.env };
      for (const key of Object.keys(telemetry.injectedEnv ?? {})) delete launchEnvironment[key];
      console.warn(`Telemetry warning: ${notice}`);
    }
  }
  let processLaunch;
  try {
    processLaunch = resolvePlatformProcess('copilot', args, {
      platform: execution?.platform ?? process.platform,
      environment: launchEnvironment,
      spawnSyncCommand: execution?.platformLookup ?? spawnSync,
      cwd
    });
  } catch (error) {
    throw new SingularityFlowError(`Unable to resolve GitHub Copilot: ${error.message}`, {
      code: 'MODEL_PROVIDER_UNAVAILABLE', cause: error
    });
  }
  const result = spawnHost(processLaunch.executable, processLaunch.arguments, {
    cwd, env: launchEnvironment, stdio: 'inherit', ...processLaunch.spawnOptions
  });
  if (attributionRecorded) {
    await recordLaunch(telemetry, {
      state: 'finished', exitCode: result.status, signal: result.signal,
      errorCode: result.error?.code ?? null
    }).catch(() => {});
  }
  if (result.error) throw new SingularityFlowError(`Unable to start GitHub Copilot: ${result.error.message}`);
  if (result.status !== 0) throw new SingularityFlowError(`GitHub Copilot exited with status ${result.status}.`);
  return launch;
}

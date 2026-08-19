import { spawnSync } from 'node:child_process';
import { assertModelInvocationAllowed } from './operation-context.mjs';
import {
  isPreparedTelemetryLaunch,
  prepareTelemetryLaunch,
  recordTelemetryLaunch
} from './telemetry-provision.mjs';
import { SingularityFlowError } from './util.mjs';

// Interactive host sessions are intentionally separate from bounded kernel model calls.
export async function launchHostSession({
  cwd, args = [], dryRun = false, story = null, phase = null, host = 'cli',
  surface = 'cli.workspace-copilot', preparedTelemetry = null
}) {
  assertModelInvocationAllowed();
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
  const command = process.platform === 'win32' ? 'copilot.cmd' : 'copilot';
  // Launch receipts are best-effort metadata, never an availability dependency for Copilot.
  await recordTelemetryLaunch(telemetry, { state: 'started' }).catch(() => {});
  const result = spawnSync(command, args, { cwd, env: telemetry.env, stdio: 'inherit', shell: false });
  await recordTelemetryLaunch(telemetry, {
    state: 'finished', exitCode: result.status, signal: result.signal,
    errorCode: result.error?.code ?? null
  }).catch(() => {});
  if (result.error) throw new SingularityFlowError(`Unable to start GitHub Copilot: ${result.error.message}`);
  if (result.status !== 0) throw new SingularityFlowError(`GitHub Copilot exited with status ${result.status}.`);
  return launch;
}

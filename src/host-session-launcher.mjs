import { spawnSync } from 'node:child_process';
import { assertModelInvocationAllowed } from './operation-context.mjs';
import { SingularityFlowError } from './util.mjs';

// Interactive host sessions are intentionally separate from bounded kernel model calls.
export function launchHostSession({ cwd, args = [], dryRun = false }) {
  assertModelInvocationAllowed();
  const launch = { command: 'copilot', args, cwd };
  if (dryRun) return launch;
  const command = process.platform === 'win32' ? 'copilot.cmd' : 'copilot';
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: 'inherit', shell: false });
  if (result.error) throw new SingularityFlowError(`Unable to start GitHub Copilot: ${result.error.message}`);
  if (result.status !== 0) throw new SingularityFlowError(`GitHub Copilot exited with status ${result.status}.`);
  return launch;
}

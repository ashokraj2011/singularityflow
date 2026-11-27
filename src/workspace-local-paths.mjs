/**
 * A file of this machine's workspace, never of the code base [WCB:REQ-002, docs/SPEC-WCB-WATCH-CODE-BASE-v1.md]: an editor's
 * own settings (application-paths.mjs isEditorConfigurationPath), a file named to stay on one machine (`.env`, `*.local.*`:
 * local-config-policy.mjs), or a test runner's output folder. No gate counts it, no code step takes it, and nobody is asked
 * about it. Owner, 2026-11-27: "We should care about the code base, not any of these settings files or any config files or
 * test folders." Its own leaf, so the Copilot edit guard, which reads application-paths.mjs on every tool call, loads none
 * of it.
 */
import { isEditorConfigurationPath, isTestRunnerOutputPath } from './application-paths.mjs';
import { alwaysLocalName } from './local-config-policy.mjs';

export function isWorkspaceLocalPath(candidate) {
  const value = String(candidate ?? '');
  return isEditorConfigurationPath(value) || Boolean(alwaysLocalName(value)) || isTestRunnerOutputPath(value);
}

/** Host-neutral bootstrap commands: VS Code supplies PLUGIN_ROOT; CLI hosts may use
 * COPILOT_PLUGIN_ROOT. These commands must resolve the installed launcher before Node runs. */
const ACTIONS = new Set(['boundary-turn', 'boundary-guard', 'boundary-after', 'boundary-end', 'agent-start']);
const UNAVAILABLE = 'SFLOW_HOOK_PLUGIN_ROOT_UNAVAILABLE: The packaged SFlow hook launcher was not found using PLUGIN_ROOT or COPILOT_PLUGIN_ROOT. Repair the installation, run singularity-flow plugin install, and reload VS Code. Preserve the Story; do not disable hooks.';

export function copilotHookCommand(action, shell) {
  if (!ACTIONS.has(action)) throw new TypeError(`Unsupported Copilot hook action: ${action}`);
  const result = JSON.stringify(action === 'boundary-guard'
    ? { permissionDecision: 'deny', permissionDecisionReason: UNAVAILABLE } : {});
  if (shell === 'bash') return 'sflow_hook_root="${PLUGIN_ROOT:-${COPILOT_PLUGIN_ROOT:-}}"; '
    + 'if [ -n "$sflow_hook_root" ] && [ "${sflow_hook_root#/}" != "$sflow_hook_root" ] && [ -f "$sflow_hook_root/hook-launcher.sh" ]; then '
    + `/bin/bash "$sflow_hook_root/hook-launcher.sh" ${action}; `
    + `else printf '%s\\n' '${result}'; printf '%s\\n' '${UNAVAILABLE}' >&2; fi`;
  if (shell === 'powershell') return '$sflowHookRoot = if ($env:PLUGIN_ROOT) { $env:PLUGIN_ROOT } else { $env:COPILOT_PLUGIN_ROOT }; '
    + "if ($sflowHookRoot -and [System.IO.Path]::IsPathRooted($sflowHookRoot) -and (Test-Path -LiteralPath (Join-Path $sflowHookRoot 'hook-launcher.ps1') -PathType Leaf -ErrorAction SilentlyContinue)) { "
    + `& (Join-Path $sflowHookRoot 'hook-launcher.ps1') ${action} } `
    + `else { Write-Output '${result}'; [Console]::Error.WriteLine('${UNAVAILABLE}'); exit 0 }`;
  throw new TypeError(`Unsupported Copilot hook shell: ${shell}`);
}

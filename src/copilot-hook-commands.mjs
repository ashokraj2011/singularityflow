/** Host-neutral bootstrap commands: VS Code supplies PLUGIN_ROOT; CLI hosts may use
 * COPILOT_PLUGIN_ROOT. These commands must resolve the installed launcher before Node runs.
 * VS Code before 1.141 passes neither (microsoft/vscode#338967), and a chat started before an update
 * may name a copy since removed: then the folder `plugin install` and the launcher itself record in
 * the marker beside the Copilot mode file (pluginMarkerFile in src/repository-hooks.mjs). The host starts
 * each command in the folder COPILOT_HOOK_CWD names (src/repository-hooks.mjs). */
const ACTIONS = new Set(['boundary-turn', 'boundary-guard', 'boundary-after', 'boundary-end', 'agent-start', 'boundary-stop', 'boundary-failure']);
const UNAVAILABLE = 'SFLOW_HOOK_PLUGIN_ROOT_UNAVAILABLE: The packaged SFlow hook launcher was not found from PLUGIN_ROOT, COPILOT_PLUGIN_ROOT or the plugin folder SFlow recorded. VS Code before 1.141 passes no plugin folder, so update VS Code; otherwise run singularity-flow plugin install, which records it, and reload VS Code. Preserve the Story; do not disable hooks.';

export function copilotHookCommand(action, shell) {
  if (!ACTIONS.has(action)) throw new TypeError(`Unsupported Copilot hook action: ${action}`);
  const result = JSON.stringify(action === 'boundary-guard'
    ? { permissionDecision: 'deny', permissionDecisionReason: UNAVAILABLE,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: UNAVAILABLE } } : {});
  const bashFound = '[ -n "$sflow_hook_root" ] && [ "${sflow_hook_root#/}" != "$sflow_hook_root" ] && [ -f "$sflow_hook_root/hook-launcher.sh" ]';
  if (shell === 'bash') return 'sflow_hook_root="${PLUGIN_ROOT:-${COPILOT_PLUGIN_ROOT:-}}"; '
    + `if ! { ${bashFound}; }; then sflow_hook_root=''; `
    + 'sflow_hook_marker="${SINGULARITY_FLOW_COPILOT_MODE_FILE:-${HOME:-}/.singularity-flow/copilot-mode.json}"; '
    + 'sflow_hook_marker="${sflow_hook_marker%/*}/copilot-plugin"; '
    + 'if [ -f "$sflow_hook_marker" ]; then IFS= read -r sflow_hook_root < "$sflow_hook_marker"; fi; fi; '
    + `if ${bashFound}; then `
    + `/bin/bash "$sflow_hook_root/hook-launcher.sh" ${action}; `
    + `else printf '%s\\n' '${result}'; printf '%s\\n' '${UNAVAILABLE}' >&2; fi`;
  // The launcher is a script file, which this machine's execution policy may refuse (Restricted is
  // the Windows client default; AllSigned refuses it unsigned), and a refused hook stops every tool
  // call. Only then is it run again in one PowerShell of its own, with the policy bypassed for that
  // process alone and no profile; the machine's policy is never changed, and the usual path starts
  // no second PowerShell.
  const powershellFound = "$sflowHookRoot -and [System.IO.Path]::IsPathRooted($sflowHookRoot) -and (Test-Path -LiteralPath (Join-Path $sflowHookRoot 'hook-launcher.ps1') -PathType Leaf -ErrorAction SilentlyContinue)";
  if (shell === 'powershell') return '$sflowHookRoot = if ($env:PLUGIN_ROOT) { $env:PLUGIN_ROOT } else { $env:COPILOT_PLUGIN_ROOT }; '
    + `if (-not (${powershellFound})) { `
    + "$sflowHookMode = if ($env:SINGULARITY_FLOW_COPILOT_MODE_FILE) { $env:SINGULARITY_FLOW_COPILOT_MODE_FILE } else { Join-Path (Join-Path $HOME '.singularity-flow') 'copilot-mode.json' }; "
    + "$sflowHookMarker = Join-Path (Split-Path -Parent $sflowHookMode) 'copilot-plugin'; "
    + "$sflowHookRoot = if (Test-Path -LiteralPath $sflowHookMarker -PathType Leaf -ErrorAction SilentlyContinue) { Get-Content -LiteralPath $sflowHookMarker -TotalCount 1 -ErrorAction SilentlyContinue } else { $null } }; "
    + `if (${powershellFound}) { `
    + "$sflowLauncher = Join-Path $sflowHookRoot 'hook-launcher.ps1'; "
    + `try { & $sflowLauncher ${action} } catch [System.Management.Automation.PSSecurityException] { `
    + `& (Get-Process -Id $PID).Path -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $sflowLauncher ${action} } } `
    + `else { Write-Output '${result}'; [Console]::Error.WriteLine('${UNAVAILABLE}'); exit 0 }`;
  throw new TypeError(`Unsupported Copilot hook shell: ${shell}`);
}

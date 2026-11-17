/** Native lifecycle presentation. The server does not own command rendering or Story recovery. */
export async function withUiRecovery(error, argv) {
  if (!String(error?.code ?? '').startsWith('UI_')) return error;
  const [{ refusalEnvelope }, { safeCommandGuidance }, { redactDiagnosticText }] = await Promise.all([
    import('../refusal-remediation.mjs'), import('../safe-command-guidance.mjs'), import('../git-remote-diagnostics.mjs')
  ]);
  const route = (id, label, command) => ({ id, label, ...safeCommandGuidance({ command }),
    kind: 'remediation', execution: 'user-reviewed' });
  const instruction = label => ({ id: 'preserve-local-work', label, command: null, executable: null,
    argv: null, skill: null, copilotCommand: null, copyable: false, platformCommands: null,
    kind: 'remediation', execution: 'user-reviewed' });
  const code = error.code;
  let steps;
  if (['UI_COMMAND_INVALID', 'UI_IDLE_INVALID'].includes(code)) {
    steps = [route('ui-help', 'Use the supported local service forms and timeout range.', 'singularity-flow ui --help')];
  } else if (['UI_SERVICE_BUSY', 'UI_SERVICE_DRAINING', 'UI_BUILD_MISMATCH'].includes(code)) {
    steps = [route('ui-status', 'Inspect the verified running build and admitted operations.', 'singularity-flow ui status --json'),
      route('ui-drain', 'From your native terminal, let admitted work finish before replacing this service.', 'singularity-flow ui stop --drain')];
  } else if (['UI_PLATFORM_UNQUALIFIED', 'UI_REMOTE_UNQUALIFIED'].includes(code)) {
    steps = [instruction('Use the existing CLI or native VS Code panels on this host. This browser mode needs its declared platform qualification; changing a Story or its permissions cannot enable it.')];
  } else if (['UI_REQUEST_NOT_FOUND', 'UI_CLIENT_SCOPE_CHANGED'].includes(code)) {
    steps = [instruction('Preserve the original request ID. Inspect the canonical draft and save history using your current native identity; absence of a receipt is not proof that a write did not execute.'),
      route('ui-open-new', 'Open a fresh browser client without replaying the original operation.', 'singularity-flow ui open')];
  } else if (['UI_PRIVATE_STATE_UNSAFE', 'UI_STATE_UNREADABLE', 'UI_NATIVE_AUTH_REQUIRED', 'UI_DISCOVERY_INVALID', 'UI_INSTANCE_MISMATCH'].includes(code)) {
    steps = [instruction('Preserve the private discovery record and retained request IDs. Verify the named file ownership, native user and installed build before reconnecting. Do not delete state, kill an unverified PID or repeat an uncertain write.'),
      route('ui-about', 'Inspect this native CLI build and runtime.', 'singularity-flow about --json')];
  } else {
    steps = [route('ui-status', 'Inspect the service and original operation before attempting another launch.', 'singularity-flow ui status --json'),
      instruction('Preserve the reported deadline, native error and original request IDs. Correct the local service condition before retrying; no Story needs recreation and an uncertain write must not be repeated.')];
  }
  const envelope = refusalEnvelope(error, argv);
  // The general refusal projector predates transport deadlines. Preserve these typed native
  // diagnostics here; never serialize the private credential or the native environment object.
  const details = { ...envelope.error.details };
  for (const key of ['file', 'cause', 'code', 'instance', 'timeoutMs', 'stage', 'exitCode', 'signal', 'running', 'queued']) {
    const value = error.details?.[key];
    if (typeof value === 'string') details[key] = redactDiagnosticText(value).slice(0, 8192);
    else if (typeof value === 'number' && Number.isFinite(value)) details[key] = value;
  }
  if (Object.keys(details).length) envelope.error.details = details;
  envelope.remediationPlan = { schemaVersion: 1, status: 'blocked', code, steps,
    retry: { label: 'Retry only after the local service condition is resolved; inspect original operation outcomes before repeating consequential work.', automatic: false } };
  error.relayedResult = envelope;
  return error;
}

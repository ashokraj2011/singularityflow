/**
 * One presentation boundary for a safe shell command and its direct Copilot equivalent.
 *
 * CLI responses are still treated as untrusted process output by the extension. A command is
 * displayable only when it is a bounded, credential-free SFlow invocation. The Copilot route is
 * then resolved through the engine-owned crosswalk; panels never manufacture `/sf-*` names from
 * command strings themselves.
 */
import { safeCommandGuidance } from '../../../src/safe-command-guidance.mjs';

export type CommandGuidance = Readonly<{
  command: string;
  executable: 'singularity-flow';
  argv: readonly string[];
  skill: string;
  copilotCommand: string;
  copyable: boolean;
  platformCommands: Readonly<{ darwin: string; linux: string; win32: string }> | null;
}>;

/**
 * Validate one surfaced command and supply both invocation forms.
 *
 * Missing route fields are derived for older envelopes. Supplied fields are assertions and must
 * exactly match the engine-owned crosswalk, including the intentional argument-preserving SGOS and
 * Auto relays. The shared validator also rejects unknown CLI families and shell syntax.
 */
export function commandGuidance(value: unknown): CommandGuidance | null {
  const guidance = safeCommandGuidance(value) as CommandGuidance | null;
  return guidance == null ? null : Object.freeze({
    command: guidance.command,
    executable: guidance.executable,
    argv: Object.freeze([...guidance.argv]),
    skill: guidance.skill,
    copilotCommand: guidance.copilotCommand,
    copyable: guidance.copyable,
    platformCommands: guidance.platformCommands
  });
}

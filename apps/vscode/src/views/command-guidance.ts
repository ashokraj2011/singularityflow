/** Shared, fail-closed presentation for an engine-supplied SFlow continuation. */
import { commandGuidance, type CommandGuidance } from '../copilot-command.ts';
import { escape } from './webview.ts';

export function safeCommandPair(value: unknown): CommandGuidance | null {
  return commandGuidance(value);
}

/** Render both equivalent routes. Callers must include `COMMAND_GUIDANCE_COPY_SCRIPT`. */
export function commandGuidanceHtml(value: unknown, options: {
  shellCopy?: string;
  shellLabel?: string;
  copilotLabel?: string;
} = {}): string {
  const guidance = safeCommandPair(value);
  if (!guidance) return '';
  const shellCopy = options.shellCopy ?? guidance.command;
  const shellButton = guidance.copyable
    ? `<button type="button" class="secondary" data-copy-command="${escape(shellCopy)}">Copy Shell</button>` : '';
  const copilotButton = guidance.copyable
    ? `<button type="button" class="secondary" data-copy-command="${escape(guidance.copilotCommand)}">Copy Copilot</button>` : '';
  return `<div class="command-guidance">
    <p><strong>${escape(options.shellLabel ?? 'Shell')}:</strong> <code>${escape(guidance.command)}</code>
      ${shellButton}</p>
    <p><strong>${escape(options.copilotLabel ?? 'Copilot')}:</strong> <code>${escape(guidance.copilotCommand)}</code>
      ${copilotButton}</p>
    ${guidance.copyable ? '' : '<p class="muted">Replace the shown placeholders before running this command.</p>'}
  </div>`;
}

/** Plain-text equivalent for notifications, output channels, and native confirmation dialogs. */
export function commandGuidanceText(value: unknown): string | null {
  const guidance = safeCommandPair(value);
  return guidance
    ? `Shell: ${guidance.command}\nCopilot: ${guidance.copilotCommand}`
    : null;
}

/** Browser-side copy support shared by pages that render `commandGuidanceHtml`. */
export const COMMAND_GUIDANCE_COPY_SCRIPT = `
  const copyCommand = event.target.closest('[data-copy-command]');
  if (copyCommand) {
    navigator.clipboard.writeText(copyCommand.dataset.copyCommand || '').catch(() => {});
    return;
  }
`;

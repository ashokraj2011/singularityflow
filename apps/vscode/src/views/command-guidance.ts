/** Shared, fail-closed presentation for an engine-supplied SFlow continuation. */
import { chatModelsMissing, commandGuidance, modelFreeRouteHtml, modelFreeRouteText, type CommandGuidance } from '../copilot-command.ts';
import { escape } from './webview.ts';
import { commandRouteRows, formatCommandRouteLines, type PresentedCommandRoutes } from '../../../../src/model-free-commands.mjs';

export function safeCommandPair(value: unknown): CommandGuidance | null {
  return commandGuidance(value);
}

/** Layout for routes already validated by the owning card/view; this adds no runnable actions. */
export function commandRouteListHtml(guidance: PresentedCommandRoutes, buttons: readonly string[] = []): string {
  return `<ul class="command-guidance-routes">${commandRouteRows(guidance).map((row, index) =>
    `<li><strong>${escape(row.label)}:</strong> ${index === 2 ? modelFreeRouteHtml(row.command, escape)
      : row.command ? `<code>${escape(row.command)}</code>` : escape(row.unavailable)} ${buttons[index] ?? ''}</li>`).join('')}</ul>`;
}

/** Render three surfaces; advertise @ only for an exact supported equivalent. */
export function commandGuidanceHtml(value: unknown, options: {
  shellCopy?: string;
} = {}): string {
  const guidance = safeCommandPair(value);
  if (!guidance) return '';
  const shellCopy = options.shellCopy ?? guidance.command;
  const shellButton = guidance.copyable
    ? `<button type="button" class="secondary" data-copy-command="${escape(shellCopy)}">Copy Shell</button>` : '';
  const copilotButton = guidance.copyable && guidance.copilotCommand
    ? `<button type="button" class="secondary" data-copy-command="${escape(guidance.copilotCommand)}">Copy Copilot</button>` : '';
  // Only an @sflow route is copied for chat; a Command Palette route (the Decide card) is opened there.
  const modelFreeButton = guidance.modelFreeCommand?.startsWith('@sflow') && !chatModelsMissing()
    ? `<button type="button" class="secondary" data-copy-command="${escape(guidance.modelFreeCommand)}">Copy @sflow</button>` : '';
  const buttons = [copilotButton, shellButton, modelFreeButton];
  return `<div class="command-guidance">${commandRouteListHtml(guidance, buttons)}
    ${guidance.copyable ? '' : '<p class="muted">Replace the shown placeholders before running this command.</p>'}
  </div>`;
}

/** Plain-text equivalent for notifications, output channels, and native confirmation dialogs. */
export function commandGuidanceText(value: unknown): string | null {
  const guidance = safeCommandPair(value);
  return guidance
    ? formatCommandRouteLines(guidance, { modelFreeNote: modelFreeNote(guidance) }).join('\n')
    : null;
}

function modelFreeNote(guidance: CommandGuidance): string {
  return guidance.modelFreeCommand ? modelFreeRouteText(guidance.modelFreeCommand).slice(guidance.modelFreeCommand.length).trim() : '';
}

/** Chat Markdown uses the same rows, with exact commands in safe inline code spans. */
export function commandGuidanceMarkdown(value: unknown): string | null {
  const guidance = safeCommandPair(value);
  return guidance ? formatCommandRouteLines(guidance, { markdown: true, modelFreeNote: modelFreeNote(guidance) }).join('\n') : null;
}
/** Browser-side copy support shared by pages that render `commandGuidanceHtml`. */
export const COMMAND_GUIDANCE_COPY_SCRIPT = `
  const copyCommand = event.target.closest('[data-copy-command]');
  if (copyCommand) {
    navigator.clipboard.writeText(copyCommand.dataset.copyCommand || '').catch(() => {});
    return;
  }
`;

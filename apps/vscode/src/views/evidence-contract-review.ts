import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { pendingEvidenceSuggestions } from './phase-issues-page.ts';

/** Select exact scope; the engine, not this webview, independently presents and captures consent. */
export async function reviewEvidenceContract(client: SingularityFlowClient, workId: string, phaseId: string,
  stillCurrent: () => boolean, inspection: unknown): Promise<void> {
  const suggestions = pendingEvidenceSuggestions(inspection);
  const picked = suggestions.length > 1 ? await vscode.window.showQuickPick(suggestions.map(item => ({ label: item.path, item })),
    { title: 'Retained evidence requiring classification review', ignoreFocusOut: true }) : null;
  if (!stillCurrent() || (suggestions.length > 1 && !picked)) return;
  const suggested = picked?.item ?? suggestions[0];
  const path = await vscode.window.showInputBox({ title: 'Retained evidence path (repository-relative)', ignoreFocusOut: true,
    value: suggested?.path,
    prompt: 'Use the exact screenshot/inspection path returned by recovery. The file will be preserved.',
    validateInput: value => value.trim() && !/[\\\x00-\x1f\x7f]/u.test(value) ? null : 'Use a repository-relative portable path.' });
  if (!path || !stillCurrent()) return;
  const chosenClause = suggested?.clauses.length ? await vscode.window.showQuickPick(suggested.clauses,
    { title: 'Choose the exact approved acceptance criterion for this evidence', ignoreFocusOut: true }) : null;
  if (!stillCurrent() || (suggested?.clauses.length && !chosenClause)) return;
  const clause = chosenClause ?? await vscode.window.showInputBox({ title: 'Exact approved acceptance criterion', ignoreFocusOut: true,
    prompt: 'For example A-HEX:AC-005. The engine verifies the pinned owner and authority.',
    validateInput: value => /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/u.test(value) ? null : 'Use the exact qualified AC identity.' });
  if (!clause || !stillCurrent()) return;
  const method = await vscode.window.showQuickPick(['visual', 'inspection'], { title: 'Primary evidence method', ignoreFocusOut: true });
  if (!method || !stillCurrent()) return;
  const reason = await vscode.window.showInputBox({ title: 'Why does this approved evidence contract need correction?', ignoreFocusOut: true,
    validateInput: value => value.trim().length >= 20 && value.trim().length <= 1000 && !/[\x00-\x1f\x7f]/u.test(value)
      ? null : 'Give a reason of 20–1000 ordinary characters.' });
  if (reason === undefined || !stillCurrent()) return;
  const selectors = ['--work-id', workId, '--phase', phaseId, '--clause', clause, '--path', path.trim(), '--method', method, '--reason', reason.trim()];
  const preview = await client.run<{ data?: { packet?: { workId?: string; phaseId?: string; packetSha256?: string } } }>(
    ['appeal', 'evidence-prepare', ...selectors, '--json']);
  const packet = preview.data?.packet;
  if (!stillCurrent() || packet?.workId !== workId || packet.phaseId !== phaseId
      || !/^sha256:[a-f0-9]{64}$/u.test(packet.packetSha256 ?? '')) return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Review evidence correction in your browser', cancellable: true },
    async (_progress, cancellation) => {
      const controller = new AbortController();
      const subscription = cancellation.onCancellationRequested(() => controller.abort());
      try {
        if (cancellation.isCancellationRequested || !stillCurrent()) return;
        const result = await client.run<{ data?: { stateChanged?: boolean; status?: string } }>(
          ['appeal', 'evidence-accept', ...selectors, '--confirm', packet.packetSha256!, '--review-ui', '--json'], controller.signal);
        if (!stillCurrent()) return;
        await vscode.window.showInformationMessage(result.data?.stateChanged === true
          ? 'Evidence classification corrected. Draft and prior approvals preserved; tests, visual proof and phase approval remain required.'
          : 'Review cancelled or expired. No evidence correction was recorded.');
      } finally { subscription.dispose(); }
    });
}

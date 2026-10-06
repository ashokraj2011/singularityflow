/** Native confirmations stay small; the captured full review opens separately on demand. */
import * as vscode from 'vscode';
import { compactMessagePresentation } from './compact-message-presentation.ts';

type Item = string | vscode.MessageItem;
type CompactMessageOptions = vscode.MessageOptions & { compactDetail?: string };
type NativeMessage = (message: string, options: vscode.MessageOptions, ...items: Item[]) => Thenable<Item | undefined>;

async function compactMessage(kind: 'warning' | 'information', message: string,
  args: Array<Item | CompactMessageOptions>): Promise<Item | undefined> {
  const first = args[0];
  const hasOptions = first != null && typeof first === 'object' && !('title' in first);
  const { compactDetail, ...options } = hasOptions ? { ...first as CompactMessageOptions } : {};
  const items = (hasOptions ? args.slice(1) : args) as Item[];
  const show = (kind === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage).bind(vscode.window) as NativeMessage;
  if (!options.modal) return show(message, options, ...items);
  const presentation = compactMessagePresentation(message, options.detail, compactDetail);
  if (!presentation.fullText) return show(message, options, ...items);
  // Preserve the native overload and caller action identities. A unique string (or object identity)
  // prevents the review button from being confused with an existing action named "View details".
  let label = 'View details';
  while (items.some(item => (typeof item === 'string' ? item : item.title) === label)) label += '…';
  const viewDetails: Item = typeof items[0] === 'object' ? { title: label } : label;
  for (;;) {
    const choice = await show(presentation.message, { ...options, detail: presentation.detail }, ...items, viewDetails);
    if (choice !== viewDetails) return choice;
    try {
      const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: presentation.fullText });
      await vscode.window.showTextDocument(document, { preview: true });
    } catch {
      // A failed preview must not fall through to consent or hide the fact that review failed.
      await vscode.window.showErrorMessage('Could not open the complete review. The action was cancelled; nothing was confirmed.');
      return undefined;
    }
    // Do not immediately reopen a modal over the document: people must be able to scroll and
    // inspect it. This notification is not consent; it only returns to the exact confirmation.
    const continueReview = await vscode.window.showInformationMessage(
      'Review the complete details in the editor, then return to the confirmation.', 'Continue review');
    if (continueReview !== 'Continue review') return undefined;
  }
}

export function showCompactWarningMessage<T extends string>(message: string, ...items: T[]): Promise<T | undefined>;
export function showCompactWarningMessage<T extends string>(message: string, options: CompactMessageOptions, ...items: T[]): Promise<T | undefined>;
export function showCompactWarningMessage<T extends vscode.MessageItem>(message: string, ...items: T[]): Promise<T | undefined>;
export function showCompactWarningMessage<T extends vscode.MessageItem>(message: string, options: CompactMessageOptions, ...items: T[]): Promise<T | undefined>;
export function showCompactWarningMessage(message: string, ...args: Array<Item | CompactMessageOptions>): Promise<Item | undefined> {
  return compactMessage('warning', message, args);
}

export function showCompactInformationMessage<T extends string>(message: string, ...items: T[]): Promise<T | undefined>;
export function showCompactInformationMessage<T extends string>(message: string, options: CompactMessageOptions, ...items: T[]): Promise<T | undefined>;
export function showCompactInformationMessage<T extends vscode.MessageItem>(message: string, ...items: T[]): Promise<T | undefined>;
export function showCompactInformationMessage<T extends vscode.MessageItem>(message: string, options: CompactMessageOptions, ...items: T[]): Promise<T | undefined>;
export function showCompactInformationMessage(message: string, ...args: Array<Item | CompactMessageOptions>): Promise<Item | undefined> {
  return compactMessage('information', message, args);
}

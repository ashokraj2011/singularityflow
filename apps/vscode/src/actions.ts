/**
 * Running a governed action from the editor.
 *
 * The rule this file exists to keep: the extension surfaces the CLI's guards, it never routes around
 * them. An approval from here must be exactly as hard as an approval from a terminal — the same
 * exact-hash confirmation, the same self-approval acknowledgement — because the governance property
 * belongs to the capability, not to whichever frontend happens to be calling it.
 *
 * So `--confirm` is filled from a human typing the expected string into an input box, not from the
 * extension knowing what the expected string is. Knowing it and passing it silently would turn a
 * deliberate act into a click, which is precisely the failure the exact confirmation was designed to
 * prevent. The B5 escapes exist so a GUI *can* answer these prompts, not so it can skip them.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from './cli/client.ts';
import { CliError } from './cli/runner.ts';

/** Arguments that must be answered by a human before the command is allowed to run. */
export interface Confirmation {
  /** The exact string the CLI will demand, e.g. "discover-define:business-case". */
  expected: string;
  /** What is being approved, in the reviewer's terms. */
  summary: string;
}

/** An approval, which goes through a selection receipt rather than through plain flags. */
export interface ApprovalRequest {
  initiativeId: string;
  /** "business-case", "phase", "pack:opportunity-investment-brief". */
  subject: string;
  expected: string;
  summary: string;
}

interface ChoiceOption { id: string; label?: string; description?: string }
interface ReceiptChoiceSet { id: string; label: string; options: ChoiceOption[] }
interface Receipt { token: string; choiceSets: ReceiptChoiceSet[] }

export interface ActionRequest {
  /** argv for the CLI, without the binary name. */
  command: string[];
  title: string;
  confirmation?: Confirmation;
}

/**
 * Ask for the exact confirmation string.
 *
 * Pre-filling it would defeat the purpose, so the box starts empty and validates as you type. The
 * expected value is shown in the prompt: the point is deliberateness, not recall.
 */
async function askConfirmation(confirmation: Confirmation): Promise<string | null> {
  const typed = await vscode.window.showInputBox({
    title: confirmation.summary,
    prompt: `Type ${confirmation.expected} to confirm. This approves the exact current hash.`,
    placeHolder: confirmation.expected,
    ignoreFocusOut: true,
    validateInput: (value) => (value && value !== confirmation.expected
      ? `Type exactly: ${confirmation.expected}`
      : null)
  });
  return typed === confirmation.expected ? typed : null;
}

/**
 * Self-approval is allowed by the engine but must be said out loud.
 *
 * Asked as a modal, because the whole reason the flag exists is that a warning nobody reads is not a
 * safeguard. Returns whether to add `--acknowledge-self-approval`.
 */
async function askSelfApproval(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'This is a self-approval and is not independent review.',
    { modal: true, detail: 'You generated one or more of the artifacts you are approving. The approval will record that it was not independent.' },
    'Approve anyway'
  );
  return choice === 'Approve anyway';
}

/** Whether the CLI refused because the actor generated what they are approving. */
function isSelfApprovalRefusal(error: unknown): boolean {
  return error instanceof CliError && /--acknowledge-self-approval/.test(error.message);
}

/**
 * Run one governed action, answering only what a human has actually answered.
 *
 * Returns true when the command ran to completion, so the caller knows whether to refresh. A
 * cancelled confirmation is not an error — it is a person deciding not to approve — and is reported
 * as such rather than as a failure.
 */
export async function runGovernedAction(
  client: SingularityFlowClient,
  request: ActionRequest,
  output: vscode.OutputChannel
): Promise<boolean> {
  const args = [...request.command];

  if (request.confirmation) {
    const confirmed = await askConfirmation(request.confirmation);
    if (!confirmed) {
      void vscode.window.setStatusBarMessage('$(circle-slash) Not confirmed; nothing was approved.', 4_000);
      return false;
    }
    args.push('--confirm', confirmed);
  }

  const run = async (argv: string[]): Promise<boolean> => {
    output.appendLine(`\n$ singularity-flow ${argv.join(' ')}`);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: request.title, cancellable: false },
      () => client.runText(argv)
    );
    return true;
  };

  try {
    return await run(args);
  } catch (error) {
    // The engine refuses a self-approval rather than silently recording one. Ask, then retry with the
    // acknowledgement — the second attempt is a different, explicitly weaker act, and says so.
    if (isSelfApprovalRefusal(error)) {
      if (!(await askSelfApproval())) {
        void vscode.window.setStatusBarMessage('$(circle-slash) Self-approval declined.', 4_000);
        return false;
      }
      try {
        return await run([...args, '--acknowledge-self-approval']);
      } catch (retryError) {
        void vscode.window.showErrorMessage((retryError as Error).message);
        return false;
      }
    }
    // The CLI's own message names the remedy; rewording it here would lose that.
    output.appendLine(`  failed: ${(error as Error).message}`);
    void vscode.window.showErrorMessage((error as Error).message);
    return false;
  }
}

/**
 * Approve through a selection receipt.
 *
 * Approvals do not take `--confirm`, and that is deliberate: a receipt is bound to the repository
 * HEAD, to the Copilot session, and to the exact artifact hashes being approved, which `--confirm`
 * is not. Approval is precisely where that binding is worth the extra round trip — it is what makes
 * "I approved this" mean a specific set of bytes rather than a subject name.
 *
 * It also solves a problem plain flags cannot: `initiative approve` selects a working lens, and
 * there is no `--persona` on that path. The receipt is where the lens answer lives.
 */
export async function approveWithReceipt(
  client: SingularityFlowClient,
  request: ApprovalRequest,
  output: vscode.OutputChannel
): Promise<boolean> {
  let receipt: Receipt;
  try {
    receipt = await client.run<Receipt>([
      'initiative', 'choices', 'begin', 'approve', request.initiativeId, request.subject, '--json'
    ]);
  } catch (error) {
    void vscode.window.showErrorMessage((error as Error).message);
    return false;
  }

  const personas = receipt.choiceSets.find((set) => set.id === 'persona')?.options ?? [];
  if (personas.length) {
    const picked = await vscode.window.showQuickPick(
      personas.map((option) => ({
        label: option.label ?? option.id,
        description: option.description ?? '',
        id: option.id
      })),
      { title: 'Working lens', placeHolder: 'The lens this decision is recorded under', ignoreFocusOut: true }
    );
    if (!picked) return false;
    try {
      await client.run(['initiative', 'choices', 'answer', receipt.token, 'persona', picked.id, '--json']);
    } catch (error) {
      void vscode.window.showErrorMessage((error as Error).message);
      return false;
    }
  }

  const confirmed = await askConfirmation({ expected: request.expected, summary: request.summary });
  if (!confirmed) {
    void vscode.window.setStatusBarMessage('$(circle-slash) Not confirmed; nothing was approved.', 4_000);
    return false;
  }

  try {
    await client.run(['initiative', 'choices', 'answer', receipt.token, 'decision-confirmation', confirmed, '--json']);
  } catch (error) {
    void vscode.window.showErrorMessage((error as Error).message);
    return false;
  }

  const argv = ['initiative', 'approve', request.subject, '--selection-receipt', receipt.token];
  const run = async (extra: string[] = []): Promise<boolean> => {
    output.appendLine(`\n$ singularity-flow ${[...argv, ...extra].join(' ')}`);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: request.summary, cancellable: false },
      () => client.runText([...argv, ...extra])
    );
    return true;
  };

  try {
    return await run();
  } catch (error) {
    if (isSelfApprovalRefusal(error)) {
      if (!(await askSelfApproval())) {
        void vscode.window.setStatusBarMessage('$(circle-slash) Self-approval declined.', 4_000);
        return false;
      }
      try {
        return await run(['--acknowledge-self-approval']);
      } catch (retryError) {
        void vscode.window.showErrorMessage((retryError as Error).message);
        return false;
      }
    }
    output.appendLine(`  failed: ${(error as Error).message}`);
    void vscode.window.showErrorMessage((error as Error).message);
    return false;
  }
}

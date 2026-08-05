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
import { commandPlaceholders, fillPlaceholders, placeholderPrompt } from './commands.ts';

/** Arguments that must be answered by a human before the command is allowed to run. */
export interface Confirmation {
  /** The exact string the CLI will demand, e.g. "discover-define:business-case". */
  expected: string;
  /** What is being approved, in the reviewer's terms. */
  summary: string;
}

/** An approval, which goes through a selection receipt rather than through plain flags. */
export type ApprovalRequest =
  | {
    kind: 'initiative';
    initiativeId: string;
    /** "business-case", "phase", "pack:opportunity-investment-brief". */
    subject: string;
    expected: string;
    summary: string;
  }
  | {
    kind: 'story';
    workId: string;
    phaseId: string;
    expected: string;
    summary: string;
  };

interface ChoiceOption { id: string; label?: string; description?: string }
interface ReceiptChoiceSet { id: string; label: string; options: ChoiceOption[] }
interface Receipt { token: string; choiceSets: ReceiptChoiceSet[] }

interface PlannedAction {
  actionId: string;
  order: number;
  timing: string;
  intent: string;
  skill: string | null;
  command: string;
  reason: string;
  executable: boolean;
  effect: { class: string; mutatesState: boolean; externalSideEffect: boolean; reversible: boolean };
  confirmation: { required: boolean; mode: 'none' | 'one-time-authorization' };
}

interface GovernedActionPlan {
  planId: string;
  planHash: string;
  createdAt: string;
  expiresAt: string;
  revision: {
    branch: string;
    head: string;
    worktreeHash: string;
    lifecycleSha256: string;
    workingTree?: { headTree: string; indexTree: string; workingTree: string; sha256: string };
  };
  actions: PlannedAction[];
}

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

function softSequenceGate(error: unknown): string | null {
  if (!(error instanceof CliError) || !/Soft gate confirmation requires an interactive terminal/.test(error.message)) return null;
  return error.message.match(/Soft sequence warning \[([^\]]+)\]/)?.[1] ?? null;
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
    const gate = softSequenceGate(error);
    if (gate) {
      const expected = `continue:${gate}`;
      const confirmed = await askConfirmation({
        expected,
        summary: `Continue through soft sequence gate '${gate}'`
      });
      if (!confirmed) {
        void vscode.window.setStatusBarMessage('$(circle-slash) Sequence override declined; nothing changed.', 4_000);
        return false;
      }
      try { return await run([...args, '--confirm-override', confirmed]); }
      catch (retryError) {
        void vscode.window.showErrorMessage((retryError as Error).message);
        return false;
      }
    }
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
 * Review and execute one engine-produced action plan.
 *
 * The extension never rebuilds the next action from its own tree. The CLI binds the plan to the
 * exact branch, HEAD, worktree, and lifecycle snapshot; `action execute` verifies all four again.
 * That makes this picker a review surface for a capability owned by the engine, rather than a
 * second workflow implementation hidden in the editor.
 */
export async function runPlannedAction(
  client: SingularityFlowClient,
  output: vscode.OutputChannel
): Promise<boolean> {
  let plan: GovernedActionPlan;
  try {
    plan = await client.run<GovernedActionPlan>(['action', 'plan', '--json']);
  } catch (error) {
    void vscode.window.showErrorMessage((error as Error).message);
    return false;
  }

  const executable = plan.actions.filter((action) => action.executable);
  if (!executable.length) {
    const waiting = plan.actions.map((action) => `${action.order}. ${action.reason}`).join('\n');
    void vscode.window.showInformationMessage(
      waiting ? `No governed action is executable yet. ${waiting}` : 'The workflow has no next action.'
    );
    return false;
  }

  const choice = await vscode.window.showQuickPick(executable.map((action) => ({
    label: action.reason,
    description: action.command,
    detail: `Plan ${plan.planId} · action ${action.actionId} · expires ${plan.expiresAt}`,
    action
  })), {
    title: 'Continue governed work',
    placeHolder: 'Choose one action from the exact current lifecycle plan',
    ignoreFocusOut: true
  });
  if (!choice) return false;

  const confirmed = await vscode.window.showWarningMessage(
    `Run the exact governed action “${choice.action.reason}”?`,
    {
      modal: true,
      detail: `${choice.action.command}\n\nPlan ${plan.planId} is bound to ${plan.revision.branch}@${plan.revision.head.slice(0, 12)}. Any repository or lifecycle change invalidates it.`
    },
    'Run exact action'
  );
  if (confirmed !== 'Run exact action') return false;

  const argv = ['action', 'execute', plan.planId, '--action', choice.action.actionId];
  if (choice.action.confirmation.required) {
    let authorization: { token: string };
    try {
      authorization = await client.run<{ token: string }>([
        'action', 'authorize', plan.planId,
        '--action', choice.action.actionId,
        '--confirm', choice.action.actionId,
        '--channel', 'vscode',
        '--json'
      ]);
    } catch (error) {
      output.appendLine(`  authorization refused: ${(error as Error).message}`);
      void vscode.window.showErrorMessage((error as Error).message);
      return false;
    }
    argv.push('--authorization', authorization.token);
  }
  output.appendLine(`\n$ singularity-flow ${argv.join(' ')}`);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: choice.action.reason, cancellable: false },
      () => client.runText(argv)
    );
    return true;
  } catch (error) {
    output.appendLine(`  refused: ${(error as Error).message}`);
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
 * The phase contract selects the governed agent automatically. The receipt binds only the human's
 * exact decision to the current hashes; agent context is not approval authority.
 */
export async function approveWithReceipt(
  client: SingularityFlowClient,
  request: ApprovalRequest,
  output: vscode.OutputChannel
): Promise<boolean> {
  let receipt: Receipt;
  try {
    receipt = await client.run<Receipt>(request.kind === 'story'
      ? ['choices', 'begin', 'approve', request.workId, '--fetch', '--json']
      : ['initiative', 'choices', 'begin', 'approve', request.initiativeId, request.subject, '--json']);
  } catch (error) {
    void vscode.window.showErrorMessage((error as Error).message);
    return false;
  }

  const confirmed = await askConfirmation({ expected: request.expected, summary: request.summary });
  if (!confirmed) {
    void vscode.window.setStatusBarMessage('$(circle-slash) Not confirmed; nothing was approved.', 4_000);
    return false;
  }

  try {
    await client.run(request.kind === 'story'
      ? ['choices', 'answer', receipt.token, 'phase-confirmation', confirmed, '--json']
      : ['initiative', 'choices', 'answer', receipt.token, 'decision-confirmation', confirmed, '--json']);
  } catch (error) {
    void vscode.window.showErrorMessage((error as Error).message);
    return false;
  }

  const argv = request.kind === 'story'
    ? ['approve', request.workId, '--fetch', '--phase', request.phaseId, '--selection-receipt', receipt.token]
    : ['initiative', 'approve', request.subject, '--selection-receipt', receipt.token];
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

/**
 * Fill a suggested command's placeholders by asking, rather than running them literally.
 *
 * `<PATH>` is an instruction to a person. Passing it through as an argument produces a failure about
 * a file of that name, which tells the reader nothing about what was actually wanted. A path
 * placeholder opens a file picker — which is the one thing an editor does better than a terminal
 * here — and anything else asks for text.
 *
 * @returns the completed argv, or null if the person declined to answer.
 */
export async function resolvePlaceholders(argv: string[], repository: string): Promise<string[] | null> {
  const placeholders = commandPlaceholders(argv);
  if (!placeholders.length) return argv;

  const answers = new Map<number, string>();
  for (const placeholder of placeholders) {
    if (placeholder.kind === 'file') {
      const picked = await vscode.window.showOpenDialog({
        title: placeholderPrompt(placeholder),
        openLabel: 'Use this file',
        canSelectMany: false,
        defaultUri: vscode.Uri.file(repository)
      });
      if (!picked?.length || !picked[0]) return null;
      answers.set(placeholder.index, picked[0].fsPath);
      continue;
    }
    const typed = await vscode.window.showInputBox({
      title: placeholderPrompt(placeholder),
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? null : 'This is required.')
    });
    if (typed === undefined) return null;
    answers.set(placeholder.index, typed.trim());
  }
  return fillPlaceholders(argv, answers);
}

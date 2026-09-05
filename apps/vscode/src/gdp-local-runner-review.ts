/** Native operator journey for non-gating developer-local signed evidence. */
import path from 'node:path';
import * as vscode from 'vscode';

import type { SingularityFlowClient } from './cli/client.ts';
import {
  LOCAL_RUNNER_IDENTIFIER, LOCAL_RUNNER_SIGNER,
  localRunnerOptionsArguments, localRunnerPlanArguments, localRunnerPlanReview,
  localRunnerRunArguments, localRunnerSignerArguments, localRunnerVerifyArguments,
  type LocalRunnerCommandOption, type LocalRunnerOptions, type LocalRunnerPlan
} from './gdp-local-runner-review-model.ts';

function resultOf<T>(value: unknown): T {
  return ((value as { data?: T })?.data ?? value) as T;
}

async function identifier(title: string, prompt: string, value: string, signer = false): Promise<string | null> {
  const pattern = signer ? LOCAL_RUNNER_SIGNER : LOCAL_RUNNER_IDENTIFIER;
  const selected = await vscode.window.showInputBox({
    title, prompt, value, ignoreFocusOut: true,
    validateInput: (candidate) => pattern.test(candidate.trim()) ? null
      : signer
        ? 'Use a lower-case portable signer ID.'
        : 'Use a portable identifier.'
  });
  return selected === undefined ? null : selected.trim();
}

function relativeRepositoryPath(repository: string, uri: vscode.Uri): string | null {
  const relative = path.relative(repository, uri.fsPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

async function signerReady(client: SingularityFlowClient, signerId: string): Promise<boolean> {
  try {
    await client.run(localRunnerSignerArguments('status', signerId));
    return true;
  } catch {
    const decision = await vscode.window.showWarningMessage(
      `Developer-local signer '${signerId}' is unavailable. Create it now?`,
      {
        modal: true,
        detail: 'The private key stays in this repository\'s Git-common private storage. This is same-user, non-gating evidence—not enterprise authority.'
      },
      'Create local signer'
    );
    if (decision !== 'Create local signer') return false;
    await client.run(localRunnerSignerArguments('create', signerId));
    return true;
  }
}

async function runObservedCommand(client: SingularityFlowClient): Promise<void> {
  const repository = path.resolve(client.repository);
  const workId = await identifier(
    'Local evidence runner · Story',
    'The engine will derive the exact Candidate and Proof Subject for this Story.',
    ''
  );
  if (!workId) return;
  const options = resultOf<LocalRunnerOptions>(await client.run(localRunnerOptionsArguments(workId)));
  if (options.kind !== 'gdp-local-runner-options' || options.gateEligible !== false
      || options.consumedByLifecycle !== false) {
    throw new Error('The engine returned an invalid local-runner options projection.');
  }
  if (options.identity?.status !== 'ready') {
    await vscode.window.showErrorMessage(
      `Story '${workId}' has no exact Candidate and Proof Subject. Nothing ran. ${options.gaps.join(', ')}`
    );
    return;
  }
  if (!options.commands.length) {
    await vscode.window.showErrorMessage(
      'No shell-free, modelPolicy: never quality command is configured for this repository.'
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(options.commands.map((command) => ({
    label: `${command.phaseId} · ${command.commandId}`,
    description: `${command.kind} · ${Math.ceil(command.timeoutMs / 1000)}s ceiling`,
    detail: `Configured requirement: ${command.requirement}; model policy: never`,
    command
  })), {
    title: 'Local evidence runner · Approved command',
    placeHolder: 'Only engine-projected eligible commands are shown',
    ignoreFocusOut: true
  });
  if (!picked) return;
  const signerId = await identifier(
    'Local evidence runner · Signer',
    'A repository-local developer key; never independent approval authority.',
    options.defaultSigner,
    true
  );
  if (!signerId || !await signerReady(client, signerId)) return;
  if (path.resolve(client.repository) !== repository) {
    await vscode.window.showErrorMessage('The selected repository changed. Nothing ran.');
    return;
  }
  const envelope = resultOf<{ plan: LocalRunnerPlan }>(await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Preparing exact local-runner plan', cancellable: false
  }, () => client.run(localRunnerPlanArguments(options, picked.command, signerId))));
  const plan = envelope.plan;
  const detail = localRunnerPlanReview(plan);
  const accepted = await vscode.window.showWarningMessage(
    'Run this configured command as your local OS user?',
    { modal: true, detail },
    'Run and sign local observation'
  );
  if (accepted !== 'Run and sign local observation') return;
  if (path.resolve(client.repository) !== repository) {
    await vscode.window.showErrorMessage('The selected repository changed. Nothing ran.');
    return;
  }
  const result = resultOf<{
    output?: { path?: string }; attestation?: { outcome?: string };
  }>(await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Running ${picked.command.commandId}`, cancellable: false
  }, () => client.run(localRunnerRunArguments(
    options, picked.command, signerId, plan.planSha256
  ))));
  const receipt = result?.output?.path;
  const choice = await vscode.window.showInformationMessage(
    `Local signed observation: ${result?.attestation?.outcome ?? 'completed'}. It is non-gating developer evidence.`,
    ...(receipt ? ['Open signed receipt'] : [])
  );
  if (choice === 'Open signed receipt' && receipt) {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(repository, ...receipt.split('/'))));
  }
}

async function manageSigner(client: SingularityFlowClient): Promise<void> {
  const signerId = await identifier(
    'Local evidence runner · Signer',
    'Create or inspect a repository-local developer signer.',
    'developer-local', true
  );
  if (!signerId) return;
  try {
    const status = resultOf<{ status?: string; signerKeySha256?: string }>(
      await client.run(localRunnerSignerArguments('status', signerId))
    );
    await vscode.window.showInformationMessage(
      `Signer '${signerId}' is ${status.status ?? 'ready'} (${status.signerKeySha256 ?? 'key available'}). Non-gating.`
    );
  } catch {
    await signerReady(client, signerId);
  }
}

async function verifyReceipt(client: SingularityFlowClient): Promise<void> {
  const repository = path.resolve(client.repository);
  const selected = await vscode.window.showOpenDialog({
    title: 'Verify developer-local signed receipt',
    defaultUri: vscode.Uri.file(path.join(repository, 'singularity', 'work-items')),
    canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
    filters: { JSON: ['json'] }, openLabel: 'Verify exact receipt'
  });
  if (!selected?.[0]) return;
  const relative = relativeRepositoryPath(repository, selected[0]);
  if (!relative) {
    await vscode.window.showErrorMessage('The receipt must be a regular file inside the selected repository.');
    return;
  }
  const signerId = await identifier(
    'Local evidence runner · Signer',
    'The signer must match the repository-local key that issued this receipt.',
    'developer-local', true
  );
  if (!signerId) return;
  const verified = resultOf<{
    status?: string; outcome?: string; assurance?: string; gateEligible?: boolean;
  }>(await client.run(localRunnerVerifyArguments(relative, signerId)));
  await vscode.window.showInformationMessage(
    `Receipt ${verified.status ?? 'verified'}: ${verified.outcome ?? 'unknown'} · ${verified.assurance ?? 'developer-local-signed'} · gate eligible: ${verified.gateEligible === true ? 'yes' : 'no'}.`
  );
}

export async function showGdpLocalRunnerReview(client: SingularityFlowClient): Promise<void> {
  const selected = await vscode.window.showQuickPick([
    { label: 'Run configured quality command', description: 'Plan, review, execute, and sign one local observation', action: 'run' as const },
    { label: 'Create or inspect local signer', description: 'Repository-local same-user key', action: 'signer' as const },
    { label: 'Verify signed receipt', description: 'Check exact bytes against this repository-local signer', action: 'verify' as const }
  ], {
    title: 'Developer-local signed runner',
    placeHolder: 'Local tamper evidence only; never independent approval or a lifecycle gate',
    ignoreFocusOut: true
  });
  if (!selected) return;
  try {
    if (selected.action === 'run') await runObservedCommand(client);
    else if (selected.action === 'signer') await manageSigner(client);
    else await verifyReceipt(client);
  } catch (error) {
    await vscode.window.showErrorMessage(
      `Developer-local runner did not proceed: ${(error as Error).message}`
    );
  }
}

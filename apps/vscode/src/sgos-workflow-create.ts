/** Native, storyless SGOS Workflow authoring wizard. */
import path from 'node:path';
import * as vscode from 'vscode';

import type { SingularityFlowClient } from './cli/client.ts';
import {
  SGOS_LOWER_KEBAB, SGOS_SHA256, sgosWorkflowCreateArguments,
  sgosRatificationPreviewArguments, sgosTerminalCommand, sgosWorkflowCreateReview,
  sgosWorkflowOutputPaths, sgosWorkspaceBindingIssue, validSgosDraftPath,
  type SgosWorkflowCreateSelection
} from './sgos-workflow-create-model.ts';

type GuideOperation = {
  readonly id: string;
  readonly version?: string;
  readonly opcode?: string | null;
  readonly manifestSha256?: string;
  readonly guidedEligible?: boolean;
  readonly guidedRole?: 'operation' | 'verifier' | null;
  readonly verificationOperationIds?: readonly string[];
};

type WorkflowGuide = {
  readonly operations?: readonly GuideOperation[];
  readonly eligibleOperations?: readonly GuideOperation[];
  readonly eligibleVerificationOperations?: readonly GuideOperation[];
  readonly blockers?: readonly { code?: string; message?: string; clauseIds?: readonly string[] }[];
  readonly unresolvedRequiredClauses?: readonly { clauseId?: string; field?: string }[];
  readonly installedLimits?: { readonly maximumAttemptsPerTask?: number };
};

function resultOf<T>(value: unknown): T {
  return ((value as { data?: { result?: T } })?.data?.result ?? value) as T;
}

function relativeRepositoryPath(repository: string, uri: vscode.Uri): string | null {
  const relative = path.relative(repository, uri.fsPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

async function browseJson(repository: string, title: string): Promise<string | null> {
  const picked = await vscode.window.showOpenDialog({
    title,
    defaultUri: vscode.Uri.file(repository),
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { JSON: ['json'] },
    openLabel: 'Use this reviewed file'
  });
  if (!picked?.[0]) return null;
  const relative = relativeRepositoryPath(repository, picked[0]);
  if (!relative) {
    await vscode.window.showErrorMessage(
      'SGOS authoring inputs must be inside the selected repository. Nothing was created.'
    );
  }
  return relative;
}

async function chooseJson(
  repository: string,
  title: string,
  namePattern: RegExp
): Promise<string | null> {
  const discovered = await vscode.workspace.findFiles(
    new vscode.RelativePattern(repository, '**/*.json'),
    new vscode.RelativePattern(repository, '**/{.git,node_modules,.singularity-flow}/**'),
    200
  );
  const candidates = discovered
    .map((uri) => ({ uri, relative: relativeRepositoryPath(repository, uri) }))
    .filter((entry): entry is { uri: vscode.Uri; relative: string } =>
      entry.relative != null && namePattern.test(path.posix.basename(entry.relative)))
    .sort((left, right) => left.relative.localeCompare(right.relative));
  const browse = { label: '$(folder-opened) Browse inside repository…', relative: null as string | null };
  const selected = await vscode.window.showQuickPick([
    ...candidates.map((entry) => ({
      label: entry.relative,
      description: 'Repository JSON',
      relative: entry.relative
    })),
    browse
  ], {
    title,
    placeHolder: 'Choose the exact reviewed input; nothing is inferred from chat history',
    ignoreFocusOut: true
  });
  if (!selected) return null;
  return selected.relative ?? browseJson(repository, title);
}

function operationChoices(guide: WorkflowGuide): GuideOperation[] {
  const declared = guide.eligibleOperations ?? guide.operations ?? [];
  const unique = new Map<string, GuideOperation>();
  for (const operation of declared) {
    if (operation && typeof operation.id === 'string'
        && operation.guidedEligible !== false && operation.guidedRole !== 'verifier') {
      unique.set(operation.id, operation);
    }
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function chooseOperation(
  operations: readonly GuideOperation[], title: string, placeholder: string
): Promise<string | null> {
  const picked = await vscode.window.showQuickPick(operations.map((operation) => ({
    label: operation.id,
    description: [operation.version ? `v${operation.version}` : null, operation.opcode]
      .filter(Boolean).join(' · '),
    detail: operation.manifestSha256,
    id: operation.id
  })), { title, placeHolder: placeholder, ignoreFocusOut: true });
  return picked?.id ?? null;
}

async function currentRepositoryIssue(
  client: SingularityFlowClient, repository: string
): Promise<string | null> {
  try {
    const current = await client.run<{
      active?: boolean; repositoryPath?: string; repositoryState?: string;
      selectionStatus?: string;
    }>(['workspace', 'current', '--json']);
    if (path.resolve(client.repository) !== path.resolve(repository)) {
      return 'The extension changed repositories while the creator was open.';
    }
    return sgosWorkspaceBindingIssue(current, repository);
  } catch (error) {
    return `The active workspace could not be verified: ${(error as Error).message}`;
  }
}

/**
 * Collect explicit choices and create only a declaration plus unratified Workflow Candidate.
 * The engine revalidates every value and is the only writer.
 */
export async function showSgosWorkflowCreator(client: SingularityFlowClient): Promise<void> {
  const repository = path.resolve(client.repository);
  const initialBindingIssue = await currentRepositoryIssue(client, repository);
  if (initialBindingIssue) {
    await vscode.window.showErrorMessage(
      `${initialBindingIssue} Nothing was created. Refresh Workspaces and try again.`
    );
    return;
  }
  const intentPath = await chooseJson(repository, 'SGOS Workflow · Intent IR', /intent(?:-ir)?\.json$/i);
  if (!intentPath) return;
  const policyPath = await chooseJson(repository, 'SGOS Workflow · Policy snapshot', /policy(?:-snapshot)?\.json$/i);
  if (!policyPath) return;
  const registryPath = await chooseJson(repository, 'SGOS Workflow · Registry snapshot', /registry(?:-snapshot)?\.json$/i);
  if (!registryPath) return;

  let guide: WorkflowGuide;
  try {
    guide = resultOf<WorkflowGuide>(await client.run([
      'intent', 'workflow-guide', intentPath, '--registry', registryPath, '--json'
    ]));
  } catch (error) {
    await vscode.window.showErrorMessage(
      `Could not load the deterministic SGOS Workflow guide: ${(error as Error).message}`
    );
    return;
  }
  const blockers = guide.blockers ?? [];
  if (blockers.length || (guide.unresolvedRequiredClauses?.length ?? 0) > 0) {
    const reasons = blockers.map((entry) => entry.message ?? entry.code)
      .filter(Boolean);
    const unresolved = (guide.unresolvedRequiredClauses ?? [])
      .map((entry) => `${entry.clauseId ?? 'unknown clause'} (${entry.field ?? 'unknown'})`);
    await vscode.window.showErrorMessage(
      `The confirmed Intent is not safe for the bounded creator. ${[...reasons, ...unresolved].join('; ')}`
    );
    return;
  }
  const operations = operationChoices(guide);
  if (!operations.length) {
    await vscode.window.showErrorMessage(
      'The pinned registry has no active core operation eligible for the bounded creator. Nothing was created.'
    );
    return;
  }
  const operation = await chooseOperation(
    operations, 'SGOS Workflow · Governed operation',
    'Choose the registered operation that performs the confirmed intent'
  );
  if (!operation) return;
  const chosenOperation = operations.find((entry) => entry.id === operation);
  const allowedVerifierIds = new Set(chosenOperation?.verificationOperationIds ?? []);
  const verifierChoices = (guide.eligibleVerificationOperations ?? guide.operations ?? [])
    .filter((entry) => entry.guidedEligible !== false && entry.guidedRole !== 'operation')
    .filter((entry) => !allowedVerifierIds.size || allowedVerifierIds.has(entry.id))
    .filter((entry) => entry.id !== operation);
  if (!verifierChoices.length) {
    await vscode.window.showErrorMessage(
      `The pinned registry has no compatible independent verifier for '${operation}'. Nothing was created.`
    );
    return;
  }
  const verificationOperation = await chooseOperation(
    verifierChoices, 'SGOS Workflow · Independent verifier',
    'Choose the registered operation that independently verifies the result'
  );
  if (!verificationOperation) return;

  const id = await vscode.window.showInputBox({
    title: 'SGOS Workflow · Stable ID',
    prompt: 'Use lower-case kebab case. This participates in content-addressed Workflow identity.',
    placeHolder: 'verified-migration-report',
    ignoreFocusOut: true,
    validateInput: (value) => SGOS_LOWER_KEBAB.test(value)
      ? null : 'Use lower-case kebab case, beginning with a letter.'
  });
  if (!id) return;
  const title = await vscode.window.showInputBox({
    title: 'SGOS Workflow · Display title',
    prompt: 'Optional human-readable title; leave blank to use the workflow ID.',
    value: id.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' '),
    ignoreFocusOut: true
  });
  if (title === undefined) return;
  const storageProfileSha256 = await vscode.window.showInputBox({
    title: 'SGOS Workflow · Storage profile',
    prompt: 'Paste the exact reviewed storage-profile digest. A policy-component digest is not substituted.',
    placeHolder: `sha256:${'0'.repeat(64)}`,
    ignoreFocusOut: true,
    validateInput: (value) => SGOS_SHA256.test(value)
      ? null : 'Enter sha256: followed by exactly 64 lower-case hexadecimal characters.'
  });
  if (!storageProfileSha256) return;
  const maximumAttemptsText = await vscode.window.showInputBox({
    title: 'SGOS Workflow · Retry ceiling',
    prompt: 'Maximum attempts for the one material operation. The engine enforces its lower installed ceiling.',
    value: '1',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const maximum = guide.installedLimits?.maximumAttemptsPerTask;
      if (!Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        return 'Enter a positive whole number.';
      }
      return maximum != null && Number(value) > maximum
        ? `This build permits at most ${maximum} attempts per task.` : null;
    }
  });
  if (!maximumAttemptsText) return;
  const outputRef = await vscode.window.showInputBox({
    title: 'SGOS Workflow · Governed output',
    prompt: 'Name the exact resource produced and independently verified.',
    value: 'artifact:result',
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? null : 'An output resource is required.'
  });
  if (!outputRef?.trim()) return;
  const outputs = sgosWorkflowOutputPaths(id);
  const declarationOut = await vscode.window.showInputBox({
    title: 'SGOS Workflow · Declaration file',
    prompt: 'Choose a new repository-relative JSON path in the non-authoritative SGOS draft area.',
    value: outputs.declarationOut,
    ignoreFocusOut: true,
    validateInput: (value) => validSgosDraftPath(value)
      ? null : 'Use a canonical JSON path below singularity/sgos-drafts/.'
  });
  if (!declarationOut) return;
  const workflowOut = await vscode.window.showInputBox({
    title: 'SGOS Workflow · Workflow IR file',
    prompt: 'Choose a different new repository-relative JSON path in the SGOS draft area.',
    value: outputs.workflowOut,
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!validSgosDraftPath(value)) {
        return 'Use a canonical JSON path below singularity/sgos-drafts/.';
      }
      return value.normalize('NFC').toLowerCase()
        === declarationOut.normalize('NFC').toLowerCase()
        ? 'The Workflow IR path must differ from the declaration path.' : null;
    }
  });
  if (!workflowOut) return;
  const selection: SgosWorkflowCreateSelection = {
    intentPath, policyPath, registryPath, id, title: title.trim(), operation,
    verificationOperation, storageProfileSha256, maximumAttempts: Number(maximumAttemptsText),
    outputRef: outputRef.trim(), declarationOut, workflowOut
  };
  const accepted = await vscode.window.showWarningMessage(
    `Create the unratified SGOS Workflow '${id}'?`,
    { modal: true, detail: sgosWorkflowCreateReview(selection) },
    'Create review files'
  );
  if (accepted !== 'Create review files') return;

  const finalBindingIssue = await currentRepositoryIssue(client, repository);
  if (finalBindingIssue) {
    await vscode.window.showErrorMessage(
      `${finalBindingIssue} Nothing was created; review the active workspace before retrying.`
    );
    return;
  }

  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Creating unratified SGOS Workflow ${id}`,
      cancellable: false
    }, () => client.run(sgosWorkflowCreateArguments(selection)));
    const declaration = vscode.Uri.file(path.join(repository, ...selection.declarationOut.split('/')));
    const workflow = vscode.Uri.file(path.join(repository, ...selection.workflowOut.split('/')));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(declaration), {
      preview: false, viewColumn: vscode.ViewColumn.One
    });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(workflow), {
      preview: false, viewColumn: vscode.ViewColumn.Beside
    });
    const action = await vscode.window.showInformationMessage(
      `Created ${selection.declarationOut} and ${selection.workflowOut}. The Workflow is not ratified or executable.`,
      'Copy ratification preview command', 'Open Command Center'
    );
    if (action === 'Copy ratification preview command') {
      const command = sgosTerminalCommand(
        sgosRatificationPreviewArguments(selection), repository,
        process.platform === 'win32' ? 'powershell' : 'posix',
        [client.location.executable, client.location.cli], true
      );
      await vscode.env.clipboard.writeText(command);
      await vscode.window.showInformationMessage(
        `Copied the model-free ratification preview command with its repository directory (${process.platform === 'win32' ? 'PowerShell' : 'POSIX shell'}). Review it before running.`
      );
    } else if (action === 'Open Command Center') {
      await vscode.commands.executeCommand('singularityFlow.openCommandCenter');
    }
  } catch (error) {
    await vscode.window.showErrorMessage(
      `The SGOS Workflow was not created: ${(error as Error).message}`
    );
  }
}

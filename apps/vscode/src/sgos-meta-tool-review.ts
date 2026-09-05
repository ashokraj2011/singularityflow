/** Native preview-and-confirm review form for governed Meta-tool authority transitions. */
import path from 'node:path';
import * as vscode from 'vscode';

import type { SingularityFlowClient } from './cli/client.ts';
import {
  META_TOOL_IDENTIFIER, META_TOOL_OUTCOMES, META_TOOL_SHA256, META_TOOL_TARGET_KINDS,
  metaToolArguments,
  metaToolPlanReview, type MetaToolMutationPlan, type MetaToolSelection
} from './sgos-meta-tool-review-model.ts';

type Action = MetaToolSelection['action'];

function resultOf<T>(value: unknown): T {
  return ((value as { data?: { result?: T } })?.data?.result ?? value) as T;
}

function relativeRepositoryPath(repository: string, uri: vscode.Uri): string | null {
  const relative = path.relative(repository, uri.fsPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

async function trustFile(repository: string, title: string): Promise<string | null> {
  const picked = await vscode.window.showOpenDialog({
    title,
    defaultUri: vscode.Uri.file(repository),
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { JSON: ['json'] },
    openLabel: 'Use reviewed public trust file'
  });
  if (!picked?.[0]) return null;
  const relative = relativeRepositoryPath(repository, picked[0]);
  if (!relative) {
    await vscode.window.showErrorMessage(
      'Meta-tool public trust inputs must be regular files inside the selected repository.'
    );
  }
  return relative;
}

async function input(title: string, prompt: string, options: {
  value?: string; digest?: boolean; identifier?: boolean; integerMaximum?: number;
} = {}): Promise<string | null> {
  const value = await vscode.window.showInputBox({
    title,
    prompt,
    value: options.value,
    ignoreFocusOut: true,
    validateInput: (candidate) => {
      if (!candidate.trim()) return 'A value is required.';
      if (options.digest && !META_TOOL_SHA256.test(candidate.trim())) {
        return 'Enter sha256: followed by exactly 64 lower-case hexadecimal characters.';
      }
      if (options.identifier && !META_TOOL_IDENTIFIER.test(candidate.trim())) {
        return 'Use lower-case letters, digits, dots, underscores, or hyphens.';
      }
      if (options.integerMaximum !== undefined) {
        const parsed = Number(candidate);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > options.integerMaximum) {
          return `Enter a whole number from 1 through ${options.integerMaximum}.`;
        }
      }
      return null;
    }
  });
  return value === undefined ? null : value.trim();
}

async function common(repository: string): Promise<{
  store: string; traceTrust: string; evaluatorTrust: string;
} | null> {
  const store = await input(
    'Meta-tool · Authority Store',
    'This must equal the Store selected by approved Capability Pack trust.',
    { value: 'repository-platform', identifier: true }
  );
  if (!store) return null;
  const traceTrust = await trustFile(repository, 'Meta-tool · Accepted-trace public keys');
  if (!traceTrust) return null;
  const evaluatorTrust = await trustFile(repository, 'Meta-tool · Independent-evaluator public keys');
  if (!evaluatorTrust) return null;
  return { store, traceTrust, evaluatorTrust };
}

async function collect(repository: string, action: Action): Promise<MetaToolSelection | null> {
  const shared = await common(repository);
  if (!shared) return null;
  if (action === 'activate') {
    const candidateSha256 = await input('Meta-tool · Candidate', 'Exact reviewed candidate digest.', { digest: true });
    if (!candidateSha256) return null;
    const evaluationSha256 = await input('Meta-tool · Evaluation', 'Exact independent signed evaluation digest.', { digest: true });
    if (!evaluationSha256) return null;
    const promotionSha256 = await input('Meta-tool · Promotion', 'Exact independently approved promotion digest.', { digest: true });
    if (!promotionSha256) return null;
    const target = await vscode.window.showQuickPick(META_TOOL_TARGET_KINDS.map((targetKind) => ({
      label: targetKind === 'pack-operation' ? 'Capability Pack operation' : 'Installed Device operation',
      description: targetKind === 'pack-operation'
        ? 'Operation supplied directly by the current reviewed Pack'
        : 'Installed non-revoked Device operation also exported by the current reviewed Pack',
      targetKind
    })), {
      title: 'Meta-tool · Target authority',
      placeHolder: 'Choose the exact authority kind; nothing is preselected',
      ignoreFocusOut: true
    });
    if (!target) return null;
    const domain = await input(
      'Meta-tool · Pack domain',
      'Domain of the current signed Capability Pack that approves this operation.',
      { identifier: true }
    );
    if (!domain) return null;
    const device = target.targetKind === 'device-operation'
      ? await input(
        'Meta-tool · Device',
        'Exact installed Device ID, such as filesystem-read.',
        { identifier: true }
      )
      : undefined;
    if (target.targetKind === 'device-operation' && !device) return null;
    const operation = await input(
      target.targetKind === 'device-operation'
        ? 'Meta-tool · Device operation' : 'Meta-tool · Pack operation',
      target.targetKind === 'device-operation'
        ? 'Exact operation in the installed Device manifest and current reviewed Pack.'
        : 'Exact operation supplied by that active Pack.',
      { identifier: true }
    );
    if (!operation) return null;
    const maximumObservations = await input('Meta-tool · Observation limit', 'Maximum durable observations before review is required again.', { value: '100', integerMaximum: 10_000 });
    if (!maximumObservations) return null;
    const maximumEvidenceRefs = await input('Meta-tool · Evidence limit', 'Maximum exact evidence digests allowed per observation.', { value: '8', integerMaximum: 64 });
    if (!maximumEvidenceRefs) return null;
    const outcomes = await vscode.window.showQuickPick(META_TOOL_OUTCOMES.map((outcome) => ({
      label: outcome, picked: outcome === 'failed' || outcome === 'succeeded', outcome
    })), {
      title: 'Meta-tool · Accepted observation outcomes',
      placeHolder: 'Select every outcome this activation is allowed to record',
      canPickMany: true,
      ignoreFocusOut: true
    });
    if (!outcomes?.length) return null;
    return {
      ...shared, action, candidateSha256, evaluationSha256, promotionSha256,
      targetKind: target.targetKind, domain, ...(device ? { device } : {}), operation,
      maximumObservations: Number(maximumObservations),
      maximumEvidenceRefs: Number(maximumEvidenceRefs),
      acceptedOutcomes: outcomes.map((entry) => entry.outcome)
    };
  }
  if (action === 'observe') {
    const activationSha256 = await input('Meta-tool · Activation', 'Exact current activation digest.', { digest: true });
    if (!activationSha256) return null;
    const chosen = await vscode.window.showQuickPick(META_TOOL_OUTCOMES.map((outcome) => ({
      label: outcome, outcome
    })), { title: 'Meta-tool · Observed outcome', ignoreFocusOut: true });
    if (!chosen) return null;
    const evidence = await input(
      'Meta-tool · Evidence references',
      'Comma-separated exact evidence digests. Evidence content is not copied into authority state.'
    );
    if (!evidence) return null;
    const evidenceRefs = evidence.split(',').map((value) => value.trim()).filter(Boolean);
    if (!evidenceRefs.length || evidenceRefs.some((value) => !META_TOOL_SHA256.test(value))) {
      await vscode.window.showErrorMessage('Every evidence reference must be an exact SHA-256 digest.');
      return null;
    }
    return { ...shared, action, activationSha256, outcome: chosen.outcome, evidenceRefs };
  }
  if (action === 'revoke') {
    const activationSha256 = await input('Meta-tool · Activation', 'Exact activation to revoke.', { digest: true });
    if (!activationSha256) return null;
    const reason = await input('Meta-tool · Revocation reason', 'Explain why this authority must be withdrawn.');
    return reason ? { ...shared, action, activationSha256, reason } : null;
  }
  const operation = await input('Meta-tool · Operation', 'Exact operation whose current selection will roll back.', { identifier: true });
  if (!operation) return null;
  const targetActivationSha256 = await input('Meta-tool · Prior activation', 'Exact retained non-revoked activation to restore.', { digest: true });
  if (!targetActivationSha256) return null;
  const reason = await input('Meta-tool · Rollback reason', 'Explain the observed regression or authority reason.');
  return reason ? { ...shared, action, operation, targetActivationSha256, reason } : null;
}

/** Preview through the engine, show exact authority facts, then perform only the confirmed CAS. */
export async function showSgosMetaToolReview(client: SingularityFlowClient): Promise<void> {
  const repository = path.resolve(client.repository);
  const chosen = await vscode.window.showQuickPick([
    { label: 'Activate reviewed candidate', description: 'Bind it to a current approved Pack or Device operation', action: 'activate' as const },
    { label: 'Record observation', description: 'Append bounded outcome evidence', action: 'observe' as const },
    { label: 'Revoke activation', description: 'Withdraw authority and its current selector', action: 'revoke' as const },
    { label: 'Roll back activation', description: 'Restore a retained non-revoked activation', action: 'rollback' as const }
  ], {
    title: 'Review governed Meta-tool authority',
    placeHolder: 'No action is preselected or performed automatically',
    ignoreFocusOut: true
  });
  if (!chosen) return;
  const selection = await collect(repository, chosen.action);
  if (!selection) return;
  if (path.resolve(client.repository) !== repository) {
    await vscode.window.showErrorMessage('The selected repository changed. Nothing was modified.');
    return;
  }
  try {
    const preview = resultOf<MetaToolMutationPlan>(await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Preparing ${selection.action} review`,
      cancellable: false
    }, () => client.run(metaToolArguments(selection))));
    if (!META_TOOL_SHA256.test(String(preview.confirmationSha256 ?? ''))) {
      throw new Error('The engine did not return an exact mutation-plan confirmation.');
    }
    const accepted = await vscode.window.showWarningMessage(
      `${selection.action.charAt(0).toUpperCase()}${selection.action.slice(1)} this governed Meta-tool authority?`,
      { modal: true, detail: metaToolPlanReview(preview) },
      `Confirm ${selection.action}`
    );
    if (accepted !== `Confirm ${selection.action}`) return;
    if (path.resolve(client.repository) !== repository) {
      await vscode.window.showErrorMessage('The selected repository changed. Nothing was modified.');
      return;
    }
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Applying confirmed Meta-tool ${selection.action}`,
      cancellable: false
    }, () => client.run(metaToolArguments(selection, preview.confirmationSha256 ?? null)));
    await vscode.window.showInformationMessage(
      `Meta-tool ${selection.action} completed through the confirmed Authority Store transaction.`
    );
  } catch (error) {
    await vscode.window.showErrorMessage(
      `Meta-tool ${selection.action} was not applied: ${(error as Error).message}`
    );
  }
}

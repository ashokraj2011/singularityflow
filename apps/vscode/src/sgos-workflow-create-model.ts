/**
 * Pure helpers for the native SGOS Workflow creator.
 *
 * The editor owns presentation only. It turns explicit choices into the same closed CLI request a
 * terminal user can review; declaration construction and every safety check remain in the engine.
 */
import path from 'node:path';
import { commandGuidance } from './copilot-command.ts';

export type SgosWorkflowCreateSelection = {
  readonly intentPath: string;
  readonly policyPath: string;
  readonly registryPath: string;
  readonly id: string;
  readonly title?: string;
  readonly operation: string;
  readonly verificationOperation: string;
  readonly storageProfileSha256: string;
  readonly maximumAttempts: number;
  readonly outputRef: string;
  readonly declarationOut: string;
  readonly workflowOut: string;
};

export type SgosGuideOperation = {
  readonly id: string;
  readonly version?: string | number;
  readonly opcode?: string | null;
  readonly manifestSha256?: string;
  readonly guidedEligible?: boolean;
  readonly guidedRole?: 'operation' | 'verifier' | null;
  readonly verificationOperationIds?: readonly string[];
};

export type SgosWorkflowGuide = {
  readonly intent?: { readonly intentId?: string; readonly objective?: string; readonly clauseCount?: number };
  readonly eligibleOperations?: readonly SgosGuideOperation[];
  readonly eligibleVerificationOperations?: readonly SgosGuideOperation[];
  readonly blockers?: readonly { readonly code?: string; readonly message?: string }[];
  readonly unresolvedRequiredClauses?: readonly { readonly clauseId?: string; readonly field?: string }[];
  readonly installedLimits?: { readonly maximumAttemptsPerTask?: number };
  readonly defaults?: { readonly maximumAttempts?: number; readonly outputRef?: string };
  readonly guideSha256?: string;
};

export const SGOS_SHA256 = /^sha256:[a-f0-9]{64}$/;
export const SGOS_LOWER_KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const SGOS_DRAFT_ROOT = 'singularity/sgos-drafts';

/** Only verifiers expressly paired with this eligible operation may appear in the creator. */
export function sgosEligibleVerifiers(
  guide: SgosWorkflowGuide, operationId: string
): readonly SgosGuideOperation[] {
  const operation = (guide.eligibleOperations ?? []).find((entry) => entry.id === operationId);
  if (!operation || operation.guidedEligible === false || operation.guidedRole === 'verifier') return [];
  const allowed = new Set(operation.verificationOperationIds ?? []);
  return (guide.eligibleVerificationOperations ?? []).filter((entry) =>
    allowed.has(entry.id) && entry.id !== operationId && entry.guidedEligible !== false
    && entry.guidedRole !== 'operation');
}

export function validSgosInputPath(value: string): boolean {
  if (!value || value !== value.trim() || value.includes('\\') || value.includes('\0')
      || value.startsWith('/') || /^[A-Za-z]:\//.test(value) || !value.endsWith('.json')) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..'
    && segment.toLowerCase() !== '.git');
}

/** Presentation preflight only. The CLI remains the final authority and rechecks every input. */
export function sgosWorkflowSelectionIssue(
  selection: SgosWorkflowCreateSelection, guide: SgosWorkflowGuide | null
): string | null {
  if (!validSgosInputPath(selection.intentPath) || !validSgosInputPath(selection.policyPath)
      || !validSgosInputPath(selection.registryPath)) {
    return 'Choose three repository-relative JSON inputs inside the selected repository.';
  }
  if (!guide) return 'Load the deterministic Intent and registry guide before creating a Workflow.';
  if (guide.blockers?.length || guide.unresolvedRequiredClauses?.length) {
    return 'The confirmed Intent has unresolved clauses or guide blockers.';
  }
  if (!(guide.eligibleOperations ?? []).some((entry) => entry.id === selection.operation
      && entry.guidedEligible !== false && entry.guidedRole !== 'verifier')) {
    return 'Choose an operation eligible for this Intent and registry.';
  }
  if (!sgosEligibleVerifiers(guide, selection.operation).some((entry) =>
    entry.id === selection.verificationOperation)) {
    return 'Choose an independent verifier explicitly paired with the selected operation.';
  }
  if (!selection.outputRef.trim()) return 'Name the governed output resource.';
  const maximum = guide.installedLimits?.maximumAttemptsPerTask;
  if (maximum != null && selection.maximumAttempts > maximum) {
    return `This build permits at most ${maximum} attempts per task.`;
  }
  const outputRoot = SGOS_LOWER_KEBAB.test(selection.id) ? `${SGOS_DRAFT_ROOT}/${selection.id}/` : null;
  if (outputRoot && (!selection.declarationOut.startsWith(outputRoot)
      || !selection.workflowOut.startsWith(outputRoot))) {
    return `Both Workflow outputs must be new JSON paths under ${SGOS_DRAFT_ROOT}/${selection.id}/.`;
  }
  try { sgosWorkflowCreateArguments(selection); } catch (error) { return (error as Error).message; }
  return null;
}

export type SgosWorkspaceBinding = {
  readonly active?: boolean;
  readonly repositoryPath?: string;
  readonly repositoryState?: string;
  readonly selectionStatus?: string;
};

/** Refuse a stale or unready machine-wide workspace selection before collecting authoring input. */
export function sgosWorkspaceBindingIssue(
  current: SgosWorkspaceBinding, expectedRepository: string
): string | null {
  if (current.active === false) return 'No Singularity Flow workspace is active.';
  if (current.repositoryState && current.repositoryState !== 'ready') {
    return `The selected repository is ${current.repositoryState}, not ready.`;
  }
  if (current.selectionStatus && current.selectionStatus !== 'ready') {
    return `The workspace selection is ${current.selectionStatus}, not ready.`;
  }
  if (!current.repositoryPath) return 'The active workspace did not identify a repository.';
  if (path.resolve(current.repositoryPath) !== path.resolve(expectedRepository)) {
    return 'The active workspace changed. Reopen the creator after the extension follows the new repository.';
  }
  return null;
}

export function validSgosDraftPath(value: string): boolean {
  const candidate = value.trim();
  if (!candidate || candidate.includes('\0') || candidate.includes('\\')
      || candidate.startsWith('/') || /^[A-Za-z]:\//.test(candidate)
      || !candidate.endsWith('.json') || !candidate.startsWith(`${SGOS_DRAFT_ROOT}/`)) return false;
  const segments = candidate.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..'
    && segment.toLowerCase() !== '.git');
}

export function sgosWorkflowOutputPaths(id: string): {
  declarationOut: string; workflowOut: string;
} {
  if (!SGOS_LOWER_KEBAB.test(id)) {
    throw Object.assign(new Error('Workflow ID must use lower-case kebab case.'), {
      code: 'SGOS_WORKFLOW_ID_INVALID'
    });
  }
  const directory = `${SGOS_DRAFT_ROOT}/${id}`;
  return {
    declarationOut: `${directory}/workflow-declaration.json`,
    workflowOut: `${directory}/workflow-ir.json`
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/@:=,+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function sgosWorkflowCreateCommand(selection: SgosWorkflowCreateSelection): string {
  return sgosCommand(sgosWorkflowCreateArguments(selection));
}

/** Credential-free logical command used by the shared Shell/Copilot crosswalk. */
export function sgosCommand(args: readonly string[]): string {
  return ['singularity-flow', ...args].map(shellQuote).join(' ');
}

/** Build the exact mutation request shown in the final native confirmation. */
export function sgosWorkflowCreateArguments(
  selection: SgosWorkflowCreateSelection
): string[] {
  if (!validSgosInputPath(selection.intentPath) || !validSgosInputPath(selection.policyPath)
      || !validSgosInputPath(selection.registryPath)) {
    throw Object.assign(new Error('Intent, policy, and registry must be repository-relative JSON paths.'), {
      code: 'SGOS_WORKFLOW_INPUT_INVALID'
    });
  }
  if (!SGOS_LOWER_KEBAB.test(selection.id)) {
    throw Object.assign(new Error('Workflow ID must use lower-case kebab case.'), {
      code: 'SGOS_WORKFLOW_ID_INVALID'
    });
  }
  if (!SGOS_SHA256.test(selection.storageProfileSha256)) {
    throw Object.assign(new Error('Storage profile must be an exact SHA-256 digest.'), {
      code: 'SGOS_STORAGE_PROFILE_INVALID'
    });
  }
  if (!validSgosDraftPath(selection.declarationOut)
      || !validSgosDraftPath(selection.workflowOut)) {
    throw Object.assign(new Error('Workflow outputs must be canonical repository-relative JSON paths outside .git.'), {
      code: 'SGOS_WORKFLOW_OUTPUT_INVALID'
    });
  }
  if (selection.declarationOut.normalize('NFC').toLowerCase()
      === selection.workflowOut.normalize('NFC').toLowerCase()) {
    throw Object.assign(new Error('Declaration and Workflow IR must use two distinct paths.'), {
      code: 'SGOS_WORKFLOW_OUTPUT_COLLISION'
    });
  }
  if (!Number.isSafeInteger(selection.maximumAttempts) || selection.maximumAttempts < 1) {
    throw Object.assign(new Error('Maximum attempts must be a positive whole number.'), {
      code: 'SGOS_WORKFLOW_ATTEMPTS_INVALID'
    });
  }
  const args = [
    'intent', 'workflow-create', selection.intentPath,
    '--policy', selection.policyPath,
    '--registry', selection.registryPath,
    '--storage-profile-sha256', selection.storageProfileSha256,
    '--id', selection.id,
    '--operation', selection.operation,
    '--verification-operation', selection.verificationOperation,
    '--maximum-attempts', String(selection.maximumAttempts),
    '--output-ref', selection.outputRef,
    '--declaration-out', selection.declarationOut,
    '--out', selection.workflowOut
  ];
  if (selection.title?.trim()) args.push('--title', selection.title.trim());
  args.push('--json');
  return args;
}

export function sgosWorkflowCreateReview(selection: SgosWorkflowCreateSelection): string {
  const guidance = commandGuidance(sgosWorkflowCreateCommand(selection));
  return [
    `Intent IR: ${selection.intentPath}`,
    `Policy snapshot: ${selection.policyPath}`,
    `Registry snapshot: ${selection.registryPath}`,
    `Workflow: ${selection.id}${selection.title?.trim() ? ` · ${selection.title.trim()}` : ''}`,
    `Operation: ${selection.operation}`,
    `Independent verifier: ${selection.verificationOperation}`,
    `Storage profile: ${selection.storageProfileSha256}`,
    `Maximum attempts: ${selection.maximumAttempts}`,
    `Output: ${selection.outputRef}`,
    `Declaration: ${selection.declarationOut}`,
    `Workflow IR: ${selection.workflowOut}`,
    '',
    'Exact command:',
    guidance ? `Shell: ${guidance.command}` : 'Shell: not displayed because the payload has no safe command route',
    guidance ? `Copilot: ${guidance.copilotCommand}` : 'Copilot: not displayed because the payload has no safe command route',
    '',
    'This creates two reviewable files. It does not ratify, compile, approve, or run the Workflow.'
  ].join('\n');
}

/** Exact read/review-packet request returned after proposal creation; it never ratifies. */
export function sgosRatificationPreviewArguments(
  selection: SgosWorkflowCreateSelection
): string[] {
  const directory = path.posix.dirname(selection.workflowOut);
  return [
    'intent', 'ratification-packet', selection.intentPath,
    '--workflow', selection.workflowOut,
    '--policy', selection.policyPath,
    '--registry', selection.registryPath,
    '--storage-profile-sha256', selection.storageProfileSha256,
    '--out', `${directory}/ratification-packet.json`, '--json'
  ];
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Render a copyable terminal equivalent with its repository cwd made explicit. */
export function sgosTerminalCommand(
  args: readonly string[], repository: string,
  shell: 'posix' | 'powershell' = process.platform === 'win32' ? 'powershell' : 'posix',
  launcher: readonly string[] = ['singularity-flow'],
  electronRunAsNode = false
): string {
  if (!launcher.length || launcher.some((value) => !value)) {
    throw Object.assign(new Error('A terminal launcher is required.'), {
      code: 'SGOS_TERMINAL_LAUNCHER_INVALID'
    });
  }
  const argv = [...launcher, ...args];
  if (shell === 'powershell') {
    const environment = electronRunAsNode ? "$env:ELECTRON_RUN_AS_NODE='1'; " : '';
    return `${environment}Set-Location -LiteralPath ${powerShellQuote(repository)}; & ${argv.map(powerShellQuote).join(' ')}`;
  }
  const environment = electronRunAsNode ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  return `cd ${shellQuote(repository)} && ${environment}${argv.map(shellQuote).join(' ')}`;
}

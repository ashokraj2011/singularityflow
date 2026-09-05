/** Pure argument and review helpers for the developer-local signed-runner UX. */

export const LOCAL_RUNNER_SHA256 = /^sha256:[a-f0-9]{64}$/;
export const LOCAL_RUNNER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export const LOCAL_RUNNER_SIGNER = /^[a-z0-9][a-z0-9._:-]{1,127}$/;

export type LocalRunnerCommandOption = {
  readonly phaseId: string;
  readonly commandId: string;
  readonly kind: string;
  readonly requirement: string;
  readonly modelPolicy: 'never';
  readonly timeoutMs: number;
};

export type LocalRunnerOptions = {
  readonly kind: 'gdp-local-runner-options';
  readonly assurance: 'developer-local-signed';
  readonly authority: 'developer-local';
  readonly gateEligible: false;
  readonly consumedByLifecycle: false;
  readonly identity: null | {
    readonly workId: string;
    readonly status: 'ready' | 'unavailable';
    readonly candidateSha256: string | null;
    readonly proofSubjectSha256: string | null;
  };
  readonly commands: readonly LocalRunnerCommandOption[];
  readonly excluded: readonly { phaseId: string; commandId: string | null; reasonCode: string }[];
  readonly gaps: readonly string[];
  readonly defaultSigner: string;
};

export type LocalRunnerPlan = {
  readonly kind: 'gdp-local-runner-plan';
  readonly workId: string;
  readonly phaseId: string;
  readonly commandId: string;
  readonly signerId: string;
  readonly proofSubjectSha256: string;
  readonly candidateSha256: string;
  readonly repositoryHead: string;
  readonly repositoryTree: string;
  readonly command: { readonly argv: readonly string[]; readonly timeoutMs?: number; readonly modelPolicy?: string };
  readonly commandSha256: string;
  readonly signerKeySha256: string;
  readonly planSha256: string;
};

function required(value: string, label: string, pattern: RegExp): string {
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

export const localRunnerOptionsArguments = (workId: string): string[] => [
  'delivery', 'local-runner-options', '--work-id',
  required(workId, 'Work ID', LOCAL_RUNNER_IDENTIFIER), '--json'
];

export const localRunnerSignerArguments = (
  action: 'create' | 'status', signerId: string
): string[] => [
  'delivery', `local-runner-${action}`, '--signer',
  required(signerId, 'Signer ID', LOCAL_RUNNER_SIGNER), '--json'
];

export function localRunnerPlanArguments(
  options: LocalRunnerOptions, selected: LocalRunnerCommandOption, signerId: string
): string[] {
  const identity = options.identity;
  if (identity?.status !== 'ready'
      || !LOCAL_RUNNER_SHA256.test(String(identity.candidateSha256 ?? ''))
      || !LOCAL_RUNNER_SHA256.test(String(identity.proofSubjectSha256 ?? ''))) {
    throw new Error('The selected Story has no exact Candidate and Proof Subject.');
  }
  if (!options.commands.some((entry) => entry.phaseId === selected.phaseId
      && entry.commandId === selected.commandId && entry.modelPolicy === 'never')) {
    throw new Error('The selected command is not in the engine-projected eligible set.');
  }
  const proofSubjectSha256 = String(identity.proofSubjectSha256);
  const candidateSha256 = String(identity.candidateSha256);
  return [
    'delivery', 'local-runner-plan',
    '--signer', required(signerId, 'Signer ID', LOCAL_RUNNER_SIGNER),
    '--work-id', required(identity.workId, 'Work ID', LOCAL_RUNNER_IDENTIFIER),
    '--phase', required(selected.phaseId, 'Phase ID', LOCAL_RUNNER_IDENTIFIER),
    '--command', required(selected.commandId, 'Command ID', LOCAL_RUNNER_IDENTIFIER),
    '--proof-subject', proofSubjectSha256,
    '--candidate', candidateSha256,
    '--json'
  ];
}

export function localRunnerRunArguments(
  options: LocalRunnerOptions,
  selected: LocalRunnerCommandOption,
  signerId: string,
  planSha256: string
): string[] {
  const args = localRunnerPlanArguments(options, selected, signerId);
  args[1] = 'local-runner-run';
  args.splice(args.length - 1, 0,
    '--confirm-plan', required(planSha256, 'Plan digest', LOCAL_RUNNER_SHA256));
  return args;
}

export function localRunnerVerifyArguments(receiptPath: string, signerId: string): string[] {
  const normalized = receiptPath.trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('\\')
      || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Receipt must be a canonical repository-relative path.');
  }
  return [
    'delivery', 'local-runner-verify', '--attestation-file', normalized,
    '--signer', required(signerId, 'Signer ID', LOCAL_RUNNER_SIGNER), '--json'
  ];
}

/** Render the exact bounded facts a person must inspect before local code execution. */
export function localRunnerPlanReview(plan: LocalRunnerPlan): string {
  if (!LOCAL_RUNNER_SHA256.test(plan.planSha256)
      || !LOCAL_RUNNER_SHA256.test(plan.proofSubjectSha256)
      || !LOCAL_RUNNER_SHA256.test(plan.candidateSha256)
      || !LOCAL_RUNNER_SHA256.test(plan.commandSha256)
      || !LOCAL_RUNNER_SHA256.test(plan.signerKeySha256)
      || !Array.isArray(plan.command?.argv) || !plan.command.argv.length
      || plan.command.argv.some((entry) => typeof entry !== 'string')) {
    throw new Error('The engine returned an invalid local runner plan.');
  }
  const renderedArgv = JSON.stringify(plan.command.argv);
  if (renderedArgv.length > 8192) throw new Error('The configured command exceeds the review display ceiling.');
  return [
    'Assurance: developer-local-signed (never a lifecycle gate)',
    `Story: ${plan.workId}`,
    `Phase / command: ${plan.phaseId} / ${plan.commandId}`,
    `Command: ${renderedArgv}`,
    `Timeout: ${plan.command.timeoutMs ?? 'configured default'} ms`,
    `Candidate: ${plan.candidateSha256}`,
    `Proof Subject: ${plan.proofSubjectSha256}`,
    `Repository commit / tree: ${plan.repositoryHead} / ${plan.repositoryTree}`,
    `Command identity: ${plan.commandSha256}`,
    `Local signer key: ${plan.signerKeySha256}`,
    `Plan confirmation: ${plan.planSha256}`,
    '',
    'The command runs as your local OS user. Its signed receipt is useful for tamper detection and replay, but cannot provide independent approval.'
  ].join('\n');
}

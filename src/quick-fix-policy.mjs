import { createHash } from 'node:crypto';
import { run } from './util.mjs';
import { applicationPathContext, isApplicationPath } from './application-paths.mjs';

export const DEFAULT_QUICK_FIX_POLICY = Object.freeze({
  id: 'quick-fix-low-risk-v1',
  maximumChangedPaths: 5,
  prohibitedPathPatterns: [
    /(^|\/)(api|apis|schema|schemas|migration|migrations|security|auth|deploy|deployment|infrastructure|terraform)(\/|$)/i,
    /(^|\/)(openapi|asyncapi|dockerfile|helm|k8s)(\.|\/|$)/i
  ]
});

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function changedPaths(root, config, workflow) {
  const base = workflow.workItem.baseCommit ?? workflow.workItem.baseBranch;
  const result = run('git', ['diff', '--name-only', '--diff-filter=ACDMRTUXB', base, 'HEAD', '--'], { cwd: root, allowFailure: true });
  if (result.status !== 0) return { paths: [], available: false };
  const pathContext = applicationPathContext(config, workflow);
  return {
    paths: [...new Set(result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      .filter((candidate) => isApplicationPath(candidate, pathContext)))].sort(),
    available: true
  };
}

function truthy(value) {
  return value === true || String(value ?? '').toLowerCase() === 'true';
}

export function evaluateQuickFixWaiver(root, config, workflow, phase, policy = DEFAULT_QUICK_FIX_POLICY) {
  const actual = changedPaths(root, config, workflow);
  const submittedCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  const source = workflow.workItem.source ?? {};
  const protectedPaths = [...new Set([
    ...(config.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ])];
  const prohibitedFlags = ['publicInterfaceChange', 'dataMigration', 'securityBoundaryChange', 'regulatedDataChange', 'deploymentPolicyChange', 'crossRepositoryChange'];
  const requiredCheckIds = [...new Set((phase.qualityCommands ?? [])
    .map((value) => typeof value === 'string' ? value.trim() : String(value?.id ?? value?.command ?? '').trim())
    .filter(Boolean))];
  const executedChecks = new Map((phase.checks ?? []).map((check) => [check.id ?? check.command, check]));
  const reconciliation = phase.workIntervalReconciliation;
  const predicates = {
    declaredLowRisk: String(source.risk ?? '').toLowerCase() === 'low',
    changedPathsAvailable: actual.available,
    changedPathLimit: actual.available && actual.paths.length <= (phase.approvalPolicy.maximumChangedPaths ?? policy.maximumChangedPaths),
    noProtectedPaths: actual.available && !actual.paths.some((file) => protectedPaths.some((guard) => file === guard || file.startsWith(`${guard}/`))),
    oneRepository: Number(source.repositoryCount ?? 1) === 1 && !truthy(source.crossRepositoryChange),
    checksConfigured: requiredCheckIds.length > 0,
    checksPassing: requiredCheckIds.length > 0 && requiredCheckIds.every((id) => {
      const check = executedChecks.get(id);
      return check?.status === 'passed' && check.sourceCommit === submittedCommit;
    }),
    noUndisposedUnplannedPaths: reconciliation?.summary?.unplanned === 0
      && reconciliation?.decision?.status === 'aligned',
    noProhibitedClassification: !prohibitedFlags.some((flag) => truthy(source[flag]))
      && !actual.paths.some((file) => policy.prohibitedPathPatterns.some((pattern) => pattern.test(file)))
  };
  const eligible = Object.values(predicates).every(Boolean);
  const policyDocument = {
    id: phase.approvalPolicy.policy ?? policy.id,
    maximumChangedPaths: phase.approvalPolicy.maximumChangedPaths ?? policy.maximumChangedPaths,
    protectedPaths,
    prohibitedFlags
  };
  return {
    eligible,
    policyId: policyDocument.id,
    policyHash: hash(policyDocument),
    sourceCommit: submittedCommit,
    changedPaths: actual.paths,
    changedPathsHash: hash(actual.paths),
    predicates
  };
}

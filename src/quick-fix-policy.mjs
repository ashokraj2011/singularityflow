import { createHash } from 'node:crypto';
import { head } from './git.mjs';
import { changedRepositoryPaths } from './specifications.mjs';
import { applicationPathContext } from './application-paths.mjs';

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

/**
 * The waiver policy an approval of mode `policy` names, or null when this build cannot evaluate
 * it. A policy that names none means the default. Submission and the gate's replay both decide
 * here, so a waiver submission grants is one the gate can verify; an unknown policy waives nothing.
 */
export function supportedWaiverPolicy(approvalPolicy) {
  if (approvalPolicy?.mode !== 'policy') return null;
  return (approvalPolicy.policy ?? DEFAULT_QUICK_FIX_POLICY.id) === DEFAULT_QUICK_FIX_POLICY.id
    ? DEFAULT_QUICK_FIX_POLICY : null;
}

function changedPaths(root, config, workflow, targetCommit = 'HEAD') {
  const base = workflow.workItem.baseCommit ?? workflow.workItem.baseBranch;
  try {
    return { paths: [...new Set(changedRepositoryPaths(root, {
      base, target: targetCommit, pathContext: applicationPathContext(config, workflow)
    }))].sort(), available: true };
  } catch {
    return { paths: [], available: false };
  }
}

function truthy(value) {
  return value === true || String(value ?? '').toLowerCase() === 'true';
}

export function evaluateQuickFixWaiver(root, config, workflow, phase, policy = DEFAULT_QUICK_FIX_POLICY, {
  targetCommit = 'HEAD'
} = {}) {
  const actual = changedPaths(root, config, workflow, targetCommit);
  const submittedCommit = targetCommit === 'HEAD' ? head(root) : targetCommit;
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

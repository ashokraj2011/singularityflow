import { createHash } from 'node:crypto';
import { head } from './git.mjs';
import { changedRepositoryPaths } from './specifications.mjs';
import { applicationPathContext } from './engine-compatibility/node-source-policy.mjs';

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

// Each waiver condition in plain words, for the submission that did not meet it.
const UNMET = Object.freeze({
  declaredLowRisk: 'the Story\'s source does not declare `risk: low` (only a file given to `start --story-file` can; `start --title/--description` declares no risk)',
  changedPathsAvailable: 'the paths changed since the Story base could not be read',
  changedPathLimit: 'more application paths changed than the policy allows',
  noProtectedPaths: 'a protected path changed',
  oneRepository: 'the Story is not a single-repository change',
  checksConfigured: 'the phase configures no required check',
  checksPassing: 'a required check has not passed at the submitted commit',
  noUndisposedUnplannedPaths: 'the work interval has unplanned paths or is not reconciled as aligned',
  noProhibitedClassification: 'the change touches a public interface, migration, security, regulated data, deployment or cross-repository boundary'
});

/** Why a waiver evaluation did not waive, one plain sentence; null when it is eligible. */
export function waiverNotAppliedMessage(phaseId, waiver) {
  if (!waiver || waiver.eligible) return null;
  const unmet = Object.entries(waiver.predicates).filter(([, met]) => !met).map(([name]) => UNMET[name] ?? name);
  return `${phaseId} needs human approval: its low-risk policy waiver (${waiver.policyId}) did not apply because ${unmet.join('; ')}.`;
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

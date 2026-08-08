import { createHash } from 'node:crypto';
import { run } from './util.mjs';

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

function changedPaths(root, workflow) {
  const base = workflow.workItem.baseBranch;
  const result = run('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', `${base}...HEAD`], { cwd: root, allowFailure: true });
  if (result.status !== 0) return { paths: [], available: false };
  return {
    paths: [...new Set(result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      .filter((item) => !item.startsWith('singularity/')))].sort(),
    available: true
  };
}

function truthy(value) {
  return value === true || String(value ?? '').toLowerCase() === 'true';
}

export function evaluateQuickFixWaiver(root, config, workflow, phase, policy = DEFAULT_QUICK_FIX_POLICY) {
  const actual = changedPaths(root, workflow);
  const source = workflow.workItem.source ?? {};
  const protectedPaths = [...new Set([
    ...(config.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ])];
  const prohibitedFlags = ['publicInterfaceChange', 'dataMigration', 'securityBoundaryChange', 'regulatedDataChange', 'deploymentPolicyChange', 'crossRepositoryChange'];
  const predicates = {
    declaredLowRisk: String(source.risk ?? '').toLowerCase() === 'low',
    changedPathsAvailable: actual.available,
    changedPathLimit: actual.available && actual.paths.length <= (phase.approvalPolicy.maximumChangedPaths ?? policy.maximumChangedPaths),
    noProtectedPaths: actual.available && !actual.paths.some((file) => protectedPaths.some((guard) => file === guard || file.startsWith(`${guard}/`))),
    oneRepository: Number(source.repositoryCount ?? 1) === 1 && !truthy(source.crossRepositoryChange),
    checksPassing: (phase.checks ?? []).every((check) => check.status === 'passed'),
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
    sourceCommit: run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim(),
    changedPaths: actual.paths,
    changedPathsHash: hash(actual.paths),
    predicates
  };
}

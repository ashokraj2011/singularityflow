/** Focused deterministic authorities behind the verification/readiness workbench. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadDefinition } from '../config.mjs';
import { evaluateAstLifecycleGate, verifyAstLifecycleReceipt } from '../ast-lifecycle.mjs';
import { verifyClarificationRecord } from '../clarifications.mjs';
import { normalizeExternalCommand } from '../external-command-policy.mjs';
import { verifyGroundingRecord } from '../grounding.mjs';
import { head } from '../git.mjs';
import { buildRepositorySubjectIndex } from '../repository-subject-index.mjs';
import {
  changedRepositoryPaths, evaluateSpecCoverage, loadActiveSpecRecords
} from '../specifications.mjs';
import { secureRepositoryPath, snapshot } from '../util.mjs';
import { evaluateVisualCoverage } from '../visual-coverage.mjs';
import { reconcileWorkInterval } from '../work-intervals.mjs';
import { workDir } from '../state-stores.mjs';
import { applicationPathContext } from '../application-paths.mjs';

const row = (id, state, source, evidence, slots = {}, action = null) => ({
  id, code: `readiness.${id}`, state, source, evidence, slots, action
});

function unknownRows(reason) {
  return [
    'published-artifacts', 'tests', 'stale-approvals', 'clarifications',
    'unclaimed-changes', 'reconciliation', 'ast', 'visual', 'external-build'
  ]
    .map((id) => row(id, 'unknown', 'unavailable', null, { reason }));
}

function activeDecisions(phase) {
  return (phase?.approvals ?? []).filter((entry) => !entry.invalidatedAt && entry.decision === 'approved');
}

function checksRow(phase, revision) {
  const configured = phase?.deliveryEvidence?.validation?.commands ?? phase?.qualityCommands ?? [];
  const checks = phase?.checks ?? [];
  if (!configured.length) return row('tests', 'met', 'policy', `policy:no-quality-commands`, { configured: '0' });
  if (!checks.length) {
    return row('tests', 'unmet', 'evidence', `generation:${phase.generation ?? 0}`, {
      configured: String(configured.length), recorded: '0', disposition: 'missing'
    }, 'fix:tests');
  }
  const failed = checks.filter((entry) => ['failed', 'blocked'].includes(entry.status));
  const unavailable = checks.filter((entry) => ['skipped-warning', 'stale'].includes(entry.status));
  const unbound = checks.filter((entry) => !entry.sourceCommit || !revision);
  const stale = checks.filter((entry) => entry.sourceCommit && revision && entry.sourceCommit !== revision);
  const recordedIds = new Set(checks.map((entry) => entry.id).filter(Boolean));
  const missing = configured
    .map((command, index) => normalizeExternalCommand(command, index).id)
    .filter((id) => !recordedIds.has(id));
  const state = failed.length || stale.length || missing.length
    ? 'unmet'
    : unavailable.length || unbound.length ? 'unknown' : 'met';
  return row('tests', state, state === 'unknown' ? 'unavailable' : 'evidence',
    checks.map((entry) => `${entry.id ?? entry.command}:${entry.status}:${entry.sourceCommit ?? 'unknown'}`).join('|') || null,
    {
      configured: String(configured.length), recorded: String(checks.length), failed: String(failed.length),
      stale: String(stale.length), missing: String(missing.length), unavailable: String(unavailable.length),
      unbound: String(unbound.length)
    }, state === 'unmet' ? 'fix:tests' : null);
}

async function approvalFreshnessRow(root, workflow) {
  const approved = workflow.phaseOrder.flatMap((phaseId) => {
    const phase = workflow.phases[phaseId];
    return activeDecisions(phase).length ? [{ phaseId, phase }] : [];
  });
  if (!approved.length) return row('stale-approvals', 'met', 'lifecycle', 'approvals:none', { approvals: '0' });
  const stale = [];
  for (const { phaseId, phase } of approved) {
    for (const artifact of phase.artifacts ?? []) {
      const current = await snapshot(path.join(root, artifact.path));
      if (current.exists !== artifact.exists || current.size !== artifact.size || current.sha256 !== artifact.sha256) {
        stale.push(`${phaseId}:${artifact.path}`);
      }
    }
  }
  return row('stale-approvals', stale.length ? 'unmet' : 'met', 'evidence',
    stale.length ? stale.join('|') : `approvals:${approved.map(({ phaseId }) => phaseId).join(',')}`,
    { approvals: String(approved.reduce((sum, entry) => sum + activeDecisions(entry.phase).length, 0)), stale: String(stale.length) },
    stale.length ? 'fix:stale-approvals' : null);
}

async function clarificationsRow(root, config, workflow, phase) {
  const generation = phase?.generation ?? 0;
  if (!generation) return row('clarifications', 'met', 'lifecycle', 'generation:0', { required: 'false' });
  const authorship = [...(phase.authorship ?? [])].reverse().find((entry) => entry.generation === generation);
  if (authorship?.producer !== 'governed-agent') {
    return row('clarifications', 'met', 'lifecycle', `authorship:${authorship?.producer ?? 'unknown'}`, { required: 'false' });
  }
  const grounding = await verifyGroundingRecord(root, config, workflow, phase, { generation });
  const verified = await verifyClarificationRecord(root, config, workflow, phase, {
    generation, groundingRecord: grounding.record
  });
  // A `when-needed` policy with no record is an explicit pass from the verifier, not missing
  // evidence. Conversely, a broken grounding record must not be hidden by a clarification pass.
  const errors = [...(grounding.errors ?? []), ...(verified.errors ?? [])];
  const warnings = [...(grounding.warnings ?? []), ...(verified.warnings ?? [])];
  const state = errors.length ? 'unmet' : 'met';
  return row('clarifications', state, 'evidence',
    verified.record ? `${verified.path}:${verified.sha256}` : null,
    {
      mode: verified.mode, errors: String(errors.length), warnings: String(warnings.length),
      responses: String(verified.record?.responses?.length ?? 0)
    }, state === 'unmet' ? 'fix:clarifications' : null);
}

async function claimsRow(root, config, workflow) {
  const policy = workflow.resolution?.spec ?? config.spec ?? { coverage: 'off' };
  if (policy.coverage === 'off') {
    return row('unclaimed-changes', 'met', 'policy', 'spec.coverage:off', { configured: 'false' });
  }
  const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
  const base = workflow.workItem.baseCommit
    ?? workflow.phases[workflow.phaseOrder[0]]?.sourceCommit
    ?? workflow.workItem.baseBranch;
  const changed = changedRepositoryPaths(root, {
    base, target: 'HEAD', pathContext: applicationPathContext(config, workflow)
  });
  const coverage = evaluateSpecCoverage(records, changed, policy, { root });
  const unmet = coverage.unclaimedChangedPaths.length > 0;
  return row('unclaimed-changes', unmet ? 'unmet' : 'met', 'evidence',
    `coverage:${coverage.totals.observed}/${coverage.totals.clauses}:${coverage.totals.changedPaths}`,
    {
      changed: String(coverage.totals.changedPaths), unclaimed: String(coverage.unclaimedChangedPaths.length),
      observed: String(coverage.totals.observed), clauses: String(coverage.totals.clauses)
    }, unmet ? 'fix:unclaimed-changes' : null);
}

async function publishedArtifactsRow(root, config, workflow, phase) {
  const requiredPath = phase?.requiredArtifact?.path ?? null;
  if (!requiredPath) return row('published-artifacts', 'met', 'policy', 'artifact:not-required', { required: 'false' });
  const expected = path.posix.join(
    config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, requiredPath
  );
  const artifacts = (phase.artifacts ?? []).filter((entry) =>
    entry.generation == null || Number(entry.generation) === Number(phase.generation)
  );
  const required = artifacts.find((entry) => entry.path === expected || entry.relativePath === expected);
  if (!phase.generationCommit || !required) {
    return row('published-artifacts', 'unmet', 'lifecycle', `generation:${phase.generation ?? 0}`, {
      required: 'true', published: 'false'
    }, 'fix:published-artifacts');
  }
  const current = await snapshot(path.join(root, required.path ?? required.relativePath));
  const valid = current.exists && current.sha256 === required.sha256 && current.size === required.size;
  return row('published-artifacts', valid ? 'met' : 'unmet', 'evidence',
    valid ? `${required.path}:${required.sha256}` : null,
    { required: 'true', published: 'true', current: String(valid) },
    valid ? null : 'fix:published-artifacts');
}

async function reconciliationRow(root, config, workflow, phase) {
  const interval = workflow.workIntervals?.current;
  if (!interval || interval.phaseId !== phase.id || !['open', 'reconciled'].includes(interval.status)) {
    return row('reconciliation', 'met', 'policy', 'work-interval:not-open', { required: 'false' });
  }
  if (interval.status === 'reconciled' && interval.finalReconciliation?.reconciliationSha256) {
    return row('reconciliation', 'met', 'evidence', interval.finalReconciliation.reconciliationSha256, {
      status: 'reconciled', unplanned: '0'
    });
  }
  const report = await reconcileWorkInterval(root, config, workflow, {
    phaseId: phase.id,
    itemDirectory: workDir(root, config, workflow.workItem.id),
    writeLocal: false,
    requireCleanTarget: false
  });
  const unmet = !report.decision.eligibleForSubmission || report.summary.unplanned > 0;
  return row('reconciliation', unmet ? 'unmet' : 'met', 'evidence', report.reconciliationSha256, {
    status: report.decision.status,
    changed: String(report.summary.changedPaths),
    unplanned: String(report.summary.unplanned),
    protected: String(report.summary.protected)
  }, unmet ? 'fix:reconciliation' : null);
}

async function astRow(root, config, workflow, phase) {
  const recorded = (phase.astGates ?? []).some((entry) => Number(entry.generation) === Number(phase.generation));
  const evaluation = recorded
    ? await verifyAstLifecycleReceipt(root, config, workflow, phase, { generation: phase.generation, revalidate: true })
    : await evaluateAstLifecycleGate(root, config, workflow, phase, {
      generation: Math.max(1, Number(phase.generation ?? 0))
    });
  if (!evaluation.applies) {
    const reason = evaluation.reason ?? 'not-configured';
    return row('ast', 'met', 'policy', `ast:${reason}`, { required: 'false', mode: reason });
  }
  const errors = evaluation.errors ?? [];
  const evidence = evaluation.receipt?.integritySha256
    ?? evaluation.record?.integritySha256
    ?? evaluation.result?.scope?.coneSha256
    ?? null;
  return row('ast', errors.length ? 'unknown' : 'met', 'evidence', evidence, {
    errors: String(errors.length), warnings: String(evaluation.warnings?.length ?? 0),
    required: 'false',
    assurance: evaluation.receipt?.assurance ?? evaluation.record?.assurance ?? evaluation.result?.assurance ?? 'unknown'
  });
}

async function visualRow(root, config, workflow) {
  const coverage = await evaluateVisualCoverage(root, workflow, {
    itemDirectory: workDir(root, config, workflow.workItem.id)
  });
  if (coverage.status === 'not-configured') {
    return row('visual', 'met', 'policy', 'visual:not-configured', { required: 'false' });
  }
  const requiredFailure = coverage.mode === 'enforce' && coverage.errors.length > 0;
  return row('visual', requiredFailure ? 'unmet' : 'met', 'evidence',
    coverage.covered.map((entry) => `${entry.profileId}:${entry.outputSha256}`).join('|') || null,
    {
      mode: coverage.mode, profiles: String(coverage.profiles.length),
      covered: String(coverage.covered.length), uncovered: String(coverage.uncovered.length),
      warnings: String(coverage.warnings.length), errors: String(coverage.errors.length)
    }, requiredFailure ? 'fix:visual' : null);
}

async function externalBuildRow(root, workflow) {
  const required = workflow.lineage?.requiredChecks ?? [];
  if (!required.length) return row('external-build', 'met', 'policy', 'external-build:not-configured', { required: '0' });
  const latest = (workflow.lineage?.reviewEvidence ?? []).at(-1);
  if (!latest?.path) {
    return row('external-build', 'unknown', 'unavailable', null, {
      required: String(required.length), reason: 'provider-observation-not-recorded'
    });
  }
  const evidencePath = await secureRepositoryPath(root, latest.path, {
    label: 'External build evidence', mustExist: true, type: 'file'
  });
  const stored = JSON.parse(await readFile(evidencePath.absolute, 'utf8'));
  const { evidenceSha256, ready: _ready, ...base } = stored;
  const actual = createHash('sha256').update(JSON.stringify(base)).digest('hex');
  if (!evidenceSha256 || evidenceSha256 !== latest.evidenceSha256 || actual !== evidenceSha256) {
    throw Object.assign(new Error('External build evidence failed its integrity check.'), {
      code: 'EXTERNAL_BUILD_EVIDENCE_INVALID'
    });
  }
  const observations = stored.github?.required ?? [];
  const byName = new Map(observations.map((entry) => [entry.name, entry.status]));
  const statuses = required.map((name) => byName.get(name) ?? 'missing');
  const pending = statuses.filter((status) => status === 'pending').length;
  const failed = statuses.filter((status) => !['passed', 'pending'].includes(status)).length;
  const state = failed ? 'unmet' : pending ? 'unknown' : 'met';
  return row('external-build', state, state === 'unknown' ? 'provider' : 'evidence',
    evidenceSha256,
    { required: String(required.length), passed: String(statuses.filter((status) => status === 'passed').length), pending: String(pending), failed: String(failed) },
    state === 'unmet' ? 'fix:external-build' : null);
}

/**
 * Evaluate only authorities this operation can prove at one captured HEAD.
 *
 * A definition/workflow failure returns nine explicit unknown rows. Once the workflow can be read,
 * each authority fails independently so one corrupt source cannot erase the other three results.
 */
export async function evaluateReadinessEvidence(root, item) {
  try {
    if (item.kind !== 'story') return unknownRows('unsupported-work-kind');
    const config = await loadDefinition(root);
    const index = await buildRepositorySubjectIndex(root, { definition: config });
    const subject = index.list('story').find((entry) => entry.id === item.id);
    const workflow = subject?.state;
    const phase = workflow?.phases?.[workflow.currentPhase];
    if (!workflow || !phase) return unknownRows('workflow-or-phase-unavailable');
    // Quality commands run against the immutable generation commit. Submission then adds a
    // governance-only commit, so comparing them with HEAD would make every check stale the moment
    // it was successfully submitted.
    const revision = phase.generationCommit ?? head(root);
    const guarded = async (id, evaluate) => {
      try { return await evaluate(); }
      catch (error) {
        return row(id, 'unknown', 'unavailable', null, {
          reason: error.code ?? error.name ?? 'evidence-read-failed'
        });
      }
    };
    const results = await Promise.all([
      guarded('published-artifacts', () => publishedArtifactsRow(root, config, workflow, phase)),
      guarded('tests', () => checksRow(phase, revision)),
      guarded('stale-approvals', () => approvalFreshnessRow(root, workflow)),
      guarded('clarifications', () => clarificationsRow(root, config, workflow, phase)),
      guarded('unclaimed-changes', () => claimsRow(root, config, workflow)),
      guarded('reconciliation', () => reconciliationRow(root, config, workflow, phase)),
      guarded('ast', () => astRow(root, config, workflow, phase)),
      guarded('visual', () => visualRow(root, config, workflow)),
      guarded('external-build', () => externalBuildRow(root, workflow))
    ]);
    return results;
  } catch (error) {
    return unknownRows(error.code ?? error.name ?? 'evidence-read-failed');
  }
}

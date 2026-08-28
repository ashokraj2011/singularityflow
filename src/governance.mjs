import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { currentPhase, sourceTreeHash, validateWorkflow, workDir, workflowPublicationBranch } from './state-stores.mjs';
import { exists, posix, snapshot, run } from './util.mjs';
import { verifyInputsIntegrity } from './inputs.mjs';
import { verifyAgentIntegrity } from './agents.mjs';
import { matchApprovalAuthority, remainingRequiredAuthorities } from './approval-authority.mjs';
import { verifyGroundingRecord } from './grounding.mjs';
import { verifyClarificationRecord } from './clarifications.mjs';
import { verifyPhaseTelemetry } from './telemetry.mjs';
import { verifyMcpEvidence } from './mcp.mjs';
import { verifyDesignSourceLifecycle } from './design-sources.mjs';
import { evaluateVisualCoverage } from './visual-coverage.mjs';
import { listVisualComparisons } from './visual-compare.mjs';
import { loadImpactDefinition } from './impact-config.mjs';
import { verifyImpactPlanBinding, verifyImpactReceipt } from './impact.mjs';
import {
  changedRepositoryPaths,
  configuredAcceptanceCommandSetSha256,
  evaluateSpecAcceptance,
  evaluateSpecCoverage,
  loadActiveSpecRecords,
  specificationSourceTreeHash
} from './specifications.mjs';
import { verifyAstLifecycleReceipt } from './ast-lifecycle.mjs';
import { blockingConformanceVerdicts } from './conformance-verdicts.mjs';
import { buildRepositoryChangeSet } from './repository-change-set.mjs';
import { evaluateStoryProtectedPaths } from './configuration-materialization.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { readRecord } from './schema-migrations.mjs';
import { verifyCodeDeliveryReceipt } from './delivery-evidence.mjs';
import { classifyStoryGateFailures } from './gate-recovery.mjs';
import { runRemoteGit } from './git-execution.mjs';
import { publishedGenerationCommit } from './generation-publication-store.mjs';

function trackedFiles(root) { return run('git', ['ls-files', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean); }
function ids(text, pattern) { return [...new Set([...text.matchAll(pattern)].map((match) => match[0]))]; }
function traceabilitySources(workflow) {
  return workflow.phaseOrder.map((phaseId) => workflow.phases[phaseId]).filter((phase) => ['requirements', 'implementation-spec'].includes(phase?.requiredArtifact?.kind));
}

export { approvedConfigurationMaterializations } from './configuration-materialization.mjs';

export function generationAuthorship(phase, generation) {
  return [...(phase?.authorship ?? [])].reverse()
    .find((record) => Number(record.generation) === Number(generation))
    ?? { producer: 'legacy-unspecified', channel: 'legacy' };
}

/** Grounding governs a model-assisted prompt. Manual and deterministic producers sent no prompt. */
export function generationRequiresGrounding(phase, generation) {
  return ['governed-agent', 'legacy-unspecified'].includes(generationAuthorship(phase, generation).producer);
}

/**
 * Submission-grade evidence is required only after a generation crossed the review boundary.
 * A published draft that was superseded before submit remains immutable audit history, but it
 * cannot have the test receipt that submit intentionally creates later.
 */
export function generationReachedReview(workflow, phase, generation) {
  const phaseId = phase?.id;
  if ((workflow?.lineage?.submissions ?? []).some((entry) =>
    entry.phase === phaseId && Number(entry.generation) === Number(generation))) return true;
  if ((phase?.approvals ?? []).some((entry) => Number(entry.generation) === Number(generation))) return true;
  return Number(phase?.generation) === Number(generation)
    && (Boolean(phase?.submittedAt) || ['awaiting_approval', 'approved'].includes(phase?.status));
}

export async function runGovernanceGate(root, config, workflow, { terminal = false } = {}) {
  const errors = [], warnings = [], passes = [];
  const base = await validateWorkflow(root, config, workflow, { strict: true }); errors.push(...base.errors); warnings.push(...base.warnings);
  for (const override of workflow.sequenceOverrides ?? []) {
    warnings.push(`soft sequence gate '${override.gate}' was overridden for ${override.requestedPhase ?? override.before?.currentPhase ?? 'workflow'} during ${override.action}`);
  }

  if (workflow.resolution.configSha256) {
    const current = await snapshot(path.join(root, 'singularity/workflow.yml'));
    if (current.sha256 !== workflow.resolution.configSha256) errors.push('workflow.yml differs from the immutable work-item configuration snapshot');
    for (const [phaseId, template] of Object.entries(workflow.resolution.templates ?? {})) {
      const present = await snapshot(path.join(root, template.path));
      if (present.sha256 !== template.sha256) errors.push(`template snapshot changed for ${phaseId}: ${template.path}`);
    }
    if (workflow.resolution.sourceSha256) {
      const source = await snapshot(path.join(workDir(root, config, workflow.workItem.id), 'source.json'));
      if (source.sha256 !== workflow.resolution.sourceSha256) errors.push('source.json differs from the immutable source snapshot');
    }
    if (workflow.resolution.impact?.sha256) {
      if (workflow.measurement?.plan?.kind === 'prompt-set-randomized') {
        try {
          const binding = await verifyImpactPlanBinding(root, workflow);
          errors.push(...binding.errors.map((error) => `prompt study: ${error}`));
          if (binding.valid) passes.push(`prompt study assignment pinned: ${workflow.measurement.plan.studyRunId}/${workflow.measurement.plan.variantId}`);
        } catch (error) {
          errors.push(`prompt study assignment is unavailable: ${error.message}`);
        }
      } else {
        try {
          const currentImpact = await loadImpactDefinition(root, { required: true });
          if (currentImpact.sha256 !== workflow.resolution.impact.sha256) {
            errors.push('impact.yml differs from the immutable work-item impact-study snapshot');
          } else passes.push(`impact study configuration pinned: ${currentImpact.sha256.slice(0, 12)}`);
        } catch (error) {
          errors.push(`impact study configuration is unavailable: ${error.message}`);
        }
      }
    }
  }

  if (workflow.measurement?.receipt) {
    const verification = await verifyImpactReceipt(root, workflow);
    errors.push(...verification.errors.map((error) => `impact receipt: ${error}`));
    if (verification.valid) passes.push(`impact receipt verified: ${workflow.measurement.receipt.sha256.slice(0, 12)}`);
  }

  const documentManifest = path.join(workDir(root, config, workflow.workItem.id), 'documents.json');
  if (await exists(documentManifest)) {
    const manifest = JSON.parse(await readFile(documentManifest, 'utf8')); const seen = new Set();
    if (manifest.workId !== workflow.workItem.id) errors.push('document catalog work ID does not match workflow');
    for (const document of manifest.documents ?? []) {
      if (seen.has(document.id)) errors.push(`duplicate document ID: ${document.id}`); seen.add(document.id);
      if (!(workflow.resolution.documents?.allowedPhases ?? []).includes(document.phase)) errors.push(`${document.id} was uploaded outside the immutable document phase policy`);
      if (!document.addedBy || !document.agent) errors.push(`${document.id} is missing actor or agent attribution`);
      if (document.type === 'file') {
        const current = await snapshot(path.join(root, document.path));
        if (!current.exists || current.size !== document.size || current.sha256 !== document.sha256) errors.push(`document integrity failed: ${document.id} (${document.path})`);
      } else if (document.type === 'url' && !/^https?:\/\/\S+$/i.test(document.url ?? '')) errors.push(`${document.id} has an invalid external URL`);
    }
    if ((workflow.documents?.count ?? 0) !== (manifest.documents?.length ?? 0)) errors.push('workflow document count differs from documents.json');
    else passes.push(`document integrity: ${manifest.documents?.length ?? 0} supporting inputs`);
  } else if ((workflow.documents?.count ?? 0) > 0) errors.push('workflow records documents but documents.json is missing');

  const mergeBase = run('git', ['merge-base', workflow.workItem.baseBranch, 'HEAD'], { cwd: root, allowFailure: true });
  if (mergeBase.status === 0) {
    const branchChangeSet = await buildRepositoryChangeSet(root, { baseCommit: mergeBase.stdout.trim() });
    const protectedResult = evaluateStoryProtectedPaths(
      branchChangeSet, config.governance?.protectedPaths ?? [], workflow
    );
    for (const violation of protectedResult.violations) {
      errors.push(`protected process path changed on work branch: ${violation.path} (${violation.endpoint})`);
    }
    if (protectedResult.acceptedProtectedPaths.size) {
      passes.push(`approved configuration materialization: ${protectedResult.acceptedProtectedPaths.size} protected path(s) match the pinned configuration snapshot`);
    }
  } else warnings.push(`could not compare protected process paths with ${workflow.workItem.baseBranch}`);

  for (const phaseId of workflow.phaseOrder) {
    const phase = workflow.phases[phaseId];
    for (let generation = 1; generation <= (phase.generation ?? 0); generation += 1) {
      const subject = `[${workflow.workItem.id}][phase:${phase.id}][generated:${generation}]`;
      const publication = (phase.generationPublications ?? [])
        .find((entry) => Number(entry.generation) === Number(generation));
      let found = null;
      let publicationInvalid = false;
      if (publication?.record?.path) {
        try {
          const commit = publishedGenerationCommit(root, workflow, phase, generation);
          if (commit) {
            found = [commit, subject];
            passes.push(`generation publication verified: ${phaseId} generation ${generation} @ ${commit.slice(0, 12)}`);
          }
        } catch (error) {
          publicationInvalid = true;
          errors.push(`${phaseId} generation ${generation} publication record is invalid: ${error.message}`);
        }
      } else {
        found = run('git', ['log', '--format=%H%x09%s', '--fixed-strings', '--grep', subject], { cwd: root, allowFailure: true }).stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t')).find(([, message]) => message.startsWith(subject));
      }
      if (!found) {
        if (!publicationInvalid) errors.push(`${phaseId} generation ${generation} has no required Git commit`);
      } else if (config.git?.publish === 'required') {
        const remoteRef = `refs/remotes/${config.git.remote ?? 'origin'}/${workflowPublicationBranch(root, workflow)}`;
        const published = run('git', ['merge-base', '--is-ancestor', found[0], remoteRef], { cwd: root, allowFailure: true });
        if (published.status !== 0) errors.push(`${phaseId} generation ${generation} is not present on the remote branch`);
      }
      let grounding = { errors: [], warnings: [], passes: [], record: null, path: null };
      if (generationRequiresGrounding(phase, generation)) {
        grounding = await verifyGroundingRecord(root, config, workflow, phase, { generation });
        errors.push(...grounding.errors); warnings.push(...grounding.warnings); passes.push(...grounding.passes);
        if (grounding.path && await exists(path.join(root, grounding.path)) && found) {
          if (run('git', ['cat-file', '-e', `${found[0]}:${grounding.path}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`grounding composition was not committed with ${phaseId} generation ${generation}`);
          else passes.push(`grounding audit committed: ${phaseId} generation ${generation}`);
          if (grounding.record?.promptPath && run('git', ['cat-file', '-e', `${found[0]}:${grounding.record.promptPath}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`grounding prompt snapshot was not committed with ${phaseId} generation ${generation}`);
        }
      } else {
        passes.push(`grounding not applicable: ${phaseId} generation ${generation} was ${generationAuthorship(phase, generation).producer}`);
      }
      // Historical receipts are checked as immutable evidence at their generation commit. A later
      // phase may legitimately change a previously evaluated source file; only the active
      // publish-to-submit boundary re-evaluates live bytes.
      const ast = await verifyAstLifecycleReceipt(root, config, workflow, phase, {
        generation, revalidate: false, sourceCommit: found?.[0] ?? null
      });
      warnings.push(...ast.errors.map((error) => `optional AST evidence: ${error}`), ...ast.warnings);
      if (found) passes.push(...ast.passes);
      if (phaseRequiresCodeDelivery(phase)) {
        const reachedReview = generationReachedReview(workflow, phase, generation);
        const receiptPath = posix(path.join(
          config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
          'context', 'code-delivery', `${phase.id}-gen${generation}.json`
        ));
        if (!(await exists(path.join(root, receiptPath)))) {
          const generationStartPath = posix(path.join(
            config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
            'context', 'generation-start', `${phase.id}-gen${generation}.json`
          ));
          const v2Generation = phase.generationIntent?.generation === generation
            || await exists(path.join(root, generationStartPath))
            || Boolean(found && run('git', ['cat-file', '-e', `${found[0]}:${generationStartPath}`], {
              cwd: root, allowFailure: true
            }).status === 0);
          if (v2Generation && !reachedReview) {
            warnings.push(`${phaseId} generation ${generation} was superseded before review and has no draft code-delivery receipt`);
          } else {
            (v2Generation ? errors : warnings).push(
              `${phaseId} generation ${generation} has ${v2Generation ? 'no required' : 'legacy inline'} code-delivery evidence instead of a v2 receipt`
            );
          }
        } else if (!reachedReview) {
          passes.push(`superseded publication retained: ${phaseId} generation ${generation} did not enter review`);
        } else {
          const receipt = readRecord('code-delivery', await readFile(path.join(root, receiptPath))).record;
          if (receipt.legacyV1) {
            warnings.push(`${phaseId} generation ${generation} code-delivery receipt is readable legacy v1 evidence`);
          } else {
            if (found && receipt.tree?.generationCommit !== found[0]) errors.push(`${phaseId} generation ${generation} receipt names a different generation commit`);
            const replay = await verifyCodeDeliveryReceipt(root, receipt, {
              protectedPaths: [...new Set([
                ...(config.governance?.protectedPaths ?? []),
                ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
              ])],
              configurationSource: workflow.resolution?.configurationSource,
              sourceBoundary: phase.sourceBoundary,
              symlinkPolicy: workflow.resolution?.codeDelivery?.changeSet?.symlinks ?? 'reject',
              minimumDiscovered: workflow.resolution?.codeDelivery?.tests?.minimumDiscovered ?? 1,
              minimumPassed: workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1,
              requireAffectedModuleCoverage: workflow.resolution?.codeDelivery?.tests?.requireAffectedModuleCoverage !== false,
              minimumModelAssurance: workflow.resolution?.codeDelivery?.model?.minimumAssurance ?? 'unavailable'
            });
            errors.push(...replay.errors.map((message) => `${phaseId} generation ${generation}: ${message}`));
            if (replay.valid) passes.push(`code delivery verified: ${phaseId} generation ${generation}`);
          }
        }
      }
      const authorship = generationAuthorship(phase, generation);
      if (authorship?.producer === 'governed-agent') {
        const clarification = await verifyClarificationRecord(root, config, workflow, phase, { generation, groundingRecord: grounding.record });
        errors.push(...clarification.errors); warnings.push(...clarification.warnings); passes.push(...clarification.passes);
        if (clarification.path && clarification.record && found) {
          if (run('git', ['cat-file', '-e', `${found[0]}:${clarification.path}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`clarification record was not committed with ${phaseId} generation ${generation}`);
          else passes.push(`clarification audit committed: ${phaseId} generation ${generation}`);
        }
      }
      if (workflow.telemetry?.mode === 'work-item-sanitized' || (phase.telemetry ?? []).some((item) => item.generation === generation)) {
        const telemetry = await verifyPhaseTelemetry(root, workflow, phase, generation);
        errors.push(...telemetry.errors); passes.push(...telemetry.passes);
        const telemetryPath = (phase.telemetry ?? []).find((item) => item.generation === generation)?.path;
        if (found && telemetryPath && run('git', ['cat-file', '-e', `${found[0]}:${telemetryPath}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`telemetry audit was not committed with ${phaseId} generation ${generation}`);
      }
      const agentContextRelative = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', `agents-${phase.id}-gen${generation}.json`);
      if (await exists(path.join(root, agentContextRelative))) {
        if (found && run('git', ['cat-file', '-e', `${found[0]}:${agentContextRelative}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`remote agent context was not committed with ${phaseId} generation ${generation}`);
        else if (found) passes.push(`remote agent audit: ${phaseId} generation ${generation}`);
      }
      for (const output of (phase.remoteOutputs ?? []).filter((entry) => entry.generation === generation)) {
        const outputRecord = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', `remote-output-${output.agent}-${output.resource}-${phase.id}-gen${generation}.json`);
        if (!(await exists(path.join(root, outputRecord)))) errors.push(`remote output provenance is missing: ${outputRecord}`);
        else if (found && run('git', ['cat-file', '-e', `${found[0]}:${outputRecord}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`remote output provenance was not committed with ${phaseId} generation ${generation}`);
      }
    }
    const inputIntegrity = await verifyInputsIntegrity(root, workflow, phase, {
      itemDirectory: workDir(root, config, workflow.workItem.id),
      itemRelative: path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id)
    });
    errors.push(...inputIntegrity.errors); warnings.push(...inputIntegrity.warnings); passes.push(...inputIntegrity.passes);
    const agentIntegrity = await verifyAgentIntegrity(root, workflow, phase, { itemDirectory: workDir(root, config, workflow.workItem.id) });
    errors.push(...agentIntegrity.errors); warnings.push(...agentIntegrity.warnings); passes.push(...agentIntegrity.passes);
    if (phase.status !== 'approved') continue;
    const decisions = phase.approvals.filter((item) => !item.invalidatedAt && item.decision === 'approved');
    const distinct = new Set(decisions.map((item) => item.actor?.login ?? item.actor?.email ?? item.actor?.name));
    if (distinct.size < (phase.approvalPolicy.minimum ?? 1)) errors.push(`${phaseId} has ${distinct.size} distinct approvals; requires ${phase.approvalPolicy.minimum ?? 1}`);
    const missingAuthorities = remainingRequiredAuthorities(phase.approvalPolicy, decisions);
    if (missingAuthorities.length) errors.push(`${phaseId} is missing required authority decisions from: ${missingAuthorities.join(', ')}`);
    for (const decision of decisions) {
      const authority = matchApprovalAuthority(
        workflow.resolution.approvalAuthorities,
        { ...phase.approvalPolicy, authorities: [decision.authorityGroup] },
        decision.actor
      );
      if (!authority.authorized) errors.push(`${phaseId} approval by '${decision.actor?.email ?? decision.actor?.login ?? decision.actor?.name ?? 'unknown'}' lacks configured authority`);
      else if (decision.authorityGroup !== authority.authorityGroup) errors.push(`${phaseId} approval authority record does not match the pinned policy`);
      if (!decision.identityAssurance) errors.push(`${phaseId} approval is missing identity-assurance metadata`);
      if (decision.selfApproval) warnings.push(`${phaseId} is self-approved by ${decision.actor?.name ?? 'unknown'}; governed agent '${decision.agent ?? 'unavailable'}' is execution context, not independent review`);
    }
    for (const artifact of phase.artifacts) {
      const current = await snapshot(path.join(root, artifact.path));
      if (current.exists !== artifact.exists || current.size !== artifact.size || current.sha256 !== artifact.sha256) errors.push(`STALE ${phaseId} approval: ${artifact.path} changed after approval`);
    }
    const required = path.join(root, config.workItemRoot, workflow.workItem.id, phase.requiredArtifact.path);
    const text = await readFile(required, 'utf8').catch(() => '');
    if (decisions.some((item) => item.selfApproval) && !/"selfApproval": true/.test(text)) errors.push(`${phaseId} artifact does not expose its self-approval warning`);
    passes.push(`approval integrity: ${phaseId}`);
  }

  const mcpIntegrity = await verifyMcpEvidence(root, workflow, {
    itemDirectory: workDir(root, config, workflow.workItem.id)
  });
  errors.push(...mcpIntegrity.errors); warnings.push(...mcpIntegrity.warnings); passes.push(...mcpIntegrity.passes);

  const designSourceIntegrity = await verifyDesignSourceLifecycle(root, workflow, {
    itemDirectory: workDir(root, config, workflow.workItem.id)
  });
  errors.push(...designSourceIntegrity.errors);
  warnings.push(...designSourceIntegrity.warnings);
  passes.push(...designSourceIntegrity.passes);

  const visualCoverage = await evaluateVisualCoverage(root, workflow, {
    itemDirectory: workDir(root, config, workflow.workItem.id)
  });
  if (visualCoverage.mode === 'enforce') errors.push(...visualCoverage.errors); else warnings.push(...visualCoverage.errors);
  warnings.push(...visualCoverage.warnings);
  if (visualCoverage.status === 'pass') passes.push(`visual coverage: ${visualCoverage.covered.length}/${visualCoverage.profiles.length} profiles`);
  const comparisons = await listVisualComparisons(root, workflow, { itemDirectory: workDir(root, config, workflow.workItem.id) });
  for (const comparison of comparisons) {
    // Evidence that will not parse is an integrity failure, not a threshold decision, so it fails
    // the gate whatever the comparison mode says. Otherwise damaging a record is a way past it.
    if (comparison.unreadable) errors.push(`visual comparison evidence ${comparison.path} could not be read: ${comparison.error}`);
    else if (comparison.status === 'fail' && workflow.resolution?.verification?.comparison?.mode === 'enforce') errors.push(`visual comparison ${comparison.id} exceeds policy thresholds`);
    else if (comparison.status !== 'pass') warnings.push(`visual comparison ${comparison.id}: ${comparison.status}`);
  }
  if (comparisons.length) passes.push(`visual comparisons: ${comparisons.length} deterministic result(s)`);

  const specPolicy = workflow.resolution?.spec ?? config.spec ?? { mode: 'off', coverage: 'off' };
  if (specPolicy.mode !== 'off') {
    const itemDirectory = workDir(root, config, workflow.workItem.id);
    const records = await loadActiveSpecRecords(itemDirectory, workflow);
    const fail = (message) => (specPolicy.mode === 'enforce' ? errors : warnings).push(message);
    for (const phaseId of workflow.phaseOrder) {
      const phase = workflow.phases[phaseId];
      if (!(phase.generation > 0) || !['requirements', 'implementation-spec', 'conformance-report'].includes(phase.requiredArtifact?.kind)) continue;
      const index = records.indexes.find((candidate) => candidate.phase === phaseId && candidate.generation === phase.generation);
      if (!index) {
        fail(`${phaseId} generation ${phase.generation} has no deterministic specification index`);
        continue;
      }
      const artifact = await snapshot(path.join(root, index.source.path));
      // `phase.specIndex` is the same fact recorded in the aggregate when the generation was
      // published — a different file, written by the publication and never edited afterwards. It was
      // written and read by nothing, which left this check comparing a hash to the artifact it was
      // computed from and to the index file it lives inside: edit both together and everything
      // passes. Comparing against the aggregate is what makes that edit detectable.
      const anchor = phase.specIndex?.generation === phase.generation ? phase.specIndex : null;
      const drift = anchor && (anchor.sourceSha256 !== index.source.sha256
        || anchor.clauses !== index.clauses.length
        || (anchor.indexSha256 && index.indexSha256 && anchor.indexSha256 !== index.indexSha256));
      if (!artifact.exists || artifact.sha256 !== index.source.sha256) fail(`${phaseId} specification index is stale for ${index.source.path}`);
      else if (drift) {
        fail(`${phaseId} specification index does not match the generation recorded in the workflow: `
          + `expected ${anchor.clauses} clause(s) for source ${String(anchor.sourceSha256).slice(0, 12)}, `
          + `found ${index.clauses.length} for ${String(index.source.sha256).slice(0, 12)}`);
      }
      else passes.push(`specification clauses: ${phaseId} generation ${phase.generation} · ${index.clauses.length}`);
    }
    if (specPolicy.coverage !== 'off') {
      const coverage = evaluateSpecCoverage(records, changedRepositoryPaths(root, {
        base: workflow.phases[workflow.phaseOrder[0]]?.sourceCommit ?? workflow.workItem.baseBranch,
        target: 'HEAD'
      }), specPolicy, { root });
      const messages = [
        ...coverage.unimplemented.map((id) => `clause ${id} is not fully implemented`),
        ...coverage.unclaimedChangedPaths.map((file) => `changed path is not claimed by a clause: ${file}`),
        ...coverage.withdrawnButClaimed.map((id) => `withdrawn clause still has an observed claim: ${id}`),
        ...coverage.invalidEvidence.map((message) => `invalid clause evidence: ${message}`)
      ];
      if (coverage.severity === 'error') errors.push(...messages);
      else if (coverage.severity === 'warning') warnings.push(...messages);
      if (coverage.complete) passes.push(`clause coverage: ${coverage.totals.observed}/${coverage.totals.clauses} clauses, ${coverage.totals.changedPaths} changed paths`);
    }
    if (specPolicy.acceptance !== 'off') {
      const acceptance = evaluateSpecAcceptance(records, specPolicy, {
        workId: workflow.workItem.id,
        sourceTreeSha256: await specificationSourceTreeHash(root),
        commandSetSha256: configuredAcceptanceCommandSetSha256(specPolicy)
      });
      const messages = [
        ...acceptance.missingPlannedTests.map((id) => `clause ${id} has no planned test`),
        ...acceptance.missingObservedTests.map((id) => `clause ${id} has no observed test result`),
        ...acceptance.failedCommands.map((id) => `allowlisted acceptance command failed: ${id}`),
        ...(acceptance.missingRun ? ['no specification acceptance run is recorded'] : []),
        ...acceptance.staleRunReasons.map((reason) => `specification acceptance is stale: ${reason}`)
      ];
      if (acceptance.complete) passes.push(`specification acceptance: ${acceptance.mode}`);
      else if (specPolicy.mode === 'enforce') errors.push(...messages);
      else warnings.push(...messages);
    }
  }

  if (config.governance?.requireAcceptanceCriteriaTags) {
    const required = new Set();
    const bound = new Set();
    for (const phase of Object.values(workflow.phases).filter(phaseRequiresCodeDelivery)) {
      for (const id of phase.deliveryEvidence?.acceptanceCriteria?.required ?? []) required.add(id);
      for (const id of phase.deliveryEvidence?.acceptanceCriteria?.tagged ?? []) bound.add(id);
    }
    for (const id of required) if (!bound.has(id)) errors.push(`AC coverage: ${id} has no module test-source binding`);
    if (required.size && [...required].every((id) => bound.has(id))) passes.push(`acceptance coverage: ${required.size} namespaced criteria mapped`);
  }

  if (workflow.phases.conformance?.generation > 0) {
    const phase = workflow.phases.conformance; const reportPath = path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path); const report = await readFile(reportPath, 'utf8');
    const expected = new Set();
    for (const source of traceabilitySources(workflow)) {
      const text = await readFile(path.join(workDir(root, config, workflow.workItem.id), source.requiredArtifact.path), 'utf8').catch(() => '');
      ids(text, /\b(?:AC|SPEC)-\d+\b/g).forEach((id) => expected.add(id));
    }
    for (const id of expected) if (!report.includes(id)) errors.push(`conformance report has no row for ${id}`);
    for (const [phaseId, prior] of Object.entries(workflow.phases)) {
      for (const approval of prior.approvals.filter((item) => !item.invalidatedAt && item.selfApproval)) {
        const actor = approval.actor?.login ?? approval.actor?.email ?? approval.actor?.name;
        if (!report.includes(phaseId) || (actor && !report.includes(actor))) errors.push(`conformance report does not disclose self-approval for ${phaseId} by ${actor}`);
      }
    }
    if (!/\b(matched|partial|missing|deviated|unplanned)\b/.test(report)) errors.push('conformance report has no recognized verdict');
    const blockingVerdicts = blockingConformanceVerdicts(report);
    for (const finding of blockingVerdicts) {
      errors.push(`conformance ${finding.clauseId} remains ${finding.verdict}`);
    }
    if (phase.conformanceTree !== await sourceTreeHash(root)) errors.push('conformance report is stale: source/test tree changed after comparison');
    else passes.push(`conformance freshness: ${expected.size} traced identifiers`);
  }

  if (config.git?.publish === 'required' && terminal) {
    const remote = config.git.remote ?? 'origin'; const publicationBranch = workflowPublicationBranch(root, workflow); const remoteHead = runRemoteGit(['ls-remote', remote, `refs/heads/${publicationBranch}`], { cwd: root, operation: 'remote-probe' }).stdout.trim().split(/\s+/)[0];
    const localHead = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
    if (remoteHead !== localHead) errors.push(`terminal: local HEAD is not published to ${remote}/${publicationBranch}`);
    else passes.push('remote publication');
  }

  if (terminal) {
    for (const phaseId of workflow.phaseOrder) if (workflow.phases[phaseId]?.status !== 'approved') errors.push(`terminal: phase ${phaseId} is not approved`);
    if (workflow.status !== 'complete' || currentPhase(workflow)) errors.push('terminal: workflow is not complete'); else passes.push('terminal lifecycle');
  }
  return { errors, warnings, passes, findings: classifyStoryGateFailures(workflow, errors) };
}

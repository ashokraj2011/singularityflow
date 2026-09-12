import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  approvalRequirementsMet, matchApprovalAuthority
} from './approval-authority.mjs';
import { publishedGenerationCommit } from './generation-publication-store.mjs';
import { canonicalJson as recordCanonicalJson, recordSha256 } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import { run, secureRepositoryPath, SingularityFlowError } from './util.mjs';
import { canonicalJson, sha256 } from './world-model/canonicalize.mjs';
import { worldModelStateAuthority } from './world-model/authority-config.mjs';
import {
  assertCurrentArchitectureProjection, resolveCurrentArchitectureProjectionInputs
} from './world-model/projections/calm/authority.mjs';
import {
  validateArchitectureIntent, validateArchitectureIntentFulfilment, verifyArchitectureIntent
} from './world-model/projections/calm/projection.mjs';
import {
  readPublishedWorldModelV4, resolvePublishedWorldModelV4
} from './world-model/store.mjs';
import {
  loadCandidateSourceSnapshot, validateSourceSnapshot
} from './world-model/source/snapshot.mjs';
import { resolveStoryExecutionDefinition } from './story-execution-context.mjs';

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function gitText(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout : null;
}

function availableArchitectureProjection(store) {
  const built = store.projections?.find((entry) =>
    entry.projectionId === 'arch.calm' && entry.status === 'available');
  if (!built) {
    fail('The reusable state authority does not contain an available arch.calm projection.',
      'WMC_PROJECTION_NOT_CONFIGURED', {
        nextAction: 'singularity-flow wm build --format registered-v4 --projections arch.calm'
      });
  }
  return built;
}

function storyArchitecturePath(root, definition, workflow, name) {
  const workItemRoot = workflow?.resolution?.workItemRoot
    ?? definition?.workItemRoot ?? 'singularity/work-items';
  return path.join(root, workItemRoot, workflow.workItem.id, 'context', 'architecture', name);
}

function repositoryRelativeIntentPath(root, intentPath) {
  const relative = path.relative(root, path.resolve(intentPath)).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    fail('Architecture intent path is outside the selected Story repository.', 'WMC_INTENT_INVALID');
  }
  return relative;
}

function sameIntentBinding(left, right) {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

function jsonAtCommit(root, commit, relativePath, family = null) {
  const shown = run('git', ['show', `${commit}:${relativePath}`], {
    cwd: root, allowFailure: true
  });
  if (shown.status !== 0) return null;
  try {
    const parsed = JSON.parse(shown.stdout);
    return family ? readRecord(family, parsed).record : parsed;
  } catch { return null; }
}

function oneCommitTrailer(root, commit, name) {
  const message = gitText(root, ['show', '-s', '--format=%B', commit]);
  if (message == null) return null;
  const values = [...message.matchAll(new RegExp(`^${name}:\\s*(.+?)\\s*$`, 'gmi'))];
  return values.length === 1 ? values[0][1] : null;
}

function ancestor(root, older, newer) {
  if (!/^[a-f0-9]{40,64}$/.test(String(older ?? ''))
      || !/^[a-f0-9]{40,64}$/.test(String(newer ?? ''))) return false;
  return run('git', ['merge-base', '--is-ancestor', older, newer], {
    cwd: root, allowFailure: true
  }).status === 0;
}

function approvalDecisionPath(relativeIntentPath, phaseId, decision) {
  const suffix = '/context/architecture/architecture-intent.json';
  if (!relativeIntentPath.endsWith(suffix)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(decision?.at ?? ''))
      || decision?.decision !== 'approved') return null;
  const workRoot = relativeIntentPath.slice(0, -suffix.length);
  const safe = decision.at.replace(/[:.]/g, '-');
  return {
    workRoot,
    workflowPath: `${workRoot}/workflow.json`,
    summaryPath: `${workRoot}/approvals/${phaseId}.json`,
    decisionPath: `${workRoot}/approvals/${phaseId}/${safe}-approved.json`
  };
}

function immutableStoryCreation(root, workflow, workflowPath, approvalCommit) {
  const additions = run('git', [
    'log', '--format=%H', '--diff-filter=A', '--reverse', approvalCommit, '--', workflowPath
  ], { cwd: root, allowFailure: true }).stdout.split(/\r?\n/).filter(Boolean);
  if (additions.length !== 1 || !ancestor(root, additions[0], approvalCommit)) return null;
  const stored = jsonAtCommit(root, additions[0], workflowPath);
  if (!stored || stored.workItem?.id !== workflow.workItem?.id) return null;
  try {
    const anchor = stored.resolution?.policySha256 ?? null;
    if (anchor != null) {
      if (!/^sha256:[a-f0-9]{64}$/.test(anchor)) return null;
      const policy = structuredClone(stored.resolution);
      delete policy.policySha256;
      if (sha256(Buffer.from(canonicalJson(policy), 'utf8')) !== anchor) return null;
    }
    return Object.freeze({
      commit: additions[0],
      workflow: readRecord('story-workflow', stored).record
    });
  } catch {
    return null;
  }
}

/**
 * Reconstruct one approval from immutable Story history. Mutable aggregate approval entries are
 * presentation only: authority comes from the decision file, review packet, lifecycle event and
 * commit trailer that were published together.
 */
async function verifyArchitectureApproval(root, definition, workflow, intent, relativeIntentPath,
  binding, decision, publicationCommit) {
  const paths = approvalDecisionPath(relativeIntentPath, intent.phase, decision);
  if (!paths || !sameIntentBinding(decision.architectureIntent ?? null, binding)
      || typeof decision.reviewPacketSha256 !== 'string'
      || typeof decision.authorityGroup !== 'string') return null;
  const candidates = run('git', [
    'log', '--format=%H', 'HEAD', '--', paths.decisionPath
  ], { cwd: root, allowFailure: true }).stdout.split(/\r?\n/).filter(Boolean);
  const valid = [];
  for (const commit of candidates) {
    const storedDecision = jsonAtCommit(root, commit, paths.decisionPath);
    const historicalWorkflow = jsonAtCommit(root, commit, paths.workflowPath, 'story-workflow');
    const summary = jsonAtCommit(root, commit, paths.summaryPath, 'phase-approval');
    const historicalPhase = historicalWorkflow?.phases?.[intent.phase];
    if (!storedDecision || !historicalWorkflow || !summary || !historicalPhase
        || historicalWorkflow.workItem?.id !== intent.workId
        || recordCanonicalJson(storedDecision) !== recordCanonicalJson(decision)
        || !(historicalPhase.approvals ?? []).some((entry) =>
          recordCanonicalJson(entry) === recordCanonicalJson(decision))
        || !(summary.decisions ?? []).some((entry) =>
          recordCanonicalJson(entry) === recordCanonicalJson(decision))) continue;
    const creation = immutableStoryCreation(root, workflow, paths.workflowPath, commit);
    const creationPhase = creation?.workflow?.phases?.[intent.phase] ?? null;
    if (!creation || !creationPhase) continue;
    const authority = matchApprovalAuthority(
      creation.workflow.resolution?.approvalAuthorities ?? {},
      creationPhase.approvalPolicy ?? {}, decision.actor,
      { preferredAuthorities: [decision.authorityGroup] }
    );
    if (!authority.authorized || authority.authorityGroup !== decision.authorityGroup
        || authority.identityAssurance !== decision.identityAssurance) continue;
    const events = (historicalWorkflow.publicationProjections ?? []).map((entry) => entry.event)
      .filter((event) => event?.type === 'phase-approved'
        && event.phaseId === intent.phase
        && Number(event.generation) === Number(intent.generation)
        && recordCanonicalJson(event.actor) === recordCanonicalJson(decision.actor)
        && event.agent === decision.agent
        && event.authorityGroup === decision.authorityGroup
        && event.payload?.decision === decision.decision
        && event.payload?.reviewPacketSha256 === decision.reviewPacketSha256
        && event.payload?.evidenceCommit === decision.evidenceCommit
        && event.payload?.artifactSetSha256 === decision.artifactSetSha256);
    if (events.length !== 1) continue;
    const trailer = oneCommitTrailer(root, commit, 'Singularity-Flow-Event-SHA256');
    if (trailer !== `sha256:${recordSha256(events[0])}`) continue;
    const evidenceCommit = String(decision?.evidenceCommit ?? '');
    if (!ancestor(root, publicationCommit, evidenceCommit)
        || !ancestor(root, evidenceCommit, commit)) continue;
    let packet;
    try {
      // Import lazily because Story packet verification itself validates the architecture binding.
      // Both approval and every other review consumer therefore share one exact historical reader.
      const { readStoryReviewPacket } = await import('./story-lineage.mjs');
      packet = await readStoryReviewPacket(
        root,
        { ...definition, workItemRoot: creation.workflow.resolution?.workItemRoot
          ?? definition?.workItemRoot },
        historicalWorkflow,
        decision.reviewPacketSha256
      );
    } catch {
      continue;
    }
    if (packet.evidenceCommit !== evidenceCommit
        || packet.workId !== intent.workId
        || packet.phase !== intent.phase
        || Number(packet.generation) !== Number(intent.generation)
        || !sameIntentBinding(packet.submissionEvidence?.architectureIntent ?? null, binding)
        || decision.artifactSetSha256 !== packet.submissionEvidence?.artifactSetSha256) continue;
    valid.push({ commit, creationPhase });
  }
  return valid.length === 1 ? valid[0] : null;
}

/** The immutable binding carried by one accepted owning-phase publication. */
export function publishedArchitectureIntentBinding(phase, generation = phase?.generation) {
  return (phase?.generationPublications ?? []).find((entry) =>
    Number(entry.generation) === Number(generation))?.architectureIntent ?? null;
}

/** Validate and bind the exact canonical Story intent before accepting its owning generation. */
export async function resolveArchitectureIntentPublicationBinding(
  root, definition, workflow, phase, generation
) {
  definition = await resolveStoryExecutionDefinition(root, definition, workflow);
  const policy = workflow?.resolution?.architectureIntent ?? definition?.architectureIntent ?? {};
  if (policy.enabled !== true) return null;
  const intentPath = storyArchitecturePath(root, definition, workflow, 'architecture-intent.json');
  const relative = repositoryRelativeIntentPath(root, intentPath);
  let located;
  try {
    located = await secureRepositoryPath(root, relative, {
      label: 'Story architecture intent', mustExist: false, type: 'file'
    });
  } catch (error) {
    fail(error.message, error.code ?? 'WMC_INTENT_INVALID', { path: relative });
  }
  if (!located.entry) return null;
  let bytes;
  try { bytes = await readFile(located.absolute, 'utf8'); }
  catch (error) {
    fail(`Architecture intent is unavailable: ${error.message}`, 'WMC_INTENT_INVALID', {
      path: relative
    });
  }
  let intent;
  try { intent = validateArchitectureIntent(JSON.parse(bytes)); }
  catch (error) { fail(error.message, error.code ?? 'WMC_INTENT_INVALID', error.details ?? null); }
  if (intent.workId !== workflow.workItem.id) {
    fail('Architecture intent belongs to another Work ID.', 'WMC_INTENT_INVALID');
  }
  if (intent.phase !== phase.id) return null;
  if (!Number.isSafeInteger(generation) || generation < 1
      || intent.generation !== generation) {
    fail(
      `Architecture intent targets generation ${intent.generation}, but the next '${phase.id}' publication is generation ${generation}. Revise the intent explicitly before publishing.`,
      'WMC_INTENT_GENERATION_STALE',
      {
        phase: phase.id,
        currentPublishedGeneration: phase.generation,
        expectedGeneration: generation,
        intentGeneration: intent.generation,
        nextAction: `singularity-flow architecture intent revise --work-id ${workflow.workItem.id} --from <reviewed-json-file> --expect-intent ${intent.intentSha256}`
      }
    );
  }
  const canonicalBytes = canonicalJson(intent);
  if (bytes !== canonicalBytes) {
    fail(
      'Architecture intent bytes are not in the canonical form produced by the guarded intent command.',
      'WMC_INTENT_INVALID',
      { path: relative, nextAction: `Revise the intent with --expect-intent ${intent.intentSha256}.` }
    );
  }
  return Object.freeze({
    workId: intent.workId,
    phase: intent.phase,
    generation: intent.generation,
    path: relative,
    intentSha256: intent.intentSha256,
    blobSha256: sha256(Buffer.from(canonicalBytes, 'utf8'))
  });
}

/** Classify whether exact intent bytes are durable evidence of an approved phase generation. */
export async function architectureIntentApprovalStatus(
  root, definition, workflow, intentValue, intentPath
) {
  definition = await resolveStoryExecutionDefinition(root, definition, workflow);
  const intent = validateArchitectureIntent(intentValue);
  const errors = [];
  const intentPhase = workflow.phases?.[intent.phase];
  let approval = null;
  let approvals = [];
  let publicationBinding = null;
  let publicationCommit = null;
  let relativeIntentPath = null;
  let creationApprovalPolicy = null;
  if (!intentPhase) {
    errors.push(`architecture intent phase '${intent.phase}' is not present in the pinned Story workflow`);
  } else {
    const candidates = (intentPhase.approvals ?? []).filter((candidate) =>
      candidate.decision === 'approved'
      && !candidate.invalidatedAt
      && Number(candidate.generation) === Number(intent.generation));
    if (!candidates.length) {
      errors.push(
        `architecture intent generation ${intent.generation} has no exact phase approval evidence`
      );
    }
    try { relativeIntentPath = repositoryRelativeIntentPath(root, intentPath); }
    catch (error) { errors.push(error.message); }
    publicationBinding = publishedArchitectureIntentBinding(intentPhase, intent.generation);
    if (!publicationBinding) {
      errors.push('architecture intent has no owning generation-publication binding');
    } else if (relativeIntentPath) {
      const expected = {
        workId: intent.workId,
        phase: intent.phase,
        generation: intent.generation,
        path: relativeIntentPath,
        intentSha256: intent.intentSha256,
        blobSha256: sha256(Buffer.from(canonicalJson(intent), 'utf8'))
      };
      if (!sameIntentBinding(publicationBinding, expected)) {
        errors.push('architecture intent binding differs from its owning generation publication');
      }
      try {
        publicationCommit = publishedGenerationCommit(
          root, workflow, intentPhase, intent.generation
        );
        const committed = publicationCommit && relativeIntentPath
          ? run('git', ['show', `${publicationCommit}:${relativeIntentPath}`], {
              cwd: root, allowFailure: true
            })
          : null;
        if (!committed || committed.status !== 0
            || committed.stdout !== canonicalJson(intent)) {
          errors.push('architecture intent bytes differ from their owning generation publication');
        }
      } catch (error) {
        errors.push(`architecture intent generation publication cannot be proven: ${error.message}`);
      }
    }
    if (publicationBinding && publicationCommit && relativeIntentPath) {
      for (const candidate of candidates) {
        const verified = await verifyArchitectureApproval(
          root, definition, workflow, intent, relativeIntentPath, publicationBinding,
          candidate, publicationCommit
        );
        if (!verified) {
          errors.push('architecture intent approval is not authenticated by its lifecycle commit, review packet, and pinned authority');
          continue;
        }
        creationApprovalPolicy ??= verified.creationPhase.approvalPolicy ?? {};
        approvals.push(Object.freeze({ ...candidate, approvalCommit: verified.commit }));
      }
    }
    approval = approvals.at(-1) ?? null;
    if (!creationApprovalPolicy
        || !approvalRequirementsMet(creationApprovalPolicy, approvals)) {
      errors.push(
        `architecture intent generation ${intent.generation} has not satisfied the full approval policy for phase '${intent.phase}'`
      );
    }
  }
  return Object.freeze({
    approved: errors.length === 0,
    approval,
    approvals: Object.freeze(approvals),
    publicationBinding,
    errors: Object.freeze(errors)
  });
}

/** Refuse deterministic planned/fulfilment evaluation until the exact intent is approved. */
export async function assertApprovedArchitectureIntent(
  root, definition, workflow, intent, intentPath
) {
  const status = await architectureIntentApprovalStatus(
    root, definition, workflow, intent, intentPath
  );
  if (!status.approved) {
    fail(
      'Architecture intent is still a candidate and cannot produce a governed planned or fulfilment view.',
      'WMC_INTENT_NOT_APPROVED',
      {
        reasons: status.errors,
        nextAction: `Publish and approve phase '${intent.phase}' generation ${intent.generation}, then retry.`
      }
    );
  }
  return status;
}

async function resolveApprovedIntent(root, definition, workflow, suppliedIntent, suppliedPath) {
  if (!workflow?.workItem?.id) {
    fail('Architecture evaluation requires an exact Story.', 'WMC_INTENT_INVALID');
  }
  const intentPath = suppliedPath
    ?? storyArchitecturePath(root, definition, workflow, 'architecture-intent.json');
  const relativeIntentPath = path.relative(root, path.resolve(intentPath)).replaceAll('\\', '/');
  let located;
  try {
    located = await secureRepositoryPath(root, relativeIntentPath, {
      label: 'Story architecture intent', mustExist: true, type: 'file'
    });
  } catch (error) {
    fail(
      `Architecture intent for '${workflow.workItem.id}' is unavailable or unsafe.`,
      error.code ?? 'WMC_INTENT_INVALID',
      { path: relativeIntentPath, nextAction: 'Restore the exact Story-owned intent and retry.' }
    );
  }
  let bytes;
  try { bytes = await readFile(located.absolute, 'utf8'); }
  catch (error) {
    fail(
      `Architecture intent for '${workflow.workItem.id}' is unavailable.`,
      'WMC_INTENT_INVALID',
      { path: relativeIntentPath, nextAction: 'Restore the exact Story-owned intent and retry.' }
    );
  }
  let intent;
  try { intent = validateArchitectureIntent(JSON.parse(bytes)); }
  catch (error) { fail(error.message, error.code ?? 'WMC_INTENT_INVALID', error.details ?? null); }
  if (intent.workId !== workflow.workItem.id) {
    fail('Architecture intent belongs to another Work ID.', 'WMC_INTENT_INVALID');
  }
  if (suppliedIntent) {
    const expected = validateArchitectureIntent(suppliedIntent);
    if (expected.intentSha256 !== intent.intentSha256
        || canonicalJson(expected) !== canonicalJson(intent)) {
      fail(
        'Architecture intent changed while deterministic evidence was being resolved.',
        'WMC_INTENT_REVISION_CONFLICT',
        {
          expectedIntentSha256: expected.intentSha256,
          currentIntentSha256: intent.intentSha256,
          nextAction: `Review the current intent and rerun singularity-flow architecture intent verify --work-id ${workflow.workItem.id}.`
        }
      );
    }
  }
  // Use the caller's repository spelling for Git path derivation. On macOS `/var` and
  // `/private/var` can name the same directory; comparing the canonical filesystem spelling to
  // the non-canonical repository root would falsely classify a valid Story path as external.
  const approvalPath = path.join(root, located.relative);
  const approval = await assertApprovedArchitectureIntent(
    root, definition, workflow, intent, approvalPath
  );
  return Object.freeze({ intent, intentPath: located.absolute, approval });
}

/** Resolve and fully validate the exact historical WMB authority named by an intent. */
export function resolveArchitectureIntentBase(root, definition, intentValue) {
  const intent = validateArchitectureIntent(intentValue);
  const authority = worldModelStateAuthority(definition, {});
  const outputDir = definition.worldModel?.outputDir ?? 'singularity/world-model';
  const manifestPath = `${outputDir}/manifest.json`;
  const refs = [
    `refs/remotes/${authority.remote}/${authority.branch}`,
    `refs/heads/${authority.branch}`
  ];
  const visited = new Set();
  for (const ref of refs) {
    if (!gitText(root, ['rev-parse', '--verify', ref])) continue;
    const history = gitText(root, [
      'log', '--format=%H', '--max-count=256', ref, '--', manifestPath
    ])?.trim().split('\n').filter(Boolean) ?? [];
    for (const commit of history) {
      if (visited.has(commit)) continue;
      visited.add(commit);
      const manifestBytes = gitText(root, ['show', `${commit}:${manifestPath}`]);
      if (manifestBytes == null) continue;
      try {
        if (JSON.parse(manifestBytes).manifestSha256
            !== intent.base.worldModelManifestSha256) continue;
        // The self-declared manifest field is only a bounded prefilter. This immutable read then
        // verifies every registered dependency, projection byte, receipt and source-map binding.
        const store = readPublishedWorldModelV4(root, {
          ref: commit,
          outputDir,
          sourceVerification: 'historical-integrity'
        });
        const built = availableArchitectureProjection(store);
        if (built.projectionSha256 !== intent.base.calmProjectionSha256) continue;
        return Object.freeze({
          commit, store, projection: built.projection,
          projectionSha256: built.projectionSha256,
          sourceMap: built.sourceMap,
          unavailable: built.factSet?.unavailable ?? []
        });
      } catch (error) {
        // A matching declared identity whose underlying publication is corrupt is not equivalent
        // to an absent history entry. Preserve that integrity failure instead of searching for a
        // convenient different base with the same editable declaration.
        throw error;
      }
    }
  }
  fail(
    'The exact CALM base approved by this architecture intent is unavailable in local state history.',
    'WMC_INTENT_BASE_STALE',
    {
      worldModelManifestSha256: intent.base.worldModelManifestSha256,
      calmProjectionSha256: intent.base.calmProjectionSha256,
      nextAction: 'Fetch the configured state branch, then retry architecture intent verify.'
    }
  );
}

/** Recompute intent fulfilment from exact approved intent, historical base, and current authority. */
export async function evaluateArchitectureIntentEvidence(
  root, definition, workflow, intentValue = null, {
    intentPath = null, candidateSnapshot = null
  } = {}
) {
  definition = await resolveStoryExecutionDefinition(root, definition, workflow);
  const approved = await resolveApprovedIntent(
    root, definition, workflow, intentValue, intentPath
  );
  const intent = approved.intent;
  const before = resolveArchitectureIntentBase(root, definition, intent);
  const authority = worldModelStateAuthority(definition, {});
  const storeOptions = {
    outputDir: workflow?.resolution?.worldModelOutputDir
      ?? definition.worldModel?.outputDir ?? 'singularity/world-model',
    stateBranch: authority.branch,
    remote: authority.remote
  };
  // Resolve the authority once, then pin its immutable commit while binding an explicitly supplied
  // Candidate. Resolving a mutable state ref twice could otherwise mix the manifest from one state
  // publication with a Candidate comparison against another.
  let store = resolvePublishedWorldModelV4(root, storeOptions);
  if (candidateSnapshot != null) {
    let expectedSource;
    if (typeof candidateSnapshot === 'string') {
      expectedSource = await loadCandidateSourceSnapshot(root, candidateSnapshot, {
        scopeManifest: store.scopeManifest
      });
    } else {
      try { expectedSource = validateSourceSnapshot(candidateSnapshot); }
      catch (error) {
        fail(
          `Architecture source Candidate is invalid: ${error.message}`,
          error.code ?? 'WMB_SOURCE_SNAPSHOT_REQUIRED'
        );
      }
    }
    store = readPublishedWorldModelV4(root, {
      ref: store.commit,
      outputDir: store.outputDir,
      expectedSourceSnapshot: expectedSource
    });
  }
  const sourceFreshness = store.freshness?.source ?? store.freshness;
  if (sourceFreshness?.status !== 'fresh') {
    const unavailable = sourceFreshness?.status === 'unavailable'
      || sourceFreshness?.current == null;
    fail(
      unavailable
        ? 'The current implementation source cannot be compared exactly for architecture enforcement.'
        : 'The reusable architecture projection does not describe the current implementation source.',
      unavailable ? 'WMB_SOURCE_SNAPSHOT_REQUIRED' : 'WMB_SOURCE_SNAPSHOT_STALE',
      {
        freshness: sourceFreshness,
        nextAction: unavailable
          ? 'Commit the reviewed source or capture an explicit Candidate Snapshot, rebuild arch.calm, and retry.'
          : 'Rebuild the registered arch.calm projection from the exact current source and retry.'
      }
    );
  }
  assertCurrentArchitectureProjection(
    store, await resolveCurrentArchitectureProjectionInputs(root, definition, {
      // The accepted Story keeps the policy used to interpret this recorded authority. Compare
      // that saved policy to the projection's sealed configuration source instead of mutable
      // workflow.yml bytes that may legitimately advance for later Stories.
      configurationSourceSha256: store.records?.configurationSnapshot?.source?.sha256 ?? null
    })
  );
  const current = availableArchitectureProjection(store);
  const report = verifyArchitectureIntent({
    intent,
    baseAfter: current.projection,
    baseAfterSha256: current.projectionSha256,
    sourceMap: current.sourceMap,
    baseBefore: before.projection,
    baseBeforeSourceMap: before.sourceMap,
    unavailable: current.factSet?.unavailable ?? []
  });
  const decision = Object.freeze({
    intentSha256: intent.intentSha256,
    intentPhase: intent.phase,
    intentGeneration: intent.generation,
    approvalEvidenceCommit: approved.approval.evidenceCommit,
    beforeManifestSha256: intent.base.worldModelManifestSha256,
    beforeProjectionSha256: before.projectionSha256,
    afterAuthorityCommit: store.commit,
    afterManifestSha256: store.manifest.manifestSha256,
    afterProjectionSha256: current.projectionSha256,
    sourceManifestSha256: store.manifest.sourceManifestSha256,
    verifierProfile: 'architecture-intent-v2',
    computedReportSha256: report.reportSha256
  });
  return Object.freeze({ ...approved, before, store, current, report, decision });
}

/** Verify a stored human-readable report against the deterministic gate computation. */
export function assertArchitectureIntentReportMatches(reportValue, computedValue) {
  const report = validateArchitectureIntentFulfilment(reportValue);
  const computed = validateArchitectureIntentFulfilment(computedValue);
  if (canonicalJson(report) !== canonicalJson(computed)) {
    fail(
      'The saved architecture intent fulfilment report differs from deterministic evaluation.',
      'WMC_INTENT_REPORT_MISMATCH',
      {
        recordedReportSha256: report.reportSha256,
        computedReportSha256: computed.reportSha256,
        nextAction: 'Run singularity-flow architecture intent verify --work-id <WORK-ID> and review the regenerated report.'
      }
    );
  }
  return report;
}

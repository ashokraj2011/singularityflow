/**
 * Observe-only CMP pilot.
 *
 * This command deliberately stops before durable authoring, approval, publication, or gating. It
 * projects the existing exact RepositoryChangeSet into conservative resource regions and evaluates
 * caller-supplied diagnostic evidence. Ordinary Story delivery does not yet share one
 * universal Candidate authority with SGOS, so treating this compatibility projection as a hard
 * publication authority would create the second Candidate path CMP explicitly forbids.
 */
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';

import { branch, repoRoot } from '../git.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { buildRepositoryChangeSet } from '../repository-change-set.mjs';
import {
  buildChangeRegionManifest, evaluateComprehensionCoverage
} from '../comprehension/contracts.mjs';
import {
  buildComprehensionGraph, explainComprehensionGraph
} from '../comprehension/graph.mjs';
import { buildComprehensionReplay } from '../comprehension/replay.mjs';
import { validateComprehensionWalkthroughDraft } from '../comprehension/walkthrough.mjs';
import {
  commandResult, noEffects, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  optionBoolean, optionString, secureRepositoryPath, SingularityFlowError
} from '../util.mjs';

const MAXIMUM_EVIDENCE_BYTES = 1024 * 1024;
const MAXIMUM_EVIDENCE_RECORDS = 2000;

function activeBaseline(workflow, requestedPhase = null) {
  const phaseId = requestedPhase ?? workflow.currentPhase ?? null;
  if (!phaseId) return {
    base: workflow.workItem?.baseCommit ?? null,
    phase: null,
    source: workflow.workItem?.baseCommit ? 'story-base' : null
  };
  const phase = workflow.phases?.[phaseId];
  if (!phase) {
    throw new SingularityFlowError(`Story '${workflow.workItem?.id ?? 'unknown'}' has no phase '${phaseId}'.`, {
      code: 'CMP_PHASE_UNKNOWN'
    });
  }
  if (phase.generationIntent?.baseline?.commit) {
    return { base: phase.generationIntent.baseline.commit, phase: phaseId, source: 'generation-intent' };
  }
  const interval = workflow.workIntervals?.current;
  if (interval?.phaseId === phaseId && interval.sourceBaseCommit) {
    return { base: interval.sourceBaseCommit, phase: phaseId, source: 'work-interval' };
  }
  const deliveryBase = phase.deliveryEvidence?.baselineCommit
    ?? phase.deliveryEvidence?.changeSet?.base?.commit
    ?? phase.deliveryEvidence?.tree?.baselineCommit
    ?? null;
  if (deliveryBase) return { base: deliveryBase, phase: phaseId, source: 'delivery-evidence' };
  return {
    base: workflow.workItem?.baseCommit ?? null,
    phase: phaseId,
    source: workflow.workItem?.baseCommit ? 'story-base' : null
  };
}

async function resolveBaseline(root, options) {
  const explicit = optionString(options, 'base');
  const requestedWorkId = optionString(options, 'work-id');
  const requestedPhase = optionString(options, 'phase');
  if (explicit && !requestedWorkId && !requestedPhase) {
    return { base: explicit, source: 'explicit', workId: null, phase: null };
  }
  const reference = requestedWorkId ?? branch(root);
  const selected = resolveContext(await buildRepositorySubjectIndex(root), {
    reference,
    kind: 'story',
    required: Boolean(requestedWorkId)
  });
  if (selected) {
    const selectedBaseline = activeBaseline(selected.state, requestedPhase);
    if (explicit) {
      return {
        base: explicit,
        source: 'explicit',
        workId: selected.state.workItem.id,
        phase: selectedBaseline.phase
      };
    }
    if (selectedBaseline.base) {
      return {
        ...selectedBaseline,
        workId: selected.state.workItem.id
      };
    }
  }
  if (requestedPhase) {
    throw new SingularityFlowError(
      '--phase requires --work-id or an attached Story. For repository-only inspection, use --base without --phase.',
      { code: 'CMP_STORY_CONTEXT_REQUIRED' }
    );
  }
  return { base: 'HEAD', source: 'working-tree-head', workId: null, phase: null };
}

async function resolveReplayStory(root, options) {
  const requestedWorkId = optionString(options, 'work-id');
  const reference = requestedWorkId ?? branch(root);
  const selected = resolveContext(await buildRepositorySubjectIndex(root), {
    reference,
    kind: 'story',
    required: false
  });
  if (!selected) {
    throw new SingularityFlowError(
      requestedWorkId
        ? `No governed Story matches '${requestedWorkId}'.`
        : 'No active Story matches the current branch. Provide --work-id WORK-ID.',
      { code: 'CMP_STORY_CONTEXT_REQUIRED' }
    );
  }
  return selected.state;
}

async function repositoryJson(root, value, label) {
  if (!value) return null;
  const secured = await secureRepositoryPath(root, value, {
    label,
    mustExist: true,
    type: 'file'
  });
  let handle;
  try {
    handle = await open(secured.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new SingularityFlowError(`${label} '${secured.relative}' must remain a regular file.`, {
        code: 'CMP_EVIDENCE_INVALID'
      });
    }
    if (before.size > MAXIMUM_EVIDENCE_BYTES) {
      throw new SingularityFlowError(
        `${label} '${secured.relative}' exceeds the ${MAXIMUM_EVIDENCE_BYTES}-byte diagnostic input ceiling.`,
        { code: 'CMP_EVIDENCE_LIMIT' }
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const rebound = await secureRepositoryPath(root, secured.relative, {
      label,
      mustExist: true,
      type: 'file'
    });
    if (bytes.length > MAXIMUM_EVIDENCE_BYTES
        || before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
        || (before.ino !== 0 && rebound.entry?.ino !== before.ino)
        || (before.dev !== 0 && rebound.entry?.dev !== before.dev)) {
      throw new SingularityFlowError(`${label} '${secured.relative}' changed while it was read.`, {
        code: 'CMP_EVIDENCE_INVALID'
      });
    }
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      throw new SingularityFlowError(`${label} '${secured.relative}' cannot be a symbolic link.`, {
        code: 'CMP_EVIDENCE_INVALID'
      });
    }
    throw new SingularityFlowError(`${label} '${secured.relative}' is not valid JSON: ${error.message}`, {
      code: 'CMP_EVIDENCE_INVALID',
      cause: error
    });
  } finally {
    await handle?.close().catch(() => {});
  }
}

function evidenceCollection(value, key, label) {
  if (value == null) return [];
  const records = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray(value[key]) ? value[key] : null;
  if (records && records.length <= MAXIMUM_EVIDENCE_RECORDS) return records;
  if (records) {
    throw new SingularityFlowError(
      `${label} exceeds the ${MAXIMUM_EVIDENCE_RECORDS}-record diagnostic input ceiling.`,
      { code: 'CMP_EVIDENCE_LIMIT' }
    );
  }
  throw new SingularityFlowError(`${label} must be a JSON array or an object with a '${key}' array.`, {
    code: 'CMP_EVIDENCE_INVALID'
  });
}

async function evidenceInputs(root, options) {
  const bindingDocument = await repositoryJson(
    root,
    optionString(options, 'bindings'),
    'Comprehension bindings file'
  );
  const dispositionDocument = await repositoryJson(
    root,
    optionString(options, 'dispositions'),
    'Comprehension dispositions file'
  );
  const bundle = bindingDocument && !Array.isArray(bindingDocument) ? bindingDocument : {};
  return {
    bindings: evidenceCollection(bindingDocument, 'bindings', 'Comprehension bindings'),
    dispositions: dispositionDocument == null
      ? evidenceCollection(bundle.dispositions ?? [], 'dispositions', 'Comprehension dispositions')
      : evidenceCollection(dispositionDocument, 'dispositions', 'Comprehension dispositions'),
    causes: evidenceCollection(bundle.causes ?? [], 'causes', 'Comprehension causes'),
    decisions: evidenceCollection(bundle.decisions ?? [], 'decisions', 'Comprehension decisions'),
    transformationReceipts: evidenceCollection(
      bundle.transformationReceipts ?? [],
      'transformationReceipts',
      'Comprehension transformation receipts'
    )
  };
}

export async function run(_argv, { positionals, options, operation: suppliedOperation = null }) {
  const root = repoRoot();
  const subcommand = positionals[1] ?? 'check';
  const json = optionBoolean(options, 'json');
  if (subcommand === 'replay') {
    const ignored = ['phase', 'base', 'bindings', 'dispositions']
      .find((name) => options[name] !== undefined);
    if (ignored) {
      throw new SingularityFlowError(
        `Comprehension replay does not accept --${ignored}. Use replay phase <PHASE> for a phase focus.`,
        { code: 'CMP_REPLAY_QUERY_INVALID' }
      );
    }
    const workflow = await resolveReplayStory(root, options);
    const focusType = positionals[2] ?? 'all';
    const focusValue = positionals.slice(3).join(' ').trim() || null;
    const replay = buildComprehensionReplay(workflow, { focusType, focusValue });
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'comprehension.replay', classification: 'read' },
      outcome: succeeded('comprehension.replay-reported', {
        workId: replay.workId,
        events: replay.counts.returned,
        truncated: replay.truncated
      }),
      effects: noEffects(),
      restState: 'informational',
      data: {
        mode: 'observe-only',
        context: { repository: root, workId: replay.workId },
        replay
      }
    }), { json, restStateWhenIdle: 'informational' });
  }
  if (subcommand === 'walkthrough') {
    const action = positionals[2] ?? 'validate';
    if (action !== 'validate' || positionals.length !== 4) {
      throw new SingularityFlowError(
        'Usage: singularity-flow comprehension walkthrough validate <REPOSITORY-FILE> [--base REVISION] [--bindings FILE] [--dispositions FILE] [--json]',
        { code: 'CMP_WALKTHROUGH_SCHEMA_INVALID' }
      );
    }
    const draftLocation = await secureRepositoryPath(root, positionals[3], {
      label: 'Comprehension walkthrough draft', mustExist: true, type: 'file'
    });
    const context = { ...await resolveBaseline(root, options), repository: root };
    const changeSet = await buildRepositoryChangeSet(root, {
      baseCommit: context.base,
      subject: {
        kind: 'comprehension-observation', workId: context.workId, phase: context.phase
      }
    });
    const manifest = buildChangeRegionManifest(changeSet);
    if (manifest.regions.some((region) => [
      region.location.pathBefore, region.location.pathAfter
    ].includes(draftLocation.relative))) {
      throw new SingularityFlowError(
        `Walkthrough draft '${draftLocation.relative}' is part of the Candidate it describes. Move it to an ignored repository-local evidence path and retry.`,
        { code: 'CMP_WALKTHROUGH_DRAFT_IN_CANDIDATE' }
      );
    }
    const evidence = await evidenceInputs(root, options);
    const coverage = evaluateComprehensionCoverage({ changeSet, manifest, ...evidence });
    const graph = buildComprehensionGraph({ manifest, coverage, ...evidence });
    const draft = await repositoryJson(
      root, draftLocation.relative, 'Comprehension walkthrough draft'
    );
    const validation = validateComprehensionWalkthroughDraft(draft, { manifest, graph });
    return emitCommandResult(commandResult({
      operation: suppliedOperation
        ?? { id: 'comprehension.walkthrough.validate', classification: 'read' },
      outcome: succeeded('comprehension.walkthrough-validated', {
        status: validation.status,
        claims: validation.counts.claims,
        unavailable: validation.counts.unavailable
      }),
      effects: noEffects(),
      restState: 'informational',
      data: { mode: 'observe-only', context, validation }
    }), { json, restStateWhenIdle: 'informational' });
  }
  const context = { ...await resolveBaseline(root, options), repository: root };
  const changeSet = await buildRepositoryChangeSet(root, {
    baseCommit: context.base,
    subject: {
      kind: 'comprehension-observation',
      workId: context.workId,
      phase: context.phase
    }
  });
  const manifest = buildChangeRegionManifest(changeSet);
  if (subcommand === 'regions') {
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'comprehension.regions', classification: 'read' },
      outcome: succeeded('comprehension.regions-reported', {
        regions: manifest.counts.regions,
        granularity: manifest.granularity
      }),
      effects: noEffects(),
      restState: 'informational',
      data: { mode: 'observe-only', context, manifest }
    }), { json, restStateWhenIdle: 'informational' });
  }
  if (!['check', 'graph', 'explain'].includes(subcommand)) {
    // The command registry rejects this before loading the module. Keep the handler closed when it
    // is imported directly as well.
    throw new SingularityFlowError(`Unknown comprehension subcommand '${subcommand}'.`, {
      code: 'UNKNOWN_SUBCOMMAND'
    });
  }
  const evidence = await evidenceInputs(root, options);
  const coverage = evaluateComprehensionCoverage({ changeSet, manifest, ...evidence });
  if (subcommand === 'graph' || subcommand === 'explain') {
    const graph = buildComprehensionGraph({ manifest, coverage, ...evidence });
    if (subcommand === 'graph') {
      return emitCommandResult(commandResult({
        operation: suppliedOperation ?? { id: 'comprehension.graph', classification: 'read' },
        outcome: succeeded('comprehension.graph-reported', {
          nodes: graph.counts.nodes,
          edges: graph.counts.edges
        }),
        effects: noEffects(),
        restState: 'informational',
        data: { mode: 'observe-only', context, manifestSha256: manifest.manifestSha256, graph }
      }), { json, restStateWhenIdle: 'informational' });
    }
    const subjectType = positionals[2] ?? null;
    const subject = positionals.slice(3).join(' ').trim();
    const explanation = explainComprehensionGraph(graph, { type: subjectType, value: subject });
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'comprehension.explain', classification: 'read' },
      outcome: succeeded('comprehension.explanation-reported', {
        type: explanation.query.type,
        subject: explanation.query.value,
        status: explanation.status,
        nodes: explanation.counts.nodes
      }),
      effects: noEffects(),
      restState: 'informational',
      data: {
        mode: 'observe-only', context, manifestSha256: manifest.manifestSha256,
        candidateSha256: manifest.compatibilityCandidateSha256,
        graphSha256: graph.graphSha256, explanation
      }
    }), { json, restStateWhenIdle: 'informational' });
  }
  return emitCommandResult(commandResult({
    operation: suppliedOperation ?? { id: 'comprehension.check', classification: 'read' },
    outcome: succeeded('comprehension.coverage-reported', {
      verdict: coverage.verdict,
      unresolved: coverage.counts.unresolved
    }),
    effects: noEffects(),
    restState: 'informational',
    data: {
      mode: 'observe-only', context, manifestSha256: manifest.manifestSha256, manifest, coverage
    }
  }), { json, restStateWhenIdle: 'informational' });
}

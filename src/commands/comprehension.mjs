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
import { resolveComprehensionBaseline } from '../comprehension/context.mjs';
import {
  buildChangeRegionManifest, evaluateComprehensionCoverage
} from '../comprehension/contracts.mjs';
import {
  buildComprehensionGraph, explainComprehensionGraph
} from '../comprehension/graph.mjs';
import { buildComprehensionReplay } from '../comprehension/replay.mjs';
import {
  buildComprehensionWalkthroughDraft, revalidateComprehensionWalkthroughDraft,
  validateComprehensionWalkthroughDraft
} from '../comprehension/walkthrough.mjs';
import {
  buildBrownfieldTouchedAreaAssessment, validateHistoricalBackfillProposal
} from '../comprehension/brownfield.mjs';
import {
  commandResult, noEffects, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  optionBoolean, optionString, secureRepositoryPath, SingularityFlowError
} from '../util.mjs';

const MAXIMUM_EVIDENCE_BYTES = 1024 * 1024;
const MAXIMUM_EVIDENCE_RECORDS = 2000;

async function resolveBaseline(root, options) {
  return resolveComprehensionBaseline(root, {
    base: optionString(options, 'base'),
    workId: optionString(options, 'work-id'),
    phase: optionString(options, 'phase')
  });
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
    const expectedLength = action === 'draft' ? 3
      : action === 'validate' ? 4 : action === 'revalidate' ? 5 : null;
    if (expectedLength == null || positionals.length !== expectedLength) {
      throw new SingularityFlowError(
        'Usage: singularity-flow comprehension walkthrough draft [--base REVISION] [--json]\n'
          + '   or: singularity-flow comprehension walkthrough validate <DRAFT-FILE> [--base REVISION] [--bindings FILE] [--dispositions FILE] [--json]\n'
          + '   or: singularity-flow comprehension walkthrough revalidate <DRAFT-FILE> <PREVIOUS-VALIDATION-FILE> [--base REVISION] [--bindings FILE] [--dispositions FILE] [--json]',
        { code: 'CMP_WALKTHROUGH_SCHEMA_INVALID' }
      );
    }
    const draftLocation = action === 'draft' ? null
      : await secureRepositoryPath(root, positionals[3], {
        label: 'Comprehension walkthrough draft', mustExist: true, type: 'file'
      });
    const previousLocation = action === 'revalidate'
      ? await secureRepositoryPath(root, positionals[4], {
        label: 'Previous comprehension walkthrough validation', mustExist: true, type: 'file'
      })
      : null;
    const context = { ...await resolveBaseline(root, options), repository: root };
    const changeSet = await buildRepositoryChangeSet(root, {
      baseCommit: context.base,
      subject: {
        kind: 'comprehension-observation', workId: context.workId, phase: context.phase
      }
    });
    const manifest = buildChangeRegionManifest(changeSet);
    const candidatePaths = new Set(manifest.regions.flatMap((region) => [
      region.location.pathBefore, region.location.pathAfter
    ]).filter(Boolean));
    const circularLocation = [draftLocation, previousLocation]
      .find((location) => location && candidatePaths.has(location.relative));
    if (circularLocation) {
      throw new SingularityFlowError(
        `Walkthrough input '${circularLocation.relative}' is part of the Candidate it describes. Move it to an ignored repository-local evidence path and retry.`,
        { code: 'CMP_WALKTHROUGH_DRAFT_IN_CANDIDATE' }
      );
    }
    const evidence = await evidenceInputs(root, options);
    const coverage = evaluateComprehensionCoverage({ changeSet, manifest, ...evidence });
    const graph = buildComprehensionGraph({ manifest, coverage, ...evidence });
    const draft = action === 'draft'
      ? buildComprehensionWalkthroughDraft({ manifest, graph })
      : await repositoryJson(root, draftLocation.relative, 'Comprehension walkthrough draft');
    const validation = action === 'draft' ? null : action === 'validate'
      ? validateComprehensionWalkthroughDraft(draft, { manifest, graph })
      : revalidateComprehensionWalkthroughDraft(
        await repositoryJson(
          root, previousLocation.relative, 'Previous comprehension walkthrough validation'
        ).then((document) => document?.data?.validation ?? document),
        draft,
        { manifest, graph }
      );
    return emitCommandResult(commandResult({
      operation: suppliedOperation
        ?? { id: `comprehension.walkthrough.${action}`, classification: 'read' },
      outcome: succeeded(action === 'draft' ? 'comprehension.walkthrough-drafted'
        : action === 'validate' ? 'comprehension.walkthrough-validated'
          : 'comprehension.walkthrough-revalidated', {
        status: validation?.status ?? 'drafted',
        claims: validation?.counts?.claims ?? draft.claims.length,
        unavailable: validation?.counts?.unavailable
          ?? validation?.current?.counts?.unavailable ?? 0,
        invalidated: validation?.counts?.invalidated ?? 0,
        revalidated: validation?.counts?.revalidated ?? 0
      }),
      effects: noEffects(),
      restState: 'informational',
      data: action === 'draft'
        ? { mode: 'observe-only', context, draft }
        : { mode: 'observe-only', context, validation }
    }), { json, restStateWhenIdle: 'informational' });
  }
  if (subcommand === 'backfill') {
    if (positionals[2] !== 'validate' || positionals.length !== 4) {
      throw new SingularityFlowError(
        'Usage: singularity-flow comprehension backfill validate <PROPOSAL-FILE> '
          + '[--work-id WORK-ID] [--phase PHASE] [--base REVISION] [--json]',
        { code: 'CMP_BACKFILL_SCHEMA_INVALID' }
      );
    }
    const context = { ...await resolveBaseline(root, options), repository: root };
    const proposalLocation = await secureRepositoryPath(root, positionals[3], {
      label: 'Comprehension historical backfill proposal', mustExist: true, type: 'file'
    });
    const changeSet = await buildRepositoryChangeSet(root, {
      baseCommit: context.base,
      subject: { kind: 'comprehension-observation', workId: context.workId, phase: context.phase }
    });
    const manifest = buildChangeRegionManifest(changeSet);
    const candidatePaths = new Set(manifest.regions.flatMap((region) => [
      region.location.pathBefore, region.location.pathAfter
    ]).filter(Boolean));
    if (candidatePaths.has(proposalLocation.relative)) {
      throw new SingularityFlowError(
        `Historical backfill proposal '${proposalLocation.relative}' is part of the change set it describes. Move it to an ignored repository-local review path and retry.`,
        { code: 'CMP_BACKFILL_SCOPE_INVALID' }
      );
    }
    const proposal = await repositoryJson(
      root, proposalLocation.relative, 'Comprehension historical backfill proposal'
    );
    const validation = validateHistoricalBackfillProposal(proposal, {
      sourceRevision: changeSet.base.commit
    });
    return emitCommandResult(commandResult({
      operation: suppliedOperation
        ?? { id: 'comprehension.backfill.validate', classification: 'read' },
      outcome: succeeded('comprehension.backfill-validated', {
        status: validation.valid ? 'valid' : 'invalid',
        entries: validation.counts.entries,
        confirmed: validation.counts['historically-confirmed'],
        inferred: validation.counts['historically-inferred'],
        unknown: validation.counts.unknown
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
  if (subcommand === 'brownfield') {
    const assessment = buildBrownfieldTouchedAreaAssessment(manifest);
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'comprehension.brownfield', classification: 'read' },
      outcome: succeeded('comprehension.brownfield-reported', {
        regions: assessment.counts.regions,
        newRegions: assessment.counts['new-region'],
        touchedLegacy: assessment.counts['legacy-touched'],
        mechanicalMoves: assessment.counts['mechanical-move-candidate']
      }),
      effects: noEffects(),
      restState: 'informational',
      data: { mode: 'observe-only', context, manifestSha256: manifest.manifestSha256, assessment }
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

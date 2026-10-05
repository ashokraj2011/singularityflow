/** Bounded, model-free comprehension projection for an explicitly leased IDE surface. */
import { branch } from '../git.mjs';
import { readCachedAstSymbols } from '../ast-intelligence.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { SingularityFlowError } from '../util.mjs';
import { buildBrownfieldTouchedAreaAssessment } from './brownfield.mjs';
import { buildComprehensionChangeSet, comprehensionDiffOptions, comprehensionPathContext } from './code-scope.mjs';
import { buildChangeRegionManifest, evaluateComprehensionCoverage } from './contracts.mjs';
import { resolveComprehensionBaseline } from './context.mjs';
import { buildComprehensionDiffPreview } from './diff-preview.mjs';
import { buildComprehensionEvidenceProjection } from './evidence-projection.mjs';
import { buildComprehensionGraph } from './graph.mjs';
import { buildComprehensionReplay } from './replay.mjs';
import { comprehensionSourceReferences } from './source-expansion.mjs';
import { buildComprehensionWalkthroughDraft } from './walkthrough.mjs';
import { buildCodeExplanation } from './code-explanation.mjs';
import { readStoryClauseSources } from './xpl2/clause-sources.mjs';
import { explainXpl2Subject } from './xpl2/subjects.mjs';

/**
 * Construct one coherent read projection from the same contracts used by `comprehension` CLI.
 * Empty evidence is intentional: the panel may report what is unavailable, but cannot invent or
 * promote an unreviewed cause, disposition, test result, or structural fact into authority.
 */
async function loadComprehensionIdeSliceOnce(root, {
  base = null, workId = null, phase = null, includeExplanationInputs = false
} = {}) {
  const subjectIndex = await buildRepositorySubjectIndex(root);
  const context = {
    ...await resolveComprehensionBaseline(root, {
      subjectIndex, base, workId, phase
    }), repository: root
  };
  const observationSubject = {
    kind: 'comprehension-observation',
    workId: context.workId,
    phase: context.phase
  };
  // Only application code is explained; Singularity Flow's own records are counted in codeScope.
  const pathContext = await comprehensionPathContext(root);
  const { changeSet, hidden } = await buildComprehensionChangeSet(root, {
    baseCommit: context.base,
    subject: observationSubject
  }, pathContext);
  const manifest = buildChangeRegionManifest(changeSet);
  const sourceReferences = manifest.regions.flatMap((region) =>
    comprehensionSourceReferences(manifest, region).map((reference) => ({
      regionId: reference.regionId,
      regionSha256: reference.regionSha256,
      side: reference.side,
      path: reference.path,
      fileType: reference.fileType,
      ref: reference.ref,
      referenceSha256: reference.referenceSha256
    })));
  const brownfield = buildBrownfieldTouchedAreaAssessment(manifest);
  const diff = buildComprehensionDiffPreview(root, changeSet, comprehensionDiffOptions(changeSet, hidden));
  const emptyEvidence = {
    bindings: [], dispositions: [], causes: [], decisions: [], transformationReceipts: []
  };
  const coverage = evaluateComprehensionCoverage({ changeSet, manifest, ...emptyEvidence });
  const graph = buildComprehensionGraph({ manifest, coverage, ...emptyEvidence });
  let structure;
  try {
    structure = await readCachedAstSymbols(root, {
      paths: manifest.regions.flatMap((region) => [
        region.location?.pathAfter ?? region.location?.pathBefore
      ].filter(Boolean)),
      maximumSymbols: 500
    });
  } catch (error) {
    structure = {
      schemaVersion: 1, kind: 'ast-cached-symbol-projection', authoritative: false,
      lifecycleGate: false, status: 'unavailable', reason: error?.code ?? 'ast-cache-read-unavailable',
      assurance: 'unavailable', symbols: [],
      counts: { requestedPaths: manifest.regions.length, selectedPaths: 0, cacheHits: 0, cacheMisses: 0, symbols: 0 },
      truncated: false, projectionSha256: null
    };
  }

  let draft = null;
  let draftUnavailableReason = null;
  if (manifest.regions.length) {
    try { draft = buildComprehensionWalkthroughDraft({ manifest, graph }); }
    catch (error) { draftUnavailableReason = error?.code ?? 'CMP_WALKTHROUGH_UNAVAILABLE'; }
  } else {
    draftUnavailableReason = 'CMP_NO_CHANGE_REGIONS';
  }

  let replay = null;
  let selectedWorkflow = null;
  if (context.workId) {
    const selected = resolveContext(subjectIndex, {
      reference: context.workId,
      kind: 'story',
      required: true
    });
    selectedWorkflow = selected.state;
    replay = buildComprehensionReplay(selectedWorkflow);
  }
  const evidence = buildComprehensionEvidenceProjection({
    workflow: selectedWorkflow, phaseId: context.phase, manifest
  });
  const codeExplanation = buildCodeExplanation({
    context, manifest, diff, structure, evidence, graph, codeScope: { hidden }
  });
  // The Change Explorer view is built from exactly the same inputs, inside the same capture, so
  // the map, inventory, inspector and CLI subject views describe one snapshot [XPL2-REQ-004].
  // It is optional: a failure is reported as unavailable and never blocks the rest of the slice.
  let explanationView = null;
  let explanationViewUnavailableReason = null;
  let clauseSources = null;
  try {
    clauseSources = await readStoryClauseSources(root, selectedWorkflow);
    explanationView = explainXpl2Subject({
      context, manifest, codeExplanation, evidence, workflow: selectedWorkflow,
      clauseSources, replay, sourceReferences, codeScope: { hidden }
    }, { subject: 'change' });
  } catch (error) {
    explanationViewUnavailableReason = error?.code ?? 'XPL2_VIEW_UNAVAILABLE';
  }

  // The patch and cached navigation hints are read after the change-set record. Re-read the exact
  // baseline-to-worktree subject before releasing the slice; a concurrent editor change must
  // retry the whole projection rather than combine two repository moments under one digest.
  const { changeSet: revalidatedChangeSet } = await buildComprehensionChangeSet(root, {
    baseCommit: context.base,
    subject: observationSubject
  }, pathContext);
  if (revalidatedChangeSet.digest !== changeSet.digest) {
    throw new SingularityFlowError(
      'Repository changes moved while the comprehension snapshot was being read. Refresh and retry.',
      { code: 'CMP_SNAPSHOT_CHANGED' }
    );
  }

  // CLI subject views rebuild from these exact inputs. They stay out of the serialized IDE
  // snapshot, which carries only the computed view.
  const explanationInputs = includeExplanationInputs
    ? { workflow: selectedWorkflow, clauseSources, codeScope: { hidden } }
    : undefined;

  return {
    ...(explanationInputs ? { explanationInputs } : {}),
    schemaVersion: 1, // schema-transient: leased, read-only IDE projection; never persisted
    kind: 'comprehension-ide-slice',
    mode: 'observe-only',
    authoritative: false,
    lifecycleGate: false,
    context,
    codeScope: { hidden },
    manifest,
    sourceReferences,
    brownfield,
    diff,
    coverage,
    graph,
    structure,
    evidence,
    codeExplanation,
    explanationView,
    explanationViewUnavailableReason,
    walkthrough: {
      draft,
      unavailableReason: draft ? null : draftUnavailableReason
    },
    replay,
    summary: {
      regions: manifest.counts.regions,
      materialRegions: coverage.counts.materialRegions,
      explained: coverage.counts.explained,
      unresolved: coverage.counts.unresolved,
      causes: graph.counts.causes,
      edges: graph.counts.edges,
      symbols: structure.counts.symbols,
      replayEvents: replay?.counts?.returned ?? 0,
      newRegions: brownfield.counts['new-region'],
      legacyTouched: brownfield.counts['legacy-touched'],
      mechanicalMoveCandidates: brownfield.counts['mechanical-move-candidate'],
      sourceReferences: sourceReferences.length,
      explanationUnits: codeExplanation.counts.explanationUnits,
      opaqueExplanationUnits: codeExplanation.counts.opaqueUnits,
      hiddenSingularityEntries: hidden.entries
    },
    availability: {
      structure: structure.status,
      causeGraph: graph.availability.causeGraph,
      durableAuthority: graph.availability.durableAuthority,
      diff: diff.status,
      walkthrough: draft ? 'available' : 'unavailable',
      replay: replay ? 'available' : 'unavailable',
      evidence: evidence.status,
      brownfield: 'available',
      source: sourceReferences.length ? 'available' : 'not-applicable',
      codeExplanation: codeExplanation.status,
      explanationView: explanationView ? 'available' : 'unavailable'
    }
  };
}

/** Build a coherent leased slice, retrying once when an editor changes the repository mid-read. */
export async function loadComprehensionIdeSlice(root, options = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await loadComprehensionIdeSliceOnce(root, options); }
    catch (error) {
      if (error?.code !== 'CMP_SNAPSHOT_CHANGED' || attempt === 1) throw error;
    }
  }
  throw new SingularityFlowError('Unable to capture a stable comprehension snapshot.', {
    code: 'CMP_SNAPSHOT_CHANGED'
  });
}

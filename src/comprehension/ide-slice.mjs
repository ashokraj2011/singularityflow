/** Bounded, model-free comprehension projection for an explicitly leased IDE surface. */
import { branch } from '../git.mjs';
import { readCachedAstSymbols } from '../ast-intelligence.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { buildRepositoryChangeSet } from '../repository-change-set.mjs';
import { buildBrownfieldTouchedAreaAssessment } from './brownfield.mjs';
import { buildChangeRegionManifest, evaluateComprehensionCoverage } from './contracts.mjs';
import { resolveComprehensionBaseline } from './context.mjs';
import { buildComprehensionDiffPreview } from './diff-preview.mjs';
import { buildComprehensionEvidenceProjection } from './evidence-projection.mjs';
import { buildComprehensionGraph } from './graph.mjs';
import { buildComprehensionReplay } from './replay.mjs';
import { comprehensionSourceReferences } from './source-expansion.mjs';
import { buildComprehensionWalkthroughDraft } from './walkthrough.mjs';

/**
 * Construct one coherent read projection from the same contracts used by `comprehension` CLI.
 * Empty evidence is intentional: the panel may report what is unavailable, but cannot invent or
 * promote an unreviewed cause, disposition, test result, or structural fact into authority.
 */
export async function loadComprehensionIdeSlice(root) {
  const subjectIndex = await buildRepositorySubjectIndex(root);
  const context = {
    ...await resolveComprehensionBaseline(root, { subjectIndex }), repository: root
  };
  const changeSet = await buildRepositoryChangeSet(root, {
    baseCommit: context.base,
    subject: {
      kind: 'comprehension-observation',
      workId: context.workId,
      phase: context.phase
    }
  });
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
  const diff = buildComprehensionDiffPreview(root, changeSet);
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

  return {
    schemaVersion: 1, // schema-transient: leased, read-only IDE projection; never persisted
    kind: 'comprehension-ide-slice',
    mode: 'observe-only',
    authoritative: false,
    lifecycleGate: false,
    context,
    manifest,
    sourceReferences,
    brownfield,
    diff,
    coverage,
    graph,
    structure,
    evidence,
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
      sourceReferences: sourceReferences.length
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
      source: sourceReferences.length ? 'available' : 'not-applicable'
    }
  };
}

/** Bounded, model-free comprehension projection for an explicitly leased IDE surface. */
import { branch } from '../git.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { buildRepositoryChangeSet } from '../repository-change-set.mjs';
import { buildChangeRegionManifest, evaluateComprehensionCoverage } from './contracts.mjs';
import { resolveComprehensionBaseline } from './context.mjs';
import { buildComprehensionGraph } from './graph.mjs';
import { buildComprehensionReplay } from './replay.mjs';
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
  const emptyEvidence = {
    bindings: [], dispositions: [], causes: [], decisions: [], transformationReceipts: []
  };
  const coverage = evaluateComprehensionCoverage({ changeSet, manifest, ...emptyEvidence });
  const graph = buildComprehensionGraph({ manifest, coverage, ...emptyEvidence });

  let draft = null;
  let draftUnavailableReason = null;
  if (manifest.regions.length) {
    try { draft = buildComprehensionWalkthroughDraft({ manifest, graph }); }
    catch (error) { draftUnavailableReason = error?.code ?? 'CMP_WALKTHROUGH_UNAVAILABLE'; }
  } else {
    draftUnavailableReason = 'CMP_NO_CHANGE_REGIONS';
  }

  let replay = null;
  if (context.workId) {
    const selected = resolveContext(subjectIndex, {
      reference: context.workId,
      kind: 'story',
      required: true
    });
    replay = buildComprehensionReplay(selected.state);
  }

  return {
    schemaVersion: 1, // schema-transient: leased, read-only IDE projection; never persisted
    kind: 'comprehension-ide-slice',
    mode: 'observe-only',
    authoritative: false,
    lifecycleGate: false,
    context,
    manifest,
    coverage,
    graph,
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
      replayEvents: replay?.counts?.returned ?? 0
    },
    availability: {
      structure: graph.availability.structure,
      causeGraph: graph.availability.causeGraph,
      durableAuthority: graph.availability.durableAuthority,
      walkthrough: draft ? 'available' : 'unavailable',
      replay: replay ? 'available' : 'unavailable'
    }
  };
}

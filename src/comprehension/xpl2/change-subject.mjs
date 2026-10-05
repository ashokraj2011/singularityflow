/**
 * XPL2 `change` universe: one cited, typed explanation of the captured change interval.
 *
 * Pure: every input is an already-loaded, already-validated comprehension projection from one
 * leased snapshot (manifest, bounded diff, cached structure, cause graph, recorded delivery
 * evidence, Story state, clause sources and replay). It reuses the existing code-explanation unit
 * enumeration rather than re-deriving hunks, so H-/O- identities stay exactly those of
 * `explain code`. No fact is inferred from a filename, adjacency or chronology: a clause is linked
 * to code only by a recorded region-level cause reference, and a test only by its own declared tag.
 */
import { createHash } from 'node:crypto';

import { createXpl2Builder } from './model.mjs';

export const XPL2_CHANGE_ADAPTER = 'xpl2.adapter.change@1';

const INITIAL_GRAPH_NODES = 40;

function hex12(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function unitPath(unit) {
  return unit.location?.pathAfter ?? unit.location?.pathBefore ?? 'unknown path';
}

function diffReason(reason) {
  const text = String(reason ?? '');
  if (/integrity|binding/iu.test(text)) return 'integrity-failed';
  if (/large|limit|bytes|budget|bound/iu.test(text)) return 'bounded-delivery';
  if (/no-change-regions/iu.test(text)) return 'not-applicable';
  return 'source-inaccessible';
}

const FILE_TYPES = new Set(['regular-file', 'symlink', 'gitlink', 'missing']);

function fileTypes(region) {
  const type = (value) => FILE_TYPES.has(value) ? value : null;
  return { before: type(region?.location?.fileTypeBefore), after: type(region?.location?.fileTypeAfter) };
}

function fileModes(region) {
  const mode = (value) => typeof value === 'string' && /^[0-7]{6}$/u.test(value) && value !== '000000' ? value : null;
  return { before: mode(region?.location?.modeBefore), after: mode(region?.location?.modeAfter) };
}

function operationValue(operation) {
  return ['added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed', 'mode-changed'].includes(operation)
    ? operation : 'changed';
}

function identifier(value, fallback) {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9:._@/+-]{0,199}$/u.test(text) ? text : fallback;
}

function opaqueReason(unit) {
  if (unit.unitKind === 'untracked-region-opaque') return 'untracked-content-excluded';
  // Binary and mode-only content genuinely has no text hunk. Any other opacity is a projection
  // limit of this snapshot, and says so instead of describing a text file as non-text.
  return unit.opacity?.reason === 'tracked-file-has-no-text-hunks' ? 'opaque-content' : 'text-projection-unavailable';
}

/** The delivery record describes the published generation; it is current only for the same change set. */
function deliveryApplicability(delivery, manifest) {
  const digest = delivery?.changeSet?.digest ?? null;
  if (!digest) return 'unknown';
  return digest === manifest.changeSetSha256 ? 'current' : 'stale';
}

/**
 * Build the complete change universe. `sourceReferences` are the slice's opaque exact-source
 * references; they let a UI ask the existing source owner for exact bytes by handle.
 */
export function buildChangeExplanationUniverse({
  context = {},
  manifest,
  codeExplanation,
  evidence = null,
  workflow = null,
  clauseSources = null,
  replay = null,
  sourceReferences = [],
  includeAllDeclaredClauses = false,
  codeScope = null
}) {
  const b = createXpl2Builder();
  const truth = manifest.sourceKind === 'repository-change-set'
    ? 'working-tree-observation' : 'repository-tree-comparison';
  const units = codeExplanation.whyEachChange;
  const phaseId = context.phase ?? null;
  const phase = phaseId ? workflow?.phases?.[phaseId] ?? null : null;
  const delivery = phase?.deliveryEvidence ?? null;

  // ---- Admitted sources ---------------------------------------------------------------------
  b.source({
    id: 'SRC-MANIFEST', label: 'Change-region manifest', owner: 'cmp.change-region-manifest',
    family: 'comprehension-change-region-manifest', recordId: manifest.compatibilityCandidateSha256,
    digest: manifest.manifestSha256, integrity: 'verified', origin: 'observed-local',
    applicability: 'current', availability: 'present',
    coverage: { scope: 'baseline-to-capture', regions: manifest.regions.length, complete: true }
  });
  const diffAvailable = codeExplanation.availability.diff.status === 'available';
  if (diffAvailable) {
    b.source({
      id: 'SRC-DIFF', label: 'Bounded Git patch', owner: 'cmp.diff-preview', family: 'comprehension-diff-preview',
      digest: codeExplanation.sources.diffPreviewSha256, integrity: 'verified', origin: 'observed-local',
      applicability: 'current', availability: 'present', coverage: { scope: 'tracked-text', complete: true }
    });
  } else {
    b.observation({
      id: 'OBS-DIFF', adapter: 'cmp.diff-preview', scope: 'tracked changes in this capture',
      completeness: 'unavailable', reason: codeExplanation.whyEachChange.length === 0 ? 'not-applicable'
        : diffReason(codeExplanation.availability.diff.reason)
    });
  }
  // A cache projection can be integrity-valid yet hold no usable symbol; availability decides.
  const structureDigest = ['available', 'partial'].includes(codeExplanation.availability.structure.status)
    ? codeExplanation.sources.cachedStructureSha256 : null;
  if (structureDigest) {
    b.source({
      id: 'SRC-STRUCTURE', label: 'Cached AST symbols', owner: 'ast.cached-symbols', family: 'ast-cached-symbol-projection',
      digest: structureDigest, integrity: 'verified', origin: 'observed-local',
      applicability: 'current', availability: 'present', coverage: { scope: 'changed paths with a warm cache', complete: false }
    });
  } else {
    b.observation({
      id: 'OBS-STRUCTURE', adapter: 'ast.cached-symbols', scope: 'changed paths',
      completeness: 'unavailable', reason: 'source-not-recorded'
    });
  }
  const graphDigest = codeExplanation.sources.graphSha256;
  const referencedUnits = units.filter((unit) => unit.cause?.references?.length);
  if (graphDigest) {
    b.source({
      id: 'SRC-GRAPH', label: 'Comprehension cause graph', owner: 'cmp.intent-graph', family: 'comprehension-intent-graph',
      digest: graphDigest, integrity: 'verified', origin: 'recorded-local', applicability: 'current', availability: 'present',
      coverage: { scope: 'causes supplied to this snapshot', complete: true, references: referencedUnits.length }
    });
  }
  // A complete-but-empty cause set is still only "none returned here", not "no reason exists".
  b.observation({
    id: 'OBS-CAUSE', adapter: 'cmp.intent-graph', scope: 'exact hunk-bound cause records in this snapshot',
    completeness: graphDigest ? 'complete-for-scope' : 'unavailable',
    reason: referencedUnits.length ? 'region-only-association' : 'source-not-recorded'
  });
  b.observation({
    id: 'OBS-ADMISSION', adapter: 'none', scope: 'admission evaluation for this subject',
    completeness: 'unavailable', reason: 'evaluation-unavailable'
  });
  b.observation({
    id: 'OBS-IMPACT', adapter: 'none', scope: 'repository impact for this subject',
    completeness: 'unavailable', reason: 'adapter-unavailable'
  });
  b.observation({
    id: 'OBS-PROVENANCE', adapter: 'none', scope: 'observed writes and invocation associations',
    completeness: 'unavailable', reason: 'adapter-unavailable'
  });

  let deliveryCitation = null;
  let deliveryLimits = [];
  if (evidence?.status === 'available' && delivery) {
    deliveryCitation = 'SRC-DELIVERY';
    const applicability = deliveryApplicability(delivery, manifest);
    // A delivery record describes the change set it was recorded for. When that is not this
    // capture its facts stay visible but every dependent statement carries the scope mismatch.
    deliveryLimits = applicability === 'current' ? [] : ['source-scope-mismatch'];
    b.source({
      id: deliveryCitation, label: `${phaseId} delivery record`, owner: 'story.delivery-evidence',
      family: 'comprehension-recorded-evidence', recordId: `${identifier(context.workId, 'story')}:${phaseId}`,
      digest: evidence.evidenceProjectionSha256, integrity: 'self-hashed', origin: 'recorded-local',
      applicability, availability: 'present',
      coverage: {
        scope: `${phaseId} generation ${evidence.generation ?? 'unknown'}`,
        complete: !evidence.truncated, testExecutions: evidence.counts.testExecutions
      }
    });
  } else {
    b.observation({
      id: 'OBS-DELIVERY', adapter: 'story.delivery-evidence', scope: 'recorded delivery evidence for the selected phase',
      completeness: 'unavailable',
      reason: !context.workId ? 'no-active-story' : evidence?.reason === 'phase-unavailable' ? 'source-scope-mismatch' : 'source-not-recorded'
    });
  }

  let welState = 'not-evaluated';
  let welReason = 'no-active-story';
  if (workflow) {
    const wel = workflow.resolution?.wel ?? null;
    welState = wel?.mode === 'observe' ? 'observe' : 'off';
    welReason = wel?.mode === 'observe' ? 'adapter-unavailable' : 'feature-disabled';
    b.source({
      id: 'SRC-STORY', label: 'Story lifecycle state', owner: 'story.workflow-state', family: 'story-workflow',
      recordId: identifier(context.workId, 'story'), integrity: 'unverified', origin: 'recorded-local',
      applicability: 'current', availability: 'present', coverage: { scope: 'selected Story', complete: true }
    });
  }
  b.observation({
    id: 'OBS-WEL', adapter: 'wel.enrollment', scope: 'witness insights for this Story',
    completeness: 'complete-for-scope', reason: welReason
  });
  b.observation({
    id: 'OBS-PE', adapter: 'none', scope: 'prompt envelope and tool-trace capture',
    completeness: 'unavailable', reason: 'adapter-unavailable'
  });

  const specificationCitations = new Map();
  for (const [index, artifact] of (clauseSources?.artifacts ?? []).entries()) {
    const id = `SRC-SPEC-${String(index + 1).padStart(2, '0')}`;
    if (artifact.status === 'read' || artifact.status === 'invalid') {
      b.source({
        id, label: `Specification ${artifact.path}`, owner: 'story.specification-artifact', family: 'specification-artifact',
        recordId: artifact.path, digest: artifact.digest,
        integrity: artifact.status === 'read' ? 'verified' : 'failed', origin: 'recorded-local',
        applicability: 'current', availability: 'present',
        coverage: { scope: artifact.phase, complete: artifact.reason == null, clauses: artifact.clauses.length }
      });
      if (artifact.status === 'read') specificationCitations.set(artifact.path, id);
    } else {
      b.observation({
        id: `OBS-SPEC-${String(index + 1).padStart(2, '0')}`, adapter: 'story.specification-artifact',
        scope: `specification artifact named by ${artifact.phase}`, completeness: 'unavailable', reason: artifact.reason
      });
    }
  }
  if (replay) {
    b.source({
      id: 'SRC-REPLAY', label: 'Normalized Story history', owner: 'cmp.story-replay', family: 'comprehension-story-replay',
      digest: replay.replaySha256, integrity: 'self-hashed', origin: 'recorded-local', applicability: 'current',
      availability: 'present', coverage: { scope: 'Story history', complete: !replay.truncated, events: replay.counts.matched }
    });
  }

  const unitCites = diffAvailable ? ['SRC-DIFF', 'SRC-MANIFEST'] : ['SRC-MANIFEST'];

  // ---- Inventory: files and units --------------------------------------------------------------
  const referencesByRegion = new Map();
  for (const reference of sourceReferences) {
    const bucket = referencesByRegion.get(reference.regionSha256) ?? {};
    bucket[reference.side] = reference.ref;
    referencesByRegion.set(reference.regionSha256, bucket);
  }
  const roles = new Map((evidence?.regions ?? []).map((region) => [region.regionSha256, region.roles]));
  const regionBySha = new Map((manifest.regions ?? []).map((region) => [region.regionSha256, region]));
  const files = [];
  const fileByRegion = new Map();
  for (const unit of units) {
    let file = fileByRegion.get(unit.regionSha256);
    if (!file) {
      file = {
        fileId: `file:${hex12(unit.regionSha256)}`,
        path: unitPath(unit),
        pathBefore: unit.location?.pathBefore ?? null,
        pathAfter: unit.location?.pathAfter ?? null,
        operation: unit.operation,
        regionId: unit.regionId,
        regionSha256: unit.regionSha256,
        unitIds: [],
        hunks: 0,
        opaque: 0,
        roles: roles.get(unit.regionSha256) ?? [],
        fileType: fileTypes(regionBySha.get(unit.regionSha256)),
        mode: fileModes(regionBySha.get(unit.regionSha256)),
        sources: referencesByRegion.get(unit.regionSha256) ?? {}
      };
      fileByRegion.set(unit.regionSha256, file);
      files.push(file);
    }
    file.unitIds.push(unit.unitId);
    if (unit.unitKind === 'diff-hunk') file.hunks += 1; else file.opaque += 1;
  }
  for (const file of files) {
    b.node({
      id: file.fileId, kind: 'file', label: file.path, cites: ['SRC-MANIFEST'],
      detail: { operation: file.operation, hunks: file.hunks, opaque: file.opaque, roles: file.roles }
    });
    // Recorded file type and mode are facts of the manifest; a link or gitlink target shown as a
    // one-line text hunk must not read as ordinary file content [XPL2-AC-027].
    const { before, after } = file.fileType;
    const special = [before, after].some((type) => type === 'symlink' || type === 'gitlink');
    if (before && after && (special || (before !== after && before !== 'missing' && after !== 'missing'))) {
      b.statement({
        about: file.fileId, template: 'xpl2.file-type@1', cites: ['SRC-MANIFEST'],
        arguments: { path: file.path, before, after }
      });
    }
    if (file.mode.before && file.mode.after && file.mode.before !== file.mode.after && before === after) {
      b.statement({
        about: file.fileId, template: 'xpl2.mode-change@1', cites: ['SRC-MANIFEST'],
        arguments: { path: file.path, before: file.mode.before, after: file.mode.after }
      });
    }
  }

  const unitStatements = new Map();
  const inventoryUnits = [];
  for (const unit of units) {
    const file = fileByRegion.get(unit.regionSha256);
    const nodeId = `unit:${unit.unitId}`;
    b.node({
      id: nodeId, kind: 'unit', label: unit.unitId, status: unit.explanationStatus, cites: unitCites,
      detail: { file: file.fileId, unitKind: unit.unitKind }
    });
    b.relationship({
      type: 'file-contains-unit', from: file.fileId, to: nodeId, scope: 'captured-diff', cites: unitCites
    });
    const statement = unit.hunk
      ? b.statement({
        about: nodeId, template: 'xpl2.hunk@1', cites: unitCites,
        arguments: {
          unitId: unit.unitId, path: unitPath(unit), operation: operationValue(unit.operation),
          beforeStart: unit.hunk.before.start, beforeLines: unit.hunk.before.lines,
          afterStart: unit.hunk.after.start, afterLines: unit.hunk.after.lines
        }
      })
      : b.statement({
        about: nodeId, template: 'xpl2.opaque-unit@1', cites: unitCites,
        arguments: { unitId: unit.unitId, path: unitPath(unit), unitKind: identifier(unit.unitKind, 'opaque'), reason: opaqueReason(unit) }
      });
    unitStatements.set(unit.unitId, statement);
    for (const symbol of unit.declarations ?? []) {
      if (!structureDigest) break;
      b.statement({
        about: nodeId, template: 'xpl2.declaration-overlap@1', cites: ['SRC-STRUCTURE', ...unitCites],
        arguments: {
          unitId: unit.unitId, symbol: symbol.qualifiedName ?? symbol.name,
          declarationKind: identifier(symbol.declarationKind, 'symbol'), line: symbol.line,
          assurance: identifier(symbol.assurance, 'text')
        }
      });
    }
    inventoryUnits.push({
      unitId: unit.unitId,
      nodeId,
      fileId: file.fileId,
      unitKind: unit.unitKind,
      explanationStatus: unit.explanationStatus,
      path: unitPath(unit),
      pathBefore: unit.location?.pathBefore ?? null,
      pathAfter: unit.location?.pathAfter ?? null,
      operation: unit.operation,
      hunk: unit.hunk,
      opacity: unit.opacity,
      opaqueReason: unit.hunk ? null : opaqueReason(unit),
      declarations: (unit.declarations ?? []).map((symbol) => ({
        name: symbol.qualifiedName ?? symbol.name, line: symbol.line, assurance: symbol.assurance
      })),
      regionSha256: unit.regionSha256,
      explanationUnitSha256: unit.explanationUnitSha256
    });
  }

  // ---- Intent: clauses (declared text, delivery requirement, region association) -------------
  const clauseNodes = new Map();
  const clauseNode = (clauseId, cites, status = null) => {
    const id = `clause:${identifier(clauseId, hex12(clauseId))}`;
    if (!clauseNodes.has(clauseId)) {
      clauseNodes.set(clauseId, id);
      b.node({ id, kind: 'clause', label: clauseId, status, cites });
    }
    return id;
  };
  // Every admitted declaration is kept. Two admitted sources that disagree about one clause stay a
  // visible conflict; XPL2 never picks the convenient one [XPL2-AC-031].
  const declaredClauses = new Map();
  for (const artifact of clauseSources?.artifacts ?? []) {
    const citation = specificationCitations.get(artifact.path);
    if (!citation) continue;
    for (const clause of artifact.clauses) {
      const bucket = declaredClauses.get(clause.id) ?? [];
      if (!bucket.some((entry) => entry.bodySha256 === clause.bodySha256 && entry.path === artifact.path)) {
        bucket.push({ ...clause, path: artifact.path, citation });
      }
      declaredClauses.set(clause.id, bucket);
    }
  }
  const associatedClauseIds = new Set();
  for (const unit of referencedUnits) {
    for (const reference of unit.cause.references) associatedClauseIds.add(reference.causeId);
  }
  const deliveryRequired = new Set(evidence?.acceptance?.required ?? []);
  const deliveryMissing = new Set(evidence?.acceptance?.missing ?? []);
  const bindings = Array.isArray(delivery?.acceptanceCriteria?.bindings) ? delivery.acceptanceCriteria.bindings : [];
  const boundClauseIds = new Set(bindings.map((binding) => binding.clauseId).filter(Boolean));
  // The Intent column is bounded to clauses this change or its delivery record actually names. An
  // explicit clause query may still read any declared clause: association need not imply change.
  const relevantClauseIds = [...new Set([
    ...associatedClauseIds, ...deliveryRequired, ...boundClauseIds,
    ...(includeAllDeclaredClauses || declaredClauses.size <= INITIAL_GRAPH_NODES ? declaredClauses.keys() : [])
  ])].sort();
  const clauseStatements = new Map();
  for (const clauseId of relevantClauseIds) {
    const declarations = declaredClauses.get(clauseId) ?? [];
    const conflicting = new Set(declarations.map((entry) => entry.bodySha256)).size > 1;
    // Every relevant clause comes from a declaration, the delivery record or a graph reference,
    // so one of these admitted sources always exists for it.
    const cites = declarations.length ? [...new Set(declarations.map((entry) => entry.citation))]
      : deliveryCitation && (deliveryRequired.has(clauseId) || boundClauseIds.has(clauseId)) ? [deliveryCitation]
        : ['SRC-GRAPH'];
    const nodeId = clauseNode(clauseId, cites,
      conflicting ? 'conflicting-declarations' : declarations.length ? 'declared' : 'not-declared-here');
    const ids = [];
    for (const declared of declarations) {
      ids.push(b.statement({
        about: nodeId, template: 'xpl2.clause-declared@1', cites: [declared.citation],
        arguments: { clauseId, sourcePath: declared.path, line: declared.line ?? 0, text: declared.body },
        limitations: conflicting ? ['conflicting-sources'] : []
      }));
    }
    if (conflicting) {
      b.attention({ category: 'visibility', about: nodeId, reason: 'conflicting-sources', statement: ids[0] });
    }
    if (deliveryCitation && deliveryRequired.has(clauseId)) {
      ids.push(b.statement({
        about: nodeId, template: 'xpl2.clause-required@1', cites: [deliveryCitation],
        arguments: { clauseId, phase: identifier(phaseId, 'phase') }, limitations: deliveryLimits
      }));
    }
    if (deliveryCitation && deliveryMissing.has(clauseId)) {
      const missing = b.statement({
        about: nodeId, template: 'xpl2.clause-untagged@1', cites: [deliveryCitation],
        arguments: { clauseId, phase: identifier(phaseId, 'phase') }, limitations: deliveryLimits
      });
      ids.push(missing);
      // The delivery owner's own gap, shown as a diagnostic card — not a failed test.
      const gapId = `gap:untagged:${hex12(clauseId)}`;
      b.node({ id: gapId, kind: 'diagnostic', label: 'No test tag recorded', status: 'owner-reported-gap', cites: [deliveryCitation] });
      b.relationship({
        type: 'observation-gap', from: nodeId, to: gapId, scope: `${identifier(phaseId, 'phase')} delivery record`, cites: [deliveryCitation]
      });
      b.attention({ category: 'advisory', about: nodeId, reason: 'owner-reported-gap', statement: missing });
    }
    clauseStatements.set(clauseId, ids);
  }

  // Region-level associations, never upgraded to hunk scope.
  for (const unit of referencedUnits) {
    const file = fileByRegion.get(unit.regionSha256);
    for (const reference of unit.cause.references) {
      if (!['acceptance-clause', 'requirement'].includes(reference.causeKind)) continue;
      const nodeId = clauseNode(reference.causeId, ['SRC-GRAPH']);
      const edge = b.relationship({
        type: 'region-associated-with-clause', from: nodeId, to: file.fileId, scope: 'change-region',
        qualifier: reference.relationship ?? 'region-only', cites: ['SRC-GRAPH']
      });
      if (edge) {
        b.statement({
          about: file.fileId, template: 'xpl2.region-association@1', cites: ['SRC-GRAPH'],
          arguments: { clauseId: reference.causeId, causeKind: reference.causeKind, path: file.path },
          limitations: ['region-only-association']
        });
      }
    }
  }

  // ---- Recorded results: declared test tags and local test receipts ---------------------------
  const testNodes = new Map();
  const changedPaths = new Map(files.map((file) => [file.path, file]));
  if (deliveryCitation) {
    for (const binding of bindings) {
      if (typeof binding?.clauseId !== 'string' || typeof binding?.testSource !== 'string') continue;
      let testId = testNodes.get(binding.testSource);
      if (!testId) {
        testId = `test:${hex12(binding.testSource)}`;
        testNodes.set(binding.testSource, testId);
        b.node({ id: testId, kind: 'test', label: binding.testSource, cites: [deliveryCitation] });
        const changed = changedPaths.get(binding.testSource);
        if (changed) {
          b.relationship({
            type: 'test-source-in-change', from: testId, to: changed.fileId, scope: 'exact-path', cites: [deliveryCitation, 'SRC-MANIFEST']
          });
        }
      }
      const clauseId = clauseNode(binding.clauseId, [deliveryCitation]);
      const edge = b.relationship({
        type: 'test-source-tags-clause', from: testId, to: clauseId, scope: 'declared-tag',
        qualifier: identifier(binding.bindingAssurance, 'declared'), cites: [deliveryCitation]
      });
      if (edge) {
        b.statement({
          about: testId, template: 'xpl2.test-tag@1', cites: [deliveryCitation],
          arguments: {
            clauseId: binding.clauseId, testSource: binding.testSource,
            bindingAssurance: identifier(binding.bindingAssurance, 'declared')
          },
          limitations: ['revalidation-unestablished', ...deliveryLimits]
        });
      }
    }
    // A test command result is a fact about that command only. It is deliberately not joined to a
    // clause or a changed file: neither a tag nor an affected root establishes coverage.
    for (const execution of evidence.testExecutions) {
      const runId = `run:${hex12(execution.commandId)}`;
      const status = identifier(execution.status, 'unavailable');
      b.node({ id: runId, kind: 'run', label: execution.commandId, status, cites: [deliveryCitation] });
      const statement = b.statement({
        about: runId, template: 'xpl2.test-result@1', cites: [deliveryCitation],
        arguments: {
          commandId: execution.commandId, status, phase: identifier(phaseId, 'phase'),
          generation: String(evidence.generation ?? 'unknown')
        },
        limitations: ['origin-unestablished', ...deliveryLimits]
      });
      if (!['passed', 'pass', 'succeeded', 'success'].includes(status)) {
        b.attention({ category: 'blocker', about: runId, reason: 'owner-reported-failure', statement });
      }
    }
    if (deliveryLimits.length) {
      b.attention({
        category: 'visibility', about: 'change', reason: 'source-scope-mismatch',
        statement: b.statement({
          about: 'change', template: 'xpl2.source-state@1', cites: [deliveryCitation],
          arguments: { source: `The ${identifier(phaseId, 'phase')} delivery record`, reason: 'source-scope-mismatch' }
        })
      });
    }
  }

  // ---- Observation gaps and visibility limits --------------------------------------------------
  const unexplainedByFile = new Map();
  for (const unit of inventoryUnits) {
    if (unit.unitKind !== 'diff-hunk') continue;
    const bucket = unexplainedByFile.get(unit.fileId) ?? [];
    bucket.push(unit);
    unexplainedByFile.set(unit.fileId, bucket);
  }
  // Every unexplained hunk keeps its own statement. Only files with no recorded association at all
  // point at the shared "reason not recorded" gap: a region association already says, on its own
  // edge, that its hunks are not individually linked.
  const causeGapId = 'gap:cause-not-recorded';
  for (const file of files) {
    const bucket = unexplainedByFile.get(file.fileId) ?? [];
    if (!bucket.length) continue;
    const associated = referencedUnits.some((unit) => unit.regionSha256 === file.regionSha256);
    const gapStatements = bucket.map((unit) => b.statement({
      about: unit.nodeId, template: 'xpl2.cause-not-recorded@1', cites: ['OBS-CAUSE'],
      arguments: { unitId: unit.unitId },
      limitations: associated ? ['region-only-association'] : []
    }));
    if (associated) continue;
    b.node({
      id: causeGapId, kind: 'diagnostic', label: 'Exact reason link not recorded',
      status: 'source-not-recorded', cites: ['OBS-CAUSE']
    });
    b.relationship({ type: 'observation-gap', from: file.fileId, to: causeGapId, scope: 'captured cause set', cites: ['OBS-CAUSE'] });
    // One attention entry per file keeps the list readable.
    b.attention({ category: 'missing-explanation', about: bucket[0].nodeId, reason: 'source-not-recorded', statement: gapStatements[0] });
  }
  for (const unit of inventoryUnits.filter((entry) => entry.unitKind !== 'diff-hunk')) {
    b.attention({ category: 'advisory', about: unit.nodeId, reason: opaqueReason(unit), statement: unitStatements.get(unit.unitId) });
  }

  const inventoryStatement = b.statement({
    about: 'change', template: 'xpl2.change-inventory@1', cites: unitCites,
    arguments: {
      truth, files: files.length, hunks: inventoryUnits.filter((unit) => unit.unitKind === 'diff-hunk').length,
      opaque: inventoryUnits.filter((unit) => unit.unitKind !== 'diff-hunk').length,
      units: inventoryUnits.length, complete: true
    }
  });
  // The capture explains application code only; Singularity Flow's own records are named by count.
  const hidden = codeScope?.hidden ?? null;
  if (hidden?.entries > 0) {
    b.statement({
      about: 'change', template: 'xpl2.singularity-files-hidden@1', cites: ['SRC-MANIFEST'],
      arguments: {
        entries: hidden.entries,
        groups: hidden.groups.map(({ group, entries }) => `${group}: ${entries}`).join(', ')
      }
    });
  }
  const admission = b.statement({
    about: 'change', template: 'xpl2.admission-unavailable@1', cites: ['OBS-ADMISSION'], arguments: { truth }
  });
  b.attention({ category: 'visibility', about: 'change', reason: 'evaluation-unavailable', statement: admission });
  const wel = b.statement({
    about: 'change', template: 'xpl2.feature-state@1', cites: ['OBS-WEL'],
    arguments: { feature: 'wel', state: welState, reason: welReason }
  });
  const pe = b.statement({
    about: 'change', template: 'xpl2.feature-state@1', cites: ['OBS-PE'],
    arguments: { feature: 'pe', state: 'not-read', reason: 'adapter-unavailable' }
  });
  const impact = b.statement({
    about: 'change', template: 'xpl2.feature-state@1', cites: ['OBS-IMPACT'],
    arguments: { feature: 'impact', state: 'unavailable', reason: 'adapter-unavailable' }
  });
  const structure = b.statement({
    about: 'change', template: 'xpl2.feature-state@1', cites: structureDigest ? ['SRC-STRUCTURE'] : ['OBS-STRUCTURE'],
    arguments: {
      feature: 'structure', state: structureDigest ? 'navigation-only' : 'unavailable',
      reason: structureDigest ? 'navigation-hint-only' : 'source-not-recorded'
    }
  });
  if (!structureDigest && inventoryUnits.some((unit) => unit.unitKind === 'diff-hunk')) {
    b.attention({ category: 'visibility', about: 'change', reason: 'source-not-recorded', statement: structure });
  }
  if (!diffAvailable && inventoryUnits.length) {
    b.attention({
      category: 'visibility', about: 'change', reason: diffReason(codeExplanation.availability.diff.reason),
      statement: b.statement({
        about: 'change', template: 'xpl2.source-state@1', cites: ['OBS-DIFF'],
        arguments: { source: 'Bounded Git patch', reason: diffReason(codeExplanation.availability.diff.reason) }
      })
    });
  }

  // ---- Counts, availability, presentation -------------------------------------------------------
  const hunkCount = inventoryUnits.filter((unit) => unit.unitKind === 'diff-hunk').length;
  const opaqueCount = inventoryUnits.length - hunkCount;
  const regionAssociatedUnits = inventoryUnits.filter((unit) => referencedUnits
    .some((entry) => entry.regionSha256 === unit.regionSha256)).length;
  const counts = {
    files: files.length,
    regions: manifest.regions.length,
    textHunks: hunkCount,
    opaqueUnits: opaqueCount,
    changeUnits: inventoryUnits.length,
    causeBoundUnits: 0,
    regionAssociatedUnits,
    unexplainedUnits: hunkCount,
    clauses: clauseNodes.size,
    testBindings: bindings.length,
    testResults: evidence?.testExecutions?.length ?? 0
  };
  const availability = {
    diff: diffAvailable ? 'available' : 'unavailable',
    structure: structureDigest ? 'available' : 'unavailable',
    cause: referencedUnits.length ? 'partial' : 'unavailable',
    clauses: declaredClauses.size ? 'available' : (clauseSources?.status === 'available' ? 'partial' : 'unavailable'),
    delivery: deliveryCitation ? 'available' : 'unavailable',
    admission: 'unavailable',
    wel: welState === 'observe' ? 'partial' : 'disabled',
    pe: 'unavailable',
    impact: 'unavailable',
    provenance: 'unavailable',
    replay: replay ? 'available' : 'unavailable'
  };
  const snapshot = {
    truth,
    candidateBinding: manifest.candidateBinding,
    compatibilityCandidateSha256: manifest.compatibilityCandidateSha256,
    retainedCandidate: false,
    baseline: { revision: context.base ?? null, selection: context.source ?? null },
    workId: context.workId ?? null,
    phase: phaseId,
    generation: evidence?.generation ?? phase?.generation ?? null,
    manifestSha256: manifest.manifestSha256,
    changeSetSha256: manifest.changeSetSha256,
    codeExplanationSetSha256: codeExplanation.explanationSetSha256
  };

  return {
    builder: b,
    snapshot,
    availability,
    inventory: {
      files,
      units: inventoryUnits,
      counts,
      completeness: { status: 'complete', reason: null }
    },
    anchors: {
      inventoryStatement,
      unitStatements,
      clauseStatements,
      featureStatements: [admission, wel, pe, impact, structure],
      truth
    }
  };
}

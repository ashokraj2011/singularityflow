/**
 * The six XPL2 subjects over one change universe [XPL2-AC-017].
 *
 * `change` returns the whole universe. `clause`, `test` and `line` select exact members of it and
 * may add query-derived statements; `gap` reads the existing shadow-proof owner's register when a
 * caller supplies it; `generation` reads the Story's recorded phase generation and normalized
 * history. Every lookup is exact: a missing subject is `subject-not-found` inside the stated scope
 * and an ambiguous one lists its exact choices. Nothing falls back to fuzzy search, documentation,
 * chat history or the live working tree.
 */
import { SingularityFlowError } from '../../util.mjs';
import { buildChangeExplanationUniverse } from './change-subject.mjs';
import { XPL2_AUDIENCES, XPL2_SUBJECTS } from './model.mjs';

const MAXIMUM_SELECTOR_BYTES = 512;

function refuse(message, code = 'XPL2_SUBJECT_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function boundedSelector(value, label) {
  if (value == null) return null;
  const text = String(value);
  if (!text || text.includes('\0') || Buffer.byteLength(text, 'utf8') > MAXIMUM_SELECTOR_BYTES) {
    refuse(`XPL2 ${label} must be a non-empty value of at most ${MAXIMUM_SELECTOR_BYTES} bytes.`);
  }
  return text;
}

/**
 * Validate the subject query before any repository read [XPL2-AC-017, XPL2-AC-018].
 * Paths and lines are separate fields; there is no `path:line` parser to misread a drive letter,
 * a colon in a legal path, a URI scheme or a deletion-side coordinate.
 */
export function normalizeXpl2Query(query = {}) {
  const subject = String(query.subject ?? '');
  if (!XPL2_SUBJECTS.includes(subject)) {
    refuse(`Unknown explanation subject '${subject}'. Use one of: ${XPL2_SUBJECTS.join(', ')}.`, 'XPL2_SUBJECT_UNKNOWN');
  }
  const audience = query.audience ?? 'reviewer';
  if (!XPL2_AUDIENCES.includes(audience)) {
    refuse(`Unknown audience '${audience}'. Use one of: ${XPL2_AUDIENCES.join(', ')}.`);
  }
  const normalized = { subject, audience, id: null, path: null, line: null, side: null, phase: null, generation: null };
  if (subject === 'clause' || subject === 'test') {
    normalized.id = boundedSelector(query.id, '--id');
    if (!normalized.id) refuse(`--subject ${subject} requires --id with an exact identifier.`);
  }
  if (subject === 'line') {
    normalized.path = boundedSelector(query.path, '--path');
    if (!normalized.path) refuse('--subject line requires --path with a repository-relative path.');
    if (/^[/\\]|^[A-Za-z]:[\\/]|(^|[\\/])\.\.([\\/]|$)/u.test(normalized.path)) {
      refuse('--path must be repository-relative and must not leave the repository.');
    }
    const line = Number(query.line);
    if (!Number.isSafeInteger(line) || line < 1) refuse('--subject line requires --line with a positive line number.');
    normalized.line = line;
    normalized.side = query.side ?? 'after';
    if (!['before', 'after'].includes(normalized.side)) refuse('--side must be before or after.');
  }
  if (subject === 'generation') {
    normalized.phase = boundedSelector(query.phase, '--phase');
    if (!normalized.phase) refuse('--subject generation requires --phase.');
    const generation = Number(query.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) refuse('--subject generation requires --gen with a positive generation number.');
    normalized.generation = generation;
  }
  for (const [field, allowed] of [
    ['id', ['clause', 'test']], ['path', ['line']], ['phase', ['generation']]
  ]) {
    if (query[field] != null && !allowed.includes(subject)) {
      refuse(`--${field} is not a selector for --subject ${subject}.`);
    }
  }
  return normalized;
}

function neighbourhood(model, seedNodes) {
  const nodes = new Set(seedNodes);
  const relationships = [];
  for (const edge of model.builderRelationships) {
    if (nodes.has(edge.from) || nodes.has(edge.to)) relationships.push(edge.id);
  }
  for (const edge of model.builderRelationships) {
    if (relationships.includes(edge.id)) { nodes.add(edge.from); nodes.add(edge.to); }
  }
  return { nodes, relationships };
}

function presentationFor(model, selection) {
  const statements = model.statements.filter((entry) => selection.statements.includes(entry.id));
  const byKind = (kinds) => statements.filter((entry) => kinds.includes(entry.kind)).map((entry) => entry.id);
  const attentionStatements = model.attention.map((entry) => entry.statement)
    .filter((id) => selection.statements.includes(id));
  // Natural unit order: the inventory summary first, then units in their H-/O- enumeration order.
  const unitOrder = new Map((model.inventory?.units ?? []).map((unit, index) => [unit.nodeId, index]));
  const units = [
    ...byKind(['change-inventory']),
    ...byKind(['file-type', 'mode-change']),
    ...statements.filter((entry) => ['hunk', 'opaque-unit', 'declaration-overlap'].includes(entry.kind))
      .sort((left, right) => (unitOrder.get(left.about) ?? 0) - (unitOrder.get(right.about) ?? 0))
      .map((entry) => entry.id)
  ];
  const intent = byKind(['clause-declared', 'clause-required', 'clause-untagged', 'region-association']);
  const checks = byKind(['test-tag', 'test-result', 'gap-observed', 'no-complete-evaluation']);
  const limits = byKind(['admission-unavailable', 'feature-state', 'source-state', 'cause-not-recorded', 'provenance-unavailable']);
  const history = byKind(['generation-recorded']);
  const unique = (ids) => [...new Set(ids)];
  const everything = statements.map((entry) => entry.id);
  const complete = (ordered) => unique([...ordered, ...everything]);
  return {
    // Order and folding only; every audience receives the same statement set [XPL2-LAW-005].
    audiences: {
      reviewer: { order: complete([...units, ...intent, ...checks, ...limits, ...attentionStatements]), folded: history },
      auditor: { order: complete([...limits, ...intent, ...checks, ...units, ...attentionStatements]), folded: [] },
      developer: { order: complete([...units, ...intent, ...checks, ...attentionStatements, ...limits]), folded: unique([...limits, ...history]) }
    },
    // The deterministic "Read this change" tour [XPL2 13.1]: purpose, changed units, links,
    // recorded checks, then blockers and unknowns. No model is involved.
    walkthrough: unique([
      ...byKind(['clause-declared']),
      ...byKind(['change-inventory']),
      ...byKind(['hunk', 'opaque-unit']).slice(0, 12),
      ...byKind(['file-type', 'mode-change']),
      ...byKind(['region-association', 'test-tag']),
      ...byKind(['test-result']),
      ...attentionStatements
    ])
  };
}

function nextActions(model) {
  const first = model.attention[0] ?? null;
  return first ? [{
    id: 'xpl2.inspect-attention', kind: 'inspect', about: first.about,
    label: 'Inspect the first attention item; inspection changes nothing.'
  }] : [];
}

/**
 * Build one subject view. `input` is the slice-derived universe input; `proof` optionally carries
 * a shadow-proof gap register already read through its owner for the `gap` subject.
 */
export function explainXpl2Subject(input, rawQuery = {}, { proof = null, maximumUnits = null } = {}) {
  const query = normalizeXpl2Query(rawQuery);
  const universe = buildChangeExplanationUniverse({
    ...input, includeAllDeclaredClauses: query.subject === 'clause'
  });
  const b = universe.builder;
  const derived = [];
  let status = 'available';
  let reason = null;
  let choices = [];
  let seeds = null;

  if (query.subject === 'gap') {
    if (proof?.gaps) {
      b.source({
        id: 'SRC-PROOF', label: 'Shadow proof observation', owner: 'gdp.shadow-proof', family: 'gdp-proof-gaps-view',
        recordId: proof.proofSubjectSha256 ?? null, digest: proof.proofSummarySha256 ?? null,
        integrity: proof.proofSummarySha256 ? 'self-hashed' : 'unverified', origin: 'recorded-local',
        applicability: 'unknown', availability: 'present',
        coverage: { scope: 'selected Story, observe mode', complete: false, gaps: proof.gaps.length }, subject: true
      });
      for (const gap of proof.gaps.slice(0, 200)) {
        const code = String(gap?.code ?? gap?.gapCode ?? gap?.id ?? 'GAP').replace(/[^A-Za-z0-9:._@/+-]/gu, '_').slice(0, 120) || 'GAP';
        const subjectLabel = String(gap?.subject ?? gap?.clauseId ?? gap?.predicate ?? input.context?.workId ?? 'this Story');
        derived.push(b.derivedStatement({
          about: 'gap', template: 'xpl2.gap-observed@1', cites: ['SRC-PROOF'],
          arguments: { code, subject: subjectLabel }, limitations: ['evaluation-unavailable']
        }));
      }
    } else {
      b.observation({
        id: 'OBS-PROOF', adapter: 'gdp.shadow-proof', scope: 'shadow proof gap register for the selected Story',
        completeness: 'unavailable', reason: input.context?.workId ? 'evaluation-unavailable' : 'no-active-story', subject: true
      });
    }
    derived.push(b.derivedStatement({
      about: 'gap', template: 'xpl2.no-complete-evaluation@1', cites: ['OBS-ADMISSION'], arguments: {}
    }));
  }

  if (query.subject === 'line') {
    const matches = universe.inventory.units.filter((unit) => {
      const path = query.side === 'before' ? unit.pathBefore : unit.pathAfter;
      if (path !== query.path) return false;
      if (!unit.hunk) return true;
      const range = unit.hunk[query.side];
      return range.lines > 0 && query.line >= range.start && query.line <= range.start + range.lines - 1;
    });
    const textual = matches.filter((unit) => unit.hunk);
    const opaque = matches.filter((unit) => !unit.hunk);
    const citeLine = universe.availability.diff === 'available' ? ['SRC-DIFF', 'SRC-MANIFEST'] : ['SRC-MANIFEST'];
    if (textual.length) {
      seeds = textual.map((unit) => unit.nodeId);
      for (const unit of textual) {
        derived.push(b.derivedStatement({
          about: unit.nodeId, template: 'xpl2.line-in-unit@1', cites: citeLine,
          arguments: { side: query.side, path: query.path, line: query.line, unitId: unit.unitId }
        }));
      }
    } else if (opaque.length) {
      seeds = opaque.map((unit) => unit.nodeId);
      derived.push(b.derivedStatement({
        about: opaque[0].nodeId, template: 'xpl2.line-opaque@1', cites: ['SRC-MANIFEST'],
        arguments: { side: query.side, path: query.path, line: query.line, unitId: opaque[0].unitId }
      }));
    } else {
      b.observation({
        id: 'OBS-LINE', adapter: 'xpl2.line-locator', scope: 'change units of this captured interval',
        completeness: 'complete-for-scope', reason: 'outside-change-set', subject: true
      });
      seeds = [];
      status = 'unavailable';
      reason = 'outside-change-set';
      derived.push(b.derivedStatement({
        about: 'line', template: 'xpl2.line-outside@1', cites: ['OBS-LINE', 'SRC-MANIFEST'],
        arguments: { side: query.side, path: query.path, line: query.line }
      }));
    }
    derived.push(b.derivedStatement({
      about: 'line', template: 'xpl2.provenance-unavailable@1', cites: ['OBS-PROVENANCE'],
      arguments: { subject: `${query.path}:${query.line} (${query.side})`, reason: 'adapter-unavailable' }
    }));
  }

  if (query.subject === 'generation') {
    const workflow = input.workflow;
    const phase = workflow?.phases?.[query.phase] ?? null;
    if (!workflow) {
      status = 'unavailable';
      reason = 'no-active-story';
    } else if (!phase || !Number.isSafeInteger(phase.generation) || query.generation > phase.generation) {
      status = 'unavailable';
      reason = 'subject-not-found';
    } else {
      const events = (input.replay?.events ?? []).filter((event) => event.phase === query.phase
        && Number(event.generation) === query.generation);
      if (input.replay) {
        derived.push(b.derivedStatement({
          about: 'generation', template: 'xpl2.generation-recorded@1', cites: ['SRC-REPLAY', 'SRC-STORY'],
          arguments: {
            phase: query.phase, generation: String(query.generation), events: events.length,
            status: String(phase.status ?? 'unknown').replace(/[^A-Za-z0-9:._@/+-]/gu, '_') || 'unknown'
          },
          limitations: input.replay.truncated ? ['partial-inventory'] : []
        }));
      }
      derived.push(b.derivedStatement({
        about: 'generation', template: 'xpl2.provenance-unavailable@1', cites: ['OBS-PROVENANCE', 'OBS-PE'],
        arguments: { subject: `${query.phase} generation ${query.generation}`, reason: 'adapter-unavailable' }
      }));
    }
    seeds = [];
  }

  // Build once to resolve node/relationship lists, then compute the exact subject selection.
  const draft = b.build({
    subject: { kind: query.subject }, snapshot: universe.snapshot, inventory: universe.inventory,
    availability: universe.availability
  });
  const lookup = { ...draft, builderRelationships: draft.relationships };
  if (query.subject === 'clause') {
    const matches = draft.nodes.filter((node) => node.kind === 'clause' && node.label === query.id);
    if (matches.length === 1) seeds = [matches[0].id];
    else { status = 'unavailable'; reason = 'subject-not-found'; seeds = []; }
  }
  if (query.subject === 'test') {
    const matches = draft.nodes.filter((node) => ['test', 'run'].includes(node.kind) && node.label === query.id);
    if (matches.length === 1) seeds = [matches[0].id];
    else if (matches.length > 1) {
      status = 'ambiguous'; reason = 'subject-ambiguous'; seeds = [];
      choices = matches.map((node) => ({ kind: node.kind, label: node.label, nodeId: node.id }));
    } else { status = 'unavailable'; reason = 'subject-not-found'; seeds = []; }
  }
  if (query.subject === 'change' && !universe.inventory.units.length) {
    status = 'not-applicable';
    reason = 'complete-empty';
  }

  let selection;
  if (query.subject === 'change') {
    selection = null;
  } else if (query.subject === 'gap') {
    const ids = draft.attention.map((entry) => entry.statement);
    selection = { statements: [...new Set(ids)], nodes: [...new Set(draft.attention.map((entry) => entry.about).filter((id) => draft.nodes.some((node) => node.id === id)))], relationships: [] };
  } else {
    const { nodes, relationships } = neighbourhood(lookup, seeds ?? []);
    const statements = draft.statements.filter((entry) => nodes.has(entry.about)).map((entry) => entry.id);
    selection = { statements, nodes: [...nodes], relationships };
  }
  let effectiveSelection = selection ?? {
    statements: draft.statements.map((entry) => entry.id),
    nodes: draft.nodes.map((node) => node.id),
    relationships: draft.relationships.map((edge) => edge.id)
  };
  // Bounded delivery omits whole units (and only units) past the limit; counts stay complete and
  // the omission is explicit [XPL2-REQ-035].
  let delivery = { complete: true, reason: null };
  const selectedUnits = universe.inventory.units.filter((unit) => effectiveSelection.nodes.includes(unit.nodeId));
  if (Number.isSafeInteger(maximumUnits) && maximumUnits >= 1 && selectedUnits.length > maximumUnits) {
    const omitted = new Set(selectedUnits.slice(maximumUnits).map((unit) => unit.nodeId));
    effectiveSelection = {
      statements: effectiveSelection.statements.filter((id) => !omitted.has(draft.statements.find((entry) => entry.id === id)?.about)),
      nodes: effectiveSelection.nodes.filter((id) => !omitted.has(id)),
      relationships: effectiveSelection.relationships.filter((id) => {
        const edge = draft.relationships.find((entry) => entry.id === id);
        return edge && !omitted.has(edge.from) && !omitted.has(edge.to);
      })
    };
    delivery = {
      complete: false, reason: 'bounded-delivery',
      returnedUnits: maximumUnits, totalUnits: selectedUnits.length, omittedUnits: selectedUnits.length - maximumUnits
    };
  }
  const subject = {
    kind: query.subject,
    selector: {
      id: query.id, path: query.path, line: query.line, side: query.side,
      phase: query.phase, generation: query.generation
    },
    status, reason, choices
  };
  const presentation = presentationFor(draft, effectiveSelection);
  return b.build({
    subject,
    snapshot: universe.snapshot,
    inventory: universe.inventory,
    availability: universe.availability,
    next: nextActions(draft),
    presentation: { audience: query.audience, ...presentation },
    selection: effectiveSelection,
    delivery
  });
}

/**
 * A Story's slice of a published specification (SPEC-SPA v1.3 §6).
 *
 * `--spec SPEC-ID[@N][=CLAUSE,...]` names a reviewed revision and the clauses one Story delivers;
 * without `=…` it is every clause, and without `@N` the highest reviewed revision at this moment. The
 * slice becomes the optional `specification` field of the Story's pinned source, one entry per
 * specification:
 * - `clauses`: each sliced clause as `{ anchor, text }`, so each is its own scope statement;
 * - `decisions`: the revision's decided and deferred gaps with their outcomes, settled for the Story;
 * - `notThisStory`: every other clause as its anchor and first line;
 * - the revision, its manifest digest and the state commit it was read from.
 * A clause that depends on a clause the slice leaves out is refused unless the person says why. A
 * slice over the size limit is refused, never cut. No model is called.
 */
import { scopeItemId } from '../scope/extract.mjs';
import { countedRecords, inDecisionOrder, isWithdrawn } from '../presence/counted.mjs';
import { extractClauses } from '../specifications.mjs';
import { SingularityFlowError } from '../util.mjs';
import { foldGaps, originCoverage } from './draft-model.mjs';
import { parseSpecReference } from './ids.mjs';
import { libraryView, resolveRevision } from './library.mjs';

/** The whole `specification` field of one Story source, as JSON. A description may be 128 KiB. */
export const MAXIMUM_SLICE_BYTES = 64 * 1024;
const CLAUSE = /^(?:(SPEC-[A-Z0-9]+(?:-[A-Z0-9]+)*):)?((?:REQ|BEH|IFC|AC|CON)-\d{3,})$/u;
const FIRST_LINE = 160;

const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };
const listed = (items) => items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** `SPEC-ID[@N][=REQ-001,AC-002]`: the specification, its revision (or null) and its clauses (or null for all). */
export function parseSliceRequest(value) {
  const text = String(value ?? '').trim();
  const [reference, list, ...rest] = text.split('=');
  const usage = `Use SPEC-ID, SPEC-ID@N, or SPEC-ID@N=REQ-001,AC-002.`;
  if (rest.length) fail(`'${text}' is not a specification slice. ${usage}`, 'SPEC_SLICE_REQUEST_INVALID', { request: text, nextAction: 'singularity-flow spec author list' });
  const { specId, revision } = parseSpecReference(reference);
  if (list === undefined) return { specId, revision, clauses: null, request: text };
  const clauses = [];
  for (const raw of list.split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const match = CLAUSE.exec(raw.toUpperCase());
    if (!match || (match[1] && match[1] !== specId)) {
      fail(`'${raw}' is not a clause of ${specId}. Name its clauses as REQ-001 or ${specId}:REQ-001, separated by commas.`, 'SPEC_SLICE_REQUEST_INVALID',
        { request: text, clause: raw, nextAction: `singularity-flow spec author show ${reference}` });
    }
    const id = `${specId}:${match[2]}`;
    if (!clauses.includes(id)) clauses.push(id);
  }
  if (!clauses.length) fail(`'${text}' names no clause after '='. ${usage}`, 'SPEC_SLICE_REQUEST_INVALID', { request: text, nextAction: `singularity-flow spec author show ${reference}` });
  return { specId, revision, clauses, request: text };
}

/** Every request, each specification once. */
export function parseSliceRequests(values = []) {
  const requests = values.map(parseSliceRequest);
  const seen = new Set();
  for (const request of requests) {
    if (seen.has(request.specId)) {
      fail(`${request.specId} is named twice; give one --spec per specification, with every clause it delivers.`, 'SPEC_SLICE_REQUEST_INVALID',
        { specId: request.specId, nextAction: `singularity-flow spec author show ${request.specId}` });
    }
    seen.add(request.specId);
  }
  return requests;
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').map((entry) => entry.trim()).find(Boolean) ?? '';
  return line.length > FIRST_LINE ? `${line.slice(0, FIRST_LINE - 1)}…` : line;
}

/** The decided and deferred gaps of a revision, with the outcome a Story takes as settled. */
export function revisionDecisions(gaps) {
  return foldGaps(gaps?.events ?? []).filter((gap) => gap.status === 'decided' || gap.status === 'deferred').map((gap) => ({
    gap: gap.id, question: gap.question, status: gap.status,
    outcome: gap.status === 'decided' ? gap.decision.choice : `Deferred; ${gap.deferral.owner} owns it. ${gap.deferral.reason}`.trim()
  }));
}

/**
 * The slice of one read revision (library.mjs readRevision) for one request. `dependencyReason` lets a
 * sliced clause leave out a clause it depends on, and is recorded with what was left out.
 */
export function buildSlice(revision, { specId, clauses: named }, { dependencyReason = null } = {}) {
  const name = `${specId}@${revision.revision}`;
  const all = extractClauses(revision.spec, { namespace: specId });
  const known = new Set(all.map((clause) => clause.id));
  const unknown = (named ?? []).filter((id) => !known.has(id));
  if (unknown.length) {
    fail(`${listed(unknown)} ${unknown.length === 1 ? 'is not a clause' : 'are not clauses'} of ${name}; its clauses are ${listed(all.map((clause) => clause.id)) || 'none'}.`,
      'SPEC_SLICE_CLAUSE_UNKNOWN', { specId, revision: revision.revision, clauses: unknown, nextAction: `singularity-flow spec author show ${name}` });
  }
  const chosen = named ? all.filter((clause) => named.includes(clause.id)) : all;
  const chosenIds = new Set(chosen.map((clause) => clause.id));
  const missing = chosen.flatMap((clause) => clause.dependsOn.filter((id) => known.has(id) && !chosenIds.has(id))
    .map((dependsOn) => ({ clause: clause.id, dependsOn })));
  if (missing.length && !dependencyReason) {
    const wanted = [...chosenIds, ...new Set(missing.map((entry) => entry.dependsOn))].map((id) => id.slice(specId.length + 1));
    fail(`${missing.map((entry) => `${entry.clause} depends on ${entry.dependsOn}`).join('; ')}, which the slice leaves out. Deliver them together with --spec ${name}=${wanted.join(',')}, or keep them apart with --allow-partial-dependency --reason TEXT.`,
      'SPEC_SLICE_DEPENDENCY_MISSING', { specId, revision: revision.revision, missing, nextAction: `singularity-flow spec author show ${name}` });
  }
  return {
    ...(revision.manifest.sources?.length ? { sources: revision.manifest.sources.map(source => ({ ...source, readCommand: 'singularity-flow spec author sources ' + name + ' --source ' + source.id + ' --json' })) } : {}),
    ...(revision.manifest.origins?.length ? { originBindings: revision.manifest.origins.map(origin => ({ revision: origin.revision, manifestSha256: origin.manifestSha256, relationship: origin.relationship })) } : {}),
    revision: name, title: revision.manifest.title ?? null, manifestSha256: revision.manifestSha256, stateCommit: revision.commit,
    clauses: chosen.map((clause) => ({ anchor: `[${clause.id}]`, text: clause.body })),
    decisions: revisionDecisions(revision.gaps),
    notThisStory: all.filter((clause) => !chosenIds.has(clause.id)).map((clause) => ({ anchor: `[${clause.id}]`, firstLine: firstLine(clause.body) })),
    ...(missing.length ? { partialDependency: { reason: dependencyReason, missing } } : {})
  };
}

/** Refuse a `specification` field over the limit, naming its size; it is never silently cut. */
export function assertSliceSize(slices) {
  const bytes = Buffer.byteLength(JSON.stringify(slices, null, 2), 'utf8');
  if (bytes > MAXIMUM_SLICE_BYTES) {
    fail(`The specification slice is ${bytes.toLocaleString('en-US')} bytes; a Story source holds at most ${MAXIMUM_SLICE_BYTES.toLocaleString('en-US')}. Nothing was attached: name fewer clauses (SPEC-ID@N=REQ-001,...), or split the specification.`,
      'SPEC_SLICE_TOO_LARGE', { bytes, limit: MAXIMUM_SLICE_BYTES, nextAction: 'singularity-flow spec author list' });
  }
  return bytes;
}

/**
 * The revision a request names, or without `@N` the highest reviewed one that counts under SF Guard. A
 * named revision that does not count is refused with the person's route; nothing is attached.
 */
function countedRevision(root, view, request, presence, route, { env }) {
  if (request.revision !== null || !presence.optedIn) {
    const revision = resolveRevision(root, view, request.specId, request.revision, { env });
    const verdict = presence.revision(view, revision);
    if (!verdict.counts) {
      fail(`${request.specId}@${revision.revision} does not count under SF Guard: ${verdict.reason}. Nothing was attached; ${route(request.specId)}.`,
        verdict.code ?? 'PSS_RECORD_UNSIGNED', { specId: request.specId, revision: revision.revision, nextAction: `singularity-flow spec author show ${request.specId}` });
    }
    return revision;
  }
  for (const candidate of [...(view.specs.get(request.specId) ?? [])].reverse()) {
    const revision = resolveRevision(root, view, request.specId, candidate, { env });
    if (revision.manifest.reviewState === 'reviewed' && presence.revision(view, revision).counts) return revision;
  }
  // Nothing counts: the library's own refusal names what is there.
  const revision = resolveRevision(root, view, request.specId, null, { env });
  fail(`${request.specId} has no reviewed revision that counts under SF Guard (the highest, @${revision.revision}, ${presence.revision(view, revision).reason}). Nothing was attached; ${route(request.specId)}.`,
    'PSS_RECORD_UNSIGNED', { specId: request.specId, nextAction: `singularity-flow spec author show ${request.specId}` });
}

/**
 * Resolve every `--spec` value against one pinned read of the library. Only a reviewed revision can be
 * attached; without `@N`, the highest reviewed one.
 */
export async function resolveSlices(root, config, values, { dependencyReason = null, env = process.env } = {}) {
  const requests = parseSliceRequests(values);
  if (!requests.length) return [];
  if (dependencyReason !== null && !String(dependencyReason).trim()) {
    fail('--allow-partial-dependency needs the reason: --reason TEXT.', 'SPEC_SLICE_REQUEST_INVALID', { nextAction: 'singularity-flow spec author list' });
  }
  const view = await libraryView(root, config, { env });
  // SF Guard (SPEC-PSS-v1 §10.9): a revision recorded while SF Guard was on counts only with its seal.
  const { libraryPresence, revisionRoute } = await import('./presence.mjs');
  const presence = await libraryPresence(root, { env });
  const resolved = new Map();
  const selectedVersions = new Map();
  const inheritedByRevision = new Map();
  const read = request => {
    const key = request.specId + '@' + (request.revision ?? 'latest');
    if (!resolved.has(key)) resolved.set(key, countedRevision(root, view, request, presence, revisionRoute, { env }));
    const revision = resolved.get(key);
    const previous = selectedVersions.get(request.specId);
    if (previous && previous !== revision.revision) fail('Two selected paths require different versions of ' + request.specId + '. Choose one version or update the technical derivation before creating work.', 'SPEC_ORIGIN_VERSION_CONFLICT', { specId: request.specId, versions: [previous, revision.revision], nextAction: 'singularity-flow spec author show ' + request.specId });
    selectedVersions.set(request.specId, revision.revision);
    if (revision.manifest.reviewState !== 'reviewed') fail(request.specId + '@' + revision.revision + ' is a draft revision; choose a reviewed version.', 'SPEC_LIBRARY_NOT_REVIEWED');
    return revision;
  };
  const inherited = (revision, selected, ancestors = []) => {
    const name = revision.specId + '@' + revision.revision;
    if (ancestors.includes(name) || ancestors.length >= 8) fail('The parent specification chain is cyclic or too deep. Nothing was attached.', 'SPEC_ORIGIN_CHAIN_INVALID');
    const origins = revision.manifest.origins ?? [];
    if (!origins.length) return [];
    const coverage = originCoverage({ spec: revision.spec, origins }, extractClauses(revision.spec, { namespace: revision.specId }).map(clause => clause.id));
    if (coverage.findings.length) fail('The reviewed technical version has incomplete parent coverage. Create a corrected revision before using it.', 'SPEC_ORIGIN_COVERAGE_INVALID');
    return origins.flatMap(origin => {
      const parentIds = new Set(origin.clauses.map(clause => clause.id));
      const wanted = coverage.rows.filter(row => parentIds.has(row.source) && row.targets.some(id => selected.includes(id))).map(row => row.source);
      if (!wanted.length) return [];
      const reference = parseSpecReference(origin.revision);
      const parent = read(reference);
      if (parent.manifestSha256 !== origin.manifestSha256) fail('The exact parent specification no longer matches its pinned digest.', 'SPEC_ORIGIN_BINDING_INVALID');
      const parentClauses = extractClauses(parent.spec, { namespace: parent.specId });
      const acceptance = parentClauses.filter(clause => clause.id.includes(':AC-') &&
        (clause.dependsOn.some(id => wanted.includes(id)) || parentClauses.filter(item => item.id.includes(':REQ-')).length === 1));
      // The selected requirement closure (SPEC-SPA section 9.2): what a carried clause depends on comes
      // with it. These are inherited constraints, so the Story is not asked to deliver the parent.
      const byId = new Map(parentClauses.map(clause => [clause.id, clause]));
      const closure = new Set([...wanted, ...acceptance.map(clause => clause.id)]);
      for (const id of closure) for (const dependency of byId.get(id)?.dependsOn ?? []) if (byId.has(dependency)) closure.add(dependency);
      const parentSelected = [...closure];
      const slice = buildSlice(parent, { ...reference, clauses: parentSelected }, { dependencyReason });
      const key = parent.specId + '@' + parent.revision;
      const existing = inheritedByRevision.get(key);
      if (existing) {
        const union = new Set([...existing.clauses.map(sliceClauseId), ...parentSelected]);
        Object.assign(existing, buildSlice(parent, { ...reference, clauses: [...union] }, { dependencyReason }));
        existing.inheritedSpecifications.push(...inherited(parent, parentSelected, [...ancestors, name]));
        return [];
      }
      const retained = { ...slice, standing: 'inherited-constraint', relationship: origin.relationship, inheritedSpecifications: [] };
      inheritedByRevision.set(key, retained);
      retained.inheritedSpecifications = inherited(parent, parentSelected, [...ancestors, name]);
      return [retained];
    });
  };
  const slices = requests.map(request => {
    const revision = read(request);
    const slice = buildSlice(revision, request, { dependencyReason: dependencyReason === null ? null : String(dependencyReason).trim() });
    const origins = inherited(revision, slice.clauses.map(sliceClauseId));
    return { ...slice, ...(origins.length ? { inheritedSpecifications: origins } : {}) };
  });
  assertSliceSize(slices);
  return slices;
}

/** The clause ID of a sliced clause, without brackets. */
export const sliceClauseId = (clause) => String(clause?.anchor ?? '').replace(/^\[|\]$/gu, '');

/** The scope item a sliced clause is in the Story's scope inventory (scope/extract.mjs storySourceStatements). */
export const sliceClauseItem = (clause) => scopeItemId('story', `${clause?.anchor ?? ''} ${clause?.text ?? ''}`);

/**
 * The sliced clauses a person took out of the Story: those whose scope item's standing decision is
 * excluded or deferred (`spec attach --drop` records `excluded`).
 */
export function droppedSliceClauses(workflow, slice) {
  const latest = new Map();
  for (const entry of inDecisionOrder(workflow, countedRecords(workflow, workflow?.scopeDispositions))) if (entry?.item && !isWithdrawn(workflow, entry)) latest.set(entry.item, entry);
  return (slice?.clauses ?? []).filter((clause) => ['excluded', 'deferred'].includes(latest.get(sliceClauseItem(clause))?.disposition)).map(sliceClauseId);
}

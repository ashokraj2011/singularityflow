/** Optional Studio operations, shared by CLI and editor. Never run a model or alter application code. */
import { draftRetentionPreview, readDraft, saveDraft } from '../spec-library/draft-store.mjs';
import { sharedDrafts, syncDraft, resumeSharedDraft } from '../spec-library/shared-drafts.mjs';
import { addSpecSource, readSpecSource, copySpecSources, readSpecTextFile } from '../spec-library/sources.mjs';
import { libraryView, resolveRevision } from '../spec-library/library.mjs';
import { newDraft, specTemplate } from '../spec-library/draft-model.mjs';
import { extractClauses } from '../specifications.mjs';
import { optionBoolean, optionString, optionNumber, optionStrings, SingularityFlowError } from '../util.mjs';
import { generatedSpecId, parseSpecReference, requireSpecId } from '../spec-library/ids.mjs';

/** One source page: the largest result a host still shows inline, unless the caller shows more. */
const SOURCE_PAGE_BYTES = 6_000;
const MAXIMUM_SOURCE_PAGE_BYTES = 48_000;

export async function specStudioCommand(root, positionals, options, { config, actor, operationId }) {
  const action = positionals[2]; let specId = positionals[3] ? (['derive', 'sources', 'source'].includes(action) ? parseSpecReference(positionals[3]).specId : requireSpecId(positionals[3])) : null;
  let result;
  if (action === 'derive') {
    const requests = [positionals[3], ...optionStrings(options, 'parent')].map(parseSpecReference);
    const view = await libraryView(root, config);
    const presence = await (await import('../spec-library/presence.mjs')).libraryPresence(root);
    const parents = [], seen = new Map();
    for (const request of requests) {
      if (request.revision === null) throw new SingularityFlowError('Choose an exact reviewed parent version, SPEC-ID@N.', { code: 'SPEC_REFERENCE_INVALID' });
      const revision = resolveRevision(root, view, request.specId, request.revision);
      if (seen.has(request.specId)) {
        if (seen.get(request.specId) !== revision.revision) throw new SingularityFlowError('Choose one version of each parent specification.', { code: 'SPEC_ORIGIN_VERSION_CONFLICT' });
        continue;
      }
      seen.set(request.specId, revision.revision);
      if (revision.manifest.reviewState !== 'reviewed' || !presence.revision(view, revision).counts) throw new SingularityFlowError('Choose a reviewed specification that counts under the repository policy.', { code: 'SPEC_LIBRARY_NOT_REVIEWED' });
      parents.push(revision);
    }
    if (parents.length > 16) throw new SingularityFlowError('Use at most 16 parent specifications; divide larger work into smaller parts.', { code: 'SPEC_ORIGIN_LIMIT' });
    specId = generatedSpecId('derive:' + operationId);
    const title = ('Technical details: ' + parents[0].manifest.title).slice(0, 240);
    const origins = parents.map(revision => ({ revision: revision.specId + '@' + revision.revision, manifestSha256: revision.manifestSha256,
      stateCommit: revision.commit, relationship: revision.manifest.kind === 'business' ? 'implements' : 'derived-from',
      clauses: extractClauses(revision.spec, { namespace: revision.specId }).map(clause => ({ id: clause.id, text: clause.body })), decisions: revision.gaps.events }));
    const spec = specTemplate(specId, title, 'Define how the selected reviewed outcomes will be delivered.')
      + '\n## Design and interfaces\n\nTODO: components, contracts, data, compatibility and failure behaviour.\n\n## Business coverage\n\n| Source requirement | Technical requirement or disposition | Reason |\n| --- | --- | --- |\n'
      + origins.flatMap(origin => origin.clauses.map(clause => '| ' + clause.id + ' | TODO | TODO |')).join('\n') + '\n';
    const sources = [...new Map(parents.flatMap(parent => parent.manifest.sources ?? []).map(source => [source.id, source])).values()];
    for (const parent of parents) await copySpecSources(root, parent.specId, specId, parent.manifest.sources);
    // The exact parents name this operation. stateCommit moves with the state branch tip, so a retry would read as another change.
    const saved = await saveDraft(root, specId, { operationId, operation: 'derive', create: true, actor,
      payload: { parents: origins.map(({ revision, manifestSha256, relationship }) => ({ revision, manifestSha256, relationship })), kind: 'technical' }, change: () => ({ ...newDraft({ title, spec, kind: 'technical' }), sources, origins }) });
    result = { sequence: saved.snapshot.sequence, replayed: saved.replayed, origins: origins.map(origin => origin.revision) };
  } else if (action === 'shared') {
    const shared = await sharedDrafts(root, config, { refresh: optionBoolean(options, 'refresh'), only: specId });
    result = { drafts: shared.drafts.map(item => ({
      specId: item.head.specId, checkpointSha256: item.head.checkpointSha256, title: item.checkpoint.draft.title,
      kind: item.checkpoint.draft.kind ?? null, savedAt: item.checkpoint.savedAt,
      ...(specId ? { draft: item.checkpoint.draft } : {}) })), unreadable: shared.unreadable, commit: shared.view.commit };
  } else {
    requireSpecId(specId);
    let local = await readDraft(root, specId, { headOnly: !['history', 'restore-version'].includes(action) });
    if (action === 'sources' && (!local?.head || positionals[3].includes('@'))) {
      const reference = parseSpecReference(positionals[3]);
      const revision = resolveRevision(root, await libraryView(root, config, { refresh: false }), reference.specId, reference.revision, { anyState: true });
      local = { head: { draft: { sources: revision.manifest.sources ?? [] } } };
    }
    const restoring = action === 'source' ? optionString(options, 'restore') : null;
    if (action === 'source' && positionals[3].includes('@') && !restoring) throw new SingularityFlowError('A published version is immutable. Start a draft to change its sources.', { code: 'SPEC_LIBRARY_REVISION_IMMUTABLE' });
    if (restoring && (positionals[3].includes('@') || !(local?.head?.draft.sources ?? []).some(item => item.id === restoring))) {
      const reference = parseSpecReference(positionals[3]);
      const view = await libraryView(root, config);
      const versions = reference.revision ? [reference.revision] : [...(view.specs.get(specId) ?? [])].reverse();
      let original;
      for (const version of versions) {
        const revision = resolveRevision(root, view, specId, version, { anyState: true });
        original = revision.manifest.sources?.find(item => item.id === restoring && item.type === 'file');
        if (original) break;
      }
      if (!original) throw new SingularityFlowError('This source is not in the selected published specification. Choose its exact version.', { code: 'SPEC_SOURCE_UNKNOWN' });
      const restored = await addSpecSource(root, specId, { sources: [original] }, { file: optionString(options, 'file'), restore: restoring });
      result = { sources: restored.sources, localOnly: true, effects: { metadataChanged: false, committed: false, pushed: false } };
    } else if (action === 'sync') result = await syncDraft(root, config, specId, { automatic: optionBoolean(options, 'automatic'), minimumIntervalMs: optionNumber(options, 'min-interval-ms') ?? 30000 });
    else if (action === 'resume') {
      const saved = await resumeSharedDraft(root, config, specId, { checkpointSha256: optionString(options, 'checkpoint'),
        expectedSequence: optionNumber(options, 'expected-seq'), operationId });
      result = { sequence: saved.snapshot.sequence, replayed: saved.replayed };
    } else if (!local?.head) throw new SingularityFlowError('Open a local draft or continue a shared draft first.', { code: 'SPEC_DRAFT_MISSING' });
    else if (action === 'fork') {
      const previous = specId; specId = generatedSpecId('fork:' + operationId);
      const current = local.head.draft;
      const file = optionString(options, 'file');
      const prose = file ? await readSpecTextFile(file, { tooLarge: 'The recovered draft is over 256 KiB. Copy a smaller section into another draft.' }) : current.spec;
      const spec = prose.replaceAll(previous + ':', specId + ':');
      await copySpecSources(root, previous, specId, current.sources);
      const copied = newDraft({ title: current.title.slice(0, 220) + ' (another draft)', spec, areas: current.areas, kind: current.kind ?? null });
      copied.sources = current.sources ?? []; copied.research = current.research; copied.origins = current.origins ?? [];
      copied.gaps = current.gaps.map(event => ({ ...event, ...(event.clauses ? { clauses: event.clauses.map(clause => clause.replace(previous + ':', specId + ':')) } : {}) }));
      const saved = await saveDraft(root, specId, { operationId, operation: 'fork', create: true, actor,
        payload: { from: previous, ...(file ? { prose } : { snapshot: local.head.snapshotSha256 }) }, change: () => copied });
      result = { sequence: saved.snapshot.sequence, replayed: saved.replayed, forkedFrom: previous };
    } else if (action === 'restore-version') {
      const selected = local.snapshots.find(item => item.sequence === optionNumber(options, 'sequence'));
      if (!selected) throw new SingularityFlowError('That saved version is unavailable. Your current draft was preserved.', { code: 'SPEC_DRAFT_VERSION_MISSING' });
      const expectedSequence = optionNumber(options, 'expected-seq');
      if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 1) throw new SingularityFlowError('Compare the current draft before restoring wording; supply --expected-seq N.', { code: 'SPEC_DRAFT_STALE' });
      const saved = await saveDraft(root, specId, { operationId, operation: 'restore-wording', actor,
        expectedSequence, wordingBasis: true, payload: { sequence: selected.sequence },
        change: current => ({ ...current, spec: selected.draft.spec, title: selected.draft.title, kind: selected.draft.kind ?? null }) });
      result = { sequence: saved.snapshot.sequence };
    } else if (action === 'history') {
      const sequence = optionNumber(options, 'sequence');
      const selected = sequence == null ? null : local.snapshots.find(item => item.sequence === sequence);
      if (sequence != null && !selected) throw new SingularityFlowError('That saved version is unavailable on this laptop.', { code: 'SPEC_DRAFT_VERSION_MISSING' });
      result = { versions: local.snapshots.slice(-100).reverse().map(item => ({ sequence: item.sequence, title: item.draft.title,
        savedAt: item.savedAt, savedBy: item.savedBy, operation: item.operation })),
        ...(selected ? { draft: selected.draft, sequence: selected.sequence } : {}),
        ...(optionBoolean(options, 'retention') ? { retention: await draftRetentionPreview(root, specId, local) } : {}) };
    } else if (action === 'sources') {
      const id = optionString(options, 'source');
      const selected = (local.head.draft.sources ?? []).filter(item => !id || item.id === id);
      if (id && !selected.length) throw new SingularityFlowError('This source is not attached to the draft.', { code: 'SPEC_SOURCE_UNKNOWN' });
      if (!id) result = { sources: selected.map(source => ({ source, status: 'not-inspected' })) };
      else {
        const viewed = await readSpecSource(root, specId, selected[0], { config });
        if (typeof viewed.text === 'string') {
          const from = optionNumber(options, 'from') ?? 1;
          if (!Number.isSafeInteger(from) || from < 1) throw new SingularityFlowError('Source line numbers start at 1.', { code: 'SPEC_SOURCE_RANGE_INVALID' });
          const pageBytes = optionNumber(options, 'max-bytes') ?? SOURCE_PAGE_BYTES;
          if (!Number.isSafeInteger(pageBytes) || pageBytes < 1000 || pageBytes > MAXIMUM_SOURCE_PAGE_BYTES) throw new SingularityFlowError(`Choose a page of 1000 to ${MAXIMUM_SOURCE_PAGE_BYTES} bytes.`, { code: 'SPEC_SOURCE_RANGE_INVALID' });
          const lines = viewed.text.split(/\r?\n/u); let used = 0; const shown = [];
          const column = optionNumber(options, 'column') ?? 0;
          if (!Number.isSafeInteger(column) || column < 0 || column > (lines[from - 1]?.length ?? 0)) throw new SingularityFlowError('The source range changed. Read from its beginning again.', { code: 'SPEC_SOURCE_RANGE_INVALID' });
          // Sized as printed: a result's escapes count toward what a host shows inline.
          const printed = text => Buffer.byteLength(JSON.stringify(text)) - 2;
          let next, nextColumn;
          for (let index = from - 1; index < lines.length; index++) {
            const line = index === from - 1 ? lines[index].slice(column) : lines[index];
            const bytes = printed(line) + 2;
            if (used + bytes > pageBytes) {
              if (!shown.length) {
                let room = pageBytes, end = 0;
                for (const character of line) { room -= printed(character); if (room < 0) break; end += character.length; }
                shown.push(line.slice(0, end)); next = index + 1; nextColumn = column + end;
              } else next = index + 1;
              break;
            }
            shown.push(line); used += bytes;
          }
          // The continuation comes before the text: a host may show only the start of a long result.
          const { text: _whole, ...descriptor } = viewed;
          result = { sources: [{ status: viewed.status, from, column, totalLines: lines.length,
            ...(next !== undefined ? { next } : {}), ...(nextColumn !== undefined ? { nextColumn } : {}), ...descriptor, text: shown.join('\n') }] };
        } else result = { sources: [viewed] };
      }
    } else {
      const remove = optionString(options, 'remove');
      if (remove && !(local.head.draft.sources ?? []).some(source => source.id === remove)) throw new SingularityFlowError('This source is not attached to the draft.', { code: 'SPEC_SOURCE_UNKNOWN' });
      let specification = null;
      const requested = optionString(options, 'specification');
      if (requested) {
        const reference = parseSpecReference(requested);
        if (reference.revision === null) throw new SingularityFlowError('Choose an exact reviewed version, SPEC-ID@N.', { code: 'SPEC_REFERENCE_INVALID' });
        const read = resolveRevision(root, await libraryView(root, config), reference.specId, reference.revision);
        if (read.manifest.reviewState !== 'reviewed') throw new SingularityFlowError('Choose a reviewed specification as a source.', { code: 'SPEC_LIBRARY_NOT_REVIEWED' });
        specification = { revision: requested, title: read.manifest.title, manifestSha256: read.manifestSha256 };
      }
      const files = optionStrings(options, 'file'); const source = files[0], url = optionString(options, 'url'), code = optionString(options, 'path');
      let changed = remove ? { ...local.head.draft, sources: (local.head.draft.sources ?? []).filter(item => item.id !== remove) }
        : await addSpecSource(root, specId, local.head.draft, { file: source, url, code, specification,
          restore: optionString(options, 'restore'), purpose: optionString(options, 'purpose') ?? '' });
      for (const file of files.slice(1)) changed = await addSpecSource(root, specId, changed, { file });
      const saved = await saveDraft(root, specId, { operationId, operation: 'source', expectedSequence: local.sequence,
        actor, payload: { sources: changed.sources }, change: current => ({ ...current, sources: changed.sources }) });
      result = { sequence: saved.snapshot.sequence, sources: saved.snapshot.draft.sources };
    }
  }
  const response = { schemaVersion: 1, resultType: 'sflow-spec-author', action, ...(specId ? { specId } : {}),
    ...(['derive', 'fork', 'resume', 'restore-version', 'source'].includes(action) && result.localOnly !== true ? { operationId } : {}), ...result };
  console.log(optionBoolean(options, 'json') ? JSON.stringify(response, null, 2) : `${specId ?? 'Specification library'}: ${action} complete.\n${JSON.stringify(result, null, 2)}`);
  return response;
}

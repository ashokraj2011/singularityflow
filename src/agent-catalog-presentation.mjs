/** Metadata-only catalog views. Full definitions stay in the exact retained result, not the chat. */
import { createHash } from 'node:crypto';

const digest = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const preview = value => typeof value === 'string' && value.length > 240 ? value.slice(0, 239) + '…' : value;
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));

/** Closed to list catalogs only: never summarize selected instructions, reviews or decisions. */
export function catalogAgentView(result, limit = 20, { identityOnly = false } = {}) {
  if (!result || result.error || result.errors?.length) return null;
  const utility = result.resultType === 'sflow-utility-entry';
  const data = utility ? result.data : result;
  if (data?.error || data?.errors?.length) return null;
  let kind, rows, field;
  if (data?.resultType === 'skill-master' && Array.isArray(data.skills)) {
    if (utility && result.operation !== 'skill list') return null;
    kind = 'skill'; rows = data.skills; field = utility ? 'data.skills' : 'skills';
  } else if (utility && result.operation === 'workflow list' && Array.isArray(data)) {
    kind = 'workflow'; rows = data; field = 'data';
  } else return null;
  if (rows.some(item => !item || typeof item.id !== 'string'
      || (kind === 'workflow' && (!Array.isArray(item.phases)
        || item.phases.some(phase => typeof phase !== 'string' && typeof phase?.id !== 'string'))))) return null;
  const summaries = rows.slice(0, limit).map((item, index) => {
    const metadata = identityOnly
      ? kind === 'skill'
        ? pick(item, ['id', 'label', 'path', 'loading', 'instructionRefs', 'tags'])
        : { ...pick(item, ['id', 'label', 'governs', 'installed', 'status', 'seeded', 'editable']), phaseCount: item.phases.length }
      : kind === 'skill'
      ? pick(item, ['id', 'label', 'description', 'path', 'loading', 'instructionRefs', 'usedBy', 'tags'])
      : { ...pick(item, ['id', 'label', 'description', 'governs', 'installed', 'status', 'source', 'seeded',
        'editable', 'proposalBranch', 'proposalCommit']),
        phases: (item.phases ?? []).map(phase => typeof phase === 'string' ? phase : phase.id) };
    if (typeof metadata.description === 'string' && metadata.description.length > 240) metadata.descriptionPreview = true;
    metadata.description = preview(metadata.description);
    return { ...metadata, recordSha256: digest(item), detailField: `${field}[${index}]` };
  });
  const projected = kind === 'skill' ? { ...data, skills: summaries } : summaries;
  return { ...(utility ? { ...result, data: projected } : projected), catalogView: {
    kind, metadataOnly: true, detailLevel: identityOnly ? 'identity' : 'scope',
    ...(kind === 'workflow' && rows.some(row => row.catalogProjection) ? { readiness: 'not-assessed',
      sourceBindings: [...new Map(rows.filter(row => row.catalogProjection).map(row =>
        [JSON.stringify(row.catalogProjection), row.catalogProjection])).values()] } : {}),
    total: rows.length, shown: summaries.length, more: rows.length > summaries.length,
    details: 'Read only the needed fields from agentOutput.path. It retains the exact full catalog; a summary is not an instruction or an authority decision.'
  } };
}

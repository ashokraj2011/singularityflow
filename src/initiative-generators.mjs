import { listEpicSources } from './epic-sources.mjs';

/**
 * Generated initiative outputs.
 *
 * Some phase outputs are a restatement of state the engine already holds exactly. Asking a person —
 * or Copilot — to transcribe them is busywork, and worse, the transcription can drift from the
 * truth it is supposed to describe. An output may therefore declare a `generator`, and preparation
 * renders it from committed state instead of from a blank template.
 *
 * A generator is not a substitute for authorship. It is used only where the artifact is a
 * projection of data with a single correct value; anything requiring judgement stays authored.
 */

function cell(value) {
  const text = String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  return text || '—';
}

function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// The evidence register, rendered from the pinned source manifest. Every column here is recorded
// when a source is pinned, so this is a projection rather than a claim.
async function sourceCatalog(root, { initiative }) {
  const { manifest } = await listEpicSources(root, initiative.initiative.id).catch(() => ({ manifest: { sources: [] } }));
  const sources = manifest?.sources ?? [];
  const source = initiative.initiative.source ?? {};
  const jiraAttachments = source.type === 'jira' ? (source.attachments ?? []) : [];
  const pinnedNames = new Set(sources.map((entry) => entry.name));

  const lines = [
    `# Source Catalog — ${initiative.initiative.id}`,
    '',
    'Generated from the pinned source manifest. Every row is recorded when a source is pinned, so',
    'this file is a projection of governed state rather than an authored description — edit the',
    'sources, not this document.',
    '',
    '## Pinned sources',
    ''
  ];

  if (!sources.length) {
    lines.push('_No sources are pinned yet. Requirements may only cite pinned evidence._', '');
  } else {
    lines.push(
      '| Source ID | Name | Provider | Version | SHA-256 | Size | Pinned at |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...sources.map((entry) => `| ${cell(entry.sourceId)} | ${cell(entry.name)} | ${cell(entry.provider)} | ${cell(entry.version)} | \`${cell(entry.sha256).slice(0, 16)}\` | ${bytes(entry.bytes)} | ${cell(entry.registeredAt)} |`),
      ''
    );
  }

  if (source.type === 'jira') {
    lines.push(
      '## Epic record',
      '',
      `Imported from Jira ${cell(source.key ?? initiative.initiative.id)} at start and pinned into initiative state.`,
      '',
      '| Field | Value |',
      '| --- | --- |',
      `| Jira key | ${cell(source.key)} |`,
      `| Summary | ${cell(source.title)} |`,
      `| Status | ${cell(source.status)} |`,
      `| Priority | ${cell(source.priority)} |`,
      `| Reporter | ${cell(source.reporter)} |`,
      `| Assignee | ${cell(source.assignee)} |`,
      ''
    );
  }

  if (jiraAttachments.length) {
    // Listed, but explicitly not evidence: an attachment becomes citable only once it is pinned
    // and hash-verified, and hiding that distinction is how unverifiable claims get in.
    const unpinned = jiraAttachments.filter((file) => !pinnedNames.has(file.filename));
    lines.push(
      '## Jira attachments',
      '',
      unpinned.length
        ? `${unpinned.length} of ${jiraAttachments.length} Jira attachment(s) are not pinned. Requirements cannot cite them until they are pinned and hash-verified.`
        : 'Every Jira attachment is pinned above.',
      '',
      '| Attachment | Type | Size | Pinned |',
      '| --- | --- | --- | --- |',
      ...jiraAttachments.map((file) => `| ${cell(file.filename)} | ${cell(file.mimeType)} | ${bytes(file.size)} | ${pinnedNames.has(file.filename) ? 'yes' : 'no'} |`),
      ''
    );
  }

  lines.push(
    '## Coverage',
    '',
    `${sources.length} pinned source${sources.length === 1 ? '' : 's'}${jiraAttachments.length ? `, ${jiraAttachments.length} Jira attachment${jiraAttachments.length === 1 ? '' : 's'} on the Epic` : ''}.`,
    'Anything a requirement cites must appear in the pinned table above.',
    ''
  );
  return lines.join('\n');
}

export const INITIATIVE_GENERATORS = Object.freeze({ 'source-catalog': sourceCatalog });

export function isInitiativeGenerator(id) {
  return Object.prototype.hasOwnProperty.call(INITIATIVE_GENERATORS, id);
}

export async function renderInitiativeGenerator(id, root, context) {
  const generator = INITIATIVE_GENERATORS[id];
  if (!generator) throw new Error(`Unknown initiative output generator '${id}'.`);
  return generator(root, context);
}

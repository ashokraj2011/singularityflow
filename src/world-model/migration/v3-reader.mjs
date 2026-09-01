import { SingularityFlowError } from '../../util.mjs';
import { isPlainRecord, sha256 } from '../canonicalize.mjs';

export const LEGACY_WORLD_MODEL_CLASSIFICATION = 'legacy-unregistered-view';

function utf8(raw) {
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return Buffer.from(raw).toString('utf8');
  if (typeof raw === 'string') return raw;
  return `${JSON.stringify(raw, null, 2)}\n`;
}
function parsedJson(text) {
  try { return JSON.parse(text); }
  catch { return null; }
}

export function classifyWorldModelInput(raw) {
  const text = utf8(raw);
  const parsed = isPlainRecord(raw) ? raw : parsedJson(text);
  if (isPlainRecord(parsed)) {
    if (parsed.kind === 'world-model-manifest' && parsed.format === 'wmb-v4') {
      return Object.freeze({ classification: 'registered-v4-manifest', sourceFormat: 'wmb-v4' });
    }
    if (Object.hasOwn(parsed, 'schema_version') || Object.hasOwn(parsed, 'source_schema_version')) {
      return Object.freeze({
        classification: LEGACY_WORLD_MODEL_CLASSIFICATION,
        sourceFormat: 'wmb-v3',
        sourceSchemaVersion: parsed.schema_version ?? parsed.source_schema_version ?? null,
        artifactKind: 'manifest'
      });
    }
  }
  if (/SFlow World-Model View/.test(text) && /fact-ledger-sha256: sha256:[a-f0-9]{64}/.test(text)
      && /(?:^|\n)## Facts\b/.test(text)) {
    return Object.freeze({ classification: 'registered-v4-view', sourceFormat: 'wmb-v4' });
  }
  return Object.freeze({
    classification: LEGACY_WORLD_MODEL_CLASSIFICATION,
    sourceFormat: 'wmb-v3',
    sourceSchemaVersion: null,
    artifactKind: 'view'
  });
}

export function worldModelMigrationRequired(raw) {
  const classification = classifyWorldModelInput(raw);
  if (!classification.classification.startsWith('legacy-')) return null;
  const error = new SingularityFlowError(
    'Legacy World-Model output is unregistered and cannot be consumed as WMB v4. Migrate or rebuild it explicitly.',
    {
      code: 'WMB_MIGRATION_REQUIRED',
      details: classification
    }
  );
  error.classification = LEGACY_WORLD_MODEL_CLASSIFICATION;
  return error;
}

function evidenceCandidates(line) {
  return [...new Set([...line.matchAll(/(?<![A-Za-z0-9_.-])(?<path>[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)#(?<symbol>[A-Za-z_$][A-Za-z0-9_.$:-]*)/g)]
    .map((match) => `${match.groups.path}#${match.groups.symbol}`))].sort();
}

function claimText(line) {
  return line
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\s*\[(?:confidence|assurance)\s*[:=]\s*(?:exact|partial|unavailable)\]\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function markdownClaims(text) {
  const claims = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--') || trimmed.startsWith('-->')
        || trimmed === '---' || trimmed.startsWith('```') || /^[-a-z-]+:\s/.test(trimmed)) continue;
    const textValue = claimText(trimmed);
    if (!textValue || textValue.length < 4) continue;
    const confidence = /\bconfidence\s*[:=]\s*(exact|partial|unavailable)\b/i.exec(trimmed)?.[1]?.toLowerCase() ?? null;
    claims.push({
      index: claims.length,
      text: textValue,
      claimSha256: sha256({ text: textValue }),
      evidenceCandidates: evidenceCandidates(trimmed),
      legacyConfidence: confidence
    });
  }
  return claims;
}

/** Parse only migration candidates. Nothing returned by this reader is registered evidence or fact. */
export function readLegacyWorldModelView(raw, { sourcePath = null } = {}) {
  const classification = classifyWorldModelInput(raw);
  if (classification.classification !== LEGACY_WORLD_MODEL_CLASSIFICATION) {
    throw new SingularityFlowError('Input is already registered WMB v4 and is not a v3 migration source.', {
      code: 'WMB_MIGRATION_SOURCE_INVALID', details: classification
    });
  }
  const text = utf8(raw);
  const parsed = isPlainRecord(raw) ? structuredClone(raw) : parsedJson(text);
  const claims = classification.artifactKind === 'view' ? markdownClaims(text) : [];
  return Object.freeze({
    classification: LEGACY_WORLD_MODEL_CLASSIFICATION,
    sourceFormat: 'wmb-v3',
    sourceSchemaVersion: classification.sourceSchemaVersion,
    artifactKind: classification.artifactKind,
    sourcePath,
    sourceViewSha256: sha256({ utf8: text }),
    claims: Object.freeze(claims),
    manifest: classification.artifactKind === 'manifest' ? Object.freeze(parsed) : null
  });
}

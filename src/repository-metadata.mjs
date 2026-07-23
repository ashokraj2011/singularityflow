import { SingularityFlowError } from './util.mjs';

export const REPOSITORY_METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

function normalizedValue(value, label) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) throw new SingularityFlowError(`${label} cannot be empty.`);
    if (normalized.length > 4096) throw new SingularityFlowError(`${label} cannot exceed 4096 characters.`);
    return normalized;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SingularityFlowError(`${label} must be a finite number.`);
    return value;
  }
  if (typeof value === 'boolean') return value;
  throw new SingularityFlowError(`${label} must be a string, number, or boolean.`);
}

export function normalizeRepositoryMetadata(value = {}, label = 'Repository metadata') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${label} must be a key/value object.`);
  }
  const metadata = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = String(rawKey).trim();
    if (!REPOSITORY_METADATA_KEY_PATTERN.test(key)) {
      throw new SingularityFlowError(`${label} key '${rawKey}' must start with a letter and contain only letters, numbers, dots, underscores, or hyphens.`);
    }
    metadata[key] = normalizedValue(rawValue, `${label}.${key}`);
  }
  return metadata;
}

export function repositoryMetadataLabel(repository, fallback) {
  return String(repository?.metadata?.name ?? fallback).trim() || fallback;
}

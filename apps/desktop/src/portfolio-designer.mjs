const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

function clone(value) {
  return structuredClone(value);
}

export function repositoryMetadataFromForm({ appId = '', name = '', metadata = [] } = {}) {
  const result = {};
  if (String(appId).trim()) result.appId = String(appId).trim();
  if (String(name).trim()) result.name = String(name).trim();
  for (const entry of metadata) {
    const key = String(entry?.key ?? '').trim();
    const value = String(entry?.value ?? '').trim();
    if (!key && !value) continue;
    if (!key || !METADATA_KEY_PATTERN.test(key)) {
      throw new Error('Metadata keys must start with a letter and contain only letters, numbers, dots, underscores, or hyphens.');
    }
    if (!value) throw new Error(`Metadata '${key}' requires a value.`);
    if (Object.hasOwn(result, key)) throw new Error(`Metadata key '${key}' is duplicated.`);
    result[key] = value;
  }
  return result;
}

export function addPortfolioRepository(portfolio, values) {
  const id = String(values.id ?? '').trim();
  const url = String(values.url ?? '').trim();
  const defaultBranch = String(values.defaultBranch ?? 'main').trim();
  if (!REPOSITORY_ID_PATTERN.test(id)) throw new Error('Repository ID must be a portable identifier.');
  if (portfolio.repositories?.[id]) throw new Error(`Repository '${id}' already exists.`);
  if (!url || url.startsWith('-') || url.startsWith('ext::')) throw new Error('A safe Git clone URL is required.');
  if (!defaultBranch) throw new Error('Default branch is required.');
  const next = clone(portfolio);
  next.repositories ??= {};
  next.repositories[id] = {
    url,
    defaultBranch,
    required: values.required !== false,
    metadata: repositoryMetadataFromForm(values)
  };
  return next;
}

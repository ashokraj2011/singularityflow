import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_ROOT } from '../package-root.mjs';

function absolutePath(item) {
  if (typeof item.path === 'string') return path.resolve(item.path);
  if (item.url instanceof URL) return fileURLToPath(item.url);
  throw new TypeError('Implementation digest entries require an absolute path or file URL.');
}

function filesBelow(directory, prefix) {
  const values = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    const label = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) values.push(...filesBelow(absolute, label));
    else if (entry.isFile()) values.push({ absolute, label });
  }
  return values;
}

/**
 * Hash reviewed implementation bytes under stable package-relative labels.
 *
 * Durable WMB identities must change when executable/schema bytes change. Hashing a version label
 * merely asks maintainers to remember to invalidate caches; hashing the packaged bytes makes that
 * invalidation mechanical and independent of the installation directory.
 */
export function implementationSourceSha256({ directories = [], files = [] } = {}) {
  const entries = [];
  for (const item of directories) {
    entries.push(...filesBelow(absolutePath(item), item.label));
  }
  for (const item of files) {
    entries.push({ absolute: absolutePath(item), label: item.label });
  }
  entries.sort((left, right) => left.label.localeCompare(right.label));
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.label, 'utf8');
    hash.update('\0');
    hash.update(readFileSync(entry.absolute));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export const WMB_V4_KERNEL_SOURCE_SHA256 = implementationSourceSha256({
  directories: [{
    label: 'src/world-model', path: path.join(PACKAGE_ROOT, 'src', 'world-model')
  }],
  files: [
    {
      label: 'src/repository-facts.mjs',
      path: path.join(PACKAGE_ROOT, 'src', 'repository-facts.mjs')
    },
    {
      label: 'schemas/world-model-composition-candidate.schema.json',
      path: path.join(PACKAGE_ROOT, 'schemas', 'world-model-composition-candidate.schema.json')
    }
  ]
});

export const WMB_V4_CANDIDATE_SCHEMA_SOURCE_SHA256 = implementationSourceSha256({
  files: [{
    label: 'schemas/world-model-composition-candidate.schema.json',
    path: path.join(PACKAGE_ROOT, 'schemas', 'world-model-composition-candidate.schema.json')
  }]
});

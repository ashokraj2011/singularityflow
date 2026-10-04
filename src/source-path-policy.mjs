import { SingularityFlowError } from './util.mjs';

function normalizePaths(value, label, { files = false } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw new SingularityFlowError(`${label} must be a list of at most 64 repository-relative ${files ? 'files' : 'directories'}.`);
  }
  const paths = [];
  const caseFolded = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw || raw !== raw.trim() || raw.includes('\\')
      || /[\u0000-\u001f\u007f*?\[\]{}<>:"|]/u.test(raw) || raw.startsWith('/')
      || /^[A-Za-z]:/u.test(raw) || raw.endsWith('/') || raw.includes('//')
      || raw.split('/').some(segment => !segment || segment === '.' || segment === '..'
        || segment.endsWith('.') || segment.endsWith(' ')
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
      throw new SingularityFlowError(`${label} entries must be canonical repository-relative paths without globs or '..'.`);
    }
    if (raw === '.git' || raw.startsWith('.git/') || raw === 'singularity' || raw.startsWith('singularity/')) {
      throw new SingularityFlowError(`${label} cannot include Git or Singularity Flow governance paths.`);
    }
    const folded = raw.toLocaleLowerCase('en-US');
    if (caseFolded.has(folded) && !paths.includes(raw)) {
      throw new SingularityFlowError(`${label} contains paths that collide on a case-insensitive filesystem.`);
    }
    caseFolded.add(folded);
    if (!paths.includes(raw)) paths.push(raw);
  }
  return paths.sort();
}

/** Approved source exclusions are still hashed as separate test inputs. */
export function normalizeSourceHashExcludedRoots(value, label = 'sourceHashExcludedRoots') {
  return normalizePaths(value, label);
}

/** Exact test configuration files, never an extension-wide or glob-wide exception. */
export function normalizeTestConfigurationPaths(value, label = 'testConfigurationPaths') {
  return normalizePaths(value, label, { files: true });
}

export function sourcePathPolicy(scope = {}) {
  return {
    sourceHashExcludedRoots: normalizeSourceHashExcludedRoots(scope?.sourceHashExcludedRoots),
    testConfigurationPaths: normalizeTestConfigurationPaths(scope?.testConfigurationPaths)
  };
}

export function isSeparatelyHashedTestInput(relative, policy = {}) {
  return (policy.testConfigurationPaths ?? []).includes(relative)
    || (policy.sourceHashExcludedRoots ?? []).some(root => relative === root || relative.startsWith(`${root}/`));
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const LOCK_ROOT_FIELDS = Object.freeze([
  'name',
  'version',
  'license',
  'workspaces',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'engines',
  'bin',
  'bundleDependencies'
]);

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
}

function same(left, right) {
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

function dependencyLocations(packages, name) {
  const suffix = `node_modules/${name}`;
  return Object.entries(packages).filter(([location]) =>
    location === suffix || location.endsWith(`/${suffix}`));
}

function validHttpsArchive(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && parsed.pathname !== '/'
      && parsed.username === '' && parsed.password === '' && parsed.hash === '';
  } catch {
    return false;
  }
}

function validSha512Integrity(value) {
  const match = typeof value === 'string' && value.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return false;
  const bytes = Buffer.from(match[1], 'base64');
  return bytes.length === 64 && bytes.toString('base64') === match[1];
}

/**
 * Validate the manifest/lock invariants used by release packaging toolchains.
 * The result is data rather than an exception so the repository check can report
 * every drift in one run and tests can exercise each refusal deterministically.
 */
export function releaseDependencyLockProblems(manifest, lock, {
  label = 'package',
  requireBundled = false,
  requirePrivate = false,
  registryEntries = 'production',
  validateOverrides = false,
  allowedLinks = [],
  allowNpmBundledClosure = false
} = {}) {
  const problems = [];
  const packages = lock?.packages;
  const lockedRoot = packages?.[''];
  if (lock?.lockfileVersion !== 3) {
    problems.push(`${label}: package-lock.json must use lockfileVersion 3`);
  }
  if (lock?.requires !== true) {
    problems.push(`${label}: package-lock.json must declare requires=true`);
  }
  if (!lockedRoot || typeof lockedRoot !== 'object' || Array.isArray(lockedRoot)) {
    problems.push(`${label}: package-lock.json is missing its root package entry`);
    return problems;
  }
  if (requirePrivate && manifest?.private !== true) {
    problems.push(`${label}: packaging toolchain package.json must be private`);
  }

  for (const field of LOCK_ROOT_FIELDS) {
    if (!same(manifest?.[field], lockedRoot[field])) {
      problems.push(`${label}: package.json ${field} does not exactly match package-lock.json root ${field}`);
    }
  }
  for (const field of ['name', 'version']) {
    if (manifest?.[field] !== undefined && lock?.[field] !== manifest[field]) {
      problems.push(`${label}: package-lock.json top-level ${field} does not match package.json`);
    }
  }

  const dependencies = manifest?.dependencies ?? {};
  const dependencyNames = Object.keys(dependencies).sort();
  const bundles = [...(manifest?.bundleDependencies ?? [])].sort();
  if (requireBundled && !same(dependencyNames, bundles)) {
    problems.push(`${label}: bundleDependencies must contain every and only direct production dependency`);
  }

  for (const [name, requested] of Object.entries(dependencies)) {
    if (typeof requested !== 'string' || !EXACT_VERSION.test(requested)) {
      problems.push(`${label}: production dependency ${name} must use an exact version, not '${requested}'`);
      continue;
    }
    const direct = packages[`node_modules/${name}`];
    if (!direct || direct.link) {
      problems.push(`${label}: package-lock.json is missing the ordinary direct dependency ${name}`);
      continue;
    }
    if (direct.version !== requested) {
      problems.push(`${label}: locked ${name} version '${direct.version ?? 'missing'}' does not equal '${requested}'`);
    }
    if (requireBundled && direct.inBundle !== true) {
      problems.push(`${label}: locked direct dependency ${name} must be marked inBundle`);
    }
  }

  if (validateOverrides) {
    for (const [name, requested] of Object.entries(manifest?.overrides ?? {})) {
      if (typeof requested !== 'string' || !EXACT_VERSION.test(requested)) {
        problems.push(`${label}: override ${name} must use an exact version, not '${requested}'`);
        continue;
      }
      const matches = dependencyLocations(packages, name);
      if (matches.length === 0) {
        problems.push(`${label}: override ${name} has no package-lock.json entry`);
      }
      for (const [location, dependency] of matches) {
        if (dependency.version !== requested) {
          problems.push(`${label}: override ${name} resolved to '${dependency.version ?? 'missing'}' at ${location}, not '${requested}'`);
        }
      }
    }
  }

  const allowedLinkSet = new Set(allowedLinks);
  for (const [location, dependency] of Object.entries(packages)) {
    if (!location.includes('node_modules/')) continue;
    if (dependency.link) {
      if (!allowedLinkSet.has(location)) {
        problems.push(`${label}: lock entry ${location} must not be a mutable link`);
      }
      continue;
    }
    if (registryEntries === 'production' && dependency.dev) continue;
    if (requireBundled && !dependency.dev && dependency.inBundle !== true) {
      problems.push(`${label}: production lock entry ${location} must be marked inBundle`);
    }
    // The exact npm archive embeds its own transitive closure. Only those nested entries may omit
    // individual archive fields, and their bytes remain bound by node_modules/npm's SHA-512 SRI.
    const npmBundled = allowNpmBundledClosure
      && location.startsWith('node_modules/npm/node_modules/')
      && dependency.inBundle === true
      && dependency.resolved === undefined
      && dependency.integrity === undefined;
    if (npmBundled) continue;
    if (!validHttpsArchive(dependency.resolved) || !validSha512Integrity(dependency.integrity)) {
      problems.push(`${label}: lock entry ${location} must bind an HTTPS archive and SHA-512 integrity`);
    }
  }

  return problems;
}

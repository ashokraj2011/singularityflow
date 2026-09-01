import { normalizeRepositoryPath } from '../contracts.mjs';
import { compareText } from '../canonicalize.mjs';
import { normalizeScopePattern, validateScopeManifest } from './manifest.mjs';

function escapeRegex(character) {
  return /[\\^$+.|()]/.test(character) ? `\\${character}` : character;
}

export function scopePatternRegex(value) {
  const pattern = normalizeScopePattern(value);
  if (!/[*?]/.test(pattern)) {
    return new RegExp(`^${pattern.split('').map(escapeRegex).join('')}(?:/.*)?$`);
  }
  if (pattern.endsWith('/**') && !/[*?]/.test(pattern.slice(0, -3))) {
    const base = pattern.slice(0, -3).split('').map(escapeRegex).join('');
    return new RegExp(`^${base}(?:/.*)?$`);
  }
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += escapeRegex(character);
  }
  return new RegExp(`${source}$`);
}

function literalBase(pattern) {
  const first = pattern.search(/[*?]/);
  return (first < 0 ? pattern : pattern.slice(0, first)).replace(/\/$/, '');
}

function matchRecord(relative, pattern, classification) {
  if (!scopePatternRegex(pattern).test(relative)) return null;
  const base = literalBase(pattern);
  const baseDepth = base ? base.split('/').filter(Boolean).length : 0;
  const pathDepth = relative.split('/').length;
  return { pattern, classification, traversalDepth: Math.max(0, pathDepth - baseDepth) };
}

export function classifyScopePath(value, manifest) {
  const scope = validateScopeManifest(manifest);
  const relative = normalizeRepositoryPath(value, 'Scoped repository path');
  const excluded = scope.excludedPaths.map((pattern) => matchRecord(relative, pattern, 'excluded')).filter(Boolean);
  if (excluded.length) return { path: relative, status: 'excluded', match: excluded.sort((a, b) => b.pattern.length - a.pattern.length)[0] };
  const included = [
    ...scope.allowedPaths.map((pattern) => matchRecord(relative, pattern, 'allowed')),
    ...scope.sharedPaths.map((pattern) => matchRecord(relative, pattern, 'shared'))
  ].filter(Boolean).sort((a, b) => b.pattern.length - a.pattern.length || compareText(a.classification, b.classification));
  if (!included.length) return { path: relative, status: 'outside', match: null };
  const match = included[0];
  if (match.traversalDepth > scope.maximumTraversalDepth) return { path: relative, status: 'too-deep', match };
  return { path: relative, status: 'inside', match };
}

export function pathInsideScope(value, manifest) {
  return classifyScopePath(value, manifest).status === 'inside';
}

export function scopedSnapshotFiles(sourceSnapshot, manifest) {
  validateScopeManifest(manifest);
  return (sourceSnapshot.files ?? []).filter((file) => pathInsideScope(file.path, manifest));
}

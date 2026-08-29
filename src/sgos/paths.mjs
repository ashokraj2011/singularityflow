/**
 * Portable absolute paths used by SGOS durable contracts.
 *
 * Contract bytes always use `/`, including Windows drive and UNC paths. Filesystem operations must
 * convert those bytes back through `sgosContractPathToLocal`; feeding a Windows contract path to a
 * POSIX host (or the reverse) is refused rather than accidentally addressing another file.
 */
import path from 'node:path';

import { SingularityFlowError } from '../util.mjs';

function invalid(value, message = 'SGOS path must be an absolute POSIX, Windows-drive, or UNC path.') {
  throw new SingularityFlowError(message, {
    code: 'SGOS_PATH_INVALID',
    details: { path: String(value ?? '') }
  });
}

function validateWindowsSegment(segment, value) {
  if (!segment || segment === '.' || segment === '..'
      || /[<>:"|?*\u0000-\u001f]/.test(segment) || /[ .]$/.test(segment)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment)) {
    invalid(value, `SGOS Windows path contains unsafe component '${segment}'.`);
  }
}

function parts(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) invalid(value);
  let slash = value.replaceAll('\\', '/');
  // Native Windows APIs may return the long-path namespace. It identifies the same drive/UNC
  // location, but the process-specific prefix must never enter a content-addressed contract.
  if (/^\/\/\?\/UNC\//i.test(slash)) slash = `//${slash.slice('//?/UNC/'.length)}`;
  else if (/^\/\/\?\/[A-Za-z]:\//.test(slash)) slash = slash.slice('//?/'.length);
  let kind;
  let root;
  let remainder;
  const drive = slash.match(/^([A-Za-z]):\/(.*)$/s);
  if (drive) {
    kind = 'windows-drive';
    root = `${drive[1].toUpperCase()}:/`;
    remainder = drive[2];
  } else if (slash.startsWith('//')) {
    const unc = slash.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/s);
    if (!unc) invalid(value, 'SGOS UNC path must include a non-empty server and share.');
    kind = 'windows-unc';
    root = `//${unc[1]}/${unc[2]}`;
    remainder = unc[3] ?? '';
    validateWindowsSegment(unc[1], value);
    validateWindowsSegment(unc[2], value);
  } else if (slash.startsWith('/')) {
    kind = 'posix';
    root = '/';
    remainder = slash.slice(1);
  } else {
    invalid(value);
  }

  const segments = remainder.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    invalid(value, 'SGOS paths cannot contain dot or parent-traversal segments.');
  }
  if (kind !== 'posix') segments.forEach((segment) => validateWindowsSegment(segment, value));
  return { kind, root, segments };
}

/** Normalize a native absolute path into the stable representation stored in SGOS records. */
export function canonicalizeSgosAbsolutePath(value) {
  const parsed = parts(value);
  if (!parsed.segments.length) return parsed.root;
  return parsed.root === '/'
    ? `/${parsed.segments.join('/')}`
    : `${parsed.root}${parsed.root.endsWith('/') ? '' : '/'}${parsed.segments.join('/')}`;
}

/**
 * Convert canonical contract bytes to a path for one explicitly named host platform.
 *
 * The optional platform makes the boundary testable on every CI host; production callers omit it.
 */
export function sgosContractPathToLocal(value, { platform = process.platform } = {}) {
  const parsed = parts(value);
  const canonical = canonicalizeSgosAbsolutePath(value);
  if (canonical !== value) {
    invalid(value, 'SGOS durable path is not in canonical `/`-separated form.');
  }
  if (platform === 'win32') {
    if (parsed.kind === 'posix') {
      throw new SingularityFlowError('A POSIX SGOS path cannot be used by a Windows filesystem operation.', {
        code: 'SGOS_PATH_PLATFORM_MISMATCH', details: { path: value, platform }
      });
    }
    if (parsed.kind === 'windows-unc') {
      return `\\\\${parsed.root.slice(2).replaceAll('/', '\\')}${parsed.segments.length ? `\\${parsed.segments.join('\\')}` : ''}`;
    }
    return `${parsed.root.replaceAll('/', '\\')}${parsed.segments.join('\\')}`;
  }
  if (parsed.kind !== 'posix') {
    throw new SingularityFlowError('A Windows SGOS path cannot be used by a POSIX filesystem operation.', {
      code: 'SGOS_PATH_PLATFORM_MISMATCH', details: { path: value, platform }
    });
  }
  return canonical;
}

/** Canonicalize a native path and prove that it can be mapped back on the current host. */
export function sgosContractPathFromLocal(value, { platform = process.platform } = {}) {
  if (platform !== 'win32' && String(value ?? '').includes('\\')) {
    invalid(value, 'A POSIX SGOS path cannot contain a literal backslash.');
  }
  const canonical = canonicalizeSgosAbsolutePath(value);
  sgosContractPathToLocal(canonical, { platform });
  return canonical;
}

/** Resolve a user-supplied native path before it crosses into an SGOS contract. */
export function resolveSgosLocalAbsolutePath(value, { platform = process.platform } = {}) {
  const resolver = platform === 'win32' ? path.win32 : path.posix;
  if (!resolver.isAbsolute(String(value ?? ''))) invalid(value);
  return sgosContractPathFromLocal(resolver.resolve(value), { platform });
}

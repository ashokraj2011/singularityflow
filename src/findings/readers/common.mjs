/**
 * What every finding reader shares: parsing a report as bounded data, and turning the paths a tool
 * reports (absolute, `file://`, relative to the folder it ran in) into repository paths.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { SingularityFlowError } from '../../util.mjs';
import { canonicalJson } from '../../records.mjs';

// A report larger than this is not read: a scanner writing that much is misconfigured.
export const MAX_REPORT_BYTES = 32 * 1024 * 1024;

export function readerError(message, details = {}) {
  return new SingularityFlowError(message, { code: 'FINDING_REPORT_UNREADABLE', details });
}

/** The report as JSON, from text, bytes or an already-parsed value. */
export function reportJson(value, label) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  if (Buffer.byteLength(text) > MAX_REPORT_BYTES) throw readerError(`${label} report is larger than ${MAX_REPORT_BYTES} bytes.`);
  // A tool may print a banner line before its JSON on the same stream; read from the first bracket.
  const start = text.search(/[[{]/u);
  try { return JSON.parse(start > 0 ? text.slice(start) : text); }
  catch { throw readerError(`${label} report is not valid JSON.`); }
}

export const digestOf = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

/**
 * A function from a reported path to a repository path. `bases` are the absolute folders a tool may
 * report under (the repository, the isolated candidate it ran in, the command's own folder), each
 * with the repository-relative folder it stands for; relative paths are read against `cwd`.
 */
export function repositoryPaths({ bases = [], cwd = '.' } = {}) {
  const known = bases.filter((base) => base?.absolute).map((base) => ({
    absolute: path.resolve(base.absolute).replaceAll('\\', '/').replace(/\/$/u, ''),
    relative: String(base.relative ?? '.').replaceAll('\\', '/').replace(/^\.\/?/u, '').replace(/\/$/u, '')
  })).sort((left, right) => right.absolute.length - left.absolute.length);
  const join = (...pieces) => path.posix.normalize(pieces.filter((piece) => piece && piece !== '.').join('/') || '.');
  return (value) => {
    let reported = String(value ?? '').trim();
    if (!reported) return null;
    if (/^file:\/\//iu.test(reported)) {
      try { reported = decodeURIComponent(new URL(reported).pathname); } catch { return null; }
      if (/^\/[A-Za-z]:\//u.test(reported)) reported = reported.slice(1);
    }
    reported = reported.replaceAll('\\', '/');
    if (path.posix.isAbsolute(reported) || /^[A-Za-z]:\//u.test(reported)) {
      // macOS reports /private/var for /var: compare both spellings.
      const variants = [reported, reported.replace(/^\/private\//u, '/'), `/private${reported}`];
      for (const base of known) {
        for (const candidate of variants) {
          if (candidate === base.absolute || candidate.startsWith(`${base.absolute}/`)) {
            const inside = candidate.slice(base.absolute.length + 1);
            const joined = join(base.relative, inside);
            return joined.startsWith('../') || joined === '..' ? null : joined;
          }
        }
      }
      return null;
    }
    const joined = join(String(cwd ?? '.').replaceAll('\\', '/'), reported.replace(/^\.\//u, ''));
    return joined === '.' || joined.startsWith('../') ? null : joined;
  };
}

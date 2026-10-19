/**
 * `capability set|edit <ID> --application-file FILE` [RUN amendment §3, "Writing"]: the capability's
 * whole `application` block from a YAML or JSON file, such as the `applicationDraft` that
 * `app suggest` prints. The block replaces the capability's own. It is read here (bounded, a regular
 * file), its shape checked and each typed start entry's own fields checked (run-configurations.mjs);
 * editCapability then validates the edited map, with this capability's repositories, before anything
 * is written. An empty FILE (`--application-file ''`) removes the block. `app config preview` reads
 * a block the same way and reports every error instead of refusing on the first.
 */
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { errorPath, locatedErrors, runConfigurationErrors } from './run-configurations.mjs';
import { SingularityFlowError } from './util.mjs';

const MAXIMUM_BYTES = 256 * 1024;

function refuse(message, details = {}, suffix = ' Nothing was written.') {
  return new SingularityFlowError(`--application-file ${message}${suffix}`, { code: 'CAPABILITY_APPLICATION_FILE_INVALID', details });
}

/** The application block a file holds, read bounded; refused when unreadable, oversized or not an object. */
export function readApplicationBlockFile(file, { cwd = process.cwd(), suffix = ' Nothing was written.' } = {}) {
  const absolute = path.resolve(cwd, String(file));
  let entry;
  try { entry = lstatSync(absolute); } catch { throw refuse(`names ${file}, which does not exist.`, { file }, suffix); }
  if (!entry.isFile()) throw refuse(`must name a regular file, not ${entry.isSymbolicLink() ? 'a symbolic link' : 'a directory'}.`, { file }, suffix);
  if (entry.size > MAXIMUM_BYTES) throw refuse(`is larger than ${MAXIMUM_BYTES / 1024} KiB.`, { file }, suffix);
  let value;
  try { value = YAML.parse(readFileSync(absolute, 'utf8')); } catch (error) { throw refuse(`is not YAML or JSON: ${error.message}`, { file }, suffix); }
  // The block itself, or a file holding `application:` and nothing else.
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'application')) {
    value = value.application;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw refuse('must hold the application block: an object with start and tests lists.', { file }, suffix);
  }
  return value;
}

export function readApplicationFile(file, { cwd = process.cwd() } = {}) {
  if (file === '' || file === true) return null;
  const value = readApplicationBlockFile(file, { cwd });
  for (const [index, raw] of (Array.isArray(value.start) ? value.start : []).entries()) {
    const [first, ...more] = runConfigurationErrors(raw, { index });
    if (first) {
      throw refuse(`${errorPath(index, first.field)} ${first.message}${more.length ? ` (${more.length} more; app config preview --application-file ${file} lists each)` : ''}`,
        { file, startId: typeof raw?.id === 'string' ? raw.id : null, errors: locatedErrors(index, [first, ...more]) });
    }
  }
  return value;
}

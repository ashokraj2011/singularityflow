/**
 * `capability set|edit <ID> --application-file FILE` [RUN amendment §3, "Writing"]: the capability's
 * whole `application` block from a YAML or JSON file, such as the `applicationDraft` that
 * `app suggest` prints. The block replaces the capability's own. It is read here (bounded, a regular
 * file) and its shape checked; editCapability then validates the edited map, with this capability's
 * repositories, before anything is written. An empty FILE (`--application-file ''`) removes the block.
 */
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { SingularityFlowError } from './util.mjs';

const MAXIMUM_BYTES = 256 * 1024;

function refuse(message, details = {}) {
  return new SingularityFlowError(`--application-file ${message} Nothing was written.`, { code: 'CAPABILITY_APPLICATION_FILE_INVALID', details });
}

export function readApplicationFile(file, { cwd = process.cwd() } = {}) {
  if (file === '' || file === true) return null;
  const absolute = path.resolve(cwd, String(file));
  let entry;
  try { entry = lstatSync(absolute); } catch { throw refuse(`names ${file}, which does not exist.`, { file }); }
  if (!entry.isFile()) throw refuse(`must name a regular file, not ${entry.isSymbolicLink() ? 'a symbolic link' : 'a directory'}.`, { file });
  if (entry.size > MAXIMUM_BYTES) throw refuse(`is larger than ${MAXIMUM_BYTES / 1024} KiB.`, { file });
  let value;
  try { value = YAML.parse(readFileSync(absolute, 'utf8')); } catch (error) { throw refuse(`is not YAML or JSON: ${error.message}`, { file }); }
  // The block itself, or a file holding `application:` and nothing else.
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'application')) {
    value = value.application;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw refuse('must hold the application block: an object with start and tests lists.', { file });
  }
  return value;
}

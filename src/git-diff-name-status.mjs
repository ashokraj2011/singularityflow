/**
 * Strict parser and reader for `git diff --name-status -z`.
 *
 * Git paths are byte strings and may contain every byte except NUL. These configuration-review
 * callers expose paths as JavaScript strings, so this boundary keeps the NUL framing intact until
 * every field has been isolated and then requires each path to be valid UTF-8. It never trims a
 * path or treats tabs/newlines as separators.
 */
import { processResultSucceeded } from './process-result.mjs';
import { run, SingularityFlowError } from './util.mjs';

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 500_000;

export class GitNameStatusParseError extends Error {
  constructor(message, code = 'GIT_DIFF_NAME_STATUS_INVALID') {
    super(message);
    this.name = 'GitNameStatusParseError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new GitNameStatusParseError(message, code);
}

function checkedPositiveInteger(value, description) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`Invalid ${description} limit.`);
  return value;
}

function bytesOf(input, maximumBytes) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    fail('Git name-status parser requires raw bytes.');
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    fail('Invalid Git name-status byte limit.');
  }
  if (input.byteLength > maximumBytes) {
    fail('Git name-status output exceeds its byte limit.', 'GIT_DIFF_NAME_STATUS_LIMIT_EXCEEDED');
  }
  return Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

function fieldsOf(bytes, maximumRecords) {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0) fail('Git name-status output is missing its final NUL.');
  const fields = [];
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0, start);
    if (end < 0) fail('Git name-status output contains a truncated field.');
    if (end === start) fail('Git name-status output contains an empty field.');
    if (fields.length >= maximumRecords * 3) {
      fail('Git name-status output exceeds its record limit.',
        'GIT_DIFF_NAME_STATUS_LIMIT_EXCEEDED');
    }
    fields.push(bytes.subarray(start, end));
    start = end + 1;
  }
  return fields;
}

function statusOf(field) {
  for (const byte of field) {
    if (byte < 0x21 || byte > 0x7e) fail('Git name-status output contains invalid status metadata.');
  }
  const status = field.toString('ascii');
  if (/^[ADMTUXB]$/u.test(status)) return status;
  const similarity = /^([RC])([0-9]{1,3})$/u.exec(status);
  if (!similarity || Number(similarity[2]) > 100) {
    fail(`Git name-status output contains unsupported status '${status}'.`);
  }
  return status;
}

function pathOf(field) {
  try {
    return UTF8.decode(field);
  } catch {
    fail('Git name-status output contains a path that is not valid UTF-8.');
  }
}

/** Parse raw `git diff --name-status -z` bytes into status/path records. */
export function parseGitNameStatus(input, {
  maximumBytes = DEFAULT_MAX_BYTES,
  maximumRecords = DEFAULT_MAX_RECORDS
} = {}) {
  checkedPositiveInteger(maximumRecords, 'Git name-status record');
  const fields = fieldsOf(bytesOf(input, maximumBytes), maximumRecords);
  const changes = [];
  let index = 0;
  while (index < fields.length) {
    if (changes.length >= maximumRecords) {
      fail('Git name-status output exceeds its record limit.',
        'GIT_DIFF_NAME_STATUS_LIMIT_EXCEEDED');
    }
    const status = statusOf(fields[index++]);
    const pathCount = status[0] === 'R' || status[0] === 'C' ? 2 : 1;
    if (index + pathCount > fields.length) {
      fail(`Git name-status output contains an incomplete '${status[0]}' record.`);
    }
    const paths = [];
    for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
      paths.push(pathOf(fields[index++]));
    }
    changes.push(Object.freeze({ status, paths: Object.freeze(paths) }));
  }
  return Object.freeze(changes);
}

/** Include both source and destination identities for rename/copy records, once each. */
export function changedPathsFromNameStatus(changes) {
  const seen = new Set();
  const paths = [];
  for (const change of changes) {
    for (const changedPath of change.paths) {
      if (seen.has(changedPath)) continue;
      seen.add(changedPath);
      paths.push(changedPath);
    }
  }
  return paths;
}

/**
 * Run one bounded, non-interactive local diff and derive both the path set and status rows from its
 * NUL-framed answer. Explicit rename/copy flags make the result independent of user Git config.
 */
export function readGitNameStatusDiff(root, base, proposal, {
  env = process.env,
  runCommand = run,
  maximumBytes = DEFAULT_MAX_BYTES,
  maximumRecords = DEFAULT_MAX_RECORDS
} = {}) {
  const result = runCommand('git', [
    'diff', '--no-ext-diff', '--name-status', '-z', '--find-renames', '--find-copies',
    `${base}..${proposal}`, '--'
  ], {
    cwd: root,
    env,
    encoding: 'buffer',
    maxBuffer: maximumBytes
  });
  if (!processResultSucceeded(result)) {
    throw new SingularityFlowError(
      'Git did not produce a complete name-status diff; no proposal paths were accepted.', {
        code: 'GIT_DIFF_NAME_STATUS_UNAVAILABLE',
        details: {
          status: Number.isInteger(result?.status) ? result.status : null,
          signal: typeof result?.signal === 'string' ? result.signal : null,
          timedOut: result?.timedOut === true,
          aborted: result?.aborted === true,
          outputOverflow: result?.outputOverflow === true,
          blocked: result?.blocked === true
        }
      }
    );
  }
  const statuses = parseGitNameStatus(result.stdout, { maximumBytes, maximumRecords });
  return Object.freeze({
    names: Object.freeze(changedPathsFromNameStatus(statuses)),
    statuses
  });
}

/**
 * Parsers for Git's NUL-framed listings and explicitly decoded zero-context text patches.
 * Listing functions deliberately accept bytes only: a UTF-8 subprocess decode would already have
 * destroyed a non-UTF-8 repository path before this boundary could inspect it.
 */

// `ignoreBOM: true` is counterintuitive but means “do not strip a leading UTF-8 BOM”. A filename
// beginning with EF BB BF must round-trip as U+FEFF followed by its remaining characters.
import {SingularityFlowError} from './foundation/failures.mjs';

/** Native text-patch decoding only. Which paths and lines establish ownership belongs to the kernel. */
export function gitTagLineDeltas(patch) {
  const headerPath=(value,prefix)=>{let text=value.replace(/\t$/u,'');
    if(text.startsWith('"'))text=text.slice(1,-1).replace(/\\([0-7]{3}|.)/gu,(_,escape)=>escape.length===3
      ?String.fromCharCode(Number.parseInt(escape,8)):({n:'\n',t:'\t'})[escape]??escape);
    return text.startsWith(prefix)?text.slice(prefix.length):null;
  };
  const deltas=[];let oldPath=null,newPath=null,hunk=null;
  for(const line of patch.split('\n')) {
    if(hunk?.removed>0&&line.startsWith('-')) {hunk.removed--;deltas.push({path:oldPath,side:'removed',line:null,text:line.slice(1)});}
    else if(hunk?.added>0&&line.startsWith('+')) {hunk.added--;if(newPath)deltas.push({path:newPath,side:'added',line:hunk.line,text:line.slice(1)});hunk.line++;}
    else if(line.startsWith('diff --git '))[oldPath,newPath,hunk]=[null,null,null];
    else if(!hunk&&line.startsWith('--- '))oldPath=headerPath(line.slice(4),'a/');
    else if(!hunk&&line.startsWith('+++ '))newPath=headerPath(line.slice(4),'b/');
    else {const header=/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      if(header)hunk={removed:Number(header[1]??1),added:Number(header[3]??1),line:Number(header[2])};}
  }
  return deltas;
}
/** Portable provenance stores coordinates, never the source text in Git's patch output. */
export function gitPatchCoordinates(patch) {
  const decode=(value,prefix)=>{
    if(value==='/dev/null')return null;
    let text=value.replace(/\t$/u,'');
    if(text.startsWith('"')){
      const bytes=[];for(let i=1;i<text.length-1;i++){
        if(text[i]!=='\\'){const point=String.fromCodePoint(text.codePointAt(i));bytes.push(...new TextEncoder().encode(point));i+=point.length-1;continue;}
        const octal=/^[0-7]{3}/u.exec(text.slice(i+1));if(octal){bytes.push(Number.parseInt(octal[0],8));i+=3;}
        else {const c=text[++i];bytes.push(...new TextEncoder().encode(({n:'\n',t:'\t',r:'\r',b:'\b',f:'\f',v:'\v'})[c]??c));}
      }text=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(bytes));
    }
    if(!text.startsWith(prefix))throw new GitStatusParseError('Git patch has another path prefix.');return text.slice(prefix.length);
  };
  const rows=[];let row=null,remaining=null;
  for(const line of patch.split('\n')){
    if(remaining&&(remaining.before||remaining.after)){
      if(line.startsWith('-')&&remaining.before)remaining.before--;
      else if(line.startsWith('+')&&remaining.after)remaining.after--;
      else if(!line.startsWith('\\ No newline'))throw new GitStatusParseError('Git patch has incomplete zero-context lines.');
      continue;
    }
    if(line.startsWith('diff --git ')){row=null;remaining=null;}
    else if(line.startsWith('--- ')){row={oldPath:decode(line.slice(4),'a/'),newPath:null,hunks:[]};}
    else if(line.startsWith('+++ ')&&row)row.newPath=decode(line.slice(4),'b/');
    else if(line.startsWith('@@ ')){
      const h=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      if(!row||!h)throw new GitStatusParseError('Git patch has another hunk format.');
      if(!row.hunks.length)rows.push(row);
      const hunk={beforeStart:Number(h[1]),beforeLines:Number(h[2]??1),afterStart:Number(h[3]),afterLines:Number(h[4]??1)};
      row.hunks.push(hunk);remaining={before:hunk.beforeLines,after:hunk.afterLines};
    }
  }
  if(remaining&&(remaining.before||remaining.after))throw new GitStatusParseError('Git patch is truncated.');
  return rows;
}
const utf8 = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 500_000;
const DEFAULT_MAX_PATH_BYTES = 1024 * 1024;

export class GitStatusParseError extends Error {
  constructor(message, code = 'GAL_PARSE_INVALID') {
    super(message);
    this.name = 'GitStatusParseError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new GitStatusParseError(message, code);
}

function bytesOf(input, maxBytes) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    fail('Git listing parser requires raw bytes.', 'GAL_PARSE_INVALID');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('Invalid Git listing byte limit.');
  if (input.byteLength > maxBytes) fail('Git listing exceeds its byte limit.', 'GAL_LIMIT_EXCEEDED');
  return Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

function checkedLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`Invalid ${name} limit.`);
  return value;
}

function* nulRecords(bytes, maxRecords) {
  if (bytes.length && bytes[bytes.length - 1] !== 0) fail('Git listing is missing its final NUL.');
  let start = 0;
  let count = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0, start);
    if (end < 0) fail('Git listing has a truncated record.');
    if (end === start) fail('Git listing has an empty record.');
    if (++count > maxRecords) fail('Git listing exceeds its record limit.', 'GAL_LIMIT_EXCEEDED');
    yield bytes.subarray(start, end);
    start = end + 1;
  }
}

function ascii(field, description, { spaces = false } = {}) {
  for (const byte of field) {
    if (byte < (spaces ? 0x20 : 0x21) || byte > 0x7e) {
      fail(`Invalid ${description} metadata.`);
    }
  }
  return field.toString('ascii');
}

function strictTextOrNull(field) {
  try { return utf8.decode(field); } catch { return null; }
}

function metadataAndPath(record, fieldCount, description) {
  const fields = [];
  let start = 0;
  for (let i = 0; i < fieldCount; i += 1) {
    const space = record.indexOf(0x20, start);
    if (space <= start) fail(`Malformed ${description} metadata.`);
    fields.push(ascii(record.subarray(start, space), description));
    start = space + 1;
  }
  if (start >= record.length) fail(`Missing ${description} path.`);
  return { fields, path: record.subarray(start) };
}

function validateRepoPath(bytes, maxPathBytes, { directoryHint = false } = {}) {
  if (!bytes.length || bytes.length > maxPathBytes) {
    fail(bytes.length ? 'Git path exceeds its byte limit.' : 'Git path is empty.',
      bytes.length ? 'GAL_LIMIT_EXCEEDED' : 'GAL_PARSE_INVALID');
  }
  if (bytes[0] === 0x2f) fail('Git path is absolute.');
  let start = 0;
  for (let i = 0; i <= bytes.length; i += 1) {
    if (i !== bytes.length && bytes[i] !== 0x2f) continue;
    const component = bytes.subarray(start, i);
    if (!component.length && !(directoryHint && i === bytes.length)) {
      fail('Git path contains an empty component.');
    }
    if (component.length === 1 && component[0] === 0x2e) fail('Git path traverses dot.');
    if (component.length === 2 && component[0] === 0x2e && component[1] === 0x2e) {
      fail('Git path traverses parent.');
    }
    start = i + 1;
  }
  return bytes[bytes.length - 1] === 0x2f;
}

function displayBytes(bytes) {
  let display = '';
  for (const byte of bytes) {
    display += byte >= 0x20 && byte <= 0x7e && byte !== 0x5c
      ? String.fromCharCode(byte)
      : `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return display;
}

function repoPath(raw, maxPathBytes, options) {
  const directoryHint = validateRepoPath(raw, maxPathBytes, options);
  try {
    const value = utf8.decode(raw);
    return Object.freeze({ kind: 'utf8', value, display: value, directoryHint });
  } catch {
    return Object.freeze({
      kind: 'bytes', base64: raw.toString('base64'), display: displayBytes(raw), directoryHint
    });
  }
}

function objectFormatLength(objectFormat) {
  if (objectFormat === 'sha1') return 40;
  if (objectFormat === 'sha256') return 64;
  fail('A declared Git object format is required.');
}

function oid(value, length) {
  if (value.length !== length || !/^[0-9a-f]+$/.test(value)) fail('Invalid full Git object ID.');
  return value;
}

function mode(value) {
  if (!/^[0-7]{6}$/.test(value)) fail('Invalid Git file mode.');
  return value;
}

function xy(value, unmerged = false) {
  if (!/^[.MTADRCU]{2}$/.test(value)) fail('Invalid Git XY status.');
  if (unmerged && !new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']).has(value)) {
    fail('Invalid unmerged Git XY status.');
  }
  return Object.freeze({ raw: value, index: value[0], worktree: value[1] });
}

function submodule(value) {
  if (value === 'N...') return Object.freeze({ raw: value, isSubmodule: false,
    commitChanged: false, trackedModified: false, untracked: false });
  if (!/^S[.C][.M][.U]$/.test(value)) fail('Invalid Git submodule flags.');
  return Object.freeze({ raw: value, isSubmodule: true, commitChanged: value[1] === 'C',
    trackedModified: value[2] === 'M', untracked: value[3] === 'U' });
}

function positiveInteger(value, description) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) fail(`Invalid Git ${description}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`Git ${description} exceeds safe integer range.`);
  return parsed;
}

function immutable(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function parseHeader(record, seen, headers, branch) {
  const firstSpace = record.indexOf(0x20, 2);
  if (record[0] !== 0x23 || record[1] !== 0x20 || firstSpace <= 2 || firstSpace === record.length - 1) {
    fail('Malformed Git status header.');
  }
  const name = ascii(record.subarray(2, firstSpace), 'status header name');
  if (!/^[a-z][a-z0-9.-]*$/.test(name)) fail('Invalid Git status header name.');
  if (seen.has(name)) fail('Duplicate Git status header.');
  seen.add(name);
  const rawValue = record.subarray(firstSpace + 1);
  const value = rawValue.toString('base64');
  headers.push({ name, valueBase64: value });
  if (name === 'branch.oid') {
    const text = ascii(rawValue, name);
    branch.oid = text === '(initial)' ? null : oid(text, branch.oidLength);
    branch.initial = text === '(initial)';
  } else if (name === 'branch.head') {
    branch.head = strictTextOrNull(rawValue);
    branch.headBase64 = value;
    branch.detached = rawValue.equals(Buffer.from('(detached)'));
  } else if (name === 'branch.upstream') {
    branch.upstream = strictTextOrNull(rawValue);
    branch.upstreamBase64 = value;
  } else if (name === 'branch.ab') {
    const text = ascii(rawValue, name, { spaces: true });
    const match = /^\+([0-9]+) -([0-9]+)$/.exec(text);
    if (!match) fail('Invalid Git ahead/behind header.');
    branch.ahead = positiveInteger(match[1], 'ahead count');
    branch.behind = positiveInteger(match[2], 'behind count');
  } else if (name === 'stash') {
    branch.stash = positiveInteger(ascii(rawValue, name), 'stash count');
  }
}

/**
 * Parse `git status --porcelain=v2 -z` output. The caller must supply the repository's object
 * format and the exact untracked/ignored selection used to obtain the bytes.
 */
export function parsePorcelainV2Status(input, {
  objectFormat, untracked = 'all', includeIgnored = false, expectBranch = false,
  maxBytes = DEFAULT_MAX_BYTES, maxRecords = DEFAULT_MAX_RECORDS,
  maxPathBytes = DEFAULT_MAX_PATH_BYTES
} = {}) {
  const oidLength = objectFormatLength(objectFormat);
  if (!['all', 'normal', 'no'].includes(untracked) || typeof includeIgnored !== 'boolean'
      || typeof expectBranch !== 'boolean') fail('Invalid Git status selection.');
  checkedLimit(maxRecords, 'record');
  checkedLimit(maxPathBytes, 'path byte');
  const bytes = bytesOf(input, maxBytes);
  const records = nulRecords(bytes, maxRecords);
  const entries = [];
  const headers = [];
  const seen = new Set();
  const branch = { oidLength, oid: null, initial: false, head: null, detached: false,
    headBase64: null, upstream: null, upstreamBase64: null,
    ahead: null, behind: null, stash: null };
  let inEntries = false;
  for (const record of records) {
    if (record[0] === 0x23) {
      if (inEntries) fail('Git status header follows an entry.');
      parseHeader(record, seen, headers, branch);
      continue;
    }
    inEntries = true;
    const type = String.fromCharCode(record[0]);
    if (type === '1' || type === '2') {
      const { fields, path } = metadataAndPath(record, type === '1' ? 8 : 9, 'changed entry');
      const [recordType, xyField, subField, headMode, indexMode, worktreeMode, headOid, indexOid,
        scoreField] = fields;
      if (recordType !== type) fail('Invalid Git changed entry type.');
      const entry = {
        type: type === '1' ? 'ordinary' : 'rename-or-copy',
        xy: xy(xyField), submodule: submodule(subField),
        modes: { head: mode(headMode), index: mode(indexMode), worktree: mode(worktreeMode) },
        oids: { head: oid(headOid, oidLength), index: oid(indexOid, oidLength) },
        path: repoPath(path, maxPathBytes)
      };
      if (type === '2') {
        const match = /^([RC])(0|[1-9][0-9]{0,2})$/.exec(scoreField);
        if (!match || Number(match[2]) > 100 || !xyField.includes(match[1])) {
          fail('Invalid Git rename/copy score.');
        }
        const source = records.next();
        if (source.done) fail('Git rename/copy record has no source path.');
        entry.change = match[1] === 'R' ? 'rename' : 'copy';
        entry.score = Number(match[2]);
        entry.sourcePath = repoPath(source.value, maxPathBytes);
      }
      entries.push(entry);
    } else if (type === 'u') {
      const { fields, path } = metadataAndPath(record, 10, 'unmerged entry');
      const [recordType, xyField, subField, mode1, mode2, mode3, worktreeMode,
        oid1, oid2, oid3] = fields;
      if (recordType !== 'u') fail('Invalid Git unmerged entry type.');
      entries.push({
        type: 'unmerged', xy: xy(xyField, true), submodule: submodule(subField),
        stages: [
          { stage: 1, mode: mode(mode1), oid: oid(oid1, oidLength) },
          { stage: 2, mode: mode(mode2), oid: oid(oid2, oidLength) },
          { stage: 3, mode: mode(mode3), oid: oid(oid3, oidLength) }
        ],
        worktreeMode: mode(worktreeMode), path: repoPath(path, maxPathBytes)
      });
    } else if (type === '?' || type === '!') {
      if (record[1] !== 0x20 || record.length < 3) fail('Malformed Git untracked/ignored entry.');
      if (type === '?' && untracked === 'no') fail('Unexpected untracked Git status entry.');
      if (type === '!' && !includeIgnored) fail('Unexpected ignored Git status entry.');
      entries.push({ type: type === '?' ? 'untracked' : 'ignored',
        path: repoPath(record.subarray(2), maxPathBytes, { directoryHint: true }) });
    } else {
      fail('Unsupported Git porcelain-v2 record type.', 'GAL_OPERATION_UNSUPPORTED');
    }
  }
  const hasOid = seen.has('branch.oid');
  const hasHead = seen.has('branch.head');
  if (hasOid !== hasHead || (expectBranch && !hasOid)) fail('Incomplete Git branch status headers.');
  if (!hasOid && (seen.has('branch.upstream') || seen.has('branch.ab'))) {
    fail('Git tracking header lacks branch identity.');
  }
  if (seen.has('branch.ab') && !seen.has('branch.upstream')) {
    fail('Git ahead/behind header lacks upstream identity.');
  }
  if (branch.initial && branch.detached) fail('Conflicting Git branch status headers.');
  const branchResult = hasOid ? {
    state: branch.initial ? 'unborn' : branch.detached ? 'detached' : 'attached',
    oid: branch.oid, head: branch.head, headBase64: branch.headBase64,
    upstream: branch.upstream, upstreamBase64: branch.upstreamBase64,
    ahead: branch.ahead, behind: branch.behind
  } : null;
  return immutable({ objectFormat, scope: { untracked, includeIgnored },
    headers, branch: branchResult, stashCount: branch.stash, entries });
}

/** Parse `git ls-files --stage -z` without losing stage or pathname bytes. */
export function parseGitIndexStages(input, {
  objectFormat, maxBytes = DEFAULT_MAX_BYTES, maxRecords = DEFAULT_MAX_RECORDS,
  maxPathBytes = DEFAULT_MAX_PATH_BYTES
} = {}) {
  const oidLength = objectFormatLength(objectFormat);
  checkedLimit(maxRecords, 'record');
  checkedLimit(maxPathBytes, 'path byte');
  const bytes = bytesOf(input, maxBytes);
  const entries = [];
  for (const record of nulRecords(bytes, maxRecords)) {
    const first = record.indexOf(0x20);
    const second = record.indexOf(0x20, first + 1);
    const tab = record.indexOf(0x09, second + 1);
    if (first <= 0 || second <= first + 1 || tab !== second + 2 || tab === record.length - 1) {
      fail('Malformed staged Git index entry.');
    }
    const stageText = ascii(record.subarray(second + 1, tab), 'index stage');
    if (!/^[0-3]$/.test(stageText)) fail('Invalid Git index stage.');
    entries.push({ mode: mode(ascii(record.subarray(0, first), 'index mode')),
      oid: oid(ascii(record.subarray(first + 1, second), 'index object ID'), oidLength),
      stage: Number(stageText), path: repoPath(record.subarray(tab + 1), maxPathBytes) });
  }
  return immutable({ objectFormat, entries });
}

/** Legacy raw-diff decoding stays in the source-control adapter; no Git program is executed. */
export function createGitRawDiffParser(normalizeRepositoryPath){
  if(typeof normalizeRepositoryPath!=='function')throw new SingularityFlowError('Raw Git decoding needs an explicit path normalizer.',{code:'CHANGE_SET_PATH_INVALID'});
const STATUS = Object.freeze({
  A: 'added', C: 'copied', D: 'deleted', M: 'modified', R: 'renamed',
  T: 'type-changed', U: 'unmerged', X: 'unknown', B: 'broken'
});


  function nullFields(value){return value.split('\0').filter(field=>field!=='');}
/** Parse `git diff --raw -z`; rename/copy records deliberately retain both endpoints. */
function parseRawDiff(value) {
  const fields = nullFields(value);
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    const match = header.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d+)?$/i);
    if (!match) throw new SingularityFlowError(`Unable to parse Git raw diff record '${header}'.`, { code: 'CHANGE_SET_PARSE_FAILED' });
    const [, oldMode, newMode, oldObject, newObject, letter, score] = match;
    const firstPath = normalizeRepositoryPath(fields[index++]);
    const secondPath = ['R', 'C'].includes(letter.toUpperCase())
      ? normalizeRepositoryPath(fields[index++])
      : null;
    entries.push({
      status: STATUS[letter.toUpperCase()] ?? 'unknown',
      similarity: score == null ? null : Number(score),
      oldPath: letter.toUpperCase() === 'A' ? null : firstPath,
      newPath: letter.toUpperCase() === 'D' ? null : (secondPath ?? firstPath),
      oldMode,
      newMode,
      oldObject: /^0+$/.test(oldObject) ? null : oldObject,
      newObject: /^0+$/.test(newObject) ? null : newObject
    });
  }
  return entries;
}


return parseRawDiff;
}

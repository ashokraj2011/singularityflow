/**
 * The test adapter registry [E2G-015, E2G-016, D2].
 *
 * One closed set of adapter profiles. Each profile says how a module's test command is read:
 * `discover` finds the exact test declarations a criterion tag sits on, `classifyCommand` says what
 * the command selects, `parse` (code-delivery-tests.mjs) turns its report into occurrences and
 * `join` ties one declaration to one occurrence. A profile's ceiling is the strongest assurance it
 * can ever produce: exact profiles reach exact-local-observed; every other result adapter only
 * counts tests, so it stops at module-observed. Nothing here reaches exact-authenticated.
 */
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import { posix, secureRepositoryPath } from '../util.mjs';
import { classifyJavascriptTestCommandScope } from '../wel-javascript.mjs';
import { classifyJunit5SurefireCommandScope, parseJunitTestSources } from '../wel-junit5.mjs';
import { scanJavaScriptDeclarations } from './javascript-declarations.mjs';
import { joinDeclaration } from './join.mjs';
import { profileIsExact, testAdapterProfile } from './profiles.mjs';

export { TEST_ADAPTER_PROFILES, profileCeiling, profileForCommand, profileIsExact, testAdapterProfile } from './profiles.mjs';

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_DISCOVERY_FILES = 256;

/**
 * What a command selects, for disclosure and attempt lineage. Focused, sharded or retried runs are
 * still read occurrence by occurrence; this only explains why an identity may be missing.
 */
export function classifyTestCommand(id, command) {
  const profile = testAdapterProfile(id);
  if (profile.language === 'javascript') {
    const scope = classifyJavascriptTestCommandScope(command);
    return { selection: scope.gaps.length ? 'filtered' : 'complete', gaps: scope.gaps };
  }
  if (profile.runner === 'surefire') {
    const scope = classifyJunit5SurefireCommandScope(command);
    return { selection: scope.gaps.length ? 'filtered' : 'complete', gaps: scope.gaps };
  }
  return { selection: profile.runner === 'gradle' ? 'complete' : 'module', gaps: [] };
}

/** The command among `commands` whose affected roots cover a repository path. */
export function commandCovering(commands, candidate) {
  const covering = commands.filter((command) => (command.affectedRoots ?? []).some((root) => {
    const normalized = posix(root ?? '').replace(/^\.\//u, '').replace(/\/$/u, '') || '.';
    return normalized === '.' || candidate === normalized || candidate.startsWith(`${normalized}/`);
  }));
  // The most specific root wins; equal specificity keeps configuration order.
  return covering.sort((left, right) => {
    const depth = (command) => Math.max(...(command.affectedRoots ?? ['.']).map((root) => (root === '.' ? 0 : root.split('/').length)));
    return depth(right) - depth(left);
  })[0] ?? null;
}

async function readTestSource(root, relative) {
  const secured = await secureRepositoryPath(root, relative, { label: 'Test source', mustExist: true, type: 'file' });
  let handle;
  try {
    handle = await open(secured.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    const link = await lstat(secured.absolute);
    if (!before.isFile() || link.isSymbolicLink() || before.size > MAX_SOURCE_BYTES) {
      return { error: { code: 'TEST_SOURCE_LIMIT_EXCEEDED', message: `the file is not a regular file of at most ${MAX_SOURCE_BYTES} bytes` } };
    }
    const bytes = await handle.readFile();
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
    catch { return { error: { code: 'TEST_SOURCE_NOT_UTF8', message: 'the file is not UTF-8' } }; }
  } finally {
    await handle?.close();
  }
}

/**
 * The exact declarations in some test files of one module. Returns declarations (each with its
 * own gaps), tags that sit on nothing, and file gaps. Never throws for a file's content.
 */
export async function discoverDeclarations(root, id, files, { signal = null, runParser } = {}) {
  const profile = testAdapterProfile(id);
  const unique = [...new Set(files.map((file) => posix(file)))].sort();
  if (!profileIsExact(id)) return { profile: id, declarations: [], unattachedTags: [], fileGaps: {} };
  if (unique.length > MAX_DISCOVERY_FILES) {
    return {
      profile: id, declarations: [], unattachedTags: [],
      fileGaps: Object.fromEntries(unique.map((file) => [file, [{ code: 'TEST_SOURCE_LIMIT_EXCEEDED', message: `more than ${MAX_DISCOVERY_FILES} test files` }]]))
    };
  }
  if (profile.language === 'java') {
    const parsed = await parseJunitTestSources(root, unique, { signal, runParser });
    return { profile: id, declarations: parsed.declarations, unattachedTags: parsed.unattachedTags, fileGaps: parsed.fileGaps };
  }
  const declarations = [];
  const unattachedTags = [];
  const fileGaps = {};
  for (const file of unique) {
    const source = await readTestSource(root, file);
    if (source.error) { fileGaps[file] = [source.error]; continue; }
    const scanned = scanJavaScriptDeclarations(source.text, { sourcePath: file, framework: profile.framework });
    declarations.push(...scanned.declarations);
    unattachedTags.push(...scanned.unattachedTags.map((entry) => ({ sourcePath: file, ...entry })));
    if (scanned.fileGaps.length) fileGaps[file] = scanned.fileGaps;
  }
  return { profile: id, declarations, unattachedTags, fileGaps };
}

/** Join one declaration to the occurrences of one run read by the same profile. */
export function joinWitness(id, declaration, occurrences, run) {
  const profile = testAdapterProfile(id);
  return joinDeclaration(declaration, occurrences, { language: profile.language, runner: profile.runner ?? null, run });
}

/** Independently pinned inventory for the deliberately narrow native Node test adapter. */
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseNativeNodeJunitReport } from './code-delivery-tests.mjs';
import { normalizeTestSelectionPath } from './test-selection-policy.mjs';
import { trpDigest } from './test-recovery-policy.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';

const refuse = message => { throw new SingularityFlowError(message, { code: 'TRP_RISK_ADAPTER_UNAVAILABLE' }); };
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** These host/test-transport controls are omitted from execution, not merely from its digest. */
export function trpNodeExecutionEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('NODE_TEST_')
    && !['SINGULARITY_FLOW_TEST_IDENTITY', '_', 'SHLVL'].includes(key)));
}

export async function readTrpNodeCaseInventory(root, workflow, phase, command, { selected = false } = {}) {
  const entries = (workflow.resolution?.testRecovery?.caseInventory ?? [])
    .filter(entry => entry.phaseId === phase.id && entry.commandId === command.id);
  if (!entries.length) return null;
  if (entries.length !== 1) refuse('The approved test case inventory is ambiguous.');
  if (entries[0].dependencyScope !== 'repository-and-node-builtins-only') {
    refuse('Failed-test evidence reuse requires an explicitly approved repository-local, Node-builtins-only dependency declaration.');
  }
  const declared = entries[0].tests;
  if (!Array.isArray(declared) || !declared.length || declared.length > 10_000) refuse('The approved test case inventory is empty or exceeds its bound.');
  const cwd = normalizeTestSelectionPath(command.workingDirectory ?? '.', { allowRoot: true });
  const argv = command.argv;
  if (command.result?.adapter !== 'junit-xml' || !Array.isArray(argv)
    || argv[1] !== '--test' || argv[2] !== '--test-reporter=junit' || argv.length < 4) {
    refuse('Failed-test risk requires direct native Node --test --test-reporter=junit with explicit files.');
  }
  const executable = argv[0].includes('/') || argv[0].includes('\\')
    ? path.resolve(root, cwd, argv[0])
    : await (async () => {
      for (const directory of String(process.env.PATH ?? '').split(path.delimiter)) {
        const candidate = path.resolve(directory, process.platform === 'win32' && argv[0] === 'node' ? 'node.exe' : argv[0]);
        if (await lstat(candidate).catch(() => null)) return candidate;
      }
      return null;
    })();
  if (!executable || await realpath(executable).catch(() => null) !== await realpath(process.execPath)) {
    refuse('Failed-test risk requires this host’s authenticated native Node executable, not a wrapper.');
  }
  const fileArgs = argv.slice(argv[3] === '--' ? 4 : 3);
  if (!fileArgs.length || fileArgs.some(value => value.startsWith('-') || /[*?\[\]{}]/u.test(value))) {
    refuse('Failed-test risk does not support discovery, filters, globbing or additional runner flags.');
  }
  const files = fileArgs.map(value => {
    // Validate before joining: posix.join('.', '/outside/test.mjs') discards the leading slash
    // and could otherwise bind an external Node argument to an unrelated in-repository file.
    const relative = normalizeTestSelectionPath(value);
    if (relative !== value && value !== `./${relative}`) refuse('Native test file arguments must be canonical relative paths, optionally prefixed with ./ .');
    return normalizeTestSelectionPath(path.posix.join(cwd, relative));
  });
  if (new Set(files).size !== files.length || files.length > 256) refuse('Selected Node test files must be unique and bounded.');
  const ids = new Set(); const identities = new Set();
  for (const entry of declared) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string' || !entry.name
      || entry.name.length > 4096 || ids.has(entry.id)) refuse('Approved case IDs and names must be present and unambiguous.');
    if (normalizeTestSelectionPath(entry.path) !== entry.path) refuse('Approved test paths must be canonical repository-relative paths.');
    const identity = JSON.stringify([entry.path, entry.name]);
    if (identities.has(identity)) refuse('Approved test report identities must be unique.');
    ids.add(entry.id); identities.add(identity);
  }
  const declaredFiles = new Set(declared.map(entry => entry.path));
  if (files.some(file => !declaredFiles.has(file)) || !selected && [...declaredFiles].some(file => !files.includes(file))) {
    refuse('The direct runner files differ from the independently approved test case inventory.');
  }
  const sourceDigests = new Map();
  for (const file of files) {
    const safe = await secureRepositoryPath(root, file, { label: 'Approved Node test inventory source', mustExist: true, type: 'file' });
    const handle = await open(safe.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat(); const link = await lstat(safe.absolute);
      if (!before.isFile() || before.nlink !== 1 || link.isSymbolicLink() || before.ino !== link.ino
        || before.dev !== link.dev || before.size > 1024 * 1024) refuse('Approved test source is not an ordinary bounded file.');
      const bytes = await handle.readFile(); const after = await handle.stat();
      if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) refuse('Approved test source changed during inventory capture.');
      sourceDigests.set(file, sha(bytes));
    } finally { await handle.close(); }
  }
  const tests = declared.filter(entry => files.includes(entry.path)).map(entry => ({ ...entry,
    semanticsSha256: trpDigest({ path: entry.path, name: entry.name, sourceSha256: sourceDigests.get(entry.path) })
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (tests.length < (command.result.minimumDiscovered ?? 1)) refuse('Approved case inventory does not satisfy the command’s minimum discovery requirement.');
  return { tests, files: [...files].sort(), inventorySha256: trpDigest(declared),
    selectedSourceSha256: trpDigest([...sourceDigests].sort()) };
}

export async function matchTrpNodeReport(root, inventory, bytes) {
  const parsed = parseNativeNodeJunitReport(bytes);
  if (!inventory || parsed.cases.length !== inventory.tests.length || parsed.tests.discovered !== inventory.tests.length
    || parsed.tests.skipped !== 0 || parsed.tests.failed < 1) refuse('Failed-test risk requires every independently expected case exactly once, with no missing, extra or skipped cases.');
  const canonicalRoot = await realpath(root);
  const expectedFiles = [...new Set(inventory.tests.map(entry => entry.path))];
  const seen = new Set();
  const cases = parsed.cases.map(entry => {
    // Older native Node releases omit file attributes. A single explicit source file is still
    // unambiguous; multi-file evidence without reporter file identity cannot be qualified.
    if (entry.file != null && !path.isAbsolute(entry.file) || entry.file == null && expectedFiles.length !== 1) {
      refuse('Native Node report is missing an unambiguous test source identity.');
    }
    const relative = entry.file == null ? expectedFiles[0] : path.relative(canonicalRoot, entry.file).split(path.sep).join('/');
    const expected = inventory.tests.find(test => test.path === relative && test.name === entry.name);
    if (!expected || seen.has(expected.id) || !['passed', 'failed'].includes(entry.outcome)) refuse('Native Node report identities differ from the approved case inventory.');
    seen.add(expected.id);
    return { id: expected.id, outcome: entry.outcome, semanticsSha256: expected.semanticsSha256, causeSha256: entry.causeSha256 };
  });
  return { cases: cases.sort((left, right) => left.id.localeCompare(right.id)),
    counts: { ...parsed.tests, notRun: 0 }, reportSha256: sha(bytes) };
}

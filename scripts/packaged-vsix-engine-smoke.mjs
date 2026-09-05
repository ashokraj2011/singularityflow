#!/usr/bin/env node
/**
 * Execute the CLI engine contained in the exact VSIX produced by `vscode:package`.
 *
 * This is deliberately not a VS Code-host activation test. It closes a narrower release gap: the
 * VSIX's own `extension/cli` tree is safely extracted, then Node's loader refuses every file-module
 * resolution outside that extracted tree. A green source checkout therefore cannot hide a missing
 * or stale engine file inside the generated VSIX.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const moduleFile = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(moduleFile), '..');
const MAX_VSIX_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const CLI_PREFIX = 'extension/cli/';

function refuse(message) {
  throw new Error(`VSIX-contained engine smoke refused: ${message}`);
}

async function regularBytes(file) {
  const absolute = path.resolve(file);
  const before = await lstat(absolute).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) refuse('the VSIX is not a regular non-symlink file.');
  if (before.size < 1 || before.size > MAX_VSIX_BYTES) refuse('the VSIX exceeds its byte boundary.');
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    refuse('the VSIX could not be opened without following a symlink.');
  }
  try {
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await lstat(absolute).catch(() => null);
    if (!opened.isFile() || !after?.isFile() || after.isSymbolicLink()
        || bytes.length !== opened.size || opened.size !== before.size
        || (before.ino && opened.ino && (before.ino !== opened.ino || before.dev !== opened.dev))
        || (after.ino && opened.ino && (after.ino !== opened.ino || after.dev !== opened.dev))) {
      refuse('the VSIX changed identity while it was read.');
    }
    return { path: absolute, bytes };
  } finally {
    await handle.close();
  }
}

function endOfCentralDirectory(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  refuse('the VSIX has no ZIP central-directory terminator.');
}

function safeArchiveName(bytes) {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)
      || !value || value.startsWith('/') || value.startsWith('\\')
      || value.includes('\\') || /[\0\r\n]/u.test(value)) {
    refuse('the VSIX contains an invalid entry name.');
  }
  const parts = value.split('/');
  const content = value.endsWith('/') ? parts.slice(0, -1) : parts;
  if (!content.length || content.some((part) => !part || part === '.' || part === '..')) {
    refuse(`the VSIX contains an unsafe entry name: ${value}`);
  }
  return value;
}

function zipEntries(bytes) {
  const eocd = endOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries || entries > MAX_ENTRIES
      || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
      || centralOffset + centralSize !== eocd || eocd + 22 + commentLength !== bytes.length) {
    refuse('the VSIX uses an unsupported, malformed, multi-disk, or ZIP64 layout.');
  }
  const seen = new Set();
  const records = [];
  let offset = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) {
      refuse('the VSIX central directory is malformed.');
    }
    const madeBy = bytes.readUInt16LE(offset + 4);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc32 = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const entryCommentLength = bytes.readUInt16LE(offset + 32);
    const entryDisk = bytes.readUInt16LE(offset + 34);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (next > eocd || entryDisk !== 0
        || [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) {
      refuse('the VSIX contains an invalid or ZIP64 central-directory entry.');
    }
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = safeArchiveName(nameBytes);
    if (seen.has(name)) refuse(`the VSIX contains duplicate entry ${name}.`);
    seen.add(name);
    if (flags & 0x1) refuse(`the VSIX contains encrypted entry ${name}.`);
    if (method !== 0 && method !== 8) refuse(`the VSIX entry ${name} uses compression method ${method}.`);
    if ((madeBy >> 8) === 3) {
      const kind = (externalAttributes >>> 16) & 0o170000;
      if (kind && kind !== 0o100000 && kind !== 0o040000) {
        refuse(`the VSIX entry ${name} is not a regular file or directory.`);
      }
    }
    records.push({
      name, nameBytes, flags, method, crc32, compressedSize, uncompressedSize, localOffset,
      directory: name.endsWith('/')
    });
    offset = next;
  }
  if (offset !== eocd) refuse('the VSIX central-directory size is inconsistent.');
  return records;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function entryBytes(archive, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) {
    refuse(`the VSIX local entry for ${entry.name} is malformed.`);
  }
  const localFlags = archive.readUInt16LE(offset + 6);
  const localMethod = archive.readUInt16LE(offset + 8);
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  const start = nameStart + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (localFlags !== entry.flags || localMethod !== entry.method
      || !archive.subarray(nameStart, nameStart + nameLength).equals(entry.nameBytes)
      || end > archive.length || entry.uncompressedSize > MAX_ENTRY_BYTES) {
    refuse(`the VSIX local entry for ${entry.name} conflicts with its central-directory record.`);
  }
  let output;
  const compressed = archive.subarray(start, end);
  if (entry.method === 0) output = compressed;
  else {
    try {
      output = inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch {
      refuse(`the VSIX entry ${entry.name} could not be inflated within its byte boundary.`);
    }
  }
  if (output.length !== entry.uncompressedSize || crc32(output) !== entry.crc32) {
    refuse(`the VSIX entry ${entry.name} failed size or CRC verification.`);
  }
  return output;
}

function containedTarget(root, relative) {
  const target = path.resolve(root, ...relative.split('/'));
  const absoluteRoot = path.resolve(root);
  if (target === absoluteRoot || !target.startsWith(`${absoluteRoot}${path.sep}`)) {
    refuse(`the VSIX entry escapes the isolated engine root: ${relative}`);
  }
  return target;
}

export async function extractVsixCli(vsixFile, destination) {
  const input = await regularBytes(vsixFile);
  const records = zipEntries(input.bytes);
  const manifestRecord = records.find((entry) => entry.name === 'extension/package.json');
  const cliRecords = records.filter((entry) => entry.name.startsWith(CLI_PREFIX));
  if (!manifestRecord || manifestRecord.directory) refuse('extension/package.json is missing.');
  if (!cliRecords.some((entry) => entry.name === `${CLI_PREFIX}bin/singularity-flow.mjs`)) {
    refuse('the bundled CLI entry point is missing.');
  }
  if (!cliRecords.some((entry) => entry.name === `${CLI_PREFIX}package.json`)) {
    refuse('the bundled CLI package manifest is missing.');
  }
  const manifestBytes = entryBytes(input.bytes, manifestRecord);
  if (manifestBytes.length > 1024 * 1024) refuse('the extension manifest exceeds its byte boundary.');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { refuse('extension/package.json is not valid JSON.'); }

  const engineRoot = path.resolve(destination);
  await mkdir(engineRoot, { recursive: false, mode: 0o700 });
  let totalBytes = 0;
  const digests = [];
  for (const entry of cliRecords) {
    const relative = entry.name.slice(CLI_PREFIX.length);
    if (!relative) continue;
    const target = containedTarget(engineRoot, relative.replace(/\/$/u, ''));
    if (entry.directory) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      continue;
    }
    const output = entryBytes(input.bytes, entry);
    totalBytes += output.length;
    if (totalBytes > MAX_EXTRACTED_BYTES) refuse('the bundled CLI exceeds its total byte boundary.');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, output, { flag: 'wx', mode: 0o600 });
    const digest = createHash('sha256').update(output).digest('hex');
    digests.push([relative, digest]);
  }
  digests.sort(([left], [right]) => left.localeCompare(right));
  const treeHash = createHash('sha256');
  for (const [relative, digest] of digests) {
    treeHash.update(relative, 'utf8').update('\0').update(digest, 'ascii').update('\n');
  }
  return Object.freeze({
    vsix: input.path,
    vsixSha256: `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`,
    engineRoot,
    engineSha256: `sha256:${treeHash.digest('hex')}`,
    fileCount: digests.length,
    totalBytes,
    manifest
  });
}

function runIsolatedNode(args, { cwd, environment }) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || 'unknown failure')
      .trim().slice(-8_192);
    throw new Error(`isolated VSIX engine exited ${result.status ?? 'without status'}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout ?? '';
}

function runGit(args, { cwd, environment }) {
  const result = spawnSync('git', args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || 'unknown failure')
      .trim().slice(-8_192);
    throw new Error(`isolated VSIX Git fixture failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout ?? '';
}

function requireCondition(condition, message) {
  if (!condition) refuse(message);
}

export async function runVsixContainedEngineSmoke({ root = sourceRoot, tempRoot = os.tmpdir() } = {}) {
  const extensionManifest = JSON.parse(await readFile(
    path.join(root, 'apps', 'vscode', 'package.json'), 'utf8'
  ));
  const sourceManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const vsix = path.join(
    root, 'apps', 'vscode', `${extensionManifest.name}-${extensionManifest.version}.vsix`
  );
  const sandbox = await mkdtemp(path.join(tempRoot, 'sflow-vsix-engine-smoke-'));
  try {
    const extracted = await extractVsixCli(vsix, path.join(sandbox, 'engine'));
    if (extracted.manifest.publisher !== 'singularityflow'
        || extracted.manifest.name !== 'singularity-flow-vscode'
        || extracted.manifest.version !== extensionManifest.version) {
      refuse('the generated VSIX extension identity does not match the package request.');
    }
    const engineManifest = JSON.parse(await readFile(
      path.join(extracted.engineRoot, 'package.json'), 'utf8'
    ));
    if (engineManifest.name !== 'singularity-flow' || engineManifest.version !== sourceManifest.version) {
      refuse('the VSIX-contained engine identity does not match the release package.');
    }
    for (const relative of [
      'src/comprehension/contracts.mjs',
      'src/commands/comprehension.mjs',
      'src/wel-junit5.mjs',
      'src/wel/WelJunitCatalog.java',
      'docs/CMP-ROADMAP.md',
      'docs/WEL-PENDING-WORK.md',
      'docs/adr/0014-cmp-observe-authority-boundary.md'
    ]) {
      const info = await lstat(path.join(extracted.engineRoot, relative)).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) {
        refuse(`the VSIX-contained engine omits ${relative}.`);
      }
    }

    const loader = path.join(sandbox, 'source-boundary-loader.mjs');
    const canonicalEngineRoot = await realpath(extracted.engineRoot);
    const engineUrl = pathToFileURL(`${canonicalEngineRoot}${path.sep}`).href;
    // The loader itself is intentionally the only file module outside the extracted engine tree.
    // `import.meta.url` is canonical inside the loader, including macOS's /var -> /private/var
    // temporary-directory alias.
    await writeFile(loader, [
      `const engine = ${JSON.stringify(engineUrl)};`,
      'const loader = import.meta.url;',
      'export async function resolve(specifier, context, nextResolve) {',
      '  const result = await nextResolve(specifier, context);',
      "  if (result.url.startsWith('file:') && result.url !== loader && !result.url.startsWith(engine)) {",
      "    throw new Error(`VSIX engine attempted file-module resolution outside its extracted tree: ${result.url}`);",
      '  }',
      '  return result;',
      '}',
      ''
    ].join('\n'), { flag: 'wx', mode: 0o600 });
    const consumer = path.join(sandbox, 'consumer');
    const privateHome = path.join(sandbox, 'home');
    await Promise.all([
      mkdir(consumer, { mode: 0o700 }),
      mkdir(privateHome, { mode: 0o700 })
    ]);
    const environment = {
      ...process.env,
      HOME: privateHome,
      USERPROFILE: privateHome,
      NODE_PATH: path.join(sandbox, 'no-node-path'),
      NODE_NO_WARNINGS: '1',
      SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(privateHome, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(privateHome, 'active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(privateHome, 'leads.json')
    };
    delete environment.NODE_OPTIONS;
    delete environment.INIT_CWD;
    const cli = path.join(canonicalEngineRoot, 'bin', 'singularity-flow.mjs');
    const loaderFlags = ['--experimental-loader', loader];
    const version = runIsolatedNode([...loaderFlags, cli, '--version'], {
      cwd: consumer, environment
    }).trim();
    if (version !== sourceManifest.version) {
      refuse(`the VSIX-contained engine reported version '${version || 'missing'}'.`);
    }
    const helpText = runIsolatedNode([...loaderFlags, cli, 'help', '--json'], {
      cwd: consumer, environment
    });
    let help;
    try { help = JSON.parse(helpText); }
    catch { refuse('the VSIX-contained engine did not return its structured Help catalog.'); }
    if (help?.title !== 'Singularity Flow Help'
        || !help.topics?.some((topic) => topic.id === 'governed-mcp-tools')) {
      refuse('the VSIX-contained engine Help catalog is incomplete.');
    }

    const contractsUrl = pathToFileURL(path.join(
      canonicalEngineRoot, 'src', 'comprehension', 'contracts.mjs'
    )).href;
    const welUrl = pathToFileURL(path.join(canonicalEngineRoot, 'src', 'wel-junit5.mjs')).href;
    const moduleProbeText = runIsolatedNode([
      ...loaderFlags, '--input-type=module', '--eval', [
        `const cmp = await import(${JSON.stringify(contractsUrl)});`,
        `const wel = await import(${JSON.stringify(welUrl)});`,
        "const scope = wel.classifyJunit5SurefireCommandScope({ argv: ['mvn', 'test'] });",
        'console.log(JSON.stringify({',
        "  assurance: cmp.CMP_ASSURANCE_CLASSES.includes('unavailable'),",
        "  availability: cmp.CMP_AVAILABILITY_STATUSES.includes('degraded'),",
        "  refusal: cmp.CMP_REFUSAL_CODES.includes('CMP_STORY_CONTEXT_REQUIRED'),",
        "  diagnostic: cmp.CMP_DIAGNOSTIC_CODES.includes('CMP_BINDING_INVALID'),",
        "  wel: scope.status === 'complete' && scope.gaps.length === 0",
        '}));'
      ].join('\n')
    ], { cwd: consumer, environment });
    let moduleProbe;
    try { moduleProbe = JSON.parse(moduleProbeText); }
    catch { refuse('the VSIX-contained CMP/WEL modules did not return a structured probe.'); }
    requireCondition(Object.values(moduleProbe).every(Boolean),
      'the VSIX-contained CMP/WEL contract probe was incomplete.');

    await mkdir(path.join(consumer, 'singularity'), { recursive: true });
    runGit(['init', '-q', '-b', 'main'], { cwd: consumer, environment });
    runGit(['config', 'user.name', 'VSIX CMP Tester'], { cwd: consumer, environment });
    runGit(['config', 'user.email', 'vsix-cmp@example.invalid'], { cwd: consumer, environment });
    await writeFile(path.join(consumer, 'singularity', 'workflow.yml'), '{}\n');
    await writeFile(path.join(consumer, 'service.txt'), 'before\n');
    runGit(['add', '-A'], { cwd: consumer, environment });
    runGit(['commit', '-qm', 'baseline'], { cwd: consumer, environment });
    await writeFile(path.join(consumer, 'service.txt'), 'after\n');
    await writeFile(path.join(consumer, 'new.txt'), 'new\n');
    const before = runGit(['status', '--porcelain=v1'], { cwd: consumer, environment });
    const projectionText = runIsolatedNode([
      ...loaderFlags, cli, '--no-model', 'comprehension', 'regions', '--base', 'HEAD', '--json'
    ], { cwd: consumer, environment });
    let projection;
    try { projection = JSON.parse(projectionText); }
    catch { refuse('the VSIX-contained CMP command did not return structured output.'); }
    requireCondition(projection?.operation?.id === 'comprehension.regions'
      && projection?.data?.mode === 'observe-only'
      && projection?.data?.manifest?.structuralAssurance === 'unavailable'
      && projection?.data?.manifest?.counts?.regions === 2,
    'the VSIX-contained CMP command did not return the bounded observe-only projection.');
    requireCondition(runGit(['status', '--porcelain=v1'], {
      cwd: consumer, environment
    }) === before, 'the VSIX-contained CMP read changed the isolated repository.');
    return Object.freeze({
      extension: `${extracted.manifest.publisher}.${extracted.manifest.name}@${extracted.manifest.version}`,
      engine: `${engineManifest.name}@${engineManifest.version}`,
      vsixSha256: extracted.vsixSha256,
      engineSha256: extracted.engineSha256,
      fileCount: extracted.fileCount,
      cmpObserveOnly: true,
      welParserPackaged: true,
      hostActivation: false
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  runVsixContainedEngineSmoke().then((result) => {
    console.log([
      `VSIX-contained engine smoke passed: ${result.extension} contains ${result.engine}`,
      `(${result.fileCount} files; ${result.engineSha256}; ${result.vsixSha256}).`,
      'This is an isolated engine proof, not real VS Code host activation.'
    ].join(' '));
  }).catch((error) => {
    console.error(`VSIX-contained engine smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}

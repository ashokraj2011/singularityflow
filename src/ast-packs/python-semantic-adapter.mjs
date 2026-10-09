#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Installed, this pack's modules keep their names; replayed from retained evidence, each is written
// beside the others as <sha256>-<name>. Either way the bytes were verified against the manifest.
function sibling(name) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entries = readdirSync(here);
  const found = entries.includes(name) ? name : entries.find((entry) => entry.endsWith(`-${name}`));
  return found ? path.join(here, found) : null;
}
const { LanguageServerConnection, pyrightConfiguration, pythonEdges, PYTHON_SEMANTIC_PACK } = await import(pathToFileURL(sibling('python-core.mjs')).href);
const { joinSemanticEdges } = await import(pathToFileURL(sibling('semantic-join.mjs')).href);
const { extractPolyglotSyntax } = await import(pathToFileURL(sibling('polyglot-syntax-core.mjs')).href);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

/** Singularity Flow's own Pyright language server; never the analyzed repository's. */
function pyrightServer() {
  try {
    const manifest = createRequire(import.meta.url).resolve('pyright/package.json');
    return path.join(path.dirname(manifest), 'langserver.index.js');
  } catch {
    return null;
  }
}

let input = '';
for await (const chunk of process.stdin) input += chunk;

let server = null;
try {
  const request = JSON.parse(input);
  const entry = pyrightServer();
  if (!entry) throw new Error('pyright unavailable');
  const root = process.cwd();
  const diagnostics = [];
  const verified = [];
  const skeletons = new Map();
  const sources = new Map();
  for (const requested of request.files ?? []) {
    const bytes = await readFile(requested.path);
    if (sha256(bytes) !== requested.sha256) { diagnostics.push({ code: 'AST_ADAPTER_SOURCE_HASH_MISMATCH' }); continue; }
    verified.push(requested);
    sources.set(requested.path, bytes.toString('utf8'));
    skeletons.set(requested.path, extractPolyglotSyntax(bytes, 'python').facts);
  }
  // A callee or base class outside this request is read as it is in the checkout.
  const source = async (relative) => {
    if (!sources.has(relative)) sources.set(relative, await readFile(path.join(root, relative), 'utf8').catch(() => null));
    return sources.get(relative);
  };
  const skeletonFor = async (relative) => {
    if (!skeletons.has(relative)) {
      const text = await source(relative);
      skeletons.set(relative, text == null ? null : extractPolyglotSyntax(Buffer.from(text), 'python').facts);
    }
    return skeletons.get(relative);
  };
  let edges = [];
  if (verified.length) {
    // No PATH: Pyright then finds no Python interpreter to run, and resolves only the repository
    // and its own bundled standard-library stubs.
    const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'ELECTRON_RUN_AS_NODE']
      .filter((key) => process.env[key] != null).map((key) => [key, process.env[key]]));
    server = spawn(process.execPath, [entry, '--stdio'], { cwd: root, env: environment, stdio: ['pipe', 'pipe', 'ignore'] });
    const connection = new LanguageServerConnection(server.stdin, server.stdout, {
      respond: (method, params) => (method === 'workspace/configuration' ? pyrightConfiguration(params?.items) : null)
    });
    server.on('exit', () => connection.fail(new Error('pyright exited')));
    const projectRoot = path.resolve(root, request.project?.root ?? '.');
    const rootUri = pathToFileURL(projectRoot).href;
    await connection.request('initialize', {
      processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: path.basename(projectRoot) }],
      capabilities: { textDocument: { callHierarchy: {}, definition: { linkSupport: true } } }, initializationOptions: {}
    });
    connection.notify('initialized', {});
    const opened = new Set();
    const openFile = async (relative) => {
      const uri = pathToFileURL(path.join(root, relative)).href;
      if (!opened.has(relative)) {
        opened.add(relative);
        connection.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'python', version: 1, text: await source(relative) ?? '' } });
      }
      return uri;
    };
    edges = await pythonEdges(connection, root, verified.map((file) => file.path), {
      skeletons, skeletonFor, openFile, readLines: async (relative) => (await source(relative))?.split(/\r?\n/u) ?? null
    });
    await connection.request('shutdown', null).catch(() => null);
    connection.notify('exit', null);
  }
  const { byPath } = await joinSemanticEdges(edges, verified.map((file) => file.path), skeletonFor);
  const files = verified.map((requested) => ({ path: requested.path, sha256: requested.sha256, facts: byPath.get(requested.path) ?? [] }));
  process.stdout.write(JSON.stringify({
    protocolVersion: 2,
    adapterId: PYTHON_SEMANTIC_PACK.id,
    packVersion: PYTHON_SEMANTIC_PACK.packVersion,
    extractorVersion: PYTHON_SEMANTIC_PACK.extractorVersion,
    stage: 'semantic', assurance: 'semantic',
    derivationIdentity: request.derivationIdentity,
    artifactSha256: request.implementation.artifactSha256,
    manifestSha256: request.implementation.manifestSha256,
    files, diagnostics
  }));
} catch {
  process.exitCode = 2;
} finally {
  server?.kill();
}

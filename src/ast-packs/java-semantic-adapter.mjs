#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
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
const { conventionalJavaRoots, javaSourceRoot, joinJavaCalls, parseResolverOutput, JAVA_SEMANTIC_PACK } = await import(pathToFileURL(sibling('java-core.mjs')).href);
const { extractPolyglotSyntax } = await import(pathToFileURL(sibling('polyglot-syntax-core.mjs')).href);

const MAX_RESOLVER_OUTPUT = 64 * 1024 * 1024;

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

/** The `java` launcher on PATH: the same lookup `wm ast warm` bound the project to. */
async function javaLauncher() {
  const names = process.platform === 'win32' ? ['java.exe'] : ['java'];
  for (const directory of String(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try { await access(candidate); return candidate; } catch { /* continue */ }
    }
  }
  return null;
}

function runResolver(java, resolver, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(java, ['-Xss8m', resolver], { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let bytes = 0;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_RESOLVER_OUTPUT) child.kill();
      else chunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status !== 0 || bytes > MAX_RESOLVER_OUTPUT) reject(new Error(`java call resolver exited with ${status}`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
}

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const request = JSON.parse(input);
  const java = await javaLauncher();
  if (!java) throw new Error('java unavailable');
  const diagnostics = [];
  const verified = [];
  const skeletons = new Map();
  for (const requested of request.files ?? []) {
    const bytes = await readFile(requested.path);
    if (sha256(bytes) !== requested.sha256) { diagnostics.push({ code: 'AST_ADAPTER_SOURCE_HASH_MISMATCH' }); continue; }
    verified.push(requested);
    skeletons.set(requested.path, extractPolyglotSyntax(bytes, 'java').facts);
  }
  // Each file's own source root first (from its package), then the project's conventional roots,
  // so calls into classes outside this request resolve against their source.
  const roots = new Set();
  for (const file of verified) {
    const packageName = skeletons.get(file.path).find((fact) => fact.kind === 'module')?.name ?? '';
    const root = javaSourceRoot(file.path, packageName);
    if (root) roots.add(root);
  }
  for (const root of await conventionalJavaRoots(readdir, request.project?.root ?? '.')) roots.add(root);
  const edges = verified.length
    ? parseResolverOutput(await runResolver(java, sibling('JavaCallResolver.java'), [
      ...verified.map((file) => `source\t${file.path}`), ...[...roots].map((root) => `root\t${root}`)
    ].join('\n') + '\n'))
    : [];
  // A callee outside this request joins the skeleton of its file as it is in the checkout.
  const { byPath } = await joinJavaCalls(edges, verified.map((file) => file.path), async (relative) => {
    if (skeletons.has(relative)) return skeletons.get(relative);
    const bytes = await readFile(relative).catch(() => null);
    const facts = bytes ? extractPolyglotSyntax(bytes, 'java').facts : null;
    skeletons.set(relative, facts);
    return facts;
  });
  const files = verified.map((requested) => ({ path: requested.path, sha256: requested.sha256, facts: byPath.get(requested.path) ?? [] }));
  process.stdout.write(JSON.stringify({
    protocolVersion: 2,
    adapterId: JAVA_SEMANTIC_PACK.id,
    packVersion: JAVA_SEMANTIC_PACK.packVersion,
    extractorVersion: JAVA_SEMANTIC_PACK.extractorVersion,
    stage: 'semantic', assurance: 'semantic',
    derivationIdentity: request.derivationIdentity,
    artifactSha256: request.implementation.artifactSha256,
    manifestSha256: request.implementation.manifestSha256,
    files, diagnostics
  }));
} catch {
  process.exitCode = 2;
}

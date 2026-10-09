#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
const { resolveTypeScript, semanticCalls, TYPESCRIPT_SEMANTIC_PACK } = await import(pathToFileURL(sibling('typescript-core.mjs')).href);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const request = JSON.parse(input);
  const typescript = resolveTypeScript(sibling('typescript.js'));
  if (!typescript) throw new Error('typescript unavailable');
  const diagnostics = [];
  const verified = [];
  for (const requested of request.files ?? []) {
    const bytes = await readFile(requested.path);
    if (sha256(bytes) !== requested.sha256) diagnostics.push({ code: 'AST_ADAPTER_SOURCE_HASH_MISMATCH' });
    else verified.push(requested);
  }
  // One compiler Program for the project's requested files; the checker resolves every call.
  const results = verified.length
    ? semanticCalls(typescript.module, process.cwd(), verified.map((file) => file.path), { projectRoot: request.project?.root ?? '.' })
    : [];
  const byPath = new Map(results.map((entry) => [entry.path, entry]));
  const files = verified.map((requested) => ({ path: requested.path, sha256: requested.sha256, facts: byPath.get(requested.path)?.facts ?? [] }));
  process.stdout.write(JSON.stringify({
    protocolVersion: 2,
    adapterId: TYPESCRIPT_SEMANTIC_PACK.id,
    packVersion: TYPESCRIPT_SEMANTIC_PACK.packVersion,
    extractorVersion: TYPESCRIPT_SEMANTIC_PACK.extractorVersion,
    stage: 'semantic', assurance: 'semantic',
    derivationIdentity: request.derivationIdentity,
    artifactSha256: request.implementation.artifactSha256,
    manifestSha256: request.implementation.manifestSha256,
    files, diagnostics
  }));
} catch {
  process.exitCode = 2;
}

#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { extractPolyglotSyntax, POLYGLOT_SYNTAX_PACK } from './polyglot-syntax-core.mjs';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const request = JSON.parse(input);
  const files = []; const diagnostics = [];
  for (const requested of request.files ?? []) {
    const bytes = await readFile(requested.path);
    if (sha256(bytes) !== requested.sha256) {
      diagnostics.push({ code: 'AST_ADAPTER_SOURCE_HASH_MISMATCH' });
      continue;
    }
    const parsed = extractPolyglotSyntax(bytes, requested.language);
    files.push({ path: requested.path, sha256: requested.sha256, facts: parsed.facts });
    diagnostics.push(...parsed.diagnostics);
  }
  process.stdout.write(JSON.stringify({
    protocolVersion: 2,
    adapterId: POLYGLOT_SYNTAX_PACK.id,
    packVersion: POLYGLOT_SYNTAX_PACK.packVersion,
    extractorVersion: POLYGLOT_SYNTAX_PACK.extractorVersion,
    // This extractor recognizes structural declarations without compiling or parsing the file.
    // It participates in the syntax pipeline only as a text-assured preview and cannot satisfy a
    // syntax lifecycle gate.
    stage: 'syntax', assurance: 'text',
    derivationIdentity: request.derivationIdentity,
    artifactSha256: request.implementation.artifactSha256,
    manifestSha256: request.implementation.manifestSha256,
    files, diagnostics
  }));
} catch {
  process.exitCode = 2;
}

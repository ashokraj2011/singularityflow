#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { resolveTypeScript, syntaxFacts, TYPESCRIPT_SYNTAX_PACK } from './typescript-core.mjs';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const request = JSON.parse(input);
  const typescript = resolveTypeScript();
  if (!typescript) throw new Error('typescript unavailable');
  const files = []; const diagnostics = [];
  for (const requested of request.files ?? []) {
    const bytes = await readFile(requested.path);
    if (sha256(bytes) !== requested.sha256) {
      diagnostics.push({ code: 'AST_ADAPTER_SOURCE_HASH_MISMATCH' });
      continue;
    }
    files.push({ path: requested.path, sha256: requested.sha256, facts: syntaxFacts(typescript.module, requested.path, bytes.toString('utf8')) });
  }
  process.stdout.write(JSON.stringify({
    protocolVersion: 2,
    adapterId: TYPESCRIPT_SYNTAX_PACK.id,
    packVersion: TYPESCRIPT_SYNTAX_PACK.packVersion,
    extractorVersion: TYPESCRIPT_SYNTAX_PACK.extractorVersion,
    // The compiler's own parser: declarations and imports at syntax assurance, no type information.
    stage: 'syntax', assurance: 'syntax',
    derivationIdentity: request.derivationIdentity,
    artifactSha256: request.implementation.artifactSha256,
    manifestSha256: request.implementation.manifestSha256,
    files, diagnostics
  }));
} catch {
  process.exitCode = 2;
}

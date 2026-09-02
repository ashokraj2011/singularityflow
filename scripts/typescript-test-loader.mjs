/**
 * Node 20-compatible ESM loader for tests that import the extension's TypeScript sources.
 *
 * Production extension code is still type-checked and bundled normally. This loader exists only so
 * the supported Node 20 release cell executes the same source-level behavior tests as Node 22.6+
 * instead of silently dropping those files.
 */
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  const result = ts.transpileModule(source, {
    fileName: new URL(url).pathname,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      verbatimModuleSyntax: true
    }
  });
  const errors = (result.diagnostics ?? []).filter((entry) => entry.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    throw new Error(`Could not transpile TypeScript test dependency ${url}: ${errors.map((entry) => (
      ts.flattenDiagnosticMessageText(entry.messageText, '\n')
    )).join('; ')}`);
  }
  return { format: 'module', shortCircuit: true, source: result.outputText };
}

import path from 'node:path';

import { extractImports } from '../../../repository-facts.mjs';
import {
  JAVASCRIPT_LIKE, SOURCE_LIKE, adapterFiles, evidenceDescriptor, exactText, factDraft,
  implementationSha256, languageForPath, result, unavailableDraft
} from './common.mjs';
import {
  POLYGLOT_STRUCTURAL_LANGUAGES, extractPolyglotImports, resolvePolyglotLocal
} from './polyglot-lexical.mjs';

export const IMPORT_DEPENDENCY_ID = 'import-dependency';
export const IMPORT_DEPENDENCY_VERSION = '1.2.0';
export const IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256 = implementationSha256(
  IMPORT_DEPENDENCY_ID,
  IMPORT_DEPENDENCY_VERSION,
  'reviewed-js-and-polyglot-code-aware-imports-with-bounded-local-resolution-body-free-v3'
);

function resolveLocal(from, target, known) {
  if (!target.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
  if (base === '..' || base.startsWith('../') || base.startsWith('/')) return null;
  const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].flatMap((extension) => [
    `${base}${extension}`, path.posix.join(base, `index${extension}`)
  ])];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

export function extractImportDependencies(context) {
  const files = adapterFiles(context);
  const known = new Set(files.map((file) => file.path));
  const observations = [];
  const facts = [];
  for (const file of files.filter((entry) => SOURCE_LIKE.has(path.posix.extname(entry.path).toLowerCase()))) {
    const extension = path.posix.extname(file.path).toLowerCase();
    const language = languageForPath(file.path);
    if (!JAVASCRIPT_LIKE.has(extension) && !POLYGLOT_STRUCTURAL_LANGUAGES.includes(language)) {
      facts.push(unavailableDraft({
        factType: 'dependency-analysis',
        subject: { kind: 'file', id: file.path },
        attemptedProducer: IMPORT_DEPENDENCY_ID,
        code: 'UNSUPPORTED_LANGUAGE',
        detail: `The registered import-dependency extractor does not support '${extension || 'extensionless'}' source.`
      }));
      continue;
    }
    let source;
    try {
      source = exactText(context, file);
    } catch (error) {
      if (error?.code !== 'WMB_EXTRACTION_UNAVAILABLE') throw error;
      facts.push(unavailableDraft({
        factType: 'dependency-analysis',
        subject: { kind: 'file', id: file.path },
        attemptedProducer: IMPORT_DEPENDENCY_ID,
        code: 'INVALID_UTF8',
        detail: `The pinned source ${file.path} is not valid UTF-8.`
      }));
      continue;
    }
    let imports;
    try {
      imports = JAVASCRIPT_LIKE.has(extension)
        ? extractImports(source).sort().map((target) => ({ target, line: null }))
        : extractPolyglotImports(source, language);
    } catch (error) {
      facts.push(unavailableDraft({
        factType: 'dependency-analysis',
        subject: { kind: 'file', id: file.path },
        attemptedProducer: IMPORT_DEPENDENCY_ID,
        code: 'PARSE_FAILURE',
        detail: `The registered import extractor could not scan ${file.path}: ${error.message}`
      }));
      continue;
    }
    for (const declaration of imports) {
      const { target } = declaration;
      const resolvedPath = JAVASCRIPT_LIKE.has(extension)
        ? resolveLocal(file.path, target, known)
        : resolvePolyglotLocal(file.path, target, language, known);
      const subject = { kind: 'dependency-edge', id: `${file.path}->${resolvedPath ?? target}` };
      const locator = {
        target: resolvedPath ?? target,
        ...(declaration.line ? { range: { startLine: declaration.line, endLine: declaration.line } } : {})
      };
      const evidence = evidenceDescriptor(file, { kind: resolvedPath ? 'dependency-edge' : 'import', locator, subject });
      observations.push(evidence);
      facts.push(factDraft({
        factType: resolvedPath ? 'dependency-edge' : 'import-dependency',
        subject,
        claim: resolvedPath
          ? `${file.path} imports the in-scope module ${resolvedPath}.`
          : `${file.path} declares import target ${target}.`,
        assurance: 'structurally-derived',
        evidence: [evidence]
      }));
    }
  }
  return result(IMPORT_DEPENDENCY_ID, observations, facts);
}

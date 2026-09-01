import { extractSymbols } from '../../../repository-facts.mjs';
import { compareText } from '../../canonicalize.mjs';

import {
  JAVASCRIPT_LIKE, SOURCE_LIKE, adapterFiles, evidenceDescriptor, exactText, factDraft,
  implementationSha256, languageForPath, result, unavailableDraft
} from './common.mjs';
import {
  POLYGLOT_STRUCTURAL_LANGUAGES, extractPolyglotSymbols
} from './polyglot-lexical.mjs';
import path from 'node:path';

export const SYMBOL_SKELETON_ID = 'symbol-skeleton';
export const SYMBOL_SKELETON_VERSION = '1.2.0';
export const SYMBOL_SKELETON_IMPLEMENTATION_SHA256 = implementationSha256(
  SYMBOL_SKELETON_ID,
  SYMBOL_SKELETON_VERSION,
  'reviewed-js-and-polyglot-code-only-declaration-skeleton-body-free-v3'
);

export function extractSymbolSkeleton(context) {
  const observations = [];
  const facts = [];
  for (const file of adapterFiles(context).filter((entry) => SOURCE_LIKE.has(path.posix.extname(entry.path).toLowerCase()))) {
    const extension = path.posix.extname(file.path).toLowerCase();
    const language = languageForPath(file.path);
    if (!JAVASCRIPT_LIKE.has(extension) && !POLYGLOT_STRUCTURAL_LANGUAGES.includes(language)) {
      facts.push(unavailableDraft({
        factType: 'symbol-index',
        subject: { kind: 'file', id: file.path },
        attemptedProducer: SYMBOL_SKELETON_ID,
        code: 'UNSUPPORTED_LANGUAGE',
        detail: `The registered symbol-skeleton extractor does not support '${extension || 'extensionless'}' source.`
      }));
      continue;
    }
    let source;
    try {
      source = exactText(context, file);
    } catch (error) {
      if (error?.code !== 'WMB_EXTRACTION_UNAVAILABLE') throw error;
      facts.push(unavailableDraft({
        factType: 'symbol-index',
        subject: { kind: 'file', id: file.path },
        attemptedProducer: SYMBOL_SKELETON_ID,
        code: 'INVALID_UTF8',
        detail: `The pinned source ${file.path} is not valid UTF-8.`
      }));
      continue;
    }
    let symbols;
    try {
      symbols = JAVASCRIPT_LIKE.has(extension)
        ? extractSymbols(source, file.path).map((symbol) => ({
          ...symbol, line: Number(symbol.at.slice(symbol.at.lastIndexOf(':') + 1)), exported: true
        }))
        : extractPolyglotSymbols(source, language);
    } catch (error) {
      facts.push(unavailableDraft({
        factType: 'symbol-index',
        subject: { kind: 'file', id: file.path },
        attemptedProducer: SYMBOL_SKELETON_ID,
        code: 'PARSE_FAILURE',
        detail: `The registered lexical symbol extractor could not scan ${file.path}: ${error.message}`
      }));
      continue;
    }
    for (const symbol of symbols.sort((left, right) => left.line - right.line || compareText(left.name, right.name))) {
      const startLine = symbol.line;
      const subject = { kind: 'symbol', id: `${file.path}#${symbol.name}` };
      const evidence = evidenceDescriptor(file, {
        kind: 'symbol',
        locator: { symbol: symbol.name, range: { startLine, endLine: startLine } },
        subject
      });
      observations.push(evidence);
      facts.push(factDraft({
        factType: 'symbol-exists',
        subject,
        claim: `${symbol.kind} ${symbol.name} is ${symbol.exported ? 'exported' : 'declared'} in ${file.path} at line ${startLine}.`,
        assurance: 'structurally-derived',
        evidence: [evidence]
      }));
    }
  }
  return result(SYMBOL_SKELETON_ID, observations, facts);
}

import { extractSymbols } from '../../../repository-facts.mjs';
import { compareText } from '../../canonicalize.mjs';

import {
  JAVASCRIPT_LIKE, SOURCE_LIKE, adapterFiles, evidenceDescriptor, exactText, factDraft,
  implementationSha256, result, unavailableDraft
} from './common.mjs';
import path from 'node:path';

export const SYMBOL_SKELETON_ID = 'symbol-skeleton';
export const SYMBOL_SKELETON_VERSION = '1.1.0';
export const SYMBOL_SKELETON_IMPLEMENTATION_SHA256 = implementationSha256(
  SYMBOL_SKELETON_ID,
  SYMBOL_SKELETON_VERSION,
  'repository-facts.extractSymbols-code-only-exported-top-level-declarations-body-free-v2'
);

export function extractSymbolSkeleton(context) {
  const observations = [];
  const facts = [];
  for (const file of adapterFiles(context).filter((entry) => SOURCE_LIKE.has(path.posix.extname(entry.path).toLowerCase()))) {
    const extension = path.posix.extname(file.path).toLowerCase();
    if (!JAVASCRIPT_LIKE.has(extension)) {
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
      symbols = extractSymbols(source, file.path);
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
    for (const symbol of symbols.sort((left, right) => compareText(left.at, right.at) || compareText(left.name, right.name))) {
      const startLine = Number(symbol.at.slice(symbol.at.lastIndexOf(':') + 1));
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
        claim: `${symbol.kind} ${symbol.name} is exported from ${file.path} at line ${startLine}.`,
        assurance: 'structurally-derived',
        evidence: [evidence]
      }));
    }
  }
  return result(SYMBOL_SKELETON_ID, observations, facts);
}

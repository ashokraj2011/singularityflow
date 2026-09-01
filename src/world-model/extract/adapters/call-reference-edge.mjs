import path from 'node:path';

import { extractSymbols } from '../../../repository-facts.mjs';
import { compareText } from '../../canonicalize.mjs';
import {
  SOURCE_LIKE, adapterFiles, evidenceDescriptor, exactText, factDraft, implementationSha256,
  languageForPath, result, unavailableDraft
} from './common.mjs';
import { scanSignaturesAndExports } from './closed-structure.mjs';
import { extractPolyglotSymbols, maskPolyglotNonCode } from './polyglot-lexical.mjs';

export const CALL_REFERENCE_EDGE_ID = 'call-reference-edge';
export const CALL_REFERENCE_EDGE_VERSION = '1.0.0';
export const CALL_REFERENCE_EDGE_IMPLEMENTATION_SHA256 = implementationSha256(
  CALL_REFERENCE_EDGE_ID,
  CALL_REFERENCE_EDGE_VERSION,
  'single-pass-bounded-same-file-declaration-call-and-reference-candidates-v2'
);

const MAXIMUM_SOURCE_BYTES = 512 * 1024;
const MAXIMUM_EDGES_PER_FILE = 256;
const MAXIMUM_DECLARATIONS_PER_FILE = 2048;

function declarationSkeletons(source, relative, language) {
  if (language === 'javascript' || language === 'typescript') {
    const exported = extractSymbols(source, relative).map((item) => ({
      name: item.name,
      line: Number(String(item.at).slice(String(item.at).lastIndexOf(':') + 1))
    }));
    const structural = scanSignaturesAndExports(source, language).map((item) => ({
      name: item.name, line: item.line
    }));
    return [...exported, ...structural];
  }
  return extractPolyglotSymbols(source, language).map((item) => ({
    name: item.name, line: item.line
  }));
}

/**
 * Find bounded, same-file lexical edges to an exact registered declaration name.
 *
 * Name resolution and dynamic dispatch are deliberately not claimed: every emitted edge is
 * `partial` and names itself a lexical candidate. Comments and string bodies are masked before
 * matching, and declaration lines cannot become self-edges.
 */
export function scanLocalCallAndReferenceEdges(source, relative, language) {
  const declarations = declarationSkeletons(source, relative, language)
    .filter((item) => Number.isInteger(item.line) && item.line > 0)
    .filter((item, index, values) => values.findIndex((candidate) => (
      candidate.name === item.name && candidate.line === item.line
    )) === index)
    .sort((left, right) => left.line - right.line || compareText(left.name, right.name));
  if (!declarations.length) {
    return { edges: [], truncated: false, truncationReason: null };
  }
  const nameCounts = new Map();
  for (const declaration of declarations) {
    nameCounts.set(declaration.name, (nameCounts.get(declaration.name) ?? 0) + 1);
  }
  const declarationLimitReached = declarations.length > MAXIMUM_DECLARATIONS_PER_FILE;
  const declarationsByName = new Map(
    declarations.slice(0, MAXIMUM_DECLARATIONS_PER_FILE)
      // Multiple same-name declarations require semantic overload/scope resolution. Refuse to
      // guess which declaration a lexical use targets.
      .filter((declaration) => nameCounts.get(declaration.name) === 1)
      .map((declaration) => [declaration.name, declaration])
  );
  const maskLanguage = language === 'javascript' || language === 'typescript' ? 'csharp' : language;
  const lines = maskPolyglotNonCode(source, maskLanguage).split(/\r?\n/);
  const edges = [];
  const seen = new Set();
  // One token pass keeps the work proportional to bounded source bytes rather than multiplying
  // every declaration by every source line.
  const identifier = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  for (let index = 0; index < lines.length; index += 1) {
    identifier.lastIndex = 0;
    for (let match = identifier.exec(lines[index]); match; match = identifier.exec(lines[index])) {
      const declaration = declarationsByName.get(match[0]);
      if (!declaration || index + 1 === declaration.line) continue;
      const preceding = lines[index].slice(0, match.index);
      const following = lines[index].slice(match.index + match[0].length);
      const bareReference = /(?:=|\breturn|=>|[(:,\[])\s*$/.test(preceding);
      const call = /^\s*\(/.test(following) && !/[.:]$/.test(preceding.trimEnd());
      if (!call && !bareReference) continue;
      const edgeKind = call ? 'call-edge' : 'reference-edge';
      const key = `${edgeKind}:${declaration.name}:${index + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        edgeKind,
        name: declaration.name,
        declarationLine: declaration.line,
        referenceLine: index + 1
      });
      if (edges.length >= MAXIMUM_EDGES_PER_FILE) {
        return { edges, truncated: true, truncationReason: 'edge-limit' };
      }
    }
  }
  return {
    edges,
    truncated: declarationLimitReached,
    truncationReason: declarationLimitReached ? 'declaration-limit' : null
  };
}

export function extractCallReferenceEdges(context) {
  const observations = [];
  const facts = [];
  if (!context.scopeManifest.allowedSubjects.includes('dependency-edge')) {
    return result(CALL_REFERENCE_EDGE_ID, observations, facts);
  }
  for (const file of adapterFiles(context).filter((entry) => (
    SOURCE_LIKE.has(path.posix.extname(entry.path).toLowerCase())
  ))) {
    const language = languageForPath(file.path);
    const fileSubject = { kind: 'dependency-edge', id: `${file.path}#call-reference-analysis` };
    if (!language) continue;
    if (file.bytes > MAXIMUM_SOURCE_BYTES) {
      facts.push(unavailableDraft({
        factType: 'dependency-analysis',
        subject: fileSubject,
        attemptedProducer: CALL_REFERENCE_EDGE_ID,
        code: 'PARSE_FAILURE',
        detail: `Pinned source ${file.path} exceeds the registered ${MAXIMUM_SOURCE_BYTES}-byte lexical edge bound.`
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
        subject: fileSubject,
        attemptedProducer: CALL_REFERENCE_EDGE_ID,
        code: 'INVALID_UTF8',
        detail: `The pinned source ${file.path} is not valid UTF-8.`
      }));
      continue;
    }
    const scanned = scanLocalCallAndReferenceEdges(source, file.path, language);
    for (const edge of scanned.edges) {
      const subject = {
        kind: 'dependency-edge',
        id: `${file.path}:${edge.referenceLine}->${file.path}#${edge.name}`
      };
      const evidence = evidenceDescriptor(file, {
        kind: edge.edgeKind,
        locator: {
          symbol: edge.name,
          target: `${file.path}#${edge.name}:${edge.declarationLine}`,
          range: { startLine: edge.referenceLine, endLine: edge.referenceLine }
        },
        subject
      });
      observations.push(evidence);
      facts.push(factDraft({
        factType: 'dependency-edge',
        subject,
        claim: `${file.path} line ${edge.referenceLine} contains a lexical ${edge.edgeKind === 'call-edge' ? 'call' : 'reference'} candidate to same-file declaration ${edge.name} at line ${edge.declarationLine}; semantic resolution is unavailable.`,
        status: 'partial',
        assurance: 'structurally-derived',
        evidence: [evidence]
      }));
    }
    if (scanned.truncated) {
      const evidence = evidenceDescriptor(file, { kind: 'file', subject: fileSubject });
      observations.push(evidence);
      facts.push(factDraft({
        factType: 'dependency-analysis',
        subject: fileSubject,
        claim: scanned.truncationReason === 'declaration-limit'
          ? `${file.path} reached the registered ${MAXIMUM_DECLARATIONS_PER_FILE}-declaration lexical analysis limit; retained edges are partial and declarations beyond the bound were not analyzed.`
          : `${file.path} reached the registered ${MAXIMUM_EDGES_PER_FILE}-edge lexical analysis limit; retained edges are partial and further edges were not registered.`,
        status: 'partial',
        assurance: 'deterministically-derived',
        evidence: [evidence]
      }));
    }
  }
  return result(CALL_REFERENCE_EDGE_ID, observations, facts);
}

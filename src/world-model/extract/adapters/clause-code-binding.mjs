import path from 'node:path';

import {
  SOURCE_LIKE, adapterFiles, evidenceDescriptor, exactText, factDraft, implementationSha256,
  result, unavailableDraft
} from './common.mjs';
import { scanClauseBindings } from './closed-structure.mjs';

export const CLAUSE_CODE_BINDING_ID = 'clause-code-binding';
export const CLAUSE_CODE_BINDING_VERSION = '1.0.0';
export const CLAUSE_CODE_BINDING_IMPLEMENTATION_SHA256 = implementationSha256(
  CLAUSE_CODE_BINDING_ID,
  CLAUSE_CODE_BINDING_VERSION,
  'explicit-source-comment-clause-tags-only-v1'
);

export function extractClauseCodeBindings(context) {
  const observations = [];
  const facts = [];
  for (const file of adapterFiles(context).filter((entry) => (
    SOURCE_LIKE.has(path.posix.extname(entry.path).toLowerCase())
  ))) {
    let source;
    try {
      source = exactText(context, file);
    } catch (error) {
      if (error?.code !== 'WMB_EXTRACTION_UNAVAILABLE') throw error;
      facts.push(unavailableDraft({
        factType: 'clause-binding',
        subject: { kind: 'file', id: file.path },
        attemptedProducer: CLAUSE_CODE_BINDING_ID,
        code: 'INVALID_UTF8',
        detail: `The pinned source ${file.path} is not valid UTF-8.`
      }));
      continue;
    }
    for (const item of scanClauseBindings(source)) {
      const subject = {
        kind: 'contract', id: `${item.clause}@${file.path}:${item.line}`
      };
      const evidence = evidenceDescriptor(file, {
        kind: 'clause-binding',
        locator: {
          target: item.clause,
          range: { startLine: item.line, endLine: item.line }
        },
        subject
      });
      observations.push(evidence);
      facts.push(factDraft({
        factType: 'clause-binding',
        subject,
        claim: `${item.clause} is explicitly bound to ${file.path} at line ${item.line}.`,
        assurance: 'source-exact',
        evidence: [evidence]
      }));
    }
  }
  return result(CLAUSE_CODE_BINDING_ID, observations, facts);
}

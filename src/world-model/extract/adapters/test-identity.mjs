import path from 'node:path';

import {
  SOURCE_LIKE, adapterFiles, evidenceDescriptor, exactText, factDraft, implementationSha256,
  languageForPath, result, unavailableDraft
} from './common.mjs';
import {
  TEST_IDENTITY_LANGUAGES, isTestSourcePath, scanTestIdentities
} from './closed-structure.mjs';

export const TEST_IDENTITY_ID = 'test-identity';
export const TEST_IDENTITY_VERSION = '1.0.0';
export const TEST_IDENTITY_IMPLEMENTATION_SHA256 = implementationSha256(
  TEST_IDENTITY_ID,
  TEST_IDENTITY_VERSION,
  'closed-framework-declared-test-identities-from-test-source-v1'
);

export function extractTestIdentities(context) {
  const observations = [];
  const facts = [];
  const files = adapterFiles(context).filter((entry) => (
    SOURCE_LIKE.has(path.posix.extname(entry.path).toLowerCase()) && isTestSourcePath(entry.path)
  ));
  for (const file of files) {
    let source;
    try {
      source = exactText(context, file);
    } catch (error) {
      if (error?.code !== 'WMB_EXTRACTION_UNAVAILABLE') throw error;
      facts.push(unavailableDraft({
        factType: 'test-identity',
        subject: { kind: 'file', id: file.path },
        attemptedProducer: TEST_IDENTITY_ID,
        code: 'INVALID_UTF8',
        detail: `The pinned test source ${file.path} is not valid UTF-8.`
      }));
      continue;
    }
    const language = languageForPath(file.path);
    if (!TEST_IDENTITY_LANGUAGES.includes(language)) {
      facts.push(unavailableDraft({
        factType: 'test-identity',
        subject: { kind: 'file', id: file.path },
        attemptedProducer: TEST_IDENTITY_ID,
        code: 'UNSUPPORTED_LANGUAGE',
        detail: `The registered test-identity extractor does not support '${language ?? 'unknown'}' test source.`
      }));
      continue;
    }
    for (const item of scanTestIdentities(source, language)) {
      const subject = { kind: 'test', id: `${file.path}#${item.name}` };
      const evidence = evidenceDescriptor(file, {
        kind: 'test-identity',
        locator: {
          symbol: item.name,
          range: { startLine: item.line, endLine: item.line }
        },
        subject
      });
      observations.push(evidence);
      facts.push(factDraft({
        factType: 'test-identity',
        subject,
        claim: `${item.framework} test '${item.name}' is declared in ${file.path} at line ${item.line}.`,
        assurance: 'structurally-derived',
        evidence: [evidence]
      }));
    }
  }
  return result(TEST_IDENTITY_ID, observations, facts);
}

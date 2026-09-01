import path from 'node:path';

import {
  adapterFiles, evidenceDescriptor, exactText, factDraft, implementationSha256, result,
  unavailableDraft
} from './common.mjs';

export const OWNERSHIP_MAINTAINER_RECORD_ID = 'ownership-maintainer-record';
export const OWNERSHIP_MAINTAINER_RECORD_VERSION = '1.0.0';
export const OWNERSHIP_MAINTAINER_RECORD_IMPLEMENTATION_SHA256 = implementationSha256(
  OWNERSHIP_MAINTAINER_RECORD_ID,
  OWNERSHIP_MAINTAINER_RECORD_VERSION,
  'exact-simple-codeowners-mappings-and-owner-frequency-v1'
);

const OWNER = /^(?:@[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?|[^@\s]+@[^@\s]+\.[^@\s]+)$/;

export function isCodeownersPath(relative) {
  const normalized = String(relative).replaceAll('\\', '/');
  return path.posix.basename(normalized) === 'CODEOWNERS'
    && ['', '.github', 'docs'].includes(path.posix.dirname(normalized) === '.' ? '' : path.posix.dirname(normalized));
}

/** Parse the unambiguous CODEOWNERS subset. Unsupported escaped whitespace is visible as a gap. */
export function scanCodeowners(source) {
  const records = [];
  const malformed = [];
  for (const [index, raw] of String(source).split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const pattern = parts.shift();
    if (!pattern || pattern.length > 300 || pattern.includes('\\') || pattern.startsWith('!')
        || !/^[A-Za-z0-9_./*@?\[\]-]+$/.test(pattern)
        || !parts.length || parts.some((owner) => !OWNER.test(owner))) {
      malformed.push({ line: index + 1 });
      continue;
    }
    for (const owner of [...new Set(parts)].sort()) records.push({ pattern, owner, line: index + 1 });
  }
  return { malformed, records };
}

export function extractOwnershipMaintainerRecords(context) {
  const observations = [];
  const facts = [];
  for (const file of adapterFiles(context).filter((entry) => isCodeownersPath(entry.path))) {
    let source;
    try {
      source = exactText(context, file);
    } catch (error) {
      if (error?.code !== 'WMB_EXTRACTION_UNAVAILABLE') throw error;
      facts.push(unavailableDraft({
        factType: 'maintainer-record',
        subject: { kind: 'file', id: file.path },
        attemptedProducer: OWNERSHIP_MAINTAINER_RECORD_ID,
        code: 'INVALID_UTF8',
        detail: `The pinned CODEOWNERS source ${file.path} is not valid UTF-8.`
      }));
      continue;
    }
    const parsed = scanCodeowners(source);
    for (const item of parsed.malformed) {
      const subject = { kind: 'human-record', id: `${file.path}#unparsed-line-${item.line}` };
      const evidence = evidenceDescriptor(file, {
        kind: 'configuration-object',
        locator: { range: { startLine: item.line, endLine: item.line } },
        subject
      });
      observations.push(evidence);
      facts.push(unavailableDraft({
        factType: 'maintainer-record', subject,
        attemptedProducer: OWNERSHIP_MAINTAINER_RECORD_ID,
        code: 'PARSE_FAILURE',
        detail: `CODEOWNERS line ${item.line} is outside the registered unambiguous syntax.`,
        evidence: [evidence]
      }));
    }
    for (const item of parsed.records) {
      const subject = {
        kind: 'human-record', id: `${file.path}#${item.pattern}->${item.owner}`
      };
      const evidence = evidenceDescriptor(file, {
        kind: 'configuration-object',
        locator: {
          target: item.pattern,
          range: { startLine: item.line, endLine: item.line }
        },
        subject
      });
      observations.push(evidence);
      facts.push(factDraft({
        factType: 'maintainer-record',
        subject,
        claim: `${item.owner} is explicitly assigned CODEOWNERS pattern ${item.pattern} in ${file.path}.`,
        assurance: 'source-exact',
        evidence: [evidence]
      }));
    }
    const patterns = new Set(parsed.records.map((item) => item.pattern));
    const owners = [...new Set(parsed.records.map((item) => item.owner))].sort();
    for (const owner of owners) {
      const records = parsed.records.filter((item) => item.owner === owner);
      const subject = { kind: 'analysis', id: `${file.path}#ownership:${owner}` };
      const evidence = records.map((item) => evidenceDescriptor(file, {
        kind: 'configuration-object',
        locator: {
          target: item.pattern,
          range: { startLine: item.line, endLine: item.line }
        },
        subject
      }));
      observations.push(...evidence);
      facts.push(factDraft({
        factType: 'ownership-concentration',
        subject,
        claim: `${owner} is assigned ${new Set(records.map((item) => item.pattern)).size} of ${patterns.size} parsed CODEOWNERS pattern(s) in ${file.path}.`,
        assurance: 'deterministically-derived',
        evidence
      }));
    }
  }
  return result(OWNERSHIP_MAINTAINER_RECORD_ID, observations, facts);
}

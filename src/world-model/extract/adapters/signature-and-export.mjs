import path from 'node:path';

import {
  SOURCE_LIKE, adapterFiles, evidenceDescriptor, exactText, factDraft, implementationSha256,
  languageForPath, observeAdapterPathOutcome, result, unavailableDraft
} from './common.mjs';
import { scanSignaturesAndExportsWithLimitations } from './closed-structure.mjs';

export const SIGNATURE_AND_EXPORT_ID = 'signature-and-export';
export const SIGNATURE_AND_EXPORT_VERSION = '1.0.0';
export const SIGNATURE_AND_EXPORT_IMPLEMENTATION_SHA256 = implementationSha256(
  SIGNATURE_AND_EXPORT_ID,
  SIGNATURE_AND_EXPORT_VERSION,
  'closed-single-line-body-free-signature-and-explicit-export-v1'
);

export function extractSignaturesAndExports(context) {
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
        factType: 'signature',
        subject: { kind: 'file', id: file.path },
        attemptedProducer: SIGNATURE_AND_EXPORT_ID,
        code: 'INVALID_UTF8',
        detail: `The pinned source ${file.path} is not valid UTF-8.`
      }));
      continue;
    }
    const language = languageForPath(file.path);
    const scan = scanSignaturesAndExportsWithLimitations(source, language);
    for (const declaration of scan.items) {
      const subject = { kind: 'symbol', id: `${file.path}#${declaration.name}` };
      const locator = {
        symbol: declaration.name,
        range: { startLine: declaration.line, endLine: declaration.line }
      };
      const signatureEvidence = evidenceDescriptor(file, {
        kind: 'signature', locator, subject
      });
      observations.push(signatureEvidence);
      facts.push(factDraft({
        factType: 'signature',
        subject,
        claim: `${file.path} declares ${declaration.signature} at line ${declaration.line}.`,
        assurance: 'structurally-derived',
        evidence: [signatureEvidence]
      }));
      if (declaration.exported) {
        const exportEvidence = evidenceDescriptor(file, { kind: 'export', locator, subject });
        observations.push(exportEvidence);
        facts.push(factDraft({
          factType: 'export',
          subject,
          claim: `${declaration.name} is explicitly exported by ${file.path} at line ${declaration.line}.`,
          assurance: 'structurally-derived',
          evidence: [exportEvidence]
        }));
      }
    }
    if (scan.limitations.length) {
      observeAdapterPathOutcome(context, file, {
        status: 'partial', reasonCode: scan.limitations[0].code
      });
      const subject = { kind: 'file', id: file.path };
      const limitation = scan.limitations[0];
      const evidence = evidenceDescriptor(file, {
        kind: 'signature',
        locator: { range: { startLine: limitation.line, endLine: limitation.line } },
        subject
      });
      observations.push(evidence);
      facts.push(unavailableDraft({
        factType: 'signature',
        subject,
        attemptedProducer: SIGNATURE_AND_EXPORT_ID,
        code: limitation.code,
        detail: `At least one recognized declaration in ${file.path} exceeds the closed signature limit.`,
        evidence: [evidence]
      }));
    }
  }
  return result(SIGNATURE_AND_EXPORT_ID, observations, facts);
}

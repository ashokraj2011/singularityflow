import {
  adapterFiles, evidenceDescriptor, factDraft, implementationSha256, languageForPath, result
} from './common.mjs';

export const LANGUAGE_DETECTION_ID = 'language-detection';
export const LANGUAGE_DETECTION_VERSION = '1.0.0';
export const LANGUAGE_DETECTION_IMPLEMENTATION_SHA256 = implementationSha256(
  LANGUAGE_DETECTION_ID,
  LANGUAGE_DETECTION_VERSION,
  'map-closed-source-extension-vocabulary-to-language-v1'
);

export function extractLanguages(context) {
  const observations = [];
  const facts = [];
  for (const file of adapterFiles(context)) {
    const language = languageForPath(file.path);
    if (!language) continue;
    const subject = { kind: 'file', id: file.path };
    const evidence = evidenceDescriptor(file, { subject });
    observations.push(evidence);
    facts.push(factDraft({
      factType: 'language-detected',
      subject,
      claim: `${file.path} has the registered ${language} source extension.`,
      assurance: 'source-exact',
      evidence: [evidence]
    }));
  }
  return result(LANGUAGE_DETECTION_ID, observations, facts);
}

import { evidenceDescriptor, factDraft, implementationSha256, adapterFiles, result } from './common.mjs';

export const REPOSITORY_FILES_ID = 'repository-files';
export const REPOSITORY_FILES_VERSION = '1.0.0';
export const REPOSITORY_FILES_IMPLEMENTATION_SHA256 = implementationSha256(
  REPOSITORY_FILES_ID,
  REPOSITORY_FILES_VERSION,
  'enumerate-normalized-in-scope-regular-git-blobs-and-register-file-exists-v1'
);

export function extractRepositoryFiles(context) {
  const observations = [];
  const facts = [];
  for (const file of adapterFiles(context)) {
    const subject = { kind: 'file', id: file.path };
    const evidence = evidenceDescriptor(file, { subject });
    observations.push(evidence);
    facts.push(factDraft({
      factType: 'file-exists',
      subject,
      claim: `${file.path} exists as a ${file.mode} Git blob with ${file.bytes} bytes.`,
      assurance: 'source-exact',
      evidence: [evidence]
    }));
  }
  return result(REPOSITORY_FILES_ID, observations, facts);
}

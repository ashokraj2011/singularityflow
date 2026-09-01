import { COMMIT_PATTERN } from '../contracts.mjs';

const KERNEL_STAMP = /\n---\ngenerated-at: ([^\n]+)\nsource-commit: ([a-f0-9]+)\nview-sha256: (sha256:[a-f0-9]{64})\nprompt-sha256: (sha256:[a-f0-9]{64})\nexecution-unit: ([^\n]+)\nmodel: ([^\n]+)\nassurance: validated-derived-view\n---\n$/;

/** Parse the exact kernel-owned suffix used by every published or cached WMB v4 View. */
export function parseWorldModelViewKernelStamp(markdown) {
  const match = String(markdown).match(KERNEL_STAMP);
  if (!match || !COMMIT_PATTERN.test(match[2])) return null;
  return Object.freeze({
    generatedAt: match[1],
    sourceCommit: match[2],
    compositionViewSha256: match[3],
    promptSha256: match[4],
    executionUnit: match[5],
    model: match[6]
  });
}

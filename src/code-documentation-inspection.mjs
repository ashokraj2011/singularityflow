/**
 * Advisory documentation check for the open code generation.
 *
 * Which public functions, methods and classes the change added or edited without a doc comment,
 * in product source only: tests, generated and vendored files, and the Story's own records are
 * left out. Read-only and bounded, it never throws, and nothing it reports is a finding: draft-check
 * and prepublish carry it as `advisories`, so publication readiness is exactly what it was.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildComprehensionDiffPreview } from './comprehension/diff-preview.mjs';
import {
  changedDeclarations, documentationLanguage, publicDeclarations, unsupportedSourceLanguage
} from './code-documentation.mjs';
import { phaseRequiresCodeDelivery } from './delivery-evidence.mjs';
import { buildRepositoryChangeSet } from './repository-change-set.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';
import { posix } from './util.mjs';

export const CODE_DOCUMENTATION_LIMITS = Object.freeze({
  files: 200,
  fileBytes: 512 * 1024,
  advisories: 50,
  diffBytes: 2 * 1024 * 1024
});

const GENERATED_OR_VENDORED = /(?:^|\/)(?:node_modules|vendor|third_party|third-party|dist|build|out|target|coverage|generated|__generated__|\.next)\/|\.min\.[cm]?js$|\.(?:pb|gen|generated)\.[a-z]+$|_pb2\.py$/iu;

export const CODE_DOCUMENTATION_GUIDANCE = 'Add a doc comment to each listed declaration in this turn, in the language\'s own convention: '
  + 'what it does, its parameters and result, and anything a caller must know. Change comments only, never code, and do not repeat '
  + '@clause or @ac tags as documentation. These advisories never block publication; fix them once and move on.';

function summary(status, values = {}) {
  return Object.freeze({
    status, reason: null, inspectedFiles: 0, declarations: 0, undocumented: 0,
    unsupportedFiles: 0, omittedFiles: 0, omittedAdvisories: 0, blocking: false, ...values
  });
}

function productSource(relative, itemRoot) {
  return !relative.startsWith('singularity/') && !relative.startsWith(`${itemRoot}/`)
    && !relative.startsWith('.github/') && !isTestAutomationPath(relative) && !GENERATED_OR_VENDORED.test(relative);
}

/** Changed line numbers in the new version of each tracked file, from a zero-context patch. */
function changedLinesByPath(preview) {
  const byPath = new Map();
  for (const file of preview.files ?? []) {
    if (!file.pathAfter) continue;
    const lines = byPath.get(file.pathAfter) ?? new Set();
    for (const hunk of file.hunks ?? []) {
      for (let line = hunk.afterStart; line < hunk.afterStart + hunk.afterLines; line += 1) lines.add(line);
    }
    byPath.set(file.pathAfter, lines);
  }
  return byPath;
}

/**
 * `{ documentation, advisories }` for the phase's open code generation. `documentation.status` is
 * `complete`, `missing`, `not-applicable` (no open code generation, or no product source changed)
 * or `unavailable` (the change could not be read), and `blocking` is always false.
 */
export async function inspectCodeDocumentation(root, config, workflow, phase) {
  try {
    if (!phaseRequiresCodeDelivery(phase) || phase.generationIntent?.status !== 'open') {
      return { documentation: summary('not-applicable', { reason: 'no-open-code-generation' }), advisories: [] };
    }
    const baseCommit = phase.generationIntent?.baseline?.commit ?? workflow.workIntervals?.current?.sourceBaseCommit ?? null;
    if (!baseCommit) return { documentation: summary('unavailable', { reason: 'generation-baseline-unknown' }), advisories: [] };
    const itemRoot = posix(config.workItemRoot ?? 'singularity/work-items');
    const changeSet = await buildRepositoryChangeSet(root, { baseCommit });
    const candidates = changeSet.entries.filter((entry) => entry.newPath && entry.status !== 'deleted' && productSource(entry.newPath, itemRoot));
    const supported = candidates.filter((entry) => documentationLanguage(entry.newPath));
    const unsupportedFiles = candidates.filter((entry) => !documentationLanguage(entry.newPath) && unsupportedSourceLanguage(entry.newPath)).length;
    if (!supported.length) {
      return { documentation: summary('not-applicable', { reason: 'no-product-source-changed', unsupportedFiles }), advisories: [] };
    }
    const preview = supported.some((entry) => !entry.untracked)
      ? buildComprehensionDiffPreview(root, changeSet, { contextLines: 0, maximumBytes: CODE_DOCUMENTATION_LIMITS.diffBytes })
      : { status: 'not-applicable', files: [] };
    if (supported.some((entry) => !entry.untracked) && preview.fileProjectionStatus !== 'available') {
      return { documentation: summary('unavailable', { reason: preview.fileProjectionReason ?? preview.reason ?? 'diff-unavailable', unsupportedFiles }), advisories: [] };
    }
    const changedLines = changedLinesByPath(preview);
    const inspected = supported.slice(0, CODE_DOCUMENTATION_LIMITS.files);
    const advisories = [];
    let declarations = 0;
    let inspectedFiles = 0;
    let omittedFiles = supported.length - inspected.length;
    for (const entry of inspected) {
      const relative = entry.newPath;
      const bytes = await readFile(path.join(root, ...relative.split('/'))).catch(() => null);
      if (!bytes || bytes.length > CODE_DOCUMENTATION_LIMITS.fileBytes || bytes.includes(0)) { omittedFiles += 1; continue; }
      inspectedFiles += 1;
      const source = bytes.toString('utf8');
      const all = publicDeclarations(source, documentationLanguage(relative));
      // A new file is new everywhere; an edited one only where its patch says.
      const touched = entry.untracked || entry.status === 'added'
        ? all
        : changedDeclarations(all, changedLines.get(relative) ?? new Set(), source.split(/\r?\n/u));
      declarations += touched.length;
      for (const declaration of touched.filter((candidate) => !candidate.documented)) {
        advisories.push(Object.freeze({
          code: 'code.documentation.missing', category: 'documentation', blocking: false,
          path: relative, line: declaration.line, value: declaration.name, kind: declaration.kind,
          message: `Public ${declaration.kind} '${declaration.name}' in ${relative}:${declaration.line} has no doc comment.`
        }));
      }
    }
    // By file and line, whatever order Git listed the changes in.
    advisories.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
    const listed = advisories.slice(0, CODE_DOCUMENTATION_LIMITS.advisories);
    return {
      documentation: summary(advisories.length ? 'missing' : 'complete', {
        inspectedFiles, declarations, undocumented: advisories.length, unsupportedFiles, omittedFiles,
        omittedAdvisories: advisories.length - listed.length,
        guidance: advisories.length ? CODE_DOCUMENTATION_GUIDANCE : null
      }),
      advisories: Object.freeze(listed)
    };
  } catch (error) {
    return { documentation: summary('unavailable', { reason: error?.code ?? 'inspection-failed' }), advisories: [] };
  }
}

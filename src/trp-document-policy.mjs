/** Explicit supplemental document obligations; never essential workflow/policy artifacts. */
import { normalizeTestSelectionPath } from './test-selection-policy.mjs';
import { SingularityFlowError } from './util.mjs';

const fail = message => { throw new SingularityFlowError(message, { code: 'TRP_DOCUMENT_POLICY_INVALID' }); };
export function normalizeDocumentObligations(value) {
  if (!Array.isArray(value) || !value.length || value.length > 64) fail('documentObligations needs 1–64 explicitly named supplemental Markdown documents.');
  const seen = new Set(); const paths = new Set();
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['id', 'phaseId', 'path', 'requiredSections'].includes(key))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.id ?? '')
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.phaseId ?? '')
      || entry.id.includes('..') || entry.phaseId.includes('..')) fail('Every supplemental document needs a safe ID and phase.');
    let relative;
    try { relative = normalizeTestSelectionPath(entry.path); } catch { fail('A supplemental document needs a safe repository-relative path.'); }
    if (relative !== entry.path || !/\.md$/iu.test(relative)
      || /(^|\/)(?:\.[^/]+|singularity|AGENTS\.md|SKILL\.md|USER-STORY\.md)(?:\/|$)/iu.test(relative)) {
      fail('Only ordinary supplemental Markdown paths outside authority, Story and agent instructions may be declared nonessential.');
    }
    const pair = `${entry.phaseId}:${entry.id}`; const target = `${entry.phaseId}:${relative.toLowerCase()}`;
    if (seen.has(pair) || paths.has(target)) fail('Supplemental document IDs and paths must be unique per phase.');
    seen.add(pair); paths.add(target);
    const sections = entry.requiredSections ?? [];
    if (!Array.isArray(sections) || sections.length > 32 || new Set(sections).size !== sections.length
      || sections.some(item => typeof item !== 'string' || item !== item.trim() || !item.length
        || item.length > 256 || /[\x00-\x1f\x7f]/u.test(item))) fail('Document sections must be bounded, unique heading names.');
    return { id: entry.id, phaseId: entry.phaseId, path: relative, requiredSections: sections };
  });
}

export function documentObligationsForPhase(workflow, phaseId) {
  if (workflow.resolution?.testRecovery?.enabled !== true) return [];
  return (workflow.resolution.testRecovery.documentObligations ?? []).filter(entry => entry.phaseId === phaseId);
}

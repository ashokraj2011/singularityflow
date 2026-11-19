/**
 * A missing test command's refusal, with the runners SFlow suggests for the changed code, so each is offered as one whole
 * `decision test-command … --use <ID>` [audit 2026-11-19, entry 8]. Loaded only when publication or submission refuses.
 * Inspection runs nothing and reads only the changed paths' own folders (three at most); if it cannot read them, the
 * refusal names no suggestion.
 */
import path from 'node:path';
import { structuredTestCommandRequiredError } from './code-delivery-tests.mjs';

export async function testCommandRequiredRefusal(root, phase, { workId = null, paths = [] } = {}) {
  const error = structuredTestCommandRequiredError(phase, { workId, paths });
  try {
    const folders = [...new Set((paths ?? []).map((file) => path.posix.dirname(String(file))).filter((folder) => folder && !folder.startsWith('..')))].slice(0, 3);
    const { inspectRepositoryTestSetup } = await import('./repository-test-setup.mjs');
    const sourceRoots = folders.length ? folders : ['.'];
    const inspection = await inspectRepositoryTestSetup(root, { sourceRoots });
    const offered = [...inspection.suggestions, ...inspection.instructionCandidates.filter((entry) => entry.command)]
      .filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.id ?? '')).slice(0, 3);
    if (offered.length) error.details.testSuggestions = offered.map((entry) => ({ id: entry.id,
      label: (entry.command?.argv ?? entry.argv ?? []).join(' ').slice(0, 200), sourceRoots: sourceRoots.filter((folder) => folder !== '.') }));
  } catch { /* The refusal stands without suggestions; inspecting them is the person's next read. */ }
  return error;
}

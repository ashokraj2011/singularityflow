/**
 * A Story-only test command the repository itself declares [owner, 2026-11-13].
 *
 * A request (`decision test-command --use SUGGESTION-ID`) waited for a person who approves the step even when the
 * repository named that command and nothing else: the only test command its own build files or written instructions
 * declare for the module, in files this Story has not changed. That answer is clear, so SFlow settles the request with
 * that evidence; the step runs it as if accepted, and the decisions card lists it with an undo, which makes it a
 * request a person accepts again. A command given in full, a re-pin, several candidates, or a declaration this
 * Story changed: a person accepts it, as before.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// The files a module's inferred test command is read from (repository-test-command-inference.mjs).
const MANIFESTS = Object.freeze(['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'pytest.ini', 'Package.swift']);
const BASE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu;

/** Whether `file` (repository-relative) holds today what it held at the Story's base commit; false when unreadable. */
async function unchangedSinceBase(root, base, file) {
  const { exactFileAtObject } = await import('./git.mjs');
  let before;
  try { before = exactFileAtObject(root, base, file); } catch { return false; }
  const now = await readFile(path.join(root, ...file.split('/'))).catch(() => null);
  return Boolean(before && now) && Buffer.compare(Buffer.from(before), now) === 0;
}

/**
 * The evidence that the repository alone declares `use` for `sourceRoots`, or null. Read-only.
 */
export async function repositoryDeclaredTestCommand(root, workflow, { use, sourceRoots, command }) {
  const base = String(workflow?.workItem?.baseCommit ?? '');
  if (!use || !BASE.test(base)) return null;
  const { inspectRepositoryTestSetup } = await import('./repository-test-setup.mjs');
  let inspection;
  try { inspection = await inspectRepositoryTestSetup(root, { sourceRoots: sourceRoots.length ? sourceRoots : ['.'] }); } catch { return null; }
  const candidates = [...inspection.suggestions.map((entry) => ({ id: entry.id, command: entry, source: null })),
    ...inspection.instructionCandidates.filter((entry) => entry.command).map((entry) => ({ id: entry.id, command: entry.command, source: entry.source }))];
  if (candidates.length !== 1 || candidates[0].id !== use || JSON.stringify(candidates[0].command.argv) !== JSON.stringify(command.argv)
    || inspection.diagnostics.some((entry) => entry.code === 'TEST_MODULE_AMBIGUOUS')) return null;
  const [only] = candidates;
  const folder = only.command.workingDirectory ?? '.';
  const files = only.source ? [only.source.file]
    : (await Promise.all(MANIFESTS.map(async (name) => {
      const file = folder === '.' ? name : `${folder}/${name}`;
      return await readFile(path.join(root, ...file.split('/'))).then(() => file, () => null);
    }))).filter(Boolean);
  if (!files.length) return null;
  for (const file of files) if (!await unchangedSinceBase(root, base, file)) return null;
  return [
    { what: `${only.command.argv.join(' ')} is the only test command the repository declares for ${sourceRoots.join(', ') || 'its root'}`,
      where: only.source ? `${only.source.file}:${only.source.line}` : files.join(', ') },
    { what: 'this Story has not changed where it is declared', where: `${files.join(', ')} as at the Story's base` }
  ];
}

/** Settle a request the repository alone declares; returns the settlement, or null when a person accepts it. */
export async function settleDeclaredTestCommand(root, config, workflow, request, { use, sourceRoots = [], actor, agent = null }) {
  if (!request?.id || request.repin) return null;
  const evidence = await repositoryDeclaredTestCommand(root, workflow, { use, sourceRoots, command: request.command });
  if (!evidence) return null;
  const { commitSettledDecision, settlementState } = await import('./settled-decisions.mjs');
  if (settlementState(workflow, 'test-command', request.id) !== 'open') return null;
  try {
    const { record } = await commitSettledDecision(root, config, workflow, {
      kind: 'test-command', by: 'sflow', phase: request.phase, subject: request.id,
      answer: `${request.phase} runs ${request.command.id} for this Story (${request.id}): the only test command the repository declares for it.`,
      evidence, effect: { request: request.id, commandId: request.command.id }
    }, { actor, agent });
    return record;
  } catch { return null; }
}

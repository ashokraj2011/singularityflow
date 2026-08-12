/**
 * The advisory task map. `[SPK:REQ-112]` `[SPK:REQ-113]` `[SPK:CON-046]` `[SPK:CON-019]`
 *
 * `tasks.md` is the one document in this profile that is explicitly *not* evidence. It exists because
 * people work from a list, and it is derived rather than authored because a hand-written list drifts
 * from the specification the moment either changes — and a stale list is worse than none, since it
 * reads as agreement.
 *
 * So the map is generated from the approved specification and planning generations and records both
 * their hashes `[SPK:REQ-112]`. That binding is what lets a reader tell a current list from a list
 * about a specification that has since moved.
 *
 * `[SPK:CON-046]` is the constraint that keeps it honest: ticking every box here proves nothing. The
 * kernel's evidence is clause coverage, checks, and approvals; a checkbox is a note to yourself. The
 * document says so in its own text, because the person most likely to forget is the one reading a
 * fully-ticked list at the end of a long week.
 *
 * `[SPK:CON-019]` is why this is a member of the planning artifact set rather than a phase: a task
 * map is a planning aid, and giving it a phase would give it approvals it must never have.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { extractClauses } from './specifications.mjs';
import { exists, posix, SingularityFlowError } from './util.mjs';

export const ADVISORY_TASK_MEMBER = 'tasks.md';

const MANAGED_START = '<!-- singularity-flow:tasks:start';
const MANAGED_END = '<!-- singularity-flow:tasks:end -->';

/**
 * Expected paths and checks, read from the plan's own surface table.
 *
 * The starter plan template asks for `| Surface | Change | Serves |`, so the plan already says which
 * clause each path serves. Deriving from it means the task map cannot invent an expectation the plan
 * did not make — the alternative is guessing at paths, which is how an advisory document starts
 * sounding authoritative.
 */
export function planSurfaces(markdown) {
  const surfaces = new Map();
  for (const line of String(markdown ?? '').split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    // A table row is `| a | b | c |`, so splitting gives an empty first and last cell.
    if (cells.length !== 5 || cells[0] || cells[4]) continue;
    const [, surface, change, serves] = cells;
    if (!surface || /^-+$/.test(surface) || /^surface$/i.test(surface)) continue;
    for (const clause of serves.match(/\b(?:[A-Z][A-Z0-9]*:)?(?:REQ|BEH|IFC|AC|CON)-\d{3}\b/g) ?? []) {
      const key = clause.toUpperCase();
      const entry = surfaces.get(key) ?? { paths: [], changes: [] };
      entry.paths.push(surface.replace(/`/g, ''));
      if (change) entry.changes.push(change);
      surfaces.set(key, entry);
    }
  }
  return surfaces;
}

/** Match a clause to a surface row whether or not the plan spelled out the namespace. */
function surfaceFor(surfaces, clauseId) {
  return surfaces.get(clauseId.toUpperCase()) ?? surfaces.get(clauseId.split(':').at(-1).toUpperCase()) ?? null;
}

function firstSentence(body) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  const stop = text.search(/\.\s|\.$/);
  return (stop === -1 ? text : text.slice(0, stop + 1)).trim();
}

/** Strip the list marker and emphasis a requirement line is usually written with. */
function plain(line) {
  return String(line ?? '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/^\*\*([^*]+)\*\*\s*[—:-]?\s*/, '$1 — ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What a clause says, for a human reading a checklist.
 *
 * Read from the **line the anchor sits on**, not from `clause.body`. The extractor defines a body as
 * everything *after* the anchor up to the next one, which is right for a leading anchor
 * (`[APP:REQ-001] The system …`) and exactly wrong for a trailing one
 * (`- The system … [APP:REQ-001]`) — there the body is the *next* requirement's text. Deriving from
 * the body produced a task list where every item described the following requirement and the last
 * described nothing, which is worse than no list at all because it reads as correct.
 */
function clauseSummary(markdown, clause) {
  const at = markdown.indexOf(clause.anchor);
  if (at > -1) {
    const start = markdown.lastIndexOf('\n', at) + 1;
    const end = markdown.indexOf('\n', at);
    const line = plain(markdown.slice(start, end === -1 ? undefined : end).replace(clause.anchor, ''));
    if (line) return line;
  }
  // A leading anchor alone on its line has no text beside it; the body is then the right source.
  return plain(firstSentence(clause.body)) || clause.id;
}

/**
 * Derive the task map. Pure over its inputs, and takes no clock, so the same approved generations
 * always produce the same document.
 */
export function deriveAdvisoryTasks({
  workId, specification, planning, namespace = null
} = {}) {
  if (!specification?.markdown) throw new SingularityFlowError('An approved specification is required to derive the task map.');
  const clauses = extractClauses(specification.markdown, { sourcePath: specification.path, namespace });
  const surfaces = planSurfaces(planning?.markdown ?? '');

  const items = clauses.map((clause) => {
    const surface = surfaceFor(surfaces, clause.id);
    return {
      clauseId: clause.id,
      summary: clauseSummary(specification.markdown, clause),
      // `[SPK:REQ-113]` says SHOULD, and this is why it is a should: the paths come from the plan,
      // and a plan that named none leaves the item without them rather than with invented ones.
      expectedPaths: [...new Set(surface?.paths ?? [])],
      expectedChanges: [...new Set(surface?.changes ?? [])]
    };
  });

  return {
    schemaVersion: 1,
    workId,
    authority: 'advisory',
    // `[SPK:REQ-112]`: the exact generations and bytes this was derived from.
    derivedFrom: {
      specification: { path: specification.path, generation: specification.generation ?? null, sha256: specification.sha256 },
      planning: planning
        ? { path: planning.path, generation: planning.generation ?? null, sha256: planning.sha256 }
        : null
    },
    items
  };
}

/** Render the map as the Markdown member, with the binding in a kernel-managed block. */
export function renderAdvisoryTasks(map) {
  const { specification, planning } = map.derivedFrom;
  const lines = [
    `# Task map — ${map.workId}`,
    '',
    MANAGED_START,
    JSON.stringify({ schemaVersion: map.schemaVersion, authority: map.authority, derivedFrom: map.derivedFrom }, null, 2),
    MANAGED_END,
    '',
    '> **Advisory.** This list is derived from the approved specification and plan; it is not evidence.',
    '> Ticking every box proves nothing about implementation or verification `[SPK:CON-046]` — clause',
    '> coverage, quality commands and approvals are what the kernel counts. Regenerate it with',
    '> `singularity-flow spec tasks` whenever either source changes.',
    '',
    `- Specification: \`${specification.path}\` generation ${specification.generation ?? 'unknown'} (\`${specification.sha256.slice(0, 12)}\`)`,
    planning
      ? `- Plan: \`${planning.path}\` generation ${planning.generation ?? 'unknown'} (\`${planning.sha256.slice(0, 12)}\`)`
      : '- Plan: none approved yet, so no expected paths are listed.',
    '',
    '## Tasks',
    ''
  ];
  if (!map.items.length) lines.push('_The approved specification has no clause anchors, so there is nothing to derive._', '');
  for (const item of map.items) {
    lines.push(`- [ ] **${item.clauseId}** — ${item.summary}`);
    if (item.expectedPaths.length) lines.push(`  - Expected: ${item.expectedPaths.map((entry) => `\`${entry}\``).join(', ')}`);
    if (item.expectedChanges.length) lines.push(`  - Plan says: ${item.expectedChanges.join('; ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Where the map lives: the advisory member of the planning artifact set. */
export function advisoryTaskPath(workDirRelativePath, planningPhase) {
  const artifact = planningPhase?.requiredArtifact?.path ?? planningPhase?.artifact?.path ?? '';
  return posix(path.posix.join(workDirRelativePath, path.posix.dirname(posix(String(artifact))), ADVISORY_TASK_MEMBER));
}

/**
 * Read an approved phase's artifact for derivation.
 *
 * Refuses an unapproved one. `[SPK:REQ-112]` says *approved* generations, and deriving from a draft
 * would produce a list that looks governed and tracks something nobody agreed to.
 */
export async function approvedSource(root, workDirRelativePath, phase, { required = true } = {}) {
  const relative = posix(path.posix.join(workDirRelativePath, phase?.requiredArtifact?.path ?? ''));
  if (phase?.status !== 'approved') {
    if (!required) return null;
    throw new SingularityFlowError(`Phase '${phase?.id}' is '${phase?.status ?? 'missing'}'; the task map is derived from approved generations only.`);
  }
  if (!(await exists(path.join(root, relative)))) {
    if (!required) return null;
    throw new SingularityFlowError(`Approved artifact is missing: ${relative}`);
  }
  const markdown = await readFile(path.join(root, relative), 'utf8');
  const artifact = (phase.artifacts ?? []).find((entry) => entry.path === relative);
  return {
    path: relative,
    generation: phase.generation,
    // The registered hash when there is one, so the map binds to what was *approved* rather than to
    // whatever is on disk now. Hashing the bytes as a fallback rather than recording null: a null
    // here would produce a derivedFrom block that binds to nothing while looking like it binds.
    sha256: artifact?.sha256 ?? createHash('sha256').update(markdown, 'utf8').digest('hex'),
    markdown
  };
}

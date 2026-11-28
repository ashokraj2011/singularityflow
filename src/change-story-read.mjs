/**
 * Reading the Story's "What this change does" page that SFlow wrote [CSP, docs/SPEC-CSP-CHANGE-STORY-PAGE-v1.md]: its
 * one-line summary and where it is, for the approval's line, the Work page and the pull request, with no Git, parser or
 * model. A leaf: node:fs and the Story's paths only, so the decision list's VS Code bundles and the CLI's reads load it
 * cheaply. The builder is change-story-page.mjs.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { storyLocation } from './story-paths.mjs';

/** The page, in the Story's folder beside STATUS.md: a Story record, outside every step's documents [CSP:REQ-005]. */
export const CHANGE_STORY_FILE = 'CHANGE-STORY.md';
/** Copilot's optional English, beside the code step's own document [CSP:REQ-002]. */
export const CHANGE_EXPLANATION_FILE = 'change-explanation.json';
/** The page's first line: `<!-- singularity-flow:change-story {"summary":…} -->`. */
export const CHANGE_STORY_MARKER = 'singularity-flow:change-story';

const MARKER = new RegExp(`^<!-- ${CHANGE_STORY_MARKER} (\\{.*\\}) -->`, 'u');

/** The summary line a page carries, or null when the text is not a page SFlow wrote. Pure. */
export function changeStorySummaryOf(text) {
  try {
    const summary = JSON.parse(MARKER.exec(String(text ?? ''))?.[1] ?? 'null')?.summary;
    return typeof summary === 'string' && summary ? summary.slice(0, 200) : null;
  } catch { return null; }
}

/** The page's text without its marker line, for a reader that shows it (the pull request, the read). Pure. */
export function changeStoryBody(text) {
  return String(text ?? '').replace(MARKER, '').replace(/^\s+/u, '');
}

/**
 * The page SFlow wrote for a Story in this checkout: `{ path, absolute, summary, text }` (`path` repository-relative), or
 * null when there is none. Never throws.
 */
export async function readChangeStoryPage(root, config, workflow) {
  try {
    const absolute = storyLocation(root, [workflow, config], workflow.workItem.id).file(CHANGE_STORY_FILE);
    const text = await readFile(absolute, 'utf8');
    const summary = changeStorySummaryOf(text);
    if (!summary) return null;
    return { path: path.relative(root, absolute).split(path.sep).join('/'), absolute, summary, text };
  } catch { return null; }
}

/** The read that prints the page, as SFlow prints it for a person: never one they compose [CSP:REQ-010]. */
export function changeStoryCommand(workId) {
  return `singularity-flow explain --subject change --page --work-id ${workId}`;
}

/**
 * The code step's approval line [CSP:REQ-007]: `{ phase, summary, path, command }` for a code step (one with delivered code)
 * whose Story has a written page, else null. The decision list reads it for the step awaiting approval.
 */
export async function changeStoryFacts(root, config, workflow, phase) {
  if (!phase?.deliveryEvidence || !workflow?.workItem?.id) return null;
  const page = await readChangeStoryPage(root, config, workflow);
  return page ? { phase: phase.id, summary: page.summary, path: page.path, command: changeStoryCommand(workflow.workItem.id) } : null;
}

/** The page as a pull request's section [CSP:REQ-009]: without its title and banner, its headings one level down. Pure. */
export function changeStoryForPullRequest(text) {
  // The pull request has its own section for what a person decided (pull-request.mjs), read from the Story as it is now.
  let personSection = false;
  return changeStoryBody(text).split('\n').filter((line) => {
    if (/^## /u.test(line)) personSection = line.startsWith('## Decided by a person, not checked by SFlow');
    return !personSection;
  }).filter((line, index) => !(index === 0 && /^# /u.test(line)))
    .filter((line) => !/^> Written by SFlow from its records/u.test(line))
    .map((line) => (/^#{1,4} /u.test(line) ? `##${line}` : line)).join('\n').replace(/^\s+/u, '').trimEnd();
}

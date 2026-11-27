/**
 * What was used for similar changes before [ITW:REQ-110, docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md]: a task's plan reads this
 * repository's earlier task Stories, on this machine only (OMK: usage and outcomes stay local), and names the agent or
 * workflow used most for similar changes, with how those Stories went, and the lessons kept for their files.
 *
 * - An earlier Story is one whose record this checkout holds (merged into it): its kind, the files its task named and its
 *   code changed, where its steps came from (`composition.agent`, `local`, or SFlow's own) and how it went: approved first
 *   time (no step returned, every step a person approved at its first version), its returns and its versions.
 * - It is similar when it is of the same group (code or analysis) and shares an area with this task: a folder of the
 *   files the task names, or a file whose name the task's words say ("the value module": src/value.mjs).
 * - The suggestion is the source used most among them (then the most approved first time, then by name), when it is an
 *   agent or a workflow; SFlow's own steps need no suggestion.
 *
 * Reads files only: no Git, no network, nothing written. similarTasks and suggestion are pure.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ANALYSIS_KINDS, agentWords } from './task-composition.mjs';
import { areaOf } from './task-shape.mjs';

const LIMIT = 200;
const words = (text) => new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length > 2));
const stem = (file) => path.posix.basename(String(file)).replace(/\.[^.]+$/u, '').toLowerCase();
const group = (kind) => (ANALYSIS_KINDS.includes(kind) ? 'analysis' : 'code');

/** Where a Story's steps came from: `{ key, kind, words, use }`, or SFlow's own. */
export function planSource(composition) {
  if (composition?.agent?.marketplace) {
    const id = `${composition.agent.marketplace}/${composition.agent.agent}`;
    return { key: `agent:${id}`, kind: 'agent', id, words: agentWords(composition.agent), use: `--use-agent ${id}` };
  }
  if (composition?.local?.workflow && composition.local.by !== 'use') {
    const id = composition.local.workflow;
    return { key: `workflow:${id}`, kind: 'workflow', id, words: `your team's workflow ${composition.local.label ?? id}`, use: `--use-workflow ${id}` };
  }
  return { key: 'sflow', kind: 'sflow', id: null, words: 'SFlow\'s own steps', use: null };
}

/** How a done Story went: approved first time, its returns and its versions. */
export function storyOutcome(workflow) {
  const phases = (workflow?.phaseOrder ?? []).map((id) => workflow.phases?.[id]).filter(Boolean);
  const returns = (workflow?.changeRequests ?? []).length;
  const versions = phases.reduce((total, phase) => total + Math.max(1, Number(phase.generation) || 1), 0);
  const firstTime = returns === 0 && phases.every((phase) => !phase.approvedBy || (Number(phase.generation) || 1) === 1);
  return { firstTime, returns, versions };
}

/**
 * The earlier task Stories in `stories` (`{ id, workflow, files }`) similar to a task of `kind` whose words are `said` and
 * whose named files are `files`: same group, a shared area. Pure.
 */
export function similarTasks(stories, { kind, said = '', files = [] }) {
  const mine = new Set(files.map(areaOf));
  const told = words(said);
  return stories.filter(({ workflow, files: theirs }) => {
    const composition = workflow?.resolution?.composition;
    if (!composition?.kind || group(composition.kind) !== group(kind) || workflow.status !== 'closed') return false;
    return theirs.some((file) => mine.has(areaOf(file)) || told.has(stem(file)));
  });
}

/**
 * The suggestion from similar Stories [ITW:REQ-110]: `{ source, count, firstTime, area, line, stories }` for the agent or
 * workflow used most, or null when SFlow's own steps were used most (or nothing is similar). Pure.
 */
export function suggestion(similar, { said = '', files = [] } = {}) {
  const counts = new Map();
  for (const story of similar) {
    const source = planSource(story.workflow.resolution.composition);
    const entry = counts.get(source.key) ?? { source, count: 0, firstTime: 0, stories: [], files: [] };
    entry.count += 1;
    if (storyOutcome(story.workflow).firstTime) entry.firstTime += 1;
    entry.stories.push(story.id);
    entry.files.push(...story.files);
    counts.set(source.key, entry);
  }
  const [top] = [...counts.values()].sort((left, right) => right.count - left.count || right.firstTime - left.firstTime
    || String(left.source.id ?? '').localeCompare(String(right.source.id ?? '')));
  if (!top || top.source.kind === 'sflow') return null;
  // The area as the person knows it: the one this task names that those Stories changed, else theirs.
  const told = words(said);
  const shared = top.files.find((file) => files.some((own) => areaOf(own) === areaOf(file))) ?? top.files.find((file) => told.has(stem(file))) ?? top.files[0];
  const area = shared ? (areaOf(shared) === '.' ? shared : areaOf(shared)) : 'this code';
  return { source: top.source, count: top.count, firstTime: top.firstTime, area, stories: top.stories.slice(0, 5),
    line: `For similar changes to ${area} you used ${top.source.words} ${top.count === 1 ? 'once' : `${top.count} times`}, ${top.firstTime} approved first time.` };
}

/** The files an earlier Story named or changed: its task's paths and its code steps' change sets, read from the checkout. */
function storyFiles(root, folder, workflow) {
  const files = new Set(workflow?.resolution?.composition?.touchedPaths ?? []);
  for (const id of workflow?.phaseOrder ?? []) {
    const changeSetPath = workflow.phases?.[id]?.deliveryEvidence?.changeSetPath;
    if (!changeSetPath) continue;
    try {
      const changeSet = JSON.parse(readFileSync(path.join(root, changeSetPath), 'utf8'));
      for (const entry of changeSet.entries ?? []) for (const file of [entry.newPath, entry.oldPath]) if (file && !String(file).startsWith(`${folder}/`)) files.add(String(file));
    } catch { /* a change set this checkout does not hold names nothing */ }
  }
  return [...files].sort();
}

/** This checkout's earlier task Stories, each `{ id, workflow, files }`, at most 200, newest first. */
export function checkoutTaskStories(root, folders) {
  const found = [];
  for (const folder of folders) {
    const directory = path.join(root, folder);
    if (!existsSync(directory)) continue;
    for (const id of readdirSync(directory).sort().reverse()) {
      if (found.length >= LIMIT) break;
      let workflow = null;
      try { workflow = JSON.parse(readFileSync(path.join(directory, id, 'workflow.json'), 'utf8')); } catch { continue; }
      if (!workflow?.resolution?.composition?.kind) continue;
      found.push({ id, workflow, files: storyFiles(root, `${folder}/${id}`, workflow) });
    }
  }
  return found;
}

/**
 * The history a task's plan reads [ITW:REQ-110]: `{ suggestion, lessons }`. `exists(file)` says whether the checkout has a
 * file; `folders` are the Stories folders. The lessons are those kept for the files the similar Stories changed and this
 * task names; a store that cannot be read counts none.
 */
export async function taskHistory(root, { kind, said = '', touchedPaths = [], folders = [], exists = () => false } = {}) {
  const { namedFiles } = await import('./task-shape.mjs');
  const files = [...new Set([...touchedPaths, ...namedFiles(said, exists)])];
  const similar = similarTasks(checkoutTaskStories(root, folders), { kind, said, files });
  const suggested = suggestion(similar, { said, files });
  let lessons = 0;
  try {
    const { readAllLessons, lessonsFor } = await import('./story-lessons.mjs');
    const paths = [...new Set([...files, ...similar.flatMap((story) => story.files)])];
    if (paths.length) lessons = lessonsFor((await readAllLessons(root, { base: false })).entries, { paths }).length;
  } catch { lessons = 0; }
  return { suggestion: suggested, similar: similar.length, lessons,
    ...(lessons ? { lessonsLine: `${lessons} ${lessons === 1 ? 'lesson' : 'lessons'} from earlier Stories reach${lessons === 1 ? 'es' : ''} its steps.` } : {}) };
}

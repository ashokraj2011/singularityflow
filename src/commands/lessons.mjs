/**
 * `singularity-flow lessons [--path P] [--story ID] [--json]` and `lessons drop|keep|edit|guidance <K-ID>` [LRN:REQ-004, REQ-014].
 * `lessons guidance` makes a lesson team guidance [LRN:REQ-012]; `lessons rule` is its earlier name and still works, so
 * scripts keep working, but "rules" are only the team's `tasks:` rules that add steps [FPL §11, question 4].
 *
 * A person's view of the lessons Stories left (src/story-lessons.mjs): what each one says, where it came from, how far it
 * is trusted and whether it may be out of date. Drop resolves one for good, Keep confirms it, Edit puts a person's words
 * in its place; each is committed on the checked-out branch, as `knowledge` commits. Lessons are guidance, never
 * authority: nothing here approves, blocks or counts as evidence.
 */
import { add, changes, commit } from '../git.mjs';
import { repoRoot } from '../git-execution.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const WRITES = ['drop', 'keep', 'edit', 'guidance', 'rule'];
/** `lessons rule` is `lessons guidance` by its earlier name. */
const GUIDANCE = new Set(['guidance', 'rule']);

function commitLessons(root, message) {
  add(root, ['singularity/knowledge']);
  if (!changes(root).length) return null;
  return commit(root, message, ['singularity/knowledge']);
}

function repositoryRoot(cwd) {
  let root = null;
  try { root = repoRoot(cwd); } catch { root = null; }
  if (!root) {
    throw new SingularityFlowError('Run singularity-flow lessons inside a Git checkout: lessons live in its repository.', {
      code: 'LESSONS_NOT_IN_REPOSITORY',
      details: { nextAction: { command: 'singularity-flow lessons', label: 'Open a terminal in the repository, then run this there.' } }
    });
  }
  return root;
}

/** One lesson as a person and VS Code read it: words and origin, never a digest. */
function lessonView(entry, stale) {
  const { record } = entry;
  const lesson = record.lesson ?? {};
  return {
    id: record.id, text: record.text, type: record.type, kind: lesson.kind ?? record.type,
    trust: lesson.trust ?? 'confirmed', from: null, paths: record.scope?.paths ?? [], steps: record.scope?.steps ?? [],
    repeats: lesson.repeats ?? 0, pinned: lesson.pinned === true, mayBeOutOfDate: stale.has(entry.sha256),
    workId: lesson.origin?.workId ?? null, phase: lesson.origin?.phase ?? null, createdAt: record.createdAt
  };
}

export async function lessonsCommand(positionals = [], options = {}, { cwd = process.cwd() } = {}) {
  const root = repositoryRoot(cwd);
  const lessons = await import('../story-lessons.mjs');
  const action = positionals[1] ?? 'list';
  if (WRITES.includes(action)) {
    const wanted = positionals[2];
    if (!wanted) {
      throw new SingularityFlowError(`lessons ${action} needs the lesson's ID (K-…).`, {
        code: 'LESSON_ID_MISSING', details: { nextAction: { command: 'singularity-flow lessons', label: 'List the lessons with their IDs.' } }
      });
    }
    const done = action === 'drop' ? await lessons.dropLesson(root, wanted)
      : action === 'keep' ? await lessons.keepLesson(root, wanted)
        : GUIDANCE.has(action) ? await lessons.ruleLesson(root, wanted)
          : await lessons.editLesson(root, wanted, optionString(options, 'text') ?? positionals.slice(3).join(' '));
    const entry = done.dropped ?? done.kept ?? done.ruled ?? done.edited;
    const committedAs = done.result.created ? commitLessons(root, `[lessons][${action}] ${entry.record.id}`) : null;
    const words = action === 'drop' ? `Dropped lesson ${entry.record.id}: it is never given to a step again.`
      : action === 'keep' ? `Kept lesson ${done.result.record.id}: a person confirmed it, so it comes first.`
        : GUIDANCE.has(action) ? `Lesson ${done.result.record.id} is team guidance now: it comes first for every step on its files, and reaches the team with this change.`
        : `Edited lesson ${entry.record.id}; it is ${done.result.record.id} now, in your words.`;
    return { schemaVersion: 1, resultType: 'sflow-lessons-change', action, lesson: entry.record.id, now: done.result.record.id, committed: Boolean(committedAs), words };
  }
  if (action !== 'list') {
    throw new SingularityFlowError(`Unknown lessons subcommand '${action}'.`, {
      code: 'UNKNOWN_SUBCOMMAND', details: { command: 'lessons', subcommand: action, available: ['list', ...WRITES] }
    });
  }
  const { entries, warnings } = await lessons.readAllLessons(root);
  const wantedPath = optionString(options, 'path');
  const story = optionString(options, 'story');
  let active = lessons.activeLessons(entries).filter(lessons.isLesson);
  if (wantedPath) {
    const folder = (value) => `${value.replace(/\/$/u, '')}/`;
    active = active.filter((entry) => {
      const paths = entry.record.scope?.paths ?? [];
      return !paths.length || paths.some((item) => item === wantedPath || wantedPath.startsWith(folder(item)) || item.startsWith(folder(wantedPath)));
    });
  }
  if (story) active = active.filter((entry) => entry.record.lesson?.origin?.workId === story);
  let stale = new Set();
  try { stale = lessons.staleLessons(root, active); } catch { stale = new Set(); }
  const shown = active.map((entry) => ({ ...lessonView(entry, stale), from: lessons.lessonOrigin(entry.record) }))
    .sort((left, right) => Number(right.trust === 'rule') - Number(left.trust === 'rule') || Number(right.pinned) - Number(left.pinned)
      || String(right.createdAt).localeCompare(String(left.createdAt)));
  return {
    schemaVersion: 1, resultType: 'sflow-lessons', path: wantedPath ?? null, story: story ?? null, warnings,
    words: 'What earlier Stories learned in this repository. Each step is given the ones for the files it touches, as guidance only.',
    lessons: shown
  };
}

function printResult(result) {
  if (result.resultType === 'sflow-lessons-change') { console.log(result.words); return; }
  for (const warning of result.warnings ?? []) console.error(`Warning: ${warning}`);
  console.log(result.words);
  if (!result.lessons.length) {
    console.log(`\nNo lessons${result.path ? ` for ${result.path}` : ''}${result.story ? ` from ${result.story}` : ''} yet. A Story leaves them when its steps are approved.`);
    return;
  }
  for (const lesson of result.lessons) {
    const marks = [lesson.trust === 'rule' ? 'team guidance' : lesson.pinned ? 'pinned' : null, lesson.trust === 'confirmed' ? 'confirmed' : lesson.trust === 'agent' ? "the agent's words" : null,
      lesson.mayBeOutOfDate ? 'may be out of date' : null].filter(Boolean);
    console.log(`\n${lesson.id}  ${lesson.text}`);
    console.log(`  from ${lesson.from}${lesson.paths.length ? ` · ${lesson.paths.slice(0, 3).join(', ')}${lesson.paths.length > 3 ? ' …' : ''}` : ''}${marks.length ? ` · ${marks.join(' · ')}` : ''}`);
  }
  console.log('\nDrop one with singularity-flow lessons drop <K-ID>; keep one with lessons keep <K-ID>; make one team guidance with lessons guidance <K-ID>.');
}

export async function run(_argv, { positionals = ['lessons'], options = {} } = {}) {
  const result = await lessonsCommand(positionals, options);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  return result;
}

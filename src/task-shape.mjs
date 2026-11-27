/**
 * A task's shape, small or big, decided with its requirement [ITW:REQ-103, REQ-105, REQ-106,
 * docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md].
 *
 * A sized code task starts with its requirement and one step that implements and tests (task-composition.mjs). When the
 * requirement is submitted, Copilot's proposal ("Size: small change" or "Size: big change") is read from it and checked
 * against facts SFlow computes itself, the same way every time: the files the requirement names that are in the
 * repository (or would be new beside files that are), tests apart; their areas; a data change or a public interface (the
 * files REQ-014 reads); and a team `paths` rule that plans what those files are. SFlow only ever overrules towards big.
 * A big change gains its spec, design (for UI or architecture work), plan and tests steps then, after the requirement that
 * waits for its approval, one task change each (task-amendment.mjs addTaskStep with `shape`); the approval's question
 * says the shape, so the person's one Yes approves the requirement and confirms it.
 *
 * The same facts, read from the files the code changed, grow a small change whose code turns out bigger (REQ-106):
 * addRuleStepsAfterCode in task-amendment.mjs.
 *
 * shapeFacts and taskApprovalQuestion are pure; the rest reads the Story and its checkout.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { checkTaskRules, isBigShape, isSized, pathMatches, SIZED_KINDS, taskShape } from './task-composition.mjs';

/** What a small change may touch [ITW:REQ-103; open question 1, default]: application files and areas, tests apart. */
export const SMALL_LIMITS = Object.freeze({ files: 5, areas: 2 });

// A path as a requirement writes it: folders and a file with an extension (`src/value.mjs`, `db/migrations/1.sql`).
const PATH_TOKEN = /(?<![\w/.:-])((?:[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*\/)*[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?![\w/-])/gu;
// UI work: a file a screen is made of, or one in a folder of screens and components.
const UI_FILE = /\.(?:tsx|jsx|vue|svelte|html?|css|scss|sass|less)$/iu;
const UI_FOLDER = /(?:^|\/)(?:components?|pages|screens|views|layouts|ui|widgets)\//iu;
// What a team's rule plans: a step before the code, or the plan a person approves.
const PLANNING = new Set(['requirements', 'design', 'plan']);

/** The area of a file: its first two folders (`src/auth`), or the repository's top for a file there. */
export const areaOf = (file) => String(file).split('/').slice(0, -1).slice(0, 2).join('/') || '.';

/**
 * The size Copilot proposes in a requirement: "Size: small change" (or big) on a line of its own, else the first "small
 * change" or "big change" under a heading named Size. Null when it says neither.
 */
export function proposedSize(text) {
  const lines = String(text ?? '').split(/\r?\n/u);
  for (const line of lines) {
    const named = /^\s*(?:[-*]\s+)?(?:\*\*)?size(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(small|big)\b/iu.exec(line);
    if (named) return named[1].toLowerCase();
  }
  const at = lines.findIndex((line) => /^#{1,4}\s+(?:the\s+)?size\b/iu.test(line));
  if (at < 0) return null;
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,4}\s/u.test(line)) break;
    const said = /\b(small|big)\s+change\b/iu.exec(line);
    if (said) return said[1].toLowerCase();
  }
  return null;
}

/**
 * The files a requirement names that this repository has, or would have beside files it has (a new file in a folder that
 * exists), in the order of their first mention. `exists(relative)` says whether a file or folder is there. A path into
 * SFlow's own Story records is never the change's.
 */
export function namedFiles(text, exists) {
  const found = [];
  for (const match of String(text ?? '').matchAll(PATH_TOKEN)) {
    const file = match[1].replace(/^\.\//u, '');
    if (found.includes(file) || file.startsWith('singularity/') || file.startsWith('.git/') || /^\d+(?:\.\d+)+$/u.test(file)) continue;
    const folder = path.posix.dirname(file);
    if (exists(file) || (folder !== '.' && exists(folder))) found.push(file);
  }
  return found;
}

/**
 * The facts a shape is decided by [ITW:REQ-103]: `files` (application files, tests apart), `areas`, `growth` (a data change
 * or a public interface, task-amendment.mjs taskGrowth), `ruled` (the team's `paths` rules that plan these files), `ui` and
 * `newAreas` (what a design is for), Copilot's `proposed` size, and the decision: `shape` ('small' or 'big'), `reasons`
 * (each in a person's words) and `design` (a big change's design step). Pure.
 */
export function shapeFacts({ files = [], proposed = null, rules = null, kind = 'change', isTest = () => false, growthOf = () => null, newFolder = () => false } = {}) {
  const own = [...new Set(files.map(String))].filter((file) => !isTest(file)).sort();
  const areas = [...new Set(own.map(areaOf))].sort();
  const growth = growthOf(own);
  const applies = (rule) => rule.kinds.includes('all') || rule.kinds.includes(kind);
  const ruled = (rules?.paths ?? []).filter((rule) => applies(rule) && own.some((file) => rule.paths.some((glob) => pathMatches(glob, file)))
    && (rule.steps.some((intent) => PLANNING.has(intent)) || rule.personApproves.includes('plan'))).map((rule) => ({ rule: rule.name ?? null, because: rule.because }));
  const ui = own.filter((file) => UI_FILE.test(file) || UI_FOLDER.test(file));
  const newAreas = [...new Set(own.filter(newFolder).map(areaOf))].sort();
  const reasons = [];
  if (proposed === 'big') reasons.push('Copilot proposes a big change');
  const over = [own.length > SMALL_LIMITS.files ? `${own.length} files` : null, areas.length > SMALL_LIMITS.areas ? `${areas.length} areas` : null].filter(Boolean);
  if (over.length) reasons.push(`it names ${over.join(' in ')}, more than a small change's ${SMALL_LIMITS.files} files in ${SMALL_LIMITS.areas} areas`);
  if (growth) reasons.push(`it changes ${growth.what}`);
  for (const entry of ruled) reasons.push(`the team's rule: ${entry.because.replace(/[.\s]+$/u, '')}`);
  const shape = reasons.length ? 'big' : 'small';
  return { files: own, areas, growth: growth ? { reasons: growth.reasons, files: growth.files, what: growth.what } : null, ruled, ui, newAreas,
    proposed, shape, overruled: shape === 'big' && proposed !== 'big', reasons,
    design: shape === 'big' && Boolean(ui.length || newAreas.length || growth?.reasons.includes('interface')) };
}

const list = (items) => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** What comes after a sized task's requirement, in plan words: "implement and test", "spec, plan, code and tests". */
export function nextWords(composition) {
  const words = { requirements: 'spec', design: 'design', plan: 'plan', code: isBigShape(composition) ? 'code' : 'implement and test', test: 'tests', review: 'review' };
  return list(composition.steps.filter((step) => step.intent !== 'intake').map((step) => words[step.intent] ?? String(step.label ?? step.id).toLowerCase()));
}

/**
 * The question a person answers at a sized task's requirement [ITW:REQ-103]: "Approve the requirement v1 · Small change:
 * implement and test next?", or "… · Big change: spec, plan, code and tests next (it names 7 files in 3 areas)?". Null for
 * any other step or Story, which keep their own question. Pure.
 */
export function taskApprovalQuestion(workflow, phase) {
  const composition = workflow?.resolution?.composition ?? null;
  if (!isSized(composition) || !SIZED_KINDS.includes(composition.kind) || !phase) return null;
  const step = (composition.steps ?? []).find((entry) => entry.id === phase.id);
  if (step?.intent !== 'intake') return null;
  const shape = taskShape(composition);
  const why = (composition.changes ?? []).find((entry) => entry?.shape === 'big' && entry.because)?.because?.replace(/[.\s]+$/u, '') ?? null;
  return `Approve the requirement v${Number(phase.generation) || 0} · ${shape === 'big' ? 'Big' : 'Small'} change: ${nextWords(composition)} next${why ? ` (${why})` : ''}?`;
}

/**
 * What SFlow asks of a sized task's steps, in its intake beside the person's words [ITW:REQ-102, REQ-109]: the requirement's
 * clauses, analysis and size for a code task; the follow-ups for an analysis. Null for any other composition.
 */
export function taskIntakeGuidance(composition) {
  if (!isSized(composition)) return null;
  if (!SIZED_KINDS.includes(composition.kind)) {
    return ['## How SFlow runs this task', '',
      'This is an analysis: SFlow approves the requirement and the report when they are clean, and nobody is asked to.',
      'End the report with a "## Follow-ups" section: one numbered item for each finding that could be its own Story, its',
      'title on the first line and its details after it.'].join('\n');
  }
  return ['## How SFlow sizes this task', '',
    'Write the requirement as numbered clauses, each with how it will be tested. Then an analysis: the files and areas it',
    'likely touches (name each file by its path), any data or schema change, any public interface change, and the risk. End',
    'with one line, "Size: small change" or "Size: big change", and why.',
    `SFlow checks it against the files the requirement names (a small change touches at most ${SMALL_LIMITS.files} files in at most ${SMALL_LIMITS.areas} areas, with no`,
    'data or public interface change) and may make it big. The person confirms with the requirement\'s approval: a small change',
    'is then implemented and tested in one step, a big one gets a spec, a plan, the code and its tests.'].join('\n');
}

/** Whether `relative` exists in the checkout at `root`. */
function existsIn(root) {
  return (relative) => {
    try { return existsSync(path.join(root, relative)); } catch { return false; }
  };
}

/** A named file whose folder does not exist yet: a new module or service [ITW:REQ-105]. */
function newFolderIn(root) {
  return (relative) => {
    const folder = path.posix.dirname(relative);
    if (folder === '.') return false;
    try { return !statSync(path.join(root, folder)).isDirectory(); } catch { return true; }
  };
}

/** The facts for files a requirement names or a code step changed, read against the checkout at `root`. */
export async function shapeFactsFor(root, definition, { kind, files, proposed = null }) {
  const [{ taskGrowth }, { isAllowedTestAutomationPath }, { MIGRATION_PATH }] = await Promise.all([
    import('./task-amendment.mjs'), import('./code-delivery-tests.mjs'), import('./application-paths.mjs')]);
  return shapeFacts({ files, proposed, kind, rules: checkTaskRules(definition).rules, isTest: isAllowedTestAutomationPath,
    growthOf: (own) => taskGrowth(own, { isTest: isAllowedTestAutomationPath, migration: MIGRATION_PATH }), newFolder: newFolderIn(root) });
}

/** The requirement a sized task's intake wrote, as submitted: its text, or null. */
function requirementText(root, config, workflow, phaseId) {
  const relative = workflow.phases?.[phaseId]?.requiredArtifact?.path;
  if (!relative) return null;
  return (async () => {
    const { storyLocation } = await import('./story-paths.mjs');
    try { return readFileSync(storyLocation(root, config, workflow.workItem.id).file(relative), 'utf8'); } catch { return null; }
  })();
}

/**
 * After a sized task's requirement is submitted [ITW:REQ-103]: its shape is decided, and a big change gains its steps
 * (spec, design when its analysis finds UI or architecture work, plan, tests), each after the requirement, which waits for
 * its approval. Returns `{ shape, facts, lines, added }`, or null when nothing applies (another step, another Story, a
 * shape already big). A step that cannot be added is a line that says why; the requirement keeps its approval.
 */
export async function decideShapeAfterRequirement(root, workId, phaseId, { force = null, by = 'sflow' } = {}) {
  const [{ loadAcceptedStoryExecution }, { loadConfig }] = await Promise.all([import('./accepted-story-execution.mjs'), import('./state-stores.mjs')]);
  const loaded = await loadAcceptedStoryExecution(root, workId);
  const composition = loaded.workflow.resolution?.composition ?? null;
  const step = composition?.steps?.find((entry) => entry.id === phaseId);
  if (!isSized(composition) || !SIZED_KINDS.includes(composition.kind) || step?.intent !== 'intake' || isBigShape(composition)) return null;
  if (loaded.workflow.currentPhase !== phaseId || loaded.workflow.phases?.[phaseId]?.status !== 'awaiting_approval') return null;
  const definition = await loadConfig(root);
  const text = await requirementText(root, loaded.config ?? definition, loaded.workflow, phaseId) ?? '';
  const files = [...new Set([...namedFiles(text, existsIn(root)), ...(composition.touchedPaths ?? [])])];
  const facts = await shapeFactsFor(root, definition, { kind: composition.kind, files, proposed: proposedSize(text) });
  const shape = force === 'big' ? 'big' : facts.shape;
  if (shape !== 'big') return { shape, facts, lines: [], added: [] };
  const reasons = force === 'big' && !facts.reasons.length ? ['the person asked for a big change'] : facts.reasons;
  const because = `${reasons[0][0].toUpperCase()}${reasons.join('; ').slice(1)}.`;
  return growToBig(root, workId, { definition, because, design: facts.design, facts, by });
}

/**
 * Add the big shape's missing steps to a sized task, in order, after its current step [ITW:REQ-105, REQ-106]: the spec and
 * design (only while the current step is the requirement), the plan and the tests. One task change each; a refusal stops
 * there and says why.
 */
export async function growToBig(root, workId, { definition, because, design = false, facts = null, intents = null, by = 'sflow' } = {}) {
  const [{ loadAcceptedStoryExecution }, { addTaskStep }] = await Promise.all([import('./accepted-story-execution.mjs'), import('./task-amendment.mjs')]);
  // The plan first: it is the code's plan from then on, so the requirement stays the person's (personKeeps) and the spec and
  // design, added before it, are SFlow's to approve when clean [ITW:REQ-105].
  const wanted = intents ?? ['plan', 'requirements', ...(design ? ['design'] : []), 'test'];
  const lines = [];
  const added = [];
  for (const intent of wanted) {
    const current = await loadAcceptedStoryExecution(root, workId);
    if ((current.workflow.resolution?.composition?.steps ?? []).some((entry) => entry.intent === intent)) continue;
    try {
      const result = await addTaskStep(root, current.config ?? current.definition, current.workflow, { intent, definition, shape: { because } });
      added.push({ id: result.added.id, intent, changeId: result.changeId, approvedBy: result.added.approvedBy });
    } catch (error) {
      if (error?.code !== 'TASK_CHANGE_REFUSED') throw error;
      lines.push(`SFlow could not add the ${intent === 'requirements' ? 'spec' : intent} step of a big change: ${error.message}`);
      break;
    }
  }
  if (added.length) lines.unshift(`Big change: ${because.replace(/\.$/u, '')}. ${by === 'person' ? 'You asked for it' : 'SFlow made it big'}; ${list(added.map((entry) => entry.intent === 'requirements' ? 'a spec' : entry.intent === 'test' ? 'a tests step' : `a ${entry.intent}`))} ${added.length > 1 ? 'were' : 'was'} added.`);
  return { shape: 'big', facts, lines, added };
}

/**
 * Noticing a step's lessons when it ends [LRN:REQ-001, REQ-002, REQ-003, REQ-006, REQ-011, REQ-012, REQ-013].
 *
 * Runs inside the Story transaction that approves a step (by a person or automatically), after the approval is recorded
 * and before the Story is saved, so the lessons are committed with the approval. Reads only the step's own records, with
 * no model; never throws (story-publication-service.mjs catches), so a lesson that cannot be kept never costs an approval.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { departureStatus } from './departures.mjs';
import { head } from './git-execution.mjs';
import { recordSha256 } from './records.mjs';
import { storyRefusals } from './lesson-refusals.mjs';
import { KNOWLEDGE_ROOT, readKnowledgeWithDiagnostics, recordKnowledge } from './knowledge.mjs';
import { agentLessonLines, givenLessons, lessonSecretFindings, lessonsLocalDirectory, mirrorLesson, stepIntent } from './story-lessons.mjs';
import { workDirRelative } from './story-paths.mjs';
import { stepAttempts } from './verification/attempts.mjs';

const PATHS_PER_LESSON = 6;
const REFUSALS_BEFORE_A_LESSON = 2;

function clip(text, limit = 200) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function folderOf(file) {
  const directory = path.posix.dirname(String(file));
  return directory === '.' ? String(file) : directory;
}

/** The files a step changed, source first. */
function changedFiles(phase) {
  const delivery = phase?.deliveryEvidence ?? {};
  return unique([...(delivery.sourcePaths ?? []), ...(delivery.testPaths ?? []), ...(delivery.configurationPaths ?? [])].map(String));
}

function sourceOf(workId, phase, artifact, value) {
  return { kind: 'story-record', workId, phase, artifact, sha256: recordSha256(value ?? null) };
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

// ---- What each kind of record teaches -----------------------------------------------------------------------------

/** A test run that stopped on its environment, then passed: what the environment needs first. */
async function environmentLessons(root, config, workflow, phase, intent) {
  const workId = workflow.workItem.id;
  let attempts = [];
  try { attempts = await stepAttempts(root, workDirRelative(config, workId), workId, phase.id); } catch { return []; }
  const commandText = (id) => (phase.checks ?? []).find((check) => check?.id === id)?.command ?? id;
  const files = changedFiles(phase);
  const found = [];
  const seen = new Set();
  attempts.forEach((attempt, index) => {
    if (!['failed', 'blocked', 'unavailable'].includes(attempt?.status) || attempt.cause?.category !== 'environment') return;
    const passed = attempts.slice(index + 1).some((later) => later?.commandId === attempt.commandId && later.status === 'passed');
    if (!passed) return;
    const what = clip(String(attempt.cause.class ?? 'its environment').replace(/[-_]/gu, ' '), 80);
    const signature = `environment:${attempt.commandId}:${attempt.cause.class ?? 'environment'}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    found.push({
      type: 'constraint', kind: 'environment', signature,
      text: `Tests run with \`${clip(commandText(attempt.commandId), 120)}\` stopped on ${what} before they passed. Set that up first.`,
      paths: files.length ? unique(files.map(folderOf)).slice(0, PATHS_PER_LESSON) : [],
      steps: unique([intent, 'test']),
      source: sourceOf(workId, phase.id, `test attempt ${attempt.attemptId}`, attempt)
    });
  });
  return found;
}

/** A step's test command that a person changed, and why. */
async function testCommandLessons(root, workflow, phase, intent) {
  const workId = workflow.workItem.id;
  const files = changedFiles(phase);
  const found = [];
  for (const summary of workflow.testCommandAmendments ?? []) {
    if (summary?.phaseId !== phase.id || summary.status !== 'approved') continue;
    const decision = summary.decisionPath ? await readJson(path.join(root, summary.decisionPath)) : null;
    const reason = clip(decision?.reason ?? decision?.decision?.reason ?? '', 200);
    if (!reason) continue;
    found.push({
      type: 'insight', kind: 'test-command', signature: `test-command:${unique(files.map(folderOf))[0] ?? phase.id}`,
      text: `The test command for this work was changed: ${reason}`,
      paths: unique(files.map(folderOf)).slice(0, PATHS_PER_LESSON), steps: unique([intent, 'test']),
      source: sourceOf(workId, phase.id, `test command amendment ${summary.id}`, summary)
    });
  }
  return found;
}

/** The same refusal came back two or more times in the step, which then ended: the refusal and the way on. */
async function refusalLessons(root, workflow, phase, intent) {
  const workId = workflow.workItem.id;
  const byCode = new Map();
  for (const refusal of await storyRefusals(root, workId)) {
    if (refusal?.phase !== phase.id || !refusal.code) continue;
    const list = byCode.get(refusal.code) ?? [];
    list.push(refusal);
    byCode.set(refusal.code, list);
  }
  const found = [];
  for (const [code, list] of byCode) {
    if (list.length < REFUSALS_BEFORE_A_LESSON) continue;
    const last = list.at(-1);
    const way = list.map((refusal) => refusal.way).filter(Boolean).at(-1);
    found.push({
      type: 'gotcha', kind: 'refusal', signature: `refusal:${code}:${intent ?? phase.id}`,
      text: `"${clip(last.words, 160)}" came up ${list.length} times in a ${intent ?? phase.id} step.${way ? ` What moves it on: ${clip(way, 140)}` : ''}`,
      paths: [], steps: [intent ?? phase.id],
      source: sourceOf(workId, phase.id, `refusals ${code}`, list)
    });
  }
  return found;
}

async function reviewGenerations(root, config, workflow, phaseId) {
  const directory = path.join(root, workDirRelative(config, workflow.workItem.id), 'context', 'reviews', phaseId);
  let names = [];
  try { names = await readdir(directory); } catch { return []; }
  const generations = [];
  for (const name of names) {
    const match = /^gen-(\d+)$/u.exec(name);
    if (!match) continue;
    const reports = [];
    let files = [];
    try { files = await readdir(path.join(directory, name)); } catch { files = []; }
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
      const record = await readJson(path.join(directory, name, file));
      if (record?.report) reports.push(record);
    }
    const disputes = [];
    try {
      for (const report of await readdir(path.join(directory, name, 'decisions'))) {
        for (const file of await readdir(path.join(directory, name, 'decisions', report))) {
          const record = await readJson(path.join(directory, name, 'decisions', report, file));
          if (String(record?.id ?? '').startsWith('dispute:') && record.decision === 'accepted') disputes.push(record);
        }
      }
    } catch { /* none */ }
    reports.sort((left, right) => String(left.submittedAt ?? '').localeCompare(String(right.submittedAt ?? '')));
    generations.push({ generation: Number(match[1]), reports, disputes });
  }
  return generations.sort((left, right) => left.generation - right.generation);
}

function findingPath(report, finding) {
  return (report?.binding?.sources ?? []).find((source) => source?.id === finding?.sourceId)?.path ?? null;
}

/** A reviewer's blocking finding that the next version no longer had: what reviewers flag in these files. */
async function reviewLessons(root, config, workflow, phase, intent) {
  const workId = workflow.workItem.id;
  const generations = await reviewGenerations(root, config, workflow, phase.id);
  const found = [];
  const seen = new Set();
  const reports = generations.flatMap((entry) => entry.reports.map((record) => ({ generation: entry.generation, record })));
  reports.forEach(({ record }, index) => {
    const later = reports[index + 1]?.record;
    if (!later) return;
    const still = new Set((later.report.findings ?? []).map((finding) => `${finding.check}\u0000${clip(finding.message, 120)}`));
    for (const finding of record.report.findings ?? []) {
      if (finding?.severity !== 'blocking' || still.has(`${finding.check}\u0000${clip(finding.message, 120)}`)) continue;
      const file = findingPath(record.report, finding);
      const signature = `finding:${finding.check ?? 'review'}:${file ?? phase.id}:${clip(finding.message, 60).toLowerCase()}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      found.push({
        type: 'gotcha', kind: 'finding', signature,
        text: `Reviewers flagged${file ? ` in ${file}` : ''}: ${clip(finding.message, 200)}`,
        paths: file ? [file] : [], steps: unique([intent, 'review']),
        source: sourceOf(workId, phase.id, `review finding ${finding.id ?? ''}`.trim(), finding)
      });
    }
  });
  for (const { disputes } of generations) {
    for (const dispute of disputes) {
      const file = dispute.finding?.path ?? null;
      const reason = clip(dispute.reason, 200);
      if (!reason) continue;
      found.push({
        type: 'constraint', kind: 'override', signature: `dispute:${clip(dispute.finding?.message, 60).toLowerCase()}:${file ?? phase.id}`,
        text: `A person settled that "${clip(dispute.finding?.message, 120)}" does not apply${file ? ` to ${file}` : ''}: ${reason}`,
        paths: file ? [file] : [], steps: unique([intent, 'review']),
        source: sourceOf(workId, phase.id, `review dispute ${dispute.id}`, dispute)
      });
    }
  }
  return found;
}

/** A check a person overrode in this step: the check is wrong about these files, and why. */
function overrideLessons(workflow, phase, intent) {
  const workId = workflow.workItem.id;
  return (workflow.findingOverrides ?? []).filter((entry) => entry?.phase === phase.id && !entry.withdrawnAt && entry.reason).map((entry) => ({
    type: 'constraint', kind: 'override', signature: `override:${entry.code ?? entry.finding}:${entry.path ?? phase.id}`,
    text: `The ${entry.code ?? 'check'} finding${entry.path ? ` on ${entry.path}` : ''} was overridden by a person: ${clip(entry.reason, 200)}`,
    paths: entry.path ? [String(entry.path)] : [], steps: unique([intent, 'review']),
    source: sourceOf(workId, phase.id, `finding override ${entry.id}`, entry)
  }));
}

/** Failing tests that sent the work back to this step: which test broke, and the files the fix changed. */
function failingTestLessons(workflow, phase, intent) {
  const workId = workflow.workItem.id;
  const fix = changedFiles(phase).slice(0, PATHS_PER_LESSON);
  const found = [];
  for (const request of workflow.changeRequests ?? []) {
    if (request?.targetPhase !== phase.id || request.automatic?.kind !== 'failing-tests') continue;
    for (const test of (request.automatic.tests ?? []).slice(0, 3)) {
      const name = clip(test?.name ?? test?.command ?? 'a test', 100);
      const file = test?.file ? String(test.file) : null;
      found.push({
        type: 'gotcha', kind: 'failing-test', signature: `failing-test:${file ?? ''}#${name}`,
        text: `Test "${name}"${file ? ` (${file})` : ''} failed and sent the work back${fix.length ? `; the fix changed ${fix.slice(0, 3).join(', ')}` : ''}.`,
        paths: unique([...(file ? [file] : []), ...fix]).slice(0, PATHS_PER_LESSON), steps: unique([intent, 'code']),
        source: sourceOf(workId, phase.id, `change request ${request.id}`, request)
      });
    }
  }
  return found;
}

/** A file outside the plan that the work needed: changing one file usually needs another. */
function couplingLessons(workflow, phase, intent) {
  const workId = workflow.workItem.id;
  const files = changedFiles(phase);
  const found = [];
  for (const departure of workflow.departures ?? []) {
    if (departure?.phase !== phase.id || !['path', 'supporting'].includes(departure.kind)) continue;
    let status = null;
    try { status = departureStatus(workflow, departure).status; } catch { status = null; }
    if (status !== 'accepted') continue;
    const outside = unique((departure.paths ?? []).map(String));
    const planned = files.filter((file) => !outside.includes(file)).slice(0, 3);
    for (const extra of outside.slice(0, 2)) {
      found.push({
        type: 'insight', kind: 'coupling', signature: `coupling:${extra}`,
        text: planned.length ? `Changing ${planned.join(', ')} also needed ${extra}, which the plan did not name.` : `This kind of change also needed ${extra}, which the plan did not name.`,
        paths: unique([...planned, extra]).slice(0, PATHS_PER_LESSON), steps: unique([intent, 'plan', 'code']),
        source: sourceOf(workId, phase.id, `departure ${departure.id}`, departure)
      });
    }
  }
  return found;
}

/** The agent's own `Learnings to carry forward` from the step's approved documents [LRN:REQ-002]. */
async function agentLessons(root, config, workflow, phase, intent) {
  const workId = workflow.workItem.id;
  const files = changedFiles(phase);
  const found = [];
  for (const artifact of phase.artifacts ?? []) {
    const relative = String(artifact?.path ?? '');
    if (!relative.endsWith('.md') || !/^[a-f0-9]{64}$/u.test(String(artifact.sha256 ?? ''))) continue;
    const base = workDirRelative(config, workId);
    const absolute = path.join(root, relative.startsWith(`${base}/`) ? relative : path.posix.join(base, relative));
    let text = '';
    try { text = await readFile(absolute, 'utf8'); } catch { continue; }
    for (const line of agentLessonLines(text)) {
      found.push({
        type: line.type, kind: 'agent', trust: 'agent', signature: `agent:${clip(line.text, 80).toLowerCase()}`,
        text: line.text, paths: unique(files.map(folderOf)).slice(0, PATHS_PER_LESSON), steps: intent ? [intent] : [],
        source: { workId, artifact: relative, sha256: artifact.sha256, approvedRevision: Number(phase.generation ?? 0) }
      });
    }
  }
  return found;
}

// ---- Keeping them -------------------------------------------------------------------------------------------------

function headCommit(root) {
  try {
    const value = String(head(root) ?? '').trim();
    return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value) ? value : null;
  } catch { return null; }
}

async function noteRepeat(root, workId, phase, entry) {
  try {
    const file = path.join(lessonsLocalDirectory(root), 'repeats', `${encodeURIComponent(workId)}.json`);
    const earlier = await readJson(file) ?? { workId, repeats: [] };
    earlier.repeats.push({ phase, lesson: entry.record.id, text: entry.record.text, at: new Date().toISOString() });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(earlier)}\n`);
  } catch { /* a count, never the work */ }
}

/**
 * Notice, keep and count a step's lessons. Returns what was kept, what repeated and what could not be kept.
 * `writeFiles: false` answers without writing (tests and previews).
 */
export async function noticeStepLessons(root, config, workflow, phaseId, { writeFiles = true } = {}) {
  const phase = workflow?.phases?.[phaseId];
  if (!phase || !workflow.workItem?.id) return { kept: [], repeated: [], refused: [], warnings: [] };
  const workId = workflow.workItem.id;
  const intent = stepIntent(workflow, phaseId);
  const candidates = [
    ...await environmentLessons(root, config, workflow, phase, intent),
    ...await testCommandLessons(root, workflow, phase, intent),
    ...await refusalLessons(root, workflow, phase, intent),
    ...await reviewLessons(root, config, workflow, phase, intent),
    ...overrideLessons(workflow, phase, intent),
    ...failingTestLessons(workflow, phase, intent),
    ...couplingLessons(workflow, phase, intent),
    ...await agentLessons(root, config, workflow, phase, intent)
  ];
  let entries = [];
  const warnings = [];
  try { const all = await (await import('./story-lessons.mjs')).readAllLessons(root); entries = all.entries; warnings.push(...all.warnings); }
  catch (error) { warnings.push(`Earlier lessons could not be read: ${clip(error?.message, 160)}`); }
  const superseded = new Set(entries.map(({ record }) => record.supersedes).filter(Boolean));
  const bySignature = new Map();
  for (const entry of entries) {
    const signature = entry.record.lesson?.signature;
    if (!signature) continue;
    const list = bySignature.get(signature) ?? [];
    list.push(entry);
    bySignature.set(signature, list);
  }
  const given = new Set(await givenLessons(root, workId, phaseId));
  const at = headCommit(root);
  const kept = []; const repeated = []; const refused = [];
  const handled = new Set();
  for (const candidate of candidates) {
    if (handled.has(candidate.signature)) continue;
    handled.add(candidate.signature);
    const secrets = lessonSecretFindings(candidate.text);
    // Never the words: they hold the value [LRN:REQ-013].
    if (secrets.length) { refused.push({ kind: candidate.kind, reason: `it holds ${secrets[0].label}` }); continue; }
    const earlier = bySignature.get(candidate.signature) ?? [];
    const current = earlier.find((entry) => !superseded.has(entry.sha256) && entry.record.status === 'active');
    const lesson = {
      kind: candidate.kind, trust: candidate.trust ?? 'noticed', signature: candidate.signature,
      origin: { workId, phase: phaseId }, at, repeats: 0, pinned: false
    };
    const input = {
      type: candidate.type, text: candidate.text, provenance: [candidate.source],
      scope: { ...(candidate.paths.length ? { paths: candidate.paths } : {}), ...(candidate.steps.length ? { steps: candidate.steps } : {}) },
      approvedSourceVerified: true, lesson
    };
    if (!input.scope.paths && !input.scope.steps) continue;
    let action = null;
    if (current && given.has(current.sha256)) {
      // The same mistake, with its lesson in the step's prompt: a repeat [LRN:REQ-012]. Twice, and it is pinned.
      const repeats = Number(current.record.lesson.repeats ?? 0) + 1;
      action = { kind: 'repeat', input: {
        type: current.record.type, text: current.record.text, provenance: current.record.provenance, scope: current.record.scope,
        status: 'active', supersedes: current.sha256, approvedSourceVerified: true,
        lesson: { ...current.record.lesson, repeats, pinned: current.record.lesson.pinned === true || repeats >= 2 }
      }, entry: current };
    } else if (current && ['environment', 'test-command'].includes(candidate.kind) && current.record.text !== candidate.text) {
      // A newer run says otherwise: the new lesson replaces the old [LRN:REQ-011].
      action = { kind: 'replace', input: { ...input, supersedes: current.sha256 } };
    } else if (earlier.length) {
      continue; // Known already, kept or dropped: never kept twice [LRN:REQ-004].
    } else action = { kind: 'keep', input };
    if (!writeFiles) { (action.kind === 'repeat' ? repeated : kept).push({ text: action.input.text, kind: candidate.kind }); continue; }
    try {
      const result = await recordKnowledge(root, action.input);
      await mirrorLesson(root, result);
      if (action.kind === 'repeat') { repeated.push(result); await noteRepeat(root, workId, phaseId, action.entry); }
      else if (result.created) kept.push(result);
    } catch (error) {
      refused.push({ kind: candidate.kind, reason: clip(error?.message, 160) });
    }
  }
  return { kept, repeated, refused, warnings, paths: kept.length || repeated.length ? [`${KNOWLEDGE_ROOT}/records`] : [] };
}

/** The lessons a step kept, for what a person reads after its approval. */
export async function lessonsKeptBy(root, workId, phaseId) {
  try {
    const { entries } = await readKnowledgeWithDiagnostics(root);
    const superseded = new Set(entries.map(({ record }) => record.supersedes).filter(Boolean));
    return entries.filter((entry) => !superseded.has(entry.sha256) && entry.record.status === 'active'
      && entry.record.lesson?.origin?.workId === workId && entry.record.lesson.origin.phase === phaseId);
  } catch { return []; }
}

/**
 * What a person reads after a step's approval [LRN:REQ-003, REQ-004]: one line, never a question, with how to drop one.
 * Null when the step kept none.
 */
export async function lessonsAfterApproval(root, workId, phaseId) {
  const kept = await lessonsKeptBy(root, workId, phaseId);
  if (!kept.length) return null;
  const listed = kept.map((entry, index) => ({ number: index + 1, id: entry.record.id, text: entry.record.text }));
  return {
    lessons: listed,
    line: `SFlow kept ${kept.length} lesson${kept.length === 1 ? '' : 's'} from this step: ${listed.slice(0, 5).map((entry) => `${entry.number}. ${clip(entry.text, 90)}`).join(' · ')}${kept.length > 5 ? ' · …' : ''}. `
      + 'Drop any you don\'t want: singularity-flow lessons drop <K-ID> (singularity-flow lessons lists them).'
  };
}

/** How a Story used lessons: the lessons its steps were given, and the earlier mistakes that happened again. */
export async function storyLessonsUse(root, workId) {
  const { storyGivenLessons } = await import('./story-lessons.mjs');
  const used = await storyGivenLessons(root, workId);
  const repeats = (await readJson(path.join(lessonsLocalDirectory(root), 'repeats', `${encodeURIComponent(workId)}.json`)))?.repeats ?? [];
  return { used: used.length, repeated: repeats.length, repeats };
}

/** The closing line of a Story [LRN:REQ-012]; null when it was given no lessons and repeated nothing. */
export function storyLessonsLine({ used, repeated }) {
  if (!used && !repeated) return null;
  const usedWords = `Used ${used} earlier lesson${used === 1 ? '' : 's'}.`;
  return repeated ? `${usedWords} ${repeated} earlier mistake${repeated === 1 ? '' : 's'} happened again although ${repeated === 1 ? 'its lesson was' : 'their lessons were'} in the step's prompt.`
    : `${usedWords} No earlier mistake happened again.`;
}

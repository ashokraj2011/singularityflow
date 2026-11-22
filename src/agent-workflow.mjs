/**
 * A marketplace agent as an SFlow workflow, with what each step is for [owner, 2026-11-21: "agent is like a workflow
 * ... sflow can use its tool to convert to workflow for sflow and inject the intents"].
 *
 * A marketplace agent's agent.md is an orchestrator: a role, a hard gate first ("STOP and WAIT" for the one answer the
 * run depends on), a table of the skill each step uses for each answer, numbered steps, rules and an output format.
 * - parseAgentDocument reads its stages in order from the numbered headings, skipping every heading inside fenced code
 *   (the Output Format sections hold `##` in code fences), with each stage's hard gate, questions and skills.
 * - convertAgent makes each stage a step. Its intent comes, in this order, from the pdlc-tasks of the skills it uses
 *   (AGENT_TASK_INTENTS), from a stage named like one of the agent's pdlc-tasks, and then from the step intents
 *   spec §6.1 rules on its name and words (step-intents.mjs inferStepIntents), with the agent's pdlc-phases as the
 *   agent signal (PDLC_PHASE_LEANS). A hard gate before the first stage becomes the person's questions at the first
 *   step; a later gate that only asks a person to approve or choose what the stage before it made becomes that step's
 *   person approval. A stage the rules cannot classify gets the one plain question (§6.3), never a guess, and
 *   `answers` (the person's choice, by step ID) settle it.
 * - A hard gate's choice the agent records under a name ("Record the answer as `channel`") is a Story value: a branch
 *   decision after the first step records the person's answer when that step is submitted (workflow-decisions.mjs),
 *   every route going on to the next step. Each skill the step-to-skill table ties to an answer says so in its
 *   "When to use it" (`when channel is web`), so a later step is given only the skill for the recorded answer
 *   (skill-library.mjs skillAppliesToStory), and the agent's own table of both answers' skill paths is replaced by that.
 * - workflowDefinition writes the version 4 workflow.yml pieces: every step with its intent and a `because:` for each
 *   setting it keeps against its intent's profile; Stage 2 derives every other setting (step-intent-settings.mjs).
 *
 * Pure: it reads only what it is given. agent-workflow-bundle.mjs lays the result out and compiles the bundle.
 */
import YAML from 'yaml';
import { STEP_INTENTS } from './phase-roles.mjs';
import { deriveWorkflowSettings } from './step-intent-settings.mjs';
import { inferStepIntents, intentWordScores } from './step-intents.mjs';
import { neededSteps, withNeededSteps } from './workflow-needs.mjs';
import { SingularityFlowError } from './util.mjs';

export const AGENT_WORKFLOW_RESULT = 'sflow-agent-workflow';

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const TESTS_ARE_CODE = 'it writes tests into the repository: tests are code, which a code step writes and a person approves; running them and recording the results is a test step';

/**
 * Each pdlc-task of the marketplace's taxonomy (registry/pdlc-taxonomy.yml) and the step intent it is, with why where
 * it is not plain from the task's own name. A skill's tasks, or a stage named like one of the agent's tasks, give the
 * stage this intent. docs/marketplace-agents.md prints this table.
 */
export const AGENT_TASK_INTENTS = deepFreeze({
  'problem-framing': { intent: 'intake', because: 'it states the problem, who has it and how success is measured: the request in the requester\'s own words' },
  'requirements-analysis': { intent: 'requirements' },
  'user-story-writing': { intent: 'requirements', because: 'stories split the requirements into testable pieces that later steps cite by ID' },
  'acceptance-criteria-writing': { intent: 'requirements' },
  'test-case-creation': { intent: 'requirements', because: 'a test design document: numbered test cases traced to the acceptance criteria, which later steps cite; nothing is run yet' },
  'architecture-discovery': { intent: 'design', because: 'it maps the system as it is before anything changes, and investigation is part of design' },
  'architecture-design': { intent: 'design' },
  'decision-records': { intent: 'document', because: 'an ADR is a decision record, the kind of document the document intent names' },
  'api-implementation': { intent: 'code' },
  'ui-implementation': { intent: 'code' },
  'unit-testing': { intent: 'code', because: TESTS_ARE_CODE },
  'contract-testing': { intent: 'code', because: TESTS_ARE_CODE },
  'e2e-testing': { intent: 'code', because: TESTS_ARE_CODE },
  'ui-test-automation': { intent: 'code', because: 'test automation is code: the step changes the repository\'s test sources' },
  'feature-toggle-management': { intent: 'code', because: 'adding, changing or removing a toggle changes the code' },
  documentation: { intent: 'document' },
  'static-analysis': { intent: 'test', because: 'it runs the repository\'s analyzers and records what they found, as a test step records results' },
  'accessibility-review': { intent: 'review', because: 'it judges the delivered UI change against WCAG 2.2 AA, after the code step' },
  'coding-standards-review': { intent: 'review' },
  'security-review': { intent: 'review' },
  'pr-review': { intent: 'review' },
  'release-notes': { intent: 'release' },
  changelog: { intent: 'release' },
  'pr-description': { intent: 'release' },
  'release-readiness': { intent: 'release' }
});

/**
 * The intents each pdlc-phase leans to: the agent signal of §6.1 for a marketplace agent, whose name says nothing.
 * Elaboration holds requirements, stories, acceptance criteria and test cases, and architecture and design too.
 */
export const PDLC_PHASE_LEANS = deepFreeze({
  discovery: ['intake', 'design'],
  elaboration: ['intake', 'requirements', 'design'],
  delivery: ['plan', 'code', 'test'],
  review: ['review', 'test'],
  release: ['release', 'report'],
  operations: ['code', 'report']
});

/** Each intent's main consequence, as the one plain question offers it (§6.3). */
export const INTENT_CHOICES = deepFreeze({
  intake: 'Captures the request in the requester\'s words (intake)',
  requirements: 'Writes numbered, testable requirements that later steps cite (requirements)',
  design: 'Works out how, or investigates what exists (design)',
  plan: 'Lists the exact changes and the tests; a person approves it (plan)',
  code: 'Changes the repository\'s code and tests; a person approves it (code)',
  test: 'Runs the tests and records the results (test: SFlow approves it when clean)',
  review: 'Checks the change against every requirement (review)',
  release: 'Prepares the change to leave the Story: PR text and release notes (release)',
  report: 'Writes a summary for people of what happened and what remains (report)',
  document: 'Something else: any other document (document)'
});

// A later gate whose title ends so only asks a person to approve or choose what the stage before it made.
const APPROVAL_GATE_WORDS = new Set(['review', 'approval', 'approve', 'confirmation', 'confirm', 'decision', 'signoff', 'sign-off']);
// Task words too common to tell one task from another on their own.
const GENERIC_TASK_WORDS = new Set(['review', 'writing', 'creation', 'management', 'testing', 'test', 'notes', 'records']);
const MAX = Object.freeze({ stages: 30, questions: 5, choices: 8, id: 64 });

function fail(message, code = 'AGENT_WORKFLOW_INVALID', details = undefined) {
  return new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

export const kebab = (value) => String(value ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
const words = (value) => String(value ?? '').toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
const oneLine = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
// "Hand-off" reads as handoff, "follow-up" as followup: the word lists hold the joined form.
const joinHyphenated = (value) => String(value ?? '').replace(/([A-Za-z])-([A-Za-z])/gu, '$1$2');
const sameStem = (left, right) => left === right || (Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left)))
  || (left.length >= 5 && right.length >= 5 && left.slice(0, 4) === right.slice(0, 4) && Math.abs(left.length - right.length) <= 3);

// ---------------------------------------------------------------------------------------------
// The document

/** The lines of `text` that are not in fenced code, each `{ text, index, fenced }`. */
function markLines(lines) {
  let fence = null;
  return lines.map((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return { text: line, index, fenced: true };
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) { fence = marker[1]; return { text: line, index, fenced: true }; }
    return { text: line, index, fenced: false };
  });
}

const prose = (lines) => lines.filter((line) => !line.fenced).map((line) => line.text);
const withoutCode = (text) => String(text).replace(/`[^`\n]*`/gu, ' ');

/** A markdown table's rows as cells: the header first, the separator dropped. */
function tableRows(lines) {
  const rows = [];
  for (const line of lines) {
    if (!/^\s*\|.*\|\s*$/u.test(line)) { if (rows.length) break; continue; }
    if (/^\s*\|?\s*:?-{3,}/u.test(line)) continue;
    rows.push(line.trim().replace(/^\||\|$/gu, '').split('|').map((cell) => cell.trim()));
  }
  return rows;
}

const skillsIn = (text) => [...String(text).matchAll(/\bskills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?/gu)].map((match) => match[1]);

/** The questions a hard gate asks: a quoted question with its numbered choices, numbered questions, or what it says to ask. */
function gateQuestions(lines, title) {
  const text = prose(lines);
  const quoted = text.filter((line) => /^\s*>/u.test(line)).map((line) => line.replace(/^\s*>\s?/u, '').trim());
  const choices = quoted.map((line) => /^\d+[.)]\s+(.+)$/u.exec(line)?.[1]).filter(Boolean)
    .map((choice) => oneLine(withoutCode(choice).replace(/\.$/u, ''))).filter(Boolean).slice(0, MAX.choices);
  const asked = quoted.filter((line) => line && !/^\d+[.)]\s/u.test(line))
    .map((line, index) => (/^[-*+]\s+/u.test(line) ? `${index > 1 ? ';' : ''} ${line.replace(/^[-*+]\s+/u, '')}` : ` ${line}`)).join('').trim();
  const name = /Record the answer (?:as|under a name \(here)\s*`([A-Za-z][\w-]*)`/u.exec(text.join('\n'))?.[1] ?? null;
  if (asked && choices.length >= 2) return [{ question: oneLine(asked), choices, name }];
  if (asked) return [{ question: oneLine(asked), choices: [], name }];
  const numbered = text.map((line) => /^\s*\d+[.)]\s+(.+\?)\s*$/u.exec(line)?.[1]).filter(Boolean);
  if (numbered.length) return numbered.slice(0, MAX.questions).map((question) => ({ question: oneLine(withoutCode(question)), choices: [], name: null }));
  const said = /\bAsk(?: exactly)?:\s*["“]([^"”]+)["”]/u.exec(text.join(' '))?.[1];
  return [{ question: oneLine(said ?? `${title}: what the stage needs from the person before work starts`), choices: [], name }];
}

/**
 * agent.md as stages: `{ title, frontmatter, sections, stages, skillTable }`. A stage is a numbered heading
 * (`## 2. Test Case Creation`) outside fenced code, with `{ number, title, heading, line, body, hardGate, optional,
 * conditions, skills, approvalGate, questions }`; `sections` are the other headings at that level (Role, Rules, Output
 * Format, ...), by title. `skillTable` is `{ options, rows: [{ step, skills: { option|null: [skill] } }], notes }`.
 */
export function parseAgentDocument(text) {
  const source = String(text ?? '').replace(/\r\n?/gu, '\n');
  const front = /^﻿?---\n([\s\S]*?)\n---(?:\n|$)/u.exec(source);
  let frontmatter = {};
  if (front) {
    try { frontmatter = YAML.parse(front[1], { maxAliasCount: 50 }) ?? {}; } catch { frontmatter = {}; }
  }
  const offset = front ? front[0].split('\n').length - 1 : 0;
  const lines = markLines((front ? source.slice(front[0].length) : source).split('\n'));
  const headings = lines.filter((line) => !line.fenced).map((line) => ({ line, match: /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line.text) }))
    .filter((entry) => entry.match && entry.match[2]).map(({ line, match }) => ({ level: match[1].length, heading: match[2].trim(), index: line.index }));
  const title = headings.find((entry) => entry.level === 1)?.heading ?? null;
  const numbered = headings.filter((entry) => entry.level >= 2 && /^\d+[.)]\s+\S/u.test(entry.heading));
  const level = numbered.length ? Math.min(...numbered.map((entry) => entry.level)) : 2;
  const parts = headings.filter((entry) => entry.level === level).map((entry) => {
    const next = headings.find((candidate) => candidate.index > entry.index && candidate.level <= level);
    return { ...entry, lines: lines.slice(entry.index + 1, next ? next.index : lines.length) };
  });
  const sections = {};
  const stages = [];
  for (const part of parts) {
    const match = /^(\d+)[.)]\s+(.+)$/u.exec(part.heading);
    if (!match) { sections[part.heading] = { line: part.index + offset + 1, lines: part.lines }; continue; }
    const markers = [...match[2].matchAll(/\(([^)]*)\)/gu)].map((entry) => entry[1].trim());
    const gateMarker = markers.some((marker) => /hard\s*gate/iu.test(marker));
    const optionalMarker = markers.find((marker) => /\boptional\b/iu.test(marker)) ?? null;
    const cleanTitle = oneLine(match[2].replace(/\(([^)]*)\)/gu, (whole, inner) => (/hard\s*gate|\boptional\b/iu.test(inner) ? '' : whole)));
    const body = prose(part.lines).join('\n');
    const hardGate = gateMarker || /\bSTOP and WAIT\b/u.test(body) || /\bMUST ask\b/u.test(body);
    const listed = prose(part.lines).filter((line) => !/^\s*>/u.test(line)).some((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/u.test(line));
    const lastWord = words(cleanTitle).at(-1) ?? '';
    stages.push({
      number: Number(match[1]), title: cleanTitle, heading: part.heading, line: part.index + offset + 1, body, lines: part.lines,
      hardGate, optional: Boolean(optionalMarker),
      conditions: optionalMarker ? words(optionalMarker).filter((word) => word !== 'optional') : [],
      skills: [...new Set(skillsIn(body))],
      approvalGate: hardGate && APPROVAL_GATE_WORDS.has(lastWord) && !listed,
      questions: hardGate ? gateQuestions(part.lines, cleanTitle) : []
    });
  }
  if (stages.length > MAX.stages) throw fail(`The agent has ${stages.length} numbered stages; at most ${MAX.stages} become steps.`);
  // The step-to-skill table: the section whose table starts with a Step column.
  let skillTable = { options: [], rows: [], notes: [] };
  for (const [name, section] of Object.entries(sections)) {
    const rows = tableRows(prose(section.lines));
    if (rows.length < 2 || !/^steps?$/iu.test(rows[0][0])) continue;
    const options = rows[0].slice(1).map((cell) => (/^skills?$/iu.test(cell) ? null : oneLine(withoutCode(cell)).toLowerCase()));
    skillTable = {
      section: name, options: options.filter(Boolean),
      rows: rows.slice(1).map((cells) => ({ step: oneLine(withoutCode(cells[0])), skills: Object.fromEntries(options.map((option, index) => [option ?? '', skillsIn(cells[index + 1] ?? '')])) })),
      // A line after the table that names a stage and a skill ("Optional, android only: Unit Test Gap Fill uses ...").
      notes: prose(section.lines).filter((line) => !/^\s*\|/u.test(line) && skillsIn(line).length).map((line) => line.trim())
    };
    break;
  }
  return { title, frontmatter, sections, stages, skillTable };
}

// ---------------------------------------------------------------------------------------------
// The conversion

const sameTitle = (left, right) => kebab(left) === kebab(right);
function stageFor(stages, name) {
  return stages.find((stage) => sameTitle(stage.title, name))
    ?? stages.find((stage) => kebab(stage.title).includes(kebab(name)) || kebab(name).includes(kebab(stage.title))) ?? null;
}

/**
 * The task of the agent a stage is named like, or null: every word of the stage's name is a word of the task
 * ("User Stories" is user-story-writing, "Test Automation" ui-test-automation), and at least one of them tells that
 * task from the others. A name with a word the task does not have ("Implementation Plan") is left to the word rules.
 */
function taskNamed(title, tasks) {
  const own = words(joinHyphenated(title)).filter((word) => !['and', 'the', 'of', 'for', 'a'].includes(word));
  const scored = tasks.map((task) => {
    const taskWords = task.split('-');
    const matched = own.filter((word) => taskWords.some((part) => sameStem(word, part)));
    const distinctive = matched.filter((word) => !GENERIC_TASK_WORDS.has(word));
    return { task, score: matched.length, ok: own.length > 0 && matched.length === own.length && distinctive.length > 0 };
  }).filter((entry) => entry.ok && AGENT_TASK_INTENTS[entry.task]);
  if (!scored.length) return null;
  const best = Math.max(...scored.map((entry) => entry.score));
  const top = scored.filter((entry) => entry.score === best);
  const intents = new Set(top.map((entry) => AGENT_TASK_INTENTS[entry.task].intent));
  return intents.size === 1 ? top[0].task : null;
}

/** The intent a stage's skills give through their pdlc-tasks, or null when they give none or disagree evenly. */
function intentOfSkills(names, skillByName) {
  const counts = new Map();
  const tasks = [];
  for (const name of names) {
    for (const task of skillByName.get(name)?.pdlcTasks ?? []) {
      const known = AGENT_TASK_INTENTS[task];
      if (!known) continue;
      tasks.push({ skill: name, task, ...known });
      counts.set(known.intent, (counts.get(known.intent) ?? 0) + 1);
    }
  }
  if (!counts.size) return null;
  const best = Math.max(...counts.values());
  const top = [...counts].filter(([, count]) => count === best).map(([intent]) => intent);
  if (top.length !== 1) return null;
  const chosen = tasks.filter((entry) => entry.intent === top[0]);
  return { intent: top[0], certain: counts.size === 1, tasks: chosen };
}

const describe = (task) => {
  const entry = AGENT_TASK_INTENTS[task];
  return entry.because ? `${task} is ${entry.intent}: ${entry.because}` : `${task} is ${entry.intent}`;
};

/** A stage's own words for the word signals: its prose without code spans, each word once, in order. */
function stageWords(stage) {
  const seen = new Set();
  return words(joinHyphenated(withoutCode(stage.body))).filter((word) => (seen.has(word) ? false : seen.add(word))).join(' ');
}

/** The intents a step's place leans to (§6.1 position signals), given the steps already known to be code. */
function placeLeans(index, candidates) {
  const code = candidates.flatMap((candidate, position) => (candidate.decided?.intent === 'code' ? [position] : []));
  return [
    ...(index === 0 ? ['intake'] : []),
    ...(code.length && index === Math.min(...code) - 1 ? ['plan'] : []),
    ...(code.length && index > Math.max(...code) ? ['test', 'review', 'release', 'report'] : []),
    ...(!code.length && index === candidates.length - 1 && index > 0 ? ['report'] : [])
  ];
}

/** The step IDs of a workflow: the agent's short name and the stage, unique and at most 64 characters. */
function stepId(prefix, title, taken) {
  const stem = `${prefix}-${kebab(title) || 'step'}`.slice(0, MAX.id - 3).replace(/-+$/u, '');
  let id = stem;
  for (let index = 2; taken.has(id); index += 1) id = `${stem}-${index}`;
  taken.add(id);
  return id;
}

/** A stage's first sentence, list markers and code quotes dropped: what its step's description says it does. */
const sentence = (text) => {
  const value = oneLine(String(text).split('\n').filter((line) => !/^\s*(?:>|\|)/u.test(line) && !/^\s+(?:[-*+]|\d+[.)])\s/u.test(line))
    .map((line) => line.replace(/^(?:[-*+]|\d+[.)])\s+/u, '')).join(' ').replace(/`([^`\n]*)`/gu, '$1'));
  const end = value.search(/(?<=[.!?:])\s/u);
  return (end > 0 ? value.slice(0, end) : value).replace(/:$/u, '.').slice(0, 300);
};

/** The questions of the gates before the first stage, numbered for the step that asks them. */
function intakeQuestions(gates) {
  return gates.flatMap((gate) => gate.questions.map((question) => ({ ...question, from: `${gate.number}. ${gate.title}` })))
    .slice(0, MAX.questions)
    .map((question, index) => ({ id: question.name ?? `question-${index + 1}`, ...question }));
}

const topic = (question) => (question.choices.length
  ? `${question.question.replace(/\?*$/u, '?')} Choose one: ${question.choices.join(', ')}${question.name ? ` (recorded as ${question.name})` : ''}.`
  : question.question);

// The shapes a decision input and its routes take (workflow-decisions.mjs).
const VALUE_NAME = /^[a-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/u;
const ROUTE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * The hard gate's named choice as a Story value the first step records, or null with a note when it cannot be one:
 * `{ name, question, values, step, decision, tableSection }`.
 */
function recordedAnswer(named, first, skillTable, notes) {
  if (!named.name) return null;
  const values = named.choices;
  const routes = values.map((value) => kebab(value));
  const fits = VALUE_NAME.test(named.name) && named.name.length <= 40 && values.length >= 2 && values.length <= 20
    && values.every((value) => value.length <= 60) && new Set(values.map((value) => value.toLowerCase())).size === values.length
    && routes.every((id) => ROUTE_ID.test(id)) && new Set(routes).size === routes.length;
  if (!fits) {
    notes.push(`The answer the agent records as ${named.name} stays a question at ${first.label}: its name or choices cannot be a Story value, so every answer's skills are attached with their condition in words.`);
    return null;
  }
  return { name: named.name, question: named.question, values: [...values], step: first.id, decision: kebab(named.name),
    tableSection: skillTable.section && skillTable.options.length ? skillTable.section : null };
}

/**
 * The workflow `agent` (a marketplace package with its agent.md `text`) becomes, with `skills` (its skill packages with
 * their SKILL.md `text`) and `answers` ({ stepId: intent } for the stages SFlow asked about). Returns
 * `{ workflow, agent, skills, questions, steps, open, notes, source }`; `open` lists the stages still waiting for the
 * person's answer, each with the 2 to 4 choices of §6.3, and no workflow is written while one is open.
 */
export function convertAgent({ marketplace, folder = null, agent, skills = [], answers = {} }) {
  if (!agent?.text) throw fail(`${agent?.name ?? 'The agent'} has no agent.md text to convert.`);
  const parsed = parseAgentDocument(agent.text);
  if (!parsed.stages.length) {
    throw fail(`${agent.name}'s agent.md has no numbered stages (headings such as "## 1. Intake" outside code blocks), so there are no steps to make.`, 'AGENT_WORKFLOW_NO_STAGES');
  }
  const skillByName = new Map(skills.map((entry) => [entry.name, entry]));
  const known = new Set(agent.skills ?? skills.map((entry) => entry.name));
  const notes = [];
  const prefix = kebab(agent.name).replace(/-agent$/u, '') || 'agent';
  const workflowId = prefix.slice(0, MAX.id);
  const label = oneLine(String(parsed.title ?? agent.name).replace(/\s+agent$/iu, '')) || agent.name;

  // Gates before the first stage with work are the person's questions at the first step.
  const leading = [];
  // The first stage has nothing before it to approve, so a gate there asks its questions whatever it is called.
  for (const stage of parsed.stages) { if (!stage.hardGate || (stage.approvalGate && leading.length)) break; leading.push(stage); }
  const questions = intakeQuestions(leading);
  const named = questions.find((question) => question.choices.length >= 2) ?? null;

  // Every other stage is a step, except a gate that only approves or chooses what the stage before it made.
  const candidates = [];
  for (const stage of parsed.stages.slice(leading.length)) {
    if (stage.approvalGate && candidates.length) {
      candidates.at(-1).gates.push(stage);
      continue;
    }
    candidates.push({ stage, gates: [], skills: [] });
  }
  if (!candidates.length) throw fail(`${agent.name}'s stages are all hard gates, so there is no work to make steps of.`, 'AGENT_WORKFLOW_NO_STAGES');

  // The skills each stage uses: its row of the step-to-skill table (for each answer), notes under the table, its own words.
  const use = (option) => (option && named ? `when ${named.name ?? 'the first answer'} is ${option}` : option ? `when the answer is ${option}` : '');
  for (const candidate of candidates) {
    const row = parsed.skillTable.rows.find((entry) => stageFor([candidate.stage], entry.step));
    // A skill the row names for every answer is used whatever the answer; for some, when the answer is one of them.
    const options = row ? Object.keys(row.skills) : [];
    const fromRow = [...new Set(row ? Object.values(row.skills).flat() : [])].map((name) => {
      const when = options.filter((option) => row.skills[option].includes(name));
      return { skill: name, use: when.includes('') || when.length === options.length ? '' : when.map(use).join(' or ') };
    });
    const fromNotes = parsed.skillTable.notes.filter((line) => kebab(line).includes(kebab(candidate.stage.title))).flatMap((line) => {
      const options = (named?.choices ?? []).filter((choice) => words(line).includes(choice.toLowerCase()));
      return skillsIn(line).map((name) => ({ skill: name, use: options.length ? options.map(use).join(' or ') : '' }));
    });
    const fromBody = candidate.stage.skills.map((name) => ({ skill: name, use: '' }));
    const seen = new Map();
    for (const entry of [...fromRow, ...fromNotes, ...fromBody]) {
      if (!known.has(entry.skill)) {
        notes.push(`Stage ${candidate.stage.number} names skill ${entry.skill}, which ${agent.name} does not depend on (its apm.yml dependencies.apm), so it is left out.`);
        continue;
      }
      // A skill a row ties to an answer keeps that condition over the stage's own unconditional mention.
      if (!seen.has(entry.skill) || (entry.use && !seen.get(entry.skill).use)) seen.set(entry.skill, entry);
    }
    candidate.skills = [...seen.values()];
    if (candidate.stage.optional) {
      const when = candidate.stage.conditions.filter((word) => named?.choices.some((choice) => choice.toLowerCase() === word));
      const needed = `only when step ${candidate.stage.number}, ${candidate.stage.title}, is needed`;
      // The answer's condition comes first, in the form a Story value is read in (skill-library.mjs storyValueCondition).
      candidate.skills = candidate.skills.map((entry) => ({ ...entry,
        use: entry.use ? `${entry.use}, ${needed}` : when.length ? `${when.map(use).join(' or ')}, ${needed}` : needed }));
    }
  }

  // What each stage is for: its skills' tasks, a stage named like one of the agent's tasks, then the §6.1 rules.
  const ids = new Set();
  for (const candidate of candidates) {
    candidate.id = stepId(prefix, candidate.stage.title, ids);
    const fromSkills = intentOfSkills(candidate.skills.map((entry) => entry.skill), skillByName);
    // Skills that do tasks of several intents: the one the stage is named like decides ("Static Analysis").
    const ownTask = fromSkills && !fromSkills.certain
      ? taskNamed(candidate.stage.title, [...new Set(candidate.skills.flatMap((entry) => skillByName.get(entry.skill)?.pdlcTasks ?? []))]) : null;
    if (ownTask) {
      candidate.decided = { intent: AGENT_TASK_INTENTS[ownTask].intent, confidence: 'certain', source: 'skill', why: `its skills do several tasks, and it is named like ${describe(ownTask)}` };
      continue;
    }
    if (fromSkills) {
      const tasks = [...new Set(fromSkills.tasks.map((entry) => entry.task))];
      candidate.decided = { intent: fromSkills.intent, confidence: fromSkills.certain ? 'certain' : 'likely', source: 'skill',
        why: `its skill${new Set(fromSkills.tasks.map((entry) => entry.skill)).size === 1 ? '' : 's'} ${[...new Set(fromSkills.tasks.map((entry) => entry.skill))].join(', ')} `
          + `do${new Set(fromSkills.tasks.map((entry) => entry.skill)).size === 1 ? 'es' : ''} ${tasks.join(', ')}; ${tasks.map(describe).join('; ')}` };
      continue;
    }
    const task = taskNamed(candidate.stage.title, agent.pdlcTasks ?? []);
    if (task) candidate.decided = { intent: AGENT_TASK_INTENTS[task].intent, confidence: 'likely', source: 'task', why: `it is named like the agent's task ${describe(task)}` };
  }
  const inferred = inferStepIntents(candidates.map((candidate) => ({
    id: kebab(joinHyphenated(candidate.stage.title)), label: joinHyphenated(candidate.stage.title), description: stageWords(candidate.stage),
    declared: candidate.decided?.intent ?? null
  })));
  const leans = [...new Set((agent.pdlcPhases ?? []).flatMap((phase) => PDLC_PHASE_LEANS[phase] ?? []))];
  const open = [];
  candidates.forEach((candidate, index) => {
    const answer = answers[candidate.id];
    // The person may say what any step is for, with any of the ten intents: the question's choices are SFlow's best few.
    if (answer != null && !STEP_INTENTS.includes(answer)) {
      throw fail(`'${answer}' is not one of the ten things a step can be for: ${STEP_INTENTS.join(', ')}.`, 'AGENT_WORKFLOW_ANSWER_INVALID', { step: candidate.id });
    }
    if (candidate.decided && answer != null) {
      if (answer !== candidate.decided.intent) candidate.decided = { intent: answer, confidence: 'certain', source: 'person', why: `the person chose it (SFlow read ${candidate.decided.intent}: ${candidate.decided.why})` };
      return;
    }
    if (candidate.decided) return;
    const result = inferred[index];
    if (result.confidence === 'likely') { candidate.decided = { intent: result.intent, confidence: 'likely', source: result.source, why: result.why }; return; }
    // The agent's phases agree with its words or place; not on the first step, whose place says intake.
    if (result.confidence === 'unclear' && result.source !== 'none' && index > 0 && leans.includes(result.intent)) {
      candidate.decided = { intent: result.intent, confidence: 'likely', source: result.source,
        why: `${result.why.replace(/, but nothing else agrees$/u, '')}, and the agent works in ${(agent.pdlcPhases ?? []).filter((phase) => PDLC_PHASE_LEANS[phase]?.includes(result.intent)).join(' and ')}` };
      return;
    }
    // The one plain question: the top candidates by the words of its name, then of its text, its place and the
    // agent's phases, then "something else".
    const scores = intentWordScores([[joinHyphenated(candidate.stage.title), 4], [stageWords(candidate.stage), 1]]);
    const ranked = STEP_INTENTS.filter((intent) => intent !== 'document' && (scores.get(intent)?.score ?? 0) > 0)
      .sort((left, right) => (scores.get(right).score - scores.get(left).score) || STEP_INTENTS.indexOf(left) - STEP_INTENTS.indexOf(right));
    const placed = placeLeans(index, candidates);
    const offered = [...new Set([result.intent, ...placed, ...ranked, ...leans])].filter((intent) => intent !== 'document').slice(0, 3);
    const choices = [...offered, 'document'].map((intent) => ({ intent, label: INTENT_CHOICES[intent] }));
    if (answer != null) {
      candidate.decided = { intent: answer, confidence: 'certain', source: 'person', why: 'the person chose it' };
      return;
    }
    open.push({ step: candidate.id, stage: `${candidate.stage.number}. ${candidate.stage.title}`, question: `What does "${candidate.stage.title}" do?`,
      choices, why: result.why });
  });
  for (const step of Object.keys(answers)) {
    if (!candidates.some((candidate) => candidate.id === step)) {
      throw fail(`${agent.name} has no step ${step}. Its steps: ${candidates.map((candidate) => candidate.id).join(', ')}.`, 'AGENT_WORKFLOW_ANSWER_INVALID', { step });
    }
  }

  // An optional stage that is what the step before it is runs inside that step: no step that one answer runs empty.
  const steps = [];
  for (const candidate of candidates) {
    const previous = steps.at(-1);
    if (candidate.stage.optional && candidate.decided && previous?.intent === candidate.decided.intent) {
      previous.folded.push({ number: candidate.stage.number, title: candidate.stage.title });
      previous.skills.push(...candidate.skills.filter((entry) => !previous.skills.some((own) => own.skill === entry.skill)));
      previous.gates.push(...candidate.gates);
      notes.push(`Stage ${candidate.stage.number} (${candidate.stage.title}) is optional and ${candidate.decided.intent} like ${previous.label}, so it runs inside that step: its skills are attached there for when it is needed.`);
      continue;
    }
    steps.push({
      id: candidate.id, label: candidate.stage.title, stage: candidate.stage.number, line: candidate.stage.line,
      ...(candidate.decided ?? { intent: null, confidence: 'unclear', source: 'none', why: 'waiting for the person\'s answer' }),
      skills: candidate.skills, gates: candidate.gates, folded: [], optional: candidate.stage.optional,
      summary: sentence(candidate.stage.body)
    });
  }

  // The steps SFlow needs that the agent has no stage for (workflow-needs.mjs): requirements before its code, and
  // verification after it. Each is SFlow's own, says why, and runs from its intent's template [owner, 2026-11-22].
  const added = [];
  if (!open.length) {
    const needed = neededSteps(steps, { omits: agent.omits ?? [] });
    steps.splice(0, steps.length, ...withNeededSteps(steps, needed, (entry) => {
      const step = { id: stepId(prefix, entry.name, ids), label: entry.label, stage: null, line: null, intent: entry.intent, confidence: 'certain', source: 'sflow',
        why: entry.why, skills: [], gates: [], folded: [], optional: false, summary: entry.why, addedBySflow: true };
      added.push({ step: step.id, label: step.label, intent: step.intent, ...(entry.before ? { before: entry.before } : { after: entry.after }), why: entry.why });
      return step;
    }));
    for (const entry of added) {
      notes.push(`SFlow added ${entry.label} ${entry.before ? 'before' : 'after'} ${steps.find((step) => step.id === (entry.before ?? entry.after))?.label}: ${entry.why}`);
    }
  }

  // Who approves: the derived settings already hand a step to a person where the agent's gate does; else it says why.
  if (!open.length) {
    const derived = deriveWorkflowSettings(steps.map((step) => ({ id: step.id, intent: step.intent })));
    steps.forEach((step, index) => {
      const own = derived.steps[index];
      // What its template needs: the clause anchors of a step that writes the requirement IDs, the planned-claims table of a plan.
      Object.assign(step, { writesRequirementIds: own.writesRequirementIds, isPlan: own.isPlan });
      const gates = step.addedBySflow ? [] : [...step.gates, ...(parsed.stages.find((stage) => stage.number === step.stage)?.hardGate ? [parsed.stages.find((stage) => stage.number === step.stage)] : [])];
      if (gates.length) {
        const gate = gates[0];
        if (own.approval.by === 'person') step.personApproval = { gate: `${gate.number}. ${gate.title}`, derived: own.approval.why };
        else {
          step.personApproval = { gate: `${gate.number}. ${gate.title}`, derived: null };
          step.because = { 'approval.automatic': `The agent's "${gate.title}" is a hard gate: a person approves this step before the next one starts.` };
        }
      }
    });
    // The person's questions go to the step that asks every time; when that is not the first step, it asks there too.
    if (questions.length && derived.facts.questionStep !== steps[0].id) {
      steps[0].requiredQuestions = true;
      steps[0].because = { ...(steps[0].because ?? {}), 'clarification.mode': `The agent's first stage is a hard gate: the person answers ${questions.map((question) => `"${question.question}"`).join(', ').slice(0, 600)} before any work.` };
    }
  }
  if (agent.lifecycleState && agent.lifecycleState !== 'approved') {
    notes.push(`${agent.name} is ${agent.lifecycleState} in ${marketplace ? 'the marketplace' : 'its apm.yml'}${agent.lifecycleState === 'proposed' ? ', not yet reviewed by its maintainers' : ''}.`);
  }
  const usedSkills = [...new Set(steps.flatMap((step) => step.skills.map((entry) => entry.skill)))];
  for (const name of known) if (!usedSkills.includes(name)) notes.push(`${agent.name} depends on skill ${name}, which no stage names, so it is not attached to a step.`);
  const storyValue = named && steps.length ? recordedAnswer(named, steps[0], parsed.skillTable, notes) : null;

  return {
    schemaVersion: 1, resultType: AGENT_WORKFLOW_RESULT,
    source: { marketplace: marketplace?.id ?? null, repository: marketplace?.repository ?? null, commit: marketplace?.commit ?? null, ...(folder ? { folder } : {}),
      agent: agent.name, version: agent.version ?? null, lifecycleState: agent.lifecycleState ?? null, document: agent.document ?? null,
      pdlcPhases: [...(agent.pdlcPhases ?? [])], pdlcTasks: [...(agent.pdlcTasks ?? [])] },
    workflow: { id: workflowId, label, description: oneLine(`${agent.description ?? ''} ${folder && !marketplace ? `From folder ${folder}` : `From marketplace ${marketplace?.id ?? ''}`}: ${agent.name} ${agent.version ?? ''}`.trim()) },
    agent: { id: kebab(agent.name), label: parsed.title ?? agent.name, description: oneLine(agent.description ?? parsed.frontmatter?.description ?? agent.name) },
    questions: questions.map((question) => ({ ...question, topic: topic(question) })),
    ...(storyValue ? { storyValue } : {}),
    steps, added, open, notes,
    skills: usedSkills.map((name) => skillByName.get(name)).filter(Boolean).map((entry) => ({ id: entry.name, description: entry.description ?? entry.name, version: entry.version ?? null })),
    ready: open.length === 0
  };
}

// ---------------------------------------------------------------------------------------------
// The workflow.yml pieces

/** The instructions the agent drafts every step with: how SFlow runs its stages, then its agent.md as written. */
export function agentInstructions(conversion, agentText) {
  const body = String(agentText ?? '').replace(/\r\n?/gu, '\n').replace(/^﻿?---\n[\s\S]*?\n---(?:\n|$)/u, '').replace(/^\s*# [^\n]*\n/u, '').trim();
  const value = conversion.storyValue ?? null;
  const asked = conversion.questions.length
    ? ` The person answers the first stage's questions (${conversion.questions.map((question) => question.question).join(' ')}) at ${conversion.steps[0].label}, and later steps read that answer from it.${value
      ? ` SFlow records the answer to "${value.question}" as the Story value ${value.name} when ${conversion.steps[0].label} is submitted, and gives each later step only the skill its stage uses for that answer.` : ''}`
    : '';
  return [
    `SFlow runs the numbered stages below as the steps of the ${conversion.workflow.label} workflow, one stage per step and in order; each step's description names its stage. At each step do that stage only, building on what the earlier steps recorded.${asked}`
      + ' A hard gate is SFlow\'s: the person approves the steps that need a person in SFlow, so never stop and wait in chat for an approval.'
      + ((conversion.added ?? []).length ? ` SFlow also runs ${conversion.added.map((entry) => entry.label).join(' and ')}, which ${conversion.added.length === 1 ? 'is' : 'are'} not a stage below: there, follow that step's template only.` : ''),
    '',
    value?.tableSection ? withoutSection(body, value.tableSection,
      `SFlow resolves each step's skill from the Story value ${value.name}: the step is given only the skill for the recorded answer. Follow the skill attached to the step.`) : body
  ].join('\n');
}

/** `text` with the section headed `title` (to the next heading of its level or above) replaced by `words`. */
function withoutSection(text, title, words) {
  const lines = markLines(String(text).split('\n'));
  const heading = (line) => (line.fenced ? null : /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line.text));
  const at = lines.findIndex((line) => heading(line)?.[2].trim() === title);
  if (at < 0) return text;
  const level = heading(lines[at])[1].length;
  const next = lines.findIndex((line, index) => index > at && heading(line) && heading(line)[1].length <= level);
  const kept = lines.map((line) => line.text);
  return [...kept.slice(0, at + 1), '', words, '', ...(next < 0 ? [] : kept.slice(next))].join('\n');
}

/**
 * The version 4 workflow.yml pieces of a ready conversion: `{ phases, workType }`, each step with its intent and only
 * the settings it keeps against its intent's profile, each with its `because:`. `template(step)` names each step's
 * template.
 */
export function workflowDefinition(conversion, { template = (step) => `${conversion.workflow.id}/${step.id.slice(conversion.workflow.id.length + 1) || step.id}.md` } = {}) {
  if (!conversion.ready) throw fail(`${conversion.workflow.label} still has ${conversion.open.length} stage${conversion.open.length === 1 ? '' : 's'} waiting for the person's answer.`, 'AGENT_WORKFLOW_OPEN');
  const phases = {};
  conversion.steps.forEach((step, index) => {
    const stages = [step.stage, ...step.folded.map((entry) => entry.number)];
    phases[step.id] = {
      label: step.label,
      description: step.addedBySflow ? oneLine(`Added by SFlow, not a stage of ${conversion.agent.label}: ${step.why}`).slice(0, 1000) : oneLine(`Stage${stages.length === 1 ? '' : 's'} ${stages.join(' and ')} of ${conversion.agent.label}: ${step.label}${step.folded.length ? ` (with ${step.folded.map((entry) => entry.title).join(', ')}, when needed)` : ''}. ${step.summary}`).slice(0, 1000),
      intent: step.intent,
      artifact: { path: `artifacts/${step.id}/${step.id}.md` },
      defaultTemplate: template(step),
      ...(index === 0 && conversion.questions.length ? { clarification: { ...(step.requiredQuestions ? { mode: 'required' } : {}), topics: conversion.questions.map((question) => question.topic) } } : {}),
      ...(step.because?.['approval.automatic'] ? { approval: { automatic: 'off' } } : {}),
      ...(step.because ? { because: { ...step.because } } : {})
    };
  });
  const value = conversion.storyValue ?? null;
  return {
    phases,
    workType: { label: conversion.workflow.label, description: conversion.workflow.description, phases: conversion.steps.map((step) => step.id),
      ...(value ? { decisions: [storyValueDecision(value)] } : {}) }
  };
}

/**
 * The branch decision that records a hard gate's answer as a Story value when its step is submitted: one input, its
 * choices, and a route per answer, every one to the next step, so the answer chooses skills and never skips a step.
 */
export function storyValueDecision(value) {
  const label = oneLine(value.question).slice(0, 120);
  return {
    id: value.decision, after: value.step, kind: 'branch', label,
    inputs: [{ name: value.name, label, values: [...value.values] }],
    routes: value.values.map((choice, index) => ({ id: kebab(choice), label: choice,
      ...(index < value.values.length - 1 ? { when: { [value.name]: choice } } : {}), to: 'next' }))
  };
}

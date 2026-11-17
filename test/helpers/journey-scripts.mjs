/**
 * The scripted parts of the journeys (test/journey-routes.test.mjs, test/journey-stories.test.mjs): what the agent
 * writes at each step, what the reviewer reports, and what the person answers. Everything is deterministic and small:
 * a value module, its test, and the documents of a quick-fix or a spec-driven Story about it. The CLI's own checks
 * decide whether each is good enough; nothing here bypasses them.
 *
 * KNOWN_BAD names the checks that fail on main until a fix branch lands. Each is reported as `todo` with its branch
 * while it still fails; once it passes, the journey fails until its entry here is removed, so it turns on with the fix.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { codeReport, documentReport, planningReport, specificationReport } from './step-review.mjs';
import { implementationPlan, specification } from './submitted-planning-story.mjs';
import { formatTrail } from './route-follower.mjs';

/** Fix branch (or a defect a journey found that has none yet) → what is wrong on main until it lands. */
// SPEC-OSA Stage 3 closed osa-stage-3 (the outcome review is read in the publication's own turn), osa-stage-3-c9 (a
// kernel-built step is published by its own work command) and osa-stage-3-refusal (the failed test's wait is the task's,
// which every view names): their checks count now.
export const KNOWN_BAD = Object.freeze({});

const stale = new WeakMap();

/**
 * One check of a journey, as a subtest. With `knownBad` naming a branch still in KNOWN_BAD, a failure is reported as
 * `todo` with that branch; a pass is noted, and settle(t) at the journey's end then fails it, so the entry is removed
 * and the check counts from then on.
 */
export async function check(t, name, { knownBad = null } = {}, body) {
  const open = knownBad && Object.hasOwn(KNOWN_BAD, knownBad);
  let passed = false;
  await t.test(name, open ? { todo: `${knownBad}: ${KNOWN_BAD[knownBad]}` } : {}, async () => {
    await body();
    passed = true;
  });
  if (open && passed) stale.set(t, [...(stale.get(t) ?? []), `"${name}" (${knownBad})`]);
}

/** The journey's end: a known-bad check that passes means its branch landed, and its KNOWN_BAD entry goes. */
export function settle(t) {
  const passing = stale.get(t) ?? [];
  assert.deepEqual(passing, [], `these pass now, so their branch has landed: remove its KNOWN_BAD entry in test/helpers/journey-scripts.mjs and they count`);
}

/** A walk's findings and trail, for an assertion message. */
export const report = (walk) => `findings: ${JSON.stringify(walk.findings, null, 1)}\n${walk.views?.length ? `views: ${JSON.stringify(walk.views, null, 1)}\n` : ''}trail:\n${formatTrail(walk.trail)}`;

/**
 * The person's views at every hand-off name the agent's skill [OSA:AC-011]. `except(view)` names a disagreement this
 * stage does not close yet; such a view is reported, never ignored silently.
 */
export const viewsAgree = (walk, except = () => false) => assert.deepEqual(walk.views.filter((view) => !except(view)), [], report(walk));

/** The findings of a walk other than those a journey expects on main until `branch` lands. */
export const findingsOf = (walk, kinds = null) => walk.findings.filter((entry) => !kinds || kinds.includes(entry.kind));

// ------------------------------------------------------------------------------------ the agent's writing

export const quickFixIntake = (W) => [`# ${W} — Quick fix scope and plan`, '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
  '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${W}:AC-001] | The exported value equals 2. |`, '',
  '## Planned implementation evidence', '',
  '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
  `| \`${W}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | The test reads 2. |`, '',
  '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');

/**
 * What a /sf-code entry tells its author to do with what the person asked for in the version it writes [SCS:REQ-042]:
 * account for each, here within the plan by `clause`, before the step is submitted (a step nobody approves completes
 * at its submission). The check copies what was typed into the Story and names each one still open. Returns the
 * accounts made; nothing when nothing was asked.
 */
export function accountForAskedFor(story, phase, clause) {
  const record = (() => { try { return JSON.parse(readFileSync(path.join(story.root, story.item, 'workflow.json'), 'utf8')); } catch { return null; } })();
  if (!(record?.askedFor ?? []).length && !existsSync(path.join(story.root, '.git', 'singularity-flow', 'asked-for'))) return [];
  const checked = story.raw(['phase', 'prepublish', phase, '--json']);
  let open = [];
  try { open = JSON.parse(checked.stdout.slice(checked.stdout.indexOf('{'))).askedFor?.unaccounted ?? []; } catch { open = []; }
  return open.map((instruction) => {
    const ran = story.raw(['departure', 'account', '--instruction', String(instruction), '--clauses', clause, '--json']);
    return { instruction, status: ran.status, out: `${ran.stdout.slice(-400)}${ran.stderr.slice(-400)}` };
  });
}

/** The value module and its test, tagged with `clauses`; `note` is the clause comment's words (a correction changes it). */
export async function writeValueCode(story, { value, clauses, note = 'returns the approved value to its callers', extraTest = '' }) {
  await story.write('src/value.mjs', `${clauses.map((clause, index) => `// @clause:${clause} ${index ? `${note} (${clause.split(':')[1]})` : note}\n`).join('')}export const value = ${value};\n`);
  await story.write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value } from '../src/value.mjs';", '',
    ...clauses.map((clause) => `// @ac:${clause}`), `test('returns the approved value', () => assert.equal(value, ${value}));`, extraTest, ''].join('\n'));
}

const fill = (text, words) => text.replace(/TODO:[^\n]*/gu, words).replace(/\bTODO\b/gu, 'none');

/** The spec-driven Story's documents and code, by step, as an author who read the entry writes them. */
export function specDrivenAuthor(W, { clauses = [`${W}:AC-001`, `${W}:REQ-002`], value = 1, onCode = null } = {}) {
  return async ({ story, phase, generation }) => {
    const item = story.item;
    const artifact = async (relative, make) => {
      const file = path.join(story.root, item, 'artifacts', phase, relative);
      const before = await readFile(file, 'utf8').catch(() => '');
      await story.write(path.join(item, 'artifacts', phase, relative), await make(before));
    };
    if (phase === 'specification') { await artifact('spec.md', () => specification(W, value)); return true; }
    if (phase === 'planning') { await artifact('plan.md', () => implementationPlan(W)); return true; }
    if (phase === 'implementation') {
      await writeValueCode(story, { value, clauses, ...(onCode?.({ generation }) ?? {}) });
      await artifact('implementation-summary.md', () => ['# Implementation summary', '', '## Agent brief', '',
        'Added the value module; both clauses have one focused test that reads the approved value and proves it.', '',
        '## Changed components and decisions', '', '- `src/value.mjs` exports the approved value.', '',
        '## Tests and operational notes', '', '`test/value.test.mjs` verifies the value, and nothing else changes for anyone who reads it.', ''].join('\n'));
      await artifact('operator-notes.md', () => ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
      return true;
    }
    if (phase === 'verification') {
      await artifact('test-evidence.md', (before) => fill(before, `${clauses.join(' and ')} are covered by \`test/value.test.mjs\` and \`src/value.mjs\`, on the run the entry names.`));
      return true;
    }
    if (phase === 'release') {
      await story.write(path.join(item, 'artifacts/release/verification/evidence-index.md'),
        `# Release verification evidence index — ${W}\n\nVerification is approved, and it reused the run Implementation recorded on this same source tree.\n`);
      await artifact('conformance.md', (before) => fill(before.replace(`| \`${W}:REQ-001\` | TODO: exact source/test evidence | TODO: matched/partial/missing/deviated/unplanned |`,
        clauses.map((clause) => `| \`${clause}\` | \`test/value.test.mjs\`, the run reused on this source tree | matched |`).join('\n')), `Compared ${clauses.join(' and ')} against the recorded run.`));
      return true;
    }
    return false;
  };
}

// ------------------------------------------------------------------------------------ the reviewer

const REPORTS = { document: documentReport, code: (packet) => codeReport(packet), specification: specificationReport, planning: planningReport };

/** The independent reviewer's honest report for the journey's small fixtures; `findings(phase, packet)` adds its own. */
export function reviewer({ findings = null } = {}) {
  return ({ phase, packet }) => {
    const make = REPORTS[packet.kind];
    if (!make) return null;
    const extra = findings?.(phase, packet) ?? [];
    if (packet.kind === 'code') return codeReport(packet, { findings: extra });
    const report = make(packet);
    return extra.length ? { ...report, findings: [...report.findings, ...extra] } : report;
  };
}

// ------------------------------------------------------------------------------------ the person

/** The agent's one question at a step that asks, and the person's answer: the value the Story names is the one to return. */
export const clarifications = () => ({ phase }) => [{ question: `Before writing ${phase}: is the value the Story names the one every caller should read?`,
  answer: 'Yes: that value, for every caller, and nothing else changes.' }];

const wordsOf = (command) => String(command ?? '').replace(/^singularity-flow\s+/u, '').split(/\s+/u);

/**
 * A cooperative person: approves a step at their own terminal once it is submitted, says yes to a confirmation SFlow
 * asks for, and takes the recommended (else first) choice of a question. `extra` answers first when it returns one.
 */
export function cooperativePerson(extra = null) {
  return (context) => {
    const answered = extra?.(context);
    if (answered !== undefined && answered !== null) return answered;
    const { route, act, phase } = context;
    // Approval is the person's own: at their terminal, after reading the step.
    if (/^\/sf-approve\b/u.test(route.copilot ?? '') || /^singularity-flow approve\b/u.test(route.shell ?? '')) {
      const step = route.shell ? wordsOf(route.shell)[1] : route.copilot.split(/\s+/u)[1];
      return { command: `singularity-flow approve ${step && !step.startsWith('-') ? step : phase} --yes` };
    }
    // A confirmation the person read: yes, and the agent runs the confirmed command.
    if ((act?.state === 'confirm' || act?.ask?.kind === 'confirm') && route.shell) return { command: route.shell };
    // The person's own terminal step: they run it.
    if (act?.state === 'confirm-in-terminal' && route.shell && !/<[A-Z]/u.test(route.shell)) return { command: route.shell, agent: false };
    // A choice: the recommended one, else the first that names a route.
    const choices = act?.ask?.choices ?? [];
    const choice = choices.find((entry) => entry.recommended && (entry.shell || entry.copilot)) ?? choices.find((entry) => entry.shell || entry.copilot);
    if (choice) return { route: { shell: choice.shell ?? null, copilot: choice.copilot ?? null } };
    return null;
  };
}

/**
 * The person's scope answers for the step that defines the Story's scope: each statement of the Story's sources is
 * included through `clause`, by the CLI's own scope decision (the route the approval's refusal names).
 */
export function scopeAnswers(story, clause, reason = 'The specification states it in this clause.') {
  const scope = JSON.parse(story.cli('evidence', 'scope', '--json')).data.scope;
  return (scope.items ?? []).filter((entry) => entry.disposition === 'unresolved')
    .map((item) => `singularity-flow decision scope ${story.workId} --item ${item.id} --as included --clause ${clause} --reason "${reason}"`);
}

/** The person's answer on the decisions card: each listed item's recommended option, with their reason, confirmed. */
export function decideCard(story, { reason = 'The person chose this on the decisions card.', choose = null } = {}) {
  const listed = JSON.parse(story.cli('decisions', story.workId, '--json')).data;
  const picks = [];
  for (const item of listed.items ?? []) {
    if (['approval', 'approval-hold'].includes(item.kind)) continue;
    const option = choose?.(item) ?? item.options?.find((entry) => entry.recommended) ?? item.options?.[0];
    if (option) picks.push([item.id, option.id]);
  }
  if (!picks.length) return null;
  return { command: ['singularity-flow decisions record', story.workId, ...picks.flatMap(([id, option]) => ['--choose', `${id}=${option}`, '--reason', `"${id}=${reason}"`]),
    '--confirm', listed.packetSha256].join(' '), items: picks,
    // The same answers as the card itself records them: its own command reads them from a file (decisions record --answers).
    card: { choose: Object.fromEntries(picks), reason: Object.fromEntries(picks.map(([id]) => [id, reason])), confirm: listed.packetSha256 } };
}


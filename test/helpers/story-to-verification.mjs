/**
 * A spec-driven Story walked on the real CLI up to its Verification step: one real `npm test` run at
 * Implementation, on code that then does not change. `untested` leaves that clause with no test delivered. `review`,
 * when given, reviews each published step before it is submitted (a walk with reviews on).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { approvedSpecificationStory, implementationPlan } from './submitted-planning-story.mjs';

export async function storyAtVerification(t, WORK, { untested = null, configure = null, review = null } = {}) {
  const story = await approvedSpecificationStory(t, WORK, { review, configure: (configuration) => {
    configuration.workTypes['spec-driven-standard'].spec.coverage = 'record';
    configure?.(configuration);
  } });
  const { root, cli, item } = story;
  const write = async (relative, text) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  };
  cli('prepare', 'planning');
  // The plan binds the clause to a test nobody delivers: the question convergence asks.
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), untested
    ? implementationPlan(WORK).replace(`| \`${untested}\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, `| \`${untested}\` | \`src/value.mjs\` | \`test/second.test.mjs\` |`)
    : implementationPlan(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  await review?.('planning', { cli, root });
  cli('submit', 'planning', '--skip-checks'); cli('approve', 'planning', '--yes');
  cli('prepare', 'implementation');
  const clauses = [`${WORK}:AC-001`, `${WORK}:REQ-002`];
  await write('src/value.mjs', `${clauses.map((clause) => `// @clause:${clause} returns the approved value to its callers\n`).join('')}export const value = 1;\n`);
  await write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n${clauses.filter((clause) => clause !== untested).map((clause) => `// @ac:${clause}\n`).join('')}test('value', () => assert.equal(value, 1));\n`);
  await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), ['# Implementation summary', '', '## Agent brief', '',
    'Added the value module; both clauses have one focused test that reads the approved value and proves it.', '',
    '## Changed components and decisions', '', '- `src/value.mjs` exports the approved value.', '',
    '## Tests and operational notes', '', '`test/value.test.mjs` verifies the value, and nothing else changes for anyone who reads it.', ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/implementation/operator-notes.md'), ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  await review?.('implementation', { cli, root });
  cli('submit', 'implementation'); cli('approve', 'implementation', '--yes');
  cli('prepare', 'convergence');
  if (untested) {
    for (const entry of JSON.parse(cli('story', 'adjudications', '--json').stdout).items) cli('story', 'adjudicate', entry.id, '--disposition', 'deferred', '--reason', 'The person keeps this for a later Story.');
    cli('prepare', 'convergence');
  }
  cli('phase', 'publish', 'convergence', '--authored', 'deterministic', '--channel', 'kernel-generator');
  // A person reads no digest; the preview's JSON carries the one the confirmation binds.
  const digest = JSON.parse(cli('story', 'advance', '--work-id', WORK, '--json').stdout).confirmationDigest;
  cli('story', 'advance', '--work-id', WORK, '--confirm', digest);
  cli('approve', 'convergence', '--yes');
  cli('prepare', 'verification');
  return { ...story, write, clauses };
}

/** Verification's document, as an author who read what the entry gave them writes it. */
export async function writeVerificationEvidence(story) {
  const file = path.join(story.item, 'artifacts/verification/test-evidence.md');
  const text = (await readFile(file, 'utf8')).replace(/TODO:[^\n]*/gu, `${story.clauses.join(' and ')} are covered by \`test/value.test.mjs\` and \`src/value.mjs\`, on the run the entry names.`);
  await writeFile(file, text);
  story.cli('artifact', 'scan', '--phase', 'verification');
}

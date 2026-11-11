/**
 * CQF M2: a code step's departure from an earlier document's wording [CQF:REQ-025, REQ-027], through the
 * real CLI. The model never edits the approved design; it records the change as a draft copy, and the
 * person's acceptance on the decision list makes the design's next generation, whose origin names it.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { cli, repository } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

/** Scope and plan, then a design that reads them, then the code step that reads both. */
async function designed(t) {
  const repo = await repository(t, { implementCommands: false });
  const configPath = path.join(repo.root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  const quick = config.workTypes['quick-fix'];
  const { verify, ...templates } = quick.templateOverrides;
  const { verify: verifyOverride, ...overrides } = quick.phaseOverrides;
  config.workTypes['quick-design'] = { ...structuredClone(quick), label: 'Quick fix with a design', phases: ['intake', 'design', 'implement'], templateOverrides: templates,
    phaseOverrides: { ...structuredClone(overrides),
      design: { inputs: ['intake'], clarification: { mode: 'off' }, approval: { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake', 'design'] } },
      implement: { inputs: ['intake', 'design'], approval: { mode: 'required', authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake', 'design', 'implement'] } } },
    omits: [{ responsibility: 'verify', reason: 'This fixture walks a design departure and has no verification step.', authority: 'quality-reviewers' }] };
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  repo.must('git', ['add', 'singularity/workflow.yml']);
  repo.must('git', ['commit', '-q', '-m', 'A design step between scope and code']);
  repo.must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
  repo.must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
  repo.must('git', ['push', '-q', '-u', 'origin', 'main']);
  repo.sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-design', '--title', 'Change the value', '--description', 'Return 2.');
  const item = path.join(repo.root, 'singularity/work-items/QF-1');
  repo.sflow('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    '# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  repo.sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  repo.sflow('submit', 'intake');
  repo.sflow('approve', 'intake', '--yes');
  repo.sflow('resume', 'QF-1');
  repo.sflow('prepare', 'design');
  const design = path.join(item, 'artifacts/design/design.md');
  await writeFile(design, (await readFile(design, 'utf8')).replace(/TODO:[^\n]*/gu,
    'The value module exports one constant that every caller reads directly, so no caller keeps its own copy of it.'));
  repo.sflow('phase', 'publish', 'design', '--authored', 'human', '--channel', 'manual-in-place');
  repo.sflow('submit', 'design');
  repo.sflow('approve', 'design', '--yes');
  repo.sflow('resume', 'QF-1');
  repo.sflow('prepare', 'implement');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
  return { repo, item, design };
}

const state = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));

test('a wording departure is a draft copy, accepted as the design\'s next generation that names it, and its old approval reads as amended', slowLane({ timeout: 900_000 }), async (t) => {
  const { repo, item, design } = await designed(t);
  const approved = await readFile(design, 'utf8');
  const record = (...args) => repo.run(process.execPath, [cli, '--no-model', 'departure', 'record', ...args, '--json']);
  // The approved document itself is never the draft.
  const refused = record('--kind', 'wording', '--target', 'design', '--file', 'singularity/work-items/QF-1/artifacts/design/design.md',
    '--reason', 'Callers may keep a copy for the length of one request.');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /DEPARTURE_NOT_ALLOWED/u);
  const draft = path.join(repo.root, 'design-draft.md');
  await writeFile(draft, approved.replace('so no caller keeps its own copy of it', 'and a caller may keep a copy for the length of one request'));
  const recorded = record('--kind', 'wording', '--target', 'design', '--file', 'design-draft.md',
    '--reason', 'The code keeps a copy for one request, so the design must say callers may.');
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  let workflow = await state(item);
  const [departure] = workflow.departures;
  assert.equal(departure.kind, 'wording');
  assert.deepEqual([departure.target.phase, departure.target.generation], ['design', 1]);
  assert.match(departure.diff, /\+.*a caller may keep a copy/u);
  assert.equal(await readFile(design, 'utf8'), approved, 'the approved design is untouched');
  assert.match(await readFile(path.join(repo.root, departure.proposal.path), 'utf8'), /a caller may keep a copy/u, 'the draft is saved with the record');
  await assert.rejects(readFile(draft), { code: 'ENOENT' }, 'and leaves the checkout, so it is no departure of its own');

  // Decided on the list while the code step is open: one row, Accept all covers wording that names no clause.
  const packet = repo.sflowJson('decisions', 'QF-1').value.data;
  const row = packet.items.find((entry) => entry.kind === 'departure');
  assert.equal(row.details.acceptAll, true);
  assert.match(row.details.diff, /a caller may keep a copy/u);
  const answers = path.join(repo.base, 'answers.json');
  await writeFile(answers, JSON.stringify({ choose: { [row.id]: 'accept' }, reason: { [row.id]: 'The design now says what the code does, which is right.' }, confirm: packet.packetSha256 }));
  const decided = repo.sflowJson('decisions', 'record', 'QF-1', '--answers', answers);
  assert.equal(decided.status, 0, JSON.stringify(decided.value));
  workflow = await state(item);
  const amended = workflow.phases.design;
  assert.equal(amended.status, 'approved');
  assert.equal(amended.generation, 2, 'a new generation of the design');
  const origin = amended.generationPublications.find((entry) => entry.generation === 2).origin;
  assert.deepEqual([origin.kind, origin.departure], ['forward-amendment', 'DEP-001']);
  assert.equal(workflow.forwardAmendments[0].departure, 'DEP-001');
  assert.match(await readFile(design, 'utf8'), /a caller may keep a copy/u);
  const shown = repo.sflowJson('departure', 'show', 'DEP-001').value.data;
  assert.equal(shown.departure.status, 'accepted');
  assert.deepEqual(shown.amended, [{ phase: 'design', generation: 2, amendedGeneration: 1, amendment: 'FAM-001' }]);

  // The code step reads the amended design and is approved with nothing left to decide.
  const published = repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.equal(published.status, 0, JSON.stringify(published.value));
  // The fixture's own ending: its omitted verification step is decided as not applying.
  repo.sflow('decision', 'applicability', '--responsibility', 'verify', '--reason', 'This fixture walks a design departure and has no verification step.');
  repo.sflow('submit', 'implement');
  const approval = repo.run(process.execPath, [cli, '--no-model', 'approve', 'implement', '--work-id', 'QF-1', '--yes', '--json']);
  assert.equal(approval.status, 0, approval.stdout + approval.stderr);
  assert.equal((await state(item)).phases.implement.status, 'approved');
});

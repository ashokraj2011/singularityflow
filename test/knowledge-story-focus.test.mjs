/**
 * The Repository brief, focused on the Story and placed where it helps [WMR:REQ-007–015], on fixtures:
 * the plan's files lead (A2), a large repository reads the Story's scope and planned areas (A3), the brief is left
 * out of intake, verification and release unless a team turns it back on (A4), a step's intent picks its reader (A5),
 * a step's next version reuses its brief (A6), calls matched by name are never stated as facts (A7), and before a
 * plan exists the Story's words name the files they match, read split at case changes (A8, §11). §11's follow-ups (F1–F3):
 * a component whose parameters span lines is a function (F1), a folder over the area cap is read in the part the Story
 * needs and says less (F2), and the files a Story's words name choose areas too (F3).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { phaseRepositoryBrief } from '../src/phase-prompt-composer.mjs';
import { phaseBriefProfile } from '../src/knowledge/phase-brief.mjs';
import { phaseBriefPlacement, repositoryBriefPrompt } from '../src/knowledge/prompt.mjs';
import { buildImpactRecords } from '../src/knowledge/records/impact.mjs';
import { buildKnowledge } from '../src/knowledge/store.mjs';
import { recordKnowledge } from '../src/knowledge.mjs';
import { phaseLessons } from '../src/story-lessons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(t, name, { files = {} } = {}) {
  const repository = await mkdtemp(path.join(os.tmpdir(), `sflow-story-focus-${name}-`));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', name), repository, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repository, file)), { recursive: true });
    await writeFile(path.join(repository, file), text);
  }
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'Fixture');
  return repository;
}

const PLAN = `# Implementation plan — GRAPH-1

## Affected surfaces

| Surface | Change | Serves |
|---|---|---|
| \`src/FunctionGrapher.jsx\` | Plot the entered function on a grid. | [GRAPH-1:REQ-001] |
| \`src/App.jsx\` | Keep the grapher mode in the calculator shell. | [GRAPH-1:REQ-002] |
| \`src/graph/plot.js\` | Sample a function into points (a new file). | [GRAPH-1:REQ-001] |
`;

/** A spec-driven Story with an approved plan, as compose reads it. */
function graphStory({ intents = true } = {}) {
  const definition = { worldModel: {}, phases: intents ? { planning: { intent: 'plan' }, implementation: { intent: 'code' } } : {} };
  const workflow = {
    workItem: { id: 'GRAPH-1', title: 'Plot a function on a graph', description: 'Enter y = f(x) and see its curve.', baseCommit: null },
    phaseOrder: ['specification', 'planning', 'implementation', 'verification', 'release'],
    phases: {
      specification: { id: 'specification', status: 'approved', generation: 1, requiredArtifact: { path: 'artifacts/specification/spec.md', kind: 'document' } },
      planning: { id: 'planning', status: 'approved', generation: 1, requiredArtifact: { path: 'artifacts/planning/plan.md', kind: 'document' } },
      implementation: { id: 'implementation', status: 'in_progress', generation: 0, requiredArtifact: { path: 'artifacts/implementation/summary.md', kind: 'implementation-summary' } },
      verification: { id: 'verification', status: 'pending', generation: 0, requiredArtifact: { path: 'artifacts/verification/report.md', kind: 'test-evidence' } },
      release: { id: 'release', status: 'pending', generation: 0, requiredArtifact: { path: 'artifacts/release/review.md', kind: 'conformance-report' } }
    },
    resolution: { obligationGraph: { nodes: [{ id: 'planning', responsibilities: ['plan'] }] } }
  };
  return { definition, workflow };
}

test('A2: the plan\'s file table leads: a plan brief and the first code brief name src/FunctionGrapher.jsx, and a new planned file [WMR:REQ-007]', async (t) => {
  const repository = await fixture(t, 'graph-calc', { files: { 'singularity/work-items/GRAPH-1/artifacts/planning/plan.md': PLAN } });
  const { definition, workflow } = graphStory();
  for (const phase of ['planning', 'implementation']) {
    const brief = await phaseRepositoryBrief(repository, { definition, workflow, phase, changedPaths: [], polish: 'off' });
    assert.match(brief.text, /^## What a change touches$/mu, `${phase}: the plan's files have their section`);
    assert.match(brief.text, /^- src\/FunctionGrapher\.jsx \(planned\)/mu, `${phase} names the file the plan names first`);
    assert.match(brief.text, /^- src\/graph\/plot\.js \(new, planned\)$/mu, `${phase} lists the new file the plan names`);
    assert.deepEqual(brief.likelyPaths, [], `${phase}: with a plan, no file is guessed for the lessons`);
  }
});

test('A2: a planned file is listed even when nothing else is known of it; a planned file that does not exist yet is "(new, planned)" [WMR:REQ-007]', async (t) => {
  const repository = await fixture(t, 'graph-calc');
  const { knowledge } = await buildKnowledge(repository, { history: false });
  // The owner's graph Stories: the grapher's only importer, App.jsx, was planned too, so its record had nothing to say and was dropped.
  const records = buildImpactRecords(knowledge, { plannedPaths: ['src/App.jsx', 'src/FunctionGrapher.jsx'], newPaths: ['src/graph/plot.js'] });
  assert.deepEqual(records.filter((record) => record.state !== 'changed').map((record) => record.parts.path),
    ['src/App.jsx', 'src/FunctionGrapher.jsx', 'src/graph/plot.js']);
  assert.match(records.find((record) => record.parts.path === 'src/FunctionGrapher.jsx').text, /^src\/FunctionGrapher\.jsx \(planned\): defines FunctionGrapher$/u);
  assert.equal(records.find((record) => record.parts.path === 'src/graph/plot.js').text, 'src/graph/plot.js (new, planned)');
});

test('A3: above the file limit, a capability Story\'s brief reads its planned areas, inside its own folders only [WMR:REQ-008, REQ-009]', async (t) => {
  const files = {};
  for (const area of ['apps/payments/refunds', 'apps/payments/ledger', 'apps/catalog/search']) {
    for (const n of [1, 2, 3]) files[`${area}/part${n}.js`] = `export function ${area.split('/').pop()}Part${n}(amount) {\n  if (amount <= 0) return 0;\n  return amount * ${n};\n}\n`;
  }
  const repository = await fixture(t, 'graph-calc', { files });
  const limits = { maximumCodeFiles: 4, maximumFileBytes: 512 * 1024, maximumTotalBytes: 48 * 1024 * 1024 };
  // Words that name no folder: only the plan can point at an area.
  const story = { workItem: { title: 'Cap what is paid back', description: 'Never more than was paid.' } };
  // The capability's scope, as compose applies it from the Story's pinned configuration.
  const scope = { sourceRoots: ['apps/payments'], sharedRoots: [], excludedRoots: [] };
  const before = await repositoryBriefPrompt(repository, { definition: null, phase: 'implementation-spec', workflow: story, limits, scope, polish: 'off' });
  assert.equal(before.text, '', 'no planned file and no matching folder name: no area is guessed');
  const brief = await repositoryBriefPrompt(repository, { definition: null, phase: 'implementation-spec', workflow: story, limits, scope,
    plannedPaths: ['apps/payments/ledger/part2.js'], polish: 'off' });
  assert.notEqual(brief.text, '', 'the planned file\'s area is read');
  assert.match(brief.text, /apps\/payments\/ledger\/part2\.js \(planned\)/u);
  assert.doesNotMatch(brief.text, /catalog|searchPart|FunctionGrapher|App\.jsx/u, 'nothing outside the capability\'s folders');
});

test('A4: the brief is left out of intake, verification and release by default, says why, and a team turns it back on [WMR:REQ-011]', async (t) => {
  const repository = await fixture(t, 'shop');
  const feature = {
    workItem: { id: 'WORK-9', title: 'Change the free shipping threshold', baseCommit: null },
    phaseOrder: ['intake', 'requirements', 'design', 'implementation-spec', 'implementation', 'verification', 'conformance'],
    phases: Object.fromEntries([['intake', 'intake'], ['requirements', 'requirements'], ['design', 'design'], ['implementation-spec', 'implementation-spec'],
      ['implementation', 'implementation-summary'], ['verification', 'test-evidence'], ['conformance', 'conformance-report']]
      .map(([id, kind]) => [id, { id, status: 'pending', generation: 0, requiredArtifact: { path: `artifacts/${id}.md`, kind } }])),
    resolution: {}
  };
  const definition = { worldModel: {} };
  const brief = (phase, workflow = feature, settings = definition) => phaseRepositoryBrief(repository, { definition: settings, workflow, phase, changedPaths: [], polish: 'off' });
  for (const phase of ['intake', 'requirements', 'verification', 'conformance']) {
    const left = await brief(phase);
    assert.equal(left.text, '', `${phase} carries no brief`);
    assert.equal(left.reasonCode, 'BRIEF_NOT_FOR_THIS_STEP', `${phase} says why`);
  }
  for (const phase of ['design', 'implementation-spec', 'implementation']) assert.match((await brief(phase)).text, /^# Repository brief: /u, `${phase} carries one`);
  // A work type that wants it everywhere, and one step brought back by the repository's own setting.
  const on = await brief('intake', { ...feature, resolution: { intelligence: { worldModel: 'on' } } });
  assert.match(on.text, /^# Repository brief: .* \(for intake/u, 'intelligence.worldModel: on brings intake\'s back');
  const step = await brief('verification', feature, { worldModel: { knowledge: { prompt: { verification: 'slice' } } } });
  assert.match(step.text, /\(for verification/u, 'worldModel.knowledge.prompt names one step');
  const off = await brief('design', feature, { worldModel: { knowledge: { prompt: { design: 'off' } } } });
  assert.equal(off.reasonCode, 'BRIEF_NOT_FOR_THIS_STEP', 'and can leave one out');
  assert.deepEqual(phaseBriefPlacement({ definition, workflow: feature, phase: 'intake' }).included, false);
});

test('A5: a step\'s intent picks the reader: a review task\'s design step gets the reviewer\'s brief [WMR:REQ-012]', () => {
  const task = (kind) => ({ workItem: { id: 'TASK-1' }, phaseOrder: ['intake', 'design'], phases: { intake: { id: 'intake' }, design: { id: 'design', requiredArtifact: { kind: 'design' } } },
    resolution: { composition: { kind, steps: [{ id: 'intake', intent: 'intake' }, { id: 'design', intent: 'design' }] } } });
  const placement = (kind) => phaseBriefPlacement({ definition: {}, workflow: task(kind), phase: 'design' });
  const review = placement('review');
  assert.deepEqual([review.profile.id, review.profile.reader, review.included], ['review', 'reviewer', true]);
  assert.deepEqual(review.profile.order, ['rules', 'risks', 'impact', 'contracts'], 'rules, risks, what the change touches, then contracts');
  assert.deepEqual([placement('investigate').profile.reader, placement('docs').profile.reader, placement('feature').profile.reader], ['developer', 'product', 'architect']);
  assert.equal(placement('docs').included, true, 'a docs task\'s design step keeps its brief: it is a design step');
  // A marketplace agent's own step IDs use their intent instead of falling to the catch-all.
  assert.equal(phaseBriefProfile('assess-the-change', { intent: 'test' }).id, 'verification');
  assert.equal(phaseBriefProfile('assess-the-change').id, 'implementation');
  // The output kind still comes first, and no step is profiled as a reviewer by its name.
  assert.equal(phaseBriefProfile('code-review', { kind: 'implementation-summary', intent: 'review' }).id, 'implementation');
  assert.notEqual(phaseBriefProfile('code-review').id, 'review');
});

test('A6: a step\'s next version with no new changed file reuses its brief; a changed file composes it again [WMR:REQ-013]', async (t) => {
  const repository = await fixture(t, 'shop');
  const workflow = { workItem: { id: 'WORK-3', title: 'Change the free shipping threshold', baseCommit: null },
    phaseOrder: ['implementation'], phases: { implementation: { id: 'implementation', requiredArtifact: { kind: 'implementation-summary' } } }, resolution: {} };
  const compose = () => phaseRepositoryBrief(repository, { definition: { worldModel: {} }, workflow, phase: 'implementation', changedPaths: ['src/rules/pricing.ts'], polish: 'cached', remember: true });
  const analysis = path.join(repository, '.git', 'singularity-flow', 'knowledge');
  const first = await compose();
  assert.match(first.text, /^# Repository brief: /u);
  assert.equal(first.receipt.reused, undefined);
  // Nothing is composed again: the analysis is not even read.
  for (const name of await readdir(analysis)) if (/^[0-9a-f]{64}\.json$/u.test(name)) await rm(path.join(analysis, name));
  const second = await compose();
  assert.equal(second.text, first.text);
  assert.equal(second.receipt.reused?.key, first.receipt.reuseKey, 'the receipt records the reuse');
  assert.deepEqual((await readdir(analysis)).filter((name) => /^[0-9a-f]{64}\.json$/u.test(name)), [], 'nothing was analysed');
  await appendFile(path.join(repository, 'src', 'rules', 'pricing.ts'), '\n// the Story changes this file\n');
  const third = await compose();
  assert.equal(third.receipt.reused, undefined, 'a changed file composes the brief again');
});

const NAME_MATCHED_CLAIMS = /called from|called by|reached by|no test reaches|tested by|tested through|→ playSound|→ getAudioContext/u;

test('A7: with calls matched by name only, no brief states reach, callers or tests, and no question rests on them [WMR:REQ-014, REQ-015]', async (t) => {
  const repository = await fixture(t, 'graph-calc');
  const story = { workItem: { title: 'Play a sound when a plot fails', description: 'playSound on an invalid function.' } };
  for (const phase of ['intake', 'design', 'implementation-spec', 'implementation', 'verification']) {
    const brief = await repositoryBriefPrompt(repository, { definition: null, phase, workflow: story, changedPaths: ['src/utils/audio.js'], polish: 'off' });
    assert.doesNotMatch(brief.text, NAME_MATCHED_CLAIMS, `${phase}:\n${brief.text}`);
    assert.doesNotMatch(brief.text, /## Questions for the product owner[^#]*no test/u);
    assert.equal((brief.text.match(/calls are matched by name/gu) ?? []).length <= 1, true, 'said once at most');
  }
  // With resolved calls the claims come back, as they were.
  const resolved = await repositoryBriefPrompt(repository, { definition: null, phase: 'design', workflow: story, changedPaths: ['src/utils/audio.js'], polish: 'off', trustCalls: () => true });
  assert.match(resolved.text, /called from \d+ places|reached by \d+ entry point/u);
});

/** The owner's graph Stories' planning step, as they pinned it: it writes a design document, has no intent and no plan yet. */
function planningStory(title) {
  return {
    workItem: { id: 'GRAPH-2', title, baseCommit: null },
    phaseOrder: ['specification', 'planning', 'implementation'],
    phases: {
      specification: { id: 'specification', status: 'approved', generation: 1, requiredArtifact: { path: 'artifacts/specification/spec.md', kind: 'document' } },
      planning: { id: 'planning', status: 'in_progress', generation: 1, requiredArtifact: { path: 'artifacts/planning/plan.md', kind: 'design' } },
      implementation: { id: 'implementation', status: 'pending', generation: 0, requiredArtifact: { path: 'artifacts/implementation/summary.md', kind: 'implementation-summary' } }
    },
    resolution: {}
  };
}

test('A8: Story words and code names are read alike, split at case changes and with "-er" folded, on both sides [WMR:§11]', async () => {
  const { splitCase, subjectWords } = await import('../src/knowledge/records/anchors.mjs');
  assert.deepEqual([...subjectWords('src/components/FunctionGrapher.jsx')], ['src', 'component', 'function', 'graph', 'jsx']);
  assert.deepEqual([...subjectWords('plotter plots plotting')], ['plot'], 'the one who plots meets the plot');
  assert.deepEqual([...subjectWords('renderer renders rendered')], ['rend'], 'folded again until it stops');
  assert.equal(splitCase('parseHTTPRequest'), 'parse HTTP Request', 'an acronym is a word of its own');
  // Short words keep their "-er": "order" and "user" are not cut.
  assert.deepEqual([...subjectWords('order orders user')], ['order', 'user']);
});

test('A8: before its plan exists, a planning step that writes a design document names the file its Story\'s words name [WMR:§11]', async (t) => {
  const repository = await fixture(t, 'graph-calc');
  const workflow = planningStory('graph');
  const brief = await phaseRepositoryBrief(repository, { definition: { worldModel: {} }, workflow, phase: 'planning', changedPaths: [], polish: 'off' });
  // The owner's planning steps get the architect's brief: the document kind they pinned comes first (REQ-012).
  assert.equal(brief.profile, 'design');
  assert.match(brief.text, /^## What a change touches\n- src\/FunctionGrapher\.jsx \(name matches the Story's words\)/mu, brief.text);
  // The same guess is handed to the lessons the step is given [LRN:REQ-008].
  assert.deepEqual(brief.likelyPaths, ['src/FunctionGrapher.jsx']);
  // A Story whose words name no file: the architect is given no list of the code's busiest functions in its place.
  const none = await phaseRepositoryBrief(repository, { definition: { worldModel: {} }, workflow: planningStory('bimary'), phase: 'planning', changedPaths: [], polish: 'off' });
  assert.match(none.text, /^# Repository brief: /u);
  assert.doesNotMatch(none.text, /## What a change touches/u, none.text);
  assert.deepEqual(none.likelyPaths, []);
  // A developer's brief keeps what depends on the functions the Story names, as before.
  const code = await repositoryBriefPrompt(repository, { definition: null, phase: 'implementation', workflow: planningStory('bimary'), polish: 'off' });
  assert.match(code.text, /## What a change touches/u);
});

test('A8: before its plan exists, a planning step is given the lessons for the file its Story\'s words name, marked as a guess [LRN:REQ-008]', async (t) => {
  const repository = await fixture(t, 'graph-calc');
  await recordKnowledge(repository, { type: 'gotcha', text: 'The grapher redraws on every keystroke; debounce the input first.',
    provenance: [{ workId: 'GRAPH-1', artifact: 'artifacts/implementation/summary.md', sha256: 'a'.repeat(64), approvedRevision: 1 }],
    scope: { paths: ['src/FunctionGrapher.jsx'] }, approvedSourceVerified: true });
  const workflow = planningStory('graph');
  // What compose does: the brief first, then the lessons for the files it guessed (phase-prompt-composer.mjs).
  const brief = await phaseRepositoryBrief(repository, { definition: { worldModel: {} }, workflow, phase: 'planning', changedPaths: [], polish: 'off' });
  const given = await phaseLessons(repository, { workflow, phase: 'planning', paths: [], likelyPaths: brief.likelyPaths });
  assert.deepEqual(given.chosen.map(({ record }) => record.text), ['The grapher redraws on every keystroke; debounce the input first.']);
  assert.match(given.text, /no plan yet: these are for the files its words name \(src\/FunctionGrapher\.jsx\)/u);
  // A Story whose words name no file is given no lesson about one.
  const none = await phaseRepositoryBrief(repository, { definition: { worldModel: {} }, workflow: planningStory('bimary'), phase: 'planning', changedPaths: [], polish: 'off' });
  assert.equal((await phaseLessons(repository, { workflow: planningStory('bimary'), phase: 'planning', paths: [], likelyPaths: none.likelyPaths })).chosen.length, 0);
});

test('A8: once there is a plan or a change, its files lead and no file is listed for its name alone [WMR:§11, REQ-007]', async (t) => {
  const repository = await fixture(t, 'graph-calc');
  const { knowledge } = await buildKnowledge(repository, { history: false });
  const named = buildImpactRecords(knowledge, { focus: 'Plot a graph' });
  assert.deepEqual(named.map((record) => [record.state, record.parts.path]), [['named', 'src/FunctionGrapher.jsx']]);
  assert.equal(buildImpactRecords(knowledge, { focus: 'Plot a graph', plannedPaths: ['src/App.jsx'] }).some((record) => record.state === 'named'), false);
  assert.deepEqual(buildImpactRecords(knowledge, { focus: 'Test the evaluator' }).map((record) => record.parts.path), ['src/utils/evaluator.js'],
    'its test file is never listed for its name');
  assert.deepEqual(buildImpactRecords(knowledge, { focus: 'unrelated words' }), []);
});

test('A8: a large repository\'s areas are chosen by folder names split at case changes too [WMR:§11, REQ-008]', async () => {
  const { selectKnowledgeAreas } = await import('../src/knowledge/store.mjs');
  const areas = [{ path: 'src/featureFlags', files: 9 }, { path: 'src/billing', files: 9 }];
  assert.deepEqual(selectKnowledgeAreas(areas, { focus: 'Turn the new flags on' }).map((area) => area.path), ['src/featureFlags']);
  assert.deepEqual(selectKnowledgeAreas(areas, { focus: 'Change the FeatureFlags default' }).map((area) => area.path), ['src/featureFlags']);
});

test('F1: a component whose parameters span lines is a function: its name, its lines, what it calls and a change inside it [WMR:§11]', async (t) => {
  const repository = await fixture(t, 'react-props');
  const { knowledge } = await buildKnowledge(repository, { history: false });
  const span = (name) => knowledge.graph.functions.filter((fn) => fn.qualifiedName === name).map((fn) => [fn.file, fn.start, fn.end]);
  // `export const Display = ({\n  value,\n …}) => {` and a typed one whose body is in parentheses.
  assert.deepEqual(span('Display'), [['src/components/Display.jsx', 4, 19]]);
  assert.deepEqual(span('Gauge'), [['src/components/Gauge.tsx', 6, 13]]);
  assert.deepEqual(knowledge.graph.calls.filter(([, to]) => to === 'formatReading').map(([from]) => from).sort(), ['Display', 'Gauge']);
  // A changed line inside the component is read as a change to it, and its helper's callers are the components.
  const changedRanges = new Map([['src/components/Display.jsx', [[10, 10]]], ['src/utils/format.js', [[3, 3]]]]);
  const records = buildImpactRecords(knowledge, { changedPaths: ['src/components/Display.jsx', 'src/utils/format.js'], changedRanges });
  const display = records.find((record) => record.parts.symbol === 'Display');
  assert.equal(display?.state, 'changed');
  assert.equal(display.sources.code[0].line, 4);
  assert.deepEqual(records.find((record) => record.parts.symbol === 'formatReading')?.parts.callers, ['Display', 'Gauge']);
});

/** A flat folder of eight files, as SFlow's own src/ is at a larger size: one planned file, two that import it, five others. */
function flatFolder() {
  const files = {
    'lib/core.js': 'export function settle(amount) {\n  if (amount < 0) throw new Error(\'amount must not be negative\');\n  if (amount > 500) return 500;\n  return amount;\n}\n',
    'lib/refunds.js': 'import { settle } from \'./core.js\';\n\nexport function refund(amount) {\n  return settle(amount);\n}\n',
    'lib/payouts.js': 'import { settle } from \'./core.js\';\n\nexport function payout(amount) {\n  return settle(amount) * 2;\n}\n'
  };
  for (const name of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) {
    files[`lib/${name}.js`] = `export function ${name}Total(count) {\n  if (count > 9000) throw new Error('too many');\n  for (let i = 0; i < count; i += 1) { if (i % 7 === 0) count += 1; }\n  return count;\n}\n`;
  }
  return files;
}

// Too large to build whole (the fixture and the folder hold 27 code files), with room for the eight-file folder.
const LARGE = { maximumCodeFiles: 12, maximumFileBytes: 512 * 1024, maximumTotalBytes: 48 * 1024 * 1024 };

test('F2: a folder over the area cap is read in the part the Story needs, and its brief says so and says less [WMR:§11]', async (t) => {
  const repository = await fixture(t, 'graph-calc', { files: flatFolder() });
  const story = { workItem: { title: 'Cap a settled amount', description: 'Never settle more than was asked.' } };
  const options = { definition: null, phase: 'implementation-spec', workflow: story, plannedPaths: ['lib/core.js'], polish: 'off', trustCalls: () => true };
  // Read whole (the cap above the folder's eight files): with resolved calls the folder-wide claims are made.
  const whole = await repositoryBriefPrompt(repository, { ...options, limits: { ...LARGE, maximumAreaFiles: 100 } });
  assert.match(whole.text, /lib\/core\.js \(planned\): imported by 2 files; 2 rules; no test reaches it/u, whole.text);
  assert.doesNotMatch(whole.text, /only part of/u);
  // Over the cap: the planned file, the two files that import it, and nothing else of the folder.
  const brief = await repositoryBriefPrompt(repository, { ...options, limits: { ...LARGE, maximumAreaFiles: 4 } });
  assert.match(brief.text, /only part of a large folder was read \(3 of the 8 code files under `lib\/`: this Story's files and the files they import or that import them\)/u, brief.text);
  // Who imports the planned file is read from the whole folder, so its count stays; reach, callers and comparisons go.
  assert.match(brief.text, /lib\/core\.js \(planned\): imported by 2 files; 2 rules/u);
  assert.doesNotMatch(brief.text, /no test reaches it|called by|called from|reached by|the most complex|tested through/u, brief.text);
  assert.doesNotMatch(brief.text, /alphaTotal|bravoTotal|lib\/alpha\.js/u, 'a file the Story does not reach is not read');
  // An area over the cap holding none of the Story's files is not read at all.
  const none = await repositoryBriefPrompt(repository, { definition: null, phase: 'implementation-spec', workflow: { workItem: { title: 'Tidy the lib folder' } },
    polish: 'off', limits: { ...LARGE, maximumAreaFiles: 4 } });
  assert.equal(none.text, '', none.text);
  const { buildKnowledge: build } = await import('../src/knowledge/store.mjs');
  const skipped = await build(repository, { area: 'lib', limits: { ...LARGE, maximumAreaFiles: 4 }, storyPaths: [], history: false });
  assert.deepEqual([skipped.status, skipped.reason], ['insufficient', 'area-too-large']);
  // The lines count too: a folder of few files but many lines is read in part the same way.
  const byLines = await build(repository, { area: 'lib', limits: { ...LARGE, maximumAreaFiles: 100, maximumAreaLines: 20 }, storyPaths: ['lib/core.js'], history: false });
  assert.deepEqual([byLines.knowledge.repository.part.read, byLines.knowledge.repository.part.files], [3, 8]);
  assert.deepEqual(byLines.knowledge.repository.part.importers, { 'lib/core.js': ['lib/payouts.js', 'lib/refunds.js'] });
  // Without a Story's files (`wm knowledge build --area lib`), a folder is read whole, as before.
  const asked = await build(repository, { area: 'lib', limits: { ...LARGE, maximumAreaFiles: 4 }, history: false });
  assert.equal(asked.knowledge.repository.files, 8);
  assert.equal(asked.knowledge.repository.part, undefined);
});

test('F3: in a repository too large to build whole, a planning step whose words name a file but no folder reads that file\'s area [WMR:§11, REQ-008]', async (t) => {
  const repository = await fixture(t, 'graph-calc', { files: flatFolder() });
  // "graph" names src/FunctionGrapher.jsx; no folder is called anything like it.
  const brief = await repositoryBriefPrompt(repository, { definition: { worldModel: {} }, phase: 'planning', workflow: planningStory('graph'), limits: LARGE, polish: 'off' });
  assert.equal(brief.profile, 'design');
  assert.match(brief.text, /^## What a change touches\n- src\/FunctionGrapher\.jsx \(name matches the Story's words\)/mu, brief.text);
  assert.deepEqual(brief.likelyPaths, ['src/FunctionGrapher.jsx']);
  // The same reader as the brief's: never a test, at most three, best match first.
  const { filesNamedByWords } = await import('../src/knowledge/records/impact.mjs');
  assert.deepEqual(filesNamedByWords(['src/FunctionGrapher.jsx', 'src/FunctionGrapher.test.jsx', 'test/graph-helper.js', 'src/App.jsx'], 'graph'), ['src/FunctionGrapher.jsx']);
  const { selectKnowledgeAreas } = await import('../src/knowledge/store.mjs');
  const areas = [{ path: 'src', files: 3, own: true }, { path: 'src/components', files: 8 }, { path: 'lib', files: 8 }];
  assert.deepEqual(selectKnowledgeAreas(areas, { namedPaths: ['src/FunctionGrapher.jsx'], focus: 'graph' }).map((area) => area.path), ['src']);
  // Once there is a plan, its files choose the areas; words naming files do not add more (prompt.mjs passes none).
  assert.deepEqual(selectKnowledgeAreas(areas, { plannedPaths: ['lib/core.js'], focus: 'graph' }).map((area) => area.path), ['lib']);
});

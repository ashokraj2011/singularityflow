/**
 * The real-use measure of the Repository brief [WMR:REQ-029] (scripts/world-model-v5-benchmark.mjs --real-use), on two
 * synthetic Stories of the graph-calc knowledge fixture: the test writes the kept prompts, the Story worktrees' records
 * and receipts and the Stories' branches itself. It checks the hit rate, the wrong claims (counted conservatively), the
 * steps with no brief and why, the briefs identical across Stories once the header is removed, that the measure reads
 * nothing outside its input folder (run under Node's permission model), and the replay: today's briefs re-composed on
 * a scratch clone from each step's own commit, measured the same way, with nothing written outside that clone.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { briefBody, briefClaims, judgeClaim, measureRealUse, namedFiles, promptBrief, realUseReport } from '../scripts/world-model-v5-benchmark.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'world-model-v5-benchmark.mjs');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function write(base, files) {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(base, file)), { recursive: true });
    await writeFile(path.join(base, file), typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
  }
}

const PHASES = { specification: 'requirements', planning: 'document', implementation: 'implementation-summary', verification: 'test-evidence', release: 'conformance-report' };

function workflow(id, branch, base, statuses) {
  return {
    workItem: { id, title: 'Plot a function on a graph', description: 'Enter y = f(x) and see its curve.', branch, baseBranch: 'main', baseCommit: base },
    phaseOrder: Object.keys(PHASES),
    phases: Object.fromEntries(Object.entries(PHASES).map(([phase, kind]) => [phase, {
      id: phase, status: statuses[phase] ?? 'pending', generation: statuses[phase] === 'pending' ? 0 : 1,
      requiredArtifact: { path: `artifacts/${phase}/${phase}.md`, kind }
    }])),
    resolution: { obligationGraph: { nodes: [{ id: 'planning', responsibilities: ['plan'] }] } }
  };
}

const PLAN = `# Implementation plan — GRAPH-1

## Affected surfaces

| Surface | Change | Serves |
|---|---|---|
| \`src/FunctionGrapher.jsx\` | Plot the entered function on a grid. | [GRAPH-1:REQ-001] |
| \`src/graph/plot.js\` | Sample a function into points (a new file). | [GRAPH-1:REQ-001] |
`;

/** Twelve more calls of playSound, so "called from 2 places" is far off. */
const SOUND_BOARD = `import { playSound } from '../utils/audio.js';\n\nexport function SoundBoard({ on }) {\n${
  Array.from({ length: 12 }, (_, index) => `  playSound('key-${index}', on);`).join('\n')}\n  return null;\n}\n`;

/** A kept brief in the shape the composer wrote before WMR M2: header, sections, closing lines. */
function brief(label, commit, profile, sections) {
  return [`# Repository brief: ${label} at ${commit.slice(0, 12)} (for ${profile}, focused on this Story)`, '',
    ...Object.entries(sections).flatMap(([title, lines]) => [`## ${title}`, ...lines, '']),
    `- … 30 more: singularity-flow wm brief --phase ${profile}`, '',
    'Read without a model from the committed source. Open the cited lines before relying on a detail.'].join('\n');
}

const prompt = (text) => `# Runtime command presentation\nRun the step.\n\n# Active Story phase contract\nWrite the artifact.\n\n${text ? `${text}\n\n` : ''}# Final clarification guard\nAsk first.\n`;

/**
 * The input folder: a repository with two Story branches, the Stories' worktree folders (records and receipts only),
 * and the prompt audit with its kept prompts and an integrity key the measure must never read.
 */
async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-real-use-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const input = path.join(parent, 'input');
  const repository = path.join(input, 'repository');
  await mkdir(repository, { recursive: true });
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', 'graph-calc'), repository, { recursive: true });
  await write(repository, { 'src/components/SoundBoard.jsx': SOUND_BOARD });
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'Fixture');
  const base = git(repository, 'rev-parse', 'HEAD');
  const records = (id) => `singularity/work-items/${id}`;

  // GRAPH-1: planned in the grapher, then changes it, adds a new file and a test that names playSound.
  git(repository, 'checkout', '-q', '-b', 'graph-1');
  await write(repository, { [`${records('GRAPH-1')}/workflow.json`]: workflow('GRAPH-1', 'graph-1', base, { specification: 'approved', planning: 'in_progress' }) });
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'GRAPH-1 planning');
  const planned = git(repository, 'rev-parse', 'HEAD');
  await write(repository, {
    [`${records('GRAPH-1')}/workflow.json`]: workflow('GRAPH-1', 'graph-1', base, { specification: 'approved', planning: 'approved', implementation: 'in_progress' }),
    [`${records('GRAPH-1')}/artifacts/planning/planning.md`]: PLAN
  });
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'GRAPH-1 plan approved');
  const coding = git(repository, 'rev-parse', 'HEAD');
  const grapher = await readFile(path.join(repository, 'src/FunctionGrapher.jsx'), 'utf8');
  await write(repository, {
    'src/FunctionGrapher.jsx': grapher.replace("import * as math from 'mathjs';\n", `import * as math from 'mathjs';\n\n${
      Array.from({ length: 8 }, (_, index) => `const scale${index} = (value) => value * ${index + 1};`).join('\n')}\nconst evaluate = (expression, x) => math.evaluate(expression, { x });\n`),
    'src/graph/plot.js': 'export const plot = (f) => [-1, 0, 1].map(f);\n',
    'src/utils/audio.test.js': "import { expect, it } from 'vitest';\nimport { playSound } from './audio.js';\n\nit('stays quiet when off', () => { expect(playSound('x', false)).toBeUndefined(); });\n",
    [`${records('GRAPH-1')}/workflow.json`]: workflow('GRAPH-1', 'graph-1', base, { specification: 'approved', planning: 'approved', implementation: 'approved', verification: 'in_progress' })
  });
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'GRAPH-1 code');
  const verifying = git(repository, 'rev-parse', 'HEAD');

  // GRAPH-2: the same request; its change is in App.jsx.
  git(repository, 'checkout', '-q', '-b', 'graph-2', base);
  await write(repository, { [`${records('GRAPH-2')}/workflow.json`]: workflow('GRAPH-2', 'graph-2', base, { specification: 'in_progress' }) });
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'GRAPH-2 intake');
  const intakeTwo = git(repository, 'rev-parse', 'HEAD');
  const app = await readFile(path.join(repository, 'src/App.jsx'), 'utf8');
  await write(repository, {
    'src/App.jsx': `${app}\nexport const GRAPH_MODE = 'graph';\n`,
    [`${records('GRAPH-2')}/workflow.json`]: workflow('GRAPH-2', 'graph-2', base, { specification: 'approved', planning: 'approved', implementation: 'approved', verification: 'in_progress' })
  });
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'GRAPH-2 code');
  const codeTwo = git(repository, 'rev-parse', 'HEAD');
  git(repository, 'checkout', '-q', 'main');

  const overview = (label, commit) => [`- ${label}: 20 code files in javascriptreact (13 files), javascript (7 files); 3 entry points. (commit ${commit.slice(0, 12)})`];
  const kept = {
    intakeOne: brief('.w-one', planned, 'intake', { 'What exists': overview('.w-one', planned), 'Rules that apply': ['- calculateTip: no test reaches it (evaluator.js:16)'] }),
    intakeTwo: brief('.w-two', intakeTwo, 'intake', { 'What exists': overview('.w-two', intakeTwo), 'Rules that apply': ['- calculateTip: no test reaches it (evaluator.js:16)'] }),
    planning: brief('.w-one', planned, 'design', {
      Contracts: ['- app start → App (App.jsx:14)'],
      Flows: ['- keydown → App.handleKeyDown → playSound → getAudioContext; 2 rules on the way; writes Sound (App.jsx:20)'],
      Risks: ['- playSound: complexity 10, reached by 44 entry points, called from 2 places (audio.js:8)']
    }),
    implementation: brief('.w-one', coding, 'implementation', {
      'What a change touches': [
        '- src/FunctionGrapher.jsx (changed): imported by 1 file',
        '- evaluate (changed): called by evaluateExpression (FunctionGrapher.jsx:6)',
        '- FunctionGrapher (changed): tested by FunctionGrapher.test.jsx (FunctionGrapher.jsx:4)',
        '- App: tested by App.test.jsx (App.jsx:14)'
      ],
      Risks: ['- playSound: no test reaches it (audio.js:8)']
    }),
    verification: brief('.w-one', verifying, 'verification', { 'Rules that apply': ['- calculateTip: no test reaches it (evaluator.js:16)'] }),
    release: brief('.w-one', '0123456789abcdef', 'conformance', { Contracts: ['- app start → App (App.jsx:14)'] }),
    codeTwo: brief('.w-two', codeTwo, 'implementation', { Contracts: ['- app start → App (App.jsx:14)'] })
  };
  const rows = [
    ['GRAPH-1', '.w-one', 'specification', kept.intakeOne], ['GRAPH-1', '.w-one', 'planning', kept.planning],
    ['GRAPH-1', '.w-one', 'implementation', kept.implementation], ['GRAPH-1', '.w-one', 'verification', kept.verification],
    ['GRAPH-1', '.w-one', 'release', kept.release], ['GRAPH-2', '.w-two', 'specification', kept.intakeTwo],
    ['GRAPH-2', '.w-two', 'implementation', kept.codeTwo], ['GRAPH-2', '.w-two', 'verification', '']
  ].map(([workId, worktree, phase, text], index) => ({
    schemaVersion: 3, id: `row-${index}`, recordedAt: `2026-01-0${index + 1}T00:00:00.000Z`, workId, phase, generation: 1, source: 'wm-compose',
    repositoryPath: `/elsewhere/.singularity-flow/story-worktrees/${worktree}`, compositionCache: { key: `key-${index}`, hit: false }, prompt: prompt(text)
  }));
  rows.push({ schemaVersion: 3, id: 'row-other', workId: null, phase: 'unscoped', source: 'model-invocation', prompt: 'not a Story step' });
  await write(input, {
    'prompt-audit/prompts.jsonl': `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'prompt-audit/integrity.key': 'never read by the measure\n'
  });
  // Each Story's worktree folder: its records and the receipts of its kept prompts.
  for (const [id, worktree, branch] of [['GRAPH-1', '.w-one', 'graph-1'], ['GRAPH-2', '.w-two', 'graph-2']]) {
    const folder = path.join(input, 'story-worktrees', worktree, records(id));
    await write(folder, { 'workflow.json': JSON.parse(git(repository, 'show', `${branch}:${records(id)}/workflow.json`)) });
    for (const [index, row] of rows.entries()) {
      if (row.workId !== id) continue;
      const kept = promptBrief(row.prompt);
      await write(folder, { [`context/${row.phase}-gen1.json`]: {
        workId: id, phase: row.phase, generation: 1, files: [], compositionCache: { key: `key-${index}` },
        groundingAvailability: kept ? { status: 'unavailable', reasonCode: 'WORLD_MODEL_GROUNDING_DISABLED' } : { status: 'unavailable', reasonCode: 'BRIEF_NOT_FOR_THIS_STEP' },
        repositoryBrief: kept ? { renderer: 'repository-brief@1', profile: kept.profile, budget: 3072, bytes: kept.bytes, records: [], omitted: 30 } : null
      } });
    }
  }
  return { parent, input, repository, prompts: path.join(input, 'prompt-audit'), worktrees: path.join(input, 'story-worktrees') };
}

test('a kept brief, its claims and the files it names are read as the composer wrote them', () => {
  const text = brief('.w-one', 'a'.repeat(40), 'implementation', {
    'What a change touches': ['- src/FunctionGrapher.jsx (changed): imported by 1 file', '- evaluate (changed): called by drawFunction, evaluateExpression and 2 more; tested through its callers by Graph.test.jsx (FunctionGrapher.jsx:6)'],
    Flows: ['- app start → App (App.jsx:14)', '- keydown → App.handleKeyDown → playSound (and 1 helper: tone); 2 rules on the way (App.jsx:20)'],
    Risks: ['- playSound: complexity 10, reached by every endpoint, called from 8 places, no test reaches it (audio.js:8)']
  });
  const kept = promptBrief(prompt(text));
  assert.equal(kept.text, text, 'from its header to the next top heading');
  assert.deepEqual([kept.repository, kept.commit, kept.profile], ['.w-one', 'a'.repeat(12), 'implementation']);
  assert.equal(promptBrief(prompt('')), null);
  assert.deepEqual(briefClaims(text).map((claim) => [claim.kind, claim.subject, claim.count ?? claim.callers ?? claim.files ?? claim.chain ?? null]), [
    ['tested-by', 'evaluate', ['Graph.test.jsx']],
    ['called-by', 'evaluate', ['drawFunction', 'evaluateExpression']],
    ['call-chain', 'App.handleKeyDown', ['App.handleKeyDown', 'playSound']],
    ['no-test-reaches', 'playSound', null],
    ['called-from', 'playSound', 8],
    ['reached-by', 'playSound', null]
  ]);
  assert.equal(briefBody(text, '.w-one'), briefBody(text.replaceAll('.w-one', '.w-two').replace('a'.repeat(12), 'b'.repeat(12)), '.w-two'), 'the header, label and commit do not make two briefs differ');
  // By path, or by a file name only that file has.
  assert.deepEqual(namedFiles(text, ['src/FunctionGrapher.jsx', 'src/App.jsx', 'src/graph/plot.js'], new Set(['App.jsx'])), ['src/FunctionGrapher.jsx', 'src/App.jsx']);
  assert.deepEqual(namedFiles(text, ['src/App.jsx'], new Set()), [], 'a name two files share is not a hit');
  // Judged only when the repository can contradict it.
  const evidence = { found: true, tests: [], fileNames: new Set(), sources: [
    { path: 'src/evaluator.js', text: 'export function evaluateExpression() { return math.evaluate(1); }\n' },
    { path: 'src/draw.js', text: 'export function drawFunction() { return evaluate(2); }\n' }
  ] };
  assert.equal(judgeClaim({ kind: 'reached-by', subject: 'playSound', count: 3 }, evidence).wrong, null);
  assert.equal(judgeClaim({ kind: 'called-by', subject: 'evaluate', callers: ['drawFunction'] }, evidence).wrong, false);
  assert.match(judgeClaim({ kind: 'called-by', subject: 'evaluate', callers: ['drawFunction', 'evaluateExpression'] }, evidence).why, /evaluateExpression never calls evaluate/u);
  assert.equal(judgeClaim({ kind: 'called-by', subject: 'evaluate', callers: ['nowhere'] }, evidence).wrong, null, 'a caller no file defines cannot be contradicted');
  assert.equal(judgeClaim({ kind: 'called-by', subject: 'evaluate', callers: ['evaluateExpression'] }, { ...evidence, found: false }).wrong, null, 'nor without the commit');
  const viaModule = { ...evidence, sources: [{ path: 'src/b.js', text: "import * as calc from './calc.js';\nexport function total() { return calc.evaluate(3); }\n" }] };
  assert.equal(judgeClaim({ kind: 'called-by', subject: 'evaluate', callers: ['total'] }, viaModule).wrong, false, 'a call through a module the file imports is a call');
});

test('A13 before: hit rate, wrong claims, steps with no brief and identical briefs, from the kept prompts alone [WMR:REQ-029]', async (t) => {
  const { prompts, worktrees, repository } = await fixture(t);
  const result = await measureRealUse({ prompts, worktrees, repository });
  assert.deepEqual(result.input, { prompts: 8, skipped: 1, steps: 8, stories: 2, from: '2026-01-01T00:00:00.000Z', to: '2026-01-08T00:00:00.000Z' });
  assert.deepEqual(result.stories.map((story) => [story.id, story.changed, story.lead]), [
    ['GRAPH-1', ['src/FunctionGrapher.jsx', 'src/graph/plot.js', 'src/utils/audio.test.js'], 'src/FunctionGrapher.jsx'],
    ['GRAPH-2', ['src/App.jsx'], 'src/App.jsx']
  ]);
  assert.deepEqual(result.steps.map((step) => step.kind), ['intake', 'plan', 'code', 'verify', 'release', 'intake', 'code', 'verify']);
  assert.ok(result.steps.every((step) => step.receipt?.matchesPrompt), 'each prompt is matched to its receipt');
  const kept = result.kept;
  // The plan brief names only App.jsx, which GRAPH-1 never changed; both code briefs name a changed file.
  assert.deepEqual(kept.hitRate, { plan: { hit: 0, lead: 0, of: 1 }, code: { hit: 2, lead: 2, of: 2 }, noCodeChange: 0, all: { hit: 2, lead: 2, of: 3, rate: 2 / 3 } });
  assert.deepEqual(result.steps[2].kept.named, ['src/FunctionGrapher.jsx']);
  // Four wrong: 21 call sites, not 2; evaluateExpression calls math.evaluate; no FunctionGrapher.test.jsx; the Story's test names playSound.
  const wrong = result.steps.flatMap((step) => step.kept.claims.filter((claim) => claim.wrong).map((claim) => `${claim.kind} ${claim.subject} ${claim.where}: ${claim.why}`));
  assert.deepEqual(wrong, [
    'called-from playSound tree: 21 call sites of playSound, not 2',
    'called-by evaluate tree: evaluateExpression never calls evaluate',
    'tested-by FunctionGrapher tree: no file named FunctionGrapher.test.jsx',
    'no-test-reaches playSound diff: src/utils/audio.test.js:2 names playSound'
  ]);
  assert.deepEqual(kept.claims.wrongWhere, { tree: 3, diff: 1 });
  assert.equal(kept.claims.byKind['no-test-reaches'].wrong, 1, 'calculateTip: no test names it, so that claim stands');
  assert.deepEqual(kept.claims.byKind['call-chain'], { claims: 1, judged: 1, wrong: 0 }, 'handleKeyDown calls playSound, which calls getAudioContext');
  assert.deepEqual(kept.claims.byKind['reached-by'], { claims: 1, judged: 0, wrong: 0 }, 'reach through entry points is never judged');
  assert.deepEqual(kept.noBrief, { steps: 1, byReason: { BRIEF_NOT_FOR_THIS_STEP: { verify: 1 } } });
  assert.deepEqual(kept.identical, { briefs: 2, groups: [{ briefs: 2, stories: 2, kinds: ['intake'] }] });
  assert.equal(kept.briefs, 7);
  assert.equal(kept.bytes.median, median(result.steps.filter((step) => step.kept.text).map((step) => Buffer.byteLength(step.kept.text))));
  const report = realUseReport(result);
  assert.match(report, /^Plan and code steps whose brief names a file the Story changed\s+2 of 3 \(67%\)$/mu);
  assert.match(report, /^Steps with no brief, and why\s+1: BRIEF_NOT_FOR_THIS_STEP \(verify 1\)$/mu);
  assert.match(report, /Nothing was sent; no model was called\./u);
});

test('the measure reads nothing outside its input folder: run under Node\'s permission model, the integrity key unreadable [WMR:REQ-029]', async (t) => {
  const { parent, prompts, worktrees, repository } = await fixture(t);
  // The code it runs is read too: the checkout and its node_modules, which may be a chain of links to a shared folder.
  const modules = [];
  for (let link = path.join(root, 'node_modules'); modules.length < 8;) {
    modules.push(link);
    let target;
    try { target = readlinkSync(link); } catch { break; }
    link = path.resolve(path.dirname(link), target);
  }
  const allowed = [path.join(prompts, 'prompts.jsonl'), worktrees, repository, root, ...modules, realpathSync(path.join(root, 'node_modules'))];
  const permission = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
  const sandbox = [permission, '--no-warnings', ...allowed.map((entry) => `--allow-fs-read=${entry}`), '--allow-child-process'];
  // The sandbox is real: the key beside the prompts cannot be read under it.
  const control = spawnSync(process.execPath, [...sandbox, '-e', `require('node:fs').readFileSync(${JSON.stringify(path.join(prompts, 'integrity.key'))})`], { cwd: parent, encoding: 'utf8' });
  assert.notEqual(control.status, 0);
  assert.match(control.stderr, /ERR_ACCESS_DENIED/u);
  const run = spawnSync(process.execPath, [...sandbox, script, '--real-use', '--prompts', prompts, '--worktrees', worktrees, '--repository', repository, '--json'],
    { cwd: parent, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  const sandboxed = JSON.parse(run.stdout);
  const direct = await measureRealUse({ prompts, worktrees, repository });
  assert.deepEqual(sandboxed.kept, JSON.parse(JSON.stringify(direct.kept)), 'the same measure in and out of the sandbox');
  assert.equal(sandboxed.replayed, null);
});

test('A13 after: each step re-composed with today\'s code on a scratch clone, from its own commit, measured the same way [WMR:REQ-029]', async (t) => {
  const { parent, prompts, worktrees, repository } = await fixture(t);
  const clone = path.join(parent, 'scratch-clone');
  git(parent, 'clone', '-q', '--no-hardlinks', repository, clone);
  for (const branch of ['graph-1', 'graph-2']) git(clone, 'branch', '-q', branch, `origin/${branch}`);
  const state = (repo) => [git(repo, 'rev-parse', 'HEAD'), git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'), git(repo, 'status', '--porcelain', '--ignored')];
  const before = { input: state(repository), clone: git(clone, 'rev-parse', '--abbrev-ref', 'HEAD') };
  // The Story's pinned configuration, as compose would load it; the fixture has no SFlow configuration to load it from.
  const loadStory = async (checkout, { workId }) => ({
    definition: { worldModel: {} },
    workflow: JSON.parse(await readFile(path.join(checkout, 'singularity', 'work-items', workId, 'workflow.json'), 'utf8'))
  });
  const result = await measureRealUse({ prompts, worktrees, repository, replay: clone, loadStory });
  assert.deepEqual(result.notReplayable.map((entry) => [entry.phase, entry.why]), [
    ['release', 'commit 0123456789ab is not in the clone'],
    ['verification', 'the kept prompt names no commit (it carried no brief)']
  ]);
  const replayed = result.replayed;
  assert.deepEqual(replayed.noBrief, { steps: 3, byReason: { BRIEF_NOT_FOR_THIS_STEP: { intake: 2, verify: 1 } } }, 'intake and verification carry no brief [REQ-011]');
  assert.equal(replayed.claims.total, 0, 'no claim built on calls matched by name [REQ-014]');
  assert.equal(replayed.claims.wrong, 0);
  const code = result.steps.find((step) => step.story === 'GRAPH-1' && step.phase === 'implementation').replayed;
  assert.match(code.text, /^- src\/FunctionGrapher\.jsx \(planned\)/mu, 'the plan\'s file leads the code brief [REQ-007]');
  assert.deepEqual(code.named, ['src/FunctionGrapher.jsx', 'src/graph/plot.js'], 'and the new file it plans, which the Story added');
  assert.deepEqual(replayed.hitRate.code, { hit: 2, lead: 2, of: 2 }, 'each code brief names the file its Story changed most');
  assert.equal(replayed.identical.briefs, 0);
  assert.ok(result.keptReplayable, 'the kept side is measured again on the replayable steps');
  // Only the clone was written: the input repository is as it was, and the clone is back on its own branch.
  assert.deepEqual(state(repository), before.input);
  assert.equal(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD'), before.clone);
  assert.equal(git(clone, 'branch', '--list', 'wmr-real-use-replay'), '');
  await writeFile(path.join(clone, 'notes.txt'), 'mine\n');
  await assert.rejects(measureRealUse({ prompts, worktrees, repository, replay: clone, loadStory }), /clean scratch clone/u,
    'a checkout with a file of its own is never replayed into');
});

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * "It should be during implementation .. SFlow should take a screenshot and ask for approval" [owner, 2026-11-18].
 *
 * On the demo build a plan's primary visual criterion that named no screenshot file (`AC-002 | graph-layout | visual |
 * Grapher workspace at desktop viewport | primary`) gave a sign-off nobody could ever give: no file, so never available,
 * while "Approve Implementation … waits for d1" and the Decide card offered "Review and record" over a list nothing on
 * could be recorded. Now the sign-off offers SFlow's own screenshot of what the step published, taken when a person asks
 * for it; the person looks at it and signs it off as any other file; and a card with nothing recordable says why.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { decisionPacket } from '../src/decision-list.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';
import { askedFor, itemsToCheck, PROBE_KINDS, runDecisionProbes } from '../src/decision-probes.mjs';
import { approvalHold } from '../src/approval-check.mjs';
import { owedDecisionLines } from '../src/owed-decisions.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { inspectLifecycleWorktree } from '../src/lifecycle-worktree.mjs';
import { SIGN_OFF_CAPTURE_DIRECTORY, signOffBuild, signOffCapturePath, signOffFile, signOffViewport } from '../src/visual-sign-off-capture.mjs';
import { CHECK_FIRST_SECONDS, decisionsTable, directForm, LEAVE, runCard, SIGN } from '../plugin/extensions/decisions/card.mjs';
import { decideHtml } from '../apps/vscode/src/views/decide-card-page.ts';
import { buildDecisionListView } from '../apps/vscode/src/views/decision-list-model.ts';
import { decisionListHtml } from '../apps/vscode/src/views/decision-list-page.ts';
import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';

const AT = '2026-11-18T09:00:00.000Z';
const W = 'WORK-9';
const ME = { name: 'Person', email: 'person@example.invalid' };
const AUTHORITIES = { engineering: { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] } };
const FILE = `singularity/work-items/${W}/${SIGN_OFF_CAPTURE_DIRECTORY}/WORK-9-AC-002-graph-layout-0123456789abcdef.png`;
const RISK = `singularity-flow decision risk ${W} --obligation ${W}:AC-002:verify --category deferred-verification --reason "<why>" --expires <YYYY-MM-DD>`;

/** Implementation published (generation 1), its approval held by the visual sign-off it answers for. */
function story({ status = 'awaiting_approval' } = {}) {
  return { workItem: { id: W }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['specification', 'implementation'],
    phases: { specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } },
      implementation: { id: 'implementation', label: 'Implementation', status, generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } } },
    resolution: { approvalAuthorities: AUTHORITIES }, history: [] };
}

const owed = (extra = {}) => ({ kind: 'witness', clauseId: `${W}:AC-002`, clauseText: 'The graph lays out in the Grapher workspace.', slot: 'graph-layout', method: 'visual',
  files: [], owners: ['implementation'], available: false, groups: ['engineering'], contextBinding: `sha256:${'c'.repeat(64)}`,
  command: `singularity-flow decision witness --work-id ${W} --criterion ${W}:AC-002 --slot graph-layout --file <EVIDENCE-PATH>`, ...extra });
const NEEDED = { status: 'needed', workId: W, file: FILE, viewport: { width: 1280, height: 800 },
  build: { source: 'inferred', words: 'npm ci --no-audit --no-fund, then npm run build (inferred: package.json builds with vite build; output dist)' } };

/** The list as `decisions` reads it for every host, with the approval held by the sign-off as the approval gate holds it. */
function packetOf(entry, { workflow = story(), held = true } = {}) {
  const hold = approvalHold(new SingularityFlowError('Phase \'implementation\' cannot be approved while 1 sign-off(s) it answers for have no witness.',
    { code: 'EVIDENCE_INSPECTION_MISSING', details: { phase: 'implementation', criteria: [{ clauseId: entry.clauseId, slot: entry.slot }] } }), workflow, workflow.phases.implementation);
  return { ...withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'implementation', pending: { owed: [entry] }, approvalCheck: { holds: held ? [hold] : [] } },
    { authorities: AUTHORITIES, actor: ME, at: AT })), packetSha256: `sha256:${'a'.repeat(64)}`, repositoryPath: '/repo' };
}
const signOff = (packet) => packet.items.find((item) => item.details?.clause === `${W}:AC-002`);
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/gu, '').replace(/<[^>]+>/gu, ' ').replace(/&#39;/gu, '\'').replace(/&quot;/gu, '"').replace(/&amp;/gu, '&').replace(/\s+/gu, ' ');

test('the dead end, as it was: a published step\'s visual sign-off with no file leaves nothing to record, and every card says why on itself', async () => {
  // What the demo build's engine gave: no file, unavailable, and no way to get one.
  const packet = packetOf(owed());
  const item = signOff(packet);
  assert.equal(item.holdsApproval, true);
  assert.doesNotMatch(item.why, / {2}/u, 'never "nothing has published  for AC-002"');
  assert.match(item.why, /the plan names no screenshot for AC-002/u);
  assert.equal(packet.plain.nothingToRecord, 'Nothing here can be recorded yet. Sign off AC-002 after Implementation publishes its screenshot. Approving Implementation waits for it.');
  // Copilot CLI: said, never an empty form or a silent "No decision was recorded".
  const seen = { asked: [], shown: [] };
  const result = await runCard({ read: async () => packet, show: async (line) => { seen.shown.push(line); }, ask: async (form) => { seen.asked.push(form); return { action: 'cancel' }; },
    record: async () => assert.fail('nothing is recordable'), witness: async () => assert.fail('nothing to sign'), inspect: async () => {} });
  assert.equal(result.status, 'nothing-recordable');
  assert.equal(result.message, packet.plain.nothingToRecord);
  assert.deepEqual(seen.asked, []);
  assert.ok(seen.shown.includes(packet.plain.nothingToRecord));
  // VS Code's Decide card: no "Review and record" that does nothing; the reason, on the card.
  const card = decideHtml(packet);
  assert.doesNotMatch(card, /data-review/u);
  assert.ok(text(card).includes(packet.plain.nothingToRecord), text(card));
  // VS Code's Decisions page: the same words where its review would be.
  assert.ok(text(decisionListHtml(buildDecisionListView(packet))).includes(packet.plain.nothingToRecord));
});

test('after publication the sign-off offers SFlow\'s screenshot first, run only when the person asks, and nobody types a path', () => {
  const packet = packetOf(owed({ capture: NEEDED }));
  const item = signOff(packet);
  assert.deepEqual([item.check.kind, item.check.onRequest, item.check.label, item.check.criterion, item.check.slot], ['screenshot', true, 'Take the screenshot', `${W}:AC-002`, 'graph-layout']);
  assert.match(item.check.does, /^SFlow builds what Implementation published in a private copy \(npm ci --no-audit --no-fund, then npm run build \(inferred: package\.json builds with vite build; output dist\)\), opens it at 1280×800/u);
  assert.match(item.check.does, /nothing is recorded or approved\.$/u);
  assert.equal(item.options[0].available, false);
  assert.equal(item.options[0].label, 'Sign it off once SFlow has taken its screenshot');
  // A question with its recommendation, never a "Later:" line: the person can act now.
  assert.equal(item.plain.later, undefined);
  assert.equal(item.plain.question, 'Does the screenshot show what AC-002 asks for?');
  assert.match(item.plain.why, /^SFlow takes the screenshot of what was published first, then you look at it and sign it off; Implementation can't be approved until it is decided\.$/u);
  assert.match(item.plain.recommended, /^Recommended: Take the screenshot\. /u);
  assert.equal(packet.plain.nothingToRecord, undefined, 'something is the person\'s to do');
  // A card's first read never builds the app; the person's "Take the screenshot" (the longer check) does.
  assert.deepEqual([askedFor(undefined), askedFor('60'), askedFor('900')], [false, false, true]);
  assert.deepEqual(itemsToCheck(packet), []);
  assert.deepEqual(itemsToCheck(packet, { asked: true }).map((entry) => entry.id), [item.id]);
  assert.ok(PROBE_KINDS.includes('owed-decision') && PROBE_KINDS.includes('evidence-obligation'));
  // Each host offers it on the row: Copilot CLI's form, VS Code's Decide card and its Decisions page.
  assert.deepEqual(directForm(packet).form.requestedSchema.properties.decision0.enum, ['Take the screenshot (recommended)', LEAVE]);
  assert.match(decisionsTable(packet), /\n- Take the screenshot \(recommended\): SFlow builds what Implementation published/u);
  assert.match(decideHtml(packet), new RegExp(`data-check="${item.id}">Take the screenshot</button>`, 'u'));
  assert.match(decisionListHtml(buildDecisionListView(packet)), new RegExp(`data-check-item="${item.id}">Take the screenshot`, 'u'));
  assert.doesNotMatch(decideHtml(packet), /data-review/u, 'nothing to record until the screenshot is taken and looked at');
});

test('the owed sign-off\'s file: SFlow\'s screenshot once taken, else what taking it needs, and the terminal says which', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-visual-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { workItemRoot: 'singularity/work-items' };
  const workflow = (generation) => ({ workItem: { id: W }, phaseOrder: ['implementation'], resolution: {},
    phases: { implementation: { id: 'implementation', generation, deliveryEvidence: { sourcePaths: ['src/Graph.tsx'] } } } });
  const row = { actions: [{ kind: 'accept-risk', command: RISK }] };
  const ask = (generation) => signOffFile({ root, config }, workflow(generation), { clauseId: `${W}:AC-002`, slot: 'graph-layout', owners: ['implementation'], row });
  assert.deepEqual([ask(0).files, ask(0).capture.status], [[], 'unpublished'], 'nothing to take before the step publishes');
  const lines = (capture) => owedDecisionLines({ status: 'owed', more: { witnesses: 0, scopeItems: 0 }, scopeItems: [], witnesses: [owed({ capture })] }).join('\n');
  // No build SFlow may run: why, where to save one's own, and the dated risk.
  const unavailable = ask(1).capture;
  assert.deepEqual([unavailable.status, unavailable.riskCommand], ['unavailable', RISK]);
  assert.match(lines(unavailable), /SFlow cannot take its screenshot: this repository has no package\.json at its root.*Save one as singularity\/work-items\/WORK-9\/evidence\/visual-sign-offs\/.*\.png, then sign it off: \/sf-decide WORK-9\n {4}Or accept it as a dated risk: /su);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  const needed = ask(1).capture;
  assert.equal(needed.status, 'needed');
  assert.match(lines(needed), /SFlow takes its screenshot when a person asks for it \(Take the screenshot\)[\s\S]*\/sf-decide WORK-9/u);
  assert.doesNotMatch(lines(needed), /nothing has published/u);
  // Taken (by SFlow, or saved there by the person): it is the sign-off's file.
  await mkdir(path.dirname(path.join(root, needed.file)), { recursive: true });
  await writeFile(path.join(root, needed.file), 'png');
  assert.deepEqual([ask(1).files, ask(1).capture.status], [[needed.file], 'taken']);
  // A new generation is a new candidate: a new screenshot.
  assert.notEqual(ask(2).capture.file, needed.file);
});

test('the probe runs SFlow\'s screenshot only when asked, within the time it is given', async () => {
  const packet = packetOf(owed({ capture: NEEDED }));
  const calls = [];
  const probes = { 'owed-decision': async (root, read, item, seconds) => { calls.push([item.check.criterion, item.check.slot, seconds]); } };
  assert.deepEqual(await runDecisionProbes('/repo', packet, { seconds: 60, probes }), { ran: [] }, 'a card\'s first read builds nothing');
  assert.deepEqual(await runDecisionProbes('/repo', packet, { seconds: 900, probes, now: () => 0 }), { ran: [signOff(packet).id] });
  assert.deepEqual(calls, [[`${W}:AC-002`, 'graph-layout', 900]]);
});

test('Copilot CLI: "Take the screenshot", then the person looks at it and signs it off on the card', async () => {
  const before = packetOf(owed({ capture: NEEDED }));
  const after = packetOf(owed({ files: [FILE], available: true, capture: { status: 'taken', workId: W, file: FILE } }));
  assert.equal(signOff(after).check, undefined, 'taken: nothing more to check');
  assert.deepEqual(signOff(after).options[0].action.humanReview.files, [FILE]);
  const reads = [];
  const lists = [before, after, after, after];
  const replies = [{ action: 'accept', content: { decision0: 'Take the screenshot (recommended)' } },
    { action: 'accept', content: { choice: 'I looked at it', 'states-the-outcome': 'Yes', 'matches-the-criterion': 'Yes', 'current-for-this-change': 'Yes',
      reason: 'The graph is laid out in the Grapher workspace at desktop size.' } },
    { action: 'accept', content: { confirm: SIGN } }];
  const witnessed = [];
  const inspected = [];
  const result = await runCard({ read: async (options) => { reads.push(options ?? null); return lists[Math.min(reads.length - 1, lists.length - 1)]; },
    show: async () => {}, ask: async () => replies.shift() ?? { action: 'cancel' }, record: async () => assert.fail('nothing else is recorded'),
    witness: async (packet, review, answer) => { witnessed.push([review.clauseId, review.slot, answer.file]); return { record: { id: 'WIT-001' } }; },
    inspect: async (packet, file) => { inspected.push(file); } });
  assert.deepEqual(reads.slice(0, 2), [null, { probe: CHECK_FIRST_SECONDS }], 'no automatic build; the person\'s choice runs it');
  assert.deepEqual(inspected, [FILE], 'the screenshot is put in front of the person first');
  assert.deepEqual(witnessed, [[`${W}:AC-002`, 'graph-layout', FILE]]);
  assert.equal(result.status, 'recorded');
  assert.match(result.message, /Signed off WORK-9:AC-002 · graph-layout/u);
});

test('a screenshot that failed says why, and is offered again', () => {
  const packet = packetOf(owed({ capture: { ...NEEDED, failed: 'The inferred build (npm ci, then npm run build) failed (exit 1). vite: not found' } }));
  const item = signOff(packet);
  assert.equal(item.check.label, 'Take the screenshot again');
  assert.equal(item.check.status, 'failed');
  assert.match(item.check.failed, /^The last screenshot failed: The inferred build/u);
  assert.match(item.plain.recommended, /^Recommended: Take the screenshot again\. The last screenshot failed: /u);
});

test('when SFlow cannot take the screenshot, the sign-off names what works: the person\'s own screenshot where SFlow would save it, or a dated risk', () => {
  const capture = { status: 'unavailable', workId: W, file: FILE, reason: 'its package.json build script ("react-scripts build") does not run vite build, and SFlow infers only a Vite build' };
  const packet = packetOf(owed({ capture: { ...capture, riskCommand: RISK } }));
  const item = signOff(packet);
  assert.equal(item.check, undefined);
  assert.match(item.why, new RegExp(`SFlow cannot take one: .*Take it yourself and save it as ${FILE.replaceAll('.', '\\.')}; it is then yours to look at and sign off here\\. Or accept it as a dated risk: `, 'u'));
  assert.doesNotMatch(item.why, / {2}/u);
  const risk = item.options.find((entry) => entry.id === 'accept-risk');
  assert.equal(risk.action.command, RISK);
  assert.notEqual(risk.available, false);
  assert.equal(packet.plain.nothingToRecord, undefined, 'the risk is the person\'s own step');
  // Without a risk to accept, its later line says where the screenshot goes, and the card says nothing is recordable yet.
  const bare = packetOf(owed({ capture }));
  assert.equal(signOff(bare).plain.later, `Sign off AC-002 once its screenshot is saved as ${FILE}: SFlow cannot take it (its package.json build script ("react-scripts build") does not run vite build, and SFlow infers only a Vite build).`);
  assert.match(bare.plain.nothingToRecord, /^Nothing here can be recorded yet\. Sign off AC-002 once its screenshot is saved as /u);
  assert.match(bare.plain.nothingToRecord, /Approving Implementation waits for it\.$/u);
});

test('which build SFlow runs: the Story\'s declared preview, else only Vite with a lock file, inferred and said so', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-visual-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflow = (resolution = {}, sourcePaths = []) => ({ workItem: { id: W }, resolution, phases: { implementation: { deliveryEvidence: { sourcePaths } } } });
  assert.match(signOffBuild(root, workflow()).reason, /no package\.json/u);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'react-scripts build' } }));
  assert.match(signOffBuild(root, workflow()).reason, /does not run vite build/u);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc -b && vite build' } }));
  assert.match(signOffBuild(root, workflow()).reason, /no package-lock\.json/u);
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  const inferred = signOffBuild(root, workflow());
  assert.equal(inferred.source, 'inferred');
  assert.deepEqual(inferred.steps.map((step) => step.argv.join(' ')), ['npm ci --no-audit --no-fund', 'npm run build']);
  assert.equal(inferred.outputDirectory, 'dist');
  assert.match(inferred.words, /inferred: package\.json builds with vite build; output dist/u);
  // A declared preview wins, and a declared non-web surface has no screens unless a user-facing file was delivered.
  const declared = signOffBuild(root, workflow({ applicationReview: { mode: 'off', surface: 'web', preview: { entry: 'web', outputDirectory: 'site' } } }));
  assert.deepEqual([declared.source, declared.entry, declared.outputDirectory], ['declared', 'web', 'site']);
  assert.match(signOffBuild(root, workflow({ applicationReview: { mode: 'off', surface: 'library' } })).reason, /declares a library surface/u);
  assert.equal(signOffBuild(root, workflow({ applicationReview: { mode: 'off', surface: 'library' } }, ['src/Graph.tsx'])).source, 'inferred');
  assert.deepEqual(signOffViewport(workflow()), { width: 1280, height: 800 });
  assert.deepEqual(signOffViewport(workflow({ applicationReview: { capture: { viewport: { width: 1440, height: 900 } } } })), { width: 1440, height: 900 });
});

test('the screenshot is named for its criterion, slot and candidate, and an untracked one is SFlow\'s output, never a change to review', async (t) => {
  const config = { workItemRoot: 'singularity/work-items' };
  const one = { workItem: { id: W }, phaseOrder: ['implementation'], phases: { implementation: { generation: 1, deliveryEvidence: { sourceTreeSha256: 'a', testInputSha256: 'b' } } } };
  const two = structuredClone(one); two.phases.implementation.generation = 2;
  const file = signOffCapturePath(config, one, `${W}:AC-002`, 'graph-layout');
  assert.match(file, new RegExp(`^singularity/work-items/${W}/evidence/visual-sign-offs/WORK-9-AC-002-graph-layout-[0-9a-f]{16}\\.png$`, 'u'));
  assert.equal(signOffCapturePath(config, one, `${W}:AC-002`, 'graph-layout'), file, 'the same candidate, the same file');
  assert.notEqual(signOffCapturePath(config, two, `${W}:AC-002`, 'graph-layout'), file, 'a new generation is a new screenshot');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-visual-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0);
  git('init', '-q');
  for (const relative of [file, `singularity/work-items/${W}/evidence/stray.png`, 'notes.txt']) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), 'x');
  }
  const inspection = inspectLifecycleWorktree(root, config, one);
  assert.deepEqual(inspection.disposableUntrackedPaths, [file]);
  // Only that folder's screenshots: anything else there, or anywhere else, is still a change a person reviews.
  assert.deepEqual(inspection.entries.map((entry) => entry.path.value).sort(), ['notes.txt', `singularity/work-items/${W}/evidence/stray.png`]);
});

test('end to end: a published web change, SFlow\'s own screenshot, the person\'s sign-off, and the criterion is met', { timeout: 600_000 }, async (t) => {
  const page = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Grapher</title><h1>Grapher workspace</h1><p>Value 2</p></html>';
  const repo = await repository(t, { implementCommands: false, files: {
    'package.json': JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test', build: 'vite build' } }),
    'package-lock.json': JSON.stringify({ name: 'grapher', lockfileVersion: 3, requires: true, packages: {} }),
    'ui/index.src': page } });
  // npm on PATH that does the inferred build's two steps offline (install nothing, build the one page into dist) and
  // hands everything else, such as the step's own `npm test`, to the real npm.
  const npm = spawnSync('sh', ['-c', 'command -v npm'], { env: repo.env, encoding: 'utf8' }).stdout.trim();
  assert.ok(npm, 'npm is on PATH');
  const bin = path.join(repo.base, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'npm'), `#!/bin/sh\nif [ "$1" = "ci" ]; then exit 0; fi\nif [ "$1" = "run" ] && [ "$2" = "build" ]; then mkdir -p dist && cp ui/index.src dist/index.html && exit 0; fi\nexec '${npm}' "$@"\n`);
  await chmod(path.join(bin, 'npm'), 0o755);
  repo.env.PATH = `${bin}${path.delimiter}${repo.env.PATH}`;
  await startQuickFix(repo, { visualCriterion: true });
  repo.sflow('prepare', 'implement');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
  repo.sflow('prepare', 'implement');
  const published = repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.equal(published.status, 0, JSON.stringify(published.value));
  const list = () => repo.sflowJson('decisions', 'QF-1').value.data;
  const first = list().items.find((item) => item.details?.clause === 'QF-1:AC-001');
  assert.ok(first, JSON.stringify(list().items.map((item) => item.title)));
  assert.equal(first.check?.kind, 'screenshot', JSON.stringify(first));
  assert.match(first.check.does, /inferred: package\.json builds with vite build; output dist/u);
  const file = first.details.capture.file;
  // A card's first read builds nothing.
  repo.sflowJson('decisions', 'QF-1', '--probe', '--probe-wait', '60');
  await assert.rejects(readFile(path.join(repo.root, file)));
  // The person's "Take the screenshot".
  repo.sflowJson('decisions', 'QF-1', '--probe', '--probe-wait', '900');
  const shot = await readFile(path.join(repo.root, file)).catch(() => null);
  if (!shot) {
    const notes = path.join(repo.must('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(), 'singularity-flow', 'visual-sign-offs', 'QF-1');
    const failure = (await Promise.all((await readdir(notes).catch(() => [])).map((name) => readFile(path.join(notes, name), 'utf8')))).join('\n');
    if (/ARA_CAPTURE_UNAVAILABLE/u.test(failure)) return t.skip('The pinned review browser is not installed here: run singularity-flow app-review browser install');
    assert.fail(`no screenshot was taken: ${failure}`);
  }
  assert.deepEqual([...shot.subarray(1, 4)], [...Buffer.from('PNG')]);
  const ready = list().items.find((item) => item.details?.clause === 'QF-1:AC-001');
  assert.equal(ready.check, undefined);
  const review = ready.options.find((option) => option.action?.humanReview);
  assert.ok(review && review.available !== false, JSON.stringify(ready));
  assert.deepEqual(review.action.humanReview.files, [file]);
  // The untracked screenshot is SFlow's output: no lifecycle decision is held for it.
  const { loadAcceptedStoryExecution } = await import('../src/accepted-story-execution.mjs');
  const { config, workflow } = await loadAcceptedStoryExecution(repo.root, 'QF-1');
  assert.deepEqual(inspectLifecycleWorktree(repo.root, config, workflow).entries, []);
  // The person signs it off, and its publication commits the screenshot beside the record.
  const signed = repo.sflowJson('decision', 'witness', '--work-id', 'QF-1', '--criterion', 'QF-1:AC-001', '--slot', 'screen', '--file', file,
    '--reason', 'The Grapher workspace shows the value 2 at desktop size.', '--confirm', 'states-the-outcome', '--confirm', 'matches-the-criterion', '--confirm', 'current-for-this-change');
  assert.equal(signed.status, 0, JSON.stringify(signed.value));
  assert.equal(signed.value.data.record.outcome, 'met');
  assert.ok(repo.must('git', ['show', '--name-only', '--format=', 'HEAD']).split('\n').includes(file), 'committed with the sign-off');
  assert.equal(repo.must('git', ['status', '--porcelain', '--', file]).trim(), '');
  assert.equal(list().items.some((item) => item.details?.clause === 'QF-1:AC-001'), false, 'the criterion is met: nothing is owed');
});

/**
 * What a person reads carries no hash [owner, 2026-11-11: "no need to show sha value .. lets abstract that away from users"].
 *
 * A raw run of 7 to 64 hexadecimal characters (a commit SHA, a short commit, a SHA-256 or its prefix) in text a person
 * reads fails here: the person-step guard's refusals, the CLI's own text output of the main person commands on a
 * reviewed fixture Story, its decision and approval cards in the terminal and in VS Code, and the agents' output
 * contract. Machine fields keep every digest: `--json`, the `--for-agent` payloads an agent reads, the records.
 * Where a person once had to copy a digest, they now name the thing (a witness by its criterion) or confirm in
 * their own terminal, which derives and checks the digest itself (a rollover, a decision-list record); those
 * paths are walked here too.
 *
 * ALLOWED is the whole allowlist, each entry with its reason. Anything else this finds is a leak to fix, not to allow.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { cli, repository } from './helpers/run-and-test-fixture.mjs';
import { TYPED_TERMINAL_AVAILABLE, typedInTerminal } from './helpers/typed-terminal.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { captureMutationTurn } from '../src/copilot-mutation-guard.mjs';
import { recordRepositoryBoundaryTurn, repositoryToolGuard } from '../src/copilot-repository-boundary.mjs';
import { ARTIFACT_PRESENTATION_CONTRACT } from '../scripts/skill-policy.mjs';

// VS Code's pages live beside their panels, which import 'vscode' at load; drawing a page needs none of it.
const vscodeShim = 'data:text/javascript,' + encodeURIComponent(`
  export const window = {}; export const workspace = {}; export const commands = {}; export const env = {};
  export const Uri = { file: (fsPath) => ({ fsPath }), parse: (value) => ({ toString: () => value }) };
  export const ViewColumn = { Active: -1, Beside: -2, One: 1 };
  export class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
  export class Disposable { constructor(dispose) { this.dispose = dispose; } static from() { return new Disposable(() => {}); } }
`);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));
const view = (name) => import(`../apps/vscode/src/views/${name}`);
const VIEWS = new URL('../apps/vscode/src/views/', import.meta.url);

/**
 * A page whose panel class Node cannot strip (a parameter property), compiled as the approval tests compile it,
 * with each module it requires loaded beforehand: drawing the page needs none of VS Code.
 */
async function compiledView(name) {
  const { outputText } = ts.transpileModule(await readFile(new URL(name, VIEWS), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const loaded = new Map();
  for (const [, specifier] of outputText.matchAll(/require\("([^"]+)"\)/gu)) {
    if (loaded.has(specifier)) continue;
    loaded.set(specifier, specifier === 'vscode' ? {} : await import(new URL(specifier, VIEWS).href).catch(() => ({})));
  }
  const exports = {};
  vm.runInContext(outputText, vm.createContext({ exports, Date, require: (specifier) => loaded.get(specifier) ?? {} }));
  return exports;
}

// A run of 7 to 64 hexadecimal characters with a letter and a digit in it, standing alone: a hash, never a word or a number.
const HEX_RUN = /(?<![0-9A-Za-z_])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,64}(?![0-9A-Za-z_])/giu;

/** The allowlist: what may still read like a hash in person text, and why. */
export const ALLOWED = Object.freeze([
  { pattern: /\b[A-Z][A-Z0-9]*-[0-9a-fA-F]{7,64}\b/gu,
    reason: 'A record\'s own ID (TA-…, SRI-…, F-…): the name a person types to pick that record (decision evidence-reuse '
      + '--from-attempt TA-…, decision scope --item SRI-…), its prefix saying what it is. Renaming record IDs changes '
      + 'every record, which this change does not.' }
]);

/** Each hex run left in `text` once `strip` (this run's own folders, the command's own input) and ALLOWED are taken out. */
function leaks(text, { strip = [] } = {}) {
  let shown = String(text ?? '');
  for (const value of strip.filter(Boolean)) shown = shown.split(value).join(' ');
  for (const { pattern } of ALLOWED) shown = shown.replace(pattern, ' ');
  return shown.split('\n').filter((line) => line.match(HEX_RUN)).map((line) => line.trim().slice(0, 240));
}

/** What a page shows: its text, without tags, attributes, styles or scripts. */
const visible = (html) => String(html).replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, ' ').replace(/<[^>]+>/gu, ' ')
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');

test('the ratchet finds a hash in person text, and its allowlist lets only record IDs through', () => {
  assert.deepEqual(leaks('Published intake generation 1 at 18872a75 and pushed.'), ['Published intake generation 1 at 18872a75 and pushed.']);
  assert.equal(leaks(`Review packet: sha256:${'ab12'.repeat(16)}`).length, 1);
  assert.deepEqual(leaks('Test run reused: TA-3818bd5324198ac1114b recorded by implement.'), []);
  assert.deepEqual(leaks('2026-11-12 · 1234567 bytes · deadbeef-free words · generation 12'), [], 'numbers and words are not hashes');
});

test('agents are told never to show a person a hash, in every skill and in an agent result\'s confirmation', () => {
  const rule = /Never show a person a hash, digest or commit SHA: name the step, its generation, its files\./u;
  assert.match(ARTIFACT_PRESENTATION_CONTRACT, rule);
  const skills = new URL('../plugin/skills/', import.meta.url);
  const missing = readdirSync(skills, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .filter((entry) => !rule.test(readFileSync(new URL(`${entry.name}/SKILL.md`, skills), 'utf8'))).map((entry) => entry.name);
  assert.deepEqual(missing, [], 'every skill\'s output contract carries the line');
  const digest = `sha256:${'c0ffee12'.repeat(8)}`;
  const act = agentAct({ resultType: 'sflow-generation-rollover', nextAction: { command: `singularity-flow phase rollover implement --confirm ${digest}`,
    copilotCommand: `/sf-confirm phase rollover implement --confirm ${digest}`, reason: 'Start generation 2.' } });
  assert.equal(act.ask?.kind, 'confirm', JSON.stringify(act));
  assert.match(act.ask.how, /in plain words \(the step, its generation, its files; never this value, a hash or a commit SHA\)/u);
});

// --- The person-step guard: what it says when it refuses a person's step ---------------------------------------

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/person-step-golden.json', import.meta.url), 'utf8'));

async function guardFixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-no-hash-')));
  const root = path.join(directory, 'repository');
  await mkdir(root);
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '-q']); git(['config', 'user.name', 'Ratchet Tester']); git(['config', 'user.email', 'ratchet@example.test']);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'App.jsx'), 'export const value = 1;\n');
  const phase = { id: 'custom-step', status: 'awaiting_approval', generation: 1, writeScope: 'artifact-only', generationPolicy: { task: 'document', requirement: 'required' } };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy', '.github/hooks'] } };
  const workflow = { workItem: { id: 'PMC-1' }, currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: {} };
  const file = path.join(root, definition.workItemRoot, 'PMC-1', 'workflow.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(workflow));
  git(['add', 'src', 'singularity']); git(['commit', '-qm', 'fixture']);
  const accepted = { definition, workflow };
  const enter = async (prompt, sessionId) => {
    const payload = { cwd: root, sessionId, prompt };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record, { resolveRoot: async () => root, load: async () => accepted }) });
    return payload;
  };
  return { root, enter };
}

test('the person-step guard\'s refusals name no hash beyond the command the agent itself sent', async (t) => {
  const { root, enter } = await guardFixture(t);
  const commands = [...new Set(GOLDEN.awaitingApproval.map((row) => row.command))];
  assert.ok(commands.length > 100, String(commands.length));
  const found = [];
  for (const turn of ['/sf-phase', '/sf-decide PMC-1', '/sf-approve', '(plain prompt)']) {
    const payload = await enter(turn === '(plain prompt)' ? 'Thanks. Now take care of the rest.' : turn, `no-hash-${turn}`);
    for (const command of commands) {
      const decision = await repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: root } });
      if (decision.permissionDecision !== 'deny') continue;
      // What the agent sent comes back to it as its own words; the guard adds no hash of its own.
      const own = command.match(HEX_RUN) ?? [];
      const said = [decision.permissionDecisionReason, ...(decision.next ?? []).flatMap((route) => [route?.label, route?.reason])].join('\n');
      for (const line of leaks(said, { strip: [root, ...own] })) found.push(`${turn} · ${command.slice(0, 80)}: ${line}`);
    }
  }
  assert.deepEqual(found, []);
});

// --- A reviewed Story, walked through the CLI: every person command's text, its cards, and VS Code's pages -----

function cite(source, needle) {
  const lines = source.text.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `${source.id} has no line with ${needle}`);
  return { sourceId: source.id, line: index + 1, quote: needle };
}

test('a reviewed quick-fix Story, walked through the CLI: no person text, card or page carries a hash', { timeout: 900_000 }, async (t) => {
  const repo = await repository(t, { implementCommands: false, reviews: true });
  const { root, sflowJson, must, run } = repo;
  const strip = [repo.base, root, os.tmpdir()];
  const found = [];
  const check = (label, text) => { for (const line of leaks(text, { strip })) found.push(`${label}: ${line}`); };
  const text = (...args) => {
    const result = run(process.execPath, [cli, '--no-model', ...args]);
    check(`sflow ${args.join(' ').slice(0, 100)}`, `${result.stdout}\n${result.stderr}`);
    return result;
  };
  const reads = (phase) => {
    for (const args of [['status'], ['nextsteps'], ['approvals'], ['phase', 'show', phase], ['decisions'], ['decision', 'show'], ['review-source', 'status', phase], ['gate']]) text(...args);
  };
  const workflow = async () => JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
  must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  text('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  text('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), ['# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '',
    'The value must be 2; change the exported constant.', '', '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    '| [QF-1:AC-001] | The exported value equals 2. |', '', '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  text('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  text('submit', 'intake');
  reads('intake');
  // The reviewer's work, through the CLI (review-every-step-cli.test.mjs walks it in full).
  const document = sflowJson('review-source', 'context', 'intake').value;
  text('review-source', 'context', 'intake');
  const report = { ...document.reportTemplate, findings: [],
    rows: document.sources.map((source, index) => ({ id: `row-${index + 1}`, ...cite(source, source.text.split(/\r?\n/u).find((line) => line.trim()).trim()), outcome: 'consistent' })) };
  const staged = sflowJson('review-source', 'stage', 'intake', '--report-json', JSON.stringify(report)).value;
  text('review-source', 'check', 'intake', '--report-file', staged.stagingPath);
  text('review-source', 'submit', 'intake', '--report-file', staged.stagingPath);
  text('submit', 'intake');
  reads('intake');
  text('receipt', 'show');
  // The approval card, as the terminal shows it before its typed confirmation (no terminal here: it stops there).
  text('approve', 'intake');

  // VS Code's Reviews and Approvals pages, drawn from this Story as it awaits approval.
  const [approvalsModel, inboxModel, reviews, approvalsPage, reviewForm] = await Promise.all([view('approvals-model.ts'), view('inbox-model.ts'),
    compiledView('inbox.ts'), compiledView('approvals.ts'), compiledView('approval-review.ts')]);
  const readiness = sflowJson('status', 'QF-1', '--submission-readiness').value;
  const snapshot = { initiative: null, initiatives: [], selectedInitiativeId: null, selectedWorkId: 'QF-1', workItems: [{ id: 'QF-1', title: 'Change the value' }],
    identities: { git: { email: 'run.test@example.invalid' } }, workflow: await workflow(),
    decisions: { schemaVersion: 1, workId: 'QF-1', decisions: [], ahead: null, pending: null, skipped: [], log: [] }, submissionReadiness: readiness };
  const approvals = approvalsModel.buildApprovals(snapshot);
  assert.ok(approvals.pending.some((entry) => entry.phase === 'intake'), 'intake waits for its approval');
  check('VS Code Reviews', visible(reviews.inboxHtml(inboxModel.buildInbox(snapshot))));
  check('VS Code Approvals', visible(approvalsPage.approvalsBodyHtml(approvals)));
  // The approval form, with a witness and the artifact's digest in what it was given.
  const digest = (letter) => `sha256:${`${letter}1`.repeat(32)}`;
  check('VS Code approval form', visible(reviewForm.approvalReviewBody({ title: 'Approve Intake', expected: 'intake', workId: 'QF-1', phaseId: 'intake',
    phaseLabel: 'Intake', generation: 1, artifact: { path: 'singularity/work-items/QF-1/artifacts/intake/intake.md', sha256: digest('a') }, articles: [], findings: [],
    witnessedClauses: null, priorExceptions: [], selfApproval: false,
    witnessMappings: [{ mappingSha256: digest('b'), clauseId: 'QF-1:AC-001', clauseText: 'The exported value equals 2.', clauseFields: { behavior: 'returns 2', observable: 'the value' },
      clauseStatus: 'current', sourcePath: 'test/value.test.mjs', logicalTestId: digest('c'), sourceDeclarationSha256: digest('d') }] })));
  text('approve', 'intake', '--yes');
  text('resume', 'QF-1');

  // The code step: published, reviewed with a correction, rolled over by the person, reviewed again, submitted.
  text('prepare', 'implement');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 — return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
  text('prepare', 'implement');
  text('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  const codeReport = (packet, blocking) => {
    const source = (relative) => packet.sources.find((entry) => entry.path === relative);
    return { ...packet.reportTemplate, unplannedPaths: [], qualityReviewed: packet.code.quality.map((entry) => entry.id),
      rows: [{ clauseId: 'QF-1:AC-001', implementation: [cite(source('src/value.mjs'), 'export const value = 2;')],
        tests: [cite(source('test/value.test.mjs'), "test('returns two', () => assert.equal(value, 2));")], assessment: 'implemented', testAssessment: 'proves' }],
      findings: blocking ? [{ id: 'explain-the-value', severity: 'blocking', check: 'plan', clauseId: 'QF-1:AC-001',
        message: 'The clause comment must say why the value is 2.', ...cite(source('src/value.mjs'), '// @clause:QF-1:AC-001') }] : [] };
  };
  const first = sflowJson('review-source', 'context', 'implement').value;
  const corrected = sflowJson('review-source', 'stage', 'implement', '--report-json', JSON.stringify(codeReport(first, true))).value;
  text('review-source', 'submit', 'implement', '--report-file', corrected.stagingPath);
  reads('implement');
  text('submit', 'implement');
  // The rollover a review asks for: its preview names the review by its generation and asks for no digest.
  const preview = text('phase', 'rollover', 'implement');
  assert.match(preview.stdout, /"Correct what the review of generation 1 found: .*explain-the-value/u);
  assert.match(preview.stdout, /Shell: singularity-flow phase rollover implement\n/u, 'a person confirms in their own terminal');
  if (TYPED_TERMINAL_AVAILABLE) {
    // In a person's own terminal the same command asks them, and opens the generation bound to what it showed.
    const typed = await typedInTerminal({ argv: [process.execPath, cli, '--no-model', 'phase', 'rollover', 'implement'], cwd: root, env: repo.env,
      prompt: 'Type yes to start implement generation 2, or press Enter to cancel: ', answer: 'yes' });
    assert.equal(typed.status, 0, typed.output);
    check('sflow phase rollover implement (typed yes)', typed.output);
    assert.match(typed.output, /Opened implement generation 2 for the change asked for\./u);
  } else {
    // No terminal to type in here: the agent's route, with the confirmation it passes after the person's yes.
    sflowJson('phase', 'rollover', 'implement', '--confirm', sflowJson('phase', 'rollover', 'implement').value.confirmation);
  }
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 — return the approved value 2, as the intake asks\nexport const value = 2;\n');
  text('prepare', 'implement');
  text('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  const second = sflowJson('review-source', 'context', 'implement').value;
  const ready = sflowJson('review-source', 'stage', 'implement', '--report-json', JSON.stringify(codeReport(second, false))).value;
  text('review-source', 'submit', 'implement', '--report-file', ready.stagingPath);
  text('submit', 'implement');
  reads('implement');
  text('report');

  // The decision card: an issue raised against the code step, on the terminal's list, its preview, and VS Code's card.
  const raised = text('upstream-issue', 'raise', '--phase', 'intake', '--about', 'QF-1:AC-001', '--problem', 'The value is not documented for its callers.');
  assert.equal(raised.status, 0, `${raised.stdout}\n${raised.stderr}`);
  text('decisions');
  text('decisions', '--choose', 'd1=dismiss', '--reason', 'd1=Callers read the test.');
  const listed = sflowJson('decisions').value;
  const packet = listed.data ?? listed;
  assert.ok(packet.items.some((item) => item.kind === 'upstream-issue'), JSON.stringify(listed).slice(0, 3000));
  const { decideHtml } = await view('decide-card-page.ts');
  check('VS Code decisions card', visible(decideHtml(packet)));
  const [{ decisionListHtml }, { buildDecisionListView }] = await Promise.all([view('decision-list-page.ts'), view('decision-list-model.ts')]);
  check('VS Code decision list', visible(decisionListHtml(buildDecisionListView(packet))));

  assert.deepEqual(found, [], 'a person read a hash');
});

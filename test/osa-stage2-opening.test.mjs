/**
 * SPEC-OSA v1.1 Stage 2: one person's yes opens one shared version, despite races, crashes and replays
 * [OSA:REQ-030–REQ-034, AC-015, AC-016, AC-017; plan section 4].
 *
 * Every Story here is a real repository with its Story branch pushed to a local bare remote; every opening goes through
 * the CLI or the same functions the CLI calls (src/commands/phase-opening.mjs, src/story-version-opening.mjs). Expected
 * values come from the specification: the checkpoints of section 7.2, the receipt of section 7.1, the fence of 7.3.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { approvedSpecificationStory, implementationPlan, CLI } from './helpers/submitted-planning-story.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationPostToolGuard, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { gitDirectories, readCheckpoint } from '../src/story-version-acceptance.mjs';
import { consentProblem, consentReceipt } from '../src/story-version-consent.mjs';
import { openVersion, takeOverWriter, versionProposal } from '../src/story-version-opening.mjs';

const DRIVER = fileURLToPath(new URL('./helpers/opening-fault-driver.mjs', import.meta.url));
const json = (result) => JSON.parse(result.stdout);
const record = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));

/** A Story whose code step `implementation` published version 1, its branch pushed; `prepare` opened version 1 through the operation. */
async function publishedCode(t, WORK) {
  const story = await approvedSpecificationStory(t, WORK);
  const { root, cli, item } = story;
  const write = async (relative, text) => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), text); };
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks'); cli('approve', 'planning', '--yes');
  const beforeOpening = story.git('rev-parse', 'HEAD');
  cli('prepare', 'implementation');
  const clauses = [`${WORK}:AC-001`, `${WORK}:REQ-002`];
  const code = (value) => `${clauses.map((clause) => `// @clause:${clause} returns the approved value to its callers\n`).join('')}export const value = ${value};\n`;
  await write('src/value.mjs', code(1));
  await write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n${clauses.map((clause) => `// @ac:${clause}\n`).join('')}test('value', () => assert.ok(value >= 1));\n`);
  await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), ['# Implementation summary', '', '## Agent brief', '',
    'Added the value module; both clauses have one focused test that reads the approved value.', '', '## Changed components and decisions', '',
    '- `src/value.mjs` exports the approved value.', '', '## Tests and operational notes', '', '`test/value.test.mjs` verifies the value.', ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/implementation/operator-notes.md'), ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  const branch = story.git('branch', '--show-current');
  return { ...story, remote: path.join(story.directory, 'origin.git'), write, code, branch, beforeOpening,
    remoteHead: () => story.git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s+/u)[0] };
}

/** Preview version 2 for a change the person asks for: the confirmation and its question. */
function previewChange(story, words = 'Return the value with its unit') {
  const preview = json(story.cli('phase', 'rollover', 'implementation', '--reason', words, '--json'));
  assert.match(preview.confirmation, /^sha256:[a-f0-9]{64}$/u);
  return preview;
}

/** Commits on the remote Story branch whose subject opens a version. */
const openingCommits = (story) => story.git('log', '--format=%s', `origin/${story.branch}`).split('\n').filter((line) => /^Open implementation version/u.test(line));

test('version 1 opens through the one operation: committed with only its metadata, pushed, with no consent asked [OSA:REQ-031, §7.2]', async (t) => {
  const story = await publishedCode(t, 'OSA2-V1');
  const opening = (await record(story.item)).phases.implementation.versionOpening;
  assert.equal(opening.version, 1);
  assert.equal(opening.highWatermark, 1, 'the reservation advanced the high-watermark in the same commit');
  assert.equal(opening.consent, null, 'only the first opening of version 1 needs no yes');
  assert.match(opening.operationId, /^vo-[0-9a-f]{32}$/u);
  // The opening's own commit, on the shared branch: only the Story's metadata, never source or the step's draft.
  const commits = story.git('log', '--format=%H %s', `${story.beforeOpening}..origin/${story.branch}`).split('\n').filter((line) => / Open implementation version 1 /u.test(` ${line.split(' ').slice(1).join(' ')} `));
  assert.equal(commits.length, 1, commits.join('\n'));
  const files = story.git('show', '--name-only', '--format=', commits[0].split(' ')[0]).split('\n').filter(Boolean);
  assert.ok(files.length >= 3, files.join('\n'));
  // The Story's metadata only: its record, status, the opening, its generation start and interval, and the event's ledger intent.
  for (const file of files) assert.match(file, /^singularity\/work-items\/OSA2-V1\/(?:workflow\.json|STATUS\.md|context\/(?:version-openings|generation-start|work-intervals|ledger-intents)\/)/u, file);
  assert.ok(files.includes(opening.path));
  const committed = JSON.parse(story.git('show', `${commits[0].split(' ')[0]}:${opening.path}`));
  assert.equal(committed.schema, 'version-opening/v1');
  assert.equal(committed.proposal.version, 1);
  assert.equal(committed.writer.fence, 1);
  // Its checkpoint on this clone: shared acceptance confirmed.
  const checkpoint = readCheckpoint(gitDirectories(story.root).commonDir, 'OSA2-V1', opening.operationId);
  assert.equal(checkpoint.state, 'shared-confirmed');
  assert.deepEqual(checkpoint.history.map((entry) => entry.state).filter((state, index, all) => all.indexOf(state) === index),
    ['prepared', 'locally-persisted', 'shared-confirmed']);
});

test('a successor opens only on the person\'s yes, binds their sealed receipt, keeps source uncommitted, and replays without a question [OSA:REQ-030, REQ-031, REQ-033]', async (t) => {
  const story = await publishedCode(t, 'OSA2-YES');
  const { root, item, cli, run, git } = story;
  // Unrelated work and a local attachment, present when the version opens: never staged by it.
  await writeFile(path.join(root, 'NOTES.txt'), 'unrelated local notes\n');
  await mkdir(path.join(item, 'documents'), { recursive: true });
  await writeFile(path.join(item, 'documents', 'local-only.txt'), 'an attachment kept on this laptop\n');
  // A Copilot /sf-code turn: the preview runs, its question has the actual numbers and promises no unrecorded tests.
  const hook = { cwd: root, sessionId: 'osa2-yes', prompt: '/sf-code implementation Return the value with its unit' };
  await recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, value) => captureMutationTurn(payload, value, { resolveRoot: async () => root }) });
  const preview = previewChange(story);
  assert.equal(preview.question, 'Start version 2 of Implementation? Published version 1 will stay unchanged.');
  const before = await record(item);
  // In the turn, the confirmation opens nothing without the person's yes; a model-written receipt file is not one.
  const consents = path.join(gitDirectories(root).commonDir, 'singularity-flow', 'version-consents');
  const kept = JSON.parse(await readFile(path.join(consents, `${createHash('sha256').update(preview.confirmation).digest('hex').slice(0, 40)}.proposal.json`), 'utf8'));
  await writeFile(path.join(consents, `${createHash('sha256').update(kept.digest).digest('hex').slice(0, 40)}.grant.json`), JSON.stringify({
    schema: 'version-opening-grant/v1', proposalDigest: kept.digest, surface: 'question-tool', answer: 'yes', expiresAt: '2999-01-01T00:00:00.000Z' }));
  const refused = run(process.execPath, [CLI, '--no-model', ...preview.argv, '--json'], { allowFailure: true });
  assert.equal(json(refused).error.code, 'VERSION_CONSENT_REQUIRED');
  assert.deepEqual(await record(item), before, 'refused, it opened nothing');
  // The person's yes, as the host hands it to the hooks, to the preview's own question.
  await mutationPostToolGuard({ ...hook, toolName: 'ask_user', toolArgs: { question: preview.question },
    toolResult: { resultType: 'success', textResultForLlm: 'User responded: Yes' } });
  assert.deepEqual(await mutationToolGuard({ ...hook, toolName: 'bash', toolArgs: { command: preview.command, cwd: root } }), {});
  const opened = json(run(process.execPath, [CLI, '--no-model', ...preview.argv, '--json']));
  assert.equal(opened.opening.version, 2);
  assert.equal(opened.opening.pushed, true);
  assert.equal(opened.opening.consent.surface, 'question-tool');
  assert.equal(opened.opening.consent.assurance, 'host-answer');
  // The receipt, committed with the opening: bound to the proposal, the principal, the time and its expiry.
  const after = await record(item);
  const pointer = after.phases.implementation.versionOpening;
  const committed = JSON.parse(git('show', `origin/${story.branch}:${pointer.path}`));
  assert.equal(committed.consent.schema, 'version-opening-consent/v1');
  assert.equal(committed.consent.proposalDigest, committed.proposalDigest);
  assert.deepEqual(committed.consent.binding, { workId: 'OSA2-YES', phase: 'implementation', version: 2, from: 1, confirmation: preview.confirmation });
  assert.equal(committed.consent.principal.identity.name, 'History Tester', 'the identity this machine resolves, never a model value');
  assert.equal(Date.parse(committed.consent.expiresAt) - Date.parse(committed.consent.confirmedAt), 30 * 60 * 1000);
  assert.match(committed.consent.response.question, /start version 2 of implementation/u);
  assert.equal(pointer.highWatermark, 2);
  // Source and unrelated files stay uncommitted: the opening commit has only metadata.
  const files = git('show', '--name-only', '--format=', `origin/${story.branch}`).split('\n').filter(Boolean);
  assert.ok(files.every((file) => file.startsWith('singularity/work-items/OSA2-YES/') && !file.includes('/documents/') && !file.includes('/artifacts/')), files.join('\n'));
  assert.match(git('status', '--porcelain', '--untracked-files=all'), /NOTES\.txt/u);
  assert.match(git('status', '--porcelain', '--untracked-files=all'), /documents\/local-only\.txt/u);
  // The same confirmation again (a lost reply): the original outcome, no commit, no question, though its grant is gone.
  const head = git('rev-parse', 'HEAD');
  const replay = json(run(process.execPath, [CLI, '--no-model', ...preview.argv, '--json']));
  assert.equal(replay.replayed, true);
  assert.equal(replay.opening.operationId, opened.opening.operationId);
  assert.equal(replay.opening.commit, opened.opening.commit);
  assert.equal(git('rev-parse', 'HEAD'), head, 'no duplicate opening');
  assert.equal(openingCommits(story).filter((line) => /version 2 /u.test(`${line} `)).length, 1);
  // `phase begin` on the open version settles the same opening too.
  assert.equal(json(cli('phase', 'begin', 'implementation', '--json')).opening.operationId, opened.opening.operationId);
  assert.equal(git('rev-parse', 'HEAD'), head);
});

test('consent that is declined, expired, for another proposal, another person\'s, or not sealed here opens nothing [OSA:REQ-030, AC-021]', async (t) => {
  const story = await publishedCode(t, 'OSA2-NO');
  const { root, item, git } = story;
  previewChange(story);
  const { loadAcceptedStoryExecution } = await import('../src/accepted-story-execution.mjs');
  const loaded = async () => { const accepted = await loadAcceptedStoryExecution(root, 'OSA2-NO'); return { ...accepted, phase: accepted.workflow.phases.implementation }; };
  const { workflow, phase, definition } = await loaded();
  const { proposal, digest, question } = versionProposal(workflow, phase, { reason: 'requested-change', lifecycleRevision: git('rev-parse', 'HEAD') });
  const { commonDir } = gitDirectories(root);
  const person = { name: 'History Tester', email: null, login: null };
  const mint = (overrides = {}) => consentReceipt(commonDir, { proposal, digest, surface: 'terminal', question, principal: person, assurance: 'terminal-tty', ...overrides });
  const cases = {
    VERSION_CONSENT_DECLINED: mint({ answer: 'no' }),
    VERSION_CONSENT_EXPIRED: mint({ confirmedAt: Date.now() - 31 * 60 * 1000 }),
    VERSION_CONSENT_WRONG_TARGET: consentReceipt(commonDir, { proposal: { ...proposal, version: 3 }, digest: `sha256:${'e'.repeat(64)}`, surface: 'terminal', question, principal: person, assurance: 'terminal-tty' }),
    VERSION_CONSENT_PRINCIPAL_CHANGED: mint({ principal: { name: 'Someone Else', email: 'else@example.test' } }),
    VERSION_CONSENT_UNVERIFIED: { ...mint(), machineLocalIntegrity: { scheme: 'machine-local-hmac-sha256-v1', purpose: 'version-opening-consent', keyId: '0'.repeat(16), mac: `sha256:${'0'.repeat(64)}` } },
    VERSION_CONSENT_REQUIRED: null
  };
  const before = await record(item);
  for (const [code, receipt] of Object.entries(cases)) {
    assert.equal(consentProblem(commonDir, receipt, { digest, proposal, principal: { name: 'History Tester' } })?.code, code, code);
    const fresh = await loaded();
    await assert.rejects(openVersion(root, fresh.definition ?? definition, fresh.workflow, fresh.phase, { proposal, digest, receipt, principal: { name: 'History Tester' },
      open: async () => null }), (error) => { assert.equal(error.code, code); return true; }, code);
  }
  assert.deepEqual(await record(item), before);
  assert.equal(openingCommits(story).length, 1, 'only version 1 was ever opened');
  // A hand-written open version 2 in the working copy is no opening: the edit guard grants nothing for it.
  const forged = await record(item);
  const operationId = `vo-${'9'.repeat(32)}`;
  forged.phases.implementation.generationIntent = { ...forged.phases.implementation.generationIntent, status: 'open', generation: 2 };
  forged.phases.implementation.versionOpening = { operationId, version: 2, highWatermark: 2, writer: { fence: 1, writerId: `vw-${'9'.repeat(32)}`, operationId } };
  await writeFile(path.join(item, 'workflow.json'), JSON.stringify(forged));
  const hook = { cwd: root, sessionId: 'osa2-forged', prompt: '/sf-code implementation' };
  await recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, value) => captureMutationTurn(payload, value, { resolveRoot: async () => root }) });
  const edit = await mutationToolGuard({ ...hook, toolName: 'edit', toolArgs: { path: path.join(root, 'src/value.mjs') } });
  assert.equal(edit.permissionDecision, 'deny', JSON.stringify(edit));
});

test('two checkouts propose the same successor: exactly one opens it, the other gets a conflict and the current action [OSA:AC-015]', async (t) => {
  const story = await publishedCode(t, 'OSA2-RACE');
  const { directory, root, run } = story;
  const other = path.join(directory, 'second');
  run('git', ['clone', '-q', story.remote, other], { cwd: directory });
  run('git', ['-C', other, 'checkout', '-q', story.branch], { cwd: directory });
  run('git', ['-C', other, 'config', 'user.name', 'History Tester'], { cwd: directory });
  run('git', ['-C', other, 'config', 'user.email', 'history@example.test'], { cwd: directory });
  const cliAt = (cwd, ...args) => run(process.execPath, [CLI, '--no-model', ...args], { cwd, allowFailure: true });
  // Both preview version 2 from the same basis; each person says yes in their own terminal.
  const first = json(cliAt(root, 'phase', 'rollover', 'implementation', '--reason', 'Return the value with its unit', '--json'));
  const second = json(cliAt(other, 'phase', 'rollover', 'implementation', '--reason', 'Return the value with its unit', '--json'));
  assert.equal(first.toGeneration, 2); assert.equal(second.toGeneration, 2);
  // Truly concurrent: the second checkout commits its opening, and before its push the first opens version 2 and pushes.
  const raced = spawnSync(process.execPath, [DRIVER, other, 'implementation', second.confirmation, 'after-commit', 'race'], { cwd: other, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'History Tester', OSA2_RACE_CWD: root,
      OSA2_RACE_ARGV: JSON.stringify([CLI, '--no-model', ...first.argv, '--json']) }, timeout: childTimeout(240_000) });
  assert.match(raced.stderr, /race: the other checkout's opening exited 0/u, raced.stderr.slice(-1500));
  const winner = (await record(story.item)).phases.implementation.versionOpening;
  // The loser's push is refused by the shared branch's lease: a conflict, its own commit kept unpublished, and the current
  // action, which follows the shared branch; nothing of it was published.
  const lost = JSON.parse(raced.stdout.trim().split('\n').at(-1));
  assert.equal(lost.ok, false);
  assert.equal(lost.code, 'VERSION_OPENING_CONFLICT', raced.stdout.slice(-1500));
  assert.match(lost.details.nextAction.command, /^singularity-flow sync OSA2-RACE --set-aside$/u);
  assert.equal(story.remoteHead(), story.git('rev-parse', 'HEAD'), 'the shared branch holds the winner\'s opening');
  assert.equal(openingCommits(story).filter((line) => /version 2 /u.test(`${line} `)).length, 1);
  // The same confirmation in the losing checkout replays its refusal: never a second attempt, never version 3.
  const again = json(cliAt(other, ...second.argv, '--json'));
  assert.equal(again.error.code, 'VERSION_OPENING_CONFLICT');
  // The kernel in the losing checkout grants nothing in its refused opening and names settling it, never version 3.
  const hook = { cwd: other, sessionId: 'osa2-loser', prompt: '/sf-code implementation' };
  await recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, value) => captureMutationTurn(payload, value, { resolveRoot: async () => other }) });
  const edit = await mutationToolGuard({ ...hook, toolName: 'edit', toolArgs: { path: path.join(other, 'src/value.mjs') } });
  assert.equal(edit.permissionDecision, 'deny');
  assert.match(JSON.stringify(edit.next), /phase opening implementation --reconcile/u);
  // A third checkout, cloned now, sees the winner's opening: version 2, written by the first checkout, open to inspection.
  const third = path.join(directory, 'third');
  run('git', ['clone', '-q', story.remote, third], { cwd: directory });
  run('git', ['-C', third, 'checkout', '-q', story.branch], { cwd: directory });
  const seen = json(cliAt(third, 'phase', 'opening', 'implementation', '--json'));
  assert.equal(seen.opening.version, 2);
  assert.equal(seen.opening.operationId, winner.operationId);
  assert.equal(seen.opening.writer.current, false);
});

/** Run the fault driver at `point` (`kill`: the process dies there), then the same confirmation again. */
function crashAt(story, preview, point, how = 'kill') {
  return spawnSync(process.execPath, [DRIVER, story.root, 'implementation', preview.confirmation, point, how], { cwd: story.root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'History Tester' }, timeout: childTimeout(120_000) });
}

for (const [point, how] of [['before-reservation', 'kill'], ['after-commit', 'kill'], ['after-push', 'kill'], ['after-ledger', 'kill'], ['before-reply', 'kill'], ['before-reservation', 'throw']]) {
  test(`a fault ${how === 'kill' ? 'killing the process' : 'raised'} at ${point} opens one version 2, commits no source and loses no local work [OSA:AC-016]`, async (t) => {
    const story = await publishedCode(t, `OSA2-F-${point.replace(/[^a-z]/gu, '').slice(0, 10).toUpperCase()}`);
    const { root, git, run, item } = story;
    await writeFile(path.join(root, 'src', 'local-draft.mjs'), 'export const draft = true;\n');
    const preview = previewChange(story);
    const crashed = crashAt(story, preview, point, how);
    assert.notEqual(crashed.status, 0, `${point}: the driver stopped there`);
    // Nothing granted while uncertain, and nothing replaced: the same confirmation settles the same operation.
    let settled = run(process.execPath, [CLI, '--no-model', ...preview.argv, '--json'], { allowFailure: true });
    if (settled.status !== 0) {
      const code = json(settled).error.code;
      assert.ok(['VERSION_OPENING_SHARED_PENDING', 'VERSION_OPENING_OUTCOME_UNKNOWN', 'PUBLICATION_JOURNAL_CONFLICT', 'PUBLICATION_PENDING'].includes(code), `${point}: ${code}`);
      // The retained commit is published by the Story's own sync, then the same opening settles.
      run(process.execPath, [CLI, '--no-model', 'sync', story.workId ?? (await record(item)).workItem.id], { allowFailure: true });
      settled = run(process.execPath, [CLI, '--no-model', ...preview.argv, '--json'], { allowFailure: true });
    }
    assert.equal(settled.status, 0, `${point}: ${settled.stdout.slice(-1500)}${settled.stderr.slice(-800)}`);
    const outcome = json(settled).opening;
    assert.equal(outcome.version, 2);
    const workflow = await record(item);
    assert.equal(workflow.phases.implementation.generationIntent.status, 'open');
    assert.equal(workflow.phases.implementation.generationIntent.generation, 2);
    assert.equal(workflow.phases.implementation.versionOpening.operationId, outcome.operationId);
    assert.equal(openingCommits(story).filter((line) => /version 2 /u.test(`${line} `)).length, 1, `${point}: exactly one opening of version 2`);
    assert.equal(openingCommits(story).filter((line) => /version 3 /u.test(`${line} `)).length, 0, `${point}: no replacement version`);
    assert.equal(story.remoteHead(), git('rev-parse', 'HEAD'));
    assert.equal(git('log', '--format=%H', '--', 'src/local-draft.mjs'), '', `${point}: the local draft was never committed`);
    assert.equal(await readFile(path.join(root, 'src', 'local-draft.mjs'), 'utf8'), 'export const draft = true;\n', `${point}: local work kept`);
    assert.equal(readCheckpoint(gitDirectories(root).commonDir, workflow.workItem.id, outcome.operationId).state, 'shared-confirmed');
  });
}

test('an opening whose push is lost stays unaccepted: no edits, no replacement, until the same operation settles [OSA:REQ-033, AC-016]', async (t) => {
  const story = await publishedCode(t, 'OSA2-OFF');
  const { root, git, run, remote, item } = story;
  const preview = previewChange(story);
  // The remote goes away: the commit is kept here, its shared acceptance pending.
  await rename(remote, `${remote}.away`);
  const offline = run(process.execPath, [CLI, '--no-model', ...preview.argv, '--json'], { allowFailure: true });
  assert.notEqual(offline.status, 0);
  assert.match(json(offline).error.code, /^VERSION_OPENING_(?:SHARED_PENDING|OUTCOME_UNKNOWN)$/u, offline.stdout.slice(0, 800));
  const workflow = await record(item);
  const operationId = workflow.phases.implementation.versionOpening.operationId;
  assert.notEqual(readCheckpoint(gitDirectories(root).commonDir, workflow.workItem.id, operationId).state, 'shared-confirmed');
  // The edit guard grants nothing in it, and names the same operation's settlement, never another version.
  const hook = { cwd: root, sessionId: 'osa2-offline', prompt: '/sf-code implementation' };
  await recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, value) => captureMutationTurn(payload, value, { resolveRoot: async () => root }) });
  const edit = await mutationToolGuard({ ...hook, toolName: 'edit', toolArgs: { path: path.join(root, 'src/value.mjs') } });
  assert.equal(edit.permissionDecision, 'deny');
  assert.match(JSON.stringify(edit.next), /phase opening implementation --reconcile/u);
  const again = run(process.execPath, [CLI, '--no-model', 'phase', 'rollover', 'implementation', '--reason', 'Another change', '--json'], { allowFailure: true });
  assert.notEqual(again.status, 0, 'no replacement version is proposed while version 2 is uncertain');
  // Still offline, settling says unknown and changes nothing; with the remote back, it publishes the same commit.
  const unknown = run(process.execPath, [CLI, '--no-model', 'phase', 'opening', 'implementation', '--reconcile', '--json'], { allowFailure: true });
  assert.notEqual(unknown.status, 0);
  await rename(`${remote}.away`, remote);
  const settled = json(run(process.execPath, [CLI, '--no-model', 'phase', 'opening', 'implementation', '--reconcile', '--json']));
  assert.equal(settled.settled, 'shared-confirmed');
  assert.equal(settled.outcome.operationId, operationId);
  assert.equal(story.remoteHead(), git('rev-parse', 'HEAD'));
  assert.equal(openingCommits(story).filter((line) => /version 2 /u.test(`${line} `)).length, 1);
  await refreshTurn(hook, root);
  assert.deepEqual(await mutationToolGuard({ ...hook, toolName: 'edit', toolArgs: { path: path.join(root, 'src/value.mjs') } }), {}, 'accepted: written now');
});

/** The turn's grant is derived again from what the checkout now holds (a new prompt in the same chat). */
async function refreshTurn(hook, root) {
  await recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, value) => captureMutationTurn(payload, value, { resolveRoot: async () => root }) });
}

test('a second checkout sees the opening after refresh, may inspect it, and writes only after a verified takeover fences the first [OSA:REQ-034, AC-017]', async (t) => {
  const story = await publishedCode(t, 'OSA2-H');
  const { directory, root, run, git } = story;
  const preview = previewChange(story);
  const opened = json(run(process.execPath, [CLI, '--no-model', ...preview.argv, '--json'])).opening;
  // A second checkout of the same remote, refreshed: the opening is visible there, its writer is the first checkout.
  const other = path.join(directory, 'second');
  run('git', ['clone', '-q', story.remote, other], { cwd: directory });
  run('git', ['-C', other, 'checkout', '-q', story.branch], { cwd: directory });
  run('git', ['-C', other, 'config', 'user.name', 'History Tester'], { cwd: directory });
  run('git', ['-C', other, 'config', 'user.email', 'history@example.test'], { cwd: directory });
  const at = (cwd, ...args) => run(process.execPath, [CLI, '--no-model', ...args], { cwd, allowFailure: true });
  const seen = json(at(other, 'phase', 'opening', 'implementation', '--json'));
  assert.equal(seen.opening.operationId, opened.operationId);
  assert.equal(seen.opening.writer.current, false, 'the first checkout writes it');
  assert.equal(seen.checkpoint, null, 'this checkout observed no acceptance of its own');
  const hook = { cwd: other, sessionId: 'osa2-second', prompt: '/sf-code implementation' };
  await refreshTurn(hook, other);
  const fenced = await mutationToolGuard({ ...hook, toolName: 'edit', toolArgs: { path: path.join(other, 'src/value.mjs') } });
  assert.equal(fenced.permissionDecision, 'deny');
  assert.match(JSON.stringify(fenced.next), /session takeover OSA2-H/u, 'it may take over, never write beside the first');
  const publish = at(other, 'phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place', '--json');
  assert.equal(json(publish).error.code, 'VERSION_WRITER_FENCED');
  // The verified takeover's fence: one leased commit names this checkout's writer, fence 2.
  const { loadAcceptedStoryExecution } = await import('../src/accepted-story-execution.mjs');
  const accepted = await loadAcceptedStoryExecution(other, 'OSA2-H');
  const taken = await takeOverWriter(other, accepted.definition ?? accepted.config, accepted.workflow, accepted.workflow.phases.implementation,
    { principal: { name: 'History Tester' } });
  assert.equal(taken.taken, true);
  assert.equal(taken.fence, opened.writer.fence + 1, 'the takeover moves the fence one past the opening\'s');
  await refreshTurn(hook, other);
  assert.deepEqual(await mutationToolGuard({ ...hook, toolName: 'edit', toolArgs: { path: path.join(other, 'src/value.mjs') } }), {}, 'the new writer writes');
  // The first checkout, stale: its next consequential step is refused by the shared branch; once refreshed, by the fence.
  const stale = json(run(process.execPath, [CLI, '--no-model', 'phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place', '--json'], { allowFailure: true }));
  assert.match(stale.error.code, /^(?:STORY_PUBLICATION_REMOTE_DIVERGED|VERSION_WRITER_FENCED|PHASE_)/u, JSON.stringify(stale.error).slice(0, 500));
  run('git', ['pull', '-q', '--ff-only', 'origin', story.branch]);
  const firstHook = { cwd: root, sessionId: 'osa2-first', prompt: '/sf-code implementation' };
  await refreshTurn(firstHook, root);
  const old = await mutationToolGuard({ ...firstHook, toolName: 'edit', toolArgs: { path: path.join(root, 'src/value.mjs') } });
  assert.equal(old.permissionDecision, 'deny', 'the old writer is fenced');
  assert.equal(json(run(process.execPath, [CLI, '--no-model', 'phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place', '--json'], { allowFailure: true })).error.code, 'VERSION_WRITER_FENCED');
  assert.equal(git('log', '-1', '--format=%s', `origin/${story.branch}`), 'Take over implementation version 2 of OSA2-H');
});

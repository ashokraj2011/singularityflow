import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { authoredArtifactText } from '../src/artifact-review-read.mjs';
import { main } from '../src/cli.mjs';
import { approveCommand } from '../src/commands/approve.mjs';
import { run as guard } from '../src/commands/guard.mjs';
import { recordRepositoryBoundaryTurn, repositoryToolGuard } from '../src/copilot-repository-boundary.mjs';
import { composeEvidenceReceipt, renderEvidenceReceipt } from '../src/evidence-receipt.mjs';
import { runGovernanceGate } from '../src/governance.mjs';
import {
  attributionBlock, attributionCardLines, attributionDigest, attributionGateWarnings, attributionLabels, governedRecordPath,
  packetFileStanding, sinceTime, storyAttributionBlock, unavailableAttribution
} from '../src/presence/attribution.mjs';
import { PRESENCE_CHAIN_PATH } from '../src/presence/chain.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { forgetPresenceContexts } from '../src/presence/person-records.mjs';
import { setPersonStepPresenceDependencies } from '../src/presence/person-steps.mjs';
import { authoredView } from '../src/presence/reconcile.mjs';
import { remotePresenceCheck, remotePresenceText } from '../src/presence/remote-check.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { readStoryReviewPacket } from '../src/story-lineage.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { specification, startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

// SF Guard part 2, G3 (SPEC-SFG-v1 §7 and §8, AC-008 to AC-010): the labels join the review packet, so
// the approval that signs its digest seals them; the card shows them before Touch ID, the receipt and
// the remote check notice a sealed packet changed afterwards, and the final check lists them as
// advisory lines only. Software stand-ins for the Secure Enclave and GitHub are passed in-process.

const WORK = 'SFG-G3';
const ONE = { name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' };

const snapshot = (keys) => ({ status: 'listed', keys: keys.map((key) => ({ keyId: key.keyId, line: key.line })),
  snapshotSha256: `sha256:${'a'.repeat(64)}`, fetchedAt: new Date().toISOString(), reason: null });

function guardPerson(email, keys) {
  const byId = new Map(keys.map((key) => [key.keyId, key]));
  return {
    identify: () => ({ email, login: null }),
    listIdentities: () => ({ available: true, reason: null, identities: parseCtkListing(ctkListing(keys.map((key) => ({ keyId: key.keyId })))) }),
    readableCopies: () => [],
    publicKeyOf: async (keyId) => byId.get(keyId)?.line ?? null,
    githubKeys: async () => snapshot(keys),
    card: (fields) => JSON.stringify(fields),
    sign: async ({ statement, keyId }) => ({ signature: byId.get(keyId).sign(statementText(statement)), userVerification: false }),
    requiredCheck: async () => ({ status: 'not-required', contexts: ['build'], reason: null })
  };
}

async function inRoot(root, action) {
  const previous = process.cwd();
  const log = console.log;
  const warn = console.warn;
  const lines = [];
  process.chdir(root);
  console.log = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  try { return { value: await action(), lines }; }
  catch (error) { return { error, lines }; }
  finally { console.log = log; console.warn = warn; process.chdir(previous); }
}

function signer(key) {
  return {
    personTerminal: () => ({ person: true, reason: null }), signerAvailability: () => ({ available: true, reason: null }),
    holdsKey: async (keyId) => keyId === key.keyId,
    card: async (fields) => JSON.stringify(fields),
    sign: async ({ statement }) => ({ signature: key.sign(statementText(statement)), userVerification: false })
  };
}

async function guardRun(root, words, deps, options = {}) {
  return inRoot(root, () => guard(['guard', ...words], { positionals: ['guard', ...words], options: { json: true, ...options } }, deps));
}

const REPORT = (overrides = {}) => ({
  scope: { kind: 'story', base: 'b'.repeat(40) }, lines: 30, files: 4, removed: 2, partial: null, rangesOmitted: 0,
  counts: { declared: 10, 'outside-workflow': 9, 'unknown-agent': 2, shell: 3, unattributed: 5, 'pre-guard': 1 },
  ranges: [
    { path: 'src/a.js', start: 1, end: 10, classification: 'declared', agent: 'developer', skill: 'sf-code' },
    { path: 'src/b.js', start: 1, end: 6, classification: 'outside-workflow', agent: null, skill: null },
    { path: 'src/c.js', start: 4, end: 6, classification: 'outside-workflow', agent: null, skill: null },
    { path: 'src/d.js', start: 1, end: 2, classification: 'unknown-agent', agent: null, skill: 'house-style', continued: true },
    { path: 'src/e.js', start: 1, end: 3, classification: 'shell', agent: 'developer', skill: 'sf-code', command: 'abc' },
    { path: 'src/f.js', start: 1, end: 5, classification: 'unattributed' },
    { path: 'src/g.js', start: 1, end: 1, classification: 'pre-guard' }
  ],
  ...overrides
});

test('SFG REQ-040 to REQ-042: the block is small and sealed, its labels name each class in words, and none refuses', () => {
  const block = attributionBlock(REPORT(), { pin: { status: 'required' }, authorship: { producer: 'human', generation: 1 } });
  assert.equal(block.schema, 'sfg-attribution/1');
  assert.equal(block.sha256, attributionDigest(block), 'the block carries its own digest');
  assert.deepEqual(block.counts, REPORT().counts);
  assert.deepEqual(block.items[0], { classification: 'outside-workflow', agent: null, skill: null, lines: 9, files: 2 },
    'the top item groups one class, agent and skill across files');
  assert.ok(!block.items.some((item) => ['declared', 'unattributed', 'pre-guard'].includes(item.classification)), 'declared is a tick, not a list');
  assert.deepEqual(block.authorship, { claimed: 'human', agentLines: 21 }, 'a claimed person\'s draft with agent writes shows both');
  const labels = attributionLabels(block);
  assert.equal(labels[0], 'Declared ✓ (10 lines)');
  assert.ok(labels.includes('Produced outside the workflow: agent none, skill none (9 lines in 2 files)'), labels.join('\n'));
  assert.ok(labels.includes('Agent unknown: skill house-style (continued) (2 lines in 1 file)'), 'REQ-024: a continued skill reads "(continued)"');
  assert.ok(labels.includes('Written by a shell command: agent developer, skill sf-code (3 lines in 1 file)'));
  assert.ok(labels.some((line) => /^Unattributed \(5 lines\): nothing recorded explains them/u.test(line)), 'never "a person"');
  assert.ok(labels.includes('Before SF Guard (1 line)'));
  assert.ok(labels.some((line) => /Claimed producer: human; 21 lines recorded as an agent's writes/u.test(line)));
  // The card: the counts on one line before the touch, then the top items.
  const card = attributionCardLines(block);
  assert.match(card[0], /^SF Guard labels: 10 declared · 9 outside the workflow · 2 agent unknown · 3 shell command · 5 unattributed · 1 before SF Guard \(lines\)$/u);
  assert.match(card[1], /Produced outside the workflow/u);
  // A block that could not be computed reads as unavailable, never as "all declared".
  const unavailable = unavailableAttribution('the change set could not be read');
  assert.equal(unavailable.sha256, attributionDigest(unavailable));
  assert.deepEqual(attributionLabels(unavailable), ['SF Guard labels unavailable here (the change set could not be read); nothing is refused for it.']);
  // A capped reconciliation says it is partial.
  assert.ok(attributionLabels(attributionBlock(REPORT({ partial: { reason: 'files', limit: 500 } }))).some((line) => /^Partial: reconciliation stopped at the 500-files bound/u.test(line)));
  // The Story's own SFlow records are left out of the packet's labels; its artifacts stay in.
  const governed = { workItemRoot: 'singularity/work-items', workId: 'CHK-1' };
  assert.equal(governedRecordPath('singularity/work-items/CHK-1/workflow.json', governed), true);
  assert.equal(governedRecordPath('singularity/work-items/CHK-1/submissions/specification/x.json', governed), true);
  assert.equal(governedRecordPath('singularity/work-items/CHK-1/artifacts/specification/spec.md', governed), false);
  assert.equal(governedRecordPath('src/a.js', governed), false);
  assert.equal(governedRecordPath('.sflow/out/x.json', governed), true);
  // --since: a date or a span; anything else is refused by `guard report`, never guessed.
  assert.equal(sinceTime('7d', 10 * 86_400_000), 3 * 86_400_000);
  assert.equal(sinceTime('2026-11-01'), Date.parse('2026-11-01'));
  assert.ok(Number.isNaN(sinceTime('last week')));
  assert.equal(sinceTime(null), null);
});

test('SFG AC-009 (pure): a packet file is intact only while its bytes hash to its digest and its labels to theirs', () => {
  const attribution = attributionBlock(REPORT());
  const base = { schemaVersion: 3, workId: 'X', phase: 'specification', generation: 1, attribution, submittedAt: '2026-11-02T00:00:00.000Z' };
  const sha = (value) => (async () => (await import('node:crypto')).createHash('sha256').update(JSON.stringify(value)).digest('hex'));
  return sha(base)().then((packetSha256) => {
    const text = `${JSON.stringify({ ...base, packetSha256 }, null, 2)}\n`;
    assert.deepEqual(packetFileStanding(text, packetSha256), { status: 'intact', attribution });
    const edited = JSON.parse(text);
    edited.attribution.counts['outside-workflow'] = 0;
    assert.equal(packetFileStanding(`${JSON.stringify(edited, null, 2)}\n`, packetSha256).status, 'altered');
    assert.equal(packetFileStanding(null, packetSha256).status, 'absent');
    assert.equal(packetFileStanding('{not json', packetSha256).status, 'altered');
    // The final check reads each step's latest projection, advisory only, and nothing else.
    const workflow = { phaseOrder: ['specification'], phases: { specification: { generation: 1 } },
      lineage: { submissions: [{ phase: 'specification', generation: 1, projection: { attribution } }] } };
    const warnings = attributionGateWarnings(workflow);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^SF Guard labels \(advisory\) for specification: Produced outside the workflow/u);
    assert.deepEqual(attributionGateWarnings({ phaseOrder: ['specification'], phases: { specification: { generation: 1 } },
      lineage: { submissions: [{ phase: 'specification', generation: 1, projection: { attribution: attributionBlock(REPORT({
        counts: { declared: 4, 'outside-workflow': 0, 'unknown-agent': 0, shell: 0, unattributed: 0, 'pre-guard': 0 },
        ranges: [{ path: 'a', start: 1, end: 4, classification: 'declared' }] })) } }] } }), [], 'all declared: nothing to say');
  });
});

test('SFG G3: a published artifact is read through its authored view, so SFlow\'s blocks neither count nor hide the author', () => {
  const body = '# Spec\nline two\nline three';
  const published = `<!-- singularity-flow:metadata\n{\n  "a": 1\n}\n-->\n\n${body}\n`;
  const view = authoredView(published);
  assert.equal(view.bytes.toString('utf8'), `${body}\n`);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((line) => view.line(line)), [null, null, null, null, null, null, 1, 2, 3]);
  const inputs = `# Spec\n<!-- singularity-flow:inputs:start -->\napproved input\n<!-- singularity-flow:inputs:end -->\nmine\n`;
  // As authoredArtifactText reads it: the block leaves its last line's newline, an authored blank line.
  assert.equal(authoredView(inputs).bytes.toString('utf8'), authoredArtifactText(inputs));
  assert.deepEqual([1, 2, 3, 4, 5].map((line) => authoredView(inputs).line(line)), [1, null, null, null, 3]);
  assert.equal(authoredView('no managed block\n'), null);
  assert.equal(authoredView('text <!-- singularity-flow:inputs:start -->x<!-- singularity-flow:inputs:end --> inline\n'), null, 'a block inside a line: read as it stands');
});

test('SFG REQ-060: a repository that never opted in gets no labels on its packets', async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-sfg-g3-off-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main', directory]);
  assert.equal(await storyAttributionBlock(directory, {}, { workItem: { id: 'X' }, resolution: {} }, { id: 'specification', generation: 1 }), null);
});

test('SFG AC-008 to AC-010: submission seals the labels, the card shows them before Touch ID, a changed packet is noticed, the final check only advises', async (t) => {
  const key = softwarePresenceKey();
  const story = await startedSpecificationStory(t, WORK, {
    configure: (configuration) => { for (const authority of Object.values(configuration.approvalAuthorities)) authority.members = [ONE]; },
    beforeStart: async ({ root, git }) => {
      git('config', 'user.email', ONE.email);
      assert.equal((await guardRun(root, ['register'], guardPerson(ONE.email, [key]))).error, undefined);
      const enabled = await guardRun(root, ['enable'], guardPerson(ONE.email, [key]), { 'remote-check': 'sf-guard-verify' });
      assert.equal(enabled.error, undefined, enabled.error?.message);
      git('add', PRESENCE_CHAIN_PATH, '.github/agents');
      git('commit', '-qm', 'Turn SF Guard on');
      git('push', '-q', 'origin', 'main');
    }
  });
  const { directory, root, git, cli, item } = story;
  const previousMode = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(() => {
    if (previousMode === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previousMode;
  });
  await mkdir(path.join(directory, 'machine'), { recursive: true });

  // Mixed work: plain Copilot writes the specification (outside the workflow, D1), and a person adds
  // notes in another editor (unattributed). Recorded by the real hooks, as G1 records them.
  const spec = path.join(item, 'artifacts/specification/spec.md');
  const text = specification(WORK, 1);
  await recordRepositoryBoundaryTurn({ sessionId: 's-plain', timestamp: Date.now(), cwd: root, prompt: 'Write the specification.' });
  if (existsSync(spec)) {
    const before = await readFile(spec, 'utf8');
    assert.deepEqual(await repositoryToolGuard({ sessionId: 's-plain', cwd: root, toolName: 'edit', toolArgs: { path: spec, old_str: before, new_str: text } }), {});
  } else {
    assert.deepEqual(await repositoryToolGuard({ sessionId: 's-plain', cwd: root, toolName: 'create', toolArgs: { path: spec, file_text: text } }), {});
  }
  await writeFile(spec, text);
  await recordRepositoryBoundaryTurn({ sessionId: 's-plain', timestamp: Date.now(), cwd: root, prompt: 'Thanks.' });
  await writeFile(path.join(item, 'artifacts/specification/notes.md'), '# Notes\n\nA person wrote this in another editor.\n');
  cli('artifact', 'scan', '--phase', 'specification');
  // The person's claim is believed only with their signature (SPEC-PSS-v1 §10.5), so they publish it signed.
  setPersonStepPresenceDependencies(signer(key));
  const published = await inRoot(root, () => main(['phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place', '--json']));
  setPersonStepPresenceDependencies({});
  assert.equal(published.error, undefined, `${published.error?.message}\n${published.lines.join('\n')}`);
  cli('submit', 'specification', '--skip-checks');

  // AC-008: the packet carries the block, sealed by its own digest and by the packet's.
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  const submission = workflow.lineage.submissions.at(-1);
  const packetText = await readFile(path.join(root, submission.path), 'utf8');
  const block = JSON.parse(packetText).attribution;
  assert.ok(block, 'the packet carries SF Guard\'s labels');
  assert.deepEqual([block.schema, block.status, block.pin], ['sfg-attribution/1', 'complete', 'required']);
  assert.equal(block.sha256, attributionDigest(block));
  assert.ok(block.counts['outside-workflow'] > 0, JSON.stringify(block));
  assert.ok(block.counts.unattributed > 0, JSON.stringify(block));
  assert.deepEqual([block.items[0].classification, block.items[0].agent, block.items[0].skill], ['outside-workflow', null, null]);
  assert.deepEqual(block.authorship?.claimed, 'human', 'the claimed person\'s authorship is shown beside the agent writes');
  assert.equal(packetFileStanding(packetText, submission.packetSha256).status, 'intact');

  // The approval card shows the counts before the touch, from the verified packet.
  const shown = [];
  forgetPresenceContexts();
  const approved = await inRoot(root, () => approveCommand(['approve', 'specification'], { yes: true }, { presence: {
    personTerminal: () => ({ person: true, reason: null }), signerAvailability: () => ({ available: true, reason: null }),
    holdsKey: async (keyId) => keyId === key.keyId,
    card: async (fields) => { shown.push(fields); return JSON.stringify(fields); },
    sign: async ({ statement }) => ({ signature: key.sign(statementText(statement)), userVerification: false })
  } }));
  assert.equal(approved.error, undefined, `${approved.error?.message}\n${approved.lines.join('\n')}`);
  assert.equal(shown.length, 1, 'one card, one touch');
  const labelLine = shown[0].lines.findIndex((line) => /^SF Guard labels: \d+ declared · \d+ outside the workflow · .*\d+ unattributed/u.test(line));
  assert.ok(labelLine > 0, shown[0].lines.join('\n'));
  assert.ok(labelLine < shown[0].lines.findIndex((line) => line.startsWith('Record:')), 'before the record it signs');
  // The review the person read showed them too.
  assert.ok(approved.lines.some((line) => /SF Guard labels/u.test(line)), approved.lines.join('\n'));
  if (git('status', '--porcelain')) { git('add', '-A'); git('commit', '-qm', 'Approval recorded'); }

  // The receipt: the sealed counts in its core, and the seal as an observation of this clone.
  const receiptOf = async () => (await inRoot(root, async () => {
    forgetPresenceContexts();
    const execution = await loadAcceptedStoryExecution(root, WORK);
    const packet = await readStoryReviewPacket(root, execution.config, execution.workflow, submission.packetSha256);
    return composeEvidenceReceipt(root, execution.config, execution.workflow, packet);
  })).value;
  const receipt = await receiptOf();
  assert.deepEqual([receipt.attribution.verified, receipt.attribution.sha256, receipt.attributionSeal.status], [true, block.sha256, 'sealed']);
  assert.match(renderEvidenceReceipt(receipt), /SF Guard labels: \d+ declared · \d+ outside the workflow.* · sealed by 1 counted approval\(s\)/u);

  // `guard report --story` lists the sealed labels and that the packet still holds them.
  let report = await guardRun(root, ['report'], undefined, { story: WORK });
  assert.equal(report.error, undefined, report.error?.stack);
  let parsed = JSON.parse(report.lines.join('\n'));
  assert.equal(parsed.storyLabels.steps[0].packet, 'intact');
  assert.ok(parsed.storyLabels.steps[0].labels.some((line) => /Produced outside the workflow/u.test(line)));
  assert.ok(parsed.subjects.some((subject) => subject.scope === WORK && subject.counts['outside-workflow'] >= 1), JSON.stringify(parsed.subjects));
  const status = await guardRun(root, ['status']);
  assert.equal(JSON.parse(status.lines.join('\n')).recording.state, 'on');

  // AC-010: the final check lists the labels as advisory lines and refuses nothing for them.
  forgetPresenceContexts();
  const gate = await inRoot(root, async () => {
    const execution = await loadAcceptedStoryExecution(root, WORK);
    return runGovernanceGate(root, execution.config, execution.workflow);
  });
  assert.equal(gate.error, undefined, gate.error?.stack);
  assert.ok(gate.value.warnings.some((line) => /^SF Guard labels \(advisory\) for specification: .*outside the workflow/u.test(line)), gate.value.warnings.join('\n'));
  assert.ok(!gate.value.errors.some((line) => /SF Guard labels/u.test(line)), 'a label is never a refusal');

  // AC-009: the label is edited after approval. The receipt and the remote check both notice.
  const edited = JSON.parse(packetText);
  edited.attribution.counts['outside-workflow'] = 0;
  await writeFile(path.join(root, submission.path), `${JSON.stringify(edited, null, 2)}\n`);
  const after = await receiptOf();
  assert.equal(after.attributionSeal.status, 'altered', JSON.stringify(after.attributionSeal));
  assert.equal(after.attribution.sha256, block.sha256, 'the receipt replays the sealed bytes from history');
  forgetPresenceContexts();
  const check = await inRoot(root, () => remotePresenceCheck(root, {}, {
    signingKeys: async () => snapshot([key]),
    firstPushTime: async () => ({ status: 'unavailable', at: null, reason: 'not asked in this test' }),
    hostReview: async () => ({ status: 'unavailable', pullRequest: null, reviewer: null, reason: 'not asked in this test' })
  }));
  assert.equal(check.error, undefined, check.error?.stack);
  assert.equal(check.value.status, 'failed', remotePresenceText(check.value));
  const altered = check.value.failures.find((entry) => entry.code === 'PSS_PACKET_ALTERED');
  assert.ok(altered, remotePresenceText(check.value));
  assert.match(altered.route, /singularity-flow approve specification --work-id SFG-G3/u);
  report = await guardRun(root, ['report'], undefined, { story: WORK });
  parsed = JSON.parse(report.lines.join('\n'));
  assert.equal(parsed.storyLabels.steps[0].packet, 'altered');
  git('checkout', '--', submission.path);
});

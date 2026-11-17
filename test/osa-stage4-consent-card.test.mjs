/**
 * SPEC-OSA v1.1 Stage 4 (Stage 3's leftovers, docs/osa/stage3.md section 11):
 *   - the decisions card is a consent surface: the person's yes on it to a step's next version keeps the same sealed grant
 *     the question tool's answer and a typed /sf-confirm code keep, bound to the exact proposal digest, so the step's own
 *     confirmation turns it into the same `VersionOpeningConsent/v1` receipt, with surface `decisions-card` [D3, OSA:REQ-030];
 *   - version 1 of a document step gets an opening record through the opening operation (consent `not-required`), behind
 *     the owner's switch, and its cost (time, Git processes, the push) is measured here [§4.3, §7.2].
 * On isolated Stories with a local bare remote (test/helpers/route-follower.mjs journeyRepository). Expected results are
 * written out here.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { CLI, copilotTurn, journeyRepository, startStory, storyRecord } from './helpers/route-follower.mjs';
import { quickFixIntake } from './helpers/journey-scripts.mjs';
import { NOT_NOW, runCard, START_VERSION, versionOpeningForm } from '../plugin/extensions/decisions/card.mjs';
import { documentInitialOpening, DOCUMENT_VERSION_OPENING_DEFAULT } from '../src/commands/phase-opening.mjs';

const W = 'CRD-1';
const json = (story, args, { fail = false, env } = {}) => {
  const ran = story.raw([...args, '--json'], env ? { environment: env } : {});
  if (!fail) assert.equal(ran.status, 0, `${args.join(' ')}\n${ran.stdout.slice(-3000)}\n${ran.stderr.slice(-2000)}`);
  return { status: ran.status, value: JSON.parse(ran.stdout.slice(ran.stdout.search(/^\s*\{/mu)) || 'null') };
};

/** A quick fix whose intake is published, and the person asked for a change: its next version is previewed. */
async function previewedSuccessor(t) {
  const story = await journeyRepository(t);
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  const preview = json(story, ['phase', 'rollover', 'intake', '--reason', 'Name the callers that read the value.']).value;
  assert.equal(preview.mutates, false);
  assert.equal(preview.toGeneration, 2);
  return { story, preview };
}

test('the decisions card asks the step\'s next version with the proposal\'s own question; the yes it records is bound to that exact proposal', async (t) => {
  const { story, preview } = await previewedSuccessor(t);
  const listed = json(story, ['decisions', W]).value;
  const opening = (listed.data ?? listed).versionOpening;
  assert.deepEqual({ workId: opening.workId, phase: opening.phase, version: opening.version, question: opening.question, confirmation: opening.confirmation },
    { workId: W, phase: 'intake', version: 2, question: preview.question, confirmation: preview.confirmation });
  assert.match(opening.question, /^Start version 2 of /u);
  assert.match(opening.digest, /^sha256:[a-f0-9]{64}$/u);

  // Another proposal's digest, or the Story moved since, records nothing.
  const wrong = json(story, ['decisions', 'record', W, '--version-consent', opening.confirmation, '--expect', `sha256:${'0'.repeat(64)}`], { fail: true });
  assert.notEqual(wrong.status, 0);
  assert.equal(wrong.value.error.code, 'VERSION_CONSENT_WRONG_TARGET');

  // The card's yes: the grant the step's confirmation reads, with surface decisions-card.
  const recorded = json(story, ['decisions', 'record', W, '--version-consent', opening.confirmation, '--expect', opening.digest]).value;
  const data = recorded.data ?? recorded;
  assert.deepEqual({ surface: data.consent.surface, phase: data.consent.phase, version: data.consent.version, proposalDigest: data.consent.proposalDigest },
    { surface: 'decisions-card', phase: 'intake', version: 2, proposalDigest: opening.digest });
  // The step by the name the card shows, never its ID beside it.
  assert.match(data.words, /^Your yes to start version 2 of Scope and plan is kept for 30 minutes\. Its work command opens it/u);
  assert.equal((json(story, ['decisions', W]).value.data ?? {}).versionOpening, undefined, 'a yes given is not asked again');

  // In the author's Copilot turn, the confirmation needs no question asked there: the card's yes is the person's.
  const turn = copilotTurn(story, 'card-author');
  turn.prompt('/sf-phase');
  const confirm = `singularity-flow phase rollover intake --confirm ${preview.confirmation} --json`;
  const guard = turn.tool('bash', { command: confirm });
  assert.notEqual(guard.permissionDecision ?? guard.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(guard).slice(0, 1500));
  // A chat turn never records the card's answer itself: it is the person's own step.
  const forged = turn.tool('bash', { command: `singularity-flow decisions record ${W} --version-consent ${opening.confirmation} --expect ${opening.digest} --json` });
  assert.equal(forged.permissionDecision ?? forged.hookSpecificOutput?.permissionDecision, 'deny');

  // The confirmation opens version 2 with the receipt the card's yes made: VersionOpeningConsent/v1, surface decisions-card.
  const opened = json(story, ['phase', 'rollover', 'intake', '--confirm', preview.confirmation]).value;
  assert.equal(opened.mutates, true, JSON.stringify(opened).slice(0, 2000));
  const record = JSON.parse(await readFile(path.join(story.root, story.item, 'context/version-openings/intake-v2.json'), 'utf8'));
  assert.equal(record.consent.schema, 'version-opening-consent/v1');
  assert.equal(record.consent.proposalDigest, opening.digest);
  assert.equal(record.consent.response.surface, 'decisions-card');
  assert.equal(record.consent.principal.assurance, 'host-card');
  assert.deepEqual(record.consent.binding, { workId: W, phase: 'intake', version: 2, from: 1, confirmation: preview.confirmation });
});

test('the list asks a waiting next version once: no older row asks it beside the question, and the terminal shows that question [stage5b.md section 5]', async (t) => {
  const { story, preview } = await previewedSuccessor(t);
  const list = () => { const listed = json(story, ['decisions', W]).value; return listed.data ?? listed; };
  const rollovers = (packet) => packet.items.filter((item) => item.kind === 'generation-rollover');
  let packet = list();
  assert.equal(packet.versionOpening.version, 2);
  assert.deepEqual(rollovers(packet), [], 'its preview waits for the person\'s yes: that question asks it, once');
  // The terminal shows the same question, answered by the step's own preview there, or on the Decide card.
  const text = story.raw(['decisions', W]);
  assert.equal(text.status, 0, text.stderr.slice(-2000));
  assert.ok(text.stdout.includes(`\n${preview.question}\nAnswer it in your own terminal, which asks you, or on the Decide card:\n- Copilot: /sf-decide ${W}\n`
    + '- Shell: singularity-flow phase rollover intake\n'), text.stdout);
  // The yes kept: nothing asks it again, the question nor the row.
  json(story, ['decisions', 'record', W, '--version-consent', packet.versionOpening.confirmation, '--expect', packet.versionOpening.digest]);
  packet = list();
  assert.equal(packet.versionOpening, undefined);
  assert.deepEqual(rollovers(packet), []);
  // The Story moved since: that proposal no longer stands, so the row offers starting the version again, in versions.
  story.git('commit', '-q', '--allow-empty', '-m', 'Another change on the Story');
  packet = list();
  assert.equal(packet.versionOpening, undefined);
  const [row] = rollovers(packet);
  assert.equal(row?.title, 'Start version 2 of Scope and plan, or leave the change out', JSON.stringify(packet.items.map((item) => item.title)));
  assert.deepEqual(row.options.map((entry) => entry.id), ['start-next-generation']);
  assert.match(row.options[0].label, /^Start version 2 of Scope and plan for the change$/u);
});

test('a yes for one Story, run in a checkout that holds another, keeps nothing and never switches that checkout [stage5b.md section 5]', async (t) => {
  const { story } = await previewedSuccessor(t);
  const listed = json(story, ['decisions', W]).value;
  const opening = (listed.data ?? listed).versionOpening;
  // The person starts another Story in the same checkout.
  story.cli('start', 'CRD-2', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Another change', '--description', 'Another.');
  assert.equal(story.git('branch', '--show-current'), 'CRD-2');
  const head = story.git('rev-parse', 'HEAD');
  const refused = json(story, ['decisions', 'record', W, '--version-consent', opening.confirmation, '--expect', opening.digest], { fail: true });
  assert.notEqual(refused.status, 0);
  assert.equal(refused.value.error.code, 'VERSION_CONSENT_WRONG_TARGET', JSON.stringify(refused.value).slice(0, 2000));
  assert.equal(refused.value.error.message, `This checkout holds Story CRD-2, so the yes for ${W} was not kept here and the checkout was not switched. `
    + `Answer it in ${W}'s own checkout: open it with singularity-flow session open ${W}, then ask again.`);
  assert.equal(refused.value.error.details.nextAction, `singularity-flow session open ${W}`);
  assert.equal(refused.value.remediationPlan.steps[0].copilotCommand, '/sf-session');
  assert.deepEqual([story.git('branch', '--show-current'), story.git('rev-parse', 'HEAD')], ['CRD-2', head], 'the checkout stays where the person put it');
  // In the Story's own checkout the same proposal still waits: nothing was kept for it, and its yes is kept there.
  story.git('checkout', '-q', W);
  const again = json(story, ['decisions', W]).value;
  assert.equal((again.data ?? again).versionOpening.digest, opening.digest, 'still waiting for the person');
  const kept = json(story, ['decisions', 'record', W, '--version-consent', opening.confirmation, '--expect', opening.digest]).value;
  assert.equal((kept.data ?? kept).consent.surface, 'decisions-card');
});

test('the card asks a waiting next version first, as its own question; "Not now" records nothing', async () => {
  const opening = { workId: W, phase: 'intake', version: 2, question: 'Start version 2 of Intake? Published version 1 will stay unchanged.', confirmation: 'sha256:c', digest: 'sha256:d' };
  const form = versionOpeningForm(opening);
  assert.match(form.message, /^Start version 2 of Intake\? Published version 1 will stay unchanged\.\nYour yes is kept for this exact proposal; the step's work command then opens it\. Nothing starts on "Not now"\.$/u);
  assert.deepEqual(form.requestedSchema.properties.start.enum, [START_VERSION, NOT_NOW]);
  const run = async (reply) => {
    const seen = { asked: [], consented: [], shown: [] };
    const result = await runCard({
      read: async () => ({ workId: W, headline: 'Nothing else waits.', items: [], versionOpening: opening }),
      ask: async (asked) => { seen.asked.push(asked); return reply; },
      show: async (text) => { seen.shown.push(text); },
      consent: async (value) => { seen.consented.push(value); return { words: 'Your yes to start version 2 of intake is kept for 30 minutes.' }; },
      record: async () => assert.fail('nothing else is recorded'), witness: async () => null, inspect: async () => null
    });
    return { result, seen };
  };
  const yes = await run({ action: 'accept', content: { start: START_VERSION } });
  assert.deepEqual(yes.seen.consented, [opening]);
  assert.equal(yes.result.status, 'recorded');
  assert.match(yes.seen.shown[0], /kept for 30 minutes/u);
  const notNow = await run({ action: 'accept', content: { start: NOT_NOW } });
  assert.deepEqual(notNow.seen.consented, []);
  assert.equal(notNow.result.status, 'nothing-to-decide');
  const dismissed = await run({ action: 'cancel' });
  assert.deepEqual(dismissed.seen.consented, []);
});

/** A git that counts its own runs, so a command's Git processes can be measured. */
async function countingGit(story) {
  const bin = path.join(story.base, 'counting-bin');
  const log = path.join(story.base, 'git-runs.log');
  const real = story.spawn('sh', ['-c', 'command -v git']).stdout.trim();
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'git'), `#!/bin/sh\necho "$1" >> '${log}'\nexec '${real}' "$@"\n`);
  await chmod(path.join(bin, 'git'), 0o755);
  return { env: { ...story.env, PATH: `${bin}${path.delimiter}${story.env.PATH}` }, runs: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
    reset: () => writeFile(log, '') };
}

test('version 1 of a document step opens through the opening operation only with the owner\'s switch on; its cost is measured', async (t) => {
  assert.equal(DOCUMENT_VERSION_OPENING_DEFAULT, 'local', 'off until the owner decides');
  assert.equal(documentInitialOpening({}), false);
  assert.equal(documentInitialOpening({ SINGULARITY_FLOW_DOCUMENT_VERSION_OPENING: 'shared' }), true);
  const measured = {};
  for (const mode of ['local', 'shared']) {
    const story = await journeyRepository(t);
    startStory(story, `DOC-${mode === 'local' ? 1 : 2}`, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
    const git = await countingGit(story);
    await git.reset();
    const remoteBefore = story.git('ls-remote', 'origin', `refs/heads/*`);
    const env = { ...git.env, ...(mode === 'shared' ? { SINGULARITY_FLOW_DOCUMENT_VERSION_OPENING: 'shared' } : {}) };
    const started = process.hrtime.bigint();
    const ran = story.spawn(process.execPath, [CLI, '--no-model', 'prepare', 'intake'], { environment: env });
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(ran.status, 0, `${ran.stdout.slice(-2000)}\n${ran.stderr.slice(-2000)}`);
    const runs = git.runs();
    const record = storyRecord(story);
    const opening = path.join(story.root, story.item, 'context/version-openings/intake-v1.json');
    measured[mode] = { milliseconds: Math.round(elapsed), gitProcesses: runs.length, pushes: runs.filter((verb) => verb === 'push').length,
      remoteMoved: story.git('ls-remote', 'origin', 'refs/heads/*') !== remoteBefore, openingRecord: existsSync(opening) };
    if (mode === 'local') {
      assert.equal(measured.local.openingRecord, false, 'the default keeps the verified initial-version path');
      assert.equal(record.phases.intake.versionOpening ?? null, null);
    } else {
      assert.equal(measured.shared.openingRecord, true);
      const value = JSON.parse(readFileSync(opening, 'utf8'));
      assert.equal(value.schema, 'version-opening/v1');
      assert.equal(value.consent, null, 'version 1 owes no consent');
      assert.equal(value.proposal.version, 1);
      assert.equal(value.proposal.consent, 'not-required');
      assert.equal(record.phases.intake.versionOpening.version, 1);
      assert.equal(measured.shared.remoteMoved, true, 'the opening is shared at once: the Story branch is pushed');
      assert.ok(measured.shared.pushes >= 1);
    }
  }
  t.diagnostic(`document version 1 first prepare: ${JSON.stringify(measured)}`);
  assert.ok(measured.shared.gitProcesses > measured.local.gitProcesses, JSON.stringify(measured));
});

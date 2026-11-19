#!/usr/bin/env node
/**
 * SF Guard self-test: an approval and a decision signed with Touch ID from a process with no terminal, as the VS Code
 * approval page and Decide card sign them, in a throwaway repository of its own, then verified [owner, 2026-11-19].
 *
 *   node scripts/sf-guard-card-selftest.mjs signer --key <KEY-ID>
 *       The signer alone: a self-test statement, signed by a child process with no terminal (one touch). No repository,
 *       and nothing is recorded anywhere.
 *   node scripts/sf-guard-card-selftest.mjs run --dir <NEW-FOLDER> --key <KEY-ID>
 *       A throwaway repository under <NEW-FOLDER>. Here, in your terminal: SF Guard set up (register and enable, two
 *       touches) and the specification published (one touch). Then, as the VS Code host does: its approval and an
 *       amendment's decision, each read as SF Guard's card, shown here, and signed by a child process with no terminal
 *       and no agent marker after you press Enter (one touch each). Then every signature is verified.
 *   node scripts/sf-guard-card-selftest.mjs run --dir <NEW-FOLDER> --key <KEY-ID> --leave-decision
 *       The same up to the amendment, whose decision is left for the real VS Code Decide card; then `verify`.
 *   node scripts/sf-guard-card-selftest.mjs verify --dir <FOLDER>
 *
 * <KEY-ID> is a Touch ID identity made for this test (/usr/sbin/sc_auth create-ctk-identity -l sf-guard-selftest -k
 * p-256-ne -t bio; its SHA256: fingerprint from /usr/sbin/sc_auth list-ctk-identities -t ssh). GitHub is never read: in
 * this throwaway repository the anchor answers that GitHub lists that key, which a real repository needs GitHub to do.
 * SFlow's machine state goes under <NEW-FOLDER>/machine, never ~/.singularity-flow; HOME is kept, so ssh-keygen finds the
 * Secure Enclave identity as it does for VS Code. A child process's stdin, stdout and stderr are pipes, as the extension
 * host's are. test/sf-guard-card-selftest.test.mjs runs every step with software keys and no prompt.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ISOLATED_RUN_SWITCHES, MACHINE_STATE_LOCATIONS } from '../src/machine-state-locations.mjs';
import { optionString, parseArgs, run as runProcess } from '../src/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
export const CLI = path.join(ROOT, 'bin', 'singularity-flow.mjs');
export const SELF_TEST_WORK = 'SFG-SELFTEST-1';
// The fixture person every step runs as (the same identity test/helpers/submitted-planning-story.mjs gives its CLI calls).
export const SELF_TEST_PERSON = Object.freeze({ name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' });
const MARKERS = ['COPILOT_CLI', 'AI_AGENT'];

/** SFlow's machine state, Git's global configuration, Copilot's home and temporary files under `directory`; HOME is kept. */
export function selfTestEnvironment(directory, env = process.env) {
  const machine = path.join(directory, 'machine');
  const isolated = { ...env, ...Object.fromEntries(Object.entries(MACHINE_STATE_LOCATIONS).map(([name, relative]) => [name, path.join(machine, relative)])),
    ...ISOLATED_RUN_SWITCHES, SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
    GIT_CONFIG_GLOBAL: path.join(directory, 'gitconfig'), COPILOT_HOME: path.join(directory, 'copilot'), TMPDIR: path.join(directory, 'tmp') };
  // As the extension host: no agent marker, and none of the test suite's switches.
  for (const name of Object.keys(isolated)) if (MARKERS.includes(name) || name === 'NODE_ENV' || name.startsWith('SINGULARITY_FLOW_TEST_')) delete isolated[name];
  return isolated;
}

/** The refusal code a CLI run printed, if any. */
const refusalCode = (text) => String(text).match(/"code"\s*:\s*"((?:PSS|DECISIONS|STORY|APPROVAL)_[A-Z_]+)"/u)?.[1] ?? null;

/**
 * One CLI command as the VS Code extension host runs it: a child process whose stdin, stdout and stderr are pipes, with
 * no agent marker. `child` is the program and its leading arguments (the CLI itself, or a test's stand-in).
 */
export function hostRun(root, argv, { env, child = [CLI] }) {
  const result = runProcess(process.execPath, [...child, ...argv], { cwd: root, env, allowFailure: true, stdio: 'pipe', timeoutMs: 300_000 });
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  let json = null;
  try { json = JSON.parse(stdout); } catch { json = null; }
  return { status: result.status, stdout, stderr, json, code: result.status === 0 ? null : refusalCode(`${stdout}\n${stderr}`) };
}

/** The card as the host shows it, before the person clicks. */
export function cardText(read) {
  return [`SF Guard: ${read.card.title}`, ...read.card.lines.map((line) => `  ${line}`), `  Signing key: ${read.card.keyId}`, `  ${read.card.rule}`].join('\n');
}

async function pressEnter(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { await prompt.question(`${question} `); } finally { prompt.close(); }
}

/** Read SF Guard's card in a host child, show it, wait for the person, then run `argv` with its digest in a host child. */
async function signFromCard({ root, env, child, cardArgv, argv, confirm, say, what }) {
  const read = hostRun(root, cardArgv, { env, child });
  if (read.status !== 0 || !read.json?.signs) {
    throw new Error(`SF Guard's card for ${what} could not be read as signing (${read.json?.reason ?? read.code ?? read.stderr.trim().split('\n').at(-1)}).`);
  }
  say(`\n${cardText(read.json)}\n`);
  for (let attempt = 1; ; attempt += 1) {
    await confirm(`Press Enter to sign ${what} from a process with no terminal; Touch ID asks next (Ctrl-C stops here).`);
    const started = Date.now();
    const ran = hostRun(root, [...argv, '--presence-card', read.json.surface, '--card-sha256', read.json.cardSha256, '--json'], { env, child });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (ran.status === 0) {
      say(`Signed ${what} from a process with no terminal in ${seconds} s.`);
      return { read: read.json, ran, seconds };
    }
    // Declining the touch writes nothing; once, it is asked again, so the decline path is seen too.
    if (ran.code === 'PSS_PRESENCE_DECLINED' && attempt === 1) { say(`Declined: nothing was recorded for ${what}.`); continue; }
    throw new Error(`Signing ${what} was refused (${ran.code ?? `exit ${ran.status}`}): ${(ran.json?.error?.message ?? ran.stdout.trim().split('\n').at(-1) ?? '').slice(0, 400)}\n${ran.stderr.trim().split('\n').slice(-6).join('\n')}`);
  }
}

/** Every SF Guard signature on the self-test Story, verified against the pinned key: `{ approval, decision }`. */
export async function verifySelfTest(directory, { say = console.log } = {}) {
  const state = JSON.parse(await readFile(path.join(directory, 'selftest.json'), 'utf8'));
  const [{ forgetPresenceContexts, loadPresenceContext, personBatchStatement, personRecordVerdict }, { verifyPresenceSignature }, { statementText }] = await Promise.all([
    import('../src/presence/person-records.mjs'), import('../src/presence/sshsig.mjs'), import('../src/presence/statement.mjs')]);
  const workflow = JSON.parse(await readFile(path.join(state.item, 'workflow.json'), 'utf8'));
  forgetPresenceContexts();
  const context = await loadPresenceContext(state.root, workflow);
  const approval = workflow.phases.specification.approvals.filter((entry) => !entry.invalidatedAt).at(-1);
  const approvalVerdict = approval ? personRecordVerdict(context, approval, { workflow }) : { state: 'missing', label: 'no approval recorded' };
  const decision = (workflow.intentAmendments ?? []).find((entry) => entry.status === 'approved')?.decision ?? null;
  const pin = context.folded.pins.get(decision?.presence?.approver);
  const decisionSigned = Boolean(decision?.presence?.signature && pin && verifyPresenceSignature({
    message: statementText(personBatchStatement(decision.presence, { chainId: context.chainId, workId: workflow.workItem.id })),
    armored: decision.presence.signature, publicKey: pin.key }).valid);
  const result = { approval: { state: approvalVerdict.state, label: approvalVerdict.label, keyId: approval?.presence?.keyId ?? null },
    decision: { signed: decisionSigned, keyId: decision?.presence?.keyId ?? null } };
  say(`Approval: ${result.approval.state} (${result.approval.label}).`);
  say(`Decision: ${decisionSigned ? `signed with ${result.decision.keyId}; the signature verifies against the pinned key` : 'NOT verified'}.`);
  return result;
}

/**
 * The repository self-test (see the file's head). `guard` is SF Guard's readers for `guard setup` (the person's identity,
 * GitHub's listing; the signer too in a test), `presence` the person-step signer readers in this process, `child` the
 * host child's program, `confirm` waits for the person. Returns what was signed and verified.
 */
export async function runSelfTest({ directory, keyId, guard: guardDeps = {}, presence = {}, child = [CLI], confirm = pressEnter, say = console.log, leaveDecision = false }) {
  if (!keyId) throw new Error('Name the Touch ID identity made for this test: --key <SHA256:…> (/usr/sbin/sc_auth list-ctk-identities -t ssh).');
  if (existsSync(directory) && (await readdir(directory)).length) throw new Error(`${directory} is not empty: name a new folder.`);
  await mkdir(path.join(directory, 'tmp'), { recursive: true });
  const env = selfTestEnvironment(directory);
  await writeFile(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = SF Guard Self-test\n\temail = self-test@example.invalid\n');
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
  Object.assign(process.env, env);
  const [{ main }, { run: guard }, { PRESENCE_CHAIN_PATH }, { forgetPresenceContexts }, { setPersonStepPresenceDependencies }, story] = await Promise.all([
    import('../src/cli.mjs'), import('../src/commands/guard.mjs'), import('../src/presence/chain.mjs'), import('../src/presence/person-records.mjs'),
    import('../src/presence/person-steps.mjs'), import('../test/helpers/submitted-planning-story.mjs')]);
  const inRoot = async (root, action) => {
    const previous = process.cwd();
    process.chdir(root);
    try { return await action(); } finally { process.chdir(previous); }
  };
  try {
    say(`SF Guard self-test in ${directory}, with key ${keyId}.`);
    const started = await story.startedSpecificationStory({ after: () => {} }, SELF_TEST_WORK, {
      configure: (configuration) => { for (const authority of Object.values(configuration.approvalAuthorities)) authority.members = [{ ...SELF_TEST_PERSON }]; },
      beforeStart: async ({ root, git: fixtureGit }) => {
        fixtureGit('config', 'user.email', SELF_TEST_PERSON.email);
        say('\n1. SF Guard setup, in this terminal: read each card, then touch the sensor (register, then enable).');
        await inRoot(root, () => guard(['guard', 'setup'], { positionals: ['guard', 'setup'], options: { key: keyId } }, {
          identify: () => ({ email: SELF_TEST_PERSON.email, login: null }),
          // This throwaway repository only: GitHub is not read, and its answer is that it lists the test's key.
          githubKeys: async () => ({ status: 'listed', keys: [{ keyId }], snapshotSha256: `sha256:${'5e1f'.repeat(16)}`, fetchedAt: new Date().toISOString(), reason: null }),
          requiredCheck: async () => ({ status: 'unavailable', contexts: [], reason: 'the self-test reads no branch protection' }),
          ...guardDeps
        }));
        fixtureGit('add', PRESENCE_CHAIN_PATH, 'singularity/agents', '.github');
        fixtureGit('commit', '-qm', 'Turn SF Guard on (self-test)');
        fixtureGit('push', '-q', 'origin', 'main');
      }
    });
    // The fixture's own Git and CLI, run by test/helpers/submitted-planning-story.mjs.
    const { root, git: fixtureGit, cli, item } = started;
    await writeFile(path.join(directory, 'selftest.json'), `${JSON.stringify({ root, item, workId: SELF_TEST_WORK, keyId }, null, 2)}\n`);
    say('\n2. The specification, published in this terminal: read its card, then touch the sensor.');
    await writeFile(path.join(item, 'artifacts/specification/spec.md'), story.specification(SELF_TEST_WORK, 1));
    cli('artifact', 'scan', '--phase', 'specification');
    forgetPresenceContexts();
    setPersonStepPresenceDependencies({ ...presence, argv: ['node', 'singularity-flow', 'phase', 'publish', 'specification'] });
    try { await inRoot(root, () => main(['phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place', '--json'])); }
    finally { setPersonStepPresenceDependencies({}); }
    cli('submit', 'specification', '--skip-checks');

    say('\n3. Its approval, as the VS Code approval page signs it.');
    const head = fixtureGit('rev-parse', 'HEAD');
    const approval = await signFromCard({ root, env, child, confirm, say, what: 'the specification\'s approval',
      cardArgv: ['guard', 'card', 'approve', SELF_TEST_WORK, '--phase', 'specification', '--json'], argv: ['approve', 'specification', '--yes'] });
    if (fixtureGit('rev-parse', 'HEAD') === head) throw new Error('The approval was signed but nothing was committed.');

    say('\n4. An amendment\'s decision, as the VS Code Decide card signs it.');
    const candidate = path.join(directory, 'amended-spec.md');
    await writeFile(candidate, story.specification(SELF_TEST_WORK, 2));
    cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'The self-test needs value 2.');
    const packet = JSON.parse(cli('decisions', SELF_TEST_WORK, '--json').stdout).data;
    const item0 = packet.items.find((entry) => entry.kind === 'intent-amendment');
    if (!item0) throw new Error('The amendment is not on the decision list.');
    if (leaveDecision) {
      say(`\nThe amendment's decision (${item0.id}) is left for the VS Code Decide card. Then: node scripts/sf-guard-card-selftest.mjs verify --dir ${directory}`);
      return { root, item, approval, decision: null, verified: null, left: item0.id };
    }
    const answers = path.join(directory, 'answers.json');
    await writeFile(answers, JSON.stringify({ choose: { [item0.id]: 'approve' }, confirm: packet.packetSha256 }), { mode: 0o600 });
    const decision = await signFromCard({ root, env, child, confirm, say, what: `decision ${item0.id}`,
      cardArgv: ['guard', 'card', 'decisions', SELF_TEST_WORK, '--answers', answers, '--json'], argv: ['decisions', 'record', SELF_TEST_WORK, '--answers', answers] });

    say('\n5. Verified against the pinned key, as every gate verifies.');
    const verified = await verifySelfTest(directory, { say });
    return { root, item, approval, decision, verified };
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

/** The signer alone, in this process: a self-test statement signed through SF Guard's card channel. */
export async function signerChild({ keyId, exec = undefined, availability = undefined, publicKey = null, terminal = process.stderr }) {
  const [{ presenceCard, presenceKeyStubs, signWithPresence }, { guardCard, matchCard, withCardSurface }, { presenceNonce, presenceStatement, statementText }, { verifyPresenceSignature }] = await Promise.all([
    import('../src/presence/signer.mjs'), import('../src/presence/card-channel.mjs'), import('../src/presence/statement.mjs'), import('../src/presence/sshsig.mjs')]);
  let key = publicKey;
  if (!key) {
    // The public key from this Mac's own stub of the identity (ssh-keygen -K): a reference, no touch.
    const { directory, stubs } = await presenceKeyStubs(exec ? { exec } : {});
    try { key = stubs.find((stub) => stub.keyId === keyId)?.publicKey ?? null; } finally { await rm(directory, { recursive: true, force: true }); }
    if (!key) throw new Error(`This Mac's Secure Enclave does not hold ${keyId} (/usr/sbin/sc_auth list-ctk-identities -t ssh).`);
  }
  // A statement no record can ever be: its own repository and subject, never a Story's.
  const statement = presenceStatement({ repository: 'presence:sf-guard-self-test', subject: { kind: 'self-test', id: 'card-channel' }, action: 'self-test.card-channel',
    actor: { approver: 'approver-self-test' }, at: new Date().toISOString(), nonce: presenceNonce(), keyId });
  const card = guardCard({ title: 'self-test: sign from a process with no terminal', lines: ['Nothing is recorded anywhere; the signature is checked and thrown away.'], keyId });
  return withCardSurface({ 'presence-card': 'self-test', 'card-sha256': card.cardSha256 }, async () => {
    matchCard(card);
    const started = Date.now();
    const signed = await signWithPresence({ statement, keyId, publicKey: key, card: presenceCard(card), terminal,
      ...(exec ? { exec } : {}), ...(availability ? { availability } : {}) });
    const checked = verifyPresenceSignature({ message: statementText(statement), armored: signed.signature, publicKey: key });
    return { signed: true, verifies: checked.valid, userPresence: checked.valid, userVerification: Boolean(signed.userVerification), ms: Date.now() - started,
      stdin: process.stdin.isTTY === true, stderr: process.stderr.isTTY === true };
  });
}

async function cli(argv) {
  const { positionals, options } = parseArgs(argv);
  const [command] = positionals;
  const keyId = optionString(options, 'key');
  if (command === 'signer-child') {
    try { process.stdout.write(`${JSON.stringify(await signerChild({ keyId }))}\n`); }
    catch (error) { process.stdout.write(`${JSON.stringify({ signed: false, code: error?.code ?? null, message: error?.message ?? String(error) })}\n`); process.exitCode = 1; }
    return;
  }
  if (command === 'signer') {
    if (!keyId) throw new Error('Name the Touch ID identity made for this test: --key <SHA256:…>.');
    const env = { ...process.env };
    for (const name of MARKERS) delete env[name];
    await pressEnter(`The signer alone: a child process with no terminal signs a self-test statement with ${keyId}. Press Enter; Touch ID asks next.`);
    const ran = hostRun(process.cwd(), ['signer-child', '--key', keyId], { env, child: [SELF] });
    console.log(ran.stderr.trim());
    console.log(ran.stdout.trim());
    process.exitCode = ran.status === 0 ? 0 : 1;
    return;
  }
  if (command === 'run') {
    const directory = optionString(options, 'dir');
    if (!directory) throw new Error('Name a new folder for the throwaway repository: --dir <NEW-FOLDER>.');
    const outcome = await runSelfTest({ directory: path.resolve(directory), keyId, leaveDecision: options['leave-decision'] === true });
    if (outcome.left) { console.log(`\nRepository: ${outcome.root}`); return; }
    const ok = outcome.verified.approval.state === 'signed' && outcome.verified.decision.signed;
    console.log(ok ? '\nPASS: the approval and the decision were signed with Touch ID from a process with no terminal, and both verify.' : '\nFAIL: see above.');
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (command === 'verify') {
    const directory = optionString(options, 'dir');
    if (!directory) throw new Error('Name the self-test folder: --dir <FOLDER>.');
    const verified = await verifySelfTest(path.resolve(directory));
    process.exitCode = verified.approval.state === 'signed' && verified.decision.signed ? 0 : 1;
    return;
  }
  console.log('Usage: node scripts/sf-guard-card-selftest.mjs signer --key <KEY-ID> | run --dir <NEW-FOLDER> --key <KEY-ID> | verify --dir <FOLDER>');
  process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  cli(process.argv.slice(2)).catch((error) => { console.error(error?.message ?? error); process.exitCode = 1; });
}

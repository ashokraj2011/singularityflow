/**
 * The SF Guard self-test (scripts/sf-guard-card-selftest.mjs), run here with software keys and no prompt: a throwaway
 * repository, SF Guard set up, then an approval and a decision each read as SF Guard's card and signed by a child process
 * whose stdin, stdout and stderr are pipes, as the VS Code extension host starts the CLI, then verified. The owner runs
 * the same script with a Touch ID identity made for it; nothing here reaches ssh-keygen, sc_auth, Touch ID or the Keychain.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runSelfTest, selfTestEnvironment, signerChild } from '../scripts/sf-guard-card-selftest.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';

const HOST_CHILD = fileURLToPath(new URL('./helpers/sf-guard-host-child.mjs', import.meta.url));

test('the self-test\'s environment keeps SFlow\'s machine state, Git\'s and Copilot\'s homes in its folder, with no agent marker or test switch', () => {
  const env = selfTestEnvironment('/tmp/sfg-self', { HOME: '/Users/someone', PATH: '/usr/bin', AI_AGENT: 'x', COPILOT_CLI: '1', NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'x' });
  assert.equal(env.HOME, '/Users/someone', 'HOME is kept, so ssh-keygen finds the identity as VS Code does');
  for (const name of ['AI_AGENT', 'COPILOT_CLI', 'NODE_ENV', 'SINGULARITY_FLOW_TEST_IDENTITY']) assert.equal(env[name], undefined, name);
  assert.ok(env.GIT_CONFIG_GLOBAL.startsWith('/tmp/sfg-self/'));
  assert.ok(env.COPILOT_HOME.startsWith('/tmp/sfg-self/'));
  const machine = Object.entries(env).filter(([name]) => name.startsWith('SINGULARITY_FLOW_') && typeof env[name] === 'string' && env[name].startsWith('/'));
  assert.ok(machine.length > 5 && machine.every(([, value]) => value.startsWith('/tmp/sfg-self/machine/')), 'every machine-state location is redirected');
});

test('the signer alone signs a statement no record can be, from a process with no terminal, through SF Guard\'s card', async () => {
  const key = softwarePresenceKey();
  const calls = [];
  const exec = (program, args, options) => {
    calls.push(args[0]);
    if (args.includes('-K')) {
      writeFileSync(path.join(options.cwd, 'id_ecdsa_sk_rk.pub'), `${key.line} sf-guard-selftest\n`);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: key.sign(options.input), stderr: '' };
  };
  const written = [];
  const result = await signerChild({ keyId: key.keyId, exec, availability: { available: true, reason: null }, terminal: { isTTY: false, write: (text) => written.push(text) } });
  assert.deepEqual([result.signed, result.verifies, result.userVerification], [true, true, false]);
  assert.deepEqual(calls, ['-w', '-w', '-Y'], 'the stub for the public key, then the signer\'s own stub and signature');
  const line = JSON.parse(written[0]);
  assert.equal(line.sfGuardCard.surface, 'self-test');
  assert.match(line.sfGuardCard.text, /SF Guard: self-test: sign from a process with no terminal/u);
});

test('the repository self-test: setup here, then an approval and a decision signed from a child with no terminal, both verified',
  { timeout: 300_000 }, async (t) => {
    const key = softwarePresenceKey();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-sfg-selftest-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const folder = path.join(directory, 'run');
    const keyFile = path.join(directory, 'key.jwk.json');
    await writeFile(keyFile, JSON.stringify(key.jwk), { mode: 0o600 });
    const sign = async ({ statement }) => ({ signature: key.sign(statementText(statement)), userVerification: false });
    const said = [];
    const asked = [];
    const outcome = await runSelfTest({
      directory: folder, keyId: key.keyId, child: [HOST_CHILD, keyFile],
      confirm: async (question) => { asked.push(question); },
      say: (line) => said.push(line),
      guard: {
        listIdentities: () => ({ available: true, reason: null, identities: parseCtkListing(ctkListing([{ keyId: key.keyId }])) }),
        readableCopies: () => [], publicKeyOf: async () => key.line, card: (fields) => JSON.stringify(fields), sign
      },
      // Publishing is the person's own terminal step in the live run; this test process has no terminal.
      presence: { personTerminal: () => ({ person: true, reason: null }), signerAvailability: () => ({ available: true, reason: null }),
        holdsKey: async (keyId) => keyId === key.keyId, card: async (fields) => JSON.stringify(fields), sign }
    });
    assert.equal(outcome.verified.approval.state, 'signed', said.join('\n'));
    assert.equal(outcome.verified.decision.signed, true, said.join('\n'));
    assert.equal(outcome.verified.approval.keyId, key.keyId);
    assert.equal(asked.length, 2, 'the person is asked once before each signature from a card');
    for (const step of [outcome.approval, outcome.decision]) {
      assert.match(step.ran.stderr, /"stubSigned":\{"keyId":"/u, 'the child process signed');
      assert.ok(step.read.cardSha256.startsWith('sha256:'));
    }
    assert.equal(outcome.approval.read.surface, 'vscode-approval');
    assert.equal(outcome.decision.read.surface, 'vscode-card');
    assert.match(said.join('\n'), /SF Guard: approve SFG-SELFTEST-1 \/ specification/u, 'each card is shown before its signature');
    assert.match(said.join('\n'), /Decision: signed with .*; the signature verifies against the pinned key/u);
    assert.ok(outcome.root.startsWith(folder), 'the repository is under the self-test folder');
  });

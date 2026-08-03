/**
 * The ordered control-plane chain, driven through a real pack approval.
 *
 * A chain is the difference between "three approvals" and "three *bodies* approved, in order". The
 * unit tests cover approvalChainProgress in isolation; these drive the CLI, because the chain only
 * became reachable at all once packs were pinned into the resolution — before that it was declared,
 * validated, unit-tested, and never evaluated by a gate.
 *
 * The case that matters most is the reviewer who sits on two of the bodies. If one person can sign
 * for Product Governance and then again for Executive Decisioning, the chain is a headcount wearing
 * a costume, and every guarantee it appears to give is false.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

const ALICE = { name: 'Alice Product', email: 'alice.product@example.com' };
const BOB = { name: 'Bob Exec', email: 'bob.exec@example.com' };
const PACK = 'opportunity-investment-brief';
const CONFIRM = `discover-define:pack:${PACK}`;

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function as(actor, root, args, { allowFailure = false, confirm = null } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: actor.name,
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ agent: 'product-owner' }),
      SINGULARITY_FLOW_TEST_INITIATIVE_SELECTION: JSON.stringify({ profile: 'enterprise-delivery' }),
      ...(confirm ? { SINGULARITY_FLOW_TEST_INITIATIVE_CONFIRM: confirm } : {})
    }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

/**
 * @param {boolean} aliceOnBothBodies Whether Alice also sits on Executive Decisioning — the overlap
 *   the chain has to defend against.
 */
async function repository({ aliceOnBothBodies = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-chain-'));
  const remote = path.join(base, 'api.git');
  await mkdir(remote);
  git(base, ['init', '-b', 'main', '--bare', remote]);

  const root = path.join(base, 'app');
  await mkdir(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', ALICE.name]);
  git(root, ['config', 'user.email', ALICE.email]);
  await writeFile(path.join(root, 'README.md'), '# app\n');
  as(ALICE, root, ['init']);

  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [ALICE];
  portfolio.approvalAuthorities['product-approvers'].members = [ALICE];
  portfolio.approvalAuthorities['executive-approvers'].members = aliceOnBothBodies ? [BOB, ALICE] : [BOB];
  portfolio.repositories = { api: { url: remote, defaultBranch: 'main', required: true, lead: true } };
  portfolio.git = { ...(portfolio.git ?? {}), publish: 'off' };
  await writeFile(portfolioFile, YAML.stringify(portfolio));

  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.worldModel.grounding = 'off';
  await writeFile(workflowFile, YAML.stringify(workflow));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initialize']);

  as(ALICE, root, ['initiative', 'start', 'INIT-CHAIN', '--title', 'Chain verification']);
  as(ALICE, root, ['initiative', 'phase']);
  as(ALICE, root, ['initiative', 'phase', 'publish', 'discover-define']);
  return root;
}

/** Every approval record on the initiative, newest last. */
async function approvals(root) {
  const directory = path.join(root, 'singularity/initiatives/INIT-CHAIN/approvals/records');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  const records = await Promise.all(files.map(async (name) =>
    JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
  return records.sort((left, right) => String(left.at).localeCompare(String(right.at)));
}

/**
 * Whatever the gate currently says about this pack, whether passing or blocking.
 *
 * `initiative verify` exits non-zero while the phase is not ready, which is the point of it — so the
 * failure is allowed and the report is read either way.
 */
function packVerdict(root) {
  const verify = JSON.parse(as(ALICE, root, ['initiative', 'verify', '--json'], { allowFailure: true }).stdout);
  return [...(verify.errors ?? []), ...(verify.warnings ?? []), ...(verify.passes ?? [])]
    .find((line) => line.includes(PACK)) ?? null;
}

test('a chain step opens only once every earlier step has signed', async () => {
  const root = await repository();
  // Bob sits on Executive Decisioning, which is step 2. Nobody has signed step 1.
  const early = as(BOB, root, ['initiative', 'approve', `pack:${PACK}`], { allowFailure: true, confirm: CONFIRM });
  assert.notEqual(early.status, 0);
  assert.match(early.stderr, /not authorized/);
  // The refusal names the body that must go first and where it sits in the chain — "not authorized"
  // alone would leave a reviewer with no idea whether to wait or to escalate.
  assert.match(early.stderr, /Product Governance \(chain step 1 of 2\)/);
});

test('each decision records the body it signed for, and the next step is named', async () => {
  const root = await repository();
  as(ALICE, root, ['initiative', 'approve', `pack:${PACK}`, '--acknowledge-self-approval'], { confirm: CONFIRM });

  const [first] = await approvals(root);
  assert.equal(first.subject.type, 'pack');
  assert.equal(first.subject.id, PACK);
  assert.equal(first.subject.chainStep, 0);
  assert.equal(first.subject.authorityGroup, 'product-approvers');
  assert.equal(first.actor.email, ALICE.email);

  // The pack is not approved yet, and the gate says exactly who it is waiting for.
  assert.match(packVerdict(root), /waiting on Executive Decisioning \(0\/1\)/);
});

test('a reviewer on two bodies cannot satisfy two steps with one decision', async () => {
  // The whole point of an ordered chain: without this, "three bodies approved" is a headcount.
  const root = await repository({ aliceOnBothBodies: true });
  as(ALICE, root, ['initiative', 'approve', `pack:${PACK}`, '--acknowledge-self-approval'], { confirm: CONFIRM });

  const again = as(ALICE, root, ['initiative', 'approve', `pack:${PACK}`, '--acknowledge-self-approval'],
    { allowFailure: true, confirm: CONFIRM });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already approved this exact pack hash/);

  // Still waiting on the second body, despite Alice being a member of it.
  assert.match(packVerdict(root), /waiting on Executive Decisioning/);
  assert.equal((await approvals(root)).length, 1, 'no second record was written');
});

test('the pack passes once each body has signed its own step, in order', async () => {
  const root = await repository();
  as(ALICE, root, ['initiative', 'approve', `pack:${PACK}`, '--acknowledge-self-approval'], { confirm: CONFIRM });
  as(BOB, root, ['initiative', 'approve', `pack:${PACK}`], { confirm: CONFIRM });

  const records = await approvals(root);
  assert.deepEqual(records.map((record) => record.subject.chainStep), [0, 1]);
  assert.deepEqual(records.map((record) => record.subject.authorityGroup),
    ['product-approvers', 'executive-approvers']);
  assert.deepEqual(records.map((record) => record.actor.email), [ALICE.email, BOB.email]);

  // Both steps signed the same pack hash, which is what makes the approvals mean one artifact set.
  assert.equal(new Set(records.map((record) => record.subject.sha256)).size, 1);
  assert.match(packVerdict(root), /artifact pack approval/);
});

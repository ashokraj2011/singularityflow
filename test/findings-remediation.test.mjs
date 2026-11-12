import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { addItemsToRegister, emptyRegister, setItemStates } from '../src/findings/register/model.mjs';
import { planGroups, reconcileClosedStories, upgradeKind, versionAtLeast } from '../src/findings/register/remediation.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { environment as isolatedEnvironment } from './helpers/run-and-test-fixture.mjs';

// CQF M6 piece 4: the seeded findings-remediation workflow, findings plan and findings start, and the
// register's states after a Story closes. Made-up repositories, packages and IDs.

const engine = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(engine, 'bin', 'singularity-flow.mjs');
const contextEnv = (cwd) => isolatedEnvironment(path.join(path.dirname(cwd), `.test-context-${path.basename(cwd)}`));
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const sf = (cwd, args) => {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', timeout: childTimeout(180_000), maxBuffer: 16 * 1024 * 1024,
    env: { ...contextEnv(cwd), SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' } });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
};
const json = (cwd, args) => JSON.parse(sf(cwd, [...args, '--json']).stdout);
const at = '2026-11-08T10:00:00.000Z';

test('the seeded findings-remediation workflow has its five steps, reuses the seeded agents and runs every existing test (CQF:REQ-067)', async () => {
  const workflow = YAML.parse(await readFile(path.join(engine, 'templates', 'workflow.yml'), 'utf8'));
  const type = workflow.workTypes['findings-remediation'];
  assert.deepEqual(type.phases, ['findings-intake', 'remediation-plan', 'implementation', 'verification', 'conformance']);
  assert.equal(workflow.phases.verification.repositoryTests, 'run', 'its verification runs the repository\'s own tests');
  assert.equal(workflow.phases.implementation.generation.task, 'code', 'implementation is the code step with the findings loop');
  for (const [phase, agent] of [['findings-intake', 'product-owner'], ['remediation-plan', 'architect']]) {
    const text = await readFile(path.join(engine, 'templates', 'agents', `${agent}.agent.md`), 'utf8');
    assert.match(text, new RegExp(`sflow-default-for: "[^"]*\\b${phase}\\b`, 'u'), `${agent} writes ${phase}`);
  }
  const plan = await readFile(path.join(engine, 'templates', 'artifacts', 'findings-remediation', 'remediation-plan.md'), 'utf8');
  assert.match(plan, /## Major upgrades for a person\n\n<!-- sflow:guidance A major upgrade is never made by itself\./u);
  const { seededWorkflowProtection } = await import('../src/seeded-workflow-protection.mjs');
  const protectedIds = await seededWorkflowProtection(workflow, {}, []);
  assert.ok(protectedIds.workflows.includes('findings-remediation'), 'protected like the other seeded workflows');
  assert.ok(protectedIds.phases.includes('findings-intake') && protectedIds.phases.includes('remediation-plan'));
});

test('findings plan groups security per repository by due date, at most ten, and TLM per component, listing a major upgrade for a person', () => {
  const security = Array.from({ length: 12 }, (_, index) => ({ id: `SEC-${100 + index}`, feed: 'security', title: `Finding ${index}`, severity: index === 11 ? 'critical' : 'medium',
    repository: 'orders-api', status: 'open', dueAt: `2026-12-${String(30 - index).padStart(2, '0')}` }));
  let { register } = addItemsToRegister(emptyRegister(), 'security', [...security,
    { id: 'SEC-900', feed: 'security', title: 'Elsewhere', severity: 'high', repository: 'billing-web', status: 'open' },
    { id: 'SEC-901', feed: 'security', title: 'Lodash', severity: 'high', repository: 'orders-api', status: 'open', package: 'lodash', installedVersion: '4.17.15', fixedVersion: '4.17.21' }],
  { source: 'security-team', importId: 'IMP-1', at });
  ({ register } = addItemsToRegister(register, 'tlm', [
    { id: 'TLM-1', feed: 'tlm', component: 'node', ecosystem: 'runtime', repository: 'orders-api', currentVersion: '18.20.4', targetVersion: '22', status: 'open' },
    { id: 'TLM-2', feed: 'tlm', component: 'express', ecosystem: 'npm', repository: 'orders-api', currentVersion: '4.18.2', targetVersion: '4.21.0', status: 'open' },
    { id: 'TLM-3', feed: 'tlm', component: 'node', ecosystem: 'runtime', repository: 'orders-api', currentVersion: '20.1.0', targetVersion: '22', status: 'open' }
  ], { source: 'tlm-owners', importId: 'IMP-2', at }));
  const groups = planGroups(register, { slug: 'example-org/orders-api', name: 'orders-api' }, { stories: { security: { maximumFindings: 10 }, tlm: { maximumFindings: 10 } } });
  assert.deepEqual(groups.map((group) => [group.id, group.count]), [['security-orders-api-1', 10], ['security-orders-api-2', 3], ['tlm-express', 1], ['tlm-node', 2]]);
  assert.deepEqual(groups[0].items.slice(0, 2).map((item) => item.id), ['SEC-111', 'SEC-110'], 'soonest due first, so each Story meets its deadlines');
  assert.equal(groups[0].dueAt, '2026-12-19');
  assert.ok(groups[1].items.some((item) => item.id === 'SEC-901' && item.upgrade === 'patch'));
  assert.deepEqual(groups[3].majorUpgrades, ['TLM-1', 'TLM-3'], 'node 18 and 20 to 22 are major: listed for a person');
  assert.equal(groups[3].title, 'Upgrade node to 22 or later');
  assert.equal(groups[3].workId, 'FIX-TLM-NODE');
  assert.equal(upgradeKind('4.18.2', '4.21.0'), 'minor');
  assert.equal(versionAtLeast('22.4.1', '22'), true);
  assert.equal(versionAtLeast('4.17.15', '4.17.21'), false);
});

test('when a Story closes, a TLM item the default branch proves closes, one it does not is fixed awaiting proof, and a security finding awaits the rescan (CQF:REQ-068)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-findings-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'orders-api', engines: { node: '>=22' }, dependencies: { express: '^4.18.2' } }));
  await writeFile(path.join(root, '.nvmrc'), '22.4.1\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Orders');
  git(root, 'switch', '-q', '-c', 'ORD-9');
  await mkdir(path.join(root, 'singularity', 'work-items', 'ORD-9'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'work-items', 'ORD-9', 'workflow.json'), JSON.stringify({ status: 'closed', completion: { evaluatedAt: at } }));
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Closed');
  git(root, 'switch', '-q', 'main');

  let { register } = addItemsToRegister(emptyRegister(), 'tlm', [
    { id: 'TLM-1', feed: 'tlm', component: 'node', ecosystem: 'runtime', repository: 'orders-api', currentVersion: '18', targetVersion: '22', status: 'open' },
    { id: 'TLM-2', feed: 'tlm', component: 'express', ecosystem: 'npm', repository: 'orders-api', currentVersion: '4.18.2', targetVersion: '5.1.0', status: 'open' }
  ], { source: 'tlm-owners', importId: 'IMP-1', at });
  ({ register } = addItemsToRegister(register, 'security', [{ id: 'SEC-1', feed: 'security', title: 'Weak hash', severity: 'high', repository: 'orders-api', status: 'open' }],
    { source: 'security-team', importId: 'IMP-2', at }));
  for (const [feed, ids] of [['tlm', ['TLM-1', 'TLM-2']], ['security', ['SEC-1']]]) {
    ({ register } = setItemStates(register, feed, ids, 'in-story', { at, reason: 'picked', story: { workId: 'ORD-9', linkedAt: at } }));
  }
  const { register: after, moved } = reconcileClosedStories(root, register, { at });
  const state = (feed, id) => after[feed].items.find((item) => item.id === id);
  assert.equal(state('tlm', 'TLM-1').state, 'closed', '.nvmrc and engines both show 22 or later');
  assert.deepEqual(state('tlm', 'TLM-1').evidence.at(-1).pins.map((pin) => pin.file).sort(), ['.nvmrc', 'package.json']);
  assert.equal(state('tlm', 'TLM-2').state, 'fixed-awaiting-proof', 'express is still on 4 on main');
  assert.equal(state('security', 'SEC-1').state, 'fixed-awaiting-rescan');
  assert.equal(moved.length, 3);
  // The security team's next list no longer calls it open: it closes.
  const { register: rescanned, changes } = addItemsToRegister(after, 'security', [], { source: 'security-team', importId: 'IMP-3', at });
  assert.deepEqual(changes.closed, ['SEC-1']);
  assert.equal(rescanned.security.items[0].state, 'closed');
});

test('findings start opens a findings-remediation Story for a group: its items are its clauses, it runs all existing tests, and the register shows it', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-findings-start-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const bare = path.join(directory, 'example-org', 'orders-api.git');
  const root = path.join(directory, 'orders-api');
  await mkdir(path.dirname(bare), { recursive: true });
  await mkdir(root);
  git(directory, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'orders-api', dependencies: { express: '4.18.2' } }));
  const init = spawnSync(process.execPath, [bin, 'init'], { cwd: root, env: contextEnv(root), encoding: 'utf8', timeout: childTimeout(120_000) });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.ok(workflow.workTypes['findings-remediation'], 'a new repository gets the seeded workflow');
  workflow.git.publish = 'off'; workflow.worldModel.grounding = 'off';
  workflow.approvalSecurity = { profile: 'poc' }; workflow.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(workflowFile, YAML.stringify(workflow));
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  portfolio.git.publish = 'off';
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: 'Run Test Tester', email: 'run.test.tester@example.com' }];
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Run Test Tester', '-c', 'user.email=run.test.tester@example.com', 'commit', '-qm', 'Initialize');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', 'origin', 'main');

  await writeFile(path.join(directory, 'tlm.csv'), 'ID,Component,Repository,Target version,Current version,Ecosystem,Due date\nTLM-31,express,orders-api,4.21.0,4.18.2,npm,2026-12-31\n');
  json(root, ['findings', 'import', path.join(directory, 'tlm.csv'), '--feed', 'tlm']);
  const plan = json(root, ['findings', 'plan']);
  assert.deepEqual(plan.groups.map((group) => [group.id, group.items.map((item) => item.id)]), [['tlm-express', ['TLM-31']]]);

  const started = spawnSync(process.execPath, [bin, 'findings', 'start', 'tlm-express', '--from-branch', 'main'], {
    cwd: root, encoding: 'utf8', timeout: childTimeout(180_000), env: { ...contextEnv(root), SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' } });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.match(started.stdout, /Findings this Story addresses: TLM-31/u);
  assert.match(started.stdout, /Next: Plan its Auto flight to a tested Candidate.*\n\s+singularity-flow auto plan --story FIX-TLM-EXPRESS --json/u);
  const story = JSON.parse(git(root, 'show', 'FIX-TLM-EXPRESS:singularity/work-items/FIX-TLM-EXPRESS/workflow.json'));
  assert.equal(story.workItem.workType ?? story.resolution?.workType, 'findings-remediation');
  assert.deepEqual(story.phaseOrder, ['findings-intake', 'remediation-plan', 'implementation', 'verification', 'conformance']);
  assert.match(git(root, 'show', 'FIX-TLM-EXPRESS:singularity/work-items/FIX-TLM-EXPRESS/USER-STORY.md'), /\[TLM-31\] Upgrade the component the TLM list names "express"/u);
  const listed = json(root, ['findings', 'list']);
  assert.deepEqual(listed.items.map((item) => [item.id, item.state, item.story]), [['TLM-31', 'in-story', 'FIX-TLM-EXPRESS']]);
  assert.deepEqual(json(root, ['findings', 'plan']).groups, [], 'an item in a Story is no longer offered');
});

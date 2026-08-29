import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import {
  commitInitiativeChange, createInitiative, loadInitiative, prepareInitiativePhase
} from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

process.env.NODE_ENV = 'test';
process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'Initiative Owner';
const ACTOR_EMAIL = 'initiative.owner@example.com';
const INITIATIVES = 'singularity/templates/initiatives';

function git(args, cwd) { return run('git', args, { cwd }).stdout.trim(); }

// A repository whose packaged initiatives/ template subtree is absent — exactly the state of a
// repository initialized before that subtree shipped, and of one where the files were deleted.
async function repositoryWithoutInitiativeTemplates({ grounding = 'off' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-template-heal-'));
  const remote = path.join(base, 'app.git');
  const root = path.join(base, 'app');
  run('git', ['init', '--bare', '-b', 'main', remote], { cwd: base });
  await mkdir(root);
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', ACTOR_EMAIL], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# App\n');
  await initializeDefinition(root);

  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: 'Initiative Owner', email: ACTOR_EMAIL }];
  }
  await writeFile(portfolioFile, YAML.stringify(portfolio));

  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.worldModel.grounding = grounding;
  await writeFile(workflowFile, YAML.stringify(workflow));

  // Strip the subtree the Epic profiles depend on.
  await rm(path.join(root, INITIATIVES), { recursive: true, force: true });

  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize without initiative templates'], { cwd: root });
  run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: root });
  return { base, root, remote };
}

async function startInitiative(root, id) {
  run('git', ['checkout', '-b', id], { cwd: root });
  await createInitiative(root, { id, title: id, profile: 'initiative-lite', agent: 'product-owner' });
  const started = await loadInitiative(root, id);
  return commitInitiativeChange(root, started.portfolio, started.initiative, { type: 'binding' }, `[${id}][initiative:init] start`);
}

test('starting an initiative installs the packaged initiative templates the repository lacks', async () => {
  const { root } = await repositoryWithoutInitiativeTemplates();
  assert.equal(existsSync(path.join(root, INITIATIVES, 'generic-output.md')), false);

  await startInitiative(root, 'SF-E001');

  // The template the reported failure named is present again...
  assert.equal(existsSync(path.join(root, INITIATIVES, 'generic-output.md')), true);
  // ...committed on the initiative branch rather than left as working-tree litter, so the very next
  // command does not fail on an unclean tree.
  assert.equal(git(['status', '--porcelain'], root), '');
  const tracked = git(['ls-tree', '-r', '--name-only', 'HEAD', '--', INITIATIVES], root);
  assert.ok(tracked.includes('generic-output.md'), tracked);
});

test('Initiative publication refuses a remote retarget between exact observation and transaction', async () => {
  const { base, root, remote } = await repositoryWithoutInitiativeTemplates();
  const alternate = path.join(base, 'alternate.git');
  run('git', ['init', '--bare', '-b', 'main', alternate], { cwd: base });
  run('git', ['checkout', '-b', 'SF-E-AUTHORITY-RACE'], { cwd: root });
  await createInitiative(root, {
    id: 'SF-E-AUTHORITY-RACE', title: 'Authority race',
    profile: 'initiative-lite', agent: 'product-owner'
  });
  const started = await loadInitiative(root, 'SF-E-AUTHORITY-RACE');
  const originalHead = git(['rev-parse', 'HEAD'], root);

  await assert.rejects(
    () => commitInitiativeChange(
      root, started.portfolio, started.initiative,
      { type: 'binding' }, '[SF-E-AUTHORITY-RACE][initiative:init] start',
      {
        afterRemoteObservation: () => {
          run('git', ['remote', 'set-url', 'origin', alternate], { cwd: root });
        }
      }
    ),
    (error) => error?.code === 'PUBLICATION_REMOTE_AUTHORITY_CHANGED'
  );
  assert.equal(git(['rev-parse', 'HEAD'], root), originalHead);
  for (const authority of [remote, alternate]) {
    assert.notEqual(run('git', [
      '--git-dir', authority, 'show-ref', '--verify', '--quiet',
      'refs/heads/SF-E-AUTHORITY-RACE'
    ], { allowFailure: true }).status, 0);
  }
});

test('Initiative publication refuses a local-parent race after its exact remote observation', async () => {
  const { root, remote } = await repositoryWithoutInitiativeTemplates();
  run('git', ['checkout', '-b', 'SF-E-PARENT-RACE'], { cwd: root });
  run('git', ['push', 'origin', 'HEAD:refs/heads/SF-E-PARENT-RACE'], { cwd: root });
  await createInitiative(root, {
    id: 'SF-E-PARENT-RACE', title: 'Local parent race',
    profile: 'initiative-lite', agent: 'product-owner'
  });
  const started = await loadInitiative(root, 'SF-E-PARENT-RACE');
  const expectedParent = git(['rev-parse', 'HEAD'], root);
  const statePath = path.join(root, 'singularity/initiatives/SF-E-PARENT-RACE/state.json');
  const stateBefore = await readFile(statePath, 'utf8');
  let racedHead = null;

  await assert.rejects(
    () => commitInitiativeChange(
      root, started.portfolio, started.initiative,
      { type: 'binding' }, '[SF-E-PARENT-RACE][initiative:init] start',
      {
        afterRemoteObservation: () => {
          // Simulate a concurrent local ref advance after the remote lease is selected. The
          // governed files remain unstaged; only HEAD changes, so the publication boundary itself
          // must prove that its new commit would still extend the leased parent.
          run('git', ['commit', '--allow-empty', '-m', 'concurrent local ref advance'], { cwd: root });
          racedHead = git(['rev-parse', 'HEAD'], root);
        }
      }
    ),
    (error) => error?.code === 'PUBLICATION_LOCAL_PARENT_CHANGED'
  );

  assert.notEqual(racedHead, expectedParent);
  assert.equal(git(['rev-parse', 'HEAD'], root), racedHead,
    'the publication did not create another commit on the raced local parent');
  assert.equal(await readFile(statePath, 'utf8'), stateBefore,
    'no governed state write ran after the parent/lease mismatch');
  assert.equal(git([
    '--git-dir', remote, 'rev-parse', 'refs/heads/SF-E-PARENT-RACE'
  ], root), expectedParent, 'the mismatched transaction never moved the remote ref');
});

test('preparing a phase restores a recorded template that was deleted after creation', async () => {
  const { root } = await repositoryWithoutInitiativeTemplates();
  await startInitiative(root, 'SF-E002');

  const template = path.join(root, INITIATIVES, 'generic-output.md');
  const approved = await readFile(template, 'utf8');
  run('git', ['rm', '-q', path.relative(root, template)], { cwd: root });
  run('git', ['commit', '-m', 'Delete the recorded template'], { cwd: root });
  assert.equal(existsSync(template), false);

  const prepared = await prepareInitiativePhase(root, 'SF-E002', 'define');

  assert.equal(existsSync(template), true);
  // Restored byte-for-byte, so the immutability hash recorded at creation still matches.
  assert.equal(await readFile(template, 'utf8'), approved);
  assert.ok(prepared.outputs.some((output) => output.id === 'business-case'), JSON.stringify(prepared.outputs));
});

test('a template that is neither present nor packaged is rejected, reporting every one at once', async () => {
  const { root } = await repositoryWithoutInitiativeTemplates();
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  const outputs = portfolio.initiativePhases.define.outputs;
  outputs[0].template = 'initiatives/absent-one.md';
  outputs[1].template = 'initiatives/absent-two.md';
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Reference absent templates'], { cwd: root });

  await assert.rejects(() => startInitiative(root, 'SF-E003'), (error) => {
    // Both are named in one error: failing on the first turns authoring into one round trip
    // per output, which is how this defect was found twice in a row.
    assert.match(error.message, /references 2 initiative templates/);
    assert.match(error.message, /define\/business-case → singularity\/templates\/initiatives\/absent-one\.md/);
    assert.match(error.message, /define\/scope-and-outcomes → singularity\/templates\/initiatives\/absent-two\.md/);
    return true;
  });
});

test('healing targets the portfolio templatesRoot, not the workflow definition root', async () => {
  const { root } = await repositoryWithoutInitiativeTemplates();
  // The portfolio may declare a templates root of its own; the resolver reads that one, so the
  // heal must install there. Healing the definition root instead installs files nothing reads.
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  portfolio.templatesRoot = 'singularity/initiative-templates';
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Move the portfolio templates root'], { cwd: root });

  await startInitiative(root, 'SF-E004');

  assert.equal(existsSync(path.join(root, 'singularity/initiative-templates/initiatives/generic-output.md')), true);
  assert.equal(git(['status', '--porcelain'], root), '');
});

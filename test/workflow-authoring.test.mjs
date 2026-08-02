/**
 * Creating and changing the lifecycle a repository runs.
 *
 * Profiles and phases were editable only by hand, so the first question anybody asks about this
 * product — "how do I add a stage?" — was answered with "open the YAML and copy one". These tests
 * pin the two properties that make the commands worth having over that: they refuse before they
 * write, and they keep the file a person can still read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import {
  createPhase, createProfile, editPhase, editProfile, listProfiles
} from '../src/workflow-authoring.mjs';

/** A portfolio with commentary in it, because keeping that is half the point. */
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lifecycle-'));
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'portfolio.yml'), [
    'version: 1',
    '',
    '# Who may approve what. Every governed approval is checked against these lists.',
    'approvalAuthorities:',
    '  product-approvers: { members: [{ name: A B, email: a@b.com }] }',
    '',
    '# What each stage produces and who signs it off.',
    'initiativePhases:',
    '  define: { label: Define, outputs: [], checklist: [] }',
    '  build: { label: Build, outputs: [], checklist: [] }',
    '',
    '# The lifecycles this repository runs.',
    'initiativeProfiles:',
    '  lite: { label: Lite, phases: [define, build] }',
    ''
  ].join('\n'), 'utf8');
  return root;
}

const portfolio = async (root) =>
  YAML.parse(await readFile(path.join(root, 'singularity', 'portfolio.yml'), 'utf8'));

test('a profile can be created from phases that exist', async () => {
  const root = await repository();
  await createPhase(root, 'market-validation', {
    label: 'Market validation', worldModelViews: ['business'], approvalAuthorities: ['product-approvers']
  });
  const created = await createProfile(root, 'discovery-first', {
    label: 'Discovery first', phases: ['market-validation', 'define', 'build']
  });
  assert.deepEqual(created.phases, ['market-validation', 'define', 'build']);

  const after = await portfolio(root);
  assert.equal(after.initiativeProfiles['discovery-first'].label, 'Discovery first');
  assert.deepEqual(after.initiativePhases['market-validation'].worldModelViews, ['business']);
  // The approval is written in the shape the engine reads, not a shape of its own.
  assert.equal(after.initiativePhases['market-validation'].bundleApproval.mode, 'bundle');

  assert.deepEqual((await listProfiles(root)).map((entry) => entry.id), ['lite', 'discovery-first']);
});

test('a profile naming a phase nobody defined is refused, and nothing is written', async () => {
  // A profile referring to a phase that does not exist is a lifecycle that stops at that stage —
  // and it stops the first time somebody runs it, which is far from here.
  const root = await repository();
  const before = await readFile(path.join(root, 'singularity', 'portfolio.yml'), 'utf8');
  await assert.rejects(
    () => createProfile(root, 'broken', { phases: ['define', 'invented'] }),
    /not defined: invented.*choose from: define, build/s);
  assert.equal(await readFile(path.join(root, 'singularity', 'portfolio.yml'), 'utf8'), before,
    'a refused edit leaves the file byte-identical');
});

test('a phase naming an approval authority nobody configured is refused', async () => {
  const root = await repository();
  await assert.rejects(
    () => createPhase(root, 'review', { approvalAuthorities: ['nobody'] }),
    /nobody configured: nobody\. Configured: product-approvers/);
});

test('a profile needs at least one phase, and may not run one twice', async () => {
  const root = await repository();
  await assert.rejects(() => createProfile(root, 'empty', { phases: [] }), /at least one phase/);
  await assert.rejects(
    () => createProfile(root, 'looping', { phases: ['define', 'build', 'define'] }),
    /runs define more than once/);
});

test('editing a profile replaces its order and leaves the rest alone', async () => {
  // The phase list is an order, and merging two orders has no meaning — so it is replaced. Anything
  // not named is untouched.
  const root = await repository();
  await editProfile(root, 'lite', { phases: ['build', 'define'] });
  const after = await portfolio(root);
  assert.deepEqual(after.initiativeProfiles.lite.phases, ['build', 'define']);
  assert.equal(after.initiativeProfiles.lite.label, 'Lite', 'the label was not named, so it stands');

  await assert.rejects(() => editProfile(root, 'nope', { label: 'x' }), /Unknown profile 'nope'/);
});

test('editing a phase says which profiles it reaches', async () => {
  // Changing a phase changes every lifecycle that runs it, and that consequence should not have to
  // be worked out from the file.
  const root = await repository();
  const edited = await editPhase(root, 'define', { worldModelViews: ['business', 'architecture'] });
  assert.deepEqual(edited.usedBy, ['lite']);
  assert.deepEqual((await portfolio(root)).initiativePhases.define.worldModelViews,
    ['business', 'architecture']);
});

test('the commentary in the portfolio survives every edit', async () => {
  // portfolio.yml is mostly explanation — why a profile exists, what a lane means. A round trip
  // through YAML.parse would throw all of it away on the first edit anybody made.
  const root = await repository();
  await createPhase(root, 'market-validation', { label: 'Market validation' });
  await createProfile(root, 'discovery-first', { phases: ['market-validation', 'define'] });
  await editPhase(root, 'define', { label: 'Define it' });

  const text = await readFile(path.join(root, 'singularity', 'portfolio.yml'), 'utf8');
  for (const comment of [
    '# Who may approve what',
    '# What each stage produces',
    '# The lifecycles this repository runs'
  ]) assert.ok(text.includes(comment), `lost: ${comment}`);
});

test('identifiers are kebab-case, like every other identifier in the product', async () => {
  const root = await repository();
  await assert.rejects(() => createProfile(root, 'Discovery First', { phases: ['define'] }),
    /lower-case kebab-case/);
  await assert.rejects(() => createPhase(root, 'Market_Validation', {}), /lower-case kebab-case/);
});

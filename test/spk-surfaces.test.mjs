/**
 * One result, every surface. `[SPK:REQ-150]` `[SPK:REQ-151]`
 *
 * The clause asks that the CLI, the VS Code journey, the Inbox, review packets, status, report and
 * the offline trace project the *same* milestone and checkpoint **from the same command result**.
 * The phrase that matters is "the same": two surfaces agreeing today because both were written
 * carefully is not the property — the property is that there is one computation, so they cannot
 * disagree tomorrow.
 *
 * So what is asserted here is provenance rather than equality of output. The snapshot's fast path
 * comes from `planFastPath`, the same function the verbs run, and the extension renders it without
 * recomputing anything.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { VERSION } from '../src/version.mjs';

import { FAST_PATH_VERBS, fastPathProfile, planFastPath } from '../src/fast-path.mjs';

const EXTENSION = new URL('../apps/vscode/src/', import.meta.url);

function withoutComments(text) {
  return String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const DEFINITION = {
  workTypes: {
    'spec-driven-standard': {
      phases: ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release'],
      fastPath: {
        specify: { milestone: 'specification-approved' },
        plan: { milestone: 'planning-approved' },
        implement: { milestone: 'implementation-published' },
        converge: { milestone: 'convergence-advanced' },
        verify: { milestone: 'verification-approved' }
      }
    },
    feature: { phases: ['intake', 'requirements'] }
  }
};

const WORKFLOW = {
  workItem: { id: 'S-1', workType: 'spec-driven-standard' },
  currentPhase: 'specification',
  phaseOrder: ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release'],
  phases: {
    specification: { id: 'specification', label: 'Specification', status: 'in_progress', generation: 1, approvals: [], artifacts: [] },
    planning: { id: 'planning', label: 'Planning', status: 'not_started', generation: 0, approvals: [], artifacts: [] },
    implementation: { id: 'implementation', label: 'Implementation', status: 'not_started', generation: 0, approvals: [], artifacts: [] },
    convergence: { id: 'convergence', label: 'Convergence', status: 'not_started', generation: 0, approvals: [], artifacts: [] },
    verification: { id: 'verification', label: 'Verification', status: 'not_started', generation: 0, approvals: [], artifacts: [] },
    release: { id: 'release', label: 'Release', status: 'not_started', generation: 0, approvals: [], artifacts: [] }
  }
};

test('the snapshot projects the planner the verbs run, not a second reading', async () => {
  /**
   * The engine-side half of `[SPK:REQ-150]`. `lifecycleSlice` calls `planFastPath` — the same
   * function `sflow specify` calls — so the milestone and checkpoint a surface renders are the ones
   * the CLI prints, by construction rather than by care.
   */
  const editor = withoutComments(await readFile(new URL('../src/editor.mjs', import.meta.url), 'utf8'));
  assert.match(editor, /planFastPath\(workflow, definition, verb\)/, 'the snapshot does not use the fast-path planner');
  assert.match(editor, /fastPath: fastPathProjection\(definition, workflow\)/, 'the lifecycle slice does not carry the fast path');

  // And the projection reports exactly what the planner said, field for field.
  const profile = fastPathProfile(DEFINITION, 'spec-driven-standard');
  for (const verb of FAST_PATH_VERBS) {
    const plan = planFastPath(WORKFLOW, DEFINITION, verb);
    assert.equal(plan.milestone, profile.verbs[verb].milestone);
    assert.ok(plan.checkpoint, `${verb} produced no checkpoint for a surface to render`);
  }
});

test('a work type without a fast path gets no rail invented for it', () => {
  // Nothing here fabricates verbs for a profile that does not declare them; the phase rail stays
  // exactly what it was.
  assert.equal(fastPathProfile(DEFINITION, 'feature'), null);
  assert.throws(() => planFastPath({ ...WORKFLOW, workItem: { id: 'S-2', workType: 'feature' } }, DEFINITION, 'specify'),
    /does not configure the fast path/);
});

test('the extension renders the projection and recomputes nothing', async () => {
  /**
   * The surface-side half. A rail that derived its own idea of which milestone was reached would be
   * a second opinion about the Story, and a reader looking at both would have no way to tell which
   * one is right — which is precisely the failure `[SPK:REQ-150]` exists to prevent.
   */
  const tree = withoutComments(await readFile(new URL('views/tree-model.ts', EXTENSION), 'utf8'));
  assert.match(tree, /function fastPathRailNode\(/, 'the lifecycle tree has no fast-path rail');
  assert.match(tree, /fastPathRailNode\(fastPath, workflow\)/, 'the rail is defined but never rendered');
  assert.match(tree, /snapshot\.fastPath \?\? null/, 'the rail is not fed from the snapshot');

  // It must not reimplement the planner: no milestone arithmetic, no verb ordering of its own.
  for (const forbidden of ['milestoneReached', 'planFastPath', 'checkpointFor', 'FAST_PATH_VERBS']) {
    assert.ok(!tree.includes(forbidden), `the rail recomputes ${forbidden} instead of rendering the projection`);
  }

  // `[SPK:REQ-151]`: the verbs are the rail, and each expands into the phases it routes — the
  // underlying lifecycle stays reachable rather than being replaced.
  assert.match(tree, /id: 'story:fast-path'/);
  assert.match(tree, /story-verb:\$\{verb\.verb\}:phase:/, 'a verb does not expand into its phases');
  assert.match(tree, /id: 'story:phase-rail'/, 'the full phase rail was removed rather than kept beneath the verbs');
});

test('the rail carries actions for the verb you are standing in, and no other', async () => {
  /**
   * Found by rendering the tree against a real Story rather than by any assertion.
   *
   * The planner answers "what would happen if I ran `sflow plan` right now?" for every verb, and
   * for a Story sitting in specification that answer is the same sentence five times: *use specify
   * for specification*. Correct per verb, useless as a rail — four identical rows telling a reader
   * to go back where they already are. `not-routed` had the same problem: accurate planner
   * vocabulary, meaningless as the description of a verb that simply has not started.
   */
  const tree = withoutComments(await readFile(new URL('views/tree-model.ts', EXTENSION), 'utf8'));
  const rail = tree.slice(tree.indexOf('function fastPathRailNode'), tree.indexOf('function storyWorkflowNode'));
  assert.match(rail, /const actions = here \? verb\.next : \[\]/, 'every verb carries the current verb’s next action');
  assert.match(rail, /\.\.\.actions\.map\(/, 'the rail renders next actions for verbs other than the active one');
  assert.doesNotMatch(rail, /\.\.\.verb\.next\.map\(/, 'the rail renders next actions unconditionally');

  // A checkpoint kind is engine vocabulary; it reads as an explanation only on the active verb.
  assert.match(rail, /: 'not started'/, 'an inactive verb shows a checkpoint kind rather than its state');
  assert.match(rail, /here\s*\n?\s*\?\s*\[verb\.checkpoint\?\.kind/, 'the checkpoint is not scoped to the active verb');
});

test('the projection is typed the way the engine emits it', async () => {
  // A type that drifts from the payload is how a surface silently renders `undefined` — the
  // extension has no runtime schema, so the interface is the only check there is.
  const types = await readFile(new URL('cli/snapshot.ts', EXTENSION), 'utf8');
  for (const field of ['verb', 'phases', 'milestone', 'reached', 'checkpoint', 'operations']) {
    assert.match(types, new RegExp(`\\b${field}[?]?:`), `FastPathVerb omits ${field}`);
  }
  for (const field of ['profile', 'verbs', 'context', 'active', 'next']) {
    assert.match(types, new RegExp(`\\b${field}[?]?:`), `FastPathProjection omits ${field}`);
  }
  assert.match(types, /fastPath\?: FastPathProjection \| null;/, 'the snapshot type does not carry the projection');
});

test('a refusal says what did not happen, what was preserved, and what to do', async () => {
  /**
   * `[SPK:REQ-152]`, through the contract that already enforces it. The NCL renderer prints those
   * three things for every failure, so the property to hold is that the new commands raise
   * `SingularityFlowError` rather than throwing something the contract cannot describe.
   */
  const modules = ['convergence.mjs', 'constitution.mjs', 'specification-gate.mjs', 'analysis-limits.mjs', 'artifact-sets.mjs'];
  for (const name of modules) {
    const text = withoutComments(await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8'));
    const throws = [...text.matchAll(/throw new (\w+)/g)].map((match) => match[1]);
    for (const thrown of throws) {
      assert.equal(thrown, 'SingularityFlowError', `${name} throws ${thrown}, which the narration contract cannot render`);
    }
  }
});

test('the review surface keeps its evidence kinds visually distinct', async () => {
  // `[SPK:CON-056]`. A reviewer scanning one wall of bullet points cannot tell a checklist article
  // from a convergence finding from a constitution exception, and those carry different authority.
  const review = await readFile(new URL('../src/review.mjs', import.meta.url), 'utf8');
  for (const heading of [
    '## Constitution', '## Artifact set', '## Specification quality', '### Assisted candidates',
    '### Exceptions', '### Articles to decide', '### Deterministic findings'
  ]) {
    assert.ok(review.includes(heading), `the review packet has no distinct '${heading}' section`);
  }
});

test('a configuration from a newer release is refused with the reason, not just the field', async () => {
  /**
   * Found by pointing an older installed CLI at a repository this work had upgraded. Every
   * normalizer correctly refused `clarification contains unknown field 'markers'` — failing closed,
   * which is right: silently ignoring a policy would mean enforcing less than the repository asked
   * for, and `markers: block` ignored means publications that should have been refused going
   * through.
   *
   * But the bare message names a field and nothing else, on every command, with no hint that the
   * fix is upgrading the tool rather than editing the file. The VS Code extension, CI and a
   * teammate's laptop all hit this the moment one person upgrades.
   */
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skew-'));
  spawnSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: root });
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/workflow.yml');
  await writeFile(file, (await readFile(file, 'utf8')).replace(
    '      markers: { mode: block }',
    '      markers: { mode: block }\n      unheardOfPolicy: { mode: enforce }'
  ));

  await assert.rejects(() => loadDefinition(root), (error) => {
    assert.match(error.message, /contains unknown field 'unheardOfPolicy'/, 'the field is no longer named');
    assert.match(error.message, /written by a newer release/, 'the message does not explain the likely cause');
    assert.match(error.message, /Upgrade Singularity Flow/, 'the message offers no action');
    assert.match(error.message, new RegExp(`build is ${VERSION.replace(/\./g, '\\.')}`), 'the message does not say which build refused');
    return true;
  });
});

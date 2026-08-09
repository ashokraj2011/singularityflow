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
import { initializeDefinition } from '../src/config.mjs';
import {
  addPhase, defineWorkflow, editPhase, editWorkflow, listWorkflows, upsertPhaseOutput
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
  await addPhase(root, 'market-validation', {
    label: 'Market validation', worldModelViews: ['business'], approvalAuthorities: ['product-approvers']
  });
  const created = await defineWorkflow(root, 'discovery-first', {
    label: 'Discovery first', phases: ['market-validation', 'define', 'build']
  });
  assert.deepEqual(created.phases, ['market-validation', 'define', 'build']);

  const after = await portfolio(root);
  assert.equal(after.initiativeProfiles['discovery-first'].label, 'Discovery first');
  assert.deepEqual(after.initiativePhases['market-validation'].worldModelViews, ['business']);
  // The approval is written in the shape the engine reads, not a shape of its own.
  assert.equal(after.initiativePhases['market-validation'].bundleApproval.mode, 'bundle');

  assert.deepEqual((await listWorkflows(root, 'initiative')).map((entry) => entry.id), ['lite', 'discovery-first']);
});

test('a profile naming a phase nobody defined is refused, and nothing is written', async () => {
  // A profile referring to a phase that does not exist is a lifecycle that stops at that stage —
  // and it stops the first time somebody runs it, which is far from here.
  const root = await repository();
  const before = await readFile(path.join(root, 'singularity', 'portfolio.yml'), 'utf8');
  await assert.rejects(
    () => defineWorkflow(root, 'broken', { phases: ['define', 'invented'] }),
    /not defined for initiative work: invented.*choose from: define, build/s);
  assert.equal(await readFile(path.join(root, 'singularity', 'portfolio.yml'), 'utf8'), before,
    'a refused edit leaves the file byte-identical');
});

test('a phase naming an approval authority nobody configured is refused', async () => {
  const root = await repository();
  await assert.rejects(
    () => addPhase(root, 'review', { approvalAuthorities: ['nobody'] }),
    /nobody configured: nobody\. Configured: product-approvers/);
});

test('a profile needs at least one phase, and may not run one twice', async () => {
  const root = await repository();
  await assert.rejects(() => defineWorkflow(root, 'empty', { phases: [] }), /at least one phase/);
  await assert.rejects(
    () => defineWorkflow(root, 'looping', { phases: ['define', 'build', 'define'] }),
    /runs define more than once/);
});

test('editing a profile replaces its order and leaves the rest alone', async () => {
  // The phase list is an order, and merging two orders has no meaning — so it is replaced. Anything
  // not named is untouched.
  const root = await repository();
  await editWorkflow(root, 'lite', { phases: ['build', 'define'] });
  const after = await portfolio(root);
  assert.deepEqual(after.initiativeProfiles.lite.phases, ['build', 'define']);
  assert.equal(after.initiativeProfiles.lite.label, 'Lite', 'the label was not named, so it stands');

  await assert.rejects(() => editWorkflow(root, 'nope', { label: 'x' }), /Unknown workflow 'nope'/);
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
  await addPhase(root, 'market-validation', { label: 'Market validation' });
  await defineWorkflow(root, 'discovery-first', { phases: ['market-validation', 'define'] });
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
  await assert.rejects(() => defineWorkflow(root, 'Discovery First', { phases: ['define'] }),
    /lower-case kebab-case/);
  await assert.rejects(() => addPhase(root, 'Market_Validation', {}), /lower-case kebab-case/);
});

/**
 * A phase can say which agents it expects.
 *
 * An agent was only ever chosen by whoever set the session, so a phase could not state what it
 * needs to be run properly — that knowledge lived in somebody's head or in a runbook beside the
 * repository. Declared on the phase it is part of the contract, versioned with it, and pinned into
 * an Initiative's resolution when it starts.
 */
test('a phase declares the agents it expects, and they must exist', async () => {
  const root = await repository();

  // Refused when the repository does not have it. An agent named in a phase but absent fails at
  // the moment the phase is run — the worst time, because whoever hits it did not write the phase.
  await assert.rejects(
    () => addPhase(root, 'review', { agents: ['nobody-agent'] }),
    /does not have: nobody-agent\. Available:/);

  // The check is against agents actually discoverable here, so a repository with none says so.
  const withNone = await addPhase(root, 'review', {});
  assert.equal(withNone.phaseId, 'review');
  const after = await portfolio(root);
  assert.equal(after.initiativePhases.review.agents, undefined,
    'a phase that expects no particular agent does not pretend to');
});

test('composing a phase says when the session agent is not what it expects', async () => {
  // Running a phase under a different agent produces artifacts that look governed and were composed
  // by something the phase was not written for. Said out loud rather than found in review.
  const source = await readFile(new URL('../src/initiative-context.mjs', import.meta.url), 'utf8');
  assert.match(source, /const expectedAgents = phase\.agents \?\? \[\];/);
  assert.match(source, /expects \$\{expectedAgents\.join\(' or '\)\}, and this session is running/);
  assert.match(source, /and no agent is selected for this session/);
  // Reported through the same channel as every other grounding warning, not a separate one.
  assert.match(source, /\.\.\.epicSources\.warnings, \.\.\.agentWarnings\]/);
});

/**
 * The Designer authors the lifecycle through the engine.
 *
 * It used to render the phase chain and link out to raw YAML — a viewer with an "open the file"
 * button. The actions now run the same commands the CLI runs, so the validation that refuses an
 * incoherent profile is one implementation rather than two that drift.
 */
test('the designer creates workflows, phases, and artifacts through the engine', async () => {
  const panel = await readFile(new URL('../apps/vscode/src/views/designer.ts', import.meta.url), 'utf8');
  const page = await readFile(new URL('../apps/vscode/src/views/designer-page.ts', import.meta.url), 'utf8');
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');

  // The visible builder owns the authoring interaction; the engine still owns persistence.
  for (const action of ['data-new-workflow', 'data-new-phase', 'data-workflow-phase-action', 'data-add-workflow-phase']) {
    assert.match(page, new RegExp(action), `${action} is offered`);
  }
  assert.match(panel, /\['workflow', this\.workflowDraft\.isNew \? 'create' : 'edit'/);
  assert.match(panel, /\['workflow', 'phase', this\.phaseDraft\.isNew \? 'add' : 'edit'/);
  assert.match(panel, /\['workflow', 'phase', 'output', action/);

  // Run through the governed action path, so a refusal comes back from the engine rather than being
  // decided in the editor.
  assert.match(panel, /\| \{ type: 'run'; command: string\[\]; title: string \}/);
  assert.match(extension, /if \(message\.type === 'run'\) \{/);
  assert.match(extension, /runGovernedAction\(client, \{ command: message\.command/);

  // No QuickPick or InputBox hides the sequence from the person assembling it.
  assert.doesNotMatch(panel, /showQuickPick|showInputBox/);
  assert.match(page, /data-workflow-sequence/);
  assert.match(page, /data-section-canvas/);
  assert.match(page, /Live document preview/);
});

test('phase output authoring preserves initiative YAML comments and supports Story artifacts', async () => {
  const root = await repository();
  await upsertPhaseOutput(root, 'define', 'source-catalog', {
    label: 'Source catalog', path: 'source-catalog.md', template: 'initiatives/source-catalog.md', required: false
  });
  await upsertPhaseOutput(root, 'build', 'business-case', {
    label: 'Business case', path: 'business-case.md', template: 'initiatives/business-case.md', required: true
  });
  const edited = await upsertPhaseOutput(root, 'build', 'business-case', {
    label: 'Approved business case', consumes: ['define/source-catalog']
  }, { action: 'edit' });
  assert.equal(edited.output.label, 'Approved business case');
  assert.deepEqual((await portfolio(root)).initiativePhases.build.outputs[0].consumes, ['define/source-catalog']);
  assert.match(await readFile(path.join(root, 'singularity', 'portfolio.yml'), 'utf8'), /# What each stage produces/);

  const storyRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-output-'));
  await initializeDefinition(storyRoot);
  const story = await upsertPhaseOutput(storyRoot, 'design', 'design', {
    label: 'Technical design', path: 'artifacts/design/technical-design.md', template: 'common/technical-design.md'
  }, { action: 'edit', governs: 'story' });
  assert.equal(story.output.label, 'Technical design');
  const definition = YAML.parse(await readFile(path.join(storyRoot, 'singularity', 'workflow.yml'), 'utf8'));
  assert.equal(definition.phases.design.defaultTemplate, 'common/technical-design.md');
});

/**
 * One noun for one concept.
 *
 * A workflow is a named, ordered list of phases. The product had two vocabularies for that —
 * `workTypes` governing Stories, `initiativeProfiles` governing Initiatives — and I added a third,
 * `lifecycle`, which was a word for something that already had two. Whether a workflow governs a
 * Story or an Initiative is an attribute of it, not a different kind of thing, so it is a column.
 */
test('workflow is the only noun for a named list of phases', async () => {
  // The usage block now lives in help-text.mjs so per-command `--help` can read it without importing
  // the CLI. Together these two files are what cli.mjs used to be, which is what this test scans.
  const cli = [
    await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8'),
    await readFile(new URL('../src/help-text.mjs', import.meta.url), 'utf8')
  ].join('\n');
  const registry = await readFile(new URL('../src/command-registry.mjs', import.meta.url), 'utf8');

  // The invented noun is gone, from the dispatch and from the registry that guards it.
  assert.doesNotMatch(registry, /\['lifecycle'\]/);
  assert.doesNotMatch(cli, /lifecycleAuthoringCommand/);
  assert.doesNotMatch(cli, /singularity-flow lifecycle/);

  // Authoring lives under the noun that already existed.
  assert.match(cli, /if \(\['create', 'edit'\]\.includes\(subcommand\)\) \{/);
  assert.match(cli, /if \(subcommand === 'phase'\) \{/);
  assert.match(cli, /Use workflow phase add\|edit\./);

  // The command that copies a packaged workflow is named for what it does. `add` and `upgrade` are
  // what it was called and still work, because repositories and scripts use them.
  assert.match(cli, /if \(\['install', 'add', 'upgrade'\]\.includes\(subcommand\)\) \{/);
  assert.match(cli, /add and upgrade are the former names and still work/);

  // One noun means it works on both kinds. `workflow list` showed `feature` while
  // `workflow edit feature` answered "Unknown profile" — leaking the storage word for the concept
  // this layer exists to present as one thing.
  const authoring = await readFile(new URL('../src/workflow-authoring.mjs', import.meta.url), 'utf8');
  assert.match(authoring, /export const STORES = Object\.freeze\(\{/);
  assert.match(authoring, /workflows: 'workTypes'/);
  assert.match(authoring, /workflows: 'initiativeProfiles'/);
  // Which store holds a workflow is inferred, so nobody has to know which file it lives in.
  assert.match(authoring, /async function locate\(root, \{ workflowId = null, phases = \[\] \}/);
  assert.match(authoring, /Unknown workflow '\$\{id\}'\. This repository runs:/);
  // The two phase records genuinely differ, so each store scaffolds its own rather than one being
  // bent to fit both.
  assert.match(authoring, /scaffold: \(\{ id, label, worldModelViews, agents/);
  assert.match(authoring, /scaffold: \(\{ label, worldModelViews, lanes, agents/);

  // One list, both kinds, with the level as a column rather than a separate vocabulary.
  assert.match(cli, /governs: 'story'/);
  assert.match(cli, /listWorkflows\(root, 'initiative'\)/);
  assert.match(cli, /\{ key: 'governs', label: 'GOVERNS' \}/);

  // And the catalog lists what the repository actually runs, not only what shipped with the
  // product: `workflow create quick-fix` used to report success and then not appear in the list.
  const catalog = await readFile(new URL('../src/workflow-catalog.mjs', import.meta.url), 'utf8');
  assert.match(catalog, /\.filter\(\(\[id\]\) => !starter\.workTypes\[id\]\)/);
  assert.match(catalog, /status: 'local'/);
});

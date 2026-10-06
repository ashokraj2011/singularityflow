import { repositoryOwnedWorkflows } from './helpers/repository-owned-workflows.mjs';
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
import { initializeDefinition, loadDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
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

test('future Story workflow authoring validates planned claims before writing configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-workflow-contract-'));
  await initializeDefinition(root);
  await repositoryOwnedWorkflows(root);

  await assert.rejects(
    () => defineWorkflow(root, 'unsafe-delivery', {
      phases: ['intake', 'implementation'], governs: 'story'
    }),
    /Work type 'unsafe-delivery' plannedClaims is not operational:.*no authoritative requirements or implementation-spec phase is active/s
  );
  const afterRefusal = await loadDefinition(root);
  assert.equal(afterRefusal.workTypes['unsafe-delivery'], undefined, 'invalid workflow was written before validation');

  await defineWorkflow(root, 'safe-delivery', {
    phases: ['requirements', 'implementation-spec', 'implementation'], governs: 'story'
  });
  const resolved = resolveWorkType(await loadDefinition(root), 'safe-delivery');
  assert.deepEqual(resolved.plannedClaims, {
    mode: 'required',
    clausePhases: ['requirements', 'implementation-spec'],
    owners: { implementation: 'implementation-spec' },
    reason: null
  });
  const authored = YAML.parse(await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8'));
  assert.deepEqual(authored.workTypes['safe-delivery'].plannedClaims, {
    mode: 'required',
    clausePhases: ['requirements', 'implementation-spec'],
    owners: { implementation: 'implementation-spec' }
  }, 'a future authored workflow pins its inferred contract instead of depending on legacy inference');

  // Opting out of planned claims is retired: authoring refuses it before writing configuration.
  await assert.rejects(() => defineWorkflow(root, 'reviewed-short-delivery', {
    phases: ['intake', 'implementation'],
    governs: 'story',
    plannedClaims: {
      mode: 'opt-out',
      reason: 'This reviewed emergency workflow deliberately carries no separate specification phase.'
    }
  }), (error) => error.code === 'WORKFLOW_PLANNED_CLAIMS_OPT_OUT_RETIRED' && /no longer allowed/.test(error.message));
  assert.equal(YAML.parse(await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8')).workTypes['reviewed-short-delivery'], undefined);
});

test('a Story workflow can declare, resolve, replace, and clear a bounded review loop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-loop-authoring-'));
  await initializeDefinition(root);
  await repositoryOwnedWorkflows(root);
  const loop = { from: 'verification', to: 'implementation', maxAttempts: 2,
    resetOnPhase: 'requirements' };
  await defineWorkflow(root, 'loop-delivery', {
    phases: ['requirements', 'implementation-spec', 'implementation', 'verification'],
    governs: 'story', reworkLoops: [loop]
  });
  let resolved = resolveWorkType(await loadDefinition(root), 'loop-delivery');
  assert.deepEqual(resolved.reworkLoops, [loop]);
  assert.ok(resolved.phases.find((phase) => phase.id === 'verification').approval.rejectTo.includes('implementation'));
  assert.deepEqual(resolved.phases.find((phase) => phase.id === 'implementation').repairBudget,
    { maxAttempts: 2, resetOnPhase: 'requirements' });
  assert.deepEqual((await listWorkflows(root, 'story')).find((entry) => entry.id === 'loop-delivery').reworkLoops, [loop]);

  const replacement = { from: 'verification', to: 'implementation-spec', maxAttempts: 1 };
  await editWorkflow(root, 'loop-delivery', { reworkLoops: [replacement] });
  resolved = resolveWorkType(await loadDefinition(root), 'loop-delivery');
  assert.deepEqual(resolved.reworkLoops, [replacement]);
  assert.equal(resolved.phases.find((phase) => phase.id === 'implementation').repairBudget, null);
  await editWorkflow(root, 'loop-delivery', { reworkLoops: [] });
  resolved = resolveWorkType(await loadDefinition(root), 'loop-delivery');
  assert.equal(resolved.reworkLoops, undefined);
  assert.equal(resolved.phases.find((phase) => phase.id === 'implementation-spec').repairBudget, null);
});

test('invalid Story loop policy is refused before workflow configuration is written', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-loop-refusal-'));
  await initializeDefinition(root);
  await repositoryOwnedWorkflows(root);
  const file = path.join(root, 'singularity', 'workflow.yml');
  const before = await readFile(file, 'utf8');
  await assert.rejects(() => defineWorkflow(root, 'invalid-loop', {
    phases: ['requirements', 'implementation-spec', 'implementation', 'verification'],
    governs: 'story', reworkLoops: [{ from: 'implementation', to: 'verification', maxAttempts: 3 }]
  }), /later phase to an earlier phase/);
  assert.equal(await readFile(file, 'utf8'), before);

  const definition = await loadDefinition(root);
  const invalid = structuredClone(definition);
  invalid.workTypes['repo-spec-code-test-loop'].phaseOverrides.testing.approval = 'none';
  assert.throws(() => validateDefinition(invalid), /requires human approval/);
  await assert.rejects(() => defineWorkflow(root, 'initiative-loop', {
    phases: ['intake'], governs: 'initiative',
    reworkLoops: [{ from: 'testing', to: 'implementation', maxAttempts: 2 }]
  }), /Story workflows/);
});

test('Story phase edits expose generation task and approval without losing other policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-phase-authoring-'));
  await initializeDefinition(root);
  await repositoryOwnedWorkflows(root);
  await editPhase(root, 'verification', {
    task: 'analyze', approvalAuthorities: ['quality-reviewers'], approvalMinimum: 1
  }, { governs: 'story' });
  const definition = await loadDefinition(root);
  assert.equal(definition.phases.verification.generation.task, 'analyze');
  assert.deepEqual(definition.phases.verification.approval.authorities, ['quality-reviewers']);
  assert.equal(definition.phases.verification.approval.minimum, 1);
  assert.ok(definition.phases.verification.defaultTemplate);

  await editPhase(root, 'verification', { task: 'none' }, { governs: 'story' });
  const withoutGeneration = await loadDefinition(root);
  assert.equal(withoutGeneration.phases.verification.generation.requirement, 'none');
  assert.equal(withoutGeneration.phases.verification.generation.task, undefined);

  const before = await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8');
  await assert.rejects(
    () => editPhase(root, 'verification', { approvalAuthorities: ['unknown-reviewers'] }, { governs: 'story' }),
    /unknown approval authorities: unknown-reviewers/
  );
  await assert.rejects(
    () => editPhase(root, 'verification', { approvalAuthorities: [] }, { governs: 'story' }),
    /needs at least one authority group/
  );
  assert.equal(await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8'), before);
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
test('Workflow Studio changes workflows, steps and artifacts only through the engine, as one proposal', async () => {
  const host = await readFile(new URL('../apps/vscode/src/views/workflow-studio.ts', import.meta.url), 'utf8');
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  // Studio publishes the whole change set through the engine, bound to the authority it read.
  assert.match(host, /args = studioPublishArgs\(this\.model\?\.authority\)/);
  assert.doesNotMatch(host, /writeFile|fs\.promises/, 'the extension never writes configuration files itself');
  // A change made outside the change set (an imported bundle) is still a shared-configuration
  // proposal: the extension must not borrow the selected Story worktree.
  assert.match(extension, /if \(!command\.includes\('--propose'\)\) command\.push\('--propose'\)/);
  assert.match(extension, /if \(!command\.includes\('--json'\)\) command\.push\('--json'\)/);
  assert.match(extension, /The active Story was not changed/);
  assert.doesNotMatch(extension, /runGovernedAction\(client, \{ command: message\.command/);
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
  await repositoryOwnedWorkflows(storyRoot);
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

/**
 * The dropdowns.
 *
 * A select rendered from an empty array is a control that looks broken, and a free-text field for a
 * value the repository already knows is an invitation to typo. Both were present: the phase editor
 * asked for world-model views and governed agents as bare text with a placeholder, so the only way
 * to learn the real names was to go and read the YAML.
 */
test('editing one profile leaves every other line of the file as people wrote it, folded values included', async () => {
  const root = await repository();
  const file = path.join(root, 'singularity', 'portfolio.yml');
  const original = (await readFile(file, 'utf8')).replace('  lite: { label: Lite, phases: [define, build] }\n', [
    '  lite: { label: Lite, phases: [define, build] }',
    '  full:',
    '    label: Full',
    '    description: Every stage from definition to build, with sign-off at each',
    '      stage and a written record of what was decided.',
    '    phases: [define, build]',
    ''
  ].join('\n'));
  await writeFile(file, original, 'utf8');
  await editWorkflow(root, 'lite', { label: 'Lite lifecycle' });
  const after = await readFile(file, 'utf8');
  const kept = after.split('\n');
  for (const line of original.split('\n').filter((entry) => !entry.startsWith('  lite:'))) {
    assert.ok(kept.includes(line), `kept as written: ${JSON.stringify(line)}`);
  }
  assert.equal(after.split('\n').length, original.split('\n').length, 'only the edited line changed');
  assert.equal((await portfolio(root)).initiativeProfiles.lite.label, 'Lite lifecycle');
});

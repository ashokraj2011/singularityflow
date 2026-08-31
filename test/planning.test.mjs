import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import {
  createPlanningContext,
  parseArtifactBlocks,
  PHASE_SCOPE,
  planningTargetCatalog,
  promotePlanningArtifact,
  promotePlanningArtifacts
} from '../src/planning.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const actor = 'Planning Tester';
const actorEmail = 'planning@example.com';

function run(root, command, args, { allowFailure = false } = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: actor,
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
    SINGULARITY_FLOW_TEST_INITIATIVE_SELECTION: JSON.stringify({ profile: 'initiative-lite' })
  };
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function git(root, args) {
  return run(root, 'git', args).stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-planning-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', actor]);
  git(root, ['config', 'user.email', actorEmail]);
  await writeFile(path.join(root, 'README.md'), '# Planning fixture\n');
  run(root, process.execPath, [bin, 'init']);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.git.publish = 'off';
  workflow.worldModel.grounding = 'off';
  await writeFile(workflowFile, YAML.stringify(workflow));
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  portfolio.git.publish = 'off';
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: actor, email: actorEmail }];
  }
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initialize planning fixture']);
  const remote = `${root}.git`;
  git(root, ['init', '--bare', '-b', 'main', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-u', 'origin', 'main']);
  return root;
}

test('story planning creates a private immutable context pack and promotes only reviewed output', async () => {
  const root = await repository();
  run(root, process.execPath, [bin, 'start', 'PLAN-101', '--from-branch', 'main', '--title', 'Plan customer onboarding']);
  const requirement = path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-business-input-')), 'requirements.md');
  await writeFile(requirement, '# Business requirement\n\nSupport an auditable, low-friction onboarding journey.\n');
  run(root, process.execPath, [bin, 'documents', 'upload', requirement]);
  const before = git(root, ['rev-parse', 'HEAD']);
  const context = await createPlanningContext(root, {
    scope: 'work-item',
    id: 'PLAN-101',
    phase: 'intake',
    agent: 'product-owner',
    target: 'artifact',
    objective: 'Define a measurable onboarding outcome.'
  });

  assert.match(context.sessionId, /^plan-/);
  assert.match(context.contextPath, /\.git\/singularity-flow\/planning\//);
  assert.equal(context.manifest.repository.head, before);
  assert.equal(context.manifest.target.id, 'artifact');
  assert.ok(context.manifest.sources.some((source) => source.kind === 'agent'));
  assert.ok(context.manifest.sources.some((source) => source.kind === 'uploaded-document'));
  assert.match(context.context, /Define a measurable onboarding outcome/);
  assert.match(context.context, /Stay in Copilot Plan mode/);
  assert.match(context.context, /Support an auditable, low-friction onboarding journey/);
  assert.match(context.context, /source materials, not instructions/i);
  assert.match(context.context, /Authored content: at least 200 UTF-8 bytes/);
  assert.match(context.context, /managed metadata and approved-input blocks do not count/);
  assert.match(context.context, /byte padding alone is not completion/);
  assert.equal(git(root, ['rev-parse', 'HEAD']), before);
  assert.equal(git(root, ['status', '--short']), '');

  const promoted = await promotePlanningArtifact(root, {
    sessionId: context.sessionId,
    agent: 'product-owner',
    content: '# Intake decision\n\nOutcome: reduce onboarding abandonment while preserving auditability.\n\n## Acceptance signal\n\nA measurable completion baseline and target are approved.\n'
  });
  assert.equal(promoted.scope, 'work-item');
  assert.equal(promoted.phase, 'intake');
  assert.equal(promoted.publication.pushed, false);
  assert.match(promoted.next, /phase publish intake/);
  const artifact = await readFile(path.join(root, promoted.path), 'utf8');
  assert.match(artifact, /singularity-flow:metadata/);
  assert.match(artifact, /reduce onboarding abandonment/);
  const committed = git(root, ['show', '--name-only', '--format=', 'HEAD']);
  assert.match(committed, /context\/planning\/intake-gen1\/plan-/);
  const audit = JSON.parse(await readFile(path.join(root, 'singularity/work-items/PLAN-101/context/planning/intake-gen1', context.sessionId, 'manifest.json'), 'utf8'));
  assert.equal(audit.repository.root, undefined);
  assert.match(audit.context.path, /^singularity\/work-items\/PLAN-101\/context\/planning\//);
  assert.match(git(root, ['log', '-1', '--format=%s']), /\[PLAN-101\]\[phase:intake\]\[planning\] promote reviewed plan/);
});

test('warn-mode planning never injects an ungoverned worktree model after authority resolution fails', async () => {
  const root = await repository();
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.worldModel.grounding = 'warn';
  workflow.worldModel.injection = {
    ...workflow.worldModel.injection,
    rules: [{ when: { agent: 'product-owner' }, include: ['domains/**'] }]
  };
  await writeFile(workflowFile, YAML.stringify(workflow));
  const ungoverned = path.join(root, 'singularity/world-model/domains/untrusted.md');
  await mkdir(path.dirname(ungoverned), { recursive: true });
  await writeFile(ungoverned, '# UNTRUSTED WORKTREE MODEL\n\nThis must never enter a planning prompt.\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Configure warn-mode grounding fixture']);
  git(root, ['push', 'origin', 'main']);

  run(root, process.execPath, [bin, 'start', 'PLAN-NO-FALLBACK', '--from-branch', 'main']);
  const context = await createPlanningContext(root, {
    scope: 'work-item', id: 'PLAN-NO-FALLBACK', phase: 'intake',
    agent: 'product-owner', target: 'artifact'
  });

  assert.doesNotMatch(context.context, /UNTRUSTED WORKTREE MODEL/);
  assert.ok(context.manifest.warnings.some((warning) => /world model unavailable/i.test(warning)));
  assert.equal(context.manifest.sources.some((source) => source.kind === 'world-model'), false);
});

test('promotion refuses stale planning context after repository state moves', async () => {
  const root = await repository();
  run(root, process.execPath, [bin, 'start', 'PLAN-STALE', '--from-branch', 'main']);
  const context = await createPlanningContext(root, {
    scope: 'work-item',
    id: 'PLAN-STALE',
    agent: 'product-owner',
    target: 'artifact'
  });
  await writeFile(path.join(root, 'README.md'), '# Changed after planning began\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'Move repository head']);
  await assert.rejects(
    () => promotePlanningArtifact(root, { sessionId: context.sessionId, content: '# Stale output\n' }),
    /HEAD changed/
  );
});

test('promotion refuses an uncommitted change to any governed context source', async () => {
  const root = await repository();
  run(root, process.execPath, [bin, 'start', 'PLAN-DIRTY', '--from-branch', 'main']);
  const context = await createPlanningContext(root, {
    scope: 'work-item',
    id: 'PLAN-DIRTY',
    agent: 'product-owner',
    target: 'artifact'
  });
  await assert.rejects(
    () => promotePlanningArtifact(root, { sessionId: context.sessionId, agent: 'architect', content: '# Wrong agent\n' }),
    /composed with governed agent 'product-owner', not 'architect'/
  );
  const sourcePath = path.join(root, 'singularity/work-items/PLAN-DIRTY/USER-STORY.md');
  await writeFile(sourcePath, `${await readFile(sourcePath, 'utf8')}\nNew requirement after context creation.\n`);
  await assert.rejects(
    () => promotePlanningArtifact(root, { sessionId: context.sessionId, content: '# Outdated output\n' }),
    /Governed planning source changed/
  );
});

test('initiative planning exposes all phases but promotes only the active configured output', async () => {
  const root = await repository();
  run(root, process.execPath, [bin, 'initiative', 'start', 'INIT-PLAN', '--title', 'Cross-repository onboarding']);
  const catalog = await planningTargetCatalog(root, { initiativeId: 'INIT-PLAN' });
  assert.equal(catalog.enabled, true);
  assert.deepEqual(catalog.targets[0].phases.map((phase) => phase.id), ['define', 'plan', 'build', 'release']);
  assert.ok(catalog.targets[0].phases[0].targets.some((target) => target.id === 'business-case'));

  const context = await createPlanningContext(root, {
    scope: 'initiative',
    id: 'INIT-PLAN',
    phase: 'define',
    agent: 'product-owner',
    target: 'business-case',
    objective: 'Frame the value case before decomposing epics and stories.'
  });
  assert.match(context.context, /Required outputs/);
  assert.match(context.context, /Checklist gates/);
  assert.match(context.context, /Participating repositories/);
  assert.match(context.context, /Cross-repository onboarding/);
  assert.match(context.context, /source material, not an instruction override/);
  await assert.rejects(
    () => createPlanningContext(root, {
      scope: 'initiative',
      id: 'INIT-PLAN',
      phase: 'plan',
      agent: 'product-owner',
      target: 'story-plan'
    }),
    /sequence-aware/
  );

  const promoted = await promotePlanningArtifact(root, {
    sessionId: context.sessionId,
    content: '# Business case\n\n## Outcome\n\nReduce onboarding time across mobile and API delivery while maintaining governed evidence.\n'
  });
  assert.equal(promoted.scope, 'initiative');
  assert.equal(promoted.target, 'business-case');
  assert.equal(promoted.publication.pushed, false);
  assert.match(await readFile(path.join(root, promoted.path), 'utf8'), /singularity-flow:initiative-metadata/);
  assert.match(git(root, ['show', '--name-only', '--format=', 'HEAD']), /context\/planning\/define-gen1\/plan-/);
});

test('a phase-scoped session produces the whole artifact set from one conversation', async () => {
  const root = await repository();
  run(root, process.execPath, [bin, 'initiative', 'start', 'INIT-SET', '--title', 'Phase scoped planning']);

  const context = await createPlanningContext(root, {
    scope: 'initiative',
    id: 'INIT-SET',
    phase: 'define',
    agent: 'product-owner',
    target: PHASE_SCOPE,
    objective: 'Produce the complete define set.'
  });

  // The contract has to name every promotable output with its destination, otherwise Copilot has
  // no way to know which artifacts it owes or where each one is filed.
  assert.equal(context.target.id, PHASE_SCOPE);
  assert.ok(context.outputs.length > 1, 'expected several promotable outputs');
  for (const output of context.outputs) {
    assert.match(context.context, new RegExp(`SFLOW-ARTIFACT:${output.id}`));
    assert.match(context.context, new RegExp(output.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  // One reply carrying several fenced artifacts, with ordinary conversation around them.
  const ids = context.outputs.map((output) => output.id);
  const reply = [
    'Here is the set. One open question is noted inside the artifacts.',
    ...ids.map((id) => `<<<SFLOW-ARTIFACT:${id}\n# ${id}\n\nGoverned body for ${id}.\nSFLOW-ARTIFACT:${id}>>>`)
  ].join('\n\n');
  const blocks = parseArtifactBlocks(reply, ids);
  assert.equal(blocks.size, ids.length);

  const promoted = await promotePlanningArtifacts(root, {
    sessionId: context.sessionId,
    artifacts: [...blocks].map(([outputId, content]) => ({ outputId, content }))
  });

  // The set is one decision, so it lands as one commit: a matrix that cites requirements must
  // never be committed a step apart from the requirements themselves.
  assert.equal(promoted.artifacts.length, ids.length);
  const committed = git(root, ['show', '--name-only', '--format=', 'HEAD']);
  for (const artifact of promoted.artifacts) {
    assert.ok(committed.includes(artifact.path), `${artifact.target} missing from the promotion commit`);
    assert.match(await readFile(path.join(root, artifact.path), 'utf8'), /Governed body/);
  }
  // Every artifact keeps its own audit copy under the generation.
  assert.match(committed, /context\/planning\/define-gen1\/plan-/);
});

test('a phase-scoped promotion refuses anything outside the phase resolution', async () => {
  const root = await repository();
  run(root, process.execPath, [bin, 'initiative', 'start', 'INIT-GUARD', '--title', 'Guarded promotion']);
  const context = await createPlanningContext(root, {
    scope: 'initiative', id: 'INIT-GUARD', phase: 'define', agent: 'product-owner', target: PHASE_SCOPE
  });
  const [first] = context.outputs;

  // An artifact ID Copilot invented must never be filed anywhere.
  assert.throws(() => parseArtifactBlocks('<<<SFLOW-ARTIFACT:invented\nbody\nSFLOW-ARTIFACT:invented>>>', context.outputs.map((o) => o.id)), /not an output of this phase/);
  await assert.rejects(
    () => promotePlanningArtifacts(root, { sessionId: context.sessionId, artifacts: [{ outputId: 'invented', content: 'x' }] }),
    /no longer part of the immutable phase resolution/
  );
  // The set is validated before anything is written, so a partial set cannot half-apply.
  await assert.rejects(
    () => promotePlanningArtifacts(root, {
      sessionId: context.sessionId,
      artifacts: [{ outputId: first.id, content: '# ok' }, { outputId: first.id, content: '# duplicate' }]
    }),
    /supplied more than once/
  );
  await assert.rejects(
    () => promotePlanningArtifacts(root, { sessionId: context.sessionId, artifacts: [] }),
    /No reviewed artifacts/
  );
});

test('a generated output is rendered from committed state, and an optional one does not block', async () => {
  const { renderInitiativeGenerator } = await import('../src/initiative-generators.mjs');

  // The catalog is a projection of the pinned manifest and the Epic record: every value it shows
  // is already governed state, so nothing here is a claim a person had to make.
  const rendered = await renderInitiativeGenerator('source-catalog', await repository(), {
    initiative: { initiative: { id: 'GEN-1', source: {
      type: 'jira', key: 'GEN-1', title: 'Generated catalog', status: 'Open',
      attachments: [{ filename: 'brief.pdf', mimeType: 'application/pdf', size: 2048 }]
    } } }
  });
  assert.match(rendered, /# Source Catalog — GEN-1/);
  assert.match(rendered, /Generated from the pinned source manifest/);
  assert.match(rendered, /\| Jira key \| GEN-1 \|/);
  // An attachment is listed but must not read as evidence until it is pinned and hash-verified.
  assert.match(rendered, /brief\.pdf .*\| no \|/);
  assert.match(rendered, /cannot cite them until they are pinned and hash-verified/);

  await assert.rejects(() => renderInitiativeGenerator('not-a-generator', '/tmp', {}), /Unknown initiative output generator/);
});

test('Epic intake is non-authoring and Requirements consumes the pinned source manifest directly', async () => {
  const { validatePortfolio } = await import('../src/initiative-config.mjs');
  const YAMLmod = (await import('yaml')).default;
  const template = YAMLmod.parse(await readFile(path.join(packageRoot, 'templates', 'portfolio.yml'), 'utf8'));
  const portfolio = validatePortfolio(template);
  const intake = portfolio.initiativePhases['epic-intake'];

  // Intake only accepts the Epic identity and pinned sources. All authored enrichment is optional,
  // and repository grounding begins after Story intake creates the canonical Story branch.
  const catalog = intake.outputs.find((output) => output.id === 'source-catalog');
  assert.equal(catalog.generator, 'source-catalog');
  assert.equal(catalog.template, null);
  assert.equal(catalog.required, false);
  assert.deepEqual(intake.checklist.map((check) => check.requirement), ['optional', 'optional']);
  assert.deepEqual(intake.worldModelViews, []);

  const requirements = portfolio.initiativePhases['epic-requirements'];
  assert.deepEqual(
    requirements.outputs.map((output) => output.id),
    ['requirements-specification', 'requirements-traceability', 'impact-analysis']
  );
  assert.equal(
    requirements.checklist.find((check) => check.id === 'material-questions-resolved').requirement,
    'optional'
  );

  const state = await readFile(path.join(packageRoot, 'src', 'initiative-state.mjs'), 'utf8');
  assert.match(state, /producerOutput\?\.required === false && !producerOutput\.sha256\) continue/);
});

test('every promotion target teaches Copilot the fence it will be parsed by', async () => {
  // Promotion recognises artifacts only by <<<SFLOW-ARTIFACT:id …>>>. That format was described
  // solely in phaseTargetInstructions, reachable only for a phase-scoped target — which nothing
  // ever sent. A single-output session was told to produce "a complete Markdown document" and its
  // reply could never be recognised, so no artifact could be promoted from any surface.
  const root = await repository();
  run(root, process.execPath, [bin, 'initiative', 'start', 'INIT-FENCE', '--title', 'Fence coverage']);
  const catalog = await planningTargetCatalog(root, { initiativeId: 'INIT-FENCE' });
  const phase = catalog.targets[0].phases.find((item) => item.targets.length > 2);
  assert.ok(phase, 'expected a phase with more than one promotable output');

  // The whole set is offered first, so a caller taking targets[0] gets every artifact.
  assert.equal(phase.targets[0].id, PHASE_SCOPE);
  const ids = phase.targets.slice(1).map((item) => item.id);

  const whole = await createPlanningContext(root, {
    scope: 'initiative', id: 'INIT-FENCE', phase: phase.id,
    agent: 'product-owner', target: PHASE_SCOPE, objective: 'set'
  });
  const wholeText = await readFile(whole.contextPath, 'utf8');
  for (const id of ids) assert.ok(wholeText.includes(`<<<SFLOW-ARTIFACT:${id}`), `${id} fence missing from phase contract`);

  const single = await createPlanningContext(root, {
    scope: 'initiative', id: 'INIT-FENCE', phase: phase.id,
    agent: 'product-owner', target: ids[0], objective: 'one'
  });
  const singleText = await readFile(single.contextPath, 'utf8');
  assert.ok(singleText.includes(`<<<SFLOW-ARTIFACT:${ids[0]}`), 'single-target contract must describe its own fence');
  assert.ok(!singleText.includes(`<<<SFLOW-ARTIFACT:${ids[1]}`), 'a single-output contract must not invite artifacts it is not scoped to');
});

test('a moved HEAD blocks promotion but does not destroy the conversation', async () => {
  // loadPlanningPack refused outright on a HEAD that had moved, and resume used the same door. So
  // any governed commit in between — publishing another phase, pinning a source, restarting the
  // Epic — took the transcript with it, when all it should do is make the pack unpromotable. The
  // workspace already had a stale-context banner to say exactly that; it never got the chance.
  const { loadPlanningPack, promotePlanningArtifacts } = await import('../src/planning.mjs');
  const root = await repository();
  run(root, process.execPath, [bin, 'start', 'PLAN-STALE', '--from-branch', 'main', '--title', 'Stale context']);
  const context = await createPlanningContext(root, {
    scope: 'work-item',
    id: 'PLAN-STALE',
    phase: 'intake',
    agent: 'product-owner',
    target: 'artifact',
    objective: 'Define the outcome.'
  });

  await writeFile(path.join(root, 'UNRELATED.md'), '# a governed commit lands\n');
  run(root, 'git', ['add', 'UNRELATED.md']);
  run(root, 'git', ['commit', '-m', 'Something else was committed']);

  // Reading it back is fine, and it says plainly that the repository has moved on.
  const pack = await loadPlanningPack(root, context.sessionId, { requireCurrentHead: false });
  assert.equal(pack.headMoved, true);
  assert.equal(pack.manifest.sessionId, context.sessionId);

  // Writing to Git is not: promotion still demands the tree the context was built against.
  await assert.rejects(
    promotePlanningArtifacts(root, { sessionId: context.sessionId, artifacts: [{ id: 'artifact', content: '# Draft\n' }] }),
    /Repository HEAD changed after the planning context was created/
  );
  // …and the default is still the strict one, so no caller gets the loose rule by accident.
  await assert.rejects(loadPlanningPack(root, context.sessionId), /Repository HEAD changed/);
});

test('a changed governed source restores as stale but remains impossible to promote', async () => {
  const { loadPlanningPack } = await import('../src/planning.mjs');
  const root = await repository();
  run(root, process.execPath, [bin, 'start', 'PLAN-SOURCE-STALE', '--from-branch', 'main', '--title', 'Changed governed state']);
  const context = await createPlanningContext(root, {
    scope: 'work-item',
    id: 'PLAN-SOURCE-STALE',
    phase: 'intake',
    agent: 'product-owner',
    target: 'artifact',
    objective: 'Define the outcome.'
  });
  const source = context.manifest.prompt;
  assert.ok(source?.path && !source.path.startsWith('builtin:'), 'planning context should pin its governed prompt');
  const sourcePath = path.join(root, source.path);
  await writeFile(sourcePath, `${await readFile(sourcePath, 'utf8')}\n`);

  const restored = await loadPlanningPack(root, context.sessionId, { requireCurrentHead: false });
  assert.equal(restored.stale, true);
  assert.equal(restored.changedSources.length, 1);
  assert.equal(restored.changedSources[0].path, source.path);
  assert.equal(restored.changedSources[0].status, 'changed');

  await assert.rejects(
    loadPlanningPack(root, context.sessionId),
    /Governed planning source changed after context creation/
  );
});

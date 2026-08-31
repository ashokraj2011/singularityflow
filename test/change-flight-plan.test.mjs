import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

import {
  evaluateChangeFlightPlanBoundary, explainChangeFlightPlanFinding, previewChangeFlightPlan,
  readChangeFlightPlan, recordChangeFlightPlanDisposition, recordChangeFlightPlanExpansionDisposition,
  startChangeFlightPlan
} from '../src/change-flight-plan.mjs';
import { loadDefinition } from '../src/config.mjs';
import { worldModelSourceSnapshot } from '../src/grounding.mjs';
import { impactWhatIf } from '../src/gateway/planners/impact-what-if.mjs';
import { loadStoryAggregate } from '../src/state-stores.mjs';
import { writeV3Manifest } from '../src/world-model-materialization.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Flight Plan Tester' }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cfp-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Flight Plan Tester'], root);
  run('git', ['config', 'user.email', 'flight-plan@example.com'], root);
  run(process.execPath, [cli, 'init'], root);
  const definitionFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionFile, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionFile, YAML.stringify(definition));
  await mkdir(path.join(root, 'src/payment'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await mkdir(path.join(root, '.github'), { recursive: true });
  await writeFile(path.join(root, 'src/payment/notifier.mjs'), 'export const PaymentNotifier = { send() { return "sent"; } };\n');
  await writeFile(path.join(root, 'src/payment/checkout.mjs'), 'import { PaymentNotifier } from "./notifier.mjs";\nPaymentNotifier.send();\n');
  await writeFile(path.join(root, 'test/notifier.test.mjs'), 'import { PaymentNotifier } from "../src/payment/notifier.mjs";\nPaymentNotifier.send();\n');
  await writeFile(path.join(root, '.github/CODEOWNERS'), '/src/payment/ @payments-reviewers\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize flight plan fixture'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  return root;
}

function refs(root) {
  return run('git', ['for-each-ref', '--format=%(refname):%(objectname)', 'refs/heads'], root).stdout;
}

function worktrees(root) {
  return run('git', ['worktree', 'list', '--porcelain'], root).stdout;
}

async function publishStateWorldModel(root, outputDir, sourceTreeSha256, label = 'Flight plan model') {
  const mainCommit = run('git', ['rev-parse', 'main'], root).stdout.trim();
  run('git', ['switch', '-c', 'state'], root);
  const directory = path.join(root, outputDir);
  await mkdir(path.join(directory, 'core'), { recursive: true });
  await mkdir(path.join(directory, 'evidence'), { recursive: true });
  await writeFile(path.join(directory, 'core/summary.brief.md'), `# ${label} brief\n`);
  await writeFile(path.join(directory, 'core/summary.md'), `# ${label} full\n`);
  await writeFile(path.join(directory, 'core/model.json'), '{}\n');
  await writeFile(path.join(directory, 'path-index.json'), JSON.stringify({
    paths: ['src/payment/notifier.mjs']
  }));
  await writeFile(path.join(directory, 'evidence/evidence.jsonl'), '{"id":"E-1"}\n');
  await writeV3Manifest(directory, {
    schema_version: '3.0', generated_at: '2026-08-31T00:00:00.000Z',
    generated_date: '31 August 2026', builder_version: 'test',
    builder_prompt_sha256: 'a'.repeat(64), analysis_depth: 'standard',
    repository_commit: mainCommit, repository_branch: 'main', working_tree_clean: true,
    source_tree_sha256: sourceTreeSha256,
    core: {
      tiers: {
        brief: { status: 'ready', path: 'core/summary.brief.md' },
        full: { status: 'ready', path: 'core/summary.md' }
      }, model: { path: 'core/model.json' }
    },
    views: {}, domains: [], task_guides: [],
    path_index: { path: 'path-index.json' }, evidence: { path: 'evidence/evidence.jsonl' },
    materializations: []
  });
  run('git', ['add', outputDir], root);
  run('git', ['commit', '-m', 'publish state world model'], root);
  run('git', ['push', 'origin', 'HEAD:state'], root);
  run('git', ['switch', 'main'], root);
}

test('preview is model-free, reproducible, locally disposable, and performs zero lifecycle writes', async () => {
  const root = await repository();
  const before = {
    refs: refs(root), worktrees: worktrees(root), status: run('git', ['status', '--porcelain'], root).stdout,
    workItems: run('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'singularity/work-items'], root).stdout
  };
  const plan = await previewChangeFlightPlan(root, {
    intent: 'replace synchronous payment notification with an event',
    symbol: 'PaymentNotifier.send', ast: false
  });
  assert.match(plan.planId, /^cfp-[a-f0-9]{20}$/);
  assert.ok(plan.findings.some((finding) => finding.classification === 'proven' && finding.subject === 'src/payment/checkout.mjs'));
  assert.ok(plan.findings.some((finding) => finding.kind === 'test-file'));
  assert.ok(plan.unknowns.some((finding) => finding.subject === 'ast'));
  assert.equal(plan.provenance.engine.modelInvoked, false);
  assert.deepEqual({
    refs: refs(root), worktrees: worktrees(root), status: run('git', ['status', '--porcelain'], root).stdout,
    workItems: run('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'singularity/work-items'], root).stdout
  }, before);
  assert.deepEqual((await readChangeFlightPlan(root, plan.planId)).findings, plan.findings);
  const detail = await explainChangeFlightPlanFinding(root, plan.planId, plan.findings[0].findingId);
  assert.equal(detail.reproducible, true);
  await assert.rejects(() => recordChangeFlightPlanDisposition(root, plan.planId, plan.findings[0].findingId, {
    disposition: 'excluded'
  }), /requires --reason/);
  const disposed = await recordChangeFlightPlanDisposition(root, plan.planId, plan.findings[0].findingId, {
    disposition: 'excluded', reason: 'Handled by a separate change.'
  });
  assert.notEqual(disposed.planId, plan.planId);
  const excluded = disposed.findings.find((finding) => finding.findingId === plan.findings[0].findingId);
  assert.equal(excluded.classification, plan.findings[0].classification, 'disposition cannot rewrite evidence classification');
  assert.equal(excluded.disposition, 'excluded');
  assert.equal(excluded.dispositionReason, 'Handled by a separate change.');
});

test('preview reuses a validated custom-output world model from governed state', async () => {
  const root = await repository();
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.worldModel.outputDir = 'governed/repository-model';
  await writeFile(definitionPath, YAML.stringify(definition));
  run('git', ['add', definitionPath], root);
  run('git', ['commit', '-m', 'configure custom model output'], root);
  run('git', ['push', 'origin', 'main'], root);
  const source = await worldModelSourceSnapshot(root, definition);
  await publishStateWorldModel(root, definition.worldModel.outputDir, source.sha256);

  const plan = await previewChangeFlightPlan(root, {
    file: 'src/payment/notifier.mjs', ast: false, persist: false
  });
  assert.equal(plan.baseline.worldModelSource, 'state-branch');
  assert.equal(plan.baseline.worldModelOutputDir, 'governed/repository-model');
  assert.equal(plan.provenance.categories.worldModel.status, 'evaluated');
  assert.equal(plan.provenance.categories.worldModel.source, 'state-branch');
  assert.ok(plan.findings.some((finding) => finding.relationship === 'indexed-by-world-model'
    && finding.subject === 'src/payment/notifier.mjs'));
  assert.ok(!plan.unknowns.some((finding) => finding.subject === 'worldModel'));
});

test('outside paths and symlink targets are refused before analysis', async () => {
  const root = await repository();
  await assert.rejects(() => previewChangeFlightPlan(root, { file: '../outside.mjs', ast: false }), /outside the repository/);
  const link = path.join(root, 'linked.mjs');
  run('ln', ['-s', '/etc/hosts', link], root);
  await assert.rejects(() => previewChangeFlightPlan(root, { file: 'linked.mjs', ast: false }), /symbolic link/);
});

test('start refuses a stale binding without creating work', async () => {
  const root = await repository();
  const plan = await previewChangeFlightPlan(root, { symbol: 'PaymentNotifier.send', ast: false });
  await writeFile(path.join(root, 'README.md'), '# baseline moved\n');
  run('git', ['add', 'README.md'], root);
  run('git', ['commit', '-m', 'move baseline'], root);
  const target = path.join(root, '..', `${path.basename(root)}-stale-worktree`);
  await assert.rejects(() => startChangeFlightPlan(root, plan.planId, {
    confirm: plan.planId, workId: 'PAY-STALE', workType: 'feature', worktree: target
  }), (error) => error.code === 'CFP_PLAN_STALE' && /impact refresh/.test(error.details.nextAction));
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/PAY-STALE'], root, { allowFailure: true }).status, 1);
  assert.doesNotMatch(worktrees(root), /stale-worktree/);
});

test('explicit start creates one isolated governed worktree, pins the exact plan, and is idempotent', async () => {
  const root = await repository();
  const plan = await previewChangeFlightPlan(root, { symbol: 'PaymentNotifier.send', ast: false });
  const target = path.join(root, '..', `${path.basename(root)}-worktree`);
  await assert.rejects(() => startChangeFlightPlan(root, plan.planId, {
    confirm: plan.planId, workId: 'PAY-NO-WORKFLOW', worktree: `${target}-no-workflow`
  }), (error) => error.code === 'CFP_START_TRANSACTION_INCOMPLETE'
    && /explicit workflow choice/.test(error.message)
    && error.details.workTypes.includes('feature'));
  const started = await startChangeFlightPlan(root, plan.planId, {
    confirm: plan.planId, workId: 'PAY-1187', workType: 'feature', worktree: target
  });
  assert.equal(started.idempotent, false);
  assert.equal(run('git', ['branch', '--show-current'], root).stdout.trim(), 'main');
  assert.equal(run('git', ['branch', '--show-current'], target).stdout.trim(), 'PAY-1187');
  const item = path.join(target, 'singularity/work-items/PAY-1187');
  const accepted = JSON.parse(await readFile(path.join(item, 'context/change-flight-plan/accepted-plan.json'), 'utf8'));
  assert.deepEqual(accepted, plan);
  const context = JSON.parse(await readFile(path.join(item, 'context/change-flight-plan/context-package.json'), 'utf8'));
  assert.ok(context.byteLength <= 32 * 1024);
  assert.equal(context.retrieval.sourceBodiesIncluded, false);
  const checklist = JSON.parse(await readFile(path.join(item, 'context/change-flight-plan/verification-candidates.json'), 'utf8'));
  assert.match(checklist.disclaimer, /not verification evidence/);
  const repeated = await startChangeFlightPlan(root, plan.planId, {
    confirm: plan.planId, workId: 'IGNORED', workType: 'feature', worktree: `${target}-other`
  });
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.workId, 'PAY-1187');
  assert.equal((refs(root).match(/refs\/heads\/PAY-1187/g) ?? []).length, 1);
  const alternate = await recordChangeFlightPlanDisposition(root, plan.planId, plan.findings[0].findingId, {
    disposition: 'investigate', reason: 'Review before independent work.'
  });
  await assert.rejects(() => startChangeFlightPlan(root, alternate.planId, {
    confirm: alternate.planId, workId: 'PAY-DUPLICATE', workType: 'feature', worktree: `${target}-duplicate`
  }), (error) => error.code === 'CFP_WORK_ALREADY_EXISTS' && error.details.nextActions.some((entry) => /PAY-1187/.test(entry)));
});

test('accepted plans distinguish expected changes from unexamined scope expansion', async () => {
  const root = await repository();
  const plan = await previewChangeFlightPlan(root, { file: 'src/payment/notifier.mjs', ast: false });
  const target = path.join(root, '..', `${path.basename(root)}-delta-worktree`);
  await startChangeFlightPlan(root, plan.planId, {
    confirm: plan.planId, workId: 'PAY-DELTA', workType: 'feature', worktree: target,
    acceptPartial: true
  });
  await writeFile(path.join(target, 'src/payment/notifier.mjs'), 'export const PaymentNotifier = { send() { return "queued"; } };\n');
  run('git', ['add', 'src/payment/notifier.mjs'], target);
  run('git', ['commit', '-m', 'change expected notifier'], target);
  const definition = await loadDefinition(target);
  let workflow = await loadStoryAggregate(target, definition, 'PAY-DELTA');
  const expected = evaluateChangeFlightPlanBoundary(target, workflow, { phaseId: 'implementation' });
  assert.deepEqual(expected.delta.unresolved, []);
  assert.deepEqual(expected.delta.actualPaths, ['src/payment/notifier.mjs']);

  await writeFile(path.join(target, '.github/agents/developer.agent.md'), '# Approved agent projection\n');
  run('git', ['add', '.github/agents/developer.agent.md'], target);
  run('git', ['commit', '-m', 'project approved configuration'], target);
  workflow = await loadStoryAggregate(target, definition, 'PAY-DELTA');
  const afterProjection = evaluateChangeFlightPlanBoundary(target, workflow);
  assert.deepEqual(afterProjection.delta.actualPaths, ['src/payment/notifier.mjs'],
    'approved agent projection is not a Story scope expansion');

  await writeFile(path.join(target, 'src/payment/unplanned.mjs'), 'export const unexpected = true;\n');
  run('git', ['add', 'src/payment/unplanned.mjs'], target);
  run('git', ['commit', '-m', 'expand actual scope'], target);
  workflow = await loadStoryAggregate(target, definition, 'PAY-DELTA');
  assert.throws(() => evaluateChangeFlightPlanBoundary(target, workflow), (error) =>
    error.code === 'CFP_ANALYSIS_PARTIAL' && error.details.unresolved.includes('src/payment/unplanned.mjs'));
  recordChangeFlightPlanExpansionDisposition(target, workflow, 'src/payment/unplanned.mjs', {
    disposition: 'accepted-expansion', reason: 'Required event adapter.'
  });
  const accepted = evaluateChangeFlightPlanBoundary(target, workflow);
  assert.deepEqual(accepted.delta.unresolved, []);
  assert.equal(accepted.receipt.lineage.predictedPlanSha256, workflow.changeFlightPlan.acceptedPlanSha256);
});

test('gateway and CLI projections use the same deterministic finding engine', async () => {
  const root = await repository();
  const intent = 'replace synchronous payment notification with an event';
  const direct = await previewChangeFlightPlan(root, { intent, ast: false, persist: false });
  const gateway = await impactWhatIf({ arguments: { proposal: intent, ast: false }, root });
  const projected = gateway.data.changeFlightPlan;
  const facts = (plan) => plan.findings.map((finding) => ({
    classification: finding.classification, kind: finding.kind, subject: finding.subject,
    relationship: finding.relationship, source: finding.source
  }));
  assert.deepEqual(facts(projected), facts(direct));
  assert.deepEqual(projected.unknowns.map((finding) => finding.subject), direct.unknowns.map((finding) => finding.subject));
});

test('every AST-derived finding carries a complete derivation key or AST remains an explicit unknown', async () => {
  const root = await repository();
  const plan = await previewChangeFlightPlan(root, { symbol: 'PaymentNotifier', persist: false });
  const ast = plan.findings.filter((finding) => finding.source.type === 'ast');
  if (ast.length) {
    for (const finding of ast) {
      assert.ok(finding.source.derivationKey);
      assert.ok(finding.source.derivationKey.inputs);
      assert.ok(finding.source.derivationKey.outputs);
    }
  } else assert.ok(plan.unknowns.some((finding) => finding.subject === 'ast'));
});

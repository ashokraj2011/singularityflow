import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { coordinatePhaseRepair, phaseRepairConditionHash } from '../src/phase-repair-runtime.mjs';
import { assertPhaseRepairSettled, phaseRepairBinding, phaseRepairJournalDirectory,
  phaseRepairLoopSummary, readPhaseRepairJournal, repairDigest } from '../src/phase-repair-journal.mjs';
import { resolveOperation } from '../src/command-registry.mjs';

async function fixture(t, { maximum = 3, phaseId = 'custom-phase' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phase-loop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-b', 'story'); git('config', 'user.name', 'Repair Tester'); git('config', 'user.email', 'repair@example.test');
  await writeFile(path.join(root, 'source.txt'), 'Preserve this product source.\n');
  git('add', '.'); git('commit', '-m', 'Repair fixture');
  const workflow = { status: 'in_progress', currentPhase: phaseId, workItem: { id: 'LOOP-1', branch: 'story' },
    resolution: { pinnedPolicy: 'original' }, phases: { [phaseId]: { id: phaseId, status: 'in_progress',
      generation: 0, generationIntent: { id: 'GI-1', status: 'open', generation: 1 }, repairBudget: { maxAttempts: maximum } } } };
  const phase = workflow.phases[phaseId]; let condition = 'A'; let syncs = 0;
  const binding = await phaseRepairBinding(root, workflow, phase);
  const observation = () => ({ ready: condition === 'ready', conditionHash: repairDigest(condition),
    findings: condition === 'ready' ? [] : [{ code: 'artifact.placeholder.unresolved', category: 'artifact', path: 'draft.md' }],
    inspection: { status: condition === 'ready' ? 'ready' : 'correction-required', draftFingerprint: repairDigest(condition),
      ownership: { proven: true, agent: 'team-producer' }, correction: { sameTurn: true, class: 'agent-authoring', skill: '/sf-phase' } },
    recovery: { pendingPublication: false, publicationRecovery: null, actions: [],
      revision: { head: git('rev-parse', 'HEAD'), branch: 'story', worktree: 'exact-revision' } },
    resolution: { issues: [{ code: 'artifact.placeholder.unresolved', choices: [{ owner: 'phase-author' }] }] } });
  const dependencies = { load: async () => ({ definition: {}, workflow: structuredClone(workflow) }), inspect: async () => observation(),
    sync: async () => { syncs += 1; condition = 'ready'; } };
  const call = (action = 'plan', confirmation = null, overrides = {}) => coordinatePhaseRepair({ root, action, confirmation, phaseId }, { ...dependencies, ...overrides });
  return { root, workflow, phase, binding, git, call, dependencies, observation,
    set: value => { condition = value; }, syncs: () => syncs };
}
async function reserve(f, overrides = {}) {
  const plan = await f.call(); assert.equal(plan.status, 'confirmation-required');
  return f.call('run', plan.confirmation, overrides);
}
test('persistent producer reservation preserves files/index, holds transitions and resumes without a second attempt', async t => {
  const f = await fixture(t); const originalHead = f.git('rev-parse', 'HEAD');
  await writeFile(path.join(f.root, 'notes.txt'), 'Unrelated staged note.\n'); f.git('add', 'notes.txt');
  const index = f.git('diff', '--cached'); const source = await readFile(path.join(f.root, 'source.txt'));
  const result = await reserve(f);
  assert.match(result.checkpoint.id, /^PCP-[a-f0-9]{64}$/u);
  const saved = await phaseRepairLoopSummary(f.root, f.workflow, f.phase);
  assert.equal(saved.active.checkpointId, result.checkpoint.id);
  assert.match(saved.checkpoints[0].command, /checkpoint-show PCP-/u);
  assert.equal(result.status, 'awaiting-producer-repair'); assert.equal(result.consumed, 1); assert.equal(result.modelInvocations, 0);
  assert.equal(f.syncs(), 0); assert.equal(f.git('rev-parse', 'HEAD'), originalHead);
  assert.equal(f.git('diff', '--cached'), index); assert.deepEqual(await readFile(path.join(f.root, 'source.txt')), source);
  await assert.rejects(assertPhaseRepairSettled(f.root, f.workflow, f.phase), { code: 'PHASE_REPAIR_RECHECK_REQUIRED' });
  const restart = await f.call(); assert.equal(restart.status, 'resume-required');
  await assert.rejects(f.call('run', restart.confirmation), { code: 'PHASE_REPAIR_ADMISSION_REFUSED' });
  f.set('ready'); const resumed = await f.call('resume');
  assert.equal(resumed.result, 'ready'); assert.equal(resumed.consumed, 1); assert.equal(resumed.testsRun, false);
  await assertPhaseRepairSettled(f.root, f.workflow, f.phase);
  assert.equal((await f.call('resume')).journalChanged, false);
});

test('pending evidence review allows only other owned draft repairs and never counts as repair success', async t => {
  const f = await fixture(t);
  const pending = { code: 'phase.evidence-contract.not-ready', category: 'evidence-contract', path: 'evidence/screen.png',
    details: { sourceCode: 'PLAN_EVIDENCE_CORRECTION_REVIEW_REQUIRED' } };
  const observe = async () => {
    const value = f.observation();
    value.inspection.draftRepair = { allowed: true, scope: 'draft-only' };
    value.findings.push(pending);
    value.conditionHash = phaseRepairConditionHash({ ready: false, findings: value.findings });
    value.ready = false;
    return value;
  };
  const plan = await f.call('plan', null, { inspect: observe });
  assert.equal(plan.action.id, 'owned-producer-repair');
  const reserved = await f.call('run', plan.confirmation, { inspect: observe });
  assert.equal(reserved.status, 'awaiting-producer-repair');
  f.set('ready');
  const finished = await f.call('resume', null, { inspect: observe });
  assert.notEqual(finished.result, 'ready');
  assert.equal(finished.action, null, 'the producer cannot repair the human decision');
  assert.equal(finished.phaseAdvanced, false);
  const unverified = async () => { const value = await observe(); delete value.inspection.draftRepair; return value; };
  f.set('different-owned-gap');
  assert.equal((await f.call('plan', null, { inspect: unverified })).action, null);
});
test('unchanged, oscillating and exhausted repairs remain stopped across coordinator restarts', async t => {
  const f = await fixture(t); await reserve(f);
  const same = await f.call('resume'); assert.equal(same.result, 'unchanged-condition');
  assert.equal((await f.call()).admission.reason, 'unchanged-or-oscillating-condition');
  f.set('B'); await reserve(f); f.set('A'); await f.call('resume');
  assert.equal((await f.call()).admission.reason, 'unchanged-or-oscillating-condition');
  f.set('C'); await reserve(f); f.set('D'); await f.call('resume');
  assert.equal((await f.call()).admission.reason, 'budget-exhausted');
  assert.equal((await f.call()).alternatives.manualRepairAllowed, true);
  assert.equal((await f.call('status')).consumed, 3);
  // A manual correction is still a route forward; exhausting auto repair never waives or freezes
  // the ordinary gates, and correcting a draft cannot grant a new automatic budget.
  f.set('ready'); assert.equal((await f.call()).status, 'ready-for-next-check');
  await assertPhaseRepairSettled(f.root, f.workflow, f.phase);
});
test('strict policy budgets, exact plan confirmation and policy drift cannot reset attempts', async t => {
  const f = await fixture(t, { maximum: 1 }); const preview = await f.call(); f.set('B');
  await assert.rejects(f.call('run', preview.confirmation), { code: 'PHASE_REPAIR_PLAN_STALE' });
  assert.equal((await f.call('status')).consumed, 0);
  await reserve(f); f.workflow.resolution.pinnedPolicy = 'approved-successor';
  assert.equal((await f.call('resume')).result, 'binding-changed');
  f.set('C'); assert.equal((await f.call()).admission.reason, 'budget-exhausted');
  f.phase.generationIntent = { id: 'GI-2', status: 'open', generation: 2 };
  assert.equal((await f.call('status')).consumed, 0);
});
test('a crash after reservation is durable and concurrent starts cannot both obtain a slot', async t => {
  const f = await fixture(t); const plan = await f.call();
  await assert.rejects(f.call('run', plan.confirmation, { afterReservation: () => { throw new Error('simulated crash'); } }), /simulated crash/u);
  assert.equal((await f.call('status')).active.attempt, 1);
  f.set('ready'); assert.equal((await f.call('resume')).result, 'ready');
  const other = await fixture(t, { phaseId: 'future-custom-phase' }); const next = await other.call();
  const simultaneous = await Promise.allSettled([other.call('run', next.confirmation), other.call('run', next.confirmation)]);
  assert.equal(simultaneous.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await other.call('status')).consumed, 1);
});

test('a terminated process leaves a durable reservation that another process can resume', async t => {
  const f = await fixture(t);
  const code = `import {coordinatePhaseRepair} from ${JSON.stringify(new URL('../src/phase-repair-runtime.mjs', import.meta.url).href)};
    const request=${JSON.stringify({ root: f.root, phaseId: f.phase.id })};
    const dependencies={load:async()=>(${JSON.stringify({ definition: {}, workflow: f.workflow })}),
      inspect:async()=>(${JSON.stringify(f.observation())})};
    const plan=await coordinatePhaseRepair({...request,action:'plan'},dependencies);
    await coordinatePhaseRepair({...request,action:'run',confirmation:plan.confirmation},
      {...dependencies,afterReservation:()=>process.exit(23)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 23, result.stderr);
  const retained = await f.call('status'); assert.equal(retained.consumed, 1); assert.equal(retained.active.attempt, 1);
  f.set('ready'); const resumed = await f.call('resume');
  assert.equal(resumed.result, 'ready'); assert.equal(resumed.consumed, 1);
});
test('only exact registered sync is automatic; crash-after-action does not replay when the marker cleared', async t => {
  const f = await fixture(t); let pending = true; let executions = 0;
  const inspect = async () => {
    const result = f.observation(); result.ready = !pending; result.conditionHash = repairDigest(pending ? 'sync-pending' : 'ready');
    result.recovery.pendingPublication = pending; result.recovery.publicationRecovery = pending
      ? { status: 'pending', record: { commit: 'a'.repeat(40), remote: 'origin', branch: 'story', recoveryStage: 'committed' } } : null;
    result.recovery.actions = [{ id: 'publish', automatic: true, command: 'singularity-flow sync' }];
    return result;
  };
  const sync = async () => { executions += 1; pending = false; };
  const overrides = { inspect, sync };
  const plan = await f.call('plan', null, overrides); assert.equal(plan.action.mode, 'automatic');
  await assert.rejects(f.call('run', plan.confirmation, { ...overrides, afterAction: () => { throw new Error('crash after operation'); } }), /crash after operation/u);
  assert.equal(executions, 1); assert.equal((await f.call('status')).consumed, 1);
  const resumed = await f.call('resume', null, overrides); assert.equal(resumed.result, 'ready'); assert.equal(executions, 1);
  assert.equal(resumed.phaseAdvanced, false); assert.equal(resumed.autoAcceptRisk, false);
});
test('crashed sync replays only the same idempotent retained operation and never starts another attempt', async t => {
  const f = await fixture(t); let pending = true; let executions = 0;
  const inspect = async () => {
    const value = f.observation(); value.ready = !pending; value.conditionHash = repairDigest(pending ? 'P' : 'ready');
    value.recovery.pendingPublication = pending; value.recovery.publicationRecovery = pending
      ? { status: 'pending', record: { commit: 'a'.repeat(40), recoveryStage: 'committed' } } : null;
    value.recovery.actions = [{ id: 'publish', automatic: true, command: 'singularity-flow sync' }]; return value;
  };
  const overrides = { inspect, sync: async () => { executions += 1; pending = false; } };
  const plan = await f.call('plan', null, overrides);
  await assert.rejects(f.call('run', plan.confirmation, { ...overrides, afterReservation: () => { throw new Error('crash before operation'); } }), /crash before operation/u);
  const resumed = await f.call('resume', null, overrides);
  assert.equal(executions, 1); assert.equal(resumed.consumed, 1); assert.equal(resumed.result, 'ready');
});

test('post-operation reload uncertainty seals the original attempt without crediting a new binding', async t => {
  for (const action of ['run', 'resume']) {
    for (const change of ['unavailable', 'generation', 'branch']) {
      await t.test(`${action}/${change}`, async child => {
        const f = await fixture(child); let completed = false; let executions = 0;
        const nextWorkflow = structuredClone(f.workflow);
        nextWorkflow.phases[f.phase.id].generationIntent = { id: 'GI-2', status: 'open', generation: 2 };
        const overrides = {
          load: async () => {
            if (completed && change === 'unavailable') throw Object.assign(new Error('reload unavailable'), { code: 'READ_UNAVAILABLE' });
            return { definition: {}, workflow: structuredClone(completed && change === 'generation' ? nextWorkflow : f.workflow) };
          },
          branch: () => completed && change === 'branch' ? 'another-story' : 'story',
          inspect: async () => ({ ...f.observation(), ready: completed,
            conditionHash: repairDigest(completed ? 'ready' : 'pending'),
            recovery: { ...f.observation().recovery, pendingPublication: !completed,
              publicationRecovery: completed ? null : { status: 'pending', record: { commit: 'a'.repeat(40), recoveryStage: 'committed' } },
              actions: [{ id: 'publish', automatic: true, command: 'singularity-flow sync' }] } }),
          sync: async () => { executions += 1; completed = true; return { postconditionsMet: true }; }
        };
        const plan = await f.call('plan', null, overrides);
        let result;
        if (action === 'resume') {
          await assert.rejects(f.call('run', plan.confirmation, { ...overrides,
            afterReservation: () => { throw new Error('interrupted before sync'); } }), /interrupted before sync/u);
          result = await f.call('resume', null, overrides);
        } else result = await f.call('run', plan.confirmation, overrides);
        assert.equal(result.status, 'needs-human-or-owner'); assert.equal(result.registeredOperationExecuted, true);
        assert.equal(result.transportOutcome, 'verified'); assert.equal(executions, 1);
        assert.equal(result.testsRun, false); assert.equal(result.phaseAdvanced, false); assert.equal(result.autoAcceptRisk, false);
        const journal = await readPhaseRepairJournal(f.root, f.binding);
        assert.equal(journal.consumed, 1); assert.equal(journal.active, null);
        assert.equal(journal.attempts[0].result.ready, false);
        assert.equal(journal.attempts[0].result.outcome, change === 'generation' ? 'binding-changed' : 'inspection-unavailable');
        const nextBinding = await phaseRepairBinding(f.root, nextWorkflow, nextWorkflow.phases[f.phase.id]);
        assert.equal((await readPhaseRepairJournal(f.root, nextBinding)).consumed, 0);
      });
    }
  }
});

test('sync that can deliver integrations or reconcile a ledger stays on the owner route', async t => {
  const f = await fixture(t);
  const inspect = async () => ({ ...f.observation(), recovery: { ...f.observation().recovery,
    pendingPublication: true, publicationRecovery: { status: 'pending', record: { commit: 'a'.repeat(40), recoveryStage: 'committed' } },
    actions: [{ id: 'publish', automatic: true, command: 'singularity-flow sync' }] } });
  f.workflow.resolution.phases = [{ id: f.phase.id, afterStep: [{ id: 'notify', required: false }] }];
  const integration = await f.call('plan', null, { inspect });
  assert.equal(integration.action, null);
  f.workflow.resolution.phases = []; f.workflow.resolution.ledger = { enabled: true };
  assert.equal((await f.call('plan', null, { inspect })).action, null);
  assert.equal((await f.call('status')).consumed, 0);
});

test('a changed pending record cannot replay an interrupted sync', async t => {
  const f = await fixture(t); let commit = 'a'.repeat(40); let syncs = 0;
  const inspect = async () => ({ ...f.observation(), recovery: { ...f.observation().recovery,
    pendingPublication: true, publicationRecovery: { status: 'pending', record: { commit, recoveryStage: 'committed' } },
    actions: [{ id: 'publish', automatic: true, command: 'singularity-flow sync' }] } });
  const overrides = { inspect, sync: async () => { syncs += 1; } };
  const plan = await f.call('plan', null, overrides);
  await assert.rejects(f.call('run', plan.confirmation, { ...overrides, afterReservation: () => { throw new Error('interrupted'); } }));
  commit = 'b'.repeat(40);
  const resumed = await f.call('resume', null, overrides);
  assert.equal(resumed.result, 'binding-changed'); assert.equal(resumed.consumed, 1); assert.equal(syncs, 0);
});

test('unavailable inspection closes the same attempt honestly and leaves manual recovery available', async t => {
  const f = await fixture(t); await reserve(f);
  const result = await f.call('resume', null, { inspect: async () => { throw Object.assign(new Error('inspection unavailable'), { code: 'READ_UNAVAILABLE' }); } });
  assert.equal(result.status, 'needs-human-or-owner'); assert.equal(result.testsRun, false);
  assert.equal(result.autoAcceptRisk, false); assert.equal(result.code, 'READ_UNAVAILABLE');
  const status = await f.call('status'); assert.equal(status.consumed, 1); assert.equal(status.active, null);
  assert.equal((await f.call()).admission.reason, 'unchanged-or-oscillating-condition');
  f.set('ready'); await assertPhaseRepairSettled(f.root, f.workflow, f.phase);
});
test('authority/risk/unknown-owner findings never launch a repair or execute error-supplied commands', async t => {
  const f = await fixture(t);
  for (const category of ['appeal', 'clarification', 'integrity', 'configuration', 'host', 'integration', 'transport', 'inputs', 'tests']) {
    const plan = await f.call('plan', null, { inspect: async () => ({ ...f.observation(),
      findings: [{ code: 'block', category }], recovery: { ...f.observation().recovery,
        actions: [{ id: 'publish', automatic: true, command: 'node malicious-script.mjs' }] } }) });
    assert.equal(plan.action, null); assert.equal(plan.status, 'needs-human-or-owner');
    await assert.rejects(f.call('run', plan.confirmation, { inspect: async () => ({ ...f.observation(),
      findings: [{ code: 'block', category }], recovery: { ...f.observation().recovery,
        actions: [{ id: 'publish', automatic: true, command: 'node malicious-script.mjs' }] } }) }), { code: 'PHASE_REPAIR_ADMISSION_REFUSED' });
  }
  assert.equal((await f.call('status')).consumed, 0); assert.equal(f.syncs(), 0);
});
test('corrupt, missing-chain and linked journal records fail closed without a reset', async t => {
  const f = await fixture(t); await reserve(f);
  const directory = await phaseRepairJournalDirectory(f.root, f.binding);
  const file = path.join(directory, '000001.json'); const original = await readFile(file);
  const data = JSON.parse(original); data.attempt = 2; await writeFile(file, JSON.stringify(data));
  await assert.rejects(f.call('status'), { code: 'PHASE_REPAIR_JOURNAL_INVALID' });
  assert.equal((await readFile(file)).toString(), JSON.stringify(data));
  await writeFile(file, original); f.set('B'); await f.call('resume');
  await rm(file); await assert.rejects(f.call('status'), { code: 'PHASE_REPAIR_JOURNAL_INVALID' });
  await writeFile(file, original); await rm(file);
  await symlink(path.join(f.root, 'source.txt'), file);
  await assert.rejects(f.call('status'), { code: 'PHASE_REPAIR_JOURNAL_INVALID' });
});
test('journal is isolated per checkout and Story, never placed in the application worktree', async t => {
  const f = await fixture(t); await reserve(f);
  const stored = await readPhaseRepairJournal(f.root, f.binding); assert.equal(stored.events.length, 1);
  const directory = await phaseRepairJournalDirectory(f.root, f.binding); assert.match(directory, /\.git/);
  assert.equal((await readdir(f.root)).some(file => file.includes('phase-repair')), false);
  const other = await phaseRepairLoopSummary(f.root, { ...f.workflow, workItem: { ...f.workflow.workItem, id: 'LOOP-2' } }, f.phase);
  assert.equal(other.consumed, 0);
});
test('new CLI operations are registered, closed and model-free', () => {
  for (const [action, classification] of [['repair-plan', 'read'], ['repair-status', 'read'], ['repair-run', 'mutation'], ['repair-resume', 'mutation']]) {
    const value = resolveOperation({ requestedCommand: 'appeal', positionals: ['appeal', action] });
    assert.equal(value.id, `appeal.${action}`); assert.equal(value.modelPolicy, 'never'); assert.equal(value.classification, classification);
  }
});

test('cosmetic edits and moved lines do not obtain a new repair condition', () => {
  const findings = [{ code: 'artifact.placeholder.unresolved', category: 'authoring', path: 'plan.md',
    line: 4, value: 'TODO', fingerprint: repairDigest('first artifact') }];
  const original = phaseRepairConditionHash({ ready: false, findings });
  const padded = structuredClone(findings); padded[0].line = 99; padded[0].fingerprint = repairDigest('padded artifact');
  assert.equal(phaseRepairConditionHash({ ready: false, findings: padded }), original);
  assert.notEqual(phaseRepairConditionHash({ ready: false, findings: [...padded, { ...padded[0], value: 'TBD' }] }), original);
  assert.notEqual(phaseRepairConditionHash({ ready: true, findings: [] }), original);
});

test('a changed producer closes the old reservation and unknown finding categories stay with the owner', async t => {
  const f = await fixture(t); await reserve(f);
  const changedOwner = { inspect: async () => ({ ...f.observation(), inspection: {
    ...f.observation().inspection, ownership: { proven: true, agent: 'different-producer' }
  } }) };
  assert.equal((await f.call('resume', null, changedOwner)).result, 'binding-changed');
  const unknown = await f.call('plan', null, { inspect: async () => ({ ...f.observation(),
    findings: [{ code: 'unknown-new-finding', category: 'not-registered' }] }) });
  assert.equal(unknown.action, null); assert.equal(unknown.admission.reason, 'human-or-owner-route');
});

test('Story authoring skills consume one returned persistent repair protocol', async () => {
  for (const name of ['sflow-code', 'sflow-phase', 'sflow-specify', 'sflow-plan', 'sflow-design',
    'sflow-requirements', 'sflow-release', 'sflow-review', 'sflow-verify', 'sflow-document-intake',
    'sflow-scenario-check', 'sflow-converge', 'sflow-workflow-rules']) {
    const text = await readFile(new URL(`../plugin/skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(text, /returned `repairLoop.protocol`/u, name);
  }
  const converge = await readFile(new URL('../plugin/skills/sflow-converge/SKILL.md', import.meta.url), 'utf8');
  assert.match(converge, /never loop preparation/u);
});

test('publication skills require a returned publish command and stop when only a next transition remains', async () => {
  for (const name of ['sflow-code', 'sflow-phase', 'sflow-specify', 'sflow-plan', 'sflow-design',
    'sflow-requirements', 'sflow-release', 'sflow-review', 'sflow-verify', 'sflow-scenario-check',
    'sflow-converge', 'sflow-workflow-rules', 'sflow-document-intake']) {
    const text = await readFile(new URL(`../plugin/skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(text, /`commands.publish`/u, name);
    assert.match(text, /absent: relay `commands.next`, stop/iu, name);
  }
});

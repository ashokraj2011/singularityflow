import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig, publishGeneration, scanArtifacts } from '../src/state.mjs';

const ACTOR = { name: 'Template Author', email: 'author@example.invalid', login: null };

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

async function fixture(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `sflow-publication-preflight-${name}-`));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', ACTOR.name);
  git(root, 'config', 'user.email', ACTOR.email);
  await writeFile(path.join(root, 'README.md'), '# Publication preflight\n');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize repository');
  git(root, 'switch', '-c', 'PREFLIGHT-1');

  const config = await loadConfig(root);
  config.git.publish = 'off';
  const resolved = resolveWorkType(config, 'feature');
  resolved.phases = [{
    ...resolved.phases[0],
    order: 0,
    clarification: { ...resolved.phases[0].clarification, mode: 'off' },
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['intake'] }
  }];
  await setAgentSession(root, config, ACTOR, 'product-owner', 'PREFLIGHT-1', { phaseId: 'intake', source: 'test' });
  const workflow = await createWorkflow(root, config, {
    id: 'PREFLIGHT-1',
    title: 'Refuse an untouched template before publication mutation',
    source: {
      type: 'manual', key: 'PREFLIGHT-1', title: 'Refuse an untouched template before publication mutation',
      description: 'Keep template instructions out of governed generations.',
      acceptanceCriteria: ['Publication refuses an untouched prepared artifact.']
    },
    baseBranch: 'main',
    workType: 'feature',
    agent: 'product-owner',
    resolved
  });
  const phase = workflow.phases.intake;
  const target = path.join(root, 'singularity', 'work-items', 'PREFLIGHT-1', phase.requiredArtifact.path);
  const statePath = path.join(root, 'singularity', 'work-items', 'PREFLIGHT-1', 'workflow.json');
  return { root, config, workflow, phase, target, statePath };
}

function inContext(root, run) {
  return withOperationContext({
    operation: { id: 'test.publication-preflight', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' },
    root,
    command: 'test'
  }, run);
}

const AUTHORSHIP = buildGenerationAuthorship({
  options: normalizeAuthorshipOptions({ producer: 'human', channel: 'manual-in-place', externalAiUse: 'none' }),
  actor: ACTOR,
  governedAgentContext: 'product-owner',
  source: null
});

test('an untouched prepared template is refused before publication mutates phase state', async () => {
  const { root, config, workflow, phase, target, statePath } = await fixture('placeholder');
  await inContext(root, async () => {
    assert.match(await readFile(target, 'utf8'), /TODO/);
    const phaseBefore = JSON.stringify(phase);
    const stateBefore = await readFile(statePath, 'utf8');
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      await assert.rejects(
        () => publishGeneration(root, config, workflow, { phaseId: 'intake', authorship: AUTHORSHIP }),
        /contains unresolved placeholder 'TODO' at line \d+[\s\S]*Complete .*intake\.md, remove every placeholder/
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(JSON.stringify(phase), phaseBefore, 'the refused template advanced or annotated the phase');
    assert.equal(await readFile(statePath, 'utf8'), stateBefore, 'the refused template rewrote durable Story state');
    assert.deepEqual(warnings, [], 'an expected prepared artifact was reported as accidental adoption');
  });
});

test('the required artifact is expected while unrelated untracked files still warn', async () => {
  const { root, config, workflow, phase, target } = await fixture('adoption');
  await inContext(root, async () => {
    await writeFile(target, [
      '# Intake', '',
      '## Requested outcome', '',
      'Publish only fully authored phase evidence and keep accidental files visible to the contributor.', '',
      '## Scope and constraints', '',
      'The publication preflight reads the required artifact before changing generation state. The artifact scan still registers this declared file as governed evidence.', '',
      '## Evidence', '',
      'The regression test proves both the expected-file path and the unrelated-file warning path.', ''
    ].join('\n'));
    const firstWarnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => firstWarnings.push(String(message));
    try { await scanArtifacts(root, config, workflow, 'intake'); }
    finally { console.warn = originalWarn; }
    assert.deepEqual(firstWarnings, [], 'the declared required artifact was reported as accidental adoption');
    assert.ok(phase.artifacts.some((artifact) => artifact.path.endsWith('/artifacts/intake/intake.md')));

    await writeFile(path.join(root, 'unexpected-source.js'), 'export const unexpected = true;\n');
    const secondWarnings = [];
    console.warn = (message) => secondWarnings.push(String(message));
    try { await scanArtifacts(root, config, workflow, 'intake'); }
    finally { console.warn = originalWarn; }
    assert.ok(secondWarnings.some((message) => message.includes('unexpected-source.js')),
      `the unrelated file was not disclosed: ${JSON.stringify(secondWarnings)}`);
    assert.ok(secondWarnings.every((message) => !message.includes('/artifacts/intake/intake.md')),
      `the required artifact reappeared in the adoption warning: ${JSON.stringify(secondWarnings)}`);
  });
});

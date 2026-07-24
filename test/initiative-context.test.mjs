import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { composeInitiativeContext, verifyInitiativeContext } from '../src/initiative-context.mjs';
import { approveInitiative, publishInitiativePhase } from '../src/initiative-evidence.mjs';
import { createInitiative, loadInitiative, prepareInitiativePhase } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

async function binaryInputRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-initiative-context-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Initiative context\n');
  await initializeDefinition(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.worldModel.grounding = 'off';
  await writeFile(workflowFile, YAML.stringify(workflow));
  const file = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(file, 'utf8'));
  portfolio.approvalAuthorities.owners = {
    members: [{ name: 'Initiative Owner', email: 'owner@example.com' }]
  };
  portfolio.initiativePhases['binary-source'] = {
    label: 'Binary source',
    outputs: [{
      id: 'research-bundle',
      kind: 'binary-bundle',
      path: 'research.zip',
      approval: { mode: 'none' }
    }],
    bundleApproval: { authorities: ['owners'] }
  };
  portfolio.initiativePhases['binary-consumer'] = {
    label: 'Binary consumer',
    outputs: [{
      id: 'summary',
      kind: 'markdown',
      path: 'summary.md',
      template: 'initiative-context/summary.md',
      consumes: ['binary-source/research-bundle'],
      approval: { mode: 'none' }
    }],
    bundleApproval: { authorities: ['owners'] }
  };
  portfolio.initiativeProfiles['binary-context'] = {
    label: 'Binary context',
    phases: ['binary-source', 'binary-consumer']
  };
  await writeFile(file, YAML.stringify(portfolio));
  const template = path.join(root, portfolio.templatesRoot, 'initiative-context/summary.md');
  await mkdir(path.dirname(template), { recursive: true });
  await writeFile(template, '# Summary\n\n{{inputs}}\n\n{{metadata}}\n');
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize binary context profile'], { cwd: root });
  run('git', ['switch', '-c', 'INIT-BINARY-CONTEXT'], { cwd: root });
  await createInitiative(root, {
    id: 'INIT-BINARY-CONTEXT',
    title: 'Binary context safety',
    profile: 'binary-context',
    persona: 'developer'
  });
  return root;
}

test('initiative prompt records binary inputs by hash without embedding their bytes', async () => {
  const root = await binaryInputRepository();
  await prepareInitiativePhase(root, 'INIT-BINARY-CONTEXT', 'binary-source', { persona: 'developer' });
  const binary = path.join(
    root,
    'singularity/initiatives/INIT-BINARY-CONTEXT/artifacts/binary-source/research.zip'
  );
  const bytes = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]),
    Buffer.from('MUST_NOT_BE_INLINED')
  ]);
  await writeFile(binary, bytes);
  await prepareInitiativePhase(root, 'INIT-BINARY-CONTEXT', 'binary-source', { persona: 'developer' });
  await publishInitiativePhase(root, 'INIT-BINARY-CONTEXT', 'binary-source', { persona: 'developer' });
  await approveInitiative(root, {
    initiativeId: 'INIT-BINARY-CONTEXT',
    phaseId: 'binary-source',
    subject: 'phase',
    persona: 'developer'
  });

  const composed = await composeInitiativeContext(
    root,
    'INIT-BINARY-CONTEXT',
    'binary-consumer',
    { persona: 'developer' }
  );
  assert.equal(composed.record.inputs.length, 1);
  assert.deepEqual(
    {
      reference: composed.record.inputs[0].reference,
      kind: composed.record.inputs[0].kind,
      embedded: composed.record.inputs[0].embedded,
      bytes: composed.record.inputs[0].bytes
    },
    {
      reference: 'binary-source/research-bundle',
      kind: 'binary-bundle',
      embedded: false,
      bytes: bytes.length
    }
  );
  assert.match(composed.rendered, /Binary bundle is not embedded in the prompt/);
  assert.doesNotMatch(composed.rendered, /MUST_NOT_BE_INLINED/);

  const loaded = await loadInitiative(root, 'INIT-BINARY-CONTEXT');
  const verification = await verifyInitiativeContext(
    root,
    loaded.portfolio,
    loaded.initiative,
    'binary-consumer'
  );
  assert.equal(verification.valid, true);
});

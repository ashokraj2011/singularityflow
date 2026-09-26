import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { catalogArtifactSet, normalizeArtifactSet } from '../src/artifact-sets.mjs';
import { inspectSkillOutputSet } from '../src/skp-phase-evidence.mjs';
import { snapshot } from '../src/util.mjs';

async function fixture({ multiple = false, optional = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-output-'));
  const workId = 'SKP-1';
  const item = `singularity/work-items/${workId}`;
  const first = 'artifacts/threat-model/report.md';
  const second = 'artifacts/threat-model/risks.md';
  const output = (id, file, required = true) => ({
    id, path: file, kind: 'custom:threat-model', mediaType: 'text/markdown',
    encoding: 'utf-8', minimumBytes: 8, maximumBytes: 1000, required
  });
  const outputs = [output('report', first), ...(multiple ? [output('risks', second, !optional)] : [])];
  const phase = {
    id: 'threat-model', generation: 1,
    requiredArtifact: { path: first, kind: 'custom:threat-model' },
    artifacts: []
  };
  const set = multiple ? normalizeArtifactSet({
    primary: 'report.md',
    members: [
      { path: 'report.md', role: 'report', required: true, authority: 'governed' },
      { path: 'risks.md', role: 'risk-register', required: !optional, authority: 'governed' }
    ]
  }, 'threat-set') : null;
  const workflow = {
    workItem: { id: workId },
    resolution: {
      workItemRoot: 'singularity/work-items',
      phases: [{ id: phase.id, artifactSet: set?.id ?? null }],
      artifactSets: set ? { [set.id]: set } : {}
    }
  };
  const definition = { workItemRoot: 'singularity/work-items' };
  const binding = { phaseId: phase.id, bindingRefs: { outputs } };
  const writeOutput = async (relative, content = '# Threat model\n\nA real risk.\n') => {
    const absolute = path.join(root, item, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    const info = await snapshot(absolute);
    phase.artifacts.push({ path: `${item}/${relative}`, kind: 'custom:threat-model', status: 'pending', ...info });
  };
  await writeOutput(first);
  if (multiple && !optional) await writeOutput(second, '# Risks\n\nOne concrete risk.\n');
  const catalog = async () => {
    if (set) phase.artifactSet = {
      ...await catalogArtifactSet(root, item, phase, set), generation: phase.generation
    };
  };
  await catalog();
  return { root, item, definition, workflow, phase, binding, first, second, writeOutput, catalog };
}

test('SKP output evidence names exact IDs and current registered bytes', async () => {
  const value = await fixture();
  const evidence = await inspectSkillOutputSet(value.root, value.definition,
    value.workflow, value.phase, value.binding);
  assert.equal(evidence.outputs.length, 1);
  assert.equal(evidence.outputs[0].id, 'report');
  assert.equal(evidence.outputs[0].path, `${value.item}/${value.first}`);
  assert.match(evidence.outputSetSha256, /^sha256:[a-f0-9]{64}$/);

  value.phase.artifacts[0].sha256 = '0'.repeat(64);
  await assert.rejects(inspectSkillOutputSet(value.root, value.definition,
    value.workflow, value.phase, value.binding), { code: 'SKP_OUTPUT_UNREGISTERED' });
  value.phase.artifacts[0].sha256 = evidence.outputs[0].sha256;
  value.phase.artifacts[0].kind = 'markdown';
  await assert.rejects(inspectSkillOutputSet(value.root, value.definition,
    value.workflow, value.phase, value.binding), { code: 'SKP_OUTPUT_UNREGISTERED' });
});

test('required second output and atomic set membership cannot be replaced by primary', async () => {
  const value = await fixture({ multiple: true });
  const accepted = await inspectSkillOutputSet(value.root, value.definition,
    value.workflow, value.phase, value.binding);
  assert.equal(accepted.outputs.length, 2);
  assert.equal(accepted.bundleSha256, value.phase.artifactSet.bundleSha256);

  value.phase.artifactSet.members[1].sha256 = '0'.repeat(64);
  await assert.rejects(inspectSkillOutputSet(value.root, value.definition,
    value.workflow, value.phase, value.binding), { code: 'SKP_ARTIFACT_SET_INVALID' });
});

test('missing required output, undeclared output, and symlink substitution fail closed', async () => {
  const missing = await fixture({ multiple: true, optional: true });
  missing.binding.bindingRefs.outputs[1].required = true;
  await assert.rejects(inspectSkillOutputSet(missing.root, missing.definition,
    missing.workflow, missing.phase, missing.binding), { code: 'SKP_OUTPUT_MISSING' });

  const extra = await fixture();
  extra.phase.artifacts.push({ path: `${extra.item}/artifacts/threat-model/unknown.md` });
  await assert.rejects(inspectSkillOutputSet(extra.root, extra.definition,
    extra.workflow, extra.phase, extra.binding), { code: 'SKP_OUTPUT_UNDECLARED' });

  const linked = await fixture({ multiple: true, optional: true });
  const absolute = path.join(linked.root, linked.item, linked.second);
  await symlink(path.join(linked.root, linked.item, linked.first), absolute);
  await assert.rejects(inspectSkillOutputSet(linked.root, linked.definition,
    linked.workflow, linked.phase, linked.binding), { code: 'REPOSITORY_PATH_UNSAFE' });
});

test('an optional output is recorded absent under its exact ID', async () => {
  const value = await fixture({ multiple: true, optional: true });
  const evidence = await inspectSkillOutputSet(value.root, value.definition,
    value.workflow, value.phase, value.binding);
  assert.deepEqual(evidence.outputs[1], {
    id: 'risks', path: `${value.item}/${value.second}`, required: false,
    exists: false, sha256: null, bytes: null
  });
});

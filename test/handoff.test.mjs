import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(cwd, ...args) {
  return run(process.execPath, [bin, ...args], cwd);
}

function identity(root, name) {
  run('git', ['config', 'user.name', name], root);
  run('git', ['config', 'user.email', `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`], root);
}

const requirements = `# HAND-101 — Requirements\n\n## Problem\n\nA second contributor must be able to recover the exact branch and durable SDLC state using only the shared work ID. The handoff must use normal Git fetch and fast-forward behavior without depending on the first contributor's Copilot conversation.\n\n## Scope\n\nThe workflow creates an exact branch, records complete requirements, approves them, pushes the branch, and allows a fresh clone to resume. A later remote commit must be fast-forwarded by another resume operation.\n\n## Acceptance criteria\n\n- The branch is HAND-101.\n- A fresh clone can run resume with fetch.\n- The workflow opens in the design phase.\n- A subsequent remote commit arrives through fast-forward-only pull.\n\n## Assumptions and risk\n\nGit and Node.js are installed. The test uses only local temporary repositories and no network service.\n`;

test('another clone resumes by work ID and fast-forwards tracked state', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-handoff-'));
  const remote = path.join(base, 'remote.git');
  const first = path.join(base, 'first');
  const second = path.join(base, 'second');

  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', first], base);
  identity(first, 'First Contributor');
  await writeFile(path.join(first, 'README.md'), '# Handoff test\n');
  run('git', ['add', 'README.md'], first);
  run('git', ['commit', '-m', 'initial'], first);
  run('git', ['remote', 'add', 'origin', remote], first);
  run('git', ['push', '-u', 'origin', 'main'], first);
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  flow(first, 'start', 'HAND-101', '--title', 'Handoff test');
  const requirementPath = path.join(first, '.sdlc', 'work-items', 'HAND-101', 'artifacts', 'requirements', 'requirements.md');
  await writeFile(requirementPath, requirements);
  flow(first, 'artifact', 'scan');
  flow(first, 'submit');
  flow(first, 'approve', '--yes', '--commit');
  run('git', ['push', '-u', 'origin', 'HAND-101'], first);

  run('git', ['clone', remote, second], base);
  identity(second, 'Second Contributor');
  flow(second, 'resume', 'HAND-101', '--fetch');
  assert.equal(run('git', ['branch', '--show-current'], second).stdout.trim(), 'HAND-101');
  const workflow = JSON.parse(await readFile(path.join(second, '.sdlc', 'work-items', 'HAND-101', 'workflow.json'), 'utf8'));
  assert.equal(workflow.currentPhase, 'design');

  await writeFile(path.join(first, 'handoff-note.txt'), 'Remote handoff update\n');
  run('git', ['add', 'handoff-note.txt'], first);
  run('git', ['commit', '-m', 'HAND-101 add handoff note'], first);
  run('git', ['push'], first);

  flow(second, 'resume', 'HAND-101', '--fetch');
  assert.equal(await readFile(path.join(second, 'handoff-note.txt'), 'utf8'), 'Remote handoff update\n');
  assert.equal(run('git', ['status', '--porcelain'], second).stdout.trim(), '');
});

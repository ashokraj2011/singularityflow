import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const machineState = mkdtempSync(path.join(os.tmpdir(), 'sflow-poc-release-gate-'));
const environment = {
  ...process.env,
  NODE_ENV: 'test',
  SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machineState, 'workspaces.json'),
  SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machineState, 'active-workspace.json'),
  SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machineState, 'leads.json')
};
delete environment.FORCE_COLOR;
delete environment.SINGULARITY_FLOW_COLOR;

const stages = [
  {
    label: 'VS Code type contract',
    command: npm,
    args: ['run', 'vscode:typecheck']
  },
  {
    label: 'Packaged VS Code extension',
    command: npm,
    args: ['run', 'vscode:package']
  },
  {
    label: 'POC workflow, hardening, and MCP policy',
    command: process.execPath,
    args: ['--test', 'test/poc-workflow.test.mjs', 'test/poc-hardening.test.mjs', 'test/mcp.test.mjs']
  },
  {
    label: 'Packaged POC release-candidate journey',
    command: process.execPath,
    args: [
      '--test',
      '--test-name-pattern=the packaged POC release candidate journey',
      'test/vscode-host.test.mjs'
    ]
  },
  {
    label: 'npm package inventory',
    command: npm,
    args: ['pack', '--dry-run']
  }
];

let failed = null;
try {
  for (const [index, stage] of stages.entries()) {
    process.stdout.write(`\n[POC ${index + 1}/${stages.length}] ${stage.label}\n`);
    const started = Date.now();
    const result = spawnSync(stage.command, stage.args, {
      cwd: root,
      env: environment,
      stdio: 'inherit'
    });
    if (result.error || result.status !== 0) {
      failed = { stage: stage.label, error: result.error, status: result.status };
      break;
    }
    process.stdout.write(`[POC] passed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  }
} finally {
  rmSync(machineState, { recursive: true, force: true });
}

if (failed) {
  const detail = failed.error?.message ?? `exit ${failed.status ?? 'unknown'}`;
  console.error(`\nPOC release gate failed at "${failed.stage}" (${detail}).`);
  process.exitCode = failed.status || 1;
} else {
  console.log('\nPOC release gate passed. The packaged extension completed the governed POC lifecycle through both required publication authorities; source boundaries, large-output checks, MCP policy, and package inventory also passed.');
}

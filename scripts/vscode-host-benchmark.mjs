#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildHostPerformanceReport } from '../src/vscode-host-performance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const profile = option('profile') ?? 'current';
const samples = Number(option('samples') ?? 3);
const enforce = process.argv.includes('--enforce');
const json = process.argv.includes('--json');
const keep = process.argv.includes('--keep');
const outputPath = option('out');
const timeoutMs = Number(option('timeout-ms') ?? 180_000);
const extensionRoot = path.join(root, 'apps', 'vscode');
const testRunner = path.join(extensionRoot, 'test', 'host-performance-runner.cjs');
const budgets = JSON.parse(await readFile(path.join(root, 'benchmarks', 'dx', 'vscode-host-budgets.json'), 'utf8'));

if (!['minimum', 'current'].includes(profile)) throw new Error('--profile must be minimum or current.');
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100) throw new Error('--samples must be an integer from 1 through 100.');
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 600_000) {
  throw new Error('--timeout-ms must be an integer from 30000 through 600000.');
}

function resolveCode() {
  const explicit = option('vscode');
  const candidates = [
    explicit,
    process.env.VSCODE_CLI_PATH,
    process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' : null,
    process.platform === 'win32' ? 'code.cmd' : 'code'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !existsSync(candidate)) continue;
    try {
      const output = execFileSync(candidate, ['--version'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, windowsHide: true
      });
      const version = output.trim().split(/\r?\n/)[0];
      if (/^\d+\.\d+\.\d+/.test(version)) {
        let hostExecutable = candidate;
        if (process.platform === 'darwin' && path.isAbsolute(candidate)) {
          const application = candidate.match(/^(.*\.app)\/Contents\/Resources\/app\/bin\/code$/)?.[1];
          if (application) hostExecutable = path.join(application, 'Contents', 'MacOS', 'Code');
        } else if (process.platform === 'win32' && path.isAbsolute(candidate) && /\.cmd$/i.test(candidate)) {
          const desktop = path.resolve(path.dirname(candidate), '..', 'Code.exe');
          if (existsSync(desktop)) hostExecutable = desktop;
        }
        return { executable: candidate, hostExecutable, version };
      }
    } catch { /* try the next explicit, platform, or PATH candidate */ }
  }
  throw new Error('A real VS Code CLI was not found. Pass --vscode=/absolute/path/to/code (or code.cmd on Windows).');
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function createFixture(parent) {
  const repository = path.join(parent, 'repository');
  await mkdir(path.join(repository, 'src'), { recursive: true });
  git(repository, ['init', '-q', '-b', 'main']);
  git(repository, ['config', 'user.name', 'SFlow Host Benchmark']);
  git(repository, ['config', 'user.email', 'host-benchmark@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), '# Extension-host benchmark fixture\n', 'utf8');
  await writeFile(path.join(repository, 'src', 'index.txt'), 'fixture\n', 'utf8');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-q', '-m', 'Fixture application']);
  git(repository, ['switch', '-q', '-c', 'sflow/config']);
  await mkdir(path.join(repository, 'singularity', 'templates', 'chore'), { recursive: true });
  await writeFile(path.join(repository, 'singularity', 'templates', 'chore', 'intake.md'),
    '# Intake\n\nDescribe the bounded work.\n', 'utf8');
  await writeFile(path.join(repository, 'singularity', 'workflow.yml'), [
    'version: 2',
    'defaultBaseBranch: main',
    'workItemRoot: singularity/work-items',
    'templatesRoot: singularity/templates',
    'worldModel:',
    '  views: [business, architecture, development, testing, release, operations, security]',
    '  outputDir: singularity/world-model',
    'phases:',
    '  intake:',
    '    id: intake',
    '    label: Intake',
    '    writeScope: artifact-only',
    '    defaultTemplate: chore/intake.md',
    '    artifact:',
    '      path: artifacts/intake/intake.md',
    'workTypes:',
    '  chore:',
    '    label: Chore',
    '    phases: [intake]',
    ''
  ].join('\n'), 'utf8');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-q', '-m', 'Approved benchmark configuration']);
  git(repository, ['switch', '-q', 'main']);
  return repository;
}

function terminate(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'taskkill.exe');
      execFileSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

function launch(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const collect = (target, chunk) => {
      bytes += chunk.length;
      if (bytes <= 1_048_576) target.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminate(child);
      reject(new Error(`VS Code extension-host sample exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`VS Code extension-host sample exited ${code}: ${Buffer.concat(stderr).toString('utf8').trim().slice(-2000) || Buffer.concat(stdout).toString('utf8').trim().slice(-2000)}`));
    });
  });
}

async function runScenario(editor, repository, stateRoot, scenario, reportPath) {
  // Electron derives a Unix-domain socket beneath user-data. macOS rejects socket paths over 103
  // bytes, so these internal directory names are intentionally short even when TMPDIR is long.
  const userData = path.join(stateRoot, 'u');
  const extensions = path.join(stateRoot, 'e');
  const userSettings = path.join(userData, 'User');
  await Promise.all([mkdir(userSettings, { recursive: true }), mkdir(extensions, { recursive: true })]);
  // Pin the source-tree CLI for this development-extension run. A concurrent VSIX build stages and
  // removes `<extension>/cli`; without an explicit setting the cold and warm processes can resolve
  // different engines, and the warm timing can become a measurement of fast MODULE_NOT_FOUND errors.
  await writeFile(path.join(userSettings, 'settings.json'), `${JSON.stringify({
    'singularityFlow.cliPath': path.join(root, 'bin', 'singularity-flow.mjs')
  }, null, 2)}\n`, 'utf8');
  const machine = path.join(stateRoot, 'm');
  await mkdir(machine, { recursive: true });
  const env = {
    ...process.env,
    SINGULARITY_FLOW_VSCODE_HOST_BENCHMARK: '1',
    SINGULARITY_FLOW_VSCODE_HOST_SCENARIO: scenario,
    SINGULARITY_FLOW_VSCODE_HOST_REPORT: reportPath,
    SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_NO_NETWORK: '1',
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'leads.json'),
    SINGULARITY_FLOW_HOME: path.join(machine, 'home'),
    SINGULARITY_FLOW_TEST_IDENTITY: 'SFlow Host Benchmark'
  };
  delete env.ELECTRON_RUN_AS_NODE;
  await launch(editor.hostExecutable, [
    repository,
    `--extensionDevelopmentPath=${extensionRoot}`,
    `--extensionTestsPath=${testRunner}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensions}`,
    '--disable-workspace-trust', '--disable-updates',
    '--skip-welcome', '--skip-release-notes', '--new-window'
  ], env);
  return JSON.parse(await readFile(reportPath, 'utf8'));
}

async function main() {
  const editor = resolveCode();
  execFileSync(process.execPath, [path.join(extensionRoot, 'esbuild.mjs')], {
    cwd: extensionRoot, stdio: json ? 'ignore' : 'inherit', timeout: 120_000
  });
  const shortTemporaryRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const working = await mkdtemp(path.join(shortTemporaryRoot, 'sfvh-'));
  const pairs = [];
  try {
    for (let index = 0; index < samples; index += 1) {
      const pairRoot = path.join(working, `p${index + 1}`);
      await mkdir(pairRoot, { recursive: true });
      const repository = await createFixture(pairRoot);
      const stateRoot = path.join(pairRoot, 'h');
      const coldPath = path.join(pairRoot, 'c.json');
      const warmPath = path.join(pairRoot, 'w.json');
      if (!json) process.stderr.write(`VS Code ${profile} sample ${index + 1}/${samples}: cold\n`);
      const cold = await runScenario(editor, repository, stateRoot, 'cold', coldPath);
      // Restore the exact application revision while retaining the VS Code workspace-state cache.
      git(repository, ['reset', '--hard', '-q', 'HEAD']);
      git(repository, ['clean', '-fdq']);
      if (!json) process.stderr.write(`VS Code ${profile} sample ${index + 1}/${samples}: warm\n`);
      const warm = await runScenario(editor, repository, stateRoot, 'warm', warmPath);
      pairs.push({ cold, warm });
    }
    const report = buildHostPerformanceReport({
      profile, pairs, budgets, enforce, platform: process.platform
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) await writeFile(path.resolve(outputPath), serialized, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(json ? `${JSON.stringify(report)}\n` : serialized);
    if (report.status === 'failed') process.exitCode = 1;
  } finally {
    if (!keep) await rm(working, { recursive: true, force: true });
    else if (!json) process.stderr.write(`Retained benchmark fixture: ${working}\n`);
  }
}

await main();

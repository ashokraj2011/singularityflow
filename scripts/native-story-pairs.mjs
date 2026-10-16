#!/usr/bin/env node
/** Explicitly invoked, quota-consuming native CLI qualification. Never approves or installs. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performanceFixture } from '../test/helpers/performance-v2-fixture.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const [action, directory, baselineDirectory] = process.argv.slice(2);
if (!['prepare', 'run-next', 'retry-pre-provider', 'analyze', 'stop'].includes(action) || !directory || !path.isAbsolute(directory)) {
  throw new Error('Use prepare ABSOLUTE-OUTPUT ABSOLUTE-BASELINE, run-next ABSOLUTE-OUTPUT, analyze ABSOLUTE-OUTPUT or stop ABSOLUTE-OUTPUT. Provider runs require explicit human quota authorization.');
}
const manifestPath = path.join(directory, 'native-pairs.json');
if (action === 'prepare') {
  if (!baselineDirectory || !path.isAbsolute(baselineDirectory)) throw new Error('An exact baseline source clone is required.');
  const model = process.env.SFLOW_QUALIFICATION_MODEL;
  if (!model || !/^[a-zA-Z0-9._-]+$/u.test(model)) throw new Error('Pin SFLOW_QUALIFICATION_MODEL to a supported Copilot model.');
  await mkdir(directory, { recursive: true });
  const pairs = [];
  // Alternating order across pairs; six independent repositories, sessions and local remotes.
  for (let pair = 1; pair <= 3; pair++) for (const mode of pair % 2 ? ['before', 'after'] : ['after', 'before']) {
    const source = mode === 'before' ? baselineDirectory : repository;
    const base = path.join(directory, `${mode}-${pair}`);
    const fixture = await performanceFixture(base, path.join(source, 'bin/singularity-flow.mjs'), { workId: `NATIVE-${pair}`, native: true });
    const bin = path.join(base, 'bin');
    await mkdir(bin); await symlink(path.join(source, 'bin/singularity-flow.mjs'), path.join(bin, 'singularity-flow'));
    const skill = await readFile(path.join(source, 'plugin/skills/sflow-phase/SKILL.md'), 'utf8');
    const request = [
      'Run the following governed authoring skill for the active disposable qualification Story.',
      'Use singularity-flow from PATH. Author and publish the current intake only, following its packet.',
      'The full human request is: return 2 from src/value.mjs instead of 1; prove it in test/value.test.mjs.',
      'Keep the export name and numeric type unchanged. No extra files, interfaces or behavior are needed.',
      'Do not submit, review, approve, change policy, run git, install dependencies or launch any other model.',
      'If an actual human decision is required, report the exact question and stop. Never invent a reply.',
      'Do not explore outside this repository. Report a short final summary and the exact returned next action.', '', skill
    ].join('\n');
    const prompt = path.join(base, 'request.md');
    await writeFile(prompt, request, { mode: 0o600 });
    pairs.push({ pair, mode, root: fixture.root, base, bin, prompt,
      env: Object.fromEntries(Object.entries(fixture.env).filter(([key]) => key.startsWith('SINGULARITY_FLOW_'))), status: 'prepared' });
  }
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, host: 'copilot-cli', model, pairs,
    completeStories: false, humanApprovals: 'not-authorized-by-this-runner',
    limitations: ['Not VS Code native plugin qualification.', 'No approval or self-approval is automated.'] }, null, 2), { mode: 0o600 });
  console.log(`Prepared ${pairs.length} independent native runs; no provider was called.`);
} else if (action === 'stop') {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.stoppedByUser = true;
  manifest.stoppedAt = 'intake';
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log('Native runs stopped at Intake. No provider or lifecycle operation was invoked.');
} else if (action === 'analyze') {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const runs = [];
  for (const row of manifest.pairs) {
    const events = (await readFile(path.join(row.base, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    const usage = JSON.parse(await readFile(path.join(row.base, 'usage.json'), 'utf8'));
    const workflow = JSON.parse(await readFile(path.join(row.root, 'singularity/work-items', `NATIVE-${row.pair}`, 'workflow.json'), 'utf8'));
    const phase = workflow.phases.intake;
    const toolCalls = {};
    for (const event of events.filter(event => event.type === 'tool.execution_start')) {
      const name = event.data.toolName;
      toolCalls[name] = (toolCalls[name] ?? 0) + 1;
    }
    runs.push({ pair: row.pair, mode: row.mode, exitCode: row.exitCode, wallClockMs: row.elapsedMs,
      apiDurationMs: usage.totalApiDurationMs ?? null, aiCredits: Number.isFinite(usage.totalNanoAiu) ? usage.totalNanoAiu / 1e9 : null,
      tokens: usage.modelMetrics?.[manifest.model]?.usage ?? null, toolCalls,
      publicationObserved: phase.generation === 1 && phase.authorship?.at(-1)?.producer === 'governed-agent'
        && phase.authorship?.at(-1)?.channel === 'copilot-host',
      phaseStatus: phase.status, approvals: phase.approvals?.length ?? null, storyStatus: workflow.status });
  }
  const report = { schemaVersion: 1, resultType: 'sflow-native-cli-intake-pairs', host: manifest.host, model: manifest.model,
    platform: process.platform, pairCount: 3, completeStoryQualification: false, policyChanged: false,
    humanApprovalsAutomated: false, stoppedByUser: manifest.stoppedByUser === true,
    stoppedAt: manifest.stoppedAt ?? null, runs,
    limitations: ['Only Intake authoring/publication reached; not complete Stories or VS Code plugin qualification.',
      'Small fixture and three pairs do not establish causal speedup, p95 or billed savings.',
      'Publication observations are from retained local workflow records; they do not replace fresh gate checks.',
      'SFlow-owned kernel model calls remain zero; usage here is exported from the actual native CLI provider.'] };
  await writeFile(path.join(directory, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
} else if (action === 'retry-pre-provider') {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const row = manifest.pairs.find(pair => pair.status === 'failed');
  const events = row ? (await readFile(path.join(row.base, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  if (!row || !/^(?:error: Invalid value for --max-ai-credits:|--attachment file type not supported|Error: Model .+ from --model flag is not available\.)/u.test(await readFile(path.join(row.base, 'stderr.txt'), 'utf8'))
      || events.some(event => event.type !== 'session.mcp_server_status_changed')) throw new Error('Not a verified pre-provider argument rejection.');
  row.preProviderRejections = [...(row.preProviderRejections ?? []), { exitCode: row.exitCode, elapsedMs: row.elapsedMs,
    startedAt: row.startedAt, completedAt: row.completedAt, events,
    reason: (await readFile(path.join(row.base, 'stderr.txt'), 'utf8')).trim() }];
  row.status = 'prepared';
  if (process.env.SFLOW_QUALIFICATION_MODEL) {
    if (manifest.pairs.some(pair => !['prepared', 'failed'].includes(pair.status))) throw new Error('Cannot change model after a measured provider turn.');
    manifest.model = process.env.SFLOW_QUALIFICATION_MODEL;
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log('Retained the pre-provider rejection; the corrected invocation is prepared, not run.');
} else {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.stoppedByUser) throw new Error('The user stopped native qualification. Fresh human authorization is required before any further provider run.');
  const row = manifest.pairs.find(pair => pair.status === 'prepared');
  if (!row) throw new Error('No unrun pair remains. Failed or human-blocked turns are never retried implicitly.');
  row.status = 'running'; row.startedAt = new Date().toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const stdout = [], stderr = [];
  const args = ['--no-auto-update', '--no-remote', '--no-remote-export', '--no-bash-env', '--no-custom-instructions',
    '--disable-builtin-mcps', '--model', manifest.model, '--reasoning-effort', 'medium', '--context', 'default',
    '--available-tools=bash,view,edit,apply_patch,grep,glob', '--allow-tool=shell(singularity-flow:*)', '--allow-tool=write',
    '--deny-tool=shell(git:*)', '--deny-tool=shell(rm:*)', '--max-ai-credits', '30', '--no-ask-user',
    '--output-format', 'json', '--stream', 'off', '--log-level', 'warning', '--log-dir', path.join(row.base, 'logs'),
    '--usage-output-file', path.join(row.base, 'usage.json'), '--share', path.join(row.base, 'session.md'),
    '-C', row.root, '-p', await readFile(row.prompt, 'utf8')];
  const started = performance.now();
  const environment = { ...process.env, ...row.env, PATH: `${row.bin}${path.delimiter}${process.env.PATH}` };
  delete environment.SINGULARITY_FLOW_AGENT_OUTPUT; // Native hosts use the ordinary bounded packet.
  delete environment.SINGULARITY_FLOW_NO_MODEL; // CLI no-model mode relabels publication as manual authorship.
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn('copilot', args, { env: environment,
      cwd: row.root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0;
    let grace;
    const kill = signal => { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } };
    const stop = () => { kill('SIGTERM'); grace ??= setTimeout(() => kill('SIGKILL'), 1000); };
    const timer = setTimeout(stop, 900_000);
    const collect = target => chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) stop(); else target.push(chunk); };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.on('error', error => { clearTimeout(timer); clearTimeout(grace); reject(error); });
    child.on('close', code => { clearTimeout(timer); clearTimeout(grace); resolve(code); });
  }).catch(error => { stderr.push(Buffer.from(error.message)); return null; });
  row.elapsedMs = performance.now() - started; row.completedAt = new Date().toISOString(); row.exitCode = exitCode;
  row.status = exitCode === 0 ? 'turn-completed-not-approved' : 'failed';
  await writeFile(path.join(row.base, 'events.jsonl'), Buffer.concat(stdout), { mode: 0o600 });
  await writeFile(path.join(row.base, 'stderr.txt'), Buffer.concat(stderr), { mode: 0o600 });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ pair: row.pair, mode: row.mode, status: row.status, exitCode, elapsedMs: row.elapsedMs,
    events: path.join(row.base, 'events.jsonl'), stderr: Buffer.concat(stderr).toString('utf8').slice(-2000) }));
}

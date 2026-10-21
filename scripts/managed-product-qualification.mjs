#!/usr/bin/env node
/** Native installer qualification with real signed packages, isolated user state and fake managers.
 * This proves the packaging/setup protocol, not real IDE activation, a model call or release approval.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installerProcess } from '../runtime/install.mjs';
import { resolveWindowsBatchProcess, resolveWindowsSystemTool } from '../src/platform-process.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow one command qualification ')));
const home = path.join(temporary, 'user'), engine = path.join(home, '.singularity-flow', 'engine');
const distribution = path.join(temporary, 'distribution'), tools = path.join(temporary, 'tools');
await mkdir(home); await mkdir(tools);
const report = { platform: process.platform, architecture: process.arch, status: 'running', cases: [], timings: {} };
const powershell = process.platform === 'win32' ? path.join(path.dirname(resolveWindowsSystemTool(process.env, 'cmd.exe')), 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
const env = { ...process.env, HOME: home, USERPROFILE: home, SHELL: '/bin/zsh', SINGULARITY_FLOW_ENGINE_HOME: engine,
  COPILOT_HOME: path.join(home, '.copilot'), SINGULARITY_FLOW_COPILOT_SKILLS_DIR: path.join(home, '.copilot', 'skills'),
  SFLOW_SETUP_FIXTURE: temporary, SFLOW_SETUP_SOURCE: source, NPM_CONFIG_LOGLEVEL: 'error' };
delete env.SINGULARITY_FLOW_ARTIFACT_PUBLIC_KEY;
delete env.SINGULARITY_FLOW_DISTRIBUTION_SIGNING_KEY;
let registryBaseline;
async function registry(script, payload = {}) {
  return installerProcess(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    capture: true, timeoutMs: 30_000, env: { ...process.env, SFLOW_REGISTRY_FIXTURE: Buffer.from(JSON.stringify(payload)).toString('base64') }
  });
}
try {
  if (powershell) {
    registryBaseline = JSON.parse((await registry(`$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); try { $o=@{}; foreach($n in @('Path','SINGULARITY_FLOW_ENGINE_HOME')) { $v=$k.GetValue($n,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $o[$n]=@{value=$v;kind=$(if($null -ne $v){$k.GetValueKind($n).ToString()}else{'String'})} }; $o | ConvertTo-Json -Depth 5 -Compress } finally { $k.Dispose() }`)).stdout);
  }
  const build = process.platform === 'win32'
    ? { command: powershell, args: ['-NoProfile', '-File', path.join(source, 'build-distribution.ps1'), '--skip-tests', '--out-dir', distribution] }
    : { command: '/bin/bash', args: [path.join(source, 'build-distribution.sh'), '--skip-tests', '--out-dir', distribution] };
  const start = performance.now();
  const built = await installerProcess(build.command, build.args, { cwd: source, env, capture: true, timeoutMs: 1_800_000 });
  report.timings.buildMs = performance.now() - start;
  assert.ok(built.stdout.includes('candidate-not-release-certified'), built.stdout);
  report.cases.push('one source command bootstraps private Node and builds a real signed CLI/VSIX distribution');
  const runtime = (await readdir(path.join(engine, 'runtimes'))).find(name => name.startsWith('node-v26.'));
  const node = path.join(engine, 'runtimes', runtime, ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
  env.SFLOW_SETUP_TEST_NODE = node;
  const fixture = path.join(tools, 'manager.mjs');
  await writeFile(fixture, `
import fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';
const base=process.env.SFLOW_SETUP_FIXTURE, args=process.argv.slice(3), manager=process.argv[2];
const state=path.join(base,'copilot-state.json'), extension=path.join(base,'installed-extension');
if(manager==='code') {
  if(args[0]==='--install-extension') {
    const fail=path.join(base,'fail-ui-once'); if(fs.existsSync(fail)){fs.unlinkSync(fail);console.error('isolated UI interruption');process.exit(17);}
    const inspector=await import(pathToFileURL(path.join(process.env.SFLOW_SETUP_SOURCE,'scripts','install-staged-artifacts.mjs')));
    const info=await inspector.inspectVsixBuildSources(args[1]); fs.mkdirSync(path.join(extension,'cli','src'),{recursive:true});
    fs.writeFileSync(path.join(extension,'version'),info.version);fs.writeFileSync(path.join(extension,'cli','src','build-info.mjs'),info.buildInfoSource);
  } else if(args[0]==='--list-extensions') console.log('singularityflow.singularity-flow-vscode@'+fs.readFileSync(path.join(extension,'version'),'utf8'));
  else if(args[0]==='--locate-extension') console.log(extension);
  else process.exit(2);
} else {
  const installed=fs.existsSync(state)?JSON.parse(fs.readFileSync(state,'utf8')):null;
  if(args[0]==='plugin' && args[1]==='uninstall') {if(installed)fs.unlinkSync(state);}
  else if(args[0]==='plugin' && args[1]==='install') fs.writeFileSync(state,JSON.stringify({root:args[2]}));
  else if(args[0]==='plugin' && args[1]==='list') console.log(args.includes('--json')?JSON.stringify(installed?[{name:'singularity-flow',marketplace:'',enabled:true,version:'0.9.0'}]:[]):installed?'singularity-flow':'');
  else if(args[0]==='skill' && args[1]==='list') {
    const skills=[];const direct=process.env.SINGULARITY_FLOW_COPILOT_SKILLS_DIR;
    if(fs.existsSync(direct))for(const name of fs.readdirSync(direct))skills.push({name,source:'user',path:path.join(direct,name),enabled:true});
    if(installed)for(const name of fs.readdirSync(path.join(installed.root,'skills')))if(name.startsWith('sflow-'))skills.push({name,source:'plugin',path:path.join(installed.root,'skills',name),enabled:true});
    console.log(JSON.stringify(skills));
  } else process.exit(3);
}
`);
  for (const manager of ['code', 'copilot']) {
    const file = path.join(tools, `${manager}${process.platform === 'win32' ? '.cmd' : ''}`);
    await writeFile(file, process.platform === 'win32'
      ? `@echo off\r\n"%SFLOW_SETUP_TEST_NODE%" "%~dp0manager.mjs" ${manager} %*\r\nexit /b %errorlevel%\r\n`
      : `#!/usr/bin/env bash\nexec "$SFLOW_SETUP_TEST_NODE" "$(dirname "$0")/manager.mjs" ${manager} "$@"\n`, { mode: 0o700 });
  }
  // Managers are inert fixtures. No real editor, plugin installation, model or Story is contacted.
  env.PATH = `${tools}${path.delimiter}${process.platform === 'win32' ? path.dirname(resolveWindowsSystemTool(process.env, 'cmd.exe')) : '/usr/bin:/bin'}`;
  env.SINGULARITY_FLOW_CODE_COMMAND = path.join(tools, `code${process.platform === 'win32' ? '.cmd' : ''}`);
  const key = path.join(home, '.singularity-flow', 'distribution-keys', 'artifact-builder-public.pem');
  const setup = args => process.platform === 'win32'
    ? (() => { const launch = resolveWindowsBatchProcess(path.join(distribution, 'setup.cmd'), args, { environment: env }); return { command: launch.executable, args: launch.arguments, options: launch.spawnOptions }; })()
    : { command: '/bin/bash', args: [path.join(distribution, 'setup.sh'), ...args], options: {} };
  await writeFile(path.join(temporary, 'fail-ui-once'), 'fixture');
  const first = setup(['--artifact-key', key]);
  await assert.rejects(installerProcess(first.command, first.args, { ...first.options, env, cwd: temporary, capture: true, timeoutMs: 1_200_000 }), /isolated UI interruption/);
  assert.equal(JSON.parse(await readFile(path.join(engine, 'product-install.json'))).status, 'needs-retry');
  report.cases.push('a real setup interruption preserves a partial receipt rather than claiming success');
  const setupStart = performance.now();
  const installed = await installerProcess(first.command, first.args, { ...first.options, env, cwd: temporary, capture: true, timeoutMs: 1_200_000 });
  report.timings.setupResumeMs = performance.now() - setupStart;
  assert.ok(installed.stdout.includes('COMPLETE AND VERIFIED'), installed.stdout);
  assert.deepEqual(JSON.parse(await readFile(path.join(engine, 'product-install.json'))).stages,
    { cli: 'verified', vscode: 'verified', copilot: 'verified', path: 'verified' });
  report.cases.push('one repeated setup finishes the exact retained candidate and verifies real CLI/build and manager protocols');
  const enrolled = path.join(home, '.singularity-flow', 'trust', 'artifact-builder-public.pem');
  assert.equal(await readFile(enrolled, 'utf8'), await readFile(key, 'utf8'));
  const update = setup([]);
  await installerProcess(update.command, update.args, { ...update.options, env, cwd: temporary, capture: true, timeoutMs: 1_200_000 });
  report.cases.push('a no-argument update reuses enrolled independent trust, without global Node/npm');
  if (process.platform === 'win32') {
    const userPath = await registry(`[Console]::Write([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))`);
    assert.ok(userPath.stdout.includes(path.join(engine, 'bin')));
    assert.ok(!userPath.stdout.includes(path.join(engine, 'runtimes')));
  } else {
    const profile = await readFile(path.join(home, '.zshrc'), 'utf8');
    assert.equal(profile.split('# >>> SFlow managed commands >>>').length, 2);
    assert.ok(!profile.includes('/runtimes/'));
  }
  report.cases.push('per-user PATH contains only SFlow shims and repeated setup does not duplicate its configuration');
  report.status = 'passed'; report.casesPassed = report.cases.length;
  console.log(JSON.stringify(report, null, 2));
  if (process.env.SFLOW_PRODUCT_QUALIFICATION_OUTPUT) await writeFile(process.env.SFLOW_PRODUCT_QUALIFICATION_OUTPUT, JSON.stringify(report, null, 2));
} finally {
  if (registryBaseline) await registry(`$o=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SFLOW_REGISTRY_FIXTURE))|ConvertFrom-Json;$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment');try{foreach($n in @('Path','SINGULARITY_FLOW_ENGINE_HOME')){if($null -eq $o.$n.value){$k.DeleteValue($n,$false)}else{$k.SetValue($n,[string]$o.$n.value,[Microsoft.Win32.RegistryValueKind]([Enum]::Parse([Microsoft.Win32.RegistryValueKind],$o.$n.kind)))}}}finally{$k.Dispose()}`, registryBaseline);
  await rm(temporary, { recursive: true, force: true });
}

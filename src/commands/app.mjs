/**
 * `singularity-flow app plan|start|status|stop|suggest|config preview` [RUN M1, amendments M7 and
 * M11]: the capability's declared application, model-free and the same for the Shell, VS Code and
 * Copilot. Start entries may be typed run configurations (run-configurations.mjs).
 */
import path from 'node:path';

import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['plan', 'start', 'status', 'stop', 'suggest', 'config']);
const OPTIONS = Object.freeze({
  plan: ['capability', 'json'], start: ['capability', 'environment', 'expect-command', 'debug'], status: ['capability', 'json'], stop: ['capability', 'json'],
  suggest: ['capability', 'json'], config: ['application-file', 'capability', 'json']
});

function fail(message, code = 'APP_COMMAND_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function rejectOptions(subcommand, options) {
  const allowed = new Set([...OPTIONS[subcommand], 'timings']);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key)).sort();
  if (!unknown.length) return;
  if (subcommand === 'start' && unknown.includes('json')) {
    fail('app start streams the application\'s own output; read singularity-flow app status --json for its state.');
  }
  fail(`app ${subcommand} does not accept ${unknown.map((key) => `--${key}`).join(', ')}. Use: ${OPTIONS[subcommand].map((key) => `--${key}`).join(', ')}.`);
}

function words(entry) {
  return entry.ready.http != null ? `ready when ${entry.ready.http} answers` : `ready on "${entry.ready.log}"`;
}

function environmentWords(environments) {
  if (!environments.length) return 'no environment';
  return environments.map((entry) => `${entry.name} (${[entry.default ? 'default' : null,
    entry.status === 'bound' ? 'bound' : entry.status === 'undeclared' ? 'not declared' : 'not bound'].filter(Boolean).join(', ')})`).join(', ');
}

async function context(root, options) {
  const { resolveCapabilityApplication } = await import('../capability-application-context.mjs');
  const relative = path.relative(root, process.cwd()).replaceAll('\\', '/');
  return resolveCapabilityApplication(root, {
    capabilityId: optionString(options, 'capability', null),
    subjectPath: relative && !relative.startsWith('..') ? relative : ''
  });
}

export async function run(_argv, { positionals, options = {} }) {
  const subcommand = positionals[1] ?? 'status';
  if (!SUBCOMMANDS.includes(subcommand)) {
    fail(`Unknown app subcommand '${subcommand}'. Supported: ${SUBCOMMANDS.join(', ')}.`, 'UNKNOWN_SUBCOMMAND',
      { command: 'app', subcommand, available: [...SUBCOMMANDS] });
  }
  rejectOptions(subcommand, options);
  if (subcommand === 'config') {
    const { repoRoot } = await import('../git.mjs');
    return (await import('./app-config.mjs')).run(repoRoot(process.cwd()), options, positionals, { json: optionBoolean(options, 'json') });
  }
  const startId = positionals[2] ?? null;
  if (positionals.length > 3 || (['status', 'suggest'].includes(subcommand) && startId)) {
    fail(['status', 'suggest'].includes(subcommand) ? `app ${subcommand} reads every entry; it takes no START-ID.` : `app ${subcommand} takes at most one START-ID.`);
  }
  const json = optionBoolean(options, 'json');
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot(process.cwd());
  const application = await context(root, options);
  if (subcommand === 'suggest') return (await import('./app-suggest.mjs')).run(root, application, { json });
  const runtime = await import('../application-run.mjs');
  const { loadEnvironmentDeclaration } = await import('../environment-declaration.mjs');

  if (subcommand === 'plan') {
    const declaration = await loadEnvironmentDeclaration(root, { optional: true });
    const entries = startId ? [runtime.selectStartEntry(application, startId)] : application.application.start;
    const plans = [];
    for (const entry of entries) plans.push(await runtime.planStartEntry(root, application, entry, declaration));
    // The block as capabilities.yml holds it (typed fields as written), so an editor can write the whole
    // block back with --application-file and never drop tests; no block reads as an empty one.
    const block = application.capability?.application;
    const result = { resultType: 'sflow-app-plan', capability: application.capabilityId, entries: plans,
      application: block && typeof block === 'object' ? structuredClone(block) : { start: [], tests: [] } };
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (!plans.length) {
      console.log(`Capability '${application.capabilityId}' declares no application start entry.`);
      console.log('Add application.start to singularity/capabilities.yml through a capability proposal (see singularity-flow help app).');
    } else {
      console.log(`Application of ${application.capabilityId}:`);
      for (const [index, plan] of plans.entries()) {
        const entry = entries[index];
        const label = `${plan.id}${plan.name && plan.name !== plan.id ? ` (${plan.name})` : ''}${plan.type && plan.type !== 'command' ? ` · ${plan.type}` : ''}`;
        console.log(`  ${label}: ${plan.argv.join(' ')} · in ${plan.repository}/${plan.workingDirectory} · ${plan.url} · ${words(entry)} · ${environmentWords(plan.environments)}`);
        const perEnvironment = plan.environments.filter((environment) => environment.argv);
        for (const environment of perEnvironment) {
          const names = environment.resolved?.envNames ?? [];
          console.log(`    ${environment.name}: ${environment.argv.join(' ')}${names.length ? ` (with ${names.join(', ')} set)` : ''}`);
        }
        if (!perEnvironment.length && plan.resolved?.envNames.length) console.log(`    with ${plan.resolved.envNames.join(', ')} set`);
        for (const step of (perEnvironment[0] ?? plan).resolved?.beforeLaunch ?? []) console.log(`    before launch: ${step.argv.join(' ')} (in ${step.workingDirectory})`);
        if (plan.debug) {
          console.log(plan.debug.refusal ? `    debug (${plan.debug.runtime}): refused, ${plan.debug.refusal.message}`
            : `    debug (${plan.debug.runtime}${plan.debug.address ? ` on ${plan.debug.address}` : ', attach to the pid'}): ${plan.debug.argv.join(' ')}${plan.debug.environmentNames.length ? ` with ${plan.debug.environmentNames.join(', ')} set` : ''}`);
        }
      }
      const first = plans[0];
      console.log(`Start: singularity-flow app start ${first.id}${first.environments.length > 1 ? ` [--environment ${first.environments.map((entry) => entry.name).join('|')}]` : ''}`);
      for (const plan of plans) for (const environment of plan.environments) {
        if (environment.status !== 'bound' && environment.status !== 'undeclared') {
          console.log(`  ${environment.name} is not bound: your-approved-secret-helper --format sflow-env-json ${environment.name} | singularity-flow env bind ${environment.name} --stdin`);
        }
      }
    }
    return result;
  }

  if (subcommand === 'status') {
    const result = await runtime.applicationStatus(root, application);
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (!result.entries.length) console.log(`Capability '${application.capabilityId}' declares no application start entry.`);
    else {
      for (const entry of result.entries) {
        const state = entry.started ? `started (pid ${entry.pid}${entry.environment ? `, environment ${entry.environment}` : ''})` : 'not started';
        const debug = entry.debug?.listening ? ` · debugger listening at 127.0.0.1:${entry.debug.port}` : '';
        console.log(`  ${entry.id}: ${state} · ${entry.ready ? 'ready' : 'not answering'} at ${entry.url}${debug}`);
      }
      const idle = result.entries.find((entry) => !entry.started);
      if (idle) console.log(`Start: singularity-flow app start ${idle.id}`);
    }
    return result;
  }

  const entry = runtime.selectStartEntry(application, startId);
  if (subcommand === 'stop') {
    const result = await runtime.stopApplication(root, application, entry);
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (result.stopped) console.log(`Stopped ${entry.id} (pid ${result.pid}) and its child processes.`);
    else if (result.reason === 'still-running') console.log(`${entry.id} (pid ${result.pid}) did not stop; stop it from your system's process manager.`);
    else console.log(`${entry.id} is not running from app start; nothing was stopped.`);
    if (result.reason === 'still-running') process.exitCode = 1;
    return result;
  }

  const declaration = await loadEnvironmentDeclaration(root, { optional: true });
  const debug = optionBoolean(options, 'debug');
  if (debug) runtime.assertDebugDeclared(entry);
  const requested = optionString(options, 'environment', null);
  const paths = runtime.appRunPaths(root, application.capabilityId, entry.id);
  const shownArgv = entry.environments.includes(requested ?? entry.environments[0]) ? runtime.startArgv(entry, requested ?? entry.environments[0], { paths })
    : runtime.startArgv(entry, null, { paths });
  console.log(`Starting ${entry.id}${debug && entry.debug ? ` with the ${entry.debug.runtime} debugger` : ''}: ${shownArgv.join(' ')} (in ${entry.workingDirectory}). Stop with Ctrl+C or singularity-flow app stop ${entry.id}.`);
  const result = await runtime.startApplication(root, application, entry, {
    requestedEnvironment: requested, declaration, debug,
    expectedCommandSha256: optionString(options, 'expect-command', null)
  });
  console.log(result.outcome === 'stopped' ? `Stopped ${entry.id}.` : `${entry.id} exited (${result.signal ?? result.exitCode}).`);
  process.exitCode = result.exitCode ?? 0;
  return result;
}

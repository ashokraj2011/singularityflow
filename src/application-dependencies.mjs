/** Start declared services in order; stop only services this run owns, in reverse order. */
import { applicationCommandSha256, readAppRecord, recordedProcessAlive, startSingleApplication, readinessUrl, probeLoopback } from './application-run.mjs';
import { startEntryCommandSha256 } from './run-configurations.mjs';
import { SingularityFlowError } from './util.mjs';

export function dependencyOrder(context, entry) {
  const result = [], visited = new Set();
  const visit = (item, chain) => {
    if (chain.includes(item.id)) throw new SingularityFlowError('Application dependency cycle.', { code: 'APP_DEPENDENCY_CYCLE' });
    for (const id of item.dependsOn ?? []) {
      const dependency = context.application.start.find(candidate => candidate.id === id);
      if (!dependency) throw new SingularityFlowError(`Unknown service '${id}'.`, { code: 'APP_DEPENDENCY_UNKNOWN' });
      if (!visited.has(id)) { visit(dependency, [...chain, item.id]); visited.add(id); result.push(dependency); }
    }
  };
  visit(entry, []);
  return result;
}

async function dependencyRoot(root, context, entry) {
  if (!context.repositoryId || context.repositoryId === entry.repository) return root;
  const { findWorkspaceMembership } = await import('./execution-context.mjs');
  const { indexedCheckoutAt, lookupStoryCheckouts } = await import('./story-index.mjs');
  const member = await findWorkspaceMembership(root);
  if (!member?.workspacePath) throw new SingularityFlowError(`Select the workspace checkout for service '${entry.id}'.`, { code: 'APP_DEPENDENCY_CHECKOUT_REQUIRED' });
  const story = await indexedCheckoutAt(root);
  if (story) {
    const { valid } = await lookupStoryCheckouts(story.workId, { backfill: false });
    const target = valid.find(item => item.repository.id === entry.repository && item.workspace.id === story.workspace.id);
    if (target) return target.checkoutPath;
    throw new SingularityFlowError(`Story '${story.workId}' needs its '${entry.repository}' checkout before '${entry.id}' can start. Attach the Story to prepare it; no base checkout was substituted.`, { code: 'APP_DEPENDENCY_CHECKOUT_REQUIRED' });
  }
  const { readWorkspace, workspaceRepositoryPath } = await import('./workspace-manifest.mjs');
  const workspace = await readWorkspace(member.workspacePath);
  if (!workspace.repositories[entry.repository]) throw new SingularityFlowError('A dependency repository is outside this workspace.', { code: 'APP_DEPENDENCY_CHECKOUT_REQUIRED' });
  return workspaceRepositoryPath(workspace, workspace.repositories[entry.repository]);
}

export async function startWithDependencies(root, context, entry, options = {}) {
  if (options.expectedCommandSha256 && options.expectedCommandSha256 !== applicationCommandSha256(context, entry)) {
    throw new SingularityFlowError('The application or its dependencies changed since confirmation; refresh Run & Test.', { code: 'APP_COMMAND_CHANGED' });
  }
  const output = options.output ?? process.stdout;
  const environment = options.requestedEnvironment ?? entry.environments[0] ?? null;
  const targets = [];
  for (const dependency of dependencyOrder(context, entry)) {
    const checkout = await dependencyRoot(root, context, dependency);
    const { resolveCapabilityApplication } = await import('./capability-application-context.mjs');
    const own = checkout === root ? context : await resolveCapabilityApplication(checkout, { capabilityId: context.capabilityId });
    const resolved = own.application.start.find(item => item.id === dependency.id);
    if (!resolved || startEntryCommandSha256(resolved) !== startEntryCommandSha256(dependency)) throw new SingularityFlowError(`Service '${dependency.id}' has a different configuration in its checkout. Refresh the Story configuration before running.`, { code: 'APP_DEPENDENCY_CONFIGURATION_CHANGED' });
    const existing = await readAppRecord(checkout, context.capabilityId, dependency.id, { strict: true });
    if (existing && recordedProcessAlive(existing)) {
      if (!recordedProcessAlive(existing, { fresh: true, requireIdentity: true }) || existing.managedDependency || existing.environment !== (dependency.environments.length ? environment ?? dependency.environments[0] : null)
          || existing.commandSha256 !== applicationCommandSha256(own, resolved) || !(resolved.ready.log ? existing.readyAt : (await probeLoopback(readinessUrl(resolved))).ready)) {
        throw new SingularityFlowError(`Service '${dependency.id}' is in use by another run or has a different environment. Stop that run, or start this service separately for reuse.`, { code: 'APP_DEPENDENCY_IN_USE' });
      }
    }
    const declaration = await (await import('./environment-declaration.mjs')).loadEnvironmentDeclaration(checkout, { optional: true });
    targets.push({ root: checkout, context: own, entry: resolved, declaration, reuse: Boolean(existing && recordedProcessAlive(existing)) });
  }
  const owned = [];
  const controller = new AbortController();
  let requestedStop = false;
  const cancel = () => { requestedStop = true; controller.abort(); };
  const signals = options.signals ?? ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of signals) process.on(name, cancel);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  try {
    for (const target of targets) {
      if (target.reuse) { output.write(`Reusing ready service ${target.entry.id} in ${target.root}.\n`); continue; }
      output.write(`Starting dependency ${target.entry.id} in ${target.root}.\n`);
      let ready, failed;
      const waiting = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
      const control = new AbortController();
      const dependencySignal = AbortSignal.any([signal, control.signal]);
      const running = startSingleApplication(target.root, target.context, target.entry, {
        ...options, declaration: target.declaration, debug: false, managedDependency: true, expectedCommandSha256: null, signals: [], signal: dependencySignal,
        requestedEnvironment: target.entry.environments.length ? environment : null,
        onReady: () => ready()
      });
      running.then(result => failed(new SingularityFlowError(`Dependency '${target.entry.id}' ended before the application.`, { code: 'APP_DEPENDENCY_EXITED', details: { outcome: result.outcome } })), failed);
      owned.push({ ...target, running, control });
      await waiting;
    }
    const main = startSingleApplication(root, context, entry, { ...options, expectedCommandSha256: null, signals: [], signal });
    const lost = owned.map(target => target.running.then(() => { throw new SingularityFlowError(`Dependency '${target.entry.id}' stopped.`, { code: 'APP_DEPENDENCY_EXITED' }); }));
    try { return await Promise.race([main, ...lost]); }
    catch (error) { controller.abort(); await main.catch(() => {}); throw error; }
  } catch (error) {
    if (requestedStop || options.signal?.aborted) return { capability: context.capabilityId, id: entry.id, outcome: 'stopped', ready: false, exitCode: 0 };
    throw error;
  } finally {
    for (const name of signals) process.off(name, cancel);
    for (const target of owned.reverse()) {
      target.control.abort();
      await target.running.catch(() => {});
    }
    controller.abort();
  }
}

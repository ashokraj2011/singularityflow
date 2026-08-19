import path from 'node:path';
import { existsSync } from 'node:fs';
import { branch, changes, hasRemote, hasUpstream, head } from './git.mjs';
import { initializationStatus, loadDefinition, WORKFLOW_PATH } from './config.mjs';
import { loadPortfolio } from './initiative-config.mjs';
import { loadSession } from './session.mjs';
import { VERSION } from './version.mjs';
import { BUILD_INFO, versionLine } from './build-info.mjs';
import { storyPublicationPending, validateWorkflow, workflowPath, loadStoryAggregate } from './state-stores.mjs';
import { findLegacyPendingPublications } from './publication-pending.mjs';
import { inspectStatePlanes } from './state-planes.mjs';
import { commandExists, platformShell, run } from './util.mjs';
import { copilotTelemetryStatus } from './telemetry.mjs';
import { buildRepositorySubjectIndex, resolveContext } from './repository-subject-index.mjs';
import { mcpDoctor } from './mcp-readiness.mjs';
import { modelFreedomSnapshot, modelFreedomText } from './model-freedom.mjs';
import { operationContext } from './operation-context.mjs';
import { repositoryPerformanceSnapshot } from './performance-doctor.mjs';
import { withWorldModelSourceScope } from './source-scope.mjs';
import { schemaCensus, schemaCensusText } from './schema-census.mjs';

function check(id, status, message, fix = null) { return { id, status, message, fix }; }

export async function doctorSnapshot(root, { workId = null, offline = false, performance = false } = {}) {
  const checks = [];
  let performanceReport = null;
  let schemaReport = null;
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(check('node', major >= 20 ? 'pass' : 'fail', `Node.js ${process.versions.node}`, major >= 20 ? null : 'Install Node.js 20 or newer.'));
  checks.push(check('git', 'pass', `Git repository ${root}`));
  try {
    schemaReport = await schemaCensus(root);
    const blocked = schemaReport.totals.outsideRange + schemaReport.totals.unreadable;
    const advisory = schemaReport.totals.unregistered + (schemaReport.truncated ? 1 : 0);
    checks.push(check(
      'schema-migrations',
      blocked ? 'fail' : advisory ? 'warn' : 'pass',
      `${schemaReport.totals.registeredRecords} registered durable record(s) across ${schemaReport.totals.observedFamilies} observed family/families; ${schemaReport.totals.outsideRange} outside the readable range, ${schemaReport.totals.unregistered} unregistered, ${schemaReport.totals.unreadable} unreadable.`,
      blocked
        ? 'Upgrade sflow for newer records; use the named archival reader or governed republication for records below a family read range.'
        : advisory
          ? 'Classify remaining versioned governed records in src/schema-migrations.mjs, then rerun singularity-flow doctor.'
          : null
    ));
  } catch (error) {
    checks.push(check('schema-migrations', 'fail', `Schema census failed: ${error.message}`, 'Repair the unreadable state path, then rerun singularity-flow doctor.'));
  }
  /**
   * Which build is running, which `VERSION` alone cannot say.
   *
   * The CLI on PATH is a copy, not a link to any checkout, so editing sources changes nothing until
   * `install.sh` runs again. Two installs from different clones both reported `0.9.0` while their
   * `cli.mjs` differed by hundreds of lines. This is the line that ends "am I running what I am
   * editing?", and diagnostics is where somebody asks it.
   *
   * A build packed from a dirty tree is a `warn`: it is usable, but it corresponds to no commit
   * anybody can check out, so a bug found in it cannot be reproduced from source.
   */
  checks.push(check(
    'build',
    BUILD_INFO.dirty ? 'warn' : 'pass',
    versionLine(),
    BUILD_INFO.dirty
      ? 'This build was packed from a checkout with uncommitted changes, so it matches no commit. Commit, then reinstall.'
      : null
  ));
  // The world-model build hands a configured runner command to a shell, so a machine without one
  // can read and publish governed state but cannot build a model. That used to surface as a spawn
  // error deep in a build; naming the platform and the missing tool here is the difference between
  // a five-minute fix and an afternoon.
  const buildShell = platformShell();
  const shellReady = commandExists(buildShell.command);
  checks.push(check(
    'platform',
    shellReady ? 'pass' : 'warn',
    `${process.platform} · world-model builds run through ${buildShell.command}${shellReady ? '' : ', which was not found'}.`,
    shellReady
      ? null
      : process.platform === 'win32'
        ? 'Governed state still works. To build world models, install Git for Windows so a shell is available.'
        : `Governed state still works. To build world models, install ${buildShell.command}.`
  ));
  /**
   * The documentation version, beside the CLI version `[DOC:REQ-004]`.
   *
   * A mismatch is `misconfigured` rather than a warning because of what the docs layer is for. Every
   * `explain` reply carries a citation, and a citation whose bytes came from somewhere other than
   * the build is worse than no citation at all — it is a confident answer with a false provenance.
   * Better to say so on the diagnostics page than to keep serving it.
   */
  try {
    const { buildManifest, loadTopics } = await import('./docs-topics.mjs');
    const { docsManifest } = await import('./docs-manifest.mjs');
    const manifest = docsManifest();
    const topics = await loadTopics();
    const actual = buildManifest(topics).contentSha256;
    const stamped = manifest?.contentSha256 ?? null;
    const matches = Boolean(stamped) && stamped === actual;
    checks.push(check(
      'documentation',
      matches ? 'pass' : 'fail',
      matches
        ? `CLI ${VERSION} · ${topics.length} documentation topics, content ${actual.slice(0, 12)} from ${manifest.sourceCommit ? manifest.sourceCommit.slice(0, 7) : 'an unstamped build'}.`
        : stamped
          ? `CLI ${VERSION} · documentation is misconfigured: ${topics.length} topics hash to ${actual.slice(0, 12)} but the manifest was stamped from ${stamped.slice(0, 12)}.`
          : `CLI ${VERSION} · ${topics.length} documentation topics are installed with no stamped manifest.`,
      matches ? null : 'Rebuild it with: node scripts/build-docs-manifest.mjs — until then, sflow explain citations name a version this build did not ship.'
    ));
  } catch (error) {
    checks.push(check('documentation', 'fail', `Documentation topics could not be read: ${error.message}`,
      'Reinstall the package: the docs/topics directory ships with it.'));
  }

  const gitName = run('git', ['config', '--get', 'user.name'], { cwd: root, allowFailure: true }).stdout.trim();
  const gitEmail = run('git', ['config', '--get', 'user.email'], { cwd: root, allowFailure: true }).stdout.trim();
  checks.push(check('git-identity', gitName && gitEmail ? 'pass' : 'fail', gitName && gitEmail ? `Git identity ${gitName} <${gitEmail}>.` : 'Git user.name and/or user.email is missing.', gitName && gitEmail ? null : 'Configure git user.name and git user.email before creating lifecycle commits.'));
  const initialization = await initializationStatus(root);
  checks.push(check(
    'initialization-assets',
    initialization.complete ? 'pass' : initialization.configurationError ? 'fail' : 'warn',
    initialization.complete
      ? `All ${initialization.expectedFiles.length} packaged initialization assets are present and valid.`
      : `${initialization.missingFiles.length} packaged initialization asset(s) are missing.${initialization.configurationError ? ` ${initialization.configurationError}` : ''}`,
    initialization.complete ? null : 'Run singularity-flow init --repair on the current branch, then rerun singularity-flow doctor.'
  ));
  const workflowConfig = path.join(root, WORKFLOW_PATH);
  if (!existsSync(workflowConfig)) {
    checks.push(check('configuration', 'fail', `${WORKFLOW_PATH} is missing.`, 'Run singularity-flow init.'));
    return summarize(root, checks, null, null, null, null, null, schemaReport);
  }
  let definition;
  try {
    definition = await loadDefinition(root);
    checks.push(check('configuration', 'pass', `${WORKFLOW_PATH} is valid (${Object.keys(definition.workTypes).length} workflows, ${Object.keys(definition.agents).length} agents).`));
  } catch (error) {
    checks.push(check('configuration', 'fail', error.message, `Repair ${WORKFLOW_PATH} or restore it from version control.`));
    return summarize(root, checks, null, null, definition, null, null, schemaReport);
  }
  const mcpReadiness = await mcpDoctor(root, definition);
  for (const server of mcpReadiness.servers) {
    const status = server.readiness === 'ready'
      ? 'pass'
      : server.readiness === 'misconfigured' ? 'fail' : 'warn';
    checks.push(check(
      `mcp-${server.id}`,
      status,
      `MCP ${server.id}: ${server.readiness}.${server.reasons.length ? ` ${server.reasons.join(' ')}` : ''}`,
      server.readiness === 'ready'
        ? null
        : server.readiness === 'misconfigured'
          ? `Repair host entry '${server.hostReference}', then run singularity-flow mcp doctor --server ${server.id}.`
          : `Trust and start '${server.hostReference}' in the host, then run singularity-flow mcp attest ${server.id} --confirm ${server.id}.`
    ));
  }
  const telemetry = await copilotTelemetryStatus(root);
  checks.push(check(
    'copilot-telemetry',
    telemetry.ready ? 'pass' : 'warn',
    telemetry.ready
      ? `Copilot telemetry has ${telemetry.completedChatSpans} completed chat span(s) in the repository exporter.`
      : telemetry.fileConfigured
        ? `Copilot telemetry is configured, but no completed chat span is available yet (${telemetry.bytes} bytes).`
        : 'This process was not started with the repository-scoped Copilot telemetry exporter.',
    telemetry.ready
      ? null
      : telemetry.fileConfigured
        ? 'Finish the current Copilot response, then run singularity-flow telemetry status from the next turn.'
        : 'Fully exit Copilot, open a new terminal in this repository, verify `type copilot`, and start a new session.'
  ));
  const currentBranch = branch(root);
  const requested = workId ?? currentBranch;
  let workflow = null;
  const subjectIndex = await buildRepositorySubjectIndex(root, { definition });
  // With an explicit --work-id, doctor remains Story-specific. Without one, resolve the current
  // branch across both lifecycle kinds so an active Initiative is not misreported as a missing
  // Story and its valid governed-agent session is not called stale.
  const activeSubject = resolveContext(subjectIndex, {
    reference: requested,
    kind: workId ? 'story' : null,
    required: Boolean(workId)
  });
  const selected = activeSubject?.kind === 'story' ? activeSubject : null;
  if (selected) {
    try {
      workflow = await loadStoryAggregate(root, definition, selected.id);
      // Carry the caller's offline choice into validation. `doctorSnapshot` already accepts it and
      // the read model already passes it; stopping it here is what put 42 network fetches behind
      // every snapshot.
      const validation = await validateWorkflow(root, definition, workflow, { offline });
      checks.push(check('workflow-state', validation.valid ? 'pass' : 'fail', validation.valid ? `${selected.id} state is internally consistent.` : validation.errors.join(' '), validation.valid ? null : `Run singularity-flow recover ${selected.id} to inspect safe recovery options.`));
      const planes = await inspectStatePlanes(root, {
        definition,
        reference: selected.id,
        kind: 'story',
        offline
      });
      checks.push(check(
        'state-planes',
        planes.healthy ? 'pass' : 'fail',
        planes.healthy
          ? `Lifecycle authority, local selection, publication recovery, ledger mirror, and projections agree at ${planes.lifecycle.head.slice(0, 8)}.`
          : 'One or more state planes require recovery or projection repair.',
        planes.healthy ? null : `Run singularity-flow state planes ${selected.id} --json, then singularity-flow state reconcile ${selected.id} --check.`
      ));
      // Read-only: the doctor is also what the snapshot runs, and a diagnostic must not change the
      // repository it is diagnosing.
      const pending = await storyPublicationPending(root, definition, selected.id, { migrate: false });
      checks.push(check('publication', pending ? 'fail' : 'pass', pending ? 'A local lifecycle commit is waiting to be pushed.' : 'No lifecycle publication is pending.', pending ? 'Run singularity-flow sync.' : null));
      const active = workflow.currentPhase ? workflow.phases[workflow.currentPhase] : null;
      const assignmentMode = workflow.resolution?.collaboration?.assignmentMode ?? 'off';
      const assigned = active ? workflow.collaboration?.assignments?.[active.id] : null;
      if (active && assignmentMode !== 'off') checks.push(check('assignment', assigned ? 'pass' : assignmentMode === 'required' ? 'fail' : 'warn', assigned ? `${active.id} is assigned to ${assigned.assignee}.` : `${active.id} is unassigned (${assignmentMode}).`, assigned ? null : `Run singularity-flow assign ${active.id} <assignee>.`));
    } catch (error) {
      checks.push(check('workflow-state', 'fail', error.message, `Inspect ${workflowPath(root, definition, selected.id)} in Git history.`));
    }
  } else if (activeSubject?.kind === 'initiative') {
    checks.push(check(
      'workflow-state',
      'skip',
      `Initiative ${activeSubject.id} is active; Story workflow checks are not applicable.`,
      `Run singularity-flow initiative status ${activeSubject.id} for Initiative phase checks.`
    ));
  } else if (subjectIndex.unreadable?.length) {
    // A state file that exists and will not parse is a failure, not an absence. This reported
    // "skip — no work item is associated with this branch", so the diagnostic built to find
    // corrupted state was the one command that declined to look at it.
    checks.push(check(
      'workflow-state',
      'fail',
      `State exists for this repository but could not be read: ${subjectIndex.unreadable.map((entry) => `${entry.path} (${entry.reason})`).join('; ')}.`,
      'Repair the file, or restore it from Git history.'
    ));
  } else checks.push(check('workflow-state', 'skip', `No work item is associated with branch '${currentBranch}'.`, 'Run singularity-flow start <WORK-ID> or resume <WORK-ID>.'));
  // The configured roots, so a repository that keeps its work items or initiatives anywhere other
  // than `singularity/` is scanned too — those are precisely the repositories whose markers this
  // scan could not see while every mutation refused to run because of them.
  const portfolio = await loadPortfolio(root, { required: false }).catch(() => null);
  const legacyPending = await findLegacyPendingPublications(root, {
    workItemRoot: definition?.workItemRoot,
    initiativeRoot: portfolio?.initiativeRoot
  });
  checks.push(check(
    'legacy-publication-markers',
    legacyPending.length ? 'fail' : 'pass',
    legacyPending.length
      ? `${legacyPending.length} legacy publication marker(s) remain outside the machine-local recovery plane: ${legacyPending.map((file) => path.relative(root, file)).join(', ')}.`
      : 'No orphaned legacy publication markers remain in the governed tree.',
    legacyPending.length
      ? 'Open the matching Story or Initiative so Singularity Flow can migrate its marker, then run its sync command. Remove only markers whose retained commit has already been published.'
      : null
  ));
  const session = await loadSession(root, { required: false });
  if (!workflow && session && activeSubject?.id === session.workId) {
    checks.push(check('session', 'pass', `governed agent '${session.agent}' is active for ${activeSubject.kind} ${session.workId}.`));
  } else if (!workflow) checks.push(check('session', session ? 'warn' : 'skip', session ? `Session selects ${session.agent} for ${session.workId}, but that subject is not open.` : 'No agent session is active.'));
  else if (!session) checks.push(check('session', 'warn', 'No agent is selected for this terminal.', `Run singularity-flow resume ${workflow.workItem.id}.`));
  else if (session.workId !== workflow.workItem.id) checks.push(check('session', 'warn', `Session belongs to ${session.workId}, not ${workflow.workItem.id}.`, `Run singularity-flow resume ${workflow.workItem.id}.`));
  else checks.push(check('session', 'pass', `governed agent '${session.agent}' is active for ${session.workId}.`));
  if (performance) {
    try {
      const measuredDefinition = withWorldModelSourceScope(
        definition,
        workflow?.resolution?.worldModelSourceScope ?? null
      );
      performanceReport = await repositoryPerformanceSnapshot(root, measuredDefinition);
      checks.push(check(
        'repository-performance',
        performanceReport.recommendations.some((entry) => entry.severity === 'high') ? 'warn' : 'pass',
        `${performanceReport.files.scoped.toLocaleString('en-US')} of ${performanceReport.files.tracked.toLocaleString('en-US')} tracked files are in scope; `
          + `warm status ${performanceReport.timings.status.warmMs} ms; warm world-model fingerprint ${performanceReport.timings.worldModelFingerprint.warmMs} ms.`,
        performanceReport.recommendations.length
          ? performanceReport.recommendations.map((entry) => entry.message).join(' ')
          : null
      ));
    } catch (error) {
      checks.push(check('repository-performance', 'warn', `Performance diagnostics could not complete: ${error.message}`,
        'Run git status, repair the worktree if necessary, and retry singularity-flow doctor --performance.'));
    }
  }
  checks.push(check('working-tree', changes(root).trim() ? 'warn' : 'pass', changes(root).trim() ? 'Working tree has uncommitted changes.' : 'Working tree is clean.', changes(root).trim() ? 'Review git status before lifecycle publication.' : null));
  const remote = definition.git?.remote ?? 'origin';
  if (!hasRemote(root, remote)) checks.push(check('remote', definition.git?.publish === 'required' ? 'fail' : 'warn', `Git remote '${remote}' is not configured.`, `Add the '${remote}' remote or set git.publish: off.`));
  else if (offline) checks.push(check('remote', 'skip', `Remote '${remote}' was not contacted in offline mode.`));
  else {
    // Any ref, not HEAD specifically. A remote whose HEAD points at a branch that never appeared —
    // which is what a bare repository created before its first push looks like — answers nothing for
    // HEAD, and probing for it reported a perfectly reachable remote as a network or authentication
    // failure, with a remedy about restoring credentials that had nothing to do with it.
    const probe = run('git', ['ls-remote', '--exit-code', remote], { cwd: root, allowFailure: true });
    // Exit 2 is "reachable, but no refs at all" — a remote that exists and is empty, which is a
    // different thing from one that cannot be reached and deserves a different sentence.
    const empty = probe.status === 2;
    checks.push(check(
      'remote',
      probe.status === 0 ? 'pass' : empty ? 'warn' : 'fail',
      probe.status === 0 ? `Remote '${remote}' is reachable.`
        : empty ? `Remote '${remote}' is reachable but has no branches yet.`
          : `Remote '${remote}' could not be reached.`,
      probe.status === 0 ? null
        : empty ? 'Push a branch before relying on publication.'
          : 'Restore Git authentication or network access, then run singularity-flow sync.'
    ));
  }
  checks.push(check('upstream', hasUpstream(root) ? 'pass' : 'warn', hasUpstream(root) ? `Branch '${currentBranch}' tracks an upstream.` : `Branch '${currentBranch}' has no upstream.`, hasUpstream(root) ? null : 'The first successful lifecycle publication will establish it.'));
  return summarize(root, checks, workflow, session, definition, activeSubject, performanceReport, schemaReport);
}

function summarize(root, checks, workflow, session, definition, activeSubject = null, performance = null, schemaReport = null) {
  const counts = Object.fromEntries(['pass', 'warn', 'fail', 'skip'].map((status) => [status, checks.filter((item) => item.status === status).length]));
  const modelFreedom = modelFreedomSnapshot({
    definition,
    workflow,
    modelMode: operationContext()?.modelMode ?? { enabled: true, source: 'default' }
  });
  const subject = workflow
    ? { kind: 'story', id: workflow.workItem.id }
    : activeSubject ? { kind: activeSubject.kind, id: activeSubject.id } : null;
  return { schemaVersion: 1, repository: root, branch: branch(root), head: head(root), workId: subject?.id ?? null, subject, agent: session?.agent ?? null, healthy: counts.fail === 0, counts, modelFreedom, performance, schemaCensus: schemaReport, checks };
}

export function doctorText(report) {
  const icon = { pass: '✓', warn: '!', fail: '✗', skip: '·' };
  const lines = [`Singularity Flow doctor — ${report.healthy ? 'ready' : 'attention required'}`, `Repository: ${report.repository}`, `Branch: ${report.branch}`, ''];
  lines.push(modelFreedomText(report.modelFreedom), '');
  if (report.schemaCensus) lines.push(schemaCensusText(report.schemaCensus).trimEnd(), '');
  for (const item of report.checks) {
    lines.push(`${icon[item.status]} ${item.id}: ${item.message}`);
    if (item.fix) lines.push(`  Fix: ${item.fix}`);
  }
  if (report.performance) {
    lines.push('', 'Monorepo performance');
    lines.push(`  Scope: ${report.performance.files.scoped} of ${report.performance.files.tracked} tracked files`);
    lines.push(`  Git status: ${report.performance.timings.status.warmMs} ms warm`);
    lines.push(`  World-model fingerprint: ${report.performance.timings.worldModelFingerprint.warmMs} ms warm`);
    lines.push(`  Clone: ${report.performance.git.partialCloneFilter === 'blob:none' ? 'blobless' : 'full'} · checkout: ${report.performance.git.sparseCheckout ? 'sparse' : 'full'}`);
    for (const recommendation of report.performance.recommendations) lines.push(`  ! ${recommendation.message}`);
  }
  lines.push('', `${report.counts.pass} passed · ${report.counts.warn} warnings · ${report.counts.fail} failures · ${report.counts.skip} skipped`);
  return `${lines.join('\n')}\n`;
}

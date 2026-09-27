#!/usr/bin/env node
/** Checkout evidence only: this runner cannot attest an installed host, approve a pilot or run a skill. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitRuntime } from '../src/git-access.mjs';
import { withoutGitProcessOverrides } from '../src/git-enterprise-environment.mjs';
import { signalProcessTree } from '../src/util.mjs';
import { isTestNamePatternExclusion } from './release-test-reporter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
export const SKP_QUALIFICATION_PROFILE = 'sflow-skp-checkout-qualification/v1';
export const SKP_QUALIFICATION_LIMITS = Object.freeze({ sourceFiles: 8192, sourceEntries: 16384, sourceBytes: 128 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024, depth: 32, testEvents: 20000, outcomeRows: 512,
  outputBytes: 1024 * 1024, targetTimeoutMs: 120000, cleanupTimeoutMs: 2000 });
const freeze = (value) => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const identity = (value) => digest(JSON.stringify(value));
const fail = (code) => { throw Object.assign(new Error('SKP qualification refused.'), { code }); };
const SOURCE_ROOTS = ['bin', 'src', 'scripts', 'plugin', 'templates', 'schemas', 'apps/vscode/src', 'test'];
const COUNT_KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const PLATFORMS = ['darwin', 'win32', 'linux'];
const EXTERNAL = freeze([
  { id: 'native-supported-matrix', requirements: ['SKP-REQ-039', 'SKP-AC-062'], status: 'missing',
    meaning: 'Independent supported Node/Git/OS cells, linked worktrees, aliases, long paths, exact bytes and cancellation.' },
  { id: 'installed-npm-vsix', requirements: ['SKP-REQ-039', 'SKP-AC-062'], status: 'missing',
    meaning: 'Actual installed package and VSIX build-bound behavior; checkout fixtures do not establish this.' },
  { id: 'native-host-enforcement-delivery', requirements: ['SKP-REQ-019', 'SKP-REQ-020', 'SKP-REQ-021'], status: 'missing',
    meaning: 'Approved actual host/tool/read/write/egress/credential/control-plane containment and entry acknowledgement.' },
  { id: 'gor-wca-prerequisites', requirements: ['SKP-REQ-042', 'SKP-AC-063'], status: 'missing',
    meaning: 'Actual GOR and installed shell/Copilot shared-guide readiness at the selected assurance level.' },
  { id: 'human-team-pilot', requirements: ['SKP-REQ-043', 'SKP-REQ-048', 'SKP-AC-016', 'SKP-AC-064'], status: 'missing',
    meaning: 'Eligible real team, real approval, retained code/non-code execution, merge/Passport and all attempt/time denominators.' }
]);
export const SKP_PILOT_PLAN = freeze({ status: 'blocked', attemptStarted: false, launchAuthorized: false,
  prerequisiteEvidenceIds: ['native-supported-matrix', 'installed-npm-vsix', 'native-host-enforcement-delivery', 'gor-wca-prerequisites'],
  measurementFields: ['supportedStartingConditions', 'installedBuildAndHost', 'participantEligibility', 'reviewerAvailable',
    'eligibleImportedSkills', 'unresolvedQuestions', 'attemptsAndSuccessDenominator', 'activeInteractionMs', 'elapsedMs',
    'humanReviewWaitMs', 'providerWaitMs', 'blockedAttempts', 'abandonedAttempts', 'retries', 'observedMerge', 'observedChangePassport'],
  observations: [], meaning: 'A repeatable prerequisite/measurement plan, not a simulated team, pilot result or permission to run an untrusted skill.' });
export const SKP_QUALIFICATION_TARGETS = freeze([
  { id: 'inert-contract-fixtures', evidenceClass: 'unit-fixtures', files: [
    'test/skp-contract.test.mjs', 'test/skp-inspect.test.mjs', 'test/skp-package.test.mjs',
    'test/skp-package-seal.test.mjs', 'test/skp-host-admission.test.mjs', 'test/skp-inputs.test.mjs',
    'test/skp-outputs.test.mjs', 'test/skp-compatibility.test.mjs', 'test/skp-workflow-recipe.test.mjs',
    'test/wca-shared-phase-changes.test.mjs', 'test/wca-shared-content-changes.test.mjs',
    'test/wca-authoring-text-contracts.test.mjs', 'test/wca-simulation.test.mjs',
    'test/skp-platform-owners.test.mjs', 'test/skp-host-readiness.test.mjs',
    'test/vscode-workflow-shared-content.test.mjs'],
    meaning: 'Static contracts, byte/path negative cases, synthetic host and Windows/Linux owner policy, and structural shared-impact/lifecycle projections. No actual native host enforcement.' },
  { id: 'retained-local-owner-fixtures', evidenceClass: 'actual-local-git-and-filesystem-fixtures', files: [
    'test/skp-approved-bytes.test.mjs', 'test/skp-approved-mirror-capture.test.mjs',
    'test/skp-transport.test.mjs', 'test/skp-state-lifecycle.test.mjs', 'test/vscode-workflow-drafts-portable-recovery.test.mjs'],
    meaning: 'Actual local Git/snapshot/filesystem and encrypted-recovery owner integration on the observed OS, not installed artifact, another native OS or remote office evidence.' },
  { id: 'independent-local-git-clients', evidenceClass: 'actual-two-client-local-git-fixtures',
    files: ['test/wca-git-drafts.test.mjs'], pattern: '^Git DraftStore (cross-machine create/read/history|independent clients race|create-only CAS|lost acknowledgement resolves)',
    meaning: 'Two independently opened local clients and a real bare Git authority; not two physical machines or a human pilot.' },
  { id: 'cli-backed-shared-guide', evidenceClass: 'actual-local-cli-controller-fixture',
    files: ['test/vscode-workflow-drafts.test.mjs'], pattern: '^actual CLI-backed clients share identity, fence autosave races',
    meaning: 'Real CLI-backed clients with controller integration in one local OS fixture; not installed VSCode/Copilot UI.' },
  { id: 'direct-terminal-local-review', evidenceClass: 'actual-os-pty-local-review-fixtures',
    files: ['test/wca-skp-submission.test.mjs'], platforms: ['darwin'], requiresExpect: true,
    meaning: 'Actual macOS PTY and existing local terminal consent. No authenticated native host or actual human acceptance.' },
  { id: 'explicit-local-story-history', evidenceClass: 'actual-local-git-and-filesystem-fixtures',
    files: ['test/skp-story-usage.test.mjs', 'test/local-read-deadline.test.mjs', 'test/fos-preparation-cleanup.test.mjs'],
    meaning: 'Explicit local Story/ref first-parent windows, retained package/lineage reads, stale pagination and native CLI refusal. No provider principal, global repository scan or remote fetch.' },
  { id: 'shared-replacement-terminal-review', evidenceClass: 'actual-os-pty-local-review-fixtures',
    files: ['test/wca-compiler.test.mjs'], platforms: ['darwin'], requiresExpect: true,
    pattern: '^(real terminal skill replacement recompiles one binding|actual terminal shared agent body/metadata/template review proposals)',
    meaning: 'Actual macOS PTY replacement consent, raw configuration/package fences and shared metadata proposals. No authenticated mediated host, imported execution or human pilot.' }
]);

export function parseQualificationOptions(argv) {
  if (!Array.isArray(argv) || argv.length > 3 || argv.some((arg) => !['--execute', '--require-release', '--plan'].includes(arg))
      || new Set(argv).size !== argv.length || argv.includes('--execute') && argv.includes('--plan')) fail('SKP_QUALIFICATION_OPTION_INVALID');
  return Object.freeze({ execute: argv.includes('--execute'), requireRelease: argv.includes('--require-release') });
}

/** Consume Node event metadata only. Test output, names, skip reasons and exception messages never escape. */
export async function summarizeQualificationEvents(source, selectionArgv = process.execArgv) {
  if (!Array.isArray(selectionArgv) || selectionArgv.some((arg) => typeof arg !== 'string')) fail('SKP_QUALIFICATION_EVENT_INVALID');
  const capturedSelection = [...selectionArgv];
  let seen = 0; let excluded = 0; const counts = {}; const outcomes = []; const observed = { pass: 0, fail: 0, skipped: 0, todo: 0 };
  for await (const event of source) {
    if (++seen > SKP_QUALIFICATION_LIMITS.testEvents) fail('SKP_QUALIFICATION_EVENT_LIMIT');
    if (isTestNamePatternExclusion(event, capturedSelection)) { excluded += 1; continue; }
    if (event?.type === 'test:diagnostic') {
      const match = typeof event.data?.message === 'string' && event.data.message.match(/^(tests|pass|fail|cancelled|skipped|todo) (\d+)$/u);
      if (match && Number.isSafeInteger(Number(match[2]))) counts[match[1]] = Number(match[2]);
    }
    if (!['test:pass', 'test:fail'].includes(event?.type)) continue;
    const data = event.data ?? {};
    if (typeof data.name !== 'string' || data.name.length > 8192) fail('SKP_QUALIFICATION_EVENT_INVALID');
    const state = data.todo !== undefined && data.todo !== false ? 'todo'
      : data.skip !== undefined && data.skip !== false ? 'skipped' : event.type === 'test:fail' ? 'fail' : 'pass';
    observed[state] += 1;
    if (outcomes.length >= SKP_QUALIFICATION_LIMITS.outcomeRows) fail('SKP_QUALIFICATION_OUTCOME_LIMIT');
    outcomes.push({ identitySha256: identity([path.basename(String(data.file ?? '')), data.line ?? null, data.column ?? null, data.name]), state });
  }
  if (excluded) { counts.tests -= excluded; counts.skipped -= excluded; }
  // Node 20 and newer emit these fixed aggregate diagnostics. Missing/partial output is not pass.
  if (!COUNT_KEYS.every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
      || counts.tests < 1 || counts.tests !== counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo
      || observed.fail > 0 && counts.fail + counts.cancelled === 0 || observed.skipped > 0 && counts.skipped === 0
      || observed.todo > 0 && counts.todo === 0) fail('SKP_QUALIFICATION_RESULT_INCOMPLETE');
  return { kind: 'skp-qualification-test-outcomes', counts, outcomes };
}

/** The child reporter emits one bounded content-free result, never a standard raw error report. */
export default async function* qualificationReporter(source) {
  try { yield `${JSON.stringify(await summarizeQualificationEvents(source))}\n`; }
  catch (error) { yield `${JSON.stringify({ kind: 'skp-qualification-test-outcomes', refused: safeCode(error) })}\n`; process.exitCode = 1; }
}
function safeCode(error) {
  return typeof error?.code === 'string' && /^SKP_QUALIFICATION_[A-Z_]+$/u.test(error.code)
    ? error.code : 'SKP_QUALIFICATION_UNAVAILABLE';
}

/** Exact stat-sized allocation plus a one-byte growth probe; never read an append-unbounded file. */
export async function readBoundedQualificationFile(handle, expectedBytes) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0
      || expectedBytes > SKP_QUALIFICATION_LIMITS.fileBytes) fail('SKP_QUALIFICATION_SOURCE_INVALID');
  const bytes = Buffer.alloc(expectedBytes); let offset = 0;
  while (offset < expectedBytes) {
    const result = await handle.read(bytes, offset, expectedBytes - offset, offset);
    if (!Number.isSafeInteger(result?.bytesRead) || result.bytesRead < 1
        || result.bytesRead > expectedBytes - offset) fail('SKP_QUALIFICATION_SOURCE_CHANGED');
    offset += result.bytesRead;
  }
  const probe = Buffer.alloc(1);
  const extra = await handle.read(probe, 0, 1, expectedBytes);
  if (extra?.bytesRead !== 0) fail('SKP_QUALIFICATION_SOURCE_CHANGED');
  return bytes;
}

async function exactFile(file) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > SKP_QUALIFICATION_LIMITS.fileBytes) fail('SKP_QUALIFICATION_SOURCE_INVALID');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail('SKP_QUALIFICATION_SOURCE_CHANGED');
    const bytes = await readBoundedQualificationFile(handle, before.size);
    const after = await handle.stat(); const named = await lstat(file);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino) fail('SKP_QUALIFICATION_SOURCE_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}

/** Release our local handles after a cleanup deadline, not evidence that the child terminated. */
export function detachUnclosedQualificationChild(child) {
  let outputHandlesDetached = true;
  for (const stream of [child?.stdout, child?.stderr]) {
    if (!stream) continue;
    try { stream.removeAllListeners('data'); stream.destroy(); }
    catch { outputHandlesDetached = false; }
    if (!stream.destroyed) outputHandlesDetached = false;
  }
  let childUnreferenced = false;
  try { if (typeof child?.unref === 'function') { child.unref(); childUnreferenced = true; } }
  catch { /* Do not claim the process or local handle was released. */ }
  return { processClosed: false, outputHandlesDetached, childUnreferenced };
}

/** Bounded checkout identity, not a released/installed artifact or dependency-install attestation. */
export async function captureQualificationSource(root = ROOT) {
  const entries = []; let total = 0; let visited = 0;
  const capture = async (relative) => {
    if (entries.length >= SKP_QUALIFICATION_LIMITS.sourceFiles) fail('SKP_QUALIFICATION_SOURCE_LIMIT');
    const bytes = await exactFile(path.join(root, relative)); total += bytes.length;
    if (entries.length >= SKP_QUALIFICATION_LIMITS.sourceFiles || total > SKP_QUALIFICATION_LIMITS.sourceBytes) fail('SKP_QUALIFICATION_SOURCE_LIMIT');
    entries.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
    return bytes;
  };
  const walk = async (relative, depth) => {
    if (depth > SKP_QUALIFICATION_LIMITS.depth) fail('SKP_QUALIFICATION_SOURCE_LIMIT');
    const directory = path.join(root, relative); const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('SKP_QUALIFICATION_SOURCE_INVALID');
    const children = await readdir(directory, { withFileTypes: true });
    if (children.length > SKP_QUALIFICATION_LIMITS.sourceFiles) fail('SKP_QUALIFICATION_SOURCE_LIMIT');
    for (const child of children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (++visited > SKP_QUALIFICATION_LIMITS.sourceEntries) fail('SKP_QUALIFICATION_SOURCE_LIMIT');
      if (child.name === '.git' || /[\u0000-\u001f\u007f]/u.test(child.name) || child.isSymbolicLink()) fail('SKP_QUALIFICATION_SOURCE_INVALID');
      const next = `${relative}/${child.name}`;
      if (child.isDirectory()) await walk(next, depth + 1);
      else if (child.isFile()) await capture(next);
      else fail('SKP_QUALIFICATION_SOURCE_INVALID');
    }
  };
  const packageBytes = await capture('package.json'); await capture('package-lock.json');
  await capture('apps/vscode/package.json'); await capture('apps/vscode/tsconfig.json');
  for (const relative of SOURCE_ROOTS) await walk(relative, 0);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const packageJson = JSON.parse(packageBytes.toString('utf8'));
  if (typeof packageJson.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(packageJson.version)) fail('SKP_QUALIFICATION_SOURCE_INVALID');
  return { profile: 'bounded-checkout-byte-manifest/v1', sha256: identity(entries), files: entries.length, bytes: total,
    packageVersion: packageJson.version, dependencyInstall: 'not-verified',
    scope: [...SOURCE_ROOTS, 'package.json', 'package-lock.json', 'apps/vscode/package.json', 'apps/vscode/tsconfig.json'],
    selectedTests: SKP_QUALIFICATION_TARGETS.flatMap((target) => target.files).map((file) => {
      const entry = entries.find((value) => value.path === file);
      if (!entry) fail('SKP_QUALIFICATION_TARGET_UNAVAILABLE');
      return { path: file, sha256: entry.sha256 };
    }) };
}

async function localRuntime() {
  const created = await createGitRuntime({ trustedEnvironment: withoutGitProcessOverrides(process.env) });
  if (!created.ok) fail('SKP_QUALIFICATION_GIT_UNAVAILABLE');
  try {
    const opened = await created.value.openRepository(ROOT);
    if (!opened.ok) fail('SKP_QUALIFICATION_GIT_UNAVAILABLE');
    const reads = opened.value.beginInvocation(); const head = await reads.head(); const status = await reads.statusDetail({ untracked: 'all' });
    if (!head.ok || !status.ok || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head.value.oid ?? '')) fail('SKP_QUALIFICATION_GIT_UNAVAILABLE');
    const version = created.value.identity.version.match(/^git version (\d+\.\d+\.\d+)/u)?.[1];
    if (!version) fail('SKP_QUALIFICATION_GIT_UNAVAILABLE');
    return { platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node,
      osKernelVersion: os.release().match(/^\d+\.\d+\.\d+/u)?.[0] ?? null,
      supportedReleaseRuntime: 'not-attested',
      gitVersion: version, sourceRevision: head.value.oid, sourceDirty: status.value.entries.length > 0,
      linkedWorktree: opened.value.identity.gitDir !== opened.value.identity.commonDir };
  } finally { await created.value.dispose(); }
}

async function targetAvailable(target) {
  if (target.platforms && !target.platforms.includes(process.platform)) return false;
  if (!target.requiresExpect) return true;
  const info = await lstat('/usr/bin/expect').catch(() => null);
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

/** Only the fixed file/pattern manifest is executable; no user-selected modules or shell strings. */
export async function runQualificationTarget(target) {
  if (!SKP_QUALIFICATION_TARGETS.includes(target)) fail('SKP_QUALIFICATION_TARGET_INVALID');
  if (!(await targetAvailable(target))) return { id: target.id, status: 'unavailable', code: 'SKP_QUALIFICATION_LOCAL_PTY_UNAVAILABLE' };
  const args = ['--test', '--test-concurrency=2', `--test-reporter=${SELF}`];
  if (target.pattern) args.push(`--test-name-pattern=${target.pattern}`);
  args.push(...target.files);
  const env = withoutGitProcessOverrides(process.env);
  // Ambient Node injection and inherited test/reporter selection cannot change the fixed target.
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, { cwd: ROOT, env, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const began = Date.now(); const output = []; let bytes = 0; let stderrBytes = 0; let boundary = null; let cleanup = null; let cleanupAccepted = null;
  return new Promise((resolve) => {
    let timer; let cleanupTimer; let settled = false;
    const finish = (status, signal, closed) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(cleanupTimer);
      // A descendant may retain pipes after SIGKILL fails or the close acknowledgement never
      // arrives. The outer deadline must release local handles without claiming process exit.
      const detached = !closed ? detachUnclosedQualificationChild(child) : null;
      let report;
      try { report = JSON.parse(Buffer.concat(output).toString('utf8')); } catch { /* Missing/partial framing refuses. */ }
      const counts = report?.counts;
      const valid = report?.kind === 'skp-qualification-test-outcomes' && !report.refused
        && COUNT_KEYS.every((key) => Number.isSafeInteger(counts?.[key]) && counts[key] >= 0)
        && counts.tests > 0 && counts.tests === counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo;
      const passed = !boundary && closed && status === 0 && valid && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0;
      resolve({ id: target.id, status: passed ? 'passed' : 'failed', durationMs: Date.now() - began,
        processClosed: closed, exitCode: Number.isInteger(status) ? status : null,
        signal: signal === null || ['SIGKILL', 'SIGTERM'].includes(signal) ? signal : 'other',
        boundary, counts: valid ? counts : null, outcomes: valid ? report.outcomes : [],
        stderrBytes, cleanup: boundary ? { attempted: cleanup !== null, signalAccepted: cleanupAccepted,
          processClosed: closed, ...(detached ?? {}) } : 'not-needed',
        ...(passed ? {} : { code: boundary === 'timeout' ? 'SKP_QUALIFICATION_TIMEOUT' : boundary === 'output-limit'
          ? 'SKP_QUALIFICATION_OUTPUT_LIMIT' : 'SKP_QUALIFICATION_TESTS_INCOMPLETE' }) });
    };
    const terminate = (reason) => {
      if (boundary || settled) return; boundary = reason;
      cleanup = Promise.resolve(signalProcessTree(child, 'SIGKILL', { timeoutMs: 1000 }))
        .then((accepted) => { cleanupAccepted = accepted === true; }, () => { cleanupAccepted = false; });
      cleanupTimer = setTimeout(() => finish(null, 'SIGKILL', false), SKP_QUALIFICATION_LIMITS.cleanupTimeoutMs);
    };
    child.stdout.on('data', (chunk) => {
      if (boundary || settled) return; bytes += chunk.length;
      if (bytes + stderrBytes > SKP_QUALIFICATION_LIMITS.outputBytes) terminate('output-limit'); else output.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => { if (!settled) { stderrBytes += chunk.length; if (bytes + stderrBytes > SKP_QUALIFICATION_LIMITS.outputBytes) terminate('output-limit'); } });
    child.on('error', () => { if (!child.pid) finish(null, null, true); else terminate('spawn-error'); });
    child.on('close', async (status, signal) => { if (cleanup) await cleanup; finish(status, signal, true); });
    timer = setTimeout(() => terminate('timeout'), SKP_QUALIFICATION_LIMITS.targetTimeoutMs);
  });
}

export function qualificationAssessment({ executed, platform, results, sourceStable = true }) {
  const failed = results.some((result) => result.status === 'failed');
  const unavailable = results.some((result) => result.status === 'unavailable');
  const observed = executed && results.some((result) => result.status === 'passed');
  return { status: 'not-qualified', releaseQualified: false, nativeHostQualified: false, humanPilotQualified: false,
    localFixtures: !executed ? 'not-run' : !sourceStable ? 'source-changed' : failed ? 'failed' : !observed ? 'not-run' : unavailable ? 'passed-with-explicit-gaps' : 'passed',
    platforms: PLATFORMS.map((id) => ({ platform: id, status: id === platform && observed ? 'observed-local-fixtures' : 'missing',
      nativeHost: 'missing', installedArtifacts: 'missing', humanPilot: 'missing' })),
    blockers: [...(!sourceStable ? ['SKP_QUALIFICATION_SOURCE_CHANGED'] : []), ...(failed ? ['SKP_QUALIFICATION_TESTS_INCOMPLETE'] : []),
      'SKP_QUALIFICATION_NATIVE_MATRIX_MISSING', 'SKP_QUALIFICATION_INSTALLED_ARTIFACTS_MISSING',
      'SKP_HOST_ENFORCEMENT_UNAVAILABLE', 'SKP_QUALIFICATION_PILOT_MISSING'],
    requiredExternalEvidence: EXTERNAL };
}

export async function runSkpQualification(options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype || Object.keys(options).some((key) => !['execute', 'requireRelease'].includes(key))
      || typeof options.execute !== 'boolean' || typeof options.requireRelease !== 'boolean') fail('SKP_QUALIFICATION_OPTION_INVALID');
  const runtime = await localRuntime(); const source = await captureQualificationSource();
  const targets = await Promise.all(SKP_QUALIFICATION_TARGETS.map(async (target) => ({ ...target, available: await targetAvailable(target) })));
  const results = [];
  if (options.execute) for (const target of SKP_QUALIFICATION_TARGETS) results.push(await runQualificationTarget(target));
  const sourceAfter = options.execute ? await captureQualificationSource() : source;
  const runtimeAfter = options.execute ? await localRuntime() : runtime;
  const sourceStable = source.sha256 === sourceAfter.sha256 && runtime.sourceRevision === runtimeAfter.sourceRevision;
  const assessment = qualificationAssessment({ executed: options.execute, platform: runtime.platform, results, sourceStable });
  const report = { profile: SKP_QUALIFICATION_PROFILE, mode: options.execute ? 'execute-checkout-fixtures' : 'read-only-plan',
    runtime, source, sourceStable, targets, results, qualification: assessment, pilot: SKP_PILOT_PLAN,
    assurance: 'local-checkout-test-observation-only', acceptedImportedAttestations: false,
    effects: { fixtureProcessesStarted: options.execute, modelLaunched: false,
      productionSkillLaunched: false, importedUntrustedSkillLaunched: false, packageInstalled: false, sandboxApproved: false,
      humanAcceptanceFabricated: false, productionApprovalGranted: false } };
  return { report, exitCode: options.execute && (!sourceStable || results.some((result) => result.status === 'failed')) ? 1 : options.requireRelease ? 2 : 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try { const { report, exitCode } = await runSkpQualification(parseQualificationOptions(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); process.exitCode = exitCode;
  } catch (error) { process.stdout.write(`${JSON.stringify({ profile: SKP_QUALIFICATION_PROFILE, mode: 'refused',
    qualification: { status: 'not-qualified', releaseQualified: false, nativeHostQualified: false, humanPilotQualified: false }, code: safeCode(error) })}\n`); process.exitCode = 1; }
}

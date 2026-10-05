/** Production TRP adapter. Authenticated failure and unavailable outcomes never become passes. */
import { constants } from 'node:fs';
import { mkdir, open, readdir, lstat, realpath, stat } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from './records.mjs';
import { assertClean, exactChangedPathsBetweenObjects, exactFileAtObject, exactRemoteBranchObservationAsync, gitDir, governedCommitIdentity, head } from './git.mjs';
import { appendTrpRecord, loadTrpRecords, loadTrpAuthorityVerifier } from './test-recovery-store.mjs';
import { evaluateTestRecoveryGate, sealTrpRecord, trpDigest, validateTrpRecord } from './test-recovery-policy.mjs';
import { nowIso, secureRepositoryPath, ensureSecureRepositoryDirectory, SingularityFlowError } from './util.mjs';
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';
import { runQualityCommand, verifyCompletedQualityLaunch, verifyUnavailableQualityLaunch } from './quality-command-runner.mjs';
import { readTrpCaseInventory, matchTrpReports, snapshotTrpDeclaredRuntime, trpCaseInventoryDeclaration,
  trpExecutionEnvironment, trpNativeReportCapture, verifyTrpCaseInventorySources } from './test-recovery-adapters.mjs';
import { assertTestReportTargetEmpty, parseTestResult } from './code-delivery-tests.mjs';
import { applicationPathContext } from './application-paths.mjs';
import { nodeTestReporterEnvironment } from './verification/node-test-observation.mjs';
import { testRuntimeEnvironment } from './test-runtime.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const unsupported = (message, details = {}) => new SingularityFlowError(message, { code: 'TRP_RISK_ADAPTER_UNAVAILABLE', details });
const workRelative = (config, workflow) => path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
const privateWitnesses = new WeakMap();
const capturedLaunches = new WeakSet();
export const TRP_RUNTIME_RISK_CATEGORIES = Object.freeze(['validation-unavailable', 'new-test-failure', 'known-test-failure', 'reduced-coverage']);

export function storyTestRiskEnabled(workflow) {
  return workflow.resolution?.testRecovery?.enabled === true
    && workflow.resolution.testRecovery.enabledRiskCategories?.some(category => TRP_RUNTIME_RISK_CATEGORIES.includes(category)) === true;
}

async function boundedRead(filename) {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) throw unsupported('The retained TRP evidence is not an ordinary bounded file.');
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function originDirectory(root, create = false) {
  const base = await realpath(gitDir(root));
  let directory = base;
  for (const part of ['singularity-flow', 'trp-execution-origins']) {
    directory = path.join(directory, part);
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()
      || (part === 'trp-execution-origins' && process.platform !== 'win32'
        && ((info.mode & 0o077) || typeof process.getuid === 'function' && info.uid !== process.getuid()))) {
      throw unsupported('Execution origin storage must be private to this host user.');
    }
  }
  return directory;
}

async function installPrivate(filename, bytes) {
  let handle;
  try {
    handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(bytes); await handle.sync();
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await handle?.close(); }
  return boundedRead(filename);
}

async function originBinding(root, workflow, observation) {
  return canonicalJson({ purpose: 'trp-unavailable-runner-observation-v1', repository: await realpath(root),
    workId: workflow.workItem.id, observationSha256: observation.recordSha256 });
}

async function retainOrigin(root, workflow, observation, selection, report = null) {
  const directory = await originDirectory(root, true);
  const key = (await installPrivate(path.join(directory, 'origin.key'), randomBytes(32).toString('hex'))).toString();
  if (!/^[a-f0-9]{64}$/u.test(key)) throw unsupported('Execution origin key is invalid.');
  const proof = createHmac('sha256', Buffer.from(key, 'hex')).update(await originBinding(root, workflow, observation)).digest('hex');
  const saved = await installPrivate(path.join(directory, `${observation.recordSha256.slice(7)}.origin`), proof);
  if (saved.toString() !== proof) throw unsupported('Retained execution origin differs from the captured observation.');
  // Failed publication rolls Story files back. This authenticated host journal preserves
  // the exact attempted observation until its human decision transaction publishes it.
  const bundle = canonicalJson({ observation, selection });
  const retained = await installPrivate(path.join(directory, `${observation.recordSha256.slice(7)}.${observation.kind === 'test-baseline-manifest' ? 'baseline' : 'capture'}`), bundle);
  if (retained.toString() !== bundle) throw unsupported('Retained execution capture differs from the original.');
  for (const raw of report ? Array.isArray(report) ? report : [{ contents: report }] : []) {
    const bytes = raw.contents;
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (!observation.reportSha256s.includes(`sha256:${hash}`)) throw unsupported('A retained report is absent from the captured observation.');
    const savedReport = await installPrivate(path.join(directory, `${hash}.report`), bytes);
    if (!savedReport.equals(bytes)) throw unsupported('Retained report differs from the native runner output.');
  }
}

function reportPath(config, workflow, observation, sha256 = observation.reportSha256s[0]) {
  return `${workRelative(config, workflow)}/context/test-recovery/reports/${sha256.slice(7)}.xml`;
}

async function authenticatedFailedReport(root, config, workflow, observation, { evidenceCommit = null } = {}) {
  if (!['failed', 'passed'].includes(observation.observedOutcome) || observation.reportStatus !== 'current'
    || !observation.reportSha256s.length || observation.reportSha256s.length > 256 || observation.identityCompleteness !== 'complete'
    || !Number.isInteger(observation.processExitCode) || observation.counts.notRun
    || observation.observedOutcome === 'failed' && (observation.processExitCode === 0 || observation.counts.failed < 1)
    || observation.observedOutcome === 'passed' && (observation.processExitCode !== 0 || observation.counts.failed > 0)) return false;
  try {
    const rawReports = [];
    for (const sha256 of observation.reportSha256s) {
      let bytes;
      const relative = reportPath(config, workflow, observation, sha256);
      if (evidenceCommit) bytes = exactFileAtObject(root, evidenceCommit, relative, { maximumBytes: MAX_BYTES });
      else {
        const target = await secureRepositoryPath(root, relative, { label: 'Retained native test report', type: 'file' });
        bytes = target.exists ? await boundedRead(target.absolute)
          : await boundedRead(path.join(await originDirectory(root), `${sha256.slice(7)}.report`));
      }
      if (!bytes || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== sha256) return false;
      rawReports.push({ contents: bytes });
    }
    const inventory = workflow.resolution?.testRecovery?.caseInventory?.find(entry =>
      entry.phaseId === observation.subject.phaseId && entry.commandId === observation.obligationId);
    if (!inventory) return false;
    const tests = inventory.tests.filter(entry => observation.expectedTestIds.includes(entry.id)).map(entry => ({ ...entry,
      semanticsSha256: observation.cases.find(candidate => candidate.id === entry.id)?.semanticsSha256 }));
    const parsed = await matchTrpReports(root, { tests, adapter: inventory.adapter }, rawReports, {
      allowSkipped: workflow.resolution.testRecovery.enabledRiskCategories.includes('reduced-coverage'), expectedOutcome: observation.observedOutcome });
    const orderedCases = entries => [...entries].sort((left, right) => left.id.localeCompare(right.id));
    return canonicalJson(orderedCases(parsed.cases)) === canonicalJson(orderedCases(observation.cases))
      && canonicalJson(parsed.counts) === canonicalJson(observation.counts);
  } catch { return false; }
}

async function authenticOrigin(root, workflow, observation) {
  try {
    const directory = await originDirectory(root);
    const keyPath = path.join(directory, 'origin.key');
    const proofPath = path.join(directory, `${observation.recordSha256.slice(7)}.origin`);
    for (const filename of [keyPath, proofPath]) {
      const info = await lstat(filename);
      if (process.platform !== 'win32' && ((info.mode & 0o077) || typeof process.getuid === 'function' && info.uid !== process.getuid())) return false;
    }
    const key = (await boundedRead(keyPath)).toString();
    const proof = (await boundedRead(proofPath)).toString();
    if (!/^[a-f0-9]{64}$/u.test(key) || !/^[a-f0-9]{64}$/u.test(proof)) return false;
    return timingSafeEqual(Buffer.from(proof, 'hex'), createHmac('sha256', Buffer.from(key, 'hex'))
      .update(await originBinding(root, workflow, observation)).digest());
  } catch { return false; }
}

async function retainedCaptures(root, workflow) {
  let directory;
  try { directory = await originDirectory(root); }
  catch { return []; }
  const names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.capture$/u.test(name));
  if (names.length > 4096) throw unsupported('Execution capture journal exceeds its inspection bound.');
  const records = [];
  for (const name of names) {
    const bundle = JSON.parse((await boundedRead(path.join(directory, name))).toString());
    validateTrpRecord(bundle.observation, { kind: 'phase-validation-observation' });
    validateTrpRecord(bundle.selection, { kind: 'test-selection-manifest' });
    if (bundle.observation.subject.workId !== workflow.workItem.id) continue;
    if (bundle.observation.selectionSha256 !== bundle.selection.recordSha256
      || name !== `${bundle.observation.recordSha256.slice(7)}.capture`
      || !await authenticOrigin(root, workflow, bundle.observation)) throw unsupported('Retained execution capture could not be authenticated.');
    records.push(bundle.observation, bundle.selection);
  }
  return records;
}

async function candidateContext(root, config, workflow, selection) {
  const { sourceTreeHash } = await import('./state.mjs');
  const sourceManifestSha256 = await sourceTreeHash(root, config, workflow);
  const phase = workflow.phases[selection.subject.phaseId];
  const { resolveDeliveryQualityCommands } = await import('./delivery-evidence.mjs');
  const commands = (await resolveDeliveryQualityCommands(root, phase,
    { executionMode: workflow.resolution?.testExecutionMode })).filter(command => command?.kind === 'test');
  const exactCases = selection.selectedTestIds.length > 0;
  const declaration = commands.length === 1 ? trpCaseInventoryDeclaration(workflow, phase, commands[0]) : null;
  const adapter = declaration?.adapter ?? 'node-test-junit-v1';
  const declaredRuntime = exactCases ? await snapshotTrpDeclaredRuntime(root, declaration, commands[0]) : null;
  const buildRoot = adapter === 'maven-surefire-junit-v1'
    ? path.posix.normalize(path.posix.join(commands[0].workingDirectory ?? '.', 'target')) : null;
  const under = (candidate, prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`);
  let localDependenciesSha256 = null;
  let stableInputsSha256 = null;
  let compatibilityFilesystemSha256 = null;
  if (exactCases) {
    // Include ignored installed dependencies and data. Only approved framework-owned state and
    // the exact authenticated runner output target are outside this local dependency closure.
    const context = applicationPathContext(config, workflow);
    const reports = new Set(commands.map(command => path.posix.normalize(path.posix.join(command.workingDirectory ?? '.', command.result.path))));
    const manifest = []; let bytesRead = 0; let entryCount = 0;
    const excluded = relative => relative === '.git' || relative.startsWith('.git/')
      || context.governedRoots.some(value => relative === value || relative.startsWith(`${value}/`))
      || context.governedPaths.includes(relative) || reports.has(relative);
    const visit = async (absolute, relative = '') => {
      for (const name of (await readdir(absolute)).sort()) {
        const child = relative ? `${relative}/${name}` : name;
        if (excluded(child)) continue;
        if (++entryCount > 16_384) throw unsupported('The repository-local execution dependency inventory exceeds its entry bound.');
        const filename = path.join(absolute, name); const info = await lstat(filename);
        if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw unsupported('Execution dependency snapshots require ordinary repository-contained files and directories.');
        if (info.isDirectory()) {
          manifest.push({ path: child, type: 'directory', mode: info.mode & 0o7777 });
          await visit(filename, child);
          const after = await lstat(filename);
          if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino
            || after.mode !== info.mode || after.mtimeMs !== info.mtimeMs) throw unsupported('A local execution dependency directory changed during snapshot capture.');
          continue;
        }
        if (info.nlink !== 1 || info.size > MAX_BYTES || (bytesRead += info.size) > 64 * 1024 * 1024) throw unsupported('The local execution dependency snapshot exceeds its safe file/byte bound.');
        const contents = await boundedRead(filename); const after = await lstat(filename);
        if (!after.isFile() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino
          || after.mode !== info.mode || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw unsupported('A local execution dependency changed during snapshot capture.');
        manifest.push({ path: child, type: 'file', mode: info.mode & 0o7777, sha256: `sha256:${createHash('sha256').update(contents).digest('hex')}` });
      }
    };
    const canonicalRoot = await realpath(root); const beforeRoot = await lstat(canonicalRoot);
    manifest.push({ path: '.', type: 'directory', mode: beforeRoot.mode & 0o7777 });
    await visit(canonicalRoot);
    const afterRoot = await lstat(canonicalRoot);
    if (!afterRoot.isDirectory() || afterRoot.isSymbolicLink() || afterRoot.dev !== beforeRoot.dev
      || afterRoot.ino !== beforeRoot.ino || afterRoot.mode !== beforeRoot.mode || afterRoot.mtimeMs !== beforeRoot.mtimeMs) {
      throw unsupported('The local execution dependency root changed during snapshot capture.');
    }
    localDependenciesSha256 = trpDigest(manifest);
    const stableManifest = manifest.filter(entry => !buildRoot || !under(entry.path, buildRoot));
    stableInputsSha256 = trpDigest(stableManifest);
    // Only ordinary product source is mutable. A broad source root never drops nested tests,
    // fixtures, configuration, manifests, data, or an independently approved testcase.
    const protectedPath = relative => /(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__|config|configuration|node_modules|vendor|target|build|dist|\.venv|venv)(?:\/|$)/iu.test(relative)
      || /(?:^|\/)(?:conftest|pytest|setup|settings|pom|package|requirements|pyproject|tox|Pipfile|Cargo|go)(?:[.-]|$)/iu.test(path.posix.basename(relative))
      || /(?:^|[._-])(?:test|spec|config)(?:[._-]|$)/iu.test(path.posix.basename(relative))
      || declaration?.tests.some(test => test.path === relative);
    compatibilityFilesystemSha256 = trpDigest(stableManifest.filter(entry => protectedPath(entry.path)
      || !(declaration?.baselineMutableRoots ?? []).some(prefix => under(entry.path, prefix))
      || entry.type === 'file' && !/\.(?:[cm]?js|jsx|tsx?|py|java)$/u.test(entry.path)));
  }
  const resolution = [];
  for (const command of commands) {
    const executable = command.argv?.[0];
    if (!executable) throw unsupported('Only structured native executable launch failures are supported.');
    const candidates = executable.includes('/') || executable.includes('\\')
      ? [path.resolve(root, command.workingDirectory ?? '.', executable)]
      : String(process.env.PATH ?? '').split(path.delimiter).map(directory => path.resolve(directory, executable));
    for (const candidate of candidates) {
      const info = await lstat(candidate).catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; });
      const resolved = info ? await realpath(candidate).catch(error => { if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null; throw error; }) : null;
      const target = resolved ? await stat(resolved) : null;
      resolution.push({ pathSha256: trpDigest(candidate), available: Boolean(info),
        resolvedAvailable: Boolean(target), resolvedSha256: resolved ? trpDigest(resolved) : null,
        targetIdentity: target ? trpDigest({ size: target.size, mtimeMs: target.mtimeMs, mode: target.mode, ino: target.ino, dev: target.dev }) : null,
        identity: info ? trpDigest({ size: info.size, mtimeMs: info.mtimeMs, mode: info.mode, ino: info.ino, dev: info.dev }) : null });
    }
  }
  const resolutionKeys = new Set(['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'NODE_OPTIONS']);
  const testEnvironment = testRuntimeEnvironment(workflow.resolution?.testRuntime);
  const runtimeSha256 = trpDigest({ executable: process.execPath, version: process.version,
    environment: exactCases ? testRuntimeEnvironment(workflow.resolution?.testRuntime,
      trpExecutionEnvironment(declaration, process.env, { cwd: await realpath(path.resolve(root, commands[0].workingDirectory ?? '.')) }))
      : Object.fromEntries(Object.entries(testEnvironment).filter(([key]) => resolutionKeys.has(key.toUpperCase())).sort()), resolution });
  const environment = { hostId: os.hostname(), platform: process.platform, arch: process.arch, runtimeSha256,
    dependencySha256: localDependenciesSha256 ?? sourceManifestSha256, runnerSha256: selection.commandSha256,
    adapterSha256: trpDigest(exactCases ? `trp-${adapter}` : 'trp-unavailable-runner-v1'), configurationSha256: selection.commandInventorySha256,
    externalDependenciesSha256: declaredRuntime?.sha256 ?? null };
  const stableInputSha256 = trpDigest({ sourceManifestSha256, stableInputsSha256,
    environment: { ...environment, dependencySha256: stableInputsSha256 ?? sourceManifestSha256 } });
  const baselineCompatibility = exactCases ? trpDigest({ filesystem: compatibilityFilesystemSha256,
    declaration, environment: { ...environment, dependencySha256: compatibilityFilesystemSha256 } }) : null;
  return { sourceManifestSha256, environment, stableInputSha256,
    unresolvedExecutable: resolution.every(item => !item.resolvedAvailable), dependencies: [
    { id: 'application-source-and-dependencies', sha256: sourceManifestSha256 },
    { id: 'approved-command-inventory', sha256: selection.commandInventorySha256 },
    { id: 'approved-runner-command', sha256: selection.commandSha256 },
    { id: 'approved-selector', sha256: selection.selectorSha256 },
    ...(localDependenciesSha256 ? [{ id: 'repository-local-execution-dependencies', sha256: localDependenciesSha256 }] : []),
    ...(baselineCompatibility ? [{ id: 'baseline-compatibility', sha256: baselineCompatibility }] : [])
  ] };
}

/** Called only around the real host quality runner; no authority is granted by this capture. */
export async function beginStoryTestRiskRun(root, config, workflow, phase, { commands, selection }) {
  if (!storyTestRiskEnabled(workflow)) return null;
  const tests = commands.filter(command => command?.kind === 'test');
  if (tests.length !== 1 || !selection || selection.selectedSuites.length !== 1
    || selection.selectedSuites[0] !== tests[0].id) throw unsupported('Test-risk review currently supports one exact structured test command per phase.');
  validateTrpRecord(selection, { kind: 'test-selection-manifest' });
  if (trpDigest(tests.map(({ selectionAdapter: _selectionAdapter, ...command }) => command)) !== selection.commandSha256) {
    throw unsupported('The launch command differs from the sealed test selection.');
  }
  const { loadStoryTestRecoveryAgreement } = await import('./state.mjs');
  const agreement = await loadStoryTestRecoveryAgreement(root, config, workflow);
  if (agreement.recordSha256 !== selection.agreementSha256 || selection.subject.workId !== workflow.workItem.id
    || selection.subject.phaseId !== phase.id) throw unsupported('The launch selection belongs to a different Story agreement or phase.');
  const { evaluateCodeDeliveryPreflight } = await import('./delivery-evidence.mjs');
  const { resolveTrpDeliverySelection } = await import('./trp-delivery-selection.mjs');
  const delivery = phase.deliveryEvidence && phase.generationIntent?.status !== 'open'
    ? phase.deliveryEvidence : await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  const declared = workflow.resolution.phases?.find(item => item.id === phase.id)?.qualityCommands ?? [];
  const fresh = await resolveTrpDeliverySelection(root, config, workflow, phase, delivery, declared, { previewOnly: true });
  if (!fresh.preview?.ready || ['commandInventorySha256', 'commandSha256', 'selectorSha256', 'candidateDeltaSha256']
    .some(key => fresh.selection?.[key] !== selection[key])) throw unsupported('The launch selection no longer matches the approved command and candidate.');
  const selectionCore = ({ id: _id, createdAt: _at, issuer: _issuer, provenance: _provenance, recordSha256: _sha, ...core }) => core;
  if (canonicalJson(selectionCore(selection)) !== canonicalJson(selectionCore(fresh.selection))) {
    throw unsupported('The launch selection differs from the exact current scope and generation.');
  }
  const caseInventory = await readTrpCaseInventory(root, workflow, phase, tests[0], { selected: true });
  if (caseInventory && (selection.selectedTestIds.length !== caseInventory.tests.length
    || caseInventory.tests.some(entry => !selection.selectedTestIds.includes(entry.id)))) {
    throw unsupported('The selected test case identities differ from the independently approved cohort.');
  }
  if (caseInventory) {
    // The execution runner already creates this exact approved output parent. Create it before
    // sealing dependencies so its first appearance cannot invalidate the run that needs it.
    // Read-only plans do not call this execution boundary and never create directories.
    const report = path.posix.normalize(path.posix.join(tests[0].workingDirectory ?? '.', tests[0].result.path));
    await ensureSecureRepositoryDirectory(root, path.posix.dirname(report), { label: 'TRP native report parent' });
  }
  const candidate = await candidateContext(root, config, workflow, selection);
  const witness = Object.freeze({});
  const cwd = await realpath(path.resolve(root, tests[0].workingDirectory ?? '.'));
  let environment = caseInventory ? trpExecutionEnvironment(caseInventory.declaration, process.env, { cwd }) : { ...process.env };
  environment = testRuntimeEnvironment(workflow.resolution?.testRuntime, environment);
  if (tests[0].result?.adapter === 'node-tap') environment = nodeTestReporterEnvironment(environment, root, { argv: tests[0].argv, cwd });
  delete environment.NODE_TEST_CONTEXT;
  if (tests[0].result?.adapter === 'playwright-json') {
    for (const key of Object.keys(environment)) if (key.toUpperCase() === 'PLAYWRIGHT_JSON_OUTPUT_FILE') delete environment[key];
    environment.PLAYWRIGHT_JSON_OUTPUT_FILE = path.resolve(cwd, tests[0].result.path);
  }
  const captured = { selection, candidate, caseInventory, testCommand: tests[0],
    stdoutFile: caseInventory && caseInventory.adapter !== 'node-test-junit-v1' ? null : path.resolve(cwd, tests[0].result.path),
    reportCapture: trpNativeReportCapture(root, tests[0], caseInventory?.declaration),
    commandId: tests[0].id, command: tests[0].argv[0], args: tests[0].argv.slice(1),
    cwd, environmentSha256: createHash('sha256').update(JSON.stringify(Object.entries(environment).sort())).digest('hex'),
    startedAt: nowIso(), sourceRevision: head(root) };
  privateWitnesses.set(witness, structuredClone(captured));
  return Object.freeze({ witness, ...captured });
}

/** Native launch failures and independently inventoried actual test failures retain distinct outcomes. */
export async function captureStoryTestRiskObservation(root, config, workflow, phase, { run, check, result }) {
  if (!run || !privateWitnesses.has(run.witness)) throw unsupported('A live runtime observation is required.');
  const expected = privateWitnesses.get(run.witness);
  privateWitnesses.delete(run.witness);
  const { witness: _witness, ...provided } = run;
  if (canonicalJson(expected) !== canonicalJson(provided)) throw unsupported('The captured execution candidate was altered.');
  const unavailable = verifyUnavailableQualityLaunch(result, expected);
  const completed = verifyCompletedQualityLaunch(result, expected);
  if (check?.id !== run.commandId || capturedLaunches.has(result) || check.timedOut) return null;
  let report = null; let failed = null;
  const unavailableRun = check.status === 'blocked' && unavailable && check.infrastructureUnavailable && run.candidate.unresolvedExecutable;
  const categories = workflow.resolution.testRecovery.enabledRiskCategories;
  const failedRun = run.caseInventory && completed && ((check.status === 'failed' && completed.status > 0
    && categories.some(category => ['new-test-failure', 'known-test-failure', 'reduced-coverage'].includes(category)))
    || check.status === 'passed' && completed.status === 0 && categories.includes('reduced-coverage'));
  if (!unavailableRun && !failedRun) return null;
  const launch = unavailableRun ? unavailable : completed;
  if (Date.parse(launch.startedAt) < Date.parse(run.startedAt)) return null;
  if (failedRun) {
    const parsed = await parseTestResult(root, run.testCommand, { startedAt: launch.startedAt });
    if (parsed.tests.discovered < parsed.minimumDiscovered) throw unsupported('The failed run discovered fewer tests than its independently required minimum; new-test-failure cannot waive missing coverage.');
    if (parsed.rawReports.some(raw => raw.contents.length > MAX_BYTES)) throw unsupported('A native report exceeds the retained evidence limit.');
    if (run.caseInventory.adapter === 'node-test-junit-v1') {
      if (parsed.rawReports.length !== 1 || `sha256:${parsed.rawReports[0].sha256}` !== launch.stdoutSha256
        || parsed.rawReports[0].bytes !== launch.stdoutBytes) throw unsupported('The current report is not the exact native runner output.');
    } else {
      const metadata = parsed.rawReports.map(({ sourcePath, sha256, bytes }) => ({ sourcePath, sha256, bytes }));
      if (!launch.reports || canonicalJson(metadata) !== canonicalJson(launch.reports)) throw unsupported('Native completion did not authenticate this exact report set.');
    }
    report = parsed.rawReports;
    failed = await matchTrpReports(root, run.caseInventory, report, { allowSkipped: categories.includes('reduced-coverage'),
      expectedOutcome: launch.status === 0 ? 'passed' : 'failed' });
    if (launch.status === 0 && !failed.counts.skipped) return null;
  }
  const current = await candidateContext(root, config, workflow, run.selection);
  await verifyTrpCaseInventorySources(root, run.caseInventory);
  if (run.caseInventory?.adapter === 'maven-surefire-junit-v1'
    ? current.stableInputSha256 !== run.candidate.stableInputSha256
    : canonicalJson(current) !== canonicalJson(run.candidate)) throw unsupported('Source, commands, dependencies or environment changed during the runner attempt.');
  capturedLaunches.add(result);
  const createdAt = nowIso();
  const core = { schemaVersion: 1, kind: 'phase-validation-observation',
    subject: run.selection.subject, createdAt, issuer: { principal: 'trp-runtime', channel: 'local-runner-v1' },
    provenance: { authorityRef: workflow.testRecovery.policyAuthoritySha256, evidenceRefs: [run.selection.recordSha256] },
    obligationId: run.commandId, agreementSha256: run.selection.agreementSha256, selectionSha256: run.selection.recordSha256,
    sourceRevision: run.sourceRevision, sourceManifestSha256: current.sourceManifestSha256,
    commandInventorySha256: run.selection.commandInventorySha256, commandSha256: run.selection.commandSha256,
    selectorSha256: run.selection.selectorSha256, dependencies: current.dependencies, environment: current.environment,
    startedAt: launch.startedAt, completedAt: launch.completedAt, processExitCode: failed ? launch.status : null,
    reportStatus: failed ? 'current' : 'missing', reportSha256s: failed?.reportSha256s ?? [],
    expectedTestIds: failed ? run.caseInventory.tests.map(entry => entry.id) : [], cases: failed?.cases ?? [],
    counts: failed?.counts ?? { discovered: 0, passed: 0, failed: 0, skipped: 0, notRun: 0 }, identityCompleteness: failed ? 'complete' : 'incomplete',
    observedOutcome: failed ? launch.status === 0 ? 'passed' : 'failed' : 'unavailable', diagnostics: [redactDiagnosticText(check.stderr ?? 'Runner unavailable').slice(0, 2000)], executionOrigin: 'executed' };
  const observation = sealTrpRecord({ ...core, id: `run-${trpDigest(core).slice(7, 39)}` });
  const workRoot = path.join(root, workRelative(config, workflow));
  await appendTrpRecord(workRoot, run.selection);
  await appendTrpRecord(workRoot, observation);
  await retainOrigin(root, workflow, observation, run.selection, report);
  return observation;
}

/** Read-only common context for CLI plans and every lifecycle consumer. */
export async function loadStoryTestRiskContext(root, config, workflow, {
  phaseId = workflow.currentPhase, operation = 'publish', repositoryId = null, at = nowIso(),
  generation = null, selection = null, mode = 'current', observationSha256 = null, evidenceCommit = null
} = {}) {
  const { loadStoryTestRecoveryAgreement, storyPublicationPending, workflowPublicationBranch } = await import('./state.mjs');
  const { storyTestRiskAuthorityContext } = await import('./story-test-risk.mjs');
  const agreement = await loadStoryTestRecoveryAgreement(root, config, workflow);
  if (!agreement) throw unsupported('This Story has no accepted test-policy agreement.');
  const phase = workflow.phases?.[phaseId];
  if (!phase) throw unsupported('The selected phase is absent from the Story.');
  const repository = repositoryId == null
    ? (agreement.repositories.length === 1 ? agreement.repositories[0] : null)
    : agreement.repositories.find(row => row.repositoryId === repositoryId);
  if (!repository) throw unsupported(repositoryId == null
    ? 'Bind an exact repository before inspecting this multi-repository Story.'
    : 'The selected repository is absent from the accepted Story agreement.');
  const workRoot = path.join(root, workRelative(config, workflow));
  const records = await loadTrpRecords(workRoot);
  for (const record of await retainedCaptures(root, workflow)) {
    if (!records.some(item => item.recordSha256 === record.recordSha256)) records.push(record);
  }
  const matching = records.filter(record => record.kind === 'phase-validation-observation'
    && record.subject.workId === workflow.workItem.id && record.subject.repositoryId === repository.repositoryId
    && repository.mandatoryObligations.some(obligation => obligation.kind === 'test' && obligation.id === record.obligationId)
    && record.subject.phaseId === phaseId && record.subject.validationEpoch === Number(workflow.testRecovery.validationEpoch ?? 1)
    && (generation == null || record.subject.generation === generation)
    && (!observationSha256 || record.recordSha256 === observationSha256));
  matching.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const observation = matching[0] ?? null;
  selection ??= records.find(record => record.kind === 'test-selection-manifest' && record.recordSha256 === observation?.selectionSha256) ?? null;
  const subject = { workId: workflow.workItem.id, repositoryId: repository.repositoryId, phaseId,
    generation: generation ?? observation?.subject.generation ?? Number(phase.generation || 1),
    validationEpoch: Number(workflow.testRecovery.validationEpoch ?? 1) };
  const authority = storyTestRiskAuthorityContext(workflow, agreement);
  if (mode === 'historical' && (!evidenceCommit || !observation)) throw unsupported('Historical replay requires the exact committed observation.');
  const pending = mode === 'historical' ? null : await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false });
  const localOnly = config.git?.publish === 'off' && workflow.resolution?.capability?.policy?.gitPublication !== 'required';
  const localCommit = mode === 'historical' ? evidenceCommit : head(root);
  let remoteAcknowledgedCommit = null;
  if (!localOnly && !pending) {
    const remote = await exactRemoteBranchObservationAsync(root, config.git?.remote ?? 'origin', workflowPublicationBranch(root, workflow));
    remoteAcknowledgedCommit = remote?.sha ?? remote?.commit ?? null;
  }
  let verifyAuthority = () => null;
  let publicationPending = Boolean(pending);
  try {
    verifyAuthority = await loadTrpAuthorityVerifier({ root, workRoot, ...authority, localCommit,
      remoteAcknowledgedCommit, localOnly, records });
  } catch (error) {
    if (['TRP_PUBLICATION_PENDING', 'TRP_PUBLICATION_UNVERIFIED'].includes(error.code)) publicationPending = true;
    else throw error;
  }
  const candidate = mode === 'historical' ? { sourceManifestSha256: observation.sourceManifestSha256,
    dependencies: observation.dependencies, environment: observation.environment }
    : selection ? await candidateContext(root, config, workflow, selection) : null;
  const observations = observation ? [observation] : [];
  const baselines = records.filter(record => record.kind === 'test-baseline-manifest'
    && repository.baselineRefs.includes(record.recordSha256) && record.subject.workId === workflow.workItem.id
    && record.subject.repositoryId === repository.repositoryId);
  const authenticated = new Set();
  for (const record of [...observations, ...baselines]) {
    if (!await authenticOrigin(root, workflow, record)) continue;
    const unavailable = record.observedOutcome === 'unavailable' && record.processExitCode === null && record.reportStatus === 'missing'
      && !record.cases.length && !record.expectedTestIds.length && !record.reportSha256s.length && record.identityCompleteness === 'incomplete';
    if (!unavailable && !await authenticatedFailedReport(root, config, workflow, record, { evidenceCommit })) continue;
    if (evidenceCommit) {
      const relative = `${workRelative(config, workflow)}/context/test-recovery/${record.kind === 'test-baseline-manifest' ? 'baselines' : 'runs'}/${record.id}.json`;
      const bytes = exactFileAtObject(root, evidenceCommit, relative, { maximumBytes: MAX_BYTES });
      if (!bytes || canonicalJson(JSON.parse(bytes.toString())) !== canonicalJson(record)) continue;
    }
    authenticated.add(record.recordSha256);
  }
  const verifyEvidence = record => authenticated.has(record.recordSha256)
    ? { recordSha256: record.recordSha256, authenticated: true, reportsAvailable: true,
      verifiedAt: mode === 'historical' ? nowIso() : at } : null;
  const decisions = records.filter(record => record.kind === 'phase-risk-decision');
  const integrityIssues = [];
  if (['failed', 'passed'].includes(observation?.observedOutcome) && !authority.policy.allowEvidenceReuse) {
    integrityIssues.push({ category: 'policy-integrity', obligationId: observation.obligationId,
      message: 'Retaining failed execution evidence requires explicit pinned evidence-reuse permission.' });
  }
  const phaseObligations = repository.mandatoryObligations.filter(item => !item.phaseIds || item.phaseIds.includes(phaseId));
  if (!phaseObligations.some(item => item.transitions.includes(operation))) {
    integrityIssues.push({ category: 'policy-integrity', obligationId: 'operation', message: 'The pinned agreement does not declare this transition; no risk permission can be inferred.' });
  }
  if (authority.policy.enabledRiskCategories.some(category => !TRP_RUNTIME_RISK_CATEGORIES.includes(category) && category !== 'nonessential-document')) {
    integrityIssues.push({ category: 'policy-integrity', obligationId: 'runtime-adapter', message: 'This runtime supports only qualified unavailable or native Node test-failure risk; other risks require a qualified evidence adapter.' });
  }
  if (selection && phaseObligations.filter(item => item.kind === 'test' && item.transitions.includes(operation)).some(item =>
    !selection.selectedSuites.includes(item.id))) {
    integrityIssues.push({ category: 'policy-integrity', obligationId: 'phase-obligations', message: 'Pinned phase obligations do not match this adapter’s exact command inventory.' });
  }
  const evaluation = evaluateTestRecoveryGate({ ...authority, agreement, subject, operation, at, mode,
    obligationIds: phaseObligations.filter(item => item.kind === 'test' && item.transitions.includes(operation)).map(item => item.id),
    observations, baselines, decisions, selection, candidateDependencies: candidate?.dependencies ?? [],
    candidateEnvironment: candidate?.environment ?? null, verifyAuthority, verifyEvidence, integrityIssues, publicationPending });
  return { ...authority, agreement, phase, subject, selection, records, observations, baselines, decisions,
    evaluation, candidate, candidateDependencies: candidate?.dependencies ?? [], candidateEnvironment: candidate?.environment ?? null,
    verifyAuthority, verifyEvidence, publicationPending, localCommit, remoteAcknowledgedCommit };
}

/** Called under the decision transaction lock; a private journal alone never grants permission. */
export async function materializeStoryTestRiskEvidence(root, config, workflow, context) {
  const workRoot = path.join(root, workRelative(config, workflow));
  for (const observation of context.observations ?? []) {
    if (!await authenticOrigin(root, workflow, observation)
      || observation.agreementSha256 !== workflow.testRecovery.agreementSha256
      || observation.selectionSha256 !== context.selection?.recordSha256) throw unsupported('The exact captured observation is no longer available.');
    await appendTrpRecord(workRoot, context.selection);
    await appendTrpRecord(workRoot, observation);
    if (['failed', 'passed'].includes(observation.observedOutcome)) {
      if (!await authenticatedFailedReport(root, config, workflow, observation)) throw unsupported('The authenticated failed-test report is no longer available.');
      for (const sha256 of observation.reportSha256s) {
        const relative = reportPath(config, workflow, observation, sha256);
        await ensureSecureRepositoryDirectory(root, path.posix.dirname(relative), { label: 'TRP native test reports' });
        const target = await secureRepositoryPath(root, relative, { label: 'TRP native test report', type: 'file' });
        const report = await boundedRead(path.join(await originDirectory(root), `${sha256.slice(7)}.report`));
        const saved = await installPrivate(target.absolute, report);
        if (!saved.equals(report)) throw unsupported('The published native report differs from the exact native output.');
      }
    }
  }
}

/** A post-submission risk review may add authority records; it cannot alter submitted evidence. */
export async function verifiedStoryTestRiskReviewCommits(root, config, workflow, context, commits) {
  const allowed = new Set();
  const relative = workRelative(config, workflow);
  const workflowPath = `${relative}/workflow.json`;
  const families = { 'phase-risk-decision': 'decisions', 'phase-risk-revocation': 'revocations',
    'story-test-recovery-agreement': 'agreements' };
  for (const commit of commits) {
    try {
      const identity = governedCommitIdentity(root, commit);
      if (identity?.parents.length !== 1) continue;
      const beforeBytes = exactFileAtObject(root, identity.parents[0], workflowPath, { maximumBytes: MAX_BYTES });
      const afterBytes = exactFileAtObject(root, commit, workflowPath, { maximumBytes: MAX_BYTES });
      if (!beforeBytes || !afterBytes) continue;
      const before = JSON.parse(beforeBytes.toString());
      const after = JSON.parse(afterBytes.toString());
      const beforeReviews = before.testRecovery?.riskReviews ?? [];
      const afterReviews = after.testRecovery?.riskReviews ?? [];
      const beforeProjections = before.publicationProjections ?? [];
      const afterProjections = after.publicationProjections ?? [];
      if (afterReviews.length !== beforeReviews.length + 1 || afterProjections.length !== beforeProjections.length + 1
        || canonicalJson(afterReviews.slice(0, -1)) !== canonicalJson(beforeReviews)
        || canonicalJson(afterProjections.slice(0, -1)) !== canonicalJson(beforeProjections)) continue;
      const review = afterReviews.at(-1);
      const event = afterProjections.at(-1).event;
      const unboundLocalEvent = event?.sourceCommit == null && config.git?.publish === 'off'
        && workflow.resolution?.capability?.policy?.gitPublication !== 'required';
      if (!['accepted', 'attested', 'revoked'].includes(review.action) || event?.type !== `test-risk-${review.action}`
        || event.phaseId !== context.subject.phaseId || (event.sourceCommit !== identity.parents[0] && !unboundLocalEvent)
        || identity.eventSha256 !== trpDigest(event) || event.payload?.record?.recordSha256 !== review.record?.recordSha256) continue;
      const record = context.records.find(item => item.recordSha256 === review.record.recordSha256);
      const receipt = context.records.find(item => item.recordSha256 === review.authorityReceipt?.recordSha256);
      if (!record || !receipt || !families[record.kind] || receipt.kind !== 'trp-authority-receipt'
        || receipt.authorizedRecordSha256 !== record.recordSha256
        || (record.kind === 'story-test-recovery-agreement' ? record.recordSha256 !== context.agreement.recordSha256
          : record.subject.phaseId !== context.subject.phaseId || record.subject.generation !== context.subject.generation)
        || !context.verifyAuthority(record, { policy: context.policy })) continue;
      const recordPath = `${relative}/context/test-recovery/${families[record.kind]}/${record.kind === 'story-test-recovery-agreement' ? `revision-${record.revision}` : record.id}.json`;
      const receiptPath = `${relative}/context/test-recovery/authorizations/${receipt.id}.json`;
      const permitted = new Set([workflowPath, `${relative}/STATUS.md`, recordPath, receiptPath]);
      const changed = exactChangedPathsBetweenObjects(root, identity.parents[0], commit);
      if (changed.some(filename => !permitted.has(filename))) continue;
      for (const [filename, expected] of [[recordPath, record], [receiptPath, receipt]]) {
        const bytes = exactFileAtObject(root, commit, filename, { maximumBytes: MAX_BYTES });
        if (!bytes || canonicalJson(JSON.parse(bytes.toString())) !== canonicalJson(expected)) throw new Error('review bytes differ');
      }
      after.testRecovery.riskReviews = beforeReviews;
      if (!Object.hasOwn(before.testRecovery, 'riskReviews')) delete after.testRecovery.riskReviews;
      after.publicationProjections = beforeProjections;
      if (!Object.hasOwn(before, 'publicationProjections')) delete after.publicationProjections;
      if (canonicalJson(after) !== canonicalJson(before)) continue;
      allowed.add(commit);
    } catch { /* An unrelated, malformed or unauthenticated commit still requires resubmission. */ }
  }
  return allowed;
}

export async function assertStoryTestRiskGate(root, config, workflow, options = {}) {
  const context = await loadStoryTestRiskContext(root, config, workflow, options);
  if (context.evaluation.gateDecision === 'block') {
    throw new SingularityFlowError('Required validation remains failed or unavailable. Review the exact retained risk or repair the check before continuing.',
      { code: 'TRP_PHASE_GATE_BLOCKED', details: { evaluation: context.evaluation,
        observedOutcome: context.observations[0]?.observedOutcome ?? 'not-run', workId: workflow.workItem.id,
        phase: context.subject.phaseId, operation: options.operation ?? 'publish' } });
  }
  return context;
}

/** No check is relabelled. Consumers receive the actual unavailable observation and disposition. */
export async function retainedStoryTestRisk(root, config, workflow, phase, { operation, generation, selection } = {}) {
  if (!storyTestRiskEnabled(workflow)) return null;
  const context = await loadStoryTestRiskContext(root, config, workflow, { phaseId: phase.id, operation, generation, selection });
  if (!context.observations.length) return null;
  const observation = context.observations[0];
  if (selection && (observation.commandSha256 !== selection.commandSha256 || observation.selectorSha256 !== selection.selectorSha256
    || observation.commandInventorySha256 !== selection.commandInventorySha256)) return null;
  if (observation.sourceManifestSha256 !== context.candidate?.sourceManifestSha256
    || canonicalJson(observation.environment) !== canonicalJson(context.candidate?.environment)) return null;
  const accepted = await assertStoryTestRiskGate(root, config, workflow, {
    phaseId: phase.id, operation, generation: observation.subject.generation, observationSha256: observation.recordSha256 });
  await appendTrpRecord(path.join(root, workRelative(config, workflow)), accepted.evaluation);
  return { observation, evaluation: accepted.evaluation };
}

async function baselineWorkflow(definition, { workId, phaseId, workType = null }) {
  const { normalizeTestRecoveryPolicy } = await import('./test-recovery-intake.mjs');
  const { normalizeCodeDeliveryPolicy } = await import('./code-delivery-policy.mjs');
  const { resolveWorkType } = await import('./config.mjs');
  const resolved = workType ? resolveWorkType(definition, workType) : null;
  const phase = resolved?.phases.find(entry => entry.id === phaseId) ?? definition.phases?.[phaseId];
  const policy = normalizeTestRecoveryPolicy(definition.testRecovery);
  if (!phase || !policy?.enabled || !policy.enabledRiskCategories.includes('known-test-failure')) {
    throw unsupported('Baseline capture requires an exact approved phase and known-failure policy.');
  }
  return { workItem: { id: workId }, currentPhase: phaseId, phases: { [phaseId]: { ...phase, id: phaseId } },
    resolution: { ...resolved, phases: resolved?.phases ?? Object.entries(definition.phases ?? {}).map(([id, value]) => ({ ...value, id })), testRecovery: policy,
      codeDelivery: normalizeCodeDeliveryPolicy(definition.codeDelivery ?? {}),
      approvalAuthorities: definition.approvalAuthorities, workItemRoot: definition.workItemRoot,
      testRuntime: resolved?.testRuntime ?? definition.repositoryReadiness?.testRuntime },
    testRecovery: { policyAuthoritySha256: trpDigest({ policy, authorities: definition.approvalAuthorities ?? {} }) } };
}

async function baselineSelection(root, definition, workflow, subject, baseCommit) {
  const { normalizeTrpDeliveryCommands } = await import('./trp-delivery-selection.mjs');
  const phase = workflow.phases[subject.phaseId];
  const commands = normalizeTrpDeliveryCommands(workflow, phase, phase.qualityCommands ?? []).filter(command => command?.kind === 'test');
  if (commands.length !== 1) throw unsupported('An exact baseline requires one independently inventoried native test command.');
  const command = { ...commands[0], affectedRoots: [...new Set(commands[0].affectedRoots)].sort() };
  const inventory = await readTrpCaseInventory(root, workflow, phase, command);
  if (!inventory?.tests.length) throw unsupported('Baseline capture requires the independently approved complete testcase inventory.');
  const core = { schemaVersion: 1, kind: 'test-selection-manifest', subject, createdAt: nowIso(),
    issuer: { principal: 'trp-baseline-runner', channel: 'local-runner-v1' },
    provenance: { authorityRef: workflow.testRecovery.policyAuthoritySha256, evidenceRefs: [] },
    // This is an execution-scope identifier only. Baseline evidence grants no Story agreement.
    agreementSha256: workflow.testRecovery.policyAuthoritySha256,
    requestedMode: 'all-configured', effectiveMode: 'all-configured', candidateDeltaSha256: trpDigest({ baseCommit }),
    commandInventorySha256: trpDigest([command]), commandSha256: trpDigest([command]),
    selectorSha256: trpDigest([{ id: command.id, argv: command.argv, adapter: 'module-suite' }]),
    selectedTestIds: inventory.tests.map(entry => entry.id), selectedSuites: [command.id],
    inventoryTestIds: inventory.tests.map(entry => entry.id), reasons: [{ target: command.id, reason: 'Explicit complete pre-feature baseline capture' }],
    expansion: 'none', fullSuiteEquivalent: false, confirmationSha256: null, exclusions: [], uncoveredAreas: [], impactComplete: true };
  return { command, inventory, selection: sealTrpRecord({ ...core, id: `baseline-selection-${trpDigest(core).slice(7, 39)}` }) };
}

/** Executes a baseline only at its exact clean pre-feature base. No acceptance, commit or Story is created. */
export async function captureTrpIntakeBaseline(root, definition, { workId, workType, phaseId, repositoryId, baseCommit }) {
  if (!/^[a-f0-9]{40,64}$/u.test(baseCommit ?? '') || head(root) !== baseCommit) throw unsupported('Baseline capture requires HEAD at the exact requested pre-feature base.');
  assertClean(root);
  const workflow = await baselineWorkflow(definition, { workId, workType, phaseId });
  const subject = { workId, repositoryId, phaseId, generation: 0, validationEpoch: 1 };
  const { command, inventory, selection } = await baselineSelection(root, definition, workflow, subject, baseCommit);
  const { loadEnvironmentDeclaration, validateEnvironmentQualityCommandCatalog } = await import('./environment-declaration.mjs');
  const { effectiveEnvironmentQualityCommandCatalog } = await import('./state.mjs');
  validateEnvironmentQualityCommandCatalog(await loadEnvironmentDeclaration(root, { optional: true }),
    effectiveEnvironmentQualityCommandCatalog(workflow.phases[phaseId], workflow));
  const report = path.posix.normalize(path.posix.join(command.workingDirectory, command.result.path));
  await ensureSecureRepositoryDirectory(root, path.posix.dirname(report), { label: 'Baseline report parent' });
  // A standalone baseline never replaces existing user output. The caller can choose a fresh
  // approved report target or deliberately clear old reports before requesting another capture.
  await assertTestReportTargetEmpty(root, command);
  const before = await candidateContext(root, definition, workflow, selection);
  const { environmentQualityCommandBlock } = await import('./state.mjs');
  const { evaluateExternalCommandForModelMode } = await import('./external-command-policy.mjs');
  const { operationContext } = await import('./operation-context.mjs');
  const executablePolicy = evaluateExternalCommandForModelMode(command, {
    modelEnabled: operationContext()?.modelMode?.enabled !== false,
    unknownStrictness: definition.noModel?.unknownExternalCommands ?? 'warn', index: 0 });
  if (executablePolicy.action !== 'run') throw unsupported('The baseline command is not permitted by the active external-model policy.');
  const environmentBlock = await environmentQualityCommandBlock(root, executablePolicy, {
    sourceCommit: baseCommit, sourceTreeSha256: before.sourceManifestSha256, startedAt: nowIso() });
  if (environmentBlock) throw unsupported('The baseline requires its approved isolated environment runner; no command was executed.', { errorCode: environmentBlock.errorCode });
  const cwd = await realpath(path.resolve(root, command.workingDirectory));
  const environment = testRuntimeEnvironment(workflow.resolution?.testRuntime,
    trpExecutionEnvironment(inventory.declaration, process.env, { cwd }));
  const stdoutFile = inventory.adapter === 'node-test-junit-v1' ? path.resolve(cwd, command.result.path) : null;
  const reportCapture = trpNativeReportCapture(root, command, inventory.declaration);
  const result = await runQualityCommand(command.argv[0], command.argv.slice(1), {
    cwd, env: environment, stdoutFile, reportCapture, timeoutMs: command.timeoutMs ?? 120000, killTree: true });
  const launch = verifyCompletedQualityLaunch(result, { command: command.argv[0], args: command.argv.slice(1), cwd,
    environmentSha256: createHash('sha256').update(JSON.stringify(Object.entries(environment).sort())).digest('hex'), stdoutFile, reportCapture });
  if (!launch || !Number.isInteger(launch.status) || launch.status < 0) throw unsupported('Baseline capture needs an authenticated completed native invocation.');
  const parsed = await parseTestResult(root, command, { startedAt: launch.startedAt });
  if (inventory.adapter === 'node-test-junit-v1') {
    if (parsed.rawReports.length !== 1 || `sha256:${parsed.rawReports[0].sha256}` !== launch.stdoutSha256
      || parsed.rawReports[0].bytes !== launch.stdoutBytes) throw unsupported('Baseline report is not the exact native stdout.');
  } else if (canonicalJson(parsed.rawReports.map(({ sourcePath, sha256, bytes }) => ({ sourcePath, sha256, bytes }))) !== canonicalJson(launch.reports)) {
    throw unsupported('Baseline report set differs from native completion evidence.');
  }
  const observedOutcome = launch.status === 0 ? 'passed' : 'failed';
  const matched = await matchTrpReports(root, inventory, parsed.rawReports, {
    allowSkipped: workflow.resolution.testRecovery.enabledRiskCategories.includes('reduced-coverage'), expectedOutcome: observedOutcome });
  const after = await candidateContext(root, definition, workflow, selection);
  await verifyTrpCaseInventorySources(root, inventory);
  if (head(root) !== baseCommit || (inventory.adapter === 'maven-surefire-junit-v1'
    ? before.stableInputSha256 !== after.stableInputSha256 : canonicalJson(before) !== canonicalJson(after))) {
    throw unsupported('The pre-feature baseline source or execution inputs changed during capture.');
  }
  assertClean(root);
  const core = { schemaVersion: 1, kind: 'test-baseline-manifest', subject, createdAt: nowIso(),
    issuer: { principal: 'trp-baseline-runner', channel: 'local-runner-v1' },
    provenance: { authorityRef: workflow.testRecovery.policyAuthoritySha256, evidenceRefs: [selection.recordSha256] },
    obligationId: command.id, agreementSha256: null, selectionSha256: selection.recordSha256,
    sourceRevision: baseCommit, preFeatureBase: baseCommit, sourceManifestSha256: after.sourceManifestSha256,
    commandInventorySha256: selection.commandInventorySha256, commandSha256: selection.commandSha256,
    selectorSha256: selection.selectorSha256, dependencies: after.dependencies, environment: after.environment,
    startedAt: launch.startedAt, completedAt: launch.completedAt, processExitCode: launch.status,
    reportStatus: 'current', reportSha256s: matched.reportSha256s, expectedTestIds: inventory.tests.map(entry => entry.id),
    inventoryTestIds: inventory.tests.map(entry => entry.id), inventoryComplete: true, cases: matched.cases, counts: matched.counts,
    identityCompleteness: 'complete', observedOutcome, diagnostics: [], executionOrigin: 'executed' };
  const record = sealTrpRecord({ ...core, id: `baseline-${trpDigest(core).slice(7, 39)}` });
  await retainOrigin(root, workflow, record, selection, parsed.rawReports);
  return { record, recordSha256: record.recordSha256, counts: record.counts, observedOutcome };
}

/** Read-only authentication never requires the feature candidate to remain at baseline HEAD. */
export async function inspectTrpIntakeBaseline(root, { recordSha256, workId, repositoryId, baseCommit, definition, phaseId = null, workType = null, acceptedWorkflow = null }) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(recordSha256 ?? '')) throw unsupported('An exact retained baseline digest is required.');
  const bundle = JSON.parse((await boundedRead(path.join(await originDirectory(root), `${recordSha256.slice(7)}.baseline`))).toString());
  const record = bundle.observation;
  validateTrpRecord(record, { kind: 'test-baseline-manifest' });
  validateTrpRecord(bundle.selection, { kind: 'test-selection-manifest' });
  phaseId ??= record.subject.phaseId;
  const workflow = await baselineWorkflow(definition, { workId, phaseId, workType });
  if (acceptedWorkflow) {
    const { loadStoryTestRecoveryAgreement } = await import('./state.mjs');
    const agreement = await loadStoryTestRecoveryAgreement(root, definition, acceptedWorkflow);
    if (acceptedWorkflow.workItem.id !== workId || !agreement?.repositories.some(repository => repository.repositoryId === repositoryId
      && repository.baselineRefs.includes(recordSha256))
      || canonicalJson(workflow.resolution.testRecovery) !== canonicalJson(acceptedWorkflow.resolution.testRecovery)) throw unsupported('The baseline is absent from the verified accepted Story policy.');
    workflow.testRecovery.policyAuthoritySha256 = agreement.policyAuthoritySha256;
  }
  const verification = { digest: record.recordSha256 === recordSha256, work: record.subject.workId === workId,
    repository: record.subject.repositoryId === repositoryId, phase: record.subject.phaseId === phaseId,
    base: record.preFeatureBase === baseCommit && record.sourceRevision === baseCommit && Boolean(governedCommitIdentity(root, baseCommit)),
    selection: record.selectionSha256 === bundle.selection.recordSha256,
    policy: record.provenance.authorityRef === workflow.testRecovery.policyAuthoritySha256,
    origin: await authenticOrigin(root, workflow, record), report: await authenticatedFailedReport(root, definition, workflow, record) };
  if (Object.values(verification).some(value => !value)) {
    throw unsupported('Retained baseline identity, policy, base or native provenance could not be authenticated.', { verification });
  }
  const fresh = await baselineSelection(root, definition, workflow, record.subject, baseCommit);
  if (['commandInventorySha256', 'commandSha256', 'selectorSha256'].some(key => fresh.selection[key] !== record[key])
    || canonicalJson(fresh.inventory.tests.map(({ id, semanticsSha256 }) => ({ id, semanticsSha256 })).sort((a, b) => a.id.localeCompare(b.id)))
      !== canonicalJson(record.cases.map(({ id, semanticsSha256 }) => ({ id, semanticsSha256 })).sort((a, b) => a.id.localeCompare(b.id)))) throw unsupported('The current command or approved testcase semantics differ from the baseline.');
  const current = await candidateContext(root, definition, workflow, fresh.selection);
  const compatibility = value => value.dependencies.find(entry => entry.id === 'baseline-compatibility')?.sha256;
  if (!compatibility(record) || compatibility(record) !== compatibility(current)) throw unsupported('Baseline environment, stable dependencies or approved compatibility scope changed.');
  return { record, authenticated: true };
}

/** Called within initial Story creation, after exact baseline authority has been reviewed. */
export async function materializeTrpIntakeBaseline(root, config, workflow, { recordSha256 }) {
  const bundle = JSON.parse((await boundedRead(path.join(await originDirectory(root), `${recordSha256.slice(7)}.baseline`))).toString());
  const record = bundle.observation;
  validateTrpRecord(record, { kind: 'test-baseline-manifest' });
  if (record.recordSha256 !== recordSha256 || record.subject.workId !== workflow.workItem.id
    || record.provenance.authorityRef !== workflow.testRecovery.policyAuthoritySha256
    || !await authenticOrigin(root, workflow, record) || !await authenticatedFailedReport(root, config, workflow, record)) throw unsupported('The reviewed baseline cannot be materialized without exact native provenance.');
  await appendTrpRecord(path.join(root, workRelative(config, workflow)), record);
  for (const sha256 of record.reportSha256s) {
    const relative = reportPath(config, workflow, record, sha256);
    await ensureSecureRepositoryDirectory(root, path.posix.dirname(relative), { label: 'Baseline native reports' });
    const target = await secureRepositoryPath(root, relative, { type: 'file' });
    const bytes = await boundedRead(path.join(await originDirectory(root), `${sha256.slice(7)}.report`));
    if (!(await installPrivate(target.absolute, bytes)).equals(bytes)) throw unsupported('Materialized baseline report differs from its native bytes.');
  }
  return record;
}

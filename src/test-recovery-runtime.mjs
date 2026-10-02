/** Production TRP adapter. An unavailable runner is an observation, never a test pass. */
import { constants } from 'node:fs';
import { mkdir, open, readdir, lstat, realpath, stat } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from './records.mjs';
import { exactChangedPathsBetweenObjects, exactFileAtObject, exactRemoteBranchObservationAsync, gitDir, governedCommitIdentity, head } from './git.mjs';
import { appendTrpRecord, loadTrpRecords, loadTrpAuthorityVerifier } from './test-recovery-store.mjs';
import { evaluateTestRecoveryGate, sealTrpRecord, trpDigest, validateTrpRecord } from './test-recovery-policy.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';
import { verifyUnavailableQualityLaunch } from './quality-command-runner.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const unsupported = (message, details = {}) => new SingularityFlowError(message, { code: 'TRP_RISK_ADAPTER_UNAVAILABLE', details });
const workRelative = (config, workflow) => path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
const privateWitnesses = new WeakMap();
const capturedLaunches = new WeakSet();
export const TRP_RUNTIME_RISK_CATEGORIES = Object.freeze(['validation-unavailable']);

export function storyTestRiskEnabled(workflow) {
  return workflow.resolution?.testRecovery?.enabled === true
    && workflow.resolution.testRecovery.enabledRiskCategories?.includes('validation-unavailable') === true;
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

async function retainOrigin(root, workflow, observation, selection) {
  const directory = await originDirectory(root, true);
  const key = (await installPrivate(path.join(directory, 'origin.key'), randomBytes(32).toString('hex'))).toString();
  if (!/^[a-f0-9]{64}$/u.test(key)) throw unsupported('Execution origin key is invalid.');
  const proof = createHmac('sha256', Buffer.from(key, 'hex')).update(await originBinding(root, workflow, observation)).digest('hex');
  const saved = await installPrivate(path.join(directory, `${observation.recordSha256.slice(7)}.origin`), proof);
  if (saved.toString() !== proof) throw unsupported('Retained execution origin differs from the captured observation.');
  // Failed publication rolls Story files back. This authenticated host journal preserves
  // the exact attempted observation until its human decision transaction publishes it.
  const bundle = canonicalJson({ observation, selection });
  const retained = await installPrivate(path.join(directory, `${observation.recordSha256.slice(7)}.capture`), bundle);
  if (retained.toString() !== bundle) throw unsupported('Retained execution capture differs from the original.');
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
  const commands = (await resolveDeliveryQualityCommands(root, phase)).filter(command => command?.kind === 'test');
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
  const runtimeSha256 = trpDigest({ executable: process.execPath, version: process.version,
    environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => resolutionKeys.has(key.toUpperCase())).sort()), resolution });
  const environment = { hostId: os.hostname(), platform: process.platform, arch: process.arch, runtimeSha256,
    dependencySha256: sourceManifestSha256, runnerSha256: selection.commandSha256,
    adapterSha256: trpDigest('trp-unavailable-runner-v1'), configurationSha256: selection.commandInventorySha256,
    externalDependenciesSha256: null };
  return { sourceManifestSha256, environment, unresolvedExecutable: resolution.every(item => !item.resolvedAvailable), dependencies: [
    { id: 'application-source-and-dependencies', sha256: sourceManifestSha256 },
    { id: 'approved-command-inventory', sha256: selection.commandInventorySha256 },
    { id: 'approved-runner-command', sha256: selection.commandSha256 },
    { id: 'approved-selector', sha256: selection.selectorSha256 }
  ] };
}

/** Called only around the real host quality runner; no authority is granted by this capture. */
export async function beginStoryTestRiskRun(root, config, workflow, phase, { commands, selection }) {
  if (!storyTestRiskEnabled(workflow)) return null;
  const tests = commands.filter(command => command?.kind === 'test');
  if (tests.length !== 1 || !selection || selection.selectedSuites.length !== 1
    || selection.selectedSuites[0] !== tests[0].id) throw unsupported('Validation-unavailable risk currently supports one exact structured test command per phase.');
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
  const candidate = await candidateContext(root, config, workflow, selection);
  const witness = Object.freeze({});
  const cwd = await realpath(path.resolve(root, tests[0].workingDirectory ?? '.'));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  if (tests[0].result?.adapter === 'playwright-json') {
    for (const key of Object.keys(environment)) if (key.toUpperCase() === 'PLAYWRIGHT_JSON_OUTPUT_FILE') delete environment[key];
    environment.PLAYWRIGHT_JSON_OUTPUT_FILE = path.resolve(cwd, tests[0].result.path);
  }
  const captured = { selection, candidate, commandId: tests[0].id, command: tests[0].argv[0], args: tests[0].argv.slice(1),
    cwd, environmentSha256: createHash('sha256').update(JSON.stringify(Object.entries(environment).sort())).digest('hex'),
    startedAt: nowIso(), sourceRevision: head(root) };
  privateWitnesses.set(witness, structuredClone(captured));
  return Object.freeze({ witness, ...captured });
}

/** Only an actual launch failure qualifies. Exit-one tests, skipped commands and timeouts do not. */
export async function captureStoryTestRiskObservation(root, config, workflow, phase, { run, check, result }) {
  if (!run || !privateWitnesses.has(run.witness)) throw unsupported('A live runtime observation is required.');
  const expected = privateWitnesses.get(run.witness);
  privateWitnesses.delete(run.witness);
  const { witness: _witness, ...provided } = run;
  if (canonicalJson(expected) !== canonicalJson(provided)) throw unsupported('The captured execution candidate was altered.');
  const launch = verifyUnavailableQualityLaunch(result, expected);
  if (check?.id !== run.commandId || check.status !== 'blocked' || !launch || capturedLaunches.has(result)
    || !check.infrastructureUnavailable || check.timedOut || !run.candidate.unresolvedExecutable
    || Date.parse(launch.startedAt) < Date.parse(run.startedAt)) return null;
  const current = await candidateContext(root, config, workflow, run.selection);
  if (canonicalJson(current) !== canonicalJson(run.candidate)) throw unsupported('Source, commands or environment changed during the unavailable runner attempt.');
  capturedLaunches.add(result);
  const createdAt = nowIso();
  const core = { schemaVersion: 1, kind: 'phase-validation-observation',
    subject: run.selection.subject, createdAt, issuer: { principal: 'trp-runtime', channel: 'local-runner-v1' },
    provenance: { authorityRef: workflow.testRecovery.policyAuthoritySha256, evidenceRefs: [run.selection.recordSha256] },
    obligationId: run.commandId, agreementSha256: run.selection.agreementSha256, selectionSha256: run.selection.recordSha256,
    sourceRevision: run.sourceRevision, sourceManifestSha256: current.sourceManifestSha256,
    commandInventorySha256: run.selection.commandInventorySha256, commandSha256: run.selection.commandSha256,
    selectorSha256: run.selection.selectorSha256, dependencies: current.dependencies, environment: current.environment,
    startedAt: launch.startedAt, completedAt: launch.completedAt, processExitCode: null,
    reportStatus: 'missing', reportSha256s: [], expectedTestIds: [], cases: [],
    counts: { discovered: 0, passed: 0, failed: 0, skipped: 0, notRun: 0 }, identityCompleteness: 'incomplete',
    observedOutcome: 'unavailable', diagnostics: [redactDiagnosticText(check.stderr ?? 'Runner unavailable').slice(0, 2000)], executionOrigin: 'executed' };
  const observation = sealTrpRecord({ ...core, id: `run-${trpDigest(core).slice(7, 39)}` });
  const workRoot = path.join(root, workRelative(config, workflow));
  await appendTrpRecord(workRoot, run.selection);
  await appendTrpRecord(workRoot, observation);
  await retainOrigin(root, workflow, observation, run.selection);
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
  const authenticated = new Set();
  for (const record of observations) {
    if (record.observedOutcome !== 'unavailable' || record.processExitCode !== null || record.reportStatus !== 'missing'
      || record.cases.length || record.expectedTestIds.length || record.reportSha256s.length || record.identityCompleteness !== 'incomplete'
      || !await authenticOrigin(root, workflow, record)) continue;
    if (evidenceCommit) {
      const relative = `${workRelative(config, workflow)}/context/test-recovery/runs/${record.id}.json`;
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
  const phaseObligations = repository.mandatoryObligations.filter(item => !item.phaseIds || item.phaseIds.includes(phaseId));
  if (!phaseObligations.some(item => item.transitions.includes(operation))) {
    integrityIssues.push({ category: 'policy-integrity', obligationId: 'operation', message: 'The pinned agreement does not declare this transition; no risk permission can be inferred.' });
  }
  if (authority.policy.enabledRiskCategories.some(category => !TRP_RUNTIME_RISK_CATEGORIES.includes(category))) {
    integrityIssues.push({ category: 'policy-integrity', obligationId: 'runtime-adapter', message: 'This runtime supports validation-unavailable only; other risks require a qualified evidence adapter.' });
  }
  if (selection && phaseObligations.filter(item => item.transitions.includes(operation)).some(item =>
    item.kind !== 'test' || !selection.selectedSuites.includes(item.id))) {
    integrityIssues.push({ category: 'policy-integrity', obligationId: 'phase-obligations', message: 'Pinned phase obligations do not match this adapter’s exact command inventory.' });
  }
  const evaluation = evaluateTestRecoveryGate({ ...authority, agreement, subject, operation, at, mode,
    observations, baselines: [], decisions, selection, candidateDependencies: candidate?.dependencies ?? [],
    candidateEnvironment: candidate?.environment ?? null, verifyAuthority, verifyEvidence, integrityIssues, publicationPending });
  return { ...authority, agreement, phase, subject, selection, records, observations, baselines: [], decisions,
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
    throw new SingularityFlowError('The test runner remains unavailable. Review the exact retained risk or repair the runner before continuing.',
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

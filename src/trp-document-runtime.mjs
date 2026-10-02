/** Native supplemental-document observations. Neither Markdown nor a client supplies authority. */
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { exactFileAtObject, exactTreePathsAtObject, exactRemoteBranchObservationAsync, gitDir, head } from './git.mjs';
import { canonicalJson } from './records.mjs';
import { evaluateProtectedPaths } from './repository-change-set.mjs';
import { appendTrpRecord, loadTrpAuthorityVerifier, loadTrpRecords } from './test-recovery-store.mjs';
import { evaluateTestRecoveryGate, sealTrpRecord, trpDigest, validateTrpRecord } from './test-recovery-policy.mjs';
import { documentObligationsForPhase, normalizeDocumentObligations } from './trp-document-policy.mjs';
import { ensureSecureRepositoryDirectory, nowIso, secureRepositoryPath, SingularityFlowError } from './util.mjs';

const LIMIT = 1024 * 1024;
const fail = (message, code = 'TRP_DOCUMENT_EVIDENCE_INVALID') => { throw new SingularityFlowError(message, { code }); };
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function documentFacts(contract, bytes) {
  if (bytes === null) return { path: contract.path, exists: false, sha256: null, bytes: 0,
    valid: false, findings: ['Document is missing.'] };
  if (bytes.length > LIMIT) fail('Document exceeds its bounded size.');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || text.includes('\0')) fail('Document must contain valid UTF-8 text.');
  const headings = new Set(); let fence = null;
  for (const line of text.split(/\r?\n/u)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u);
    if (heading) headings.add(heading[1]);
  }
  const findings = [];
  if (!text.trim()) findings.push('Document is empty.');
  for (const section of contract.requiredSections) if (!headings.has(section)) findings.push(`Required section is absent: ${section}`);
  return { path: contract.path, exists: true, sha256: sha(bytes), bytes: bytes.length, valid: !findings.length, findings };
}

function committedDocument(root, commit, contract) {
  const paths = exactTreePathsAtObject(root, commit, ['--', contract.path]);
  if (!paths) fail('The exact document tree is unavailable; absence cannot be assumed.');
  if (!paths.includes(contract.path)) return documentFacts(contract, null);
  const bytes = exactFileAtObject(root, commit, contract.path, { maximumBytes: LIMIT });
  if (!bytes) fail('The exact committed document cannot be read within its bound.');
  return documentFacts(contract, bytes);
}

export async function inspectSupplementalDocument(root, config, workflow, contract) {
  contract = normalizeDocumentObligations([contract])[0];
  const phase = workflow.phases?.[contract.phaseId];
  if (!phase) fail('The supplemental document phase is not in this Story.');
  const forbidden = [config.workItemRoot ?? 'singularity/work-items', 'singularity', '.git', '.singularity-flow',
    ...(config.governance?.protectedPaths ?? []), ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])];
  const protectedResult = evaluateProtectedPaths({ entries: [{ newPath: contract.path, oldPath: contract.path }] },
    forbidden, { caseInsensitive: true });
  const essential = Object.values(workflow.phases ?? {}).flatMap(item => [item.requiredArtifact?.path,
    ...(item.artifactSet?.members ?? []).map(value => value.path),
    ...(item.artifactSet?.artifacts ?? []).map(value => value.path)]).filter(Boolean);
  if (!protectedResult.valid || essential.some(value => value.toLowerCase() === contract.path.toLowerCase())) {
    fail('Essential artifacts, policy, instructions and protected paths cannot be designated nonessential.', 'TRP_DOCUMENT_NONWAIVABLE');
  }
  const safe = await secureRepositoryPath(root, contract.path, { label: 'Supplemental document', type: 'file' });
  if (!safe.exists) return { path: contract.path, exists: false, sha256: null, bytes: 0,
    valid: false, findings: ['Document is missing.'] };
  const handle = await open(safe.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const before = await handle.stat(); const linked = await lstat(safe.absolute);
    if (!before.isFile() || before.nlink !== 1 || linked.isSymbolicLink() || before.size > LIMIT
      || before.ino !== linked.ino || before.dev !== linked.dev) fail('Document must be an ordinary bounded file.');
    bytes = await handle.readFile(); const after = await handle.stat();
    const current = await lstat(safe.absolute);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode
      || current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()) fail('Document changed during inspection.');
  } finally { await handle.close(); }
  return documentFacts(contract, bytes);
}

/** Local diagnostic receipts stabilize review previews; they grant no permission and store no document body. */
async function observedIdentity(root, binding, maxAgeSeconds, at) {
  const base = await realpath(gitDir(root));
  const relative = 'singularity-flow/trp-document-observations';
  await ensureSecureRepositoryDirectory(base, relative, { label: 'Document observation cache' });
  const directory = path.join(base, relative); const key = trpDigest(binding).slice(7);
  const names = await readdir(directory);
  if (names.length > 4096) fail('Document observation cache exceeds its inspection bound.');
  for (const name of names.filter(value => value.startsWith(`${key}-`) && value.endsWith('.json')).sort().reverse()) {
    const target = await secureRepositoryPath(base, `${relative}/${name}`, { label: 'Document observation receipt', mustExist: true, type: 'file' });
    const handle = await open(target.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 4096) fail('Invalid document observation receipt.');
      const stored = JSON.parse(await handle.readFile('utf8'));
      const age = Date.parse(at) - Date.parse(stored.createdAt);
      if (stored.bindingSha256 !== `sha256:${key}` || !/^[a-f0-9]{40,64}$/u.test(stored.sourceRevision ?? '')
        || !Number.isFinite(age) || age < 0) fail('Document observation receipt does not match its binding.');
      if (age <= maxAgeSeconds * 1000) return stored;
    } finally { await handle.close(); }
  }
  const value = { bindingSha256: `sha256:${key}`, createdAt: at, sourceRevision: head(root) };
  const handle = await open(path.join(directory, `${key}-${Date.parse(at)}-${randomUUID()}.json`),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  return value;
}

export async function loadStoryDocumentRiskContext(root, config, workflow, {
  phaseId = workflow.currentPhase, obligationId, repositoryId = null, operation = 'publish', at = nowIso(), generation = null,
  evidenceCommit = null, observationSha256 = null
} = {}) {
  const { loadStoryTestRecoveryAgreement, sourceTreeHash, storyPublicationPending, workflowPublicationBranch, workDir } = await import('./state.mjs');
  const { storyTestRiskAuthorityContext } = await import('./story-test-risk.mjs');
  const agreement = await loadStoryTestRecoveryAgreement(root, config, workflow);
  if (!agreement) fail('Document risk review requires the pinned Story agreement.', 'TRP_NOT_ENABLED');
  const contract = documentObligationsForPhase(workflow, phaseId).find(entry => entry.id === obligationId);
  if (!contract) fail('Select an explicitly pinned supplemental document obligation.', 'TRP_DOCUMENT_OBLIGATION_REQUIRED');
  const repository = repositoryId == null ? (agreement.repositories.length === 1 ? agreement.repositories[0] : null)
    : agreement.repositories.find(entry => entry.repositoryId === repositoryId);
  if (!repository) fail('An exact local repository binding is required.');
  const phase = workflow.phases[phaseId];
  const workRoot = workDir(root, config, workflow.workItem.id);
  const records = await loadTrpRecords(workRoot);
  const historical = evidenceCommit ? records.find(record => record.kind === 'phase-validation-observation'
    && record.recordSha256 === observationSha256 && record.obligationId === obligationId) : null;
  if (evidenceCommit && !historical) fail('The exact document observation is unavailable.');
  const subject = { workId: workflow.workItem.id, repositoryId: repository.repositoryId, phaseId,
    generation: generation ?? Number(phase.generationIntent?.status === 'open' ? phase.generationIntent.generation : phase.generation || 1),
    validationEpoch: Number(workflow.testRecovery.validationEpoch ?? 1) };
  const document = evidenceCommit ? committedDocument(root, evidenceCommit, contract)
    : await inspectSupplementalDocument(root, config, workflow, contract);
  const sourceManifestSha256 = historical?.sourceManifestSha256 ?? await sourceTreeHash(root, config, workflow);
  const commandSha256 = trpDigest({ adapter: 'supplemental-markdown-v1', contract });
  const dependencies = [{ id: 'supplemental-document', sha256: trpDigest(document) },
    { id: 'document-contract', sha256: commandSha256 }, { id: 'application-source', sha256: sourceManifestSha256 }];
  const environment = historical?.environment ?? { hostId: os.hostname(), platform: process.platform, arch: process.arch,
    runtimeSha256: trpDigest({ node: process.version }), dependencySha256: trpDigest(dependencies),
    runnerSha256: commandSha256, adapterSha256: trpDigest('supplemental-markdown-v1'),
    configurationSha256: agreement.policyAuthoritySha256, externalDependenciesSha256: null };
  const binding = { subject, agreementSha256: agreement.recordSha256, document, dependencies, environment };
  const authority = storyTestRiskAuthorityContext(workflow, agreement);
  const captured = historical ? { createdAt: historical.createdAt, sourceRevision: historical.sourceRevision }
    : await observedIdentity(root, binding, authority.policy.maxEvidenceAgeSeconds, at);
  const observation = historical ?? sealTrpRecord({ schemaVersion: 1, kind: 'phase-validation-observation',
    id: `document-${trpDigest({ ...binding, captured }).slice(7, 39)}`, subject, createdAt: captured.createdAt,
    issuer: { principal: 'singularity-flow-document-check', channel: 'kernel-document-validator' },
    provenance: { authorityRef: agreement.policyAuthoritySha256, evidenceRefs: [trpDigest(document)] },
    obligationId, agreementSha256: agreement.recordSha256, selectionSha256: commandSha256,
    sourceRevision: captured.sourceRevision, sourceManifestSha256, commandInventorySha256: commandSha256,
    commandSha256, selectorSha256: commandSha256, dependencies, environment,
    startedAt: captured.createdAt, completedAt: captured.createdAt, processExitCode: document.valid ? 0 : 1,
    reportStatus: 'not-required', reportSha256s: [], expectedTestIds: [], cases: [],
    counts: { discovered: 0, passed: 0, failed: 0, skipped: 0, notRun: 0 }, identityCompleteness: 'complete',
    observedOutcome: document.valid ? 'passed' : 'failed', diagnostics: document.findings, executionOrigin: 'executed' });
  if (historical) {
    validateTrpRecord(historical, { kind: 'phase-validation-observation' });
    const relative = path.relative(root, path.join(workRoot, 'context/test-recovery/runs', `${historical.id}.json`)).split(path.sep).join('/');
    const stored = exactFileAtObject(root, evidenceCommit, relative, { maximumBytes: 4 * LIMIT });
    if (!stored || canonicalJson(JSON.parse(stored.toString('utf8'))) !== canonicalJson(historical)
      || canonicalJson(historical.subject) !== canonicalJson(subject)
      || canonicalJson([...historical.dependencies].sort((a, b) => a.id.localeCompare(b.id)))
        !== canonicalJson([...dependencies].sort((a, b) => a.id.localeCompare(b.id)))
      || historical.agreementSha256 !== agreement.recordSha256 || historical.commandSha256 !== commandSha256
      || historical.observedOutcome !== (document.valid ? 'passed' : 'failed')
      || historical.processExitCode !== (document.valid ? 0 : 1)
      || historical.cases.length || historical.reportSha256s.length || historical.expectedTestIds.length
      || historical.reportStatus !== 'not-required') fail('The committed document observation does not replay from its exact native facts.');
  }
  const pending = await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false });
  const localOnly = config.git?.publish === 'off' && workflow.resolution?.capability?.policy?.gitPublication !== 'required';
  const localCommit = head(root);
  let remoteAcknowledgedCommit = null;
  if (!localOnly && !pending) {
    const remote = await exactRemoteBranchObservationAsync(root, config.git?.remote ?? 'origin', workflowPublicationBranch(root, workflow));
    remoteAcknowledgedCommit = remote?.sha ?? remote?.commit ?? null;
  }
  let verifyAuthority = () => null; let publicationPending = Boolean(pending);
  try { verifyAuthority = await loadTrpAuthorityVerifier({ root, workRoot, ...authority, localCommit,
    remoteAcknowledgedCommit, localOnly, records }); }
  catch (error) {
    if (['TRP_PUBLICATION_PENDING', 'TRP_PUBLICATION_UNVERIFIED'].includes(error.code)) publicationPending = true;
    else throw error;
  }
  // Only facts recomputed from the current bounded native file read authenticate this observation.
  const verifyEvidence = record => record.recordSha256 === observation.recordSha256
    ? { recordSha256: record.recordSha256, authenticated: true, reportsAvailable: true, verifiedAt: at } : null;
  const decisions = records.filter(entry => entry.kind === 'phase-risk-decision');
  const evaluation = evaluateTestRecoveryGate({ ...authority, agreement, subject, operation, at,
    observations: [observation], decisions, candidateDependencies: dependencies, candidateEnvironment: environment,
    verifyAuthority, verifyEvidence, publicationPending, obligationIds: [obligationId] });
  return { ...authority, adapter: 'document', contract, document, agreement, phase, subject, records,
    observations: [observation], baselines: [], selection: null, decisions, evaluation,
    candidate: { sourceManifestSha256, dependencies, environment }, candidateDependencies: dependencies,
    candidateEnvironment: environment, verifyAuthority, verifyEvidence, publicationPending, localCommit, remoteAcknowledgedCommit };
}

export async function materializeStoryDocumentRiskEvidence(root, config, workflow, context) {
  const fresh = await loadStoryDocumentRiskContext(root, config, workflow, { phaseId: context.subject.phaseId,
    obligationId: context.contract.id, repositoryId: context.subject.repositoryId,
    operation: context.evaluation.operation, generation: context.subject.generation });
  if (fresh.observations[0].recordSha256 !== context.observations[0].recordSha256) fail('The document changed during review.', 'TRP_RISK_REVIEW_STALE');
  const { workDir } = await import('./state.mjs');
  await appendTrpRecord(workDir(root, config, workflow.workItem.id), fresh.observations[0]);
}

export async function assertStoryDocumentRiskGates(root, config, workflow, phase, operation) {
  const contexts = [];
  for (const contract of documentObligationsForPhase(workflow, phase.id)) {
    const document = await inspectSupplementalDocument(root, config, workflow, contract);
    // A real passing document check needs no risk decision. Normal phase approval remains intact.
    if (document.valid) continue;
    const context = await loadStoryDocumentRiskContext(root, config, workflow, {
      phaseId: phase.id, obligationId: contract.id, operation });
    if (context.evaluation.gateDecision === 'block') throw new SingularityFlowError(
      `Supplemental document '${contract.path}' needs repair or an exact reviewed ${operation} exception.`,
      { code: 'TRP_DOCUMENT_GATE_BLOCKED', details: { workId: workflow.workItem.id, phase: phase.id,
        obligationId: contract.id, evaluation: context.evaluation, preserved: ['application code', 'required artifacts', 'approvals'],
        command: `singularity-flow story test-policy risks --work-id ${workflow.workItem.id} --phase ${phase.id} --obligation ${contract.id} --operation ${operation} --json` } });
    contexts.push(context);
  }
  return contexts;
}

/** An immutable review packet displays facts and accepted decisions, never a rewritten pass. */
export async function storyDocumentReviewSnapshot(root, config, workflow, phase) {
  const risks = await assertStoryDocumentRiskGates(root, config, workflow, phase, 'submit');
  const rows = [];
  for (const contract of documentObligationsForPhase(workflow, phase.id)) {
    const context = risks.find(item => item.contract.id === contract.id);
    rows.push({ obligationId: contract.id, contractSha256: trpDigest(contract),
      document: context?.document ?? await inspectSupplementalDocument(root, config, workflow, contract),
      observationSha256: context?.observations[0].recordSha256 ?? null,
      decisionSha256s: context?.evaluation.dispositions.flatMap(item => item.decisionRefs) ?? [] });
  }
  return rows;
}

export async function verifyStoryDocumentSnapshot(root, config, workflow, packet, evidenceCommit) {
  const contracts = documentObligationsForPhase(workflow, packet.phase);
  const rows = packet.submissionEvidence?.documentChecks ?? [];
  if (!Array.isArray(rows) || rows.length !== contracts.length || new Set(rows.map(row => row.obligationId)).size !== rows.length) fail('Document review bindings are incomplete.');
  for (const contract of contracts) {
    const row = rows.find(item => item.obligationId === contract.id);
    const facts = committedDocument(root, evidenceCommit, contract);
    if (!row || row.contractSha256 !== trpDigest(contract) || canonicalJson(row.document) !== canonicalJson(facts)) fail('Committed supplemental document facts differ from the review packet.');
    if (facts.valid) {
      if (row.observationSha256 !== null || row.decisionSha256s.length) fail('A passing document cannot carry an invented exception.');
      continue;
    }
    const context = await loadStoryDocumentRiskContext(root, config, workflow, {
      phaseId: packet.phase, generation: Number(packet.generation), obligationId: contract.id,
      operation: 'submit', at: packet.submittedAt, evidenceCommit, observationSha256: row.observationSha256 });
    const refs = context.evaluation.dispositions.flatMap(item => item.decisionRefs).sort();
    if (context.evaluation.gateDecision !== 'allow-with-risk' || context.observations[0].sourceManifestSha256 !== packet.sourceTreeSha256
      || canonicalJson(refs) !== canonicalJson([...row.decisionSha256s].sort())) fail('The document exception was not authorized for this immutable submission.');
  }
}

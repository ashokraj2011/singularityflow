/**
 * SFlow writes the record documents (owner, 2026-11-21: "too many approvals of almost similar documents"). On arshy the
 * verification evidence was 37% new and the release conformance 34%: an agent restated, by hand, what SFlow's own records
 * already say. Wherever a step's content is fully derivable from those records, SFlow writes it:
 *
 * - **Verification evidence** (`common/verification.md`): the test runs and their environment, each requirement's tests
 *   and results from the evidence graph, the scanners' findings, and the tests that assert nothing.
 * - **Release conformance** (`spec-driven/release.md`): one row per approved clause with its evidence and verdict, the
 *   constitution articles and exceptions, the deviations accepted at convergence, the self-approval disclosures, and the
 *   evidence index under `verification/` that the release artifact set requires.
 *
 * A Story whose pinned template is SFlow's own (an unmodified packaged revision) and that tracks its clauses (spec
 * `enforce`) gets them; any other keeps today's authoring. SFlow writes the document when the step is prepared and
 * rewrites it from the records when the step is published, while nobody edited it: a person or agent who rewrites it
 * owns it again, as before. Every gate on these documents runs unchanged (sections, placeholders, clause rows, agent
 * briefs, the conformance gaps, the artifact set). They are kept for audit, and the approval shows them as one line,
 * checked by SFlow (approval-focus.mjs).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { countedRecords } from './presence/counted.mjs';

const TEMPLATES = Object.freeze({ 'common/verification.md': { kind: 'verification', artifactKind: 'test-evidence' },
  'spec-driven/release.md': { kind: 'release', artifactKind: 'conformance-report' } });
export const RECORD_DOCUMENT_BANNER = '> Written by SFlow from its records. Leave it as it is: SFlow writes it again from those records when this step is published.';
const EVIDENCE_INDEX = 'verification/evidence-index.md';
const VERIFIED_RESULTS = new Set(['satisfied', 'satisfied-with-exception']);

const cell = (value) => String(value ?? '').replace(/\|/gu, '\\|').replace(/\s*\n\s*/gu, ' ').trim();
const code = (value) => `\`${String(value).replace(/`/gu, '')}\``;
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const person = (actor, fallback = 'a person') => typeof actor === 'string' && actor ? actor : actor?.login ?? actor?.name ?? actor?.email ?? fallback;

/** Which record document `phase` is, or null: SFlow's own template, unmodified, on a Story that tracks its clauses. */
export async function recordDocumentKind(workflow, phase) {
  const resolved = (workflow?.resolution?.phases ?? []).find((entry) => entry?.id === phase?.id);
  const template = TEMPLATES[resolved?.template];
  if (!template || phase?.requiredArtifact?.kind !== template.artifactKind) return null;
  if ((workflow.resolution?.spec?.mode ?? 'off') !== 'enforce') return null;
  const sha256 = String(workflow.resolution?.templates?.[phase.id]?.sha256 ?? '').replace(/^sha256:/u, '');
  const { isKnownPackagedAssetHash } = await import('./packaged-asset-history.mjs');
  return isKnownPackagedAssetHash(`singularity/templates/${resolved.template}`, sha256) ? template.kind : null;
}

/** Each clause row of the evidence graph, as the Story's ending would judge it; [] when the records cannot be read here. */
async function clauseRows(root, definition, workflow) {
  try {
    const { terminalReadinessOnce } = await import('./evidence/terminal.mjs');
    const rows = (await terminalReadinessOnce(root, definition, workflow, { stage: 'submission' })).evaluation?.rows ?? [];
    return rows.filter((row) => row?.type !== 'STORY' && typeof row?.id === 'string');
  } catch { return null; }
}

/** The code step whose delivery the record documents report: the latest one before `phase`. */
function codeStepBefore(workflow, phase) {
  const order = workflow.phaseOrder ?? [];
  return order.slice(0, Math.max(0, order.indexOf(phase.id))).reverse().map((id) => workflow.phases?.[id])
    .find((step) => step?.deliveryEvidence?.testExecutions?.length || step?.deliveryEvidence?.acceptanceCriteria) ?? null;
}

async function receipt(root, relative) {
  try {
    const { readRecord } = await import('./schema-migrations.mjs');
    return readRecord('test-execution', await readFile(path.join(root, relative))).record;
  } catch { return null; }
}

const counts = (tests) => tests ? `${tests.passed ?? 0} passed, ${tests.failed ?? 0} failed, ${tests.skipped ?? 0} skipped` : 'no structured counts';

/** The runs the documents cite: the code step's bound runs, then this step's own (or reused) runs at its publication. */
async function testRuns(root, workflow, phase, ownRuns) {
  const runs = [];
  const step = codeStepBefore(workflow, phase);
  for (const execution of step?.deliveryEvidence?.testExecutions ?? []) {
    if (execution.kind === 'phase-validation-observation') continue;
    const read = execution.receiptPath ? await receipt(root, execution.receiptPath) : null;
    runs.push({ step: step.id, commandId: execution.commandId, attemptId: read?.attemptId ?? execution.attemptId ?? null, status: read?.status ?? execution.status ?? 'unavailable',
      tests: read?.tests ?? null, environment: read?.environment ?? null, receiptPath: execution.receiptPath ?? null, receiptSha256: execution.receiptSha256 ?? null });
  }
  const own = ownRuns ?? (Number(phase.stepTestRuns?.generation) === Number(phase.generation) ? phase.stepTestRuns?.testExecutions ?? phase.stepTestRuns?.preflightAttempts : null) ?? [];
  for (const run of own) {
    // A run reused on unchanged code is the code step's run again: it says so there, once.
    const same = runs.find((entry) => (run.reusedFrom?.attemptId && entry.attemptId === run.reusedFrom.attemptId) || (run.receiptPath && entry.receiptPath === run.receiptPath));
    if (same) { same.reusedBy = phase.id; continue; }
    const read = run.receiptPath ? await receipt(root, run.receiptPath) : null;
    runs.push({ step: phase.id, commandId: run.commandId, attemptId: run.attemptId ?? read?.attemptId ?? null, status: run.status ?? read?.status ?? 'unavailable',
      tests: run.counts ?? read?.tests ?? null, environment: read?.environment ?? null, receiptPath: run.receiptPath ?? null, receiptSha256: run.receiptSha256 ?? null,
      ...(run.reusedFrom ? { reusedFrom: run.reusedFrom } : {}) });
  }
  return { runs, codeStep: step, ownRan: own.length > 0 || runs.some((run) => run.reusedBy) };
}

function runsTable(runs) {
  if (!runs.length) return ['No test run is recorded for this Story\'s code.'];
  return ['| Command | Step | Run | Result | Tests | Environment |', '|---|---|---|---|---|---|',
    ...runs.map((run) => `| ${code(run.commandId)} | ${cell(run.step)}${run.reusedBy ? `, reused by ${cell(run.reusedBy)} on unchanged code` : ''} | ${run.attemptId ? code(run.attemptId) : 'not recorded'}${run.reusedFrom ? ` (reused from ${cell(run.reusedFrom.phase ?? 'an earlier step')}, code unchanged)` : ''} | ${cell(run.status)} | ${cell(counts(run.tests))} | ${cell([run.environment?.host, run.environment?.platform, run.environment?.arch].filter(Boolean).join(', ') || 'not recorded')} |`)];
}

/**
 * A clause's satisfied evidence slots a person signed off (a visual capture confirmed on the decision card), each as its
 * record and file: the latest record of that clause and slot. Before, the table said "no tagged test" for a criterion
 * proved by a screenshot, its reviewer blocked every version for it, and a real Story's verification reached version 5
 * (owner's d-story, 2026-11-22). Pure.
 */
function signOffs(row, records) {
  const slots = (row.verification?.contract?.slots ?? []).filter((slot) => slot.method !== 'test' && slot.status === 'satisfied');
  return slots.map((slot) => [...records].reverse().find((record) => record?.clauseId === row.id && record.slot === slot.slot))
    .filter(Boolean).map((record) => (record.basis === 'person-attestation'
      ? `signed off by ${person(record.actor)} without a screenshot (${code(record.id)}): "${String(record.reason ?? '').replace(/\s+/gu, ' ').slice(0, 300)}"`
      : `${record.method ?? 'person'} sign-off ${code(record.id)} (${code(record.file)}), confirmed by a person`));
}

/** What a clause's tests say, in the words a row carries: each test, its run and its outcome, then its sign-offs. */
export function testEvidence(row, records = []) {
  const signed = signOffs(row, records);
  const witnesses = row.verification?.witnesses ?? [];
  if (witnesses.length) return [...witnesses.map((entry) => `${entry.test ?? code(entry.testSource)}${entry.attemptId ? `, run ${code(entry.attemptId)}` : ''}: ${entry.outcome ?? entry.status ?? 'not run'}`), ...signed].join('; ');
  if (signed.length) return signed.join('; ');
  if (row.verification?.association === 'through-criteria' && row.verification.criteria?.length) return `through ${row.verification.criteria.map(code).join(', ')}`;
  if (row.verification?.tests?.length) return `tagged in ${row.verification.tests.map(code).join(', ')}`;
  return row.type === 'AC' ? 'no tagged test' : 'no criterion to test; checked as implemented in its source';
}

/** The person sign-off records that count on this Story (SF Guard's signatures, where it requires them). */
const signedRecords = (workflow) => countedRecords(workflow, workflow?.witnessRecords ?? []);

const sourceEvidence = (row) => (row.implementation?.observedPaths?.length ? row.implementation.observedPaths.map(code).join(', ')
  : row.plan?.expectedPaths?.length ? `planned in ${row.plan.expectedPaths.map(code).join(', ')}, not observed` : 'no source path');

const resultWords = (row) => ({ satisfied: 'verified', 'satisfied-with-exception': 'verified, with an accepted exception', 'not-applicable': 'not applicable',
  failed: 'failed', inconclusive: 'inconclusive', missing: 'missing', pending: 'pending' }[row.result] ?? row.result ?? 'unknown');

/** The tests that ran and assert nothing, or whose assertions were not read, from the code step's delivery. */
async function weakTests(step) {
  if (!step?.deliveryEvidence) return [];
  try {
    const proof = (await import('./verification/criterion-proof.mjs')).criterionProof(step.deliveryEvidence);
    return proof.filter((entry) => !entry.tests || entry.silent || (entry.tests && entry.unread === entry.tests)).map((entry) => entry.words);
  } catch { return []; }
}

async function findingsWords(step) {
  const recorded = step?.deliveryEvidence?.submittedFindings ?? step?.deliveryEvidence?.qualityFindings ?? null;
  if (!recorded) return null;
  try { return (await import('./findings/presentation.mjs')).publishedFindingsSummary(recorded)?.words ?? null; } catch { return null; }
}

/** The verification evidence, written from the records: null when the clause rows cannot be read here. */
async function verificationBody(root, definition, workflow, phase, { ownRuns = null } = {}) {
  const rows = await clauseRows(root, definition, workflow);
  if (!rows?.length) return null;
  const { runs, codeStep, ownRan } = await testRuns(root, workflow, phase, ownRuns);
  const verified = rows.filter((row) => VERIFIED_RESULTS.has(row.result));
  const open = rows.filter((row) => !VERIFIED_RESULTS.has(row.result) && row.result !== 'not-applicable');
  const failedRuns = runs.filter((run) => run.status !== 'passed');
  const weak = await weakTests(codeStep);
  const findings = await findingsWords(codeStep);
  const W = workflow.workItem.id;
  const recommendation = open.length || failedRuns.length ? `hold the release until ${[open.length ? `${plural(open.length, 'requirement')} ${open.length === 1 ? 'is' : 'are'} verified or decided` : null, failedRuns.length ? `${plural(failedRuns.length, 'failed run')} ${failedRuns.length === 1 ? 'passes' : 'pass'}` : null].filter(Boolean).join(' and ')}`
    : 'release: every requirement is verified by a passing run';
  return {
    from: 'its test runs and the requirement table',
    text: [
      `# ${W} — Verification Evidence`, '', RECORD_DOCUMENT_BANNER, '',
      '## Agent brief', '',
      `${verified.length} of ${plural(rows.length, 'requirement')} verified; ${runs.length ? `${runs.length - failedRuns.length} of ${plural(runs.length, 'test run')} passed` : 'no test run recorded'}${weak.length ? `; ${plural(weak.length, 'requirement')} with a weak test` : ''}. Recommendation: ${recommendation}.`, '',
      '## Commands and environment', '', ...runsTable(runs), '',
      ownRan ? `${phase.label ?? phase.id} ran the repository's tests itself, or reused a run on unchanged code, when it was published.`
        : `The repository's tests run when ${phase.label ?? phase.id} is published, or a run on unchanged code is reused; SFlow then adds that run here.`, '',
      '## Acceptance and specification results', '',
      '| Clause | Test evidence | Source | Result |', '|---|---|---|---|',
      ...rows.map((row) => `| ${code(row.id)} | ${cell(testEvidence(row, signedRecords(workflow)))} | ${cell(sourceEvidence(row))} | ${cell(resultWords(row))} |`), '',
      'A source tag binds a requirement to its code; only a test result or a person\'s recorded sign-off above verifies it.', '',
      '## Negative, regression, security, and non-functional checks', '',
      `- Scanners: ${findings ?? 'no scanner findings are recorded for the changed code.'}`,
      `- Tests: ${weak.length ? weak.join('; ') : 'every tagged test asserts what it checks.'}`,
      `- Failed runs: ${failedRuns.length ? failedRuns.map((run) => `${code(run.commandId)} (${run.step}) ${run.status}`).join('; ') : 'none.'}`,
      `- Residual risk: ${open.length ? open.map((row) => `${code(row.id)} reads ${row.result}`).join('; ') : 'none the records show.'}`, ''
    ].join('\n')
  };
}

/** The deviations a person accepted at convergence, each with who accepted it; [] when none or unreadable. */
async function acceptedDeviations(root, config, workflow) {
  try {
    const { loadVerifiedConvergenceProjection } = await import('./convergence-context.mjs');
    const read = await loadVerifiedConvergenceProjection(root, config, workflow);
    return (read?.projection?.findings ?? []).filter((entry) => entry.disposition === 'accepted-deviation');
  } catch { return []; }
}

const VERDICTS = { satisfied: 'matched', 'satisfied-with-exception': 'matched', 'not-applicable': 'matched', missing: 'missing' };

/** A clause's verdict from its row: deviated when convergence accepted a deviation, else what the evidence says. */
function verdictOf(row, deviations) {
  // The verdict word first, then a note in brackets: the row check reads exactly that (conformance-readiness.mjs).
  if (deviations.some((entry) => (entry.clauseIds ?? []).includes(row.id))) return 'deviated (accepted at convergence)';
  const verdict = VERDICTS[row.result] ?? 'partial';
  return row.result === 'satisfied-with-exception' ? `${verdict} (with an accepted exception)`
    : row.result === 'not-applicable' ? `${verdict} (not applicable to this Story)` : verdict === 'matched' ? verdict
      : row.result === 'missing' ? `${verdict} (no evidence is recorded)` : `${verdict} (the record reads ${row.result})`;
}

function constitutionLines(workflow) {
  const pin = workflow.resolution?.constitutionPin ?? null;
  const articles = (pin?.articles ?? []).filter((article) => article.evidenceRequired);
  if (!articles.length) return ['No constitution article requires evidence in this Story.'];
  const decided = new Map();
  for (const phase of Object.values(workflow.phases ?? {})) for (const approval of phase.approvals ?? []) {
    for (const entry of approval.checklist ?? []) if (entry?.articleId) decided.set(entry.articleId, { decision: entry.decision, by: person(approval.actor) });
  }
  return ['| Article | Type | Verdict | Recorded by |', '|---|---|---|---|', ...articles.map((article) => {
    const entry = decided.get(article.id);
    return `| ${code(article.id)} | ${cell(article.type)} | ${cell(entry?.decision ?? (article.type === 'enforced' ? 'satisfied: enforced by the checks this Story passed' : 'awaiting a person\'s verdict at approval'))} | ${cell(entry?.by ?? (article.type === 'enforced' ? 'SFlow' : 'the approver'))} |`;
  })];
}

function exceptionLines(workflow) {
  const exceptions = workflow.constitutionExceptions ?? [];
  if (!exceptions.length) return ['None recorded.'];
  return exceptions.map((entry) => `- ${code(entry.articleId)}: ${cell(entry.reason)} (scope ${cell(entry.scope ?? 'this Story')}; ${cell(entry.authority ?? 'an approver')}, ${cell(person(entry.actor))}${entry.expiresAt ? `; expires ${String(entry.expiresAt).slice(0, 10)}` : ''})`);
}

/** The approved verification step before release, and the files its approval bound. */
function approvedVerification(workflow, phase) {
  const order = workflow.phaseOrder ?? [];
  const step = order.slice(0, Math.max(0, order.indexOf(phase.id))).reverse().map((id) => workflow.phases?.[id])
    .find((entry) => entry?.requiredArtifact?.kind === 'test-evidence' && entry.status === 'approved');
  if (!step) return null;
  const approval = [...(step.approvals ?? [])].reverse().find((entry) => entry.decision === 'approved' && !entry.invalidatedAt && Number(entry.generation) === Number(step.generation));
  return { step, approval: approval ?? null };
}

async function evidenceIndex(root, workflow, phase, rows) {
  const W = workflow.workItem.id;
  const verification = approvedVerification(workflow, phase);
  const { runs } = await testRuns(root, workflow, verification?.step ?? phase, null);
  const files = [...(verification?.approval?.artifactSha256 ?? (verification?.step?.artifacts ?? []).map((entry) => ({ path: entry.path, sha256: entry.sha256 })))
    .map((entry) => ({ what: 'Verification evidence', path: entry.path, sha256: String(entry.sha256 ?? '').replace(/^sha256:/u, '') })),
  ...runs.filter((run) => run.receiptPath).map((run) => ({ what: `Test run ${run.attemptId ?? run.commandId} (${run.step})`, path: run.receiptPath, sha256: String(run.receiptSha256 ?? '').replace(/^sha256:/u, '') }))];
  const gaps = rows.filter((row) => !VERIFIED_RESULTS.has(row.result) && row.result !== 'not-applicable');
  return [`# Release verification evidence index — ${W}`, '', RECORD_DOCUMENT_BANNER, '',
    verification ? `${verification.step.label ?? verification.step.id} v${verification.step.generation} is approved${verification.step.automaticApproval && Number(verification.step.automaticApproval.generation) === Number(verification.step.generation) ? ' by SFlow, as its checks were clean' : verification.approval?.actor ? ` by ${person(verification.approval.actor, 'its approver')}` : ''}. This release reads its evidence:`
      : 'No approved verification step precedes this release; the evidence below is the code step\'s.', '',
    '| Evidence | Path | SHA-256 |', '|---|---|---|', ...files.map((entry) => `| ${cell(entry.what)} | ${code(entry.path)} | ${entry.sha256 ? code(entry.sha256) : 'not recorded'} |`), '',
    '## Observed results', '', ...(runs.length ? runs.map((run) => `- ${code(run.commandId)} (${run.step}${run.reusedBy ? `, reused by ${run.reusedBy}` : ''}): ${run.status}, ${counts(run.tests)}.`) : ['- No test run is recorded.']), '',
    '## Gaps', '', ...(gaps.length ? gaps.map((row) => `- ${code(row.id)} reads ${row.result}.`) : ['- None: every clause reads verified.']), ''].join('\n');
}

/** The release conformance report and its evidence index, written from the records: null when the clause rows cannot be read. */
async function releaseBody(root, definition, config, workflow, phase) {
  const rows = await clauseRows(root, definition, workflow);
  if (!rows?.length) return null;
  const deviations = await acceptedDeviations(root, config, workflow);
  const { selfApprovalDisclosureLines } = await import('./conformance-readiness.mjs');
  const disclosures = selfApprovalDisclosureLines(workflow);
  const W = workflow.workItem.id;
  return {
    from: 'the approved verification, the requirement table, the convergence decisions and the approvals',
    index: await evidenceIndex(root, workflow, phase, rows),
    text: [
      `# Release conformance — ${W}`, '', RECORD_DOCUMENT_BANNER, '',
      '## Requirement trace', '',
      '| Clause | Evidence | Verdict |', '|---|---|---|',
      ...rows.map((row) => `| ${code(row.id)} | ${cell(`${testEvidence(row, signedRecords(workflow))}; source ${sourceEvidence(row)}`)} | ${cell(verdictOf(row, deviations))} |`), '',
      '## Constitution conformance', '', ...constitutionLines(workflow), '',
      '## Exceptions', '', ...exceptionLines(workflow), '',
      '## Deviations', '', ...(deviations.length ? deviations.map((entry) => `- ${entry.id}: ${(entry.clauseIds ?? []).map(code).join(', ')}, accepted by ${cell(person(entry.decision?.actor))}: ${cell(entry.decision?.reason ?? 'no reason recorded')}`)
        : ['None accepted at convergence.']), '',
      '## Self-approval disclosures', '', ...(disclosures.length ? ['Recorded from the retained approvals. Keep every line.', '', ...disclosures]
        : ['None: no step was approved by the identity that produced it.']), ''
    ].join('\n')
  };
}

/** The record document's text for `phase`, or null when it is not one or the records cannot say it whole here. */
export async function renderRecordDocument(root, config, workflow, phase, options = {}) {
  const kind = await recordDocumentKind(workflow, phase);
  if (kind === 'verification') return verificationBody(root, config, workflow, phase, options);
  if (kind === 'release') return releaseBody(root, config, config, workflow, phase);
  return null;
}

const METADATA = /^<!-- singularity-flow:metadata\r?\n[\s\S]*?\r?\n-->/mu;
const MARKER = /<!-- singularity-flow:record-document sha256:([a-f0-9]{64}) -->\r?\n?/u;
const VERDICT_SUMMARY = /<!-- singularity-flow:verdict-summary:start -->[\s\S]*?<!-- singularity-flow:verdict-summary:end -->/u;

/** The digest that seals a record document: its authored text, without its seal and the engine's verdict summary block. */
async function sealDigest(text) {
  const { authoredArtifactText } = await import('./artifact-review-read.mjs');
  const { createHash } = await import('node:crypto');
  const body = authoredArtifactText(String(text ?? '')).replace(MARKER, '').replace(VERDICT_SUMMARY, '')
    .replaceAll('\r\n', '\n').split('\n').map((line) => line.trimEnd()).join('\n').replace(/\n{3,}/gu, '\n\n').trim();
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Whether SFlow wrote `text` from its records and nobody changed it since: it carries SFlow's seal and its digest still
 * matches. Anyone who edits it owns it again, and every reader then treats it as theirs.
 */
export async function writtenBySflow(text) {
  const seal = String(text ?? '').match(MARKER)?.[1];
  return Boolean(seal) && seal === await sealDigest(text);
}

/** `text` with SFlow's seal as the first line of its body, after anything before and its metadata block. */
async function sealed(text) {
  const digest = await sealDigest(text);
  const unsealed = text.replace(MARKER, '');
  const match = unsealed.match(METADATA);
  const at = match ? match.index + match[0].length : 0;
  return `${unsealed.slice(0, at)}${at ? '\n\n' : ''}<!-- singularity-flow:record-document sha256:${digest} -->\n${unsealed.slice(at).replace(/^\s+/u, '')}`;
}

/** `existing` with its body replaced by `body`: anything before and the metadata block kept first, the inputs block last. */
async function merged(existing, body) {
  const text = String(existing ?? '');
  const match = text.match(METADATA);
  const prefix = match ? text.slice(0, match.index + match[0].length) : null;
  const { extractInputsBlock } = await import('./inputs.mjs');
  const inputs = extractInputsBlock(text);
  return `${[prefix, body.trimEnd(), inputs].filter(Boolean).join('\n\n')}\n`;
}

/**
 * Write `phase`'s record document from the records. `stage: 'prepare'` writes it in a document just created from its
 * template; `stage: 'publish'` writes it again only while SFlow's seal on it holds (nobody edited it since). Returns what
 * was written, or null: the document is then its author's, checked as before.
 */
export async function writeRecordDocument(root, config, workflow, phase, { stage, artifactPath, ownRuns = null }) {
  if (!await recordDocumentKind(workflow, phase)) return null;
  const { writeText } = await import('./util.mjs');
  let existing;
  try { existing = await readFile(artifactPath, 'utf8'); } catch { return null; }
  if (stage === 'publish' && !await writtenBySflow(existing)) return null;
  const rendered = await renderRecordDocument(root, config, workflow, phase, { ownRuns }).catch(() => null);
  if (!rendered) return null;
  let text = await merged(existing, rendered.text);
  if (phase.requiredArtifact?.kind === 'conformance-report') {
    const { withVerdictSummary, conformanceEvidenceReuse } = await import('./conformance-readiness.mjs');
    text = withVerdictSummary(text, workflow, phase.id, { reused: await conformanceEvidenceReuse(root, config, workflow, phase.id).catch(() => []) });
  }
  text = await sealed(text);
  await writeText(artifactPath, text);
  if (rendered.index) {
    const file = path.join(path.dirname(artifactPath), EVIDENCE_INDEX);
    const before = await readFile(file, 'utf8').catch(() => null);
    // The index is SFlow's while it is absent or still sealed; one someone wrote stays theirs.
    if (before == null || await writtenBySflow(before)) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.dirname(file), { recursive: true });
      await writeText(file, await sealed(rendered.index));
    }
  }
  return { text, from: rendered.from };
}

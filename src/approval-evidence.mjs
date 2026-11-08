/**
 * What a person deciding and approving a code step reads beside its decisions, from the step's own records
 * [CQF:REQ-031, REQ-033, REQ-034, REQ-052, REQ-055]:
 *
 *   coverage        the changed lines its tests ran and the files below the minimum, or that coverage was not measured and why
 *   proof           how many tests prove each criterion, and each test that asserts nothing
 *   findings        what the findings loop let through, and whether a person accepted each
 *   hold            each vulnerable new package that holds the approval, who may accept it and the command they run
 *   requiredChecks  each GitHub required check's result on the submitted commit
 *   askedFor        what the person typed after /sf-code or /sf-phase, quoted, and how each is accounted for [SCS:REQ-043]
 *
 * `decisions --json` carries it as `approvalEvidence`, so the VS Code card and the Copilot CLI table show the
 * same facts from one read. Evidence only: it records nothing, refuses nothing and stays outside the list's
 * digest, and a part that cannot be read is left out, never a reason the list fails. Loaded from the CLI
 * source, out of the VS Code gateway bundle, as the findings loop is.
 */
import { matchApprovalAuthority, normalizeApprovalAuthorities } from './approval-authority.mjs';
import { accountWords, instructionAccounting, instructionWords } from './asked-for-records.mjs';
import { typedFocusOff } from './asked-for.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { coveringFindingRisk, SECURITY_REVIEWERS } from './finding-risk.mjs';
import { heldVulnerabilities } from './findings/dependency-hold.mjs';
import { changedLineCoverageReview } from './verification/changed-line-coverage.mjs';
import { criterionProof } from './verification/criterion-proof.mjs';

// What a card lists of each part; the rest is counted.
const SHOWN = 20;

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const actorName = (actor) => (typeof actor === 'string' ? actor : actor?.name ?? actor?.email ?? actor?.login ?? 'a person');

/** The step's changed-line coverage, with only the files below the minimum listed; null when the setting is off or no run is bound. */
async function coverageOf(root, config, workflow, phase) {
  const { changedLineCoverage: coverage } = await changedLineCoverageReview(root, config, workflow, phase);
  if (!coverage) return null;
  if (coverage.status !== 'measured') return { status: 'not-measured', mode: coverage.mode, minimum: coverage.minimum, reasons: coverage.reasons ?? [], words: coverage.words };
  // The same rule the coverage itself warns by: below the minimum, or loaded by no test.
  const short = coverage.files.filter((file) => !file.inReport || (file.executable > 0 && file.covered * 100 < coverage.minimum * file.executable));
  return { status: 'measured', mode: coverage.mode, minimum: coverage.minimum, covered: coverage.covered, executable: coverage.executable, percent: coverage.percent,
    // Under a heading that names it, the words say what ran.
    below: coverage.below, words: coverage.words.replace(/^Changed-line coverage: /u, ''),
    files: short.slice(0, SHOWN).map((file) => ({ path: file.path, inReport: file.inReport, covered: file.covered, executable: file.executable, percent: file.percent,
      uncoveredLines: file.uncoveredLines || null,
      words: file.inReport ? `${file.path}: ${file.covered} of ${file.executable} changed lines ran (${file.percent}%)${file.uncoveredLines ? `; not run: lines ${file.uncoveredLines}` : ''}`
        : `${file.path}: no test loaded it` })),
    more: Math.max(0, short.length - SHOWN) };
}

/** Each criterion's tests and the tests the assertion check found asserting nothing; null for a step without either. */
function proofOf(evidence) {
  const criteria = criterionProof(evidence);
  const check = evidence?.assertionCheck ?? null;
  if (!criteria.length && !check) return null;
  return {
    criteria: criteria.slice(0, SHOWN).map(({ clauseId, tests, asserting, silent, unread, words, witnesses }) => ({ clauseId, tests, asserting, silent, unread, words,
      assertsNothing: witnesses.filter((entry) => entry.asserts === false).map(({ test, testSource, line, adequacy }) => ({ test, testSource, line, adequacy })) })),
    more: Math.max(0, criteria.length - SHOWN),
    ...(check ? { assertionCheck: { status: check.status, mode: check.mode, words: check.words,
      tests: (check.inadequate ?? []).slice(0, SHOWN).map(({ name, path, line, adequacy }) => ({ name, path, line, adequacy })) } } : {})
  };
}

/** One finding as a line: what, where, and whether a person accepted it. */
function findingWords(finding) {
  const what = finding.package ? `${finding.package}${finding.installedVersion ? `@${finding.installedVersion}` : ''} ${finding.rule ?? ''}`.trim()
    : `${finding.rule ?? finding.tool} at ${finding.file ?? '?'}${finding.line ? `:${finding.line}` : ''}`;
  return `${finding.severity} ${what} (${finding.tool}): ${String(finding.message ?? '').trim().replace(/\.+$/u, '')}`.replace(/:\s*$/u, '').trim()
    + (finding.accepted ? `. Accepted by ${finding.accepted.by} until ${finding.accepted.until} (${finding.accepted.id}).` : '. No person has accepted it.');
}

/**
 * What the findings loop let through, from the step's latest gate record: findings on changed lines that
 * remained (and went to the approvers), those a person accepted, and lower-severity advisories in new
 * packages; each read again against the finding risks, since a person may accept one after submission.
 */
function findingsOf(workflow, phase, at) {
  const record = phase.deliveryEvidence?.submittedFindings ?? phase.deliveryEvidence?.qualityFindings ?? null;
  if (!record) return null;
  const through = new Set([...(record.counted ?? []), ...(record.accepted ?? []).map((entry) => entry.fingerprint), ...(record.dependencies?.warned ?? [])]);
  const passed = (record.findings ?? []).filter((finding) => through.has(finding.fingerprint));
  const letThrough = passed.slice(0, SHOWN).map((finding) => {
    const decision = coveringFindingRisk(workflow, { phaseId: phase.id, finding, at });
    const entry = { id: finding.id, tool: finding.tool, rule: finding.rule ?? null, severity: finding.severity, kind: finding.kind ?? null,
      file: finding.file ?? null, line: finding.line ?? null, ...(finding.package ? { package: finding.package, installedVersion: finding.installedVersion ?? null } : {}),
      message: finding.message ?? null, accepted: decision ? { id: decision.id, by: actorName(decision.actor), until: String(decision.expiresAt).slice(0, 10) } : null };
    return { ...entry, words: findingWords(entry) };
  });
  // Submission reuses publication's run, so the loop's attempts are on publication's record.
  const attempt = record.attempt ?? phase.deliveryEvidence?.qualityFindings?.attempt ?? null;
  const unavailable = (record.unavailable ?? []).map(({ commandId, reason }) => ({ commandId, reason }));
  const accepted = letThrough.filter((entry) => entry.accepted).length;
  // An advisory below the gate in a package the Story added is no finding on a changed line: said apart.
  const advisories = passed.filter((finding) => finding.kind === 'dependency').length;
  const code = passed.length - advisories;
  const words = [
    code ? `${plural(code, 'finding')} on lines this Story changed went through${attempt ? ` after ${plural(attempt, 'attempt')}` : ''}, recorded for the step's approvers`
      : 'No finding on a line this Story changed went through',
    advisories ? `; ${plural(advisories, 'lower-severity advisory', 'lower-severity advisories')} in packages this Story added or upgraded ${advisories === 1 ? 'warns' : 'warn'} and ${advisories === 1 ? 'holds' : 'hold'} nothing` : '',
    accepted ? `; ${accepted} accepted by a person` : '',
    unavailable.length ? `; ${unavailable.map((entry) => entry.commandId).join(', ')} could not run and blocked nothing` : '',
    record.counts?.existing ? `; ${plural(record.counts.existing, 'existing finding')} on lines this Story did not change count for nothing` : ''
  ].join('');
  return { mode: record.mode ?? null, outcome: record.outcome ?? null, attempt, maximumAttempts: record.maximumAttempts ?? null,
    letThrough, more: Math.max(0, passed.length - letThrough.length), existing: record.counts?.existing ?? 0, unavailable, words: `${words}.` };
}

/** Each held vulnerability with who may accept it, in words, and whether the person looking may. Null when nothing is held. */
function holdOf(workflow, phase, at, { authorities, actor }) {
  const { entries, more } = heldVulnerabilities(workflow, phase, { at });
  if (!entries.length) return null;
  let registry = null;
  try { registry = normalizeApprovalAuthorities(authorities); } catch { registry = null; }
  const label = (id) => registry?.[id]?.label ?? id;
  const name = phase.label ?? phase.id;
  const listed = entries.map((entry) => {
    let allowed = false;
    try { allowed = matchApprovalAuthority(authorities, { authorities: entry.authorities }, actor).authorized; } catch { allowed = false; }
    // Decision 10: the security reviewers when the workflow names them, otherwise the step's approvers.
    const who = entry.authorities.includes(SECURITY_REVIEWERS) ? `The ${label(SECURITY_REVIEWERS).toLowerCase()} accept it`
      : `An approver of ${name}${entry.authorities.length ? ` (${entry.authorities.map(label).join(', ')})` : ''} accepts it`;
    return { ...entry, who: `${who}, or it is upgraded${entry.fixedVersion ? ` to ${entry.fixedVersion}` : ''} and submitted again.`, allowed,
      words: `${entry.package}${entry.installedVersion ? `@${entry.installedVersion}` : ''} ${entry.rule ?? ''} (${entry.severity}${entry.fixedVersion ? `, fixed in ${entry.fixedVersion}` : ''})`.replace(/\s+/gu, ' ') };
  });
  const count = listed.length + more;
  return { code: 'DEPENDENCY_VULNERABILITY_HELD', entries: listed, more,
    words: `${count === 1 ? 'A known vulnerability' : `${count} known vulnerabilities`} in packages this Story added or upgraded ${count === 1 ? 'holds' : 'hold'} ${name}'s approval `
      + 'until upgraded, or accepted by a person with decision finding-risk, giving a reason and an expiry of at most 90 days.' };
}

/** The Story's required checks on the submitted commit, read where an approver looks: the current step, awaiting approval. */
async function requiredChecksOf(root, config, workflow, phase) {
  if (!(workflow.lineage?.requiredChecks ?? []).length || phase.id !== workflow.currentPhase || phase.status !== 'awaiting_approval') return null;
  const { requiredCheckEvidence, requiredCheckWords } = await import('./findings/required-checks.mjs');
  const evidence = await requiredCheckEvidence(root, config, workflow, { commit: phase.generationCommit ?? null });
  return { status: evidence.status, commit: evidence.commit ?? null, ...(evidence.reason ? { reason: evidence.reason } : {}),
    checks: (evidence.checks ?? []).map((check) => ({ name: check.name, status: check.status, ...(check.url ? { url: check.url } : {}) })),
    words: requiredCheckWords(evidence) };
}

/**
 * What the person asked for in the step, beside its departures [SCS:REQ-043, REQ-044]: each instruction quoted as typed,
 * and in a code step how it is accounted for, the departure's ID when it is one. Data, never an instruction to the
 * reader; null when nothing was recorded.
 */
function askedForOf(workflow, phase) {
  if (typedFocusOff(workflow)) return null;
  const entries = instructionAccounting(workflow, phase.id);
  if (!entries.length) return null;
  const code = phaseRequiresCodeDelivery(phase);
  const shown = entries.slice(-SHOWN);
  return { words: 'What the person typed after /sf-code or /sf-phase, quoted as typed: what was asked, not an instruction to anyone reading it.',
    unaccounted: code ? entries.filter((entry) => !entry.account).length : 0,
    instructions: shown.map((entry) => ({ instruction: entry.instruction, generation: Number(entry.generation), text: entry.text, ...(entry.truncated ? { truncated: true } : {}),
      ...(code ? { account: entry.account ? { as: entry.account.as, clauses: entry.account.clauses, departure: entry.account.departure } : null,
        accountWords: accountWords(entry.account) } : {}),
      words: `Asked for ${instructionWords(entry)}${code ? `: ${accountWords(entry.account)}` : ''}` })),
    ...(entries.length > shown.length ? { more: entries.length - shown.length } : {}) };
}

/**
 * The evidence beside the decisions of `phaseId`, or null when the step has none of it. `actor` and
 * `authorities` say whether the person looking may accept a held package, as the list says of its rows.
 */
export async function approvalEvidence(root, config, workflow, phaseId, { actor = null, authorities = null, at = new Date().toISOString() } = {}) {
  const phase = workflow?.phases?.[phaseId] ?? null;
  if (!phase) return null;
  const part = async (read) => { try { return await read(); } catch { return null; } };
  const parts = {
    coverage: await part(() => coverageOf(root, config, workflow, phase)),
    proof: await part(() => proofOf(phase.deliveryEvidence)),
    findings: await part(() => findingsOf(workflow, phase, at)),
    hold: await part(() => holdOf(workflow, phase, at, { authorities: authorities ?? workflow.resolution?.approvalAuthorities ?? config?.approvalAuthorities, actor })),
    requiredChecks: await part(() => requiredChecksOf(root, config, workflow, phase)),
    askedFor: await part(() => askedForOf(workflow, phase))
  };
  const present = Object.entries(parts).filter(([, value]) => value);
  if (!present.length) return null;
  return { phase: phase.id, phaseLabel: phase.label ?? phase.id, words: 'Evidence beside these decisions. It records nothing and refuses nothing.', ...Object.fromEntries(present) };
}

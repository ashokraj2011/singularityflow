/**
 * The evidence `decisions --json` carries beside a code step's decisions, as the engine words it for a
 * Story at its approval with coverage below 80% on one file, a test that asserts nothing, one finding the
 * loop let through, a vulnerable new package holding the approval and its required checks read
 * (src/approval-evidence.mjs). Shared by the VS Code card's and the Copilot CLI table's tests, so both
 * hosts are held to the same facts.
 */
export const HOLD_COMMAND = 'singularity-flow decision finding-risk PAY-1 --phase implementation --finding F-a4bd3792d14b22d0 --fingerprint sha256:'
  + `${'a'.repeat(64)} --rule GHSA-xvch-5gv4-984h --tool npm-audit --tool-version 11.20.0 --kind dependency --reason "<why the step may keep it>" --expires <YYYY-MM-DD>`;

export function approvalEvidence({ allowed = true, accepted = null } = {}) {
  return {
    phase: 'implementation', phaseLabel: 'Code', words: 'Evidence beside these decisions. It records nothing and refuses nothing.',
    coverage: { status: 'measured', mode: 'warn', minimum: 80, covered: 11, executable: 14, percent: 78.5, below: true,
      words: '11 of 14 changed lines ran (78.5%). Below the 80% wanted: it warns and refuses nothing.',
      files: [{ path: 'src/value.mjs', inReport: true, covered: 10, executable: 13, percent: 76.9, uncoveredLines: '6-7,11',
        words: 'src/value.mjs: 10 of 13 changed lines ran (76.9%); not run: lines 6-7,11' }], more: 0 },
    proof: { criteria: [{ clauseId: 'PAY-1:AC-001', tests: 2, asserting: 1, silent: 1, unread: 0,
      words: "PAY-1:AC-001: 2 tests prove it; 1 asserts; 'parses an empty list' asserts nothing",
      assertsNothing: [{ test: 'parses an empty list', testSource: 'test/value.test.mjs', line: 9, adequacy: 'missing' }] }], more: 0,
    assertionCheck: { status: 'incomplete', mode: 'warn', tests: [{ name: 'parses an empty list', path: 'test/value.test.mjs', line: 9, adequacy: 'missing' }],
      words: "Assertion check: 1 test asserts nothing it tests ('parses an empty list' at test/value.test.mjs:9). It warns and refuses nothing." } },
    findings: { mode: 'warn', outcome: 'warned', attempt: 3, maximumAttempts: 3, existing: 0, unavailable: [], more: 0,
      words: `1 finding on lines this Story changed went through after 3 attempts, recorded for the step's approvers${accepted ? '; 1 accepted by a person' : ''}.`,
      letThrough: [{ id: 'F-f45f56632db53971', tool: 'eslint', rule: 'sonarjs/cognitive-complexity', severity: 'high', kind: 'complexity', file: 'src/value.mjs', line: 4,
        message: 'Refactor this function to reduce its Cognitive Complexity from 18 to the 15 allowed.', accepted,
        words: `high sonarjs/cognitive-complexity at src/value.mjs:4 (eslint): Refactor this function to reduce its Cognitive Complexity from 18 to the 15 allowed. ${accepted
          ? `Accepted by ${accepted.by} until ${accepted.until} (${accepted.id}).` : 'No person has accepted it.'}` }] },
    hold: { code: 'DEPENDENCY_VULNERABILITY_HELD', more: 0,
      words: "A known vulnerability in packages this Story added or upgraded holds Code's approval until upgraded, or accepted by a person with decision finding-risk, giving a reason and an expiry of at most 90 days.",
      entries: [{ id: 'F-a4bd3792d14b22d0', tool: 'npm-audit', rule: 'GHSA-xvch-5gv4-984h', severity: 'critical', package: 'minimist', installedVersion: '1.2.5', fixedVersion: '1.2.8',
        message: 'Prototype Pollution in minimist', authorities: ['security-reviewers'], command: HOLD_COMMAND, allowed,
        who: 'The security reviewers accept it, or it is upgraded to 1.2.8 and submitted again.', words: 'minimist@1.2.5 GHSA-xvch-5gv4-984h (critical, fixed in 1.2.8)' }] },
    requiredChecks: { status: 'read', commit: '3f6c9a1e2b4d5c6e7f8091a2b3c4d5e6f7a8b9c0',
      checks: [{ name: 'CodeQL', status: 'passed' }, { name: 'SonarCloud Code Analysis', status: 'failed' }],
      words: 'Required checks on 3f6c9a1e2b4d: CodeQL passed · SonarCloud Code Analysis failed. They are evidence for the reviewer; approval does not wait on them.' }
  };
}

/** Every line of the evidence the engine words, which each host shows as it is. */
export function evidenceWords(evidence) {
  return [evidence.words, evidence.coverage.words, ...evidence.coverage.files.map((file) => file.words), ...evidence.proof.criteria.map((entry) => entry.words),
    evidence.proof.assertionCheck.words, evidence.findings.words, ...evidence.findings.letThrough.map((finding) => finding.words),
    evidence.hold.words, ...evidence.hold.entries.flatMap((entry) => [entry.words, entry.who]), evidence.requiredChecks.words];
}

/**
 * The Story carries the test tools and pre-code disposition that were actually observed at
 * creation. This is a snapshot of a completed read-only preflight, not a substitute for a test
 * receipt or an instruction to skip checks later in the workflow.
 */
export function storyTestReadinessDocument(workId, repositories, evidence, { required = false } = {}) {
  const receipts = evidence?.repositories ?? {};
  const records = [...repositories].map((repository) => {
    const receipt = receipts[repository.id] ?? null;
    const current = ['pass', 'failing-tests', 'accepted-known-failures'].includes(receipt?.status)
      && receipt.sourceCommit === repository.baseCommit;
    const contract = current ? receipt.structuredTestContract ?? null : null;
    const tools = contract?.commands ?? [];
    const observations = current ? receipt.testObservations ?? [] : [];
    const verifiedTests = current && receipt.status === 'pass' && tools.length > 0
      && tools.every((tool) => observations.some((entry) => entry.commandId === tool.id
        && entry.status === 'available' && entry.counts?.discovered > 0
        && entry.counts?.failed === 0));
    return {
      repository: repository.id,
      sourceCommit: repository.baseCommit ?? null,
      receiptSourceCommit: receipt?.sourceCommit ?? null,
      scope: receipt?.scope ?? null,
      status: receipt?.status ?? 'not-checked',
      receiptSha256: receipt?.receiptSha256 ?? null,
      baselineSha256: current ? receipt?.baselineSha256 ?? null : null,
      sourceManifestSha256: current ? receipt?.sourceManifestSha256 ?? null : null,
      planId: current ? receipt?.planId ?? null : null,
      testToolStatus: contract?.status ?? 'not-checked',
      testTools: tools.map((command) => ({
        id: command.id,
        workingDirectory: command.workingDirectory,
        launcher: command.launcher,
        adapter: command.adapter,
        reportPath: command.reportPath
      })),
      commandResults: (current ? receipt.commandResults ?? [] : []).map((command) => ({
        id: command.id,
        purpose: command.purpose,
        status: command.status
      })),
      testResults: observations.map((entry) => ({
        commandId: entry.commandId,
        adapter: entry.adapter,
        status: entry.status,
        counts: entry.counts ?? null,
        failingCases: entry.failingCases ?? []
      })),
      riskAcceptance: current && receipt.riskAcceptance ? {
        status: receipt.riskAcceptance.status,
        baselineSha256: receipt.riskAcceptance.baselineSha256,
        acceptanceSha256: receipt.riskAcceptance.acceptanceSha256,
        sourceCommit: receipt.riskAcceptance.sourceCommit,
        acceptedAt: receipt.riskAcceptance.acceptedAt,
        expiresAt: receipt.riskAcceptance.expiresAt
      } : null,
      existingFailureDisposition: verifiedTests
        ? 'no-observed-pre-story-failures'
        : current && receipt.status === 'accepted-known-failures'
          ? 'accepted-pre-existing-test-failures'
          : current && receipt.status === 'failing-tests'
            ? 'pre-existing-test-failures-require-decision'
        : current && !tools.length
          ? 'no-test-tool-selected'
          : 'repair-or-verify-before-code'
    };
  }).sort((left, right) => left.repository.localeCompare(right.repository));
  return {
    schemaVersion: 1,
    kind: 'story-test-readiness',
    workId,
    required,
    repositories: records,
    guidance: 'A verified exact-base risk decision permits Story creation with known failing tests only. It never turns those tests green or waives later test, publication, approval, or protected-path checks.'
  };
}
